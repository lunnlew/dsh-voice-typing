/**
 * 回归测试：关闭麦克风 = 完整状态复位。
 *
 * 设计原则（用户明确要求）：
 *   「取消麦克风状态之后，所有的状态应该是被清空了。」
 *
 * 分工（2026-10-31 重构后）：
 *   stopListening —— 聆听侧的复位：麦克风、识别、草稿基准、定时器
 *   stopPlayback  —— 朗读侧的复位：朗读队列、代次、当前播放、speaking 状态
 *   stopAll       —— 两者都停，只在组件卸载时用
 *
 * 之前漏掉的一个：
 *   `pendingAutoSendTimerRef`（「助手忙完后自动发送」的定时器）
 *   只在组件卸载时被清 —— 于是用户关掉麦克风后，
 *   那个定时器照样在 400 毫秒后触发，把草稿**自动发了出去**。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = fs.readFileSync(root + '/lib/client.js', 'utf8')
const lines = cli.split('\n')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/** 取某个 useCallback 的函数体（按括号配平）。 */
function bodyOf(needle) {
  const start = lines.findIndex((l) => l.includes(needle))
  if (start < 0) return ''
  let depth = 0
  for (let k = start; k < lines.length; k++) {
    for (const ch of lines[k]) { if (ch === '(' || ch === '{') depth++; if (ch === ')' || ch === '}') depth-- }
    if (depth <= 0 && k > start) return lines.slice(start, k + 1).join('\n')
  }
  return lines.slice(start).join('\n')
}

const stopListening = bodyOf('const stopListening = useCallback')
const stopPlayback = bodyOf('const stopPlayback = useCallback')
const closeMic = bodyOf('const closeMic = useCallback')
const haltSpeaking = bodyOf('const haltSpeaking = useCallback')

console.log('聆听侧的复位（stopListening）')
check('stopListening 存在', stopListening.length > 0)
check('清掉「助手忙完后自动发送」的定时器',
  /timers\.clearGroup\('send'\)/.test(stopListening),
  '不清的话关麦后 400 毫秒它照样触发，把草稿自动发出去')
check('清掉「发送前等待」的定时器',
  /timers\.clearGroup\('send'\)/.test(stopListening),
  'pending-send 与 pending-auto-send 同属 send 组，一次清干净')
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
check('VAD 定时器被清', /timers\.clearGroup\('mic'\)/.test(closeMic))
check('flush 定时器被清', /timers\.clearGroup\('mic'\)/.test(closeMic))

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
const stopAll = bodyOf('const stopAll = useCallback')
check('调用 stopListening', /stopListening\(\)/.test(stopAll))
check('调用 stopPlayback', /stopPlayback\(\)/.test(stopAll))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
