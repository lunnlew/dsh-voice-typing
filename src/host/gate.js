/**
 * 流式门限状态机（宿主侧入口）。
 *
 * 为什么单独抽成一个模块：
 *   `/asr-stream` 的「这帧要不要喂给解码器」必须由一套确定的门限判定给出。
 *   它**不依赖** dsh 的 ctx/scope/settings，是纯函数 —— 放进独立文件
 *   才能被单独测试、被其它宿主模块复用，而不必把整个 `lib/index.js` 拉进来。
 *
 * 算法不在这里：住在 `src/shared/gate.js`（**单源**）。
 *   浏览器侧 `src/client/pure/gate.js` 用的是同一个模块、**不同的门限常数**
 *   （宿主 clamp 0.01/0.045，浏览器 clamp 0.008/0.035）。
 *   两侧仍由同一份用例表（`test/fixtures/gate-cases.mjs`）驱动 ——
 *   现在它验的是「常数接对了」，不再是「两份实现有没有分叉」。
 *
 * 本文件只保留宿主的东西：宿主现行常数、以及公共导出面
 * （`lib/index.js` re-export 了这三个名字，别动）。
 */
import { createGate } from '../shared/gate.js'

// 初始状态从同一处出：`lib/index.js` 建流时写的 noiseFloor 基准就是这个值。
export { INITIAL_GATE_STATE } from '../shared/gate.js'

/** 说话中，连续多少帧低于门限才判定「说完了」。 */
export const STREAM_SILENT_FRAMES_TO_END = 3

/**
 * 门限状态机的默认常数（宿主侧）。
 *
 * 这些数是宿主 `/asr-stream` 的现行取值。
 * 抽成可传入的常数，是为了让浏览器侧能用**同一份用例表**驱动两侧的门限逻辑
 * （用例表见 test/fixtures/gate-cases.mjs）。
 */
export const DEFAULT_GATE_OPTS = {
  /** 门限下限：再安静也不低于这个值。 */
  minGate: 0.01,
  /** 门限上限：再吵也不高于这个值。 */
  maxGate: 0.045,
  /** 门限相对底噪的倍数。 */
  multiplier: 2.5,
  /** 门限的固定偏移量。 */
  offset: 0.003,
  /** 连续多少帧低于门限才判定「说完了」。 */
  silentFramesToEnd: STREAM_SILENT_FRAMES_TO_END,
}

/**
 * 推进门限状态机（宿主侧：默认常数 = `DEFAULT_GATE_OPTS`）。
 *
 * 纯函数：不改传入的 state，返回新的 state。算法与浏览器侧同源，见 `src/shared/gate.js`。
 * @param {object} state - 当前状态 {noiseFloor, inSpeech, silentFrames}（不会被修改）。
 * @param {number} level - 本帧的 RMS。
 * @param {object} [opts] - 要覆盖的门限常数，缺省用 DEFAULT_GATE_OPTS。
 * @returns {{feed: boolean, speech: boolean, gate: number, state: object}}。
 */
export const advanceGate = createGate(DEFAULT_GATE_OPTS)
