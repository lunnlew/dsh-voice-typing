/**
 * 流式识别的门限逻辑单元测试（不依赖活着的插件）。
 *
 * 背景（2026-10-31）：
 *   集成测试发现「流式·真实语音」只认出「你好明天天怎」，
 *   而整段非流式能认出「你好，今天天气怎么样？」。
 *
 *   原因：门限把中间两块真实语音（rms 0.025 / 0.031）挡在了解码器外面。
 *   而底噪是**每帧都**更新的（0.95/0.05 指数平均），
 *   说话时底噪被语音自己抬高 → 门限跟着抬高 → 越说越容易被挡。
 *
 * 这里用真实的 rms 序列验证门限状态机。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const idx = fs.readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('流式门限的实现')
check('有「说话中」状态', /inSpeech: false/.test(idx))
check('有连续静音计数', /silentFrames: 0/.test(idx))
check('定义了结束所需的连续静音帧数', /const STREAM_SILENT_FRAMES_TO_END = \d+/.test(idx))
check('底噪只在静音时更新（不在说话中更新）',
  /if \(!state\.inSpeech\) \{\s*\n\s*state\.noiseFloor = state\.noiseFloor \* 0\.95/.test(idx),
  '每帧都更新的话，底噪会被语音自己抬高，门限跟着涨，语音被自己的声音挡掉')
check('说话中不会因为单帧偏低就中断',
  /state\.silentFrames \+= 1\s*\n\s*else state\.silentFrames = 0/.test(idx))
check('连续静音达到阈值才退出说话态',
  /state\.silentFrames >= STREAM_SILENT_FRAMES_TO_END/.test(idx))
check('静音帧不喂给解码器', /if \(level < gate\) \{[\s\S]{0,220}?speech: false/.test(idx))

console.log('\n用真实 rms 序列验证门限状态机')
// 复刻实现里的门限逻辑
const STREAM_SILENT_FRAMES_TO_END = Number(/const STREAM_SILENT_FRAMES_TO_END = (\d+)/.exec(idx)[1])

function simulate(levels) {
  const state = { noiseFloor: 0.004, inSpeech: false, silentFrames: 0 }
  const fed = []
  for (const level of levels) {
    if (!state.inSpeech) state.noiseFloor = state.noiseFloor * 0.95 + level * 0.05
    const gate = Math.min(Math.max(0.01, state.noiseFloor * 2.5 + 0.003), 0.045)
    if (state.inSpeech) {
      if (level < gate) state.silentFrames += 1
      else state.silentFrames = 0
      if (state.silentFrames >= STREAM_SILENT_FRAMES_TO_END) { state.inSpeech = false; state.silentFrames = 0 }
    } else if (level < gate) {
      continue
    } else {
      state.inSpeech = true
      state.silentFrames = 0
    }
    fed.push(level)
  }
  return { fed, state }
}

// 实测的真实 rms 序列（来自 zh-test.wav，按 0.4 秒分块）
const real = [0.0410, 0.0815, 0.0255, 0.0482, 0.0308, 0.0485, 0.0512, 0.0000, 0.0000]
const { fed } = simulate(real)
console.log('  喂给解码器的帧:', fed.map((x) => x.toFixed(4)).join(', '))
const speechFrames = real.filter((l) => l > 0)
check('所有真实语音帧都被喂进去了',
  speechFrames.every((l) => fed.includes(l)),
  `喂了 ${fed.length} 帧，其中语音 ${fed.filter((l) => l > 0).length}/${speechFrames.length} 帧`)
check('尾部静音也可以喂进去（transducer 需要静音才能定句）',
  fed.length >= speechFrames.length,
  '说话结束后连续静音才退出说话态，所以尾部静音帧会被喂进去，这是对的')

// 纯静音不应该喂任何帧
const { fed: fedQuiet } = simulate([0.0001, 0.0002, 0.0001, 0.0002, 0.0001])
check('纯静音不会喂给解码器（防止模型凭空造字）', fedQuiet.length === 0, `喂了 ${fedQuiet.length} 帧`)

// 低噪环境：底噪抬高后仍不该把噪声喂进去
const noise = []
for (let i = 0; i < 8; i++) noise.push(0.012 + (i % 3) * 0.002)
const { fed: fedNoise } = simulate(noise)
check('持续低噪不会被喂进去', fedNoise.length === 0, `喂了 ${fedNoise.length} 帧`)

// 低噪环境里的真语音仍要能进
const mixed = [0.012, 0.013, 0.012, 0.012, 0.05, 0.06, 0.011, 0.012]
const { fed: fedMixed } = simulate(mixed)
check('低噪环境里的语音仍被喂进去', fedMixed.includes(0.05) && fedMixed.includes(0.06), fedMixed.join(', '))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
