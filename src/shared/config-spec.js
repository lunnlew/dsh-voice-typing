/**
 * 配置字段规则 + 默认值 —— **单源**（宿主校验与浏览器侧 UI 共用同一份）。
 *
 * 为什么只有一份：
 *   加一个配置项原本要改**四处**：宿主 `lib/index.js` 的 `DEFAULTS`、
 *   宿主 `lib/config-schema.js` 的 `SPECS`、客户端 `pure/config-normalize.js`
 *   的 `UI_DEFAULTS`，以及（字符串项）客户端的 `STRING_LIMITS`。
 *   四处靠 `test/config-contract.test.mjs` 逐项横断言「碰巧写对了」，
 *   漂移过的真实代价：客户端没收 `sovitsUrl` 的长度上限，粘贴超长地址原样 POST，
 *   被宿主严格校验打回 400，界面只显示「保存失败」。
 *
 *   现在一个键的**完整描述**（类型 / 枚举 / 范围 / 长度上限 / 默认值）只在这里写一次：
 *     - 宿主 `lib/config-schema.js` 拿它做校验与清洗；
 *     - 宿主 `lib/index.js` 的 `DEFAULTS` 是 `CONFIG_DEFAULTS` 的别名；
 *     - 客户端 `UI_DEFAULTS` 是同一个对象，`STRING_LIMITS` 与各夹取区间由这里派生。
 *   所以加一个配置项 = 改这一处 + 设置面板那一行（表现层，本来就该各写各的）。
 *
 * 环境约束（`src/shared/*` 的共同规矩，由 `test/bundle-sync.test.mjs` 机械守卫）：
 *   纯 ESM、零浏览器全局、零 Node API、零 React。
 *
 * **不在这里的东西**：
 *   - 浏览器侧表现层：语速/音调/音量与空闲释放的**档位列表**、错误文案的中文键名、
 *     保存前的形状收窄（`RATE_PATTERN` 等）—— 那些是 UI 的选择，宿主 schema 没有对应物；
 *   - 两侧需要不同常数的门限（`src/shared/gate.js` 用 `createGate(defaults)` 注入）。
 *
 * 冻结说明：`CONFIG_SPECS`、每个 spec 条目、`CONFIG_DEFAULTS` **以及里面的默认数组**
 * 都冻结了。原因是两端都只是浅拷贝（`{ ...DEFAULTS }`、`{ ...UI_DEFAULTS, ...cfg }`），
 * 谁就地改一次 `words`，另一端的默认值也跟着变 —— 单源最怕的就是这种「改一处影响两端」。
 * 全仓库对 `.words` 没有 push/splice/sort（本轮 grep 过），所以冻结不改变任何现有行为；
 * 将来真要改默认词表，应该显式新建数组，而不是动这份共享的默认值。
 */

import {
  TTS_ENGINES,
  ASR_LANGUAGES,
  SOVITS_LANGUAGES,
  LIVE_ASR_MODES,
  INTERACTION_MODES,
  VOICE_PROMPT_MODES,
  TTS_FORMATS,
} from './config-vocab.js'

/** 默认 GPT-SoVITS 服务地址（官方 api_v2 默认绑定 127.0.0.1:9880）。 */
export const DEFAULT_SOVITS_URL = 'http://127.0.0.1:9880'

/**
 * 每个配置键的完整描述。
 *
 * 字段含义：
 *   - `type`    ：`enum` | `boolean` | `number` | `string` | `url` | `words`；
 *   - `values`  ：`enum` 的合法取值（来自 `config-vocab.js`，两端同一个数组对象）；
 *   - `min`/`max`：数值区间（**宿主与客户端夹取用的是同一对数字**，不在客户端另写一遍）；
 *   - `integer` ：是否取整（宿主清洗时四舍五入，客户端夹取时同样取整）；
 *   - `maxLen`  ：字符串/URL 的字符上限（客户端保存前按它截断，避免 400）；
 *   - `def`     ：默认值 —— 宿主 `DEFAULTS` 与客户端 `UI_DEFAULTS` 都由这一项派生。
 *
 * 类型语义：
 *   - `number`：POST 时允许安全强转「数字字符串」（`'15'`）；
 *   - `string`：trim 后受 `maxLen` 限制；空串合法 = 清空；
 *   - `url`   ：http(s) URL 或空串（空串 = 用默认地址）；
 *   - `words` ：词表数组（`string` 或 `{correct, replace}`，统一归一化成字符串形式）。
 */
export const CONFIG_SPECS = Object.freeze({
  /** 识别模型档位。 */
  model: { type: 'string', maxLen: 64, def: 'sensevoice' },
  /** 识别语言提示（`auto` = 由模型判断）。 */
  language: { type: 'enum', values: ASR_LANGUAGES, def: 'auto' },
  /**
   * 「边说边出字」的实时字方式：
   *   - `full`  ：每 900ms 把当前整段音频重新识别一遍（默认）。精度最好（与最终稿同源），
   *              但段越长越慢 —— 复杂度 O(n²)。
   *   - `stream`：用流式模型（zipformer2）边喂边解码，只喂新增音频。延迟低、长段不变慢，
   *              但精度略低于整段重识别。
   *   - `auto`  ：当前模型是流式模型就用流式，否则用整段重识别。
   * 最终稿（断句后的那次识别）**始终**走当前模型，不受这个选项影响。
   */
  liveAsr: { type: 'enum', values: LIVE_ASR_MODES, def: 'full' },
  /**
   * TTS 引擎：
   *   - `online`：Edge 在线朗读，音质最好，但需要联网；
   *   - `local` ：跨平台系统语音（SAPI / say / espeak-ng），完全离线，失败自动回退在线；
   *   - `neural`：本地神经模型（sherpa-onnx VITS），离线且音质接近在线；
   *   - `sovits`：外部 GPT-SoVITS 服务，失败**不**回退（用户要的是自己的声音/隐私，
   *              绝不能偷偷发给微软）。
   */
  ttsEngine: { type: 'enum', values: TTS_ENGINES, def: 'online' },
  /** Edge TTS 音色（`ttsEngine=online` 时使用）。 */
  voice: { type: 'string', maxLen: 200, def: 'zh-CN-XiaoxiaoNeural' },
  /**
   * 本地合成发音人名（`ttsEngine=local` 时使用）。
   * **不能写死 Windows 的 SAPI 语音名**：macOS/Linux 上这个值不存在，
   * 会让「本地系统语音」必然失败并静默回退到在线（用户以为离线，其实联网）。
   * 留空表示用平台默认发音人。
   */
  localVoice: { type: 'string', maxLen: 200, def: '' },
  /** 本地神经模型档位（`ttsEngine=neural` 时使用）。 */
  neuralModel: { type: 'string', maxLen: 64, def: 'vits-melo-zh_en' },
  /**
   * 神经模型的说话人 id。
   * 上限取 1000 而不是「很大」：设置面板只会从模型自带的 speakers 里选，
   * 真实档位的 speaker 数都远小于 1000；放宽到 10000 会让 `neuralSpeaker: 9999`
   * 这种明显越界的值通过校验、到合成期才每句 500。
   */
  neuralSpeaker: { type: 'number', min: 0, max: 1000, integer: true, def: 0 },
  /**
   * 外部 GPT-SoVITS 服务地址（`ttsEngine=sovits` 时使用）。
   *
   * 插件**不内置** GPT-SoVITS、也不做声音克隆：用户自己把 `api_v2.py` 跑起来
   * （默认 127.0.0.1:9880），并把服务端可访问的参考音频路径/文本/语言填在配置里；
   * 插件只负责把每句文本 POST 到 `/tts`。详见 `lib/sovits-tts.js` 顶部注释。
   * 空串 = 用 `DEFAULT_SOVITS_URL`。
   */
  sovitsUrl: { type: 'url', maxLen: 2048, def: DEFAULT_SOVITS_URL },
  /** 服务端参考音频路径（必须是 GPT-SoVITS 所在机器上可访问的路径）。 */
  sovitsRefAudio: { type: 'string', maxLen: 1024, def: '' },
  /** 参考音频对应的文本（可选；官方 api_v2 里为空也能用，但匹配时音质更好）。 */
  sovitsPromptText: { type: 'string', maxLen: 500, def: '' },
  /** 合成文本的语言（zh / en / ja / ko / yue，GPT-SoVITS 官方支持集，没有 auto）。 */
  sovitsTextLang: { type: 'enum', values: SOVITS_LANGUAGES, def: 'zh' },
  /** 参考音频文本的语言（同上）。 */
  sovitsPromptLang: { type: 'enum', values: SOVITS_LANGUAGES, def: 'zh' },
  /**
   * 语速（四种引擎都支持）。
   * online 用 SSML 百分比写法，local 换算成 SAPI/say/espeak 的档位，
   * neural 换算成倍率（100% = 1 倍速）。宿主只校验形状与长度，具体档位由 UI 给。
   */
  rate: { type: 'string', maxLen: 16, def: '+10%' },
  /** Edge TTS 音调（如 `+0Hz`、`-5Hz`）。只有 online 引擎支持。 */
  pitch: { type: 'string', maxLen: 16, def: '+0Hz' },
  /** 音量（如 `+0%`、`-20%`）。online 与 local 支持，neural 不支持。 */
  volume: { type: 'string', maxLen: 16, def: '+0%' },
  /**
   * 音频输出格式，直接对应 msedge-tts 的 OUTPUT_FORMAT 键。
   * 只有 online 引擎用得上。上游那份包有三个键（两个 MP3 加一个 WEBM/Opus），
   * 词表只收 MP3 的两个 —— 本仓库的朗读链路是按 MP3 建的，第三个键没有对应验证过。
   * 传进去的键真包不认时会**静默回落**到 24k/48k（`edge-tts.js` 里那一条 `??`），
   * 所以这里必须是枚举，不能是自由字符串 —— 「词表里的键真包认不认识」由
   * `test/edge-tts.test.mjs` 的「真装的 msedge-tts」那一段逐个判，不靠这段注释。
   */
  ttsFormat: { type: 'enum', values: TTS_FORMATS, def: 'AUDIO_24KHZ_48KBITRATE_MONO_MP3' },
  /** 识别后是否自动发送。 */
  autoSend: { type: 'boolean', def: true },
  /** 是否朗读回复。 */
  readAloud: { type: 'boolean', def: false },
  /**
   * 「朗读追赶最新」的积压上限（秒）。
   *
   * 生成远快于朗读时，坚持全部朗读会越读越滞后（听到几分钟前的内容）。
   * 待朗读音频时长超过这个值，就**整段**跳到最新几段（保留最新 3 段；不会从段落中间跳）。
   * 默认 7.5 秒（= 原 15 秒的一半，用户要求更激进）。0 = 关闭追赶，全部朗读。
   */
  readAloudLag: { type: 'number', min: 0, max: 120, def: 7.5 },
  /** 交互模式：`toggle` 连续对话（默认）/ `once` 说完就关。 */
  mode: { type: 'enum', values: INTERACTION_MODES, def: 'toggle' },
  /** 静音断句时长（毫秒）。 */
  silenceMs: { type: 'number', min: 500, max: 5000, def: 1500 },
  /** 断句后再等多久才发送（毫秒），用于合并短句。 */
  autoSendExtraMs: { type: 'number', min: 0, max: 5000, def: 1200 },
  /** 是否清理语气词。 */
  removeFillers: { type: 'boolean', def: false },
  /** 自定义词表（字符串数组，或 `{correct, replace}` 对象数组；上限见 config-vocab）。 */
  words: { type: 'words', def: [] },
  /** 全局热键：按一下切换语音模式（等同点麦克风按钮），不是按住说话。 */
  shortcut: { type: 'string', maxLen: 64, def: 'Alt+V' },
  /**
   * 空闲多少分钟后自动释放已加载的模型。
   * 0 表示永不释放（模型一直占着内存）。宿主允许 0..1440 任意整数，UI 只列常用档位。
   */
  idleReleaseMinutes: { type: 'number', min: 0, max: 1440, integer: true, def: 10 },
  /**
   * 是否在启用模型后立即预加载。
   * 好处：第一次说话不用等模型加载（zipformer2 要 40 秒）。
   */
  preloadModels: { type: 'boolean', def: true },
  /**
   * 全局语音浮层（任意页面常驻的麦克风/字幕小窗）。
   * 默认关：它会常驻监听入口并占用麦克风，必须是用户显式打开的开关。
   */
  globalVoice: { type: 'boolean', def: false },
  /**
   * 全局语音切换快捷键（窗口内生效；系统级热键 helper 也用它注册）。
   * 与 `shortcut` 分开：composer 的 Alt+V 只在输入框上下文有意义，
   * 全局模式要在设置页/插件页也能按。上限 64 与 `shortcut` 一致。
   */
  globalShortcut: { type: 'string', maxLen: 64, def: 'Ctrl+Alt+V' },
  /** 语音文本注入方式：`queue` 下一轮 / `steer` 当前轮下一步（助手忙时用）。 */
  voicePromptMode: { type: 'enum', values: VOICE_PROMPT_MODES, def: 'queue' },
  /**
   * 允许模型通过 `voice_ui` 工具操控界面。
   * 默认关：这是「AI 能操作你的界面」的总开关，不能默认替用户打开；
   * 关闭时工具仍可见但 execute 直接返回未启用错误，不广播任何动作。
   */
  uiControl: { type: 'boolean', def: false },
  /** 危险 UI 动作（切会话/新建/执行命令/发消息/中止生成）是否要用户确认。 */
  uiConfirm: { type: 'boolean', def: true },
  /** 是否拉起系统级全局热键 helper（额外进程，仅 Windows）。 */
  globalHotkeyHelper: { type: 'boolean', def: false },
  /**
   * 全局语音待机唤醒词（默认「小鱼」）：浮层麦克风常开待机，
   * 只有说到唤醒词才开始接收命令，避免把环境里的闲聊发进会话。
   * **空串 = 关闭唤醒词**，回到「说话直接发」的行为。
   * 上限 32：设置面板只收一个短语，真实唤醒词通常 2~4 个字；放宽上限没有意义，
   * 还会让匹配逻辑更慢、更易误唤醒。
   */
  wakeWord: { type: 'string', maxLen: 32, def: '小鱼' },
})

/** schema 覆盖的全部键（顺序与 `CONFIG_SPECS` 一致）。 */
export const CONFIG_SPEC_KEYS = Object.freeze(Object.keys(CONFIG_SPECS))

/** 默认配置（由每个键的 `def` 派生；宿主 `DEFAULTS` 与客户端 `UI_DEFAULTS` 都是它）。 */
export const CONFIG_DEFAULTS = Object.freeze(
  Object.fromEntries(CONFIG_SPEC_KEYS.map((key) => [key, CONFIG_SPECS[key].def])),
)

for (const spec of Object.values(CONFIG_SPECS)) Object.freeze(spec)
// 默认值是数组的（`words`）连数组一起冻结：两端都是浅拷贝，共享的是**同一个数组引用**，
// 一次就地 push 就会同时改掉宿主的默认词表和客户端的默认词表。
for (const spec of Object.values(CONFIG_SPECS)) {
  if (Array.isArray(spec.def)) Object.freeze(spec.def)
}

/**
 * 取某个键的描述。未知键返回 `null`（调用方决定忽略还是报错，不要在这里猜）。
 *
 * @param {unknown} key - 配置键名。
 * @returns {object|null} 只读描述对象。
 */
export function specFor(key) {
  return Object.prototype.hasOwnProperty.call(CONFIG_SPECS, key) ? CONFIG_SPECS[key] : null
}

/**
 * 带 `maxLen` 的键 → 长度上限。
 *
 * 客户端的 `STRING_LIMITS` 由它派生，这样「宿主改了 maxLen、客户端还在截老长度」
 * 这一类漂移不可能再发生。注意它包含 rate/pitch/volume（16）——
 * 客户端对那三项另有 `CHOICE_STRING_MAX_LEN`（形状收窄，属 UI 表现层），
 * 按键取值时各用自己的那套，互不影响。
 */
export const CONFIG_MAX_LENS = Object.freeze(Object.fromEntries(
  CONFIG_SPEC_KEYS.filter((key) => typeof CONFIG_SPECS[key].maxLen === 'number')
    .map((key) => [key, CONFIG_SPECS[key].maxLen]),
))

/**
 * 数值键的夹取区间。
 *
 * 客户端的 `clampSilenceMs` / `clampAutoSendExtraMs` / `clampReadAloudLag` 等
 * 原本把 500/5000、0/5000、0/120 **写死在函数体里**，现在统一走这里。
 * 返回新对象而不是 spec 本身：调用方只需要两个端点，
 * 拿到 spec 会诱导有人顺手读 `integer`/`def`。
 * `integer` **故意不派生**：客户端输入框一律取整（滑杆/数字框给不出 1500.4 毫秒），
 * 而宿主允许小数（`readAloudLag: 7.5` 就是合法值）——
 * 那是各侧的输入行为，不是同一判据的两份副本。
 *
 * @param {unknown} key - 配置键名。
 * @returns {{min:number, max:number}|null} 数值键的区间；非数值键与未知键返回 null。
 */
export function rangeFor(key) {
  const spec = specFor(key)
  if (!spec || spec.type !== 'number') return null
  return { min: spec.min, max: spec.max }
}
