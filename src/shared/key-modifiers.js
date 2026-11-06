/**
 * 修饰键词表：任何写法（`Control` / `Cmd` / `Option` / `Win` / `Super`…）→ 四个规范名。
 *
 * 为什么住 `src/shared`（第 4 步 4.3b，4.3c 补齐第三条链路）：
 *   「这一串字到底要不要按下 Ctrl」这件事被三处需要，而它们问的是同一个问题：
 *     - a11y 的按键字符串解析（`src/client/pure/a11y.js` 的 `parseKeySpec`）—— **主动派发**给 DOM；
 *     - 窗口内快捷键匹配（`src/client/pure/shortcut.js` 的 `matchesShortcut`）—— **被动比较** KeyboardEvent；
 *     - 宿主原生热键 helper（`lib/global-hotkey-helper.js`）—— 注册**系统级**热键。
 *   前两条直接查这张表。第三条要的**值**不同（它要的是 Win32 的位掩码，不是布尔），
 *   所以它查 `keyModifierSpellings()` 认出写法、再用 `canonicalModifier` 落到规范名，
 *   最后查自己那张「规范名 → 位」的表。写法名单仍然只有这一份，位的知识留在宿主。
 *
 * 这张表解决的是一类**静默失效**：设置面板的校验放行某种写法、匹配层却只认规范名，
 * 于是「保存成功、界面没有报错、快捷键按了没反应」。规则收成一句：
 * **校验放行的写法，匹配层必须认**，而两边问的都是这张表。
 *
 * 本文件是双端单源判据：纯 ESM、零浏览器全局、零 Node API、零 React。
 */

/** 别名 → 规范名。规范名只有四个，正好对上 `KeyboardEvent` 的四个布尔。 */
export const KEY_MODIFIER_ALIASES = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  windows: 'meta',
  super: 'meta',
}

/** 四个规范名（派发按键时写进 `KeyboardEventInit` 的那四项）。 */
export const KEY_MODIFIER_NAMES = ['ctrl', 'alt', 'shift', 'meta']

/**
 * 「强修饰键」：能让**单个字母**主键变得安全的规范名。
 *
 * `Shift+V` 就是打一个大写字母，绝不该被当成快捷键；Ctrl/Alt/Meta 才是修饰。
 * 空格键的写法提示（`Space`）与输入法占用是另一回事，不在这条规则里。
 */
export const STRONG_KEY_MODIFIER_NAMES = ['ctrl', 'alt', 'meta']

/**
 * 把一个写法归一成规范名。
 *
 * @param {string} token - 用户或模型写的修饰键（大小写、空白都无所谓）。
 * @returns {string} 规范名（`ctrl`/`alt`/`shift`/`meta`）；不认识返回空串。
 */
export function canonicalModifier(token) {
  return KEY_MODIFIER_ALIASES[String(token ?? '').trim().toLowerCase()] ?? ''
}

/**
 * 所有被认作修饰键的写法（四个规范名 + 全部别名，去重）。
 *
 * 为什么要导出这个：宿主热键 helper（`lib/global-hotkey-helper.js`）要把
 * 「哪些写法算修饰键」建成一张派生表（第 4 步 4.3c）。它需要的是**全部写法**，
 * 只列别名就会漏掉规范名（现在两者恰好重合，将来加一个规范名不配同名别名就会漏），
 * 漏掉的那一种表现是「设置面板存得下去、系统级热键永远注册不起来」。
 * 用这个函数拼表，漏哪种写法在构造上就不可能了。
 *
 * @returns {string[]} 去重后的写法（未小写；派生表用的时候再转小写）。
 */
export function keyModifierSpellings() {
  return [...new Set([...KEY_MODIFIER_NAMES, ...Object.keys(KEY_MODIFIER_ALIASES)])]
}
