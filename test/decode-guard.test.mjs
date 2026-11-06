/**
 * 解码循环的安全阀 + 流式档位的类别（批次 6k，docs/architecture-modernization.md §8.44）。
 *
 * 这个文件原来有 6 条源码正则，判的是三件事：
 *   ① `while (recognizer.isReady(stream)) decode(stream)` 必须有步数上限 ——
 *      decode 不推进状态时那个循环永不退出：跑在主线程就是把整个应用卡死（界面无响应、
 *      被看门狗杀掉，用户看到「DSH 闪退」），跑在识别线程就是那条 /transcribe 永远不回话；
 *   ② 上限要宽松到正常路径碰不到，不然会把好端端的一句话截断；
 *   ③ 流式档位（engine 'online'）必须用 OnlineRecognizer、按 isReady/decode/inputFinished
 *      那一套走 —— 用 OfflineRecognizer 配 transducer 会让 sherpa 的原生代码直接 exit(1)，
 *      整个应用没了。
 *
 * 现在三件事都按**跑出来的东西**判：把假 sherpa 的 `isReady` 调成「永远说还能再解」，
 * 看三条真路径是不是还在有限步内返回；调成「要 800 步」，看会不会被上限截断；
 * 正常档跑一遍，看构造出来的到底是哪一类、动作顺序对不对。
 * 判据只看观测值（返回了没、解了几步、构造了哪个类），
 * 不把 `MAX_DECODE_STEPS` 那个数字抄进断言 —— 上限值是生产的选择（见 src/host/decode-steps.js）。
 *
 * 三条真路径 = `decodeOnlineStream` 的三个调用点：
 *   1. 主线程兜底识别 `recognizeWithSherpa`（宿主导出的那个函数，直接驱动）；
 *   2. POST /asr-stream 的每一帧（流式实时字）；
 *   3. POST /transcribe → 识别线程（真 worker，跨线程跑生产那份 asr-worker.js）。
 * 「别处不许再手写第四个裸循环」不住在这个文件里，住在 eslint.config.js 的
 * `HOST_DECODE_LOOP_BAN`（真树由 test/no-undef.test.mjs 的全树 lint 执行）。
 *
 * 为什么这一批动了生产代码：老判据扫的是 index.js，于是它口中的「所有解码循环」
 * 只有两处；asr-worker.js 里那第三处**当时真的没有上限**。判据写成三路径真跑之后先红了一次
 * （那条 /transcribe 12s 没返回），补上共享实现再绿 —— 实录与取舍见 §8.44。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadHostRoutes } from './helpers/host-routes.mjs'
import { fakeSherpa } from './helpers/fake-sherpa.mjs'
import { makeReadyTier, placeTierFiles, frameOfLevel } from './helpers/fake-tier.mjs'
import { MODELS, findModel, STREAM_MODEL_ID } from '../src/host/model-catalog.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/**
 * 调一条路由并**有界**地等它。
 * 上限失效时循环永不退出，await 也就永不返回 —— 那样测试进程会挂在那里，
 * 判不出「哪一条红了」。所以这里用 Promise.race 把「没返回」如实摊成一次失败。
 */
async function callRoute(env, url, options = {}, timeoutMs = 12000) {
  let timer = null
  try {
    return await Promise.race([
      env.request(url, options),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${url}：${timeoutMs}ms 内没返回（解码循环没上限就会这样）`)), timeoutMs)
      }),
    ])
  } catch (error) {
    return { statusCode: 0, timedOut: true, text: error.message, json: () => ({ error: error.message }) }
  } finally {
    clearTimeout(timer)
  }
}

/** 一段肯定过能量门限（0.008）的 f32 采样：0.1 的恒定幅值，rms 就是 0.1。 */
const LOUD_SAMPLES = new Float32Array(1600).fill(0.1)

/**
 * 起一棵「真宿主 + 真 worker + 假 sherpa」的临时环境，跑完就拆。
 * @param {object} options - { onlineReady: 假 isReady 的答法, tiers: 合成档位数组, model: 行配置档位 id }
 * @param {(ctx: {env: object, fake: object}) => Promise<void>} body
 */
async function withHost({ onlineReady = 'never', tiers, model = null }, body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-decode-guard-'))
  for (const tier of tiers) placeTierFiles(home, tier.tier, tier.bodies)
  const fake = fakeSherpa({ marker: '假识别', onlineReady })
  fake.install()
  try {
    const env = await loadHostRoutes({
      dshHome: home,
      appendAsrTiers: tiers.map((t) => t.tier),
      rowConfig: { model: model ?? tiers[0].tier.id, preloadModels: false },
      extraTreeFiles: fake.files,
    })
    try {
      await body({ env, fake })
    } finally {
      env.restore()
    }
  } finally {
    fake.uninstall()
    for (const dir of [home, fake.dir]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 清理失败不算判据失败 */ }
    }
  }
}

/** 取某个时刻之后新记的事件（三条路径按顺序跑，新事件就归当前这一条）。 */
function since(events, mark) { return events.slice(mark) }
/** 新事件里最后一条 getResult 记到的解码步数。 */
function decodesOf(added) {
  const got = added.filter((e) => e.event === 'getResult')
  return got.length ? got[got.length - 1].extra?.decodes ?? null : null
}
/** 新事件里构造过哪些识别器类（'OnlineRecognizer' / 'OfflineRecognizer'）。 */
function builtOf(added) {
  return [...new Set(added.filter((e) => e.event === 'ctor' || e.event === 'factory').map((e) => e.extra?.name))]
}

// ---------------------------------------------------------------------------
// 1) 真档位表：流式那一档的 engine 必须是 'online'（它是所有分支的唯一开关）
// ---------------------------------------------------------------------------
console.log('档位表里那一档确实是流式（数据判据：比 findModel 的值，不比源码写法）')
{
  const streaming = findModel('zipformer2-zh')
  check('内置档位 zipformer2-zh 的 engine 是 online（engine 就是「用哪一类识别器」的开关）',
    streaming?.engine === 'online', JSON.stringify({ engine: streaming?.engine }))
  check('流式实时文字就固定走这一档（STREAM_MODEL_ID 与档位表指向同一条）',
    STREAM_MODEL_ID === 'zipformer2-zh' && findModel(STREAM_MODEL_ID)?.engine === 'online',
    String(STREAM_MODEL_ID))
  const onlineIds = MODELS.filter((m) => m.engine === 'online').map((m) => m.id)
  check('表里被标成 online 的就是这一档（没有第二档被顺手标成流式）',
    JSON.stringify(onlineIds) === JSON.stringify(['zipformer2-zh']), onlineIds.join(','))
}

// ---------------------------------------------------------------------------
// 2) 上限：isReady 永远说「还能再解」时，三条真路径都必须在有限步内返回
// ---------------------------------------------------------------------------
console.log('\n上限：decode 不推进状态时，三条真路径都收敛（假 isReady 永远为真）')
{
  const mainTier = makeReadyTier('dsg-6k-main', { engine: 'online', repo: 'fake-repo/decode-guard-main' })
  const workerTier = makeReadyTier('dsg-6k-worker', { engine: 'online', repo: 'fake-repo/decode-guard-worker' })
  const streamTier = makeReadyTier(STREAM_MODEL_ID, { engine: 'online', repo: 'fake-repo/decode-guard-stream' })
  await withHost(
    { onlineReady: 'always', tiers: [mainTier, workerTier, streamTier], model: workerTier.tier.id },
    async ({ env, fake }) => {
      // ① 主线程兜底识别：recognizeWithSherpa 是宿主导出的真函数。
      let mark = fake.events().length
      const main = await Promise.race([
        env.mod.recognizeWithSherpa(mainTier.tier, LOUD_SAMPLES, { language: 'zh' }),
        new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 12000)),
      ])
      let added = since(fake.events(), mark)
      check('主线程 recognizeWithSherpa 在「isReady 永不落假」下仍然返回（没把测试进程挂住）',
        !main?.hung && typeof main?.text === 'string', JSON.stringify({ hung: !!main?.hung }))
      const mainSteps = decodesOf(added)
      check('主线程那一圈解到上限就停：解了有限步（≥1000，说明阀真的在那儿）',
        typeof mainSteps === 'number' && mainSteps >= 1000, `实际 ${mainSteps}`)

      // ② 流式实时字：/asr-stream 每一帧都过那个循环。
      mark = fake.events().length
      const frame = await callRoute(env, `/dsh-voice-typing/asr-stream?sessionId=dsg-6k-always`, {
        method: 'POST', body: frameOfLevel(0.1), headers: { 'content-type': 'application/octet-stream' },
      })
      added = since(fake.events(), mark)
      check('/asr-stream 的一帧在「isReady 永不落假」下仍然回 200（客户端不会等到天荒地老）',
        frame.statusCode === 200, JSON.stringify({ status: frame.statusCode, err: frame.json?.()?.error }))
      const streamSteps = decodesOf(added)
      check('/asr-stream 那一圈也解到上限就停：有限步（≥1000）',
        typeof streamSteps === 'number' && streamSteps >= 1000, `实际 ${streamSteps}`)

      // ③ 识别线程：/transcribe 走真 worker（那份 asr-worker.js 就是生产用的）。
      mark = fake.events().length
      const transcribed = await callRoute(env, '/dsh-voice-typing/transcribe', {
        method: 'POST', body: frameOfLevel(0.1), headers: { 'content-type': 'application/octet-stream' },
      })
      added = since(fake.events(), mark)
      check('POST /transcribe（识别线程里跑）在「isReady 永不落假」下仍然回包 —— 批次 6k 之前这一条是红的',
        transcribed.statusCode === 200, JSON.stringify({ status: transcribed.statusCode, err: transcribed.json?.()?.error }))
      const workerSteps = decodesOf(since(added.filter((e) => e.thread && e.thread > 0), 0))
      check('识别线程那一圈同样有上限：线程里解了有限步（≥1000）',
        typeof workerSteps === 'number' && workerSteps >= 1000, `实际 ${workerSteps}`)
      check('这三条路径用的是同一个阀（三处观测到的步数一样）',
        mainSteps !== null && streamSteps !== null && workerSteps !== null
        && mainSteps === streamSteps && streamSteps === workerSteps,
        JSON.stringify({ mainSteps, streamSteps, workerSteps }))
    },
  )
}

// ---------------------------------------------------------------------------
// 3) 上限够宽松：真要解 800 步的流不能被截断（30 秒音频按 0.1 秒 chunk 算最多约 300 步）
// ---------------------------------------------------------------------------
console.log('\n宽松：isReady 要 800 步才落假的流，一步不多一步不少地解完')
{
  const mainTier = makeReadyTier('dsg-6k-room', { engine: 'online', repo: 'fake-repo/decode-guard-room' })
  const streamTier = makeReadyTier(STREAM_MODEL_ID, { engine: 'online', repo: 'fake-repo/decode-guard-room-stream' })
  await withHost(
    { onlineReady: 800, tiers: [mainTier, streamTier], model: mainTier.tier.id },
    async ({ env, fake }) => {
      let mark = fake.events().length
      const main = await env.mod.recognizeWithSherpa(mainTier.tier, LOUD_SAMPLES, { language: 'zh' })
      let added = since(fake.events(), mark)
      check('主线程：需要 800 步的流真解了 800 步（上限没插手）',
        decodesOf(added) === 800, JSON.stringify({ decodes: decodesOf(added) }))
      check('主线程：解完之后照样出文本（不是「被上限掐掉」那种半截结果）',
        typeof main?.text === 'string' && main.text.includes('假识别'), JSON.stringify(main))

      mark = fake.events().length
      const frame = await callRoute(env, '/dsh-voice-typing/asr-stream?sessionId=dsg-6k-room', {
        method: 'POST', body: frameOfLevel(0.1), headers: { 'content-type': 'application/octet-stream' },
      })
      added = since(fake.events(), mark)
      check('/asr-stream：同一帧需要 800 步时也是解满 800 步',
        frame.statusCode === 200 && decodesOf(added) === 800,
        JSON.stringify({ status: frame.statusCode, decodes: decodesOf(added) }))
    },
  )
}

// ---------------------------------------------------------------------------
// 4) 类别：engine 决定构造哪一类；流式那套动作顺序（正常档，isReady 一次就落假）
// ---------------------------------------------------------------------------
console.log('\n类别与顺序：engine=online 构造 OnlineRecognizer，engine=whisper 构造 OfflineRecognizer')
{
  const onlineTier = makeReadyTier('dsg-6k-online', { engine: 'online', repo: 'fake-repo/decode-guard-online' })
  const offlineTier = makeReadyTier('dsg-6k-offline', { engine: 'whisper', repo: 'fake-repo/decode-guard-offline' })
  const streamTier = makeReadyTier(STREAM_MODEL_ID, { engine: 'online', repo: 'fake-repo/decode-guard-online-stream' })
  await withHost(
    { onlineReady: 3, tiers: [onlineTier, offlineTier, streamTier], model: onlineTier.tier.id },
    async ({ env, fake }) => {
      let mark = fake.events().length
      await env.mod.recognizeWithSherpa(onlineTier.tier, LOUD_SAMPLES, { language: 'zh' })
      let added = since(fake.events(), mark)
      check('online 档真跑构造的是 OnlineRecognizer（旧判据扫的是那句三元表达式）',
        builtOf(added).includes('OnlineRecognizer') && !builtOf(added).includes('OfflineRecognizer'),
        builtOf(added).join(','))
      // 这一条就是老的「流式用 isReady/decode/inputFinished 的方式」：
      // 判的是**跑出来的动作顺序**，不是源码里有没有那句 `stream.inputFinished`。
      const mainOrder = added.filter((e) => ['acceptWaveform', 'decode', 'inputFinished', 'getResult'].includes(e.event))
        .map((e) => e.event)
      check('整段识别真按「喂进去 → 循环解 → isReady 落假 → inputFinished → 取结果」走完',
        mainOrder.indexOf('acceptWaveform') === 0
        && mainOrder.indexOf('decode') > 0
        && mainOrder.indexOf('inputFinished') > mainOrder.indexOf('decode')
        && mainOrder.indexOf('getResult') > mainOrder.indexOf('inputFinished'),
        mainOrder.join(' → '))
      check('isReady 说还能解 3 次，就真的解了 3 次（循环的推动力是 isReady，不是猜的）',
        mainOrder.filter((n) => n === 'decode').length === 3 && decodesOf(added) === 3,
        JSON.stringify({ 记到的: decodesOf(added), 顺序: mainOrder }))

      mark = fake.events().length
      await env.mod.recognizeWithSherpa(offlineTier.tier, LOUD_SAMPLES, { language: 'zh' })
      added = since(fake.events(), mark)
      check('whisper 档真跑构造的是 OfflineRecognizer（同一处分支的另一半）',
        builtOf(added).includes('OfflineRecognizer') && !builtOf(added).includes('OnlineRecognizer'),
        builtOf(added).join(','))
      const offlineSteps = decodesOf(added)
      check('离线档不进解码循环（只解一次，也没有 inputFinished 那一步）',
        offlineSteps === 1 && !added.some((e) => e.event === 'inputFinished'),
        JSON.stringify({ decodes: offlineSteps, events: added.map((e) => e.event) }))

      mark = fake.events().length
      const frame = await callRoute(env, '/dsh-voice-typing/asr-stream?sessionId=dsg-6k-order', {
        method: 'POST', body: frameOfLevel(0.1), headers: { 'content-type': 'application/octet-stream' },
      })
      added = since(fake.events(), mark)
      const frameOrder = added.filter((e) => ['acceptWaveform', 'decode', 'inputFinished', 'getResult'].includes(e.event))
        .map((e) => e.event)
      check('/asr-stream 的一帧走「喂 → 循环解 → 取这帧的最新字」，逐帧不收尾',
        frame.statusCode === 200
        && frameOrder.indexOf('acceptWaveform') === 0
        && frameOrder.indexOf('decode') > 0
        && frameOrder.indexOf('getResult') > frameOrder.indexOf('decode'),
        JSON.stringify({ status: frame.statusCode, 顺序: frameOrder }))
      check('/asr-stream 一帧里不许调 inputFinished（那是「这段说完了」的收尾；连续流每帧收尾会把没说完的话提前定稿）',
        !frameOrder.includes('inputFinished'), frameOrder.join(' → '))

      mark = fake.events().length
      const transcribed = await callRoute(env, '/dsh-voice-typing/transcribe', {
        method: 'POST', body: frameOfLevel(0.1), headers: { 'content-type': 'application/octet-stream' },
      })
      added = since(fake.events(), mark).filter((e) => e.thread > 0)
      check('/transcribe 交给识别线程时，engine=online 映射成线程里的 OnlineRecognizer（spec.kind=transducer 那条路）',
        transcribed.statusCode === 200 && builtOf(added).includes('OnlineRecognizer'),
        JSON.stringify({ status: transcribed.statusCode, built: builtOf(added) }))
      const threadOrder = added.filter((e) => ['acceptWaveform', 'decode', 'inputFinished'].includes(e.event))
        .map((e) => e.event)
      check('线程里也是那一套顺序：喂 → 解 → inputFinished',
        threadOrder.indexOf('acceptWaveform') === 0
        && threadOrder.indexOf('decode') > 0
        && threadOrder.indexOf('inputFinished') > threadOrder.indexOf('decode'),
        threadOrder.join(' → '))
    },
  )
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
