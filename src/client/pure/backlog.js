/**
 * 朗读积压裁剪（依赖无关、可独立测试的模块）。
 *
 * 背景：
 *   助手是流式输出的，句子一到就排队播。
 *   但**生成比朗读快**时 —— 尤其模型一次性吐出整段回复 ——
 *   队列会越积越长，于是：
 *
 *     1. 听到的内容离屏幕上的最新回复越来越远；
 *     2. 新一轮都开始念了，还在念上一轮的旧内容（听着像答非所问）。
 *
 * 所以待播句子有上限，超了就丢**最旧**的，
 * 保证朗读始终贴着最新内容。
 *
 * 注意：这里**不是**严格意义「不修改入参」的纯函数 ——
 * 它原地裁剪调用方自己的数组（朗读队列是 `pumpQueue` 内的局部数组，
 * 换新引用会让主循环/后台任务读到旧引用，风险大于收益）。
 * 它仍然是**依赖无关、无 IO、可被测试原生 import 跑场景**的单元。
 */

/**
 * 裁剪待播句子，只留最新的若干句。
 *
 * 语义：
 *   - `inflight` 是**正在合成**的（FIFO，旧的在前）；
 *     `queue` 是**还没开始合成**的（FIFO，更新的在后）。
 *     两者拼起来就是全局的待播顺序。
 *   - 超过 `max` 就丢**最旧的可丢项**：
 *     先找 `inflight` 里第一个 `index !== 0`（更旧的那批），
 *     再找 `queue` 里第一个 `index !== 0`。
 *     ⚠️ 不能只看队头 —— 受保护的首句（index 0）可能挡在队头，
 *     只看队头会退而丢**队尾（最新）**的句子，正好违背目标。
 *   - `index === 0` 的句子（本轮第一句）**永不丢弃**：
 *     朗读的第一声应该是这条回复的开头，不是中段。
 *
 * 原地修改传入的数组并返回它（数组就是调用方自己的队列）。
 *
 * @param {Array<{index: number}>} inflight - 正在合成的句子。
 * @param {Array<{index: number}>} queue - 还没开始合成的句子。
 * @param {number} max - 待播上限。
 * @returns {{inflight: Array, queue: Array}} 裁剪后的两个队列。
 */
export function trimBacklog(inflight, queue, max) {
  const a = inflight ?? []
  const b = queue ?? []
  const limit = Number.isFinite(max) && max > 0 ? max : 1
  while (a.length + b.length > limit) {
    // 找最旧的可丢项：inflight(更旧) 里第一个非首句，其次 queue 里第一个。
    const dropA = a.findIndex((x) => x.index !== 0)
    if (dropA >= 0) {
      a.splice(dropA, 1)
      continue
    }
    const dropB = b.findIndex((x) => x.index !== 0)
    if (dropB >= 0) {
      b.splice(dropB, 1)
      continue
    }
    // 只剩受保护的第一句了 —— 不能再丢。
    break
  }
  return { inflight: a, queue: b }
}
