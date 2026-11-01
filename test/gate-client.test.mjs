/**
 * 客户端侧的门限测试：用**同一份共享用例表**驱动。
 *
 * 这份表（test/fixtures/gate-cases.mjs）同时驱动宿主侧与客户端侧，
 * 断言两边的行为一致 —— 防止「同一判据两处实现」分叉。
 *
 * 分叉过的后果很具体：宿主侧曾把真实语音的低音量帧
 * （rms 0.0255 / 0.0308）挡在解码器外面，
 * 流式只认出「你好明天天怎」，整段非流式却能认出「你好，今天天气怎么样？」。
 *
 * 客户端的实现住在 src/client/pure/gate.js（原生 import，无需提取求值）；
 * 产物 lib/client.js 由 scripts/bundle-client.mjs 从同一份源码内联生成。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GATE_CASES, GATE_OPTS, GATE_INITIAL_STATE, runGateCase } from './fixtures/gate-cases.mjs'
import { advanceGate } from '../src/client/pure/gate.js'

const bundled = fs.readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('产物与源文件一致')
check('lib/client.js 内联了门限实现',
  /function advanceGate\(state, level, opts\)/.test(bundled))
check('lib/client.js 里只有一处 advanceGate 定义',
  (bundled.match(/function advanceGate\(state, level, opts\)/g) || []).length === 1)

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
