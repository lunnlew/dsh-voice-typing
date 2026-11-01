/**
 * 回归测试：定时器必须登记到登记表。
 *
 * 背景（2026-10-31）：
 *   「助手忙完后自动发送」的定时器只在组件卸载时被清，
 *   于是用户关掉麦克风后它照样在 400 毫秒后触发，
 *   把草稿**自动发了出去**。用户明明已经停了对话。
 *
 *   根因是定时器句柄分散在各自的 ref 里、各自清理、各自可能漏。
 *
 * 规则（可执行）：
 *   源码里**不允许**出现裸的 window.setTimeout / window.setInterval
 *   —— 只有定时器登记表内部和 sleep() 里可以有。
 *   这样「漏登记」会直接被静态检查抓到，而不是等到用户踩到。
 *
 * 本文件已并入原 test/timer-pairs.test.mjs 的三组不变量：
 *   清理调用的变量必须存在 / 登记表调用必须带字符串 id /
 *   识别路径的变量作用域（keptPartial、自动发送可达）。
 *   注意：原 timer-pairs 的「变量存在」检查是个**假绿**（把
 *   `hintTimerRef.current` 归一成 `current`，恰好撞上源码里无关的
 *   `const current = ...` 就永远通过）。这里改成按 ref 根名核对声明。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = fs.readFileSync(root + '/lib/client.js', 'utf8')
const lines = src.split('\n')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('登记表本身')
check('存在 createTimerRegistry', /function createTimerRegistry\(win\)/.test(src))
check('登记表有 interval / timeout / clear / clearGroup / clearAll',
  /interval\(id, fn, ms, group\)/.test(src)
  && /timeout\(id, fn, ms, group\)/.test(src)
  && /clear\(id\)/.test(src)
  && /clearGroup\(group\)/.test(src)
  && /clearAll\(\)/.test(src))
check('登记表暴露诊断接口（size / ids）',
  /size\(\)\s*\{\s*return timers\.size/.test(src) && /ids\(\)\s*\{\s*return \[\.\.\.timers\.keys\(\)\]/.test(src))

console.log('\n不允许有裸的定时器调用')
// 登记表内部的 2 处 + sleep 里的 1 处是合法的
const allowed = new Set()
lines.forEach((l, k) => {
  if (/const handle = window\.set(Timeout|Interval)\(fn, ms\)/.test(l)) allowed.add(k)
  if (/new Promise\(\(resolve\) => window\.setTimeout\(resolve, ms\)\)/.test(l)) allowed.add(k)
})
const bare = []
lines.forEach((l, k) => {
  if (allowed.has(k)) return
  if (/window\.set(Timeout|Interval)\(/.test(l)) bare.push({ line: k + 1, text: l.trim() })
})
check('没有裸的 window.setTimeout / window.setInterval',
  bare.length === 0,
  bare.map((b) => `行 ${b.line}: ${b.text.slice(0, 60)}`).join(' | '))

console.log('\n短时等待用统一的 sleep()')
check('存在 sleep 辅助函数', /function sleep\(win, ms\)/.test(src))
check('调用点都传了 window', /createTimerRegistry\(window\)/.test(src) && /sleep\(window,/.test(src), '纯函数签名改了，调用点必须同步')
check('没有直接 new Promise + setTimeout 的等待',
  !/new Promise\(\(r\) => setTimeout\(r,/.test(src),
  '这种等待没登记，会在状态复位后继续跑')

console.log('\n状态复位要按 group 清')
check('关麦时清 mic 组', /timers\.clearGroup\('mic'\)/.test(src))
check('停麦时清 send 组', /timers\.clearGroup\('send'\)/.test(src))
check('卸载时全清', /timers\.clearAll\(\)/.test(src))

console.log('\n调试快照')
check('暴露了 __DSH_VOICE_DEBUG__', /window\.__DSH_VOICE_DEBUG__ = \(\) =>/.test(src))
check('快照里能看到朗读队列长度', /queue: speakQueueRef\.current\.length/.test(src))
check('快照里能看到还挂着哪些定时器', /timers: timers\.ids\(\)/.test(src))
check('卸载时删除快照', /delete window\.__DSH_VOICE_DEBUG__/.test(src))

/* ------------------------------------------------------------------ */
/* 以下由原 test/timer-pairs.test.mjs 合并而来（独有不变量，不放丢）   */
/* ------------------------------------------------------------------ */
// 只剥注释、不剥字符串 —— 要检查「定时器 id / 清理解释表达式」的原文。
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

console.log('\n清理调用用的变量必须存在（按 ref 根名核对）')
const clears = [...code.matchAll(/window\.clear(?:Timeout|Interval)\(([^)]+)\)/g)]
check('有清理调用', clears.length > 0)
for (const m of clears) {
  const expr = m[1].trim()
  const root = expr.split('.')[0].trim()
  // 关键：不能用 expr.replace(/^ref\./,'') 之类归一化成 "current" ——
  // 源码里恰好有无关的 `const current = ...`，会让检查永远为真（原假绿）。
  const declared = new RegExp(`const\\s+${root}\\s*=\\s*useRef\\(`).test(code)
    || new RegExp(`(?:const|let|var)\\s+${root}\\b`).test(code)
  check(`清理的 ${expr} 有定义（${root} 已声明）`, declared,
    '变量不存在 → 每次都抛 ReferenceError → 这段逻辑等于没有')
}

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
