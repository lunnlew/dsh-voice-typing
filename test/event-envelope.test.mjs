/**
 * 事件信封 v2 的**运行时**回归测试（宿主侧）。
 *
 * 背景（2026-10-31）：
 *   阶段 3 把 SSE 事件改成统一信封：
 *     data: {"v":2,"seq":12,"ts":1735000000000,"sessionId":"s1","text":"你好","turnId":"turn-x","index":0}
 *
 *   （原 test/event-contract.test.mjs 已并入本文件：它检查的**源码形状**
 *   （正则扫 lib/index.js）与信封断言大多重复，独有的一条「真实
 *   buildEventEnvelope → 客户端 parseEnvelope 的 sentence 字段/para/paraStart
 *   接缝」已迁到下面第 3b 节；原文件已删除。）
 *   本文件真正补的是源码形状测不到的那一层：**真的把插件拉起来**，
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
import { hostModule } from './helpers/host-source.mjs'

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
// 形状断言全部从这个文件搬走了（批次 6i-b，docs §8.42）：
// 上面那份 `await import('../lib/index.js')` 拿到的是真产物，本文件的判据现在都跑在
// 真广播出来的帧、真路由的响应上。原来还留着三条读手写源码的正则，去向写在下面两处注释里。
// ENV_SRC 随着「协议层抽到独立模块」那条形状断言一起删了：
// 顶层 `await import('../lib/index.js')` 能取到 buildEventEnvelope / EVENT_PROTOCOL_VERSION，
// 已经比「那个文件里还有这两行 export」更硬；剩下的判据都在真帧上。

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
// 3b) sentence 契约：真实调度器产出 para/paraStart → 真实信封 → 客户端解析
//
// （由 test/event-contract.test.mjs 迁移而来 —— 该文件其余内容是信封形状的重复
//   断言与「用自造 stub 断言 index 连续」的自证断言，已删除。）
// 这里用**真实** createReadAloudScheduler + **真实** turnModel.nextSentenceIndex
// 产句子，再用**真实** buildEventEnvelope + 客户端 parseEnvelope 走一遍接缝。
// ---------------------------------------------------------------------------
console.log('\nsentence 契约：真实调度器产出 → 真实信封 → 客户端解析')
{
  const { createReadAloudScheduler } = await hostModule('read-aloud-scheduler')
  const { createTurnModel } = await hostModule('turn-model')
  const { parseEnvelope } = await import('../src/client/pure/envelope.js')

  // 真实生产实现：句子序号由 turnModel.nextSentenceIndex 分配（不是测试自己造的 stub），
  // 「index 从 0 连续」因此是真断言，而不是自证。
  const tm = createTurnModel({ getSessionsService: () => null })
  const emitted = []
  const scheduler = createReadAloudScheduler({
    emit: (event, payload) => emitted.push({ event, payload }),
    nextIndex: (sid) => tm.nextSentenceIndex(sid),
  })
  // 段落 0 故意超过单句上限（60 字）→ 段内切成多个片段；段落 1 很短 → 单片段。
  const para0 = '这是用来测试段落内多个片段的第一句话。'
    + '这是第二句话，内容要足够长以便超过单句上限。'
    + '这是第三句话，继续补充一些内容让总长度明显超过六十个字的上限。'
  const reader = scheduler.reader('sess-1', 'turn-abc')
  reader.push(para0 + '\n\n第二段只有一句话。\n\n')
  reader.end()

  const sentences = emitted.filter((x) => x.event === 'sentence').map((x) => x.payload)
  check('前置：至少切出 2 段、3 个片段', sentences.length >= 3, `pieces=${sentences.length}`)
  check('每条 sentence 带 text/turnId/index/para/paraStart（类型正确）',
    sentences.every((s) => typeof s.text === 'string' && s.text.trim().length > 0
      && typeof s.turnId === 'string' && s.turnId.length > 0
      && Number.isInteger(s.index) && s.index >= 0
      && Number.isInteger(s.para) && s.para >= 0
      && typeof s.paraStart === 'boolean'),
    JSON.stringify(sentences[0]))
  check('sentence.text 是清洗后的纯文本（不含 Markdown 标记）',
    sentences.every((s) => !/[#*`>]/.test(s.text)), JSON.stringify(sentences.map((s) => s.text)))
  check('index 从 0 连续递增（真实 turnModel 计数；客户端 (turnId,index) 去重的前提）',
    sentences.every((s, i) => s.index === i), JSON.stringify(sentences.map((s) => s.index)))
  check('para 从 0 开始、单调不减',
    sentences[0]?.para === 0 && sentences.every((s, i) => i === 0 || s.para >= sentences[i - 1].para),
    JSON.stringify(sentences.map((s) => s.para)))
  const flagsByPara = new Map()
  for (const s of sentences) {
    if (!flagsByPara.has(s.para)) flagsByPara.set(s.para, [])
    flagsByPara.get(s.para).push(s.paraStart)
  }
  check('每个 para 只有第一个片段 paraStart=true、其余 false',
    [...flagsByPara.values()].every((flags) => flags[0] === true && flags.slice(1).every((f) => f === false)),
    JSON.stringify([...flagsByPara.entries()]))
  check('同一 para 的片段连续出现（段落不交叉）',
    (() => {
      const seen = new Set()
      let last = -1
      for (const s of sentences) {
        if (s.para === last) continue
        if (seen.has(s.para)) return false
        seen.add(s.para)
        last = s.para
      }
      return true
    })(),
    JSON.stringify(sentences.map((s) => s.para)))

  // 接缝第二步：这些业务字段必须能被**真实信封 + 客户端解析**原样带过去。
  const roundTrip = sentences.map((s) => parseEnvelope({ data: JSON.stringify(buildEventEnvelope(s)) }))
  check('真实信封 + parseEnvelope 后 para/paraStart/index/turnId/text 原样保留',
    roundTrip.every((p, i) => p.v === EVENT_PROTOCOL_VERSION
      && p.para === sentences[i].para
      && p.paraStart === sentences[i].paraStart
      && p.index === sentences[i].index
      && p.turnId === sentences[i].turnId
      && p.text === sentences[i].text
      && p.sessionId === 'sess-1'),
    JSON.stringify(roundTrip[0]))
  scheduler.dispose()
}

// 原来这里是「客户端除 parseEnvelope 内部外没有裸的 JSON.parse(event.data)」的源码计数。
// **删**（批次 6i-b，docs §8.42），理由分两半：
//   · 它能守住的「消费点真的在用信封」这一半，现在由 `test/client-behavior.test.mjs`
//     的场景「信封消费」真跑：别的会话的句子既不念也不回执、缺 sessionId 的全局事件照样生效、
//     五种事件的 data 喂坏之后 SSE 还能继续念 —— 那三条判的是这件事的实际后果。
//   · 它的另一半「不许出现裸解析」在这里**没有行为面**：客户端每个 SSE handler 外面都包着
//     `try { … } catch { /* 忽略 */ }`，裸解析抛出来的异常会被那层 catch 当场吞掉，
//     和 parseEnvelope 返回 null 走的是同一条出口，跑不出差别。
//     推翻条件：哪天把某个 handler 外面那层 catch 去掉（让坏帧成为可观察的故障），
//     「有没有裸解析」就又能被跑出来了 —— 那时应该在 client-behavior 里加判据，而不是回到这条正则。

// 客户端解析器的健壮性（event-contract 迁移）：坏输入不能抛。
{
  const { parseEnvelope, belongsToSession } = await import('../src/client/pure/envelope.js')
  check('坏 JSON 返回 null', parseEnvelope({ data: '{not json' }) === null)
  check('非对象（JSON 字符串）返回 null', parseEnvelope({ data: '"hello"' }) === null)
  check('空信封 belongsToSession 不崩（返回 false）', belongsToSession(null, 'sess-1') === false)
}

// ---------------------------------------------------------------------------
// 4) 路由：配置与诊断分开，死路由删干净
// ---------------------------------------------------------------------------console.log('\n路由：配置与诊断数据分开')
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
  check('GET /latest-message 已删除（批次 17：客户端不调的死链，约 100 行 + 一份轮次键双实现）',
    !host.routes.has('/dsh-voice-typing/latest-message'))
  // 「源码里标注了未使用」删掉了：注释是不是这么写的，不是能被测出来的行为（§8.34 批次 0）。
}

console.log('\n信封与死事件的清理（本节现在一条源码正则都不留）')
// 这一节原来 11 条，先删了 8 条 —— 它们盯的东西这个文件已经在前面的真执行场景里查过了：
//   · 每帧都带 v/seq/ts/sessionId → 等价于「broadcast 统一套信封」+「SSE 写整个信封」+「模块级 seq」；
//   · assistant-busy 的置位/复位/载荷（含 sessionId）→ 等价于那两条 emitBroadcast 正则；
//   · 「不发 session / 不发旧 busy 事件」+「路由表里没有 /session」→ 等价于三条死符号正则。
// 当时留下的两条（模型事件带 kind、percent 由宿主算）写着「等一个下载场景」（§8.34 批次 1），
// 那个场景一直在 `test/model-state.test.mjs` 里跑（S2 下载中 / S3 下完 / S4 失败），
// 批次 6i-b 把缺的那两格补齐：
//   · 「S2 model-progress 每一帧都带 kind」
//   · 「S4 model-error 带的是这条档位与 asr 类别」（S3 的 model-ready 早就带 kind 了）
//   · percent 那一格本来就在：S2 判的是**收下来的帧**里的 percent 是整数、0..100、单调不减、最后到 100，
//     而「percent 由宿主算」这个契约的另一半（算法本身）由本文件那 8 条 `downloadPercent` 纯函数判据守。
// 于是这两条正则删掉：宿主源码里写着 `kind` 只能证明「有人写过这个词」，
// 收到帧里带不带 kind、percent 是不是宿主算出来的，上面那三条才是能看的。

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
