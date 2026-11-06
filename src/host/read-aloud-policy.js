/**
 * 朗读发射规则（纯函数，宿主与测试共用）。
 *
 * 为什么需要它：
 *   助手一次可能吐出一大段文本。以前每遇到一个句末标点就广播一条 `sentence`
 *   事件，客户端收到就立刻发一个 `/tts` 请求 —— 于是一大段文本会瞬间打出
 *   **一大批** TTS 请求：
 *     - Edge 在线合成是**串行**的（共享一条 WebSocket），几十个请求排在
 *       一个队列里，后面的要等前面全部合成完才出声；
 *     - 每条请求都要编码/传输，机器和网络都被打满；
 *     - 用户在读到第 3 句时，屏幕上早就写完了，内容严重滞后。
 *
 * **核心规则（历史/降级路径）：按时间窗口从队列里取句子**
 *
 *   句子先进**待朗读队列**；定时器每 `EMIT_WINDOW_MS`（400ms）到点，
 *   从队列里**取 `MAX_PIECES_PER_WINDOW` 句**广播出去。于是：
 *     - 请求速率上限 = 1 / 窗口长度（默认每秒最多 2.5 句），
 *       与文本到达速度**完全无关** —— 一百字和一万字，每秒发的条数一样；
 *     - 内容不会丢：取不完的留在队列里，下个窗口继续取；
 *     - 首句不排队：第一句**无条件立刻发**，保证用户马上听到声音。
 *
 *   现状（2026-11-01 起）：宿主主路径已改成**客户端播放进度流控**
 *   （见 `lib/read-aloud-scheduler.js`）；这里的 `EMIT_WINDOW_MS` 时间窗口
 *   只在「收不到 ack 的老客户端 / ack 丢失」时作为降级节奏使用。
 *   `splitLongText` / `packWindowSentences` / `MAX_SENTENCE_CHARS` 这些切分规则
 *   仍被两条路径共用，所以本模块保留。
 *
 * **重要：一批里不是把所有句子合并成一大段。**
 *   窗口只决定「什么时候发」，不决定「发多大」。
 *   一批里仍然是「一句一段」，每段不超过 `MAX_SENTENCE_CHARS`，
 *   且一次最多取 `MAX_PIECES_PER_WINDOW` 句。
 *   （曾经把整个窗口拼成一整段，文本一多就变成几百字的超长句，
 *    既难合成又容易被切坏 —— 已被用户明确否决。）
 *
 * **切分规则：必须是完整的句子**
 *   见 `splitLongText`：优先在句末标点断开，
 *   绝不在句子中间切断（「这样才能形成一段完整的话，」这种半句是禁忌）。
 *
 * 时间窗口由调用方驱动（宿主用定时器），本模块只提供纯判定，
 * 这样规则本身可以脱离定时器单独测试。
 */

/** 时间窗口长度（毫秒）：定时器每这么久从队列里取一次句子。 */
export const EMIT_WINDOW_MS = 400

/**
 * 最短有效句子长度（字数）。
 *
 * 只用于 `packWindowSentences` 判断「两个碎片是否都够短、可以合并」。
 * 注意：它**不参与**是否发射的判定 —— 发射由定时器 + 首句规则决定。
 */
export const MIN_SENTENCE_CHARS = 8

/**
 * 单句上限（字数）：超过就按标点断开。
 *
 * 合成耗时随字数增长（实测 10 字约 1 秒，25 字约 1.5 秒），
 * 单句太长会让「这一声」等得难受。
 * 但断句必须断在**完整句子**上，不能断成半句 —— 见 `splitLongText`。
 */
export const MAX_SENTENCE_CHARS = 60

/**
 * 一个时间窗口里**最多**取几句去合成。
 *
 * 定时器每 `EMIT_WINDOW_MS` 到点，从待朗读队列里取走这么多句。
 * 取 1 句 = 最平稳（每秒约 2.5 句，略慢于正常语速时队列会自然变长）；
 * 取 2 句 = 积压时能追一点。默认 1 —— 严格按「到点取一条」的语义。
 */
export const MAX_PIECES_PER_WINDOW = 1

/**
 * 判断一段文本能不能发射（供外部按需使用的辅助判定）。
 *
 * 宿主的实际发射由定时器驱动（`tickWindow`），**不调用本函数**；
 * 它保留给需要「按长度决定要不要发」的场合，并作为规则文档的一部分。
 *
 * @param {string} text - 已清洗的候选句子（不含首尾空白）。
 * @param {object} [options] - {force, isFirst}。
 *   force=true 表示窗口关闭/流结束，必须发出去（不能把尾巴留着）。
 * @returns {boolean} 是否可以发射。
 */
export function shouldEmit(text, options = {}) {
  const value = String(text ?? '')
  if (!value.trim()) return false
  if (options.force) return true
  return value.length >= MIN_SENTENCE_CHARS
}

/**
 * 句末标点：在这里断开，句子是**完整的**。
 * 这些字符后面的停顿是「一句话说完了」，朗读在这里换段完全自然。
 */
const SENTENCE_END = '。！？!?；;\n'

/**
 * 句内标点：只在**实在找不到句末标点**时才用它断开。
 *
 * 逗号、顿号、冒号后面都是「话没说完」，
 * 在这里切会读出「这样才能形成一段完整的话，」这种半句，
 * 听感非常破碎 —— 用户明确反馈过这一点。
 */
const CLAUSE_BREAK = '，、：,'

/**
 * 「远超上限」的判定倍数。
 *
 * 剩余文本超过 `上限 × 该倍数` 时，才允许在**句内标点**（逗号等）处断开。
 * 目的：在「别读出半句话」与「别让一句长到合成不出来」之间取平衡。
 *   - 略超（1~2 倍）：整句读，听感自然；
 *   - 远超（2 倍以上）：必须断，否则某一句要合成非常久，第一声等太长。
 */
const HARD_CUT_RATIO = 2

/**
 * 把一段超长文本切成若干段，每段尽量是**完整的句子**。
 *
 * **切分优先级**（这是「听起来是不是完整句子」的关键）：
 *   1. **句末标点**（。！？；换行）—— 在这里切，读出来是完全的句子；
 *   2. 没有句末标点、但剩余文本**远超上限**时，才退用**句内标点**（，、：）；
 *   3. 连句内标点都没有 → **硬切**（宁可停顿怪，也不能让单句无限长）；
 *   4. 没有句末标点、只是略超上限 → **整段不切**（宁可略长也不读半句）。
 *
 * 「别读出半句话」这条保证写在**切分源头**（第 1/4 条），
 * 不是靠事后把半句并到下一段 —— 那样做会逐个向后合并，
 * 最终把所有段又拼回一整段，切分彻底失效（实测 203 字被合成 1 段）。
 *
 * @param {string} text - 待切文本。
 * @param {number} [maxChars] - 单段目标上限（可能被略超，以保证句子完整）。
 * @returns {string[]} 切好的若干段（都非空）。
 */
export function splitLongText(text, maxChars = MAX_SENTENCE_CHARS) {
  let rest = String(text ?? '')
  const out = []
  const limit = Math.max(1, Number(maxChars) || MAX_SENTENCE_CHARS)
  // 向前搜索切点的下限：不能太靠近段首，否则会切出很碎的段。
  const searchFloor = Math.max(1, Math.floor(limit * 0.4))

  /**
   * 在允许范围内从后往前找切点（切点 = 该标点之后）。
   * @param {string} chars - 允许作为切点的标点集合。
   * @returns {number} 切点下标；找不到返回 -1。
   */
  const findBreak = (chars) => {
    for (let i = Math.min(limit, rest.length) - 1; i >= searchFloor; i--) {
      if (chars.includes(rest[i])) return i + 1
    }
    return -1
  }

  while (rest.length > limit) {
    // 1) 优先句末标点 —— 切成完整句子。
    let cut = findBreak(SENTENCE_END)
    if (cut <= 0) {
      // 2) 没有句末标点。
      //    只剩三种情况，按「宁可整句读，也别读半句；但绝不能无限长」排序：
      const clauseCut = findBreak(CLAUSE_BREAK)
      if (clauseCut <= 0) {
        // a) 连句内标点都没有：只能硬切。硬切虽然停顿怪，
        //    但总比让一句 200 字的长文整段合成（要好几秒）好。
        cut = limit
      } else if (rest.length > limit * HARD_CUT_RATIO) {
        // b) 远超上限：必须切，即使切点是逗号（会产生半句，
        //    但这句话本来就要合成很久，只能牺牲一点的听感）。
        cut = clauseCut
      } else {
        // c) 只是略超上限：宁可整段读，也不制造半句话。
        break
      }
    }
    const piece = rest.slice(0, cut)
    if (piece) out.push(piece)
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)

  // 注意：这里**不做「把半句并到下一段」的后处理**。
  // 之前那样写会逐个向后合并，等于把所有段又拼回一整段，切分完全失效
  // （实测 203 字的文本被合成 1 段）。
  //
  // 「别读出半句话」的保证方式放在切分源头：
  //   - 有句末标点就在句末切（必然是完整句）；
  //   - 只有逗号且不是远超上限时，整段不切（宁可略超上限也不制造半句）；
  //   - 只有逗号且远超上限时，才在逗号处切（这时必须切，否则单句太长）。
  return out
}

/**
 * 把一个窗口里攒到的句子整理成**这一批要发送的若干句**。
 *
 * **不是把整个窗口拼成一大段**。窗口只负责「什么时候发」，不负责「发多大」：
 *
 *   - 一批里仍然是**一句一段**（按句子边界），每一段都不超过 maxChars；
 *   - 但一批的**段数有上限**（maxPieces）：窗口里攒了 50 句时，
 *     这一批最多发 maxPieces 段，剩下的挪到下一批。
 *     这样既不会出现几百字的超长句，也不会一次打出几十个请求。
 *
 * 合并策略（当碎片太短时）：
 *   两个相邻碎片如果都很短（「对。」+「好。」），拼起来不超过 maxChars 就合并 ——
 *   避免碎句各占一次请求。
 *
 * @param {string[]} sentences - 窗口内攒到的句子（已清洗）。
 * @param {object} [options] - {maxChars, maxPieces}。
 * @returns {{pieces: string[], rest: string[]}} -
 *   pieces 是这一批要发的句子；rest 是没发完、留给下一批的句子。
 */
export function packWindowSentences(sentences, options = {}) {
  const maxChars = Math.max(1, Number(options.maxChars) || MAX_SENTENCE_CHARS)
  const maxPieces = Math.max(1, Number(options.maxPieces) || MAX_PIECES_PER_WINDOW)
  const listed = (Array.isArray(sentences) ? sentences : [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)

  // 第一步：超长句按标点拆开，保证每段都不超过 maxChars。
  const units = []
  for (const s of listed) {
    for (const piece of splitLongText(s, maxChars)) {
      const value = piece.trim()
      if (value) units.push(value)
    }
  }

  // 第二步：把太短的相邻碎片合并（碎句不该各占一次请求）。
  const merged = []
  for (const unit of units) {
    const prev = merged[merged.length - 1]
    // 只有「两个都很短」才合并，且合并后不能超过 maxChars。
    const bothShort = prev !== undefined &&
      prev.length < MIN_SENTENCE_CHARS && unit.length < MIN_SENTENCE_CHARS
    if (bothShort && prev.length + unit.length <= maxChars) {
      merged[merged.length - 1] = prev + unit
    } else {
      merged.push(unit)
    }
  }

  // 第三步：一段数上限 —— 超出部分留到下一批（不丢内容）。
  const pieces = merged.slice(0, maxPieces)
  const rest = merged.slice(maxPieces)
  return { pieces, rest }
}
