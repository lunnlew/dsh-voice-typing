/**
 * 「朗读环境自检」这条链路上的原因码 —— 宿主与浏览器侧共用的**单源**词表（批次 22-3-2，docs §8.67）。
 *
 * 为什么需要这一份：宿主的 `/tts/env` 以前在每一行引擎结果里直接写中文句子
 * （`可用（Windows PowerShell 5.1），默认发音人：…`、`找不到可用的 powershell（…）`、
 * `模型还没下载（…）`、`连不上：${error.message}`），客户端拿到就原样拼进设置面板
 * （`formatEnvEngines` → 面板那行 `${e.label}：${e.detail}`）。
 * 于是**英文界面上那几行是中文**，而且是宿主写的中文 —— 宿主管不着界面语言，
 * 客户端又没法覆盖已经给出的句子。这和批次 18（开麦就绪）、19（系统级热键）、20（配置校验）
 * 是同一个形状，只是说话的人换成了 `src/host/tts-env.js`。
 *
 * 分工照那一族的定法：**宿主只报码**（「哪一步没通」这件事实）+ 结构化参数，
 * **句子由客户端的 i18n 字典出**。宿主原来那句原文仍留在 `detail` 里，
 * 但那个字段的读者是 `/diagnostics` 与装机排查，**不是界面**。
 *
 * 码表放 `src/shared`：它同时被 `src/host/tts-env.js`（发码）和
 * `src/client/pure/tts-env-reason-text.js`（查句子）import —— 一次拼错会在两端之一红掉，
 * 而不是变成装机上一条永远走不到的分支。
 *
 * 环境约束（`src/shared/*` 的共同规矩，由 `test/bundle-sync.test.mjs` 机械守卫）：
 *   纯 ESM、零浏览器全局、零 Node API、零 React。
 *
 * **不在这里的东西**：
 *   - 每个码的中英句子与参数名 —— 表现层，住在 `src/client/pure/i18n.js`；
 *   - `engines[].note` / `noteEn` —— 客户端一个字都没渲染（只在 `/diagnostics` 里看），
 *     按「这句话会不会进界面」那条判据（§8.65）不在本族范围内；
 *   - sovits 那一行的 `url` —— 那是用户自己填的地址（数据不是文案），原样显示，见 `formatEnvEngines`。
 */

/**
 * 十四个码，按三个引擎分组。顺序不是契约，命名才是。
 *
 * 命名规矩沿用批次 18/19/20：`<引擎>-<哪一步>-<通不通>`，读码就知道去哪一段代码。
 * 每组都**分「可用」与「不可用」两套码**，不是只报失败 —— 这行界面本来就在报「能不能用」，
 * 成功那句同样有内容（哪个 shell、哪个音色、几个可用音色），把成功压成一个布尔就丢信息。
 */
export const TTS_ENV_REASONS = Object.freeze({
  // —— 本地系统语音（Windows PowerShell / macOS say / Linux espeak）——
  LOCAL_READY_POWERSHELL: 'local-ready-powershell',
  LOCAL_MISSING_POWERSHELL: 'local-missing-powershell',
  LOCAL_READY_SAY: 'local-ready-say',
  LOCAL_MISSING_SAY: 'local-missing-say',
  LOCAL_READY_ESPEAK: 'local-ready-espeak',
  LOCAL_MISSING_ESPEAK: 'local-missing-espeak',
  LOCAL_PLATFORM_UNSUPPORTED: 'local-platform-unsupported',
  // —— Edge 在线 ——
  ONLINE_READY: 'online-ready',
  ONLINE_NO_VOICES: 'online-no-voices',
  ONLINE_UNREACHABLE: 'online-unreachable',
  // —— 本地神经模型 ——
  NEURAL_NO_TIER: 'neural-no-tier',
  NEURAL_MISSING_RUNTIME: 'neural-missing-runtime',
  NEURAL_MODEL_MISSING: 'neural-model-missing',
  NEURAL_READY: 'neural-ready',
})

/** 上面那张表的值集合（判据用它比对宿主真正回出来的 `reason`）。 */
export const TTS_ENV_REASON_VALUES = Object.freeze(Object.values(TTS_ENV_REASONS))

/**
 * 这个码是不是词表里的？（宿主与客户端都用它，别各自写 `in` 判断。）
 * @param {unknown} reason - 待检查的值（允许 undefined / 非字符串，一律当「不认识」）。
 * @returns {boolean}
 */
export function isTtsEnvReason(reason) {
  return typeof reason === 'string' && TTS_ENV_REASON_VALUES.includes(reason)
}

/**
 * 每个码**必须**带的参数名（批次 20 的 `CONFIG_ERROR_PARAM_NAMES` 同一族规矩）。
 *
 * 为什么这张表值得存在：宿主少填一个参数，客户端那句子里就有一个没被填掉的 `{version}`
 * 直接显示给用户。判据拿这张表逐码核对「宿主现场收集到的参数名正好是这些」，
 * 于是「宿主多一个码忘了填参数」在测试里红，不在装机上红。
 *
 * 参数值是**契约值或机器事实**（版本号、平台名、档位 id、音色短名、运行时种类、数量），
 * 客户端按原样填进句子；`{model}` 用档位 id 而不是展示名，理由写在 §8.66 那条裁定里
 * （那句本来就在括号里，展示名自己也带括号会变成套括号）。
 */
export const TTS_ENV_REASON_PARAMS = Object.freeze({
  [TTS_ENV_REASONS.LOCAL_READY_POWERSHELL]: Object.freeze(['version', 'voice']),
  [TTS_ENV_REASONS.LOCAL_MISSING_POWERSHELL]: Object.freeze([]),
  [TTS_ENV_REASONS.LOCAL_READY_SAY]: Object.freeze(['voice']),
  [TTS_ENV_REASONS.LOCAL_MISSING_SAY]: Object.freeze([]),
  [TTS_ENV_REASONS.LOCAL_READY_ESPEAK]: Object.freeze(['bin']),
  [TTS_ENV_REASONS.LOCAL_MISSING_ESPEAK]: Object.freeze([]),
  [TTS_ENV_REASONS.LOCAL_PLATFORM_UNSUPPORTED]: Object.freeze(['platform']),
  [TTS_ENV_REASONS.ONLINE_READY]: Object.freeze(['count']),
  [TTS_ENV_REASONS.ONLINE_NO_VOICES]: Object.freeze([]),
  [TTS_ENV_REASONS.ONLINE_UNREACHABLE]: Object.freeze([]),
  [TTS_ENV_REASONS.NEURAL_NO_TIER]: Object.freeze([]),
  [TTS_ENV_REASONS.NEURAL_MISSING_RUNTIME]: Object.freeze([]),
  [TTS_ENV_REASONS.NEURAL_MODEL_MISSING]: Object.freeze(['model']),
  [TTS_ENV_REASONS.NEURAL_READY]: Object.freeze(['model', 'runtime']),
})
