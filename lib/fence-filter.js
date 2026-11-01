/**
 * 流式代码围栏过滤器（纯模块，无宿主依赖）。
 *
 * 为什么需要它（真实缺陷，2026-11-01 端到端验证发现）：
 *   宿主 `llm/stream` 钩子以前是**逐 chunk** 扫代码围栏的：
 *     `for (const piece of chunk.text.split('```')) ...`
 *   这个写法只在「完整的 ``` 恰好落在同一个 chunk 里」时成立。真实的模型
 *   流式输出按 token 交付，**围栏标记可能正好被 chunk 边界切开**：
 *
 *     chunk A = "下面是一段示例代码：\n``"   ← 只有两个反引号
 *     chunk B = "`js\nconst x = 1\n```\n正文。"
 *
 *   于是 A 里 `split('```')` 一个都切不出来 → 两个反引号被当正文喂进去；
 *   B 里的 ``` 被切出来，但状态机错位。实测结果：
 *     - 代码内容被朗读（"js"、"const x = 1"、"console.log(x)"）；
 *     - 围栏状态反了，**围栏之后的正文反而被当代码丢掉**。
 *
 * 正确做法：把围栏识别做成**跨 chunk 有状态**的过滤器 ——
 * 暂存「还无法判定」的尾字符（可能构成围栏标记的反引号/波浪线 run），
 * 等下一块到达后再判定。本模块就是这个状态机。
 *
 * 语义（与旧实现兼容，同时修掉跨 chunk 的坑）：
 *   - 围栏字符：反引号 `` ``` `` 与波浪线 `~~~`（Markdown 的两种围栏）；
 *   - 开启围栏需要 **连续 >=3 个**同种字符；开启标记本身的长度记为 `len`；
 *   - 闭合需要 **连续 >=len 个**同种字符（Markdown：闭合围栏不能比开启短）；
 *   - 围栏标记与围栏内内容**全部丢弃**（不朗读代码，也不朗读标记/info string）；
 *   - 围栏**外**的行内反引号（如 `` `foo()` ``）原样返回，交给 stripForSpeech
 *     去处理 —— 绝不能因为「看到一个反引号」就把整段正文吞掉；
 *   - 围栏标记出现在行首还是行中都能识别（与旧实现等价：旧实现也是
 *     「任意位置出现 ``` 就切换状态」）。
 *
 * 与宿主接线方式（Lead 负责）：
 *   ```js
 *   const fence = createFenceFilter()
 *   for await (const chunk of inner) {
 *     if (chunk?.type === 'text-delta' && chunk.text) {
 *       const body = fence.push(chunk.text)
 *       if (body) reader.push(body)
 *     }
 *     yield chunk
 *   }
 *   // 流结束：
 *   const tail = fence.flush()
 *   if (tail) reader.push(tail)
 *   reader.end()
 *   ```
 */

/** 可以构成围栏的字符。 */
const FENCE_CHARS = new Set(['`', '~'])

/** 围栏的最短长度（Markdown 标准：>=3）。 */
const MIN_FENCE_LEN = 3

/**
 * 创建一个流式代码围栏过滤器。
 *
 * 每个 `llm/stream` 调用建一个实例（状态属于「一条流」）。
 *
 * @returns {{
 *   push(text: string): string,
 *   flush(): string,
 *   isInFence(): boolean,
 * }} 过滤器
 *   - `push(text)`：喂入一段流式文本，返回其中**围栏外的正文**（可能为空串）；
 *   - `flush()`：流结束。返回暂存的、最终被判定为「普通文本」的尾字符
 *     （例如行尾一个孤立的反引号）；围栏内未闭合的内容直接丢弃；
 *     该标记（run >= 3）按「未闭合围栏的起始」丢弃 —— 没有内容可朗读；
 *   - `isInFence()`：当前是否在围栏内（诊断/测试用）。
 */
export function createFenceFilter() {
  /** null = 不在围栏内；否则 { ch: '`'|'~', len: 开启围栏的字符个数 }。 */
  let inFence = null
  /**
   * 暂存的尾字符 run（只可能是同一种围栏字符）。
   *
   * 为什么需要暂存：这个 run 可能是**被 chunk 边界切开的围栏标记**的前半截，
   * 例如 "``" + "`"、"`" + "``"、"~~" + "~"、以及更长的 "```" + "`"。
   * 在拿到下一个字符之前无法判定它是「正文里的反引号」还是「围栏标记」，
   * 所以先扣住，等下一块到达（或 flush）再判。
   */
  let carry = ''
  /** carry 那段 run 开始前的「行首状态」（`~~~` 围栏必须行首时要用）。 */
  let carryLineStart = true
  let carryLineSpaces = 0
  /** 当前位置是否在行首（行首只允许 0~3 个空格）。 */
  let lineStart = true
  let lineSpaces = 0

  /**
   * 更新「行首」状态（只对围栏外的正常文本有意义；围栏内也记，供 `~~~` 闭合判断）。
   * @param {string} ch - 一个字符。
   */
  const markChar = (ch) => {
    if (ch === '\n') {
      lineStart = true
      lineSpaces = 0
      return
    }
    if (lineStart) {
      if (ch === ' ' && lineSpaces < 3) lineSpaces += 1
      else lineStart = false
    }
  }
  const atLineStart = () => lineStart && lineSpaces <= 3

  /**
   * 喂入一段流式文本，返回围栏外的正文。
   * @param {string} text - 流式文本片段（可以任意切分，包括把围栏标记切开）。
   * @returns {string} 围栏外的正文（围栏内内容与标记本身都被剔除）。
   */
  const push = (text) => {
    const src = carry + String(text ?? '')
    if (carry) {
      // 恢复 carry 之前的状态，重新从 run 的起点判定（run 可能被下一块延长成围栏）。
      lineStart = carryLineStart
      lineSpaces = carryLineSpaces
    }
    carry = ''
    let out = ''
    let i = 0
    while (i < src.length) {
      const ch = src[i]

      if (inFence) {
        // ── 围栏内：只关心「闭合围栏的字符 run」，其它字符一律丢弃 ──
        if (ch === inFence.ch) {
          let j = i
          while (j < src.length && src[j] === ch) j++
          const runLen = j - i
          const atEnd = j === src.length
          // `~~~` 的闭合也要求行首（否则代码里的连续 ~ 会提前结束围栏）；
          // ``` 保持旧行为：任意位置的 run >= 开启长度即闭合。
          const canClose = runLen >= inFence.len && (inFence.ch === '`' || atLineStart())
          if (canClose) {
            inFence = null
            for (let k = i; k < j; k += 1) markChar(src[k])
            i = j
          } else if (atEnd) {
            // run 落在 chunk 末尾：可能是更长的闭合标记的前半截 → 暂存。
            carry = src.slice(i, j)
            carryLineStart = lineStart
            carryLineSpaces = lineSpaces
            i = j
          } else {
            // 短的 run（或非行首的 ~~~）后面已经跟了别的字符 → 它只是围栏内的内容 → 丢弃。
            for (let k = i; k < j; k += 1) markChar(src[k])
            i = j
          }
        } else {
          // 围栏内普通字符：直接丢弃（不朗读代码）。
          markChar(ch)
          i++
        }
        continue
      }

      // ── 围栏外：正常输出正文，但要留意「可能是围栏标记」的字符 run ──
      if (FENCE_CHARS.has(ch)) {
        let j = i
        while (j < src.length && src[j] === ch) j++
        const runLen = j - i
        const atEnd = j === src.length
        if (atEnd) {
          // 落在 chunk 末尾：可能被下一个字符延长成围栏标记（"``"+"`"），
          // 也可能只是正文里的反引号（等下一块/ flush 再判）→ 暂存。
          carry = src.slice(i, j)
          carryLineStart = lineStart
          carryLineSpaces = lineSpaces
          i = j
        } else if (runLen >= MIN_FENCE_LEN && (ch === '`' || atLineStart())) {
          // 连续的 >=3 个同种围栏字符 = 开启围栏（后面的内容全部丢弃）。
          // ``` 保持旧行为（任意位置）；`~~~` 必须**行首**（0~3 空格）——
          // 否则正文里 3 个连续 `~`（如 "~~~ 第二段"）会把后面整段静默吞掉（评审 P2-4）。
          inFence = { ch, len: runLen }
          for (let k = i; k < j; k += 1) markChar(src[k])
          i = j
        } else {
          // 行内代码/普通反引号（1~2 个，或非行首的 ~~~）：原样返回，交给 stripForSpeech。
          out += src.slice(i, j)
          for (let k = i; k < j; k += 1) markChar(src[k])
          i = j
        }
        continue
      }

      out += ch
      markChar(ch)
      i++
    }
    return out
  }

  /**
   * 流结束：把暂存的尾字符做一个终判。
   * @returns {string} 需要补交给调用方的正文（通常是行尾孤立的 1~2 个反引号）。
   */
  const flush = () => {
    const tail = carry
    const tailAtLineStart = carryLineStart
    carry = ''
    if (inFence) {
      // 围栏没有闭合（回复被中断）：围栏内的内容全部丢弃，没有可朗读的尾巴。
      inFence = null
      return ''
    }
    if (!tail) return ''
    // 不在围栏内：暂存的 run 是正文的一部分。
    // 但若它构成「围栏起始标记」（``` 任意位置、~~~ 行首，且 run >=3），
    // 属于标记而不是正文 → 丢弃（没有内容会因此丢失）。
    const isFenceStart = tail.length >= MIN_FENCE_LEN && (tail[0] === '`' || tailAtLineStart)
    return isFenceStart ? '' : tail
  }

  /** 当前是否处于围栏内（诊断/测试用）。 */
  const isInFence = () => inFence !== null

  return { push, flush, isInFence }
}
