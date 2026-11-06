/**
 * 配置加固的宿主接线测试：真实 `apply()` + 临时 DSH_HOME + 真实路由 handler。
 *
 * 覆盖审计报告（review/config-matrix-host.md）里 R1–R7 对应的修复：
 *   - POST /config 严格校验：非法 patch → 400 `{ok:false, errors:[{key,reason}]}` 且不落盘；
 *   - 合法 patch → 200 + GET /config 返回**归一化后**的完整配置（同键名）；
 *   - 非法引擎（配置文件里手写）→ `/tts` 400，**不再静默落 online**（隐私承诺）；
 *   - `/tts/warmup`：neural/sovits 快速返回 `{warmed:false}`，不发起 Edge 网络；
 *   - `/voices?engine=neural|sovits` → `{voices:[]}`，非法引擎 → 400；
 *   - `/tts/env` 含 sovits 项（supported/configured/url）且 `configured` 是归一化引擎；
 *   - `/transcribe` 用非法 model → 400（不静默回退 SenseVoice）。
 *
 * 运行：node test/config-guard.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 必须在 import lib/index.js 之前指好 DSH_HOME（配置路径由它决定）。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-config-guard-'))
process.env.DSH_HOME = tmpHome
const CONFIG_PATH = path.join(tmpHome, 'voice-typing.json')

const { apply } = await import('../lib/index.js')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 拉起一个真实 apply() 的宿主（假 Cordis 上下文）。 */
function makeHost(rowConfig = {}) {
  const routes = new Map()
  const handlers = new Map()
  const scope = {
    effect(fn) { fn(); return () => {} },
    webServer: { register(definition) { routes.set(definition.path, definition); return () => {} } },
    sessions: { get() { return { deriveMessages: () => [] } }, list() { return [] } },
  }
  const ctx = {
    on(event, handler) { handlers.set(event, handler) },
    inject(_deps, fn) { fn(scope); return () => {} },
  }
  apply(ctx, rowConfig)
  return { routes, handlers }
}

/** 构造假 req（支持 async iterator 读 body）。 */
function makeReq(method, url, body) {
  const chunks = body == null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')]
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    on() { return this },
  }
}

/** 构造假 res（收集状态/头/字节）。 */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    chunks: [],
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {}; this.headersSent = true },
    write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      }
      this.writableEnded = true
    },
  }
}

/** 调路由 → { status, headers, raw, body, ms }。 */
async function callRoute(host, routePath, method, body, query = '') {
  const definition = host.routes.get(routePath)
  if (!definition) throw new Error('route not found: ' + routePath)
  const res = makeRes()
  const t0 = Date.now()
  await definition.handler(makeReq(method, routePath + query, body), res)
  const raw = Buffer.concat(res.chunks)
  let parsed = null
  try { parsed = JSON.parse(raw.toString('utf8')) } catch { /* 二进制音频响应 */ }
  return { status: res.statusCode, headers: res.headers, raw, body: parsed, ms: Date.now() - t0 }
}

const postConfig = (host, patch) => callRoute(host, '/dsh-voice-typing/config', 'POST', JSON.stringify(patch))
const getConfig = (host) => callRoute(host, '/dsh-voice-typing/config', 'GET')
const getTts = (host, text = '你好。') => callRoute(host, '/dsh-voice-typing/tts', 'GET', null, '?text=' + encodeURIComponent(text))
const getWarmup = (host) => callRoute(host, '/dsh-voice-typing/tts/warmup', 'GET')
const getVoices = (host, engine) => callRoute(host, '/dsh-voice-typing/voices', 'GET', null, '?engine=' + encodeURIComponent(engine))
const getEnv = (host) => callRoute(host, '/dsh-voice-typing/tts/env', 'GET')
const postTranscribe = (host) => callRoute(host, '/dsh-voice-typing/transcribe', 'POST', Buffer.alloc(64 * 4))
const getDiagnostics = (host) => callRoute(host, '/dsh-voice-typing/diagnostics', 'GET')
/** 直接改配置文件（模拟用户手写/旧客户端写入）。 */
const writeOverrides = (values) => fs.writeFileSync(CONFIG_PATH, JSON.stringify(values, null, 2) + '\n', 'utf8')
const readOverrides = () => {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return null }
}

console.log('== 1. POST /config 严格校验 ==')
{
  const host = makeHost()
  await getConfig(host) // 确保初始配置已加载（初始 DSH_HOME 为空 → 默认配置）
  check('初始配置文件不存在', !fs.existsSync(CONFIG_PATH))

  const bad = await postConfig(host, {
    ttsEngine: 123,
    readAloudLag: 'abc',
    neuralSpeaker: 9999,
    sovitsUrl: 'ftp://x',
    sovitsTextLang: 'auto',
  })
  check('非法 patch → 400', bad.status === 400, String(bad.status))
  check('响应 ok:false 且带 errors 数组', bad.body?.ok === false && Array.isArray(bad.body?.errors), JSON.stringify(bad.body))
  const keys = (bad.body?.errors ?? []).map((e) => e.key)
  check('错误按 key 聚合（ttsEngine/readAloudLag/neuralSpeaker/sovitsUrl/sovitsTextLang）',
    ['ttsEngine', 'readAloudLag', 'neuralSpeaker', 'sovitsUrl', 'sovitsTextLang'].every((k) => keys.includes(k)),
    JSON.stringify(keys))
  check('非法 patch 不落盘（没有配置文件）', !fs.existsSync(CONFIG_PATH))

  const malformed = await callRoute(host, '/dsh-voice-typing/config', 'POST', '{not json')
  check('请求体不是 JSON → 400', malformed.status === 400 && malformed.body?.ok === false, JSON.stringify(malformed.body))
}

console.log('\n== 2. POST /config 合法 patch：归一化 + 落盘 + GET 回读 ==')
{
  const host = makeHost()
  await getConfig(host)
  const good = await postConfig(host, {
    ttsEngine: ' SoViTs ',
    readAloudLag: '15',
    silenceMs: '1500',
    neuralSpeaker: '2',
    sovitsUrl: 'http://127.0.0.1:9880',
    sovitsRefAudio: 'C:/ref.wav',
    sovitsTextLang: 'JA',
    words: ['热词', { correct: '正确', replace: '错误' }],
  })
  check('合法 patch → 200', good.status === 200 && good.body?.ok === true, JSON.stringify(good.body))
  check('响应里返回完整配置（35 键）', Object.keys(good.body?.config ?? {}).length === 35,
    String(Object.keys(good.body?.config ?? {}).length))
  check('响应里的引擎已归一化', good.body?.config?.ttsEngine === 'sovits', JSON.stringify(good.body?.config?.ttsEngine))
  check('响应里的数字已强转', good.body?.config?.readAloudLag === 15 && good.body?.config?.silenceMs === 1500)
  check('响应里的 words 已归一化',
    JSON.stringify(good.body?.config?.words) === JSON.stringify(['热词', '正确=错误']),
    JSON.stringify(good.body?.config?.words))

  const onDisk = readOverrides()
  check('落盘值是归一化后的', onDisk?.ttsEngine === 'sovits' && onDisk?.readAloudLag === 15, JSON.stringify(onDisk))

  const get = await getConfig(host)
  check('GET /config 返回 200', get.status === 200)
  check('GET /config 与 POST 后的生效配置一致', get.body?.ttsEngine === 'sovits' && get.body?.readAloudLag === 15)
  check('GET /config 不含 warnings/stats（诊断不混进配置）',
    !('configWarnings' in (get.body ?? {})) && !('stats' in (get.body ?? {})), JSON.stringify(Object.keys(get.body ?? {})))
  check('GET /config 返回完整键（与 schema 一致）', Object.keys(get.body ?? {}).length === 35)
}

console.log('\n== 2b. 全局语音 / AI 界面操控的新键：默认值与保存回读 ==')
{
  const host = makeHost()
  const get = await getConfig(host)
  check('新键默认值安全（浮层/操控/helper 关，确认开，队列注入）',
    get.body?.globalVoice === false && get.body?.globalShortcut === 'Ctrl+Alt+V'
    && get.body?.voicePromptMode === 'queue' && get.body?.uiControl === false
    && get.body?.uiConfirm === true && get.body?.globalHotkeyHelper === false,
    JSON.stringify({
      globalVoice: get.body?.globalVoice,
      globalShortcut: get.body?.globalShortcut,
      voicePromptMode: get.body?.voicePromptMode,
      uiControl: get.body?.uiControl,
      uiConfirm: get.body?.uiConfirm,
      globalHotkeyHelper: get.body?.globalHotkeyHelper,
    }))
  // v3 第 35 键：默认开启唤醒词（空串才表示关闭）。
  check('wakeWord 默认「小鱼」', get.body?.wakeWord === '小鱼', JSON.stringify(get.body?.wakeWord))

  const saved = await postConfig(host, {
    globalVoice: true,
    globalShortcut: '  Ctrl+Shift+Space  ',
    voicePromptMode: 'STEER',
    uiControl: true,
    uiConfirm: false,
    globalHotkeyHelper: true,
    wakeWord: '  小助手  ',
  })
  check('新键合法 patch → 200', saved.status === 200 && saved.body?.ok === true, JSON.stringify(saved.body))
  const after = await getConfig(host)
  check('新键已归一化并回读',
    after.body?.globalVoice === true
    && after.body?.globalShortcut === 'Ctrl+Shift+Space'
    && after.body?.voicePromptMode === 'steer'
    && after.body?.uiControl === true
    && after.body?.uiConfirm === false
    && after.body?.globalHotkeyHelper === true
    && after.body?.wakeWord === '小助手',
    JSON.stringify({
      globalVoice: after.body?.globalVoice,
      globalShortcut: after.body?.globalShortcut,
      voicePromptMode: after.body?.voicePromptMode,
      uiControl: after.body?.uiControl,
      uiConfirm: after.body?.uiConfirm,
      globalHotkeyHelper: after.body?.globalHotkeyHelper,
      wakeWord: after.body?.wakeWord,
    }))
  // 空串 = 关闭唤醒词，必须原样落盘/回读（不能被「空串回退默认」吃掉）。
  const disabled = await postConfig(host, { wakeWord: '' })
  const afterOff = await getConfig(host)
  check('wakeWord 空串 = 关闭（落盘并按空串回读）',
    disabled.status === 200 && afterOff.body?.wakeWord === '',
    JSON.stringify(afterOff.body?.wakeWord))
}

console.log('\n== 3. 非法引擎（手写配置文件）→ /tts 400，不静默落 online ==')
{
  const host = makeHost()
  writeOverrides({ ttsEngine: 'definitely-not-an-engine' })
  const get = await getConfig(host) // 触发 reload → sanitize + 记 warning
  check('GET /config 对非法引擎回退默认（online）并仍返回 200',
    get.status === 200 && get.body?.ttsEngine === 'online', JSON.stringify(get.body?.ttsEngine))
  const tts = await getTts(host)
  check('/tts 遇非法引擎配置 → 400（不合成）', tts.status === 400, `${tts.status} bytes=${tts.raw.length}`)
  check('/tts 错误里点名 ttsEngine', tts.body?.errors?.some?.((e) => e.key === 'ttsEngine'), JSON.stringify(tts.body))
  check('/tts 400 不返回音频字节', tts.raw.length < 2048 && !String(tts.headers['content-type'] ?? '').startsWith('audio/'))
  const diag = await getDiagnostics(host)
  check('/diagnostics.configWarnings 暴露非法引擎',
    Array.isArray(diag.body?.configWarnings) &&
    diag.body.configWarnings.some((w) => w.key === 'ttsEngine'),
    JSON.stringify(diag.body?.configWarnings))
}

console.log('\n== 3b. rowConfig（插件行配置）非法引擎 → /tts 也 400 ==')
{
  // 行配置不是通过 POST /config 写的，但同样不能静默落 online：
  // reloadConfig 每次都重新合并 raw rowConfig，于是 warning 不会丢。
  const host = makeHost({ ttsEngine: 'bogus-engine', preloadModels: false })
  await getConfig(host)
  const tts = await getTts(host)
  check('rowConfig 非法引擎 → /tts 400', tts.status === 400, `${tts.status} ${JSON.stringify(tts.body)}`)
  const diag = await getDiagnostics(host)
  check('rowConfig 非法引擎记入 configWarnings',
    (diag.body?.configWarnings ?? []).some((w) => w.key === 'ttsEngine'),
    JSON.stringify(diag.body?.configWarnings))
}

console.log('\n== 4. /tts/warmup：只有 online 才连 Edge ==')
{
  for (const engine of ['neural', 'sovits', 'local']) {
    const host = makeHost()
    writeOverrides({ ttsEngine: engine })
    await getConfig(host)
    const warm = await getWarmup(host)
    check(`${engine}：快速返回 warmed:false 且带 engine`,
      warm.status === 200 && warm.body?.warmed === false && warm.body?.engine === engine,
      JSON.stringify(warm.body))
    check(`${engine}：不发起 Edge 网络（<500ms）`, warm.ms < 500, `${warm.ms}ms`)
  }
}

console.log('\n== 5. /voices：neural/sovits 空列表；非法引擎 400 ==')
{
  const host = makeHost()
  writeOverrides({ ttsEngine: 'sovits' })
  await getConfig(host)
  for (const engine of ['neural', 'sovits']) {
    const res = await getVoices(host, engine)
    check(`/voices?engine=${engine} → {engine, voices: []}`,
      res.status === 200 && res.body?.engine === engine && Array.isArray(res.body?.voices) && res.body.voices.length === 0,
      JSON.stringify(res.body))
  }
  const bad = await getVoices(host, 'definitely-not')
  check('/voices 非法引擎 → 400', bad.status === 400, JSON.stringify(bad.body))
  const upper = await getVoices(host, ' SOVITS ')
  check('/voices 引擎大小写/空格归一化', upper.status === 200 && upper.body?.engine === 'sovits', JSON.stringify(upper.body))
}

console.log('\n== 6. /tts/env 含 sovits 项 ==')
{
  const host = makeHost()
  writeOverrides({ ttsEngine: 'sovits', sovitsUrl: 'http://10.0.0.5:9880' })
  await getConfig(host)
  const env = await getEnv(host)
  check('/tts/env 返回 200', env.status === 200, JSON.stringify(env.body).slice(0, 200))
  const sovits = (env.body?.engines ?? []).find((e) => e?.id === 'sovits')
  check('engines 含 sovits 项', !!sovits, JSON.stringify((env.body?.engines ?? []).map((e) => e.id)))
  check('sovits 项字段符合契约（supported/configured/url）',
    sovits?.supported === true && sovits?.configured === true && sovits?.url === 'http://10.0.0.5:9880',
    JSON.stringify(sovits))
  check('env.configured 是归一化引擎', env.body?.configured === 'sovits', JSON.stringify(env.body?.configured))
}

console.log('\n== 7. /transcribe：非法 model → 400，不静默回退 SenseVoice ==')
{
  const host = makeHost()
  writeOverrides({ model: 'definitely-not-a-model' })
  await getConfig(host)
  const res = await postTranscribe(host)
  check('/transcribe 非法 model → 400', res.status === 400, `${res.status} ${JSON.stringify(res.body)}`)
  check('错误里点名未知识别档位', /未知识别档位/.test(String(res.body?.error ?? '')), JSON.stringify(res.body))
  check('不再回退 SenseVoice（错误里不出现 sensevoice 就绪提示）',
    !/sensevoice/.test(String(res.body?.error ?? '')), JSON.stringify(res.body))
}

console.log('\n== 8. GET /config 与 /diagnostics 的职责分离 ==')
{
  const host = makeHost()
  writeOverrides({ readAloudLag: 'abc' })
  const get = await getConfig(host)
  check('非法 readAloudLag 被 clamp/回退（GET 不报错）', get.status === 200 && typeof get.body?.readAloudLag === 'number',
    JSON.stringify(get.body?.readAloudLag))
  const diag = await getDiagnostics(host)
  check('/diagnostics.configWarnings 记录 readAloudLag 告警',
    (diag.body?.configWarnings ?? []).some((w) => w.key === 'readAloudLag'),
    JSON.stringify(diag.body?.configWarnings))
  check('GET /config 仍不含 configWarnings', !('configWarnings' in (get.body ?? {})))
}

fs.rmSync(tmpHome, { recursive: true, force: true })
console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
