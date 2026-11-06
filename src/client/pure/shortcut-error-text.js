/**
 * 设置面板那两行「快捷键不合法」红字 —— 原因码 → i18n 键的**唯一一张表**（批次 22，docs §8.64）。
 *
 * 分工与批次 18（`pure/asr-ready-text.js`）、批次 19（`pure/hotkey-reason-text.js`）、
 * 批次 20（`pure/config-error-text.js`）完全一致：**判据只说不合哪条规则，句子由这一层按当前语言出**。
 * 差别只在于这条链路的「写句子的人」和「读句子的人」都在客户端：
 * 改前 `pure/shortcut.js` 直接返回五条中文，设置面板原样显示，切英文后那两行仍然是中文。
 *
 * **参数是判据给的，不是字典猜的**：「不认识的修饰键」要说 out 是哪个键，
 * 「浏览器占用的组合键」要说是哪一组 —— 这些值是用户输入的内容本身，
 * 只有校验那一侧知道，所以 `validateShortcut` 除了码还带一个 `params`。
 * 与批次 20 不同的是那里**不需要**参数协议：没有跨进程传输，`params` 就是这个调用栈里的一个对象。
 *
 * 词表外的值（脏数据、别的调用方塞进来的整句中文）一律走兜底那句 `shortcutErrorUnknown`，
 * 传进来的原文一个字都不进界面。
 *
 * 环境约束：纯 ESM、零浏览器全局、零 Node API、零 React（`test/bundle-sync.test.mjs` 机械守卫）。
 */
import { isShortcutErrorCode } from './shortcut.js'

/** 码 → i18n 键（五个码五句，没有故意合并：每一句要用户做的动作都不一样）。 */
export const SHORTCUT_ERROR_KEYS = Object.freeze({
  'empty': 'shortcutErrorEmpty',
  'too-few-parts': 'shortcutErrorTooFewParts',
  'unknown-modifier': 'shortcutErrorUnknownModifier',
  'single-letter': 'shortcutErrorSingleLetter',
  'reserved-paste': 'shortcutErrorReservedPaste',
})

/**
 * 把一条校验结果翻成界面那句红字。
 *
 * @param {{ok: boolean, reason?: unknown, params?: object}} check - `validateShortcut` 的返回。
 * @param {(key: string, params?: object) => string} t - 取词函数（i18n）。
 * @param {string} [fallbackKey] - 词表外时用的那句键；调用点可换。
 * @returns {string} `t` 给出的那句。
 */
export function shortcutErrorText(check, t, fallbackKey = 'shortcutErrorUnknown') {
  const reason = check?.reason
  if (!isShortcutErrorCode(reason)) return t(fallbackKey)
  const i18nKey = SHORTCUT_ERROR_KEYS[reason] ?? fallbackKey
  const params = check?.params
  const hasParams = params && Object.keys(params).length > 0
  return hasParams ? t(i18nKey, params) : t(i18nKey)
}
