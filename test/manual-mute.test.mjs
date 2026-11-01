/**
 * 回归测试：「聆听」与「朗读」是两个独立的事。
 *
 * 背景（2026-10-31）：
 *   以前麦克风按钮一个动作干两件事：关麦 + 停朗读 + 清草稿基准。
 *   后果：
 *     1. 「停止朗读但继续听」做不到；
 *     2. once 模式（说完一句就退出聆听）会顺手把这一轮的朗读也清掉 ——
 *        LLM 响应够快时（< 1.2 秒），刚入队的第一句就被清掉，
 *        表现是「这一轮一句都读不出来」；
 *     3. 「关闭语音对话后朗读还在继续」这类语义混淆。
 *
 * 现在的分工：
 *   麦克风按钮      → 只管聆听（stopListening）
 *   「停止朗读」按钮 → 只管朗读（stopPlayback）
 *   stopAll        → 两者都停，只在卸载时用
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

const micStart = lines.findIndex((l) => l.includes('function MicButton'))
const mic = lines.slice(micStart).join('\n')

console.log('职责拆分')
check('存在 stopListening', /const stopListening = useCallback/.test(cli))
check('存在 stopPlayback', /const stopPlayback = useCallback/.test(cli))
check('存在 stopAll（两者都停）', /const stopAll = useCallback/.test(cli))
check('stopAll 同时调用两者',
  /const stopAll = useCallback\(\(\) => \{\s*\n\s*stopListening\(\)\s*\n\s*stopPlayback\(\)/.test(cli))

console.log('\n麦克风按钮只管聆听')
const t = mic.indexOf('const toggleVoice = useCallback')
const toggle = mic.slice(t, t + 1200)
check('关闭时只调 stopListening', /stopListening\(\)/.test(toggle))
check('关闭时不停朗读（不调 haltSpeaking / stopPlayback）',
  !/haltSpeaking|stopPlayback/.test(toggle),
  '麦克风按钮不该顺带把朗读停掉')
check('关闭时不设置手动静音标记',
  !/mutedTurnRef\.current = true/.test(toggle),
  '静音是「停止朗读」按钮的职责')
check('重新开启麦克风时**不**解除手动静音',
  !/mutedTurnRef\.current = false/.test(toggle),
  '「停止朗读」是明确的用户意图，点麦克风不该撤销它 —— 否则「停止朗读 → 点麦克风 → 剩余句子又响了」')
check('静音只由新一轮解除',
  /addEventListener\('turn-begin'[\s\S]{0,600}?mutedTurnIdRef\.current = null/.test(mic),
  '新回合开始时恢复朗读')

console.log('\nonce 模式只关麦，不动朗读')
const once = mic.indexOf("mode ?? 'toggle') === 'once'")
// 剥离注释：注释里提到 stopAll() 会造成误判
const onceBlock = mic.slice(once, once + 400).replace(/\/\/[^\n]*/g, '')
check('once 模式调用 stopListening', /stopListening\(\)/.test(onceBlock))
check('once 模式不调用 stopAll / stopPlayback',
  !/stopAll\(\)|stopPlayback\(\)/.test(onceBlock),
  '以前调 stopAll 会把这一轮的朗读一起清掉')

console.log('\n独立的「停止朗读」按钮')
check('有 stopPlayback 按钮', /stopSpeakingButton/.test(cli))
check('按钮只在朗读时出现', /const stopSpeakingButton = speaking/.test(cli))
check('点它会静音本轮',
  /mutedTurnIdRef\.current = currentTurnIdRef\.current/.test(cli),
  '静音只由 turnId 表达（单一真源）')
check('点它会记住被静音的是哪一轮',
  /mutedTurnIdRef\.current = currentTurnIdRef\.current/.test(cli),
  '按轮静音比全局布尔精确：下一轮（turn-begin）自动恢复，本轮不受影响')
check('有中文文案', /stopSpeaking: '停止朗读'/.test(cli))
check('有英文文案', /stopSpeaking: 'Stop reading'/.test(cli))

console.log('\n手动静音的完整生命周期')
const sentenceIdx = mic.indexOf("addEventListener('sentence'")
// 截到 handler 末尾：原来写死 1200 字符，句处理器一长（加了去重/自愈/回执）
// 就会被截断 → 误报「没按轮判断静音」。边界按「下一个 handler 结束」找。
const sentenceEnd = mic.indexOf('return () => source.close()', sentenceIdx)
const sentenceBlock = mic.slice(sentenceIdx, sentenceEnd > sentenceIdx ? sentenceEnd : sentenceIdx + 6000)
check('sentence 处理器按轮判断静音',
  /mutedTurnIdRef\.current !== null/.test(sentenceBlock)
  && /mutedTurnIdRef\.current === '' \|\| !turnId \|\| turnId === mutedTurnIdRef\.current/.test(sentenceBlock),
  '静音只由 turnId 表达（null / \'\' / 具体轮次），没有布尔回退')
const turnIdx = mic.indexOf("addEventListener('turn-begin'")
const turnBlock = turnIdx >= 0 ? mic.slice(turnIdx, turnIdx + 700) : ''
check('新一轮开始时解除静音（turn-begin）',
  turnBlock.includes('mutedTurnIdRef.current = null'),
  '收到 turn-begin 就恢复朗读')
check('不再监听旧的 turn-start（不兼容老协议）',
  !/addEventListener\('turn-start'/.test(mic),
  '同一事实两条通路会让客户端维护两套判断')
check('静音标记由「停止朗读」按钮设置，而不是 stopPlayback',
  /mutedTurnIdRef\.current = currentTurnIdRef\.current/.test(cli),
  '「停止朗读」是用户意图，由按钮记录被静音的是哪一轮')

console.log('\n「停止朗读」必须真的停下来')
check('haltSpeaking 会清空队列', /speakQueueRef\.current\.length = 0/.test(cli))
check('haltSpeaking 会作废正在合成的句子', /speakGenRef\.current \+= 1/.test(cli))
check('haltSpeaking 会停掉当前播放', /speakCancelRef\.current/.test(cli))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
