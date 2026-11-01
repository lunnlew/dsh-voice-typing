/**
 * 列表标记不能当句子朗读。
 *
 * 用户反馈：「对于有序列表或者无序列表，还会把编号作为简短的一个句子。」
 *
 * 根因：`splitSentenceParts` 的句界规则是「中文句末标点」或「英文句号后跟空白」，
 * 于是 `1. 第一步是安装依赖。` 里的 `1. ` 被判成句子结束 ——
 * `"1."` 单独成为一个片段，被当成一句话送去合成。
 *
 * 另外 `stripForSpeech` 也没清掉中文编号（`一、`），
 * 于是会念出「一、第一项」。
 */
import { stripForSpeech, splitSentenceParts } from '../lib/speech-clean.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

console.log('有序列表：编号不能单独成句')
for (const [label, text] of [
  ['1. 形式', '1. 第一步是安装依赖。\n2. 第二步是配置环境。\n3. 第三步启动。'],
  ['1) 形式', '1) 有序括号项。\n2) 第二个括号项。'],
]) {
  const { parts, rest } = splitSentenceParts(text)
  const all = [...parts, rest]
  const bareNumber = all.filter((p) => /^\s*\d{1,3}[.)]\s*$/.test(p))
  check(`${label}：没有「纯编号」片段`, bareNumber.length === 0, JSON.stringify(bareNumber))
  const joined = all.join('')
  check(`${label}：内容没丢`, joined.replace(/\s/g, '') === text.replace(/\s/g, ''))
}

console.log('\n无序列表：符号不能单独成句')
{
  const text = '- 苹果\n- 香蕉\n- 橘子'
  const { parts, rest } = splitSentenceParts(text)
  const all = [...parts, rest]
  const bareBullet = all.filter((p) => /^\s*[-*+]\s*$/.test(p))
  check('没有「纯符号」片段', bareBullet.length === 0, JSON.stringify(bareBullet))
  check('清洗后不含列表符号', !stripForSpeech(text).includes('- '), stripForSpeech(text))
}

console.log('\n清洗：编号前缀要删掉')
for (const [label, input, expectNo, expectKeep] of [
  ['阿拉伯 1.', '1. 第一步是安装依赖。', '1.', '第一步是安装依赖'],
  ['阿拉伯 1)', '1) 第一步。', '1)', '第一步'],
  ['中文 一、', '一、第一项内容。', '一、', '第一项内容'],
  ['中文 十、', '十、第十项内容。', '十、', '第十项内容'],
  ['中文 十一、', '十一、第十一项。', '十一、', '第十一项'],
]) {
  const out = stripForSpeech(input)
  check(`${label}：编号被删掉`, !out.startsWith(expectNo), out)
  check(`${label}：正文保留`, out.includes(expectKeep), out)
}

console.log('\n不能误伤正文里的数字')
for (const text of [
  '这是正文，1.5 倍速不要删。',
  '增长率为 3.14 左右。',
  '请注意「一、二、三」这几个数字。',
  '版本 2.0 已发布。',
]) {
  const out = stripForSpeech(text)
  check(`正文不被误删：${text.slice(0, 12)}`, out.replace(/\s/g, '') === text.replace(/\s/g, ''), out)
}

console.log('\n列表项的整句仍然完整（不因去编号而断裂）')
{
  const text = '1. 第一步是安装依赖。\n2. 第二步是配置环境。'
  const cleaned = stripForSpeech(text)
  const lines = cleaned.split('\n').filter(Boolean)
  check('两个列表项各成一句', lines.length === 2, JSON.stringify(lines))
  check('每句都以句号结尾（完整句）', lines.every((l) => l.endsWith('。')), JSON.stringify(lines))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
