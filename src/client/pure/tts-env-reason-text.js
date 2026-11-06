/**
 * 「朗读环境自检」那几行的原因码 → 界面文案（纯函数，不碰浏览器全局）。
 *
 * 为什么要单独一个模块（批次 22-3-2，docs/architecture-modernization.md §8.67）：
 *   宿主的 `/tts/env` 现在每行引擎只回**原因码 + 参数**（`src/shared/tts-env-reasons.js`），
 *   界面那句话由这里的映射给出。改前这条链路是 `${e.label}：${e.detail}` ——
 *   `label` 与 `detail` 都是 `src/host/tts-env.js` 里手写的中文，
 *   于是英文界面上「运行环境自检」那四行（Edge 在线 / 本地系统语音 / 本地神经模型 / GPT-SoVITS）
 *   整片是宿主写的中文。这和批次 18（开麦就绪）、19（系统级热键）、20（配置校验）同一个形状。
 *
 *   引擎行名同理：`ENV_ENGINE_LABEL_KEYS` 按 `id` 出行名，宿主的 `label` 客户端不再读
 *   （它只留在 `/diagnostics` 与宿主自己的返回值里），这样「同一个引擎有两个展示名」
 *   这件事从源头就没了。
 *
 * 映射表住在这里而不是 `voice-settings-section.js`，是因为它需要被单测直接驱动：
 *   词表里每个码都要有对应键（漏一个就是装机上一句生硬的兜底文案），
 *   而词表外的值（宿主版本不一致、脏数据、旧产物）必须走兜底而不是原样显示出来。
 *
 * **参数为什么由宿主给、句子为什么在这边**：
 *   参数全是契约值或机器事实（版本号、平台名、档位 id、音色短名、运行时种类、数量），
 *   不是话；「哪一步没通」这句话才是表现层。`{model}` 填档位 **id** 而不是展示名
 *   （§8.66 那条裁定：展示名自己带括号，套进括号里读不通），
 *   `{runtime}` 填 `native` / `wasm` 这个契约值，由 `envRuntimeLabel` 再翻一次。
 *
 * 环境约束（`src/client/pure/*` 的共同规矩）：不依赖浏览器全局、不依赖 React，Node 里可原生 import。
 */
import { isTtsEnvReason, TTS_ENV_REASON_PARAMS } from '../../shared/tts-env-reasons.js'
import { envRuntimeLabel } from './i18n.js'

/**
 * 原因码 → i18n 键。命名跟着 `envReason*` 走，和 `MODEL_LABEL_KEYS` / `VOICE_LABEL_KEYS` 同一族。
 *
 * 每个码一句，**没有合并**：这一族的码连「成功」都分了三套（PowerShell / say / espeak），
 * 因为它们要填的参数不一样、要人做的事也不一样（后者是「这台机器缺什么」）。
 * 合并的代价是英文界面上一句读不通的通用话，收益只有少几个键 —— 与批次 19/20 那种
 * 「界面上要做的动作一样才合并」不同，这里四句动作各不同。
 */
export const TTS_ENV_REASON_KEYS = Object.freeze({
  'local-ready-powershell': 'envReasonLocalReadyPowershell',
  'local-missing-powershell': 'envReasonLocalMissingPowershell',
  'local-ready-say': 'envReasonLocalReadySay',
  'local-missing-say': 'envReasonLocalMissingSay',
  'local-ready-espeak': 'envReasonLocalReadyEspeak',
  'local-missing-espeak': 'envReasonLocalMissingEspeak',
  'local-platform-unsupported': 'envReasonLocalPlatformUnsupported',
  'online-ready': 'envReasonOnlineReady',
  'online-no-voices': 'envReasonOnlineNoVoices',
  'online-unreachable': 'envReasonOnlineUnreachable',
  'neural-no-tier': 'envReasonNeuralNoTier',
  'neural-missing-runtime': 'envReasonNeuralMissingRuntime',
  'neural-model-missing': 'envReasonNeuralModelMissing',
  'neural-ready': 'envReasonNeuralReady',
})

/**
 * 这个码要填哪些参数（`{名字}` 从哪来）—— 由调用方补上「已经翻过一次的」那类。
 *
 * 这里唯一的加工是 `{runtime}`：宿主给的是契约值 `native` / `wasm`，
 * 界面上要说「原生加速 / native runtime」，所以进句子前过 `envRuntimeLabel`。
 * 其余参数（版本号、平台名、档位 id、音色短名、数量）是数据，原样填。
 */
function paramsFor(code, params, t) {
  const given = params && typeof params === 'object' ? params : {}
  const wanted = TTS_ENV_REASON_PARAMS[code] ?? []
  const out = {}
  for (const name of wanted) {
    const value = given[name]
    if (value === undefined || value === null) continue
    out[name] = name === 'runtime' ? envRuntimeLabel(String(value), t) : String(value)
  }
  return out
}

/**
 * 把宿主回的原因码翻成当前语言的句子。
 *
 * @param {unknown} reason - 宿主回的 `reason`（词表外的值、空值、非字符串都算「不认识」）。
 * @param {(key: string, params?: object) => string} t - i18n 取词函数（测试里传恒等函数）。
 * @param {object} [params] - 宿主给的参数（只取这个码要的那几个名字）。
 * @param {string} [fallbackKey] - 认不出这个码时用的那句键；调用点可换。
 * @returns {string} 界面要显示的句子。宿主那句原文**永远不会**从这里出去。
 */
export function ttsEnvReasonText(reason, t, params, fallbackKey = 'envReasonUnknown') {
  const translate = typeof t === 'function' ? t : (key) => key
  if (!isTtsEnvReason(reason)) return translate(fallbackKey)
  const i18nKey = TTS_ENV_REASON_KEYS[reason] ?? fallbackKey
  const filled = paramsFor(reason, params, translate)
  return Object.keys(filled).length ? translate(i18nKey, filled) : translate(i18nKey)
}
