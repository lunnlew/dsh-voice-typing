/**
 * dsh-voice-typing —— 宿主侧（Node 侧）。
 *
 * 提供 HTTP 路由供浏览器侧的麦克风控件使用。
 *
 * 路由清单**不在这里抄一份**（批次 25）：真身就是下面那一串 `webServer.register({ path })`，
 * 给人看的那份住在 `cordis.patch.yml` 的文件头，两边由 `test/route-contract.test.mjs`
 * 拿真装出来的注册表**双向**核对 —— 清单少了、注册多了、名字写歪了都会红。
 * 这里以前抄过一张 20 行的表，它没有判据管着，于是 `/reading-ack`、`/asr-ready`、
 * `/asr-warmup`、`/ui-action-claim` 四条先后漏在它外面（§8.59 末尾记的就是这个缺口）。
 * 加一条路由的正确做法：在这里注册 + 在 `cordis.patch.yml` 补一行，少哪一侧判据就报哪一侧。
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
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { writeFileAtomic } from './atomic-file.js'
import { synthesizeSpeech, listVoices, warmUpTts } from './edge-tts.js'
import { synthesizeLocal, listLocalVoices, isLocalSupported, defaultLocalVoice } from './local-tts.js'
import { synthesizeNeural, listSpeakers, encodeWav, disposeNeuralTts, preloadNeural, releaseNeural } from './neural-tts.js'
import { synthesizeSovits } from './sovits-tts.js'
import { checkTtsEnvironment } from './tts-env.js'
import { createTurnModel } from './turn-model.js'
import { decodeOnlineStream } from './decode-steps.js'
import { STREAM_DISCARD_REASONS, noteStreamingDiscard, streamDiscardSnapshot } from './stream-discard-log.js'
import { ASR_READY_REASONS } from '../shared/asr-readiness.js'
import { CONFIG_ERROR_REASONS } from '../shared/config-error-codes.js'
import { MODEL_DOWNLOAD_REASONS, modelDownloadReasonOf } from '../shared/model-download-reasons.js'
import { postProcessWithMeta, parseWordEntries } from './text-rules.js'
import { createReadAloudScheduler } from './read-aloud-scheduler.js'
import { createFenceFilter } from './fence-filter.js'
import {
  TTS_ENGINES,
  ASR_LANGUAGES,
  VOICE_PROMPT_MODES,
  CONFIG_DEFAULTS,
  normalizeTtsEngine,
  sanitizeConfig,
  validateConfigPatch,
} from './config-schema.js'
import { createHotkeyHelper, helperSupported } from './global-hotkey-helper.js'
import {
  advanceGate,
  DEFAULT_GATE_OPTS,
  STREAM_SILENT_FRAMES_TO_END,
  INITIAL_GATE_STATE,
} from './gate.js'
import {
  UI_ACTION_NAMES,
  UI_ACTION_LIMITS,
  actionNeedsConfirm,
  buildUiActionPayload,
  getUiActionSpec,
  validateUiAction,
  validateUiActionResult,
} from './ui-action-protocol.js'
import {
  MODELS,
  findModel,
  listModels,
  ensureModel,
  isModelReady,
  isHostedModel,
  modelPaths,
  STREAM_MODEL_ID,
  TTS_MODELS,
  findTtsModel,
  ttsModelPaths,
} from './model-catalog.js'

/**
 * 配置默认值 —— **就是** `src/shared/config-spec.js` 的 `CONFIG_DEFAULTS`
 * （每个键的类型/范围/默认值写在 spec 的 `def` 上，注释也在那一侧）。
 *
 * 以前这里是 35 行手写字面量，与 `lib/config-schema.js` 的 SPECS、客户端的
 * `UI_DEFAULTS` 各有一份，加一个配置项要同时改四处。
 * 这里是别名而不是拷贝，所以 `{ ...DEFAULTS }`、`sanitizeConfig(x, DEFAULTS)`
 * 的行为与以前逐字一致（shared 那份是冻结的，本文件只读不写）。
 */
const DEFAULTS = CONFIG_DEFAULTS

/** 允许写回配置的键。 */
const CONFIG_KEYS = Object.keys(DEFAULTS)

/** 宿主侧当前生效的配置（apply() 里刷新；模块级函数也要读语言设置）。 */
let currentSettings = { ...DEFAULTS }

/** `/voice-prompt` 的文本长度上限（与界面动作 send_prompt 的上限保持同一份真源）。 */
const MAX_VOICE_PROMPT_CHARS = UI_ACTION_LIMITS.text

/**
 * `/voice-prompt` 的 requestId 长度上限。
 *
 * requestId 会作为用户消息的 `source.rpcId` 落进会话日志，并被
 * `hasPromptRequest` 反复扫描；64KB 请求体里塞一个超长 id 会让每条新消息的
 * 去重检查都多扫一大段字符串。UUID（36 字符）远小于 200，不影响正常客户端。
 */
const MAX_REQUEST_ID_CHARS = 200

/**
 * `/ui-action-claim` 的 clientId 长度上限。
 *
 * clientId 只是「哪个窗口先认领」的随机标识（sessionStorage 里的 UUID），
 * 200 足够；限长防止把请求体当成无界字符串存进 pending 表。
 */
const MAX_CLIENT_ID_CHARS = 200

/**
 * `voice_ui` 工具等待渲染器回执的超时（毫秒）。
 *
 * 20 秒是「用户点确认 + 执行」的合理上限：再长会让模型的工具调用卡住整轮；
 * 太短则用户还没来得及看清确认条就超时。
 * 做成可覆盖的模块级变量只为测试（见 setVoiceUiTimeoutForTest）——
 * 生产路径不需要也不应该改它。
 */
let voiceUiTimeoutMs = 20_000

/**
 * 仅供测试：缩短 `voice_ui` 的等待超时，避免测试真的等 20 秒。
 * @param {number} ms - 新的超时（毫秒）；非法值恢复默认。
 */
export function setVoiceUiTimeoutForTest(ms) {
  voiceUiTimeoutMs = Number.isFinite(ms) && ms > 0 ? ms : 20_000
}

/**
 * 懒加载 `@deepseek-ai/dsh-llm` 的 `createUserMessage`。
 *
 * 只有走 `agents.followup` 兜底时才需要它；优先路径（sessionController.prompt）
 * 完全不碰这个包，所以包解析失败时语音注入仍然可用（只是失去兜底）。
 * package.json 里声明了 optional peer `@deepseek-ai/dsh-llm`，DSH 的安装级
 * 解析表才会把这个包重定向到安装内副本（之前没声明 → 生产环境必然
 * ERR_MODULE_NOT_FOUND，兜底其实是死代码）。
 * 失败后清空缓存：DSH 升级/重装后下一次调用还能再试。
 *
 * @returns {Promise<Function>} createUserMessage。
 */
let createUserMessagePromise = null

/**
 * 仅供测试：注入 createUserMessage 加载器。
 *
 * 生产环境用 `import('@deepseek-ai/dsh-llm')`；测试环境没有该包，
 * 用它覆盖「没有 sessionController 时 agents.followup 兜底成功」的路径。
 *
 * @param {Function|null} loader - 返回 createUserMessage 的 async 函数；null 恢复默认。
 */
let createUserMessageLoaderForTest = null
export function setCreateUserMessageLoaderForTest(loader) {
  createUserMessageLoaderForTest = typeof loader === 'function' ? loader : null
  createUserMessagePromise = null
}

async function loadCreateUserMessage() {
  if (createUserMessageLoaderForTest) {
    const injected = await createUserMessageLoaderForTest()
    if (typeof injected !== 'function') throw new Error('测试注入的 createUserMessage 加载器未返回函数')
    return injected
  }
  if (!createUserMessagePromise) {
    createUserMessagePromise = import('@deepseek-ai/dsh-llm')
      .then((module) => {
        const factory = module?.createUserMessage ?? module?.default?.createUserMessage
        if (typeof factory !== 'function') throw new Error('@deepseek-ai/dsh-llm 未导出 createUserMessage')
        return factory
      })
      .catch((error) => {
        createUserMessagePromise = null
        throw error
      })
  }
  return createUserMessagePromise
}

/**
 * 把注入失败的错误归一化成带 code 的结构（路由据此回 502）。
 * @param {unknown} error - 本次尝试的错误（可为 null）。
 * @param {unknown} fallback - 更早一次尝试的错误（主路径失败后兜底也失败时用）。
 * @returns {Error} 带 code 的错误。
 */
function toInjectError(error, fallback) {
  const source = error ?? fallback
  const message = source instanceof Error ? source.message : String(source ?? '')
  const normalized = new Error(message || '没有可用的注入通路')
  normalized.code = source && typeof source.code === 'string' && source.code ? source.code : 'inject_failed'
  return normalized
}

/**
 * 归一化语音注入方式（queue / steer）。
 * @param {unknown} value - 请求里的 mode 或配置值。
 * @param {string} [fallback] - 非法时用的默认值。
 * @returns {'queue'|'steer'} 合法模式。
 */
function normalizeVoicePromptMode(value, fallback = 'queue') {
  if (typeof value !== 'string') return fallback
  const text = value.trim().toLowerCase()
  return VOICE_PROMPT_MODES.includes(text) ? text : fallback
}

/**
 * 比较 /hotkey 的 token（长度不等直接失败；相等时用 timingSafeEqual）。
 *
 * 路由只在本机 loopback 上，威胁模型很弱；但热键能直接触发语音模式，
 * 用常数时间比较的成本几乎为零，没有理由用 `===`。
 *
 * @param {unknown} provided - 请求头里的 token。
 * @param {unknown} expected - helper 生成的 token。
 * @returns {boolean} 是否一致。
 */
function safeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false
  if (!provided || !expected) return false
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * sherpa-onnx 支持的识别语言名（auto = 由模型自动判别）。
 * 真源是 `src/shared/config-vocab.js` 的 `ASR_LANGUAGES`（配置项 `language` 的枚举），
 * 这里只是宿主内部沿用旧名字的局部别名 —— 不要再抄一份字面量：
 * 第四份副本一旦和词表分叉，表现是「配置能存但识别静默回退 auto」。
 */
const SUPPORTED_LANGUAGES = ASR_LANGUAGES

/**
 * 流式实时文字用的模型档位 id 来自 `./model-catalog.js` 的 `STREAM_MODEL_ID`
 * （目录里 `engine: 'online'` 的那一个）。
 * 批次 5c 之前这里是第二份字面量，客户端的 `STREAM_MODEL_IDS` 是第三份，
 * 一致性靠扫源码正则对拍；现在两份都在数据层比（`test/live-asr.test.mjs`）。
 */

// 门限状态机（纯函数）已抽到 lib/gate.js。
// 这里 re-export，保持「宿主导出了 advanceGate / DEFAULT_GATE_OPTS」这个公共接口
// （test/gate-host.test.mjs 从 lib/index.js import），并让 /asr-stream 继续用
// 宿主侧默认常数。宿主侧与浏览器侧用的是同一套算法、不同的门限常数，
// 由 test/fixtures/gate-cases.mjs 同一张用例表驱动两侧。

export { advanceGate, DEFAULT_GATE_OPTS, STREAM_SILENT_FRAMES_TO_END }

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

/**
 * 系统/本机默认语言（用于配置为 auto 时）。
 *
 * 为什么不把 auto 直接交给识别引擎：SenseVoice 的 auto 是整句语言判定，
 * 对 2~3 个字的短唤醒词极不稳定（实测「小鱼」被识别成英文「I.」/「U.」）。
 * 配置 auto 的语义改为「用本机默认语言」——这与用户预期一致，也让预加载、
 * 识别、空闲释放拿到**同一个**语言，避免 worker 因语言不同缓存两份模型。
 *
 * @returns {'zh'|'yue'|'ja'|'ko'|'en'|'auto'} 系统语言；无法判断时 auto。
 */
function systemLocaleLanguage() {
  try {
    const locale = String(Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || '')
    const lower = locale.toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
    if (lower.startsWith('ja')) return 'ja'
    if (lower.startsWith('ko')) return 'ko'
    if (lower.startsWith('en')) return 'en'
  } catch {
    /* 老运行时没有 Intl：退回 auto */
  }
  return 'auto'
}

/**
 * 当前生效的识别语言：显式配置优先；配置 auto 时用系统默认语言。
 * @returns {'zh'|'yue'|'ja'|'ko'|'en'|'auto'} 语言。
 */
function effectiveLanguage() {
  const configured = resolveLanguage(currentSettings.language)
  return configured === 'auto' ? systemLocaleLanguage() : configured
}

/** 当前生效的语言提示。 */
function currentLanguage() {
  return effectiveLanguage()
}

/**
 * 解析 `x-dsh-voice-language` 请求头：只接受白名单值，非法/auto/缺失时退回配置语言。
 *
 * 单独导出给测试；路由里也用同一个函数，避免「注释说退回配置、代码退回 auto」。
 *
 * @param {string|undefined} headerValue - 请求头原始值。
 * @param {string} configuredLanguage - 当前生效语言（通常是 currentLanguage()）。
 * @returns {string} 供本次识别使用的语言。
 */
export function resolveRequestLanguage(headerValue, configuredLanguage) {
  const raw = typeof headerValue === 'string' ? headerValue.trim().toLowerCase() : ''
  if (raw && raw !== 'auto' && SUPPORTED_LANGUAGES.includes(raw)) return raw
  return configuredLanguage
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
      // 绝大多数键里，空串表示「没填，用默认值」；但 wakeWord 的空串是**有语义的**：
      // 它表示「关闭唤醒词」。所以这里必须放行 wakeWord，否则设置面板里
      // 把唤醒词清空保存后，运行期又被默认值 '小D' 顶回去（静默无法关闭）。
      const emptyIsMeaningful = key === 'wakeWord'
      if (value !== undefined && value !== null && (value !== '' || emptyIsMeaningful)) merged[key] = value
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

/**
 * 这条错是不是「我们自己把请求拒了」。
 *
 * 判据是带不带**4xx 的 `statusCode`**：读体超限（413）这类拒绝自己会把状态码挂在错上，
 * 而运行期异常（识别器抛的、原生代码抛的）没有。
 * 一条路上只有这一处会产生 4xx（`readBody` 的 413），所以这个判据等价于
 * 「不是我们自己拒的，就是处理过程中真出事了」。
 * 一件事两处要用（批次 8 用它决定「要不要回执」，批次 11/12 用它决定「要不要动会话状态」），
 * 所以把它写成一处，别在两个 catch 里各判各的。
 *
 * @param {unknown} error - 处理请求时抛出来的错。
 * @returns {boolean} 是否是请求级拒绝（4xx 状态码）。
 */
function isRequestRejection(error) {
  const status = Number(error?.statusCode)
  return Number.isInteger(status) && status >= 400 && status < 500
}

/**
 * 出错时给这条请求写回执。
 *
 * 为什么要抽这一处（批次 8，docs/architecture-modernization.md §8.49）：
 * 「这条请求还能不能回话」原先在两条识别路由里各判各的，而且都判错了对象 ——
 * 判的是 `aborted` 标志，可在 Node 里**消费方自己提前退出读体循环**
 * （`readBody` 超限抛错就是这种）同样会把入站流标成 aborted。
 * 于是「主动拒绝超限请求」被当成「客户端走了」，**一个回执都不写**：
 * 真机上给 `/transcribe` 发 17 MB（超过 16 MB 上限），20 秒、120 秒都没有任何回应，
 * 浮层停在「识别中」，用户看不到错误，只能重开。这条是装机回归撞出来的，
 * 测试撞不出来 —— 夹具的假 req 原先不模拟「提前退出」，本批已把它补到和 Node 一样。
 *
 * 判据换成两条真的：
 *   1. 能不能写 → 看 `res`（已销毁 / 已写完 / 已发过头就不写）；
 *   2. 是不是我们自己拒绝的 → 带 `statusCode` 的错（超限 413）**必须**回执，
 *      哪怕连接同时被标成 aborted；只有不带 statusCode 的运行期异常才按「客户端走了」丢掉。
 *
 * @param {object} res - HTTP 响应对象。
 * @param {unknown} error - 处理请求时抛出来的错。
 * @param {boolean} aborted - 调用方算出来的「连接是不是已经没了」。
 * @returns {boolean} 是否真的写了回执。
 */
function replyRequestError(res, error, aborted) {
  const status = Number(error?.statusCode) || 500
  if (!isRequestRejection(error) && aborted) return false
  json(res, status, { error: error instanceof Error ? error.message : String(error) })
  return true
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
 * 请求体是否声明为 JSON（Content-Type 含 application/json，忽略大小写/参数）。
 *
 * 为什么必须查这个：插件路由注册在 DSH 的 `/api` 鉴权桥**之外**，本机任意
 * 进程都能访问；更麻烦的是浏览器里任意网页也能用
 *   fetch(url, { method:'POST', headers:{'content-type':'text/plain'}, body:'{...}' })
 * 发「简单请求」—— 不触发 CORS 预检，直接打到 loopback 上。
 * 有副作用的路由（/voice-prompt 注入用户消息、/ui-action-result 伪造工具回执、
 * /hotkey 切语音模式）不校验就等于留着一条 CSRF 后门。
 * 要求 application/json 之后，跨域请求必须触发预检，而预检没有 CORS 应答会被拒。
 * 代价为零：自己的客户端 fetch 与热键 helper 脚本本来就都发 application/json。
 *
 * @param {object} req - HTTP 请求。
 * @returns {boolean} 是否是 JSON 请求。
 */
function isJsonContentType(req) {
  const raw = req?.headers?.['content-type']
  return typeof raw === 'string' && raw.toLowerCase().includes('application/json')
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
 * 首次加载要多久**没有可靠的上界**（2026-11-04 装机实测：whisper-tiny 424 ms、
 * 228 MB 的 SenseVoice 回热约 1 秒；更大档位与慢盘上没有测过），
 * 所以这里和给用户看的文案都不写具体秒数（批次 9，docs §8.50）。
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
 * 彻底丢弃某个会话的流式状态：释放流对象 + 删除状态条目，并记下**为什么丢**。
 *
 * 「彻底丢弃」= 下一轮一定从零开始，不会带上一轮的残留文字。
 * @param {string} sessionId - 会话 id。
 * @param {string} reason - `STREAM_DISCARD_REASONS` 里的一个（五个入口各自的形态）。
 *   必须报：这是「实时文字为什么整段没了」唯一的可见依据。
 *   漏报当场抛 —— 宁可炸在测试里，也不要装机上多一条说不清的丢弃。
 *   （批次 12 那次修的就是这里的一条语义：请求级拒绝不许丢弃，docs §8.53。）
 * @returns {boolean} 是否确实丢掉了状态。
 */
function discardStreamingState(sessionId, reason) {
  if (!reason) throw new Error('discardStreamingState 必须报原因（见 stream-discard-log.js 的词表）')
  const state = streamingStates.get(sessionId)
  if (!state) return false
  streamingStates.delete(sessionId)
  noteStreamingDiscard({
    sessionId,
    reason,
    modelId: state.modelId,
    idleMs: Number.isFinite(state.lastActiveAt) ? Date.now() - state.lastActiveAt : null,
  })
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
    if (state.recognizer === recognizer) discardStreamingState(sessionId, STREAM_DISCARD_REASONS.RECOGNIZER_FREED)
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
 *
 * 判据怎么跑到这一段（批次 16）：不用等 15 秒、也不用把常量调小 ——
 * 装载宿主期间接管 `setInterval` 把回调收下来，再把 `Date.now` 挪过上限，
 * 由测试自己决定「现在扫一次」。写法与 `test/turn-boundary.test.mjs` 那一节相同。
 */
function startStreamSweeper() {
  if (streamSweeper) return
  streamSweeper = setInterval(() => {
    const now = Date.now()
    for (const [sessionId, state] of [...streamingStates]) {
      if (now - (state.lastActiveAt ?? 0) > STREAM_IDLE_TIMEOUT_MS) {
        discardStreamingState(sessionId, STREAM_DISCARD_REASONS.IDLE_TIMEOUT)
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
      discardStreamingState(sessionId, STREAM_DISCARD_REASONS.RECOGNIZER_CHANGED)
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
      // 起点值来自门限模块（INITIAL_GATE_STATE），不在这里写死数字。
      noiseFloor: INITIAL_GATE_STATE.noiseFloor,
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
        language: currentLanguage(),
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
      // 这条 120 秒定时器**不按住进程**（批次 11，docs §8.52）：
      // 它只是「等不到回包就报失败」的兜底，宿主正在退出时不该为它再等两分钟。
      // 判据是句柄上的 `hasRef()`（`test/worker-pending-settle.test.mjs`），不是源码里有没有那句 `unref`。
      timer.unref?.()
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
        // 批次 7：这条与「重新下载完成」共用同一个 releaseModelEverywhere，
        // 两处不再各写各的（以前只有这里通知了线程，下载完成那一处只清了名单）。
        const model = findModel(modelId)
        if (model) void releaseModelEverywhere(modelId)
        else releaseRecognizer(modelId)
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
  /**
   * 线程没了（报错、或者当场退出）时，把所有在等它的人一次性结算掉。
   *
   * 为什么必须有（批次 11，docs §8.52）：`asrPending` 里的任务是「等回包」的 Promise，
   * 而 `'error'` 只在**有错误对象**时发。线程被原生代码干掉（sherpa 的 C++ 崩溃、OOM、
   * 批次 7 见过的那些「原生直接终止进程」的形态）时，Node 只发 `'exit'`。
   * 以前 `'exit'` 里只有一句 `asrWorker = null`，于是：
   *   - `recognizeInWorker` 的 Promise 永远不 settle（它连超时定时器都没有）
   *     → 那条 `/transcribe` 连接一直挂着、一个字节都不回，和批次 8 那个超限缺陷同一类；
   *   - 客户端只会看到「说了没反应」，宿主这边连一条错误都不会记。
   * 结算成 reject 之后，调用方各自走已有的处置：`/transcribe` 落主线程同步识别（还能出字），
   * 预加载/释放报告 false（不谎报成功）。
   *
   * @param {Error} error - 失败原因（'exit' 那条没有真错误，造一条说明情况的）。
   */
  const settlePendingAsFailure = (error) => {
    for (const task of asrPending.values()) task.reject(error)
    asrPending.clear()
  }
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
    settlePendingAsFailure(error instanceof Error ? error : new Error(String(error)))
    try { worker.terminate() } catch { /* 忽略 */ }
    asrWorker = null
  })
  // `'exit'` 也必须结算（见上面 `settlePendingAsFailure` 那段）。
  // 挂在**每次新建**的线程上，不是只给第一个线程补的补丁：
  // 死一次之后 `asrWorker` 是 null，下一次会重建，那条路径同样会再死。
  worker.on('exit', () => {
    settlePendingAsFailure(new Error('识别线程已退出'))
    asrWorker = null
  })
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
 * 「已加载」名单**不在这里动**（批次 7）：这里只负责线程那一侧，
 * 名单由 `releaseRecognizer` 单点负责。以前这里有一句
 * `if (spec?.modelId) asrLoadedModels.delete(...)`，而唯一的调用方传的是
 * `{model, encoder, language}`（不带 modelId），于是它从来没生效过 ——
 * 留着它就是第二条「看起来在记账、其实没记」的路径，比没有更糟。
 *
 * @param {object} spec - 档位描述（要和预加载时用的完全一致，缓存键才对得上）。
 * @returns {Promise<boolean>} 是否释放成功。
 */
function releaseInWorker(spec) {
  try {
    if (!asrWorker) return Promise.resolve(false)
    const id = ++asrSeq
    // 缓存键要和 worker 里的 recognizerKey(spec) 完全一致
    const key = spec.model + '|' + (spec.encoder ?? '') + '|' + (spec.language ?? 'auto')
    // 同一个模型可能因语言不同缓存了多份（auto / 待机 zh），按模型前缀整组释放。
    const keyPrefix = spec.model + '|' + (spec.encoder ?? '') + '|'
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        asrPending.delete(id)
        resolve(false)
      }, 15000)
      // 同样不按住进程（批次 11）：停用那条是 `void releaseModelEverywhere(id)`，
      // 没人等这个返回值，留着 ref 句柄只会让「插件停用之后进程退出」最多白等 15 秒 × 档位数。
      timer.unref?.()
      asrPending.set(id, {
        keyPrefix,
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
        // `key` 与 `keyPrefix` 都要发（批次 7）：线程那边的规则是
        // 「有 keyPrefix 就按前缀整组释放，否则只按精确键释放一份」。
        // 以前这里只发 key，于是上面算出来的 keyPrefix 白算了 ——
        // 同一份模型因为语言提示不同缓存的其它识别器（配置语言 + 待机强制语言）
        // 就一直留在内存里，注释里说的「整组释放」从来没生效。
        asrWorker.postMessage({ kind: 'release', id, key, keyPrefix })
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
 * 把一个档位「里外都释放」：工作线程里那份识别器 + 主线程回退那份 + 已加载名单。
 *
 * 为什么要有这一个函数（批次 7，docs §8.47）：识别器住在**工作线程**里，
 * 主线程的 `recognizers` Map 只有走回退路径才有条目。以前三条释放路径里
 * 只有「空闲释放」通知了线程，另两条只调 `releaseRecognizer` —— 于是：
 *   - 「用重新下载修复损坏的模型」修不动：线程里的缓存键是 `model|encoder|language`
 *     （只看路径、不看文件内容），旧文件建好的那份识别器一直命中；
 *   - 插件停用/重载号称释放常驻模型（几百 MB），实际线程一个 release 消息都没收到。
 * 「空闲释放」「重新下载完成」「插件停用」三条路径都走这里，就不再各写各的
 * （停用那条要并上「已加载」名单才知道线程里有哪些档，见 `releaseAllRecognizers`）。
 *
 * @param modelId - 档位 id。
 * @returns {Promise<boolean>} 线程那边是否真的释放了某份识别器（主线程那份与名单照旧清）。
 */
function releaseModelEverywhere(modelId) {
  let workerRelease = Promise.resolve(false)
  const model = findModel(modelId)
  if (model) {
    try {
      const paths = modelPaths(model)
      // 缓存键要和预加载时用的完全一致（语言取当前生效值），前缀才能对上。
      workerRelease = releaseInWorker({
        model: paths.model,
        encoder: paths.encoder,
        language: currentLanguage(),
      })
    } catch {
      /* 线程没起来或路径算不出：主线程那份与名单仍然要清 */
    }
  }
  releaseRecognizer(modelId)
  return workerRelease
}

/**
 * 释放全部已加载过的识别器（插件停用/重载那条路径）。
 *
 * 识别器里常驻着模型（几百 MB），插件卸载/重载时不释放就一直占着内存。
 *
 * 为什么要并上「已加载」名单（批次 7 场景 B，docs §8.47）：识别器住在**工作线程**里，
 * 主线程这张 `recognizers` Map 在正常路径下是空的 —— 只遍历它的话，
 * 这句「不释放就一直占着几百 MB」承诺的是不存在的东西（6l-e 发现 1）。
 * 名单里每个 id 都走 `releaseModelEverywhere`，于是线程那份也放掉。
 *
 * 线程本身**不终止**（那是裁定的另一半）：热重载之后线程还在，
 * 下次 `/asr-warmup` 只要重新加载模型（本机实测 SenseVoice 228 MB 约 1 秒），
 * 不用重起线程，也不会把在途识别请求一起拆掉。
 *
 * @returns {number} 发起释放的档位数。
 */
function releaseAllRecognizers() {
  const ids = new Set([...recognizers.keys(), ...asrLoadedModels])
  let count = 0
  for (const modelId of ids) {
    try {
      void releaseModelEverywhere(modelId)
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
        // 循环与它的步数上限只有一处实现（src/host/decode-steps.js，批次 6k）：
        // decode 不推进状态时它必须有限步内返回，否则宿主主线程被卡死。
        decodeOnlineStream(recognizer, stream, (r, s) => decode.call(r, s))
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
import { createDiagnostics, DIAGNOSTICS_GROUPS, MAX_EVENTS_PER_GROUP, WAKE_MISS_TEXT_LIMIT } from './diagnostics.js'
import { groupWakeMissByWake } from './wake-miss-index.js'

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
  /** 诊断事件记录器（按引擎/功能分组的事件队列，环形缓冲）。 */
  const diagnostics = createDiagnostics()
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
     * 「听到但没匹配上唤醒词」的**总次数**（批次 14，docs §8.56）。
     *
     * 明细在诊断记录器的 `wakeMiss` 分组里（环形缓冲，只留最近若干条）；
     * 这个计数**不受窗口裁剪**，所以「20 条样本之外还有多少」看得见 ——
     * 判唤醒方案时它就是那个诚实的分母。
     */
    wakeMissCount: 0,
    /**
     * 最近一次浮层开麦**实际用上**的采集路径（批次 10，任务 #38）。
     *
     * 单独一个字段，不复用 `stats.client`：那个装的是 wake-miss / 发送尝试，
     * 每条都会覆盖前一条，采集路径混进去就把那边的现场冲掉了。
     * 形状：`{path, reason, at}`，path 取值见客户端 `GLOBAL_CAPTURE_PATHS`
     * （'worklet' / 'script-processor' / 'none'）。
     */
    capture: null,
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
    /**
     * 全局语音注入（/voice-prompt）的统计。
     *
     * 客户端优先在渲染器里 `session.prompt()` 直发，失败才走这条回退；
     * 不回退成功/失败次数的话，用户看到的就是「说话没反应」，
     * 没人知道是直发失败、回退也失败、还是压根没调。
     */
    voicePrompt: 0,
    voicePromptFailures: 0,
    lastVoicePromptAt: 0,
    lastVoicePromptError: '',
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

  // -------------------------------------------------------------------------
  // 全局语音 / AI 界面操控（v1）：服务句柄、回执等待表、系统级热键 helper
  // -------------------------------------------------------------------------

  /**
   * 注入回合用的服务句柄。
   *
   * 为什么不用模块级变量：测试会在同一进程里多次 apply()，每个宿主必须
   * 拿自己那份；而且拆成独立 inject 后，某个服务缺失只降级对应能力，
   * 不会把整块 webServer 路由一起拖死（sessionController/agents 是 DSH
   * 桌面端才有的服务，别的部署里可能没有）。
   */
  const services = { sessionController: null, agents: null }

  /**
   * 已下发、等待渲染器回执的 UI 动作（requestId → {resolve, timer, action}）。
   *
   * 工具 execute 与 POST /ui-action-result 是两条独立调用，只能靠这张表
   * 把「模型的一次工具调用」和「渲染器的一次回执」对上。
   */
  const pendingUiActions = new Map()

  /** 最近 UI 动作记录上限（/diagnostics.uiActions）。 */
  const UI_ACTION_LOG_LIMIT = 50
  /**
   * /diagnostics 用的最近 UI 动作（只记 {at,requestId,action,ok,error}）。
   * **不记录参数正文**：text/line 里可能是用户的语音转写或会话 id，
   * 诊断数据不应该变成一份额外的消息副本。
   */
  const uiActionLog = []
  const rememberUiAction = (entry) => {
    try {
      uiActionLog.push(entry)
      while (uiActionLog.length > UI_ACTION_LOG_LIMIT) uiActionLog.shift()
    } catch {
      /* 诊断记录失败不能影响动作 */
    }
  }

  /** 宿主 webServer 端口（Windows helper 建 URL 的兜底）。注入后才有值。 */
  let webPort = 0
  /** 宿主 webServer 对外 origin（http(s) 时优先用它拼 helper 回调地址）。 */
  let webOrigin = ''

  /**
   * 读取 webServer 的真实对外 origin。
   *
   * 插件不能假设宿主永远绑在 `http://127.0.0.1:<port>`：DSH 的 webServer 可配
   * host/协议（TLS 部署、指定网卡）。Windows helper 脚本里写死的地址一旦错了，
   * C# 的 POST 会静默失败，而诊断里却显示「已启动」。
   *
   * @param {object} webServer - webServer 服务（测试替身可能没有 getOrigin）。
   * @returns {string} `http(s)://host[:port]`（无尾斜杠）；不可用时返回空串（调用方兜底）。
   */
  const resolveWebOrigin = (webServer) => {
    try {
      const origin = webServer?.getOrigin?.()
      if (typeof origin === 'string' && /^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, '')
    } catch {
      /* 老版本/精简部署没有 getOrigin：走端口兜底 */
    }
    return ''
  }

  /**
   * 系统级全局热键 helper（lib/global-hotkey-helper.js）。
   *
   * Windows 走 PowerShell 子进程（token + HTTP 路由）；macOS/Linux 走
   * uiohook-napi（进程内）。native 命中时直接在这里广播 SSE —— 同一进程内
   * 调用，不需要额外进程/token/端口。
   */
  const hotkeyHelper = createHotkeyHelper({
    log: (message) => {
      try { ctx.logger?.warn?.(`[dsh-voice-typing] ${message}`) } catch { /* 忽略 */ }
    },
    onTrigger: () => {
      try { broadcast('global-hotkey', { action: 'toggle' }) } catch { /* 忽略 */ }
    },
  })

  /**
   * 按当前配置（重新）同步 helper。
   *
   * 端口/origin 未知时也调用：native 路径不需要它们；Windows 路径会自己
   * 记录「宿主地址未知」原因而不是用错地址拉起。同一配置重复 sync 是幂等的。
   *
   * @returns {{enabled:boolean, status:string, reason:string, detail:string}} helper 状态（/diagnostics 用；
   *   `reason` 是 `src/shared/hotkey-reasons.js` 里的原因码，`detail` 只进诊断不进界面）。
   */
  const syncHotkeyHelper = () => {
    try {
      // sync 是同步的：开关关闭/浮层未开/加速键非法都只记录原因、不抛错。
      // 用 apply 作用域的 settings（不是模块级 currentSettings）：
      // 同一进程里可能有多个宿主实例（测试），配置不能串。
      hotkeyHelper.sync(settings, webPort, webOrigin)
    } catch (error) {
      // 拉起失败只影响系统级热键，其它语音能力照常。
      try {
        ctx.logger?.warn?.(
          `[dsh-voice-typing] 全局热键 helper 同步失败：${error instanceof Error ? error.message : String(error)}`,
        )
      } catch { /* 忽略 */ }
    }
    return hotkeyHelper.state()
  }

  /**
   * 把一段文本作为「用户消息」注入指定会话。
   *
   * 优先 `sessionController.prompt` —— 它就是 composer 发消息走的那个入口
   * （正常落库、能恢复冷会话）。
   *
   * **只有 sessionController 不可用（服务缺失/没有 prompt 方法）时才走
   * `agents.get(id).followup/steer` 兜底。** 如果 controller.prompt 抛错，
   * 直接把错误上报给客户端（502），不再二次注入 —— 主路径可能已经入队了
   * 这条消息（例如本地超时但服务端接受了），再 followup 一次会让同一条语音
   * 在会话里出现两遍。
   * **绝不**手写 session 事件假装一轮开始：那样不会触发模型。
   *
   * @param {{sessionId:string, text:string, requestId:string, mode:'queue'|'steer'}} input
   * @returns {Promise<void>} 注入成功；失败抛带 code 的错误。
   */
  const injectVoicePrompt = async ({ sessionId, text, requestId, mode }) => {
    const controller = services.sessionController
    if (controller && typeof controller.prompt === 'function') {
      try {
        const result = await controller.prompt({
          sessionId,
          requestId,
          mode,
          content: [{ type: 'text', text }],
        }, AbortSignal.timeout(15000))
        // 服务端可能用 {ok:false}/{accepted:false} 表示「没接住」而不是抛错
        //（例如 requestId 去重命中时是 accepted:true，属于成功）。
        if (result?.ok === false || result?.accepted === false) {
          const rejected = new Error(result?.error?.message ?? '会话拒绝了这条消息')
          rejected.code = result?.error?.code ?? 'session_rejected'
          throw rejected
        }
        return
      } catch (error) {
        // 关键：这里**不**回退 agents —— controller 已经尝试过，状态未知，
        // 再注入一次有重复风险（见函数注释）。直接上报。
        throw toInjectError(error, null)
      }
    }

    const agent = services.agents?.get?.(sessionId)
    if (agent) {
      try {
        const createUserMessage = await loadCreateUserMessage()
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
        if (mode === 'steer' && typeof agent.steer === 'function') await agent.steer(message)
        else if (typeof agent.followup === 'function') await agent.followup(message)
        else throw new Error('该会话的 Agent 不支持 followup/steer')
        return
      } catch (error) {
        throw toInjectError(error, null)
      }
    }

    throw toInjectError(new Error('sessionController 不可用且该会话没有可用的 Agent'), null)
  }

  /**
   * 从真实 `sessionController.list()` 的一行里取标题。
   *
   * 真实行**没有顶层 title**：`summaryFor()` 只平铺 header 的少量字段
   * （parentSessionId/origin/cwd），标题在 projections 里
   * （`row.projections.values.title`）。旧测试替身返回顶层 title 恰好把这个
   * bug 遮住了 —— 线上表现为模型拿到一串只有 id 的会话，无法按名字选择。
   *
   * @param {object} row - list() 的一行。
   * @returns {string} 标题（trim 后截断 200）；没有则为空串。
   */
  const sessionTitleOf = (row) => {
    const projected = row?.projections?.values?.title
    if (typeof projected === 'string' && projected.trim()) return projected.trim().slice(0, 200)
    if (typeof row?.title === 'string' && row.title.trim()) return row.title.trim().slice(0, 200)
    if (typeof row?.name === 'string' && row.name.trim()) return row.name.trim().slice(0, 200)
    return ''
  }

  /**
   * 从真实行里取「最近一次用户 prompt 时间」。
   *
   * 真实值在 `row.projections.values.sessionListMetadata.lastPromptAt`；
   * 顶层的 `updatedAt` 是**任意事件**的时间（含助手回复/工具调用），
   * 旧代码把它当成 lastPromptAt 会误导模型判断「最近对话」。
   *
   * @param {object} row - list() 的一行。
   * @returns {number|null} epoch ms；没有则为 null。
   */
  const sessionLastPromptAtOf = (row) => {
    const projected = row?.projections?.values?.sessionListMetadata?.lastPromptAt
    if (Number.isFinite(projected)) return projected
    if (Number.isFinite(row?.lastPromptAt)) return row.lastPromptAt
    // 兜底：老测试替身/老版本只有 updatedAt；用它总比 null 好。
    if (Number.isFinite(row?.updatedAt)) return row.updatedAt
    return null
  }

  /**
   * 给 voice_ui 的会话摘要（id/title/lastPromptAt，最多 50 个）。
   *
   * 为什么不在工具里直接返回 `sessionController.list()` 原始行：那个对象包含
   * projections 等大块数据，塞回模型会浪费大量 token；模型只需要能选中目标。
   * 另外把 `running/blank/cwd` 带上——模型判断「切到哪个会话/哪个在跑」要用。
   *
   * @returns {Promise<Array<{id:string,title:string,lastPromptAt:number|null,running:boolean,blank:boolean,cwd?:string}>>}
   *   摘要列表。
   */
  const listSessionsForTool = async () => {
    const controller = services.sessionController
    if (!controller || typeof controller.list !== 'function') {
      const error = new Error('会话服务不可用')
      error.code = 'session_controller_unavailable'
      throw error
    }
    // 真实签名是 list(request, signal)，返回 {items:[...]}；测试替身也可能返回数组。
    const result = await controller.list(undefined, AbortSignal.timeout(5000))
    const rows = Array.isArray(result) ? result : (Array.isArray(result?.items) ? result.items : [])
    return rows.slice(0, 50).map((row) => {
      const summary = {
        id: String(row?.sessionId ?? row?.id ?? ''),
        title: sessionTitleOf(row),
        lastPromptAt: sessionLastPromptAtOf(row),
        running: row?.running === true,
        blank: row?.blank === true,
      }
      if (typeof row?.cwd === 'string' && row.cwd) summary.cwd = row.cwd
      return summary
    })
  }


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

  // -------------------------------------------------------------------------
  // 系统提示词 section 与 uiControl 开关联动（评审 P2-6）
  //
  // 提示词在宣传「你可以调用 voice_ui」，而工具在 uiControl=false 时只会
  // 返回 ui_control_disabled：无条件注册等于每次都白占 token、还让模型
  // 疑惑「为什么工具不可用」。所以按开关动态注册/注销：
  // 打开 → 注册；关闭 → 立即释放；插件卸载 → 释放。
  // -------------------------------------------------------------------------
  /** systemPrompt 服务句柄（inject 后可用；缺失时静默跳过提示词能力）。 */
  let systemPromptService = null
  /** 当前已注册的 voice-ui section disposer（null = 未注册）。 */
  let voiceUiPromptDispose = null

  /**
   * 构建 voice-ui 提示词文本（动作表由协议生成，避免第三份副本漂移）。
   * @returns {string} 提示词 section 正文。
   */
  const buildVoiceUiPromptText = () => {
    const actionLines = UI_ACTION_NAMES.map((name) => {
      const spec = getUiActionSpec(name)
      const params = spec && spec.params.length
        ? `参数：${spec.params.join('、')}${spec.required.length ? `（必填：${spec.required.join('、')}）` : ''}`
        : '无参数'
      const confirm = spec?.confirm ? '（危险动作，默认需用户确认）' : ''
      return `- ${name}${confirm}：${params}`
    }).join('\n')
    return [
      '你可以调用 voice_ui 工具操作 DSH 的用户界面。',
      '只在用户明确要求操作界面（切换/新建会话、执行斜杠命令、发送消息、停止生成、收起侧栏、打开插件页、通用界面操作、查看界面状态）时调用；普通问答不要调用。',
      '一次调用只做一个动作。动作由用户界面执行，可能被用户拒绝或超时：失败时把错误照实告诉用户，不要假装成功，也不要反复重试同一个被拒绝的动作。',
      '不要用这个工具做审批/授权类操作（同意工具调用、回答 agent 提问、放宽权限）—— 那些只能由用户本人完成。',
      '通用界面操作（ui_snapshot / ui_click / ui_type / ui_key）：先调用 ui_snapshot 拿到当前页面可见可交互元素的 ref，再按返回的 ref 操作；ref 只在最近一次快照内有效，过期或找不到就重新 ui_snapshot，不要猜，也不要把 DOM 选择器/坐标当 ref。',
      'ui_click / ui_type / ui_key 可能改变界面甚至提交数据，默认需要用户确认（用户说「允许/拒绝」或点确认条都算）；被拒绝就停下，不要换一个 ref 重试。',
      '优先用语义动作（切/建会话、set_sidebar、open_plugins、run_command、send_prompt 等）；语义动作覆盖不了的界面才用 a11y 原语。',
      '该工具依赖用户开启「全局语音浮层」（界面执行器与确认条都在浮层里）；浮层未开启时会返回 voice_overlay_disabled，照实告诉用户去设置里打开，不要重试。',
      '收到 ui_control_disabled / voice_overlay_disabled 说明用户没开对应开关，请提示去设置里打开，不要重试。',
      '动作表：',
      actionLines,
    ].join('\n')
  }

  /**
   * 按当前 `settings.uiControl` 确保提示词 section 的注册状态（幂等）。
   * 配置保存后由 reloadConfig 调用；systemPrompt 服务注入时也会立即调用一次。
   */
  const syncVoiceUiPromptSection = () => {
    if (!systemPromptService || typeof systemPromptService.section !== 'function') return
    const wanted = settings.uiControl === true
    if (wanted && !voiceUiPromptDispose) {
      try {
        // order 5000：排在既有提示词 section 之后，不抢 harness 身份/工具说明的位置。
        voiceUiPromptDispose =
          systemPromptService.section({ name: 'voice-ui', order: 5000, text: buildVoiceUiPromptText() }) ?? null
      } catch {
        // 注册失败不影响工具本身；下次配置保存会重试。
        voiceUiPromptDispose = null
      }
      return
    }
    if (!wanted && voiceUiPromptDispose) {
      const dispose = voiceUiPromptDispose
      voiceUiPromptDispose = null
      try { dispose() } catch { /* 忽略 */ }
    }
  }

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
    // 配置变化可能改了 globalHotkeyHelper/globalVoice/globalShortcut：同步 helper。
    // 地址未知时 helper 自己会记录原因（不会用错地址拉起子进程）；
    // 同一配置重复 sync 是幂等的。
    syncHotkeyHelper()
    // uiControl 开关变化：动态注册/注销 voice-ui 提示词 section。
    syncVoiceUiPromptSection()
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

  // -------------------------------------------------------------------------
  // 服务句柄与模型工具（界面操控的宿主半边）
  // -------------------------------------------------------------------------

  // 单独 inject：服务缺失时只让「注入回合 / list_sessions」降级，
  // 不会连累 webServer 路由（那是语音主链路，必须始终可用）。
  ctx.inject(['sessionController'], (scope) => {
    services.sessionController = scope?.sessionController ?? null
  })
  ctx.inject(['agents'], (scope) => {
    services.agents = scope?.agents ?? null
  })

  // 系统提示词：只在 uiControl 打开时注册 voice-ui section（见
  // syncVoiceUiPromptSection 的说明）。配置保存后 reloadConfig 会动态增删；
  // inject 回调本来就在 Cordis effect 里，卸载时 section 也会随作用域释放，
  // 这里再显式 dispose 一次，保证「先关开关、后卸载」两条路径都干净。
  ctx.inject(['systemPrompt'], (scope) => {
    systemPromptService = scope?.systemPrompt ?? null
    syncVoiceUiPromptSection()
    return () => {
      systemPromptService = null
      if (voiceUiPromptDispose) {
        const dispose = voiceUiPromptDispose
        voiceUiPromptDispose = null
        try { dispose() } catch { /* 忽略 */ }
      }
    }
  })

  // 模型工具 voice_ui：模型调用 → 插件 SSE 下发 → 渲染器执行 → HTTP 回执。
  //
  // 用 raw 定义（不 import @deepseek-ai/dsh-tools）：工具定义只是个普通对象，
  // 直接交给 ctx.tools.register；这样包解析失败也不会把整个插件拖垮。
  // 工具默认全局可见（DSH 没有按会话屏蔽全局工具的公开入口），真正的总开关
  // 是 execute 里的 uiControl 判断 —— 关闭时连广播都不发。
  ctx.inject(['tools'], (scope) => {
    const tools = scope?.tools
    if (!tools || typeof tools.register !== 'function') return undefined
    try {
      const dispose = tools.register({
        name: 'voice_ui',
        description: '操作 DSH 用户界面：切换/新建会话、执行斜杠命令、发送消息、停止生成、收起侧栏、查看界面状态。仅在用户明确要求操作界面时调用；一次调用只做一个动作；用户拒绝、超时或参数错误都会返回错误，请照实转告用户，不要重试同一个被拒绝的动作。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: [...UI_ACTION_NAMES], description: '要执行的界面动作（见动作表）' },
            sessionId: { type: 'string', description: 'switch_session / stop_generation 的目标会话 id' },
            text: { type: 'string', description: 'send_prompt 要发送给当前会话的消息文本；ui_type 要输入的文本' },
            line: { type: 'string', description: 'run_command 要执行的斜杠命令（单行，如 /compact）' },
            workspaceId: { type: 'string', description: 'new_session 可选的 workspace id' },
            ref: { type: 'string', description: 'ui_click / ui_type 的目标元素：先调用 ui_snapshot，把它返回的 ref（如 e12）原样传回来；ref 只在最近一次快照内有效' },
            key: { type: 'string', description: 'ui_key 要发送的按键或组合键，如 Escape、Tab、Ctrl+K（单键或 Ctrl/Alt/Shift/Meta + 单键）' },
            collapsed: { type: 'boolean', description: 'set_sidebar 的方向：true = 收起侧栏，false = 展开侧栏' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          // 输出统一是一段 JSON 字符串：模型只需要读结构化结果，
          // 不需要宿主再拼自然语言（拼了反而和客户端渲染分叉）。
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        /**
         * 执行一次界面动作。
         * @param {object} args - 工具参数（action + 对应动作的参数）。
         * @param {object} exec - DSH 工具执行上下文（exec.agent 是调用会话的 Agent）。
         * @returns {Promise<string>} JSON 字符串结果（ok/error/value）。
         */
        async execute(args, exec) {
          // 总开关：关闭时不做任何动作、不向渲染器广播。
          // 读 apply 作用域的 settings：同一进程多宿主（测试）时配置不串。
          if (settings.uiControl !== true) {
            return JSON.stringify({ ok: false, error: 'ui_control_disabled' })
          }
          // 执行前先校验（客户端执行前还会再校验一次，双保险）。
          const checked = validateUiAction(args?.action, args)
          if (!checked.ok) {
            rememberUiAction({ at: Date.now(), requestId: '', action: String(args?.action ?? ''), ok: false, error: checked.error })
            return JSON.stringify({ ok: false, error: checked.error })
          }
          const { action, params } = checked

          // list_sessions 是纯宿主数据：直接答，不经过渲染器（没有界面依赖，
          // 用户没打开浮层时也能用）。
          if (action === 'list_sessions') {
            try {
              const value = await listSessionsForTool()
              return JSON.stringify({ ok: true, value })
            } catch (error) {
              return JSON.stringify({
                ok: false,
                error: (error && typeof error.code === 'string' && error.code) || 'session_list_failed',
                message: error instanceof Error ? error.message : String(error),
              })
            }
          }

          // 并发保护：工具一次只该有一个动作在途；模型狂调时不要把等待表撑爆。
          if (pendingUiActions.size >= 16) {
            return JSON.stringify({ ok: false, error: 'ui_busy' })
          }

          // 界面动作的执行器住在全局语音浮层里（它是唯一能弹确认条、能读当前
          // 会话的地方）。浮层总开关没开时不会有执行器，直接返回明确错误，
          // 别让模型白等 20 秒超时。
          if (settings.globalVoice !== true) {
            return JSON.stringify({ ok: false, error: 'voice_overlay_disabled' })
          }

          const requestId = randomUUID()
          // confirm 是生效值：只读动作永远不弹确认，危险动作才看 uiConfirm。
          const confirm = settings.uiConfirm !== false && actionNeedsConfirm(action)
          // exec.agent 是调用本工具的 Agent；session.id 就是当前会话 id。
          const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id ?? null
          // 一个 deadline 同时用于「下发给客户端的 expiresAt」和「宿主自己的等待超时」。
          // 两者必须完全一致：否则宿主 20s 判失败后，用户 30s 内点「允许」仍会真的
          // 执行动作（ghost action，模型已收到失败却发出了一条消息/命令）。
          const expiresAt = Date.now() + voiceUiTimeoutMs
          const payload = buildUiActionPayload({ requestId, sessionId, action, params, confirm, expiresAt })

          const result = await new Promise((resolve) => {
            const timer = setTimeout(() => {
              pendingUiActions.delete(requestId)
              resolve({ ok: false, error: 'ui_timeout' })
            }, Math.max(0, expiresAt - Date.now()))
            // 注意**不要** unref 这个定时器：它是「这次工具调用」的兜底，
            // 被 unref 后如果事件循环恰好没有别的句柄，Promise 永远不 settle，
            // 模型的一轮就永远卡住（测试里就等于进程直接退出）。
            pendingUiActions.set(requestId, { resolve, timer, action, claimedBy: null })
            // 先登记再广播：渲染器回执可能比广播返回还快（同进程 HTTP）。
            broadcast('ui-action', payload)
          })

          // 诊断记录（不记录参数正文）。
          rememberUiAction({
            at: Date.now(),
            requestId,
            action,
            ok: result?.ok === true,
            error: result?.ok === true ? '' : String(result?.error ?? ''),
          })

          if (result?.ok === true) {
            const wrapped = { ok: true }
            if (result.value !== undefined) wrapped.value = result.value
            // 用户取消（浮层确认条选了「取消」）时客户端回 value.cancelled=true，
            // 这里同时提到顶层，模型更容易理解。
            if (result.value && typeof result.value === 'object' && result.value.cancelled === true) wrapped.cancelled = true
            return JSON.stringify(wrapped)
          }
          const failed = { ok: false, error: result?.error ?? 'ui_action_failed' }
          if (result?.value && typeof result.value === 'object' && result.value.cancelled === true) failed.cancelled = true
          return JSON.stringify(failed)
        },
      })
      return () => {
        try { dispose?.() } catch { /* 忽略 */ }
      }
    } catch (error) {
      // 工具注册失败不能拖垮语音：只写日志（宿主界面操控不可用，其它照常）。
      try {
        ctx.logger?.warn?.(
          `[dsh-voice-typing] voice_ui 工具注册失败（界面操控不可用）：${error instanceof Error ? error.message : String(error)}`,
        )
      } catch { /* 忽略 */ }
      return undefined
    }
  })

  ctx.inject(['webServer', 'sessions'], (scope) => {
    // llm/stream 钩子在 inject 之外，scope 拿不到，这里存一份模块级引用
    sessionsService = scope?.sessions ?? null

    // 系统级热键 helper 需要真实端口/origin：注入完成后才能同步。
    // 启动时的 reloadConfig() 可能比这个 inject 早跑（那时地址未知），
    // 所以这里必须再同步一次，否则「开了开关但热键一直不启动」。
    //
    // 注意**不要**用「端口变了才 sync」：cordis 可能因服务替换重新激活这个
    // inject（cleanup 里 dispose 了 helper），端口不变时若不 sync 就永远不重启。
    // helper.sync 对相同配置是幂等的，无条件调用没有副作用。
    const port = Number(scope?.webServer?.port)
    if (Number.isInteger(port) && port > 0) webPort = port
    webOrigin = resolveWebOrigin(scope?.webServer)
    syncHotkeyHelper()

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
                json(res, 400, {
                  ok: false,
                  errors: [{
                    key: '',
                    reason: CONFIG_ERROR_REASONS.BODY_NOT_JSON,
                    detail: '请求体不是合法 JSON',
                  }],
                })
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
              // 这条链路的失败也要「报码」而不是把 `error.message` 当界面文案（批次 20，docs §8.62）：
              // 413（体积超限）有自己那句，其余一律 `save-failed`；原始消息留在 `detail` 给排查。
              // 状态码沿用 `replyRequestError` 的口径（`statusCode` 优先，否则 500），
              // 这里不走它，正是因为它那套回执只有自由文本 `error` 这一个字段。
              const status = Number(error?.statusCode) || 500
              const detail = error instanceof Error ? error.message : String(error)
              json(res, status, {
                ok: false,
                errors: [{
                  key: '',
                  reason: status === 413
                    ? CONFIG_ERROR_REASONS.BODY_TOO_LARGE
                    : CONFIG_ERROR_REASONS.SAVE_FAILED,
                  detail,
                }],
              })
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
              // wake-miss 的明细只取一次：索引和明细同一份数组，
              // 「按 wake 分组的次数」与「窗口里那 20 条」就不会各说各话（批次 26，docs §8.74）。
              const wakeMissEvents = diagnostics.events(DIAGNOSTICS_GROUPS.WAKE_MISS)
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
                  events: diagnostics.events(DIAGNOSTICS_GROUPS.LOCAL_TTS),
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
                  events: diagnostics.events(DIAGNOSTICS_GROUPS.ONLINE_TTS),
                },
                /**
                 * 本地神经（sherpa-onnx VITS）语音合成的失败情况。
                 */
                neuralTts: {
                  failures: stats.neuralTtsFailures,
                  lastError: stats.lastNeuralTtsError,
                  lastAt: stats.lastNeuralTtsAt,
                  events: diagnostics.events(DIAGNOSTICS_GROUPS.NEURAL_TTS),
                },
                /**
                 * 外部 GPT-SoVITS 服务（ttsEngine=sovits）的失败情况。
                 */
                sovitsTts: {
                  failures: stats.sovitsTtsFailures,
                  lastError: stats.lastSovitsTtsError,
                  lastAt: stats.lastSovitsTtsAt,
                  events: diagnostics.events(DIAGNOSTICS_GROUPS.SOVITS_TTS),
                },
                /**
                 * 全局语音注入（/voice-prompt）的统计。
                 * 客户端直发失败才走这条回退；计数与最近错误是排查「说话没反应」的入口。
                 */
                voicePrompt: {
                  count: stats.voicePrompt,
                  failures: stats.voicePromptFailures,
                  lastAt: stats.lastVoicePromptAt,
                  lastError: stats.lastVoicePromptError,
                  events: diagnostics.events(DIAGNOSTICS_GROUPS.VOICE_PROMPT),
                },
                /**
                 * 待机里「听到但没匹配上唤醒词」的现场（批次 14，docs §8.56）。
                 *
                 * `{count, window, events}`：`count` 是**总次数**（不随窗口裁剪），
                 * `window` 是 `events` 最多留几条（从诊断记录器那一份常量来，不在这里抄数字），
                 * `events` 是 `{at, text, wake}`，旧→新。
                 *
                 * 这块存在的意义是**让判据能量出来**：唤醒方案（拼音归一 / 音频级 KWS /
                 * 零代码缓解）要选哪个，取决于「这些错法里有多少其实听起来就是唤醒词」，
                 * 那句话只能从混淆样本堆上算，`stats.client` 的单格覆盖攒不出来。
                 */
                wakeMiss: {
                  count: stats.wakeMissCount,
                  window: MAX_EVENTS_PER_GROUP,
                  events: wakeMissEvents,
                  /**
                   * 按**当时配置的唤醒词**分好组的同一份窗口（批次 26，docs §8.74）。
                   *
                   * `[{wake, count, texts: [{text, count}]}]`，组与组内都按次数从多到少。
                   * 为什么要它：`events` 是流水，改过唤醒词之后里面混着两个词，
                   * 拿旧词的样本去和新词比出来的比例是假的；分组这一步原先每次手工做、
                   * 而且没人判过对不对（§8.56(三) 记的就是这笔欠账）。
                   * 为什么分母是窗口不是 `count`：见 `src/host/wake-miss-index.js` 头部，
                   * 简言之这份索引是**算出来的**，不额外存状态，所以它不可能超出那 20 条。
                   */
                  byWake: groupWakeMissByWake(wakeMissEvents),
                },
                /**
                 * 流式会话状态被**彻底丢弃**的现场（批次 16，docs §8.58）。
                 *
                 * `{count, window, events}`，形状与 `wakeMiss` 那一块一致：
                 * `count` 是总次数（不随窗口裁剪），`events` 是
                 * `{at, sessionId, reason, modelId, idleMs}`，旧→新。
                 * `reason` 的取值就是 `stream-discard-log.js` 那张词表，五个入口各一个。
                 *
                 * 为什么要有这一块：「实时文字整段消失」是用户看得见、代码答不出的那类事。
                 * 批次 12 修掉的是其中一个入口（超限的请求不许丢），修完之后
                 * 「这次到底丢没丢」仍然只能读代码相信 —— 现在它是 `/diagnostics` 里的一行，
                 * 包括「没丢」那种情况：413 之后这里多不出事件，就是修复还在生效的证据。
                 *
                 * 这一组跟着模块级的 `streamingStates` 走，不跟着 `apply()` 实例走，
                 * 理由写在 `stream-discard-log.js` 头部（识别器释放与空闲清扫都在实例外面）。
                 */
                streamDiscard: streamDiscardSnapshot(),
                /**
                 * 最近 50 条 UI 动作（{at, requestId, action, ok, error}）。
                 * **不含参数正文**：text/line 里可能是用户语音转写或会话内容，
                 * 诊断数据不应变成额外的消息副本。
                 */
                uiActions: [...uiActionLog],
                /**
                 * 系统级全局热键 helper 状态（{enabled, reason, tokenReady}，不含 token）。
                 * helper 起来了吗、为什么没起来，都只能从这里看。
                 */
                hotkeyHelper: hotkeyHelper.state(),
                /** 正在进行的下载。 */
                downloads: [...downloadProgress.entries()].map(([id, progress]) => ({
                  id,
                  received: progress?.received ?? 0,
                  total: progress?.total ?? 0,
                  percent: downloadPercent(progress?.received ?? 0, progress?.total ?? 0),
                })),
              })
            } catch (error) {
              replyRequestError(res, error, false)
            }
          },
        }),
      )

      // --- 全局语音：文本 → 指定会话（客户端调用；直发失败时的备用回退注入）---
      //
      // 调用方：渲染器侧的全局语音浮层。它优先用
      // `ctx.sessions.binding(id).session.prompt()` 直发（与会话里手打消息同路径）；
      // 服务缺失/直发失败时才 POST 到这里。宿主注入顺序：
      //   1) sessionController.prompt（composer 的宿主入口，正常落库、能恢复冷会话）；
      //   2) agents.get(id).followup/steer（文档化的 Agent API，需要 dsh-llm 的 createUserMessage）。
      // 响应：200 {ok:true}；400 {error:{code,message}}（参数问题）；
      //       502 {ok:false, error:{code,message}}（两条注入路径都失败）。
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/voice-prompt',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            // 跨站简单请求防护：这条路由会往会话里注入一条「用户消息」，
            // 必须拒绝 text/plain 等非 JSON 请求（见 isJsonContentType 的说明）。
            if (!isJsonContentType(req)) {
              json(res, 415, {
                error: { code: 'unsupported_media_type', message: '请求必须使用 application/json' },
              })
              return
            }
            let body = null
            try {
              const raw = Buffer.from(await readBody(req, 64 * 1024)).toString('utf8')
              body = JSON.parse(raw || '{}')
            } catch {
              json(res, 400, { error: { code: 'invalid_json', message: '请求体不是合法 JSON' } })
              return
            }
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
            const text = typeof body?.text === 'string' ? body.text.trim() : ''
            // requestId 可选：客户端重试时带同一个值，sessionController 会去重
            //（hasPromptRequest），不会重复发两条。没带就现生成一个。
            const requestId = typeof body?.requestId === 'string' && body.requestId.trim()
              ? body.requestId.trim()
              : randomUUID()
            const mode = normalizeVoicePromptMode(body?.mode, normalizeVoicePromptMode(settings.voicePromptMode))
            // 参数错误要明确告诉客户端哪一项不对，别让它静默丢一句话。
            if (!sessionId) {
              json(res, 400, { error: { code: 'invalid_session', message: 'sessionId 不能为空' } })
              return
            }
            if (sessionId.length > UI_ACTION_LIMITS.sessionId) {
              json(res, 400, {
                error: { code: 'invalid_session', message: `sessionId 不能超过 ${UI_ACTION_LIMITS.sessionId} 字符` },
              })
              return
            }
            // requestId 会落进会话日志的 source.rpcId 并被去重逻辑反复扫描，
            // 必须有长度上限（正常 UUID 36 字符，200 足够）。
            if (requestId.length > MAX_REQUEST_ID_CHARS) {
              json(res, 400, {
                error: { code: 'invalid_requestId', message: `requestId 不能超过 ${MAX_REQUEST_ID_CHARS} 字符` },
              })
              return
            }
            if (!text) {
              json(res, 400, { error: { code: 'invalid_text', message: 'text 不能为空' } })
              return
            }
            if (text.length > MAX_VOICE_PROMPT_CHARS) {
              json(res, 400, {
                error: { code: 'invalid_text', message: `text 不能超过 ${MAX_VOICE_PROMPT_CHARS} 字符` },
              })
              return
            }
            try {
              await injectVoicePrompt({ sessionId, text, requestId, mode })
              stats.voicePrompt += 1
              stats.lastVoicePromptAt = Date.now()
              json(res, 200, { ok: true })
            } catch (error) {
              stats.voicePromptFailures += 1
              stats.lastVoicePromptError = error instanceof Error ? error.message : String(error)
              stats.lastVoicePromptAt = Date.now()
              diagnostics.record(DIAGNOSTICS_GROUPS.VOICE_PROMPT, {
                error: stats.lastVoicePromptError,
                sessionId,
                requestId,
                mode,
              })
              json(res, 502, {
                ok: false,
                error: {
                  code: error && typeof error.code === 'string' && error.code ? error.code : 'inject_failed',
                  message: stats.lastVoicePromptError,
                },
              })
            }
          },
        }),
      )

      // --- UI 动作执行回执（客户端调用：渲染器 → 宿主 voice_ui 工具）---
      //
      // 调用方：渲染器侧的 UI 动作执行器（全局语音浮层组件）。宿主工具 voice_ui
      // 通过 SSE 下发 ui-action 后在这里等回执；找不到 requestId（已超时/已回执）
      // 返回 404，让客户端知道「这条结果没人收了」，而不是静默丢弃。
      // 请求：{requestId, ok, value?, error?} → 200 {ok:true} | 400 | 404。
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/ui-action-result',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            // 同 /voice-prompt：伪造一条回执就能让模型的工具调用「成功」，
            // 必须要求 JSON（跨站简单请求拿不到 application/json）。
            if (!isJsonContentType(req)) {
              json(res, 415, {
                error: { code: 'unsupported_media_type', message: '请求必须使用 application/json' },
              })
              return
            }
            let body = null
            try {
              const raw = Buffer.from(await readBody(req, 64 * 1024)).toString('utf8')
              body = JSON.parse(raw || '{}')
            } catch {
              json(res, 400, { error: { code: 'invalid_json', message: '请求体不是合法 JSON' } })
              return
            }
            const checked = validateUiActionResult(body)
            if (!checked.ok) {
              json(res, 400, { error: { code: checked.error, message: '回执字段不合法' } })
              return
            }
            const pending = pendingUiActions.get(checked.value.requestId)
            if (!pending) {
              json(res, 404, { error: 'unknown requestId' })
              return
            }
            pendingUiActions.delete(checked.value.requestId)
            try { clearTimeout(pending.timer) } catch { /* 忽略 */ }
            pending.resolve(checked.value)
            json(res, 200, { ok: true })
          },
        }),
      )

      // --- UI 动作执行认领（客户端调用：多窗口防重复执行）---
      //
      // 调用方：渲染器侧的 UI 动作执行器。ui-action 是 SSE 全量广播 ——
      // 两个 DSH 窗口各挂一个浮层时都会收到同一个动作。执行前先来认领：
      // 第一个 clientId 拿到 {claimed:true} 才弹确认/执行；其它窗口拿到
      // {claimed:false} 直接静默跳过，不再回执（避免双份 send_prompt）。
      // 未知/已超时/已回执的 requestId → 404（与 /ui-action-result 语义一致）。
      // 请求：{requestId, clientId} → 200 {claimed:true|false} | 400 | 404。
      // 说明：/ui-action-result 仍保持兼容（接受任意回执），但 pending 只处理一次；
      // 客户端接入前这条路由属于「宿主保留、显式标注」的入口（route-contract）。
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/ui-action-claim',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            // 认领会决定「哪个窗口执行动作」—— 同样是副作用入口，只收 JSON。
            if (!isJsonContentType(req)) {
              json(res, 415, {
                error: { code: 'unsupported_media_type', message: '请求必须使用 application/json' },
              })
              return
            }
            let body = null
            try {
              const raw = Buffer.from(await readBody(req, 8 * 1024)).toString('utf8')
              body = JSON.parse(raw || '{}')
            } catch {
              json(res, 400, { error: { code: 'invalid_json', message: '请求体不是合法 JSON' } })
              return
            }
            const requestId = typeof body?.requestId === 'string' ? body.requestId.trim() : ''
            const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : ''
            if (!requestId || requestId.length > MAX_REQUEST_ID_CHARS) {
              json(res, 400, { error: { code: 'invalid_requestId', message: 'requestId 缺失或过长' } })
              return
            }
            if (!clientId || clientId.length > MAX_CLIENT_ID_CHARS) {
              json(res, 400, { error: { code: 'invalid_clientId', message: 'clientId 缺失或过长' } })
              return
            }
            const pending = pendingUiActions.get(requestId)
            if (!pending) {
              json(res, 404, { error: 'unknown requestId' })
              return
            }
            // 第一次认领即锁定；同一 client 重复认领保持幂等（网络重试友好）。
            if (!pending.claimedBy || pending.claimedBy === clientId) {
              pending.claimedBy = clientId
              json(res, 200, { claimed: true })
              return
            }
            json(res, 200, { claimed: false })
          },
        }),
      )

      // --- 系统级全局热键回调（helper-only：客户端不调用）---
      //
      // **唯一调用方是 lib/global-hotkey-helper.js 拉起的额外进程**
      // （PowerShell RegisterHotKey 后 POST 过来）。渲染器侧监听的是同一个
      // `global-hotkey` SSE 事件，不直接 POST 这条路由 —— 所以这条路由属于
      // 「宿主保留、显式标注」的入口（route-contract 需要这个标注）。
      // 鉴权：x-dsh-voice-token 必须是本次启动随机生成的 token（helper 脚本里写死）；
      // 关闭 globalHotkeyHelper 或平台不支持时一律 403（不泄露 token 是否存在）。
      disposers.push(
        scope.webServer.register({
          kind: 'exact',
          path: '/dsh-voice-typing/hotkey',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed' })
              return
            }
            // 与上面两条一致：helper 脚本本来就用 application/json，
            // 这里先卡 Content-Type 再验 token，跨站简单请求根本到不了 token 校验。
            if (!isJsonContentType(req)) {
              json(res, 415, {
                error: { code: 'unsupported_media_type', message: '请求必须使用 application/json' },
              })
              return
            }
            const provided = req.headers?.['x-dsh-voice-token']
            if (
              settings.globalHotkeyHelper !== true
              || !helperSupported()
              || !safeTokenEqual(provided, hotkeyHelper.token)
            ) {
              json(res, 403, { error: 'forbidden' })
              return
            }
            let action = ''
            try {
              const raw = Buffer.from(await readBody(req, 4 * 1024)).toString('utf8')
              const body = JSON.parse(raw || '{}')
              action = body?.action === 'toggle' ? 'toggle' : ''
            } catch {
              /* 空 body 也按非法动作处理 */
            }
            if (!action) {
              json(res, 400, { error: { code: 'invalid_action', message: "action 只能是 'toggle'" } })
              return
            }
            // sessionId 为 null：这是全局事件（信封会写成 sessionId:null）。
            broadcast('global-hotkey', { action })
            json(res, 200, { ok: true })
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
              replyRequestError(res, error, false)
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
              // `error` 那句只给 /diagnostics 与 console；界面读的是 `reason` + `params`
              // （批次 22-4-1，docs §8.70）。以前这里只有中文整句，面板把它原样显示出来。
              json(res, 404, {
                error: 'unknown model: ' + id,
                reason: MODEL_DOWNLOAD_REASONS.UNKNOWN_MODEL,
                params: { model: id },
              })
              return
            }
            // 内置模型（isHostedModel 是唯一权威判定）：零下载，只要本地文件在位即可用。
            if (isHostedModel(model)) {
              const ready = await isModelReady(model)
              if (ready) {
                json(res, 200, { ok: true, alreadyReady: true, host: true })
              } else {
                // `params.model` 用档位 **id** 不用 `model.label`（§8.66 那条裁定：
                // 展示名自己带括号，套进句子括号里读不通）。
                json(res, 409, {
                  error: `宿主内置模型不可用：${model.label}`,
                  reason: MODEL_DOWNLOAD_REASONS.HOSTED_UNAVAILABLE,
                  params: { model: model.id },
                })
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
                // 里外都释放（批次 7）：只清主线程那份 + 名单是不够的 ——
                // 线程里的缓存键只看路径不看文件内容，重下换了文件也必须让它重建。
                // 名单与主线程那一份在 `releaseModelEverywhere` 里**同步**清掉，
                // 下面的 `activeDownloads.delete` 与广播都发生在它之后。
                void releaseModelEverywhere(model.id)
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
                // 广播里三样东西各有读者：`reason` + `params` 给界面出句子（批次 22-4-1），
                // `error` 是宿主那句原文，只给 /diagnostics、console 与装机排查看。
                // 没带码的异常（文件系统错误、宿主自己的代码炸了）由 `modelDownloadReasonOf`
                // 归到 `failed-unknown`，这样客户端永远不需要把 `error` 当文案来显示。
                const failure = modelDownloadReasonOf(error)
                broadcast('model-error', {
                  id: model.id,
                  kind,
                  reason: failure.reason,
                  params: failure.params,
                  error: failure.message,
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
              // 只有显式带 sessionId 的心跳才改 voiceSession：
              // 诊断类上报（如 wake-miss）不带 sessionId，不能把已有会话指针清空。
              if (Object.prototype.hasOwnProperty.call(payload, 'sessionId')) {
                voiceSession = payload.sessionId ? String(payload.sessionId) : null
              }
              // 客户端状态上报：定位「语音对话中无法对话」这类问题用。
              if (payload.client) {
                // 采集路径上报走独立字段（批次 10，任务 #38）：
                // stats.client 装的是 wake-miss / 发送尝试，每条覆盖前一条，
                // 混进来会把那边的现场冲掉 —— 而采集路径恰恰要在失败现场留着。
                if (payload.client.kind === 'capture-path') {
                  stats.capture = {
                    path: String(payload.client.path ?? ''),
                    reason: String(payload.client.reason ?? ''),
                    at: Date.now(),
                  }
                } else {
                  stats.client = {
                    ...payload.client,
                    at: Date.now(),
                  }
                }
                stats.clientCount = (stats.clientCount ?? 0) + 1
                /**
                 * 「听到但没匹配上唤醒词」另外进一个环形缓冲（批次 14，docs §8.56）。
                 *
                 * 为什么 `stats.client` 那份不够：它是**单格覆盖**，
                 * 待机时每句闲聊都把前一句冲掉，于是「喊了不醒」只能看到最后一句，
                 * 攒不出分布。而唤醒方案（折算回拼音 / 音频级 KWS / 零代码缓解）的
                 * 判据要的正是分布 —— 「这些错法里有多少其实听起来就是唤醒词」。
                 * 只认 `via === 'wake-miss'`：发送尝试、no_session、心跳、采集路径都不进这个组。
                 */
                if (payload.client.via === 'wake-miss') {
                  diagnostics.record(DIAGNOSTICS_GROUPS.WAKE_MISS, {
                    // 客户端已经截到 60 字，这里再兜一层：别的调用方不许把整段对话搬进诊断面。
                    text: String(payload.client.text ?? '').slice(0, WAKE_MISS_TEXT_LIMIT),
                    // 唤醒词取**宿主当前配置的这一份**，不认客户端自报的 wake：
                    // 判据要比的是「在那套配置下该不该命中」，而配置以宿主为准（面板写的就是这里）。
                    wake: String(settings.wakeWord ?? '').trim(),
                  })
                  stats.wakeMissCount += 1
                }
              }
              json(res, 200, { ok: true, voiceSession })
            } catch (error) {
              replyRequestError(res, error, false)
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
              // 审计 D4）。与 /asr-ready 的 `model-not-found` 那条原因码语义一致。
              const model = findModel(settings.model)
              if (!model) {
                json(res, 400, {
                  ok: false,
                  error: '未知识别档位：' + String(settings.model),
                  // `reason` 这个字段在本仓库统一是**原因码**（批次 18/19/20）；
                  // 这句原文搬到 `detail`。这条 400 目前没人在界面上读它，
                  // 改成码是为了不让「reason 里可以写句子」这个例外留着。
                  errors: [{
                    key: 'model',
                    reason: ASR_READY_REASONS.MODEL_NOT_FOUND,
                    detail: '未知识别档位：' + String(settings.model),
                  }],
                })
                return
              }
              if (!(await isModelReady(model))) {
                json(res, 409, { error: '模型尚未就绪：' + model.id })
                return
              }
              // 语言提示真正传给识别器（SenseVoice 的 language / Whisper 的 language）。
              //
              // 允许调用方（全局语音待机）用 `x-dsh-voice-language` 头覆盖本次识别语言：
              // 短唤醒词（如「小鱼」）在 auto 下容易被判成英文（实测被识别成「I.」），
              // 待机唤醒永远匹配不上。只接受白名单值；**非法值退回当前生效语言**
              //（不是退回 auto —— 那等于绕一圈又回到要修的 bug）。
              const language = resolveRequestLanguage(req.headers?.['x-dsh-voice-language'], currentLanguage())
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
              // 超限（413）必须回执；只有「客户端走了」才允许不回话（见 replyRequestError）。
              replyRequestError(res, error, controller.signal.aborted)
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
              // 静音片段不喂给解码器：否则流式模型会对着噪声凭空造字。              // 门限随该流的底噪浮动，底噪高的环境里不会一直喂噪声。
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
              // 同样走那一处带上限的实现（src/host/decode-steps.js，批次 6k）。
              decodeOnlineStream(state.recognizer, state.stream, (r, s) => decode.call(r, s))
              const text = String(state.recognizer.getResult(state.stream).text ?? '').trim()
              state.lastActiveAt = Date.now()
              if (text) stats.streamNonEmpty += 1
              json(res, 200, { text, model: state.modelId, speech: true })
            } catch (error) {
              // 只有「解码这一侧真出事了」才丢掉这个会话的流状态，下一轮从零开始（不留残留）。
              // 请求级拒绝（超限 413）跟会话状态**无关**：它是一块数据太大，不是流坏了。
              // 以前这里是无条件丢弃，于是一块过大的分片会抹掉正在跑的会话 ——
              // 用户看到的是实时文字整段消失（在线流对象被 free、状态条目被删，下一帧从零重建）。
              // 真走了请求级拒绝这条路也不用担心残留：空闲清理（`startStreamSweeper`，60 秒）会兜住。
              // 批次 12，docs/architecture-modernization.md §8.53。
              if (!isRequestRejection(error)) {
                discardStreamingState(sessionId, STREAM_DISCARD_REASONS.DECODE_ERROR)
              }
              // 超限（413）必须回执；只有「客户端走了」才允许不回话（见 replyRequestError）。
              replyRequestError(res, error, req.aborted || res.writableEnded)
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
              discardStreamingState(sessionId, STREAM_DISCARD_REASONS.CLIENT_RESET)
              // discarded 恒为 true：调用之后该会话一定没有任何流式残留。
              json(res, 200, { text, discarded: true, model: state?.modelId ?? STREAM_MODEL_ID })
            } catch (error) {
              replyRequestError(res, error, false)
            }
          },
        }),
      )

      // --- 识别模型就绪状态 ---
      //
      // 客户端在进入「聆听中」之前要先问一句「模型好了吗」。
      //
      // 为什么必须问：首次加载要多久没有可靠上界（装机实测 tiny 0.4 秒、SenseVoice 约 1 秒）。
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
                json(res, 200, { ready: false, model: settings.model, reason: ASR_READY_REASONS.MODEL_NOT_FOUND })
                return
              }
              const downloaded = await isModelReady(model)
              const loaded = asrLoadedModels.has(model.id) || recognizers.has(model.id)
              json(res, 200, {
                ready: downloaded && loaded,
                downloaded,
                loaded,
                model: model.id,
                // 报的是**码**，不是句子（批次 18，docs §8.60）：宿主说「哪一步没通」这件事实，
                // 界面那句话由客户端的 i18n 按当前语言决定。
                reason: !downloaded
                  ? ASR_READY_REASONS.NOT_DOWNLOADED
                  : !loaded
                    ? ASR_READY_REASONS.LOADING
                    : '',
              })
            } catch (error) {
              replyRequestError(res, error, false)
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
                json(res, 200, { ready: false, reason: ASR_READY_REASONS.MODEL_NOT_FOUND })
                return
              }
              if (!(await isModelReady(model))) {
                json(res, 200, { ready: false, reason: ASR_READY_REASONS.NOT_DOWNLOADED })
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
                // 语言必须和真正识别时用的**同一个值**：worker 的缓存键是
                // `model|encoder|language`，而 /transcribe 用的是 `currentLanguage()`
                // （配置写 auto 会被解析成系统语言，例如 'zh'）。
                // 这里过去写的是 `resolveLanguage(settings.language)`，配置写 auto 就原样传了 'auto'：
                // 键对不上 → 预热的那份识别器永远用不到（模型加载两遍、开麦后第一次识别照样干等几十秒），
                // 空闲释放也按 `currentLanguage()` 算键，那份 'auto' 的副本还一直漏在内存里。
                // 判据：`test/worker-protocol.test.mjs` 的「预热后的首次 /transcribe 复用预热好的那份识别器」。
                language: currentLanguage(),
              })
              if (ok) markModelUsed(model.id)
              json(res, 200, { ready: ok, model: model.id, reason: ok ? '' : ASR_READY_REASONS.LOAD_FAILED })
            } catch (error) {
              replyRequestError(res, error, false)
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
              // **没有 `label`**：行名由客户端按 `id` 查字典（批次 22-3-2，§8.67）；
              // `url` 是用户自己填的地址，属于数据不是文案，界面原样显示。
              env.engines = [
                ...(Array.isArray(env.engines) ? env.engines : []),
                {
                  id: 'sovits',
                  supported: true,
                  configured: normalizedEngine === 'sovits',
                  url: settings.sovitsUrl,
                },
              ]
              json(res, 200, env)
            } catch (error) {
              replyRequestError(res, error, false)
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
                  // 这句「应为 … 之一」以前是把 spec 里的允许值在宿主侧手抄成句子；
                  // 现在报码，允许值由客户端按同一个 key 去 `config-spec.js` 取（同一条规则只有一份）。
                  errors: [{
                    key: 'ttsEngine',
                    reason: CONFIG_ERROR_REASONS.NOT_IN_ENUM,
                    detail: `应为 ${TTS_ENGINES.join(' / ')} 之一`,
                  }],
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
              replyRequestError(res, error, false)
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
                    reason: CONFIG_ERROR_REASONS.NOT_IN_ENUM,
                    detail: engineWarning?.reason ?? `应为 ${TTS_ENGINES.join(' / ')} 之一`,
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
                  diagnostics.record(DIAGNOSTICS_GROUPS.NEURAL_TTS, {
                    error: stats.lastNeuralTtsError,
                    engine: 'neural',
                  })
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
                  diagnostics.record(DIAGNOSTICS_GROUPS.LOCAL_TTS, {
                    error: stats.lastLocalTtsError,
                    engine: 'local',
                    fallback: 'online',
                  })
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
                  diagnostics.record(DIAGNOSTICS_GROUPS.SOVITS_TTS, {
                    error: stats.lastSovitsTtsError,
                    engine: 'sovits',
                  })
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
                  diagnostics.record(DIAGNOSTICS_GROUPS.ONLINE_TTS, {
                    error: stats.lastOnlineTtsError,
                    engine: 'online',
                    fallback: isLocalSupported() ? 'local' : 'none',
                  })
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
                      diagnostics.record(DIAGNOSTICS_GROUPS.LOCAL_TTS, {
                        error: stats.lastLocalTtsError,
                        engine: 'local',
                        fallback: 'failed',
                        originalError: stats.lastOnlineTtsError,
                      })
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
              replyRequestError(res, error, false)
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
        // 释放常驻的识别器（模型常驻在内存里，不释放会一直占着几百 MB）。
        // 批次 7 场景 B 的裁定：**释放识别器、保留线程** ——
        // 重载后线程还活着，下次 /asr-warmup 只需重新加载模型（本机实测 SenseVoice 228 MB 约 1 秒），
        // 既不重起线程，也不会把在途识别请求一起拆掉。见 docs §8.47。
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
        // 停掉系统级热键 helper 子进程并删除临时脚本：
        // 不清理的话每次重载都会多留一个等待热键的 powershell。
        try {
          hotkeyHelper.dispose()
        } catch {
          /* 忽略 */
        }
        // 插件卸载/热重载：把还在等回执的 voice_ui 工具调用立刻收尾。
        // 不清理的话每个在途调用会把事件循环多钉 20 秒，工具 Promise 悬空；
        // resolve 成 ui_timeout 让模型这一轮正常结束（与真正超时同一错误码）。
        for (const [requestId, pending] of [...pendingUiActions]) {
          pendingUiActions.delete(requestId)
          try { clearTimeout(pending.timer) } catch { /* 忽略 */ }
          try { pending.resolve({ ok: false, error: 'ui_timeout' }) } catch { /* 忽略 */ }
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
