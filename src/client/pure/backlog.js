/**
 * 朗读积压裁剪（依赖无关、可独立测试的模块）。
 *
 * 背景（2026-11-01 修订）：
 *   旧实现按「丢最旧的非首句」裁剪，看着像「贴着最新内容」，实际上丢掉的
 *   正是**接下来马上要播的那几句** —— 用户听到的是「首句 → 直接跳到最新
 *   内容」，落点常常在某段中间，正是「挑到最新段落中非首句的句子」这个听感；
 *   如果后续又插进旧段落（宿主重复发/换轮迟到），还会「读完后面又读前面」。
 *
 *   现在宿主改成了**流控**（已发未确认句数 <= READ_ALOUD_LEAD，客户端每开始
 *   播一句回一条 reading-ack），生成快于播放时句子不再涌进客户端队列 ——
 *   正常情况下这里根本不会被调用。它退化成**安全网**（老宿主、ack 丢失、
 *   重连、宿主降级回 400ms 时间窗口）。
 *
 *   安全网也必须守住「段落完整性」与「追赶最新」两个方向：
 *     - 按 `para`（宿主给的自然段序号）**整段**丢弃；
 *     - 保护「含本轮首句(index===0)的段落」、「正在播放的段落」、以及
 *       **最新的一组（最后一个 group）** —— 绝不能为了压到上限把最新段丢掉，
 *       那正好和「追赶最新」相反（评审 P2）；
 *     - 只从**最旧**的未保护组开始丢；若丢完仍超上限（剩下的全是受保护组），
 *       接受**软上限**：宁可暂时多留几句，也不丢正在读的段或最新段；
 *     - 绝不允许「保留段尾、丢掉段首」—— 那还是会从段落中间开始播；
 *     - `para < 0`（老宿主没给）时退化成「每句各成一段」，仍然能裁剪。
 *
 * 注意：这里**不是**严格意义「不修改入参」的纯函数 ——
 * 它原地裁剪调用方自己的数组（朗读队列是 `pumpQueue` 内的局部数组，
 * 换新引用会让主循环/后台任务读到旧引用，风险大于收益）。
 * 它仍然是**依赖无关、无 IO、可被测试原生 import 跑场景**的单元。
 */

/**
 * 裁剪待播句子，只留最新的若干句（**以段落为最小单位**）。
 *
 * 语义要点：
 *   - 受保护的组不丢：含本轮首句(index===0)的组、正在播放的组、**最新一组**；
 *   - 只从最旧的可丢组开始整段丢（追赶最新方向）；
 *   - 丢不动了就接受**软上限**：返回的 `dropped` 可能不足以把总数压到 `max`，
 *     调用方不要把它当成「一定 ≤ max」。
 *
 * @param {Array<{index: number, para?: number}>} inflight - 正在合成的句子
 *   （按播放顺序在前；FIFO，旧的在前）。
 * @param {Array<{index: number, para?: number}>} queue - 还没开始合成的句子
 *   （FIFO，更新的在后）。两者拼起来就是全局待播顺序。
 * @param {number} max - 待播上限（句）。
 * @param {{playingPara?: number|null}} [options] - `playingPara`：正在播放的
 *   段落序号；整段保护，避免只播了段首、剩下的被裁掉。
 * @returns {{inflight: Array, queue: Array, dropped: number, droppedItems: Array}}
 *   裁剪后的两个队列、**被丢掉的句数**，以及**被丢掉的那些队列项**
 *   （调用方要按句子自己的 sessionId/turnId 回执，把宿主配额还回去）。
 */
export function trimBacklog(inflight, queue, max, options = {}) {
  const a = inflight ?? []
  const b = queue ?? []
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 1
  const playingPara = Number.isInteger(options?.playingPara) && options.playingPara >= 0
    ? options.playingPara
    : null
  if (a.length + b.length <= limit) return { inflight: a, queue: b, dropped: 0, droppedItems: [] }

  // 1) 按播放顺序拼起来，再聚成「整段」。
  //    para < 0 的项无法判断属于哪一段 —— 每句各成一组：
  //    既不会把老客户端的句子并成一大段（那样会丢得过多），也不会让裁剪失效。
  const groups = []
  for (const item of [...a, ...b]) {
    const para = Number.isInteger(item?.para) && item.para >= 0 ? item.para : -1
    const last = groups[groups.length - 1]
    if (para >= 0 && last && last.para === para) {
      last.items.push(item)
      continue
    }
    groups.push({ para, items: [item] })
  }

  // 2) 保护三类组：
  //    - 含本轮首句（index===0）的组：开头不能缺；
  //    - 正在播放的段落（playingPara）：不能只留半段；
  //    - **最后一组（最新内容）**：安全网绝不能为了压到上限而丢掉最新段 ——
  //      那与「追赶最新」正好相反（评审 P2：受保护组超上限时会丢最新段）。
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    group.protected =
      i === groups.length - 1 ||
      group.items.some((item) => item?.index === 0) ||
      (group.para >= 0 && group.para === playingPara)
  }

  // 3) 从**最旧**的组开始整段丢，直到降到上限；受保护的组整段跳过。
  //    若丢完所有可丢组仍然超上限（剩下的全是受保护组），接受**软上限**：
  //    宁可暂时多留几句，也不为了压数字去丢正在读的段或最新段。
  const toDrop = new Set()
  const droppedItems = []
  let total = a.length + b.length
  let dropped = 0
  for (const group of groups) {
    if (total <= limit) break
    if (group.protected) continue
    for (const item of group.items) {
      toDrop.add(item)
      droppedItems.push(item)
      total -= 1
      dropped += 1
    }
  }

  // 4) 原地删除（保持数组引用不变：调用方持有这两个数组）。
  if (dropped > 0) {
    const removeDropped = (arr) => {
      let write = 0
      for (let read = 0; read < arr.length; read++) {
        if (toDrop.has(arr[read])) continue
        arr[write++] = arr[read]
      }
      arr.length = write
    }
    removeDropped(a)
    removeDropped(b)
  }

  return { inflight: a, queue: b, dropped, droppedItems }
}
