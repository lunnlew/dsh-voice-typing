/**
 * 回合（turn）判定模型 —— 从宿主里抽出来的独立单元。
 *
 * 负责回答一个问题：某次 `llm/stream` 调用，是不是用户发起了「新的一轮对话」？
 *
 * 为什么值得独立成一个模块：
 *   宿主 `lib/index.js` 里塞了七件事（HTTP 服务、SSE、TTS 路由、
 *   识别、回合判定、配置、诊断），3000+ 行。
 *   回合判定是一块**自洽且有状态**的逻辑（几张 Map + 一个计数器），
 *   把它隔离出来既方便测试，也避免「改一轮的判定」误碰朗读/识别。
 *
 * 设计要点（与旧实现逐行等价，只是搬进工厂 + 注入依赖）：
 *   - 判定依据是「用户消息条数」，首选请求里的 `options.messages`，
 *     session 里的条数 + 5 秒时间窗只作兜底。这样没有「本轮消息还没写进
 *     session」的时序竞态。
 *   - turnId 每轮都不同（递增序号，不再用内容锚点 —— 锚点在本轮消息还没
 *     写入时会指着上一轮那条，两轮拿到同一个 id）。
 *   - `detectTurn` 顺带返回 `prevTurnId`（刚结束的上一轮），供宿主广播真正的
 *     每轮一次 `turn-end`。
 *
 * @param {object} deps
 * @param {() => object} deps.getSessionsService - 返回宿主 sessions 服务（可能为 null）。
 *   llm/stream 钩子注册在 inject 之外，拿不到 inject 作用域的 scope，
 *   所以用 getter 延迟取（inject 之后才有值）。
 */
export function createTurnModel({ getSessionsService }) {
  const TURN_WINDOW_MS = 5000
  /**
   * 会话长时间不用后，丢弃其回合状态（防长时间运行缓慢增长）。
   *
   * 宿主没有「会话结束」回调，只能用空闲超时兜底：一个会话超过这个时长
   * 没有新的 llm/stream，就把它在下面几张 Map 里的条目清掉。
   * 取值要远大于 TURN_WINDOW_MS，且保证「正在朗读的一轮不会被误清」——
   * 一轮的多个 llm/stream 调用间隔远小于这个值。
   */
  const TURN_STATE_TTL_MS = 10 * 60_000
  /** 每个会话「已见用户消息条数」（session 里的条数，兜底用）。 */
  const turnUserCounts = new Map()
  /**
   * 每个会话「请求里的用户消息条数」。
   * 与 turnUserCounts 分开存：两种计数不能混在一张表里，
   * 否则一次「拿不到请求消息」的兜底会把另一种计数的基线冲掉。
   */
  const turnRequestUserCounts = new Map()
  /** 各会话上一次广播回合开始事件的时间（毫秒）。 */
  const lastTurnAt = new Map()
  /** sessionId → 当前回合的 turnId。 */
  const turnIds = new Map()
  /** sessionId → 当前回合的内容锚点（最后一条 user 消息的稳定标识）。 */
  const turnAnchors = new Map()
  /** sessionId → 当前回合已发出的句子数（用于句子序号）。 */
  const turnIndexes = new Map()
  /** sessionId → 最近一次 detectTurn 的时间（空闲判定用）。 */
  const lastActivityAt = new Map()
  let turnCounter = 0

  /**
   * 从 llm/stream 的**请求**里数出「用户消息条数」。
   *
   * 为什么用请求里的 messages，而不是 session 里的：
   *   session 的消息写入时机和 LLM 开始流式输出**不一致** ——
   *   本轮的用户消息可能还没写进 session，于是宿主看到「条数没变」，
   *   判成同一轮 → 新一轮的 turn-begin 根本没发出去 →
   *   客户端不解除静音、也不停掉上一轮的朗读。
   *   而 llm/stream 的 options 就是**这次请求的完整消息列表**
   *   （模型就是看着它回答的），用户消息一定在里面 —— 没有时序竞态。
   *
   * 一轮里多次 llm/stream 调用（工具调用链）时，
   * 消息列表会变长，但**用户消息条数不变** —— 正好是回合标识。
   *
   * @param {object} options - llm/stream 的请求参数。
   * @returns {number} 用户消息条数；拿不到时返回 -1。
   */
  function countRequestUserMessages(options) {
    const messages = options?.messages
    if (!Array.isArray(messages)) return -1
    let count = 0
    for (const m of messages) {
      if (m?.role === 'user') count++
    }
    return count
  }

  /**
   * 判断这次 llm/stream 是不是「新的一轮用户对话」。
   *
   * 为什么不用时间/句数判断：
   *   llm/stream 一次助手回合里可能被调用多次（工具调用前一次、最终回答一次），
   *   每次都当成新回合会让客户端反复清空朗读队列，中间的句子就丢了。
   *
   * 为什么用「用户消息条数」：
   *   工具调用只会增加 assistant/tool 消息，用户消息条数不变；
   *   用户新发一条消息，条数才 +1。所以它是可靠的回合标识。
   *
   * 首选是**请求里的**条数（countRequestUserMessages）：
   *   它没有「消息还没写进 session」的时序竞态。
   *   session 里的条数 + 5 秒时间窗只作为拿不到请求消息时的兜底。
   *
   * @param {string} sessionId - 会话 id。
   * @param {number} requestUserCount - 请求里的用户消息条数；-1 表示拿不到。
   * @returns {boolean} 是否新回合。
   */
  function isNewUserTurn(sessionId, requestUserCount = -1) {
    if (!sessionId) return false
    // ── 首选：请求里的用户消息条数 ──
    if (requestUserCount >= 0) {
      const prev = turnRequestUserCounts.get(sessionId)
      turnRequestUserCounts.set(sessionId, requestUserCount)
      // 第一次见到这个会话：按新回合处理。
      // 此时客户端队列是空的（刚连上），广播不会误伤内容。
      if (prev === undefined) {
        lastTurnAt.set(sessionId, Date.now())
        return true
      }
      // 只认「条数增加」才是新一轮。
      // 条数**减小**说明上下文被裁剪/截断（DSH 压缩历史、删除旧 user 消息），
      // 这不是用户新发消息 —— 不能触发新回合，否则会误清客户端队列、
      // 撤销用户刚点的「停止朗读」、或拦腰截断正在朗读的回复。
      return requestUserCount > prev
    }
    // ── 兜底：session 里的条数 + 时间窗 ──
    const sessionsService = getSessionsService()
    if (!sessionsService) return false
    try {
      const store = sessionsService
      const session = typeof store?.get === 'function' ? store.get(sessionId) : undefined
      if (!session || typeof session.deriveMessages !== 'function') return false
      const messages = session.deriveMessages() ?? []
      let count = 0
      for (const m of messages) {
        if (m?.role === 'user') count++
      }
      const now = Date.now()
      const prev = turnUserCounts.get(sessionId)
      const last = lastTurnAt.get(sessionId) ?? 0
      turnUserCounts.set(sessionId, count)
      // 第一次见到这个会话：按新回合处理。
      if (prev === undefined) {
        lastTurnAt.set(sessionId, now)
        return true
      }
      // 条数没变 → 不是新回合
      if (count === prev) return false
      // 条数变了，但距上次广播很近 → 是同一回合里「本轮消息延迟写入」造成的，
      // 不是用户新发消息。这种情况不能广播，否则会打断本轮自己的朗读。
      if (now - last < TURN_WINDOW_MS) return false
      lastTurnAt.set(sessionId, now)
      return true
    } catch {
      return false
    }
  }

  /**
   * 求当前回合的内容锚点（最后一条 user 消息的稳定标识）。
   * 取值顺序与 /latest-message 保持一致（同一份「轮次键」定义）。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {string} 锚点；取不到时返回空串。
   */
  function resolveTurnAnchor(sessionId) {
    const sessionsService = getSessionsService()
    if (!sessionId || !sessionsService) return ''
    try {
      const session = typeof sessionsService.get === 'function'
        ? sessionsService.get(sessionId) : undefined
      if (!session || typeof session.deriveMessages !== 'function') return ''
      const messages = session.deriveMessages() ?? []
      let lastUserIndex = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') { lastUserIndex = i; break }
      }
      if (lastUserIndex < 0) return ''
      const um = messages[lastUserIndex]
      return String(um?.id ?? um?.seq ?? um?.eventSeq ?? lastUserIndex)
    } catch {
      return ''
    }
  }

  /**
   * 判定这一轮是不是新的，并给出本轮的 turnId（及刚结束的上一轮 turnId）。
   *
   * @param {string} sessionId - 会话 id。
   * @param {number} requestUserCount - 请求里的用户消息条数；-1 表示拿不到。
   * @returns {{isNew: boolean, turnId: string, prevTurnId: string}} 判定结果、
   *   本轮 turnId、以及「刚结束的上一轮」turnId（仅当本轮是新回合且上一轮存在）。
   */
  function detectTurn(sessionId, requestUserCount = -1) {
    // 记录活动时间（不管是不是新回合）—— 空闲清理靠它判断会话是否还活着。
    if (sessionId) lastActivityAt.set(sessionId, Date.now())
    const anchor = resolveTurnAnchor(sessionId)
    const isNew = isNewUserTurn(sessionId, requestUserCount)
    const prevTurnId = isNew ? (turnIds.get(sessionId) ?? '') : ''
    if (isNew) {
      // 轮次 id 必须**每一轮都不同**（用递增序号，不用内容锚点 ——
      // 锚点在本轮消息还没写进 session 时会指着上一轮那条，两轮共用同一 id）。
      const turnId = `turn-${++turnCounter}`
      turnIds.set(sessionId, turnId)
      turnIndexes.set(sessionId, 0)
    } else if (!turnIds.has(sessionId)) {
      // 还没分配过（例如这次不是新回合但没有历史）：给一个稳定的占位值。
      const turnId = `turn-${++turnCounter}`
      turnIds.set(sessionId, turnId)
      turnIndexes.set(sessionId, 0)
    }
    turnAnchors.set(sessionId, anchor)
    return { isNew, turnId: turnIds.get(sessionId) ?? `turn-${sessionId}`, prevTurnId }
  }

  /**
   * 取本轮下一个句子序号并自增。
   * @param {string} sessionId - 会话 id。
   * @returns {number} 本次句子的序号（从 0 起）。
   */
  function nextSentenceIndex(sessionId) {
    const index = turnIndexes.get(sessionId) ?? 0
    turnIndexes.set(sessionId, index + 1)
    return index
  }

  /**
   * 丢弃长时间没活动的会话的回合状态（防内存/条目缓慢增长）。
   *
   * 宿主没有「会话结束」回调，只能靠空闲超时兜底。每次 detectTurn 都会
   * 更新 lastActivityAt，所以这里按它判断会话是否还活着。
   *
   * @param {number} now - 当前时间（毫秒），便于测试。
   */
  function prune(now = Date.now()) {
    for (const [sessionId, at] of lastActivityAt) {
      if (now - at <= TURN_STATE_TTL_MS) continue
      turnUserCounts.delete(sessionId)
      turnRequestUserCounts.delete(sessionId)
      lastTurnAt.delete(sessionId)
      turnIds.delete(sessionId)
      turnAnchors.delete(sessionId)
      turnIndexes.delete(sessionId)
      lastActivityAt.delete(sessionId)
    }
  }

  /** 仅供测试：清空所有回合状态。 */
  function reset() {
    turnUserCounts.clear()
    turnRequestUserCounts.clear()
    lastTurnAt.clear()
    turnIds.clear()
    turnAnchors.clear()
    turnIndexes.clear()
    lastActivityAt.clear()
    turnCounter = 0
  }

  return {
    countRequestUserMessages,
    isNewUserTurn,
    resolveTurnAnchor,
    detectTurn,
    nextSentenceIndex,
    prune,
    reset,
  }
}
