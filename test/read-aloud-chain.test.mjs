/**
 * 端到端「朗读链路」：真实 apply() + 真实 llm/stream 钩子 + 真实 /reading-ack 路由
 * + 假宿主/SSE 采集 + 模拟客户端（按播放进度 ack）。
 *
 * 验证宿主新契约（lib/read-aloud-scheduler.js）：
 *   A. 内容完整、无重复、顺序正确：各段实际片段拼接 == 该段 stripForSpeech 文本
 *      （允许片段合并，不允许重复/丢失）。
 *   B. 段落不被跨越 + 段内顺序单调：某段所有片段发完前不出现下一段；
 *      段内 offset 严格递增；每段第一个片段 `paraStart === true`、其余 false；
 *      `para` 与期望段序号一致（客户端据此整段裁剪，永不从段落中间开始播）。
 *   C. 流控：flow 模式下任意时刻「已发未 ack」句数 <= READ_ALOUD_LEAD(3)；
 *      客户端 ack 一句宿主补发（不无限预发）；无 ack 时降级 pending（旧 400ms
 *      时间窗口节奏），内容最终仍完整发出、不因等 ack 卡死。
 *   D. 首句延迟 <= 150ms（自「宿主最早可能发出首句」的时刻）。
 *   E. 场景覆盖：多段落、慢速流式（120/300ms/chunk）、一次灌入、列表/标题/引用/
 *      代码围栏、中英混排、一轮两次 llm/stream 调用（工具调用链）。
 *
 * 另外断言 ack 路由契约（未知会话/turnId 不匹配返回 ok:false、非 POST 返回 405）
 * 与 /diagnostics 的调度器状态（mode / outstanding / pendingUnits / stalls / acks）。
 *
 * 运行：node test/read-aloud-chain.test.mjs（退出码 0 = 全通过）。
 */
import os from 'node:os'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'

const tmpHome = path.join(os.tmpdir(), `dsh-vt-read-aloud-chain-${process.pid}`)
await mkdir(tmpHome, { recursive: true })
process.env.DSH_HOME = tmpHome

const { apply } = await import('../lib/index.js')
const { splitParagraphs } = await import('../lib/paragraph.js')
const { stripForSpeech, splitSentenceParts } = await import('../lib/speech-clean.js')
const { createFenceFilter } = await import('../lib/fence-filter.js')
const { EMIT_WINDOW_MS, MAX_SENTENCE_CHARS, splitLongText, packWindowSentences } = await import(
  '../lib/read-aloud-policy.js'
)
const { READ_ALOUD_LEAD } = await import('../lib/read-aloud-scheduler.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ============================================================
// 假宿主 / SSE 采集 / ack 路由调用
// ============================================================
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

function connectSse(h) {
  const def = h.routes.get('/dsh-voice-typing/stream')
  if (!def) throw new Error('SSE 路由 /dsh-voice-typing/stream 未注册')
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

// readAloudLag: 0 = 关闭「追赶最新」：本测试要验证「全部内容完整发出」的契约；
// 追赶语义由 test/read-aloud-scheduler.test.mjs 单独覆盖。
const HOST = makeHost({ readAloud: true, preloadModels: false, readAloudLag: 0 })
const SSE = connectSse(HOST)
const HOOK = HOST.handlers.get('llm/stream')
if (typeof HOOK !== 'function') {
  console.error('致命：llm/stream 钩子没有注册')
  process.exit(2)
}
const ACK_DEF = HOST.routes.get('/dsh-voice-typing/reading-ack')
const DIAG_DEF = HOST.routes.get('/dsh-voice-typing/diagnostics')

/** 通过真实路由 handler 发一次 ack（假 req/res，参考仓库内 test 的写法）。 */
async function postAck({ sessionId, turnId, count }) {
  if (!ACK_DEF) return { status: 0, body: null }
  const payload = JSON.stringify({ sessionId, turnId, count })
  const req = {
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload) },
  }
  let raw = ''
  const res = { writeHead(_s) {}, end(s) { raw += s == null ? '' : String(s) } }
  await ACK_DEF.handler(req, res)
  let body = null
  try { body = JSON.parse(raw || '{}') } catch { body = null }
  return { body }
}

async function readDiagnostics() {
  let raw = ''
  const res = { writeHead() {}, end(s) { raw += s == null ? '' : String(s) } }
  await DIAG_DEF.handler({ method: 'GET' }, res)
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

// ============================================================
// chunk 切分器
// ============================================================
const byChars = (n) => (text) => {
  const out = []
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n))
  return out
}
const byLine = (text) => {
  const out = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') { out.push(text.slice(start, i + 1)); start = i + 1 }
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}
const bySentence = (text) => {
  const out = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if ('。！？!?；;'.includes(ch)) { out.push(text.slice(start, i + 1)); start = i + 1; continue }
    if (ch === '.' && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      out.push(text.slice(start, i + 1)); start = i + 1
    }
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}
const byAll = (text) => [text]

// ============================================================
// 期望序列 + 检查器（A/B + para/paraStart + D）
// ============================================================
function stripFences(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
}

function buildExpected(calls) {
  const out = []
  for (let ci = 0; ci < calls.length; ci++) {
    const raw = stripFences(calls[ci].text)
    const { paragraphs } = splitParagraphs(raw + '\n\n')
    for (const para of paragraphs) {
      const clean = stripForSpeech(para)
      if (clean) out.push({ call: ci, raw: para, clean })
    }
  }
  return out
}

function idealSentences(clean) {
  const { pieces } = packWindowSentences(splitLongText(clean, MAX_SENTENCE_CHARS), {
    maxChars: MAX_SENTENCE_CHARS,
    maxPieces: 9999,
  })
  return pieces.map((s) => s.trim()).filter((s) => s.length >= 2)
}

const WS_RE = /[\s\u00a0\u3000]/
const normalizeText = (s) => String(s ?? '').replace(/[\s\u00a0\u3000]+/g, '')
function buildNorm(text) {
  const src = String(text ?? '')
  let norm = ''
  const map = []
  for (let i = 0; i < src.length; i++) {
    if (WS_RE.test(src[i])) continue
    norm += src[i]
    map.push(i)
  }
  return { norm, map }
}

/**
 * 把实际 sentence 事件映射回「期望段落 + 段内起始 offset」，并检查：
 *   A 完整无重复、B 段落不跨越、C 段首 offset 0、D 段内 offset 递增、
 *   para/paraStart 契约。
 */
function checkSentences(expected, events) {
  const problems = []
  const paras = expected.map((e, i) => ({ idx: i, ...e, ...buildNorm(e.clean) }))
  const assignments = paras.map(() => [])
  let p = 0
  let pos = 0

  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei]
    const evNorm = normalizeText(ev.text)
    if (!evNorm) { problems.push({ kind: 'EMPTY_EVENT', ei, text: ev.text }); continue }
    while (p < paras.length && pos >= paras[p].norm.length) { p++; pos = 0 }
    let found = null
    for (let j = p; j < paras.length; j++) {
      const from = j === p ? pos : 0
      const at = paras[j].norm.indexOf(evNorm, from)
      if (at >= 0) { found = { j, at }; break }
    }
    if (!found) {
      problems.push({
        kind: 'A_UNMATCHED_EVENT', ei, text: ev.text,
        atPara: p, atNormPos: pos,
        expectedRemaining: paras[p] ? paras[p].norm.slice(pos, pos + 80) : '',
      })
      // 事件字段仍然要检查（para 契约）
      problems.push(...checkFields(ev, ei, null, paras.length))
      continue
    }
    const { j, at } = found
    const para = paras[j]
    if (j > p) {
      problems.push({
        kind: 'B_CROSS_PARA', ei, text: ev.text,
        fromPara: p, toPara: j,
        fromRemaining: paras[p] ? paras[p].norm.slice(pos, pos + 80) : '',
      })
    }
    const startOrig = para.map[at]
    const prev = assignments[j].length ? assignments[j][assignments[j].length - 1] : null
    if (!prev && startOrig !== 0) {
      problems.push({
        kind: 'C_FIRST_NOT_AT_0', ei, text: ev.text, para: j,
        startOffset: startOrig, paraHead: para.clean.slice(0, 40),
      })
    }
    if (prev && !(startOrig > prev.startOrig)) {
      problems.push({
        kind: 'D_NOT_INCREASING', ei, text: ev.text, para: j,
        prevOffset: prev.startOrig, startOffset: startOrig,
      })
    }
    problems.push(...checkFields(ev, ei, j, paras.length))
    assignments[j].push({ ei, at, startOrig })
    p = j
    pos = at + evNorm.length
  }

  for (let j = 0; j < paras.length; j++) {
    const para = paras[j]
    const got = assignments[j].map((a) => normalizeText(events[a.ei].text)).join('')
    if (got === para.norm) continue
    let k = 0
    while (k < got.length && k < para.norm.length && got[k] === para.norm[k]) k++
    problems.push({
      kind: 'A_CONTENT_MISMATCH', para: j,
      atNormOffset: k,
      missingInActual: para.norm.slice(k, k + 80),
      extraInActual: got.slice(k, k + 80),
      expectedLen: para.norm.length, actualLen: got.length,
      assignedEvents: assignments[j].length,
      paraHead: para.clean.slice(0, 40),
    })
  }
  return { problems, assignments, paras }
}

function checkFields(ev, ei, mappedPara, paraCount) {
  const problems = []
  const para = ev.para
  if (typeof para !== 'number' || !Number.isInteger(para) || para < 0) {
    problems.push({ kind: 'PARA_FIELD_INVALID', ei, text: ev.text, para })
    return problems
  }
  if (mappedPara !== null && para !== mappedPara) {
    problems.push({
      kind: 'PARA_FIELD_MISMATCH', ei, text: ev.text,
      mappedPara, eventPara: para,
    })
  }
  if (para >= paraCount) {
    problems.push({ kind: 'PARA_FIELD_OUT_OF_RANGE', ei, para, paraCount })
  }
  return problems
}

/** 段落边界 + paraStart 契约：每段第一个事件 paraStart=true，其余 false。 */
function checkParaStart(expected, events) {
  const problems = []
  const total = expected.length
  const groups = new Map()
  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei]
    if (typeof ev.para !== 'number') continue
    if (!groups.has(ev.para)) groups.set(ev.para, [])
    groups.get(ev.para).push({ ei, ev })
  }
  for (const [para, list] of groups) {
    if (list[0].ev.paraStart !== true) {
      problems.push({
        kind: 'PARASTART_MISSING', para, ei: list[0].ei,
        text: list[0].ev.text, paraStart: list[0].ev.paraStart,
      })
    }
    for (let k = 1; k < list.length; k++) {
      if (list[k].ev.paraStart !== false) {
        problems.push({
          kind: 'PARASTART_EXTRA', para, ei: list[k].ei,
          text: list[k].ev.text, paraStart: list[k].ev.paraStart,
        })
      }
    }
  }
  // 段落序号必须 0..n-1 连续且按序出现（同一段绝不重复出现）。
  let last = -1
  for (let ei = 0; ei < events.length; ei++) {
    const para = events[ei].para
    if (typeof para !== 'number') continue
    if (para < last) {
      problems.push({ kind: 'PARA_ORDER_REGRESSION', ei, para, last })
    } else if (para > last + 1) {
      problems.push({ kind: 'PARA_GAP', ei, para, last })
    }
    last = para
  }
  const seen = new Set(events.map((e) => e.para).filter((x) => typeof x === 'number'))
  for (let j = 0; j < total; j++) {
    if (!seen.has(j)) problems.push({ kind: 'PARA_MISSING', para: j })
  }
  return problems
}

/**
 * C 流控时间线：进入 flow 模式后任意时刻「已发未 ack」<= READ_ALOUD_LEAD。
 *
 * **排序不能用毫秒时间戳**（Date.now 分辨率 1ms）：
 *   pending 阶段的时间窗口可能恰好在第一条 ack 的同一毫秒发句，
 *   用时间戳排序会把「ack 前发出的 pending 句」当成 ack 触发的 flow 句，
 *   误判成超出上限（实测偶发 maxOutstandingFlow=4）。
 *
 * 正确做法：SSE 事件按**捕获顺序**是确定的。客户端每次 ack 前记下
 * 「当时已捕获的事件数」`snapshot`；`snapshot <= i` 的 ack 先于第 i 条事件生效。
 *
 * 记账语义与调度器 ack() 一致：
 *   - pending 阶段每发一句未确认 +1（旧时间窗口节奏，不受 lead 约束）；
 *   - **第一条 ack 进入 flow：未确认 = max(0, 未确认 - count)，不是清零**
 *     （pending 阶段已发的句子也是未确认的，清零会导致多预发、冲破 lead）；
 *   - 之后每 emit +1、每 ack −count；flow 内未确认必须恒 <= lead。
 */
function checkFlowControl(events, acks, lead) {
  const problems = []
  const okAcks = acks
    .filter((a) => a.ok)
    .slice()
    .sort((x, y) => (x.snapshot - y.snapshot) || (x.at - y.at))
  let outstanding = 0
  let flowStarted = false
  let maxOutstandingFlow = 0
  let maxOutstandingBeforeFlow = 0
  let ai = 0
  const perAckBurst = []
  for (let i = 0; i < events.length; i += 1) {
    // 先结算「在第 i 条事件之前就已发出」的 ack（它们可能触发第 i 条事件）。
    while (ai < okAcks.length && okAcks[ai].snapshot <= i) {
      const a = okAcks[ai]
      ai += 1
      if (!flowStarted) flowStarted = true
      outstanding = Math.max(0, outstanding - (a.count ?? 1))
      perAckBurst.push(0)
    }
    outstanding += 1
    if (flowStarted) {
      maxOutstandingFlow = Math.max(maxOutstandingFlow, outstanding)
      if (perAckBurst.length) perAckBurst[perAckBurst.length - 1] += 1
    } else {
      maxOutstandingBeforeFlow = Math.max(maxOutstandingBeforeFlow, outstanding)
    }
  }
  // 事件之后的 ack（收尾归还配额）不影响上限断言。
  while (ai < okAcks.length) {
    ai += 1
    if (!flowStarted) flowStarted = true
  }
  if (maxOutstandingFlow > lead) {
    problems.push({ kind: 'C_OUTSTANDING_OVER_LEAD', maxOutstandingFlow, lead })
  }
  return { problems, maxOutstandingFlow, maxOutstandingBeforeFlow, perAckBurst }
}

// ============================================================
// 「最早可能发出首句」模拟（围栏过滤 + 段落/句子切分 + 清洗）
// ============================================================
function firstReadyChunkIndex(chunks) {
  const fence = createFenceFilter()
  let acc = ''
  for (let i = 0; i < chunks.length; i++) {
    const body = fence.push(String(chunks[i]))
    if (body) acc += body
    if (!acc) continue
    try {
      const { paragraphs } = splitParagraphs(acc)
      for (const para of paragraphs) {
        if (stripForSpeech(para)) return i
      }
      const { parts } = splitSentenceParts(acc)
      for (const part of parts) {
        const text = stripForSpeech(part)
        if (text && idealSentences(text).length) return i
      }
    } catch { /* 忽略 */ }
  }
  return -1
}

// ============================================================
// 场景运行
// ============================================================
const checkList = []
function record(name, ok, detail) {
  checkList.push({ name, ok, detail })
  if (ok) console.log('  ok   ' + name)
  else console.log('  FAIL ' + name + (detail ? ' :: ' + detail : ''))
}

async function runCase(def, caseIndex, label) {
  console.log(`\n== ${label} ==`)
  const sessionId = `chain-${caseIndex}`
  const startCursor = SSE.events.length
  const useAcks = def.acks !== false
  const calls = def.calls
  const hardTimeout = def.hardTimeoutMs ?? 20000
  const ackBatch = Math.max(1, Math.min(8, def.ackBatch ?? 1))
  /** 客户端发出的 ack（at 是「这几句开始播放」的时刻，早于路由返回/补发）。 */
  const clientAcks = []
  const callMeta = []
  let streamDone = false
  let clientTimedOut = false
  let playedCount = 0

  const sentenceCount = () =>
    SSE.events.slice(startCursor).filter((e) => e.event === 'sentence').length
  const ackedSentences = () =>
    clientAcks.filter((a) => a.ok).reduce((n, a) => n + (a.count ?? 1), 0)

  // ---------- 生成端：真实 llm/stream 钩子 ----------
  const streamPromise = (async () => {
    for (let ci = 0; ci < calls.length; ci++) {
      const call = calls[ci]
      const chunkTimes = []
      const chunks = call.chunker(call.text)
      const readyIdx = firstReadyChunkIndex(chunks)
      const meta = {
        call: ci,
        chunkCount: chunks.length,
        intervalMs: call.intervalMs,
        readyIdx,
        chunkTimes,
        startAt: 0,
        endAt: 0,
      }
      callMeta.push(meta)
      meta.startAt = Date.now()
      const gen = async function* () {
        for (let i = 0; i < chunks.length; i++) {
          if (i > 0 && call.intervalMs > 0) await sleep(call.intervalMs)
          chunkTimes.push(Date.now())
          yield { type: 'text-delta', text: chunks[i] }
        }
      }
      const stream = HOOK(
        { sessionId, messages: [{ role: 'user', id: `u${ci + 1}` }] },
        () => gen(),
      )
      for await (const _c of stream) { /* 消费 */ }
      meta.endAt = Date.now()
    }
    streamDone = true
  })()

  // ---------- 模拟客户端：顺序播放 + 「开始播放」时 ack ----------
  // 播放时长按句长估算（真实约 4.5 字/秒；测试用 msPerChar 缩放，
  // 保持「消费慢于生产时宿主必须按 ack 节流」的相对节奏）。
  // ackBatch>1 时模拟客户端攒 2 句一起 ack（验证 ack.count 语义）。
  if (useAcks) {
    const msPerChar = def.msPerChar ?? 8
    const deadline = Date.now() + hardTimeout
    while (true) {
      const sentences = SSE.events.slice(startCursor).filter((e) => e.event === 'sentence')
      if (playedCount < sentences.length) {
        const ev = sentences[playedCount]
        playedCount += 1
        const playStart = Date.now()
        if (playedCount % ackBatch === 0) {
          // snapshot：发送 ack 时已捕获的事件数 —— ack 触发的新事件必然在其后
          // （捕获顺序是确定的，不受 Date.now 毫秒分辨率影响）。
          const snapshot = sentenceCount() // 已捕获的 **sentence 事件** 数量（事件数组只含 sentence）
          const res = await postAck({ sessionId, turnId: ev.data.turnId, count: ackBatch })
          clientAcks.push({
            at: playStart,
            snapshot,
            ok: !!(res.body && res.body.ok),
            count: ackBatch,
            text: ev.data.text,
          })
        }
        const text = String(ev.data.text ?? '')
        const playMs = Math.max(20, Math.min(600, Math.round(text.length * msPerChar)))
        await sleep(playMs)
        continue
      }
      if (streamDone) {
        await sleep(20)
        if (playedCount < sentenceCount()) continue
        // 还有「已播未 ack」的句子：先把配额还给宿主，它可能还有排队内容
        //（否则宿主会一直等 ack，看起来像卡死）。
        const unacked = playedCount - ackedSentences()
        if (unacked > 0) {
          const at = Date.now()
          const snapshot = sentenceCount() // 已捕获的 **sentence 事件** 数量（事件数组只含 sentence）
          const res = await postAck({ sessionId, turnId: '', count: unacked })
          clientAcks.push({ at, snapshot, ok: !!(res.body && res.body.ok), count: unacked, text: '' })
          continue
        }
        await sleep(150)
        if (playedCount >= sentenceCount() && playedCount === ackedSentences()) break
        continue
      }
      if (Date.now() > deadline) { clientTimedOut = true; break }
      await sleep(10)
    }
  }
  await Promise.race([streamPromise, sleep(hardTimeout)])
  if (!streamDone) clientTimedOut = true
  await sleep(50)

  const sentenceEvents = SSE.events.slice(startCursor).filter((e) => e.event === 'sentence')
  const events = sentenceEvents.map((e) => ({
    text: String(e.data?.text ?? ''),
    at: e.at,
    turnId: e.data?.turnId,
    index: e.data?.index,
    para: e.data?.para,
    paraStart: e.data?.paraStart,
  }))
  const expected = buildExpected(calls)
  const check = checkSentences(expected, events)
  const problems = [...check.problems, ...checkParaStart(expected, events)]
  const firstProblem = (pred) => {
    const found = problems.find(pred)
    return found ? JSON.stringify(found).slice(0, 500) : ''
  }

  record(`${label} | A 内容完整、无重复（期望 ${expected.length} 段 / ${events.length} 条）`,
    !problems.some((p) => p.kind.startsWith('A_')),
    firstProblem((p) => p.kind.startsWith('A_')))
  record(`${label} | B 段落不跨越 + D 段内 offset 单调`,
    !problems.some((p) => p.kind === 'B_CROSS_PARA' || p.kind === 'D_NOT_INCREASING'),
    firstProblem((p) => p.kind === 'B_CROSS_PARA' || p.kind === 'D_NOT_INCREASING'))
  record(`${label} | C 每段首片段 paraStart=true 且从段内 offset 0 开始`,
    !problems.some((p) =>
      p.kind.startsWith('C_') || p.kind.startsWith('PARASTART') || p.kind.startsWith('PARA_')),
    firstProblem((p) =>
      p.kind.startsWith('C_') || p.kind.startsWith('PARASTART') || p.kind.startsWith('PARA_')))
  record(`${label} | sentence 事件带合法 para/paraStart 字段`,
    !problems.some((p) => p.kind.startsWith('PARA_FIELD')),
    firstProblem((p) => p.kind.startsWith('PARA_FIELD')))

  {
    const indexCheck = checkIndexSequence(events)
    record(`${label} | index 从 0 连续递增（客户端据此去重）`,
      indexCheck.ok,
      indexCheck.ok ? '' : `第 ${indexCheck.at} 条 index=${indexCheck.got}，期望 ${indexCheck.expect}`)
  }

  let flow = null
  if (useAcks) {
    const okAcked = ackedSentences()
    record(`${label} | 客户端按播放进度归还配额，全部片段播完（${okAcked}/${events.length}）`,
      okAcked === events.length && !clientTimedOut,
      `acked=${okAcked} events=${events.length} timedOut=${clientTimedOut}`)

    flow = checkFlowControl(events, clientAcks, READ_ALOUD_LEAD)
    record(`${label} | C 流控：flow 模式未确认句数 <= LEAD(${READ_ALOUD_LEAD})`,
      flow.problems.length === 0,
      `maxOutstandingFlow=${flow.maxOutstandingFlow} ` +
        `maxBeforeFlow=${flow.maxOutstandingBeforeFlow} ` +
        JSON.stringify(flow.problems))
    console.log(`  info ${label} maxOutstandingFlow=${flow.maxOutstandingFlow} ` +
      `maxBeforeFlow=${flow.maxOutstandingBeforeFlow}`)
    if (def.expectLeadFill) {
      record(`${label} | C 流控真的生效（客户端慢时宿主预取到 LEAD=${READ_ALOUD_LEAD} 就停）`,
        flow.maxOutstandingFlow === READ_ALOUD_LEAD,
        `maxOutstandingFlow=${flow.maxOutstandingFlow}`)
    }
  }

  // ---------- 无 ack 降级：内容最终完整、不卡死、仍按时间窗口节奏 ----------
  if (!useAcks) {
    record(`${label} | 无 ack 降级：内容最终完整（不丢尾巴）`,
      events.length > 0 && !problems.some((p) => p.kind.startsWith('A_')),
      `events=${events.length}`)
    record(`${label} | 无 ack 降级：不因等 ack 卡死（流结束即排空）`,
      !clientTimedOut && events.length > 0, `events=${events.length}`)
    if (def.checkPendingPacing && callMeta.length) {
      const meta = callMeta[0]
      // 流式期间 = 最后一个 chunk 到达之前（之后宿主会在调用结束时同步排空，
      // 那属于旧行为里「不留尾巴」的收尾，不该算进窗口节奏）。
      const lastChunkAt = meta.chunkTimes[meta.chunkTimes.length - 1] ?? meta.endAt
      const streamMs = lastChunkAt - meta.startAt
      const during = events.filter((e) => e.at < lastChunkAt - 2).length
      const bound = Math.ceil(streamMs / EMIT_WINDOW_MS) + 2
      record(`${label} | 无 ack 降级：流式期间按 ${EMIT_WINDOW_MS}ms 窗口节奏（不爆发）`,
        during <= bound, `期间发 ${during} 条，上限 ${bound}（流 ${streamMs}ms）`)
      console.log(`  info ${label} 流式期间 ${during} 条 / 上限 ${bound}（流 ${streamMs}ms）`)
    }
  }

  // ---------- D 首句延迟（每 call 一次 llm/stream）----------
  const firstEventPerCall = new Map()
  for (let j = 0; j < check.assignments.length; j++) {
    const callIdx = expected[j]?.call
    for (const a of check.assignments[j]) {
      const cur = firstEventPerCall.get(callIdx)
      if (cur === undefined || a.ei < cur) firstEventPerCall.set(callIdx, a.ei)
    }
  }
  for (const meta of callMeta) {
    const ei = firstEventPerCall.get(meta.call)
    const firstEvent = ei === undefined ? null : events[ei]
    const tReady = meta.readyIdx >= 0 ? meta.chunkTimes[meta.readyIdx] : null
    if (!firstEvent) {
      record(`${label} | call${meta.call} 首句发出`, false, '没有任何事件归到该 call')
      continue
    }
    if (tReady === null) {
      record(`${label} | call${meta.call} 首句延迟（无 ready 点，跳过）`, true)
      continue
    }
    const delay = firstEvent.at - tReady
    // flow 模式：若本次调用开始时还有未确认句（上一次调用的内容正等客户端播放），
    // 首句必须等 ack 才能发 —— 这是流控的正确行为，不做严格断言。
    const outstandingAtStart = useAcks
      ? events.filter((e) => e.at < meta.startAt).length -
        clientAcks.filter((a) => a.ok && a.at < meta.startAt)
          .reduce((n, a) => n + (a.count ?? 1), 0)
      : 0
    if (useAcks && outstandingAtStart > 0) {
      record(`${label} | call${meta.call} 首句延迟（当时有 ${outstandingAtStart} 条未确认，流控等待属正常）`,
        true, `delay=${delay}ms`)
    } else {
      record(`${label} | call${meta.call} 首句延迟 <=150ms`, delay <= 150, `delay=${delay}ms`)
    }
  }

  // ---------- 诊断快照：流控真的生效、没有积压、watchdog 未触发 ----------
  const diag = await readDiagnostics()
  const state = (diag.readAloud ?? []).find((s) => s.sessionId === sessionId)
  if (useAcks) {
    const okAcked = ackedSentences()
    record(`${label} | 诊断：mode=flow / outstanding=0 / pendingUnits=0 / stalls=0 / acks=${okAcked}`,
      !!state && state.mode === 'flow' && state.outstanding === 0 &&
        state.pendingUnits === 0 && state.stalls === 0 && state.acks === okAcked,
      JSON.stringify(state))
  } else {
    record(`${label} | 诊断：mode=pending / pendingUnits=0（尾巴没丢）`,
      !!state && state.mode === 'pending' && state.pendingUnits === 0 && state.acks === 0,
      JSON.stringify(state))
  }

  if (problems.length) {
    console.log('  --- 违反详情 ---')
    for (const p of problems.slice(0, 12)) console.log('    ' + JSON.stringify(p))
    console.log('  期望段落: ' + JSON.stringify(expected.map((e) => e.clean)))
    console.log('  实际事件: ' +
      JSON.stringify(events.map((e) => ({ t: e.text, para: e.para, s: e.paraStart }))))
  }
  return { problems, events, expected, flowProblems: flow ? flow.problems : [] }
}

/** 同一轮内 sentence 的 index 必须从 0 连续递增。 */
function checkIndexSequence(events) {
  let expect = 0
  for (const ev of events) {
    if (ev.index !== expect) return { ok: false, at: ev.index, got: ev.index, expect }
    expect += 1
  }
  return { ok: true }
}

// ============================================================
// 场景定义
// ============================================================
const REPLY_MULTI = [
  '第一段第一句：这里说明背景情况。第一段第二句：补充一个关键细节。第一段第三句：给出初步结论。',
  '第二段只有一句话，但它足够长，不会被合并进别的段落里。',
  '第三段第一句：分析原因，可能是网络抖动。第三段第二句：也可能是模型输出被截断。',
  '第四段第一句：总结一下上述现象。第四段第二句：给出后续处理建议。第四段第三句：如有疑问请联系维护者。',
].join('\n\n')

const REPLY_LONG_PARA = (() => {
  const sents = []
  for (let i = 1; i <= 7; i++) {
    sents.push(`第${i}句话在这里展开，描述一个具体的技术细节，长度大约三十个字左右，用于构成超长段落。`)
  }
  return sents.join('')
})()

const REPLY_MARKDOWN = [
  '# 安装与验证步骤',
  '',
  '请按下面的顺序操作，不要跳步，否则可能出现环境不一致的问题。',
  '',
  '1. 先安装 Node 运行环境，要求版本十八以上。',
  '2. 再执行依赖安装命令，确保过程没有报错。',
  '3. 最后跑一遍测试脚本，确认全部检查都通过。',
  '',
  '> 离线环境需要提前下载模型。',
  '> 否则首次朗读会直接失败。',
  '',
  '完成以上步骤之后，重启服务即可生效。',
].join('\n')

const REPLY_FENCE = [
  '先看下面这段代码。',
  '',
  '```js',
  'const a = 1',
  'console.log(a)',
  '```',
  '',
  '代码的意思是打印一个常量。',
  '',
  '最后一段结束。',
].join('\n')

const REPLY_MIXED = [
  'The quick brown fox jumps over the lazy dog. It then runs away quickly.',
  '',
  '中文段落第一句：这是一个测试。中文段落第二句：English words are mixed in here. 最后一句结束。',
].join('\n')

const REPLY_INCOMPLETE = '第一段已经完整结束了。\n\n第二段还没有句号就断了'

const CALL1 = '我先查一下当前的依赖版本。\n\n稍等，正在读取配置文件。'
const CALL2 = '查到了：依赖版本是 3.2.1。\n\n第一项检查通过。\n\n第二项也通过，可以继续。'

let caseSeq = 0
async function scenario(label, def) {
  caseSeq += 1
  return runCase(def, caseSeq, label)
}

// ---------- ack 模式（flow）----------
await scenario('ack/multi-para by-sentence@120ms', {
  calls: [{ text: REPLY_MULTI, chunker: bySentence, intervalMs: 120 }],
  msPerChar: 6,
})
await scenario('ack/multi-para 7char@30ms（客户端慢：30字≈240ms）', {
  calls: [{ text: REPLY_MULTI, chunker: byChars(7), intervalMs: 30 }],
  msPerChar: 8,
  expectLeadFill: true,
})
await scenario('ack/all-at-once@0ms（首条 ack 到达前 pending 已排空：兼容行为）', {
  calls: [{ text: REPLY_MULTI, chunker: byAll, intervalMs: 0 }],
  msPerChar: 8,
})
await scenario('ack/long-para（>300字） by-sentence@300ms', {
  calls: [{ text: REPLY_LONG_PARA, chunker: bySentence, intervalMs: 300 }],
  msPerChar: 4,
  hardTimeoutMs: 20000,
})
await scenario('ack/markdown 列表/标题/引用 7char@0ms', {
  calls: [{ text: REPLY_MARKDOWN, chunker: byChars(7), intervalMs: 0 }],
  msPerChar: 4,
})
await scenario('ack/代码围栏 by-line@30ms', {
  calls: [{ text: REPLY_FENCE, chunker: byLine, intervalMs: 30 }],
  msPerChar: 4,
})
await scenario('ack/中英混排 20char@0ms', {
  calls: [{ text: REPLY_MIXED, chunker: byChars(20), intervalMs: 0 }],
  msPerChar: 6,
})
await scenario('ack/一轮两次 llm/stream（工具调用链）by-sentence@120ms', {
  calls: [
    { text: CALL1, chunker: bySentence, intervalMs: 120 },
    { text: CALL2, chunker: bySentence, intervalMs: 120 },
  ],
  msPerChar: 6,
})
await scenario('ack/攒 2 句一起 ack（count=2 语义）', {
  calls: [{ text: REPLY_MULTI, chunker: bySentence, intervalMs: 120 }],
  ackBatch: 2,
  msPerChar: 8,
})

// ---------- 无 ack（老客户端：pending 降级）----------
await scenario('pending(无ack)/multi-para by-sentence@120ms', {
  acks: false,
  calls: [{ text: REPLY_MULTI, chunker: bySentence, intervalMs: 120 }],
  checkPendingPacing: true,
})
await scenario('pending(无ack)/代码围栏 by-line@0ms', {
  acks: false,
  calls: [{ text: REPLY_FENCE, chunker: byLine, intervalMs: 0 }],
})
await scenario('pending(无ack)/一轮两次 llm/stream', {
  acks: false,
  calls: [
    { text: CALL1, chunker: bySentence, intervalMs: 120 },
    { text: CALL2, chunker: bySentence, intervalMs: 120 },
  ],
})
await scenario('pending(无ack)/一次灌入 all-at-once', {
  acks: false,
  calls: [{ text: REPLY_MULTI, chunker: byAll, intervalMs: 0 }],
})
await scenario('pending(无ack)/结尾未完成段 7char@30ms', {
  acks: false,
  calls: [{ text: REPLY_INCOMPLETE, chunker: byChars(7), intervalMs: 30 }],
})

// ---------- 路由契约 ----------
console.log('\n== ack 路由契约 ==')
{
  const res1 = await postAck({ sessionId: 'no-such-session', turnId: 'turn-x', count: 1 })
  record('未知会话的 ack 返回 ok:false（不误伤其它会话）', res1.body?.ok === false, JSON.stringify(res1.body))

  const res2 = await postAck({ sessionId: 'chain-1', turnId: 'wrong-turn', count: 1 })
  record('turnId 不匹配的 ack 返回 ok:false', res2.body?.ok === false, JSON.stringify(res2.body))

  // GET 该路由应 405
  let raw = ''
  const def = ACK_DEF
  const res3 = { writeHead() {}, end(s) { raw += s == null ? '' : String(s) } }
  await def.handler({ method: 'GET' }, res3)
  let body3 = null
  try { body3 = JSON.parse(raw || '{}') } catch { body3 = null }
  record('GET /reading-ack 返回 405（只接受 POST）', body3?.error === 'method not allowed', raw)
}

// ---------- 汇总 ----------
const failed = checkList.filter((c) => !c.ok)
const passed = checkList.length - failed.length
console.log(`\n通过 ${passed}，失败 ${failed.length}`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f.name + (f.detail ? ' :: ' + String(f.detail).slice(0, 400) : ''))
}
console.log(failed.length === 0
  ? '结论：朗读链路 A 内容完整/无重复、B 段落顺序、C 流控、D 首句延迟、E 降级与多场景全部通过。'
  : '结论：存在失败的链路契约（见上）。')
process.exitCode = failed.length ? 1 : 0
process.exit(failed.length ? 1 : 0)
