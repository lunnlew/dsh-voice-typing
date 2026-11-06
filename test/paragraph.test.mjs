/**
 * 段落切分 —— `splitParagraphs` 的回归测试。
 *
 * 背景（用户反馈 2026-11-01）：
 *   「对话具有段落形式，应该按照定时取段落，然后再段落里面再取句子」
 *   —— 朗读应**先按段落收集**，段落是连贯的朗读单元，段内再按句末标点分句。
 *
 * 段落边界（与用户确认）：
 *   1. 空行（`\n\n`）—— 自然段分隔；
 *   2. 块级标记行首 —— 列表项逐项成段、引用块合并、标题独占。
 *
 * 流式语义：末尾**没有**空行的段是「未完成」的，放进 `rest` 等下一块补全
 * （或流结束时由 finally 发掉），**不**算作已完成段落。
 */
import { splitParagraphs } from '../src/host/paragraph.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

console.log('空行分自然段：\n\n 之间各成一段')
{
  const r = splitParagraphs('第一段。\n\n第二段。\n\n第三段。\n\n')
  check('三段全部完成', r.paragraphs.length === 3 && r.rest === '', JSON.stringify(r))
  check('首段正确', r.paragraphs[0] === '第一段。', r.paragraphs[0])
}

console.log('\n流式未完成：末尾无空行的段进 rest')
{
  const r = splitParagraphs('第一段。\n\n第二段还没写完')
  check('第一段完成', r.paragraphs.length === 1, JSON.stringify(r.paragraphs))
  check('第二段留作 rest', r.rest === '第二段还没写完', JSON.stringify(r.rest))
}

console.log('\n连续列表项逐项成段')
{
  const r = splitParagraphs('引言。\n- 甲\n- 乙\n- 丙\n\n结尾。')
  check('引言/甲/乙/丙各段 + 结尾 rest', r.paragraphs.length === 4 && r.rest === '结尾。', JSON.stringify(r))
  check('甲/乙/丙独立', r.paragraphs[1] === '- 甲' && r.paragraphs[2] === '- 乙' && r.paragraphs[3] === '- 丙', JSON.stringify(r.paragraphs))
}

console.log('\n有序列表逐项成段')
{
  const r = splitParagraphs('1. 第一步\n2. 第二步\n3. 第三步')
  check('前两项完成 + 第三项 rest', r.paragraphs.length === 2 && r.rest === '3. 第三步', JSON.stringify(r))
  check('编号保留', r.paragraphs[0] === '1. 第一步', r.paragraphs[0])
}

console.log('\n标题独占一段，后续正文另起段')
{
  const r = splitParagraphs('# 标题一\n正文甲。\n\n## 标题二\n正文乙。')
  check('标题一/正文甲/标题二各段 + 正文乙 rest', r.paragraphs.length === 3 && r.rest === '正文乙。', JSON.stringify(r))
  check('标题一独占', r.paragraphs[0] === '# 标题一' && r.paragraphs[1] === '正文甲。', JSON.stringify(r.paragraphs))
}

console.log('\n引用块连续行合并成一段')
{
  const r = splitParagraphs('> 引用第一行\n> 引用第二行\n\n正文。')
  check('引用块一段 + 正文 rest', r.paragraphs.length === 1 && r.paragraphs[0].includes('引用第二行') && r.rest === '正文。', JSON.stringify(r))
}

console.log('\n流式补全：上一块的 rest 与下一块合并')
{
  const a = splitParagraphs('第一段。\n\n第二段开')
  const b = splitParagraphs(a.rest + '头。\n\n第三段。')
  check('第二段补全完成', b.paragraphs[0] === '第二段开头。', JSON.stringify(b.paragraphs))
  check('第三段留 rest', b.rest === '第三段。', JSON.stringify(b.rest))
}

console.log('\n无任何段落边界：全部进 rest')
{
  const r = splitParagraphs('只有一段没有空行')
  check('整段 rest', r.paragraphs.length === 0 && r.rest === '只有一段没有空行', JSON.stringify(r))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
