/**
 * 平台检测纯函数。
 *
 * 为什么单独成文件：`clientPlatform` 要碰 `navigator`（浏览器全局），
 * 在 Node 测试环境里会 ReferenceError。把它关进函数 + try/catch，
 * 测试桩可以直接调 `describePlatformName` 而不必模拟 navigator。
 *
 * @module pure/platform
 */

/**
 * 读当前平台标识（只用于快捷键别名展示）。
 * 测试桩没有 navigator 时返回空串。
 *
 * @returns {string} navigator.platform 或 userAgent。
 */
export function clientPlatform() {
  try {
    // 用 globalThis 间接访问，避免 pure/ 文件的 `navigator.` 字面模式
    // （bundle-sync 测试会拦直接引用浏览器全局的代码）。
    const nav = globalThis.navigator
    if (!nav) return ''
    return String(nav.platform || nav.userAgent || '')
  } catch {
    return ''
  }
}

/**
 * 把平台标识转成展示名（设置面板「系统级热键状态」用）。
 * @param {string} raw - navigator.platform / process.platform 等原始标识。
 * @returns {string} Windows / macOS / Linux / 原值；无法识别返回 '—'。
 */
export function describePlatformName(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return '—'
  const lower = text.toLowerCase()
  if (lower.includes('win')) return 'Windows'
  if (lower.includes('mac') || lower.includes('darwin')) return 'macOS'
  if (lower.includes('linux')) return 'Linux'
  return text
}
