/**
 * 测试接缝：造一个「已经下载好」的合成模型档位，让宿主的识别路径不必碰几百 MB 真模型。
 *
 * 为什么需要它（docs/architecture-modernization.md §8.41，批次 6h）：
 *   `test/worker-protocol.test.mjs`、`test/listening-ready.test.mjs`、
 *   `test/model-state.test.mjs` 各自手写过一份同样思路的脚手架（档位文件本地造、
 *   sha256 由测试自己算、按宿主认的位置摆进假 DSH_HOME）。
 *   这个文件把它收在一处，供后续批次直接使用：
 *   档位是**测试自己追加**进 `MODELS` 的（`loadHostRoutes({appendAsrTiers})`），
 *   sha 与文件内容都对得上，于是 `isModelReady()` 走**真判据**就会通过，
 *   识别路由跑的是真代码，只有最外层的第三方依赖换成 `fake-sherpa`。
 *
 * 三个要点：
 *   1. **文件名必须含 encoder / decoder / joiner / tokens**：
 *      `modelPaths()` 是按 `f.name.includes('encoder')` 这类子串挑文件的，
 *      名字起错了档位就是「路径全 null」，识别器构造出来也是坏的。
 *   2. **要覆盖某个内置档位**（例如流式那档 `zipformer2-zh`）就用**同一个 id** 追加：
 *      `appendAsrTiers` 是 `[...追加的, ...内置的]`，`findModel` 取第一个匹配，
 *      于是宿主拿到的是这份测试档位，而 sha 是测试自己算的那份。
 *   3. **每帧的 rms 就是幅值**：`rmsOf()` 是平方均值开根号，
 *      恒定幅值的帧算回来正好等于幅值 —— 门限用例表可以直接按 rms 喂音频。
 */
import fs from 'node:fs'
import path from 'node:path'
import { digest } from './fake-cdn.mjs'

/** 默认识别档位文件：encoder / decoder / joiner / tokens 四类都齐（online 与 whisper 都用得着）。 */
const DEFAULT_MODEL_FILES = ['model-encoder.onnx', 'model-decoder.onnx', 'model-joiner.onnx', 'tokens.txt']

/**
 * 合成一个「下载完成」的档位。
 * @param {string} id - 档位 id（要与内置档重名时传那个 id）。
 * @param {object} [options] - { engine: 'whisper'|'online'|…，repo: 本地目录名，files: 文件名列表 }
 * @returns {{tier: object, bodies: Array<{name: string, bytes: number, sha256: string, body: Buffer}>}}
 */
export function makeReadyTier(id, { engine = 'whisper', repo = 'fake-repo/synthetic', files = DEFAULT_MODEL_FILES } = {}) {
  const bodies = files.map((name, i) => {
    const body = Buffer.from(`${name}-${i}-`.repeat(64))
    return { name, bytes: body.length, sha256: digest(body), body }
  })
  const tier = {
    id,
    label: `测试档位 ${id}`,
    labelEn: `Test ${id}`,
    engine,
    repo,
    revision: 'main',
    bytes: bodies.reduce((n, f) => n + f.bytes, 0),
    note: '',
    noteEn: '',
    languages: ['zh'],
    files: bodies.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
  }
  return { tier, bodies }
}

/** 把档位文件摆进假 DSH_HOME 的模型目录（与 `cacheRoot()` 同一套位置规则）。 */
export function placeTierFiles(home, tier, bodies) {
  const dir = path.join(home, 'voice-typing', 'models', tier.repo)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of bodies) fs.writeFileSync(path.join(dir, f.name), f.body)
  return dir
}

/** 一段「肯定过能量门限」的 f32 PCM（门限 0.008，这里振幅 0.1）。 */
export function loudPcm(samples = 1600) {
  const arr = new Float32Array(samples)
  for (let i = 0; i < samples; i++) arr[i] = (i % 2 ? -0.1 : 0.1)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

/**
 * 一帧 rms **正好等于 level** 的 f32 PCM（恒定幅值）。
 * @param {number} level - 目标 rms（0 = 纯静音）。
 * @param {number} [count] - 采样点数。
 * @returns {Buffer} 可以直接当 `/asr-stream`、`/transcribe` 请求体的 Buffer。
 */
export function frameOfLevel(level, count = 1600) {
  const arr = new Float32Array(count).fill(level)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

/** 同上，但交回 Float32Array（给 `recognizeWithSherpa` 这类直接吃采样的函数用）。 */
export function samplesOfLevel(level, count = 1600) {
  return new Float32Array(count).fill(level)
}
