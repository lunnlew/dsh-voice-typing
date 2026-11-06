/**
 * 朗读回执（reading-ack）客户端侧的算术（依赖无关、可原生 import 跑）。
 *
 * 这套协议在做什么：宿主每发一句给客户端就在自己账上记一笔「已发未确认」，
 * 客户端每开始播一句（或每丢掉一句）回一条 `POST /reading-ack` 把配额还回去。
 * 一条回执的 `count` 可以大于 1 —— 一次清掉一批积压句子时按条数归还。
 *
 * 为什么必须**拆批**：宿主的 clamp 是 1..64
 * （`Math.max(1, Math.min(64, ...))`，实测见 `test/reading-ack-contract.test.mjs` 第 3 节）。
 * 一次要还 200 条如果发一条 `count=200`，宿主只会认 64，
 * 剩下 136 条配额永远还不回去 —— 表现是「朗读越来越慢、最后干脆停住，
 * 宿主干等到 watchdog 才补发」。所以发送方自己按 64 拆成几条。
 *
 * 批次 6f：这段算术原先直接写在组件的 `ackReading` 里
 * （`for (let left = total; left > 0; left -= 64)`），
 * 于是守着它的只有 `read-aloud-stop.test.mjs` 里一条扫源码的正则。
 * 抽出来之后判据看的是**拆出来的批长什么样**，跟写法无关。
 *
 * 运行方：`src/client/dom/mic-button.js` 的 `ackReading`；
 * 判据：`test/reading-ack-contract.test.mjs` 第 6 节。
 */

/** 单次回执的条数上限，必须与宿主 `/reading-ack` 的 clamp 上限一致。 */
export const ACK_BATCH_LIMIT = 64

/**
 * 把调用方给的 count 收敛成「至少 1 的整数」。
 *
 * 非数字 / Infinity / NaN / 负数 / 0 一律按 **1** 计：宁可多归还一句，
 * 也不能因为一个异常值把这批配额卡住（宿主那边等的是条数，不是我们的体面）。
 *
 * @param {unknown} count - 调用方给的条数。
 * @returns {number} 大于等于 1 的整数。
 */
export function normalizeAckCount(count) {
  return Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : 1
}

/**
 * 按单次上限把总条数拆成几批（例如 200 → [64, 64, 64, 8]）。
 *
 * @param {unknown} count - 要归还的总条数（会先过 `normalizeAckCount`）。
 * @param {number} [limit] - 单次上限，默认 `ACK_BATCH_LIMIT`。
 * @returns {number[]} 每批的条数；总和等于收敛后的 count。
 */
export function ackBatches(count, limit = ACK_BATCH_LIMIT) {
  const total = normalizeAckCount(count)
  const step = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : ACK_BATCH_LIMIT
  const out = []
  for (let left = total; left > 0; left -= step) out.push(Math.min(left, step))
  return out
}
