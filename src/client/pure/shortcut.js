/**
 * 快捷键：格式校验、按键匹配、设置面板的「正在录键」状态。
 *
 * 为什么单独成一个文件（第 4 步 4.3，从 main.js 搬出来）：
 *   1. 这三件事是**同一套判据**：面板输入框写的字符串、按窗口里收到的
 *      KeyboardEvent、macOS 的 Cmd 别名，都是对同一份「组合键」文本的解释。
 *      留在 main.js 时它们分散在文件头、播放核心后面和组件区中间，
 *      改一条规则要跳三处 —— 而规则本身只该有一份。
 *   2. 它是纯判据 + 一份很小的可变状态，不碰任何浏览器 API：
 *      `event` 由调用方传进来，平台标识由调用方传进来（`clientPlatform()` 在 main.js，
 *      因为那里才真的读 navigator）。所以本文件可以在 Node 里直接 import 单测
 *      （test/shortcut.test.mjs），不需要假 DOM。
 *   3. 「设置面板正在录键时不要触发录音」那个标志以前是 main.js 的两个模块级 `let`。
 *      搬成工厂之后它变成显式实例：两个输入框共用一份状态、卸载时必须复位这件事
 *      有了可读的 API（focus/blur/anyFocused/releaseAll），也能在真实产物里被驱动
 *      （test/client-behavior.test.mjs 的场景「窗口内快捷键」）。
 *
 * 与 a11y 的 `parseKeySpec`（pure/a11y.js）的分工：那条是**主动派发**按键给 DOM
 * （要把具名键规范成 KeyboardEvent.key 的真值），这里是**被动匹配**用户按下的键。
 * 判据不同（这里要求修饰键精确一致、且对未知主键宽松），所以不合并。
 * 但「Control 算不算 ctrlKey」这个问题两边是同一个，那张表住在
 * `src/shared/key-modifiers.js`，两边都从那里取（第 4 步 4.3b）。
 *
 * 本文件不依赖浏览器全局、不依赖 React、不依赖 Node API（与 pure/gate.js 同一约定）。
 */

import { effectiveShortcut } from './global-voice.js'
import { KEY_MODIFIER_NAMES, STRONG_KEY_MODIFIER_NAMES, canonicalModifier } from '../../shared/key-modifiers.js'
import { domKeyOf } from '../../shared/key-names.js'

/**
 * 列出组合键要求按下的修饰键（规范名集合）。
 *
 * 为什么要先归一：`validateShortcut` 放行 `Control+Alt+V`、`Cmd+V`、`Win+V` 这些写法
 * （macOS/Windows 的用户本来就习惯这么写），而 `KeyboardEvent` 上只有
 * `ctrlKey/altKey/shiftKey/metaKey` 四个布尔。以前匹配层只按字面比较那四个词，
 * 于是「校验放行 → 保存成功 → 窗口内快捷键永远不触发」，用户看到的是「设了没用」。
 * 规则收成一句：**校验放行的写法，匹配层必须认** —— 而两边现在查的是同一张表，
 * 这句话就不再靠「记得同步改两处」来维持。
 * 宿主原生 helper（`lib/global-hotkey-helper.js`）早就认这些别名，
 * 所以「窗口内」和「系统级」两条路对同一个配置值的态度也一致了。
 *
 * @param {string[]} parts - 已经小写去空白的组合键分段（含主键，主键在最后）。
 * @returns {Set<string>} 必须按下的规范修饰键名。
 */
function wantedModifiers(parts) {
  const wanted = new Set()
  for (const part of parts.slice(0, -1)) {
    const canonical = canonicalModifier(part)
    if (canonical) wanted.add(canonical)
  }
  // 主键位置上恰好写着规范修饰键名（`Ctrl+Shift` 这种「把修饰键本身当主键」的配置）：
  // 旧实现是 `parts.includes('shift')` 整串扫描，等于把主键位置也算进修饰要求。
  // 这一轮不动它 —— 一次只改一个变量（别名），改坏了才说得清是哪条造成的。
  for (const name of KEY_MODIFIER_NAMES) {
    if (parts.includes(name)) wanted.add(name)
  }
  return wanted
}

/**
 * 快捷键校验的失败原因码（批次 22）。
 *
 * **为什么不放 `src/shared/`**：批次 18/19/20 那三张码表进 shared 是因为**两端都会发**
 * （宿主发、客户端翻译）。这条链路只有客户端自己发、客户端自己译 —— 放进 shared
 * 只是把文件搬个地方，不给任何运行期收益（同 §8.63 那条「不把超时搬进 shared」的裁定）。
 * 形状仍与那三张一致：`Object.freeze` 的字典 + 值清单 + `isShortcutErrorCode()`，
 * 于是拼错一处会在映射表那条判据上红，而不是悄悄掉进兜底句。
 */
export const SHORTCUT_ERROR_REASONS = Object.freeze({
  /** 整条组合键是空串。 */
  EMPTY: 'empty',
  /** 少于两段（没有修饰键，或者只写了一个键名）。 */
  TOO_FEW_PARTS: 'too-few-parts',
  /** 修饰键位置写了词表里认不出的名字。 */
  UNKNOWN_MODIFIER: 'unknown-modifier',
  /** 单字母主键没配强修饰键（打字会误触发）。 */
  SINGLE_LETTER: 'single-letter',
  /** 撞上浏览器占用的组合键。 */
  RESERVED_PASTE: 'reserved-paste',
})

/** 全部原因码（词表完备性判据按它逐个查文案）。 @returns {string[]} */
export const SHORTCUT_ERROR_REASON_VALUES = Object.freeze([...Object.values(SHORTCUT_ERROR_REASONS)])

/**
 * 这个值是不是本表里的原因码。
 * @param {unknown} value - 待检查的值。
 * @returns {boolean} 在词表内为 true。
 */
export function isShortcutErrorCode(value) {
  return SHORTCUT_ERROR_REASON_VALUES.includes(value)
}

/**
 * 校验快捷键格式（设置面板保存前用它挡非法值）。
 *
 * 必须带至少一个修饰键，且主键不能是单独一个字母（否则打字会误触发）。
 *
 * **这里没有一句用户看的文案**（批次 22）：改前这个文件直接返回五条中文
 * （`'不能为空'`、`'至少要两个键，例如 Ctrl+Shift+Space'`、`'不认识的修饰键：' + modifier`、
 * `'别用单个字母，否则打字会误触发（单字母需要搭配 Ctrl/Alt）'`、
 * `'Ctrl+Shift+V 是浏览器的「粘贴为纯文本」'`），设置面板原样显示，
 * 切英文后这两行红字仍然是中文。现在只回原因码 + 填句子要的参数（哪个修饰键不认识），
 * 句子由 `src/client/pure/shortcut-error-text.js` 按当前语言从字典出。
 *
 * @param {string} value - 用户填写的组合键。
 * @returns {{ok:true}|{ok:false, reason:string, params:object}} 校验结果。
 */
export function validateShortcut(value) {
  const text = String(value ?? '').trim()
  if (!text) return { ok: false, reason: SHORTCUT_ERROR_REASONS.EMPTY, params: {} }
  const parts = text.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean)
  if (parts.length < 2) return { ok: false, reason: SHORTCUT_ERROR_REASONS.TOO_FEW_PARTS, params: {} }
  const modifiers = parts.slice(0, -1)
  const key = parts[parts.length - 1]
  // 认哪些写法由 shared 那张表说了算 —— 校验这里不再自己列一份名单。
  for (const modifier of modifiers) {
    if (!canonicalModifier(modifier)) {
      return { ok: false, reason: SHORTCUT_ERROR_REASONS.UNKNOWN_MODIFIER, params: { modifier } }
    }
  }
  // 单字母主键只有在配上 Ctrl/Alt/Meta 这类「强修饰键」时才安全；
  // 光 Shift+字母 会和正常打大写字母冲突，要拒绝。
  // 注意：默认快捷键 Alt+V 必须通过校验（以前这条规则会把它判为非法，
  // 于是「保存前校验快捷键」会直接把默认配置的保存按钮永久禁用）。
  // 别名写法要先归一再查这张名单，否则 `Control+V` 会被当成「没有强修饰键」。
  const strongModifier = modifiers.some((modifier) => STRONG_KEY_MODIFIER_NAMES.includes(canonicalModifier(modifier)))
  if (key.length === 1 && /[a-z]/.test(key) && !strongModifier) {
    return { ok: false, reason: SHORTCUT_ERROR_REASONS.SINGLE_LETTER, params: { key } }
  }
  if (text.toLowerCase() === 'ctrl+shift+v') {
    return { ok: false, reason: SHORTCUT_ERROR_REASONS.RESERVED_PASTE, params: { combo: 'Ctrl+Shift+V' } }
  }
  return { ok: true, params: {} }
}

/**
 * 判断 window keydown 事件是否命中某个组合键。
 *
 * 与 composer 麦克风那边的匹配规则一致：修饰键必须**精确**一致 ——
 * 配置 Alt+V 时按下 Ctrl+Alt+V 不算命中（否则两个语音入口会一起被触发）。
 *
 * @param {KeyboardEvent} event - 键盘事件。
 * @param {string} combo - 形如 `Ctrl+Alt+V` 的配置值。
 * @returns {boolean} 是否命中。
 */
export function matchesShortcut(event, combo) {
  const parts = String(combo ?? '').split('+').map((part) => part.trim().toLowerCase()).filter(Boolean)
  if (!parts.length) return false
  const key = parts[parts.length - 1]
  if (!event || typeof event.key !== 'string') return false
  // 配置里写的名字先过一遍词表（src/shared/key-names.js，4.3d），拿到 `KeyboardEvent.key`
  // 的真值再比。以前这里只特判了空格一个键（`key === 'space' ? ' ' : key`），
  // 于是 `Ctrl+Up` 这类写法保存得下去、永远不触发 —— 按下去时 `event.key` 是 `ArrowUp`，
  // 而比较用的还是配置里的 `up`。词表里没有的写法（比如直接写 `ArrowUp`）落回原样比较。
  const expectedKey = domKeyOf(key) || key
  if (event.key.toLowerCase() !== expectedKey.toLowerCase()) return false
  const wanted = wantedModifiers(parts)
  const pressed = { ctrl: !!event.ctrlKey, alt: !!event.altKey, shift: !!event.shiftKey, meta: !!event.metaKey }
  for (const name of KEY_MODIFIER_NAMES) {
    if (pressed[name] !== wanted.has(name)) return false
  }
  return true
}

/**
 * 快捷键匹配（含平台别名）。
 *
 * macOS 上默认的 Ctrl+Alt+V 不顺手：配置值保持不变，但匹配时额外接受
 * Meta+Alt+V（Cmd+Alt+V）—— 别名表在 pure/global-voice.js 的 effectiveShortcut。
 *
 * 平台标识由调用方传进来（读 navigator 是环境访问，不能住在这个文件里）。
 * 测试桩没有 navigator 时调用方给空串，等价于「不加别名」。
 *
 * @param {KeyboardEvent} event - 键盘事件。
 * @param {string} combo - 配置里的组合键。
 * @param {string} platform - 平台标识（navigator.platform / userAgent）。
 * @returns {boolean} 是否命中任一可接受的组合。
 */
export function shortcutMatches(event, combo, platform) {
  const candidates = effectiveShortcut(combo, platform)
  return candidates.some((candidate) => matchesShortcut(event, candidate))
}

/**
 * 「设置面板正在录快捷键」这份状态。
 *
 * 两个输入框（composer 快捷键 / 全局语音快捷键）是两套设置：
 * 录其中一个时，另一个也不该被那串按键触发 —— 所以判据分两级：
 *   - `isFocused('composer')`：composer 自己的监听只看自己那个框；
 *   - `anyFocused()`：全局语音那条监听两个框都认（历史上就是 `a || b`）。
 *
 * 卸载时必须 `releaseAll()`：面板被销毁时不保证触发 blur，
 * 标志留在 true 的话快捷键就**永久**失效（审计 F14）。
 *
 * @returns {{focus: Function, blur: Function, isFocused: Function, anyFocused: Function,
 *   releaseAll: Function, fields: Function}} 状态实例（可有多个，互不干扰）。
 */
export function createShortcutFocusTracker() {
  const focusedFields = new Set()
  return {
    /** 某输入框拿到焦点。 @param {string} field - 字段标识。 */
    focus(field) { focusedFields.add(String(field)) },
    /** 某输入框交出焦点。 @param {string} field - 字段标识。 */
    blur(field) { focusedFields.delete(String(field)) },
    /** 某个框是否正在聚焦（未聚焦时快捷键正常）。 @returns {boolean} */
    isFocused(field) { return focusedFields.has(String(field)) },
    /** 任一个框正在聚焦 —— 全局那条监听用这个。 @returns {boolean} */
    anyFocused() { return focusedFields.size > 0 },
    /** 全部复位（组件卸载时调用，否则快捷键永久失效）。 */
    releaseAll() { focusedFields.clear() },
    /** 当前聚焦的字段清单（诊断用；顺序是插入序）。 @returns {string[]} */
    fields() { return [...focusedFields] },
  }
}

/**
 * 全局快捷键焦点跟踪单例。
 *
 * 为什么导出单例而不是让调用方各自 create：
 *   MicButton / 设置面板 / 全局浮层必须共享**同一个**实例，
 *   「正在录键」状态才跨组件一致 —— 否则 MicButton 查 `anyFocused()`
 *   看不到设置面板刚 focus 的状态，快捷键会在录键时误触发。
 *   消费方直接 import 此对象即可。
 */
export const shortcutFocus = createShortcutFocusTracker()
