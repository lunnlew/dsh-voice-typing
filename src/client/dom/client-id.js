/**
 * 多窗口去重 / 请求 id。
 *
 * 为什么单独成文件（docs/architecture-modernization.md §5 第 4 步）：
 *   main.js 里有 ~80 行代码负责「本渲染器实例的唯一 id + 向宿主认领 ui-action」，
 *   依赖浏览器 API（window / sessionStorage / localStorage / crypto / fetch），
 *   与 React 组件和状态胶水无关。拆出去之后 main.js 更聚焦于组件本体。
 *
 * 和 `dom/mic-device.js`、`dom/playback-core.js` 同一类：持有的是浏览器对象，
 * 环境只能从参数进来（源码里不许出现裸 window / document / navigator，
 * 见 `test/bundle-sync.test.mjs`），所以 Node 里能直接 new 一个假环境驱动真代码。
 *
 * 一条注：存储是**取值函数**而不是实例本身。两个原因：
 *   ① 摘下来的浏览器方法传出去，在部分引擎里会 Illegal invocation；
 *   ② 调用时才取，测试可以在同一个实例上切换存储可用/不可用。
 */
// 只 import 纯数据：前缀默认值与路径名归 route 表（批次 6j），实际前缀照旧从 env.baseUrl 注入。
import { ROUTE_BASE, ROUTE_PATHS } from '../pure/routes.js'

/** clientId 的持久化键：sessionStorage 优先（同标签页共享，多标签页互不干扰）。 */
const CLIENT_ID_KEY = 'dsh-voice-typing:client-id'

/**
 * 建一个客户端 id 管理实例（整个客户端共用一个）。
 *
 * @param {object} [env] - 注入的环境；缺任何一项都退化成「不能用」，不抛错。
 * @param {() => object|null} [env.getWindow] - 读 window 的调用点。
 * @param {() => object|null} [env.getCrypto] - 读 crypto 的调用点。
 * @param {string} [env.baseUrl] - 宿主路由前缀（`/dsh-voice-typing`）。
 * @returns {{ getClientId: Function, claimUiAction: Function, generateId: (prefix: string) => string }}
 */
export function createClientId(env = {}) {
  const getWindow = typeof env.getWindow === 'function' ? env.getWindow : null
  const getCrypto = typeof env.getCrypto === 'function' ? env.getCrypto : null
  const baseUrl = typeof env.baseUrl === 'string' ? env.baseUrl : ROUTE_BASE

  /**
   * 生成一个随机 id。
   * @param {string} prefix - 退化路径的前缀（crypto.randomUUID 可用时不加）。
   * @returns {string} 随机 id。
   */
  function generateId(prefix) {
    try {
      const crypto = getCrypto ? getCrypto() : null
      if (crypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
      }
    } catch {
      /* 退化到时间+随机（不用于安全场景，只做去重标识） */
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  /**
   * 读取/创建本渲染器实例的 clientId。
   *
   * 为什么用 sessionStorage：多标签页各有一份（这正是要区分的对象），
   * 同一标签页刷新后保持不变；无痕模式/被禁用时退回 localStorage，再失败就
   * 只存在内存里（退化为"刷新后视为新窗口"，多窗口仍能靠先到先得去重）。
   *
   * @returns {string} 本窗口的稳定 id。
   */
  function resolveClientId() {
    const win = getWindow ? getWindow() : null
    if (win) {
      const storages = [win.sessionStorage, win.localStorage]
      for (const storage of storages) {
        if (!storage) continue
        try {
          const existing = String(storage.getItem(CLIENT_ID_KEY) ?? '').trim()
          if (existing) return existing
          const created = generateId('client')
          storage.setItem(CLIENT_ID_KEY, created)
          return created
        } catch {
          /* 这个存储不可用：试下一个 */
        }
      }
    }
    return generateId('client')
  }

  /** 本窗口的 clientId（模块初始化时确定，所有 ui-action 认领共用）。 */
  const CLIENT_ID = resolveClientId()

  /**
   * 向宿主认领一个 ui-action（多窗口先到先得）。
   *
   * 宿主的 `ui-action` 是广播：两个 DSH 窗口各有一个浮层时，两边都会收到。
   * 只有 claim 成功的那个窗口才允许弹确认/执行，否则 `send_prompt` 这类动作
   * 会被执行两次。404（旧宿主/路由未就绪）与网络错误一律保守跳过 ——
   * 宁可这次动作没执行，也不要多窗口重复执行。
   *
   * @param {string} requestId - 动作请求 id。
   * @returns {Promise<boolean>} 是否认领成功。
   */
  async function claimUiAction(requestId) {
    try {
      const win = getWindow ? getWindow() : null
      if (!win || typeof win.fetch !== 'function') return false
      const resp = await win.fetch(`${baseUrl}${ROUTE_PATHS.uiActionClaim}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, clientId: CLIENT_ID }),
      })
      if (!resp.ok) return false
      const data = await resp.json().catch(() => null)
      return data?.claimed === true
    } catch {
      return false
    }
  }

  return {
    getClientId: () => CLIENT_ID,
    claimUiAction,
    // 随机 id 生成器（crypto.randomUUID 优先，失败退化为时间+随机）。
    // 之前只有这里的闭包能用，别的文件想要一个 id 就只能裸调 generateId ——
    // 摘掉 @bundle、换成真 ESM 之后那样会变成 ReferenceError
    //（浮层发送识别文本时踩过一次，见 docs/architecture-modernization.md §8.32）。
    generateId,
  }
}
