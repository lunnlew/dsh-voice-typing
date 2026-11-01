/**
 * lib/fence-filter.js 单测：流式代码围栏过滤器。
 *
 * 覆盖：
 *   1. 基本围栏（正文→围栏→正文）；
 *   2. **跨 chunk 被切开的围栏标记**（"``"+"`"、"`"+"``"、"~~"+"~"…），
 *      包括「任意切分点」的穷举（把同一段回复在每一个位置切成两块/三块）；
 *   3. 围栏长度 >=3、闭合长度 >= 开启长度；
 *   4. 行内单/双反引号、`~~删除线~~` 必须原样返回（不能误吞正文）；
 *   5. 未闭合围栏：前的正文保留、围栏内内容丢弃；
 *   6. flush 的尾字符判定（孤立反引号返回、未成围栏的 run 丢弃）；
 *   7. 与基线端到端复现一致的 4 字符切块用例（真实缺陷的最小复现）。
 *
 * 运行：node test/fence-filter.test.mjs
 */
import { createFenceFilter } from '../lib/fence-filter.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 按固定字符数切块。 */
function byChars(text, n) {
  const out = []
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n))
  return out
}

/** 把 chunks 依次喂给一个新过滤器，返回 push 输出 + flush 尾字符的拼接。 */
function feed(chunks) {
  const fence = createFenceFilter()
  let out = ''
  for (const chunk of chunks) out += fence.push(chunk)
  out += fence.flush()
  return out
}

/** 逐字符切块（最极端：每个字符一块）。 */
const byChar = (text) => text.split('')

/** 基线最小复现用的回复（README/任务里给的原文）。 */
const FENCE_REPLY =
  '下面是一段示例代码：\n```js\nconst x = 1\nconsole.log(x)\n```\n代码执行完之后会输出结果。'
/** 剔除围栏（含标记与 info string）后的期望正文。 */
const FENCE_REPLY_BODY = '下面是一段示例代码：\n\n代码执行完之后会输出结果。'

console.log('== 1. 基本围栏：一次 push 就完整到达 ==')
{
  const out = feed([FENCE_REPLY])
  check('正文完整保留', out === FENCE_REPLY_BODY, JSON.stringify(out))
  check('代码与围栏标记/ info string 都没漏出来',
    !out.includes('const') && !out.includes('console') && !out.includes('```') && !out.includes('js\n'),
    JSON.stringify(out))
}

console.log('\n== 2. 跨 chunk 被切开的围栏标记（手动构造的关键切法）==')
{
  // "``" + "`js..." / "`" + "``js..." / "```" 后面再补一个反引号
  const splits = [
    ['下面是一段示例代码：\n``', '`js\nconst x = 1\nconsole.log(x)\n```\n代码执行完之后会输出结果。'],
    ['下面是一段示例代码：\n`', '``js\nconst x = 1\nconsole.log(x)\n``', '`\n代码执行完之后会输出结果。'],
    ['下面是一段示例代码：\n```', 'js\nconst x = 1\nconsole.log(x)\n``', '`\n代码执行完之后会输出结果。'],
    ['下面是一段示例代码：\n```js\nconst x = 1\n```', '\n代码执行完之后会输出结果。'],
  ]
  for (let i = 0; i < splits.length; i++) {
    const out = feed(splits[i])
    check('切法#' + (i + 1) + ' 正文完整',
      out.includes('下面是一段示例代码：') && out.includes('代码执行完之后会输出结果。'),
      JSON.stringify(out))
    check('切法#' + (i + 1) + ' 代码没漏',
      !out.includes('const') && !out.includes('console') && !out.includes('js\n'),
      JSON.stringify(out))
  }
}

console.log('\n== 3. 任意切分点穷举：同一段回复在每一个位置切成 2 块 ==')
{
  let bad = 0
  let sample = ''
  for (let k = 1; k < FENCE_REPLY.length; k++) {
    const out = feed([FENCE_REPLY.slice(0, k), FENCE_REPLY.slice(k)])
    if (out !== FENCE_REPLY_BODY) {
      bad++
      if (!sample) sample = '切点 ' + k + ' → ' + JSON.stringify(out)
    }
  }
  check('所有 2 块切法输出都等于期望正文', bad === 0, `${bad} 个切点不符；例如 ${sample}`)

  let badLeak = 0
  for (let k = 1; k < FENCE_REPLY.length; k++) {
    const out = feed([FENCE_REPLY.slice(0, k), FENCE_REPLY.slice(k)])
    if (out.includes('const') || out.includes('console')) badLeak++
  }
  check('所有 2 块切法都没有漏出代码', badLeak === 0, `${badLeak} 个切点漏代码`)
}

console.log('\n== 4. 任意切分点穷举：切成 3 块 ==')
{
  let bad = 0
  let sample = ''
  for (let k1 = 1; k1 < FENCE_REPLY.length; k1++) {
    for (let k2 = k1 + 1; k2 < FENCE_REPLY.length; k2++) {
      const out = feed([
        FENCE_REPLY.slice(0, k1),
        FENCE_REPLY.slice(k1, k2),
        FENCE_REPLY.slice(k2),
      ])
      if (out !== FENCE_REPLY_BODY) {
        bad++
        if (!sample) sample = `切点 ${k1},${k2} → ` + JSON.stringify(out)
      }
    }
  }
  check('所有 3 块切法输出都等于期望正文', bad === 0, `${bad} 种切法不符；例如 ${sample}`)
}

console.log('\n== 5. 固定粒度切块（含 1 字符 = 每个反引号单独到达）==')
{
  for (const size of [1, 2, 3, 4, 5, 7, 20]) {
    const out = feed(byChars(FENCE_REPLY, size))
    check(`按 ${size} 字符切块：正文完整且代码不漏`,
      out === FENCE_REPLY_BODY, JSON.stringify(out))
  }
  const out = feed(byChar(FENCE_REPLY))
  check('逐字符切块：正文完整且代码不漏', out === FENCE_REPLY_BODY, JSON.stringify(out))
}

console.log('\n== 6. 行内反引号 / 删除线：原样返回，不能误吞正文 ==')
{
  const inline = '请把 `foo()` 改成 `bar()`，两个反引号 `` 不算围栏，~~删除线~~ 也一样。'
  const out1 = feed([inline])
  check('整块到达时行内反引号原样返回', out1 === inline, JSON.stringify(out1))

  // 逐字符切块也要一字不差（行内反引号会被当成「未决 run」暂存再吐出）。
  const out2 = feed(byChar(inline))
  check('逐字符切块时行内反引号原样返回', out2 === inline, JSON.stringify(out2))

  const out3 = feed(byChars(inline, 3))
  check('按 3 字符切块时行内反引号原样返回', out3 === inline, JSON.stringify(out3))
}

console.log('\n== 7. 波浪线围栏（~~~）与跨 chunk 切开的 ~~~ ==')
{
  const oneShot = feed(['前文。\n~~~\ncode();\n~~~\n后文。'])
  check('~~~ 围栏：正文保留、代码丢弃',
    oneShot === '前文。\n\n后文。', JSON.stringify(oneShot))

  // "~~" + "~" 切开
  const split = feed(['前文。\n~~', '~\ncode();\n~~', '~\n后文。'])
  check('~~~ 被切块：正文保留、代码丢弃',
    split === '前文。\n\n后文。', JSON.stringify(split))

  check('波浪线围栏不会漏出代码', !split.includes('code()'), JSON.stringify(split))
}

console.log('\n== 8. 围栏长度规则：开启 4 个、闭合只有 3 个 → 不算闭合 ==')
{
  const out = feed([
    '正文。\n````\n代码行\n',
    '```\n更多代码\n',
    '````\n尾文。',
  ])
  check('闭合长度不足时不闭合（代码继续丢弃）',
    out === '正文。\n\n尾文。', JSON.stringify(out))
  check('闭合长度不足时没有代码漏出',
    !out.includes('代码行') && !out.includes('更多代码'), JSON.stringify(out))
}

console.log('\n== 9. 未闭合围栏（回复被中断）==')
{
  const fence = createFenceFilter()
  const head = fence.push('正常开头。\n```js\n')
  check('未闭合围栏：之前的正文保留', head === '正常开头。\n', JSON.stringify(head))
  const more = fence.push('const a = 1;\nconst b = 2;\n')
  check('未闭合围栏：围栏内内容不返回', more === '', JSON.stringify(more))
  check('未闭合围栏：isInFence=true', fence.isInFence() === true)
  const tail = fence.flush()
  check('未闭合围栏：flush 不吐出代码', tail === '', JSON.stringify(tail))
  check('未闭合围栏：flush 之后状态复位', fence.isInFence() === false)
}

console.log('\n== 10. flush 尾字符判定 ==')
{
  {
    const fence = createFenceFilter()
    const a = fence.push('正文 `')
    const b = fence.flush()
    check('行尾孤立反引号：push 先暂存', a === '正文 ', JSON.stringify(a))
    check('行尾孤立反引号：flush 交还', b === '`', JSON.stringify(b))
  }
  {
    const fence = createFenceFilter()
    const a = fence.push('正文 ``')
    const b = fence.flush()
    check('行尾两个反引号：flush 交还 ``', a === '正文 ' && b === '``', JSON.stringify(a + '|' + b))
  }
  {
    const fence = createFenceFilter()
    const a = fence.push('正文```')
    const b = fence.flush()
    check('行尾三个反引号：视为未闭合围栏起始 → 丢弃（正文保留）',
      a === '正文' && b === '', JSON.stringify(a + '|' + b))
  }
  {
    const fence = createFenceFilter()
    check('空输入不会破坏暂存状态',
      fence.push('x `') === 'x ' && fence.push('') === '' && fence.push('y') === '`y',
      JSON.stringify([fence.push('')]))
  }
}

console.log('\n== 11. 围栏在行中间（与旧实现等价：任意位置出现围栏都生效）==')
{
  const out = feed(['前文```js\ncode\n```后文'])
  check('行中围栏：前后正文都保留、代码丢弃', out === '前文后文', JSON.stringify(out))
}

console.log('\n== 12. 无围栏文本：完整透传（一字不差）==')
{
  const plain = '这是普通的一句话。第二句没有任何标记，也没有代码。'
  check('无围栏文本透传', feed([plain]) === plain)
  check('无围栏文本逐字符切块透传', feed(byChar(plain)) === plain)

  // 表格式内容里的 `|` 不应被过滤器处理（不是它的职责）。
  const table = '| 名称 | 版本 |\n| --- | --- |'
  check('表格文本透传', feed([table]) === table)
}

console.log('\n== 13. `~~~` 围栏必须行首：正文里的 3 个连续 ~ 不能吞后文 ==')
{
  // 评审 P2-4：`~~~` 是本次新支持的围栏；如果不要求行首，正文里出现
  // "~~~ 第二段" 这类写法会把后面整段内容静默吞掉。
  const plain = '第一段内容。~~~ 第二段内容。第三段内容。'
  const once = feed([plain])
  check('行中的 ~~~ 当普通文本（不吞后文）',
    once.includes('第二段内容') && once.includes('第三段内容'), JSON.stringify(once))

  // 行首的 ~~~ 仍然是围栏（跨 chunk 切开也要识别）。
  const a = '第一段。\n~~'
  const b = '~\n代码内容a\n~~'
  const c = '~\n第二段。'
  const fence = createFenceFilter()
  const out = fence.push(a) + fence.push(b) + fence.push(c) + fence.flush()
  check('行首 ~~~ 是围栏：正文保留、代码不念',
    out.includes('第一段') && out.includes('第二段。') && !out.includes('代码内容a'),
    JSON.stringify(out))
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exitCode = fail ? 1 : 0
process.exit(fail ? 1 : 0)
