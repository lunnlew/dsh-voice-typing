/**
 * 端到端：「追赶最新（readAloudLag）」的真实链路回归。
 *
 * 背景（用户反馈 2026-11-01，经两轮调优）：
 *   预算 15 秒、朗读已经落后 15 秒了，**下一段却还是旧的** —— 旧实现只把积压
 *   「裁到刚好 ≤ 预算」，留下的仍是十几秒前的内容，读完一段又接着读下一段旧的。
 *   现在语义：积压超预算就**整段跳旧段、保留最新 3 段**（默认预算 7.5 秒，
 *   从「最新第 3 段」开始接着读）；生成很快时还会 skim（正在读的段只读首句就跳）。
 *   中间没开始发的完整段落整段跳过。
 *
 * 本文件用**真实** `apply()` + 真实 `llm/stream` 钩子 + 真实 `/reading-ack` 路由
 * + 假 SSE 采集，覆盖三条不可由纯函数测试替代的链路：
 *   a. 慢速流式 + 慢速 ack：超预算后**跳到最新第 3 段并保留最新 3 段**
 *      （不是旧语义会留下的上一段），更旧的段整段跳过、每段 paraStart 正确、
 *      最后读到最新段、出现过的段内容完整；
 *   b. 最新内容还在 `curPara`（未成句的尾部）时超预算：丢掉更旧的段、
 *      保留最新 3 段，等尾部成段后读到最新段；
 *   c. 关闭追赶（`readAloudLag: 0`）：同样的输入必须整段顺序全部读出（对照组）。
 *   d/e. 调用结束的收尾契约：关闭追赶时**同步排空**（老客户端不额外等待）；
 *      开启追赶时先等 ack grace（给新客户端发首条 ack 的机会）再排空、不丢尾巴；
 *      e2（由已删除的 test/read-aloud-emit-rate.test.mjs 迁移）：一次性大批灌入时
 *      收尾**有时限** —— 不会退化成「按 400ms 窗口一条条慢慢拖到最后」。
 *   f. SSE 重连（页面刷新）：旧连接遗留的「已发未确认」必须被释放，
 *      新连接的首句不能等 10s 的 ack watchdog。
 *
 * 设计取舍：
 *   - 用「测试驱动的可控流」（push/close）而不是固定 sleep 竞争：真实钩子/路由不变，
 *     但 chunk 到达时机确定，断言不会因机器慢而抖。
 *   - 用每段 ≤60 字的短段落控制「估算朗读时长」（约 210ms/字，下限 700ms），
 *     使 `readAloudLag=2s` 的预算边界可精确计算：
 *       4 段 × 4 字（≈840ms/段）= 3360ms > 2000ms 预算
 *       旧语义（裁到预算内）会保留 2 段 → 下一段是「倒数第 2 段」；
 *       新语义保留最新 3 段、丢掉更旧的 → 这些短用例里等价于「只留最新段」，
 *       多段场景（a3/a5）则明确断言保留 3 段。
 *   - 每个场景先 ack 一条切到 `flow`，避免 pending 收尾 grace 干扰断言。
 *
 * 运行：node test/read-aloud-catchup.test.mjs（退出码 0 = 全通过）
 */
import os from 'node:os'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'

const tmpHome = path.join(os.tmpdir(), `dsh-vt-catchup-${process.pid}`)
await mkdir(tmpHome, { recursive: true })
process.env.DSH_HOME = tmpHome

const { apply } = await import('../lib/index.js')
const { splitParagraphs } = await import('../lib/paragraph.js')
const { stripForSpeech } = await import('../lib/speech-clean.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ============================================================
// 假宿主 / SSE / 路由调用（最小实现，不依赖其它测试文件）
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
    headersSent: false,
    writeHead() { this.headersSent = true },
    write(chunk) {
      for (const frame of String(chunk).split('\n\n')) {
        const body = frame.trim()
        if (!body || body.startsWith(':')) continue
        const m = /^event: (\S+)\ndata: ([\s\S]*)$/.exec(body)
        if (!m) continue
        let obj
        try { obj = JSON.parse(m[2]) } catch { continue }
        if (seen.has(obj.seq)) continue
        seen.add(obj.seq)
        events.push({ event: m[1], at: Date.now(), data: obj })
      }
      return true
    },
    end() { this.writableEnded = true },
  }
  def.handler(req, res)
  return { events, close() { try { onClose?.() } catch { /* 忽略 */ } } }
}

function fakeRes() {
  const res = {
    status: 0, raw: '',
    writableEnded: false, destroyed: false, headersSent: false,
    writeHead(status) { res.status = status },
    end(body) { res.raw += body == null ? '' : String(body); res.writableEnded = true },
  }
  return res
}

async function callRoute(host, routePath, { method = 'GET', body = '' } = {}) {
  const def = host.routes.get(routePath)
  if (!def) return { status: 0, body: null }
  const req = {
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body)
    },
  }
  const res = fakeRes()
  try { await def.handler(req, res) } catch (e) { return { status: -1, body: { error: String(e) } } }
  let parsed = null
  try { parsed = JSON.parse(res.raw || 'null') } catch { parsed = null }
  return { status: res.status, body: parsed }
}

function postAck(host, { sessionId, turnId, count }) {
  return callRoute(host, '/dsh-voice-typing/reading-ack', {
    method: 'POST',
    body: JSON.stringify({ sessionId, turnId, count }),
  })
}

async function readDiagnostics(host) {
  const r = await callRoute(host, '/dsh-voice-typing/diagnostics')
  return r.body ?? {}
}

// ============================================================
// 可控流：chunk 由测试推进（push/close），真实 llm/stream 钩子逐块消费
// ============================================================
function createControlledStream() {
  const queue = []
  let wake = null
  let closed = false
  const gen = async function* () {
    for (;;) {
      while (queue.length === 0) {
        if (closed) return
        await new Promise((r) => { wake = r })
      }
      yield { type: 'text-delta', text: queue.shift() }
    }
  }
  return {
    gen,
    push(text) { queue.push(text); const w = wake; wake = null; if (w) w() },
    close() { closed = true; const w = wake; wake = null; if (w) w() },
  }
}

function startStream(host, { sessionId, messages }) {
  const ctl = createControlledStream()
  const stream = host.handlers.get('llm/stream')({ sessionId, messages }, () => ctl.gen())
  const done = (async () => {
    try { for await (const _c of stream) { /* 消费，触发 finally */ } } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
    return null
  })()
  return { ctl, done }
}

// ============================================================
// 断言辅助
// ============================================================
const WS_RE = /[\s\u00a0\u3000]/
const norm = (s) => String(s ?? '').replace(/[\s\u00a0\u3000]+/g, '')

function sentenceEvents(sse, from) {
  return sse.events.slice(from).filter((e) => e.event === 'sentence').map((e) => e.data)
}

/** 期望段落：与宿主一致的「按段落切 + stripForSpeech」。 */
function expectedParagraphs(text) {
  const { paragraphs } = splitParagraphs(String(text) + '\n\n')
  return paragraphs.map((p) => stripForSpeech(p)).filter((p) => p && p.trim())
}

/**
 * 段落契约（与实现语义一一对应）：
 *   - para 单调不减、同一段的事件连续（不交叉）；
 *   - 每段第一个事件 paraStart=true、其余 false；
 *   - 该段所有事件文本拼接 == 期望段落清洗文本（出现过的段必须完整：不丢不重）；
 *   - allowSkip=false 时要求所有段落都出现。
 */
function checkParagraphContract(events, expected, { allowSkip = true } = {}) {
  const problems = []
  const groups = new Map()
  let last = -1
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]
    if (!Number.isInteger(ev.para) || ev.para < 0) {
      problems.push({ kind: 'PARA_INVALID', i, para: ev.para })
      continue
    }
    if (ev.para < last) problems.push({ kind: 'PARA_REGRESSION', i, para: ev.para, last })
    if (!groups.has(ev.para)) groups.set(ev.para, [])
    groups.get(ev.para).push({ i, ev })
    last = ev.para
  }
  for (const [para, list] of groups) {
    const idxs = list.map((x) => x.i)
    for (let k = 1; k < idxs.length; k += 1) {
      if (idxs[k] !== idxs[k - 1] + 1) problems.push({ kind: 'PARA_INTERLEAVED', para, at: idxs[k] })
    }
    if (list[0].ev.paraStart !== true) {
      problems.push({ kind: 'PARASTART_MISSING', para, text: list[0].ev.text })
    }
    for (let k = 1; k < list.length; k += 1) {
      if (list[k].ev.paraStart !== false) problems.push({ kind: 'PARASTART_EXTRA', para, at: list[k].i })
    }
    const want = expected[para]
    if (want === undefined) {
      problems.push({ kind: 'PARA_OUT_OF_RANGE', para, count: expected.length })
      continue
    }
    const got = norm(list.map((x) => x.ev.text).join(''))
    if (got !== norm(want)) {
      let k = 0
      const wanted = norm(want)
      while (k < got.length && k < wanted.length && got[k] === wanted[k]) k += 1
      problems.push({
        kind: 'PARA_CONTENT', para,
        missing: wanted.slice(k, k + 60), extra: got.slice(k, k + 60),
        gotLen: got.length, wantLen: wanted.length,
      })
    }
  }
  if (!allowSkip) {
    for (let j = 0; j < expected.length; j += 1) {
      if (!groups.has(j)) problems.push({ kind: 'PARA_MISSING', para: j })
    }
  }
  return { problems, groups }
}

/** 等待条件成立（轮询，不用固定 sleep 赌时序）。 */
async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await sleep(intervalMs)
  }
  return predicate()
}

/** 等到事件数连续 quietMs 不再变化（用于「应当不再发」的负断言）。 */
async function waitStable(getCount, { quietMs = 150, timeoutMs = 3000 } = {}) {
  const start = Date.now()
  let last = getCount()
  let stableSince = Date.now()
  while (Date.now() - start < timeoutMs) {
    await sleep(15)
    const next = getCount()
    if (next !== last) { last = next; stableSince = Date.now(); continue }
    if (Date.now() - stableSince >= quietMs) return next
  }
  return getCount()
}

/** 模拟客户端：按顺序给「已收到但还没 ack」的句子回执（慢速播放 = 每条前等 delayMs）。 */
function createAckClient(host, sessionId, sse, from) {
  let acked = 0
  return {
    async ackNew({ delayMs = 0 } = {}) {
      for (;;) {
        const sents = sentenceEvents(sse, from)
        if (acked >= sents.length) break
        const ev = sents[acked]
        acked += 1
        if (delayMs) await sleep(delayMs)
        await postAck(host, { sessionId, turnId: ev.turnId, count: 1 })
      }
      return acked
    },
    count() { return acked },
    async drain({ quietMs = 150, timeoutMs = 4000 } = {}) {
      const start = Date.now()
      let quiet = 0
      for (;;) {
        const sents = sentenceEvents(sse, from)
        if (acked < sents.length) {
          const ev = sents[acked]
          acked += 1
          await postAck(host, { sessionId, turnId: ev.turnId, count: 1 })
          quiet = 0
          if (Date.now() - start > timeoutMs) break
          continue
        }
        if (Date.now() - start > timeoutMs) break
        await sleep(15)
        if (sentenceEvents(sse, from).length === acked) {
          quiet += 1
          if (quiet * 15 >= quietMs) break
        } else quiet = 0
      }
      return acked
    },
  }
}

// ============================================================
// 结果记录
// ============================================================
let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('  ok   ' + name) }
  else {
    failures.push({ name, detail })
    console.log('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 600) : ''))
  }
}
function scenario(title) { console.log('\n== ' + title + ' ==') }

/**
 * 起一个会话 + SSE + 可控流。返回的 `closeAll()` 负责收尾（关流 + 关 SSE），
 * 每个用例都用 try/finally 调它，避免 keepAlive 定时器把进程挂住。
 */
function openSession({ rowConfig, sessionId }) {
  const host = makeHost(rowConfig)
  const sse = connectSse(host)
  const from = sse.events.length
  const { ctl, done } = startStream(host, {
    sessionId,
    messages: [{ role: 'user', id: 'u1' }],
  })
  return { host, sse, from, ctl, done, sessionId }
}

async function closeSession(ctx, client) {
  ctx.ctl.close()
  const err = await ctx.done
  if (client) await client.drain({ quietMs: 120, timeoutMs: 2000 })
  return err
}

// ============================================================
// 场景 a：慢速流式 + 慢速 ack —— 超预算后跳到「最新第 3 段」（保留最新 3 段）
// ============================================================
async function scenarioSlowStreamCatchup() {
  scenario('a) 慢速流式 + 慢速 ack：超预算后跳到最新第 3 段（保留最新 3 段）')
  const ctx = openSession({
    sessionId: 'catchup-a',
    rowConfig: { readAloud: true, preloadModels: false, readAloudLag: 2 },
  })
  const { host, sse, from, ctl } = ctx
  const client = createAckClient(host, 'catchup-a', sse, from)
  try {
    // --- 1) 慢速流式：逐段到达（段间 sleep），客户端也慢速（每句 20ms 后才 ack）---
    const slowParas = ['开头段。', '慢速第二段。', '慢速第三段。']
    for (let i = 0; i < slowParas.length; i += 1) {
      ctl.push(slowParas[i] + '\n\n')
      await waitFor(() => sentenceEvents(sse, from).length >= i + 1)
      await client.ackNew({ delayMs: 20 })
      await sleep(15)
    }
    const afterSlow = sentenceEvents(sse, from)
    check('a1 慢速阶段三句都发出且已 ack（进入 flow）', afterSlow.length === 3,
      `events=${afterSlow.length}`)
    let diag = await readDiagnostics(host)
    let state = (diag.readAloud ?? []).find((s) => s.sessionId === 'catchup-a')
    check('a2 收到 ack 后进入 flow 模式、未确认归零',
      state?.mode === 'flow' && state?.outstanding === 0, JSON.stringify(state))

    // --- 2) 一次到达 4 个短段（4×≈840ms = 3360ms > 2000ms 预算）---
    // 语义：超预算时保留最新 3 段（para 4/5/6，含"爆发二/三/四"），
    // 更旧的「爆发一」(para=3) 整段跳过；下一段从最新第 3 段（para=4）开始读。
    ctl.push('爆发一。\n\n爆发二。\n\n爆发三。\n\n爆发四。\n\n')
    await waitFor(() => sentenceEvents(sse, from).length >= 4, { timeoutMs: 2000 })
    await sleep(30) // 让「同一批」里可能的多条事件都落地，再断言条数
    const afterBurst = sentenceEvents(sse, from)
    const burstEvents = afterBurst.slice(3)
    check('a3 超预算后保留最新 3 段（para 4/5/6），不是预算内剩下的旧段',
      burstEvents.length === 3 &&
        JSON.stringify(burstEvents.map((e) => e.text)) ===
          JSON.stringify(['爆发二。', '爆发三。', '爆发四。']),
      `新增 ${burstEvents.length} 条：${JSON.stringify(burstEvents.map((e) => e.text))}`)
    check('a4 下一段是最新第 3 段（para=4），且 paraStart=true、从段首开始',
      burstEvents[0]?.para === 4 && burstEvents[0]?.paraStart === true,
      JSON.stringify(burstEvents[0]))
    check('a5 更旧的未开始段（para=3）整段跳过、一条事件都没有',
      afterBurst.every((e) => e.para !== 3),
      JSON.stringify(afterBurst.map((e) => [e.para, e.text])))

    // --- 3) 收尾：把剩余 ack 掉、关闭流、清空 ---
    await client.ackNew()
    const streamErr = await closeSession(ctx, client)
    check('a6 流正常结束、没有异常', streamErr === null, String(streamErr))

    const events = sentenceEvents(sse, from)
    const expected = expectedParagraphs(
      slowParas.map((p) => p + '\n\n').join('') + '爆发一。\n\n爆发二。\n\n爆发三。\n\n爆发四。\n\n',
    )
    const { problems, groups } = checkParagraphContract(events, expected, { allowSkip: true })
    check('a7 出现过的段落：内容完整（不丢不重）、不交叉、每段从段首开始',
      problems.length === 0, JSON.stringify(problems.slice(0, 3)))
    const paras = [...groups.keys()]
    check('a8 最终读到最新段（最后一条事件属于 para=6）',
      events[events.length - 1]?.para === 6, `last=${events[events.length - 1]?.para}`)
    check('a9 段落顺序单调、无重复段（0,1,2 之后跳到最新 3 段 4/5/6）',
      paras.join(',') === '0,1,2,4,5,6', `paras=${paras.join(',')}`)
    check('a10 sentence.index 连续（客户端去重键依赖它连续递增）',
      events.every((e, i) => e.index === i), JSON.stringify(events.map((e) => e.index)))

    diag = await readDiagnostics(host)
    state = (diag.readAloud ?? []).find((s) => s.sessionId === 'catchup-a')
    check('a11 诊断：整段跳过 1 段、保留 3 段（keepParagraphs=3）且 lagMs 有值',
      state?.trimmedParagraphs === 1 && state?.keepParagraphs === 3 && Number.isFinite(state?.lagMs),
      JSON.stringify(state))
  } finally {
    sse.close()
  }
}

// ============================================================
// 场景 b：最新内容还在 curPara（未成句尾部）—— 不得再读旧段
// ============================================================
async function scenarioNewestStillStreaming() {
  scenario('b) 最新内容还在未成句的尾部时超预算：保留最新 3 段，等尾部成段后读到最新')
  const ctx = openSession({
    sessionId: 'catchup-b',
    rowConfig: { readAloud: true, preloadModels: false, readAloudLag: 2 },
  })
  const { host, sse, from, ctl } = ctx
  const client = createAckClient(host, 'catchup-b', sse, from)
  try {
    // 先读掉首段 → 进入 flow、未确认归零
    ctl.push('开头段。\n\n')
    await waitFor(() => sentenceEvents(sse, from).length >= 1)
    await client.ackNew()
    await sleep(20)

    // 4 个旧段（3360ms > 2000ms 预算）+ 最新段的第一句还没写完（无句末标点）
    const tail = '最新一段还没写完的半句话'
    ctl.push('旧段一。\n\n旧段二。\n\n旧段三。\n\n旧段四。\n\n' + tail)
    // 负断言：给它足够时间「本来会发」的旧段（旧实现在这里会发 para=4）
    const countAfterBurst = await waitStable(() => sentenceEvents(sse, from).length, { quietMs: 200 })
    check('b1 超预算时丢掉更旧的段（para=1 不读），保留最新 3 段（para 2/3/4）',
      countAfterBurst === 4 &&
        sentenceEvents(sse, from).every((e) => e.para !== 1) &&
        [0, 2, 3, 4].every((p) => sentenceEvents(sse, from).some((e) => e.para === p)),
      JSON.stringify(sentenceEvents(sse, from).map((e) => [e.para, e.text])))

    // 前面已发出 3 条未 ack（lead=3）：先 ack 掉腾出名额（真实客户端播放中也会持续 ack）
    await client.ackNew()
    // 尾部补完句末标点 + 空行 → 成为新段落，直接读到它
    ctl.push('。\n\n')
    await waitFor(() => sentenceEvents(sse, from).length >= 5, { timeoutMs: 2000 })
    await sleep(30)
    const afterTail = sentenceEvents(sse, from)
    check('b2 尾部成段后立刻发出（para=5，且 paraStart=true）',
      afterTail.length === 5 && afterTail[4]?.para === 5 && afterTail[4]?.paraStart === true,
      JSON.stringify(afterTail.map((e) => [e.para, e.paraStart, e.text])))

    await client.ackNew()
    const streamErr = await closeSession(ctx, client)
    check('b3 流正常结束', streamErr === null, String(streamErr))

    const events = sentenceEvents(sse, from)
    const expected = expectedParagraphs(
      '开头段。\n\n旧段一。\n\n旧段二。\n\n旧段三。\n\n旧段四。\n\n' + tail + '。\n\n',
    )
    const { problems, groups } = checkParagraphContract(events, expected, { allowSkip: true })
    check('b4 出现过的段落内容完整、不交叉、每段从段首开始',
      problems.length === 0, JSON.stringify(problems.slice(0, 3)))
    check('b5 更旧的 para=1 整段跳过（保留最新 3 段 para 2/3/4）',
      events.every((e) => e.para !== 1),
      JSON.stringify(events.map((e) => e.para)))
    check('b6 最后读到最新段（para=5）', events[events.length - 1]?.para === 5,
      `last=${events[events.length - 1]?.para}`)
    check('b7 段落序列 = 首段 + 最新 3 段 + 尾部段', [...groups.keys()].join(',') === '0,2,3,4,5',
      [...groups.keys()].join(','))
  } finally {
    sse.close()
  }
}

// ============================================================
// 场景 c（对照组）：关闭追赶 —— 同样输入必须全部顺序读出
// ============================================================
async function scenarioCatchupOff() {
  scenario('c) 关闭追赶（readAloudLag=0）：同样的输入整段顺序全部读出')
  const ctx = openSession({
    sessionId: 'catchup-c',
    rowConfig: { readAloud: true, preloadModels: false, readAloudLag: 0 },
  })
  const { host, sse, from, ctl } = ctx
  const client = createAckClient(host, 'catchup-c', sse, from)
  try {
    ctl.push('开头段。\n\n')
    await waitFor(() => sentenceEvents(sse, from).length >= 1)
    await client.ackNew()
    await sleep(20)

    // 与场景 a 完全相同的爆发输入：关闭追赶时必须一段都不跳。
    ctl.push('爆发一。\n\n爆发二。\n\n爆发三。\n\n爆发四。\n\n')
    await client.drain({ quietMs: 120, timeoutMs: 3000 })
    const streamErr = await closeSession(ctx, client)
    check('c1 流正常结束', streamErr === null, String(streamErr))

    const events = sentenceEvents(sse, from)
    const expected = expectedParagraphs('开头段。\n\n爆发一。\n\n爆发二。\n\n爆发三。\n\n爆发四。\n\n')
    const { problems, groups } = checkParagraphContract(events, expected, { allowSkip: false })
    check('c2 全部 5 段都读出、顺序正确、段落不交叉、每段从段首开始',
      problems.length === 0, JSON.stringify(problems.slice(0, 3)))
    check('c3 段落序列 = 0,1,2,3,4（没有跳段）', [...groups.keys()].join(',') === '0,1,2,3,4',
      [...groups.keys()].join(','))
    check('c4 sentence.index 连续', events.every((e, i) => e.index === i),
      JSON.stringify(events.map((e) => e.index)))

    const diag = await readDiagnostics(host)
    const state = (diag.readAloud ?? []).find((s) => s.sessionId === 'catchup-c')
    check('c5 诊断：trimmed=0（关闭追赶不跳段）', state?.trimmed === 0, JSON.stringify(state))
  } finally {
    sse.close()
  }
}

// ============================================================
// 场景 d/e（收尾契约）：关闭追赶时同步排空；开启追赶时先等 ack grace 再排空
// ============================================================
async function scenarioFlushContract() {
  // d) `readAloudLag: 0`（关闭追赶）+ 无 ack：调用结束必须**同步排空**，
  //    不能因为「等 ack grace」让老客户端白白多等 1.2s。
  scenario('d) 关闭追赶 + 无 ack：调用结束后同步排空（不额外等 grace）')
  {
    const ctx = openSession({
      sessionId: 'catchup-d',
      rowConfig: { readAloud: true, preloadModels: false, readAloudLag: 0 },
    })
    const { host, sse, from, ctl } = ctx
    try {
      const text = '第一段。\n\n第二段。\n\n第三段。\n\n'
      ctl.push(text)
      await waitFor(() => sentenceEvents(sse, from).length >= 1)
      ctl.close()
      const streamErr = await ctx.done
      // 关键：**不 sleep、不 ack**，紧接着断言 —— endCall 的同步 flush 必须已经发完。
      const immediate = sentenceEvents(sse, from)
      const expected = expectedParagraphs(text)
      check('d1 流正常结束', streamErr === null, String(streamErr))
      check('d2 调用结束的瞬间就排空（同步 flush，3 段 3 条都在）',
        immediate.length === expected.length && expected.length === 3,
        `immediate=${immediate.length} expected=${expected.length}`)
      const { problems } = checkParagraphContract(immediate, expected, { allowSkip: false })
      check('d3 同步排空的内容完整、顺序正确、每段从段首开始',
        problems.length === 0, JSON.stringify(problems.slice(0, 3)))
      const diag = await readDiagnostics(host)
      const state = (diag.readAloud ?? []).find((s) => s.sessionId === 'catchup-d')
      check('d4 无 ack 时仍是 pending 模式（老客户端旧语义）',
        state?.mode === 'pending' && state?.acks === 0, JSON.stringify(state))
    } finally {
      sse.close()
    }
  }

  // e) `readAloudLag > 0`（开启追赶）+ 无 ack：调用结束先等 ack grace
  //    （新客户端可能在这段时间里发首条 ack 切 flow 走追赶），老客户端 grace 到点后
  //    照旧一次发完 —— **不丢尾巴，只晚 ~1s**。这是「追赶能覆盖到 pending 收尾」的关键。
  scenario('e) 开启追赶 + 无 ack：先等 ack grace，之后再排空（不丢尾巴）')
  {
    const ctx = openSession({
      sessionId: 'catchup-e',
      rowConfig: { readAloud: true, preloadModels: false, readAloudLag: 2 },
    })
    const { sse, from, ctl } = ctx
    try {
      // 3 段 × 4 字（≈840ms/段）= 2520ms > 2000ms 预算 → 走 grace 路径
      const text = '甲段。\n\n乙段。\n\n丙段。\n\n'
      ctl.push(text)
      await waitFor(() => sentenceEvents(sse, from).length >= 1)
      ctl.close()
      const streamErr = await ctx.done
      const immediate = sentenceEvents(sse, from)
      check('e1 流正常结束', streamErr === null, String(streamErr))
      check('e2 调用结束时没有立刻倒空（grace 期间等 ack，避免打断流控/追赶）',
        immediate.length < 3, `immediate=${immediate.length}`)
      check('e3 grace 到点后全部发完（不丢尾巴，最多晚 ~1.5s）',
        await waitFor(() => sentenceEvents(sse, from).length >= 3, { timeoutMs: 3000 }),
        `events=${sentenceEvents(sse, from).length}`)
      const expected = expectedParagraphs(text)
      const { problems } = checkParagraphContract(sentenceEvents(sse, from), expected, { allowSkip: false })
      check('e4 grace 排空后内容完整、顺序正确、每段从段首开始',
        problems.length === 0, JSON.stringify(problems.slice(0, 3)))
    } finally {
      sse.close()
    }
  }

  // e2) pending 收尾必须「有时限」：老客户端（无 ack）一次灌入一大批文本时，
  //     调用结束的收尾不能退化成「按 400ms 窗口一条条慢慢拖」。
  //     （由已删除的 test/read-aloud-emit-rate.test.mjs 迁移 —— 那条独有断言：
  //      「一次性灌入时最后一条在 3s 内到齐，不会按窗口拖 ~8s」。）
  scenario('e2) 开启追赶 + 无 ack + 一次性大批灌入：收尾有时限（不按窗口拖）')
  {
    const ctx = openSession({
      sessionId: 'catchup-e2',
      rowConfig: { readAloud: true, preloadModels: false, readAloudLag: 2 },
    })
    const { sse, from, ctl } = ctx
    try {
      // 12 个短段（每段 1 句）：pendingMs ≈ 12×700ms = 8400ms > 2000ms 预算 → grace 路径。
      // 若退化成「按 400ms 窗口逐条补发」，收尾剩余 11 条要 4400ms > 3000ms 上限。
      const paras = []
      for (let i = 0; i < 12; i += 1) paras.push('段' + i + '。')
      const text = paras.map((p) => p + '\n\n').join('')
      ctl.push(text)
      await waitFor(() => sentenceEvents(sse, from).length >= 1, { timeoutMs: 1000 })
      ctl.close()
      const streamErr = await ctx.done
      const endAt = Date.now()
      const allInTime = await waitFor(
        () => sentenceEvents(sse, from).length >= 12,
        { timeoutMs: 3000 },
      )
      const elapsed = Date.now() - endAt
      check('e2a 流正常结束', streamErr === null, String(streamErr))
      check('e2b 收尾有时限：12 条在 3s 内到齐（按 400ms 窗口拖要 ~4.4s）',
        allInTime && elapsed <= 3000,
        `elapsed=${elapsed}ms events=${sentenceEvents(sse, from).length}`)
      const expected = expectedParagraphs(text)
      const { problems } = checkParagraphContract(sentenceEvents(sse, from), expected, { allowSkip: false })
      check('e2c 收尾内容完整、顺序正确、每段从段首开始',
        problems.length === 0, JSON.stringify(problems.slice(0, 3)))
    } finally {
      sse.close()
    }
  }
}

// ============================================================
// 场景 f：SSE 重连（页面刷新）—— 释放旧连接遗留的未确认配额
// ============================================================
async function scenarioReconnectReleasesQuota() {
  scenario('f) SSE 重连：释放旧连接的未确认配额，新连接补发不用等 10s watchdog')
  const host = makeHost({ readAloud: true, preloadModels: false, readAloudLag: 0 })
  const sse1 = connectSse(host)
  const from1 = sse1.events.length
  const { ctl, done } = startStream(host, {
    sessionId: 'catchup-f',
    messages: [{ role: 'user', id: 'u1' }],
  })
  let sse2 = null
  try {
    // 8 个短段：pending 发首句 → 首条 ack 切 flow 补到 LEAD(3) → 后面还有 4 段没发。
    const paras = ['甲段甲段。', '乙段乙段。', '丙段丙段。', '丁段丁段。',
      '戊段戊段。', '己段己段。', '庚段庚段。', '辛段辛段。']
    ctl.push(paras.map((p) => p + '\n\n').join(''))
    await waitFor(() => sentenceEvents(sse1, from1).length >= 1)
    const first = sentenceEvents(sse1, from1)[0]
    await postAck(host, { sessionId: 'catchup-f', turnId: first.turnId, count: 1 })
    await waitFor(() => sentenceEvents(sse1, from1).length >= 4, { timeoutMs: 1000 })
    const beforeReconnect = sentenceEvents(sse1, from1)
    const diag = await readDiagnostics(host)
    const state = (diag.readAloud ?? []).find((s) => s.sessionId === 'catchup-f')
    check('f1 重连前「已发未确认」已满 LEAD（复现旧 bug 的前提）',
      state?.outstanding === 3 && beforeReconnect.length === 4,
      JSON.stringify({ outstanding: state?.outstanding, emitted: beforeReconnect.length }))
    check('f2 重连前后面的段落还没发（4 段里只发了首段）',
      beforeReconnect.every((e) => e.para === 0) === false &&
        beforeReconnect.length === 4,
      JSON.stringify(beforeReconnect.map((e) => e.para)))

    // 新连接 = 页面刷新：旧 SSE 已经没了，它的未确认永远不会被 ack。
    // 新连接建立必须释放配额并继续补发（否则要等 ACK_STALL_MS=10s 的 watchdog）。
    sse2 = connectSse(host)
    const released = await waitFor(() => sentenceEvents(sse2, 0).length >= 3, { timeoutMs: 1500 })
    const newEvents = sentenceEvents(sse2, 0)
    check('f3 新连接后立刻补发 3 句（不用等 10s watchdog）',
      released && newEvents.length === 3,
      `released=${released} newEvents=${newEvents.length}`)
    check('f4 补发的是下一段开始的内容，且段首 paraStart=true',
      newEvents[0]?.para === 4 && newEvents[0]?.paraStart === true,
      JSON.stringify(newEvents.map((e) => [e.para, e.paraStart])))
    const allParas = [...beforeReconnect, ...newEvents].map((e) => e.para)
    check('f5 已发出的句子不重发（重连前后 para 不重复）',
      new Set(allParas).size === allParas.length && allParas.join(',') === '0,1,2,3,4,5,6',
      allParas.join(','))

    ctl.close()
    const streamErr = await done
    check('f6 流正常结束', streamErr === null, String(streamErr))
  } finally {
    if (sse2) sse2.close()
    sse1.close()
  }
}

// ============================================================
// 主流程
// ============================================================
await scenarioSlowStreamCatchup()
await scenarioNewestStillStreaming()
await scenarioCatchupOff()
await scenarioFlushContract()
await scenarioReconnectReleasesQuota()

console.log(`\n通过 ${passed}，失败 ${failures.length}`)
if (failures.length) {
  console.log('失败项：')
  for (const f of failures) {
    console.log('  - ' + f.name + (f.detail ? ' :: ' + String(f.detail).slice(0, 500) : ''))
  }
}
process.exitCode = failures.length ? 1 : 0
process.exit(failures.length ? 1 : 0)
