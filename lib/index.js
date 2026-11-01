/**
 * dsh-voice-typing —— 宿主侧（Node 侧）。
 *
 * 提供 HTTP 路由供浏览器侧的麦克风控件使用。下列路径都带
 * `/dsh-voice-typing` 前缀（下文省略）：
 *
 *   POST      /transcribe                  录音 → 文字（请求体是 f32 PCM）
 *   POST      /asr-stream?sessionId=…      边喂边出字（实时文字）
 *   POST      /asr-stream/reset?sessionId=…  结束流式并彻底丢弃状态
 *   GET       /tts?text=…                  文字 → 音频（online 出 MP3，local/neural 出 WAV）
 *   GET       /voices?engine=…             音色列表（在线 Edge 列表 / 本地系统语音）
 *   GET       /tts/env                     合成运行环境自检（引擎可用性、平台能力）
 *   GET       /tts/warmup                  预热在线 TTS 连接（本地引擎无连接概念，直接返回）
 *   GET       /asr-ready                   识别模型是否已下载 + 已加载（客户端开麦前先问）
 *   POST      /asr-warmup                  确保识别模型真的加载好（没就绪就等到就绪）
 *   GET       /latest-message?sessionId=…  本轮 assistant 回复全文（**客户端仍用 turnAnchor/turnKey，先保留**）
 *   GET       /busy                        助手是否正在生成（降级用，优先用 assistant-busy 事件）
 *   POST      /voice-session               客户端心跳上报（诊断用）
 *   GET/POST  /config                      当前生效配置 / 保存配置
 *   GET       /diagnostics                 诊断信息（统计、忙碌状态、下载进度）
 *   GET       /models                      模型档位清单与本地状态（识别 + 合成）
 *   POST      /model                       下载/准备指定档位
 *   GET       /stream                      SSE：turn-begin / turn-end / call-end / sentence /
 *                                           assistant-busy / model-progress /
 *                                           model-ready / model-error
 *
 * SSE 事件信封（协议版本 v3）：
 *   每个事件的 data 都是同一个信封，事件自己的字段**平铺**在信封字段之后：
 *
 *     event: sentence
 *     data: {"v":3,"seq":12,"ts":1735000000000,"sessionId":"s1","text":"你好","turnId":"turn-x","index":0}
 *
 *   - v       —— 协议版本，当前为 3（见 lib/sse-envelope.js 的 EVENT_PROTOCOL_VERSION）。
 *                v3 把「一次调用结束」改名为 call-end，turn-end 专指真正的一轮结束。
 *   - seq     —— 全局单调递增的整数（模块级计数器，每次广播 +1，与订阅者数量无关）。
 *                客户端可以用它发现丢事件（seq 跳号 = 中间少了一条）。
 *   - ts      —— 事件产生时刻（epoch 毫秒）。
 *   - sessionId —— 归属会话；null 表示全局事件（例如模型下载进度）。
 *   后面是事件自己的字段（text / turnId / index / busy / kind / percent …）。
 *
 * 朗读的句子由 `lib/read-aloud-scheduler.js` 决定「什么时候发」：
 * 主路径是**客户端播放进度流控**（客户端每开始播一句回 /reading-ack，宿主补发）；
 * 收不到 ack 的老客户端降级为旧的 400ms 时间窗口节奏。
 * 后者用 lib/read-aloud-policy.js 里的 `EMIT_WINDOW_MS`。
 * 长回复会「追赶最新」：积压超预算（默认 7.5 秒）就整段跳到最新 3 段，
 * 生成很快时每段只读首句（详见 scheduler 文件头）。
 * 首句不排队，立刻发；代码块（```…```）里的内容**一律不朗读**。
 *
 * 识别后端按所选档位切换。三档都是 sherpa-onnx 本地推理，区别只在模型文件：
 *   - sensevoice：离线 SenseVoice，复用 DSH 已装好的模型文件
 *     （~/.dsh/speech-to-text），零下载、零密钥；
 *   - whisper-*  ：sherpa-onnx 离线 Whisper（int8 量化）；
 *   - zipformer2-zh：sherpa-onnx 流式 zipformer2（在线 transducer）。
 * 注意：sensevoice 档位**不是**去调用宿主的 speech-to-text 服务，
 * 而是用宿主那份模型文件在本进程内跑 sherpa-onnx。
 *
 * 线程分工（两个模型都很重，绝不能放在宿主主线程里跑）：
 *   - 识别 → lib/asr-worker.js。zipformer2 是流式模型，必须用
 *     OnlineRecognizer + isReady/inputFinished 的解码方式；
 *     用 OfflineRecognizer 配 transducer 会让 sherpa 的原生代码直接终止进程
 *     （整个桌面应用退出），所以这一档在 worker 里也走流式解码。
 *   - 本地神经合成 → lib/tts-worker.js。VITS 解码是 CPU 密集的同步计算，
 *     实测 RTF 约 0.35（一句话就要占住主线程 1 秒）。
 *
 * 模型预加载与空闲释放（见 DEFAULTS.preloadModels / idleReleaseMinutes）：
 *   - 启用某个档位后，后台先把模型读进内存，用户第一次说话就不用干等
 *     （zipformer2 首次要 40 秒，神经 TTS 也要几十秒）。
 *   - 模型常驻内存（zipformer2 160MB / 神经 TTS 170MB），闲置超过设定时长
 *     就自动释放。识别模型要显式通知工作线程释放 —— 它住在 worker 里，
 *     宿主主线程的 Map 是空的，光清 Map 什么都不会释放。
 *
 * 热词提示（词表里只写「正确」、不写「=错误」的条目）：
 *   只有 transducer 档位（zipformer2）支持，运行时传给识别器做偏置。
 *   SenseVoice 的热词要烘进模型文件，运行期给不了。
 *
 * 响应约定（客户端要对接的字段）：
 *   - /transcribe → {text, model, language, hotwords, speech}
 *       hotwords 是词表里「纯字符串」条目（热词提示，不改文本）；
 *       speech=true 表示宿主确认这段音频里检测到了人声。
 *   - /asr-stream → {text, model, speech}
 *       模型不可用时 → {text:'', unavailable:true, reason:'…', model}
 *       （reason 是人话原因，客户端要能感知到「实时文字不可用」，别静默）。
 *   - /asr-stream/reset → {text, discarded, model}
 *       discarded=true 表示该会话的流对象与状态已被彻底丢弃（下一轮从零开始）。
 *   - /models → 每项带 host:true|false（true = 宿主内置模型，不需要下载）。
 *   - /config → **只有配置本身**（不含 stats 等诊断数据）。
 *       诊断数据走 /diagnostics —— 混在配置里的话，
 *       客户端会把整个响应当 config 用、再原样 POST 回来。
 *
 * @module dsh-voice-typing
 */

import { readFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { writeFileAtomic } from './atomic-file.js'
import { synthesizeSpeech, listVoices, warmUpTts } from './edge-tts.js'
import { synthesizeLocal, listLocalVoices, isLocalSupported, defaultLocalVoice } from './local-tts.js'
import { synthesizeNeural, listSpeakers, encodeWav, disposeNeuralTts, preloadNeural, releaseNeural } from './neural-tts.js'
import { synthesizeSovits, DEFAULT_SOVITS_URL } from './sovits-tts.js'
import { checkTtsEnvironment } from './tts-env.js'
import { createTurnModel } from './turn-model.js'
import { postProcessWithMeta, parseWordEntries } from './text-rules.js'
import { createReadAloudScheduler } from './read-aloud-scheduler.js'
import { createFenceFilter } from './fence-filter.js'
import {
  TTS_ENGINES,
  normalizeTtsEngine,
  sanitizeConfig,
  validateConfigPatch,
} from './config-schema.js'
import {
  MODELS,
  findModel,
  listModels,
  ensureModel,
  isModelReady,
  isHostedModel,
  modelPaths,
  TTS_MODELS,
  findTtsModel,
  ttsModelPaths,
} from './model-catalog.js'

/** 配置默认值。 */
const DEFAULTS = {
  /** 识别模型档位。 */
  model: 'sensevoice',
  /** 识别语言提示。 */
  language: 'auto',
  /**
   * 「边说边出字」的实时字用哪种方式：
   *   - 'full'  ：每 900ms 把当前整段音频重新识别一遍（默认）。
   *              精度最好（与最终稿同源），但段越长越慢 —— 复杂度 O(n²)。
   *   - 'stream'：用流式模型（zipformer2）边喂边解码，只喂新增音频。
   *              延迟低、长段不变慢，但精度略低于整段重识别。
   *   - 'auto'  ：当前模型是流式模型就用流式，否则用整段重识别。
   *
   * 最终稿（断句后的那次识别）**始终**走当前模型，不受这个选项影响。
   */
  liveAsr: 'full',
  /**
   * TTS 引擎：
   *   - online：Edge 在线朗读，音质最好，但需要联网；
   *   - local ：跨平台系统语音（SAPI / say / espeak-ng），完全离线；
   *   - neural：本地神经模型（sherpa-onnx VITS），离线且音质接近在线；
   *   - sovits：外部 GPT-SoVITS 服务（用户自己跑 api_v2），插件只转发文本合成。
   * local 合成失败时自动回退到 online，保证「总有声音」。
   * sovits 失败**不**回退（用户要的是自己的声音/隐私，绝不能偷偷发给微软）。
   */
  ttsEngine: 'online',
  /** Edge TTS 音色（ttsEngine=online 时使用）。 */
  voice: 'zh-CN-XiaoxiaoNeural',
  /**
   * 本地合成发音人名（ttsEngine=local 时使用）。
   * 不能写死 Windows 的 SAPI 语音名：macOS/Linux 上这个值不存在，
   * 会导致「本地系统语音」必然失败并静默回退到在线（用户以为离线，其实联网）。
   * 留空表示用平台默认发音人。
   */
  localVoice: '',
  /** 本地神经模型档位（ttsEngine=neural 时使用）。 */
  neuralModel: 'vits-melo-zh_en',
  /** 神经模型的说话人 id。 */
  neuralSpeaker: 0,
  /**
   * 外部 GPT-SoVITS 引擎（ttsEngine=sovits 时使用）。
   *
   * 插件**不内置** GPT-SoVITS、也不做声音克隆：用户自己把 GPT-SoVITS
   * 的 `api_v2.py` 服务跑起来（默认 127.0.0.1:9880），并把服务端可访问的
   * 参考音频路径/参考文本/语言填在这里；插件只负责把每句文本 POST 到 `/tts`。
   * 详见 lib/sovits-tts.js 顶部注释。
   */
  sovitsUrl: DEFAULT_SOVITS_URL,
  /** 服务端参考音频路径（必须是 GPT-SoVITS 所在机器上可访问的路径）。 */
  sovitsRefAudio: '',
  /** 参考音频对应的文本（可选；官方 api_v2 里为空也能用，但匹配时音质更好）。 */
  sovitsPromptText: '',
  /** 合成文本的语言：zh / en / ja / ko / yue。 */
  sovitsTextLang: 'zh',
  /** 参考音频文本的语言：zh / en / ja / ko / yue。 */
  sovitsPromptLang: 'zh',
  /**
   * 语速（四种引擎都支持）。
   * online 用 SSML 百分比写法，local 换算成 SAPI/say/espeak 的档位，
   * neural 换算成倍率（100% = 1 倍速）。
   */
  rate: '+10%',
  /** Edge TTS 音调（如 +0Hz、-5Hz）。只有 online 引擎支持。 */
  pitch: '+0Hz',
  /** 音量（如 +0%、-20%）。online 与 local 支持，neural 不支持。 */
  volume: '+0%',
  /**
   * 音频输出格式，直接对应 msedge-tts 的 OUTPUT_FORMAT 键。
   * 只有 online 引擎用得上；vendor 里实际只认
   * AUDIO_24KHZ_48KBITRATE_MONO_MP3 与 AUDIO_24KHZ_96KBITRATE_MONO_MP3，
   * 其它键会静默回落到 24k/48k。
   */
  ttsFormat: 'AUDIO_24KHZ_48KBITRATE_MONO_MP3',
  /** 识别后是否自动发送。 */
  autoSend: true,
  /** 是否朗读回复。 */
  readAloud: false,
  /**
   * 「朗读追赶最新」的积压上限（秒）。
   *
   * 生成远快于朗读时，坚持全部朗读会越读越滞后（听到几分钟前的内容）。
   * 待朗读音频时长超过这个值，就**整段**跳到最新几段（保留最新 3 段；
   * 不会从段落中间跳）。默认 7.5 秒（= 原 15 秒的一半，用户要求更激进）。
   * 0 = 关闭追赶，全部朗读。
   */
  readAloudLag: 7.5,
  /** 交互模式：toggle（连续对话，默认）/ once（说完就关）。 */
  mode: 'toggle',
  /** 静音断句时长（毫秒）。 */
  silenceMs: 1500,
  /** 断句后再等多久才发送（毫秒），用于合并短句。 */
  autoSendExtraMs: 1200,
  /** 是否清理语气词。 */
  removeFillers: false,
  /** 自定义词表（字符串数组，或 {correct, replace} 对象数组）。 */
  words: [],
  /**
   * 全局热键：按一下切换语音模式（等同点麦克风按钮），不是按住说话。
   */
  shortcut: 'Alt+V',
  /**
   * 空闲多少分钟后自动释放已加载的模型（分钟）。
   * 0 表示永不释放（模型一直占着内存）。
   */
  idleReleaseMinutes: 10,
  /**
   * 是否在启用模型后立即预加载。
   * 预加载的好处：第一次说话不用等模型加载（zipformer2 要 40 秒）。
   */
  preloadModels: true,
}

/** 允许写回配置的键。 */
const CONFIG_KEYS = Object.keys(DEFAULTS)

/** 宿主侧当前生效的配置（apply() 里刷新；模块级函数也要读语言设置）。 */
let currentSettings = { ...DEFAULTS }

/** sherpa-onnx 支持的识别语言名（auto = 由模型自动判别）。 */
const SUPPORTED_LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

/** 流式实时文字用的模型档位 id（在线 transducer，边喂边出字）。 */
const STREAM_MODEL_ID = 'zipformer2-zh'

/**
 * 说话中，连续多少帧低于门限才判定「说完了」。
 *
 * 一帧偏低不能算结束 ——
 * 汉语的轻声、句尾的下降音天然偏低，
 * 一帧就中断的话解码器永远缺那段音频，识别结果会截断。
 *
 * 客户端每 0.4 秒送一帧，所以 3 帧约等于 1.2 秒的静音，
 * 足以区分「句中停顿」和「说完了」。
 */
const STREAM_SILENT_FRAMES_TO_END = 3

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
 * 推进门限状态机（纯函数）。
 *
 * 这是 `/asr-stream` 的门限判定内核：拿「上一帧的状态」和「本帧的 RMS」，
 * 推出「本帧要不要喂给解码器」和「下一帧的状态」。
 *
 * 纯函数保证：
 *   - **不改**传入的 state（内部只推进自己的副本）；
 *   - 返回的新 state 只有 noiseFloor / inSpeech / silentFrames 三个字段；
 *   - 所有门限常数都从 opts 进来，浏览器侧可以用同一份用例表驱动两侧。
 *
 * 算法（宿主与浏览器侧必须完全一致）：
 *   1. 底噪**只在不在说话中**时更新：noiseFloor = noiseFloor * 0.95 + level * 0.05
 *      （每帧都更新的话，说话时底噪被自己的声音抬高 → 门限跟着抬高 → 语音被自己的声音挡掉）；
 *   2. 门限：gate = min(max(minGate, noiseFloor * multiplier + offset), maxGate)；
 *   3. 说话中：低于门限就 silentFrames += 1，否则清零；
 *      连续静音达到 `state.silentFrames >= STREAM_SILENT_FRAMES_TO_END`
 *      （默认 3 帧，opts.silentFramesToEnd 可覆盖）才退出说话态；
 *      说话段内的帧**一律算语音**（单帧偏低是汉语轻声、句尾下降音，不能中断，
 *      中断一次解码器就永远缺了那部分音频，识别结果会截断）；
 *   4. 不在说话中：低于门限 → 本帧不算语音、不喂给解码器；
 *      否则进入说话态并开始喂。
 *
 * @param {object} state - 当前状态 {noiseFloor, inSpeech, silentFrames}（不会被修改）。
 * @param {number} level - 本帧的 RMS。
 * @param {object} [opts] - 门限常数 {minGate, maxGate, multiplier, offset, silentFramesToEnd}，
 *   缺省用 DEFAULT_GATE_OPTS。
 * @returns {{feed: boolean, speech: boolean, gate: number, state: object}} -
 *   feed 是本帧要不要喂给解码器（宿主用），
 *   speech 是本帧算不算「有语音」（浏览器侧 VAD 用），
 *   两者在本算法下恒等（见 stepGate 里的说明）。
 */
export function advanceGate(state, level, opts = {}) {
  const o = { ...DEFAULT_GATE_OPTS, ...opts }
  // 副本：下面所有赋值都作用在它身上，调用方传进来的 state 原封不动（纯函数）。
  const local = {
    noiseFloor: Number(state?.noiseFloor ?? DEFAULT_GATE_OPTS.noiseFloor),
    inSpeech: Boolean(state?.inSpeech),
    silentFrames: Number(state?.silentFrames ?? 0),
  }
  return stepGate(local, Number(level) || 0, o)
}

/**
 * 门限状态机的一步（内部实现：推进的是传进来的那份副本）。
 * @param {object} state - 状态副本。
 * @param {number} level - 本帧 RMS。
 * @param {object} o - 已合并默认值的门限常数。
 * @returns {{feed: boolean, speech: boolean, gate: number, state: object}}。
 */
function stepGate(state, level, o) {
  // 底噪只在「不在说话中」时更新（原因见 advanceGate 的算法说明）。
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
    // 退出条件：state.silentFrames >= STREAM_SILENT_FRAMES_TO_END（默认 3 帧，opts 可覆盖）。
    if (state.silentFrames >= o.silentFramesToEnd) {
      state.inSpeech = false
      state.silentFrames = 0
    }
  } else if (level < gate) {
    // 静音：不喂给解码器（宿主路由会回报 speech: false）
    feed = false
    speech = false
  } else {
    // 静音 → 说话，开始喂音频
    state.inSpeech = true
    state.silentFrames = 0
  }
  return { feed, speech, gate, state }
}

/**
 * 单次识别里解码循环的最大步数（安全阀）。
 *
 * 解码是 `while (recognizer.isReady(stream)) decode(stream)` ——
 * 正常情况下 `decode` 会消费掉音频、让 `isReady` 变假，循环自然结束。
 *
 * 但一旦 `decode` 因为任何原因不推进状态（原生绑定的边界情况、
 * 音频长度不是 chunk 的整数倍等），这个循环**永不退出**：
 * 宿主主线程被卡死 → 界面无响应 → 应用被看门狗杀掉重启，
 * 表现出来就是「整个 DSH 闪退」。
 *
 * 一段 30 秒音频按 0.1 秒的 chunk 算最多 300 步，
 * 所以这个上限宽松到不可能被正常路径触及，
 * 但足以把「死循环」变成「少识别几个字」。
 */
const MAX_DECODE_STEPS = 10000

/**
 * 把配置里的语言提示归一化成 sherpa-onnx 支持的语言名。
 *
 * 配置里可以是 auto / zh / en / yue / ja / ko；其它值一律退回 auto。
 * @param value - 配置里的语言值。
 * @returns 归一化后的语言名。
 */
function resolveLanguage(value) {
  const lang = String(value ?? 'auto').trim().toLowerCase()
  return SUPPORTED_LANGUAGES.includes(lang) ? lang : 'auto'
}

/** 当前生效的语言提示。 */
function currentLanguage() {
  return resolveLanguage(currentSettings.language)
}

/** 配置文件路径（~/.dsh/voice-typing.json）。 */
function configPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'voice-typing.json')
}

/** 合并行配置与配置文件（配置文件优先）。 */
function mergeConfig(rowConfig) {
  const merged = { ...DEFAULTS }
  if (rowConfig && typeof rowConfig === 'object') {
    for (const key of CONFIG_KEYS) {
      const value = rowConfig[key]
      if (value !== undefined && value !== null && value !== '') merged[key] = value
    }
  }
  return merged
}

/** 读取用户保存的覆盖配置。 */
async function readOverrides() {
  try {
    const raw = await readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const key of CONFIG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(parsed, key) && parsed[key] !== undefined) out[key] = parsed[key]
    }
    return out
  } catch {
    return {}
  }
}

/** 写 JSON 响应。 */
function json(res, status, payload) {
  // 绝不能因为响应已关闭而抛异常：
  // 客户端可能早就断开了（超时、页面刷新、取消操作），
  // 此时 writeHead/end 会抛 ERR_STREAM_WRITE_AFTER_END，
  // 在路由的 catch 里再抛一次就变成未处理 rejection，
  // 足以让整个宿主进程崩溃。
  try {
    if (!res || res.writableEnded || res.destroyed || res.headersSent) return
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    /* 连接已断开，忽略 */
  }
}

/** 读取请求体。 */
async function readBody(req, maxBytes = 16 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      const error = new Error('请求体过大')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * 把 f32 PCM（16k 单声道）转成规范 16k 单声道 PCM16 WAV。
 * DSH 内置 SenseVoice provider 只接受这种 WAV（见 dsh-experimental-speech-to-text/wave）。
 * @param samples - Float32 采样。
 * @returns WAV 字节。
 */
export function pcmToWav(samples) {
  const frames = samples.length
  const buf = Buffer.alloc(44 + frames * 2)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + frames * 2, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(16000, 24)
  buf.writeUInt32LE(32000, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(frames * 2, 40)
  let o = 44
  for (let i = 0; i < frames; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), o)
  }
  return buf
}

/** 惰性加载 sherpa-onnx：优先原生 addon（多线程、更快），回落 WASM。 */
let sherpaPromise = null
async function loadSherpa() {
  if (!sherpaPromise) {
    sherpaPromise = (async () => {
      for (const name of ['sherpa-onnx-node', 'sherpa-onnx']) {
        try {
          const mod = await import(name)
          const api = mod.default ?? mod
          // 原生版提供**类**（new api.OfflineRecognizer(config)），
          // WASM 版只提供**工厂**（api.createOfflineRecognizer(config)）。
          //
          // 判定必须看「类在不在」，不能看「类或工厂在不在」：
          // 用 || 的话 WASM 版也会被判成 native，
          // 后面走 new api.OfflineRecognizer(config) →
          // TypeError: not a constructor → **兜底路径成了死代码**，
          // 于是「原生件装不上就用 WASM」这个承诺根本没兑现
          // （Linux musl / arm64 / macOS 缺预编译二进制时全线崩）。
          //
          // 实测（两包都装着的机器上）：
          //   原生：OfflineRecognizer=function, createOfflineRecognizer=undefined
          //   WASM：OfflineRecognizer=undefined, createOfflineRecognizer=function
          const kind = typeof api.OfflineRecognizer === 'function' ? 'native' : 'wasm'
          return { api, kind }
        } catch {
          /* 试下一个 */
        }
      }
      throw new Error('未找到 sherpa-onnx（原生或 WASM）')
    })()
  }
  return sherpaPromise
}

/** 已加载的 sherpa-onnx 识别器（按档位缓存，附带生效的语言与配置）。 */
const recognizers = new Map()

/**
 * 已经加载进内存的识别模型（档位 id）。
 *
 * 与 `recognizers`（主线程的识别器缓存）不是一回事：
 *   - 主线程模式下，识别器在 `recognizers` 里；
 *   - 线程模式下，识别器在 worker 线程里，主线程看不到。
 *
 * 所以单独记一份「已加载」名单，
 * 客户端在进入「聆听中」之前要先问一句「模型好了吗」——
 * 首次加载 SenseVoice 要 20~40 秒，
 * 不确认就开麦的话，用户说的话会**全部丢掉**（识别请求直接失败）。
 *
 * 释放模型（release）时要从名单里删掉。
 */
const asrLoadedModels = new Set()

/** 每个会话的流式解码状态（zipformer2 在线识别，边喂边出字）。 */
const streamingStates = new Map()

/** 流式会话的最长空闲时间（毫秒）：超时即丢弃状态，避免上一轮残留串到下一轮。 */
const STREAM_IDLE_TIMEOUT_MS = 60_000

/**
 * 彻底丢弃某个会话的流式状态：释放流对象 + 删除状态条目。
 *
 * 「彻底丢弃」= 下一轮一定从零开始，不会带上一轮的残留文字。
 * @param sessionId - 会话 id。
 * @returns 是否确实丢掉了状态。
 */
function discardStreamingState(sessionId) {
  const state = streamingStates.get(sessionId)
  if (!state) return false
  streamingStates.delete(sessionId)
  try {
    state.stream?.free?.()
  } catch {
    /* 忽略 */
  }
  return true
}

/**
 * 释放一个识别器实例。
 *
 * 释放 native handle 之前必须先丢掉引用它的流式会话状态，
 * 否则会话里会残留一个已释放的句柄，下一次调用可能直接崩掉宿主进程。
 * @param recognizer - 识别器实例。
 */
function freeRecognizer(recognizer) {
  if (!recognizer) return
  for (const [sessionId, state] of [...streamingStates]) {
    if (state.recognizer === recognizer) discardStreamingState(sessionId)
  }
  try {
    recognizer.free?.()
  } catch {
    /* 忽略 */
  }
}

/** 流式状态清理定时器。 */
let streamSweeper = null

/**
 * 启动流式状态清理定时器。
 *
 * 客户端取消录音时未必会发 reset（识别失败、页面关闭、网络中断），
 * 残留的流对象会串到下一轮，让实时文字带上上一轮的尾巴。
 * 这里用「空闲超时」兜底：超过 STREAM_IDLE_TIMEOUT_MS 没有新音频就彻底丢弃。
 */
function startStreamSweeper() {
  if (streamSweeper) return
  streamSweeper = setInterval(() => {
    const now = Date.now()
    for (const [sessionId, state] of [...streamingStates]) {
      if (now - (state.lastActiveAt ?? 0) > STREAM_IDLE_TIMEOUT_MS) {
        discardStreamingState(sessionId)
      }
    }
  }, 15_000)
  streamSweeper.unref?.()
}

/**
 * 停止流式状态清理定时器。
 * 插件卸载/重载时必须调用，否则定时器会一直跑下去。
 */
function stopStreamSweeper() {
  if (!streamSweeper) return
  clearInterval(streamSweeper)
  streamSweeper = null
}

/**
 * 取得某会话的流式解码器。
 *
 * 流式实时文字固定走 zipformer2-zh（在线 transducer，边喂边出字）。
 * 模型不可用时返回 {unavailable: true, reason}，由路由明确告诉客户端，
 * 不能静默返回空串。
 *
 * @param sessionId - 会话 id。
 * @returns 可用时是 {recognizer, stream, kind, modelId, lastActiveAt}；
 *   不可用时是 {unavailable: true, reason}。
 */
async function getStreamingState(sessionId) {
  const model = findModel(STREAM_MODEL_ID)
  if (!model) {
    return { unavailable: true, reason: `未找到流式模型 ${STREAM_MODEL_ID}` }
  }
  if (!(await isModelReady(model))) {
    return {
      unavailable: true,
      reason: `流式模型 ${STREAM_MODEL_ID} 未就绪：请先在设置里下载它，或改用离线档位出最终稿`,
    }
  }
  let state = streamingStates.get(sessionId)
  if (state) {
    // 识别器可能已经被释放（模型下载完成、语言变更、档位切换），句柄失效必须重建。
    const current = recognizers.get(model.id)?.recognizer
    if (!current || state.recognizer !== current) {
      discardStreamingState(sessionId)
      state = undefined
    }
  }
  if (!state) {
    const { kind } = await loadSherpa()
    const recognizer = await getRecognizer(model, { language: currentLanguage() })
    state = {
      recognizer,
      stream: recognizer.createStream(),
      kind,
      modelId: model.id,
      lastActiveAt: Date.now(),
      // 每个流维护底噪估计：门限随底噪浮动，
      // 固定门限在有底噪的环境里会把噪声喂给模型，模型就会凭空造字。
      noiseFloor: 0.004,
      // 是否处于「说话中」。
      //
      // 门限的作用是「别把噪声喂给模型」，但它不能一刀切掉低音量帧 ——
      // 汉语的轻声、句尾的下降音，音量天然偏低，
      // 一刀切掉的话解码器就缺了那部分音频，识别结果会**截断**。
      //
      // 实测：一句「你好，今天天气怎么样？」按 0.4 秒分块，
      // 中间两块 rms 只有 0.025 / 0.031，被门限挡掉，
      // 结果只认出「你好明天天怎」，尾巴整个丢了。
      //
      // 所以要有「说话中」状态：一旦有帧超过门限就进入，
      // 之后即使某帧偏低也照喂，直到**连续**若干帧都低于门限才退出。
      inSpeech: false,
      // 说话中，连续低于门限的帧数（用来判断是不是说完了）
      silentFrames: 0,
    }
    streamingStates.set(sessionId, state)
  }
  state.lastActiveAt = Date.now()
  return state
}

/**
 * 该引擎是否吃语言提示。
 *
 * 在线流式 zipformer2 是纯中文模型，没有语言字段；离线 SenseVoice / Whisper 支持。
 * @param model - 档位。
 * @returns 是否支持语言提示。
 */
function engineSupportsLanguage(model) {
  return model.engine !== 'online'
}

/**
 * 构造某个档位的 sherpa-onnx 识别器配置。
 * @param model - 档位。
 * @param paths - 模型文件路径。
 * @param language - 生效语言（auto / zh / en / yue / ja / ko）。
 * @returns 识别器配置对象。
 */
function buildRecognizerConfig(model, paths, language) {
  if (model.engine === 'sensevoice') {
    return {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: paths.model,
          // 语言提示在这里真正生效：auto 由模型判别，否则指定 zh/en/yue/ja/ko。
          language,
          useInverseTextNormalization: 1,
        },
        tokens: paths.tokens,
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
    }
  }
  if (model.engine === 'whisper') {
    return {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        whisper: {
          encoder: paths.encoder,
          decoder: paths.decoder,
          // Whisper 的 auto 等价于空串（由模型自己检测语种）。
          language: language === 'auto' ? '' : language,
        },
        tokens: paths.tokens,
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
    }
  }
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: paths.encoder,
        decoder: paths.decoder,
        joiner: paths.joiner,
      },
      tokens: paths.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  }
}

/**
 * 取得（必要时创建）某个档位的识别器。
 *
 * 识别器实例按档位复用；语言变了时优先用 sherpa-onnx 的 setConfig 就地更新
 * （OfflineRecognizer 有 setConfig，原生 addon 与 WASM 版都支持），
 * 不支持 setConfig 的引擎则按新语言重建实例。
 *
 * @param model - 档位。
 * @param options - {language} 语言提示（auto / zh / en / yue / ja / ko）。
 * @returns 识别器实例。
 */
async function getRecognizer(model, options = {}) {
  const language = engineSupportsLanguage(model) ? resolveLanguage(options.language) : 'auto'
  const existing = recognizers.get(model.id)
  if (existing) {
    if (existing.language === language) return existing.recognizer
    const config = buildRecognizerConfig(model, modelPaths(model), language)
    if (typeof existing.recognizer.setConfig === 'function') {
      try {
        existing.recognizer.setConfig(config)
        existing.language = language
        existing.config = config
        return existing.recognizer
      } catch {
        /* setConfig 不可用就退回重建 */
      }
    }
    // 重建前先释放旧实例——释放句柄会连带丢掉引用它的流式会话。
    recognizers.delete(model.id)
    freeRecognizer(existing.recognizer)
  }
  const { api, kind } = await loadSherpa()
  const paths = modelPaths(model)
  const config = buildRecognizerConfig(model, paths, language)
  let recognizer
  if (kind === 'native') {
    const Ctor = model.engine === 'online' ? api.OnlineRecognizer : api.OfflineRecognizer
    recognizer = new Ctor(config)
  } else {
    const factory =
      model.engine === 'online'
        ? api.createOnlineRecognizer
        : api.createOfflineRecognizer
    recognizer = factory(config)
  }
  recognizers.set(model.id, { recognizer, language, config, kind })
  return recognizer
}

/** 已创建的 Silero VAD（按模型路径缓存）。 */
const vads = new Map()

/**
 * 取得 Silero VAD：起音 0.25s / 静音 0.5s / 最长单段 20s。
 * 只有宿主内置的 SenseVoice 档位带 VAD 模型，其它档位返回 null（改用能量判断）。
 * @param model - 档位。
 * @returns VAD 实例，无 VAD 模型时返回 null。
 */
async function getVad(model) {
  // Silero VAD 跟着宿主内置的 SenseVoice 模型一起走（isHostedModel 是唯一权威判定）。
  if (!isHostedModel(model)) return null
  const paths = modelPaths(model)
  if (!paths.vad) return null
  if (vads.has(paths.vad)) return vads.get(paths.vad)
  const { api, kind } = await loadSherpa()
  const config = {
    sileroVad: {
      model: paths.vad,
      threshold: 0.5,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 20,
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: 30,
  }
  const vad = kind === 'native' ? new api.Vad(config) : api.createVad(config)
  vads.set(paths.vad, vad)
  return vad
}

/**
 * 用 Silero VAD 切出语音段。
 * 复刻官方 SenseVoice worker 的做法：512 样本一块喂入，段起点用于音点前置补偿。
 * @param vad - VAD 实例。
 * @param samples - 16k 单声道采样。
 * @returns 语音段数组（每项含 samples 与 start）。
 */
function segmentByVad(vad, samples) {
  if (!vad) return [{ samples, start: 0 }]
  const segments = []
  const drain = () => {
    while (!vad.isEmpty()) {
      const segment = vad.front(false)
      segments.push({
        samples: new Float32Array(segment.samples),
        start: typeof segment.start === 'number' ? segment.start : 0,
      })
      vad.pop()
    }
  }
  try {
    vad.reset?.()
    for (let offset = 0; offset < samples.length; offset += 512) {
      vad.acceptWaveform(samples.subarray(offset, offset + 512))
      drain()
    }
    vad.flush?.()
    drain()
  } catch {
    return [{ samples, start: 0 }]
  }
  // 注意：这里不能回退成「整段拿去识别」——纯静音会让模型凭空造字。
  return segments
}

/** 音点前置补偿（毫秒）：把段首之前的静音补回去，不吞第一个字。 */
const ONSET_PADDING_MS = 300

/**
 * 注意：这里**没有**「最近一次识别是否有人声」的模块级变量。
 * speech 由识别函数随返回值带出来（见 recognizeWithSherpa）——
 * 以前那个模块级变量会让两个并发 /transcribe 互相覆盖，
 * 客户端依据 speech 决定是否回滚实时字，回滚错就会把用户刚说的话吃掉。
 */

/** 正在进行的模型下载任务（防止重复触发）。 */
const activeDownloads = new Set()

/**
 * 各模型的下载进度：modelId → { received, total }。
 *
 * 设置面板关掉再打开时，组件会重新挂载、组件内的进度状态全丢。
 * 进度必须放在宿主侧，否则用户看到的永远是「刚点了下载」却没有任何进度。
 */
const downloadProgress = new Map()

/**
 * 下载进度百分比（0~100 的整数）。
 *
 * 由**宿主**算好后随事件广播，客户端不要再自己算：
 * 两端公式不一样（有的用 received/total，有的拿模型档位里的已知大小），
 * 同一个下载会显示两个不同的百分比，进度条还会来回跳。
 *
 * @param {number} received - 已下载字节。
 * @param {number} total - 总字节（0 或非法表示未知）。
 * @returns {number} 0~100 的整数。
 */
export function downloadPercent(received, total) {
  const r = Number(received)
  const t = Number(total)
  if (!Number.isFinite(r) || !Number.isFinite(t) || t <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((r / t) * 100)))
}

// SSE 事件信封协议层已抽到独立模块 lib/sse-envelope.js（见该文件说明）。
// 这里 re-export，对外接口（apply / buildEventEnvelope / EVENT_PROTOCOL_VERSION /
// downloadPercent 等）保持不变。
import {
  EVENT_PROTOCOL_VERSION,
  buildEventEnvelope,
  resetEventSeqForTest,
} from './sse-envelope.js'

export { EVENT_PROTOCOL_VERSION, buildEventEnvelope, resetEventSeqForTest }

/** 音色列表缓存（5 分钟）。 */
let voicesCache = null
let voicesCacheAt = 0

/**
 * 助手是否正在生成回复。
 * 会话对象上没有 running 字段，前端拿不到，
 * 所以由宿主在 llm/stream 开始与结束时维护：
 * 既广播 assistant-busy 事件（客户端的首选通路），
 * 也经 /busy 暴露（降级通路）。
 */
let busySession = null
/**
 * assistant-busy 事件的广播计数（诊断用）。
 *
 * 用来分辨「宿主没发复位事件」和「客户端没收到复位事件」——
 * 两种情况下客户端都会一直以为助手在忙，现象完全一样。
 */
const busyBroadcasts = { total: 0, trueCount: 0, falseCount: 0, last: null }
/** 助手开始生成的时间戳（/busy 用来回报「已经忙了多久」）。 */
let busyAt = 0

/**
 * 广播函数占位。
 * markBusy 定义在 ctx.inject 之前，拿不到注入作用域里的 broadcast
 * （那里是 const 声明，存在暂时性死区，直接调用会报 broadcast is not defined）。
 * 注入完成后把真正的 broadcast 赋给这里。
 */
let emitBroadcast = null

/**
 * 宿主的 sessions 服务句柄。
 *
 * llm/stream 钩子注册在 ctx.inject 之外，拿不到 inject 回调里的 scope，
 * 所以在这里存一份模块级引用（inject 之后才有值）。
 */
let sessionsService = null

/**
 * 回合判定模型（独立单元，见 lib/turn-model.js）。
 *
 * 通过 getter 取 sessionsService：llm/stream 钩子注册在 inject 之外，
 * 而 sessionsService 在 inject 里才有值，用 getter 延迟取。
 */
const turnModel = createTurnModel({ getSessionsService: () => sessionsService })

/** 本地发音人的校验结果缓存（避免每次合成都起 PowerShell 枚举语音）。 */
let localVoiceCache = null

/**
 * 解析出可用的本地发音人。
 * @param {string} wanted - 配置里指定的发音人。
 * @returns {Promise<string>} 可用的发音人名。
 */
async function resolveLocalVoice(wanted) {
  const target = String(wanted ?? '').trim()
  if (!target) return defaultLocalVoice()
  if (localVoiceCache && localVoiceCache.wanted === target) return localVoiceCache.resolved
  let resolved = target
  try {
    const available = await listLocalVoices()
    if (!available.some((v) => v.name === target)) resolved = defaultLocalVoice()
  } catch {
    resolved = defaultLocalVoice()
  }
  localVoiceCache = { wanted: target, resolved }
  return resolved
}

/**
 * 模型空闲释放的扫描间隔（毫秒）。
 */
const IDLE_SWEEP_MS = 60_000

/** 预加载任务的防抖定时器（配置连续变化时只做最后一次）。 */
let preloadTimer = null

/**
 * 安排一次预加载（防抖）。
 *
 * 配置连续改动时（比如用户连点几个下拉）只做最后一次预加载，
 * 免得反复加载不同模型把内存和 CPU 都占满。
 */
function schedulePreload() {
  if (currentSettings.preloadModels === false) return
  if (preloadTimer) clearTimeout(preloadTimer)
  preloadTimer = setTimeout(() => {
    preloadTimer = null
    void preloadConfiguredModels()
  }, 500)
  preloadTimer.unref?.()
}

/**
 * 按当前配置预加载要用到的模型。
 *
 * 用途：用户在设置里选了某个模型后，后台先把模型读进内存，
 * 真正开始说话时就不用干等（zipformer2 首次要 40 秒，神经 TTS 也要几十秒）。
 *
 * @returns {Promise<void>} 完成。
 */
async function preloadConfiguredModels() {
  // 注意：settings 是 apply() 作用域的变量，这里（模块级）取不到，
  // 必须用模块级的 currentSettings，否则运行时会 ReferenceError。
  const cfg = currentSettings
  if (cfg.preloadModels === false) return
  try {
    // 识别模型：交给识别线程加载
    const model = findModel(cfg.model)
    if (model && (await isModelReady(model))) {
      const paths = modelPaths(model)
      await preloadInWorker({
        modelId: model.id,
        kind: model.engine === 'online' ? 'transducer' : model.engine,
        model: paths.model,
        encoder: paths.encoder,
        decoder: paths.decoder,
        joiner: paths.joiner,
        tokens: paths.tokens,
        vad: paths.vad,
        language: resolveLanguage(cfg.language),
      })
      markModelUsed(model.id)
    }
    // 合成模型：本地神经模型要加载 170MB，只在真的用它时预加载
    if (normalizeTtsEngine(cfg.ttsEngine) === 'neural') {
      const tier = findTtsModel(cfg.neuralModel)
      if (tier && (await isModelReady(tier))) {
        await preloadNeural(ttsModelPaths(tier))
        markModelUsed(tier.id)
      }
    }
  } catch {
    /* 预加载失败不影响正常使用 */
  }
}

/**
 * 在识别线程里预加载一个识别器。
 * @param {object} spec - 档位描述。
 * @returns {Promise<boolean>} 是否成功。
 */
function preloadInWorker(spec) {
  try {
    const worker = getAsrWorker()
    const id = ++asrSeq
    // 加载成功后记入「已加载」名单（spec.modelId 可能没有 —— 那就不记）。
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        asrPending.delete(id)
        resolve(false)
      }, 120000)
      asrPending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          const ok = Boolean(value?.ok)
          if (ok && spec?.modelId) asrLoadedModels.add(spec.modelId)
          resolve(ok)
        },
        reject: () => {
          clearTimeout(timer)
          resolve(false)
        },
      })
      try {
        worker.postMessage({ kind: 'preload', id, spec })
      } catch {
        asrPending.delete(id)
        clearTimeout(timer)
        resolve(false)
      }
    })
  } catch {
    return Promise.resolve(false)
  }
}

/** 各模型最后使用时间（毫秒）。 */
const modelUsedAt = new Map()

/**
 * 记录模型最近被使用。
 * @param {string} modelId - 模型 id。
 */
function markModelUsed(modelId) {
  if (!modelId) return
  modelUsedAt.set(modelId, Date.now())
}

/**
 * 释放空闲超时的模型。
 *
 * 模型常驻在内存里（zipformer2 160MB、神经 TTS 170MB），
 * 长时间不用就该释放掉，不然一直占着。
 */
function releaseIdleModels() {
  const cfg = currentSettings
  const minutes = Number(cfg.idleReleaseMinutes ?? 10)
  if (!Number.isFinite(minutes) || minutes <= 0) return
  const deadline = Date.now() - minutes * 60_000
  // 空闲释放保护「**实际解析出的**在用模型」，而不是配置里的原始字符串：
  // 配置里可能写了一个不存在的档位 id（/transcribe 现在会 400，但旧数据/手写配置也可能），
  // 直接按字符串比较会把真正在用的那个模型释放掉。
  const currentAsrModel = findModel(cfg.model)
  const currentAsrId = currentAsrModel?.id ?? ''
  const currentNeuralModel = findTtsModel(cfg.neuralModel)
  const currentNeuralId = currentNeuralModel?.id ?? ''
  const neuralInUse = normalizeTtsEngine(cfg.ttsEngine) === 'neural'
  for (const [modelId, usedAt] of [...modelUsedAt]) {
    if (usedAt > deadline) continue
    // 正在用的模型不释放
    if (currentAsrId && modelId === currentAsrId) continue
    if (neuralInUse && currentNeuralId && modelId === currentNeuralId) continue
    try {
      if (currentNeuralId && modelId === currentNeuralId) {
        // 神经合成模型在 TTS 工作线程里，终止线程即释放
        releaseNeural()
      } else {
        // 识别模型住在**工作线程**里，必须显式通知它释放，
        // 否则宿主这边的 Map 是空的，什么都没释放，模型一直占着内存。
        const model = findModel(modelId)
        if (model) {
          const paths = modelPaths(model)
          void releaseInWorker({
            model: paths.model,
            encoder: paths.encoder,
            language: resolveLanguage(cfg.language),
          })
        }
        // 主线程回退路径用的那份也一起清掉
        releaseRecognizer(modelId)
      }
      modelUsedAt.delete(modelId)
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 标记生成状态。
 *
 * 置位与复位必须对称：之前复位只写在「开朗读」那条分支的 generator finally 里，
 * 而 readAloud 默认是 false —— 于是助手第一次回话后状态永远停在「忙」，
 * 识别出的文字只留在输入框、永远发不出去。
 * 现在两条路径（朗读 / 不朗读）都会走到这里。
 *
 * @param {string} sessionId - 会话 id。
 * @param {boolean} busy - 是否正在生成。
 */
function markBusy(sessionId, busy) {
  const sid = sessionId ?? null
  if (busy) {
    busySession = sid
    busyAt = Date.now()
  } else if (busySession === sid || !sid) {
    busySession = null
    busyAt = 0
  }
  try {
    // 事件名是 assistant-busy（不是 busy）：
    // 客户端用它替代 700ms 轮询 GET /busy —— 轮询最多要慢 700ms 才感知到。
    //
    // 载荷里的 busy 是**全局状态**，与 GET /busy 的返回值一致：
    // 两条通路给出的答案必须一样，否则客户端会在事件与轮询之间来回翻转。
    // sessionId 带上事件归属的会话（复位时是刚结束的那个会话）。
    const busyValue = busySession !== null
    busyBroadcasts.total += 1
    if (busyValue) busyBroadcasts.trueCount += 1
    else busyBroadcasts.falseCount += 1
    busyBroadcasts.last = { busy: busyValue, sessionId: busySession ?? sid, at: Date.now() }
    emitBroadcast?.('assistant-busy', { busy: busyValue, sessionId: busySession ?? sid })
  } catch { /* 忽略 */ }
}

/**
 * 识别工作线程。
 * 识别是 CPU 密集的同步计算，放在主线程会把整个应用卡住 0.5~3 秒，
 * 表现为「识别延迟超高」。放进独立线程后主线程始终可响应。
 */
let asrWorker = null
/** 等待 worker 回包的任务表。 */
const asrPending = new Map()
/** worker 请求序号。 */
let asrSeq = 0

/**
 * 取得（必要时启动）识别工作线程。
 * @returns Worker 实例。
 */
function getAsrWorker() {
  if (asrWorker) return asrWorker
  const worker = new Worker(new URL('./asr-worker.js', import.meta.url))
  worker.on('message', (message) => {
    const task = asrPending.get(message?.id)
    if (!task) return
    asrPending.delete(message.id)
    // **传整个 message**，不要在这里挑字段。
    //
    // asrPending 这张表被两种请求共用，而它们的回包形状不同：
    //   recognize → {ok, text, speech}
    //   preload   → {ok, preloaded}
    //   release   → {ok}
    //
    // 之前这里统一转成 {text, speech}（为 recognize 设计的），
    // 于是 preload 收到的 value 里**没有 ok 字段**
    // → preloadInWorker 的 `Boolean(value?.ok)` 恒为 false
    // → **预加载即使成功也永远报告失败**
    // → 客户端「模型加载失败」，开麦被卡住。
    //
    // 各用途自己解包（见 recognizeInWorker / preloadInWorker 的 resolve 包装）。
    if (message.ok) task.resolve(message)
    else task.reject(new Error(message.error ?? '识别失败'))
  })
  worker.on('error', (error) => {
    // 这里的变量名之前写错成 asr（未声明），会抛 ReferenceError，
    // 导致 getAsrWorker 首次调用就失败、/transcribe 永远回落主线程同步识别。
    for (const task of asrPending.values()) task.reject(error instanceof Error ? error : new Error(String(error)))
    asrPending.clear()
    try { worker.terminate() } catch { /* 忽略 */ }
    asrWorker = null
  })
  worker.on('exit', () => { asrWorker = null })
  // 不让 worker 阻止进程退出
  worker.unref?.()
  asrWorker = worker
  return worker
}

/**
 * 把一段音频交给工作线程识别。
 * @param {object} model - 档位。
 * @param {Float32Array} samples - 16k 单声道采样。
 * @param {string} language - 语言提示。
 * @param {string[]} [hotwords] - 热词提示（只有 transducer 档位支持）。
 * @returns {Promise<{text: string, speech: boolean}>}。
 */
function recognizeInWorker(model, samples, language, hotwords) {
  const worker = getAsrWorker()
  const id = ++asrSeq
  const paths = modelPaths(model)
  return new Promise((resolve, reject) => {
    asrPending.set(id, {
      // 自己从原始 message 里取识别结果（handler 不再预筛字段）
      resolve: (message) => resolve({
        text: message?.text ?? '',
        speech: message?.speech === true,
      }),
      reject,
    })
    try {
      worker.postMessage({
        kind: 'recognize',
        id,
        spec: {
          // engine 'online' 就是 zipformer2（transducer），
          // worker 里按 transducer 构造识别器，并支持热词提示。
          kind: model.engine === 'online' ? 'transducer' : model.engine,
          model: paths.model,
          encoder: paths.encoder,
          decoder: paths.decoder,
          joiner: paths.joiner,
          tokens: paths.tokens,
          vad: paths.vad,
          language,
          hotwords: Array.isArray(hotwords) ? hotwords : [],
        },
        samples,
      })
    } catch (error) {
      asrPending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/**
 * 能量门限：低于这个 RMS 视为静音（约 -42dB）。
 * 低于门限的音频送去识别，模型会凭空造字，必须在宿主侧拦住。
 */
const SILENCE_RMS = 0.008

/**
 * 计算一段采样的 RMS 能量。
 * @param samples - f32 采样。
 * @returns RMS。
 */
function rmsOf(samples) {
  if (!samples || samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/**
 * 让识别工作线程释放一个识别器（把模型从线程内存里踢掉）。
 *
 * 注意：识别器实际住在**工作线程**里，宿主主线程的 recognizers Map
 * 只有走主线程回退路径时才有条目。
 * 所以「空闲释放」必须显式通知工作线程，否则模型一直占着内存。
 *
 * @param {object} spec - 档位描述（要和预加载时用的完全一致，缓存键才对得上）。
 * @returns {Promise<boolean>} 是否释放成功。
 */
function releaseInWorker(spec) {
  // 同样从「已加载」名单里删掉。
  if (spec?.modelId) asrLoadedModels.delete(spec.modelId)
  try {
    if (!asrWorker) return Promise.resolve(false)
    const id = ++asrSeq
    // 缓存键要和 worker 里的 recognizerKey(spec) 完全一致
    const key = spec.model + '|' + (spec.encoder ?? '') + '|' + (spec.language ?? 'auto')
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        asrPending.delete(id)
        resolve(false)
      }, 15000)
      asrPending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(Boolean(value?.released))
        },
        reject: () => {
          clearTimeout(timer)
          resolve(false)
        },
      })
      try {
        asrWorker.postMessage({ kind: 'release', id, key })
      } catch {
        asrPending.delete(id)
        clearTimeout(timer)
        resolve(false)
      }
    })
  } catch {
    return Promise.resolve(false)
  }
}

/**
 * 释放某个档位的识别器。
 *
 * 同时清掉 streamingStates 里引用它的会话状态——留着已释放的句柄，
 * 下一次流式调用可能直接崩掉宿主进程。
 * @param modelId - 档位 id。
 */
function releaseRecognizer(modelId) {
  // 释放了就不算「已加载」了 —— 客户端下次开麦前会重新问一遍。
  asrLoadedModels.delete(modelId)
  const entry = recognizers.get(modelId)
  if (!entry) return
  recognizers.delete(modelId)
  freeRecognizer(entry.recognizer)
}

/**
 * 释放全部已缓存的识别器。
 *
 * 识别器里常驻着模型（几百 MB），插件卸载/重载时不释放就一直占着内存。
 * @returns 释放的数量。
 */
function releaseAllRecognizers() {
  let count = 0
  for (const modelId of [...recognizers.keys()]) {
    try {
      releaseRecognizer(modelId)
      count++
    } catch {
      /* 忽略 */
    }
  }
  return count
}

/**
 * 给识别器建流。
 *
 * 热词（词表里的纯字符串条目）只在 transducer 模型上真正生效：
 * sherpa-onnx 原生接口的 createStream(hotwords) 支持上下文偏置，
 * 多个短语用 '/' 分隔，可带 ":分数"。
 *
 * 限制（务必知悉）：
 *   - 离线 SenseVoice 不是 transducer，原生接口的热词对它无效；
 *   - 离线 Whisper 同样不支持热词；
 *   - 在线 zipformer2 的原生 addon 没有流级热词接口（WASM 版只支持配置级
 *     hotwordsFile，且要求 modified_beam_search 解码）。
 * 因此这些档位上热词只是「提示」：文本不会被改动，热词列表会随识别结果一起返回，
 * 由调用方决定怎么用。
 *
 * @param recognizer - 识别器实例。
 * @param model - 档位。
 * @param hotwords - 热词列表。
 * @returns 流对象。
 */
function createRecognizerStream(recognizer, model, hotwords) {
  const list = Array.isArray(hotwords) ? hotwords.filter(Boolean) : []
  // zipformer2 的 engine 记的是 'online'，它同样是 transducer 架构，
  // 支持热词。之前只判 'transducer'，这个条件永远不成立，热词形同虚设。
  const isTransducer = model.engine === 'transducer' || model.engine === 'online'
  if (list.length && isTransducer && recognizer.createStream.length > 0) {
    try {
      return recognizer.createStream(list.map((word) => `${word} :2.0`).join('/'))
    } catch {
      /* 不支持热词就退回普通流 */
    }
  }
  return recognizer.createStream()
}

/**
 * 用 sherpa-onnx 识别一段 16k 单声道 f32 采样。
 *
 * 「这段音频里有没有人声」必须**随返回值**带出来，不能靠模块级变量 ——
 * 两个并发识别会互相覆盖那个变量，客户端依据 speech 决定是否回滚实时字，
 * 回滚错就会把用户刚说的话吃掉。
 * @param model - 档位。
 * @param samples - 采样。
 * @param options - {language} 语言提示、{words} 词表（用于热词偏置）。
 * @returns {Promise<{text: string, speech: boolean}>} - text 是识别文本；
 *   speech 表示这段音频里检测到了人声。
 */
export async function recognizeWithSherpa(model, samples, options = {}) {
  if (!samples || samples.length === 0) return { text: '', speech: false }
  // 静音直接返回空，不给模型造字的机会。
  if (rmsOf(samples) < SILENCE_RMS) return { text: '', speech: false }
  const { kind } = await loadSherpa()
  const vad = await getVad(model)
  const segments = segmentByVad(vad, samples)
  // VAD 找到语音段才算「有人说话」；没有 VAD 的档位退回能量判断。
  const hadSpeech = vad ? segments.some((s) => s.samples.length > 0) : rmsOf(samples) >= SILENCE_RMS
  const recognizer = await getRecognizer(model, { language: options.language })
  const hotwords = parseWordEntries(options.words).hotwords
  const onsetPadding = Math.round((ONSET_PADDING_MS / 1000) * 16000)
  const texts = []
  let isFirst = true
  for (const segment of segments) {
    if (segment.samples.length === 0) continue
    let speech = segment.samples
    if (isFirst) {
      isFirst = false
      const from = Math.max(0, segment.start - onsetPadding)
      if (from < segment.start) {
        const restored = new Float32Array(segment.start - from + speech.length)
        restored.set(samples.subarray(from, segment.start))
        restored.set(speech, segment.start - from)
        speech = restored
      }
    }
    const stream = createRecognizerStream(recognizer, model, hotwords)
    try {
      if (kind === 'native') stream.acceptWaveform({ sampleRate: 16000, samples: speech })
      else if (model.engine === 'online') stream.acceptWaveform(16000, speech)
      else stream.acceptWaveform(speech)
      const decode = recognizer.decodeStream ?? recognizer.decode
      if (model.engine === 'online') {
        if (recognizer.isReady) {
          // 必须有步数上限：见 MAX_DECODE_STEPS 的说明。
          // 无上限的 while 一旦 decode 不推进状态就会把宿主线程卡死。
          let steps = 0
          while (recognizer.isReady(stream) && steps++ < MAX_DECODE_STEPS) {
            decode.call(recognizer, stream)
          }
        } else {
          decode.call(recognizer, stream)
        }
        if (stream.inputFinished) stream.inputFinished()
      } else {
        decode.call(recognizer, stream)
      }
      const result = recognizer.getResult(stream)
      const text = String(result?.text ?? '').trim()
      if (text) texts.push(text)
    } finally {
      try {
        stream.free?.()
      } catch {
        /* 忽略 */
      }
    }
  }
  return { text: texts.join(' ').trim(), speech: hadSpeech }
}

/**
 * 宿主侧入口。
 * @param ctx - Cordis 上下文。
 * @param rowConfig - 插件行配置。
 */
export function apply(ctx, rowConfig) {
  // 启动时也走一遍 schema 清洗（rowConfig 可能来自用户手写的插件行配置）。
  const initialConfig = sanitizeConfig(mergeConfig(rowConfig), DEFAULTS)
  let settings = initialConfig.config
  currentSettings = settings
  /**
   * 最近一次加载/保存配置时的 schema 告警。
   *
   * 非法项已经按规则回退/夹紧（不会让运行期拿到坏形状），但用户需要知道
   * 「你写的配置里哪几项被改了」—— 挂在 /diagnostics.configWarnings，
   * **不混进 /config 响应**（那是生效配置本身）。
   */
  let configWarnings = initialConfig.warnings
  /** 当前开启「边生成边读」的会话 id。 */
  let voiceSession = null
  /** SSE 订阅者。 */
  const listeners = new Set()
  /** 诊断计数：用来定位「没人说话时状态一直变」这类问题（经 /diagnostics 暴露）。 */
  const stats = {
    transcribe: 0,
    withSpeech: 0,
    noSpeech: 0,
    stream: 0,
    streamNonEmpty: 0,
    lastText: '',
    lastAt: 0,
    client: null,
    clientCount: 0,
    /**
     * 本地系统语音合成失败的次数。
     *
     * 本地合成失败会**静默回退在线** —— 用户以为在离线，
     * 文本其实发给了微软。不留痕迹的话，这个行为完全不可见。
     */
    localTtsFailures: 0,
    /** 最近一次本地合成失败的原因（人话）。 */
    lastLocalTtsError: '',
    /** 最近一次本地合成失败的时间。 */
    lastLocalTtsAt: 0,
    /**
     * 在线（微软 Edge）语音合成失败的次数。
     *
     * 在线引擎失败时 `/tts` 直接报错，客户端静默跳过那一句 ——
     * 用户只看到「没声音」。计数 + 最近错误要能查出来，否则无从排查。
     */
    onlineTtsFailures: 0,
    lastOnlineTtsError: '',
    lastOnlineTtsAt: 0,
    /**
     * 本地神经（sherpa-onnx VITS）语音合成失败的次数。
     *
     * 神经引擎失败时 `/tts` 直接报错（无回退），客户端静默跳过那一句。
     */
    neuralTtsFailures: 0,
    lastNeuralTtsError: '',
    lastNeuralTtsAt: 0,
    /**
     * 外部 GPT-SoVITS 引擎合成失败的次数。
     *
     * 它**不回退**其它引擎（用户要自己的声音/隐私），失败时 `/tts` 直接报错，
     * 客户端静默跳过那一句 —— 不计下来就只剩「没声音」。
     */
    sovitsTtsFailures: 0,
    lastSovitsTtsError: '',
    lastSovitsTtsAt: 0,
  }

  /**
   * 向浏览器广播一个事件。
   *
   * **统一信封在这里统一加**（v / seq / ts / sessionId），
   * 所以每一个事件都自动带上了信封，不需要逐个事件改。
   * 广播出去的已经是信封，订阅者拿到手就能直接 JSON.parse。
   */
  const broadcast = (event, payload) => {
    const envelope = buildEventEnvelope(payload)
    for (const listener of [...listeners]) {
      try {
        listener(event, envelope)
      } catch {
        /* 忽略 */
      }
    }
  }

  // 把广播函数接给 markBusy / llm 钩子使用。
  // 它们定义在这个位置之前，不能直接引用 broadcast（暂时性死区）。
  emitBroadcast = broadcast

  /**
   * 朗读调度器：按自然段落收集 + 按客户端播放进度发句
   * （见 lib/read-aloud-scheduler.js 顶部的设计说明）。
   *
   * 做成 apply() 内的实例（而不是模块级单例）：测试会在同一进程里创建多个
   * 宿主，每个宿主有自己的广播通道与会话状态，互不干扰；卸载时 dispose。
   */
  const readAloudScheduler = createReadAloudScheduler({
    emit: (event, payload) => { try { emitBroadcast?.(event, payload) } catch { /* 忽略 */ } },
    nextIndex: (sid) => turnModel.nextSentenceIndex(sid),
    // 「追赶最新」上限：读**当前生效配置**（设置面板改了立即生效）。
    // 秒 → 毫秒；0 = 关闭追赶（全部朗读）。夹在 0~120 秒，防止异常配置把朗读跳空。
    getMaxLagMs: () => {
      const seconds = Number(currentSettings.readAloudLag ?? 7.5)
      if (!Number.isFinite(seconds) || seconds <= 0) return 0
      return Math.min(120, seconds) * 1000
    },
  })

  /** 重新读取配置（读盘 → 合并 → schema 清洗；非法项回退并记 warning）。 */
  const reloadConfig = async () => {
    const overrides = await readOverrides()
    // 合并顺序：DEFAULTS < rowConfig（插件行配置）< 配置文件。
    // 注意**不要**先合并上一份 sanitized settings：那样会把「rowConfig 里的非法原值」
    // 洗掉，/tts 就无法再识别出「用户的引擎配置是坏的」而只能静默用默认值。
    const merged = mergeConfig({
      ...(rowConfig && typeof rowConfig === 'object' ? rowConfig : {}),
      ...overrides,
    })
    const sanitized = sanitizeConfig(merged, DEFAULTS)
    settings = sanitized.config
    currentSettings = settings
    configWarnings = sanitized.warnings
    return settings
  }

  // 挂钩模型流：把回复按「自然段落 → 段内句子」切出来，通过 SSE 推给浏览器逐句朗读。
  // 不这样做的话，必须等整段回复生成完才能开始念，等待感很强。
  //
  // 切分与发句节奏全部在 lib/read-aloud-scheduler.js（按客户端播放进度流控）；
  // 文本清洗（Markdown → 适合合成的纯文本）在 lib/speech-clean.js；
  // 代码围栏在流层面由 lib/fence-filter.js 跨 chunk 过滤。
  ctx.on('llm/stream', (options, next) => {
    const sessionId = options?.sessionId
    // 不要求 voiceSession：那个值只有客户端主动调 /voice-session 才会被设置，
    // 而客户端拿不到可靠的会话 id，于是它永远是 null，
    // 整个钩子直接 return，sentence 事件从来没广播过 —— 边生成边朗读永不生效。
    // 现在只要开着朗读就广播，由客户端按「是否用户发起的一轮」自己过滤。
    // 「正在生成」状态必须无条件维护：
    // 之前放在 readAloud 判断之后，而 readAloud 默认是 false，
    // 于是状态永远是「不忙」，
    // 「助手忙时说的话先留在草稿、忙完再发」这条链路整条失效，
    // 用户说话会直接打断正在进行的生成。
    //
    // markBusy 内部会广播 assistant-busy 事件（置位与复位各一次），
    // 客户端用它替代 700ms 轮询 GET /busy。
    if (sessionId) markBusy(sessionId, true)
    // 用模块级的 currentSettings：llm/stream 钩子注册在 ctx.inject 之外，
    // 拿不到 apply() 作用域里的 settings，引用它会抛 ReferenceError
    // （表现就是助手一回复就报错、朗读完全不工作）。
    //
    // **busy 的置位与复位必须对称。**
    //
    // 之前 markBusy(false) 只写在「开朗读」那条分支的 generator finally 里，
    // 而 readAloud 默认是 false —— 于是助手第一次回话后
    // /busy 永远返回 {busy:true}：
    //   客户端每 700ms 轮询 → assistantRunning 恒为 true
    //   → 识别出的文字只留在输入框，自动发送的条件永远不满足
    //   → **这段话永远发不出去**，全程没有任何报错。
    //
    // 这是把「/busy 永远 false」修成了「/busy 永远 true」——
    // 同一个 bug 的镜像。所以复位必须放在**所有**返回路径都覆盖的地方。
    if (currentSettings.readAloud !== true) {
      // 不朗读：仍然要把流正常传下去，并在结束时复位 busy。
      let plain
      try {
        plain = next()
      } catch (err) {
        // next() 同步抛错（模型/连接错误）：generator 的 finally 不会注册，
        // 若不在此复位，busySession 永久卡 true → 客户端 assistantRunning 恒真
        // → 自动发送链路永久失效且无报错。
        if (sessionId) markBusy(sessionId, false)
        throw err
      }
      if (!sessionId) return plain
      return (async function* () {
        try {
          yield* plain
        } finally {
          // 复位 busy（对称于钩子开头的置位）：
          // 不朗读的这条路径也必须复位 —— 之前复位只写在开朗读的分支里，
          // 状态永远停在「忙」，识别出的文字永远发不出去。
          // markBusy 内部广播 assistant-busy { busy:false }。
          markBusy(sessionId, false)
        }
      })()
    }
    let inner
    try {
      inner = next()
    } catch (err) {
      // next() 同步抛错：同样必须复位 busy（见上方不朗读分支的说明）。
      if (sessionId) markBusy(sessionId, false)
      throw err
    }
    // 注意：broadcast 是 ctx.inject 内部的作用域变量，
    // 这里不能直接用（存在暂时性死区，会报 broadcast is not defined）。
    // 统一走 emitBroadcast 转发。
    //
    // 事件一律带上 sessionId：信封里的 sessionId 就是从载荷里取的，
    // 载荷自带 sessionId 时以载荷为准（turn-begin / turn-end 本来就带）。
    const emit = (event, payload) => {
      try { emitBroadcast?.(event, { sessionId, ...payload }) } catch { /* 忽略 */ }
    }
    return (async function* () {
      // 广播「新一轮开始」：客户端据此中断上一轮的朗读。
      //
      // 关键：必须在「真正的新一轮」时才广播。
      // llm/stream 每调用一次就会触发一次 —— 助手一轮里用了工具就会有
      // 多次调用（工具调用前 + 最终回答），每次都广播会让客户端反复清空
      // 朗读队列，中间的内容就被丢了（表现为「很多没播报」）。
      //
      // 判定方法：数会话里的「用户消息条数」。
      // 工具调用不会增加用户消息，只有用户新发一条才会 —— 这个计数就是可靠的回合标识。
      // 回合判定。isNew 的依据是「请求里的用户消息条数」——
      // 同一轮里多次 llm/stream 调用（工具调用链）条数不变，
      // 用户新发一条消息才 +1。没有时序竞态，
      // 也不会出现「工具调用跑了 5 秒以上 → 同一轮被判成新一轮」，
      // 那会让客户端解除静音 + 清空队列（用户刚点的「停止朗读」被撤销）。
      const requestUserCount = turnModel.countRequestUserMessages(options)
      const turn = sessionId ? turnModel.detectTurn(sessionId, requestUserCount) : { isNew: false, turnId: '', prevTurnId: '' }
      if (sessionId && turn.isNew) {
        // 真正的一轮开始：先广播上一轮的 turn-end（若有），再广播本轮 turn-begin。
        // turn-end 表示「上一轮真的结束了」—— 下一轮开始就是最可靠的确认信号
        // （DSH 没有显式的「一轮结束」回调，只有新一轮出现才知道上一轮没了）。
        // 客户端据此可以精确地按轮收尾，不用靠「队列排空」去猜。
        if (turn.prevTurnId) emit('turn-end', { sessionId, turnId: turn.prevTurnId })
        // 只有 turn-begin：回合事件带 turnId，客户端据此精确同步。
        // 不再保留老的 turn-start ——
        // 同一事实两条通路，客户端要维护两套判断，
        // 而且两者的触发时机可能不一致（这正是「等很久才朗读」这类问题的来源）。
        emit('turn-begin', { sessionId, turnId: turn.turnId })
      }
      // 流式输出时代码块分三段到达（开始 ```、内容、结束 ```），
      // 单段清洗识别不了，会把代码念出来。
      // 所以在流层面维护「是否在代码块内」的状态，块内一律不朗读。
      //
      // 「切段落 / 段内切句 / 什么时候发」全部交给朗读调度器
      // （lib/read-aloud-scheduler.js）：
      //   - 按自然段落收集，段内再按句末标点切句（完整句，绝不切半句）；
      //   - 按**客户端的播放进度**发句（客户端回 ack），未确认句子不超过几句。
      //     这样既不会像以前那样「生产速度是播放速度的 5~8 倍 → 客户端只能
      //     丢掉接下来要播的句子 → 从段落中间开始念」，也不会越读越滞后。
      // 代码围栏过滤器（``` / ~~~）：**必须在流层面逐块扫**。
      //
      // 为什么不能先把正文拼进累积文本再判断：
      //   围栏和代码在流式输出时必然不在同一个 chunk 里到达，先拼再数 ```
      //   会让代码内容先落进累积被切成句子念出来（实测 `const x = 1` 被朗读）。
      //
      // 为什么不能简单 `chunk.text.split('```')`：
      //   围栏标记本身也可能**被 chunk 边界切成两半**（"``" + "`js"），
      //   那样状态机会错位：代码被念出来，而紧随其后的正文被当成代码整段丢弃。
      //   所以用 lib/fence-filter.js：它跨 chunk 记住可能是围栏前缀的尾部字符，
      //   支持 ``` / ~~~ 与任意 >=3 的围栏长度。围栏内的内容一个字都不交给朗读。
      const fence = createFenceFilter()
      const reader = readAloudScheduler.reader(sessionId, turn.turnId)
      try {
        for await (const chunk of inner) {
          if (chunk?.type === 'text-delta' && chunk.text) {
            // 只把「围栏外的正文」喂给朗读调度器。
            const visible = fence.push(chunk.text)
            if (visible) reader.push(visible)
          }
          yield chunk
        }
      } finally {
        // 流结束：交还暂存的普通尾字符（如行尾孤立的反引号）；
        // 未闭合围栏里的内容丢弃（那是代码，绝不能念）。
        const tail = fence.flush()
        if (tail) reader.push(tail)
        // 本次调用结束：把当前未完成段落封口。
        // 旧客户端（没有 ack）下调度器会在这一步同步发完剩余句子（不丢尾巴）；
        // 新客户端下剩余句子按播放进度补发（不 burst）。
        reader.end()
        // 复位 busy（对称于钩子开头的置位）：markBusy 内部广播 assistant-busy { busy:false }。
        if (sessionId) markBusy(sessionId, false)
        // 一次 llm/stream 调用结束（注意：**不是**一轮结束 —— 一轮里可能有多次调用，
        // 工具调用链就是这样）。事件名从 v2 的 turn-end 改名为 call-end，对齐语义。
        // 真正的「一轮结束」由 turn-end 表达（下一轮开始时广播上一轮的 turn-end）。
        if (sessionId && turn.turnId) emit('call-end', { sessionId, turnId: turn.turnId })
      }
    })()
  })

  ctx.inject(['webServer', 'sessions'], (scope) => {
    // llm/stream 钩子在 inject 之外，scope 拿不到，这里存一份模块级引用
    sessionsService = scope?.sessions ?? null

    scope.effect(() => {
      const disposers = []
      // 兜底清理长期空闲的流式会话（客户端没发 reset 时防止状态泄漏到下一轮）。
      startStreamSweeper()

      // 空闲释放扫描：模型常驻内存（zipformer2 160MB / 神经 TTS 170MB），
      // 长时间不用就释放掉。同时兜底清理「会话结束后没删」的回合状态
      //（宿主没有会话结束回调，只能用空闲超时）。
      const idleSweeper = setInterval(() => {
        try {
          releaseIdleModels()
        } catch {
          /* 忽略 */
        }
        try {
          turnModel.prune(Date.now())
        } catch {
          /* 忽略 */
        }
        try {
          readAloudScheduler.prune()
        } catch {
          /* 忽略 */
        }
      }, IDLE_SWEEP_MS)
      idleSweeper.unref?.()
      disposers.push(() => clearInterval(idleSweeper))
      // 插件卸载：停掉朗读调度器的定时器，避免悬空回调往已关闭的 SSE 广播。
      disposers.push(() => readAloudScheduler.dispose())

      // --- 配置 ---
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/config',
          handler: async (req, res) => {
            if (req.method === 'GET') {
              await reloadConfig()
              // **只返回配置本身。**
              // 之前这里混着 stats（诊断数据），客户端把整个响应当 config 用，
              // stats 就会被混进 config 对象再 POST 回来 ——
              // 配置与诊断数据必须分开（诊断数据走 /diagnostics）。
              json(res, 200, { ...settings })
              return
            }
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            try {
              const raw = Buffer.from(await readBody(req, 1024 * 1024)).toString('utf8')
              let patch
              try {
                patch = JSON.parse(raw || '{}')
              } catch {
                json(res, 400, { ok: false, errors: [{ key: '', reason: '请求体不是合法 JSON' }] })
                return
              }
              // **严格校验**：类型/枚举/范围/URL 非法 → 400 且不落盘。
              // 之前是「写什么存什么」，非法值要到运行期才以「静默走 online /
              // 每句 500 / 追赶被关掉」的形式爆炸（审计 R6）。
              const checked = validateConfigPatch(patch)
              if (!checked.ok) {
                json(res, 400, { ok: false, errors: checked.errors })
                return
              }
              const current = await readOverrides()
              const next = { ...current, ...checked.value }
              const path = configPath()
              await mkdir(dirname(path), { recursive: true })
              // 原子写：先写临时文件再替换。
              // 直接覆盖的话，写到一半被中断 → JSON 截断 →
              // readOverrides() 的 catch 把 parse 错误吞掉、返回 {} →
              // 用户的配置**静默回到默认值**，界面上一点提示都没有。
              await writeFileAtomic(path, JSON.stringify(next, null, 2) + '\n')
              await reloadConfig()
              // 「config」事件原先在配置变化时广播，但客户端从不监听它 ——
              // 客户端是在挂载时拉一次 /config，之后靠设置面板保存时同步。
              // 保留一个没人消费的事件，只会让后来的人以为「客户端靠它同步配置」。
              // 需要最新配置就拉 GET /config。
              // 配置变了就把要用到的模型在后台加载好：
              // 用户下一次说话就不用等模型加载（zipformer2 要 40 秒）。
              schedulePreload()
              // 响应里也只有配置（不夹带 stats 等诊断数据）。
              json(res, 200, { ok: true, config: settings })
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 客户端朗读进度回报（流控 + 追赶计时）---
      //
      // 宿主按「已发未确认句数 <= READ_ALOUD_LEAD」发句；客户端每**开始播放**
      // 一句就回一条 ack，宿主随即补发下一句。于是朗读节奏由真实播放进度决定，
      // 不会积压、不会丢句跳段（详见 lib/read-aloud-scheduler.js）。
      //
      // POST { sessionId, turnId, count, durationMs? } -> { ok }
      //   count 省略时按 1 计（一次 ack 至少归还一句的配额；0/负数按 1，>64 按 64）；
      //   durationMs（可选，仅 count=1 有意义）：这一句的**真实音频时长**。
      //     宿主用它把「正在播放的剩余时长」精确计入追赶预算（`lagMs` / `playingMs`）；
      //     不传则退回按字数估算（老客户端兼容）。
      //
      // ack 被拒（session 不存在 / turn 不匹配）返回 ok:false，并计入
      // `GET /diagnostics` 的 `readAloudScheduler.rejectedAcks / lastRejectedAck`
      // —— 用于发现「两端 session 记账不一致」（页面缓存了旧 session 等）。
      //
      // 老客户端不会调这条路由：调度器收不到 ack 就按旧的 400ms 时间窗口节奏
      // 发句，行为与修复前一致（兼容 / 兜底）。
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/reading-ack',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            try {
              const raw = Buffer.from(await readBody(req, 8 * 1024)).toString('utf8')
              const body = JSON.parse(raw || '{}')
              const ok = readAloudScheduler.ack({
                sessionId: body?.sessionId,
                turnId: body?.turnId,
                count: body?.count,
                // 客户端播放时回报的真实音频时长（毫秒）：追赶计时用它更准；
                // 老客户端不传就退回按字数估算。
                durationMs: body?.durationMs,
              })
              json(res, 200, { ok })
            } catch (error) {
              json(res, 400, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 诊断信息（原先混在 /config 里）---
      //
      // stats 是**诊断数据**，不是配置。
      // 混在 /config 的响应里有两个害处：
      //   1. 客户端把整个响应当 config 用，stats 就被混进 config 对象；
      //   2. 客户端再把整个对象 POST 回来，配置里就多出几个不认识的键。
      // 所以诊断数据单独走一条路由。
      //
      // 状态：**保留备用** —— 客户端目前还没接这条路由（出问题时的排查入口）。
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/diagnostics',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            try {
              json(res, 200, {
                ok: true,
                /** 事件协议版本（与 SSE 信封里的 v 一致）。 */
                protocol: EVENT_PROTOCOL_VERSION,
                /** 识别/转写计数与最后一次识别内容。 */
                stats,
                /** 助手是否正在生成（与 assistant-busy 事件、/busy 同源）。 */
                busy: {
                  busy: busySession !== null,
                  sessionId: busySession,
                  since: busyAt ? Date.now() - busyAt : 0,
                },
                /**
                 * assistant-busy 事件的广播计数（诊断用）。
                 *
                 * 用来分辨「宿主没发复位事件」和「客户端没收到」——
                 * 两种情况下客户端都会一直以为助手在忙，现象完全一样。
                 */
                busyBroadcasts,
                /** 客户端上报的「边生成边读」会话。 */
                voiceSession,
                /**
                 * 最近一次加载/保存配置时的 schema 告警（非法项已回退/夹紧）。
                 * 为空数组表示配置干净；`[{key, reason}]` 说明用户配置里哪几项被修正。
                 */
                configWarnings,
                /**
                 * 朗读调度器状态（流控诊断）：
                 *   - mode：pending = 还没收到客户端 ack（旧节奏）；flow = 按播放进度发句；
                 *   - outstanding：已发未确认句数（应 <= READ_ALOUD_LEAD）；
                 *   - stalls：ack 超时放行次数（>0 说明客户端回报不正常）。
                 */
                readAloud: readAloudScheduler.diagnostics(),
                /**
                 * 朗读调度器级诊断：被拒绝的 ack（session/turn 对不上时两端记账错位）等。
                 * 老客户端/页面缓存导致的 session 命名空间不一致会在这里体现，
                 * 而不是静默退化为 pending（又慢又滞后）。
                 */
                readAloudScheduler: readAloudScheduler.schedulerDiagnostics(),
                /**
                 * 本地系统语音合成的失败情况。
                 *
                 * 本地失败会静默回退在线（保证「总有声音」），
                 * 但用户以为在离线、文本其实发给了微软 ——
                 * 这个「静默」必须在这里变成可见。
                 */
                localTts: {
                  failures: stats.localTtsFailures,
                  lastError: stats.lastLocalTtsError,
                  lastAt: stats.lastLocalTtsAt,
                },
                /**
                 * 在线（微软 Edge）语音合成的失败情况。
                 *
                 * 在线失败 `/tts` 直接报错，客户端静默跳过那一句 ——
                 * 用户只见「没声音」，必须在这里变得可查。
                 */
                onlineTts: {
                  failures: stats.onlineTtsFailures,
                  lastError: stats.lastOnlineTtsError,
                  lastAt: stats.lastOnlineTtsAt,
                },
                /**
                 * 本地神经（sherpa-onnx VITS）语音合成的失败情况。
                 */
                neuralTts: {
                  failures: stats.neuralTtsFailures,
                  lastError: stats.lastNeuralTtsError,
                  lastAt: stats.lastNeuralTtsAt,
                },
                /**
                 * 外部 GPT-SoVITS 服务（ttsEngine=sovits）的失败情况。
                 */
                sovitsTts: {
                  failures: stats.sovitsTtsFailures,
                  lastError: stats.lastSovitsTtsError,
                  lastAt: stats.lastSovitsTtsAt,
                },
                /** 正在进行的下载。 */
                downloads: [...downloadProgress.entries()].map(([id, progress]) => ({
                  id,
                  received: progress?.received ?? 0,
                  total: progress?.total ?? 0,
                  percent: downloadPercent(progress?.received ?? 0, progress?.total ?? 0),
                })),
              })
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 模型清单 ---
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/models',
          handler: async (req, res) => {
            try {
              // 识别模型与合成模型一起返回，客户端用同一个下载管理界面。
              const asr = await listModels()
              const tts = []
              for (const tier of TTS_MODELS) {
                let ready = false
                try { ready = await isModelReady(tier) } catch { ready = false }
                tts.push({
                  id: tier.id,
                  label: tier.label,
                  labelEn: tier.labelEn,
                  bytes: tier.bytes,
                  ready,
                  downloading: activeDownloads.has(tier.id),
                  ...(downloadProgress.get(tier.id) ?? {}),
                  category: 'tts',
                  note: tier.note,
                  noteEn: tier.noteEn,
                })
              }
              json(res, 200, {
                // 识别模型也要带 downloading / 进度：
                // 之前只有 TTS 模型带，识别模型（Whisper 等）下载中时
                // 界面照样显示「下载模型」，用户完全看不出正在下。
                models: [
                  ...asr.map((m) => ({
                    ...m,
                    category: 'asr',
                    downloading: activeDownloads.has(m.id),
                    ...(downloadProgress.get(m.id) ?? {}),
                  })),
                  ...tts,
                ],
                selected: settings.model,
              })
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 下载模型 ---
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/model',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            let id = ''
            try {
              const raw = Buffer.from(await readBody(req, 1024 * 64)).toString('utf8')
              id = String(JSON.parse(raw || '{}').id ?? '')
            } catch {
              /* 空 */
            }
            // 识别模型与 TTS 模型共用同一套下载机制。
            // kind 标出这是哪一类的档位（客户端要分别显示「下载识别模型 / 下载合成模型」，
            // 也要知道下载完了要刷新哪一栏）。
            const asrModel = findModel(id)
            const ttsModel = findTtsModel(id)
            const model = asrModel ?? ttsModel
            const kind = asrModel ? 'asr' : 'tts'
            if (!model) {
              json(res, 404, { error: 'unknown model: ' + id })
              return
            }
            // 内置模型（isHostedModel 是唯一权威判定）：零下载，只要本地文件在位即可用。
            if (isHostedModel(model)) {
              const ready = await isModelReady(model)
              if (ready) {
                json(res, 200, { ok: true, alreadyReady: true, host: true })
              } else {
                json(res, 409, { error: `宿主内置模型不可用：${model.label}` })
              }
              return
            }
            try {
              if (await isModelReady(model)) {
                json(res, 200, { ok: true, alreadyReady: true })
                return
              }
            } catch (error) {
              // 判不出来就当成「没准备好」，让流程继续走下载，
              // 而不是让路由抛出去导致请求永远没有响应。
              json(res, 200, { ok: true, alreadyReady: false })
              return
            }
            // 下载必须放到后台跑，不能占着 HTTP 请求：
            // 之前 await 在请求处理器里，客户端一超时断开，
            // 下载完成后写响应就会抛异常，宿主直接崩溃。
            if (activeDownloads.has(model.id)) {
              json(res, 202, { ok: true, started: true, alreadyRunning: true })
              return
            }
            activeDownloads.add(model.id)
            json(res, 202, { ok: true, started: true })
            // 后台任务：任何异常都在这里吞掉，绝不让它冒泡到宿主。
            void ensureModel(model, (received, total) => {
              downloadProgress.set(model.id, { received, total })
              // percent 由宿主算好再广播（客户端不要再自己算，两端公式不同会分叉）。
              broadcast('model-progress', {
                id: model.id,
                kind,
                received,
                total,
                percent: downloadPercent(received, total),
              })
            })
              .then(() => {
                releaseRecognizer(model.id)
                // 必须**先清状态再广播**。
                // 客户端收到 model-ready 会立刻拉 /models，
                // 那时 activeDownloads 里要是还留着这个 id，
                // 拉回来的 downloading 还是 true —— 界面就一直显示「下载中」，
                // 永远变不成「已就绪」。
                activeDownloads.delete(model.id)
                downloadProgress.delete(model.id)
                broadcast('model-ready', { id: model.id, kind })
              })
              .catch((error) => {
                activeDownloads.delete(model.id)
                downloadProgress.delete(model.id)
                broadcast('model-error', {
                  id: model.id,
                  kind,
                  error: error instanceof Error ? error.message : String(error),
                })
              })
          },
        }),
      )

      // --- 状态流（SSE）---
      disposers.push(
        scope.webServer.register({
          kind: 'prefix',
          path: '/dsh-voice-typing/stream',
          handler: (req, res) => {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            })
            res.write(': connected\n\n')
            // 写出去的是**整个信封**（v/seq/ts/sessionId + 事件字段），
            // 不是裸载荷 —— 客户端只要认一种形状。
            const listener = (event, envelope) => {
              try {
                res.write(`event: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`)
              } catch {
                /* 忽略 */
              }
            }
            listeners.add(listener)
            // 新连接（页面刷新/断线重连）：旧 SSE 连接遗留的「已发未确认」永远不会
            // 再被 ack，若不释放，新页面首句要等 watchdog（10 秒）才发（实测 10025ms）。
            // 新连接说明旧播放队列已不存在，直接归零并继续补发（已发出的句子不重发）。
            try { readAloudScheduler.resetOutstanding() } catch { /* 忽略 */ }

            // 连接建立时**推送一次当前状态**。
            //
            // 为什么必须有这一步：
            //   assistant-busy 只在 markBusy() 里广播 ——
            //   也就是只在「状态变化的那一刻」发。
            //   客户端如果是在助手**已经开始忙之后**才连上的，
            //   它会先从轮询读到 busy=true，随后 SSE 连上、轮询停掉，
            //   而 SSE 这边不会再发任何东西（状态没再变过）
            //   → 客户端的「助手忙」永远停在 true。
            //
            //   症状：宿主 /busy 说 false，客户端却说 true；
            //         「助手忙时说的话先留草稿、忙完再发」这条链路
            //         永远走不到「发」的那一步 —— 文字停在输入框里。
            //
            // 事件流的标准做法就是「连接即快照」，
            // 这样客户端无论何时连上都能拿到当前状态。
            try {
              listener('assistant-busy', buildEventEnvelope({
                busy: busySession !== null,
                sessionId: busySession,
                // 标记这是「连接建立时的状态快照」，不是一次状态变化。
                // 不加标记的话，客户端与测试会把它误当成一次「复位」——
                // 现象是「助手明明在忙，客户端却说空闲」。
                snapshot: true,
              }))
            } catch {
              /* 忽略 */
            }

            const keepAlive = setInterval(() => {
              try {
                res.write(': ping\n\n')
              } catch {
                /* 忽略 */
              }
            }, 20000)
            req.on('close', () => {
              clearInterval(keepAlive)
              listeners.delete(listener)
            })
          },
        }),
      )

      // --- 语音会话登记：客户端在发送消息前告诉宿主「这一轮要边生成边读」 ---
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/voice-session',
          handler: async (req, res) => {
            try {
              const raw = Buffer.from(await readBody(req, 64 * 1024)).toString('utf8')
              const payload = JSON.parse(raw || '{}')
              voiceSession = payload.sessionId ? String(payload.sessionId) : null
              // 客户端状态上报：定位「语音对话中无法对话」这类问题用。
              if (payload.client) {
                stats.client = {
                  ...payload.client,
                  at: Date.now(),
                }
                stats.clientCount = (stats.clientCount ?? 0) + 1
              }
              json(res, 200, { ok: true, voiceSession })
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 转写 ---
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/transcribe',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            const controller = new AbortController()
            req.on('aborted', () => controller.abort())
            try {
              const body = await readBody(req)
              if (body.length === 0 || body.length % 4 !== 0) {
                json(res, 400, { error: 'expected f32 pcm payload' })
                return
              }
              const samples = new Float32Array(body.buffer, body.byteOffset, body.length / 4)
              // 档位解析必须**严格**：配置里的 model 不存在时报 400，
              // 不要静默回退 SenseVoice（否则用户以为在用 Whisper、实际用 SenseVoice；
              // 审计 D4）。与 /asr-ready 的「未找到该识别档位」提示语义一致。
              const model = findModel(settings.model)
              if (!model) {
                json(res, 400, {
                  ok: false,
                  error: '未知识别档位：' + String(settings.model),
                  errors: [{ key: 'model', reason: '未知识别档位' }],
                })
                return
              }
              if (!(await isModelReady(model))) {
                json(res, 409, { error: '模型尚未就绪：' + model.id })
                return
              }
              // 语言提示真正传给识别器（SenseVoice 的 language / Whisper 的 language）。
              const language = resolveLanguage(settings.language)
              // 热词提示：只写「正确」的那些条目。
              // 只有 transducer（zipformer2）档位支持，运行期传给识别器。
              const { hotwords: hintWords } = parseWordEntries(settings.words ?? [])
              // 放到工作线程里跑：主线程不阻塞，应用不会卡。
              // online（zipformer2）是流式模型，worker 里用 OnlineRecognizer +
              // isReady/inputFinished 的方式解码（用 OfflineRecognizer 会让
              // sherpa 的原生代码直接终止进程）。
              let raw = ''
              // speech 是**请求局部**的：跟着这次识别走，不经过模块级变量。
              // 两个并发 /transcribe（实时字轮询 + 断句识别）各拿各的，
              // 不会互相覆盖 —— 覆盖了客户端就会回滚错实时字。
              let hadSpeech = false
              try {
                const result = await recognizeInWorker(model, samples, language, hintWords)
                raw = result.text
                hadSpeech = result.speech
                // 记一下这次用过，空闲释放才知道哪些模型还在用
                markModelUsed(model.id)
              } catch (error) {
                // worker 起不来时退回主线程，至少还能用。
                const fallback = await recognizeWithSherpa(model, samples, {
                  language,
                  words: settings.words,
                })
                raw = fallback.text
                hadSpeech = fallback.speech
              }
              stats.transcribe += 1
              stats.lastAt = Date.now()
              stats.lastText = raw
              if (hadSpeech) stats.withSpeech += 1
              else stats.noSpeech += 1
              const { text, hotwords } = postProcessWithMeta(raw, {
                words: settings.words,
                language,
                removeFillers: settings.removeFillers,
              })
              // hotwords：词表里纯字符串条目（热词提示，不改文本），供调用方做上下文偏置。
              json(res, 200, { text, model: model.id, language, hotwords, speech: hadSpeech })
            } catch (error) {
              if (controller.signal.aborted) return
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 流式识别：边喂边出字（**保留但未使用**：客户端目前走 /transcribe）---
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/asr-stream',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            let sessionId = ''
            try {
              const url = new URL(req.url ?? '/', 'http://dsh-voice-typing')
              sessionId = url.searchParams.get('sessionId') ?? ''
              const body = await readBody(req)
              if (!sessionId || body.length === 0 || body.length % 4 !== 0) {
                json(res, 400, { error: 'bad request' })
                return
              }
              const state = await getStreamingState(sessionId)
              if (!state || state.unavailable) {
                // 流式模型不可用：明确告诉客户端（不要静默返回空串）。
                json(res, 200, {
                  text: '',
                  unavailable: true,
                  reason: state?.reason ?? '流式识别不可用',
                  model: STREAM_MODEL_ID,
                })
                return
              }
              const kind = state.kind ?? 'native'
              const samples = new Float32Array(body.buffer, body.byteOffset, body.length / 4)
              const decode = state.recognizer.decodeStream ?? state.recognizer.decode
              // 静音片段不喂给解码器：否则流式模型会对着噪声凭空造字。
              // 门限随该流的底噪浮动，底噪高的环境里不会一直喂噪声。
              const level = rmsOf(samples)
              stats.stream += 1
              stats.lastAt = Date.now()

              // 门限判定交给纯函数（见 advanceGate）：
              // 底噪只在「不在说话中」时更新、说话段内的帧一律喂、
              // 连续若干帧静音才退出说话态。
              // 抽成纯函数是为了能直接跑单元测试，
              // 浏览器侧也能用同一份用例表驱动自己的那套门限逻辑。
              const gateResult = advanceGate(state, level)
              // 纯函数返回的是**新**状态，这里只把三个字段搬回会话状态。
              state.noiseFloor = gateResult.state.noiseFloor
              state.inSpeech = gateResult.state.inSpeech
              state.silentFrames = gateResult.state.silentFrames
              if (!gateResult.feed) {
                // 静音：不喂给解码器（否则模型会对着噪声凭空造字）
                const kept = String(state.recognizer.getResult(state.stream).text ?? '').trim()
                json(res, 200, { text: kept, model: state.modelId, speech: false })
                return
              }
              // 原生 addon 的在线流接受对象参数，WASM 版接受 (采样率, 采样) 两个参数。
              if (kind === 'native') state.stream.acceptWaveform({ sampleRate: 16000, samples })
              else state.stream.acceptWaveform(16000, samples)
              if (state.recognizer.isReady) {
                // 同样要加步数上限，见 MAX_DECODE_STEPS 的说明。
                let steps = 0
                while (state.recognizer.isReady(state.stream) && steps++ < MAX_DECODE_STEPS) {
                  decode.call(state.recognizer, state.stream)
                }
              } else {
                decode.call(state.recognizer, state.stream)
              }
              const text = String(state.recognizer.getResult(state.stream).text ?? '').trim()
              state.lastActiveAt = Date.now()
              if (text) stats.streamNonEmpty += 1
              json(res, 200, { text, model: state.modelId, speech: true })
            } catch (error) {
              // 识别失败或客户端中断：丢掉这个会话的流状态，下一轮从零开始（不留残留）。
              discardStreamingState(sessionId)
              if (req.aborted || res.writableEnded) return
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 结束流式：取回当前文本并彻底丢弃解码状态（**保留但未使用**）---
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/asr-stream/reset',
          handler: async (req, res) => {
            try {
              const url = new URL(req.url ?? '/', 'http://dsh-voice-typing')
              const sessionId = url.searchParams.get('sessionId') ?? ''
              const state = streamingStates.get(sessionId)
              let text = ''
              if (state) {
                try {
                  text = String(state.recognizer.getResult(state.stream).text ?? '').trim()
                } catch {
                  /* 忽略 */
                }
              }
              // 彻底丢弃：释放该会话的流对象 + 删除状态（下一轮不会带上一轮残留）。
              discardStreamingState(sessionId)
              // discarded 恒为 true：调用之后该会话一定没有任何流式残留。
              json(res, 200, { text, discarded: true, model: state?.modelId ?? STREAM_MODEL_ID })
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 识别模型就绪状态 ---
      //
      // 客户端在进入「聆听中」之前要先问一句「模型好了吗」。
      //
      // 为什么必须问：首次加载 SenseVoice 要 20~40 秒。
      // 不确认就开麦的话，用户说的话会**全部丢掉**
      // —— 识别请求在模型就绪前就失败了，而失败时音频已经被切走。
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/asr-ready',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            try {
              const model = findModel(settings.model)
              if (!model) {
                json(res, 200, { ready: false, model: settings.model, reason: '未找到该识别档位' })
                return
              }
              const downloaded = await isModelReady(model)
              const loaded = asrLoadedModels.has(model.id) || recognizers.has(model.id)
              json(res, 200, {
                ready: downloaded && loaded,
                downloaded,
                loaded,
                model: model.id,
                reason: !downloaded
                  ? '识别模型还没下载，请先在设置里下载该档位'
                  : !loaded
                    ? '识别模型正在加载（首次需要 20~40 秒）'
                    : '',
              })
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 识别模型预热：确保它真的加载好了 ---
      //
      // 与 /tts/warmup 同一思路（先热身，真正用到时就不用等）。
      // 客户端在开麦前调它：模型没就绪就一直等到就绪为止，
      // 用户看到的是「正在加载模型…」，而不是「说了话没反应」。
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/asr-warmup',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            try {
              const model = findModel(settings.model)
              if (!model) {
                json(res, 200, { ready: false, reason: '未找到该识别档位' })
                return
              }
              if (!(await isModelReady(model))) {
                json(res, 200, { ready: false, reason: '识别模型还没下载，请先在设置里下载该档位' })
                return
              }
              if (asrLoadedModels.has(model.id) || recognizers.has(model.id)) {
                json(res, 200, { ready: true, model: model.id })
                return
              }
              // 真正加载（不走 preloadConfiguredModels ——
              // 那个函数会受 preloadModels 设置影响，而开麦时必须加载）
              const paths = modelPaths(model)
              const ok = await preloadInWorker({
                modelId: model.id,
                kind: model.engine === 'online' ? 'transducer' : model.engine,
                model: paths.model,
                encoder: paths.encoder,
                decoder: paths.decoder,
                joiner: paths.joiner,
                tokens: paths.tokens,
                vad: paths.vad,
                language: resolveLanguage(settings.language),
              })
              if (ok) markModelUsed(model.id)
              json(res, 200, { ready: ok, model: model.id, reason: ok ? '' : '识别模型加载失败' })
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 运行环境自检 ---
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/tts/env',
          handler: async (req, res) => {
            try {
              const env = await checkTtsEnvironment(settings)
              const normalizedEngine = normalizeTtsEngine(settings.ttsEngine)
              // `configured` 用**归一化后**的引擎（配置里的原始字符串可能大小写不一致）。
              env.configured = normalizedEngine
              // 外部 GPT-SoVITS 是「用户自己的服务」：插件不探测/不管理，
              // 但设置面板需要知道它是不是当前引擎、地址是什么。
              env.engines = [
                ...(Array.isArray(env.engines) ? env.engines : []),
                {
                  id: 'sovits',
                  label: 'GPT-SoVITS 外部服务',
                  supported: true,
                  configured: normalizedEngine === 'sovits',
                  url: settings.sovitsUrl,
                },
              ]
              json(res, 200, env)
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 本地神经 TTS 模型档位 ---
      // 路由已删除：客户端用 /models 的统一清单（按 category 区分 asr/tts），
      // 这个单独一份的清单没人调 —— 留着只会让人以为有两套档位定义。
      // 档位本身的定义在 lib/model-catalog.js（/models 会用）。

      // --- TTS 预热：建立共享连接，避免首次朗读等握手 ---
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/tts/warmup',
          handler: async (req, res) => {
            try {
              // 只有**在线引擎**才需要建立 Edge 连接预热。
              // local 没有连接概念；neural 是本地线程；sovits 是用户自己的服务
              // （绝不能在 sovits/离线场景下偷偷连微软 —— 审计 D2）。
              const engine = normalizeTtsEngine(settings.ttsEngine)
              if (engine !== 'online') {
                json(res, 200, {
                  warmed: false,
                  engine,
                  reason: engine ? `${engine} 引擎不需要 Edge 预热` : '语音引擎配置非法，跳过预热',
                })
                return
              }
              await warmUpTts({
                voice: settings.voice,
                rate: settings.rate,
                pitch: settings.pitch,
                volume: settings.volume,
                format: settings.ttsFormat,
              })
              json(res, 200, { warmed: true, engine })
            } catch (error) {
              json(res, 200, { warmed: false, error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 音色列表 ---
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/voices',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            try {
              // 按引擎返回音色：online 走 Edge 云端列表，local 走系统 SAPI；
              // neural（模型自带说话人）与 sovits（音色由用户服务管理）**没有**音色列表，
              // 直接返回空列表，**不再回落成 Edge 音色列表**（审计 D7）。
              const requested = new URL(req.url ?? '/', 'http://x').searchParams.get('engine') ?? settings.ttsEngine
              const engine = normalizeTtsEngine(requested)
              if (!engine) {
                json(res, 400, {
                  ok: false,
                  error: `非法语音引擎：${String(requested)}`,
                  errors: [{ key: 'ttsEngine', reason: `应为 ${TTS_ENGINES.join(' / ')} 之一` }],
                })
                return
              }
              if (engine === 'neural' || engine === 'sovits') {
                json(res, 200, { engine, voices: [] })
                return
              }
              if (engine === 'local') {
                if (!isLocalSupported()) {
                  json(res, 200, {
                    engine: 'local',
                    supported: false,
                    platform: process.platform,
                    voices: [],
                  })
                  return
                }
                const locals = await listLocalVoices()
                json(res, 200, {
                  engine: 'local',
                  supported: true,
                  platform: process.platform,
                  voices: locals.map((v) => ({
                    name: v.name,
                    // 各平台适配器统一用 culture，这里兼容两种字段名
                    locale: v.culture ?? v.locale ?? '',
                    gender: v.gender ?? '',
                    friendly: v.name,
                  })),
                })
                return
              }
              // 缓存 5 分钟：音色列表很少变，避免每次打开设置面板都请求
              const now = Date.now()
              if (!voicesCache || now - voicesCacheAt > 5 * 60 * 1000) {
                voicesCache = await listVoices()
                voicesCacheAt = now
              }
              const lang = (new URL(req.url ?? '/', 'http://x').searchParams.get('lang') ?? '').toLowerCase()
              let voices = voicesCache
              if (lang) voices = voices.filter((v) => String(v?.Locale ?? '').toLowerCase().startsWith(lang))
              json(res, 200, {
                engine: 'online',
                voices: voices.map((v) => ({
                  name: v.ShortName,
                  locale: v.Locale,
                  gender: v.Gender,
                  friendly: v.FriendlyName,
                  tags: v.VoiceTag?.ContentCategories ?? [],
                })),
              })
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 朗读 ---
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/tts',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            try {
              const url = new URL(req.url ?? '/', 'http://dsh-voice-typing')
              const text = (url.searchParams.get('text') ?? '').trim()
              if (!text) {
                json(res, 400, { error: 'missing text' })
                return
              }
              // 按引擎合成：online 走 Edge（音质好，需联网），local 走系统语音（离线），
              // neural 走本地 VITS 模型（离线），sovits 走用户自己的 GPT-SoVITS 服务。
              // local 合成失败时自动回退到 online，保证「总有声音」；
              // sovits 失败**不回退**（隐私/音色承诺）。
              //
              // 引擎值一律 `normalizeTtsEngine`（trim+小写+枚举）：
              // 非法/空 → **400，绝不静默落 online**（审计 D1：否则用户本意是 sovits
              // 时文本会被发给微软）。
              const engine = normalizeTtsEngine(settings.ttsEngine)
              const engineWarning = configWarnings.find((warning) => warning.key === 'ttsEngine')
              if (!engine || engineWarning) {
                json(res, 400, {
                  ok: false,
                  error: `语音引擎配置非法：${engineWarning?.reason ?? String(settings.ttsEngine)}`,
                  errors: [{
                    key: 'ttsEngine',
                    reason: engineWarning?.reason ?? `应为 ${TTS_ENGINES.join(' / ')} 之一`,
                  }],
                })
                return
              }
              let audio
              let mime = 'audio/mpeg'
              // 音频的真实容器格式（'wav' / 'aiff' / 'mp3'）——
              // mime 必须按它来，不能一律写 audio/wav：
              // Chromium/Electron 的 decodeAudioData 不支持 AIFF，
              // 格式对不上时浏览器解码抛错，整句语音被丢掉，
              // 用户看到的就是「一点声音都没有」。
              let format = 'mp3'
              // 实际产出音频的引擎（回退时与用户选的引擎不同）。
              let actualEngine = engine === 'neural' ? 'neural' : engine === 'sovits' ? 'sovits' : 'online'
              if (engine === 'neural') {
                // 本地神经模型（sherpa-onnx VITS）：离线，音质接近在线
                const tier = findTtsModel(settings.neuralModel)
                if (!tier) throw new Error('未知的本地神经模型：' + settings.neuralModel)
                const paths = ttsModelPaths(tier)
                const speed = 1 + (Number.parseInt(String(settings.rate ?? '').replace(/[^-\d]/g, ''), 10) || 0) / 100
                try {
                  const result = await synthesizeNeural({
                    text: text.slice(0, 3000),
                    paths,
                    speakerId: Number(settings.neuralSpeaker ?? 0),
                    speed: Math.max(0.5, Math.min(2, speed)),
                  })
                  audio = encodeWav(result.audio, result.sampleRate)
                  mime = 'audio/wav'
                  format = 'wav'
                } catch (neuralError) {
                  // 神经失败没有回退（本地神经就是本地），直接报错给客户端，
                  // 但必须留下痕迹：客户端会静默跳过这一句，用户只见「没声音」。
                  stats.neuralTtsFailures += 1
                  stats.lastNeuralTtsError =
                    neuralError instanceof Error ? neuralError.message : String(neuralError)
                  stats.lastNeuralTtsAt = Date.now()
                  throw neuralError
                }
              } else if (engine === 'local') {
                try {
                  if (!isLocalSupported()) {
                    throw new Error(`当前平台（${process.platform}）不支持本地语音合成，请改用在线引擎。`)
                  }
                  // 发音人：配置里指定了就用，没指定（或该平台没这个发音人）
                  // 就用平台默认的。否则 macOS/Linux 上会拿 Windows 的语音名去调，
                  // 必然失败并静默回退到在线引擎。
                  //
                  // 校验结果必须缓存：listLocalVoices() 要起一个 PowerShell 进程
                  // （实测 1~20 秒），每次合成都校验会把本地合成拖到几十秒。
                  const voice = await resolveLocalVoice(settings.localVoice)
                  // synthesizeLocal 返回 {audio, format}：
                  // format 是**真实容器**（macOS 的 say 早期只能出 AIFF，
                  // 而浏览器解码器不认 AIFF，所以必须按真实格式给 mime）。
                  const local = await synthesizeLocal({
                    text: text.slice(0, 3000),
                    voice,
                    rate: settings.rate,
                    volume: settings.volume,
                  })
                  audio = local.audio
                  format = local.format ?? 'wav'
                  mime = format === 'aiff' ? 'audio/aiff' : 'audio/wav'
                  actualEngine = 'local'
                } catch (localError) {
                  // 本地失败 → 回退在线（保证「总有声音」）。
                  //
                  // 但必须**留下痕迹**：用户以为在离线，文本其实发给了微软，
                  // 而这个回退原先连日志都没有，完全不可见。
                  // 痕迹有两个：响应头（x-tts-engine-fallback）与
                  // /diagnostics 里的 localTts。
                  stats.localTtsFailures += 1
                  stats.lastLocalTtsError =
                    localError instanceof Error ? localError.message : String(localError)
                  stats.lastLocalTtsAt = Date.now()
                  audio = await synthesizeSpeech({
                    text: text.slice(0, 4000),
                    voice: settings.voice,
                    rate: settings.rate,
                    pitch: settings.pitch,
                    volume: settings.volume,
                    format: settings.ttsFormat,
                  })
                  mime = 'audio/mpeg'
                  format = 'mp3'
                  actualEngine = 'online'
                }
              } else if (engine === 'sovits') {
                // 外部 GPT-SoVITS 服务（用户自己跑 api_v2）：插件只转发文本合成。
                //
                // **不**做本地/在线回退：用户选这个引擎就是要自己的声音
                //（也避免把文本偷偷发给微软）。失败时直接报错，客户端跳过这一句，
                // 但错误必须进 /diagnostics，否则用户只看到「没声音」。
                try {
                  const result = await synthesizeSovits({
                    text: text.slice(0, 2000),
                    settings,
                  })
                  audio = result.audio
                  format = result.format
                  mime = result.mime
                  actualEngine = 'sovits'
                } catch (sovitsError) {
                  stats.sovitsTtsFailures += 1
                  stats.lastSovitsTtsError =
                    sovitsError instanceof Error ? sovitsError.message : String(sovitsError)
                  stats.lastSovitsTtsAt = Date.now()
                  throw sovitsError
                }
              } else {
                try {
                  audio = await synthesizeSpeech({
                    text: text.slice(0, 4000),
                    voice: settings.voice,
                    rate: settings.rate,
                    pitch: settings.pitch,
                    volume: settings.volume,
                    format: settings.ttsFormat,
                  })
                } catch (onlineError) {
                  // 在线失败 → **回退本地系统语音**（保证「总有声音」）。
                  //
                  // 这一条是必须的：在线引擎依赖微软服务器 + WebSocket，
                  // 代理异常、网络抖动、服务端限流都会让它整体不可用。
                  // 之前这里直接抛错（没有任何回退），客户端拿到 500 就
                  // 静默跳过这一句 —— 用户听到的就是**彻底没声音**，
                  // 而 /diagnostics 里 onlineTts.failures 一路上涨
                  //（实测 77 次，全部「15000 毫秒无结果」）。
                  // 本地系统语音（Windows SAPI / macOS say / espeak-ng）
                  // 完全离线，实测一句不到 1 秒，正好用来兜底。
                  stats.onlineTtsFailures += 1
                  stats.lastOnlineTtsError =
                    onlineError instanceof Error ? onlineError.message : String(onlineError)
                  stats.lastOnlineTtsAt = Date.now()
                  let fellBack = false
                  if (isLocalSupported()) {
                    try {
                      const localVoice = await resolveLocalVoice(settings.localVoice)
                      const local = await synthesizeLocal({
                        text: text.slice(0, 3000),
                        voice: localVoice,
                        rate: settings.rate,
                        volume: settings.volume,
                      })
                      if (local?.audio?.length) {
                        audio = local.audio
                        format = local.format ?? 'wav'
                        mime = format === 'aiff' ? 'audio/aiff' : 'audio/wav'
                        actualEngine = 'local'
                        fellBack = true
                      }
                    } catch (localError) {
                      // 本地也失败：记下来，再把在线那个原始错误抛出去
                      stats.localTtsFailures += 1
                      stats.lastLocalTtsError =
                        localError instanceof Error ? localError.message : String(localError)
                      stats.lastLocalTtsAt = Date.now()
                    }
                  }
                  if (!fellBack) throw onlineError
                }
              }
              const headers = {
                'content-type': mime,
                'content-length': audio.length,
                'cache-control': 'no-store',
                // 客户端按真实容器解码，这里把格式也明确报出来
                //（content-type 也是 CORS 安全响应头，跨源时照样读得到）。
                'x-dsh-audio-format': format,
                // 实际用的是哪个引擎：选了 local 却回退到 online 时，
                // 这个头会明确写出来（不然用户以为在离线，文本其实发给了微软）。
                'x-tts-engine': actualEngine,
              }
              if (engine === 'local' && actualEngine !== 'local') {
                headers['x-tts-engine-fallback'] = 'online'
              }
              // 在线失败、回退到本地系统语音时也明确标出来（可观测）：
              // 不然用户以为在用在线音色，其实听的是系统语音。
              if (engine !== 'local' && actualEngine !== engine) {
                headers['x-tts-engine-fallback'] = actualEngine
              }
              res.writeHead(200, headers)
              res.end(audio)
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 最新回复（**保留中：客户端仍用其 turnAnchor/turnKey 做回合判定**）---
      //
      // 状态：客户端这一轮**还要用**它（里面的 turnAnchor / turnKey 算法
      // 是回合模型的依据），所以路由先留着。
      // 但它不属于新事件契约的一部分，也没有 SSE 事件与之对应 ——
      // 等客户端那侧改完回合模型，这条路由连同 activeSession 一起删掉。
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/latest-message',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            try {
              const url = new URL(req.url ?? '/', 'http://dsh-voice-typing')
              // 客户端不一定能拿到 sessionId（注入的会话状态里没有可靠字段），
              // 所以这里允许不传：回退到 voiceSession → 唯一会话。
              // 之前强制要求 sessionId，客户端拿不到就 400，朗读永远没文本 —— 「没声音」。
              let sessionId = (url.searchParams.get('sessionId') ?? '').trim()
              if (!sessionId) {
                sessionId = voiceSession || ''
              }
              if (!sessionId) {
                try {
                  const all = scope.sessions?.list?.() ?? []
                  if (all.length === 1) {
                    const only = all[0]
                    sessionId = typeof only === 'string' ? only : (only?.id ?? '')
                  }
                } catch { /* 忽略 */ }
              }
              if (!sessionId) {
                json(res, 400, { error: 'no session available' })
                return
              }
              const store = scope.sessions
              const session = typeof store?.get === 'function' ? store.get(sessionId) : undefined
              if (!session || typeof session.deriveMessages !== 'function') {
                json(res, 404, { error: 'session not found: ' + sessionId })
                return
              }
              const messages = session.deriveMessages()
              if (url.searchParams.get('debug') === '1') {
                const brief = messages.map((m) => ({
                  role: m?.role,
                  blocks: Array.isArray(m?.content) ? m.content.map((b) => ({ type: b?.type ?? b?.kind, len: typeof b?.text === 'string' ? b.text.length : 0 })) : null,
                }))
                json(res, 200, { total: messages.length, tail: brief.slice(-8) })
                return
              }
              // 收集「本轮」的完整回复：从最后一条 user 之后，把所有
              // assistant 文本块按顺序拼起来。
              // 之前只取「最后一条带文本的 assistant」，但一轮里
              // assistant(文本) → tool-call → tool → assistant(文本) 很常见，
              // 只取最后一条会丢掉前面的内容，读出来就是残缺的、像是"上一次的回复"。
              let lastUserIndex = -1
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i]?.role === 'user') { lastUserIndex = i; break }
              }
              // 轮次标识：用本轮起点 + 本轮内 assistant 文本块总数，
              // 这是个稳定值（空闲时不变），并且每轮对话都会变。
              const pieces = []
              for (let i = lastUserIndex + 1; i < messages.length; i++) {
                const msg = messages[i]
                if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
                for (const block of msg.content) {
                  if (!block) continue
                  const isText = block.type === 'text' || block.kind === 'text'
                  if (!isText || typeof block.text !== 'string') continue
                  const piece = block.text.trim()
                  if (piece) pieces.push(piece)
                }
              }
              const text = pieces.join('\n').trim()
              // 轮次键用「本轮最后一条 user 的稳定序号」，不用文本块数量：
              // 用块数的话，生成过程中 1→2→3 会一直变，客户端会以为不断有新回复。
              let turnAnchor = ''
              if (lastUserIndex >= 0) {
                const um = messages[lastUserIndex]
                turnAnchor = String(um?.id ?? um?.seq ?? um?.eventSeq ?? lastUserIndex)
              }
              const turnKey = `${turnAnchor}`
              // complete：这一轮是否已经收尾（最后一条消息不是 assistant/tool 且没有 pending tool-call）
              let complete = true
              const lastMsg = messages[messages.length - 1]
              if (lastMsg) {
                const lastBlocks = Array.isArray(lastMsg.content) ? lastMsg.content : []
                const hasToolCall = lastBlocks.some((b) => b && (b.type === 'tool-call' || b.kind === 'tool-call'))
                if (lastMsg.role === 'tool') complete = false
                else if (lastMsg.role === 'assistant' && hasToolCall) complete = false
              }
              if (text) {
                json(res, 200, { text: text.slice(0, 4000), turnKey, complete })
                return
              }
              json(res, 404, { error: 'no assistant message with text', turnKey, complete })
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // --- 生成状态（降级通路）---
      //
      // 客户端的首选通路是 SSE 的 assistant-busy 事件（不用轮询、零延迟）。
      // 这条路由保留着：SSE 连不上时客户端还能降级来问一句。
      // 两条通路必须给出一致的答案，所以它们读的是同一份状态。
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/busy',
          handler: async (req, res) => {
            json(res, 200, {
              busy: busySession !== null,
              sessionId: busySession,
              since: busyAt ? Date.now() - busyAt : 0,
            })
          },
        }),
      )

      // 注：原先这里还有 GET/POST /session（以及对应的 session 事件）。
      // 客户端从来不调它 —— activeSession 恒为 null，是一条**死链**：
      //   - 客户端拿不到可靠的会话 id，POST 的 sessionId 永远是空；
      //   - session 事件也没有任何订阅者。
      // 全部删除，不留半死不活的入口。

      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 忽略 */
          }
        }
        // 停掉后台定时器：插件被停用/重载时必须清理，
        // 否则每次重载都会多留一个 15 秒的轮询定时器，永远不停。
        stopStreamSweeper()
        // 释放常驻的识别器（模型常驻在内存里，不释放会一直占着几百 MB）
        try {
          releaseAllRecognizers()
        } catch {
          /* 忽略 */
        }
        // 终止本地合成线程（线程里常驻着 170MB 模型）
        try {
          disposeNeuralTts()
        } catch {
          /* 忽略 */
        }
      }
    })
  })

  // 读取一次用户覆盖配置（宿主启动时即可拿到）。
  reloadConfig()
    .then(() => schedulePreload())
    .catch(() => {})
}

// 声明插件依赖的服务。
// llm/stream 是 LLM 服务派发的事件，必须在这里声明，否则事件永远到不了本插件 ——
// 之前是空数组，ctx.on('llm/stream') 注册了但一次都没被调用（hookCalls: 0）。
export const inject = ['llm']
export const name = 'dsh-voice-typing'
export { MODELS }
