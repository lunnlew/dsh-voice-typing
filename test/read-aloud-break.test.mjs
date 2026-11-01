/**
 * 朗读断句 —— `findSentenceBreak` 的回归测试。
 *
 * 背景（用户反馈）：
 *   「朗读时可能在词汇中间断开，也可能在句子中间断开，不是识别了一个完整的句子」
 *
 * 根因（2026-11-01 复现确认）：
 *   旧 `findSentenceBreak` 只认逗号/顿号/分号/冒号/空格（**没有句末标点**），
 *   于是「This is a normal sentence.」这种有句号的句子会优先在**空格**处切，
 *   造成句子中间断开；而 `preferSpace:false` 的首句切分直接 15 字硬切，
 *   把英文单词/标识符（如 `transformData`、`processData`）从中间劈开。
 *
 * 修复后（`lib/speech-clean.js`）：
 *   句末标点优先（含英文句号，且 `.` 须后跟空白/行尾，避免误切 1.5 / 3.14）；
 *   其次句内标点/空格（单词边界）；硬切**始终**回退最近空格，绝不劈英文词。
 *
 * `findSentenceBreak` 是**贪心**切分：取「离切点最近」的标点（在 windowLen 内尽量
 * 切长的一段），所以断言的是「切点落在完整句/单词边界」，而非「切在第一个标点」。
 */
import { findSentenceBreak } from '../lib/speech-clean.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

// 切点是否落在「英文单词中间」（前后都是词字符）。
const inWordMiddle = (text, at) => {
  const a = text[at - 1] ?? ''
  const b = text[at] ?? ''
  return /[A-Za-z0-9_]/.test(a) && /[A-Za-z0-9_]/.test(b)
}
// 切点是否落在句子中间（切出的段既不以句末标点结尾，又以标点结尾但还有后续内容）。
const SENTENCE_END = /[。！？!?；;.]$/

console.log('有句号：切在句末标点后，切出的段是完整句（不切半句）')
{
  const text = 'This is a normal sentence. Another complete one here.'
  const at = findSentenceBreak(text, { windowLen: 120, minBreak: 20, fallbackLen: 60 })
  const seg = text.slice(0, at)
  check('切出的段以句号结尾（完整句）', SENTENCE_END.test(seg), JSON.stringify(seg))
  check('切点不是半句（段后还有内容且段尾是句号）',
    SENTENCE_END.test(seg) && at > 20, 'at=' + at + ' 段=' + JSON.stringify(seg))
}

console.log('\n中文句末标点：切在句号后')
{
  const text = '这是第一句话。这是第二句话，后面还有内容。'
  const at = findSentenceBreak(text, { windowLen: 120, minBreak: 6, fallbackLen: 40 })
  const seg = text.slice(0, at)
  check('切出的段以句号结尾', SENTENCE_END.test(seg), JSON.stringify(seg))
}

console.log('\n英文句号不误切小数（1.5 / 3.14 / example.com 里的点不算句界）')
{
  const text = 'The version is 3.14 and the ratio is 1.5 percent.'
  const at = findSentenceBreak(text, { windowLen: 120, minBreak: 20, fallbackLen: 60 })
  const seg = text.slice(0, at)
  // 唯一合法的英文句号是句末那个（...percent.）—— 切出的段应以它结尾。
  check('不误切小数里的点（切在句末句号后）', SENTENCE_END.test(seg), JSON.stringify(seg))
}

console.log('\n无句号但有空格：切在单词边界，绝不劈开英文单词/标识符')
{
  const cases = [
    'The function transformData is called and then we proceed to the next step.',
    '第一段说英文调用 processData 函数并返回结果继续讨论这个问题。',
    'Thequickbrownfox jumpsoverthelazydog Thequickbrownfoxjumpsoverthelazydog.',
  ]
  for (const text of cases) {
    const at = findSentenceBreak(text, { windowLen: 120, minBreak: 20, fallbackLen: 60 })
    check('不劈英文单词：' + text.slice(0, 22),
      !inWordMiddle(text, at), 'at=' + at + ' 段=' + JSON.stringify(text.slice(0, at)))
  }
}

console.log('\n硬切回退最近空格：fallbackLen 落在单词中间时回退到空格')
{
  // 每段 10 字母 + 空格。fallbackLen=60 正好落在某个 10 字母段的中间 → 应回退到前一个空格。
  const text = 'abcdefghij '.repeat(10) // 共 110 字
  const at = findSentenceBreak(text, { windowLen: 200, minBreak: 20, fallbackLen: 60 })
  check('回退到空格（不在单词中间）', !inWordMiddle(text, at), 'at=' + at)
  check('切点是空格后的位置', text[at - 1] === ' ', 'at=' + at + ' 段尾=' + JSON.stringify(text[at - 1]))
}

console.log('\n无标点无空格（纯中文长串）：只能硬切到 fallbackLen')
{
  const text = '这是一个非常非常长的中文句子没有任何标点'.repeat(4)
  const at = findSentenceBreak(text, { windowLen: 120, minBreak: 20, fallbackLen: 60 })
  check('硬切到 fallbackLen', at === 60, 'at=' + at)
  check('首段不超 fallbackLen', text.slice(0, at).length <= 60, String(text.slice(0, at).length))
}

console.log('\n首句切分（新参数）：有句号时等完整句，不 15 字就切半句')
{
  // 首句切分现在用 {windowLen:80, minBreak:10, fallbackLen:40}。
  const text = 'This is a normal sentence.'
  const at = findSentenceBreak(text, { windowLen: 80, minBreak: 10, fallbackLen: 40 })
  const seg = text.slice(0, at)
  check('首句切在句号后（完整句）', SENTENCE_END.test(seg) && seg === text, 'at=' + at + ' 段=' + JSON.stringify(seg))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
