/**
 * SSE 事件信封与定时器登记（纯函数 / 无浏览器 API 依赖）。
 *
 * 这些文件被 `scripts/bundle-client.mjs` 内联进 lib/client.js，
 * 同时也可以被 Node 里的测试**原生 import**（不需要「从大文件里提取源码再求值」）。
 */

/**
 * 解析 SSE 事件信封。
 *
 * 协议 v3：所有事件的 data 都是同一个信封
 *   { v: 3, seq, ts, sessionId, ...payload }
 *
 * 统一信封的好处：
 *   - 客户端能靠 seq 发现丢事件（重连后 seq 跳变）；
 *   - sessionId 让多会话不会串音（客户端只处理自己会话的事件）；
 *   - 业务字段直接放在信封里，不用再包一层。
 *
 * @param {object} event - EventSource 的事件对象（只需要 data）。
 * @returns {object|null} 信封；解析失败返回 null。
 */
export function parseEnvelope(event) {
  try {
    const raw = JSON.parse(event.data)
    if (!raw || typeof raw !== 'object') return null
    return raw
  } catch {
    return null
  }
}

/**
 * 判断一个事件是不是属于当前会话。
 *
 * sessionId 为 null 的事件是全局事件（模型下载进度之类），
 * 任何会话都要处理。
 *
 * @param {object} envelope - 事件信封。
 * @param {string} currentSessionId - 当前会话 id。
 * @returns {boolean} 是否属于当前会话。
 */
export function belongsToSession(envelope, currentSessionId) {
  if (!envelope) return false
  const sid = envelope.sessionId
  if (!sid) return true
  if (!currentSessionId) return true
  return sid === currentSessionId
}

/**
 * 定时器登记表。
 *
 * 为什么要有它：这个插件里「停麦之后还留着定时器」造成过严重故障 ——
 * 「助手忙完后自动发送」的定时器之前只在组件卸载时被清，
 * 于是用户关掉麦克风后它照样在 400 毫秒后触发，把草稿自动发了出去。
 *
 * 定时器句柄分散在各自的 ref 里，各自清理、各自可能漏。
 * 登记到一张表之后：
 *   - 状态复位时按 group 一次清干净；
 *   - 卸载时 clearAll() 兜底；
 *   - 漏登记的定时器能被静态检查抓到（源码里不该再有裸的
 *     window.setTimeout / window.setInterval）。
 *
 * @param {object} win - 提供 setTimeout/setInterval/clearTimeout/clearInterval 的对象。
 * @returns {object} 登记表。
 */
export function createTimerRegistry(win) {
  const timers = new Map()
  const clearOne = (id) => {
    const t = timers.get(id)
    if (!t) return
    if (t.kind === 'interval') win.clearInterval(t.handle)
    else win.clearTimeout(t.handle)
    timers.delete(id)
  }
  return {
    /** 登记一个重复定时器；同名会先清掉旧的。 */
    interval(id, fn, ms, group) {
      clearOne(id)
      const handle = win.setInterval(fn, ms)
      timers.set(id, { handle, kind: 'interval', group })
      return handle
    },
    /** 登记一个一次性定时器；同名会先清掉旧的。 */
    timeout(id, fn, ms, group) {
      clearOne(id)
      const handle = win.setTimeout(fn, ms)
      timers.set(id, { handle, kind: 'timeout', group })
      return handle
    },
    /** 清掉一个。 */
    clear(id) { clearOne(id) },
    /** 清掉某一组（状态复位时用）。 */
    clearGroup(group) {
      for (const [id, t] of [...timers]) if (t.group === group) clearOne(id)
    },
    /** 全清（卸载时兜底）。 */
    clearAll() { for (const id of [...timers.keys()]) clearOne(id) },
    /** 当前登记了多少个（诊断用）。 */
    size() { return timers.size },
    /** 已登记的 id 列表（诊断用）。 */
    ids() { return [...timers.keys()] },
  }
}

/**
 * 短时等待。
 *
 * 唯一的例外：它不登记到定时器表 ——
 * 它必定结束、不会跨状态残留，登记反而是负担。
 * 所有**跨状态存活**的定时器都必须走登记表。
 *
 * @param {object} win - 提供 setTimeout 的对象。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 等待结束。
 */
export function sleep(win, ms) {
  return new Promise((resolve) => win.setTimeout(resolve, ms))
}
