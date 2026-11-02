/**
 * 全局语音的纯逻辑：VAD 分段状态机、识别文本归一化、AudioWorklet 源码生成。
 *
 * 为什么单独抽成纯函数文件：
 *   1. 分段判据是「说没说完」的唯一依据，写错就会切碎句子或永远不断句；
 *      放在纯函数里可以用 Node 测试直接驱动一串帧能量，不需要浏览器。
 *   2. VAD 在 AudioWorklet 里跑（窗口隐藏时主线程定时器会被 Chromium 节流到
 *      1 次/秒，基于 setInterval 的 VAD 在后台会彻底失效）。Worklet 不能 import
 *      模块，所以这里用 Function.prototype.toString() 把同一份状态机源码内联进
 *      worklet 脚本文本 —— 两处实现只有一份，不会分叉。
 *
 * 本文件**不依赖任何浏览器 API**（window/document/navigator 都不碰），
 * 也不依赖 React，Node 里可原生 import（与 pure/gate.js 同一约定）。
 */

/** 送进会话的语音文本上限（与宿主 /voice-prompt 的 text 上限保持一致）。 */
export const VOICE_TEXT_MAX = 4000

/** AudioWorklet 处理器名：主线程 new AudioWorkletNode 与内联源码必须一致。 */
export const GLOBAL_VAD_PROCESSOR = 'dsh-voice-typing-vad'

/**
 * VAD 默认参数（可被调用方覆盖）。
 *
 * - threshold/minGate/maxGate：门限的绝对下限、自适应底噪门限的夹取范围；
 * - startFrames：连续多少帧超过门限才算「开口」（防爆音/键盘声误触）；
 * - silenceFrames：连续多少帧低于门限才算「说完」；
 * - maxFrames：单段最长帧数，到点强制切段（防内存无限增长）。
 */
export const DEFAULT_VAD_OPTIONS = {
  threshold: 0.012,
  minGate: 0.008,
  maxGate: 0.035,
  multiplier: 2.5,
  offset: 0.003,
  startFrames: 3,
  silenceFrames: 40,
  maxFrames: 11250,
}

/**
 * 新建 VAD 状态。
 *
 * 字段含义：
 *   noiseFloor  —— 底噪估计（只在不在说话时更新）；
 *   inSpeech    —— 是否处于语音段；
 *   silentFrames—— 语音段内连续静音帧数；
 *   loudFrames  —— 非语音段内连续超门限帧数（开口去抖）；
 *   speechFrames—— 当前语音段累计帧数（诊断/上限用）。
 *
 * @returns {object} 初始状态。
 */
export function createVadState() {
  return {
    noiseFloor: 0.004,
    inSpeech: false,
    silentFrames: 0,
    loudFrames: 0,
    speechFrames: 0,
  }
}

/**
 * 推进一帧 VAD 判定。
 *
 * 纯函数：不修改传入的 state，返回新的 state 与事件。
 * 事件语义：
 *   'start' —— 本帧刚刚进入语音段（调用方从这里开始收集音频）；
 *   'end'   —— 本帧刚刚说完（调用方把已收集的音频交给识别）；
 *   null    —— 状态未跨越边界。
 *
 * @param {object} state - 上一帧的状态（null/残缺按初始状态处理）。
 * @param {number} rms - 本帧 RMS 能量。
 * @param {object} [opts] - 覆盖 DEFAULT_VAD_OPTIONS 的参数。
 * @returns {{state: object, event: 'start'|'end'|null, gate: number}} 本帧判定。
 */
export function advanceVad(state, rms, opts) {
  const prev = state || { noiseFloor: 0.004, inSpeech: false, silentFrames: 0, loudFrames: 0, speechFrames: 0 }
  const threshold = Number(opts?.threshold) > 0 ? Number(opts.threshold) : 0.012
  const minGate = Number(opts?.minGate) > 0 ? Number(opts.minGate) : 0.008
  const maxGate = Number(opts?.maxGate) > 0 ? Number(opts.maxGate) : 0.035
  const multiplier = Number(opts?.multiplier) > 0 ? Number(opts.multiplier) : 2.5
  const offset = Number.isFinite(Number(opts?.offset)) ? Number(opts.offset) : 0.003
  const startFrames = Math.max(1, Math.floor(Number(opts?.startFrames) || 3))
  const silenceFramesToEnd = Math.max(1, Math.floor(Number(opts?.silenceFrames) || 40))
  const level = Number.isFinite(Number(rms)) ? Math.max(0, Number(rms)) : 0

  // 底噪只在不在说话中更新：说话时更新会被语音自己抬高，
  // 门限跟着涨，越说越容易被判成静音（与 pure/gate.js 同一个教训）。
  const noiseFloor = prev.inSpeech
    ? Number(prev.noiseFloor) || 0.004
    : (Number(prev.noiseFloor) || 0.004) * 0.95 + level * 0.05
  // 门限取「绝对下限 threshold」与「自适应底噪门限」的较大者，再夹到上限：
  // 安静环境用 threshold 兜底，嘈杂环境自动抬高，不用用户调参。
  const gate = Math.min(
    Math.max(Math.max(threshold, minGate), noiseFloor * multiplier + offset),
    Math.max(maxGate, threshold),
  )

  const inSpeechPrev = prev.inSpeech === true
  let inSpeech = inSpeechPrev
  let silentFrames = Math.max(0, Math.floor(Number(prev.silentFrames) || 0))
  let loudFrames = Math.max(0, Math.floor(Number(prev.loudFrames) || 0))
  let speechFrames = Math.max(0, Math.floor(Number(prev.speechFrames) || 0))
  let event = null

  if (inSpeech) {
    speechFrames += 1
    if (level < gate) silentFrames += 1
    else silentFrames = 0
    if (silentFrames >= silenceFramesToEnd) {
      // 退出语音段：这一帧本身仍是「刚说完的那一下」，
      // 调用方应当把它一起收进段尾（最后一段静音用于定句）。
      inSpeech = false
      silentFrames = 0
      speechFrames = 0
      event = 'end'
    }
  } else {
    if (level >= gate) loudFrames += 1
    else loudFrames = 0
    if (loudFrames >= startFrames) {
      inSpeech = true
      loudFrames = 0
      silentFrames = 0
      speechFrames = 1
      event = 'start'
    }
  }

  return {
    state: { noiseFloor, inSpeech, silentFrames, loudFrames, speechFrames },
    event,
    gate,
  }
}

/**
 * 识别文本归一化：去掉开头常被识别出来的标点、把换行/连续空白压成单空格、去首尾空白。
 *
 * 为什么保留句尾标点：语音说「你好」和「你好。」对模型没有区别，
 * 但保留它不会造成任何损失；反过来把句尾的「？」吃掉会让问句语义变弱。
 *
 * @param {string} raw - 识别返回的原始文本。
 * @returns {string} 归一化后的文本（可能为空串）。
 */
export function normalizeVoiceText(raw) {
  return String(raw ?? '')
    .replace(/^[\s，。！？、,.!?;；:：]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 把文本截断到上限（宿主 /voice-prompt 的 text 上限 4000）。
 *
 * 按码点切，避免把 emoji / 代理对切成半个字符。
 *
 * @param {string} text - 文本。
 * @param {number} [max] - 上限（默认 VOICE_TEXT_MAX）。
 * @returns {string} 截断后的文本。
 */
export function limitVoiceText(text, max = VOICE_TEXT_MAX) {
  const value = String(text ?? '')
  const limit = Math.max(0, Math.floor(Number(max) || VOICE_TEXT_MAX))
  if (value.length <= limit) return value
  return Array.from(value).slice(0, limit).join('')
}

/**
 * 识别文本的完整处理：归一化 + 限长。
 *
 * @param {string} raw - 识别返回的原始文本。
 * @returns {string} 可直接送进会话的文本（空串表示没有可发送内容）。
 */
export function prepareVoiceText(raw) {
  return limitVoiceText(normalizeVoiceText(raw))
}

/**
 * 注入方式归一化：只认 queue/steer，非法值回退 queue。
 *
 * @param {string} value - 配置里的 voicePromptMode。
 * @returns {'queue'|'steer'} 归一化后的模式。
 */
export function normalizeVoicePromptMode(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return text === 'steer' ? 'steer' : 'queue'
}

/**
 * 把毫秒换算成 AudioWorklet 的帧数（每帧 quantum 个采样点）。
 *
 * Worklet 里只知道采样率，不知道「毫秒」；主线程在构造处理器参数时换算一次，
 * 避免两边各算一遍导致阈值不一致。
 *
 * @param {number} ms - 毫秒。
 * @param {number} sampleRate - 采样率（如 48000）。
 * @param {number} [quantum] - 每帧采样点数（AudioWorklet 固定 128）。
 * @returns {number} 帧数（至少 1）。
 */
export function vadFramesForMs(ms, sampleRate, quantum = 128) {
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 48000
  const q = Number(quantum) > 0 ? Number(quantum) : 128
  const frames = Math.round((Number(ms) > 0 ? Number(ms) : 0) / 1000 * rate / q)
  return Math.max(1, frames)
}

/**
 * 生成 AudioWorklet 处理器的源码文本。
 *
 * 为什么用 toString() 内联而不是手写第二份实现：
 *   Worklet 跑在独立线程、不能 import 模块，但它必须和主线程/测试用**同一个**
 *   分段判据。这里把 advanceVad / createVadState 的函数源码直接嵌进脚本，
 *   算法只有一份；测试可以 `new Function(source)` 只做语法校验（不执行）。
 *
 * @param {string} [processorName] - registerProcessor 的名字。
 * @param {object} [options] - 处理器默认参数（可被 processorOptions 覆盖）。
 * @returns {string} 可直接交给 audioWorklet.addModule 的脚本文本。
 */
export function vadWorkletSource(processorName = GLOBAL_VAD_PROCESSOR, options = DEFAULT_VAD_OPTIONS) {
  const defaults = {
    threshold: Number(options?.threshold) > 0 ? Number(options.threshold) : 0.012,
    minGate: Number(options?.minGate) > 0 ? Number(options.minGate) : 0.008,
    maxGate: Number(options?.maxGate) > 0 ? Number(options.maxGate) : 0.035,
    multiplier: Number(options?.multiplier) > 0 ? Number(options.multiplier) : 2.5,
    offset: Number.isFinite(Number(options?.offset)) ? Number(options.offset) : 0.003,
    startFrames: Math.max(1, Math.floor(Number(options?.startFrames) || 3)),
    silenceFrames: Math.max(1, Math.floor(Number(options?.silenceFrames) || 40)),
    maxFrames: Math.max(1, Math.floor(Number(options?.maxFrames) || 11250)),
  }
  return `// 由 src/client/pure/global-voice.js 的 vadWorkletSource() 生成，勿手改。
const createVadState = (${createVadState.toString()});
const advanceVad = (${advanceVad.toString()});
const DEFAULT_OPTIONS = ${JSON.stringify(defaults)};
class GlobalVoiceVadProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const passed = (options && options.processorOptions) || {};
    this.options = Object.assign({}, DEFAULT_OPTIONS, passed);
    this.state = createVadState();
    // 开口前的预录环：把触发 start 的那几帧也带上，否则第一个字会被切掉。
    this.pre = [];
    this.segment = [];
    this.segmentFrames = 0;
    this.port.onmessage = (event) => {
      const data = event && event.data;
      if (data && data.type === 'flush') this._emitSegment(true);
    };
  }
  _emitSegment(forced) {
    if (!this.segment.length) { this.segment = []; this.segmentFrames = 0; return; }
    let total = 0;
    for (let i = 0; i < this.segment.length; i++) total += this.segment[i].length;
    const samples = new Float32Array(total);
    let offset = 0;
    for (let i = 0; i < this.segment.length; i++) {
      samples.set(this.segment[i], offset);
      offset += this.segment[i].length;
    }
    this.port.postMessage({ type: 'segment', samples, forced: forced === true }, [samples.buffer]);
    this.segment = [];
    this.segmentFrames = 0;
  }
  process(inputs) {
    const input = inputs && inputs[0] && inputs[0][0];
    if (!input) return true;
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const result = advanceVad(this.state, rms, this.options);
    this.state = result.state;
    const frame = new Float32Array(input);
    if (result.event === 'start') {
      this.port.postMessage({ type: 'start' });
      this.segment = this.pre.slice();
      this.pre = [];
      this.segment.push(frame);
      this.segmentFrames += 1;
      return true;
    }
    if (result.event === 'end') {
      // 说完的那一帧（静音）也收进段尾：识别器需要它来定句。
      if (this.segment.length) this.segment.push(frame);
      this._emitSegment(false);
      return true;
    }
    if (this.state.inSpeech) {
      this.segment.push(frame);
      this.segmentFrames += 1;
      if (this.segmentFrames >= this.options.maxFrames) this._emitSegment(true);
      return true;
    }
    // 空闲：只保留最近 startFrames 帧作预录，别无限缓存静音。
    this.pre.push(frame);
    while (this.pre.length > this.options.startFrames) this.pre.shift();
    return true;
  }
}
registerProcessor(${JSON.stringify(processorName)}, GlobalVoiceVadProcessor);
`
}

/* ================= 当前会话解析（全局浮层用） ================= */

/**
 * 把一个可能是时间戳的字段收敛成数值（毫秒）。
 *
 * 为什么不能直接 Number()：
 *   客户端会话行里的 `updatedAt` 在新创建的行上是 `Date.now()` 数字，
 *   但底层 session-info schema 允许字符串；ISO 字符串直接 Number() 会得 NaN，
 *   这个会话就会被当成「没有时间」而在排序里排到最后。
 *
 * @param {unknown} value - 数字 / 数字字符串 / 日期字符串。
 * @returns {number} 毫秒时间戳；无法解析返回 -Infinity（排序时最旧）。
 */
function toTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return -Infinity
    const asNumber = Number(text)
    if (Number.isFinite(asNumber)) return asNumber
    const parsed = Date.parse(text)
    if (Number.isFinite(parsed)) return parsed
  }
  return -Infinity
}

/**
 * 一个会话行的「最近活跃时间」。
 *
 * 真源形状（@deepseek-ai/dsh-api-session-controller 的 projectList）：
 *   - `projectionValues.sessionListMetadata.lastPromptAt`：最近一次**人类**提示的
 *     时间（number|null，官方注明 "Latest human-authored prompt time"）；
 *   - `updatedAt`：目录行更新时间（新建会话是 Date.now() 数字，旧路径可能是字符串）；
 *   - `createdAt` / `lastActiveAt`：不同版本/投影可能有，存在就参与比较。
 * 取这些字段的最大值：任何一个更新都说明这个会话更「近」。
 *
 * @param {object} row - byId 里的会话行。
 * @returns {number} 毫秒时间戳；都没有返回 -Infinity。
 */
function sessionRecency(row) {
  let best = -Infinity
  const fields = [
    row?.projectionValues?.sessionListMetadata?.lastPromptAt,
    row?.lastPromptAt,
    row?.updatedAt,
    row?.createdAt,
    row?.lastActiveAt,
  ]
  for (const value of fields) {
    const at = toTimestamp(value)
    if (at > best) best = at
  }
  return best
}

/**
 * 判断一行是不是「子代理会话」。
 *
 * 为什么排序时要跳过它们：子代理的目录行也挂在同一个 `byId` 里
 * （`origin: 'subagent'`），但用户说的「当前/最近的会话」绝不该是子代理；
 * 不跳过的话，刚跑过子代理就会把语音发进子代理的会话。
 * 注意不能靠 `parentId` 判断：fork 出来的用户会话也有 parentId。
 *
 * @param {object} row - byId 里的会话行。
 * @returns {boolean} 是否子代理行。
 */
function isSubagentRow(row) {
  return row?.origin === 'subagent'
}

/**
 * 候选会话键：`snapshot.ids` 的顺序优先，再把只存在于 byId 里的键按对象顺序补上。
 *
 * 为什么两个来源都要：ids 是渲染顺序（权威），但列表刷新/子代理投影可能让
 * byId 里出现 ids 尚未包含的行；只信一个来源会在「ids[0] 指向已删除会话」时
 * 直接返回空串 —— 那正是本次要修掉的「明明有会话却说没有」。
 *
 * @param {object} snapshot - SessionListState 快照。
 * @param {object} byId - byId 表。
 * @returns {string[]} 去重后的候选键（ids 顺序在前）。
 */
function candidateSessionKeys(snapshot, byId) {
  const keys = []
  const seen = new Set()
  if (Array.isArray(snapshot?.ids)) {
    for (const id of snapshot.ids) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue
      seen.add(id)
      keys.push(id)
    }
  }
  for (const key of Object.keys(byId)) {
    if (seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
}

/**
 * 从会话列表快照里找「主视图正在看」的会话 id。
 *
 * 判据与 DSH 核心一致：`retainedBy.mainView > 0`。
 * 遍历顺序固定为 snapshot.ids → byId 键顺序，保证同样的快照永远选同一个。
 *
 * @param {object|null} snapshot - SessionListState 快照（{ids, byId}）。
 * @returns {string} 会话 id；没有返回空串。
 */
export function findMainViewSessionId(snapshot) {
  try {
    const byId = snapshot?.byId && typeof snapshot.byId === 'object' ? snapshot.byId : null
    if (!byId) return ''
    const keys = candidateSessionKeys(snapshot, byId)
    for (const key of keys) {
      const row = byId[key]
      if (!row || typeof row !== 'object') continue
      const retained = row.retainedBy
      const mainView = retained && typeof retained === 'object' ? Number(retained.mainView) : 0
      if (mainView > 0) return String(row.id ?? key)
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * 解析「当前应该把语音文本送进哪个会话」。
 *
 * 优先级（修复「设置页启用浮层后一直提示没有当前会话」的根因）：
 *   1. `retainedBy.mainView > 0` —— 用户正在看的会话（核心同款判据）；
 *   2. `options.lastKnown` —— 上次持久化的主视图会话，只要它还在列表里就用它
 *      （从对话页切到设置页后，主视图保留消失，但会话没变）；
 *   3. 最近的会话 —— 按 lastPromptAt/updatedAt/createdAt/lastActiveAt 最大值，
 *      跳过子代理行；并列时按 ids 顺序取第一个（确定性）；
 *   4. `snapshot.ids[0]`（若在 byId 里存在），否则 byId 的第一个键；
 *   5. 空列表/畸形快照返回 ''。
 *
 * 这个函数**绝不抛错**：快照来自宿主，任何字段都可能缺失或类型不同；
 * 解析失败就让浮层走「新建会话」或提示没有会话，不能让浮层崩掉。
 *
 * @param {object|null} snapshot - SessionListState 快照（{ids, byId}）。
 * @param {{lastKnown?: string}} [options] - 持久化的上次主视图会话 id。
 * @returns {string} 要发送到的会话 id；没有可用会话返回空串。
 */
export function pickSessionId(snapshot, options = {}) {
  try {
    const byId = snapshot?.byId && typeof snapshot.byId === 'object' ? snapshot.byId : null
    if (!byId) return ''
    const keys = candidateSessionKeys(snapshot, byId)
    if (!keys.length) return ''

    // 1) 主视图（含 origin 子代理行也无所谓：只要主视图真在看它）
    const mainViewId = findMainViewSessionId(snapshot)
    if (mainViewId) return mainViewId

    // 2) 持久化的上次主视图会话：必须还在 byId 里（陈旧的 id 不能直接用，
    //    否则会把文本发进一个已经不存在的会话）。
    const lastKnown = typeof options?.lastKnown === 'string' ? options.lastKnown : ''
    if (lastKnown && Object.prototype.hasOwnProperty.call(byId, lastKnown)) {
      const row = byId[lastKnown]
      if (row && typeof row === 'object') return String(row.id ?? lastKnown)
    }

    // 3) 最近的用户会话（跳过子代理；时间戳并列时保留先出现的，保证确定性）
    let bestId = ''
    let bestAt = -Infinity
    for (const key of keys) {
      const row = byId[key]
      if (!row || typeof row !== 'object') continue
      if (isSubagentRow(row)) continue
      const at = sessionRecency(row)
      if (at > bestAt) {
        bestAt = at
        bestId = String(row.id ?? key)
      }
    }
    if (bestId) return bestId

    // 4) 兜底：ids 顺序里第一个真实存在于 byId 的行，否则 byId 的第一个键
    for (const key of keys) {
      if (byId[key] && typeof byId[key] === 'object') return String(byId[key].id ?? key)
    }
    for (const key of Object.keys(byId)) {
      if (byId[key] && typeof byId[key] === 'object') return String(byId[key].id ?? key)
    }
    return ''
  } catch {
    return ''
  }
}

/* ================= v3 唤醒词匹配 ================= */

/** 开头可忽略的语气词（呃/喂/嗯/我说，可重复）。 */
const WAKE_FILLER_PATTERN = /^(?:呃+|喂+|嗯+|我说)/

/**
 * 唤醒/剩余文本边界上的「噪声」：空白、中英文标点、引号与括号。
 * 用同一个字符集处理开头剥离与剩余文本裁剪，避免两处定义漂移。
 */
const WAKE_EDGE_NOISE_PATTERN = /[\s，。！？、,.!?;；:：…·~～"'“”‘’「」『』（）【】]/

/**
 * 剥掉剩余文本开头的标点/空白（唤醒词后面通常跟一个逗号或空格）。
 * @param {string} text - 文本。
 * @returns {string} 去掉开头噪声后的文本（仍会 trim）。
 */
function stripWakeLeadNoise(text) {
  let start = 0
  while (start < text.length && WAKE_EDGE_NOISE_PATTERN.test(text[start])) start += 1
  return text.slice(start).trim()
}

/**
 * 判断两个字符串的编辑距离是否 ≤ 1（Levenshtein 的「最多一处编辑」特化）。
 *
 * 只关心「是不是只差一个字」，不需要完整距离矩阵：
 * 长度差 > 1 直接 false；长度相同时数不匹配字符；差 1 时允许跳过一处。
 *
 * @param {string} a - 文本 A（已小写）。
 * @param {string} b - 文本 B（已小写）。
 * @returns {boolean} 是否至多一处编辑。
 */
function withinOneEdit(a, b) {
  if (a === b) return true
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i += 1
      j += 1
      continue
    }
    edits += 1
    if (edits > 1) return false
    if (la > lb) i += 1
    else if (lb > la) j += 1
    else {
      i += 1
      j += 1
    }
  }
  if (i < la || j < lb) edits += 1
  return edits <= 1
}

/**
 * v3 唤醒词匹配。
 *
 * 为什么要容忍语气词/标点/一个字的误差：
 *   用户是**说话**，不是打字。识别结果经常是「嗯，小D，打开设置」、
 *   「小滴打开设置」（同音字错一个）。如果唤醒词必须逐字精确、且必须从
 *   第一个字开始，用户会喊很多遍都唤不醒 —— 这比误唤醒更伤体验。
 *
 * 但误唤醒的代价也很大（常开麦待机，任何环境闲聊都可能被当成命令），所以：
 *   - 只允许**开头**匹配（前 4 个字符窗口内），句中任意位置出现一律不算；
 *   - 唤醒词 ≥2 字时才允许 1 个字的编辑距离（单字唤醒词没有容错空间）；
 *   - 唤醒词为空 = 关闭唤醒词（返回不匹配，调用方走 v2 原逻辑）。
 *
 * @param {string} text - 已做 prepareVoiceText 的识别文本。
 * @param {string} wakeWord - 配置里的唤醒词（可能带首尾空白）。
 * @returns {{matched:boolean, rest:string, via:'head'|'fuzzy'|''}}
 *   matched=是否命中；rest=去掉唤醒词后的剩余命令（未命中时是原文本）；
 *   via=命中方式（head 精确开头 / fuzzy 容错 1 字 / '' 未命中）。
 */
export function matchWakeWord(text, wakeWord) {
  const rawText = String(text ?? '')
  const rawWake = String(wakeWord ?? '').trim()
  // 空唤醒词 = 关闭：把原文原样交回调用方（rest 必须是原文，别丢内容）。
  if (!rawWake) return { matched: false, rest: rawText, via: '' }

  // 1) 剥掉开头的语气词与标点：定位「唤醒词可能开始的位置」。
  //    循环处理「标点 + 语气词 + 标点」的混排（最多 8 轮防空转）。
  let start = 0
  for (let guard = 0; guard < 8; guard += 1) {
    const before = start
    while (start < rawText.length && WAKE_EDGE_NOISE_PATTERN.test(rawText[start])) start += 1
    const filler = WAKE_FILLER_PATTERN.exec(rawText.slice(start))
    if (filler) start += filler[0].length
    if (start === before) break
  }
  const head = rawText.slice(start)
  if (!head) return { matched: false, rest: rawText, via: '' }
  const lowerHead = head.toLowerCase()
  const lowerWake = rawWake.toLowerCase()

  // 2) 精确开头匹配（大小写不敏感）：唤醒词 + 命令连说也走这条路。
  if (lowerHead.startsWith(lowerWake)) {
    return {
      matched: true,
      rest: stripWakeLeadNoise(head.slice(rawWake.length)),
      via: 'head',
    }
  }

  // 3) 容错 1 字：**唤醒词至少 3 个字**才启用。
  //
  // 为什么 2 字不启用（评审 P1-1）：对「小D」这种两字唤醒词，1 个字容错 =
  // 只要求「小」对得上、第二个字随便 —— 「小区门口」「小张来了」都会唤醒，
  // 随即把尾巴当命令送进会话（隐私泄漏 + 命令被吞掉首字）。两字词必须精确匹配
  //（仍允许开头语气词/标点被剥掉，见上一步）。
  //
  // 匹配窗口锚定在**开头**（不允许前面有任意前缀）：这是「不允许句中匹配」的
  // 落地方式 —— 否则「请打开小D」会因为唤醒词出现在前 4 个字符窗口里而误唤醒。
  // 语气词/标点已在上面剥掉，正常的「嗯，小D…」不会损失容错。
  if (rawWake.length >= 3) {
    // 编辑距离 1 可能是错一个字 / 多一个字 / 少一个字，对应三种消耗长度；
    // 先试「等长替换」（最常见，同音字），再试多/少一个字。
    for (const consumed of [rawWake.length, rawWake.length + 1, rawWake.length - 1]) {
      if (consumed < 1 || consumed > head.length) continue
      const candidate = head.slice(0, consumed)
      if (candidate.length < Math.max(1, rawWake.length - 1)) continue
      if (withinOneEdit(candidate.toLowerCase(), lowerWake)) {
        return {
          matched: true,
          rest: stripWakeLeadNoise(head.slice(consumed)),
          via: 'fuzzy',
        }
      }
    }
  }

  // 4) 开头附近都不是唤醒词：待机时必须丢弃这句话（不能把它当命令发出去）。
  return { matched: false, rest: rawText, via: '' }
}

/* ================= 快捷键平台别名 ================= */

/**
 * 快捷键的平台别名（当前只有 macOS 的默认组合）。
 *
 * 为什么需要：默认「全局语音快捷键」是 Ctrl+Alt+V —— 这是 Windows/Linux 的习惯；
 * macOS 上用户的直觉是 Cmd(⌘)+Alt+V。配置值保持 Ctrl+Alt+V 不变（设置面板与
 * 持久化不随平台漂移、不会出现「我的设置怎么变了」），只在**匹配**时额外接受
 * Meta+Alt+V。
 *
 * 只对默认值生效：用户自定义的组合不猜测、不翻译 —— 否则会在用户不知情时
 * 多出一条热键，反而制造意外触发。
 *
 * @param {string} combo - 配置里的组合键（如 `Ctrl+Alt+V`）。
 * @param {string} platform - 平台标识（navigator.platform / userAgent；含 mac/darwin 即视为 macOS）。
 * @returns {string[]} 实际接受的组合键列表；第一个元素始终是原配置（空配置返回空数组）。
 */
export function effectiveShortcut(combo, platform) {
  const text = String(combo ?? '').trim()
  if (!text) return []
  const list = [text]
  const isDarwin = /mac|darwin/i.test(String(platform ?? ''))
  if (isDarwin && text.toLowerCase() === 'ctrl+alt+v') list.push('Meta+Alt+V')
  return list
}

