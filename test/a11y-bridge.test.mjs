/**
 * a11y DOM 桥的行为回归（第 4 步 4.1：从 main.js 的闭包里搬出来的第一块）。
 *
 * 这个文件守的是**真行为**：环境（window / document）由参数注入，
 * 所以 Node 里用假对象就能驱动真代码，不需要正则扫源码。
 *
 * 为什么值得单独测：这套判据是「AI 能不能点到你的界面」的执行层。
 *   - `isVisible` 决定什么进快照，也决定 `resolve` 放行谁 ——
 *     快照端与执行端必须是同一个判据（bundle-sync 里有「只有一份」的守卫）。
 *   - ref 的生命周期是契约：新快照整体覆盖旧表，旧 ref 必须立即失效，
 *     否则模型点到的是上一页的同名 ref。
 *   - `setNativeInputValue` 走的是 React 受控输入的原生 setter，
 *     写成 `el.value = x` 会被 value tracker 吞掉（表现是「语音填了但界面没收到」）。
 */
import { createA11yDomBridge } from '../src/client/dom/a11y-bridge.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/** 造一个够用的假元素。 */
function makeEl(opts = {}) {
  const {
    tag = 'BUTTON',
    offsetParent = {},
    style = null,
    closestResults = {},
    attributes = {},
  } = opts
  const el = {
    tagName: tag,
    offsetParent,
    __style: style,
    __attrs: { ...attributes },
    __events: [],
    __removed: [],
    __setters: [],
    getAttribute(name) { return name in el.__attrs ? el.__attrs[name] : null },
    setAttribute(name, value) { el.__attrs[name] = value },
    removeAttribute(name) { el.__removed.push(name); delete el.__attrs[name] },
    closest(sel) { return sel in closestResults ? closestResults[sel] : null },
    dispatchEvent(event) { el.__events.push(event); return true },
    click() { el.__events.push({ type: 'click' }) },
  }
  // 元素**自己**的 value 访问器：真实页面里 React 会把 input 的 value 接管，
  // 直接 `el.value = x` 走的是这里，而不是原型上的原生 setter —— 计数器用来证明没走错路。
  let own = ''
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return own },
    set(v) { el.__ownSet = (el.__ownSet ?? 0) + 1; own = v },
  })
  return el
}

/** 造一个够用的假 window（可只给部分能力，用来测退化路径）。 */
function makeWin(capabilities = {}) {
  const win = {
    getComputedStyle: (el) => el.__style ?? null,
    Event: class { constructor(type, init = {}) { Object.assign(this, { type }, init) } },
    KeyboardEvent: class { constructor(type, init = {}) { Object.assign(this, { type }, init) } },
  }
  // React 受控输入的原生 setter：故意只写在 `__native` 上，
  // 这样测试能分清「走了原型 setter」还是「直接赋了元素自己的 value」。
  function installInputProto(ctorName) {
    const proto = {}
    Object.defineProperty(proto, 'value', {
      configurable: true,
      set(v) { this.__native = v },
    })
    win[ctorName] = function () {}
    win[ctorName].prototype = proto
  }
  installInputProto('HTMLInputElement')
  installInputProto('HTMLTextAreaElement')
  for (const key of Object.keys(capabilities)) win[key] = capabilities[key]
  return win
}

function makeDoc(contains = true) {
  return { contains: () => contains }
}

console.log('\n== 1. isVisible：什么元素进快照 ==')
{
  const win = makeWin()
  const bridge = createA11yDomBridge(win, makeDoc())
  check('offsetParent 非空 → 可见', bridge.isVisible(makeEl()) === true)
  check('offsetParent 为空 + 非 fixed → 不可见',
    bridge.isVisible(makeEl({ offsetParent: null, style: { position: 'static' } })) === false)
  check('offsetParent 为空 + position:fixed（浮层/对话框）→ 可见',
    bridge.isVisible(makeEl({ offsetParent: null, style: { position: 'fixed' } })) === true)
  check('display:none → 不可见',
    bridge.isVisible(makeEl({ style: { display: 'none' } })) === false)
  check('visibility:hidden → 不可见',
    bridge.isVisible(makeEl({ style: { visibility: 'hidden' } })) === false)
  check('aria-hidden 子树 → 不可见（屏幕阅读器看不到的不该进快照）',
    bridge.isVisible(makeEl({ closestResults: { '[aria-hidden="true"]': {} } })) === false)
  check('null / 非对象 → 不可见且不抛错',
    bridge.isVisible(null) === false && bridge.isVisible(undefined) === false
    && bridge.isVisible('x') === false)
  check('getComputedStyle 抛错 → 退回 offsetParent 判据（不因环境异常全盲）',
    bridge.isVisible(makeEl({ offsetParent: null, style: { position: 'fixed' } })) === true
    && createA11yDomBridge({ getComputedStyle: () => { throw new Error('detached') } }, null)
      .isVisible(makeEl()) === true)
  check('完全没有 window → 只按 offsetParent 判，仍不抛错',
    createA11yDomBridge(null, null).isVisible(makeEl()) === true
    && createA11yDomBridge(null, null).isVisible(makeEl({ offsetParent: null })) === false)
}

console.log('\n== 2. ref 生命周期：record / infoFor / resolve / clear ==')
{
  const win = makeWin()
  const doc = makeDoc(true)
  const bridge = createA11yDomBridge(win, doc)
  const el = makeEl()
  const info = { ref: 'e1', role: 'button', name: '发送', tag: 'BUTTON' }
  bridge.record('e1', el, info)
  check('record 后 resolve 命中同一元素', bridge.resolve('e1') === el)
  check('record 后 infoFor 拿到可读描述（确认条要用）', bridge.infoFor('e1') === info)
  check('未知 ref → resolve null（调用方回 stale_ref）', bridge.resolve('e99') === null)
  check('未知 ref → infoFor null', bridge.infoFor('e99') === null)
  check('空 ref → 两者都 null 且不抛错',
    bridge.resolve(null) === null && bridge.infoFor(undefined) === null)

  // 元素已被卸载：document.contains 为假时不能放行（否则点到的是脱离 DOM 的节点）。
  const detachedDoc = makeDoc(false)
  const bridge2 = createA11yDomBridge(win, detachedDoc)
  bridge2.record('e1', el, info)
  check('元素不在 DOM 里 → resolve null', bridge2.resolve('e1') === null)

  // 快照里看不见（disabled 由执行端拒绝，这里只管可见性）。
  const hidden = makeEl({ style: { display: 'none' } })
  const bridge3 = createA11yDomBridge(win, doc)
  bridge3.record('e1', hidden, info)
  check('记录时可见、执行时已隐藏 → resolve null（执行前重新判一次）',
    bridge3.resolve('e1') === null)

  const bridge4 = createA11yDomBridge(win, doc)
  const a = makeEl()
  bridge4.record('e1', a, info)
  bridge4.clear()
  check('clear 后旧 ref 立即失效', bridge4.resolve('e1') === null && bridge4.infoFor('e1') === null)
  check('clear 会摘掉 DOM 上的 ref 标记（不留脏属性）', a.__removed.includes('data-dsh-voice-ref'))
  check('clear 可重复调用（第二次不抛错）', (() => { bridge4.clear(); return true })())

  // removeAttribute 抛错（节点已卸载）不能中断整次清理。
  const brittle = makeEl()
  brittle.removeAttribute = () => { throw new Error('detached') }
  const bridge5 = createA11yDomBridge(win, doc)
  bridge5.record('e1', brittle, info)
  bridge5.record('e2', makeEl(), info)
  let threw = false
  try { bridge5.clear() } catch { threw = true }
  check('某个元素摘标记失败 → 整表仍清空且不抛错',
    !threw && bridge5.resolve('e2') === null)
}

console.log('\n== 3. dispatchDomEvent：真构造器 / 退化对象 ==')
{
  const win = makeWin()
  const bridge = createA11yDomBridge(win, null)
  const el = makeEl()
  bridge.dispatchDomEvent(el, 'click', { bubbles: true })
  check('普通事件走 window.Event', el.__events.length === 1 && el.__events[0] instanceof win.Event)
  el.__events.length = 0
  bridge.dispatchDomEvent(el, 'keydown', { key: 'a' })
  bridge.dispatchDomEvent(el, 'keyup', { key: 'a' })
  check('keydown/keyup 走 window.KeyboardEvent（两个都必须是）',
    el.__events.length === 2
    && el.__events.every((e) => e instanceof win.KeyboardEvent))
  check('init 字段原样带上（按键动作靠它）', el.__events[0].key === 'a')

  const stub = makeEl()
  createA11yDomBridge(null, null).dispatchDomEvent(stub, 'input', { bubbles: true })
  check('没有 window → 退化对象仍派发，且带 preventDefault/stopPropagation',
    stub.__events.length === 1 && typeof stub.__events[0].preventDefault === 'function'
    && typeof stub.__events[0].stopPropagation === 'function' && stub.__events[0].bubbles === true)

  const noDispatch = { }
  let threw = false
  try { createA11yDomBridge(null, null).dispatchDomEvent(noDispatch, 'click') } catch { threw = true }
  check('桩元素没有 dispatchEvent → 忽略，不抛错', !threw)
}

console.log('\n== 4. setNativeInputValue：绕过 React 的 value tracker ==')
{
  const win = makeWin()
  const bridge = createA11yDomBridge(win, null)
  const input = makeEl({ tag: 'INPUT' })
  bridge.setNativeInputValue(input, '你好')
  check('input 走 HTMLInputElement 原型上的原生 setter', input.__native === '你好')
  check('原生 setter 确实把值写进去了', input.__native === '你好')
  check('没有走元素自己的 value 赋值（那种写法会被 React 的 value tracker 当成「没变」）',
    (input.__ownSet ?? 0) === 0)
  check('写完派发 input + change（React 受控输入要这两下才收得到）',
    input.__events.map((e) => e.type).join(',') === 'input,change')
  check('input/change 都带 bubbles', input.__events.every((e) => e.bubbles === true))

  const area = makeEl({ tag: 'TEXTAREA' })
  bridge.setNativeInputValue(area, '多行')
  check('textarea 走 HTMLTextAreaElement 原型', area.__native === '多行')

  // 没有 window（或原型取不到）→ 直接赋值，仍然派发事件。
  const fallback = makeEl({ tag: 'INPUT' })
  createA11yDomBridge(null, null).setNativeInputValue(fallback, '退化')
  check('没有原生 setter 也能写值并派发事件',
    fallback.value === '退化' && fallback.__events.length === 2)

  // 赋值本身抛错（只读元素）不能连带将事件派发炸掉。
  const broken = makeEl({ tag: 'INPUT' })
  Object.defineProperty(broken, 'value', { get() { return '' }, set() { throw new Error('readonly') } })
  let threw = false
  try { createA11yDomBridge(null, null).setNativeInputValue(broken, 'x') } catch { threw = true }
  check('写值抛错被吞掉，不冒泡给动作执行层', !threw)

  const nullish = makeEl({ tag: undefined })
  let threw2 = false
  try { bridge.setNativeInputValue(nullish, 'x') } catch { threw2 = true }
  check('tagName 缺失也不抛错', !threw2)
}

console.log('\n== 5. 状态隔离：两份桥互不干扰 ==')
{
  const win = makeWin()
  const a = createA11yDomBridge(win, makeDoc())
  const b = createA11yDomBridge(win, makeDoc())
  a.record('e1', makeEl(), { ref: 'e1' })
  check('浮层与另一份胶水各有各的 ref 表', a.resolve('e1') !== null && b.resolve('e1') === null)
  a.clear()
  check('一边 clear 不影响另一边', a.resolve('e1') === null)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
