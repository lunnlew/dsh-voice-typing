/**
 * 回归测试：SSE 监听的 effect 依赖必须稳定。
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
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const src = fs.readFileSync(file, 'utf8')
const lines = src.split('\n')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('翻译函数 t 的引用必须稳定')
// 1) 所有**翻译函数**的 `const t =` 都必须用 useCallback 包。
//    注意：只认「翻译函数 t」，不能泛匹配所有 `const t =`
//    —— 定时器登记表里也有 `const t = timers.get(id)`，那是另一个东西。
const tDefs = lines.filter((l) => /^\s*const t\s*=\s*useCallback\b/.test(l)
  || /^\s*const t\s*=\s*typeof props/.test(l)
  || /^\s*const t\s*=\s*props\./.test(l))
check('存在 const t = 定义', tDefs.length > 0, `找到 ${tDefs.length} 处`)
for (const def of tDefs) {
  const indent = def.match(/^\s*/)[0].length
  const next = lines[lines.indexOf(def) + 1] ?? ''
  const usesCallback = /useCallback\s*\(/.test(def) || /useCallback\s*\(/.test(next)
  check('const t = 用 useCallback 稳住引用', usesCallback, def.trim().slice(0, 60))
}
check(
  '没有裸箭头函数形式的 t',
  !/const t = typeof props/.test(src),
  '裸箭头每次渲染都是新引用，会让依赖它的 effect 反复重跑',
)

// 2) useEffect 的依赖里不能有「每次渲染都变」的裸值
const effectBlocks = []
lines.forEach((l, i) => {
  if (/^\s*useEffect\s*\(\s*\(\)\s*=>\s*\{/.test(l)) effectBlocks.push(i)
})
check('存在 useEffect 块', effectBlocks.length > 0, `找到 ${effectBlocks.length} 个`)

for (const start of effectBlocks) {
  // 找到这个 effect 的依赖数组
  let depth = 0
  let end = -1
  for (let k = start; k < lines.length; k++) {
    for (const ch of lines[k]) { if (ch === '(' || ch === '{' || ch === '[') depth++; if (ch === ')' || ch === '}' || ch === ']') depth-- }
    if (depth <= 0 && k > start) { end = k; break }
  }
  if (end < 0) continue
  const depsLine = lines[end]
  const m = depsLine.match(/\},?\s*\[([^\]]*)\]/)
  if (!m) continue
  const deps = m[1].split(',').map((d) => d.trim()).filter(Boolean)
  for (const dep of deps) {
    // 依赖里不能直接出现 props.xxx（每次渲染都可能变）
    const bad = /^props(\?|\.)/.test(dep)
    check(`effect 依赖 "${dep}" 不是易变的 props 字段`, !bad, 'props 每次渲染可能变，会导致 effect 反复重跑')
  }
}

// 3) SSE 的 EventSource 必须在 effect 的 cleanup 里被关掉
//    要检查**每一个** EventSource —— 之前只看第一个，
//    后面的连接漏关也不会被发现（评审时专门提过这条）。
const sseIdx = lines.findIndex((l) => l.includes('new EventSource'))
check('有 EventSource 连接', sseIdx >= 0)
{
  const ssePositions = []
  lines.forEach((l, k) => { if (l.includes('new EventSource')) ssePositions.push(k) })
  check('至少有两个 EventSource（麦克风按钮 + 设置面板）', ssePositions.length >= 2,
    `找到 ${ssePositions.length} 个`)
  for (const pos of ssePositions) {
    // 从这个连接往后找它的 cleanup（窗口放宽到 250 行，
    // 因为一个 effect 里可能挂好几个监听器）
    const window = lines.slice(pos, pos + 250).join('\n')
    check(`行 ${pos + 1} 的 EventSource 在 cleanup 里被 close()`,
      /return \(\) => source\.close\(\)/.test(window),
      '不关的话组件卸载后连接还在，事件会打到已卸载的组件上')
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
