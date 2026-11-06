/**
 * 诊断事件记录器。
 *
 * 设计原则：
 *   1. **保留计数**：`stats.*` 的 25 个计数字段不动（/diagnostics 面板和心跳上报依赖它们）；
 *   2. **增加事件历史**：每次失败/关键事件记录一条带时间戳的详情，环形缓冲（最多 N 条）；
 *   3. **分类管理**：按引擎/功能分组（localTts / onlineTts / neuralTts / sovitsTts / voicePrompt），
 *      每组独立的事件队列，避免混在一起难以定位；
 *   4. **可序列化**：`/diagnostics` 路由直接 JSON.stringify 输出，不需要额外转换。
 *
 * 与旧 stats.* 的关系：
 *   - 旧：`stats.localTtsFailures = 3; stats.lastLocalTtsError = '...'; stats.lastLocalTtsAt = 123456`
 *   - 新：保留计数（向后兼容），同时 `recorder.record('localTts', { error, context })` 自动维护事件队列
 *   - /diagnostics 输出：`{ localTts: { failures: 3, events: [{at, error, context}, ...] } }`
 *
 * @module lib/diagnostics
 */

/**
 * 每组事件队列的上限（环形缓冲，超过后丢弃最旧的）。
 *
 * 导出它是因为 `/diagnostics` 要把「窗口多大」一起报出来：
 * 读的人必须能分辨「只有这 8 条」和「一共 173 条，这是最近 20 条」——
 * 拿窗口里的样本算比例时，分母是这里的条数还是那个工作者的总数，结论完全不同。
 */
export const MAX_EVENTS_PER_GROUP = 20

/**
 * `wakeMiss` 组里每条原文的长度上限。
 *
 * 诊断面是给人看分布的，不是对话内容的第二份副本 —— 待机里一句长闲聊整段搬进来，
 * `/diagnostics` 就成了隐私放大器。客户端本来就截到 60 字，这里是宿主的第二道兜底
 * （不信任调用方）：任何别的上报方都不能越过它。
 *
 * 导出它：测试要按同一个数字判截断，抄一份 80 就是第二处实现。
 */
export const WAKE_MISS_TEXT_LIMIT = 80

/**
 * 创建诊断记录器实例。
 *
 * 为什么是工厂而不是模块级单例：测试会在同一进程里多次 apply()，
 * 每个宿主实例必须有自己的诊断队列（与 stats 对象同一生命周期）。
 *
 * @returns {{ record: function, events: function, snapshot: function }}
 */
export function createDiagnostics() {
  /** 分组事件队列：{ localTts: [], onlineTts: [], ... } */
  const eventQueues = new Map()

  /**
   * 记录一次事件。
   *
   * @param {string} group - 事件分组（'localTts' / 'onlineTts' / 'neuralTts' / 'sovitsTts' / 'voicePrompt' / 'uiAction' 等）
   * @param {object} event - 事件详情（必须包含 at: number，可选 error/context 等）
   */
  function record(group, event) {
    if (!event || typeof event !== 'object') return
    // 确保有 at 字段（调用方可能忘传）
    const entry = { at: Date.now(), ...event }
    let queue = eventQueues.get(group)
    if (!queue) {
      queue = []
      eventQueues.set(group, queue)
    }
    queue.push(entry)
    // 环形缓冲：超过上限就丢弃最旧的
    while (queue.length > MAX_EVENTS_PER_GROUP) {
      queue.shift()
    }
  }

  /**
   * 读取指定分组的事件队列（只读快照，不是引用）。
   *
   * @param {string} group - 事件分组名
   * @returns {Array<object>} 该分组的事件数组（按时间正序，最新在末尾）
   */
  function events(group) {
    const queue = eventQueues.get(group)
    return queue ? [...queue] : []
  }

  /**
   * 输出所有分组的诊断快照（用于 /diagnostics 路由）。
   *
   * @returns {object} 形如 { localTts: { events: [...] }, onlineTts: { events: [...] }, ... }
   */
  function snapshot() {
    const result = {}
    for (const [group, queue] of eventQueues.entries()) {
      result[group] = { events: [...queue] }
    }
    return result
  }

  return { record, events, snapshot }
}

/**
 * 事件分组名常量（避免字符串拼写错误）。
 *
 * 为什么用对象而不是枚举：bundle-sync 的「同一判据不许双实现」守卫按算法关键行扫描，
 * 常量对象在产物里只有一份定义，字符串值可以被多处引用而不触发重复计数。
 */
export const DIAGNOSTICS_GROUPS = Object.freeze({
  LOCAL_TTS: 'localTts',
  ONLINE_TTS: 'onlineTts',
  NEURAL_TTS: 'neuralTts',
  SOVITS_TTS: 'sovitsTts',
  VOICE_PROMPT: 'voicePrompt',
  /**
   * 待机里「听到但没匹配上唤醒词」的那句识别原文（批次 14，docs §8.56）。
   *
   * 与其它分组的差别：这里存的是**用户说的话**（截到 80 字），不是错误消息。
   * 这是有意为之 —— 判唤醒方案要的是混淆分布，光有计数答不出
   * 「小鱼被识成了什么」。原文本来就已经进 `stats.client`（单格），
   * 这一组只是让它不再被下一句冲掉。
   */
  WAKE_MISS: 'wakeMiss',
})
