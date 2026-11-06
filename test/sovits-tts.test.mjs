/**
 * GPT-SoVITS 外部引擎（ttsEngine=sovits）回归测试。
 *
 * 定位：插件**不内置** GPT-SoVITS、不做克隆；用户自己跑官方 `api_v2` 服务，
 * 插件只把每句文本 POST 到 `/tts` 拿回 wav。所以这里测的是：
 *   1. 请求契约（字段、语言、语速、可选参考音频/参考文本）；
 *   2. URL 规范化（根地址 / 带 /tts / 非法）；
 *   3. 失败路径（HTTP 400/空音频/连不上/超时）→ 抛错，而且**不回退在线**；
 *   4. 宿主 `/tts` 路由确实接入了 sovits 分支、失败计数进 /diagnostics。
 *      第 4 项从批次 6g 起是**真跑**：起一棵临时宿主（真路由 + 真配置校验），
 *      后端指向本文件那个假 GPT-SoVITS 服务，判据看的是响应头、响应字节和
 *      `/diagnostics` 里的计数 —— 不再刮宿主源码找 `engine === 'sovits'` 那行字。
 *      客户端那一侧（下拉框里的选项、选成 sovits 才出现的两个输入框）
 *      挪到了 `test/client-behavior.test.mjs` 的「面板·GPT-SoVITS 引擎」场景。
 *
 * 运行：node test/sovits-tts.test.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { loadHostRoutes } from './helpers/host-routes.mjs'
import {
  DEFAULT_SOVITS_URL,
  SOVITS_TIMEOUT_MS,
  sovitsEndpoint,
  normalizeSovitsLang,
  sovitsSpeedFromRate,
  buildSovitsPayload,
  synthesizeSovits,
} from '../src/host/sovits-tts.js'
import { TTS_TIMEOUT_MS } from '../src/client/pure/voice-constants.js'
import { CONFIG_DEFAULTS } from '../src/host/config-schema.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 起一个本地假 GPT-SoVITS 服务。 */
async function startServer(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const WAV_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.alloc(4),
  Buffer.from('WAVEfmt ', 'ascii'),
  Buffer.from([16, 0, 0, 0]),
])

console.log('\n== 1. URL 规范化 ==')
check('空地址回退默认 127.0.0.1:9880',
  sovitsEndpoint('') === DEFAULT_SOVITS_URL + '/tts', sovitsEndpoint(''))
check('根地址自动补 /tts',
  sovitsEndpoint('http://127.0.0.1:9880') === 'http://127.0.0.1:9880/tts', sovitsEndpoint('http://127.0.0.1:9880'))
check('已带 /tts 不重复拼接',
  sovitsEndpoint('http://127.0.0.1:9880/tts') === 'http://127.0.0.1:9880/tts', sovitsEndpoint('http://127.0.0.1:9880/tts'))
check('尾部斜杠归一', sovitsEndpoint('http://127.0.0.1:9880/') === 'http://127.0.0.1:9880/tts')
check('非法地址报错',
  (() => { try { sovitsEndpoint('not-a-url'); return false } catch { return true } })())
check('非 http(s) 地址报错',
  (() => { try { sovitsEndpoint('ftp://x'); return false } catch { return true } })())

console.log('\n== 2. 语言与语速 ==')
check('支持的语言保留', ['zh', 'en', 'ja', 'ko', 'yue'].every((l) => normalizeSovitsLang(l) === l))
check('不支持的语言回退 zh', normalizeSovitsLang('fr') === 'zh')
check('空语言回退', normalizeSovitsLang('') === 'zh')
check('+0% → 1.0', sovitsSpeedFromRate('+0%') === 1)
check('+20% → 1.2', sovitsSpeedFromRate('+20%') === 1.2)
check('-30% → 0.7', sovitsSpeedFromRate('-30%') === 0.7)
check('非法语速 → 1.0', sovitsSpeedFromRate('abc') === 1)

console.log('\n== 3. 请求体契约 ==')
{
  const payload = buildSovitsPayload({
    text: '  你好，世界。  ',
    settings: {
      sovitsTextLang: 'zh',
      sovitsPromptLang: 'en',
      sovitsRefAudio: '/ref/voice.wav',
      sovitsPromptText: '参考音频内容',
      rate: '+15%',
    },
  })
  check('text 已 trim', payload.text === '你好，世界。', JSON.stringify(payload.text))
  check('text_lang 正确', payload.text_lang === 'zh', payload.text_lang)
  check('prompt_lang 正确', payload.prompt_lang === 'en', payload.prompt_lang)
  check('参考音频路径透传', payload.ref_audio_path === '/ref/voice.wav', payload.ref_audio_path)
  check('参考文本透传', payload.prompt_text === '参考音频内容', payload.prompt_text)
  check('语速换算 speed_factor', payload.speed_factor === 1.15, String(payload.speed_factor))
  check('media_type=wav / streaming 关闭 / cut5',
    payload.media_type === 'wav' && payload.streaming_mode === false && payload.text_split_method === 'cut5')
  const empty = buildSovitsPayload({ text: '说一句。', settings: {} })
  check('未配置参考音频时不带 ref_audio_path（不覆盖服务端默认）',
    !('ref_audio_path' in empty) && !('prompt_text' in empty), JSON.stringify(empty))
}

console.log('\n== 4. 成功路径（真实本地 HTTP 服务）==')
let server = null
try {
  let captured = null
  server = await startServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      captured = { method: req.method, url: req.url, body: JSON.parse(body || '{}') }
      res.writeHead(200, { 'content-type': 'audio/wav' })
      res.end(WAV_BYTES)
    })
  })
  const result = await synthesizeSovits({
    text: '测试一句。',
    settings: {
      sovitsUrl: server.base,
      sovitsTextLang: 'zh',
      sovitsPromptLang: 'zh',
      sovitsRefAudio: '/tmp/ref.wav',
      sovitsPromptText: '参考文本',
    },
  })
  check('请求打到 /tts 且是 POST', captured?.method === 'POST' && captured?.url === '/tts',
    JSON.stringify(captured))
  check('请求体是合法 JSON 且带 text', captured?.body?.text === '测试一句。', JSON.stringify(captured?.body))
  check('返回音频被正确读出', result.audio.length === WAV_BYTES.length && result.format === 'wav' && result.mime === 'audio/wav',
    `len=${result.audio.length}`)
} finally {
  if (server) await server.close()
}

console.log('\n== 5. 失败路径 ==')
{
  // HTTP 400 + 官方 message：要带上「参考音频路径」提示（用户最常踩的坑）
  const server400 = await startServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'ref_audio_path is required' }))
  })
  try {
    await synthesizeSovits({ text: '测试。', settings: { sovitsUrl: server400.base } })
    check('HTTP 400 应抛错', false)
  } catch (error) {
    check('HTTP 400 抛出可读错误（含 ref_audio_path 提示）',
      /HTTP 400/.test(String(error.message)) && /参考音频路径/.test(String(error.message)),
      String(error.message))
  } finally {
    await server400.close()
  }

  // 空音频
  const serverEmpty = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'audio/wav' })
    res.end()
  })
  try {
    await synthesizeSovits({ text: '测试。', settings: { sovitsUrl: serverEmpty.base } })
    check('空音频应抛错', false)
  } catch (error) {
    check('空音频抛出可读错误', /空音频/.test(String(error.message)), String(error.message))
  } finally {
    await serverEmpty.close()
  }

  // 连不上（先拿一个端口再关掉）
  const closed = await startServer((req, res) => res.end())
  const closedPort = closed.port
  await closed.close()
  try {
    await synthesizeSovits({ text: '测试。', settings: { sovitsUrl: `http://127.0.0.1:${closedPort}` } })
    check('连不上应抛错', false)
  } catch (error) {
    check('连不上抛出可读错误（含地址）',
      /连不上 GPT-SoVITS 服务/.test(String(error.message)) && String(error.message).includes(String(closedPort)),
      String(error.message))
  }

  // 超时：服务延迟响应
  const serverSlow = await startServer((req, res) => {
    setTimeout(() => {
      try { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(WAV_BYTES) } catch { /* 忽略 */ }
    }, 500)
  })
  try {
    await synthesizeSovits({ text: '测试。', settings: { sovitsUrl: serverSlow.base }, timeoutMs: 120 })
    check('超时应抛错', false)
  } catch (error) {
    check('超时抛出可读错误', /超时/.test(String(error.message)), String(error.message))
  } finally {
    await serverSlow.close()
  }
}

console.log('\n== 6. 宿主 /tts 真跑：sovits 分支、失败计数、不回退在线 ==')
{
  // 配置键是否真的在宿主的默认配置里（决定它会不会被读写路径当成未知键丢掉）。
  // 以前这条是拿正则刮 lib/index.js 的 DEFAULTS 字面量；默认值单源化后
  // 那份字面量不存在了，直接读**同一份数据**更准。
  check('sovits 配置项在白名单里（来自 CONFIG_DEFAULTS）',
    ['sovitsUrl', 'sovitsRefAudio', 'sovitsTextLang', 'sovitsPromptLang']
      .every((key) => Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)),
    Object.keys(CONFIG_DEFAULTS).join(','))

  /**
   * 起一树真宿主（临时 DSH_HOME + 行配置 ttsEngine=sovits），后端指到本地假服务。
   * @param {(req,res)=>void} handler - 假 GPT-SoVITS 的响应逻辑。
   * @param {(ctx: {host: object}) => Promise<void>} run - 要跑的判据。
   */
  async function withSovitsHost(handler, run) {
    const service = await startServer(handler)
    const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sovits-host-'))
    const host = await loadHostRoutes({
      dshHome,
      rowConfig: { ttsEngine: 'sovits', sovitsUrl: service.base, preloadModels: false },
    })
    try {
      await run({ host })
    } finally {
      host.restore()
      await service.close()
      fs.rmSync(dshHome, { recursive: true, force: true })
    }
  }

  /* ---- ① 成功：路由真的接到了 sovits 客户端 ---- */
  let served = null
  await withSovitsHost((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      served = { method: req.method, url: req.url, body: JSON.parse(body || '{}') }
      res.writeHead(200, { 'content-type': 'audio/wav' })
      res.end(WAV_BYTES)
    })
  }, async ({ host }) => {
    const res = await host.request(`/dsh-voice-typing/tts?text=${encodeURIComponent('说一句。')}`)
    // 旧判据「宿主 import 了 sovits 客户端」+「/tts 路由有 sovits 分支」：
    // 扫的是 `from './sovits-tts.js'` 和 `engine === 'sovits'` 两行字面量。
    // 现在看的是**假服务真的被打了个 POST**、文本还是路由里那句 —— 接线断了就没有这条。
    check('/tts（引擎=sovits）真的把这句转给了 GPT-SoVITS 服务（旧判据：源码里有 sovits 分支）',
      res.statusCode === 200 && served?.method === 'POST' && served?.url === '/tts'
      && served?.body?.text === '说一句。',
      `${res.statusCode} ${JSON.stringify(served)}`)
    check('/tts 把服务回来的 wav 原样交给客户端',
      Buffer.compare(Buffer.concat(res.chunks), WAV_BYTES) === 0
      && String(res.headers?.['content-type']) === 'audio/wav',
      `${res.headers?.['content-type']} ${Buffer.concat(res.chunks).length} 字节`)
    // 「不回退在线」的**成功**那一半：用的就是 sovits，头里不会出现别的引擎。
    check('响应头写明实际引擎是 sovits、没有回退标记',
      res.headers?.['x-tts-engine'] === 'sovits' && !('x-tts-engine-fallback' in (res.headers ?? {})),
      JSON.stringify(res.headers))
    const diag = (await host.request('/dsh-voice-typing/diagnostics')).json()
    check('成功这一趟不产生任何失败计数',
      diag.sovitsTts?.failures === 0 && diag.onlineTts?.failures === 0,
      JSON.stringify({ s: diag.sovitsTts?.failures, o: diag.onlineTts?.failures }))
  })

  /* ---- ② 失败：报错 + 计数进 /diagnostics，而且**不回退在线** ---- */
  await withSovitsHost((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'ref_audio_path is required' }))
  }, async ({ host }) => {
    const res = await host.request(`/dsh-voice-typing/tts?text=${encodeURIComponent('说一句。')}`)
    check('sovits 失败时 /tts 直接 500、原始错误透传（旧判据扫的是「记完数就 throw」那段源码顺序）',
      res.statusCode === 500 && /HTTP 400/.test(String(res.json()?.error)),
      `${res.statusCode} ${res.text}`)
    const diag = (await host.request('/dsh-voice-typing/diagnostics')).json()
    check('sovits 失败计数进 /diagnostics（旧判据：源码里有 sovitsTtsFailures / sovitsTts:）',
      diag.sovitsTts?.failures === 1
      && diag.stats?.sovitsTtsFailures === 1
      && /HTTP 400/.test(String(diag.sovitsTts?.lastError))
      && diag.sovitsTts?.events?.length === 1
      && typeof diag.sovitsTts?.lastAt === 'number',
      JSON.stringify(diag.sovitsTts))
    // 这才是「不回退在线」的可核对版本：在线/神经/本地三个引擎的失败计数一次都没涨，
    // 也没有任何一次真的去请求在线（客户端拿到的就是 500，跳过这一句）。
    check('sovits 失败不回退别的引擎（在线/神经/本地计数都没动）',
      diag.onlineTts?.failures === 0 && diag.neuralTts?.failures === 0 && diag.localTts?.failures === 0,
      JSON.stringify({
        online: diag.onlineTts?.failures,
        neural: diag.neuralTts?.failures,
        local: diag.localTts?.failures,
      }))
  })
}

// 跨端的那条时间契约（批次 21）：宿主的请求超时必须早于客户端「等这一句合成」的那句超时，
// 否则客户端已经放弃、宿主还在等，用户看到的只是一句静音，错误连界面都到不了。
// 客户端的数字只住在 `src/client/pure/voice-constants.js`，这里 import 进来比，不另抄一份。
check(`sovits 的默认请求超时早于客户端单句合成超时 ${TTS_TIMEOUT_MS}ms`,
  SOVITS_TIMEOUT_MS < TTS_TIMEOUT_MS && SOVITS_TIMEOUT_MS > 0,
  `宿主 ${SOVITS_TIMEOUT_MS}ms vs 客户端 ${TTS_TIMEOUT_MS}ms`)
{
  // 默认值那条路径真的挂上了中止吗：把 setTimeout 换成记录器（只记不改成真等），
  // 服务故意不回话，一百毫秒后由测试自己把连接掐断 —— 于是既能看到「中止登记在多少毫秒」，
  // 又不用真等满那个默认值。改前这里没有判据：慢服务那条用例是显式传 timeoutMs:120 跑的，
  // 默认值走没走上中止，谁都没看过。
  const sockets = new Set()
  const server = http.createServer(() => { /* 就是不回话 */ })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const realSetTimeout = globalThis.setTimeout
  const registered = []
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms >= 100) registered.push(ms)
    return realSetTimeout(fn, ms, ...rest)
  }
  const stopper = realSetTimeout(() => {
    for (const socket of sockets) { try { socket.destroy() } catch { /* 忽略 */ } }
  }, 100)
  let outcome = null
  try {
    outcome = await synthesizeSovits({ text: '说一句。', settings: { sovitsUrl: base } })
      .then(() => 'resolved', (error) => 'rejected:' + String(error?.name ?? error?.message ?? error))
  } finally {
    globalThis.clearTimeout(stopper)
    globalThis.setTimeout = realSetTimeout
    server.close()
  }
  check('不传 timeoutMs 时，默认那份中止登记在 SOVITS_TIMEOUT_MS 上（不是随手一个数）',
    registered.includes(SOVITS_TIMEOUT_MS), `${registered.join(', ')} vs 默认 ${SOVITS_TIMEOUT_MS}`)
  check('默认那条中止登记得比客户端单句合成超时早',
    registered.length > 0 && Math.min(...registered) < TTS_TIMEOUT_MS,
    `${registered.join(', ')} vs 客户端 ${TTS_TIMEOUT_MS}ms`)
  check('服务不回话时这一句以错误收场（不是永远挂着）',
    String(outcome).startsWith('rejected:'), String(outcome))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
