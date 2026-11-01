/**
 * 朗读高亮的纯匹配逻辑（依赖无关、可独立测试）。
 *
 * 背景：
 *   朗读时宿主广播的 `sentence { text, turnId, index }` 里，`text` 是
 *   `stripForSpeech()` 的产物 —— **纯文本**（markdown 已剥离、SSML 已转义）。
 *   屏幕上渲染的是带格式的 markdown DOM。要在消息里把「正在朗读的一句」
 *   圈出来，必须把纯文本 `text` 对齐到渲染后的 DOM 文本上。
 *
 *   这个文件只做**字符串层面的对齐**：把「若干个文本节点的原文」拼成
 *   一个归一化字符串，找到目标句的位置，再映射回「每个节点里的原始区间」。
 *   真正的 DOM 操作（splitText / Range / 覆盖层）在 main.js 里做 ——
 *   纯函数无法碰 DOM，但可以被 Node 测试原生 import。
 *
 * 为什么归一化：
 *   - DOM 文本里可能有 `\u00a0`、软换行、HTML 实体还原后的连续空白；
 *   - 宿主广播的句子是折叠过空白的（stripForSpeech 里 `[ \t]+`→` `）。
 *   两者不逐字相等，所以匹配前都要把「空白串」折叠成单个空格。
 */

/**
 * 反转 stripForSpeech 的 SSML 转义。
 *
 * 宿主把 `&`→`&amp;`、`<`→`&lt;`（Edge TTS 的 SSML 模板需要合法 XML），
 * 所以 `sentence.text` 里出现的是 `&amp;` / `&lt;`。
 * 而 DOM 里渲染出来的是 `&` / `<`。匹配前必须还原，否则永远匹配不上。
 *
 * @param {string} text - 宿主广播的句子文本（可能已 SSML 转义）。
 * @returns {string} 还原后的纯文本。
 */
export function unescapeSpeechText(text) {
  return String(text ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/**
 * 把一个文本节点的原文归一化：空白串（含 `\u00a0`）折叠成单个空格。
 *
 * 返回的 `map` 让「归一化字符下标」能映射回「原文区间」：
 *   map[i] = { start, len } —— 归一化第 i 个字符对应原文 [start, start+len)。
 * 折叠的空白串被当作**一个**空格字符，其 len 覆盖整段空白，
 * 于是匹配时能整段圈住，不会只圈到空白的一半。
 *
 * @param {string} raw - 一个文本节点的原始内容。
 * @returns {{ text: string, map: Array<{start: number, len: number}> }}
 */
export function normalizeRun(raw) {
  const s = String(raw ?? '')
  const chars = []
  const map = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (/\s/.test(ch) || ch === '\u00a0') {
      let j = i
      while (j < s.length && (/\s/.test(s[j]) || s[j] === '\u00a0')) j++
      // 折叠空白串 → 一个空格；紧挨着已有的空格就不再重复加。
      // （避免「原文行尾空格 + 下一节点行首空格」拼成两个空格，
      //   与宿主的「折叠后仍是一个空格」不一致。）
      if (chars.length === 0 || chars[chars.length - 1] !== ' ') {
        chars.push(' ')
        map.push({ start: i, len: j - i })
      }
      i = j
    } else {
      chars.push(ch)
      map.push({ start: i, len: 1 })
      i++
    }
  }
  return { text: chars.join(''), map }
}

/**
 * 折叠目标字符串的空白（用于与归一化后的节点文本比较）。
 *
 * 宿主广播的句子已 `trim()` 过，且空白已折叠成单个空格；
 * 这里再做一次幂等折叠，作为防御。
 *
 * @param {string} text - 目标句。
 * @returns {string} 折叠后的目标。
 */
export function collapseWhitespace(text) {
  return String(text ?? '').replace(/[ \t\r\n\u00a0]+/g, ' ').trim()
}

/**
 * 在多个文本节点的原文里定位目标句。
 *
 * 把 `nodeTexts` 依次拼成一个归一化字符串，找出目标（同样归一化）的位置，
 * 再映射回**每个节点内部的原始区间**。返回 `null` 表示整句都匹配不上
 * （跨块/跨节点导致的错位，调用方应降级为整段高亮）。
 *
 * @param {string[]} nodeTexts - 有序的文本节点原文（按文档顺序）。
 * @param {string} target - 要定位的句子（宿主的 `sentence.text`，未还原也可，
 *   内部会先 unescapeSpeechText + collapseWhitespace）。
 * @returns {Array<{nodeIndex: number, start: number, end: number}>|null}
 *   每个要高亮的节点区间；整句无命中返回 null。
 */
export function matchInNodes(nodeTexts, target) {
  if (!Array.isArray(nodeTexts) || nodeTexts.length === 0) return null
  const targetNorm = collapseWhitespace(unescapeSpeechText(target))
  if (!targetNorm) return null

  // 拼归一化字符串 + 记录每个归一化字符落在哪个节点的哪个原文区间。
  const normChars = []
  const normMap = [] // 每个归一化字符 -> { nodeIndex, start, len }
  for (let n = 0; n < nodeTexts.length; n++) {
    const { text, map } = normalizeRun(nodeTexts[n])
    for (let k = 0; k < text.length; k++) {
      normChars.push(text[k])
      normMap.push({ nodeIndex: n, start: map[k].start, len: map[k].len })
    }
  }
  const normalized = normChars.join('')
  const idx = normalized.indexOf(targetNorm)
  if (idx < 0) return null
  const last = idx + targetNorm.length - 1
  if (last >= normMap.length) return null

  const firstCell = normMap[idx]
  const lastCell = normMap[last]
  // 逐节点收集 [start, end)。
  const ranges = []
  for (let n = firstCell.nodeIndex; n <= lastCell.nodeIndex; n++) {
    const nodeRaw = nodeTexts[n]
    let start = 0
    let end = nodeRaw.length
    if (n === firstCell.nodeIndex) start = firstCell.start
    if (n === lastCell.nodeIndex) end = lastCell.start + lastCell.len
    // 跨多个节点时，中间节点整个覆盖；两端按命中边界截。
    ranges.push({ nodeIndex: n, start, end })
  }
  return ranges
}
