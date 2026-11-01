/**
 * `POST /dsh-voice-typing/reading-ack` 路由契约测试。
 *
 * 为什么单独一个文件：
 *   `/reading-ack` 是宿主 ↔ 客户端**跨组件契约**的落点 —— 客户端每开始播一句就
 *   回一条 ack，宿主据此补发下一句。它的边界（方法、body、count clamp、未知会话、
 *   轮次不匹配）一旦静默改坏，表现是「朗读又慢又滞后」且两端都不报错，
 *   所以必须把当前实现语义固定下来。
 *
 * 被测的是**真实 apply() 注册的路由**（不是手写 handler），并用真实
 * `llm/stream` 钩子建立调度器状态（这样 ack 才有 session/turn 可对齐）。
 *
 * 断言的语义（附「为什么」）：
 *   - 只接受 POST；其它方法 405 `{error:'method not allowed'}`；
 *   - body 必须是合法 JSON 对象：坏 JSON → 400；超过 8KB → 4xx（当前实现 400，
 *     readBody 抛错后统一 catch；允许 400/413 —— 语义上「拒绝超大 body」即可）；
 *   - `count` clamp：`Math.max(1, Math.min(64, Math.floor(Number(count) || 1)))`。
 *     即：0 / 负数 / 非数字（"abc" / 缺省）都按 **1** 计（宁可多归还 1 句，
 *     也不能因为异常值把配额卡住）；超过 64 按 64 计（一次最多归还 64 句）。
 *     观察点用 `/diagnostics.readAloud[].acks` —— 它是**clamp 之后**的累计值，
 *     能精确反推 clamp 结果，不受 pending/flow 补发影响。
 *   - 未知 session / turnId 不匹配 → 200 `{ok:false}`（不 500、不误伤其它会话）；
 *     并在 `/diagnostics.readAloudScheduler.rejectedAcks` / `lastRejectedAck` 留痕。
 *   - 缺 turnId → 当前实现**不校验轮次**（`if (turnId && state.turnId && ...)`），
 *     因为客户端在轮次未知时会发空 turnId 兜底；断言为 ok:true 并在此说明。
 *
 * 运行：node test/reading-ack-contract.test.mjs（退出码 0 = 全通过）
 */
import os from 'node:os'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'

const tmpHome = path.join(os.tmpdir(), `dsh-vt-ack-contract-${process.pid}`)
await mkdir(tmpHome, { recursive: true })
process.env.DSH_HOME = tmpHome

const { apply } = await import('../lib/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('  ok   ' + name) }
  else {
    failures.push({ name, detail })
    console.log('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 600) : ''))
  }
}

// ============================================================
// 假宿主（只需要路由 + llm/stream 钩子；本测试不需要 SSE）
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

function fakeRes() {
  const res = {
    status: 0, raw: '',
    writableEnded: false, destroyed: false, headersSent: false,
    writeHead(status) { res.status = status },
    end(body) { res.raw += body == null ? '' : String(body); res.writableEnded = true },
  }
  return res
}

/** 调一条真实路由。body 为字符串时原样发送（用于坏 JSON / 超大 body 场景）。 */
async function callRoute(host, routePath, { method = 'GET', body } = {}) {
  const def = host.routes.get(routePath)
  if (!def) return { status: 0, body: null, raw: '' }
  const req = {
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined && body !== '') yield Buffer.from(body)
    },
  }
  const res = fakeRes()
  try { await def.handler(req, res) } catch (e) { return { status: -1, body: { error: String(e) }, raw: '' } }
  let parsed = null
  try { parsed = JSON.parse(res.raw || 'null') } catch { parsed = null }
  return { status: res.status, body: parsed, raw: res.raw }
}

function postAck(host, payload) {
  return callRoute(host, '/dsh-voice-typing/reading-ack', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

function postAckRaw(host, rawBody) {
  return callRoute(host, '/dsh-voice-typing/reading-ack', { method: 'POST', body: rawBody })
}

async function readDiagnostics(host) {
  const r = await callRoute(host, '/dsh-voice-typing/diagnostics', { method: 'GET' })
  return r.body ?? {}
}

/** 跑一次真实 llm/stream 钩子（一串 chunk 全部给出）。 */
async function runStream(host, options, chunks) {
  const stream = host.handlers.get('llm/stream')(options, () => (async function* () {
    for (const text of chunks) yield { type: 'text-delta', text }
  })())
  for await (const _chunk of stream) { /* 消费，触发 finally */ }
}

const ACK_PATH = '/dsh-voice-typing/reading-ack'
const SID = 'ack-contract'
const TURN_INPUT_SENTENCE = '第一句话内容够长一点。' // 11 字 → 估算 2310ms，远小于默认预算（15s）

// ============================================================
// 准备：建立调度器状态（真实钩子）
// ============================================================
console.log('准备：用真实 llm/stream 钩子建立会话/轮次记账')
const host = makeHost({ readAloud: true, preloadModels: false, readAloudLag: 15 })
await runStream(host, { sessionId: SID, messages: [{ role: 'user', id: 'u1' }] }, [TURN_INPUT_SENTENCE])
await sleep(20) // 让 finally 里的收尾跑完（单句、未超预算 → 同步排空，无 grace 定时器）

let diag = await readDiagnostics(host)
let state = (diag.readAloud ?? []).find((s) => s.sessionId === SID)
const turnId = state?.turnId
check('前置：调度器里有该会话的状态（mode/outstanding/turnId 可读）',
  !!state && typeof turnId === 'string' && turnId.length > 0 && state.outstanding >= 1,
  JSON.stringify(state))
check('前置：首条 ack 之前处于 pending 模式、acks=0',
  state?.mode === 'pending' && state?.acks === 0, JSON.stringify(state))

/** 当前调度器级诊断（ack 被拒计数）。 */
async function schedulerDiag() {
  const d = await readDiagnostics(host)
  return d.readAloudScheduler ?? {}
}
async function sessionState() {
  const d = await readDiagnostics(host)
  return (d.readAloud ?? []).find((s) => s.sessionId === SID) ?? null
}

// ============================================================
// 1) 方法限制
// ============================================================
console.log('\n1) 方法限制：只接受 POST')
for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
  const r = await callRoute(host, ACK_PATH, { method })
  check(`${method} → 405 + {error:'method not allowed'}`,
    r.status === 405 && r.body?.error === 'method not allowed', JSON.stringify(r))
}
{
  // 不带 method 的请求视为非法（不是 POST）→ 405，绝不能当成 ack 处理。
  const r = await callRoute(host, ACK_PATH, { method: undefined })
  check('缺 method → 405（不会把读请求当成 ack）', r.status === 405, JSON.stringify(r))
}

// ============================================================
// 2) body 校验
// ============================================================
console.log('\n2) body 校验：坏 JSON → 400；超大 body → 4xx；非对象 → ok:false')
{
  const r = await postAckRaw(host, '{not json')
  check('坏 JSON → 400 且带 error 文本', r.status === 400 && typeof r.body?.error === 'string',
    JSON.stringify(r))
}
{
  // 路由用 readBody(req, 8*1024)：超过 8KB 会被拒绝。
  // 当前实现把 readBody 的 413 统一映射成 400；这里允许 400/413（契约是「拒绝」）。
  const big = JSON.stringify({ sessionId: SID, turnId, count: 1, pad: 'x'.repeat(9000) })
  const r = await postAckRaw(host, big)
  check('超过 8KB 的 body 被拒绝（400 或 413），不会当成有效 ack',
    (r.status === 400 || r.status === 413) && typeof r.body?.error === 'string',
    JSON.stringify({ status: r.status, body: r.body }))
}
{
  const r = await postAckRaw(host, '{}')
  check('body={} → 200 {ok:false}（无 sessionId 不误伤其它会话）',
    r.status === 200 && r.body?.ok === false, JSON.stringify(r))
}
{
  const r = await postAckRaw(host, 'null')
  check('body=null → 200 {ok:false}（不崩溃）', r.status === 200 && r.body?.ok === false,
    JSON.stringify(r))
}

// ============================================================
// 3) count clamp（用 /diagnostics 的 acks 反推 clamp 结果）
// ============================================================
console.log('\n3) count clamp：0/负数/非数字 → 1；>64 → 64（观察 acks 累计值）')
{
  let expectedAcks = (await sessionState())?.acks ?? 0

  /** 发一条 ack，断言 ok 且 acks 增量 == 期望的 clamp 值。 */
  const expectAck = async (label, payload, expectedDelta) => {
    const before = (await sessionState())?.acks ?? 0
    const r = await postAck(host, { sessionId: SID, turnId, ...payload })
    const after = (await sessionState())?.acks ?? 0
    expectedAcks = before + expectedDelta
    check(`${label}：ok + acks +${expectedDelta}`,
      r.status === 200 && r.body?.ok === true && after === expectedAcks,
      JSON.stringify({ status: r.status, body: r.body, before, after, expected: expectedAcks }))
  }

  await expectAck('count=1（正常）', { count: 1 }, 1)
  await expectAck('count=0 → 按 1 计（宁可多归还，不能卡住配额）', { count: 0 }, 1)
  await expectAck('count=-5 → 按 1 计（clamp 下限）', { count: -5 }, 1)
  await expectAck('count="abc" → 按 1 计（NaN 兜底）', { count: 'abc' }, 1)
  await expectAck('count=1.7 → 向下取整 1', { count: 1.7 }, 1)
  await expectAck('count=1e9 → clamp 到 64（单次上限）', { count: 1e9 }, 64)
  await expectAck('count=65 → clamp 到 64', { count: 65 }, 64)
  await expectAck('count="3"（数字字符串）→ 3', { count: '3' }, 3)
  await expectAck('count 缺省 → 1', {}, 1)

  const s = await sessionState()
  check('多批 ack 之后未确认句数不会变成负数', (s?.outstanding ?? -1) >= 0, JSON.stringify(s))
  check('收到 ack 后已切到 flow 模式', s?.mode === 'flow', JSON.stringify(s))
}

// ============================================================
// 4) 会话 / 轮次校验（拒绝时留痕）
// ============================================================
console.log('\n4) 未知 session / turnId 不匹配 → ok:false，且诊断留痕')
{
  const before = await schedulerDiag()
  const beforeRejected = before.rejectedAcks ?? 0
  const acksBefore = (await sessionState())?.acks ?? 0

  const rUnknown = await postAck(host, { sessionId: 'no-such-session', turnId, count: 1 })
  check('未知 session → 200 {ok:false}', rUnknown.status === 200 && rUnknown.body?.ok === false,
    JSON.stringify(rUnknown))

  const rTurn = await postAck(host, { sessionId: SID, turnId: 'turn-definitely-not-exist', count: 1 })
  check('turnId 不匹配 → 200 {ok:false}', rTurn.status === 200 && rTurn.body?.ok === false,
    JSON.stringify(rTurn))

  const after = await schedulerDiag()
  const afterRejected = after.rejectedAcks ?? 0
  check('被拒绝的 ack 有计数（rejectedAcks +2，不再静默）',
    afterRejected === beforeRejected + 2,
    JSON.stringify({ before: beforeRejected, after: afterRejected }))
  check('lastRejectedAck 记录最近一次原因（turn-mismatch）与 sessionId',
    after.lastRejectedAck?.reason === 'turn-mismatch' &&
      after.lastRejectedAck?.sessionId === SID,
    JSON.stringify(after.lastRejectedAck))
  check('被拒绝的 ack 不影响该会话的 acks 计数',
    (await sessionState())?.acks === acksBefore,
    JSON.stringify({ before: acksBefore, after: (await sessionState())?.acks }))
}

// ============================================================
// 5) 缺 turnId：当前实现不校验轮次（客户端降级路径依赖）
// ============================================================
console.log('\n5) 缺 turnId：当前实现不校验轮次（客户端拿不到轮次时会发空 turnId）')
{
  // 实现：`if (turnId && state.turnId && turnId !== state.turnId) return false`
  // —— turnId 为空/缺失时跳过轮次校验，只按 session 记账。
  // 这是客户端降级路径的前提：拿不到轮次 id 时仍要能归还配额。
  const before = (await sessionState())?.acks ?? 0
  const r = await postAck(host, { sessionId: SID, count: 1 })
  const after = (await sessionState())?.acks ?? 0
  check('缺 turnId 的 ack 被接受（ok:true、acks +1）',
    r.status === 200 && r.body?.ok === true && after === before + 1,
    JSON.stringify({ status: r.status, body: r.body, before, after }))
}

// ============================================================
// 摘要
// ============================================================
console.log(`\n通过 ${passed}，失败 ${failures.length}`)
if (failures.length) {
  console.log('失败项：')
  for (const f of failures) {
    console.log('  - ' + f.name + (f.detail ? ' :: ' + String(f.detail).slice(0, 500) : ''))
  }
}
process.exitCode = failures.length ? 1 : 0
process.exit(failures.length ? 1 : 0)
