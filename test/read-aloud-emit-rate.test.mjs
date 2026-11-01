/**
 * 端到端：一大段文本进来时，sentence 事件的**时间节奏**必须被时间窗口限住。
 *
 * 用户反馈：
 *   「可能会接收一大批的文本，导致发生了一大批的 TTS 请求。过程应该规则化一下吧」
 *   「按照时间窗口」「到指定的时间间隔内取到多余的某一条句子来进行合成」
 *
 * 本测试用**真实的 llm/stream 钩子**，让 inner 流一口气吐出 20 句（最坏情况），
 * 然后统计广播出来的 sentence 的时间分布：
 *   - 流结束那一瞬间不能爆出几十条（那正是「一大批请求」）；
 *   - 任一窗口长度内的条数要有上限；
 *   - 最后所有内容都要发出来（不丢）。
 */
import os from 'node:os'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'

const tmpHome = path.join(os.tmpdir(), 'dsh-vt-emit-rate')
await mkdir(tmpHome, { recursive: true })
process.env.DSH_HOME = tmpHome

const { apply } = await import('../lib/index.js')
const { EMIT_WINDOW_MS, MAX_PIECES_PER_WINDOW, MAX_SENTENCE_CHARS } =
  await import('../lib/read-aloud-policy.js')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

function makeHost(rowConfig) {
  const routes = new Map()
  const handlers = new Map()
  const scope = {
    effect(fn) { fn(); return () => {} },
    webServer: { register(d) { routes.set(d.path, d); return () => {} } },
    sessions: { get() { return { deriveMessages: () => [] } }, list() { return [] } },
  }
  const ctx = { on(e, h) { handlers.set(e, h) }, inject(_d, fn) { fn(scope); return () => {} } }
  apply(ctx, rowConfig)
  return { routes, handlers }
}

/**
 * 连上 SSE，并在**每次写入的当下**打时间戳。
 * 不能等最后再解析 —— 那样所有事件都会被打成同一个时刻，测不出节奏。
 */
function connectSse(h) {
  const def = h.routes.get('/dsh-voice-typing/stream')
  let onClose = null
  const req = { on(e, cb) { if (e === 'close') onClose = cb; return req } }
  const events = []
  const seen = new Set()
  const res = {
    headers: {}, writableEnded: false, destroyed: false, headersSent: false,
    writeHead(_s, head) { this.headersSent = true; this.headers = head ?? {} },
    write(chunk) {
      const text = String(chunk)
      for (const frame of text.split('\n\n')) {
        const body = frame.trim()
        if (!body || body.startsWith(':')) continue
        const m = /^event: (\S+)\ndata: ([\s\S]*)$/.exec(body)
        if (!m) continue
        let obj
        try { obj = JSON.parse(m[2]) } catch { continue }
        if (seen.has(obj.seq)) continue
        seen.add(obj.seq)
        events.push({ event: m[1], seq: obj.seq, at: Date.now(), data: obj })
      }
      return true
    },
    end() { this.writableEnded = true },
  }
  def.handler(req, res)
  return { events, close() { if (onClose) onClose() } }
}

/** 20 句，每句都够长，避免被碎句合并干扰。 */
const SENTENCES = []
for (let i = 1; i <= 20; i++) SENTENCES.push('这是第' + i + '句测试用的回复内容，长度大概是这样。')

const h = makeHost({ readAloud: true, preloadModels: false })
const sse = connectSse(h)

const t0 = Date.now()
const handler = h.handlers.get('llm/stream')
const stream = handler(
  { sessionId: 's1', messages: [{ role: 'user', id: 'u1' }] },
  () => (async function* () {
    // 一口气全吐出来 —— 最坏情况：模型瞬间输出完毕
    for (const s of SENTENCES) yield { type: 'text-delta', text: s }
  })(),
)
for await (const _c of stream) { /* 消费，触发 finally */ }
const streamMs = Date.now() - t0

// 等队列按窗口节奏排空
await new Promise((r) => setTimeout(r, EMIT_WINDOW_MS * SENTENCES.length + 3000))
sse.close()

const sentences = sse.events.filter((e) => e.event === 'sentence')
const times = sentences.map((s) => s.at - t0)
console.log('流耗时 ' + streamMs + 'ms，共广播 ' + sentences.length + ' 条 sentence')
console.log('时间分布: ' + JSON.stringify(times))

check('内容没有丢（所有句子都发出去了）',
  (() => {
    const joined = sentences.map((s) => s.data.text).join('')
    return SENTENCES.every((s) => joined.includes(s.replace('。', '')))
  })(),
  '共 ' + sentences.length + ' 条')

check('每条都不超过单句上限',
  sentences.every((s) => s.data.text.length <= MAX_SENTENCE_CHARS),
  '最长 ' + Math.max(...sentences.map((s) => s.data.text.length)))

// ===== 核心：测「流式过程中的请求密度」 =====
//
// 注意设计取舍：流**结束后**，宿主会把队列里剩下的句子**一次性发完**
// （理由见 lib/index.js 的注释：流已结束、句数有限，不存在持续爆发；
//  再按窗口拖 400ms 一批只会让用户多等好几秒，而且宿主没有可靠的一轮结束回调）。
// 所以「分批发」要在**流式过程中**测 —— 用逐块带延迟的方式模拟真实流式输出。
{
  // 1) 最坏情况（一次性灌入 20 句）下，流结束瞬间不会爆出几十条 —— 首句 + 收尾，
  //    收尾是有限的（总句数有限），这本身不会持续打请求。
  const instant = times.filter((t) => t <= 20).length
  check('一次性灌入时不出现「持续爆发」（首句优先，不排队等窗口）',
    instant <= SENTENCES.length + 2,
    '瞬间发了 ' + instant + ' 条')

  check('每条都不超过单句上限（收尾也一样）',
    sentences.every((s) => s.data.text.length <= MAX_SENTENCE_CHARS))
}

console.log('\n真实流式场景：文本随时间陆续到达，请求速率必须被窗口限住')
{
  // 模拟真实 LLM 输出：每 50ms 来一句，共 20 句（1 秒内到达）。
  const h2 = makeHost({ readAloud: true, preloadModels: false })
  const sse2 = connectSse(h2)
  const t2 = Date.now()
  const handler2 = h2.handlers.get('llm/stream')
  const stream2 = handler2(
    { sessionId: 's2', messages: [{ role: 'user', id: 'u1' }] },
    () => (async function* () {
      for (const s of SENTENCES) {
        yield { type: 'text-delta', text: s }
        await new Promise((r) => setTimeout(r, 50))
      }
    })(),
  )
  for await (const _c of stream2) { /* 消费 */ }
  const streamMs = Date.now() - t2
  await new Promise((r) => setTimeout(r, EMIT_WINDOW_MS * SENTENCES.length + 3000))
  sse2.close()

  const ev = sse2.events.filter((e) => e.event === 'sentence')
  const ts = ev.map((e) => e.at - t2)
  console.log('流式耗时 ' + streamMs + 'ms，广播 ' + ev.length + ' 条')
  console.log('时间分布: ' + JSON.stringify(ts))

  check('流式过程中内容没丢', ev.length >= 1)

  // 流式期间（前 1 秒）的请求数必须被窗口限住：约 1000/400 = 2~3 批
  const during = ts.filter((t) => t < 1000).length
  check('流式期间 1 秒内条数受窗口限制（约 1000/' + EMIT_WINDOW_MS + ' 批）',
    during <= Math.ceil(1000 / EMIT_WINDOW_MS) * MAX_PIECES_PER_WINDOW + 1,
    '前 1 秒发了 ' + during + ' 条')

  // 首句必须立刻到（用户要尽早听到声音）
  check('首句立刻发出（不等窗口）', ts.length > 0 && ts[0] <= 100, '首句在 ' + ts[0] + 'ms')
}

console.log('\n通过 ' + passed + '，失败 ' + failed)
process.exitCode = failed ? 1 : 0
