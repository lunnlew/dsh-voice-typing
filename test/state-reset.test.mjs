/**
 * 回归测试：状态复位与「聆听 / 朗读」两轴分工。
 *
 * 设计原则（用户明确要求）：
 *   「取消麦克风状态之后，所有的状态应该是被清空了。」
 *
 * 分工（2026-10-31 重构后）：
 *   stopListening —— 聆听侧的复位：麦克风、识别、草稿基准、定时器
 *   stopPlayback  —— 朗读侧的复位：朗读队列、代次、当前播放、speaking 状态
 *   stopAll       —— 两者都停，只在组件卸载时用
 *
 * 本文件已并入原 test/manual-mute.test.mjs（独有断言）：
 *   - 麦克风按钮只管聆听（关麦不碰朗读、也不撤销手动静音）；
 *   - once 模式只关麦、不动朗读；
 *   - 「停止朗读」按钮按轮静音、只在朗读中显示；
 *   - 静音只由新一轮（turn-begin）解除。
 *   原文件里对已删除的 `mutedTurnRef` 的负向断言是恒真的，已丢弃。
 *
 * 之前漏掉的一个：
 *   `pendingAutoSendTimerRef`（「助手忙完后自动发送」的定时器）
 *   只在组件卸载时被清 —— 于是用户关掉麦克风后，
 *   那个定时器照样在 400 毫秒后触发，把草稿**自动发了出去**。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { blockOf } from './helpers/block.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = fs.readFileSync(root + '/lib/client.js', 'utf8')
const lines = cli.split('\n')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

// 按大括号配平取函数体（test/helpers/block.mjs）—— 不要用固定字符窗口，
// 函数一长窗口外的回归就会被静默漏检。
const stopListening = blockOf(lines, 'const stopListening = useCallback').text
const stopPlayback = blockOf(lines, 'const stopPlayback = useCallback').text
const closeMic = blockOf(lines, 'const closeMic = useCallback').text
const haltSpeaking = blockOf(lines, 'const haltSpeaking = useCallback').text
const stopAll = blockOf(lines, 'const stopAll = useCallback').text
const toggleVoice = blockOf(lines, 'const toggleVoice = useCallback').text
const onceMode = blockOf(lines, "mode ?? 'toggle') === 'once'").text

console.log('聆听侧的复位（stopListening）')
check('stopListening 存在', stopListening.length > 0)
check('清掉发送组定时器（「助手忙完后自动发送」等）',
  /timers\.clearGroup\('send'\)/.test(stopListening),
  '不清的话关麦后 400 毫秒它照样触发，把草稿自动发出去')
check('清掉提示定时器', /clearTimeout\(hintTimerRef\.current\)/.test(stopListening))
check('关闭麦克风', /closeMic\(\)/.test(stopListening))
for (const [name, re] of [
  ['识别中标志 recognizingRef', /recognizingRef\.current = false/],
  ['听到人声标志 hearingRef', /hearingRef\.current = false/],
  ['实时字 livePartialRef', /livePartialRef\.current = ''/],
  ['录音缓冲 chunksRef', /chunksRef\.current = \[\]/],
  ['草稿基准 baseDraftRef', /baseDraftRef\.current = ''/],
  ['已提交语音 committedRef', /committedRef\.current = ''/],
  ['当前段 segmentRef', /segmentRef\.current = ''/],
  ['上次写入 lastWrittenRef', /lastWrittenRef\.current = ''/],
  ['待发送标志 pendingAutoSendRef', /pendingAutoSendRef\.current = false/],
  ['噪音基准 noiseFloorRef', /noiseFloorRef\.current = 0/],
]) {
  check(name, re.test(stopListening))
}

console.log('\n录音标志由 closeMic 清')
check('recorderActiveRef', /recorderActiveRef\.current = false/.test(closeMic))
check('麦克风资源 micRef 置空', /micRef\.current = null/.test(closeMic))
check('麦克风这一组的定时器被清（VAD / flush）', /timers\.clearGroup\('mic'\)/.test(closeMic),
  '两个定时器现在由登记表按 group 一次清干净，不再逐个 ref 清（逐个清总会漏）')

console.log('\n朗读侧的复位（stopPlayback / haltSpeaking）')
check('stopPlayback 调用 haltSpeaking', /haltSpeaking\(true\)/.test(stopPlayback))
check('朗读标志 speakingRef', /speakingRef\.current = false/.test(haltSpeaking))
check('朗读队列被清空', /speakQueueRef\.current\.length = 0/.test(haltSpeaking))
check('代次自增（旧音频作废）', /speakGenRef\.current \+= 1/.test(haltSpeaking))
check('当前播放被停掉', /speakCancelRef\.current/.test(haltSpeaking))
check('标记本轮不再朗读由「停止朗读」按钮负责（不在 stopPlayback 里）',
  !/mutedTurn/.test(stopPlayback)
  && /mutedTurnIdRef\.current = currentTurnIdRef\.current/.test(cli),
  '静音是用户意图，由按钮记录被静音的是哪一轮；stopPlayback 只负责停掉声音')

console.log('\nstopAll 两者都停')
check('调用 stopListening', /stopListening\(\)/.test(stopAll))
check('调用 stopPlayback', /stopPlayback\(\)/.test(stopAll))

/* ------------------------------------------------------------------ */
/* 以下由原 test/manual-mute.test.mjs 合并而来（独有断言，不放丢）     */
/* ------------------------------------------------------------------ */
console.log('\n麦克风按钮只管聆听（不碰朗读、不撤销静音）')
check('关闭时只调 stopListening', /stopListening\(\)/.test(toggleVoice))
check('关闭时不停朗读（不调 haltSpeaking / stopPlayback）',
  !/haltSpeaking|stopPlayback/.test(toggleVoice),
  '麦克风按钮不该顺带把朗读停掉')
check('开麦/关麦不撤销手动静音（不写 mutedTurnIdRef = null）',
  !/mutedTurnIdRef\.current = null/.test(toggleVoice),
  '「停止朗读」是明确的用户意图，点麦克风不该撤销它 —— 否则「停止朗读 → 点麦克风 → 剩余句子又响了」')
check('静音只由新一轮解除（turn-begin → mutedTurnIdRef=null）',
  /addEventListener\('turn-begin'[\s\S]{0,600}?mutedTurnIdRef\.current = null/.test(cli),
  '新回合开始时恢复朗读')

console.log('\nonce 模式只关麦，不动朗读')
check('once 模式调用 stopListening', /stopListening\(\)/.test(onceMode))
// 注释里会提到「以前调的是 stopAll()」，先剥注释再断言（否则永远假红）。
const onceCode = onceMode.replace(/\/\/[^\n]*/g, '')
check('once 模式不调用 stopAll / stopPlayback',
  !/stopAll\(\)|stopPlayback\(\)/.test(onceCode),
  '以前调 stopAll 会把这一轮的朗读一起清掉')

console.log('\n独立的「停止朗读」按钮（按轮静音）')
check('按钮只在朗读时出现', /const stopSpeakingButton = speaking/.test(cli))
check('点它按轮静音（单一真源 mutedTurnIdRef）',
  /mutedTurnIdRef\.current = currentTurnIdRef\.current/.test(cli))
check('stopSpeaking 中英文案齐全',
  /stopSpeaking: '停止朗读'/.test(cli) && /stopSpeaking: 'Stop reading'/.test(cli))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
