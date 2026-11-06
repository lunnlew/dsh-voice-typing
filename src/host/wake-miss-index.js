/**
 * `/diagnostics.wakeMiss.byWake` —— 混淆样本按**当时配置的唤醒词**分好组（批次 26，docs §8.74）。
 *
 * 这一层要解决的是 §8.56(三) 记下的那笔欠账。`wakeMiss.events` 里每条都带 `wake`
 * （那条样本是在哪个唤醒词下没匹配上的，取的是宿主当时的配置），可是改过唤醒词之后
 * 这份历史是**混着两个词**的：判「这些错法里有多少其实听起来就是唤醒词」时，
 * 拿 `小鲸` 那一组的样本去和 `小虾` 比，算出来的比例是假的。
 * 批次 14 当时的说法是「算分布时要自己按 wake 分组，本批没提前做二级索引」——
 * 于是这把尺子每次用都要先手工分一次组，而手工分组这一步没有人判过对错。
 *
 * 为什么顺手把「组内原文去重计数」也做出来：真正要读的是**分布**而不是流水，
 * 「同一句被听错的形式反复出现几次」才是判唤醒方案 A/B/C 的输入；
 * 只有分组计数的话，读的人仍然得自己数第二遍。
 *
 * 为什么它是**算出来的**、不是另外存的一份：
 *   1. 输入只有 `events` 这一份窗口，索引和明细永远同源 —— 不会出现「明细 20 条、索引加起来 21 条」
 *      这种自相矛盾的读数（存一份就得维护一份，维护一份就会漏一处）；
 *   2. 不新增隐私面：`/diagnostics` 这一趟响应里原文本来就整段在 `events` 上，
 *      分组只是把同一批字符串换个摆法，没有多带一个字的新内容；
 *   3. 窗口 20 条的量级下，每次 `/diagnostics` 现算的成本可以忽略，
 *      换来的是「改唤醒词这件事不需要任何迁移逻辑」—— 旧样本带着旧词，索引自然把它们分回旧词那一格。
 *
 * 代价说清楚：`byWake` 里每个数字的分母是**窗口**（最近 `MAX_EVENTS_PER_GROUP` 条），
 * 不是 `wakeMiss.count` 那个不裁剪的总次数。窗口外被挤掉的样本进不了索引，
 * 所以 `sum(byWake[].count) <= count` 才是这里该读的口径（判据里就按这条判，见 §8.74）。
 *
 * @module dsh-voice-typing/wake-miss-index
 */

/**
 * 把 wake-miss 的窗口事件按 `wake` 归并成一份可直接读的分布。
 *
 * 排序规则是定死的，判据要能复现：
 *   - 组之间按 `count` 从多到少；次数相同则按**该组最早那条样本的出现顺序**（先出现的在前）；
 *   - 组内 `texts` 按 `count` 从多到少；次数相同则按该原文第一次出现的顺序。
 * 不做字母序、不做拼音序 —— 那两种都会让「刚发生的那一批」在长序列里排到后面去。
 *
 * @param {Array<{text?: string, wake?: string}>} events 诊断记录器里 `wakeMiss` 那组（旧→新）
 * @returns {Array<{wake: string, count: number, texts: Array<{text: string, count: number}>}>}
 */
export function groupWakeMissByWake(events) {
  /** @type {Array<{wake: string, count: number, texts: Array<{text: string, count: number}>}>} */
  const groups = []
  const indexOfWake = new Map()

  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue
    // 空唤醒词是一种合法现场（配置被清空、或这条记录早于面板写过一次），
    // 它要单独占一格而不是和别的词混进同一格 —— 混进去就是把「没配词」这个原因洗掉了。
    const wake = String(event.wake ?? '')
    const text = String(event.text ?? '')

    let group = indexOfWake.get(wake)
    if (!group) {
      group = { wake, count: 0, texts: [] }
      indexOfWake.set(wake, group)
      groups.push(group)
    }
    group.count += 1

    const hit = group.texts.find((row) => row.text === text)
    if (hit) hit.count += 1
    else group.texts.push({ text, count: 1 })
  }

  for (const group of groups) {
    group.texts.sort((a, b) => b.count - a.count)
  }
  return groups.sort((a, b) => b.count - a.count)
}
