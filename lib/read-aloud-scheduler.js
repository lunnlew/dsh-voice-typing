/**
 * 朗读调度器（宿主侧，按「自然段落 + 客户端播放进度」发句）。
 *
 * 为什么需要它（用户反馈 2026-11-01，反复两次）：
 *   对话回复是**段落形式**的，朗读应当**按段落自然推进**：一段话从头读到尾，
 *   再进入下一段。以前宿主按 400ms/句的固定时间窗口猛发（2.5 句/秒），
 *   而浏览器端真正「念出来」受音频播放时长限制（2~3 秒/句）——
 *   生产速度是消费速度的 5~8 倍，于是：
 *
 *     1. 客户端待播队列必然越积越长；
 *     2. 客户端为了「贴着最新内容」，只能丢**最旧的待播句** ——
 *        丢掉的正是「接下来马上要播的那几句」；
 *     3. 播放位置于是不断向前跳，落点是某个段落的**中间**，
 *        用户听到的就是：「不是按自然段落读的，总挑到最新段落里非首句的句子」。
 *
 *   这不是切分算法的 bug，是**生产/消费速率失衡**。调大队列上限只能把跳变
 *   推迟几秒；真正要解决「既不丢内容、又不越读越滞后」，必须让宿主
 *   **按客户端的播放进度发句**（流控 / back-pressure）：
 *
 *   - 每发一句记一笔「未确认（unacked）」；
 *   - 客户端**开始播放**一句就回 `ack(count=1)`，宿主才补发下一句；
 *   - 未确认句数上限 `READ_ALOUD_LEAD`（默认 3）——
 *     客户端正好用这 3 句做并行合成预取，既不空转，也不会积压。
 *
 *   于是：朗读完整、顺序、按段落推进，和屏幕内容的差距恒定在「几句」以内。
 *
 * **追赶最新（2026-11-01 用户追加需求，经两轮调优定稿）**：
 *   流控保证「不丢句、不跳段」，但「全部朗读」在长回复时会**越读越滞后**
 *   （模型几秒写完，逐句朗读要几分钟，听到的可能是几分钟前的内容）。
 *   所以再加一层「追赶」：
 *
 *   - **计时**：待朗读音频时长 = **正在播放的剩余时长** + 已发未确认 + 队列里
 *     没发的 + 当前段落剩余文本。客户端 ack 会带真实音频时长 `durationMs`
 *     （`decoded.duration`），不带则按 ~210ms/字估算。超过 `getMaxLagMs()`
 *     （设置项「朗读追赶最新」，**默认 7.5 秒**，0 = 关闭）就触发追赶。
 *   - **保留最新 3 段**：中间还没开始发的完整段落整段跳过，只保留「已开读的段」+
 *     「最新 `TRIM_KEEP_PARAGRAPHS`（3）段」；当前段读完后从「最新第 3 段」接着读
 *     （用户要求「跳到最新的第三条」）。
 *   - **生成很快时只读首句（skim）**：仍在流式生成、且「还没发出去的内容」
 *     （`backlogMs`，不含正在播放/已发未播的流水线提前量）超过预算时，正在读的
 *     段落发出**首句**后就放弃剩余句子、直接跳走；生成结束（或回到预算内）后恢复
 *     正常完整朗读，剩余段落整段读完，不把结尾读残。
 *   - 跳过的单位仍是**完整段落**（只有「未开始发」的才整段丢）；只有 skim 模式
 *     允许把正在读的段落截到首句（用户明确要求「跳走时只需要读首句」）。
 *
 * 兼容/兜底：
 *   - 老客户端（或者页面没重启、没有 ack）收不到 `ack` 时，调度器停留在
 *     `pending` 模式，按**旧的 400ms 时间窗口**节奏发句（行为与修复前一致）；
 *     只有「积压超预算」时，调用结束才先等 `FLUSH_GRACE_MS`（1.2s）再排空 ——
 *     等首条 ack 好切 flow 走追赶；老客户端到点照旧发完，不丢尾巴。
 *   - 一旦收到第一条 ack 就切到 `flow` 模式（严格按播放进度补发）；
 *   - `flow` 模式下若某句发出去 `ACK_STALL_MS` 还没 ack（客户端掉线 / 播放被
 *     系统静音 / 老客户端混用），watchdog 放行一条，保证不会永久卡死。
 *     watchdog 只在「真发句 / 收到 ack」时重新计时，持续收到文本不会拖住它。
 *   - SSE 新连接（页面刷新 / 断线重连）会调用 `resetOutstanding()` 清零旧连接遗留
 *     的「已发未确认」，否则新页面首句要白等一个 watchdog（10 秒）。
 *
 * 段落模型（与 lib/paragraph.js 一致）：
 *   - 空行 / 列表项 / 标题 / 引用 = 段落边界；
 *   - 段落内再按句末标点切句（`splitLongText` 保证完整句，绝不切半句；
 *     相邻短句会合并成 ≤ `MAX_SENTENCE_CHARS` 的片段，skim 时再从片段里取首句）；
 *   - 段落是朗读的基本单元：一段的句子全部发出后，才轮到下一段。
 *
 * 输出的 `sentence` 事件载荷：
 *   `{ text, sessionId, turnId, index, para, paraStart }`
 *     - `para`：段落序号（一轮内从 0 递增）——客户端据此**按整段**裁剪
 *       （要丢就整组丢，绝不只丢段首保留段尾，否则又从段落中间开始播）；
 *     - `paraStart`：该句是本段**第一个发出的片段**（客户端据此识别段首；
 *       整组被安全网裁掉时它也会一起丢，但不会出现「段中没有段首」）。
 *
 * 诊断（`GET /dsh-voice-typing/diagnostics`）：
 *   - `readAloud[]`（按会话）：`mode` / `outstanding` / `acks` / `emitted` /
 *     `stalls` / `lagMs` / `playingMs` / `backlogMs` / `budgetMs` / `streaming` /
 *     `skim` / `keepParagraphs` / `trimmed` / `trimmedParagraphs` /
 *     `trimmedSentences` / `truncatedParagraphs` / `pendingUnits` /
 *     `awaitingFlush` / `lastAt`；
 *   - `readAloudScheduler`（全局）：`rejectedAcks` / `lastRejectedAck` / `disposed`。
 *
 * 本模块只负责「什么时候发、发什么」，事件怎么广播由调用方注入的 `emit` 决定，
 * 句子序号怎么分配由 `nextIndex` 决定 —— 于是它可以在没有宿主的情况下单测。
 */
import { splitParagraphs } from './paragraph.js'
import { stripForSpeech, splitSentenceParts } from './speech-clean.js'
import {
  EMIT_WINDOW_MS,
  MAX_SENTENCE_CHARS,
  splitLongText,
  packWindowSentences,
} from './read-aloud-policy.js'

/**
 * 未确认句子上限（流控窗口）。
 *
 * = 客户端可以提前合成/排队几句。取 3：客户端本来就是 3 路并行合成
 * （`inflight < 3` 的预取），正好把合成延迟完全藏进上一句的播放时间里。
 */
export const READ_ALOUD_LEAD = 3

/**
 * 一句发出去多久没收到 ack 就放行下一句（watchdog）。
 *
 * 正常播放时客户端**开始播**就 ack，远小于这个值；这里只兜底「ack 掉线」
 * 这类异常，保证朗读不会永久停住。
 */
export const ACK_STALL_MS = 10000

/** 会话状态空闲多久后回收（宿主没有会话结束回调，只能按空闲超时兜底）。 */
export const SESSION_IDLE_MS = 10 * 60 * 1000

/**
 * `pending`（老客户端/首条 ack 未到）模式下，一次调用结束后的收尾等待（毫秒）。
 *
 * 为什么需要：新客户端首条 ack 通常在 1~2 秒内到；如果调用结束就**同步把剩余句子
 * 一次发完**（旧语义），流控/追赶都来不及生效（用户看到「全读、越读越滞后」）。
 * 所以先等一个 grace：期间 ack 到了就切 flow 走追赶；老客户端没有 ack，grace 到点
 * 后照旧一次性发完（不丢尾巴）。
 *
 * 0 = 不等待（回到旧的同步排空语义）。
 */
export const FLUSH_GRACE_MS = 1200

/**
 * 「追赶最新」的默认积压上限（毫秒）。
 *
 * 生成远快于朗读时（典型：模型几秒写完，逐句朗读要几分钟），如果坚持**全部朗读**，
 * 听到的内容会离屏幕越来越远（甚至几分钟前的内容）。所以允许待朗读音频时长
 * 超过这个上限就**按整段**跳到最新内容：跳过完整的旧段落，绝不从段落中间开始念。
 *
 * 0 = 关闭追赶（全部朗读，不跳段）。
 */
export const DEFAULT_MAX_LAG_MS = 7500

/**
 * 追赶时**保留最新几段**（超出积压上限后，从「最新第 N 段」开始接着读）。
 *
 * 用户反馈（2026-11-01）的演进：
 *   1. 只把积压裁到 ≤ 预算 → 留下的还是十几秒前的内容，看起来没在追；
 *   2. 只保留最新 1 段 → 太狠，中间全没、上下文断裂；
 *   3. **保留最新 3 段**：超预算时丢掉更旧的整段，从「最新第 3 段」开始读 ——
 *      既追上了最新内容，又留一点上下文（用户明确要求）。
 */
export const TRIM_KEEP_PARAGRAPHS = 3

/** 估算朗读时长：中文约 4.8 字/秒（默认语速），即每字约 210ms。 */
const MS_PER_CHAR = 210
/** 单句估算下限（再短的句子也要一点时间）。 */
const MIN_SENTENCE_MS = 700
/** 单句估算上限（超长句按上限算，避免几乎不追赶）。 */
const MAX_SENTENCE_MS = 15000

/**
 * 估算一句话的朗读时长（毫秒）。只用于「追赶最新」的积压判断 ——
 * 估算偏差只会让追赶稍早/稍晚，不会造成跳句或乱序。
 *
 * @param {string} text - 句子文本。
 * @returns {number} 估算时长（毫秒）。
 */
function estimateSpeechMs(text) {
  const chars = String(text ?? '').replace(/\s+/g, '').length
  if (!chars) return 0
  return Math.max(MIN_SENTENCE_MS, Math.min(MAX_SENTENCE_MS, chars * MS_PER_CHAR))
}

/**
 * 把一段原文清洗、切分成可朗读的句子（与旧 `flushParagraph` 等价）。
 *
 * @param {string} raw - 原始 Markdown 片段（可能为空）。
 * @returns {string[]} 句子（已清洗、去空白、长度 >= 2）。
 */
function sentencesOf(raw) {
  const text = stripForSpeech(raw)
  if (!text) return []
  const { pieces } = packWindowSentences(splitLongText(text, MAX_SENTENCE_CHARS), {
    maxChars: MAX_SENTENCE_CHARS,
    maxPieces: 9999,
  })
  return pieces.map((piece) => piece.trim()).filter((piece) => piece.length >= 2)
}

/**
 * 创建一个朗读调度器。
 *
 * @param {object} [options]
 * @param {(event: string, payload: object) => void} [options.emit] - 广播事件。
 * @param {(sessionId: string) => number} [options.nextIndex] - 分配本轮句子序号。
 * @param {number} [options.lead] - 未确认句子上限（默认 READ_ALOUD_LEAD）。
 * @param {number} [options.windowMs] - pending 模式的时间窗口（默认 EMIT_WINDOW_MS）。
 * @param {number} [options.stallMs] - ack watchdog 超时（默认 ACK_STALL_MS）。
 * @param {number} [options.idleMs] - 会话空闲回收时间。
 * @param {() => number} [options.getMaxLagMs] - 「追赶最新」的积压上限毫秒数
 *   （返回 0 = 关闭追赶）。每次发句/收到文本时读取，于是运行中改设置立即生效。
 * @param {number} [options.flushGraceMs] - pending 收尾等待 ack 的 grace（默认 FLUSH_GRACE_MS，0=同步排空）。
 * @param {() => number} [options.now] - 时钟（测试用）。
 * @param {Function} [options.setTimeout] - 定时器（测试用）。
 * @param {Function} [options.clearTimeout] - 清定时器（测试用）。
 */
export function createReadAloudScheduler(options = {}) {
  const emit = typeof options.emit === 'function' ? options.emit : () => {}
  const nextIndex = typeof options.nextIndex === 'function' ? options.nextIndex : () => 0
  const lead = Math.max(1, Math.floor(Number(options.lead) || READ_ALOUD_LEAD))
  const windowMs = Math.max(1, Math.floor(Number(options.windowMs) || EMIT_WINDOW_MS))
  const stallMs = Math.max(5, Math.floor(Number(options.stallMs) || ACK_STALL_MS))
  const idleMs = Math.max(1000, Math.floor(Number(options.idleMs) || SESSION_IDLE_MS))
  const flushGraceMs = Math.max(0, Math.floor(Number(options.flushGraceMs ?? FLUSH_GRACE_MS)))
  /** 「追赶最新」的积压上限（毫秒）；0 = 关闭。 */
  const getMaxLagMs = typeof options.getMaxLagMs === 'function'
    ? options.getMaxLagMs
    : () => Math.max(0, Number(options.maxLagMs) || 0)
  const now = typeof options.now === 'function' ? options.now : Date.now
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout

  /** 插件卸载后为 true：之后所有 reader/push/end 都是空操作（防止悬空定时器再广播）。 */
  let disposed = false
  /** ack 被拒绝的计数与最近一次原因（诊断用：session/turn 对不上时说明两端记账错位）。 */
  let rejectedAcks = 0
  let lastRejectedAck = null

  /** sessionId -> 该会话的朗读状态。 */
  const sessions = new Map()

  /** 起一个不阻止进程退出的定时器。 */
  const startTimer = (fn, ms) => {
    const timer = setTimer(fn, ms)
    timer?.unref?.()
    return timer
  }

  /** 清掉一个状态上的全部定时器。 */
  const clearTimers = (state) => {
    if (state.windowTimer) {
      try { clearTimer(state.windowTimer) } catch { /* 忽略 */ }
      state.windowTimer = null
    }
    if (state.stallTimer) {
      try { clearTimer(state.stallTimer) } catch { /* 忽略 */ }
      state.stallTimer = null
    }
    if (state.flushTimer) {
      try { clearTimer(state.flushTimer) } catch { /* 忽略 */ }
      state.flushTimer = null
    }
  }

  /** 新建（或重置）一个会话的朗读状态。 */
  const createState = (sessionId, turnId) => ({
    sessionId,
    turnId: turnId ?? '',
    /** 还没发完的段落单元：{ para, sentences, sent, emitted, closed }。 */
    units: [],
    /** 当前**未完成**段落的单元（null = 没有打开的段落）。 */
    openUnit: null,
    /** 段落序号计数器（一轮内从 0 递增）。 */
    paraSeq: 0,
    /** 当前是否在「生成中」（收到流式文本 → true；一次调用结束 → false）。 */
    streaming: false,
    /** 当前是否处于「只读每段首句」的追赶模式（诊断用）。 */
    skim: false,
    /** 当前未完成段落的完整累积原文（含已提前发出的句子）。 */
    curPara: '',
    /** `curPara` 里已提前发出（已进入段落单元）的前缀**字符数**。 */
    curParaSentLen: 0,
    /** 已发出、尚未被客户端 ack 的句数。 */
    outstanding: 0,
    /**
     * 已发出、尚未被 ack 的句子**估算时长**（毫秒，FIFO）。
     * 用于「追赶最新」估算当前朗读落后了多久。
     */
    unackedDurations: [],
    /**
     * 「正在播放」的预计结束时刻（epoch ms）。
     *
     * 客户端在**开始播放**一句话时就 ack（这样宿主能尽早补发下一句），
     * 所以被 ack 掉的那句其实还要播 2~5 秒。追赶计时必须把这段**正在念**的
     * 时长也算进「落后」，否则预算实际会变成「预算 + 正在念的那句」，
     * 用户看到的就是「明明落后超过预算了还不跳」（用户反馈）。
     */
    playbackEnd: 0,
    /** 模式下：'pending' = 还没收到 ack（按时间窗口），'flow' = 按播放进度。 */
    mode: 'pending',
    /** 本轮发出的句子总数（诊断用）。 */
    emitted: 0,
    /** **本次 llm/stream 调用**发出的句子数（pending 模式下每 call 首句立刻发）。 */
    emittedThisCall: 0,
    /** 收到的 ack 总数（诊断用）。 */
    acks: 0,
    /** watchdog 放行次数（诊断用：>0 说明客户端 ack 不正常）。 */
    stalls: 0,
    /** 「追赶最新」跳过的句子数 / 段落数（诊断用）。 */
    trimmed: 0,
    trimmedParagraphs: 0,
    /** 段内截断（生成很快时"只读首句"就跳走）丢掉的句子数 / 被截断的段落数。 */
    trimmedSentences: 0,
    truncatedParagraphs: 0,
    /** pending 模式的时间窗口定时器。 */
    windowTimer: null,
    /** flow 模式的 ack watchdog 定时器。 */
    stallTimer: null,
    /** pending 收尾等待 ack 的 grace 定时器（老客户端到点后照旧排空）。 */
    flushTimer: null,
    createdAt: now(),
    updatedAt: now(),
  })

  /**
   * 取（或创建）会话状态，并把定时器挂到当前状态上。
   * 一轮对话一个状态：turnId 变了就整体重置（上一轮的尾巴不再朗读）。
   */
  const stateFor = (sessionId, turnId) => {
    const key = sessionId || ''
    let state = sessions.get(key)
    if (!state || state.turnId !== (turnId ?? '')) {
      if (state) clearTimers(state)
      state = createState(key, turnId ?? '')
      sessions.set(key, state)
    }
    return state
  }

  /**
   * 取一段文本里的**第一句**（用于「生成很快时每段只读首句」）。
   *
   * 为什么需要：段落切句时会把相邻短句合并成不超过 60 字的片段，所以要单独
   * 从片段里再取出第一句；否则"只读首句"会退化成"读完整段"（短段落只有一个片段）。
   *
   * @param {string} text - 片段文本。
   * @returns {string} 第一句（找不到句末标点时返回整段）。
   */
  const firstSentenceOf = (text) => {
    const value = String(text ?? '')
    for (let i = 0; i < value.length; i += 1) {
      if ('。！？!?；;\n'.includes(value[i])) return value.slice(0, i + 1).trim()
    }
    return value.trim()
  }

  /**
   * 从队列里取下一条要朗读的句子（会推进游标）。
   *
   * 段落按到达顺序消费：只有**当前段落**的句子全部取完（且该段已封口）
   * 才会进入下一段 —— 于是段落之间绝不交叉。
   *
   * @param {object} state - 会话状态。
   * @param {boolean} [skimFirstOnly] - 「生成很快、正在追赶」时每段**只读首句**：
   *   取该段第一句发出，本段剩余句子直接放弃（用户要求「只需要读首句就行」）。
   * @returns {{text: string, para: number, paraStart: boolean}|null}
   */
  const nextSentence = (state, skimFirstOnly = false) => {
    while (state.units.length) {
      const unit = state.units[0]
      if (unit.sent >= unit.sentences.length) {
        if (!unit.closed) return null   // 段落还没写完：等后续文本补全
        state.units.shift()
        if (state.openUnit === unit) state.openUnit = null
        continue
      }
      if (skimFirstOnly && (unit.skimmed || unit.emitted >= 1)) {
        // 这段已经读过（首）句（或本来就发过句子）：追赶模式下不再续读，剩余全部放弃。
        const cut = unit.sentences.length - unit.sent
        unit.sent = unit.sentences.length
        unit.closed = true
        if (state.openUnit === unit) state.openUnit = null
        state.trimmedSentences += cut
        state.trimmed += cut
        state.truncatedParagraphs += 1
        continue
      }
      if (skimFirstOnly && unit.emitted === 0) {
        // 追赶模式：只取本段**第一句**，其余整段放弃（不再排进队列）。
        const piece = String(unit.sentences[unit.sent] ?? '').trim()
        const first = firstSentenceOf(piece)
        if (!first || first.length < 2) {
          unit.sent = unit.sentences.length
          unit.closed = true
          if (state.openUnit === unit) state.openUnit = null
          continue
        }
        const restPieces = unit.sentences.length - unit.sent - 1
        unit.sent = unit.sentences.length
        unit.skimmed = true
        unit.closed = true
        if (state.openUnit === unit) state.openUnit = null
        // 诊断：丢掉了本段剩余的片段（第一句之外的内容）
        const droppedParts = restPieces + (first === piece ? 0 : 1)
        if (droppedParts > 0) {
          state.trimmedSentences += droppedParts
          state.truncatedParagraphs += 1
          state.trimmed += droppedParts
        }
        unit.emitted += 1
        return { text: first, para: unit.para, paraStart: true }
      }
      const text = unit.sentences[unit.sent++].trim()
      if (text.length < 2) continue
      const paraStart = unit.emitted === 0
      unit.emitted += 1
      return { text, para: unit.para, paraStart }
    }
    return null
  }

  /** 队列里还有没有可发的句子（不推进游标）。 */
  const hasPending = (state) => state.units.some((unit) => unit.sent < unit.sentences.length)

  /**
   * 发出一条 sentence 事件。
   * @returns {boolean} 是否真的发了一条。
   */
  const emitOne = (state, skimFirstOnly = false) => {
    const item = nextSentence(state, skimFirstOnly)
    if (!item) return false
    state.outstanding += 1
    state.emitted += 1
    state.emittedThisCall += 1
    state.unackedDurations.push(estimateSpeechMs(item.text))
    state.updatedAt = now()
    try {
      emit('sentence', {
        sessionId: state.sessionId || null,
        turnId: state.turnId,
        // index —— 本轮第几句（客户端据此去重/检测丢句）
        index: nextIndex(state.sessionId),
        text: item.text,
        // para —— 所属自然段序号；paraStart —— 该段第一个发出的片段
        para: item.para,
        paraStart: item.paraStart,
      })
    } catch {
      /* 广播失败不影响队列推进 */
    }
    return true
  }

  /** 开/续 pending 模式的时间窗口定时器（旧节奏，每窗口一句）。 */
  const armWindow = (state) => {
    if (state.mode !== 'pending' || state.windowTimer) return
    state.windowTimer = startTimer(() => {
      state.windowTimer = null
      if (state.mode !== 'pending') return
      if (emitOne(state) && hasPending(state)) armWindow(state)
    }, windowMs)
  }

  /** 清掉 ack watchdog。 */
  const clearStall = (state) => {
    if (state.stallTimer) {
      try { clearTimer(state.stallTimer) } catch { /* 忽略 */ }
      state.stallTimer = null
    }
  }

  /**
   * 开/续 ack watchdog：flow 模式下迟迟没有 ack 就放行一条，避免永久卡死。
   *
   * 计时起点：**收到 ack / 真正发出句子**时重置；**不能**被「持续收到文本」重置 ——
   * 否则模型一直在流式输出、客户端却不再 ack（掉线/播放被静音）时，watchdog
   * 永远不会触发，朗读会永久停住（评审实测：持续 push 2.2s、stallMs=300 → 放行 0 次）。
   */
  const armStall = (state) => {
    clearStall(state)
    if (state.mode !== 'flow' || state.outstanding <= 0) return
    state.stallTimer = startTimer(() => {
      state.stallTimer = null
      if (state.mode !== 'flow' || state.outstanding <= 0) return
      // 客户端没有回 ack（掉线 / 播放被跳过 / 老客户端混用）：放行一条。
      state.outstanding = Math.max(0, state.outstanding - 1)
      state.unackedDurations.shift()
      state.stalls += 1
      while (state.outstanding < lead && emitOne(state)) { /* 补到上限 */ }
      armStall(state)
    }, stallMs)
  }

  /**
   * 估算「待朗读音频总时长」：**正在播放的剩余时长** + 已发未确认
   * + 队列里没发的 + 当前段落尚未切句的尾巴。
   *
   * 为什么要把「正在播放的剩余时长」算进来：客户端 ack 的时机是**开始播放**
   * （为了尽早让宿主补发下一句），被 ack 的句子并没有播完 —— 只按「未确认」
   * 计算会把正在念的 2~5 秒漏掉，预算会凭空多出 2~5 秒。
   *
   * @param {object} state - 会话状态。
   * @returns {number} 毫秒。
   */
  const pendingMs = (state) => {
    let ms = Math.max(0, (state.playbackEnd ?? 0) - now())
    for (const duration of state.unackedDurations) ms += duration
    for (const unit of state.units) {
      for (let i = unit.sent; i < unit.sentences.length; i += 1) {
        ms += estimateSpeechMs(unit.sentences[i])
      }
    }
    const tail = state.curPara.slice(state.curParaSentLen ?? 0)
    if (tail.trim()) ms += estimateSpeechMs(tail)
    return ms
  }

  /**
   * 「还没发出去的内容」估算时长（毫秒）= 待朗读总时长 − 正在播放剩余 − 已发未确认。
   *
   * 用途：判断「生成是否明显快于朗读」。`pendingMs` 里含流水线提前量
   * （正在播放的那句 + 最多 lead 句已发未播），即使生成很慢它也可能超过预算，
   * 所以「要不要每段只读首句（skim）」不能用它判断 —— 否则正常语速也会被截断。
   *
   * @param {object} state - 会话状态。
   * @returns {number} 毫秒。
   */
  const backlogMs = (state) => {
    let ms = 0
    for (const duration of state.unackedDurations) ms += duration
    ms += Math.max(0, (state.playbackEnd ?? 0) - now())
    return Math.max(0, pendingMs(state) - ms)
  }

  /**
   * 「追赶最新」：积压超过上限就**跳过旧段落、直接追到最新几段**。
   *
   * 用户反馈（2026-11-01）的演进：
   *   1. 「只把积压裁到 ≤ 预算」：留下的仍是十几秒前的内容 → 反馈「落后 15 秒还不跳」；
   *   2. 「超预算只保留最新 1 段」：太狠，中间全没、上下文断裂；
   *   3. 「保留最新 3 段」：从最新第 3 段开始读，追上最新又留一点上下文；
   *   4. **生成很快时只读首句就跳**（当前实现）：正在读的旧段落不再强制读完 ——
   *      它已经发出的部分（通常就是首句）念完就跳走，剩下的句子直接放弃。
   *      这样追赶的代价从「等一整段」降到「一句」，生成越快越贴近最新。
   *
   * 约束：
   *   - 跳过的单位仍是**完整段落**（未开始发的整段丢）；只有「正在读的旧段」允许
   *     在**已经发出至少一句之后**被截断（用户明确要求"只需要读首句"）；
   *   - **只在生成中**截断：生成结束后剩余的最新段落仍然完整读完（不把结尾也读残）；
   *   - 保留「最新 3 段」：**正在写的那一段**也算其中一段。
   *
   * @param {object} state - 会话状态。
   * @returns {number} 本次跳过的句子数（整段丢弃 + 段内截断）。
   */
  const trimToLatest = (state) => {
    const maxLagMs = Math.max(0, Number(getMaxLagMs()) || 0)
    if (!maxLagMs) return 0
    if (pendingMs(state) <= maxLagMs) return 0
    let keep = TRIM_KEEP_PARAGRAPHS
    let dropped = 0
    for (let i = state.units.length - 1; i >= 0; i -= 1) {
      const unit = state.units[i]
      // 正在写的段（未封口）：算「最新一段」之一，保留（本来也绝不可能丢）。
      if (!unit.closed) {
        keep = Math.max(0, keep - 1)
        continue
      }
      // 正在读的段（已经发过句子）：不能被整段丢掉（已发出的句子收不回来）。
      if (unit.sent > 0) continue
      // 还没开始发的完整段：保留最新 keep 段，其余整段跳过。
      if (keep > 0) {
        keep -= 1
        continue
      }
      state.units.splice(i, 1)
      if (state.openUnit === unit) state.openUnit = null
      dropped += unit.sentences.length
      state.trimmedParagraphs += 1
    }

    if (dropped) {
      state.trimmed += dropped
      state.updatedAt = now()
    }
    return dropped
  }

  /**
   * 驱动发句（内部统一出口）。
   *
   * - `flow`：先「追赶最新」（积压超上限就整段跳过旧段落），再按播放进度补发，
   *   未确认不超过 lead 句；
   * - `pending`：首句立刻发，其余交给时间窗口定时器（与修复前一致）。
   */
  const pump = (state) => {
    if (disposed) return
    state.updatedAt = now()
    if (state.mode === 'flow') {
      // 追赶最新：积压超上限就整段跳到最新几段（保留已开读的段 + 最新 3 段）。
      trimToLatest(state)
      // 「生成很快、正在追赶」时每段只读首句（用户要求）：不再把每段读完才跳。
      // 判断用「还没发出去的内容」（backlog）而不是含流水线提前量的 lag ——
      // 生成慢时 backlog 很小，必须完整朗读，不能被提前量误触发。
      // 生成结束后（streaming=false）恢复完整朗读，避免把结尾读残。
      const maxLagMs = Math.max(0, Number(getMaxLagMs()) || 0)
      const skim = maxLagMs > 0 && state.streaming && backlogMs(state) > maxLagMs
      state.skim = skim
      let emittedNow = 0
      while (state.outstanding < lead && emitOne(state, skim)) emittedNow += 1
      // **只有「真的发了句子」或「当前没有 watchdog」时才（重）计时**：
      // 持续收到文本本身不是进度，不能把 watchdog 一直往后推（评审 P2-1）。
      if (emittedNow > 0 || !state.stallTimer) armStall(state)
      return
    }
    // pending：**每次 llm/stream 调用**的首句都无条件立刻发（用户要尽早听到声音）。
    // 注意用 emittedThisCall 而不是 emitted：一轮里第二次调用（工具调用链）
    // 的 state 复用同一份，emitted 早已 > 0 —— 用 emitted 会让第二次调用的
    // 首句白等一个 400ms 窗口（无 ack 的老客户端会听到「工具调用后卡一下」）。
    if (state.emittedThisCall === 0) {
      if (emitOne(state)) armWindow(state)
    } else if (hasPending(state)) {
      armWindow(state)
    }
  }

  /**
   * 往会话里喂一段流式文本（`text-delta` 的正文部分，代码块已剔除）。
   *
   * 处理顺序（与段落语义严格对应）：
   *   1. 累积到「当前未完成段」，用 `splitParagraphs` 切出**完整段落**；
   *   2. 完整段落的剩余部分并入当前段落单元，并**封口**（该段读完后才进下一段）；
   *   3. 未完成段里已到句末标点的句子**提前**切出（首句尽早开口），
   *      它们归入**同一个**段落单元（段落不会被拆成两截）；
   *   4. 驱动发句。
   *
   * @param {object} state - 会话状态。
   * @param {string} text - 文本片段。
   */
  const pushText = (state, text) => {
    if (disposed) return
    const piece = String(text ?? '')
    if (!piece) return
    state.streaming = true
    // 新内容到了：取消上一次调用结束时挂起的「收尾排空」——
    // 不能让它在新内容流式到达的中途把队列一次性倒出去（会绕过追赶/流控）。
    if (state.flushTimer) {
      try { clearTimer(state.flushTimer) } catch { /* 忽略 */ }
      state.flushTimer = null
    }
    state.curPara += piece
    const { paragraphs, rest } = splitParagraphs(state.curPara)
    state.curPara = rest
    let first = true
    for (const para of paragraphs) {
      // 第一段就是「当前未完成段」补全出来的：它开头那几句已经提前发过
      // （`curParaSentLen` 个字符），这里只补**剩余**部分，绝不重复发。
      const cut = first ? Math.min(state.curParaSentLen, para.length) : 0
      if (first) state.curParaSentLen = 0
      first = false
      appendBody(state, para.slice(cut), true)
    }
    // 未完成段里已完成的句子：提前切出（首句尽早开口），归入当前段落单元。
    const { parts } = splitSentenceParts(state.curPara)
    if (parts.length) {
      let skip = 0
      let acc = 0
      while (skip < parts.length && acc < state.curParaSentLen) {
        acc += parts[skip].length
        skip += 1
      }
      for (const part of parts.slice(skip)) {
        appendBody(state, part, false)
        state.curParaSentLen += part.length
      }
    }
    pump(state)
  }

  /**
   * 把一段文本的句子追加进**当前段落单元**（或新开一个段落单元）。
   *
   * @param {object} state - 会话状态。
   * @param {string} raw - 原文片段。
   * @param {boolean} close - 是否封口（true = 这段已完整，读完就进下一段）。
   */
  const appendBody = (state, raw, close) => {
    const sentences = sentencesOf(raw)
    let unit = state.openUnit
    if (sentences.length) {
      if (!unit || unit.closed) {
        unit = { para: state.paraSeq ?? 0, sentences: [], sent: 0, emitted: 0, closed: false }
        state.paraSeq = (state.paraSeq ?? 0) + 1
        state.units.push(unit)
        state.openUnit = unit
      }
      unit.sentences.push(...sentences)
    }
    if (close && unit) {
      unit.closed = true
      if (state.openUnit === unit) state.openUnit = null
    }
  }

  /**
   * `pending` 模式收尾：把排队剩下的句子一次发完（旧客户端兼容路径，不丢尾巴）。
   * @param {object} state - 会话状态。
   */
  const flushPending = (state) => {
    while (emitOne(state)) { /* 发完 */ }
    if (state.windowTimer) {
      try { clearTimer(state.windowTimer) } catch { /* 忽略 */ }
      state.windowTimer = null
    }
  }

  /**
   * 一次 `llm/stream` 调用结束：把当前未完成段落封口。
   *
   * - `flow` 模式：只封口，剩余句子按客户端播放进度补发（不 burst）；
   * - `pending` 模式（旧客户端 / 首条 ack 还没到）：**先等一个 grace**（`flushGraceMs`）
   *   再一次性发完。wait 的意义：新客户端首条 ack 通常 1~2 秒内到，到了就切 flow、
   *   走流控与追赶；如果一结束就同步排空，追赶在这条调用上完全失效（评审 P2-3）。
   *   老客户端不会有 ack，grace 到点后照旧发完——不丢尾巴，只晚 ~1s。
   */
  const endCall = (state) => {
    if (disposed) return
    // 生成（这一次调用）结束：之后不再做「只读首句就跳走」的段内截断，
    // 保留的最新段落要完整读完（不把结尾读残）。
    state.streaming = false
    if (state.curParaSentLen > 0) {
      const cut = Math.min(state.curParaSentLen, state.curPara.length)
      appendBody(state, state.curPara.slice(cut), true)
    } else {
      appendBody(state, state.curPara, true)
    }
    state.curPara = ''
    state.curParaSentLen = 0
    if (state.openUnit) {
      state.openUnit.closed = true
      state.openUnit = null
    }
    state.updatedAt = now()
    if (state.mode === 'pending') {
      // 追赶关闭 / grace=0 / 剩余内容本来就没超预算：保持旧语义，调用结束就同步发完
      // （小尾巴没必要延迟；也保证老客户端与既有测试行为不变）。
      const maxLagMs = Number(getMaxLagMs()) || 0
      if (flushGraceMs <= 0 || maxLagMs <= 0 || pendingMs(state) <= maxLagMs) {
        flushPending(state)
        return
      }
      if (!state.flushTimer) {
        state.flushTimer = startTimer(() => {
          state.flushTimer = null
          if (disposed || state.mode !== 'pending') return
          flushPending(state)
        }, flushGraceMs)
      }
    } else {
      pump(state)
    }
  }

  /**
   * 客户端回报「已开始播放 count 句」。
   *
   * 第一条 ack 会把会话从 `pending` 切到 `flow`：清掉旧的时间窗口定时器，
   * 之后严格按「已发未确认 <= lead」发句。
   *
   * **未确认句数按实际减**（不能在切换时清 0）：
   *   `pending` 阶段已经发出去的句子同样是「已发未确认」—— 客户端可能正在播放，
   *   也可能一次攒几句一起 ack（count=2）。切换时若把未确认清零，会把
   *   pending 阶段已发的句子当成「客户端已经播过」，于是多预发几句，
   *   超出 `lead` 上限（实测批量 ack 场景会冲到 4 > 3）。
   *
   * @param {{sessionId?: string, turnId?: string, count?: number}} ack - 回报。
   * @returns {boolean} 是否被接受（会话/轮次对不上时为 false）。
   */
  const ack = (ackPayload = {}) => {
    const key = ackPayload.sessionId || ''
    const state = sessions.get(key)
    if (!state) {
      rejectedAcks += 1
      lastRejectedAck = { reason: 'unknown-session', sessionId: key, at: now() }
      return false
    }
    const turnId = ackPayload.turnId
    if (turnId && state.turnId && turnId !== state.turnId) {
      rejectedAcks += 1
      lastRejectedAck = { reason: 'turn-mismatch', sessionId: key, turnId, stateTurnId: state.turnId, at: now() }
      return false
    }
    const count = Math.max(1, Math.min(64, Math.floor(Number(ackPayload.count) || 1)))
    state.acks += count
    state.updatedAt = now()
    if (state.mode === 'pending') {
      // 收到第一条 ack：说明客户端支持流控。清掉旧节奏定时器与收尾 grace，改按进度发。
      state.mode = 'flow'
      if (state.windowTimer) {
        try { clearTimer(state.windowTimer) } catch { /* 忽略 */ }
        state.windowTimer = null
      }
      if (state.flushTimer) {
        try { clearTimer(state.flushTimer) } catch { /* 忽略 */ }
        state.flushTimer = null
      }
    }
    state.outstanding = Math.max(0, state.outstanding - count)
    // ack = 客户端**开始播放**（不是播完）：把这些句子从「未确认」移入「正在播放」
    // 时间线，按预计播完时刻累计 —— 正在念的 2~5 秒也要算进「落后」（用户反馈）。
    const playbackDurations = []
    while (playbackDurations.length < count && state.unackedDurations.length) {
      playbackDurations.push(state.unackedDurations.shift())
    }
    const providedMs = Number(ackPayload.durationMs)
    const playedMs = count === 1 && Number.isFinite(providedMs) && providedMs > 0
      ? Math.min(120000, providedMs) // 客户端给了真实音频时长（decoded.duration）→ 更准
      : playbackDurations.reduce((sum, d) => sum + d, 0)
    if (playedMs > 0) {
      state.playbackEnd = Math.max(now(), state.playbackEnd ?? 0) + playedMs
    }
    pump(state)
    // ack 是真实的播放进度：把 watchdog 重新计时（pump 里可能没发新句、不会 re-arm）。
    armStall(state)
    return true
  }

  /** 回收空闲会话（宿主没有会话结束回调，只能按空闲超时兜底）。 */
  const prune = () => {
    const t = now()
    for (const [key, state] of sessions) {
      const busy = state.outstanding > 0 || state.units.length > 0 || Boolean(state.curPara)
      if (!busy && t - state.updatedAt > idleMs) {
        clearTimers(state)
        sessions.delete(key)
      }
    }
  }

  /** 清掉全部定时器与会话状态（插件卸载时调用）。 */
  const dispose = () => {
    disposed = true
    for (const state of sessions.values()) clearTimers(state)
    sessions.clear()
  }

  /**
   * SSE 新连接（页面刷新 / 断线重连）：把旧连接遗留的「已发未确认」清掉。
   *
   * 为什么需要：刷新页面后旧 SSE 连接关闭，但它之前发出的句子永远不会被 ack；
   * 宿主 `outstanding` 一直卡在 lead，新页面的第一句要等 watchdog（10 秒）才发 ——
   * 实测首句延迟 10025ms（评审 P2-2）。新连接建立说明旧播放队列已不存在，
   * 未确认数没有意义，直接归零并让调度器继续补发（已发出的那几句不重发）。
   */
  const resetOutstanding = () => {
    if (disposed) return
    let touched = 0
    for (const state of sessions.values()) {
      if (state.outstanding <= 0 && state.unackedDurations.length === 0) continue
      state.outstanding = 0
      state.unackedDurations.length = 0
      state.playbackEnd = 0
      state.stalls = 0
      clearStall(state)
      touched += 1
      pump(state)
    }
    return touched
  }

  /** 诊断快照（挂到 /diagnostics，方便定位「朗读不动/滞后」）。 */
  const diagnostics = () => {
    const list = []
    for (const [sessionId, state] of sessions) {
      list.push({
        sessionId,
        turnId: state.turnId,
        mode: state.mode,
        outstanding: state.outstanding,
        acks: state.acks,
        emitted: state.emitted,
        stalls: state.stalls,
        /** 当前估算的待朗读音频时长（毫秒，含正在播放的剩余时长）：超过追赶上限就会被整段跳过。 */
        lagMs: Math.round(pendingMs(state)),
        /** 其中「正在播放、还没播完」的剩余时长（毫秒）——追赶计时不能漏掉它。 */
        playingMs: Math.max(0, Math.round((state.playbackEnd ?? 0) - now())),
        /** 当前配置的追赶上限（毫秒；0=关闭）。 */
        budgetMs: Math.max(0, Number(getMaxLagMs()) || 0),
        /** 「还没发出去的内容」估算时长：用它判断"生成是否明显快于朗读"（skim 条件）。 */
        backlogMs: Math.round(backlogMs(state)),
        /** 追赶时保留最新几段（默认 3）。 */
        keepParagraphs: TRIM_KEEP_PARAGRAPHS,
        /** 追赶最新跳过的句子数 / 段落数。 */
        trimmed: state.trimmed,
        trimmedParagraphs: state.trimmedParagraphs,
        /** 段内截断（生成很快时"只读首句就跳走"）丢掉的句子数 / 段落数。 */
        trimmedSentences: state.trimmedSentences,
        truncatedParagraphs: state.truncatedParagraphs,
        /** 是否仍在生成中（决定要不要做"只读首句就跳"的段内截断）。 */
        streaming: Boolean(state.streaming),
        /** 当前是否处于「只读每段首句」的追赶模式。 */
        skim: Boolean(state.skim),
        pendingUnits: state.units.length,
        /** pending 模式收尾的 grace 定时器是否在等（老客户端到点后一次发完）。 */
        awaitingFlush: Boolean(state.flushTimer),
        lastAt: state.updatedAt,
      })
    }
    return list
  }

  /** 调度器级诊断（ack 被拒等全局计数）。 */
  const schedulerDiagnostics = () => ({
    rejectedAcks,
    lastRejectedAck,
    disposed,
  })

  return {
    /**
     * 取一个「喂文本」的写入端（一次 llm/stream 调用一个）。
     * @param {string} sessionId - 会话 id。
     * @param {string} turnId - 本轮 id。
     */
    reader(sessionId, turnId) {
      const state = stateFor(sessionId, turnId)
      const key = state.sessionId
      // 新的一次 llm/stream 调用：它自己的首句要立刻发（指标按调用重置）。
      state.emittedThisCall = 0
      /**
       * 这个 reader 是否仍然「有效」：插件已卸载、或这一轮已被新一轮替换
       * （state 被 sessions 换掉）后，旧的 reader 不能再广播上一轮的句子/起定时器
       * （评审 P3：换轮后旧 reader 迟到 end() 会重播上一轮）。
       */
      const alive = () => !disposed && sessions.get(key) === state
      return {
        /** 喂入一段正文文本（代码块已被调用方剔除）。 */
        push(text) { if (alive()) pushText(state, text) },
        /** 本次调用结束：封口当前段落。 */
        end() { if (alive()) endCall(state) },
      }
    },
    /** 客户端播放进度回报。 */
    ack,
    /**
     * SSE 新连接（页面刷新/重连）：释放旧连接遗留的未确认配额。
     * @returns {number} 被重置的会话数。
     */
    resetOutstanding,
    /** 回收空闲会话。 */
    prune,
    /** 插件卸载清理。 */
    dispose,
    /** 诊断快照（按会话）。 */
    diagnostics,
    /** 诊断快照（调度器级：ack 被拒计数等）。 */
    schedulerDiagnostics,
  }
}
