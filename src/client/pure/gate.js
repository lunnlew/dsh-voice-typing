/**
 * 门限状态机（纯函数）。
 *
 * 宿主侧（/asr-stream）与浏览器侧（VAD）用**同一套算法**，
 * 由同一份用例表（test/fixtures/gate-cases.mjs）驱动，
 * 防止「同一判据两处实现」分叉。
 *
 * 分叉过的后果很具体：宿主侧曾把真实语音的低音量帧
 * （rms 0.0255 / 0.0308）挡在解码器外面，
 * 流式只认出「你好明天天怎」，整段非流式却能认出「你好，今天天气怎么样？」。
 */

/**
 * 推进门限状态机。
 *
 * 语义：
 *   底噪**只在不在说话中时**更新 —— 否则说话时底噪被语音自己抬高，
 *   门限跟着涨，越说越容易被判成静音。
 *   进入说话态后，单帧偏低不退出（汉语轻声、句尾下降音天然偏低）；
 *   连续若干帧都低才退出。
 *
 * 纯函数：不修改传入的 state，返回新的 state。
 *
 * @param {object} state - {noiseFloor, inSpeech, silentFrames}。
 * @param {number} level - 本帧 RMS。
 * @param {object} opts - {minGate, maxGate, multiplier, offset, silentFramesToEnd}。
 * @returns {{feed: boolean, speech: boolean, gate: number, state: object}} 本帧的判定与新状态。
 */
export function advanceGate(state, level, opts) {
  const prev = state || { noiseFloor: 0.004, inSpeech: false, silentFrames: 0 }
  const minGate = opts?.minGate ?? 0.008
  const maxGate = opts?.maxGate ?? 0.035
  const multiplier = opts?.multiplier ?? 2.5
  const offset = opts?.offset ?? 0.003
  const silentFramesToEnd = opts?.silentFramesToEnd ?? 1

  // 1) 底噪只在不在说话中时更新
  const noiseFloor = prev.inSpeech
    ? prev.noiseFloor
    : prev.noiseFloor * 0.95 + level * 0.05

  // 2) 门限
  const gate = Math.min(Math.max(minGate, noiseFloor * multiplier + offset), maxGate)

  // 3) 说话态推进
  let inSpeech = prev.inSpeech
  let silentFrames = prev.silentFrames
  let feed = false
  if (inSpeech) {
    if (level < gate) silentFrames += 1
    else silentFrames = 0
    if (silentFrames >= silentFramesToEnd) {
      inSpeech = false
      silentFrames = 0
    }
    // 说话中一律喂 —— 包括「退出说话态」的那一帧。
    // 那一帧是「刚说完」的那一下，喂给解码器它才能定句。
    feed = true
  } else if (level < gate) {
    feed = false
    silentFrames = 0
  } else {
    inSpeech = true
    silentFrames = 0
    feed = true
  }
  return {
    feed,
    // 与 feed 恒等：说话段内的帧一律算语音。
    speech: feed,
    gate,
    state: { noiseFloor, inSpeech, silentFrames },
  }
}
