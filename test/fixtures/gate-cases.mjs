/**
 * 共享用例表：流式门限状态机（宿主侧 + 浏览器侧共用）。
 *
 * 这个文件**不依赖任何模块**（浏览器侧也能直接 import），
 * 只导出数据 + 算法契约，两侧各跑一遍，断言结果一致。
 *
 * ============================== 用法 ==============================
 *
 * 宿主侧（Node）：
 *   import { GATE_CASES, GATE_OPTS, GATE_INITIAL_STATE } from './fixtures/gate-cases.mjs'
 *   const { advanceGate } = await import('../../lib/index.js')
 *
 * 浏览器侧（不能 import Node 模块，要在客户端实现同一套算法）：
 *   1) import { GATE_CASES, GATE_OPTS, GATE_INITIAL_STATE } from '.../gate-cases.mjs'
 *   2) 在客户端实现同名同签名的 advanceGate(state, level, opts)；
 *   3) 用下面的循环跑一遍。
 *
 * 跑法（两侧通用）：
 *   let state = { ...GATE_INITIAL_STATE }
 *   const fed = c.levels.map((level) => {
 *     const r = advanceGate(state, level, { ...GATE_OPTS, ...(c.opts ?? {}) })
 *     state = r.state
 *     return r.feed          // 宿主看 feed；浏览器侧看 speech（两者恒等，见下）
 *   })
 *   assert.deepEqual(fed, c.expectFed)
 *   assert.deepEqual(
 *     { inSpeech: state.inSpeech, silentFrames: state.silentFrames },
 *     c.expectFinal,
 *   )
 *
 * ============================== 契约 ==============================
 *
 * 纯函数：advanceGate(state, level, opts)
 *   @param {{noiseFloor:number, inSpeech:boolean, silentFrames:number}} state
 *   @param {number} level  本帧 RMS
 *   @param {{minGate:number, maxGate:number, multiplier:number, offset:number,
 *           silentFramesToEnd:number}} opts
 *   @returns {{feed:boolean, speech:boolean, gate:number,
 *              state:{noiseFloor:number, inSpeech:boolean, silentFrames:number}}}
 *
 *   - **纯函数**：不改传入的 state，返回**新** state（只有那三个字段）。
 *   - feed   ：本帧要不要喂给解码器（宿主 `/asr-stream` 用）。
 *   - speech ：本帧算不算「有语音」（浏览器侧 VAD 用）。
 *     注意：speech **不是**简单的 level > gate，而是
 *     「本帧超过门限 **或** 上一帧结束时处于说话态」。
 *     说话段内的帧一律算语音 —— 汉语的轻声、句尾的下降音天然偏低，
 *     判成「没人说话」的话这部分音频会被切掉，识别结果会截断。
 *     在本算法下 feed 与 speech **恒等**，所以一张 expectFed 表两侧通用。
 *   - 浏览器侧要判断「说话段结束了没有」，看返回的 state.inSpeech，
 *     不要用 speech（speech 在结束那一帧仍然是 true）。
 *
 * 算法（两侧必须完全一致，否则同一张表会跑出不同结果）：
 *   1. 底噪**只在不在说话中**时更新：noiseFloor = noiseFloor * 0.95 + level * 0.05
 *      （每帧都更新的话，说话时底噪被自己的声音抬高 → 门限跟着抬高 →
 *        越说越容易被判成静音 → 语音被自己的声音挡掉）；
 *   2. 门限：gate = min(max(minGate, noiseFloor * multiplier + offset), maxGate)；
 *   3. 说话中：低于门限就 silentFrames += 1，否则清零；
 *      silentFrames 达到 silentFramesToEnd 才退出说话态（并把 silentFrames 清零）；
 *   4. 不在说话中：低于门限 → 本帧不算语音、不喂给解码器；
 *      否则进入说话态（inSpeech = true，silentFrames = 0）并开始喂。
 *
 * 两侧的常数不同（宿主 clamp(0.01, 0.045)，浏览器侧 clamp(0.008, 0.035)），
 * 由 opts 传入。**本表的期望值在两套常数下都成立** ——
 * 用例是刻意挑的：所有用例算出来的门限都落在 0.0108 ~ 0.0300 之间，
 * 严格落在两侧 clamp 区间（宿主 0.01~0.045、浏览器侧 0.008~0.035）内部，
 * 所以谁都不会碰到 clamp 边界，换常数算出来的结果完全一样。
 */

/**
 * 门限常数（宿主侧默认值；两侧都用这一份跑用例表）。
 *
 * 浏览器侧生产代码用的是自己那套（clamp 0.008 / 0.035），
 * 但跑这张表时传这份，两边的结果才一致。
 */
export const GATE_OPTS = {
  /** 门限下限：再安静也不低于这个值。 */
  minGate: 0.01,
  /** 门限上限：再吵也不高于这个值。 */
  maxGate: 0.045,
  /** 门限相对底噪的倍数。 */
  multiplier: 2.5,
  /** 门限的固定偏移量。 */
  offset: 0.003,
  /** 连续多少帧低于门限才判定「说完了」。 */
  silentFramesToEnd: 3,
}

/** 每条用例的初始状态（新的流/新的会话都从这个状态开始）。 */
export const GATE_INITIAL_STATE = {
  /** 底噪估计的初值。 */
  noiseFloor: 0.004,
  /** 是否处于「说话中」。 */
  inSpeech: false,
  /** 说话中连续低于门限的帧数。 */
  silentFrames: 0,
}

/**
 * 用例表。
 *
 * 每条用例的字段：
 *   - name       ：中文标题（测试输出里用）。
 *   - why        ：这条用例防的是什么回归（可选）。
 *   - levels     ：逐帧 RMS（一帧 = 客户端一次送音频，约 0.4 秒）。
 *   - opts       ：本条用例专用的常数覆盖（可选，缺省用 GATE_OPTS）。
 *   - expectFed  ：逐帧「这一帧要不要喂给解码器」，与 levels 等长（必填）。
 *   - expectFinal：跑完这一串之后的状态（可选）：
 *                   { inSpeech, silentFrames }。
 */
export const GATE_CASES = [
  {
    name: '纯静音一帧都不喂',
    why: '静音喂给解码器，模型会对着噪声凭空造字。',
    levels: [0.0001, 0.0002, 0.0001, 0.0002, 0.0001],
    expectFed: [false, false, false, false, false],
    expectFinal: { inSpeech: false, silentFrames: 0 },
  },
  {
    name: '持续低噪一帧都不喂',
    why: '底噪抬高后门限要跟着抬高，否则环境噪声被喂进模型。',
    levels: [0.012, 0.014, 0.016, 0.012, 0.014, 0.016, 0.012, 0.014],
    expectFed: [false, false, false, false, false, false, false, false],
    expectFinal: { inSpeech: false, silentFrames: 0 },
  },
  {
    name: '低噪环境里突然出现语音，语音要被喂',
    why: '环境有底噪时，真正的语音仍然要能进。',
    levels: [0.012, 0.013, 0.012, 0.012, 0.05, 0.06],
    expectFed: [false, false, false, false, true, true],
    expectFinal: { inSpeech: true, silentFrames: 0 },
  },
  {
    name: '真实语音序列里所有非零帧都要被喂',
    why:
      '回归：低音量帧（rms 0.0255 / 0.0308）之前被门限挡掉，' +
      '流式只认出「你好明天天怎」，整段非流式却能认出「你好，今天天气怎么样？」。',
    levels: [0.0410, 0.0815, 0.0255, 0.0482, 0.0308, 0.0485, 0.0512, 0.0000, 0.0000],
    // 尾部两个静音帧也要喂：说话刚结束时的那点静音是解码器定句需要的。
    expectFed: [true, true, true, true, true, true, true, true, true],
    expectFinal: { inSpeech: true, silentFrames: 2 },
  },
  {
    name: '说话中连续 3 帧静音才退出说话态',
    why: '说完之后要能把说话态收掉，后面的静音才不用再喂。',
    levels: [0.05, 0.06, 0.0, 0.0, 0.0, 0.0],
    // 第 3 个静音帧仍然要喂（它是「说完」的那一帧，喂了解码器才能定句），
    // 第 4 个静音帧起不再喂。
    expectFed: [true, true, true, true, true, false],
    expectFinal: { inSpeech: false, silentFrames: 0 },
  },
  {
    name: '说话中单帧静音不退出说话态',
    why: '汉语的轻声、句尾的下降音天然偏低，一帧就中断的话识别结果会截断。',
    levels: [0.05, 0.06, 0.001, 0.05],
    expectFed: [true, true, true, true],
    expectFinal: { inSpeech: true, silentFrames: 0 },
  },
  {
    name: '门限常数可注入：抬高下限后弱语音被挡',
    why:
      '两端常数不同（宿主 clamp 0.01/0.045，浏览器侧 clamp 0.008/0.035），' +
      '所以门限常数必须能通过 opts 传进来，而不是写死在实现里。' +
      '同样这串 level，用默认常数时是会被喂的。',
    opts: { minGate: 0.03 },
    levels: [0.025, 0.025],
    expectFed: [false, false],
    expectFinal: { inSpeech: false, silentFrames: 0 },
  },
]

/**
 * 把一条用例跑完，返回逐帧结果与结束状态。
 * 两侧测试都可以直接用它（只要提供自己的 advanceGate）。
 *
 * @param {object} gateCase - 用例表里的一条。
 * @param {Function} advanceGate - 纯函数 advanceGate(state, level, opts)。
 * @param {object} [opts] - 用例没有自带 opts 时用的常数（缺省 GATE_OPTS）。
 * @returns {{fed: boolean[], speech: boolean[], gates: number[], final: object}}。
 */
export function runGateCase(gateCase, advanceGate, opts = GATE_OPTS) {
  const effective = { ...opts, ...(gateCase.opts ?? {}) }
  let state = { ...GATE_INITIAL_STATE }
  const fed = []
  const speech = []
  const gates = []
  for (const level of gateCase.levels) {
    const result = advanceGate(state, level, effective)
    state = result.state
    fed.push(Boolean(result.feed))
    speech.push(Boolean(result.speech))
    gates.push(result.gate)
  }
  return {
    fed,
    speech,
    gates,
    final: { inSpeech: state.inSpeech, silentFrames: state.silentFrames },
  }
}
