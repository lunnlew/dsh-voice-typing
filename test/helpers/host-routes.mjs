/**
 * 测试接缝：把宿主插件（`src/host/index.js` 的 `apply(ctx, config)`）装到一个**假注入作用域**上，
 * 拿到真实的路由处理函数，然后用假的 req/res 直接调它们。
 *
 * 为什么需要它（docs/architecture-modernization.md §8.34 批次 2）：
 *   `test/download.test.mjs` 里有七条判据长这样：
 *     check('ASR 模型也带 downloading', /category: 'asr',\s*\n\s*downloading: activeDownloads\.has\(m\.id\)/.test(idx))
 *     check('activeDownloads 在广播 model-ready 之前删除',
 *       /activeDownloads\.delete\(model\.id\)[\s\S]{0,120}?broadcast\('model-ready'/.test(idx))
 *   第一条钉的是**写法**（把 `downloading:` 换个顺序、抽个变量出来它就红）；
 *   第二条更成问题：它拿「源码里两条语句的先后」代理一件本来能直接看的事 ——
 *   **客户端收到 model-ready 的那一刻再去拉 /models，拿到的 downloading 是不是 false**。
 *   有了这个接缝，第二条变成后者：真的下载、真的广播、真的在事件到达时发一次 GET，
 *   比较的是**响应里的字段**，不是源码行号。
 *
 * 用法：
 *   const env = await loadHostRoutes({ dshHome, cdnOrigin, appendAsrTiers: [tier] })
 *   const res = await env.request('/dsh-voice-typing/models')
 *   res.json().models  // 真处理函数产出的真响应
 *   const stream = env.openStream()   // SSE：stream.events 会随着广播长出来
 *   env.restore()
 *
 * 三条实现上的注意：
 *   1. **假 ctx 的 API 面很小**（`ctx.inject` / `ctx.on` / `ctx.logger` / `ctx.tools` / `ctx.sessions`），
 *      所以能整套装上 22 条路由，`apply()` 只跑 5ms，不起 worker、不联网。
 *      但 `scope.effect(fn)` 必须**真的把 fn 跑掉**：路由注册全在里面，偷懒返回空就等于没装。
 *   2. **req 要同时是可迭代对象和 EventEmitter**：`readBody()` 用 `for await`，
 *      SSE 与转写路由用 `req.on('close'|'aborted')`。少一样，对应的路由就在测试里走另一条分支。
 *   3. **res 不能真的「结束」SSE**：`json()` 会检查 `writableEnded`，
 *      所以 fake res 得如实记录这些标志位，否则「客户端已断开」那条防护路径永远测不到。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { copyHostTree, importFromTree, removeHostTree } from './host-copy.mjs'

/**
 * 最小可用假的 `ctx` / `scope`（cordis 注入作用域的替身）。
 *
 * @param {object} options - { routes: Array, hooks: Map, tools: Array, cleanups: Array, pluginCleanups: Array }
 * @returns {object} 可以交给 `apply(ctx, config)` 的 ctx。
 */
function makeFakeCtx({ routes, hooks, tools, cleanups, pluginCleanups }) {
  const scope = {
    webServer: {
      // 真宿主的 port/origin 会决定热键 helper 与回调地址；这里给一个合法的本地值。
      port: 17777,
      origin: 'http://127.0.0.1:17777',
      register: (def) => {
        routes.push(def)
        return { dispose() {} }
      },
    },
    sessions: {
      binding: (id) => ({ session: { prompt: async () => ({ id }) }, id }),
    },
    // effect() 是「注册 + 登记清理」的容器；不跑 fn 就等于一条路由都不注册。
    // 返回的清理函数**必须收下来**：effect 里开了空闲扫描定时器，
    // 不 dispose 的话测试进程永远不退出（或者更糟：靠 unref 侥幸退出，定时器却在跑）。
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
  }
  // `inject(deps, cb)` 的**返回值在真宿主里是这段注入的清理**（插件停用/重载时跑的那一大段）。
  // 以前这里直接 `cb(scope)` 把返回值丢了，于是「停用到底释放了什么」在测试里根本跑不到
  // ——批次 7 场景 B 把它收进 pluginCleanups，由 env.disposePlugin() 跑。
  const inject = (_deps, cb) => {
    const cleanup = cb(scope)
    if (typeof cleanup === 'function') pluginCleanups.push(cleanup)
    return cleanup
  }
  return {
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    on: (name, fn) => { hooks.set(name, fn) },
    tools: { register: (def) => { tools.push(def) } },
    inject,
    // 少数代码直接读 ctx.<service>（例如 ctx.sessions）；给齐。
    sessions: scope.sessions,
    webServer: scope.webServer,
    getScope: () => scope,
  }
}

/**
 * 假的请求体（可读、可迭代、可订阅 close/aborted）。
 *
 * `return()` 那一段是**照 Node 的真实语义补的**（批次 8，docs §8.49）：
 * 消费方提前退出 `for await`（`break` 或在循环体里 `throw`，读体超限就是后者）时，
 * Node 会拆掉入站流并触发 `'aborted'`、把 `req.aborted` 置真。
 * 夹具原先没有这一步 —— 于是「超限抛错」在测试里看起来像正常读完，
 * 生产代码里那句 `if (controller.signal.aborted) return` 永远不生效，
 * 「超限的请求没有回执、连接挂死」这条只在真机才露面的缺陷被完全盖住。
 *
 * @param {object} options - { method, url, body, headers, onEarlyReadEnd }。
 * @returns {object} req。
 */
function makeReq({ method = 'GET', url = '/', body = '', headers = {}, onEarlyReadEnd = null }) {
  const listeners = new Map()
  const chunks = body === '' || body === null || body === undefined
    ? []
    : [Buffer.from(typeof body === 'string' ? body : body)]
  const req = {
    method,
    url,
    aborted: false,
    headers: { 'content-type': 'application/json', ...headers },
    [Symbol.asyncIterator]() {
      let i = 0
      let exhausted = false
      return {
        async next() {
          if (i < chunks.length) return { value: chunks[i++], done: false }
          exhausted = true
          return { done: true }
        },
        // 只有「非正常结束」（break / throw）才会被 for-await 调用；读完不会。
        async return() {
          if (!exhausted && !req.aborted) {
            req.aborted = true
            for (const fn of listeners.get('aborted') ?? []) { try { fn() } catch { /* 忽略 */ } }
            onEarlyReadEnd?.()
          }
          return { done: true }
        },
      }
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
    },
    emit(event) {
      for (const fn of listeners.get(event) ?? []) { try { fn() } catch { /* 忽略 */ } }
    },
    socket: { remoteAddress: '127.0.0.1' },
  }
  return req
}

/**
 * 假的响应对象：记录 writeHead / write / end，供断言读取。
 * @returns {object} res（带 `.text` `.json()` `.chunks` `.closed()`）。
 */
function makeRes() {
  const parts = []
  const res = {
    statusCode: null,
    headers: null,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers ?? {}
      res.headersSent = true
      return res
    },
    setHeader(name, value) {
      res.headers = res.headers ?? {}
      res.headers[name] = value
    },
    write(chunk) {
      if (res.writableEnded || res.destroyed) throw new Error('write after end')
      parts.push(Buffer.from(typeof chunk === 'string' ? chunk : chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) parts.push(Buffer.from(typeof chunk === 'string' ? chunk : chunk))
      res.writableEnded = true
      return res
    },
    destroy() { res.destroyed = true },
    get chunks() { return parts.slice() },
    get text() { return Buffer.concat(parts).toString('utf8') },
    json() { return JSON.parse(Buffer.concat(parts).toString('utf8')) },
    /** SSE：把已经写出去的字节解析成 {event,data} 列表。 */
    events() {
      const out = []
      for (const block of res.text.split('\n\n')) {
        const eventName = /^event: (.+)$/m.exec(block)?.[1]
        const dataLine = /^data: (.+)$/m.exec(block)?.[1]
        if (!eventName || !dataLine) continue
        try {
          out.push({ event: eventName, data: JSON.parse(dataLine) })
        } catch {
          /* 半截 JSON：本轮还没写完 */
        }
      }
      return out
    },
  }
  return res
}

/**
 * 装载宿主插件并拿到可调用路由。
 *
 * @param {object} [options] - 选项。
 * @param {string} [options.dshHome] - 假 DSH_HOME（模型缓存根），import 前设置、restore 时还原。
 * @param {string} [options.cdnOrigin] - 给了就把 model-catalog 的 HOSTS 换成这个本地 CDN（真下载链路）。
 * @param {Array<object>} [options.appendAsrTiers] - 追加进 MODELS 的**合成档位**（sha 由测试自己算，
 *   于是宿主的路由/状态机跑的是真代码，模型文件却是本地可控的那份）。
 * @param {(code: string, file: string) => string} [options.transform] - 对所有 .js 再过一次改写
 *   （拆兜底、注入延迟等）。**在接缝自己的改写之后**执行，调用方的改写优先。
 * @param {boolean} [options.scaffoldRounds] - 压小下载重试轮数（40→3、5→2）。
 *   凡是可能走到「下载失败重试」的用例都要给：不压的话「404 被当成网络错误重试」
 *   能让用例白跑好几分钟。
 * @param {object} [options.rowConfig] - 传给 `apply()` 的行配置（默认空 = 全默认值）。
 * @param {Record<string, string>} [options.extraTreeFiles] - 装载前要写进临时 host 目录的额外文件
 *   （`fake-fs` 的包装模块就是这么进去的：`import` 一发生就来不及写了）。
 * @param {Array<[string, string, string]>} [options.requireRewrite] - 追加的改写自检清单
 *   （和接缝自己的清单一起过：原文里要有第一段、产物里要有第二段，否则直接抛错）。
 * @returns {Promise<object>} { mod, routes, request, openStream, hooks, tools, dir, restore }
 */
export async function loadHostRoutes({
  dshHome = null,
  cdnOrigin = null,
  appendAsrTiers = [],
  transform = null,
  scaffoldRounds = false,
  rowConfig = {},
  extraTreeFiles = {},
  requireRewrite: extraRequireRewrite = [],
} = {}) {
  const previousHome = process.env.DSH_HOME
  if (dshHome !== null) process.env.DSH_HOME = dshHome

  const hostsLiteral = cdnOrigin === null ? null : `const HOSTS = ${JSON.stringify([cdnOrigin])}`
  const requireRewrite = []
  if (hostsLiteral !== null) {
    requireRewrite.push(['模型下载指向本地 CDN', "const HOSTS = ['https://hf-mirror.com', 'https://huggingface.co']", hostsLiteral])
  }
  if (appendAsrTiers.length) {
    requireRewrite.push(['合成档位追加进 MODELS 数组', 'export const MODELS = [', 'globalThis.__dshAppendAsrTiers ?? []'])
  }
  if (scaffoldRounds) {
    requireRewrite.push(
      ['脚手架压小了单连接重试轮数', 'for (let round = 1; round <= 40; round++)', 'for (let round = 1; round <= 3; round++)'],
      ['脚手架压小了分片重试轮数', 'for (let round = 1; round <= 5; round++)', 'for (let round = 1; round <= 2; round++)'],
    )
  }

  const tree = copyHostTree('index', {
    transform: (code, file) => {
      if (file === 'model-catalog.js') {
        if (hostsLiteral !== null) {
          code = code.replace(/const HOSTS = \[[^\]]*\]/, hostsLiteral)
        }
        if (appendAsrTiers.length) {
          // 在数组字面量闭合前插入展开：档位内容由测试算好（含正确的 sha256）。
          code = code.replace('export const MODELS = [', 'export const MODELS = [...(globalThis.__dshAppendAsrTiers ?? []),')
        }
        if (scaffoldRounds) {
          code = code
            .replace('for (let round = 1; round <= 40; round++)', 'for (let round = 1; round <= 3; round++)')
            .replace('for (let round = 1; round <= 5; round++)', 'for (let round = 1; round <= 2; round++)')
        }
      }
      if (transform) code = transform(code, file)
      return code
    },
    requireRewrite: [...requireRewrite, ...extraRequireRewrite],
  })
  // 额外文件（fake-fs 的包装模块）必须在 import **之前**落进树里。
  for (const [name, content] of Object.entries(extraTreeFiles)) {
    const to = path.join(tree.hostDir, name)
    // 允许带子路径：`node_modules/sherpa-onnx-node/index.js` 这类**假包**要按
    // Node 的解析规则摆进树里才命中（批次 6e 的 fake-sherpa）。
    mkdirSync(path.dirname(to), { recursive: true })
    writeFileSync(to, content, 'utf8')
  }
  if (appendAsrTiers.length) globalThis.__dshAppendAsrTiers = appendAsrTiers

  const mod = await importFromTree(tree)

  const routes = []
  const hooks = new Map()
  const tools = []
  const cleanups = []
  const pluginCleanups = []
  const ctx = makeFakeCtx({ routes, hooks, tools, cleanups, pluginCleanups })
  mod.apply(ctx, rowConfig)

  /**
   * 跑掉当前登记的清理（effect 级在前、inject 级在后），跑完即从队列摘掉。
   * @param {string|null} errorLabel - 给了文案就「有清理抛错」→ 抛 Error；给 null 就吞掉。
   * @returns {number} 实际跑了几个清理。
   */
  const runScopeCleanups = (errorLabel) => {
    const pending = [...cleanups.splice(0), ...pluginCleanups.splice(0)]
    const errors = []
    for (const cleanup of pending) {
      try {
        cleanup()
      } catch (error) {
        if (errorLabel) errors.push(String(error?.message ?? error))
      }
    }
    if (errorLabel && errors.length) throw new Error(`${errorLabel}：${errors.join(' | ')}`)
    return pending.length
  }

  /** 按 URL 找路由：先精确后前缀（与真宿主一致）。 */
  const findRoute = (url) => {
    const path = url.split('?')[0]
    return routes.find((r) => r.kind === 'exact' && r.path === path)
      ?? routes.find((r) => r.kind !== 'exact' && path.startsWith(r.path))
      ?? null
  }

  /**
   * 调一条路由并等它返回。
   * @param {string} url - 路径（可带 query）。
   * @param {object} [options] - { method, body, headers, clientAbort }。
   *   `clientAbort: true` 表示「读体没读完客户端就走了」：一旦处理方提前退出读体循环，
   *   连 res 一起拆掉（Node 在这种情况下真的写不出去，处理方必须闭嘴而不是抛错）。
   * @returns {Promise<object>} fake res。
   */
  const request = async (url, { method = 'GET', body = '', headers = {}, clientAbort = false } = {}) => {
    const route = findRoute(url)
    if (!route) throw new Error(`路由不存在：${url}（已注册 ${routes.length} 条）`)
    const res = makeRes()
    const req = makeReq({
      method,
      url,
      body,
      headers,
      onEarlyReadEnd: clientAbort ? () => res.destroy() : null,
    })
    await route.handler(req, res)
    res.routeKind = route.kind
    return res
  }

  /**
   * 打开 SSE（/stream）。返回的 res 会一直「开着」，广播写进来的字节靠 `res.events()` 读。
   * @param {object} [options] - { query }
   * @returns {object} { res, events(), close() }
   */
  const openStream = ({ query = '' } = {}) => {
    const route = findRoute(`/dsh-voice-typing/stream${query}`)
    if (!route) throw new Error('SSE 路由没注册')
    const req = makeReq({ method: 'GET', url: `/dsh-voice-typing/stream${query}` })
    const res = makeRes()
    route.handler(req, res)
    return {
      res,
      events: () => res.events(),
      close: () => req.emit('close'),
    }
  }

  return {
    mod,
    routes,
    hooks,
    tools,
    dir: tree.dir,
    request,
    openStream,
    /**
     * 跑一次「插件停用/热重载」的清理：effect 登记的 + inject 回调返回的，两批都跑。
     *
     * 为什么两批都要（批次 7 场景 B）：生产里那一大段清理（`disposers` 那一串 +
     * `stopStreamSweeper` + `releaseAllRecognizers` + `disposeNeuralTts` …）挂在
     * `scope.effect(() => { ... return () => {...} })` 的返回值上，**不是** `apply()` 的返回值，
     * 也不是 `ctx.inject` 的返回值。只跑其中一批就会出现「清理跑了、模型却没释放」。
     * 真实宿主跑这两批的顺序与并发语义没有证实过（docs §8.47 的诚实边界），本批要的是
     * 「停用清理这条代码路径能不能被跑到」。跑完从队列摘掉，`restore()` 不重复跑。
     * @returns {number} 实际跑了几个清理。
     */
    disposePlugin() {
      return runScopeCleanups('插件停用清理抛错')
    },
    restore() {
      // 插件级 + effect 级清理（测试没自己跑过的那些）→ 还原环境变量 → 删临时目录。
      runScopeCleanups(null)
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      delete globalThis.__dshAppendAsrTiers
      removeHostTree(tree.dir)
    },
  }
}

/**
 * 等一个条件成立（轮询）。下载是后台任务，断言前必须等它。
 * @param {() => boolean | Promise<boolean>} predicate - 条件。
 * @param {object} [options] - { timeoutMs, everyMs, label }
 * @returns {Promise<boolean>} 成立返回 true，超时返回 false（**不抛错**，让判据自己决定怎么写）。
 */
export async function waitUntil(predicate, { timeoutMs = 20000, everyMs = 20, label = '' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
  void label
  return false
}

/**
 * 有界地等一条宿主路由。
 *
 * 为什么不能直接 `await env.request(...)`：宿主的工作线程是 `unref()` 的
 * （`getAsrWorker` 里那句，为了不让模型线程拖住应用退出），于是**等回包期间进程里
 * 一个 ref 句柄都没有** —— Node 会直接退出，测试拿到一条
 * 「Detected unsettled top-level await」警告而不是结果（批次 6e 实测踩过一次，
 * 那份实现原来住在 `test/worker-protocol.test.mjs` 里，批次 6l-e 搬到这里，
 * 因为 `test/listening-ready.test.mjs` 的「记入/摘除」真跑同样要等一条会起线程的路由）。
 * 这里的定时器既是界（超时就如实报失败，不白等），也是那个 ref 句柄。
 *
 * @param {object} env - `loadHostRoutes` 的返回值。
 * @param {string} url - 路径。
 * @param {object} [options] - { method, body, headers }
 * @param {number} [timeoutMs] - 上界。
 * @returns {Promise<object>} 真 res；超时或抛错时给一个 `statusCode:0` 的假 res（判据据此如实报红）。
 */
export async function callRoute(env, url, options = {}, timeoutMs = 20000) {
  let timer = null
  try {
    return await Promise.race([
      env.request(url, options),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          `${url}：${timeoutMs}ms 内没返回（识别线程 unref，等待期本来没有 ref 句柄）`)),
        timeoutMs)
      }),
    ])
  } catch (error) {
    return { statusCode: 0, json: () => ({ error: error.message }), text: error.message }
  } finally {
    clearTimeout(timer)
  }
}
