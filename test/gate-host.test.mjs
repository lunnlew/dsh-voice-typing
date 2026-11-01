/**
 * 宿主侧门限状态机的单元测试（不依赖活着的插件，也不需要模型）。
 *
 * 背景（2026-10-31）：
 *   集成测试发现「流式·真实语音」只认出「你好明天天怎」，
 *   而整段非流式能认出「你好，今天天气怎么样？」。
 *   原因：门限把中间两块真实语音（rms 0.0255 / 0.0308）挡在了解码器外面。
 *
 *   门限逻辑原先内联在 `/asr-stream` 路由里，改不动也测不了；
 *   现在抽成了纯函数 advanceGate（lib/index.js），
 *   宿主侧与浏览器侧共用同一份用例表（test/fixtures/gate-cases.mjs）。
 */
import { GATE_CASES, GATE_OPTS, GATE_INITIAL_STATE, runGateCase } from './fixtures/gate-cases.mjs'
import fs from 'node:fs'

// 直接引宿主模块的文件路径（插件入口本身也是 ESM，可以直接 import）。
const { advanceGate, DEFAULT_GATE_OPTS, recognizeWithSherpa } = await import('../lib/index.js')
const HOST_SRC = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('门限纯函数已抽出来')
check('宿主导出了 advanceGate', typeof advanceGate === 'function')
check('advanceGate 不带 opts 也能用（缺省就是 DEFAULT_GATE_OPTS）',
  (() => {
    const a = advanceGate({ ...GATE_INITIAL_STATE }, 0.05)
    const b = advanceGate({ ...GATE_INITIAL_STATE }, 0.05, DEFAULT_GATE_OPTS)
    return JSON.stringify(a) === JSON.stringify(b)
  })())
check('宿主导出了默认门限常数', !!DEFAULT_GATE_OPTS)

console.log('\n默认常数与共享用例表一致')
check(
  '用例表的 GATE_OPTS 与宿主的 DEFAULT_GATE_OPTS 完全相同',
  JSON.stringify(GATE_OPTS) === JSON.stringify(DEFAULT_GATE_OPTS),
  `用例表 ${JSON.stringify(GATE_OPTS)}，宿主 ${JSON.stringify(DEFAULT_GATE_OPTS)}`,
)

console.log('\n纯函数性质')
{
  const before = { ...GATE_INITIAL_STATE }
  const snapshot = JSON.stringify(before)
  advanceGate(before, 0.05, GATE_OPTS)
  check('不改传入的 state', JSON.stringify(before) === snapshot, JSON.stringify(before))
}
{
  const input = { ...GATE_INITIAL_STATE }
  const result = advanceGate(input, 0.05, GATE_OPTS)
  check('返回 feed / speech / gate / state', !!result && 'feed' in result && 'speech' in result && 'gate' in result && !!result.state)
  check('返回的新 state 只有三个字段',
    result && Object.keys(result.state).sort().join(',') === 'inSpeech,noiseFloor,silentFrames',
    result ? Object.keys(result.state).join(',') : '没有 state')
  check('新 state 与传入的 state 不是同一个对象', result && result.state !== input)
}
{
  // 同一个输入必须给出同一个结果（可重复）。
  const a = advanceGate({ ...GATE_INITIAL_STATE }, 0.041, GATE_OPTS)
  const b = advanceGate({ ...GATE_INITIAL_STATE }, 0.041, GATE_OPTS)
  check('同样的输入给出同样的输出（可重复）', JSON.stringify(a) === JSON.stringify(b))
}
{
  // feed 与 speech 在本算法下恒等 —— 共享用例表靠这一点两侧通用。
  const result = advanceGate({ ...GATE_INITIAL_STATE }, 0.05, GATE_OPTS)
  check('feed 与 speech 一致（客户端 VAD 可以直接用 speech）', result.feed === result.speech)
}

console.log('\n用共享用例表驱动宿主门限')
for (const gateCase of GATE_CASES) {
  const result = runGateCase(gateCase, advanceGate)
  const fedOk = JSON.stringify(result.fed) === JSON.stringify(gateCase.expectFed)
  check(
    gateCase.name,
    fedOk,
    fedOk ? '' : `喂了 [${result.fed.join(', ')}]，期望 [${gateCase.expectFed.join(', ')}]`,
  )
  if (gateCase.expectFinal) {
    const finalOk = JSON.stringify(result.final) === JSON.stringify(gateCase.expectFinal)
    check(
      gateCase.name + '（结束状态）',
      finalOk,
      finalOk ? '' : `结束状态 ${JSON.stringify(result.final)}，期望 ${JSON.stringify(gateCase.expectFinal)}`,
    )
  }
  const speechOk = JSON.stringify(result.speech) === JSON.stringify(result.fed)
  check(gateCase.name + '（speech 与 feed 一致）', speechOk)
}

console.log('\n回归：真实语音序列的所有非零帧都要被喂')
{
  const gateCase = GATE_CASES.find((c) => c.name.startsWith('真实语音序列'))
  const result = runGateCase(gateCase, advanceGate)
  const spoken = gateCase.levels.filter((l) => l > 0)
  const fedSpoken = gateCase.levels.filter((l, i) => l > 0 && result.fed[i])
  check(
    '所有非零帧都被喂进去了',
    spoken.length === fedSpoken.length,
    `喂了 ${fedSpoken.length}/${spoken.length} 帧`,
  )
  check(
    '尾部静音也喂进去了（解码器需要静音才能定句）',
    result.fed.slice(-2).every(Boolean),
    `尾部两帧 feed=${result.fed.slice(-2).join(', ')}`,
  )
}

console.log('\n回归：门限常数可注入（两端常数不同）')
{
  // 客户端侧的常数（clamp 0.008 / 0.035）跑同一张表，结果必须一致。
  const CLIENT_OPTS = {
    minGate: 0.008,
    maxGate: 0.035,
    multiplier: 2.5,
    offset: 0.003,
    silentFramesToEnd: 3,
  }
  let same = true
  for (const gateCase of GATE_CASES) {
    const host = runGateCase(gateCase, advanceGate)
    const client = runGateCase(gateCase, advanceGate, CLIENT_OPTS)
    if (JSON.stringify(host.fed) !== JSON.stringify(client.fed)) same = false
    if (JSON.stringify(host.final) !== JSON.stringify(client.final)) same = false
  }
  check('换一套门限常数，同一张用例表的结果不变', same)
}

console.log('\n回归：底噪只在不在说话中时更新')
{
  // 说话时底噪不能被自己的声音抬高，否则越说越容易被挡。
  const gateCase = GATE_CASES.find((c) => c.name.startsWith('真实语音序列'))
  const result = runGateCase(gateCase, advanceGate)
  const gates = result.gates
  const drifting = gates.slice(1).some((g, i) => Math.abs(g - gates[i]) > 1e-12)
  check('说话过程中门限不跟着自己的声音往上漂', !drifting, gates.map((g) => g.toFixed(5)).join(', '))
}

console.log('\n回归：D5 —— speech 不再走模块级变量')
{
  const src = HOST_SRC
  check(
    '没有模块级的 lastRecognitionHadSpeech 变量了',
    !/(let|var|const)\s+lastRecognitionHadSpeech\b/.test(src),
    '模块级变量还在 —— 两个并发 /transcribe 会互相覆盖 speech',
  )
  check(
    '/transcribe 用的是请求局部的 speech',
    /speech: hadSpeech/.test(src) && /let hadSpeech = false/.test(src),
  )
  check(
    'recognizeWithSherpa 的返回值带 speech',
    /return \{ text: texts\.join\(' '\)\.trim\(\), speech: hadSpeech \}/.test(src),
  )
  const empty = await recognizeWithSherpa(null, new Float32Array(0))
  check(
    'recognizeWithSherpa 返回 {text, speech}',
    !!empty && typeof empty.text === 'string' && typeof empty.speech === 'boolean',
    JSON.stringify(empty),
  )
  const silent = await recognizeWithSherpa(null, new Float32Array(64))
  check(
    '静音输入的 speech 是 false',
    !!silent && silent.speech === false && silent.text === '',
    JSON.stringify(silent),
  )
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
