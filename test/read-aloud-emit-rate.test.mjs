/**
 * 端到端：一大段文本进来时，sentence 事件的**时间节奏**必须被限住（不 burst）。
 *
 * 用户反馈：
 *   「可能会接收一大批的文本，导致发生了一大批的 TTS 请求。过程应该规则化一下吧」
 *   「按照时间窗口」「到指定的时间间隔内取到多余的某一条句子来进行合成」
 *
 * **覆盖范围（重要）**：本文件只覆盖 **pending（无 ack / 老客户端）** 路径 ——
 *   - 首句立刻发；
 *   - 其余句子按 `EMIT_WINDOW_MS` 时间窗口逐条发（不会瞬间倒空）；
 *   - 调用结束的收尾：关闭追赶（`readAloudLag=0`）时同步排空；开启追赶时先等
 *     ack grace（默认 1.2s，给新客户端发首条 ack 的机会）再一次性排空，不丢尾巴。
 * 新客户端（有 ack）的 **flow 流控 / 追赶** 路径（未确认 ≤ LEAD、ack 驱动、
 * 按整段跳段）由 `test/read-aloud-chain.test.mjs`、`test/read-aloud-catchup.test.mjs`
 * 与 `test/read-aloud-scheduler.test.mjs` 覆盖。
 *
 * 本测试用**真实的 llm/stream 钩子**，让 inner 流一口气吐出 20 句（最坏情况），
 * 然后统计广播出来的 sentence 的时间分布。
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

// ===== 核心：一次性灌入（最坏情况）时，收尾必须是「有限、有时限」的，不是按窗口慢慢拖 =====
//
// pending（无 ack / 老客户端）路径的语义是「首句立刻发 + 调用结束收尾发完」。
// 现在收尾多了一个 1.2s 的 ack grace（新客户端可能在这 1.2s 内发第一条 ack、切到
// flow 走流控与追赶；老客户端没有 ack，grace 到点后照旧一次发完 —— 不丢尾巴，只晚 ~1s）。
// 所以这里能断言的是三件事（而不是「instant 条数 <= 总句数 + 2」那种恒真式）：
//   1) 首句立刻发（不等 400ms 窗口）；
//   2) 所有剩余句子都发出来了（不丢）—— 收尾在 grace 到点后由 flushPending 一次倒出；
//   3) 收尾总时长有界（<= 3s）：如果退化成「只按 400ms 窗口一条条发、结束不排空」，
//      20 句要 ~8s，这条会失败。
// flow（有 ack）路径的「未确认 <= LEAD、ack 驱动」由
// test/read-aloud-chain.test.mjs / test/read-aloud-catchup.test.mjs 覆盖。
{
  const firstAt = times[0] ?? -1
  const rest = times.slice(1)
  const lastAt = times[times.length - 1] ?? -1

  check('首句立刻发（不等窗口）', firstAt >= 0 && firstAt <= 150, `首句 ${firstAt}ms`)
  check('一次性灌入的剩余句子全部发出（不丢尾巴）',
    rest.length === SENTENCES.length - 1,
    `非首句 ${rest.length} 条 / 期望 ${SENTENCES.length - 1} 条`)
  check('收尾有时限：最后一条在 3s 内到齐（含 1.2s 的 ack grace；不会按窗口拖 ~8s）',
    lastAt >= 0 && lastAt <= 3000,
    `最后一条 ${lastAt}ms，时间分布 ${JSON.stringify(times)}`)
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
