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

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
