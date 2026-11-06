/**
 * 回合（turn）判定单元测试 —— 真跑 `createTurnModel`，不再扫源码文本。
 *
 * 批次 4（2026-11-03）之前：这份文件是对 turn-model.js 做 22 条正则形状断言
 * （「有没有 TURN_WINDOW_MS 常量」「lastTurnAt 是不是 Map」「那句窗口内 return false 还在不在」）。
 * 那些只能证明**这句话还写着**：把 `requestUserCount > prev` 改成 `!== prev`（上下文被压缩时
 * 误判成新轮，症状正是用户报的「正在念的回复被拦腰截断」），只要常量名和注释都还在，形状断言照样绿。
 * 现在把工厂直接 import 进来，喂假 sessions 服务 + 注入时钟，判**行为**。
 *
 * 时钟缝（本批唯一的宿主生产改动）：`createTurnModel({ getSessionsService, clock })`，
 * `clock` 默认 `() => Date.now()`，宿主不传 → 行为与注入前逐字一致。开它只为「5 秒回合窗口」
 * 和「10 分钟空闲清理」能在测试里步进时间 —— 不注入的话要么真等 5 秒/10 分钟，要么只能扫文本。
 *
 * 删掉的形状判据与它们的更强对应物（不留悬空）：
 *   - 客户端监听 turn-begin / turn-end、不再监听旧的 turn-start、收到回合开始 haltSpeaking(true)、
 *     按 turnId 静音、静音不用布尔标记
 *     → `test/client-behavior.test.mjs`：场景 18「停止朗读」把四种「解除静音的尝试」（同轮
 *       turn-begin / 没带 turnId 的句子 / call-end / turn-end 后的迟到句）逐条跑过，
 *       「换轮」场景跑过「旧轮清队列也 ack、不会倒回去念旧轮」。
 *   - 句子事件不要求语音模式开启 → 同上：那些播放场景从头到尾没点过麦克风
 *       （`onRef.current` 一直是 false），声音照样播出来。
 *   - 宿主分配 turnId、`turn-begin`/`turn-end` 帧带 turnId、句子带 turnId+index
 *     → `test/read-aloud-stop.test.mjs` 用真钩子 + 真 SSE 数**发出来的帧**：
 *       「同一轮的两句共用同一个 turnId」「turn-begin 与句子的 turnId 一致」「两轮的 turnId 不同」
 *       「turn-end 带的是刚结束的上一轮 turnId」。帧比正则强。
 *   - 「回合判定住在独立模块」 → 本文件 import 的就是那个模块：内联回 index.js 直接 ENOENT。
 *   - 「宿主不再自己抄一份判定」 → 批次 6i-c 起由下面的「宿主接线（真跑）」判：
 *       驱动**真宿主**的 llm/stream 钩子，看发出来的 turn-begin 帧数与 turnId。
 *       抄一份最常见的走偏（把「只认条数增加」写成「条数变了就算」）会多广播一次
 *       turn-begin，客户端据此清队列、撤销用户刚点的「停止朗读」—— 这条判据抓得到。
 *
 * 原来末尾留着 3 条静态接线判据，批次 6i-c 全部换成真跑，本节现在一条源码正则都不留
 * （三条各自换成哪一段真跑、以及「换掉之后旧写法守不住什么」写在下面那段注释里，实录见 docs §8.42）。
 *
 * 计数走两条通道：`add()` = 场景判据（createTurnModel 真跑 + 宿主接线真跑出来的每一条），
 * `check()` = 收尾的结论性判据（本批之后已经没有结论性判据了）。
 *
 * 用法：node test/turn-boundary.test.mjs
 */
import os from 'node:os'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const TURN_MODEL = path.join(here, '..', 'src', 'host', 'turn-model.js')
const { createTurnModel } = await import(pathToFileURL(TURN_MODEL).href)

const scenarioRows = []
const verdictRows = []
function print(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '：' + detail : ''}`)
}
/** 场景判据：createTurnModel 真跑出来的每一条。 */
function add(name, ok, detail = '') {
  scenarioRows.push({ name, ok, detail })
  print(name, ok, detail)
}
/** 结论性判据（末尾保留的静态接线判据）。 */
function check(name, ok, detail = '') {
  verdictRows.push({ name, ok, detail })
  print(name, ok, detail)
}

const u = (id) => ({ role: 'user', id })
const a = (id) => ({ role: 'assistant', id })
const tool = (id) => ({ role: 'tool', id })

/**
 * 造一个可控的回合模型实例。
 *
 * - `getSessionsService` 给一个查表服务，`flags` 用来演「旧 shape / 当场抛错」这些边角；
 * - `clock` 是注入的假时钟（`advance` 步进），窗口与 TTL 类判据靠它，不用真等；
 *   起点取 `Date.now()` 与真实时间对齐 —— 这样「绕过缝直接用 Date.now()」的写法退化
 *   会在「窗口外该算新回合」那一条露馅（步进的时间真实世界里并没有过去）。
 * - 每个场景**各起一个实例**：回合模型是有状态的，共用实例会让上一条判据红掉的原因
 *   落到下一条上（批次 1 踩过：分不清是缺陷还是状态串了）。
 */
function makeHarness(Factory, { exposeSessions = true } = {}) {
  const messages = new Map()
  const flags = { throwOnGet: false, noDerive: false, throwOnDerive: false }
  const service = {
    get(sessionId) {
      if (flags.throwOnGet) throw new Error('fake: sessions.get 当场抛错')
      if (!messages.has(sessionId)) return undefined
      const list = messages.get(sessionId)
      if (flags.noDerive) return { list }
      return {
        deriveMessages() {
          if (flags.throwOnDerive) throw new Error('fake: deriveMessages 当场抛错')
          return list
        },
      }
    },
  }
  let t = Date.now()
  const clock = { now: () => t, advance(ms) { t += ms } }
  const model = Factory({
    getSessionsService: () => (exposeSessions ? service : null),
    clock: clock.now,
  })
  return { model, clock, flags, setMessages: (id, list) => messages.set(id, list) }
}

/**
 * 判据本体 —— 只吃工厂，不写死「真模块」。
 * @returns {Array<{name: string, ok: boolean, detail: string}>}
 */
function battery(Factory) {
  const rows = []
  const row = (name, ok, detail = '') => rows.push({ name, ok, detail })

  // ── S1 从请求里数用户消息条数 ──
  {
    const { model } = makeHarness(Factory)
    row('S1 混合角色数得出 user 条数',
      model.countRequestUserMessages({ messages: [u('m1'), a('r1'), u('m2'), tool('t1'), u('m3')] }) === 3)
    row('S1 拿不到 messages 是 -1（「拿不到」不能当成 0 条）',
      model.countRequestUserMessages({}) === -1 && model.countRequestUserMessages(null) === -1)
    row('S1 messages 不是数组也是 -1', model.countRequestUserMessages({ messages: 'x' }) === -1)
    row('S1 空数组是 0 条（不是 -1）', model.countRequestUserMessages({ messages: [] }) === 0)
    row('S1 只认 role === user（工具调用链不会让条数变化）',
      model.countRequestUserMessages({ messages: [a('r1'), tool('t1')] }) === 0)
  }

  // ── S2 请求条数是首选判据：只认「增加」 ──
  {
    const { model } = makeHarness(Factory)
    row('S2 首次见到会话就按新回合（客户端刚连上，广播不会误伤）', model.isNewUserTurn('s', 1) === true)
    row('S2 条数增加才是新一轮', model.isNewUserTurn('s', 2) === true)
    row('S2 同一条数（一轮里多次 llm/stream）不算新回合',
      model.isNewUserTurn('s', 2) === false && model.isNewUserTurn('s', 2) === false)
    row('S2 条数减少（上下文被压缩/裁剪）不算新回合', model.isNewUserTurn('s', 1) === false,
      '写成 !== 的话这里 true → 误清客户端队列、拦腰截断正在朗读的回复')
    row('S2 减少之后基线跟着下移（再增加仍认得出新一轮）', model.isNewUserTurn('s', 3) === true)
    row('S2 没有 sessionId 时不判新回合', model.isNewUserTurn('', 5) === false)
  }

  // ── S3 0 条也是一次真实计数（不能退回兜底通路） ──
  {
    const { model } = makeHarness(Factory)
    row('S3 请求里 0 条也走请求通路（首见 → 新回合）', model.isNewUserTurn('s0', 0) === true)
    row('S3 0 条的基线记下来了（第二次不再算新回合）', model.isNewUserTurn('s0', 0) === false)
  }

  // ── S4 两种计数分开存：兜底不能冲掉请求基线 ──
  {
    const h = makeHarness(Factory)
    const first = h.model.isNewUserTurn('mix', 3)
    h.setMessages('mix', [u('x1'), u('x2')])
    const fallbackFirst = h.model.isNewUserTurn('mix', -1)
    const backToRequest = h.model.isNewUserTurn('mix', 3)
    row('S4 兜底那次不能把「请求条数」的基线冲掉',
      first === true && fallbackFirst === true && backToRequest === false,
      `请求首见=${first} 兜底首见=${fallbackFirst} 再回请求=${backToRequest}（两张表合成一张时最后一步是 true → 同一次提问被当成两轮）`)
    row('S4 兜底通路自己的基线也记着（同条数不再算新回合）',
      h.model.isNewUserTurn('mix', -1) === false)
  }

  // ── S5 兜底通路：条数 + 5 秒窗口（注入时钟步进） ──
  {
    const h = makeHarness(Factory)
    h.setMessages('w', [u('m1')])
    row('S5 兜底：首次见会话按新回合', h.model.isNewUserTurn('w', -1) === true)
    row('S5 兜底：条数没变不算新回合', h.model.isNewUserTurn('w', -1) === false)
    h.clock.advance(2000)
    h.setMessages('w', [u('m1'), u('m2')])
    row('S5 兜底：窗口内的条数变化 = 本轮消息延迟写入，不算新回合',
      h.model.isNewUserTurn('w', -1) === false,
      '无脑当新回合的话，本轮自己正在合成的句子会被客户端整段丢掉（2026-10-31 报障的症状）')
    h.clock.advance(6000)
    row('S5 兜底：出了窗口但条数没再变，也不补广播', h.model.isNewUserTurn('w', -1) === false)
    h.setMessages('w', [u('m1'), u('m2'), u('m3')])
    row('S5 兜底：窗口外的条数变化算新回合', h.model.isNewUserTurn('w', -1) === true)
  }

  // ── S6 兜底通路拿不到东西时：判 false，不能抛 ──
  {
    const noService = makeHarness(Factory, { exposeSessions: false })
    noService.setMessages('x', [u('m1')])
    row('S6 宿主 inject 之前拿不到 sessions 服务：不判新回合、不抛错',
      noService.model.isNewUserTurn('x', -1) === false)
    const h = makeHarness(Factory)
    row('S6 会话不在目录里：不判新回合', h.model.isNewUserTurn('ghost', -1) === false)
    h.setMessages('noDerive', [u('m1')])
    h.flags.noDerive = true
    row('S6 会话没有 deriveMessages（旧 shape）：不判新回合',
      h.model.isNewUserTurn('noDerive', -1) === false)
    h.setMessages('boom', [u('m1')])
    h.flags.throwOnDerive = true
    row('S6 deriveMessages 抛错：吞掉判 false，不把整个流带崩',
      h.model.isNewUserTurn('boom', -1) === false)
    const g = makeHarness(Factory)
    g.setMessages('t', [u('m1')])
    g.flags.throwOnGet = true
    row('S6 sessions.get 抛错同样吞掉', g.model.isNewUserTurn('t', -1) === false)
  }

  // ── S7 detectTurn：turnId 与「刚结束的上一轮」 ──
  {
    const h = makeHarness(Factory)
    h.setMessages('t', [u('m1')])
    const t1 = h.model.detectTurn('t', 1)
    row('S7 首轮：isNew、有 turnId、没有上一轮',
      t1.isNew === true && /^turn-/.test(t1.turnId) && t1.prevTurnId === '', JSON.stringify(t1))
    const t2 = h.model.detectTurn('t', 1)
    row('S7 同轮第二次：不判新回合、turnId 不变、不报上一轮',
      t2.isNew === false && t2.turnId === t1.turnId && t2.prevTurnId === '')
    h.setMessages('t', [u('m1'), u('m2')])
    const t3 = h.model.detectTurn('t', 2)
    row('S7 第二轮：turnId 与首轮不同', t3.isNew === true && t3.turnId !== t1.turnId,
      `${t1.turnId} → ${t3.turnId}`)
    row('S7 第二轮把「刚结束的上一轮」id 交出来（宿主靠它广播真正的 turn-end）',
      t3.prevTurnId === t1.turnId, `prevTurnId=${t3.prevTurnId}，应为 ${t1.turnId}`)
  }
  {
    // 本轮消息还没写进 session —— 当初把 turnId 从「内容锚点」换成递增序号的原因。
    const h = makeHarness(Factory)
    h.setMessages('late', [u('m1')])
    const a1 = h.model.detectTurn('late', 1)
    const a2 = h.model.detectTurn('late', 2)
    row('S7 锚点没变（本轮消息还没落 session）时 turnId 仍然每轮不同',
      a2.isNew === true && a1.turnId !== a2.turnId,
      `两轮都拿到 ${a2.turnId} → 客户端按 turnId 静音/去重会把新一轮当成旧轮`)
  }
  {
    const h = makeHarness(Factory)
    h.setMessages('A', [u('a1')])
    h.setMessages('B', [u('b1')])
    const ta = h.model.detectTurn('A', 1)
    const tb = h.model.detectTurn('B', 1)
    row('S7 两个会话各判各的（互不污染基线）',
      ta.isNew === true && tb.isNew === true && ta.turnId !== tb.turnId)
    row('S7 B 的第二次调用不影响 A 的轮次',
      h.model.detectTurn('B', 1).isNew === false && h.model.detectTurn('A', 1).isNew === false)
  }
  {
    const h = makeHarness(Factory)
    row('S7 没有 sessionId 也给出可用的占位 turnId', /^turn-/.test(h.model.detectTurn('', 1).turnId))
  }

  // ── S8 本轮句子序号 ──
  {
    const h = makeHarness(Factory)
    h.setMessages('n', [u('m1')])
    h.model.detectTurn('n', 1)
    const seq = [h.model.nextSentenceIndex('n'), h.model.nextSentenceIndex('n'), h.model.nextSentenceIndex('n')]
    row('S8 每轮的句子序号从 0 递增', seq.join(',') === '0,1,2', seq.join(','))
    h.model.detectTurn('n', 2)
    row('S8 换轮后序号归零（客户端按 turnId:index 去重）', h.model.nextSentenceIndex('n') === 0)
    row('S8 没 detectTurn 过的会话也从 0 起', h.model.nextSentenceIndex('fresh') === 0)
  }

  // ── S9 内容锚点的取值顺序 ──
  {
    const h = makeHarness(Factory)
    h.setMessages('k', [u('m1'), a('r1'), { role: 'user', seq: 7 }])
    row('S9 锚点取最后一条 user 消息的 id/seq', h.model.resolveTurnAnchor('k') === '7', h.model.resolveTurnAnchor('k'))
    h.setMessages('k2', [{ role: 'user', eventSeq: 9 }])
    row('S9 没有 id 时退到 seq，再退到 eventSeq', h.model.resolveTurnAnchor('k2') === '9')
    h.setMessages('k3', [{ role: 'user' }])
    row('S9 连标识都没有时用下标（至少稳定）', h.model.resolveTurnAnchor('k3') === '0')
    h.setMessages('k4', [a('r1')])
    row('S9 没有 user 消息时是空串', h.model.resolveTurnAnchor('k4') === '')
    row('S9 拿不到服务时是空串',
      makeHarness(Factory, { exposeSessions: false }).model.resolveTurnAnchor('k') === '')
  }

  // ── S10 空闲清理（TTL 用注入时钟步进） ──
  {
    const h = makeHarness(Factory)
    h.setMessages('p', [u('m1')])
    const first = h.model.detectTurn('p', 1)
    h.clock.advance(9 * 60_000)
    h.model.prune(h.clock.now())
    const kept = h.model.detectTurn('p', 1)
    row('S10 TTL 之内不动还在用的会话（turnId 不变、同轮仍不算新回合）',
      kept.turnId === first.turnId && kept.isNew === false, JSON.stringify(kept))
    // 上面那次 detectTurn 会刷新活动时间，所以这里要从它那一刻再空 12 分钟。
    h.clock.advance(12 * 60_000)
    h.model.prune(h.clock.now())
    const after = h.model.detectTurn('p', 1)
    row('S10 TTL 之外丢弃空闲会话（重新按首见处理）',
      after.isNew === true && after.turnId !== first.turnId, JSON.stringify(after))
  }
  {
    const h = makeHarness(Factory)
    h.setMessages('idle', [u('m1')])
    h.setMessages('live', [u('m2')])
    h.model.detectTurn('idle', 1)
    h.clock.advance(9 * 60_000)
    const live = h.model.detectTurn('live', 1)
    h.clock.advance(2 * 60_000)
    h.model.prune(h.clock.now())
    row('S10 空闲扫描不误伤刚活动过的会话', h.model.detectTurn('live', 1).turnId === live.turnId)
    row('S10 超时那条会话确实被丢了', h.model.detectTurn('idle', 1).isNew === true)
  }
  {
    const h = makeHarness(Factory)
    h.setMessages('long', [u('m1')])
    const start = h.model.detectTurn('long', 1)
    let dropped = false
    for (let i = 0; i < 4; i++) {
      h.clock.advance(9 * 60_000)
      h.model.prune(h.clock.now())
      if (h.model.detectTurn('long', 1).turnId !== start.turnId) { dropped = true; break }
    }
    row('S10 会话只要还在被调用就不会被 TTL 清掉（每次判定都刷新活动时间）', dropped === false)
  }

  // ── S11 默认时钟（宿主走的就是这条路径） ──
  {
    const messages = new Map([['real', [u('m1')]]])
    const model = Factory({
      getSessionsService: () => ({
        get: (id) => (messages.has(id) ? { deriveMessages: () => messages.get(id) } : undefined),
      }),
    })
    row('S11 不传 clock 时仍能用：请求通路首见 true / 同条数 false',
      model.isNewUserTurn('real', 1) === true && model.isNewUserTurn('real', 1) === false)
    const before = model.detectTurn('real', 1).turnId
    model.prune()
    row('S11 默认时钟下 prune 不会把刚用过的会话清掉', model.detectTurn('real', 1).turnId === before)
    row('S11 默认时钟下兜底通路也走得通（首见 true / 同条数 false）',
      model.isNewUserTurn('real', -1) === true && model.isNewUserTurn('real', -1) === false)
  }

  // ── S12 reset()：场景之间靠它隔离，本身也得是对话 ──
  {
    const h = makeHarness(Factory)
    h.setMessages('z', [u('m1')])
    const before = h.model.detectTurn('z', 1)
    h.model.reset()
    const after = h.model.detectTurn('z', 1)
    row('S12 reset() 把状态清干净（同一会话重新按首见处理、不再报上一轮、序号从头）',
      after.isNew === true && after.prevTurnId === '' && h.model.nextSentenceIndex('z') === 0,
      JSON.stringify({ before, after }))
    row('S12 reset() 连递增计数器一起归零（turnId 从 turn-1 起）', after.turnId === 'turn-1', after.turnId)
  }

  return rows
}

/* ================================================================== */
/* 1) 场景判据：跑真模块                                                 */
/* ================================================================== */
console.log('回合判定（createTurnModel 真跑）')
for (const r of battery(createTurnModel)) add(r.name, r.ok, r.detail)

/* ================================================================== */
/* 2) 宿主接线（真跑：把真宿主装进接缝，驱动真钩子、真扫一次空闲）      */
/* ================================================================== */
// 这一节原来 3 条，全是源码正则。批次 6i-c 换成三段真跑，逐条对应：
//   旧「宿主确实 import 并实例化 turn-model」
//     → S13：驱动**真宿主**的 llm/stream 钩子，看它广播的 turn-begin 帧。
//       旧写法只证明 index.js 里写着那两行字；宿主要是把判定抄一份进去
//       （把「只认条数增加」写成「条数变了就算」），那两行可以原样留着、字面正则照样绿，
//       而本文件上面那一段「createTurnModel 真跑」的判据全绿在一份没人调用的死模块上。
//       现在钉的是**行为**：上下文被压缩（用户消息条数变小）不算新一轮 —— 少广播一次 turn-begin。
//   旧「宿主不注入时钟（生产走默认的 Date.now）」
//     → S14：同一轮里扫一次空闲，回合状态不能被清掉。
//       工厂存活动时间用注入的 clock，宿主 prune 传的是 Date.now()，
//       宿主一旦给它注入一个固定/偏移时钟，这两个时间就不同源：
//       扫一次就把还在用的会话当「10 分钟没动」清掉 → 同一轮的下一次调用被当成新一轮。
//       旧写法盯的是「参数表里没出现 clock 这个词」，改成 `clock: Date.now` 这种合法写法它就绿。
//   旧「宿主空闲扫描里调用 turnModel.prune」
//     → S15：把时间挪过 TTL 再扫一次，同一会话必须重新算一轮。
//       旧写法的理由（「TTL 是 10 分钟，套件里跑不出来」）站不住：
//       不用改常量、不用真等 —— 空闲扫描是 setInterval 的回调，接管 setInterval 就能
//       自己决定「什么时候扫一次」，再把 Date.now 往后挪过 TTL 就是它本来的触发条件。
//       那行 prune 被删掉时，回合状态永远不清，长跑内存涨的账照旧，但这一节会红。
// 三条都用同一个宿主实例、同一个 SSE 连接，靠 sessionId 分开，互不串味。
console.log('\n宿主接线（真跑：loadHostRoutes + 真 llm/stream 钩子 + 真空闲扫描）')
{
  const home = path.join(os.tmpdir(), 'dsh-voice-typing-turn-wiring')
  await mkdir(home, { recursive: true })
  const { loadHostRoutes } = await import('./helpers/host-routes.mjs')

  // 宿主的空闲扫描写的是 setInterval(…, 60_000)：套件里等不到它自己响。
  // 不改它的源码，也不把常量调小 —— 在装宿主这段时间接管 setInterval，
  // 把登记过的回调收下来，由测试自己决定「现在扫一次」。
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const sweepers = new Map()
  globalThis.setInterval = (fn, ms, ...rest) => {
    const id = realSetInterval(fn, ms, ...rest)
    if (typeof fn === 'function') sweepers.set(id, fn)
    return id
  }
  globalThis.clearInterval = (id) => {
    sweepers.delete(id)
    return realClearInterval(id)
  }
  const env = await loadHostRoutes({
    dshHome: home,
    rowConfig: { readAloud: true, preloadModels: false },
  })
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval

  /** 跑一遍真钩子（真广播、真 generator 消费）。`n` = 请求里的用户消息条数。 */
  const runStream = async (sessionId, n) => {
    const messages = []
    for (let i = 0; i < n; i++) messages.push({ role: 'user', id: `u${i + 1}` })
    const handler = env.hooks.get('llm/stream')
    const stream = handler({ sessionId, messages }, () => (async function* () {
      yield { type: 'text-delta', text: '这一轮的一句话。' }
    })())
    for await (const _chunk of stream) { /* 消费到底，触发 finally 里的 busy 复位 */ }
  }
  /** 把收下来的定时器回调全跑一遍（= 宿主自己转了一圈空闲扫描）。 */
  const sweep = () => {
    for (const fn of [...sweepers.values()]) {
      try { fn() } catch { /* 空闲扫描里每一项本来就各自 try/catch */ }
    }
  }
  const begins = (stream, sessionId) =>
    stream.events().filter((e) => e.event === 'turn-begin' && e.data.sessionId === sessionId)

  const sse = env.openStream()
  try {
    check('接缝里装上了真宿主的 llm/stream 钩子', typeof env.hooks.get('llm/stream') === 'function')
    check('空闲扫描的定时器确实被接管到了（收下的回调数 > 0）',
      sweepers.size > 0, `收到 ${sweepers.size} 个 interval`)

    // ── S13 宿主的轮次判定走的是 turn-model 那份（不是自己抄的） ──
    const s13 = 'wire-compress'
    await runStream(s13, 2)
    await runStream(s13, 1)
    const b13 = begins(sse, s13)
    add('S13 宿主跑真钩子：首次请求广播一次 turn-begin', b13.length >= 1, `广播 ${b13.length} 次`)
    add('S13 上下文被压缩（用户消息条数变小）不算新一轮 —— 抄一份的写法（条数变了就算）会在这里多广播一次',
      b13.length === 1, `广播 ${b13.length} 次：${b13.map((e) => e.data.turnId).join(' → ')}`)

    // ── S14 同一轮里扫一次空闲：还在用的会话不能被 TTL 误清 ──
    const s14 = 'wire-live'
    await runStream(s14, 1)
    const beforeSweep = begins(sse, s14).length
    sweep()
    await runStream(s14, 1)
    const b14 = begins(sse, s14)
    add('S14 扫一次空闲之后，同一轮的下一次调用仍算同一轮（宿主给工厂的是真实时间）',
      beforeSweep === 1 && b14.length === 1,
      `扫前 ${beforeSweep} 次 / 扫后 ${b14.length} 次：${b14.map((e) => e.data.turnId).join(' → ')}`)

    // ── S15 时间挪过 TTL 再扫一次：回合状态必须真的被清掉 ──
    const s15 = 'wire-ttl'
    await runStream(s15, 1)
    const first = begins(sse, s15)[0]?.data.turnId ?? ''
    const realNow = Date.now
    // 工厂里的 TTL 是 10 分钟（模块内常量，没导出）。这里挪 30 分钟：
    // 若哪天把 TTL 抬到 30 分钟以上，这一条会红 —— 那时把这里的量一起抬高即可，
    // 判据本身没写死任何一行源码。
    Date.now = () => realNow() + 30 * 60_000
    try {
      sweep()
    } finally {
      Date.now = realNow
    }
    await runStream(s15, 1)
    const b15 = begins(sse, s15)
    add('S15 空闲扫描真的在清回合状态：越过 TTL 扫一次后，同一会话重新算一轮',
      b15.length === 2 && b15[1].data.turnId !== first,
      `广播 ${b15.length} 次：${first} → ${b15.map((e) => e.data.turnId).join(' → ')}`)

    // 清扫之后还在被使用的另一路（S13 那个会话）不该被连带误判：
    // 它的活动时间在 S13 之后就再没刷新过，越过 TTL 后清掉是**正确**行为，
    // 所以这里只确认扫完宿主仍然跑得通（不抛、能广播句子）。
    await runStream(s13, 2)
    add('S15 越过 TTL 清扫之后宿主照样能用（同一会话重新起一轮，不报错）',
      begins(sse, s13).length === 2, `广播 ${begins(sse, s13).length} 次`)
  } finally {
    sse.close()
    for (const id of [...sweepers.keys()]) {
      try { realClearInterval(id) } catch { /* 忽略 */ }
    }
    env.restore()
  }
}

const all = [...scenarioRows, ...verdictRows]
const passed = all.filter((r) => r.ok).length
const failed = all.length - passed
console.log(`\n通过 ${passed}，失败 ${failed}（场景判据 ${scenarioRows.length} 条 + 静态接线 ${verdictRows.length} 条）`)
if (failed) process.exitCode = 1
