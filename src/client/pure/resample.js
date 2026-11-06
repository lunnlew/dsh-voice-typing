/**
 * 采集侧的音频算式：拼 chunks、按麦克风实际采样率线性重采样到 16k。
 *
 * 为什么单独成一个文件（第 4 步 4.4a，从 main.js 搬出来）：
 *   1. 这是**整条识别链路唯一的采样率归一出口**。浏览器里麦克风给的采样率
 *      是设备说了算（44.1k / 48k 都常见），而宿主侧喂模型的每一处都写死 16000
 *      （`lib/asr-worker.js`、`lib/index.js` 的 `acceptWaveform`）。
 *      「客户端负责把音频变成 16k」是两端之间的契约，不是某个组件的私事。
 *   2. 搬之前它只有 main.js 里的一份实现，但**取采样率那一步被手写了三遍**：
 *      两处 `micRef.current?.ctx?.sampleRate ?? 16000`、一处
 *      `Number(sampleRate) > 0 ? Number(sampleRate) : 16000`。
 *      前两处只挡 `undefined`，挡不住 0 / NaN —— 真拿到 0 时
 *      `ratio = 0`、`outLength = Infinity`，`new Float32Array(Infinity)` 直接抛
 *      RangeError（浏览器不会给 0，但假环境、以及以后任何新调用点都可能给）。
 *      第三处已经自己做了这个判断。现在三条路都走 `normalizeSourceRate`，
 *      判据只有一份：**不是有限的正数，就当它已经是目标采样率**（等价于不重采样）。
 *   3. 「把若干 chunk 拼成一段」同样被手写了三行 ×2 处（求和 → 分配 → set），
 *      收成 `mergeChunks`，两处调用点各剩一行。
 *
 * 零环境：只用 Float32Array / Number 这些语言级 API，不碰 window / navigator，
 * 所以 Node 里可以直接 import 单测（test/resample.test.mjs）。
 */

/**
 * 与宿主的采样率契约。
 *
 * 这个数字不是「偏好」：宿主侧每一处 `acceptWaveform` 与特征配置都写 16000，
 * 上传的 PCM 按 16k 解释。所以它住在判据旁边而不是散在三个调用点里。
 */
export const TARGET_SAMPLE_RATE = 16000

/**
 * 把「麦克风/调用方给的采样率」归一成能用来重采样的值。
 *
 * @param {unknown} value - 原始采样率（常见来源：`ctx.sampleRate`、worklet 回传的数值、
 *   字符串形式的数字）。
 * @returns {number} 有限的正数原样返回（数字字符串会被 `Number` 接受）；
 *   `undefined` / 0 / 负数 / NaN / Infinity 一律当目标采样率，意思是「不重采样」，
 *   而不是让下游算出 `Infinity` 个采样。
 */
export function normalizeSourceRate(value) {
  const rate = Number(value)
  return Number.isFinite(rate) && rate > 0 ? rate : TARGET_SAMPLE_RATE
}

/**
 * 把若干段 Float32 采样拼成一段（顺序即时间顺序）。
 *
 * @param {Float32Array[]} chunks - 采集到的分块，按时间顺序。
 * @returns {Float32Array} 拼接结果；空数组给长度 0 的 Float32Array（不抛错）。
 */
export function mergeChunks(chunks) {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const merged = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

/**
 * 线性插值重采样到 16k。
 *
 * @param {Float32Array} samples - 原始采样。
 * @param {number} from - 原始采样率（先过 `normalizeSourceRate` 再用）。
 * @returns {Float32Array} 16k 采样；已经是 16k 时**返回同一个数组**（不拷贝 ——
 *   调用方拿到就直接上传，没人改它，省一次整段分配）。
 */
export function resampleTo16k(samples, from) {
  if (from === TARGET_SAMPLE_RATE) return samples
  const ratio = from / TARGET_SAMPLE_RATE
  const outLength = Math.max(1, Math.floor(samples.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = samples[idx] ?? 0
    const b = samples[idx + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}
