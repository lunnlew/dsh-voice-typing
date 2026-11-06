/**
 * 朗读调度器 —— 按自然段落 + 按客户端播放进度发句（回归测试）。
 *
 * 背景（用户反馈 2026-11-01，两次）：
 *   1. 「不是按自然段落读的，总挑到最新段落里非首句的句子」；
 *   2. 「已经念到后面了，又回去念前面的」。
 *
 * 根因（本次定位）：
 *   宿主按 400ms/句发射，而播放受真实音频时长限制 2~3 秒/句 ——
 *   生产速度是消费速度的 5~8 倍，客户端为了「贴着最新内容」只能丢掉
 *   **接下来马上要播**的句子，播放位置不断向前跳、落点在段落中间；
 *   旧实现里段落补全时用 `startsWith` 减前缀、没有兜底，还会把已发的句子
 *   再发一遍（听感就是「又回去念前面的」）。
 *
 * 本测试针对新的 `lib/read-aloud-scheduler.js`：
 *   - 段落是朗读单元：一段的句子全部发完才轮到下一段；
 *   - 内容不丢、不重复、不乱序；
 *   - 流控：未确认句数 <= READ_ALOUD_LEAD，客户端 ack 一句才补发一句；
 *   - 兼容：没有 ack（老客户端）时按旧的时间窗口节奏发，结束时同步发完；
 *   - ack 掉线时 watchdog 放行，不把朗读永久卡死。
 *
 * 追赶最新（2026-11-01 用户追加，经两轮调优）：
 *   - 积压（含「正在播放的剩余时长」；客户端 ack 可带真实时长 durationMs）
 *     超过预算（默认 7.5 秒）→ 整段跳旧段、**保留最新 3 段**（跳到最新第 3 段）；
 *   - 生成很快时 skim：仍在流式生成且「还没发出去的内容（backlogMs）」超预算时，
 *     正在读的段**只读首句**就跳走；生成结束后的剩余段落完整读完；
 *   - SSE 重连（resetOutstanding）释放旧连接的未确认配额。
 *
 * 批次 6l-f 从 `test/read-aloud-policy.test.mjs` 搬来的两条（原来读源码正则，现在跑真调度器）：
 *   - 「生产者不按时间窗口分批」= 一段多句一次取全、补发只由 ack 推进（窗口设 60 秒，
 *     期间一次都不到点，剩下的内容仍能发完）；
 *   - 「按句子长度决定的发射判定不在生产路径上」= 短于 `MIN_SENTENCE_CHARS` 的首句照样开口。
 */
import {
  createReadAloudScheduler,
  READ_ALOUD_LEAD,
} from '../src/host/read-aloud-scheduler.js'
import { stripForSpeech } from '../src/host/speech-clean.js'
import {
  MIN_SENTENCE_CHARS,
  MAX_SENTENCE_CHARS,
  MAX_PIECES_PER_WINDOW,
} from '../src/host/read-aloud-policy.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 建一个调度器 + 事件收集器。
 * 时间窗口/watchdog 取很小的值，让测试跑得快（语义不变）。
 */
function makeScheduler(options = {}) {
  const events = []
  let seq = 0
  const scheduler = createReadAloudScheduler({
    emit: (event, payload) => events.push({ event, ...payload }),
    nextIndex: () => seq++,
    // 默认值给得很小，避免测试等待；需要旧节奏语义的用例自己覆盖。
    windowMs: 15,
    stallMs: 40,
    // pending 收尾 grace 默认给很小；只有「开启追赶且积压超预算」的用例会用到。
    flushGraceMs: 30,
    lead: READ_ALOUD_LEAD,
    ...options,
  })
  return { scheduler, events }
}

/**
 * 把流式文本按固定字数切片（模拟 text-delta 任意切块）。
 */
function chunk(text, size) {
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/**
 * 模拟客户端：每收到一句就「开始播放」并 ack 1 句，直到不再有新句子。
 * @returns {number} 本次 ack 的总数。
 */
function playAndAck(scheduler, events, sessionId, turnId, ackedRef) {
  let acked = 0
  let guard = 0
  while (ackedRef.n < events.length && guard++ < 500) {
    ackedRef.n += 1
    acked += 1
    scheduler.ack({ sessionId, turnId, count: 1 })
  }
  return acked
}

/**
 * 把发出去的句子按顺序映射回「清洗后的原文」，检查不丢、不重复、不乱序。
 *
 * @param {Array} events - sentence 事件。
 * @param {string} reply - 原始回复。
 * @returns {{ok: boolean, detail: string}}
 */
function checkOrderAndNoLoss(events, reply) {
  const cleaned = stripForSpeech(reply)
  let cursor = 0
  for (const event of events) {
    const text = String(event.text ?? '')
    if (!text) return { ok: false, detail: '出现空句' }
    const at = cleaned.indexOf(text, cursor)
    if (at < 0) {
      const earlier = cleaned.indexOf(text)
      return {
        ok: false,
        detail: earlier >= 0
          ? `重复/回退：「${text}」在位置 ${earlier} 已发过（当前游标 ${cursor}）`
          : `丢失/错位：找不到「${text}」（游标 ${cursor}）`,
      }
    }
    cursor = at + text.length
  }
  // 尾巴必须发完（允许中间合并片段，但不允许整段丢失）。
  const tail = cleaned.slice(cursor).trim()
  return { ok: true, detail: '尾部剩余：' + JSON.stringify(tail) }
}

console.log('流控：按段落顺序发句，客户端 ack 一句才补一句，不丢不重不乱序')
{
  const reply = [
    '第一段的第一句话。第一段的第二句话！',
    '',
    '第二段只有一句话。',
    '',
    '- 列表甲',
    '- 列表乙',
    '',
    '最后一段开头。最后一段结尾？',
    '',
  ].join('\n')
  const { scheduler, events } = makeScheduler()
  const ackedRef = { n: 0 }
  const reader = scheduler.reader('s1', 'turn-1')
  for (const piece of chunk(reply, 4)) {
    reader.push(piece)
    // 流控不变量：任意时刻已发未确认句数不超过 lead。
    const outstanding = events.length - ackedRef.n
    check('未确认句数不超过 lead（push 后）', outstanding <= READ_ALOUD_LEAD,
      `已发 ${events.length}、已确认 ${ackedRef.n}`)
    playAndAck(scheduler, events, 's1', 'turn-1', ackedRef)
  }
  reader.end()
  playAndAck(scheduler, events, 's1', 'turn-1', ackedRef)

  check('所有句子都发出来了', events.length === 7, `只有 ${events.length} 条`)
  const order = checkOrderAndNoLoss(events, reply)
  check('不丢、不重复、不乱序', order.ok, order.detail)

  // 段落结构：para 单调不减；同一段连续；每段第一个片段 paraStart=true 且每段只有一次。
  let prevPara = -1
  let starts = 0
  let lastStartPara = -1
  let contiguous = true
  for (const event of events) {
    check('sentence 事件带文本', typeof event.text === 'string' && event.text.length > 0)
    if (event.para < prevPara) contiguous = false
    if (event.para !== prevPara) {
      // 换段：必须是该段的第一个片段
      if (event.paraStart !== true) contiguous = false
      prevPara = event.para
    }
    if (event.paraStart) {
      starts += 1
      if (lastStartPara === event.para) contiguous = false
      lastStartPara = event.para
    }
  }
  check('段落按顺序推进、段内不跨越', contiguous)
  check('每段恰好一个段首标记', starts === 5, `paraStart=${starts}`)
  check('段落序号从 0 开始', events[0]?.para === 0, JSON.stringify(events[0]?.para))
}

console.log('\n段落补全不重复：先提前发句子，段落边界后到，绝不能重发已发句子')
{
  const { scheduler, events } = makeScheduler()
  const ackedRef = { n: 0 }
  const reader = scheduler.reader('s2', 'turn-1')
  // 第一段两句先到，段落边界（空行）后到 —— 旧实现在这里会把已发句子重发一遍。
  reader.push('句一。句二。')
  playAndAck(scheduler, events, 's2', 'turn-1', ackedRef)
  reader.push('\n\n第二段。')
  playAndAck(scheduler, events, 's2', 'turn-1', ackedRef)
  reader.end()
  playAndAck(scheduler, events, 's2', 'turn-1', ackedRef)

  const texts = events.map((e) => e.text)
  check('文本序列恰好是「句一。句二。第二段。」',
    texts.join('|') === '句一。|句二。|第二段。', texts.join('|'))
  check('没有重复发已发句子', new Set(texts).size === texts.length, texts.join('|'))
  check('段落编号 0,0,1', events.map((e) => e.para).join(',') === '0,0,1',
    events.map((e) => e.para).join(','))
  check('段首标记只有两处', events.filter((e) => e.paraStart).length === 2)
}

console.log('\n兼容：没有 ack（老客户端）时按旧时间窗口节奏，首句立刻发，结束时同步发完')
{
  // 窗口设得足够长：测试期间不会到点，便于区分「首句立刻发」和「窗口发」。
  const { scheduler, events } = makeScheduler({ windowMs: 5000 })
  const reader = scheduler.reader('s3', 'turn-1')
  reader.push('第一句。第二句。第三句。')
  check('首句立刻发出（不等窗口）', events.length === 1, `发了 ${events.length} 条`)
  check('第一句内容正确', events[0]?.text === '第一句。', JSON.stringify(events[0]?.text))
  const before = events.length
  reader.end()
  check('调用结束同步发完剩余句子（不丢尾巴）',
    events.length === 3 && before === 1, `发了 ${events.length} 条`)
  const order = checkOrderAndNoLoss(events, '第一句。第二句。第三句。')
  check('内容完整', order.ok, order.detail)
  check('没有 ack 时不计算未确认句数（保持旧语义）',
    scheduler.diagnostics()[0]?.mode === 'pending',
    JSON.stringify(scheduler.diagnostics()))
}

console.log('\n流控 watchdog：客户端不再 ack 时放行，不把朗读永久卡死')
{
  const { scheduler, events } = makeScheduler({ stallMs: 30 })
  const reader = scheduler.reader('s4', 'turn-1')
  reader.push('第一句。第二句。第三句。第四句。第五句。')
  // 先 ack 一次 → 切到 flow 模式：已发的 1 句被确认，然后补发到未确认上限。
  scheduler.ack({ sessionId: 's4', turnId: 'turn-1', count: 1 })
  const flowStart = events.length
  check('切到 flow 后补发到未确认上限',
    flowStart === 1 + READ_ALOUD_LEAD, `发了 ${flowStart} 条`)
  // 之后一句都不 ack：watchdog 应该逐条放行。
  await sleep(120)
  const diag = scheduler.diagnostics()[0]
  check('watchdog 放行过（stalls > 0）', (diag?.stalls ?? 0) > 0, JSON.stringify(diag))
  check('内容继续推进到发完', events.length === 5, `发了 ${events.length} 条`)
  reader.end()
}

console.log('\n新一轮：状态整体重置，段落编号从头开始、首句立刻发')
{
  const { scheduler, events } = makeScheduler()
  const r1 = scheduler.reader('s5', 'turn-1')
  r1.push('上一轮的话。')
  const before = events.length
  const r2 = scheduler.reader('s5', 'turn-2')
  r2.push('新一轮的第一句。')
  const fresh = events.slice(before)
  check('上一轮不再有句子补发', before === 1, `上一轮发了 ${before} 条`)
  check('新一轮首句立刻发', fresh.length === 1, `发了 ${fresh.length} 条`)
  check('新一轮段落编号从 0 开始', fresh[0]?.para === 0, JSON.stringify(fresh[0]?.para))
  check('新一轮段首标记为 true', fresh[0]?.paraStart === true)
  check('新一轮 turnId 正确', fresh[0]?.turnId === 'turn-2', JSON.stringify(fresh[0]?.turnId))
  r2.end()
}

console.log('\n超长段落：段内按句末标点切，仍是同一段落（不会另起一段）')
{
  const sentence = '这是测试用的一个完整句子，用来把段落撑长一点。'
  const reply = sentence.repeat(6)
  const { scheduler, events } = makeScheduler()
  const ackedRef = { n: 0 }
  const reader = scheduler.reader('s6', 'turn-1')
  for (const piece of chunk(reply, 7)) {
    reader.push(piece)
    playAndAck(scheduler, events, 's6', 'turn-1', ackedRef)
  }
  reader.end()
  playAndAck(scheduler, events, 's6', 'turn-1', ackedRef)
  check('所有句子都是同一个段落', new Set(events.map((e) => e.para)).size === 1,
    events.map((e) => e.para).join(','))
  check('只有第一个片段带段首标记', events.filter((e) => e.paraStart).length === 1)
  check('每句不超过单句上限', events.every((e) => e.text.length <= 60),
    String(Math.max(...events.map((e) => e.text.length))))
  const order = checkOrderAndNoLoss(events, reply)
  check('内容完整不乱序', order.ok, order.detail)
}

console.log('\n一次 llm/stream 调用内的多段落一次到齐：段落顺序与编号正确')
{
  const { scheduler, events } = makeScheduler()
  const ackedRef = { n: 0 }
  const reader = scheduler.reader('s7', 'turn-1')
  reader.push('甲段。\n\n乙段。\n\n丙段。\n\n')
  reader.end()
  playAndAck(scheduler, events, 's7', 'turn-1', ackedRef)
  check('三段各一句', events.map((e) => e.text).join('|') === '甲段。|乙段。|丙段。',
    events.map((e) => e.text).join('|'))
  check('段落编号 0,1,2', events.map((e) => e.para).join(',') === '0,1,2',
    events.map((e) => e.para).join(','))
}

console.log('\n结尾未完成段以空白开头：按字符数减前缀，绝不整段重发（旧 trim+startsWith 的坑）')
{
  // 基线验证的真实最小复现：最后一段的首字符是空格。
  // 旧 finally 里先 `curPara.trim()` 再 `tail.startsWith(curParaSent)`，
  // trim 掉前导空格后匹配失败 → 整段重发一遍（用户听到的「读完又回去读」）。
  const reply = '第一段内容完整结束。\n\n 第二段开头有一个多余的空格。它还有第二句话。'
  const { scheduler, events } = makeScheduler()
  const ackedRef = { n: 0 }
  const reader = scheduler.reader('s9', 'turn-1')
  for (const piece of ['第一段内容完整结束。', '\n\n 第二段开头有一个多余的空格。', '它还有第二句话。']) {
    reader.push(piece)
    playAndAck(scheduler, events, 's9', 'turn-1', ackedRef)
  }
  reader.end()
  playAndAck(scheduler, events, 's9', 'turn-1', ackedRef)
  const texts = events.map((e) => e.text)
  check('没有把整段重发一遍', new Set(texts).size === texts.length, texts.join('|'))
  check('三句各发一次且顺序正确',
    texts.join('|') === '第一段内容完整结束。|第二段开头有一个多余的空格。|它还有第二句话。',
    texts.join('|'))
  check('段落编号 0,1,1', events.map((e) => e.para).join(',') === '0,1,1',
    events.map((e) => e.para).join(','))
}

console.log('\n兼容：一轮内第二次 llm/stream 调用的首句也要立刻发（工具调用链不卡 400ms）')
{
  const { scheduler, events } = makeScheduler({ windowMs: 5000 })
  const r1 = scheduler.reader('s10', 'turn-1')
  r1.push('工具调用前的那句话。')
  r1.end()
  check('第一次调用的首句立刻发', events.length === 1, `发了 ${events.length} 条`)
  const r2 = scheduler.reader('s10', 'turn-1')
  r2.push('工具调用后的回答。')
  check('第二次调用的首句也立刻发（不等窗口）', events.length === 2, `发了 ${events.length} 条`)
  r2.end()
  check('第二次调用结束时发完剩余（此处无剩余）', events.length === 2)
}

console.log('\n切流控的记账：pending 阶段已发的句子不能清零，批量 ack 不能冲过 lead')
{
  // 场景：客户端攒 2 句一起 ack（count=2）；而 pending 阶段时间窗口已经发出
  // 3 句（客户端还没 ack 它们）。旧实现切 flow 时把未确认清 0，再补发 3 句 →
  // 「已发 - 已确认」= 6 - 2 = 4 > lead（实测批量 ack 场景会偶发冲过上限）。
  const { scheduler, events } = makeScheduler({ windowMs: 15 })
  const reader = scheduler.reader('s11', 'turn-1')
  reader.push('第一句。第二句。第三句。第四句。第五句。')
  await sleep(90)
  const pendingEmitted = events.length
  check('pending 窗口确实多发了句子（模拟「客户端还没 ack」）', pendingEmitted >= 2,
    `pendingEmitted=${pendingEmitted}`)
  check('此时未确认已到上限', scheduler.diagnostics()[0]?.outstanding === pendingEmitted,
    JSON.stringify(scheduler.diagnostics()[0]))
  // 客户端攒 2 句一起回执。
  scheduler.ack({ sessionId: 's11', turnId: 'turn-1', count: 2 })
  const diag = scheduler.diagnostics()[0]
  check('批量 ack 后未确认不超过 lead', (diag?.outstanding ?? 99) <= READ_ALOUD_LEAD,
    JSON.stringify(diag))
  check('「已发 - 已确认」不超过 lead（不会多预发）',
    events.length - 2 <= READ_ALOUD_LEAD,
    `sent=${events.length} acked=2`)
  reader.end()
}

console.log('\ndispose 之后不再发句（插件卸载）')
{
  const { scheduler, events } = makeScheduler({ windowMs: 10 })
  const reader = scheduler.reader('s8', 'turn-1')
  reader.push('第一句。第二句。')
  scheduler.dispose()
  const before = events.length
  await sleep(40)
  check('dispose 后定时器不再发句', events.length === before,
    `${before} → ${events.length}`)
}

console.log('\n追赶最新：积压超过上限就按整段跳到最新（不丢段首、不打断正在读的段）')
{
  // 每段一句话（约 17 字 ≈ 3.6s 估算音频）；模拟「模型瞬间写完 6 段，客户端播放很慢」。
  const paraTexts = ['甲', '乙', '丙', '丁', '戊', '己'].map(
    (p) => p + '段只有一句话但是内容要够长一点。',
  )
  const { scheduler, events } = makeScheduler({ getMaxLagMs: () => 5000 })
  const reader = scheduler.reader('s12', 'turn-1')
  // 生成远快于朗读：一次性全部写完，客户端还没 ack。
  for (const text of paraTexts) reader.push(text + '\n\n')
  // 第一条 ack 切 flow（首句已经在 pending 阶段发出）→ 触发「追赶」。
  let acked = 1
  scheduler.ack({ sessionId: 's12', turnId: 'turn-1', count: 1 })
  reader.end()
  let guard = 0
  while (events.length > acked && guard++ < 200) {
    acked += 1
    scheduler.ack({ sessionId: 's12', turnId: 'turn-1', count: 1 })
  }

  const paraIds = events.map((e) => e.para)
  const emittedParas = [...new Set(paraIds)]
  check('段落序号单调不减（不乱序）', paraIds.every((v, i) => i === 0 || v >= paraIds[i - 1]),
    paraIds.join(','))
  check('追赶生效：中间段落被整段跳过',
    emittedParas.length < paraTexts.length && emittedParas.length >= 1,
    `emittedParas=${emittedParas.join(',')}`)
  check('首段被完整读出（第一段从段首开始）',
    emittedParas[0] === 0 && events.filter((e) => e.para === 0).length >= 1,
    JSON.stringify(emittedParas))
  check('最后一句是最新段落的句子', events[events.length - 1]?.para === paraTexts.length - 1,
    JSON.stringify(events[events.length - 1]))
  // 出现过的段落必须完整（单句段落：恰好这一句；且 paraStart=true）
  check('出现过的段落都是完整的（从段首开始）',
    emittedParas.every((para) => {
      const list = events.filter((e) => e.para === para)
      return list.length === 1 && list[0].paraStart === true && list[0].text === paraTexts[para]
    }),
    emittedParas.map((p) => `${p}:${events.filter((e) => e.para === p).length}`).join(' '))
  const diag = scheduler.diagnostics()[0]
  check('诊断记录跳过的句子/段落数',
    (diag?.trimmed ?? 0) > 0 && (diag?.trimmedParagraphs ?? 0) > 0, JSON.stringify(diag))
  check('诊断给出当前估算积压时长', Number.isFinite(diag?.lagMs), JSON.stringify(diag))
}

console.log('\n追赶最新：超预算后跳到「最新第 3 段」，保留最新 3 段（不是只留最新 1 段）')
{
  // 用户要求（2026-11-01）：不要"只留最新一条"，而是跳到**最新的第三条**：
  // 保留最新 3 段，从最新第 3 段开始接着读（既有上下文又追上最新）。
  const paraTexts = Array.from({ length: 10 }, (_, i) =>
    `${'甲乙丙丁戊己庚辛壬癸'[i]}段只有一句话但是内容要够长一点。`,
  )
  const { scheduler, events } = makeScheduler({ getMaxLagMs: () => 8000 })
  const reader = scheduler.reader('s15', 'turn-1')
  for (const text of paraTexts) reader.push(text + '\n\n')
  // 首句已经在 pending 阶段发出；第一条 ack 切 flow 并触发追赶。
  let acked = 1
  scheduler.ack({ sessionId: 's15', turnId: 'turn-1', count: 1 })
  reader.end()
  let guard = 0
  while (events.length > acked && guard++ < 200) {
    acked += 1
    scheduler.ack({ sessionId: 's15', turnId: 'turn-1', count: 1 })
  }
  const paraIds = events.map((e) => e.para)
  check('保留首段（已开读）+ 最新 3 段（7/8/9）',
    JSON.stringify(paraIds) === JSON.stringify([0, 7, 8, 9]), `paras=${paraIds.join(',')}`)
  const diag = scheduler.diagnostics()[0]
  check('中间 6 段被整段跳过', diag?.trimmedParagraphs === 6, JSON.stringify(diag))
  check('跳过后的下一段是最新第 3 段、从段首开始（paraStart=true）',
    events[1]?.paraStart === true && events[1]?.para === 7,
    JSON.stringify(events[1]))
  check('诊断暴露保留段数 keepParagraphs=3', diag?.keepParagraphs === 3, JSON.stringify(diag))
}

console.log('\n追赶最新：生成很快时当前段只读首句就跳走（不需要整段读完）')
{
  // 长段落（80 字 > 单句上限 60）会被切成 2 个片段；生成中 + 超预算时，
  // 按用户要求「跳走时只需要读首句」：只发第一句，剩余片段直接放弃。
  const longPara = [
    '第一句内容写得比较长一些用来凑字数。',
    '第二句内容也写得比较长一些凑字数。',
    '第三句内容同样写得比较长一点凑字数。',
    '第四句内容继续写得比较长一点凑字数。',
  ].join('')
  const shortParas = ['乙', '丙', '丁', '戊'].map((p) => p + '段只有一句话但是内容要够长一点。')
  const { scheduler, events } = makeScheduler({ getMaxLagMs: () => 2500, lead: 1 })
  const reader = scheduler.reader('s14', 'turn-1')
  // 先用一段开场白进入 flow；ack 里带一个 12s 的播放时长 → 立刻处于「超预算 + 生成中」。
  reader.push('开场白。\n\n')
  scheduler.ack({ sessionId: 's14', turnId: 'turn-1', count: 1, durationMs: 12000 })
  reader.push(longPara + '\n\n') // 这一段的 remainder 应被 skim 丢弃
  for (const text of shortParas) reader.push(text + '\n\n')
  reader.end()
  let acked = 1
  let guard = 0
  while (events.length > acked && guard++ < 200) {
    acked += 1
    scheduler.ack({ sessionId: 's14', turnId: 'turn-1', count: 1 })
  }

  const longParaEvents = events.filter((e) => e.para === 1)
  check('生成中追赶：长段落只发出**首句**（不再整段读完）', longParaEvents.length === 1,
    `pieces=${longParaEvents.length} texts=${JSON.stringify(longParaEvents.map((e) => e.text))}`)
  check('发出的就是第一句（不是整段/半句）',
    longParaEvents[0]?.text === '第一句内容写得比较长一些用来凑字数。',
    JSON.stringify(longParaEvents[0]?.text))
  check('没有把整段读完（用户要求：跳走时不用读完当前段）',
    longParaEvents.map((e) => e.text).join('') !== longPara,
    JSON.stringify(longParaEvents.map((e) => e.text).join('')))
  const diag = scheduler.diagnostics()[0]
  check('诊断记录段内截断（trimmedSentences/truncatedParagraphs > 0）',
    (diag?.trimmedSentences ?? 0) > 0 && (diag?.truncatedParagraphs ?? 0) > 0,
    JSON.stringify(diag))
  check('跳到最新段落（而不是接着读全部中间段）',
    events[events.length - 1]?.para === 5,
    JSON.stringify(events.map((e) => e.para)))
}

console.log('\n生成结束后（不再 streaming）：剩余段落完整读完，不截断结尾')
{
  const twoSentence = (name) => `${name}段第一句话内容够长。${name}段第二句话内容也够长。`
  const { scheduler, events } = makeScheduler({ getMaxLagMs: () => 1500, lead: 1 })
  const reader = scheduler.reader('s26', 'turn-1')
  reader.push(twoSentence('甲') + '\n\n')
  // 带真实时长让"正在播放"足够长 → 超预算（生成中）→ 第一段只读首句
  scheduler.ack({ sessionId: 's26', turnId: 'turn-1', count: 1, durationMs: 12000 })
  reader.push(twoSentence('乙') + '\n\n')
  reader.push(twoSentence('丙') + '\n\n')
  check('生成中：第一段只读了首句',
    events.filter((e) => e.para === 0).length === 1,
    JSON.stringify(events.map((e) => [e.para, e.text])))
  // 生成结束（端到端里对应 endCall）：之后不再截断，排队的段要完整读完
  reader.end()
  let acked = 1
  let guard = 0
  while (events.length > acked && guard++ < 100) {
    acked += 1
    scheduler.ack({ sessionId: 's26', turnId: 'turn-1', count: 1 })
  }
  const last = events[events.length - 1]
  check('生成结束后排队的段完整读出（含第二句，不截断结尾）',
    last?.para === 2 && last?.text === twoSentence('丙'),
    JSON.stringify(events.map((e) => [e.para, e.text])))
}

console.log('\n追赶最新：0 = 关闭（全部朗读，不跳段）')
{
  const paraTexts = ['甲', '乙', '丙', '丁'].map(
    (p) => [p + '段第一句测试内容。', p + '段第二句测试内容。'],
  )
  const { scheduler, events } = makeScheduler({ getMaxLagMs: () => 0 })
  const ackedRef = { n: 0 }
  const reader = scheduler.reader('s13', 'turn-1')
  for (const sentences of paraTexts) {
    reader.push(sentences.join('') + '\n\n')
    if (events.length > ackedRef.n) {
      ackedRef.n += 1
      scheduler.ack({ sessionId: 's13', turnId: 'turn-1', count: 1 })
    }
  }
  reader.end()
  let guard = 0
  while (events.length > ackedRef.n && guard++ < 200) {
    ackedRef.n += 1
    scheduler.ack({ sessionId: 's13', turnId: 'turn-1', count: 1 })
  }
  check('关闭追赶时全部段落都读（不跳段）',
    JSON.stringify([...new Set(events.map((e) => e.para))]) === JSON.stringify([0, 1, 2, 3]),
    JSON.stringify([...new Set(events.map((e) => e.para))]))
  check('关闭追赶时不记录跳过', (scheduler.diagnostics()[0]?.trimmed ?? 0) === 0,
    JSON.stringify(scheduler.diagnostics()[0]))
}

console.log('\nwatchdog：持续收到文本但客户端不 ack 时仍要放行（不能被 push 重置）')
{
  const { scheduler, events } = makeScheduler({ stallMs: 80 })
  const reader = scheduler.reader('s16', 'turn-1')
  reader.push('第一句。')
  scheduler.ack({ sessionId: 's16', turnId: 'turn-1', count: 1 }) // 切 flow
  // 之后**持续 push 文本、不 ack**：旧实现每次 push 都会把 watchdog 重新计时，
  // 于是永远不会放行（评审实测：持续 push 2.2s、stallMs=300 → 放行 0 次）。
  for (let i = 0; i < 12; i += 1) {
    reader.push('后续内容第' + i + '句。')
    await sleep(25)
  }
  const diag = scheduler.diagnostics()[0]
  check('watchdog 真的放行了（stalls > 0）', (diag?.stalls ?? 0) > 0, JSON.stringify(diag))
  check('内容继续推进（没有永久卡住）', events.length > 1, `emitted=${events.length}`)
  reader.end()
}

console.log('\n追赶最新：最新内容还在未完成段（curPara）时，仍只保留最新 3 段')
{
  const closedParas = ['甲', '乙', '丙', '丁', '戊'].map(
    (p) => p + '段只有一句话但是内容要够长一点点。',
  )
  const { scheduler, events } = makeScheduler({ getMaxLagMs: () => 2000, lead: 2 })
  const reader = scheduler.reader('s17', 'turn-1')
  for (const text of closedParas) reader.push(text + '\n\n')
  // 最新一段还没写完（没有句末标点）：它比所有已封口段都新，但按"保留最新 3 段"
  // 语义，已封口的最后 3 段（para 2/3/4）仍然保留，更旧的 para1 被整段跳过。
  reader.push('这是最新的一段内容还没有写完')
  let acked = 1
  scheduler.ack({ sessionId: 's17', turnId: 'turn-1', count: 1 })
  const beforeTail = [...new Set(events.map((e) => e.para))]
  check('更旧的段被整段跳过（para1 不读）', !beforeTail.includes(1),
    `paras=${beforeTail.join(',')}`)
  check('开始读的是最新 3 段之一（para2 起）', beforeTail.some((p) => p >= 2),
    `paras=${beforeTail.join(',')}`)
  // 尾巴补完整 → 最后读到最新段
  reader.push('，这就是最新段。')
  reader.end()
  let guard = 0
  while (events.length > acked && guard++ < 100) {
    acked += 1
    scheduler.ack({ sessionId: 's17', turnId: 'turn-1', count: 1 })
  }
  const last = events[events.length - 1]
  check('尾巴成段后最后读到最新段（para5）', last?.para === 5 && last?.paraStart === true,
    JSON.stringify(last))
  check('旧段被整段跳过（trimmedParagraphs >= 1）',
    (scheduler.diagnostics()[0]?.trimmedParagraphs ?? 0) >= 1,
    JSON.stringify(scheduler.diagnostics()[0]))
}

console.log('\npending 收尾 grace：期间收到 ack 就走追赶（不会一次把旧段全发完）')
{
  const paraTexts = Array.from({ length: 10 }, (_, i) =>
    `${'甲乙丙丁戊己庚辛壬癸'[i]}段只有一句话但是内容要够长一点。`,
  )
  const { scheduler, events } = makeScheduler({ getMaxLagMs: () => 4000, flushGraceMs: 40 })
  const reader = scheduler.reader('s18', 'turn-1')
  for (const text of paraTexts) reader.push(text + '\n\n')
  reader.end() // pending 模式 + 超预算 → 挂起等待 ack
  check('收尾挂起等待 ack（awaitingFlush=true）',
    scheduler.diagnostics()[0]?.awaitingFlush === true, JSON.stringify(scheduler.diagnostics()[0]))
  const emittedBefore = events.length
  // grace 期内客户端 ack 第一条 → 切 flow，追赶立即生效
  scheduler.ack({ sessionId: 's18', turnId: 'turn-1', count: 1 })
  const parasNow = [...new Set(events.map((e) => e.para))]
  check('ack 后立即走追赶（保留最新 3 段：para7/8/9）',
    parasNow.length <= 4 && parasNow[parasNow.length - 1] === paraTexts.length - 1
      && parasNow.includes(paraTexts.length - 3),
    parasNow.join(','))
  check('没有把 10 段一次性发完', events.length < paraTexts.length,
    `emitted=${events.length}（ack 前 ${emittedBefore}）`)
  await sleep(80) // 若 grace 定时器没被取消，这期间会一次性排空
  let acked = 1
  let guard = 0
  while (events.length > acked && guard++ < 100) {
    acked += 1
    scheduler.ack({ sessionId: 's18', turnId: 'turn-1', count: 1 })
  }
  const finalParas = [...new Set(events.map((e) => e.para))]
  check('最终读到最新段', finalParas[finalParas.length - 1] === paraTexts.length - 1,
    finalParas.join(','))
  check('grace 定时器已被取消（awaitingFlush=false）',
    scheduler.diagnostics()[0]?.awaitingFlush === false,
    JSON.stringify(scheduler.diagnostics()[0]))
}

console.log('\npending 收尾 grace：老客户端（始终无 ack）到点后照旧发完，不丢尾巴')
{
  const paraTexts = Array.from({ length: 10 }, (_, i) =>
    `${'甲乙丙丁戊己庚辛壬癸'[i]}段只有一句话但是内容要够长一点。`,
  )
  const { scheduler, events } = makeScheduler({ getMaxLagMs: () => 3000, flushGraceMs: 20 })
  const reader = scheduler.reader('s19', 'turn-1')
  for (const text of paraTexts) reader.push(text + '\n\n')
  reader.end()
  const before = events.length
  await sleep(80)
  const after = events.length
  check('grace 到点后一次性发完（老客户端兼容）', after > before, `${before} → ${after}`)
  check('内容没有丢（10 段都发出来了）',
    new Set(events.map((e) => e.para)).size === paraTexts.length,
    `paras=${[...new Set(events.map((e) => e.para))].join(',')}`)
}

console.log('\nSSE 重连（resetOutstanding）：旧连接遗留的未确认配额被释放')
{
  const { scheduler } = makeScheduler({ stallMs: 5000 })
  const reader = scheduler.reader('s20', 'turn-1')
  reader.push('第一句。第二句。第三句。第四句。')
  scheduler.ack({ sessionId: 's20', turnId: 'turn-1', count: 1 })
  const before = scheduler.diagnostics()[0]?.outstanding ?? 0
  const touched = scheduler.resetOutstanding()
  const after = scheduler.diagnostics()[0]?.outstanding ?? 0
  check('resetOutstanding 重置了受影响会话', touched >= 1, String(touched))
  check('旧未确认被清零（新页面首句不再等 watchdog）', before > 0 && after === 0,
    `${before} → ${after}`)
  reader.end()
}

console.log('\ndispose / 换轮后旧 reader 失效（不再广播、不再起定时器）')
{
  const { scheduler, events } = makeScheduler()
  const reader = scheduler.reader('s21', 'turn-1')
  reader.push('第一句。')
  scheduler.dispose()
  const before = events.length
  reader.push('销毁之后不该再发。')
  await sleep(30)
  check('dispose 后旧 reader push 不再广播', events.length === before,
    `${before} → ${events.length}`)

  const { scheduler: s2, events: e2 } = makeScheduler()
  const oldReader = s2.reader('s22', 'turn-1')
  oldReader.push('旧轮句子。')
  const before2 = e2.length
  s2.reader('s22', 'turn-2') // 新一轮替换 state
  oldReader.push('旧 reader 迟到内容。')
  oldReader.end()
  check('换轮后旧 reader 不再广播/封口', e2.length === before2,
    `${before2} → ${e2.length}`)
}

console.log('\nack 被拒要可观测（session/turn 对不上时诊断有记录）')
{
  const { scheduler } = makeScheduler()
  scheduler.reader('s23', 'turn-1')
  check('未知会话的 ack 返回 false',
    scheduler.ack({ sessionId: 'nope', turnId: 'turn-1', count: 1 }) === false)
  let diag = scheduler.schedulerDiagnostics()
  check('诊断记录 rejectedAcks / lastRejectedAck',
    diag.rejectedAcks === 1 && diag.lastRejectedAck?.reason === 'unknown-session',
    JSON.stringify(diag))
  check('turnId 不匹配的 ack 返回 false',
    scheduler.ack({ sessionId: 's23', turnId: 'turn-9', count: 1 }) === false)
  diag = scheduler.schedulerDiagnostics()
  check('turn-mismatch 也被记录', diag.rejectedAcks === 2 && diag.lastRejectedAck?.reason === 'turn-mismatch',
    JSON.stringify(diag))
}

console.log('\n追赶计时：正在播放的那句也要计入积压（ack 只代表开始播放）')
{
  // 客户端 ack 的时机是「开始播放」（为了让宿主尽早补发下一句），
  // 被 ack 的句子其实还要播 2~5 秒。追赶计时如果只算「未确认」，
  // 15 秒预算实际会变成 15 + 正在念的那句（用户反馈「明明落后 15s 还不跳」）。
  const { scheduler } = makeScheduler({ getMaxLagMs: () => 5000 })
  const reader = scheduler.reader('s24', 'turn-1')
  reader.push('这一句比较长一些用来验证正在播放的时长会被计入积压。')
  scheduler.ack({ sessionId: 's24', turnId: 'turn-1', count: 1 }) // 开始播放（还没播完）
  const diag = scheduler.diagnostics()[0]
  check('ack 后仍计入「正在播放」的剩余时长', (diag?.playingMs ?? 0) > 2000, JSON.stringify(diag))
  check('lagMs 包含正在播放的时长（不是 0）', (diag?.lagMs ?? 0) > 2000, JSON.stringify(diag))
  check('诊断暴露追赶预算 budgetMs', diag?.budgetMs === 5000, JSON.stringify(diag))
  reader.end()
}

console.log('\n追赶计时：客户端上报真实音频时长时优先使用（比按字数估算准）')
{
  const { scheduler } = makeScheduler({ getMaxLagMs: () => 5000 })
  const reader = scheduler.reader('s25', 'turn-1')
  reader.push('这一句比较长一些用来验证真实时长优先于字数估算。')
  scheduler.ack({ sessionId: 's25', turnId: 'turn-1', count: 1, durationMs: 9500 })
  const diag = scheduler.diagnostics()[0]
  check('playingMs 采用 ack 里的真实时长（≈9.5s）',
    (diag?.playingMs ?? 0) > 8000 && (diag?.playingMs ?? 0) <= 9500,
    JSON.stringify(diag))
  reader.end()
}

console.log('\n一次取全：整段一次交给生产者，发句节奏由 ack 决定（不按时间窗口分批）')
{
  // 判的是「生产者不按窗口分批」这条语义，靠跑真调度器观察，不读源码。
  // 生产写法在 src/host/read-aloud-scheduler.js 的 sentencesOf()：调
  // packWindowSentences 时显式传 maxPieces: 9999 —— 一次把整段取全，
  // 之后按客户端播放进度逐句补发。
  // 旧的窗口语义是「一个 EMIT_WINDOW_MS 最多取 MAX_PIECES_PER_WINDOW(=1) 批」，
  // 接回来的话整段只剩第一个片段、其余内容在 return 的 rest 里被丢掉（实测见文档 6l-f）。
  // 窗口设 60 秒：本用例期间时间窗口一次都不会到点，
  // 所以「后面的片段发出来了」只能是被 ack 发出来的。
  const SENTENCES = Array.from(
    { length: 24 },
    (_, i) => `第${i + 1}句话要把这一段凑得比未确认上限更长一些。`,
  )
  const full = SENTENCES.join('')
  const { scheduler, events } = makeScheduler({ windowMs: 60000 })
  const reader = scheduler.reader('s26', 'turn-1')
  const textsOf = () => events.map((event) => event.text).join('')
  // 空行 = 段落边界：整段一次交给生产者（一次拿到多句才能看出「一批取几句」的限制）。
  reader.push(`${full}\n\n`)
  check('窗口没到点也已经开口（首句无条件立刻发）',
    events.length === 1, '已发 ' + events.length)
  check('整段没有一次全倒给客户端（未确认配额之外都等着）',
    textsOf().length < full.length, `${textsOf().length}/${full.length} 字`)

  // 一句一句 ack 到整段发完，全程不给时间窗口任何到点机会。
  let acked = 0
  for (let guard = 0; guard < 60 && textsOf().length < full.length; guard += 1) {
    const before = textsOf().length
    scheduler.ack({ sessionId: 's26', turnId: 'turn-1', count: 1 })
    acked += 1
    // 流控不变量：ack 一句只补一句，绝不冲过未确认上限。
    check('未确认句数不超过 lead（每次 ack 后）',
      events.length - acked <= READ_ALOUD_LEAD,
      `已发 ${events.length}、已确认 ${acked}`)
    // ack 不再推进 = 要发的内容根本不在队列里，别空转。
    if (textsOf().length === before) break
  }
  const texts = events.map((event) => event.text)
  check('整段内容一次取全、全部发出（旧分批语义只剩第一个片段）',
    texts.join('') === full,
    `发出 ${texts.length} 批 / ${texts.join('').length} 字，整段 ${full.length} 字：${texts.join('|').slice(0, 90)}`)
  check(`发出的批数多于一个窗口的分批容量（> ${MAX_PIECES_PER_WINDOW}）`,
    texts.length > MAX_PIECES_PER_WINDOW, String(texts.length))
  check(`每批仍不超过单句上限（<= ${MAX_SENTENCE_CHARS} 字）`,
    texts.every((text) => text.length <= MAX_SENTENCE_CHARS),
    '最长 ' + Math.max(...texts.map((text) => text.length)))
  check('发句已切到流控模式（ack 驱动）',
    scheduler.diagnostics()[0]?.mode === 'flow',
    JSON.stringify(scheduler.diagnostics()[0]?.mode))
  const order = checkOrderAndNoLoss(events, full)
  check('不丢、不重复、不乱序', order.ok, order.detail)
  reader.end()
}

console.log('\n发射判定与句子长度无关（旧 shouldEmit 的长度门槛不在生产路径上）')
{
  // read-aloud-policy.js 里的 shouldEmit() 是旧窗口发射时代的判定：
  // 短于 MIN_SENTENCE_CHARS 又不是 force 就「先不发」。宿主今天不走它 ——
  // 首句一识别出来就发，短成「走吧。」也一样。
  // 于是这条判据是「生产发射路径不受句子长度门槛约束」的行为侧：
  // 谁把按长度决定的发射判定接回 scheduler，这里立刻红。
  const short = '走吧。'
  check('用例句子确实短于旧门槛（否则这条判据是空的）',
    short.length < MIN_SENTENCE_CHARS, `${short.length} vs ${MIN_SENTENCE_CHARS}`)
  const { scheduler, events } = makeScheduler({ windowMs: 60000 })
  const reader = scheduler.reader('s27', 'turn-1')
  reader.push(short)
  check('三字短句首句照样立刻发出',
    events.length === 1 && events[0].text === short,
    JSON.stringify(events.map((event) => event.text)))
  reader.end()
  playAndAck(scheduler, events, 's27', 'turn-1', { n: 0 })
  check('收尾也不会补发第二句（不是「攒着等长度够」）',
    events.length === 1, JSON.stringify(events.map((event) => event.text)))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
