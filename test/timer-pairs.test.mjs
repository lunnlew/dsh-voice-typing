/**
 * 回归测试：定时器「设置」与「清理」必须成对，且清理的变量必须存在。
 *
 * 背景（2026-10-31）：
 *   把 `window.setTimeout` 改成登记表的 `timers.timeout` 时，
 *   **漏改了对应的清理代码**：
 *
 *     const timer = window.setTimeout(...)      ← 改成 timers.timeout 后这行没了
 *     ...
 *     } finally {
 *       window.clearTimeout(timer)              ← timer 变量已经不存在了
 *     }
 *
 *   后果非常隐蔽：
 *     识别请求成功 → finally 里抛 ReferenceError → 进 catch →
 *     catch 又要用 keptPartial（定义在 try 块内部，取不到）→ 再抛一次 →
 *     **识别之后的整段逻辑都没执行**（包括「自动发送」）。
 *
 *     症状是「文字出现在输入框里，但永远不自动发送」，
 *     而且控制台里只有两条看不懂的 ReferenceError。
 *
 * 规则（可执行）：
 *   1. `window.clearTimeout(X)` / `window.clearInterval(X)` 里的 X 必须有定义；
 *   2. 定时器要么走登记表（timers.*），要么成对地用裸 API；
 *   3. 源码里不该再有裸的 `window.setTimeout` / `window.setInterval`。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = fs.readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
/**
 * 剥离注释，避免把注释里的例子当成真代码。
 *
 * 只剥注释、**不剥字符串** —— 剥了字符串就没法检查「定时器 id 是字面量」了。
 */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('清理用的变量必须存在')
const clears = [...code.matchAll(/window\.clear(?:Timeout|Interval)\(([^)]+)\)/g)]
check('有清理调用', clears.length > 0)
for (const m of clears) {
  const expr = m[1].trim()
  const name = expr.replace(/^[a-zA-Z_$][\w$]*\./, '')
  const defined = new RegExp(`(const|let|var)\\s+${name}\\b`).test(code)
  check(`清理的 ${expr} 有定义`, defined,
    '变量不存在 → 每次都抛 ReferenceError → 这段逻辑等于没有')
}

console.log('\n不该再有裸的定时器设置（必须走登记表）')
const bareTimers = [...code.matchAll(/window\.set(?:Timeout|Interval)\s*\(/g)]
check('没有裸的 window.setTimeout/setInterval', bareTimers.length === 0,
  `${bareTimers.length} 处 —— 跨状态存活的定时器必须登记，否则关麦后还会触发`)

console.log('\n登记表的调用必须带 id')
for (const m of code.matchAll(/timers\.(timeout|interval)\(\s*([^,)]+)/g)) {
  const id = m[2].trim()
  check(`timers.${m[1]} 的 id 是字符串字面量`, /^['"][^'"]+['"]$/.test(id), id)
}

console.log('\n关键不变量：识别路径上的变量作用域')
{
  // keptPartial 必须在 try 之前取，否则 catch 里拿不到
  const idx = code.indexOf('const keptPartial = livePartialRef.current')
  const tryIdx = code.indexOf('try {', code.indexOf('const transcribeSegment'))
  check('keptPartial 在 try 之前取', idx >= 0 && tryIdx >= 0 && idx < tryIdx,
    '定义在 try 块内部的话，catch 里会抛 ReferenceError')
  // catch 里用得到它
  const catchIdx = code.indexOf('catch (error)', tryIdx)
  const useIdx = code.indexOf('keptPartial', catchIdx)
  check('catch 分支能拿到 keptPartial', useIdx > catchIdx)
}

console.log('\n识别结束后的「自动发送」逻辑必须能走到')
{
  const t = code.indexOf('const transcribeSegment')
  const autoSend = code.indexOf("configRef.current.autoSend !== false", t)
  const catchIdx = code.indexOf('catch (error)', t)
  check('自动发送的判断在 catch 之前（异常时也能走）', autoSend > 0 && autoSend < catchIdx,
    '放在 catch 之后的话，识别失败就永远不发送')
  check('自动发送会调用 submit', /inputActions\?\.submit\?\.\(\)/.test(code.slice(t, catchIdx + 2000)))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
