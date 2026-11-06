/**
 * 集成测试：`/tts` 的引擎回退与「回退必须留痕」（批次 6a）。
 *
 * 来源（docs/architecture-modernization.md §8.34 批次 6）：
 *   `test/local-tts.test.mjs` 里剩的 20 条**源码文本**判据长这样：
 *     check('回退时把失败次数记下来', /stats\.localTtsFailures \+= 1/.test(idxSrc))
 *     check('/diagnostics 里含失败次数/原因/时间', /failures: stats\.localTtsFailures/.test(idxSrc))
 *     check('本地合成的 mime 由 format 决定', /mime = format === 'aiff' \? 'audio\/aiff' : 'audio\/wav'/)
 *   钉的全是写法：把那三行统计抽成一个 `recordLocalFailure(error)` helper，它红；
 *   而真的把 `stats.localTtsFailures += 1` 写成 `+= 0`、或者把 diagnostics 里的
 *   `failures:` 对上 `stats.onlineTtsFailures`（张冠李戴），它照样绿。
 *   更要紧的是它判不到**行为**：选了本地却静默用了在线，用户以为文本没出网 ——
 *   这件事本来可以直接看响应头和 `/diagnostics`，不用看源码。
 *
 * 现在跑的是真宿主路由（`test/helpers/host-routes.mjs`：真 `apply()`、真 handler、
 * 真 req/res），只把三个引擎的「产出音频」那一步换成可控替身（替身必须装上，
 * 装不上就抛错，绝不悄悄跑真实现 —— 见 `requireRewrite`）。于是：
 *   - 回退计数 → 连发两次失败的本地合成，看 `/diagnostics` 里 `localTts.failures` 是不是 2；
 *   - 隐私可见性 → 看 `x-tts-engine` / `x-tts-engine-fallback` 这两个头；
 *   - mime → 替身给 AIFF 就得是 `audio/aiff`，不给 format 就得按 wav 兜底；
 *   - 「在线炸了才回退本地，本地也炸就把在线那个原始错误抛出去」→ 看 500 的 error 文本。
 *
 * 三平台命令行那一层（say / powershell / espeak 的参数、临时文件、编码行）
 * 不在本文件，见 `test/local-tts-command.test.mjs`。
 *
 * 运行：node test/tts-fallback-trace.test.mjs
 */
import fs from 'node:fs'
import osPkg from 'node:os'
import path from 'node:path'
import { loadHostRoutes } from './helpers/host-routes.mjs'
import { fakeWavBytes, fakeAiffBytes } from './helpers/fake-child-process.mjs'
import { isLocalSupported } from '../src/host/local-tts.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 替身给「在线产物」用的字节：不是真 MP3，但足以验证宿主原样透传、并按在线容器报 mime。 */
const ONLINE_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x05, 0x06])
const LOCAL_MSG = 'fake: 本地合成炸了（测试桩）'
const ONLINE_MSG = 'fake: 在线合成炸了（测试桩）'
const NEURAL_MSG = 'fake: 神经合成炸了（测试桩）'

/**
 * 三个引擎的「产出音频」那一步换成替身。
 * 每条都记 `[标签, 原文片段, 替身片段]`：`loadHostRoutes` 会先确认原文片段在源码树里
 * （片段没了 = 生产代码换了写法，这条自检该跟着改），再确认替身真的打上了。
 */
const STUBS = [
  {
    file: 'local-tts.js',
    label: '本地系统语音合成换成可控替身',
    from: 'export async function synthesizeLocal(options) {',
    to: 'export async function synthesizeLocal(options) {\n  if (globalThis.__dshLocalStub) return globalThis.__dshLocalStub(options)',
  },
  {
    file: 'edge-tts.js',
    label: '在线（Edge）合成换成可控替身（不联网）',
    from: 'export async function synthesizeSpeech(options, timeoutMs = DEFAULT_TIMEOUT_MS) {',
    to: 'export async function synthesizeSpeech(options, timeoutMs = DEFAULT_TIMEOUT_MS) {\n  if (globalThis.__dshOnlineStub) return globalThis.__dshOnlineStub(options)',
  },
  {
    file: 'neural-tts.js',
    label: '本地神经合成换成可控替身（不起 worker）',
    from: 'export async function synthesizeNeural(options) {',
    to: 'export async function synthesizeNeural(options) {\n  if (globalThis.__dshNeuralStub) return globalThis.__dshNeuralStub(options)',
  },
]

function clearStubs() {
  delete globalThis.__dshLocalStub
  delete globalThis.__dshOnlineStub
  delete globalThis.__dshNeuralStub
}

/**
 * 起一套真宿主路由（临时 DSH_HOME、预加载关掉），跑完一定拆干净。
 * @param {object} rowConfig - 行配置（`ttsEngine` 等）。
 * @param {(env: object) => Promise<void>} body。
 */
async function withTtsHost(rowConfig, body) {
  const home = fs.mkdtempSync(path.join(osPkg.tmpdir(), 'dsh-tts-home-'))
  clearStubs()
  const env = await loadHostRoutes({
    dshHome: home,
    // 关掉预加载：这里测的是合成路径，不是「模型有没有被读进内存」。
    rowConfig: { preloadModels: false, ...rowConfig },
    requireRewrite: STUBS.map((s) => [s.label, s.from, s.to]),
    transform: (code, file) => {
      for (const s of STUBS) {
        if (s.file === file) code = code.replace(s.from, s.to)
      }
      return code
    },
  })
  try {
    await body(env)
  } finally {
    env.restore()
    clearStubs()
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
  }
}

const ttsUrl = (text) => `/dsh-voice-typing/tts?text=${encodeURIComponent(text)}`
const getDiagnostics = async (env) => (await env.request('/dsh-voice-typing/diagnostics')).json()
const bodyBytes = (res) => Buffer.concat(res.chunks)

console.log('\n== 1. 选了本地、本地炸了：回退在线，但回退必须看得见 ==')
{
  await withTtsHost({ ttsEngine: 'local' }, async (env) => {
    globalThis.__dshLocalStub = () => { throw new Error(LOCAL_MSG) }
    globalThis.__dshOnlineStub = async () => ONLINE_BYTES
    const before = Date.now()
    const res = await env.request(ttsUrl('今天下午 3 点开会'))
    const after = Date.now()
    check('[local→online] 本地炸了仍然 200（保证「总有声音」）',
      res.statusCode === 200, `${res.statusCode} ${res.text}`)
    check('[local→online] 实际用的引擎写在响应头里（x-tts-engine: online）',
      res.headers?.['x-tts-engine'] === 'online', JSON.stringify(res.headers))
    check('[local→online] 「回退了」这件事写在响应头里（x-tts-engine-fallback: online）',
      res.headers?.['x-tts-engine-fallback'] === 'online', JSON.stringify(res.headers))
    check('[local→online] 产物就是在线替身给的那段字节（原样透传，没有中途换容器）',
      Buffer.compare(bodyBytes(res), ONLINE_BYTES) === 0, bodyBytes(res).toString('hex'))
    check('[local→online] 在线产物的容器按 mp3 报（content-type 与 x-dsh-audio-format 一对）',
      res.headers?.['content-type'] === 'audio/mpeg' && res.headers?.['x-dsh-audio-format'] === 'mp3',
      JSON.stringify({ type: res.headers?.['content-type'], format: res.headers?.['x-dsh-audio-format'] }))

    const diag = await getDiagnostics(env)
    check('[local→online] /diagnostics 里有 localTts 这一组（不是只在源码里存在）',
      diag.localTts && typeof diag.localTts === 'object', JSON.stringify(Object.keys(diag)))
    check('[local→online] 失败次数记成 1',
      diag.localTts?.failures === 1, JSON.stringify(diag.localTts))
    check('[local→online] 失败原因是本地那个真错误（不是在线的）',
      String(diag.localTts?.lastError ?? '').includes(LOCAL_MSG), diag.localTts?.lastError)
    check('[local→online] 失败时间落在这次请求之间',
      Number.isFinite(diag.localTts?.lastAt) && diag.localTts.lastAt >= before && diag.localTts.lastAt <= after,
      JSON.stringify({ before, after, lastAt: diag.localTts?.lastAt }))
    check('[local→online] 事件记录里写明了 fallback: online',
      (diag.localTts?.events ?? []).some((e) => e.fallback === 'online' && e.engine === 'local'),
      JSON.stringify(diag.localTts?.events))
    check('[local→online] 回退不该算成在线引擎的失败（onlineTts.failures 仍是 0）',
      diag.onlineTts?.failures === 0, JSON.stringify(diag.onlineTts))
  })
}

console.log('\n== 2. 本地正常：不该有回退头、不该记失败 ==')
{
  await withTtsHost({ ttsEngine: 'local' }, async (env) => {
    globalThis.__dshLocalStub = async () => ({ audio: fakeWavBytes(16), format: 'wav' })
    const res = await env.request(ttsUrl('正常的一句'))
    check('[local 正常] 200 且实际引擎就是 local',
      res.statusCode === 200 && res.headers?.['x-tts-engine'] === 'local',
      `${res.statusCode}/${res.headers?.['x-tts-engine']}`)
    check('[local 正常] 没有 x-tts-engine-fallback（只有真回退了才加这个头）',
      res.headers && !('x-tts-engine-fallback' in res.headers), JSON.stringify(res.headers))
    check('[local 正常] 本地 wav 的 content-type 是 audio/wav',
      res.headers?.['content-type'] === 'audio/wav' && res.headers?.['x-dsh-audio-format'] === 'wav',
      JSON.stringify({ type: res.headers?.['content-type'], format: res.headers?.['x-dsh-audio-format'] }))
    check('[local 正常] 产物字节原样透传（RIFF 头还在）',
      bodyBytes(res).slice(0, 4).toString('latin1') === 'RIFF', bodyBytes(res).slice(0, 4).toString('hex'))
    const diag = await getDiagnostics(env)
    check('[local 正常] localTts.failures 仍是 0',
      diag.localTts?.failures === 0, JSON.stringify(diag.localTts))
  })
}

console.log('\n== 3. mime 必须跟真实容器走（AIFF 报 audio/aiff，缺 format 按 wav 兜底）==')
{
  // macOS 的老 `say` 只能出 AIFF：报成 audio/wav 时浏览器 decodeAudioData 抛错，整句被丢。
  await withTtsHost({ ttsEngine: 'local' }, async (env) => {
    globalThis.__dshLocalStub = async () => ({ audio: fakeAiffBytes(16), format: 'aiff' })
    const res = await env.request(ttsUrl('AIFF 的一句'))
    check('[mime] 替身给 AIFF → content-type 是 audio/aiff、头里的格式是 aiff',
      res.headers?.['content-type'] === 'audio/aiff' && res.headers?.['x-dsh-audio-format'] === 'aiff',
      JSON.stringify({ type: res.headers?.['content-type'], format: res.headers?.['x-dsh-audio-format'] }))
    check('[mime] AIFF 的字节没被改写（FORM 头在）',
      bodyBytes(res).slice(0, 4).toString('latin1') === 'FORM', bodyBytes(res).slice(0, 4).toString('hex'))
  })
  await withTtsHost({ ttsEngine: 'local' }, async (env) => {
    globalThis.__dshLocalStub = async () => ({ audio: fakeWavBytes(8) })
    const res = await env.request(ttsUrl('没给 format 的一句'))
    check('[mime] 替身没给 format → 按 wav 兜底（不是空串、不是 mp3）',
      res.headers?.['x-dsh-audio-format'] === 'wav' && res.headers?.['content-type'] === 'audio/wav',
      JSON.stringify({ type: res.headers?.['content-type'], format: res.headers?.['x-dsh-audio-format'] }))
  })
}

console.log('\n== 4. 在线炸了 → 回退本地系统语音（也要留痕）==')
{
  await withTtsHost({ ttsEngine: 'online' }, async (env) => {
    globalThis.__dshOnlineStub = () => { throw new Error(ONLINE_MSG) }
    globalThis.__dshLocalStub = async () => ({ audio: fakeWavBytes(16), format: 'wav' })
    const before = Date.now()
    const res = await env.request(ttsUrl('在线炸了的一句'))
    const after = Date.now()
    const diag = await getDiagnostics(env)
    if (isLocalSupported()) {
      check('[online→local] 在线失败仍拿到 200（回退本地兜底）',
        res.statusCode === 200, `${res.statusCode} ${res.text}`)
      check('[online→local] 实际引擎写成本地（x-tts-engine: local）',
        res.headers?.['x-tts-engine'] === 'local', JSON.stringify(res.headers))
      check('[online→local] 回退头写的是 local（不是 online —— 用户听的其实是系统语音）',
        res.headers?.['x-tts-engine-fallback'] === 'local', JSON.stringify(res.headers))
      check('[online→local] 容器跟着本地产物走（audio/wav）',
        res.headers?.['content-type'] === 'audio/wav', res.headers?.['content-type'])
      check('[online→local] 本地兜底成功时不该记本地失败',
        diag.localTts?.failures === 0, JSON.stringify(diag.localTts))
    } else {
      check(`[online→local] 本机平台（${process.platform}）不支持本地时按 500 报错`,
        res.statusCode === 500, `${res.statusCode} ${res.text}`)
    }
    check('[online→local] 在线失败次数记成 1',
      diag.onlineTts?.failures === 1, JSON.stringify(diag.onlineTts))
    check('[online→local] 在线失败原因是替身抛的那条',
      String(diag.onlineTts?.lastError ?? '').includes(ONLINE_MSG), diag.onlineTts?.lastError)
    check('[online→local] 在线失败时间落在这次请求之间',
      Number.isFinite(diag.onlineTts?.lastAt) && diag.onlineTts.lastAt >= before && diag.onlineTts.lastAt <= after,
      JSON.stringify({ before, after, lastAt: diag.onlineTts?.lastAt }))
    check('[online→local] 事件记录里带上了引擎与回退去向',
      (diag.onlineTts?.events ?? []).some((e) => e.engine === 'online'
        && e.fallback === (isLocalSupported() ? 'local' : 'none')),
      JSON.stringify(diag.onlineTts?.events))
  })
}

console.log('\n== 5. 在线和本地都炸：抛的是在线那条原始错误 ==')
{
  await withTtsHost({ ttsEngine: 'online' }, async (env) => {
    globalThis.__dshOnlineStub = () => { throw new Error(ONLINE_MSG) }
    globalThis.__dshLocalStub = () => { throw new Error(LOCAL_MSG) }
    const res = await env.request(ttsUrl('两边都炸的一句'))
    const diag = await getDiagnostics(env)
    check('[两边都炸] 返回 500（不是假装成功）', res.statusCode === 500, `${res.statusCode}`)
    check('[两边都炸] 错误文本是在线那条原始错误（本地那条只是兜底失败）',
      String(JSON.stringify(res.json())).includes(ONLINE_MSG)
      && !String(res.json()?.error ?? '').includes(LOCAL_MSG),
      JSON.stringify(res.json()))
    check('[两边都炸] 在线失败仍记 1 次',
      diag.onlineTts?.failures === 1, JSON.stringify(diag.onlineTts))
    if (isLocalSupported()) {
      check('[两边都炸] 本地兜底也失败时同样留痕（failures 1 + 原因来自本地）',
        diag.localTts?.failures === 1 && String(diag.localTts.lastError).includes(LOCAL_MSG),
        JSON.stringify(diag.localTts))
      check('[两边都炸] 本地那条事件写的是 fallback: failed，并带上原始在线错误',
        (diag.localTts?.events ?? []).some((e) => e.fallback === 'failed'
          && String(e.originalError ?? '').includes(ONLINE_MSG)),
        JSON.stringify(diag.localTts?.events))
    }
  })
}

console.log('\n== 6. 神经引擎失败：没有回退，但计数与原因必须可见 ==')
{
  await withTtsHost({ ttsEngine: 'neural', neuralModel: 'vits-melo-zh_en' }, async (env) => {
    globalThis.__dshNeuralStub = () => { throw new Error(NEURAL_MSG) }
    const before = Date.now()
    const res = await env.request(ttsUrl('神经炸了的一句'))
    const after = Date.now()
    const diag = await getDiagnostics(env)
    check('[neural] 500 且错误就是神经那条', res.statusCode === 500
      && String(res.json()?.error ?? '').includes(NEURAL_MSG), `${res.statusCode} ${res.text}`)
    check('[neural] neuralTts.failures 记成 1',
      diag.neuralTts?.failures === 1, JSON.stringify(diag.neuralTts))
    check('[neural] 原因与时间都留了（原因含替身消息，时间落在请求区间）',
      String(diag.neuralTts?.lastError ?? '').includes(NEURAL_MSG)
      && Number.isFinite(diag.neuralTts?.lastAt)
      && diag.neuralTts.lastAt >= before && diag.neuralTts.lastAt <= after,
      JSON.stringify(diag.neuralTts))
    check('[neural] 神经失败不该记到本地/在线头上（各自仍是 0）',
      diag.localTts?.failures === 0 && diag.onlineTts?.failures === 0,
      JSON.stringify({ local: diag.localTts?.failures, online: diag.onlineTts?.failures }))
  })
}

console.log('\n== 7. 计数会累计、时间会往前走（不是每次覆盖成 1）==')
{
  await withTtsHost({ ttsEngine: 'local' }, async (env) => {
    globalThis.__dshLocalStub = () => { throw new Error(LOCAL_MSG) }
    globalThis.__dshOnlineStub = async () => ONLINE_BYTES
    const one = await env.request(ttsUrl('第一句'))
    const first = await getDiagnostics(env)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const two = await env.request(ttsUrl('第二句'))
    const second = await getDiagnostics(env)
    check('[累计] 两次本地失败之后 failures 是 2',
      second.localTts?.failures === 2, JSON.stringify(second.localTts))
    check('[累计] lastAt 跟着更新（不早于第一次的时间）',
      second.localTts?.lastAt >= first.localTts?.lastAt,
      JSON.stringify({ first: first.localTts?.lastAt, second: second.localTts?.lastAt }))
    check('[累计] 事件队列里两条都在（环形缓冲没被覆盖掉）',
      (second.localTts?.events ?? []).length === 2, JSON.stringify(second.localTts?.events))
    check('[累计] 每一次回退都各自带了回退头（不是只在第一次带）',
      one.headers?.['x-tts-engine-fallback'] === 'online'
      && two.headers?.['x-tts-engine-fallback'] === 'online',
      JSON.stringify([one.headers, two.headers]))
  })
}

console.log('\n== 8. 对照：在线正常时不带任何回退头 ==')
{
  await withTtsHost({ ttsEngine: 'online' }, async (env) => {
    globalThis.__dshOnlineStub = async () => ONLINE_BYTES
    const res = await env.request(ttsUrl('在线正常的一句'))
    check('[对照] 200 + x-tts-engine: online',
      res.statusCode === 200 && res.headers?.['x-tts-engine'] === 'online',
      `${res.statusCode}/${res.headers?.['x-tts-engine']}`)
    check('[对照] 没有回退头、没有任何失败计数',
      res.headers && !('x-tts-engine-fallback' in res.headers), JSON.stringify(res.headers))
    const diag = await getDiagnostics(env)
    check('[对照] online/local/neural 三个失败计数都是 0',
      diag.onlineTts?.failures === 0 && diag.localTts?.failures === 0 && diag.neuralTts?.failures === 0,
      JSON.stringify({ online: diag.onlineTts?.failures, local: diag.localTts?.failures, neural: diag.neuralTts?.failures }))
  })
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
