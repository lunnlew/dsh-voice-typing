/**
 * 客户端侧的门限测试：用**同一份共享用例表**驱动。
 *
 * 这份表（test/fixtures/gate-cases.mjs）同时驱动宿主侧与客户端侧，
 * 断言两边的行为一致。自第 3 步起算法只有**一份**（src/shared/gate.js），
 * 这张表验的从「两份实现有没有分叉」变成「两侧的常数有没有接对」。
 *
 * 分叉过的后果很具体：宿主侧曾把真实语音的低音量帧
 * （rms 0.0255 / 0.0308）挡在解码器外面，
 * 流式只认出「你好明天天怎」，整段非流式却能认出「你好，今天天气怎么样？」。
 *
 * 浏览器侧入口住在 src/client/pure/gate.js（原生 import，无需提取求值）；
 * 产物 lib/client.js 由 scripts/build-client.mjs 从同一份源码合并生成。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GATE_CASES, GATE_OPTS, GATE_INITIAL_STATE, runGateCase } from './fixtures/gate-cases.mjs'
import { advanceGate, CLIENT_GATE_OPTS } from '../src/client/pure/gate.js'
import { createGate } from '../src/shared/gate.js'

const bundled = fs.readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('门限算法是双端单源：产物里只有一份，浏览器侧只做常数注入')
// 不再断言 `function advanceGate(state, level, opts)`：advanceGate 现在是
// createGate() 的返回值（常数由两侧各自注入），esbuild 会把内层函数改名成
// advanceGate2 以免与外层 const 撞名 —— 按旧名字断言必然红，且说明不了任何问题。
check('产物里合并了 shared/gate.js（有 createGate）',
  /function createGate\(/.test(bundled))
check('产物里门限状态机只有一份（stepGate 恰好定义一次）',
  (bundled.match(/function stepGate\b/g) || []).length === 1,
  `${(bundled.match(/function stepGate\b/g) || []).length} 处 —— shared 模块被重复注入了`)
{
  // 原来这三条扫的是 `src/client/pure/gate.js` 的文本（「不含 noiseFloor * 0.95」、
  // 「import 语句从 shared 来」、「文件里写着 0.008/0.035/1」）。批次 6i，docs §8.42：
  // 这三件事的**可观察面**就是这个模块导出的那个函数跑出来是什么，于是改成真跑。
  // ① 两侧常数是**不同**的这一组（宿主是 clamp 0.01/0.045、连续 3 帧）。
  //    gate 在返回值里，所以 clamp 的上下界不用读源码就能量出来。
  const lowFloor = { ...GATE_INITIAL_STATE, noiseFloor: 0 }
  check('浏览器侧门限的下界是 0.008（底噪为零时返回的 gate 就是它）',
    advanceGate(lowFloor, 0).gate === 0.008, `gate=${advanceGate(lowFloor, 0).gate}`)
  const highFloor = { ...GATE_INITIAL_STATE, noiseFloor: 1 }
  check('浏览器侧门限的上界是 0.035（底噪顶到天才也不会超过它）',
    advanceGate(highFloor, 0).gate === 0.035, `gate=${advanceGate(highFloor, 0).gate}`)
  // ② 「连续 1 帧低就退出说话态」：同一帧音频在浏览器侧退出、在宿主侧不退。
  const speaking = { noiseFloor: 0.004, inSpeech: true, silentFrames: 0 }
  const oneQuiet = advanceGate(speaking, 0)
  check('浏览器侧 1 帧静音就退出说话态',
    oneQuiet.state.inSpeech === false, JSON.stringify(oneQuiet.state))
  check('退出说话态的那一帧照样喂（它是刚说完的最后一帧，解码器要靠它定句）',
    oneQuiet.feed === true && oneQuiet.speech === true, JSON.stringify(oneQuiet))
  const hostSide = advanceGate(speaking, 0, { minGate: 0.01, maxGate: 0.045, silentFramesToEnd: 3 })
  check('同一帧音频在宿主的常数下不退出（要连续 3 帧）—— 两侧各拿自己那组常数',
    hostSide.state.inSpeech === true, JSON.stringify(hostSide.state))
  // ③ 「没有第二份算法」不靠读文件判：把 shared 的 createGate 用同一组常数现造一份，
  //    和入口那份在**整张共享用例表**上逐帧比 {feed, gate, state}。
  //    入口改成自己重写实现而结果有任何一点不同，这里就红。
  const fresh = createGate(CLIENT_GATE_OPTS)
  let diverged = ''
  for (const c of GATE_CASES) {
    let a = { ...GATE_INITIAL_STATE }
    let b = { ...GATE_INITIAL_STATE }
    for (let k = 0; k < c.levels.length && !diverged; k++) {
      const ra = advanceGate(a, c.levels[k])
      const rb = fresh(b, c.levels[k])
      a = ra.state
      b = rb.state
      if (JSON.stringify(ra) !== JSON.stringify(rb)) {
        diverged = `${c.name} 第 ${k + 1} 帧：入口 ${JSON.stringify(ra)}，现造 ${JSON.stringify(rb)}`
      }
    }
  }
  check('入口那份与用 shared 现造的那份逐帧等价（整张用例表，含 gate 与 state）',
    diverged === '', diverged)
  // 为什么这里不判「pure/gate.js 里有没有第二份实现」：
  // 那是「同一件事不许写两遍」的仓级问题，已由 test/bundle-sync.test.mjs 的
  // 全仓反分叉扫描守（标记就是 `noiseFloor * 0.95`，范围是全部手写源码文件），
  // 覆盖面严格宽于本文件只看一个文件。真跑本身判不出「抄了一份但暂时一模一样」。
}

console.log('\n逐条跑共享用例表')
for (const c of GATE_CASES) {
  const r = runGateCase(c, advanceGate, GATE_OPTS)
  const fedOk = JSON.stringify(r.fed) === JSON.stringify(c.expectFed)
  const finalOk = !c.expectFinal
    || (r.final.inSpeech === c.expectFinal.inSpeech && r.final.silentFrames === c.expectFinal.silentFrames)
  check(c.name, fedOk && finalOk,
    !fedOk ? `feed=${JSON.stringify(r.fed)} 期望=${JSON.stringify(c.expectFed)}`
      : `final=${JSON.stringify(r.final)} 期望=${JSON.stringify(c.expectFinal)}`)
}

console.log('\nspeech 与 feed 必须恒等（两侧共用一张表的前提）')
for (const c of GATE_CASES) {
  const r = runGateCase(c, advanceGate, GATE_OPTS)
  check(`${c.name}：speech === feed`, JSON.stringify(r.speech) === JSON.stringify(r.fed))
}

console.log('\n客户端生产用的常数（clamp 0.008~0.035）也能跑同一张表')
for (const c of GATE_CASES) {
  const r = runGateCase(c, advanceGate, { ...GATE_OPTS, minGate: 0.008, maxGate: 0.035 })
  check(`${c.name}：客户端常数下结果一致`, JSON.stringify(r.fed) === JSON.stringify(c.expectFed),
    `feed=${JSON.stringify(r.fed)}`)
}

console.log('\n纯函数性质')
{
  const s0 = { ...GATE_INITIAL_STATE }
  advanceGate(s0, 0.05, GATE_OPTS)
  check('不修改传入的 state', s0.noiseFloor === GATE_INITIAL_STATE.noiseFloor
    && s0.inSpeech === GATE_INITIAL_STATE.inSpeech
    && s0.silentFrames === GATE_INITIAL_STATE.silentFrames)
  const r = advanceGate(s0, 0.05, GATE_OPTS)
  check('返回的 state 只有三个字段',
    Object.keys(r.state).sort().join(',') === 'inSpeech,noiseFloor,silentFrames',
    Object.keys(r.state).join(','))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
