/**
 * 集成测试：`checkTtsEnvironment()` 这台「引擎自检」的接线（批次 6a）。
 *
 * 来源（docs/architecture-modernization.md §8.34 批次 6）：
 *   `test/local-tts.test.mjs` 里剩的 6 条**源码文本**判据长这样：
 *     check('本地引擎的 available 来自探测结果', /available: local\.available/.test(envSrc))
 *     check('不再拿平台判断当可用性', !/available: isLocalSupported\(\)/.test(envSrc))
 *     check('本地神经模型看模型下没下（isModelReady）', /await isModelReady\(tier\)/.test(envSrc))
 *     check('区分「模型没下载」与「运行时不可用」', /模型还没下载/.test(envSrc) && /缺少本地推理运行时/.test(envSrc))
 *     check('tts-env 的 nvidia-smi 也走统一参数', /PROBE_OPTS/.test(envSrc))
 *   它们判的是「这行字在不在源码里」，两头都不牢：
 *     - 假红：把 `available: local.available` 写成先解构再赋值（行为一字不变）它红；
 *     - 漏红：把 `available: local.available` 换成 `available: isLocalSupported()`（**这正是原先的 bug**）
 *       只要那行旧字面量被别处保留着，它照样绿；`nvidia-smi` 少传 PROBE_OPTS 也照样绿
 *       —— 因为源码里那个标识符还在。
 *
 * 现在跑的是真自检函数：子进程（powershell / nvidia-smi）走
 * `test/helpers/fake-child-process.mjs` 的记录仪，三个「外部世界」的入口
 * （在线音色列表、sherpa 运行时、模型是否就绪）在**临时拷贝**上装替身，
 * 于是判据变成：
 *   - 探测说 powershell 不在 → 自检里 local 就是不可用，**即使本机平台是支持的**；
 *   - 运行时缺失 + 模型也没下 → 说明写的是运行时，不是「模型还没下载」；
 *   - nvidia-smi 那次调用带没带超时/隐藏窗口/大缓冲 → 直接在记录上看。
 * 替身是否真的装上，用 `stubLanded()` 读临时树验证 —— 打空了就当场报错，
 * 绝不悄悄跑真实现（与 `host-routes.mjs` 的 `requireRewrite` 同一纪律）。
 *
 * 不在本文件的：`probeLocalEngine()` 三平台的探测细节（12 条）在
 * `test/local-tts-command.test.mjs`；`/tts` 的路由行为与失败留痕在
 * `test/tts-fallback-trace.test.mjs`。
 *
 * 批次 22-3-2（docs §8.67）把「哪一步没通」这句话从宿主的手里拿走了：
 *   每个条目现在给 `{available, reason, params, detail}`，`reason` 是
 *   `src/shared/tts-env-reasons.js` 里的码，界面那句中文/英文由客户端字典出，
 *   `detail` 那句原文只归 `/diagnostics` 读。所以这里原来那批
 *   `/缺少本地推理运行时/.test(detail)` 形状的话术判据，改成了「码对不对 + 参数带没带」：
 *   判的是**哪一条分支被走到**，而不是那条分支当时怎么写句子 —— 改文案不再动本文件，
 *   而「两个原因混成一句」这种真错误照样红（码只有一个）。
 *   `params` 的核对同时兜住「宿主加了个码却忘了收集它的参数」（逐码比对
 *   `TTS_ENV_REASON_PARAMS` 那份清单）。
 *
 * 运行：node test/tts-env-check.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { TTS_MODELS } from '../src/host/model-catalog.js'
import { TTS_ENV_REASONS, TTS_ENV_REASON_PARAMS, isTtsEnvReason } from '../src/shared/tts-env-reasons.js'
import { loadHostModuleWithFakeCp } from './helpers/fake-child-process.mjs'

/**
 * 这个条目的 `params` 是否正好是这个码该带的那些参数（不多不少）。
 * @param {{reason?: unknown, params?: unknown}} entry - 自检里的一个引擎条目。
 * @returns {boolean}
 */
function paramsMatchCode(entry) {
  const wanted = TTS_ENV_REASON_PARAMS[entry?.reason]
  if (!wanted) return false
  const given = Object.keys(entry?.params ?? {}).sort()
  return JSON.stringify(given) === JSON.stringify([...wanted].sort())
}

/**
 * `params.model` 是否点名了目录里的某个档位（用 **id**，批次 22-3-2 的裁定）。
 * 判据读的是 `TTS_MODELS` 这份数据本身（批次 5c 的老纪律：别再往测试里抄字面量），
 * 目录加档位、改名都不用动这里；把 `${tier.id}` 从参数里删掉才会红。
 */
const namesTierId = (params) => TTS_MODELS.some((tier) => tier.id === params?.model)

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/**
 * 三处替身：都装在 `tts-env.js` 的临时拷贝上，由 globalThis 上的开关决定返回值。
 * `guard` 为 null 表示这一处不装替身（跑真实现）。
 */
const STUB_ANCHORS = {
  runtime: {
    from: 'export function probeSherpaRuntime() {',
    to: 'export function probeSherpaRuntime() {\n  if (globalThis.__dshRuntimeStub) return globalThis.__dshRuntimeStub()',
  },
  modelReady: {
    from: '  const ready = await isModelReady(tier)',
    to: '  const ready = (globalThis.__dshModelReady !== undefined) ? globalThis.__dshModelReady : await isModelReady(tier)',
  },
  onlineVoices: {
    from: '    const voices = await listVoices()',
    to: '    const voices = (globalThis.__dshOnlineVoices !== undefined)\n'
      + '      ? await globalThis.__dshOnlineVoices()\n'
      + '      : await listVoices()',
  },
}

function clearStubs() {
  delete globalThis.__dshRuntimeStub
  delete globalThis.__dshModelReady
  delete globalThis.__dshOnlineVoices
}

/**
 * 装一批替身后装载 `tts-env`（子进程走记录仪，平台覆写留到 restore）。
 *
 * 两处默认就装替身，为的是**测试进程一次网都不出、一次真盘都不读**：
 *   - `onlineVoices`：不装的话 `checkOnline()` 会去连微软的 WebSocket；
 *   - `modelReady`：不装的话 `isModelReady()` 会读本机 `~/.dsh` 里的模型目录，
 *     结论随这台机器下没下载而变（判据就成了看机器脸色）。
 * 场景要改这两个的行为，直接覆盖 `globalThis.__dsh*` 即可。
 *
 * @param {object} options - { guards: string[], vendor }
 * @returns {Promise<object>} `{ env, stubLanded(key), restore() }`
 */
async function withTtsEnv({ guards = [], vendor = () => ({}) }) {
  clearStubs()
  const all = [...new Set(['onlineVoices', 'modelReady', ...guards])]
  const env = await loadHostModuleWithFakeCp('tts-env', {
    platform: 'win32',
    platformHold: true,
    vendor,
    tune: (code) => {
      for (const key of all) {
        const anchor = STUB_ANCHORS[key]
        if (!anchor) throw new Error(`未知的替身名：${key}`)
        code = code.replace(anchor.from, anchor.to)
      }
      return code
    },
  })
  // 默认应答：在线侧给 3 个音色（可用），模型侧给「没下载」。
  globalThis.__dshModelReady = false
  globalThis.__dshOnlineVoices = () => [{ shortName: 'a' }, { shortName: 'b' }, { shortName: 'c' }]
  /** 替身是否真的打进了临时树（打空了 = 判据会悄悄跑真实现）。 */
  const landed = {}
  for (const key of all) {
    landed[key] = fs.readFileSync(path.join(env.hostDir, 'tts-env.js'), 'utf8')
      .includes(STUB_ANCHORS[key].to)
  }
  const stubLanded = (key) => landed[key] === true
  const restore = () => {
    env.restore()
    clearStubs()
  }
  return { env, stubLanded, restore }
}

/** 从自检结果里按 id 取一个引擎条目。 */
const engineOf = (snapshot, id) => (snapshot.engines ?? []).find((e) => e.id === id)

console.log('\n== 1. 自检的骨架：三个引擎条目 + 各自回的是码 ==')
{
  const { env, restore } = await withTtsEnv({
    vendor: (call) => (call.cmd === 'nvidia-smi'
      ? { stdout: 'NVIDIA GeForce RTX 4060, 8188\n' }
      : { stdout: '5.1.19041.1\n' }),
  })
  try {
    const snapshot = await env.mod.checkTtsEnvironment({ ttsEngine: 'local' })
    const ids = (snapshot.engines ?? []).map((e) => e.id).join(',')
    check('自检给出 online / local / neural 三个引擎条目', ids === 'online,local,neural', ids)
    check('每个条目都有布尔 available、词表内的 reason，且 params 正好是这个码要的那几个',
      (snapshot.engines ?? []).every((e) => typeof e.available === 'boolean'
        && isTtsEnvReason(e.reason) && paramsMatchCode(e)),
      JSON.stringify(snapshot.engines))
    check('每个条目都留了一句 detail 原文（读者是 /diagnostics，不是界面）',
      (snapshot.engines ?? []).every((e) => typeof e.detail === 'string' && e.detail.trim().length > 0),
      JSON.stringify((snapshot.engines ?? []).map((e) => e.detail)))
    check('宿主不再给条目写行名（`label` 由客户端按 id 查字典，§8.67）',
      (snapshot.engines ?? []).every((e) => e.label === undefined),
      JSON.stringify((snapshot.engines ?? []).map((e) => e.label)))
    check('每个条目都带一句 note（取舍写在 /diagnostics 里，客户端一个字都不渲染它）',
      (snapshot.engines ?? []).every((e) => typeof e.note === 'string' && e.note.trim().length > 0),
      JSON.stringify((snapshot.engines ?? []).map((e) => e.note)))
    check('自检把「当前配的是哪个引擎」也带出来（面板要选中那一项）',
      snapshot.configured === 'local', JSON.stringify(snapshot.configured))
    check('平台/架构/Node 版本一起报（装机排查要这三样）',
      typeof snapshot.platform === 'string' && typeof snapshot.arch === 'string'
      && typeof snapshot.node === 'string', JSON.stringify({ p: snapshot.platform, a: snapshot.arch, n: snapshot.node }))
    const gpu = env.calls.filter((c) => c.cmd === 'nvidia-smi')
    check('自检里真的探了一次 nvidia-smi（不是写死「无显卡」）',
      gpu.length === 1, JSON.stringify(env.calls.map((c) => c.cmd)))
    check('探到的显卡名与显存写进结果（RTX 4060 / 8188 MB）',
      snapshot.gpu?.available === true && snapshot.gpu?.name === 'NVIDIA GeForce RTX 4060'
      && snapshot.gpu?.memoryMB === 8188, JSON.stringify(snapshot.gpu))
    check('nvidia-smi 那次探测也带统一参数：windowsHide（Electron 里不闪黑框）',
      gpu[0]?.opts?.windowsHide === true, JSON.stringify(gpu[0]?.opts))
    check('nvidia-smi 那次探测也带统一参数：maxBuffer 放大（列表输出会超默认 1MB）',
      gpu[0]?.opts?.maxBuffer > 1024 * 1024, JSON.stringify(gpu[0]?.opts))
    check('nvidia-smi 那次探测也带统一参数：有限超时（驱动挂住时自检不能永等）',
      Number.isFinite(gpu[0]?.opts?.timeout) && gpu[0].opts.timeout > 0, JSON.stringify(gpu[0]?.opts))
    check('本机上 nvidia-smi 与 powershell 用的是同一份超时值（不各写一份）',
      gpu[0]?.opts?.timeout === env.calls.find((c) => c.cmd === 'powershell')?.opts?.timeout,
      JSON.stringify({ smi: gpu[0]?.opts, ps: env.calls.find((c) => c.cmd === 'powershell')?.opts }))
  } finally {
    restore()
  }
}

console.log('\n== 2. 显卡探不到时不该编出可用 ==')
{
  const { env, restore } = await withTtsEnv({
    vendor: (call) => (call.cmd === 'nvidia-smi'
      ? { error: Object.assign(new Error('nvidia-smi not found'), { code: 'ENOENT' }) }
      : { stdout: '5.1.19041.1\n' }),
  })
  try {
    const snapshot = await env.mod.checkTtsEnvironment({})
    check('nvidia-smi 探不到 → gpu.available=false 且没有假名字',
      snapshot.gpu?.available === false && snapshot.gpu?.name === '',
      JSON.stringify(snapshot.gpu))
    check('自检仍然整体返回（显卡只是展示项，探不到不影响三个引擎条目）',
      (snapshot.engines ?? []).length === 3, JSON.stringify(snapshot.engines?.map((e) => e.id)))
  } finally {
    restore()
  }
}

console.log('\n== 3. local 条目的 available 来自探测，不是「平台对不对」==')
{
  // 探测说 powershell 不在（Windows 精简镜像的真实形态），而本机平台是「支持」的。
  const { env, restore } = await withTtsEnv({
    vendor: (call) => (call.cmd === 'nvidia-smi'
      ? { error: { message: 'ENOENT', code: 'ENOENT' } }
      : { error: Object.assign(new Error('spawn powershell ENOENT'), { code: 'ENOENT' }) }),
  })
  try {
    const snapshot = await env.mod.checkTtsEnvironment({})
    const local = engineOf(snapshot, 'local')
    check('平台声称支持本地（platformSupportsLocal 为真）',
      env.mod.platformSupportsLocal() === true, String(env.mod.platformSupportsLocal()))
    check('但探测探不到 powershell → 自检里 local 就是不可用',
      local?.available === false, JSON.stringify(local))
    check('不可用时报的是 local-missing-powershell 这个码（不再靠话术辨认哪一步）',
      local?.reason === TTS_ENV_REASONS.LOCAL_MISSING_POWERSHELL && paramsMatchCode(local),
      JSON.stringify({ reason: local?.reason, params: local?.params }))
    check('原始错误仍留在 detail 里（点名 powershell 与精简镜像，给 /diagnostics 读）',
      /powershell/.test(local?.detail ?? '') && /精简镜像/.test(local?.detail ?? ''),
      local?.detail)
    check('在线/神经两条不受本地探测影响（各自仍有结论）',
      typeof engineOf(snapshot, 'online')?.available === 'boolean'
      && typeof engineOf(snapshot, 'neural')?.available === 'boolean',
      JSON.stringify(snapshot.engines))
  } finally {
    restore()
  }
}
{
  const { env, restore } = await withTtsEnv({
    vendor: (call) => (call.cmd === 'nvidia-smi'
      ? { error: { message: 'ENOENT', code: 'ENOENT' } }
      : { stdout: '5.1.19041.1\n' }),
  })
  try {
    const snapshot = await env.mod.checkTtsEnvironment({})
    const local = engineOf(snapshot, 'local')
    check('对照：探到 powershell 时报 local-ready-powershell，版本号在 params 里而不是句子里',
      local?.available === true && local?.reason === TTS_ENV_REASONS.LOCAL_READY_POWERSHELL
        && local?.params?.version === '5.1.19041.1' && paramsMatchCode(local),
      JSON.stringify(local))
    check('默认发音人作为参数带出（界面那句由客户端把它填进去，宿主不造句）',
      typeof local?.params?.voice === 'string' && local.params.voice.length > 0,
      JSON.stringify(local?.params))
  } finally {
    restore()
  }
}

console.log('\n== 4. neural：运行时 / 模型两件事分别说清（不恒为可用）==')
{
  // 运行时缺失 + 模型也没下：要说「缺运行时」，不能两句混着说。
  const { env, stubLanded, restore } = await withTtsEnv({ guards: ['runtime', 'modelReady'] })
  try {
    check('替身装上了（运行时那处）', stubLanded('runtime'), STUB_ANCHORS.runtime.to)
    check('替身装上了（模型就绪那处）', stubLanded('modelReady'), STUB_ANCHORS.modelReady.to)
    globalThis.__dshRuntimeStub = () => ({ ok: false, kind: '' })
    globalThis.__dshModelReady = false
    const snapshot = await env.mod.checkTtsEnvironment({})
    const neural = engineOf(snapshot, 'neural')
    check('运行时缺失 → neural 不可用（不是恒为可用）',
      neural?.available === false, JSON.stringify(neural))
    check('报的是 neural-missing-runtime（界面那句由客户端按这个码出）',
      neural?.reason === TTS_ENV_REASONS.NEURAL_MISSING_RUNTIME && paramsMatchCode(neural),
      JSON.stringify({ reason: neural?.reason, params: neural?.params }))
    check('此时不许是「模型还没下载」那个码（一个码只说一件事，两个原因不混）',
      neural?.reason !== TTS_ENV_REASONS.NEURAL_MODEL_MISSING, String(neural?.reason))
  } finally {
    restore()
  }
}
{
  // 运行时在、模型没下：这才是「模型还没下载」。
  const { env, restore } = await withTtsEnv({ guards: ['runtime', 'modelReady'] })
  try {
    globalThis.__dshRuntimeStub = () => ({ ok: true, kind: 'wasm' })
    globalThis.__dshModelReady = false
    const snapshot = await env.mod.checkTtsEnvironment({})
    const neural = engineOf(snapshot, 'neural')
    check('运行时有、模型没下 → neural 不可用',
      neural?.available === false, JSON.stringify(neural))
    check('报的是 neural-model-missing',
      neural?.reason === TTS_ENV_REASONS.NEURAL_MODEL_MISSING && paramsMatchCode(neural),
      JSON.stringify({ reason: neural?.reason, params: neural?.params }))
    check('参数里点名了目录中的具体档位 id（用户知道要下哪一个，行名由客户端查字典）',
      namesTierId(neural?.params) === true, JSON.stringify(neural?.params))
    check('此时不许是「缺少本地推理运行时」那个码（两条分支互斥）',
      neural?.reason !== TTS_ENV_REASONS.NEURAL_MISSING_RUNTIME, String(neural?.reason))
  } finally {
    restore()
  }
}
{
  // 两样都齐：这时才允许报「可用」。
  const { env, restore } = await withTtsEnv({ guards: ['runtime', 'modelReady'] })
  try {
    globalThis.__dshRuntimeStub = () => ({ ok: true, kind: 'native' })
    globalThis.__dshModelReady = true
    const snapshot = await env.mod.checkTtsEnvironment({ neuralModel: 'vits-melo-zh_en' })
    const neural = engineOf(snapshot, 'neural')
    check('运行时 + 模型都就绪 → neural 可用',
      neural?.available === true, JSON.stringify(neural))
    check('可用时报 neural-ready，参数带的是用的哪个档位与哪种运行时',
      neural?.reason === TTS_ENV_REASONS.NEURAL_READY && paramsMatchCode(neural)
        && neural?.params?.model === 'vits-melo-zh_en' && neural?.params?.runtime === 'native',
      JSON.stringify({ reason: neural?.reason, params: neural?.params }))
    check('运行时种类给的是契约值（native / wasm），「原生加速」那句话归客户端出',
      ['native', 'wasm'].includes(neural?.params?.runtime), JSON.stringify(neural?.params))
  } finally {
    restore()
  }
}
{
  // 配置里给了一个目录里没有的档位：不能当成「就绪」。
  const { env, restore } = await withTtsEnv({ guards: ['runtime', 'modelReady'] })
  try {
    globalThis.__dshRuntimeStub = () => ({ ok: true, kind: 'wasm' })
    globalThis.__dshModelReady = true
    const snapshot = await env.mod.checkTtsEnvironment({ neuralModel: 'no/such-tier' })
    const neural = engineOf(snapshot, 'neural')
    check('档位名写错时退回默认档并照常给结论（不是崩掉，参数也照带）',
      typeof neural?.available === 'boolean' && isTtsEnvReason(neural?.reason) && paramsMatchCode(neural),
      JSON.stringify({ reason: neural?.reason, params: neural?.params }))
    check('退回的是目录里真实存在的档位（不编一个不存在的 id 给界面）',
      namesTierId(neural?.params) === true, JSON.stringify(neural?.params))
  } finally {
    restore()
  }
}

console.log('\n== 5. online：可用来自音色列表，失败回 online-unreachable ==')
{
  const { env, stubLanded, restore } = await withTtsEnv({ guards: ['onlineVoices'] })
  try {
    check('替身装上了（在线音色那处）', stubLanded('onlineVoices'), STUB_ANCHORS.onlineVoices.to)
    globalThis.__dshOnlineVoices = () => [{ shortName: 'zh-CN-XiaoxiaoNeural' }, { shortName: 'a' }, { shortName: 'b' }]
    const snapshot = await env.mod.checkTtsEnvironment({})
    const online = engineOf(snapshot, 'online')
    check('拿到 3 个音色 → online 可用，数量作为参数带出（那句「返回 N 个音色」由客户端填）',
      online?.available === true && online?.reason === TTS_ENV_REASONS.ONLINE_READY
        && online?.params?.count === '3' && paramsMatchCode(online),
      JSON.stringify(online))

    globalThis.__dshOnlineVoices = () => []
    const empty = engineOf(await env.mod.checkTtsEnvironment({}), 'online')
    check('连上了但列表是空 → 不可用，且回的是 online-no-voices（不是「可用（0 个音色）」）',
      empty?.available === false && empty?.reason === TTS_ENV_REASONS.ONLINE_NO_VOICES
        && paramsMatchCode(empty), JSON.stringify(empty))

    globalThis.__dshOnlineVoices = () => { throw new Error('fake: 连不上（测试桩）') }
    const broken = engineOf(await env.mod.checkTtsEnvironment({}), 'online')
    check('列音色抛错时自检不抛穿：available=false 且报 online-unreachable',
      broken?.available === false && broken?.reason === TTS_ENV_REASONS.ONLINE_UNREACHABLE
        && paramsMatchCode(broken), JSON.stringify(broken))
    check('原始错误没丢：它留在 detail 里（界面那句不许带错误原文，排查要看这一格）',
      /连不上/.test(broken?.detail ?? '') && /测试桩/.test(broken?.detail ?? ''), broken?.detail)
    check('在线这条不拖累另外两条（local 仍来自 powershell 探测）',
      engineOf(await env.mod.checkTtsEnvironment({}), 'local')?.available === true,
      'local 应为可用（powershell 探到了）')
  } finally {
    restore()
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
