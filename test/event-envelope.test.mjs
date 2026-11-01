/**
 * 事件信封 v2 的**运行时**回归测试（宿主侧）。
 *
 * 背景（2026-10-31）：
 *   阶段 3 把 SSE 事件改成统一信封：
 *     data: {"v":2,"seq":12,"ts":1735000000000,"sessionId":"s1","text":"你好","turnId":"turn-x","index":0}
 *
 *   test/event-contract.test.mjs 检查的是**源码形状**（正则扫 lib/index.js），
 *   这个文件补的是它测不到的那一层：**真的把插件拉起来**，
 *   接一条真的 SSE 连接、跑真的 llm/stream 钩子，
 *   然后按帧解析 —— 确认线上跑的字节就是契约里写的那几个字段。
 *
 *   为什么非要跑真的：信封是**接缝**，两端各写一遍就一定会分叉。
 *   源码里有 buildEventEnvelope 不代表广播出去的就是它；
 *   广播函数里套了信封也不代表 SSE 写出去的就是信封。
 *
 * 不依赖模型、不需要网络，用假 Cordis 上下文把插件拉起来即可。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'

// 配置读写都指向临时目录：别碰用户的 ~/.dsh。
const tmpHome = path.join(os.tmpdir(), 'dsh-voice-typing-event-contract')
await mkdir(tmpHome, { recursive: true })
process.env.DSH_HOME = tmpHome

const {
  apply,
  buildEventEnvelope,
  downloadPercent,
  EVENT_PROTOCOL_VERSION,
} = await import('../lib/index.js')
const HOST_SRC = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const ENV_SRC = fs.readFileSync(new URL('../lib/sse-envelope.js', import.meta.url), 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

// ---------------------------------------------------------------------------
// 假宿主：够用就行，只要 apply() 能跑起来。
// ---------------------------------------------------------------------------

/**
 * 拉起一份宿主（假 Cordis 上下文）。
 * @param {object} rowConfig - 插件行配置。
 * @returns {{routes: Map, handlers: Map, sessions: Map}} 路由表、钩子表、会话表。
 */
function makeHost(rowConfig) {
  const routes = new Map()
  const handlers = new Map()
  const sessions = new Map()
  const scope = {
    effect(fn) { fn(); return () => {} },
    webServer: {
      register(def) { routes.set(def.path, def); return () => {} },
    },
    sessions: {
      get(id) { return sessions.get(id) },
      list() { return [...sessions.keys()] },
    },
  }
  const ctx = {
    on(event, handler) { handlers.set(event, handler) },
    inject(_deps, fn) { fn(scope); return () => {} },
  }
  apply(ctx, rowConfig)
  return { routes, handlers, sessions }
}

/** 假的 HTTP 响应。 */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    chunks: [],
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
      this.headersSent = true
    },
    write(chunk) { this.chunks.push(String(chunk)); return true },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
      }
      this.writableEnded = true
    },
    get body() { return this.chunks.join('') },
  }
}

/** 假的 HTTP 请求。 */
function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
    on() { return this },
  }
}

/**
 * 接一条真的 SSE 连接。
 * @param {object} host - 宿主。
 * @returns {{events: () => Array, close: () => void}} 帧解析器与断开函数。
 */
function connectSse(host) {
  const def = host.routes.get('/dsh-voice-typing/stream')
  const res = makeRes()
  let onClose = null
  const req = { on(event, cb) { if (event === 'close') onClose = cb; return req } }
  def.handler(req, res)
  return {
    raw: () => res.body,
    events() {
      const out = []
      for (const frame of res.body.split('\n\n')) {
        const text = frame.trim()
        if (!text || text.startsWith(':')) continue
        const m = /^event: (\S+)\ndata: ([\s\S]*)$/.exec(text)
        if (!m) continue
        out.push({ event: m[1], data: JSON.parse(m[2]) })
      }
      return out
    },
    close() { if (onClose) onClose() },
  }
}

/**
 * 跑一遍 llm/stream 钩子（真的钩子、真的广播）。
 * @param {object} host - 宿主。
 * @param {string} sessionId - 会话 id。
 * @param {string[]} chunks - 依次吐出的文本片段。
 */
async function runStream(host, sessionId, chunks) {
  const handler = host.handlers.get('llm/stream')
  const stream = handler({ sessionId }, () => (async function* () {
    for (const text of chunks) yield { type: 'text-delta', text }
  })())
  for await (const _chunk of stream) { /* 消费掉，触发 finally */ }
}

// ---------------------------------------------------------------------------
// 1) 信封本身
// ---------------------------------------------------------------------------
console.log('信封（协议 v2）')
{
  const env = buildEventEnvelope({ text: '你好', turnId: 'turn-x', index: 0 })
  check('v 固定为 3', env.v === 3, String(env.v))
  check('协议版本常量是 3', EVENT_PROTOCOL_VERSION === 3, String(EVENT_PROTOCOL_VERSION))
  check('seq 是整数', Number.isInteger(env.seq))
  check('ts 是 epoch 毫秒', Number.isFinite(env.ts) && env.ts > 1600000000000, String(env.ts))
  check('ts 与当前时间接近', Math.abs(Date.now() - env.ts) < 5000, String(env.ts))
  check('没有 sessionId 时是 null（全局事件）', env.sessionId === null, JSON.stringify(env.sessionId))
  check('业务字段平铺在顶层（没有 payload 嵌套层）',
    env.text === '你好' && env.turnId === 'turn-x' && env.index === 0 && env.payload === undefined,
    Object.keys(env).join(','))
  check('信封键在前、业务键在后',
    JSON.stringify(Object.keys(env).slice(0, 4)) === JSON.stringify(['v', 'seq', 'ts', 'sessionId']),
    Object.keys(env).join(','))
}
{
  const a = buildEventEnvelope({})
  const b = buildEventEnvelope({})
  check('seq 严格递增（每次广播 +1）', b.seq === a.seq + 1, `${a.seq} → ${b.seq}`)
}
{
  const env = buildEventEnvelope({ sessionId: 's1', text: 'x' })
  check('sessionId 从载荷里取', env.sessionId === 's1', JSON.stringify(env.sessionId))
  check('sessionId 只出现一次（不会平铺出第二份）',
    Object.keys(env).filter((k) => k === 'sessionId').length === 1,
    Object.keys(env).join(','))
}
{
  const env = buildEventEnvelope({ v: 99, seq: 99, ts: 99, sessionId: 's1', text: 'x' })
  check('保留字段不能被载荷覆盖',
    env.v === 3 && env.seq !== 99 && env.ts !== 99 && env.sessionId === 's1',
    JSON.stringify(env))
}
{
  const env = buildEventEnvelope(null)
  check('载荷为空/非法也能给出合法信封',
    env.v === 3 && env.sessionId === null && Number.isInteger(env.seq) && Number.isFinite(env.ts),
    JSON.stringify(env))
}

// ---------------------------------------------------------------------------
// 2) 下载百分比（宿主算好再广播）
// ---------------------------------------------------------------------------
console.log('\n下载百分比由宿主算好')
check('0/100 → 0', downloadPercent(0, 100) === 0)
check('50/100 → 50', downloadPercent(50, 100) === 50)
check('100/100 → 100', downloadPercent(100, 100) === 100)
check('total 未知 → 0', downloadPercent(123, 0) === 0)
check('负数 → 0', downloadPercent(-5, 100) === 0)
check('超出 100% → 夹到 100', downloadPercent(150, 100) === 100)
check('非法值 → 0', downloadPercent(NaN, 100) === 0 && downloadPercent(10, NaN) === 0)
check('结果是整数', Number.isInteger(downloadPercent(1, 3)))

// ---------------------------------------------------------------------------
// 3) 运行时：SSE 上真的写的是信封
// ---------------------------------------------------------------------------
console.log('\n运行时：SSE 帧就是信封')
{
  const host = makeHost({ readAloud: true, preloadModels: false })
  host.sessions.set('s1', { deriveMessages: () => [{ role: 'user', id: 'u1' }] })
  const sse = connectSse(host)
  try {
    await runStream(host, 's1', ['你好。'])
    const events = sse.events()
    // 连接建立时宿主会推一次状态快照（snapshot:true）——
    // 它不是一次状态变化，顺序断言要把它排除。
    const changed = events.filter((e) => !e.data?.snapshot)
    const names = changed.map((e) => e.event)
    check('事件顺序：置位 → turn-begin → sentence → 复位 → call-end',
      JSON.stringify(names) === JSON.stringify(['assistant-busy', 'turn-begin', 'sentence', 'assistant-busy', 'call-end']),
      names.join(' → '))
    check('连接时先推一次状态快照（客户端连上就能拿到当前状态）',
      events.some((e) => e.event === 'assistant-busy' && e.data?.snapshot === true),
      '不推的话，客户端在「状态变化之后」连上就永远对不上')
    check('每一帧的 data 都是信封',
      events.every((e) => e.data && e.data.v === 3 && Number.isInteger(e.data.seq) && Number.isFinite(e.data.ts) && 'sessionId' in e.data),
      JSON.stringify(events.map((e) => e.data)))
    check('seq 在整条流里严格递增',
      events.every((e, i) => i === 0 || e.data.seq > events[i - 1].data.seq),
      events.map((e) => e.data.seq).join(','))
    check('这一轮的事件都带 sessionId',
      changed.every((e) => e.data.sessionId === 's1'),
      events.map((e) => e.data.sessionId).join(','))

    // 连接建立时宿主会推一次状态快照（snapshot:true）——
  // 它不是一次状态变化，顺序与配对断言都要排除。
  const changes = events.filter((e) => !e.data?.snapshot)
  const busyOn = changes.find((e) => e.event === 'assistant-busy' && e.data.busy === true)
    check('assistant-busy 有置位（busy:true）', !!busyOn, JSON.stringify(events[0]?.data))
    check('assistant-busy 的置位带 sessionId', busyOn?.data.sessionId === 's1', JSON.stringify(busyOn?.data))
    const busyOff = changes.filter((e) => e.event === 'assistant-busy' && e.data.busy === false)
    check('assistant-busy 有复位（busy:false）', busyOff.length === 1, String(busyOff.length))
    check('assistant-busy 的复位带 sessionId', busyOff[0]?.data.sessionId === 's1', JSON.stringify(busyOff[0]?.data))

    const sentence = events.find((e) => e.event === 'sentence')
    check('sentence 带文本', sentence?.data.text === '你好。', JSON.stringify(sentence?.data))
    // 轮次 id 的**格式**不是契约，契约是「同一轮的事件带同一个 id」。
    // 格式从「内容锚点」改成「递增序号」了：
    // 锚点取的是 session 里最后一条 user 消息，
    // 而本轮的用户消息可能还没写进 session —— 于是新一轮会拿到上一轮的锚点，
    // 两轮共用同一个 turnId，客户端就分不出「换轮了」
    // （不解除静音、也不停掉上一轮的朗读）。
    check('sentence 带 turnId', typeof sentence?.data.turnId === 'string' && sentence.data.turnId.length > 0,
      JSON.stringify(sentence?.data))
    check('sentence 带本轮序号', sentence?.data.index === 0, JSON.stringify(sentence?.data))
    check('sentence 带 sessionId', sentence?.data.sessionId === 's1', JSON.stringify(sentence?.data))

    const begin = events.find((e) => e.event === 'turn-begin')
    // 协议 v3：一次 llm/stream 调用结束是 call-end；turn-end 是「真正一轮结束」，
    // 只在下一轮开始时广播上一轮 —— 单次调用不会出现。
    const callEnd = events.find((e) => e.event === 'call-end')
    check('call-end 带 turnId 与 sessionId（一次调用结束）',
      typeof callEnd?.data.turnId === 'string' && callEnd.data.turnId.length > 0 &&
      callEnd?.data.sessionId === 's1',
      JSON.stringify(callEnd?.data))
    check('单次调用不广播 turn-end（真正一轮结束要等下一轮）',
      !events.some((e) => e.event === 'turn-end'))
    check('turn-begin / call-end 与句子共用同一个 turnId',
      begin?.data.turnId === sentence?.data.turnId &&
      callEnd?.data.turnId === sentence?.data.turnId,
      JSON.stringify([begin?.data?.turnId, sentence?.data?.turnId, callEnd?.data?.turnId]))
    check('不发 turn-start（客户端已不兼容老协议）',
      !events.some((e) => e.event === 'turn-start'))
    check('不发 session 事件（已删除）', !events.some((e) => e.event === 'session'))
    check('不发旧的 busy 事件（改用 assistant-busy）', !events.some((e) => e.event === 'busy'))
  } finally {
    sse.close()
  }
}

console.log('\n运行时：不朗读的那条路径也要置位与复位')
{
  // readAloud 默认是 false —— 之前复位只写在「开朗读」的分支里，
  // 于是状态永远停在「忙」，识别出的文字永远发不出去。
  const host = makeHost({ readAloud: false, preloadModels: false })
  host.sessions.set('s2', { deriveMessages: () => [{ role: 'user', id: 'u2' }] })
  const sse = connectSse(host)
  try {
    await runStream(host, 's2', ['你好。'])
    const events = sse.events()
    // 排除连接时的状态快照（snapshot:true）
    const noReadAloudChanges = events.filter((e) => !e.data?.snapshot)
    const names = noReadAloudChanges.map((e) => e.event)
    check('不朗读时也广播 assistant-busy（置位）',
      names[0] === 'assistant-busy' && noReadAloudChanges[0].data.busy === true,
      JSON.stringify(noReadAloudChanges[0]?.data))
    check('不朗读时也广播 assistant-busy（复位）',
      names[names.length - 1] === 'assistant-busy' && noReadAloudChanges[names.length - 1].data.busy === false,
      JSON.stringify(noReadAloudChanges[names.length - 1]?.data))
    check('不朗读时置位与复位成对出现',
      noReadAloudChanges.filter((e) => e.event === 'assistant-busy').length === 2,
      names.join(' → '))
    check('不朗读时没有 sentence 事件', !names.includes('sentence'), names.join(' → '))
    check('不朗读时复位也带 sessionId',
      noReadAloudChanges[names.length - 1].data.sessionId === 's2',
      JSON.stringify(noReadAloudChanges[names.length - 1]?.data))
  } finally {
    sse.close()
  }
}

console.log('\n跨端一致：客户端的 parseEnvelope 能原样解析宿主的信封')
{
  const env = buildEventEnvelope({ sessionId: 's1', text: '你好', turnId: 'turn-u1', index: 0 })
  const wire = JSON.stringify(env)
  try {
    const { parseEnvelope, belongsToSession } = await import('../src/client/pure/envelope.js')
    const parsed = parseEnvelope({ data: wire })
    check('客户端 parseEnvelope 能解析宿主的信封', !!parsed, wire)
    check('解析结果与宿主构造的信封一致',
      JSON.stringify(parsed) === JSON.stringify(env), JSON.stringify(parsed))
    check('belongsToSession 认得信封里的 sessionId',
      belongsToSession(parsed, 's1') === true && belongsToSession(parsed, 's2') === false,
      JSON.stringify(parsed))
    const global = buildEventEnvelope({ id: 'x', percent: 50 })
    check('全局事件（sessionId=null）任何会话都要处理',
      belongsToSession(global, 's1') === true, JSON.stringify(global))
  } catch (error) {
    check('客户端的纯函数模块可用（跨端一致）', false, error?.message ?? String(error))
  }
}

// ---------------------------------------------------------------------------
// 4) 路由：配置与诊断分开，死路由删干净
// ---------------------------------------------------------------------------
console.log('\n路由：配置与诊断数据分开')
{
  const host = makeHost({ readAloud: true, preloadModels: false })
  const configDef = host.routes.get('/dsh-voice-typing/config')

  const getRes = makeRes()
  await configDef.handler(makeReq('GET', '/dsh-voice-typing/config'), getRes)
  const config = JSON.parse(getRes.body)
  check('GET /config 返回 200', getRes.statusCode === 200, String(getRes.statusCode))
  check('GET /config 不含 stats（诊断数据混进配置会被原样 POST 回来）', !('stats' in config), Object.keys(config).join(','))
  check('GET /config 不含 activeSession', !('activeSession' in config), Object.keys(config).join(','))
  check('GET /config 不含 voiceSession', !('voiceSession' in config), Object.keys(config).join(','))
  check('GET /config 就是配置本身（含 model / readAloud / ttsEngine）',
    config.model !== undefined && config.readAloud !== undefined && config.ttsEngine !== undefined,
    Object.keys(config).join(','))

  const postRes = makeRes()
  await configDef.handler(
    makeReq('POST', '/dsh-voice-typing/config', JSON.stringify({ model: 'sensevoice' })),
    postRes,
  )
  const posted = JSON.parse(postRes.body)
  check('POST /config 返回 ok + config', posted.ok === true && !!posted.config, postRes.body.slice(0, 200))
  check('POST /config 的响应里也没有 stats',
    posted.stats === undefined && posted.config?.stats === undefined, postRes.body.slice(0, 200))
  check('GET /config 的键与配置键完全一致（没有混进诊断字段）',
    JSON.stringify(Object.keys(config).sort()) === JSON.stringify(Object.keys(posted.config).sort()),
    `${Object.keys(config).sort().join(',')} vs ${Object.keys(posted.config).sort().join(',')}`)

  const diagDef = host.routes.get('/dsh-voice-typing/diagnostics')
  check('新增 GET /diagnostics 路由', !!diagDef)
  if (diagDef) {
    const diagRes = makeRes()
    await diagDef.handler(makeReq('GET', '/dsh-voice-typing/diagnostics'), diagRes)
    const diag = JSON.parse(diagRes.body)
    check('GET /diagnostics 返回 200', diagRes.statusCode === 200, String(diagRes.statusCode))
    check('GET /diagnostics 带统计信息',
      diag.ok === true && !!diag.stats && typeof diag.stats.transcribe === 'number' && typeof diag.stats.stream === 'number',
      diagRes.body.slice(0, 200))
    check('GET /diagnostics 带协议版本', diag.protocol === 3, String(diag.protocol))
    check('GET /diagnostics 带忙碌状态（与 assistant-busy 同源）',
      !!diag.busy && typeof diag.busy.busy === 'boolean' && 'sessionId' in diag.busy,
      JSON.stringify(diag.busy))
    check('GET /diagnostics 带下载进度列表', Array.isArray(diag.downloads), JSON.stringify(diag.downloads))
    check('GET /diagnostics 带各引擎的合成失败计数（在线/神经不再静默）',
      typeof diag.onlineTts?.failures === 'number'
      && typeof diag.neuralTts?.failures === 'number'
      && 'lastError' in diag.onlineTts
      && 'lastError' in diag.neuralTts,
      JSON.stringify({ online: diag.onlineTts, neural: diag.neuralTts }))
  }
}

console.log('\n路由：死链清理')
{
  const host = makeHost({ readAloud: true, preloadModels: false })
  check('GET/POST /session 路由已删除',
    !host.routes.has('/dsh-voice-typing/session'))
  check('GET /busy 保留（降级通路，客户端 SSE 断了还能问一句）',
    host.routes.has('/dsh-voice-typing/busy'))
  const busyDef = host.routes.get('/dsh-voice-typing/busy')
  const busyRes = makeRes()
  await busyDef.handler(makeReq('GET', '/dsh-voice-typing/busy'), busyRes)
  const busy = JSON.parse(busyRes.body)
  check('GET /busy 的响应与 assistant-busy 事件同源',
    busy.busy === false && 'sessionId' in busy && 'since' in busy, busyRes.body)
  check('GET /latest-message 保留（这轮客户端还要用）',
    host.routes.has('/dsh-voice-typing/latest-message'))
  check('GET /latest-message 在源码里标注了「未使用」',
    /保留但未使用|保留但客户端已不用/.test(HOST_SRC))
}

console.log('\n源码：信封与死事件的清理')
check('broadcast 里统一套信封',
  /const broadcast = \(event, payload\) => \{[\s\S]{0,240}?buildEventEnvelope\(payload\)/.test(HOST_SRC))
check('SSE 写出去的是整个信封',
  /data: \$\{JSON\.stringify\(envelope\)\}/.test(HOST_SRC))
check('模块级 seq 计数器存在（在独立协议模块里）', /let eventSeq = 0/.test(ENV_SRC))
check('协议层抽到独立模块 lib/sse-envelope.js',
  /export const EVENT_PROTOCOL_VERSION = 3/.test(ENV_SRC) && /export function buildEventEnvelope/.test(ENV_SRC),
  '信封协议应隔离出来，避免改协议误碰宿主路由/朗读')
check('不再广播 session 事件', !/broadcast\('session'/.test(HOST_SRC))
check('不再广播旧的 busy 事件', !/emitBroadcast\?\.\('busy'/.test(HOST_SRC))
check('广播 assistant-busy 事件', /emitBroadcast\?\.\('assistant-busy'/.test(HOST_SRC))
check('assistant-busy 的载荷字段是 busy', /'assistant-busy', \{ busy: [^}]*sessionId/.test(HOST_SRC))
check('模型事件带 kind',
  /broadcast\('model-progress', \{[\s\S]{0,200}?kind/.test(HOST_SRC) &&
  /broadcast\('model-ready', \{ id: model\.id, kind \}\)/.test(HOST_SRC) &&
  /broadcast\('model-error', \{[\s\S]{0,120}?kind/.test(HOST_SRC))
check('model-progress 的 percent 由宿主算',
  /percent: downloadPercent\(received, total\)/.test(HOST_SRC))
check('没有 activeSession 变量了',
  !/let\s+activeSession\b/.test(HOST_SRC) && !/activeSession\s*=/.test(HOST_SRC))
check('没有 /dsh-voice-typing/session 路由了', !/dsh-voice-typing\/session/.test(HOST_SRC))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
