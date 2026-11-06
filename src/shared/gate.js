/**
 * 流式门限状态机 —— **单源**实现（宿主 `/asr-stream` 与浏览器 VAD 共用这一份）。
 *
 * 为什么只有一份：
 *   这条判据在 2026-10-31 之前是「宿主一份 + 浏览器一份」，靠一张用例表防分叉。
 *   分叉过的代价很具体：宿主侧曾把真实语音的低音量帧（rms 0.0255 / 0.0308）
 *   挡在解码器外面，流式只认出「你好明天天怎」，整段非流式却能认出
 *   「你好，今天天气怎么样？」。防分叉的测试只能事后报警，
 *   而判据本身不需要两份 —— 于是收在这里。
 *
 * 环境约束（`src/shared/*` 的共同规矩，由 test/bundle-sync.test.mjs 机械守卫）：
 *   - 纯 ESM、零浏览器全局、零 Node API：宿主直接 `import`，浏览器侧由
 *     `scripts/build-client.mjs` 在构建期合并进单文件产物。
 *   - **常数不在这里**：两侧的门限常数本来就不同（宿主 clamp 0.01/0.045、
 *     浏览器 clamp 0.008/0.035），用 `createGate(defaults)` 注入，
 *     所以「同一算法」与「不同常数」互不牵制。
 *
 * 算法（两侧必须完全一致）：
 *   1. 底噪**只在不在说话中**时更新：noiseFloor = noiseFloor * 0.95 + level * 0.05
 *      （每帧都更新的话，说话时底噪被自己的声音抬高 → 门限跟着抬高 → 语音被自己的声音挡掉）；
 *   2. 门限：gate = min(max(minGate, noiseFloor * multiplier + offset), maxGate)；
 *   3. 说话中：低于门限就 silentFrames += 1，否则清零；
 *      连续静音达到 `silentFramesToEnd` 才退出说话态；
 *      说话段内的帧**一律算语音**（单帧偏低是汉语轻声、句尾下降音，不能中断，
 *      中断一次解码器就永远缺了那部分音频，识别结果会截断）；
 *      「退出说话态」的那一帧仍然要喂 —— 那是刚说完的最后一帧，喂进去解码器才能定句；
 *   4. 不在说话中：低于门限 → 本帧不算语音、不喂给解码器；否则进入说话态并开始喂。
 */

/**
 * 门限状态机的初始值。两侧的生产代码本来就用同一个数（0.004），
 * 收在这里是为了让「缺字段的 state」有一条确定的处理路径 ——
 * 宿主侧旧写法取的是 `DEFAULT_GATE_OPTS.noiseFloor`（并不存在 → NaN 门限），
 * 只是调用方每次都初始化过，那条路没被踩到而已。
 *
 * 冻起来：这是**双方共用的起点值**，谁都不该在运行中改它（改了会同时影响两侧）。
 */
export const INITIAL_GATE_STATE = Object.freeze({ noiseFloor: 0.004, inSpeech: false, silentFrames: 0 })

/**
 * 用一组默认常数造出门限判定函数。
 *
 * @param {object} defaults - 该侧的默认常数
 *   {minGate, maxGate, multiplier, offset, silentFramesToEnd}。
 * @returns {(state: object, level: number, opts?: object) => {feed: boolean, speech: boolean, gate: number, state: object}}
 *   纯函数：不修改传入的 state，返回新的 state（只有 noiseFloor / inSpeech / silentFrames 三个字段）。
 *   调用方仍可用第三个参数临时覆盖任意常数。
 */
export function createGate(defaults) {
  /**
   * 推进门限状态机。
   * @param {object} state - 当前状态 {noiseFloor, inSpeech, silentFrames}（不会被修改）。
   * @param {number} level - 本帧的 RMS。
   * @param {object} [opts] - 要覆盖的门限常数，缺省用 `createGate` 注入的那一组。
   * @returns {{feed: boolean, speech: boolean, gate: number, state: object}} -
   *   feed 是本帧要不要喂给解码器（宿主用），speech 是本帧算不算「有语音」（浏览器 VAD 用），
   *   两者在本算法下恒等（见 stepGate 里的说明）。
   */
  return function advanceGate(state, level, opts) {
    const o = { ...defaults, ...opts }
    // 副本：下面所有赋值都作用在它身上，调用方传进来的 state 原封不动（纯函数）。
    const local = {
      noiseFloor: Number(state?.noiseFloor ?? INITIAL_GATE_STATE.noiseFloor),
      inSpeech: Boolean(state?.inSpeech),
      silentFrames: Number(state?.silentFrames ?? 0),
    }
    return stepGate(local, Number(level) || 0, o)
  }
}

/**
 * 门限状态机的一步（内部实现：推进的是传进来的那份副本）。
 * @param {object} state - 状态副本。
 * @param {number} level - 本帧 RMS。
 * @param {object} o - 已合并默认值的门限常数。
 * @returns {{feed: boolean, speech: boolean, gate: number, state: object}}。
 */
function stepGate(state, level, o) {
  // 底噪只在「不在说话中」时更新（原因见文件头的算法说明）。
  if (!state.inSpeech) {
    state.noiseFloor = state.noiseFloor * 0.95 + level * 0.05
  }
  const gate = Math.min(Math.max(o.minGate, state.noiseFloor * o.multiplier + o.offset), o.maxGate)
  // feed（宿主要不要喂解码器）与 speech（这帧算不算语音）在本算法下**恒等**：
  // 说话段内的帧一律算语音 —— 汉语的轻声、句尾的下降音天然偏低，
  // 判成「没人说话」的话，这部分音频就被切掉了，识别结果会截断。
  let feed = true
  let speech = true
  if (state.inSpeech) {
    // 说话中：连续几帧都低于门限才算说完了。
    // 单帧偏低（汉语的轻声、句尾的下降音）**不能**就此中断 ——
    // 中断一次，解码器就永远缺了那部分音频，识别结果会截断。
    if (level < gate) state.silentFrames += 1
    else state.silentFrames = 0
    // 退出说话态的那一帧仍然喂：它是「刚说完」的最后一帧，喂进去解码器才能定句。
    if (state.silentFrames >= o.silentFramesToEnd) {
      state.inSpeech = false
      state.silentFrames = 0
    }
  } else if (level < gate) {
    // 静音：不喂给解码器（否则模型会对着噪声凭空造字）
    feed = false
    speech = false
  } else {
    // 静音 → 说话，开始喂音频
    state.inSpeech = true
    state.silentFrames = 0
  }
  return { feed, speech, gate, state }
}
