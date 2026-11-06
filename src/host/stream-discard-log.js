/**
 * 「这一轮的实时文字为什么被清空了」的记录处（批次 16，docs §8.58）。
 *
 * 为什么需要它：浮层里实时文字整段消失是用户**看得见**的事，但代码这边一直答不出为什么 ——
 * 丢弃一个会话的流式状态一共有五个入口（识别器被释放、下一次取流时发现句柄换了、
 * 空闲超时、解码这一侧抛错、客户端主动结束这一轮），每一处都是静默的。
 * 批次 12 修的正是其中一个（超限的请求**不许**丢弃，docs §8.53），
 * 可修完之后「这次到底有没有丢弃」仍然只能靠读代码相信：装机上问一句
 * 「刚那块超限分片有没有把我的会话抹掉」，`/diagnostics` 答不出来。
 * 这个模块把那五处变成**数得出来的东西**：谁丢的、什么时候、隔了多少毫秒没音频。
 *
 * 为什么住在模块级、不像其它分组那样进 `createDiagnostics()`：
 *   被记录的状态本身（`index.js` 的 `streamingStates` / `recognizers`）就是模块级的，
 *   跨 `apply()` 共享；而诊断记录器是每个宿主实例一份。
 *   跟着实例走就记不到 `freeRecognizer` 与空闲清扫这两条**在实例外面**跑的路径 ——
 *   那两条恰恰是最难复现的（「重下模型之后实时文字没了」）。
 *   代价写清楚：同一进程里多个实例共用这一条日志（测试里就是这种情形），
 *   所以判据一律按自己的 sessionId 过滤、按差值数，**不判绝对值**。
 *
 * @module dsh-voice-typing/stream-discard-log
 */

/**
 * 丢弃流式会话状态的五个入口，词表只在这里写一次。
 *
 * 每个调用点必须报其中一个：新增第六个入口时如果图省事传个字符串，
 * 判据（`test/stream-discard.test.mjs` 按这张表逐个真跑）就会红在那条词表比对上。
 */
export const STREAM_DISCARD_REASONS = Object.freeze({
  /** 识别器正在被释放（重下、换语言、切档位、插件停用），引用它的会话必须先丢。 */
  RECOGNIZER_FREED: 'recognizer-freed',
  /** 下一次取流时发现状态里那个句柄已经不是当前识别器了（释放之后重建那条路）。 */
  RECOGNIZER_CHANGED: 'recognizer-changed',
  /** 空闲清扫：超过 `STREAM_IDLE_TIMEOUT_MS` 没有新音频，丢掉以免残留串到下一轮。 */
  IDLE_TIMEOUT: 'idle-timeout',
  /** `/asr-stream` 的 catch：解码这一侧真出事了（请求级拒绝**不**算，见批次 12）。 */
  DECODE_ERROR: 'decode-error',
  /** `/asr-stream/reset`：客户端主动结束这一轮，正常路径。 */
  CLIENT_RESET: 'client-reset',
})

/**
 * 事件窗口：`/diagnostics.streamDiscard.events` 最多留几条。
 *
 * 单独一个常量、不复用 `diagnostics.js` 的 `MAX_EVENTS_PER_GROUP`：
 * 那两个窗口是两回事，一个数字改了不该带动另一个。
 * 导出它同样是给判据用的 —— 判溢出要按同一个数写，不在测试里抄 20。
 */
export const MAX_DISCARD_EVENTS = 20

/** 丢弃事件（旧→新）。 */
const discardEvents = []

/** 丢弃**总次数**（不随窗口裁剪）：算「这轮被抹了几次」时的诚实分母。 */
let discardCount = 0

/**
 * 记一次已经发生过的丢弃。只由 `index.js` 的 `discardStreamingState` 调用 ——
 * 那里才知道「这次有没有真丢掉状态」，别的调用点报「丢了」而其实什么都没丢，
 * 就是把这条日志变成噪声。
 *
 * @param {object} event - {sessionId, reason, modelId, idleMs}。
 *   `idleMs` 是「距上一次喂音频过了多久」，`idle-timeout` 那条主要靠它分辨。
 */
export function noteStreamingDiscard(event) {
  discardCount += 1
  discardEvents.push({
    at: Date.now(),
    sessionId: String(event?.sessionId ?? ''),
    reason: String(event?.reason ?? ''),
    modelId: String(event?.modelId ?? ''),
    idleMs: Number.isFinite(event?.idleMs) ? event.idleMs : null,
  })
  while (discardEvents.length > MAX_DISCARD_EVENTS) discardEvents.shift()
}

/**
 * `/diagnostics.streamDiscard` 的那一块：`{count, window, events}`。
 * @returns {{count: number, window: number, events: Array<object>}}
 */
export function streamDiscardSnapshot() {
  return { count: discardCount, window: MAX_DISCARD_EVENTS, events: [...discardEvents] }
}
