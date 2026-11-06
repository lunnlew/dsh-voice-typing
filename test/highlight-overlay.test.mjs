/**
 * 朗读高亮覆盖层 —— 单元测试（批次 5d：从「扫客户端源码正则」改成直接驱动真工厂）。
 *
 * 用户反馈（2026-11-01）：「高亮条似乎会显示到弹框的上面？比如设置弹框出现，
 * 高亮条也会显示出在这上面」。
 *
 * 根因与修复（两道路）：
 *   1. 覆盖层 `z-index:900`：高于消息正文、低于 DSH 的 1000 级弹框/遮罩
 *      （原先是 `2147483647`，弹框打开时高亮照样盖在上面）；
 *   2. 检测到弹框打开时**直接隐藏覆盖层**（`[aria-modal="true"] / [role="dialog"] /
 *      [role="alertdialog"]` + MutationObserver 监听挂载/卸载，关闭后自动恢复并重画）。
 *   同源的另外两条反馈是「句子滚到输入框下面，高亮画在输入框上」和「滚出视口还在画」——
 *   Range 的矩形不受父级 `overflow:hidden` 影响，所以覆盖层必须自己裁剪到
 *   「会话滚动视口 ∩ 窗口 ∩ 底栏输入区以上」。
 *
 * 为什么这一版不再扫源码：
 *   这个文件原先是 13 条对 `clientSource()` 的正则 —— 判的是
 *   `const OVERLAY_Z_INDEX = 900`、`const x0 = Math.max(left, clip.left)` 这种**写法**：
 *   换个变量名、把模板串拆成两段、把裁剪的四行挪进一个 helper，它都会红；
 *   而真正出事的两件事（弹框开着还画色块、色块画到裁剪区外面）它一样都判不到。
 *   `createReadingHighlight(win, highlight)` 本来就是**注入 win** 的工厂
 *   （模块头写明「不引用任何浏览器全局」），所以给它一份假 window 就能原生调用，
 *   判它「注入了什么样式、弹框开着画不画、矩形裁成什么样、dispose 清没清干净」。
 *
 * 一处刻意的简化（不是漏判）：矩形的**来源**由测试直接喂（`doc.__rects`），
 * 浏览器里那是布局引擎的事；本文件判的是拿到矩形之后怎么裁、画不画、画成哪个尺寸。
 * 字符串对齐由 `pure/highlight.js` 自己承担（本文件用的是真对齐函数，所以那条链路也过了一遍），
 * 「产物里的高亮真的被朗读管道调起来」由 `client-behavior` 的场景 24 判。
 *
 * 批次 5d 学到的三条（第一轮有三处失手，改法都写在 §8.34 的 5d 实录）：
 *   - **左右交集那两条起初是空转的** —— 所有 fixture 的矩形都落在左右边界内，
 *     把 `x0/x1` 的 `Math.max/min` 删掉照样绿。所以这里刻意有一条「矩形比视口宽」和一条
 *     「整块在左右区外」；加几何用例时别只加上下越界的那种。
 *   - **诊断位会被第二条来源顶住** —— `clipped` 写的是 `Boolean(scrollEl) || chromeTop !== null`，
 *     带着底栏的用例里删掉滚动祖先它仍然为真；判「有没有找滚动祖先」那组必须 `composer: false`。
 *   - **别把字面量当契约** —— 样式那几条按 `selector{decl}` 解析后再取值/取声明，
 *     `display: none`（带空格）这类等价改写不该判红。
 *
 * 运行：node test/highlight-overlay.test.mjs
 */
import { createReadingHighlight } from '../src/client/pure/reading-highlight.js'
import { matchInNodes, collapseWhitespace, unescapeSpeechText } from '../src/client/pure/highlight.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/* ------------------------------------------------------------------ */
/* 假 DOM：只搭这个工厂用到的那几件事                                   */
/* ------------------------------------------------------------------ */

/**
 * 属性选择器匹配。用到的形态就三类：标签名、`[attr]`、`[attr="v"]` / `[attr*="v"]`，
 * 一组里可以连写多个条件（`[data-chat-flow-key][data-chat-flow-kind="assistant-step"]`），
 * 逗号分隔多组。**不实现**后代/兄弟组合 —— 这个模块没用到，实现了也没人判。
 */
function matchGroup(node, group) {
  if (!node.isElement) return false
  const tokens = String(group).trim().match(/^[a-zA-Z]+|\[[^\]]+\]/g) ?? []
  if (!tokens.length) return false
  for (const token of tokens) {
    if (token.startsWith('[')) {
      const bare = /^\[([a-zA-Z-]+)\]$/.exec(token)
      if (bare) {
        if (node.attr(bare[1]) === null) return false
        continue
      }
      const m = /^\[([a-zA-Z-]+)([*^$|]?=)"([^"]*)"\]$/.exec(token)
      if (!m) return false
      const [, name, op, value] = m
      const have = node.attr(name)
      if (have === null) return false
      if (op === '*=' ? !have.includes(value) : have !== value) return false
    } else if (node.tagName !== token.toUpperCase()) {
      return false
    }
  }
  return true
}

/**
 * 把注入的那份 CSS 拆成 `[{ selector, decl }]`。
 * 样式那几条判的是「选择器命中了谁、声明了什么」，不是字符串长什么样 ——
 * 写成 `display: none`（带空格）算等价，正则照抄整条规则会把这种合法改法判红。
 */
function cssRules(css) {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(String(css ?? '')))) out.push({ selector: m[1].trim(), decl: m[2].trim() })
  return out
}

function makeDoc() {
  let uid = 0
  const all = []

  const setConnected = (node, value) => {
    node.isConnected = value
    for (const child of node.childNodes ?? []) setConnected(child, value)
  }
  const textOf = (node) => (node.isElement
    ? node.childNodes.map(textOf).join('')
    : String(node.nodeValue ?? ''))
  const descendants = (root) => {
    const out = []
    const walk = (node) => { for (const child of node.childNodes ?? []) { out.push(child); walk(child) } }
    walk(root)
    return out
  }
  const kebab = (key) => `data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`

  const base = (tag) => {
    const node = {
      id: ++uid,
      isElement: true,
      tagName: String(tag).toUpperCase(),
      attrs: new Map(),
      childNodes: [],
      parentElement: null,
      isConnected: false,
      style: {},
      /** getComputedStyle 的返回值（测试按节点挂）。 */
      computed: null,
      /** 布局矩形（getBoundingClientRect 的返回值；没挂就是零矩形）。 */
      rect: null,
    }
    node.attr = (name) => (node.attrs.has(name) ? node.attrs.get(name) : null)
    node.setAttribute = (name, value) => { node.attrs.set(name, String(value)) }
    node.removeAttribute = (name) => { node.attrs.delete(name) }
    node.hasAttribute = (name) => node.attrs.has(name)
    node.appendChild = (child) => {
      child.parentElement = node
      node.childNodes.push(child)
      setConnected(child, true)
      return child
    }
    node.remove = () => {
      const parent = node.parentElement
      if (parent) {
        const at = parent.childNodes.indexOf(node)
        if (at >= 0) parent.childNodes.splice(at, 1)
      }
      node.parentElement = null
      setConnected(node, false)
    }
    Object.defineProperty(node, 'dataset', {
      get: () => new Proxy({}, {
        set: (_t, key, value) => { node.setAttribute(kebab(key), value); return true },
        get: (_t, key) => node.attr(kebab(key)),
      }),
    })
    Object.defineProperty(node, 'children', { get: () => node.childNodes.filter((c) => c.isElement) })
    Object.defineProperty(node, 'textContent', {
      get: () => textOf(node),
      set: (value) => {
        node.childNodes = String(value) === '' ? [] : [makeText(String(value), node)]
      },
    })
    node.getBoundingClientRect = () => node.rect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    all.push(node)
    return node
  }
  const makeText = (value, parent) => {
    const node = { isElement: false, nodeValue: value, parentElement: parent ?? null, isConnected: true }
    all.push(node)
    return node
  }

  const doc = {
    __all: all,
    documentElement: null,
    body: null,
    head: null,
    createElement: (tag) => base(tag),
    /**
     * 全树文档序里第一个匹配任一分组的节点。
     * （按分组各扫一遍会挑出「第二组里更靠前的那个」，弹框那条判据要的是文档序。）
     */
    querySelector(sel) {
      const groups = String(sel).split(',')
      for (const node of descendants(doc.documentElement)) {
        if (groups.some((group) => matchGroup(node, group))) return node
      }
      return null
    },
    querySelectorAll(sel) {
      const groups = String(sel).split(',')
      return descendants(doc.documentElement).filter((node) => groups.some((g) => matchGroup(node, g)))
    },
    createTreeWalker(root, _what, filter) {
      const texts = descendants(root).filter((n) => !n.isElement)
      const kept = filter && typeof filter.acceptNode === 'function'
        ? texts.filter((n) => filter.acceptNode(n) === doc.__win.NodeFilter.FILTER_ACCEPT)
        : texts
      let at = 0
      return { nextNode: () => (at < kept.length ? kept[at++] : null), kept }
    },
    /**
     * Range 只用到 `setStart/setEnd/getClientRects`。
     * 浏览器里 getClientRects 是布局的结果，这里由测试直接给（`doc.__rects`）。
     */
    createRange() {
      return { setStart() {}, setEnd() {}, getClientRects: () => doc.__rects ?? [] }
    },
    /** 造一个元素 + 若干文本子节点（rect 顺手把 width/height 补齐）。 */
    el(tag, { attrs = {}, text = [], rect = null, computed = null } = {}) {
      const node = base(tag)
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
      for (const t of text) node.appendChild(makeText(t, node))
      if (rect) node.rect = { ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top }
      if (computed) node.computed = computed
      return node
    },
  }
  doc.documentElement = base('html')
  doc.body = base('body')
  doc.head = base('head')
  doc.documentElement.appendChild(doc.head)
  doc.documentElement.appendChild(doc.body)
  doc.documentElement.parentElement = null
  return doc
}

function makeWin(doc) {
  const observers = []
  const listeners = []
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; this.observed = null; this.disconnected = false; observers.push(this) }
    observe(target, options) { this.observed = { target, options } }
    disconnect() { this.disconnected = true }
    /** 模拟一次 DOM 变化（真实浏览器里由布局/渲染那边回调）。 */
    trigger() { this.cb([]) }
  }
  const win = {
    document: doc,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    MutationObserver: FakeMutationObserver,
    innerWidth: 1000,
    innerHeight: 800,
    getComputedStyle: (node) => node.computed ?? {},
    // 同步执行**并返回 0**：本文件判的是「每次 render 画成什么样」，不判帧调度去重。
    // 返回非 0 会让模块里的 `if (raf) return` 把后面每次 set() 都吃掉 —— 浏览器里那次
    // 回调是异步落地的（落地时自己把 raf 清零），这里回调已经当场跑过了。
    requestAnimationFrame: (fn) => { fn(); return 0 },
    cancelAnimationFrame() {},
    addEventListener: (type, fn, capture) => { listeners.push({ type, fn, capture: Boolean(capture) }) },
    removeEventListener: (type, fn) => {
      const at = listeners.findIndex((l) => l.type === type && l.fn === fn)
      if (at >= 0) listeners.splice(at, 1)
    },
    console: { debug: () => {} },
    __observers: observers,
    __listeners: listeners,
  }
  doc.__win = win
  return win
}

const HIGHLIGHT = { matchInNodes, collapseWhitespace, unescapeSpeechText }
const STYLE_SELECTOR = 'style[data-plugin-css="dsh-voice-reading-style"]'
const SENTENCE = '第一句被朗读的话。'

/**
 * 搭一个「有一条正在朗读的句子」的最小现场。
 *
 * @param {object} opts
 *   viewport  给不给 overflow-y:auto 的滚动祖先（视口 0,120 → 900,600）
 *   composer  给不给底栏输入区（默认给：下半屏 40,650 → 960,760）
 *   topSearch 额外给一个上半屏、data-slot 里也带 composer 字样的搜索框
 */
function setup(opts = {}) {
  const doc = makeDoc()
  const win = makeWin(doc)
  const container = doc.el('div', {
    attrs: { 'data-step-process-content': '' },
    text: [SENTENCE, '第二句不朗读。'],
    rect: { left: 20, top: 200, right: 700, bottom: 260 },
  })
  let mount = container
  if (opts.viewport) {
    const viewport = doc.el('div', {
      attrs: { 'data-scroll': '' },
      rect: { left: 0, top: 120, right: 900, bottom: 600 },
      computed: { overflowY: 'auto' },
    })
    viewport.appendChild(container)
    mount = viewport
  }
  doc.body.appendChild(mount)
  if (opts.composer !== false) {
    doc.body.appendChild(doc.el('textarea', { rect: { left: 40, top: 650, right: 960, bottom: 760 } }))
  }
  if (opts.topSearch) {
    doc.body.appendChild(doc.el('input', {
      attrs: { 'data-slot': 'top-search-composer' },
      rect: { left: 40, top: 30, right: 400, bottom: 70 },
    }))
  }
  doc.__rects = [container.getBoundingClientRect()]
  const ctrl = createReadingHighlight(win, HIGHLIGHT)
  return {
    doc,
    win,
    container,
    ctrl,
    layer: () => doc.querySelector('[data-voice-reading-overlay]'),
    spans: () => { const l = doc.querySelector('[data-voice-reading-overlay]'); return l ? l.children : [] },
    styleTag: () => doc.querySelector(STYLE_SELECTOR),
    /** 挂一个弹框进 body 并触发一次「DOM 变了」。 */
    openModal: (attrs) => {
      const dialog = doc.el('div', { attrs, rect: { left: 0, top: 0, right: 1000, bottom: 800 } })
      doc.body.appendChild(dialog)
      win.__observers.forEach((o) => o.trigger())
      return dialog
    },
    closeModal: (dialog) => { dialog.remove(); win.__observers.forEach((o) => o.trigger()) },
  }
}

/* ================================================================== */
/* 1. 层级：注入的样式必须是 900，旧的 max z-index 要被就地改掉          */
/* ================================================================== */
console.log('\n== 1. 覆盖层样式（低于弹框/遮罩）==')
{
  const env = setup()
  env.ctrl.set(SENTENCE)
  const css = env.styleTag()?.textContent ?? ''
  const rules = cssRules(css)
  const overlayRule = rules.find((r) => r.selector === '[data-voice-reading-overlay]')
  const hiddenRule = rules.find((r) =>
    r.selector.includes('data-voice-reading-overlay') && r.selector.includes('data-voice-reading-hidden'))
  check('set() 之后 head 里有那份样式标签（按 data-plugin-css 找得到，父级是 head）',
    env.styleTag() !== null && env.styleTag().parentElement === env.doc.head,
    String(env.styleTag()?.parentElement?.tagName))
  check('样式里覆盖层用的是 z-index:900（高于正文、低于 DSH 的 1000 级浮层）',
    /z-index:\s*(\d+)/.exec(overlayRule?.decl ?? '')?.[1] === '900',
    JSON.stringify({ selector: overlayRule?.selector, decl: overlayRule?.decl, css }))
  check('样式里不再出现整型最大值（2147483647 会盖住设置弹框）',
    !/2147483647/.test(css), css)
  check('样式里有「隐藏态」规则：带 data-voice-reading-hidden 就不显示',
    hiddenRule !== undefined && /display:\s*none\b/.test(hiddenRule.decl),
    JSON.stringify({ selector: hiddenRule?.selector, decl: hiddenRule?.decl, rules }))

  // 升级现场：页面没刷新，head 里躺着旧版本注入的那份样式（z-index 还是最大值）。
  const env2 = setup()
  const stale = env2.doc.el('style', { attrs: { 'data-plugin-css': 'dsh-voice-reading-style' } })
  stale.textContent = '[data-voice-reading-overlay]{position:fixed;inset:0;z-index:2147483647;}'
  env2.doc.head.appendChild(stale)
  check('预置的旧样式被认出来（querySelector 找到的是同一份，不是另建一个）',
    env2.styleTag() === stale, `${env2.styleTag()?.id}/${stale.id}`)
  env2.ctrl.set(SENTENCE)
  check('旧样式被就地改掉（页面没刷新也能生效）',
    stale.parentElement === env2.doc.head && /z-index:\s*900/.test(stale.textContent)
      && !/2147483647/.test(stale.textContent), stale.textContent)
  check('改的是同一个标签，没有再插第二份',
    env2.doc.querySelectorAll(STYLE_SELECTOR).length === 1,
    String(env2.doc.querySelectorAll(STYLE_SELECTOR).length))
}

/* ================================================================== */
/* 2. 弹框打开时：隐藏覆盖层、一个色块都不画；关闭后恢复并重画          */
/* ================================================================== */
console.log('\n== 2. 宿主弹框打开时不画高亮 ==')
{
  const env = setup()
  env.ctrl.set(SENTENCE)
  check('没有弹框时覆盖层不带隐藏属性',
    env.layer() !== null && !env.layer().hasAttribute('data-voice-reading-hidden'),
    JSON.stringify([...env.layer().attrs.keys()]))
  check('没有弹框时正常画出了色块（下面几条的对照组）',
    env.spans().length > 0, String(env.spans().length))

  const watch = env.win.__observers[0]
  check('弹框状态用 MutationObserver 盯 body，observe 带的那份 options 就是契约',
    watch?.observed?.target === env.doc.body
      && watch?.observed?.options?.childList === true
      && watch?.observed?.options?.subtree === true
      && watch?.observed?.options?.attributes === true
      && String(watch?.observed?.options?.attributeFilter) === 'role,aria-modal,hidden,style',
    JSON.stringify(watch?.observed?.options))

  for (const [label, attrs] of [
    ['role="dialog"', { role: 'dialog' }],
    ['role="alertdialog"', { role: 'alertdialog' }],
    ['aria-modal="true"', { 'aria-modal': 'true' }],
  ]) {
    const e = setup()
    e.ctrl.set(SENTENCE)
    const dialog = e.openModal(attrs)
    check(`弹框检测认 ${label}：隐藏属性挂上，诊断 modalOpen 为真`,
      e.layer().hasAttribute('data-voice-reading-hidden') && e.ctrl.getState().modalOpen === true,
      JSON.stringify(e.ctrl.getState()))
    e.ctrl.set(SENTENCE)
    check(`弹框（${label}）开着期间一个色块都不画`,
      e.spans().length === 0 && e.ctrl.getState().rectCount === 0,
      JSON.stringify({ spans: e.spans().length, ...e.ctrl.getState() }))
    e.closeModal(dialog)
    e.ctrl.set(SENTENCE)
    check(`弹框（${label}）关掉后隐藏属性摘掉并重新画出来`,
      !e.layer().hasAttribute('data-voice-reading-hidden') && e.ctrl.getState().modalOpen === false
        && e.spans().length > 0,
      JSON.stringify({ spans: e.spans().length, ...e.ctrl.getState() }))
  }

  // 关闭当前这句还在读：恢复不该等下一句才生效。
  const env3 = setup()
  env3.ctrl.set(SENTENCE)
  const dialog3 = env3.openModal({ role: 'dialog' })
  env3.ctrl.set(SENTENCE)
  check('弹框开着期间确实没画东西（重画前的对照组）',
    env3.spans().length === 0, String(env3.spans().length))
  env3.closeModal(dialog3)
  check('关闭后当前这句自动重画（不用等下一句，且层真的可见）',
    env3.spans().length > 0 && !env3.layer().hasAttribute('data-voice-reading-hidden'),
    JSON.stringify({ spans: env3.spans().length, ...env3.ctrl.getState() }))
}

/* ================================================================== */
/* 3. 裁剪：滚动视口 ∩ 窗口 ∩ 底栏输入区以上                           */
/* ================================================================== */
console.log('\n== 3. 裁剪到会话滚动视口 ==')
{
  // 视口 0,120 → 900,600；不给底栏（否则 clipped 会被底栏兜住，判不出「有没有找滚动祖先」）；
  // 矩形 20,100 → 700,200（上半越界）。
  const env = setup({ viewport: true, composer: false })
  env.container.rect = { left: 20, top: 100, right: 700, bottom: 200, width: 680, height: 100 }
  env.doc.__rects = [{ left: 20, top: 100, right: 700, bottom: 200 }]
  env.ctrl.set(SENTENCE)
  const drawn = env.spans()[0]
  check('往上找到 overflow-y:auto 的滚动祖先并据此裁剪（诊断 clipped 为真）',
    env.ctrl.getState().clipped === true, JSON.stringify(env.ctrl.getState()))
  check('色块裁成「矩形 ∩ 裁剪区」：上边界收到视口 top=120，左右仍按矩形',
    drawn?.style.left === '20px' && drawn?.style.top === '120px'
      && drawn?.style.width === '680px' && drawn?.style.height === '80px',
    JSON.stringify({ left: drawn?.style.left, top: drawn?.style.top, width: drawn?.style.width, height: drawn?.style.height }))

  // 整块都在视口外（滚到视口下方）：不画，并记进 skippedRects 诊断。
  const env2 = setup({ viewport: true })
  env2.doc.__rects = [{ left: 20, top: 620, right: 700, bottom: 640 }]
  env2.ctrl.set(SENTENCE)
  check('完全在裁剪区外的矩形一个都不画（这就是「画到输入框上面」那条反馈的根因）',
    env2.spans().length === 0, JSON.stringify({ spans: env2.spans().length, ...env2.ctrl.getState() }))
  check('被裁掉的矩形数进了诊断（装机上「为什么没高亮」就看这个）',
    env2.ctrl.getState().skippedRects === 1, JSON.stringify(env2.ctrl.getState()))

  // 底栏输入区的顶部是下边界。
  const env3 = setup({ viewport: false })
  env3.doc.__rects = [{ left: 20, top: 500, right: 700, bottom: 900 }]
  env3.ctrl.set(SENTENCE)
  check('没有滚动祖先时按「视口 ∩ 底栏输入区以上」裁：底栏顶 650 成为下边界',
    env3.ctrl.getState().clipped === true && env3.spans()[0]?.style.height === '150px',
    JSON.stringify({ height: env3.spans()[0]?.style.height, ...env3.ctrl.getState() }))

  // 上半屏那个也叫 composer 的东西不能被当成底栏（否则整页高亮都被裁没）。
  const env4 = setup({ viewport: false, topSearch: true })
  env4.doc.__rects = [{ left: 20, top: 200, right: 700, bottom: 300 }]
  env4.ctrl.set(SENTENCE)
  check('只认下半屏的输入区：上半屏那个 data-slot 里带 composer 的搜索框不算底栏',
    env4.spans().length === 1 && env4.spans()[0].style.top === '200px'
      && env4.spans()[0].style.height === '100px',
    JSON.stringify({ top: env4.spans()[0]?.style.top, height: env4.spans()[0]?.style.height }))

  // 又窄又矮的输入元素不算底栏。
  const env5 = setup({ viewport: false, composer: false })
  env5.doc.body.appendChild(env5.doc.el('textarea', { rect: { left: 800, top: 700, right: 820, bottom: 705 } }))
  env5.doc.__rects = [{ left: 20, top: 500, right: 700, bottom: 780 }]
  env5.ctrl.set(SENTENCE)
  check('宽度不足 100 或高度不足 10 的输入区不当底栏（下边界仍是视口 800）',
    env5.spans()[0]?.style.height === '280px',
    JSON.stringify({ height: env5.spans()[0]?.style.height, ...env5.ctrl.getState() }))

  // 既没有滚动祖先也没有底栏：裁剪区就是整个视口。
  const env6 = setup({ viewport: false, composer: false })
  env6.doc.__rects = [{ left: 20, top: 200, right: 700, bottom: 300 }]
  env6.ctrl.set(SENTENCE)
  check('没有滚动祖先也没有底栏时按整个视口，一块都不裁',
    env6.ctrl.getState().clipped === false && env6.spans()[0]?.style.top === '200px'
      && env6.spans()[0]?.style.height === '100px',
    JSON.stringify({ height: env6.spans()[0]?.style.height, ...env6.ctrl.getState() }))

  // 多个矩形：裁完各画各的（一段跨行的句子会有好几块）。
  const env7 = setup({ viewport: true })
  env7.container.rect = { left: 20, top: 200, right: 700, bottom: 260, width: 680, height: 60 }
  env7.doc.__rects = [
    { left: 20, top: 200, right: 700, bottom: 230 },
    { left: 20, top: 240, right: 400, bottom: 260 },
  ]
  env7.ctrl.set(SENTENCE)
  check('跨行的若干矩形各裁各画（两块都在视口内时两块都画）',
    env7.spans().length === 2 && env7.spans()[1].style.width === '380px',
    JSON.stringify(env7.spans().map((s) => `${s.style.top}+${s.style.height}`)))

  // 横向也要取交集：上面几条的矩形都在左右边界内，把 x 方向的 Math.max/min 删掉照样绿。
  // 会话视口左边让出 100px（侧栏）、右边到 800，矩形比它宽 → 色块必须收进 100..800。
  const env8 = setup({ viewport: true, composer: false })
  const scrollEl = env8.doc.querySelector('[data-scroll]')
  scrollEl.rect = { left: 100, top: 120, right: 800, bottom: 600 }
  env8.container.rect = { left: 100, top: 200, right: 800, bottom: 260 }
  env8.doc.__rects = [{ left: 20, top: 200, right: 950, bottom: 230 }]
  env8.ctrl.set(SENTENCE)
  const wide = env8.spans()[0]
  check('横向越界也要取交集：矩形比滚动视口宽时色块收到视口左右边',
    wide?.style.left === '100px' && wide?.style.width === '700px',
    JSON.stringify({ left: wide?.style.left, width: wide?.style.width, ...env8.ctrl.getState() }))

  // 整块都在左边/右边外面：横向也该丢掉（不只是上下）。
  const env9 = setup({ viewport: true, composer: false })
  const scrollEl9 = env9.doc.querySelector('[data-scroll]')
  scrollEl9.rect = { left: 100, top: 120, right: 800, bottom: 600 }
  env9.container.rect = { left: 100, top: 200, right: 800, bottom: 260 }
  env9.doc.__rects = [{ left: 850, top: 200, right: 950, bottom: 230 }]
  env9.ctrl.set(SENTENCE)
  check('整块在左右裁剪区外的矩形也不画（skippedRects 记账）',
    env9.spans().length === 0 && env9.ctrl.getState().skippedRects === 1,
    JSON.stringify({ spans: env9.spans().length, ...env9.ctrl.getState() }))
}

/* ================================================================== */
/* 4. 收尾：dispose 把挂上去的东西拆干净                               */
/* ================================================================== */
console.log('\n== 4. dispose / clear 的清理 ==')
{
  const env = setup({ viewport: true })
  env.ctrl.set(SENTENCE)
  check('朗读期间挂了 scroll/resize 监听（滚动时得重算矩形）',
    env.win.__listeners.length >= 2
      && env.win.__listeners.some((l) => l.type === 'scroll' && l.capture === true)
      && env.win.__listeners.some((l) => l.type === 'resize'),
    JSON.stringify(env.win.__listeners.map((l) => `${l.type}${l.capture ? '@capture' : ''}`)))
  env.ctrl.clear()
  check('clear() 摘掉监听并清空色块（不再朗读就不该继续画）',
    env.win.__listeners.length === 0 && env.spans().length === 0,
    JSON.stringify({ listeners: env.win.__listeners.length, spans: env.spans().length }))

  env.ctrl.set(SENTENCE)
  const layerNode = env.layer()
  check('再朗读一次：覆盖层与样式都还在（clear 之后可复用）',
    layerNode !== null && env.styleTag() !== null && env.spans().length > 0,
    JSON.stringify({ layer: layerNode !== null, style: env.styleTag() !== null }))
  env.ctrl.dispose()
  check('dispose 断开弹框监听',
    env.win.__observers.length > 0 && env.win.__observers.every((o) => o.disconnected === true),
    JSON.stringify(env.win.__observers.map((o) => o.disconnected)))
  check('dispose 从 body 摘掉覆盖层',
    layerNode.isConnected === false && env.layer() === null,
    JSON.stringify(env.doc.body.children.map((c) => c.tagName)))
  check('dispose 移除注入的样式标签',
    env.styleTag() === null, String(env.styleTag()?.textContent).slice(0, 40))
  check('dispose 之后监听也没了（不会再自己爬起来画）',
    env.win.__listeners.length === 0, JSON.stringify(env.win.__listeners.length))
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exitCode = fail ? 1 : 0
