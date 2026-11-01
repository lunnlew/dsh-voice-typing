/**
 * 段落切分（纯函数）。
 *
 * 为什么需要它（用户反馈 2026-11-01）：
 *   对话回复是**段落形式**的。以前按「句子」直接切分朗读单元，
 *   一个完整意思可能被劈成两段，读起来破碎；
 *   而且按句子切分会在词汇中间 / 句子中间断开（详见 read-aloud-break 测试）。
 *
 *   用户明确要求：**先按段落收集，定时取一个段落，段落内再按句子切**。
 *   这样每一段是一个完整的朗读单元，段内的句子连贯、不混入其它段落。
 *
 * 段落边界（与用户确认）：
 *   1. **空行**（`\n\n` 或行首空白）—— 自然段分隔；
 *   2. **块级标记行首** —— 列表项、标题、引用各自成段：
 *      - 连续**列表项**（`- `、`* `、`+ `、`1. `、`1)`）逐项成段；
 *      - 连续**引用**（`> `）合并成一个引用块；
 *      - **标题**（`#`~`######`）独占一段。
 *
 * `splitParagraphs` 处理**流式累积**的 buffer：末尾可能是还没到段落边界的
 * 未完成段，它被放进 `rest`，等下一块文本到达后再补全。
 */

/**
 * 判定一行的块级类型。
 * @returns {'list'|'heading'|'quote'|'para'}
 */
function lineType(line) {
  if (/^[ \t]*[-*+]\s+/.test(line)) return 'list'
  if (/^[ \t]*\d{1,3}[.)]\s+/.test(line)) return 'list'
  if (/^[ \t]*#{1,6}\s+/.test(line)) return 'heading'
  if (/^[ \t]*>\s?/.test(line)) return 'quote'
  return 'para'
}

/**
 * 把 buffer 按段落边界切成完整段落 + 剩余未完成段。
 *
 * @param {string} buffer - 流式累积的文本（可能含未完成段）。
 * @returns {{paragraphs: string[], rest: string, endedByBlank: boolean}} -
 *   - `paragraphs`：完整段落（每项是原文，含内部换行，不含尾部空行）；
 *   - `rest`：最后一个未完成段（还没到段落边界，等下一块补全）；
 *   - `endedByBlank`：buffer 是否以空行结尾（true 表示最后一段已完整）。
 */
export function splitParagraphs(buffer) {
  const text = String(buffer ?? '')
  const paragraphs = []
  const lines = text.split('\n')
  let cur = []
  let curType = 'para'
  let endedByBlank = false

  const flushCur = () => {
    if (cur.length) {
      paragraphs.push(cur.join('\n'))
      cur = []
    }
    curType = 'para'
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    if (line.trim() === '') {
      // 空行 = 段落边界。
      flushCur()
      endedByBlank = true
      continue
    }
    const type = lineType(line)
    if (type === 'list') {
      // 连续列表项：**每一项**各自成段。
      flushCur()
      cur = [line]
      curType = 'list'
    } else if (type === 'heading') {
      // 标题：独占一段。
      flushCur()
      cur = [line]
      curType = 'heading'
    } else if (type === 'quote') {
      // 引用块：连续 `>` 行合并成一段。
      if (curType !== 'quote') flushCur()
      cur.push(line)
      curType = 'quote'
    } else {
      // 普通行：若当前段是列表项/标题/引用，先收尾，再开普通段。
      if (curType !== 'para') flushCur()
      cur.push(line)
      curType = 'para'
    }
    endedByBlank = false
  }

  const rest = cur.join('\n')
  return { paragraphs, rest, endedByBlank }
}
