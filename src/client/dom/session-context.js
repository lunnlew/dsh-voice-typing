/**
 * 会话上下文：插件 ctx 的模块级引用 + 上次会话 id 的持久化。
 *
 * 为什么单独成文件（docs/architecture-modernization.md §5 第 4 步 · 4.5）：
 *   main.js 里有三个顶层 `let` 都和"会话持久化 / 插件上下文"相关：
 *     1. `pluginCtx` —— 宿主 `apply(ctx)` 时存下来的上下文，供全局浮层取 sessions/uiWorkspace/layout 服务；
 *     2. `capturedSessionsService` —— 通过 `ctx.inject(['sessions'])` 捕获的会话服务（只读兜底）；
 *     3. `lastPersistedSessionId` —— 模块级缓存，避免每次渲染都读 localStorage。
 *   这三个变量和它们相关的三个函数（`readLastSessionId` / `persistLastSessionId` / `clientService`）
 *   在 main.js 里占了约 90 行，且 `clientService` 在 15+ 处被调用。
 *   拆出去之后 main.js 顶层 `let` 从 3 个降到 0 个（第 4 步的目标之一）。
 *
 * 和 `dom/mic-device.js`、`dom/playback-core.js` 同一类：持有的是浏览器对象（localStorage）、
 * 环境只能从参数进来（源码里不许出现裸 window / document / navigator，
 * 见 `test/bundle-sync.test.mjs`），所以 Node 里能直接 new 一个假环境驱动真代码
 * （`test/session-context.test.mjs`）。
 *
 * 一条注：存储是**取值函数**而不是实例本身。两个原因：
 *   ① 摘下来的浏览器方法传出去，在部分引擎里会 Illegal invocation
 *     （`playback-core.js` 里 `request` / `toObjectUrl` 同一个理由）；
 *   ② 调用时才取，测试可以在同一个实例上切换存储可用/不可用，
 *     不用为每个场景重建一份 sessionContext。
 */

/** 持久化上次会话 id 的键。 */
const LAST_SESSION_KEY = 'dsh-voice-typing:last-session'

/**
 * 建一个会话上下文实例（整个客户端共用一个）。
 *
 * @param {object} [env] - 注入的环境；缺任何一项都退化成「不能用」，不抛错。
 * @param {() => object|null} [env.readStorage] - 读存储的调用点（`window.localStorage`）。
 * @param {() => object|null} [env.writeStorage] - 写存储的调用点（通常和 readStorage 同一个对象）。
 * @returns {{ setPluginCtx: Function, setCapturedSessionsService: Function,
 *   clientService: Function, readLastSessionId: Function, persistLastSessionId: Function }}
 */
export function createSessionContext(env = {}) {
  const readStorage = typeof env.readStorage === 'function' ? env.readStorage : null
  const writeStorage = typeof env.writeStorage === 'function' ? env.writeStorage : null

  /** 宿主 apply(ctx) 时存下来的上下文。 */
  let pluginCtx = null

  /** 通过 ctx.inject(['sessions']) 捕获的会话服务（只读兜底）。 */
  let capturedSessionsService = null

  /** 模块级缓存：避免每次渲染都读 localStorage。 */
  let lastPersistedSessionId = null

  /**
   * 存下宿主 apply(ctx) 的上下文（全局浮层需要 sessions/uiWorkspace/layout 服务时用）。
   * @param {object|null} ctx - 宿主上下文。
   */
  function setPluginCtx(ctx) {
    pluginCtx = ctx ?? null
  }

  /**
   * 存下通过注入作用域捕获的 sessions 服务。
   * @param {object|null} service - 会话服务。
   */
  function setCapturedSessionsService(service) {
    capturedSessionsService = service ?? null
  }

  /**
   * 读持久化的上次会话 id（无痕模式/禁用 localStorage 时静默返回空串）。
   * @returns {string} 会话 id；没有/读取失败返回空串。
   */
  function readLastSessionId() {
    try {
      const storage = readStorage ? readStorage() : null
      if (!storage) return ''
      return String(storage.getItem(LAST_SESSION_KEY) ?? '')
    } catch {
      return ''
    }
  }

  /**
   * 持久化「上次使用的会话」。
   *
   * 调用点可能很频繁（MicButton 每次会话 id 变化、浮层每次快照更新），
   * 所以先用模块级变量比对：相同 id 直接返回，不做任何写入/读取。
   *
   * @param {string} id - 会话 id。
   */
  function persistLastSessionId(id) {
    const value = typeof id === 'string' ? id.trim() : ''
    if (!value || value === lastPersistedSessionId) return
    lastPersistedSessionId = value
    try {
      const storage = writeStorage ? writeStorage() : null
      if (!storage) return
      storage.setItem(LAST_SESSION_KEY, value)
    } catch {
      /* 无痕模式/配额/被策略禁用：持久化只是增强，失败不能影响语音 */
    }
  }

  /**
   * 取客户端服务：优先注入作用域捕获的 sessions，再优先 ctx 上直接挂的
   * （sessions/slots/…），最后退回 ctx.get(name)。几种取法都试，
   * 避免 DSH 版本差异让浮层直接失效。
   *
   * @param {string} name - 服务名。
   * @returns {object|null} 服务对象；拿不到返回 null。
   */
  function clientService(name) {
    // 注入作用域捕获的 sessions 最可靠：ctx 上没有时它是唯一来源。
    if (name === 'sessions' && capturedSessionsService) return capturedSessionsService
    if (!pluginCtx) return null
    // 顺序很重要：**先试 ctx.get()，再试 ctx[name]**。
    //
    // 反过来会踩一个很隐蔽的坑：插件只声明了 inject=['slots','locale']，
    // 直接读 ctx.layout 会抛 "cannot get property without inject"，
    // 外层 try/catch 一兜就直接返回 null —— 看起来像「服务不存在」，
    // 于是 toggle_sidebar / switch_session 全都报 unsupported。
    // ctx.get()（reflect.get）本来可以绕过 inject 拿到服务，所以必须先走它。
    try {
      if (typeof pluginCtx.get === 'function') {
        const viaGet = pluginCtx.get(name)
        if (viaGet) return viaGet
      }
    } catch {
      /* 再试直接属性 */
    }
    try {
      return pluginCtx[name] ?? null
    } catch {
      return null
    }
  }

  return {
    setPluginCtx,
    setCapturedSessionsService,
    clientService,
    readLastSessionId,
    persistLastSessionId,
  }
}

/**
 * 读取 sessions.list 的快照。
 * 服务可能还没就绪，或不同版本用了 snapshot/getSnapshot —— 都试一遍，拿不到返回 null。
 *
 * @param {object} sessionsService - ctx.sessions。
 * @returns {object|null} SessionListState 快照。
 */
export function readSessionSnapshot(sessionsService) {
  try {
    const list = sessionsService?.list
    if (!list) return null
    if (typeof list.getSnapshot === 'function') return list.getSnapshot()
    return list.snapshot ?? null
  } catch {
    return null
  }
}
