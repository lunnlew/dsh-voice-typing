/**
 * 朗读高亮的纯匹配逻辑测试。
 *
 * 纯函数住在 src/client/pure/highlight.js，**原生 import** 即可
 * （它们只碰字符串，不依赖浏览器 DOM）。
 * 产物 lib/client.js 由 scripts/bundle-client.mjs 从同一份源码内联生成，
 * bundle-sync.test.mjs 会校验两者同步。
 *
 * 这里覆盖「把宿主的纯文本句对齐到渲染后的 DOM 文本」这条链的
 * 字符串层：SSML 还原、空白归一化、跨节点匹配、错位降级。
 */
import {
  unescapeSpeechText,
  normalizeRun,
  collapseWhitespace,
  matchInNodes,
} from '../src/client/pure/highlight.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('unescapeSpeechText —— 反转 stripForSpeech 的 SSML 转义')
{
  check('&amp; → &', unescapeSpeechText('a &amp; b') === 'a & b')
  check('&lt; → <', unescapeSpeechText('a &lt; b') === 'a < b')
  check('&gt; → >', unescapeSpeechText('a &gt; b') === 'a > b')
  check('&quot; → "', unescapeSpeechText('&quot;x&quot;') === '"x"')
  check('&#39; → \'', unescapeSpeechText('&#39;x&#39;') === "'x'")
  check('普通文本原样', unescapeSpeechText('hello') === 'hello')
  check('空串', unescapeSpeechText('') === '')
  check('非字符串（null）', unescapeSpeechText(null) === '')
}

console.log('\nnormalizeRun —— 空白串折叠成单个空格并保留原文区间')
{
  const r = normalizeRun('a\u00a0 b')
  check('折叠后是 a b', r.text === 'a b', r.text)
  check('三段字符（a 空格 b）', r.map.length === 3, r.map)
  check('nbsp+空格折叠成 len=2', r.map[1].len === 2, r.map[1])
  check('普通字符 len=1', r.map[0].len === 1, r.map[0])
  const r2 = normalizeRun('   ')
  check('纯空白折叠成一个空格', r2.text === ' ', r2.text)
  const r3 = normalizeRun('abc')
  check('无空白原样', r3.text === 'abc', r3.text)
}

console.log('\ncollapseWhitespace —— 幂等折叠目标句空白')
{
  check('折叠多种空白', collapseWhitespace('a\u00a0\t b\r\n c') === 'a b c')
  check('首尾 trim', collapseWhitespace('  a  ') === 'a')
  check('普通文本不变', collapseWhitespace('今天天气') === '今天天气')
}

console.log('\nmatchInNodes —— 单节点命中')
{
  let r = matchInNodes(['今天天气怎么样'], '今天天气怎么样')
  check('整句精确命中', r && r.length === 1 && r[0].nodeIndex === 0 && r[0].start === 0 && r[0].end === 7, r)
  r = matchInNodes(['你好。今天天气怎么样？再见'], '今天天气怎么样')
  check('段落内子串命中', r && r[0].start === 3 && r[0].end === 10, r)
  r = matchInNodes(['第一句。第二句很长很长。第三句。'], '第二句很长很长')
  check('句中段命中（偏移正确）', r && r[0].start === 4 && r[0].end === 11, r)
}

console.log('\nmatchInNodes —— 跨节点命中')
{
  const r = matchInNodes(['今天天气', '怎么样'], '今天天气怎么样')
  check('跨两个文本节点', r && r.length === 2
    && r[0].nodeIndex === 0 && r[0].start === 0 && r[0].end === 4
    && r[1].nodeIndex === 1 && r[1].start === 0 && r[1].end === 3, r)
}

console.log('\nmatchInNodes —— 空白/实体差异')
{
  // DOM 里 nbsp + 空格折叠成一个空格，目标里也是空格 → 命中。
  let r = matchInNodes(['今天\u00a0天气 怎么样'], '今天 天气 怎么样')
  check('nbsp 折叠后命中', r && r.length === 1 && r[0].start === 0 && r[0].end === 9, r)
  // DOM 里软换行（渲染成空格），目标里有空格 → 命中。
  r = matchInNodes(['第一行\n第二行'], '第一行 第二行')
  check('软换行当作空格命中', r && r.length === 1, r)
  // 目标带 SSML 转义，DOM 里是还原后的字符 → 命中。
  r = matchInNodes(['a < b'], 'a &lt; b')
  check('转义目标还原后命中', r && r.length === 1 && r[0].start === 0 && r[0].end === 5, r)
}

console.log('\nmatchInNodes —— 错位/无命中返回 null（降级为整段高亮）')
{
  // DOM 有空格但目标没有 → 真错位，必须返回 null，让调用方降级。
  let r = matchInNodes(['今天\u00a0天气 怎么样'], '今天天气怎么样')
  check('空白不一致返回 null', r === null, r)
  r = matchInNodes(['完全不同的内容'], '今天天气怎么样')
  check('完全不匹配返回 null', r === null, r)
  r = matchInNodes([], 'x')
  check('空节点列表返回 null', r === null, r)
  r = matchInNodes(['abc'], '')
  check('空目标返回 null', r === null, r)
  r = matchInNodes(['abc'], '   ')
  check('全空白目标返回 null', r === null, r)
}

console.log('\n纯函数性质：不修改入参')
{
  const texts = ['a', 'b']
  const before = JSON.stringify(texts)
  matchInNodes(texts, 'a b')
  check('matchInNodes 不修改入参数组', JSON.stringify(texts) === before)
  const raw = 'a b'
  const nr = normalizeRun(raw)
  check('normalizeRun 不修改入参', raw === 'a b')
  check('collapseWhitespace 不修改入参', (() => { const s = ' a '; collapseWhitespace(s); return s === ' a ' })())
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
