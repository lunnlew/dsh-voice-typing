/**
 * 朗读切分/合并规则（纯函数）。
 *
 * 生产现状（0.0.2）：
 *   - 发句节奏由 `src/host/read-aloud-scheduler.js` 按**客户端播放进度（ack）**驱动，
 *     旧的「时间窗口每 400ms 取 N 句」只作为**老客户端降级**语义保留；
 *   - 生产者**不再**按 `MAX_PIECES_PER_WINDOW` 分批（scheduler 调 `packWindowSentences`
 *     时显式传 `maxPieces: 9999`，一次取全再按 ack 流控补发）；
 *   - `shouldEmit()` 已无生产调用（按句子长度决定发不发，不在发射路径上）。
 *
 * 本文件只保护**纯函数层**的规则：超长句按句末标点切（`splitLongText`）、
 * 碎句合并（`packWindowSentences`）、几个常量的取值范围。
 *
 * 批次 6l-f：这里原来还有两条读源码正则的「规则0」——
 * 钉 `maxPieces: 9999` 那行写法、钉「宿主不调 shouldEmit / MAX_PIECES_PER_WINDOW」。
 * 它们保护的是**调度器与宿主的接线行为**，已经换成跑真调度器的判据，住在
 * `test/read-aloud-scheduler.test.mjs`：
 *   - 「整段一次交给生产者 → 内容一次取全、批数多于一个窗口的分批容量、
 *     补发只由 ack 推进（窗口设 60 秒，用例期间一次都不到点）」；
 *   - 「短于 `MIN_SENTENCE_CHARS` 的首句照样开口」（= 长度门槛不在发射路径上）。
 * 端到端那一层（真 `apply()` + 真 `llm/stream` 钩子 + 真 `/reading-ack` 路由）在
 * `test/read-aloud-chain.test.mjs`：每段内容完整、段落不跨越、未确认不超过 lead。
 */
import {
  EMIT_WINDOW_MS,
  MIN_SENTENCE_CHARS,
  MAX_SENTENCE_CHARS,
  MAX_PIECES_PER_WINDOW,
  splitLongText,
  packWindowSentences,
} from '../src/host/read-aloud-policy.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

console.log('常量合理')
check('时间窗口是正数毫秒', EMIT_WINDOW_MS > 0 && EMIT_WINDOW_MS <= 2000, String(EMIT_WINDOW_MS))
check('单句上限不超过 80 字', MAX_SENTENCE_CHARS <= 80, String(MAX_SENTENCE_CHARS))
check('一批最多几句有上限', MAX_PIECES_PER_WINDOW >= 1 && MAX_PIECES_PER_WINDOW <= 4, String(MAX_PIECES_PER_WINDOW))
check('最短句子长度不超过单句上限', MIN_SENTENCE_CHARS <= MAX_SENTENCE_CHARS)

console.log('\n规则2：窗口不是「合并成一大段」')
{
  // 10 句各自独立，绝不能拼成一个超长串
  const sentences = Array.from({ length: 10 }, (_, i) => `这是第${i + 1}句话，长度差不多就这样吧。`)
  const out = packWindowSentences(sentences, { maxPieces: 99 })
  check('每段都不超过单句上限',
    out.pieces.every((p) => p.length <= MAX_SENTENCE_CHARS),
    '最长 ' + Math.max(...out.pieces.map((p) => p.length)))
  check('没有被拼成一整段（段数 > 1）', out.pieces.length > 1, '段数 ' + out.pieces.length)
  check('内容是原来那些句子（没有丢失信息）',
    out.pieces.join('').replace(/\s/g, '') === sentences.join('').replace(/\s/g, ''))
}

console.log('\n规则3：超长单句按标点拆开，不会让一句无限长')
{
  // 纯逗号且**远超**上限（203 字 vs 上限 60）：必须断开，否则一句合成太久。
  const long = '这是一句非常长的话，'.repeat(20) + '结束。'
  const parts = splitLongText(long, MAX_SENTENCE_CHARS)
  check('远超上限时拆成了多段', parts.length > 1, '段数 ' + parts.length)
  check('拼回去等于原文（不丢字）', parts.join('') === long)
  check('每段都在标点处断开',
    parts.slice(0, -1).every((p) => /[。！？；，、：!?;,]$/.test(p) || p.length === MAX_SENTENCE_CHARS),
    JSON.stringify(parts.slice(0, 3)))

  // 无标点的超长文本：只能硬切（保证一定不无限长）
  const noPunct = '字'.repeat(200)
  const hard = splitLongText(noPunct, MAX_SENTENCE_CHARS)
  check('无标点时硬切，每段不超上限',
    hard.every((p) => p.length <= MAX_SENTENCE_CHARS),
    '最长 ' + Math.max(...hard.map((p) => p.length)))
}

console.log('\n规则3b：绝不能在句子中间切断（用户反馈的「半句」问题）')
{
  // 用户原话：「有时候可能是测试符号就把句子截断了，导致看起来不是一个完整的句子」
  // 「这样才能形成一段完整的话，」这种以逗号结尾的半句，听感非常破碎。
  const CLAUSE = '，、：,'

  const text = '第一句话讲的是背景，第二句话讲的是问题，第三句话讲的是原因。'
    + '第四句话开始讲解决方案，第五句话讲具体步骤，第六句话讲注意事项。'
    + '第七句话总结全文，强调重点。最后一句是结束语。'
  // 生产上限（MAX_SENTENCE_CHARS）以及接近它的几个值：
  // 只要上限足够容纳一个完整分句，就必须在句号处断开、绝不出现半句。
  for (const maxChars of [40, 50, 60, 80]) {
    const parts = splitLongText(text, maxChars)
    const badIdx = parts
      .map((p, i) => (i < parts.length - 1 && CLAUSE.includes(p[p.length - 1]) ? i : -1))
      .filter((i) => i >= 0)
    check(`上限 ${maxChars} 字时没有以逗号结尾的半句段`, badIdx.length === 0,
      '半句段: ' + badIdx.map((i) => JSON.stringify(parts[i])).join(', '))
    check(`上限 ${maxChars} 字时不丢内容`, parts.join('') === text)
  }

  // 上限被逼到极小时（比一个分句还短），只能在逗号处切 ——
  // 这是明确接受的取舍：宁可偶尔半句，也不能让一句长到合成不出来。
  const tiny = splitLongText(text, 20)
  check('上限极小时仍然不丢内容', tiny.join('') === text)

  // 真实回复里常见的一句话（中间只有逗号）：宁可整句不切，也不要切成半句。
  const commaOnly = '这是一个比较长的句子，它包含了很多个分句，每个分句之间都用逗号隔开，'
    + '这样才能形成一段完整的话，如果按照逗号硬切就会把意思切断。'
  const one = splitLongText(commaOnly, 60)
  check('只有逗号时不产生半句',
    one.every((p, i) => i === one.length - 1 || !CLAUSE.includes(p[p.length - 1])),
    JSON.stringify(one.map((p) => p.slice(-6))))
  check('只有逗号时内容不丢', one.join('') === commaOnly)
}

console.log('\n规则4：碎句合并（「对。」不该各占一次请求）')
{
  const out = packWindowSentences(['对。', '好。', '可以。'], { maxPieces: 99 })
  check('三个碎句合并成一段', out.pieces.length === 1, '段数 ' + out.pieces.length)
  check('合并后内容完整', out.pieces[0] === '对。好。可以。', out.pieces[0])
  // 但两个长句不应被合并
  const two = packWindowSentences(
    ['这是一句完整长度的正常句子。', '这也是另一句完整长度的句子。'], { maxPieces: 99 })
  check('两个长句保持分开', two.pieces.length === 2, '段数 ' + two.pieces.length)
}

console.log('\n规则6：极端输入不崩')
{
  check('空数组返回空批次', (() => {
    const r = packWindowSentences([])
    return r.pieces.length === 0 && r.rest.length === 0
  })())
  check('全是空白返回空批次', packWindowSentences(['', '  ', '\n']).pieces.length === 0)
  // 单字符片段：不能凭空吞掉，也不能变成两段（原先写成 `pieces.length >= 0` 恒真）。
  check('单字符文本原样成段、不丢内容', (() => {
    const r = packWindowSentences(['。'])
    return r.pieces.length === 1 && r.pieces[0] === '。' && r.rest.length === 0
  })(), JSON.stringify(packWindowSentences(['。'])))
  check('超长无标点文本会被硬切', (() => {
    const r = packWindowSentences(['字'.repeat(500)], { maxPieces: 999 })
    return r.pieces.every((p) => p.length <= MAX_SENTENCE_CHARS)
  })())
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
