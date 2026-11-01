/**
 * 回归测试：流式实时字（阶段 5b）。
 *
 * 背景（2026-10-31）：
 *   「边说边出字」原先是**每 900ms 把当前整段音频重新识别一遍** ——
 *   一段 5 秒的语音会重复识别 5 次，累计处理的音频量是段长的平方倍，
 *   段越长越慢。
 *
 *   宿主侧其实早就有真正的流式解码（/asr-stream，zipformer2 在线识别器），
 *   但客户端从来不调它 —— 一条**死链**，约 100 行代码加测试在维护，却没人用。
 *
 * 现在接上了：实时字可以走流式（只喂新增音频，解码器保留上下文）。
 *
 * 关键不变量：
 *   1. 流式解码器是**有状态**的 —— 每次开麦必须新会话；
 *   2. 断句和关麦时必须**丢弃**流式状态，否则上一段的上下文会污染下一段；
 *   3. 客户端的流式模型清单必须与宿主一致（两边不能各写一份又分叉）。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = fs.readFileSync(root + '/lib/client.js', 'utf8')
const idx = fs.readFileSync(root + '/lib/index.js', 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('宿主：流式模型 id')
const hostStreamId = /const STREAM_MODEL_ID = '([^']+)'/.exec(idx)?.[1]
check('宿主有 STREAM_MODEL_ID', !!hostStreamId, hostStreamId)

console.log('\n客户端：流式模型清单必须与宿主一致')
const cliIds = /const STREAM_MODEL_IDS = \[([^\]]*)\]/.exec(cli)?.[1] ?? ''
const cliIdList = [...cliIds.matchAll(/'([^']+)'/g)].map((m) => m[1])
check('客户端有 STREAM_MODEL_IDS', cliIdList.length > 0)
check('客户端的清单包含宿主的流式模型', cliIdList.includes(hostStreamId),
  `客户端=${cliIdList.join(',')} 宿主=${hostStreamId}`)

console.log('\n流式会话必须有始有终')
check('有流式会话 id 的 ref', /const streamSessionIdRef = useRef\(''\)/.test(cli))
check('有「已喂样本数」的 ref', /const streamFedRef = useRef\(0\)/.test(cli))
check('开麦时生成新的会话 id',
  /streamSessionIdRef\.current = streamLiveRef\.current[\s\S]{0,200}?voice-/.test(cli),
  '解码器是有状态的，复用同一个 id 会把上一轮的上下文带进来')
check('断句时丢弃流式状态', /void resetStream\(\)\s*\n\s*void transcribeSegment\(\)/.test(cli))
check('关麦时丢弃流式状态', /void resetStream\(\)\s*\n\s*\}\s*,\s*\[timers, resetStream\]/.test(cli))
check('resetStream 会调 /asr-stream/reset', /asr-stream\/reset\?sessionId=/.test(cli))

console.log('\n只喂新增音频（这是流式的意义）')
check('记录了已喂的样本数', /streamFedRef\.current = samples\.length/.test(cli))
check('只喂 subarray(already) 之后的增量', /samples\.subarray\(already\)/.test(cli))
check('增量没超过已喂量时跳过', /if \(samples\.length <= already\) return/.test(cli))

console.log('\n两种模式互斥，不能同时写实时字')
check('流式分支与整段分支是分开的',
  /if \(streamLiveRef\.current\) \{[\s\S]{0,900}?return\s*\n\s*\}/.test(cli)
  && /const resp = await fetch\(`\$\{BASE\}\/transcribe`/.test(cli))

console.log('\n模式判定')
check('支持三种取值', /liveAsr: 'full'/.test(idx))
check('auto 模式按模型判定', /mode === 'auto' && isStreamModel/.test(cli))
check('stream 模式强制开启', /mode === 'stream' \|\|/.test(cli))
check('流式不可用时退回整段重识别', /data\?\.unavailable\)[\s\S]{0,200}?streamLiveRef\.current = false/.test(cli))

console.log('\n界面')
check('设置面板有该选项', /t\('liveAsr'\)/.test(cli))
check('有中文文案', /liveAsr: '实时字方式'/.test(cli))
check('有英文文案', /liveAsr: 'Live text mode'/.test(cli))
check('默认是 full（对现有用户零影响）', /liveAsr: 'full'/.test(idx))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
