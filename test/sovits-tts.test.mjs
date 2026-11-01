/**
 * GPT-SoVITS 外部引擎（ttsEngine=sovits）回归测试。
 *
 * 定位：插件**不内置** GPT-SoVITS、不做克隆；用户自己跑官方 `api_v2` 服务，
 * 插件只把每句文本 POST 到 `/tts` 拿回 wav。所以这里测的是：
 *   1. 请求契约（字段、语言、语速、可选参考音频/参考文本）；
 *   2. URL 规范化（根地址 / 带 /tts / 非法）；
 *   3. 失败路径（HTTP 400/空音频/连不上/超时）→ 抛错，而且**不回退在线**；
 *   4. 宿主 `/tts` 路由确实接入了 sovits 分支、失败计数进 /diagnostics。
 *
 * 运行：node test/sovits-tts.test.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SOVITS_URL,
  sovitsEndpoint,
  normalizeSovitsLang,
  sovitsSpeedFromRate,
  buildSovitsPayload,
  synthesizeSovits,
} from '../lib/sovits-tts.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const indexSrc = fs.readFileSync(root + 'lib/index.js', 'utf8')
const clientSrc = fs.readFileSync(root + 'lib/client.js', 'utf8')

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

console.log('\n== 6. 宿主接线 / 客户端 UI ==')
check('宿主 import 了 sovits 客户端', /from '\.\/sovits-tts\.js'/.test(indexSrc))
check('/tts 路由有 sovits 分支', /engine === 'sovits'/.test(indexSrc))
check('sovits 配置项在白名单里（来自 DEFAULTS）',
  /sovitsUrl:/.test(indexSrc) && /sovitsRefAudio:/.test(indexSrc) && /sovitsTextLang:/.test(indexSrc) && /sovitsPromptLang:/.test(indexSrc))
check('sovits 失败计数进 /diagnostics',
  /sovitsTtsFailures/.test(indexSrc) && /sovitsTts:/.test(indexSrc))
check('sovits 失败时抛错（不回退在线引擎）',
  /stats\.lastSovitsTtsAt = Date\.now\(\)[\s\S]{0,200}?throw sovitsError/.test(indexSrc))
check('客户端有引擎选项与设置项（构建产物）',
  /GPT-SoVITS 外部服务/.test(clientSrc) && /sovitsUrl/.test(clientSrc) && /sovitsRefAudio/.test(clientSrc))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
