/**
 * 回归测试：SSE 监听的 effect 依赖必须稳定、每个连接都必须在 effect 的 cleanup 里关闭。
 *
 * 背景（2026-10-31）：
 *   翻译函数 `t` 原本写成裸箭头函数：
 *       const t = typeof props?.t === 'function' ? props.t : (key) => zh[key] ?? key
 *   宿主没传 props.t 时，它**每次渲染都是新函数**，引用每次都变。
 *   而监听 SSE 的 effect 依赖 [reload, t]，于是：
 *       effect 重跑 → new EventSource + void reload()
 *                → setConfig → 渲染 → t 变了 → effect 再重跑 → …
 *   结果是无限重连循环：EventSource 刚连上就被 close() 关掉，
 *   永远收不到 model-progress —— **点「下载」看不到任何进度**，
 *   同时 reload() 也在无限循环。
 *
 *   这类错 node --check 抓不到，SSR 渲染也抓不到（SSR 不跑 effect），
 *   所以在这里用静态断言锁住这个不变量。
 *
 * 本版本修正了旧实现的两个**假绿**（审计结论）：
 *   1. 旧代码用「逐字符数括号」找 effect 边界 —— 字符串/注释里的括号会干扰；
 *   2. 单行 `useEffect(() => { ... }, [deps])` 因 `k > start` 条件被**静默跳过**
 *      （永远不会给依赖做断言）。单行 effect 现在也会被检查；解析不出来的
 *      effect 直接判失败，不再 `continue` 悄悄放过。
 *   EventSource 的 cleanup 也改为「按所属 effect 的边界」匹配，
 *   不再用宽松的 250 行窗口。
 *
 * 2026-11-04 批次 6l-c：这里剩的两条**源码文本**判据（扫 `const t = typeof props`、
 *   扫 cleanup 里的 `close(`）删掉了，改由 test/client-behavior.test.mjs 的
 *   「SSE 不重连与卸载关闭」场景真的挂载 / 重渲染 / 卸载来判。
 *   余下的行不动，它们不是「扫源码找写法」，而是**解析器本身**（去注释、括号配平、
 *   依赖数组抽取）和「依赖里不许直接放 props 字段」这条结构约束 ——
 *   后者要真跑就得让宿主传一个每次渲染都变的 props，等于把这里想防的 bug 写进源码。
 *   裁定、代价与推翻条件见 docs/architecture-modernization.md §8.46（6l-c）。
 */
import { clientSource } from './helpers/client-source.mjs'

// 读**源码**（main.js 拍平 + pure/），不读 lib/client.js 产物：
// 这里的括号配平/依赖数组解析是按人类写法设计的，esbuild 的输出形态（引号、空白、
// 重排）会让 sanitize 的字符串扫描错位、一个 effect 都找不到。
const src = clientSource()

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/**
 * 把字符串 / 模板字符串 / 注释的内容替换成空格（保留换行与长度）。
 * 这样后续按括号配平找 effect 边界时，不会被字符串里的括号/反引号干扰。
 * 注意：不处理正则字面量 —— 当前客户端 effect 里没有正则；
 * 若将来有，解析会在这里显出问题（宁可报错也不要假绿）。
 */
function sanitize(code) {
  const out = code.split('')
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ' }
  let i = 0
  while (i < code.length) {
    const c = code[i]
    const c2 = code[i + 1]
    if (c === '/' && c2 === '/') {
      const e = code.indexOf('\n', i)
      const end = e < 0 ? code.length : e
      blank(i, end)
      i = end
      continue
    }
    if (c === '/' && c2 === '*') {
      const e = code.indexOf('*/', i + 2)
      const end = e < 0 ? code.length : e + 2
      blank(i, end)
      i = end
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue }
        if (code[j] === c) { j++; break }
        j++
      }
      blank(i, j)
      i = j
      continue
    }
    if (c === '`') {
      let j = i + 1
      let depth = 0
      while (j < code.length) {
        const d = code[j]
        if (d === '\\') { j += 2; continue }
        if (d === '`' && depth === 0) { j++; break }
        if (d === '$' && code[j + 1] === '{') { depth++; j += 2; continue }
        if (d === '}' && depth > 0) { depth--; j++; continue }
        j++
      }
      blank(i, j)
      i = j
      continue
    }
    i++
  }
  return out.join('')
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

/** 按括号配平，返回从 openIdx（指向 '('）开始匹配到的 ')' 的下标。 */
function matchParen(clean, openIdx) {
  let depth = 0
  for (let k = openIdx; k < clean.length; k++) {
    const ch = clean[k]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return k
    }
  }
  return -1
}

const clean = sanitize(src)

console.log('翻译函数 t 的引用必须稳定')
// 1) 所有**翻译函数**的 `const t =` 都必须用 useCallback 包。
//    只认「翻译函数 t」，不能泛匹配所有 `const t =`（定时器登记表里还有别的 t）。
{
  const tDefs = []
  const re = /^[ \t]*const t\s*=\s*(useCallback|typeof props|props\.)[^\n]*/gm
  let m
  while ((m = re.exec(src))) tDefs.push({ at: m.index, text: m[0].trim(), kind: m[1] })
  check('存在 const t = 定义', tDefs.length > 0, `找到 ${tDefs.length} 处`)
  check('所有 const t = 都用 useCallback 稳住引用',
    tDefs.every((d) => d.kind === 'useCallback'),
    tDefs.filter((d) => d.kind !== 'useCallback').map((d) => d.text).join(' | '))
}
// 「不许有裸箭头形式的 t」这条**源码文本**判据（2026-11-04 批次 6l-c 删）：
// 它真正的意思是「t 的引用变了会让 effect 反复重连」，而这件事现在由
// test/client-behavior.test.mjs 的「SSE 不重连与卸载关闭」场景直接跑出来 ——
// 假 React 里用新 props 重渲染 5 次，数 EventSource 的条数有没有跟着涨。

// 2) 每个 useEffect 都要能解析出依赖数组；依赖里不能有「每次渲染都变」的 props 字段
const effectCalls = []
{
  const re = /useEffect\s*\(/g
  let m
  while ((m = re.exec(clean))) {
    const open = clean.indexOf('(', m.index)
    const close = matchParen(clean, open)
    if (close < 0) { effectCalls.push({ start: m.index, end: -1, deps: null }); continue }
    const span = clean.slice(m.index, close + 1)
    const depsMatch = /,\s*\[([^\]]*)\]\s*\)\s*$/.exec(span)
    const deps = depsMatch ? depsMatch[1].split(',').map((d) => d.trim()).filter(Boolean) : null
    effectCalls.push({ start: m.index, end: close, deps })
  }
}
check('存在 useEffect 块', effectCalls.length > 0, `找到 ${effectCalls.length} 个`)
check('每个 useEffect 都能解析出依赖数组（解析不了就失败，不静默跳过）',
  effectCalls.every((e) => Array.isArray(e.deps)),
  effectCalls.filter((e) => !Array.isArray(e.deps))
    .map((e) => `行 ${lineOf(src, e.start)}`).join(', '))
{
  let depCount = 0
  for (const effect of effectCalls) {
    if (!Array.isArray(effect.deps)) continue
    const line = lineOf(src, effect.start)
    for (const dep of effect.deps) {
      depCount += 1
      const bad = /^props(\?|\.)/.test(dep)
      check(`行 ${line} 的 effect 依赖 "${dep}" 不是易变的 props 字段`, !bad,
        'props 每次渲染可能变，会导致 effect 反复重跑')
    }
  }
  check('effect 依赖全部检查到（非空扫描）', depCount > 0, `共 ${depCount} 个依赖项`)
}

// 3) SSE 的 EventSource 必须在**所属 effect** 的 cleanup 里被 close()
//    要检查每一个 EventSource —— 之前只看第一个，后来的连接漏关发现不了。
{
  const sseAt = []
  const re = /new EventSource/g
  let m
  while ((m = re.exec(clean))) sseAt.push(m.index)
  check('有 EventSource 连接', sseAt.length > 0)
  check('至少有两个 EventSource（麦克风按钮 + 设置面板）', sseAt.length >= 2,
    `找到 ${sseAt.length} 个`)

  for (const at of sseAt) {
    const line = lineOf(src, at)
    const host = effectCalls.find((e) => e.end > at && e.start < at)
    check(`行 ${line} 的 EventSource 在 effect 里创建`, Boolean(host),
      '在 effect 外创建 = 没有 cleanup 机会，组件卸载后连接还在')
    // 「所属 effect 的 cleanup 里 close()」这条**源码文本**判据（2026-11-04 批次 6l-c 删）：
    // 它靠正则认 `return () => …close(`，写法一变就误报、写成别的合法清理又漏报。
    // 现在由 client-behavior 的同一个场景判行为：unmount() 后 env.eventSources
    // 里每条都该 closed === true，摘掉 close() 当场变红（实测见 docs §8.46）。
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
