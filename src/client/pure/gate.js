/**
 * 门限状态机（浏览器侧入口）。
 *
 * 算法不在这里：住在 `src/shared/gate.js`（**单源**，宿主 `lib/gate.js` 用的是同一个模块）。
 *   两侧只有**门限常数**不同：浏览器 VAD clamp 0.008/0.035、连续 1 帧低就退出说话态；
 *   宿主 `/asr-stream` clamp 0.01/0.045、要连续 3 帧。
 *   两侧仍由同一份用例表（`test/fixtures/gate-cases.mjs`）驱动。
 *
 * 分叉过的后果很具体：宿主侧曾把真实语音的低音量帧（rms 0.0255 / 0.0308）
 * 挡在解码器外面，流式只认出「你好明天天怎」，整段非流式却能认出
 * 「你好，今天天气怎么样？」。
 *
 * 本文件能被 Node 原生 import（`main.js` 与测试都直接用它），不依赖浏览器全局。
 */
import { createGate, INITIAL_GATE_STATE } from '../../shared/gate.js'

// 初始底噪也来自同一处：`main.js` 开麦/关麦时重置的 noiseFloor 基准就是这个值，
// 写成字面量的话「算法认为的起点」和「调用方的起点」会分家。
export { INITIAL_GATE_STATE }

/**
 * 浏览器侧现行门限常数（`main.js` 的 VAD 调用点传的就是这一组）。
 * 与宿主的 `DEFAULT_GATE_OPTS` 只差 clamp 与「几帧算说完」。
 */
export const CLIENT_GATE_OPTS = {
  minGate: 0.008,
  maxGate: 0.035,
  multiplier: 2.5,
  offset: 0.003,
  silentFramesToEnd: 1,
}

/**
 * 推进门限状态机（纯函数，默认常数 = `CLIENT_GATE_OPTS`）。
 *
 * @param {object} state - {noiseFloor, inSpeech, silentFrames}，不会被修改。
 * @param {number} level - 本帧 RMS。
 * @param {object} [opts] - 要覆盖的门限常数。
 * @returns {{feed: boolean, speech: boolean, gate: number, state: object}}
 *   本帧的判定与新状态。`speech` 与 `feed` 在本算法下恒等。
 */
export const advanceGate = createGate(CLIENT_GATE_OPTS)
