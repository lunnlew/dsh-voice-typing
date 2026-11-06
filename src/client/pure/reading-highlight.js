/**
 * 朗读高亮覆盖层工厂（DOM 胶水，但**不引用任何浏览器全局**）。
 *
 * 为什么单独成文件：
 *   原先内联在 `main.js`（原 964–1348 行区间）。它只通过参数 `win` 摸 DOM，
 *   形状上早就是 `pure/*` 约定的样子，留在巨石文件里只是没搬。
 *   字符串对齐那部分仍在 `pure/highlight.js`，本文件只负责
 *   「定位容器 → 收集文本节点 → 建 Range → 取矩形 → 画色块」。
 *
 * 引用方向（本仓库的硬规则：**单向**）：
 *   本文件不引用 `main.js` 的任何符号，也不 import 其它 pure 文件
 *   —— `main.js` 的纯文件内联是**顺序敏感**的隐式全局，回头依赖一旦分叉
 *   不会有任何编译期信号。它对 `pure/highlight.js` 三个函数的依赖
 *   因此改成**显式注入**（第二个参数），由调用方决定给哪一套对齐逻辑。
 *
 * 为什么用注入的 `win` 而不是全局：
 *   纯文件必须能在 Node 里原生 import（测试要直接调用本工厂），
 *   `window` / `document` / `navigator` 出现在文件里就会被 bundle-sync 拦下。
 *
 * @module pure/reading-highlight
 */

/**
 * 朗读高亮覆盖层控制器（见文件头的引用方向说明）。
 *
 * 完全不碰消息 DOM（`main.js` 里 `readingHighlightRef` 处说明了为什么）。
 * 字符串对齐由注入的 `highlight` 提供，这里负责：
 *   定位当前回复容器 → 收集文本节点 → 找命中区间 → 建 Range →
 *   取矩形 → 在 fixed 覆盖层里画半透明色块。
 *
 * @param {object} win - 浏览器 window（注入以便在其它环境里复用/测试）。
 * @param {{ matchInNodes: Function, collapseWhitespace: Function, unescapeSpeechText: Function }} highlight
 *   `pure/highlight.js` 的三个对齐函数，由调用方显式注入。
 * @returns {{ set(text: string): void, clear(): void, dispose(): void, getState(): object }}
 */
export function createReadingHighlight(win, highlight) {
  const { matchInNodes, collapseWhitespace, unescapeSpeechText } = highlight
  const doc = win.document
  const STYLE_ID = 'dsh-voice-reading-style'
  /** 覆盖层：fixed、盖满视口、不拦截事件，色块放它里面。 */
  let layer = null
  /** 是否在活跃（正在朗读）。 */
  let active = false
  /** 当前要高亮的句子文本（已还原、未归一化）。 */
  let currentText = ''
  /** 节流用的 rAF 句柄。 */
  let raf = 0
  /** 绑定到 window 的滚动/缩放监听（活跃时才挂）。 */
  let boundScroll = null

  /** 最近一次 render 的诊断结果（挂到 __DSH_VOICE_DEBUG__ 里排查「为什么没高亮」）。 */
  const diag = {
    active: false,
    target: '',
    containerCount: 0,
    foundContainer: false,
    matchCount: -1,
    rectCount: 0,
    layerChildren: 0,
    /** 宿主弹框/遮罩是否打开（打开时覆盖层隐藏，避免画在弹框上面）。 */
    modalOpen: false,
    /** 是否按「会话滚动视口 ∩（底栏输入区以上）」裁剪过高亮。 */
    clipped: false,
    /** 因裁剪被完全丢掉的矩形数（这一句滚出视口/滚到输入框下面时 > 0）。 */
    skippedRects: 0,
    error: '',
  }

  /**
   * 覆盖层 z-index。
   *
   * 不能取整型最大值：DSH 的弹框/遮罩是 `z-index:1000` 级别的浮层，
   * 覆盖层如果取 `2147483647`，**设置弹框打开时高亮会画在弹框上面**（用户反馈）。
   * 取 900：高于消息正文（正文没有 z-index），低于弹框（1000+）。
   * 另外还有一道保险：检测到弹框打开时直接隐藏覆盖层（见 syncModal）。
   */
  const OVERLAY_Z_INDEX = 900

  const ensureStyle = () => {
    const css = [
      `[data-voice-reading]{position:absolute;pointer-events:none;background:rgba(255,214,0,.32);border-radius:2px;}`,
      `[data-voice-reading-overlay]{position:fixed;inset:0;pointer-events:none;z-index:${OVERLAY_Z_INDEX};}`,
      `[data-voice-reading-overlay][data-voice-reading-hidden]{display:none;}`,
    ].join('\n')
    const existing = doc.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
    if (existing) {
      // 旧版本注入的是 z-index:2147483647 —— 升级后要把已存在的样式改过来，
      // 否则页面没刷新时会继续盖在弹框上面。
      if (existing.textContent !== css) existing.textContent = css
      return
    }
    const tag = doc.createElement('style')
    tag.dataset.pluginCss = STYLE_ID
    tag.textContent = css
    doc.head.appendChild(tag)
  }

  /** 宿主弹框/遮罩是否打开。 */
  let modalOpen = false
  /** 监视弹框打开/关闭的 MutationObserver。 */
  let modalObserver = null

  const hasOpenModal = () => {
    try {
      return Boolean(doc.querySelector(
        '[aria-modal="true"], [role="dialog"], [role="alertdialog"]',
      ))
    } catch {
      return false
    }
  }

  /** 弹框状态变化：隐藏/恢复覆盖层（打开时绝不能画在弹框上面）。 */
  const syncModal = () => {
    const nowOpen = hasOpenModal()
    const applyHidden = () => {
      if (!layer) return
      if (modalOpen) layer.setAttribute('data-voice-reading-hidden', '')
      else layer.removeAttribute('data-voice-reading-hidden')
    }
    if (nowOpen === modalOpen) {
      // 状态没变也要对齐一次 DOM（layer 可能刚被重建，属性丢了）。
      applyHidden()
      return
    }
    modalOpen = nowOpen
    diag.modalOpen = modalOpen
    applyHidden()
    if (!modalOpen && active && currentText) scheduleRender()
  }

  const ensureModalWatch = () => {
    if (modalObserver) return
    try {
      modalObserver = new win.MutationObserver(() => syncModal())
      modalObserver.observe(doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['role', 'aria-modal', 'hidden', 'style'],
      })
    } catch { /* 老环境没有 MutationObserver：只靠 z-index 兜底 */ }
    syncModal()
  }

  const ensureLayer = () => {
    if (layer && layer.isConnected) return layer
    layer = doc.createElement('div')
    layer.setAttribute('data-voice-reading-overlay', '')
    doc.body.appendChild(layer)
    return layer
  }

  const clear = () => {
    if (layer) layer.textContent = ''
  }

  /** 收集容器里非空的文本节点（按文档顺序）。 */
  const collectTextNodes = (root) => {
    const nodes = []
    const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const v = node.nodeValue
        return v && v.trim() !== '' ? win.NodeFilter.FILTER_ACCEPT : win.NodeFilter.FILTER_REJECT
      },
    })
    let node
    while ((node = walker.nextNode())) nodes.push(node)
    return nodes
  }

  /**
   * 定位当前回复容器。
   *
   * 实测（2026-11-01）发现：**正在流式输出的助手回复并不在
   * `[data-step-process-content]` 里**，而是在
   * `[data-chat-flow-kind="assistant-step"]`（更精确）或外层
   * `[data-chat-flow]` / `[data-slot="conversation.chat.flow"]` 里。
   * 只搜 `[data-step-process-content]` 会漏掉「当前正在朗读的那一句」，
   * 于是 foundContainer=false、什么都不高亮。
   *
   * 所以这里搜三类候选，凡是归一化后包含目标句的都收进来，
   * 然后取 **textContent 最短**（最深层、最精确）的那个容器。
   * 这样：新回复命中 assistant-step；已归档回复命中
   * data-step-process-content；都能拿到精确的矩形。
   *
   * @param {string} targetNorm - 已归一化的目标句。
   * @returns {Element|null}
   */
  const findContainer = (targetNorm) => {
    const sel = [
      '[data-step-process-content]',
      '[data-chat-flow-key][data-chat-flow-kind="assistant-step"]',
      '[data-chat-flow]',
      '[data-slot="conversation.chat.flow"]',
    ].join(',')
    const candidates = doc.querySelectorAll(sel)
    let best = null
    let bestLen = Infinity
    for (const el of candidates) {
      const txt = collapseWhitespace(el.textContent ?? '')
      if (txt.includes(targetNorm) && txt.length < bestLen) {
        best = el
        bestLen = txt.length
      }
    }
    return best
  }

  /**
   * 找「会话滚动视口」：从消息容器往上找 `overflow-y:auto/scroll/overlay` 的祖先。
   *
   * 为什么需要：消息滚出视口后，Range/元素矩形**仍然会报原位置**
   * （父级的 `overflow:hidden` 只是视觉裁掉），于是固定在视口的覆盖层会把
   * 高亮画到**输入框/顶栏上面**（用户反馈：滚动到输入框下方，高亮显示在输入框上）。
   * 所以覆盖层必须自己裁剪到滚动视口。
   */
  const findScrollViewport = (el) => {
    let node = el
    while (node && node !== doc.body && node !== doc.documentElement) {
      try {
        const style = typeof win.getComputedStyle === 'function' ? win.getComputedStyle(node) : null
        if (style && /auto|scroll|overlay/.test(style.overflowY)) return node
      } catch { /* 忽略 */ }
      node = node.parentElement
    }
    return null
  }

  /**
   * 底部输入区（composer）的顶部；找不到返回 null。
   *
   * 只认「下半屏、够宽」的输入元素，避免把顶栏的搜索框当成底栏把高亮裁没了。
   */
  const findBottomChromeTop = () => {
    let top = null
    try {
      const els = doc.querySelectorAll(
        '[data-slot*="composer"], [data-testid*="composer"], textarea, [contenteditable="true"]',
      )
      const vh = win.innerHeight || 0
      for (const el of els) {
        const r = el.getBoundingClientRect()
        if (r.width < 100 || r.height < 10) continue
        if (vh && r.top < vh * 0.5) continue
        if (top === null || r.top < top) top = r.top
      }
    } catch { /* 忽略 */ }
    return top
  }

  /** 高亮允许出现的区域：滚动视口 ∩ 窗口 ∩（底栏输入区以上）。 */
  const computeClipRect = (container) => {
    const vw = win.innerWidth || 0
    const vh = win.innerHeight || 0
    const clip = { left: 0, top: 0, right: vw, bottom: vh }
    const scrollEl = findScrollViewport(container)
    if (scrollEl) {
      try {
        const r = scrollEl.getBoundingClientRect()
        clip.left = Math.max(clip.left, r.left)
        clip.top = Math.max(clip.top, r.top)
        clip.right = Math.min(clip.right, r.right)
        clip.bottom = Math.min(clip.bottom, r.bottom)
      } catch { /* 忽略 */ }
    }
    const chromeTop = findBottomChromeTop()
    if (chromeTop !== null && Number.isFinite(chromeTop)) {
      clip.bottom = Math.min(clip.bottom, chromeTop)
    }
    diag.clipped = Boolean(scrollEl) || chromeTop !== null
    return clip
  }

  /** 画一个矩形色块（视口坐标 → fixed 层内的绝对定位；先按 `clip` 裁剪）。 */
  const drawRect = (rect, clip) => {
    if (!rect) return
    const left = Number(rect.left) || 0
    const top = Number(rect.top) || 0
    const right = Number.isFinite(rect.right) ? rect.right : left + (Number(rect.width) || 0)
    const bottom = Number.isFinite(rect.bottom) ? rect.bottom : top + (Number(rect.height) || 0)
    const x0 = Math.max(left, clip.left)
    const x1 = Math.min(right, clip.right)
    const y0 = Math.max(top, clip.top)
    const y1 = Math.min(bottom, clip.bottom)
    // 整块都在可视区外（比如这一句已经滚到输入框下面/顶栏上面）：不画。
    if (x1 - x0 <= 0 || y1 - y0 <= 0) {
      diag.skippedRects += 1
      return
    }
    const span = doc.createElement('span')
    span.setAttribute('data-voice-reading', '')
    span.style.left = `${x0}px`
    span.style.top = `${y0}px`
    span.style.width = `${x1 - x0}px`
    span.style.height = `${y1 - y0}px`
    layer.appendChild(span)
  }

  /** 从矩形集合画色块（按会话滚动视口裁剪，绝不画到视口外）。 */
  const drawRects = (rects, clip) => {
    clear()
    diag.skippedRects = 0
    for (const rect of rects) drawRect(rect, clip)
  }

  /** 重算当前句的矩形并重画（滚动/重排时也调用）。 */
  const render = () => {
    raf = 0
    if (!active || !currentText) return
    // 弹框/遮罩打开时不画高亮（z-index 再低也可能遇到高浮层；直接隐藏最稳）。
    if (modalOpen) {
      clear()
      diag.rectCount = 0
      diag.layerChildren = 0
      return
    }
    diag.active = true
    diag.target = currentText
    diag.error = ''
    const targetNorm = collapseWhitespace(unescapeSpeechText(currentText))
    if (!targetNorm) { clear(); diag.error = 'empty-target'; return }
    const container = findContainer(targetNorm)
    diag.containerCount = doc.querySelectorAll('[data-step-process-content],[data-chat-flow-key][data-chat-flow-kind="assistant-step"],[data-chat-flow],[data-slot="conversation.chat.flow"]').length
    diag.foundContainer = !!container
    if (!container) {
      clear()
      diag.error = 'no-container'
      win.console.debug(`[dsh-voice-typing] 高亮：找不到含目标句的容器（共 ${diag.containerCount} 个候选），target="${targetNorm.slice(0, 40)}"`)
      return
    }
    const textNodes = collectTextNodes(container)
    const ranges = matchInNodes(textNodes.map((n) => n.nodeValue), targetNorm)
    diag.matchCount = ranges ? ranges.length : 0
    // 高亮只能出现在「会话滚动视口 ∩ 底栏输入区以上」：
    // 已经滚出视口/滚到输入框下面的句子不画（用户反馈：会画到输入框上面）。
    const clip = computeClipRect(container)
    if (!ranges) {
      win.console.debug(`[dsh-voice-typing] 高亮：目标句在容器内匹配不上，降级为整段高亮。target="${targetNorm.slice(0, 40)}"`)
    }
    if (!ranges || !ranges.length) {
      // 整句匹配不上（跨块/软换行错位）→ 降级：整段浅高亮。
      const rect = container.getBoundingClientRect()
      drawRects([rect], clip)
      diag.rectCount = layer ? layer.children.length : 0
      diag.layerChildren = layer ? layer.children.length : 0
      return
    }
    try {
      const range = doc.createRange()
      const first = ranges[0]
      const last = ranges[ranges.length - 1]
      range.setStart(textNodes[first.nodeIndex], first.start)
      range.setEnd(textNodes[last.nodeIndex], last.end)
      drawRects(range.getClientRects(), clip)
      diag.rectCount = layer ? layer.children.length : 0
    } catch (err) {
      diag.error = String(err)
      /* 节点被 React 移除等异常：忽略，下次 render 再试 */
    }
  }

  const scheduleRender = () => {
    if (raf) return
    raf = win.requestAnimationFrame(render)
  }

  const set = (text) => {
    ensureStyle()
    ensureLayer()
    ensureModalWatch()
    // 重新确保一次弹框态（layer 可能刚被重建，属性丢了）。
    syncModal()
    active = true
    currentText = String(text ?? '')
    scheduleRender()
    if (!boundScroll) {
      boundScroll = () => scheduleRender()
      win.addEventListener('scroll', boundScroll, true)
      win.addEventListener('resize', boundScroll)
    }
  }

  const clearReading = () => {
    active = false
    currentText = ''
    diag.active = false
    clear()
    if (raf) { win.cancelAnimationFrame(raf); raf = 0 }
    if (boundScroll) {
      win.removeEventListener('scroll', boundScroll, true)
      win.removeEventListener('resize', boundScroll)
      boundScroll = null
    }
  }

  const dispose = () => {
    clearReading()
    if (modalObserver) {
      try { modalObserver.disconnect() } catch { /* 忽略 */ }
      modalObserver = null
    }
    if (layer) { layer.remove(); layer = null }
    const style = doc.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
    if (style) style.remove()
  }

  const getState = () => ({ ...diag })

  return { set, clear: clearReading, dispose, getState }
}
