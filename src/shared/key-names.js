/**
 * 具名键词表：一个写法（`Enter` / `Space` / `ArrowUp` / `Del`…）→ 三个环境各自要的值。
 *
 * 为什么住 `src/shared`（第 4 步 4.3d）：「这串字是哪个键」这个问题被三条链路问，
 * 而每条链路要的**值**不一样：
 *   - 浏览器派发／比对按键：`KeyboardEvent.key` 的真值（`pure/a11y.js` 主动派发给焦点元素、
 *     `pure/shortcut.js` 被动比较用户按下的是不是配置里那串）；
 *   - Windows 注册系统热键：`RegisterHotKey` 的虚拟键码（`lib/global-hotkey-helper.js`）；
 *   - macOS/Linux 进程内监听：uiohook 的键名（同一个 helper）。
 * 以前这三份各抄一遍：两张表（a11y 的 `NAMED_KEYS`、helper 的 `VK_BY_KEY` + `NATIVE_KEY_NAMES`），
 * 外加两处「Space 的 `KeyboardEvent.key` 是一个空格字符」的现场特判。抄出来的差别不在今天，
 * 在「以后有人只给其中一张表加一个键」那一刻：一端认、另一端不认，用户看到的是
 * 「窗口里按得出、切到别的应用按不动」这种最难查的分裂（和 4.3b 的修饰键别名同一类）。
 * 现在写法名单只有这一份，三个取值并排放在同一条目里 —— 加一个键要么三列一起填，
 * 要么在测试里当场变红。
 *
 * 取值那一列怎么读：
 *   - `dom` 是 `KeyboardEvent.key` 的规范值。**空格是 `' '`，不是 `'Space'`** ——
 *     这是 DOM 规范定的，不是本项目的选择（派发 `key: 'Space'` 的事件，页面里的代码认不出它）；
 *   - `native` 是 `uiohook-napi` 里 `UiohookKey` 的属性名；
 *   - `win` 是 Win32 虚拟键码（`VK_*`）。
 *
 * 本文件是双端单源判据：纯 ESM、零浏览器全局、零 Node API、零 React。
 * 它只回答「写法 → 值」；「这条链路允许哪些键」是各链路自己的策略，留在调用方 ——
 * a11y 只肯派发它自己列过的那一批，helper 的功能键到 F24、a11y 到 F12。
 */

/**
 * 写法 → 三种形态。写法一律小写做键（取值函数自己 `trim().toLowerCase()`）。
 *
 * 字母、数字、F1-F24 不在这里：它们由形状规则现取（见 `keyNameOf`），
 * 写进表里就等于把三十几个键塞进一张本该一眼看完的表。
 */
const KEY_NAME_FORMATS = {
  enter: { dom: 'Enter', native: 'Enter', win: 0x0d },
  return: { dom: 'Enter', native: 'Enter', win: 0x0d },
  tab: { dom: 'Tab', native: 'Tab', win: 0x09 },
  space: { dom: ' ', native: 'Space', win: 0x20 },
  escape: { dom: 'Escape', native: 'Escape', win: 0x1b },
  esc: { dom: 'Escape', native: 'Escape', win: 0x1b },
  backspace: { dom: 'Backspace', native: 'Backspace', win: 0x08 },
  delete: { dom: 'Delete', native: 'Delete', win: 0x2e },
  del: { dom: 'Delete', native: 'Delete', win: 0x2e },
  insert: { dom: 'Insert', native: 'Insert', win: 0x2d },
  ins: { dom: 'Insert', native: 'Insert', win: 0x2d },
  home: { dom: 'Home', native: 'Home', win: 0x24 },
  end: { dom: 'End', native: 'End', win: 0x23 },
  pageup: { dom: 'PageUp', native: 'PageUp', win: 0x21 },
  pagedown: { dom: 'PageDown', native: 'PageDown', win: 0x22 },
  up: { dom: 'ArrowUp', native: 'ArrowUp', win: 0x26 },
  arrowup: { dom: 'ArrowUp', native: 'ArrowUp', win: 0x26 },
  down: { dom: 'ArrowDown', native: 'ArrowDown', win: 0x28 },
  arrowdown: { dom: 'ArrowDown', native: 'ArrowDown', win: 0x28 },
  left: { dom: 'ArrowLeft', native: 'ArrowLeft', win: 0x25 },
  arrowleft: { dom: 'ArrowLeft', native: 'ArrowLeft', win: 0x25 },
  right: { dom: 'ArrowRight', native: 'ArrowRight', win: 0x27 },
  arrowright: { dom: 'ArrowRight', native: 'ArrowRight', win: 0x27 },
}

/**
 * 把一个写法归一成规范键名（`Enter` / `Space` / `ArrowUp` / `A` / `1` / `F5`）。
 *
 * 规范名是三条链路共同的中间值，也是**给人看的那个名字**：a11y 拿它判断
 * 「这个键允不允许派发」，设置面板的提示语里写的也是它。要派发或注册时
 * 用下面的三个取值函数，别拿规范名直接当某个环境的值（空格就是唯一会踩的地方）。
 *
 * @param {string} raw - 用户或模型写的键名。
 * @returns {string} 规范名；不认识返回空串。
 */
export function keyNameOf(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const lower = text.toLowerCase()
  const format = KEY_NAME_FORMATS[lower]
  if (format) return format.native
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase()
  if (/^[0-9]$/.test(lower)) return lower
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower)
  if (functionKey) return 'F' + functionKey[1]
  return ''
}

/**
 * 写法 → `KeyboardEvent.key` 的真值。浏览器派发与比对都问它。
 *
 * 与规范名的唯一差别是空格：真值是一个空格字符 `' '`。
 * 字母给大写（`event.key` 实际按 Shift 状态给 `a`/`A`，比较方自己转小写）。
 *
 * @param {string} raw - 键名写法。
 * @returns {string} 真值；不认识返回空串。
 */
export function domKeyOf(raw) {
  const format = KEY_NAME_FORMATS[String(raw ?? '').trim().toLowerCase()]
  if (format) return format.dom
  return keyNameOf(raw)
}

/**
 * 写法 → uiohook 的键名（macOS/Linux 进程内监听问它）。
 * @param {string} raw - 键名写法。
 * @returns {string} 键名；不认识返回空串。
 */
export function uiohookKeyOf(raw) {
  const format = KEY_NAME_FORMATS[String(raw ?? '').trim().toLowerCase()]
  if (format) return format.native
  return keyNameOf(raw)
}

/**
 * 写法 → Windows 虚拟键码（`RegisterHotKey` 的 `vk` 参数）。
 *
 * 认不出来返回 `undefined` 而不是 0：调用方据此判非法，绝不能拿 0 去注册热键。
 * @param {string} raw - 键名写法。
 * @returns {number|undefined} 虚拟键码。
 */
export function windowsVirtualKeyOf(raw) {
  const lower = String(raw ?? '').trim().toLowerCase()
  const format = KEY_NAME_FORMATS[lower]
  if (format) return format.win
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(lower)) return lower.charCodeAt(0)
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower)
  if (functionKey) return 0x70 + (Number(functionKey[1]) - 1)
  return undefined
}
