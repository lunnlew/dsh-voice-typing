/**
 * 系统级热键的原因码 → 界面文案的**唯一**一张对照表。
 *
 * 为什么需要它（批次 19，docs/architecture-modernization.md §8.61）：
 *   helper 报的 `reason` 以前是宿主写好的中文句子，设置面板直接把它插进自己的文案
 *   （`t('hotkeyStatusFailed', { reason })` 和「说明」那一行）——英文界面上那段是中文。
 *   现在宿主只报码（`src/shared/hotkey-reasons.js`），这句话由这里翻译成 i18n 的键，
 *   再由 `t` 按界面语言取句子。
 *
 * 本文件的规矩（`src/client/pure/*` 的共同规矩，由 `test/bundle-sync.test.mjs` 机械守卫）：
 *   零浏览器全局、零 Node API、零 React、零状态 —— 只接受一个 `t` 函数进来干活。
 *
 * **对照表的两个取舍**：
 *   - 几个码共用一句：`script-build-failed` / `script-write-failed` 都是「助手脚本没准备好」，
 *     `spawn-failed` / `start-failed` 都是「助手进程没能启动」。用户能做的事一样，
 *     就不必为每个码造一句几乎相同的话；到底是哪一步，看 `/diagnostics` 的 `detail`。
 *   - `no-global-voice` 有自己的一句（`hotkeyReasonOverlayOff`）。面板上另外已经有一条
 *     「需要同时开启浮层」的提示（`hotkeyStatusNeedsOverlay`，按本地配置出），
 *     复用那句会让同一个面板把同一句话显示两遍。
 *
 * **不在这里的东西**：
 *   - 句子本身 —— 住在 `src/client/pure/i18n.js`（中英两份）；
 *   - 动态原文（组合键写法、pid、退出码、操作系统报错）—— 在 `detail` 里，只进诊断，
 *     界面一个字都不取。
 */
import { isHotkeyReason } from '../../shared/hotkey-reasons.js'

/**
 * 原因码 → i18n 键。键名用 `hotkeyReason*`，跟状态行的 `hotkeyStatus*` 分开：
 * 状态行只放短词（「失败」），这一句是「为什么失败、能怎么办」。
 */
export const HOTKEY_REASON_KEYS = Object.freeze({
  'host-address-unknown': 'hotkeyReasonAddress',
  'script-build-failed': 'hotkeyReasonScript',
  'script-write-failed': 'hotkeyReasonScript',
  'spawn-failed': 'hotkeyReasonHelperStart',
  'start-failed': 'hotkeyReasonHelperStart',
  'exited-before-ready': 'hotkeyReasonBeforeReady',
  'register-failed': 'hotkeyReasonRegister',
  'exited': 'hotkeyReasonExited',
  'native-unavailable': 'hotkeyReasonNative',
  'invalid-shortcut': 'hotkeyReasonShortcut',
  'disabled-by-switch': 'hotkeyReasonSwitchOff',
  'no-global-voice': 'hotkeyReasonOverlayOff',
  'unloaded': 'hotkeyReasonUnloaded',
})

/**
 * 把原因码翻成界面那句话。
 *
 * 词表外的值（旧宿主直接写的中文句子、字段缺失、拼错的码）一律走兜底键，
 * **绝不把原始值显示给用户** —— 这正是本批要修的那件事。
 *
 * @param {unknown} reason - helper 报的码（字符串；其它形状当「不认识」）。
 * @param {(key:string, params?:object)=>string} t - i18n 取句函数。
 * @param {string} [fallbackKey] - 词表外时用的键。
 * @returns {string} 界面文案。
 */
export function hotkeyReasonText(reason, t, fallbackKey = 'hotkeyReasonUnknown') {
  const key = isHotkeyReason(reason) ? HOTKEY_REASON_KEYS[reason] : undefined
  return t(key ?? fallbackKey)
}
