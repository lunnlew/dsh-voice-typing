/**
 * 通用 a11y 界面操作的 **DOM 侧胶水**（全局语音浮层执行 `ui_*` 动作时用的那一层）。
 *
 * 为什么单独成文件（docs/architecture-modernization.md §5 第 4 步 · 4.1）：
 *   这七件事（可见性判据、ref→元素表、ref→可读描述、DOM 事件派发、React 受控输入写入、
 *   ref 解析）以前住在 6454 行的 `main.js` 闭包里，只有浮层用得到，却没有自己的名字。
 *   搬出来之后它**独立可测**：环境（`window` / `document`）由调用方注入，
 *   Node 里传假对象就能驱动真代码 —— 和 `pure/reading-highlight.js` 同一个规矩。
 *
 * 和 `pure/` 的分工：`pure/` 是无状态的纯函数；这里**持有状态**（最近一次快照的两张表）
 * 并真的操作 DOM，所以住 `dom/`。两者受同一条机械约束管 —— 源码里不许出现裸浏览器全局
 * （`window.` / `document.` / `navigator.`，见 `test/bundle-sync.test.mjs`），
 * 环境只能从参数进来。这样「在浏览器里看着能跑、在 Node 测试里 ReferenceError」这一类
 * 缺陷就没有生存空间。
 *
 * ref 的生命周期是契约的一部分，改这块前务必记住：
 *   `ui_snapshot` 与 `ui_click` / `ui_type` 是**两次独立的 SSE 动作**，中间隔着模型思考
 *   与用户确认；ref 只在最近一次快照内有效，新快照整体覆盖旧表，旧 ref 立即失效
 *   （否则可能点到上一页的同名 ref）。
 */

/**
 * 建一个 a11y DOM 桥（一份浮层用一个实例）。
 *
 * @param {object|null} [win] - 注入的 `window`（取 `getComputedStyle` / `Event` /
 *   `KeyboardEvent` / `HTML*Element.prototype`）。
 * @param {object|null} [doc] - 注入的 `document`（只用 `contains`，判断元素还在不在 DOM 里）。
 *   两者留空表示「没有窗口」（Node 单测 / DOM 桩环境）：可见性与解析退化成 false / null，
 *   事件派发退化成普通对象，**不抛错** —— 与搬出来之前的行为一致。
 * @returns {{ clear: Function, record: Function, infoFor: Function,
 *   isVisible: Function, resolve: Function, dispatchDomEvent: Function,
 *   setNativeInputValue: Function }}
 */
export function createA11yDomBridge(win = null, doc = null) {
  /** ref → 元素（只在最近一次快照内有效）。 */
  let elements = new Map()
  /**
   * ref → 可读描述 `{ref, role, name, tag}`。
   *
   * 用途：确认条要告诉用户「你在批准什么」。只显示 ref（`ui_click: e12`）
   * 等于让用户盲签 —— a11y 动作能点到任意按钮，尤其是危险开关。
   */
  let infos = new Map()

  /** 清掉旧快照：摘掉 DOM 上的 ref 标记并清空两张表（旧 ref 立即失效）。 */
  function clear() {
    for (const el of elements.values()) {
      try { el.removeAttribute?.('data-dsh-voice-ref') } catch { /* 节点可能已卸载 */ }
    }
    elements = new Map()
    infos = new Map()
  }

  /**
   * 记一条快照命中：ref → 元素，同时 ref → 描述。
   * 两个表一起写，避免出现「能点到但确认条说不出点了什么」的半成品状态。
   *
   * @param {string} ref - 快照 ref（如 e12）。
   * @param {Element} el - 命中的元素。
   * @param {object} info - `describeInteractiveElement` 的产出。
   */
  function record(ref, el, info) {
    const key = String(ref ?? '')
    elements.set(key, el)
    infos.set(key, info)
  }

  /**
   * 查 ref 的可读描述（确认条渲染时查），没有返回 null。
   * @param {string} ref - 快照 ref。
   * @returns {object|null}
   */
  function infoFor(ref) {
    return infos.get(String(ref ?? '')) ?? null
  }

  /**
   * 元素是否「可见可交互」。
   *
   * 判据与契约一致：`offsetParent !== null` 或 `position:fixed`；
   * 跳过 `aria-hidden="true"` 子树（屏幕阅读器也看不到的东西不该进快照）。
   * disabled 元素**保留**（快照里带 disabled 字段），由执行动作时拒绝。
   *
   * @param {Element} el - DOM 元素。
   * @returns {boolean} 是否纳入快照。
   */
  function isVisible(el) {
    try {
      if (!el || typeof el !== 'object') return false
      if (typeof el.closest === 'function' && el.closest('[aria-hidden="true"]')) return false
      let style = null
      try {
        if (typeof win?.getComputedStyle === 'function') {
          style = win.getComputedStyle(el)
        }
      } catch {
        style = null
      }
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
      if (el.offsetParent === null) {
        // position:fixed 的元素（浮层/对话框）offsetParent 也是 null，但可见。
        return Boolean(style && style.position === 'fixed')
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * 派发 DOM 事件：浏览器里用真构造器；测试桩环境退化成普通对象（不抛错）。
   * @param {Element} el - 目标元素。
   * @param {string} type - 事件类型。
   * @param {object} [init] - 事件初始化参数。
   */
  function dispatchDomEvent(el, type, init = {}) {
    try {
      const Ctor = win && (type === 'keydown' || type === 'keyup' ? win.KeyboardEvent : win.Event)
      if (Ctor) {
        el.dispatchEvent(new Ctor(type, init))
        return
      }
    } catch {
      /* 继续用退化对象 */
    }
    try {
      el.dispatchEvent({ type, ...init, preventDefault() {}, stopPropagation() {} })
    } catch {
      /* 桩元素没有 dispatchEvent：忽略 */
    }
  }

  /**
   * 写 React 受控输入。
   *
   * 直接 `el.value = x` 会被 React 的 value tracker 当成「值没变」，onChange
   * 不会触发 —— 必须调用原型上的原生 setter 绕过 tracker，再派发 input/change。
   * 这是 React 受控输入的标准写法（语音/模型代填必须让界面真的收到变化）。
   *
   * @param {Element} el - input/textarea。
   * @param {string} value - 目标文本。
   */
  function setNativeInputValue(el, value) {
    const tag = String(el?.tagName ?? '').toUpperCase()
    let setter = null
    try {
      const proto = tag === 'TEXTAREA' ? win?.HTMLTextAreaElement?.prototype : win?.HTMLInputElement?.prototype
      if (proto) setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set ?? null
    } catch {
      setter = null
    }
    try {
      if (setter) setter.call(el, value)
      else el.value = value
    } catch {
      try { el.value = value } catch { /* 忽略 */ }
    }
    dispatchDomEvent(el, 'input', { bubbles: true })
    dispatchDomEvent(el, 'change', { bubbles: true })
  }

  /**
   * 解析 ref → 元素：必须在最近一次快照表里、仍在 DOM、可见。
   * 任何一条不满足都返回 null（调用方回 `stale_ref`，让模型重新拍快照）。
   *
   * @param {string} ref - 快照 ref（如 e12）。
   * @returns {Element|null} 目标元素。
   */
  function resolve(ref) {
    const key = String(ref ?? '')
    const el = elements.get(key)
    if (!el) return null
    try {
      if (typeof doc?.contains === 'function' && !doc.contains(el)) return null
    } catch {
      /* 桩环境没有 contains：跳过 */
    }
    if (!isVisible(el)) return null
    return el
  }

  return { clear, record, infoFor, isVisible, resolve, dispatchDomEvent, setNativeInputValue }
}
