/**
 * 回归测试：进入「聆听中」之前，模型与麦克风都必须真的就绪。
 *
 * 背景（2026-10-31，用户反馈）：
 *   「聆听中」状态转换的时候，识别的时候能不能确保模型已经加载了？」
 *
 * 两个真实问题：
 *
 * 1. **模型没加载就开麦**
 *    首次加载模型要等（时长随档位与磁盘变，所以不写具体秒数）。以前是**先**把界面切成「聆听中」
 *    **再**去开麦，于是用户说的话会**全部丢掉** ——
 *    识别请求在模型就绪前就失败了，而失败的音频已经被切走。
 *
 * 2. **麦克风没打开也算「聆听中」**
 *    `getUserMedia` 可能被拒绝、可能一直挂着等授权、
 *    也可能拿到一个已经结束（ended）的轨道 ——
 *    这时候照样能建出音频图、能跑 VAD，只是永远采不到声音，
 *    而界面显示「聆听中」，用户完全看不出来。
 *
 * 规则（可执行）：
 *   - 模型没就绪 → 不能进入聆听态（先 warmup，必要时显示「正在加载模型…」）
 *   - 没有可用的音频轨道 → 不能进入聆听态
 *   - 「聆听中」的标志只能由「一切就绪」那一步设置
 *   - 就绪通道（`/asr-ready` / `/asr-warmup`）的 `reason` **只许是原因码**
 *     （`src/shared/asr-readiness.js` 那份词表），宿主不许出句子 —— 界面那句话由客户端
 *     i18n 按当前语言给（批次 18，docs §8.60）。以前宿主直接回中文句子、客户端
 *     `data.reason || t(...)` 又优先用它，英文界面因此弹过中文提示。
 *
 * 这一版改了什么（docs/architecture-modernization.md §8.34 批次 3）：
 *   原来这个文件十六判据全是**扫源码**：宿主那五条问的是「路由注册了没有、
 *   `asrLoadedModels` 这个 Set 存不存在、有没有 add/delete」，客户端那几条问的是
 *   「`ensureModelReady()` 这一行在不在 `getUserMedia` 之前」。写法一改就红，
 *   写法不改而行为坏掉反而绿。现在：
 *     - 宿主侧 → 装真路由（`test/helpers/host-routes.mjs`）+ 真模型目录，
 *       发真请求比真响应（档位不存在 / 没下载 / 下齐了但没加载 / sha 不符 / 空文件 /
 *       方法不对 / 没有可用 worker 时不许假装 loaded）；
 *     - 客户端侧 → `test/client-behavior.test.mjs` 的场景「开麦的时序与就绪判据」
 *       （假录音设备 + 可控的 `/asr-ready`，跑出来「先确认模型再取流」「没就绪根本不取流」
 *       「失败分支复位『正在开麦』」「状态行短词 + 悬停长说明」）；
 *     - 发送通路那三条（两条通路共用一个定时器 id）→ 同一文件的场景「自动发送只发一遍」。
 *   这一度留下两条**跨文件静态不变量**（批次 6l-e，docs §8.46 把它们也清掉了，
 *   现在这个文件一行源码都不读）：
 *     - 「客户端真代码里 setOn(true) 只有一个设置点」→ 换成 eslint 的选择器禁令
 *       （`eslint.config.js` 的 LISTENING_ON_BAN：`setOn(true)` 与 `onRef.current = true`
 *       只许出现在 `mic-button.js` 的 `markListening` 里，别处写了就在 offending 那一行报红），
 *       边界由 `test/no-undef.test.mjs` 的内存探针钉住；行为侧的分枝覆盖本来就在
 *       `test/client-behavior.test.mjs` 场景 12。
 *     - 「已加载名单有记入也有摘除」→ 换成一次真跑（下面的场景「已加载名单的记入与摘除」）：
 *       真识别线程（只把第三方依赖换成假 sherpa）预热成功 → `/asr-ready` 报 loaded=true；
 *       删掉磁盘上一个文件再走真 `/model` 下载 → 完成回调把这一档摘掉 → 文件重新齐了、
 *       loaded 却回到 false；再预热一次又能记上。缺任何一半都在这里红，不再是三处正则同时红。
 */
import fs from 'node:fs'
import path from 'node:path'
import osPkg from 'node:os'
import { startFakeCdn, digest, patternBuffer } from './helpers/fake-cdn.mjs'
import { loadHostRoutes, waitUntil, callRoute } from './helpers/host-routes.mjs'
import { fakeSherpa } from './helpers/fake-sherpa.mjs'
// `placeTierFiles` 起别名：本文件自己那份（配合上面的 makeTier，带 overrides 覆盖单个文件）
// 已经在场景里用了，两者签名不同，不能共用一个名字。
import { makeWhisperTier, placeTierFiles as placeWhisperTierFiles, cdnFiles } from './helpers/fake-asr-tier.mjs'
import { ASR_READY_REASONS, ASR_READY_REASON_VALUES, isAsrReadyReason } from '../src/shared/asr-readiness.js'

let passed = 0
let failed = 0
const rows = []
/**
 * 本文件里宿主**真正回出来过**的 `reason`（空串=就绪，不算）。
 * 批次 18（docs §8.60）用它做一条完整性判据：四个原因码必须 each 被真跑出来过，
 * 而且这条链路上不许出现词表外的值 —— 新增一个失败分支而忘了登记进词表时，红的就是这条。
 */
const observedReasons = new Set()
/** 记下宿主回出的非空 reason（就绪时是空串，不记）。 */
function noteReason(value) {
  if (typeof value === 'string' && value) observedReasons.add(value)
  return value
}
/** 判据收集：跑一条记一条，最后一行的「通过/失败」就由 rows 构成。 */
function add(name, ok, detail = '') {
  rows.push({ name, ok, detail })
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (!ok && detail ? '：' + detail : ''))
}

/** 合成档位：内容 sha 由测试自己算，于是宿主的路由跑的是真判据，文件却是本地可控的那份。 */
function makeTier(id, name, body, { noSha = false } = {}) {
  const files = [
    { name, bytes: body.length },
    { name: name + '.tokens', bytes: 4 },
  ]
  if (!noSha) {
    files[0].sha256 = digest(body)
    files[1].sha256 = digest(Buffer.from('tok'))
  }
  return {
    id,
    label: `测试档位 ${id}`,
    labelEn: `Test ${id}`,
    engine: 'whisper',
    repo: id.split('/')[0] + '/repo',
    revision: 'main',
    bytes: body.length,
    note: '',
    noteEn: '',
    languages: ['zh'],
    files,
    // 主文件的内容，placeTierFiles 按文件名取不到时就用它。
    __body: body,
    __mainName: name,
  }
}

/** 把档位文件按宿主认的那个位置摆好（`DSH_HOME/voice-typing/models/<repo>/<name>`）。 */
function placeTierFiles(home, tier, overrides = {}) {
  const dir = path.join(home, 'voice-typing', 'models', tier.repo)
  fs.mkdirSync(dir, { recursive: true })
  for (const file of tier.files) {
    const content = overrides[file.name] !== undefined
      ? overrides[file.name]
      : (file.name === tier.__mainName ? tier.__body : Buffer.from('tok'))
    fs.writeFileSync(path.join(dir, file.name), content)
  }
}

/**
 * 起一套真宿主路由。`stubAsrWorker` 把识别线程换成「当场拒绝」的替身：
 * 没有它，预热那条路要等 120 秒超时（而那正是本文件要验的分支之一）。
 */
async function withRoutes({ tier, modelId, stubAsrWorker = false, transform = null }, body) {
  const home = fs.mkdtempSync(path.join(osPkg.tmpdir(), 'dsh-asr-ready-home-'))
  const tiers = tier ? [tier] : []
  const STUB_WORKER = "({ on() {}, terminate() {}, postMessage() { throw new Error('fake: 测试环境没有识别线程') } })"
  const REAL_WORKER = "new Worker(new URL('./asr-worker.js', import.meta.url))"
  const env = await loadHostRoutes({
    dshHome: home,
    appendAsrTiers: tiers,
    rowConfig: modelId ? { model: modelId } : {},
    // 自检：替身必须真的换掉了那一句。换不掉（宿主写法变了）就是判据失效，
    // 而不是「预热刚好成功/失败」——后者会让这一版测试悄悄退回验不动的东西。
    requireRewrite: stubAsrWorker ? [['识别线程换成当场拒绝的替身', REAL_WORKER, STUB_WORKER]] : [],
    transform: (code, file) => {
      if (stubAsrWorker && file === 'index.js') {
        code = code.replace(REAL_WORKER, STUB_WORKER)
      }
      return transform ? transform(code, file) : code
    },
  })
  try {
    await body({ env, home })
  } finally {
    env.restore()
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
  }
}

/** 场景体：/asr-ready 的三档状态 + /asr-warmup 的两条快失败分支。 */
async function scenarioReadyStates(transform = null) {
  observedReasons.clear()
  const body = patternBuffer(2048, 7)
  const tier = makeTier('test-asr-ready/model', 'model.onnx', body)

  await withRoutes({ tier, modelId: tier.id, stubAsrWorker: true, transform }, async ({ env }) => {
    const res = await env.request('/dsh-voice-typing/asr-ready')
    add('[宿主·档位没下载] GET /asr-ready 返回 200', res.statusCode === 200, `status=${res.statusCode}`)
    const data = res.json()
    add('[宿主·档位没下载] 响应带齐客户端要读的五个字段',
      ['ready', 'downloaded', 'loaded', 'model', 'reason'].every((k) => k in data),
      JSON.stringify(data))
    add('[宿主·档位没下载] ready=false 且 downloaded=false',
      data.ready === false && data.downloaded === false, JSON.stringify(data))
    add('[宿主·档位没下载] reason 报的是「还没下载」这个码（句子由客户端 i18n 出，批次 18 §8.60）',
      noteReason(data.reason) === ASR_READY_REASONS.NOT_DOWNLOADED, JSON.stringify(data.reason))
    add('[宿主·档位没下载] 宿主这句不是给人看的句子：纯 ASCII，不含中文',
      /^[\x20-\x7E]*$/.test(String(data.reason)), JSON.stringify(data.reason))
    add('[宿主·档位没下载] model 回的是**设置里那一档**的 id（客户端提示要用它）',
      data.model === tier.id, JSON.stringify(data.model))

    const warm = await env.request('/dsh-voice-typing/asr-warmup', { method: 'POST' })
    add('[宿主·预热·档位没下载] 不去加载，直接报「还没下载」的码',
      warm.json().ready === false && noteReason(warm.json().reason) === ASR_READY_REASONS.NOT_DOWNLOADED,
      JSON.stringify(warm.json()))
  })

  // 文件摆齐（sha 对得上）= 已下载；但 loaded 只能由真 worker 回执翻上来。
  await withRoutes({ tier, modelId: tier.id, stubAsrWorker: true, transform }, async ({ env, home }) => {
    placeTierFiles(home, tier)
    const data = (await env.request('/dsh-voice-typing/asr-ready')).json()
    add('[宿主·已下载未加载] downloaded=true 但 loaded=false',
      data.downloaded === true && data.loaded === false, JSON.stringify(data))
    add('[宿主·已下载未加载] ready 仍然是 false（下载完 ≠ 能识别）',
      data.ready === false, JSON.stringify(data))
    // 批次 18（docs §8.60）：宿主这一路改成只报码。
    // 上面批次 9 那两条「必须给一句能看的原因 / 原因里不许写死秒数」现在由这条码契约**结构性**兜住：
    // 一个 ASCII 码里既没有文案也没有时长，文案的唯一来源是客户端 i18n 字典。
    add('[宿主·已下载未加载] reason 是「正在加载」这个码（界面那句话由客户端 i18n 出）',
      noteReason(data.reason) === ASR_READY_REASONS.LOADING, JSON.stringify(data.reason))
    add('[宿主·已下载未加载] reason 里不可能写死时长：宿主这一路根本不出句子',
      !/\d/.test(String(data.reason)), JSON.stringify(data.reason))

    const warm = (await env.request('/dsh-voice-typing/asr-warmup', { method: 'POST' })).json()
    add('[宿主·预热·没有可用识别线程] 报失败而不是假装 ready',
      warm.ready === false && noteReason(warm.reason) === ASR_READY_REASONS.LOAD_FAILED, JSON.stringify(warm))
    const after = (await env.request('/dsh-voice-typing/asr-ready')).json()
    add('[宿主·预热失败之后] /asr-ready 依旧说没加载好（客户端因此不会开麦）',
      after.ready === false && after.loaded === false, JSON.stringify(after))
  })

  // 就绪判据是「内容对得上」，不是「文件在不在」。
  await withRoutes({ tier, modelId: tier.id, stubAsrWorker: true, transform }, async ({ env, home }) => {
    placeTierFiles(home, tier, { 'model.onnx': Buffer.from('这一份是半截的或者被换过的') })
    const data = (await env.request('/dsh-voice-typing/asr-ready')).json()
    add('[宿主·文件在但 sha 不符] 不算已下载（哈希对不上就是没下好）',
      data.downloaded === false && data.ready === false, JSON.stringify(data))
  })

  await withRoutes({ tier, modelId: tier.id, stubAsrWorker: true, transform }, async ({ env, home }) => {
    placeTierFiles(home, tier, { 'model.onnx': Buffer.alloc(0) })
    const data = (await env.request('/dsh-voice-typing/asr-ready')).json()
    add('[宿主·文件在但是空文件] 不算已下载（下载被中断留下的就是这种）',
      data.downloaded === false, JSON.stringify(data))
  })

  // 「非空」这条规则不是 sha 校验的重复品：`fileMatchesHash` 对**没记 sha256 的文件直接放行**
  // （宿主自己管的那类文件走的就是这条路）。真档位目前 24 个文件全部带 sha256，
  // 所以这里造一个不带 sha 的档位，验的是「只剩非空这一条防线时它还在」。
  {
    const bareTier = makeTier('test-asr-ready-bare/model', 'model.onnx', patternBuffer(1024, 3), { noSha: true })
    await withRoutes({ tier: bareTier, modelId: bareTier.id, stubAsrWorker: true, transform }, async ({ env, home }) => {
      placeTierFiles(home, bareTier, { 'model.onnx': Buffer.alloc(0) })
      const data = (await env.request('/dsh-voice-typing/asr-ready')).json()
      add('[宿主·没记 sha 的档位·空文件] 靠「非空」这一条挡住（没 sha 时它是唯一防线）',
        data.downloaded === false && data.ready === false, JSON.stringify(data))
      placeTierFiles(home, bareTier)
      const ok = (await env.request('/dsh-voice-typing/asr-ready')).json()
      add('[宿主·没记 sha 的档位·文件齐且非空] 算已下载（别把这条防线扩成永远不就绪）',
        ok.downloaded === true, JSON.stringify(ok))
    })
  }

  // 方法守卫：这两条路由客户端各用一种方法，另一种必须挡掉。
  await withRoutes({ tier, modelId: tier.id, stubAsrWorker: true, transform }, async ({ env }) => {
    add('[宿主·方法守卫] /asr-ready 只收 GET',
      (await env.request('/dsh-voice-typing/asr-ready', { method: 'POST' })).statusCode === 405)
    add('[宿主·方法守卫] /asr-warmup 只收 POST',
      (await env.request('/dsh-voice-typing/asr-warmup', { method: 'GET' })).statusCode === 405)
  })

  // 档位 id 被用户改成不存在的值：不能说「正在加载」，那是误导。
  await withRoutes({ tier, modelId: 'nope/missing', stubAsrWorker: true, transform }, async ({ env }) => {
    const data = (await env.request('/dsh-voice-typing/asr-ready')).json()
    add('[宿主·档位不存在] ready=false 且 reason 指到档位本身（码：model-not-found）',
      data.ready === false && noteReason(data.reason) === ASR_READY_REASONS.MODEL_NOT_FOUND, JSON.stringify(data))
    add('[宿主·档位不存在] model 仍回用户配的那个 id（界面要显示它）',
      data.model === 'nope/missing', JSON.stringify(data.model))
    const warm = (await env.request('/dsh-voice-typing/asr-warmup', { method: 'POST' })).json()
    add('[宿主·档位不存在] 预热也报同一个码，不去碰线程',
      warm.ready === false && noteReason(warm.reason) === ASR_READY_REASONS.MODEL_NOT_FOUND, JSON.stringify(warm))
  })

  // 完整性：四个码都被真回出来过，且这条链路上没出现过词表外的值。
  // 新增第五个失败分支而没登记进 `src/shared/asr-readiness.js` 时，红的就是这一条
  // （和批次 16 那条丢弃原因完整性判据同一个做法）。
  const notDriven = ASR_READY_REASON_VALUES.filter((code) => !observedReasons.has(code))
  const outside = [...observedReasons].filter((value) => !ASR_READY_REASON_VALUES.includes(value))
  add('词表完整性：四个原因码逐个被宿主真回出来过，且没有词表外的 reason',
    notDriven.length === 0 && outside.length === 0,
    JSON.stringify({ 没驱动到: notDriven, 词表外: outside }))
}

/**
 * 场景：「已加载」名单的记入与摘除都要真的发生（批次 6l-e，docs §8.46）。
 *
 * 它替代的那条源码正则判的是三处文本同时在场：
 *   `asrLoadedModels.add(spec.modelId)` + `.delete(modelId)` + `.delete(spec.modelId)`
 * 那三处各自都在别处有用（有的分支从来没调用方给过 modelId），文本在≠名单会翻回来。
 * 现在判的是能观察到的那件事：**释放之后 `/asr-ready` 到底还说不说 loaded**。
 *
 * 跑的是真链路：真宿主路由 + 真识别线程 + 只把第三方依赖 `sherpa-onnx-node` 换成假包
 * （批次 6e 那份替身）。真模型 230MB 不该进测试，而「加载成功」这条路径必须要有一个
 * 真会成功的加载器 —— 替身放在依赖那一层，协议、名单、路由响应全是生产代码在跑。
 *
 * 三点设置上的注意：
 *   - `preloadModels: false`：开机预热会在 500ms 后自己把配置里那档加载进来，
 *     那样「记入」就不是一次明确的动作了。关掉它，名单里唯一一次记入来自下面那次 `/asr-warmup`。
 *   - 档位用 `makeWhisperTier` 那三个文件名：宿主的 `modelPaths` 按文件名认路径，
 *     名字不对 `tokens` 解析成 null，worker 构造时就抛，红的是夹具不是被测代码。
 *   - 等路由一律走 `callRoute`（识别线程 unref，直接 await 会让进程提前退出）。
 */
async function scenarioLoadedLedger() {
  const tierId = 'test-listening-ledger/model'
  const { tier, files } = makeWhisperTier(tierId, 'test-listening/ledger')
  const home = fs.mkdtempSync(path.join(osPkg.tmpdir(), 'dsh-asr-ledger-home-'))
  placeWhisperTierFiles(home, tier, files)
  const modelDir = path.join(home, 'voice-typing', 'models', tier.repo)
  // 假 CDN 备好同一份内容：下面「摘除」那一步要靠**真下载**触发释放回调。
  const cdn = await startFakeCdn({ files: cdnFiles(tier, files) })
  const fake = fakeSherpa({ marker: '假识别' })
  fake.install()   // 必须在起线程之前：Worker 继承父进程 env
  const env = await loadHostRoutes({
    dshHome: home,
    cdnOrigin: cdn.origin,
    appendAsrTiers: [tier],
    // 万一「重新下载」那一处退化，用例也得在有界时间内跑完（压小重试轮数）。
    scaffoldRounds: true,
    rowConfig: { model: tierId, preloadModels: false },
    extraTreeFiles: fake.files,
  })
  const stream = env.openStream()
  try {
    const ready = async () => (await callRoute(env, '/dsh-voice-typing/asr-ready')).json()

    // ① 起点：文件齐、没人加载过。
    const before = await ready()
    add('[名单·起点] 下载齐但没加载：downloaded=true 且 loaded=false',
      before.downloaded === true && before.loaded === false, JSON.stringify(before))

    // ② 记入：真 `/asr-warmup` → 真线程回 ok → 名单记下这一档。
    const warm = await callRoute(env, '/dsh-voice-typing/asr-warmup', { method: 'POST', body: '{}' })
    add('[名单·记入] 预热回 ready:true（真 worker 的成功回执）',
      warm.statusCode === 200 && warm.json()?.ready === true,
      `status=${warm.statusCode} ${JSON.stringify(warm.json())}`)
    const afterWarm = await ready()
    add('[名单·记入] 之后 /asr-ready 报 loaded=true',
      afterWarm.loaded === true, JSON.stringify(afterWarm))
    add('[名单·记入] loaded 是**线程里真构造过识别器**换来的（不是主线程假报）',
      fake.events().some((e) => e.event === 'ctor' && e.thread >= 1),
      JSON.stringify(fake.events().map((e) => `${e.event}@${e.thread}`)))

    // ③ 摘除：删掉磁盘上其中一个文件 → 真 `/model` 重下 → 完成回调 releaseRecognizer(这一档)。
    fs.rmSync(path.join(modelDir, 'model-encoder.onnx'))
    const started = await callRoute(env, '/dsh-voice-typing/model', {
      method: 'POST', body: JSON.stringify({ id: tierId }),
    })
    add('[名单·摘除] 缺文件就重新下：/model 回 202 started（不是 alreadyReady）',
      started.statusCode === 202 && started.json()?.started === true && started.json()?.alreadyReady !== true,
      `status=${started.statusCode} ${JSON.stringify(started.json())}`)
    const gotReadyEvent = await waitUntil(
      () => stream.events().some((e) => e.event === 'model-ready' && e.data?.id === tierId),
      { timeoutMs: 20000, label: tierId },
    )
    add('[名单·摘除] 真下载跑完并广播了 model-ready',
      gotReadyEvent, JSON.stringify(stream.events().map((e) => e.event)))
    const after = await ready()
    add('[名单·摘除] 文件重新齐了、loaded 却回到 false（只加不减的写法就在这条红）',
      after.downloaded === true && after.loaded === false && after.ready === false,
      JSON.stringify(after))
    add('[名单·摘除] reason 回到「正在加载」这个码，客户端因此会先预热再开麦',
      noteReason(after.reason) === ASR_READY_REASONS.LOADING, JSON.stringify(after.reason))

    // ④ 成对的另一半要能再来一遍：释放不是「一次性把名单清干净」，
    //    客户端下次开麦会重新预热，名单要重新记上同一档。
    const again = await callRoute(env, '/dsh-voice-typing/asr-warmup', { method: 'POST', body: '{}' })
    const reloaded = await ready()
    add('[名单·再记入] 释放后重新预热又能 loaded=true（记入与摘除可以反复成对）',
      again.json()?.ready === true && reloaded.loaded === true,
      JSON.stringify({ warm: again.json(), ready: reloaded }))
  } finally {
    stream.close()
    env.restore()
    fake.uninstall()
    await cdn.close()
    for (const dir of [home, fake.dir]) {
      // Windows 上删临时目录会被杀毒/索引器短暂拦住；清理失败不能算判据失败。
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
    }
  }
}

const SCENARIOS = [
  ['宿主：/asr-ready 与 /asr-warmup 的真实响应', scenarioReadyStates],
  ['宿主：已加载名单的记入与摘除（真识别线程 + 真下载）', scenarioLoadedLedger],
]

async function evaluate(transform = null) {
  rows.length = 0
  for (const [label, fn] of SCENARIOS) {
    console.log(`\n${label}`)
    try {
      await fn(transform)
    } catch (error) {
      add(`${label}：场景跑通`, false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '))
    }
  }
  return rows.slice()
}


await evaluate(null)
passed = rows.filter((r) => r.ok).length
failed = rows.length - passed
console.log(`\n通过 ${passed}，失败 ${failed}（判据 ${rows.length} 条）`)
if (failed) process.exitCode = 1
