/**
 * 朗读链路的**核心胶水**：文本 → 可播放 URL，外加那个常驻的播放 AudioContext。
 *
 * 为什么单独成文件（docs/architecture-modernization.md §5 第 4 步 · 4.2）：
 *   取音频、建/复用播放上下文、首次手势预热，加上 7 个「给诊断看」的状态，
 *   以前住在 6334 行的 `main.js` 闭包最前面。它们只服务于「让句子出声」这一件事，
 *   对外只暴露三件事（拿 URL、拿上下文、预热）和七个只读诊断字段。
 *   搬出来之后它能被 Node 单测直接驱动（test/playback-core.test.mjs）：
 *   假 fetch、假 AudioContext 传进来，就能验证「协商不到采样率时到底有没有出声」。
 *
 * 和 `dom/a11y-bridge.js` 同一类：持有状态、真的碰浏览器对象，所以住 `dom/` 而不是 `pure/`；
 * 环境只能从参数进来（源码里不许出现裸 window / document / navigator，
 * 见 `test/bundle-sync.test.mjs`）—— 否则「产物里看着能跑、Node 里 ReferenceError」
 * 这类缺陷又有了生存空间。
 *
 * 两条改这块前必须记住的教训：
 *   1. **绝不能强制指定 `sampleRate`**：见 `getPlayCtx()` 里的阶梯。
 *   2. 诊断字段是**活的**（每次读都取当前值）：调试快照和 1.5 秒心跳都在运行时反复读，
 *      用普通属性存一份拷贝就会出现「界面显示 running、其实早就 suspended」。
 */
// 只 import 纯数据：路径名归 route 表（批次 6j），前缀照旧从 env.baseUrl 注入。
import { ROUTE_PATHS } from '../pure/routes.js'

/**
 * 建一个播放核心（整个客户端共用一个实例）。
 *
 * @param {object} [env] - 注入的环境，缺任何一项都退化「不出声但不抛错」，不影响其它功能。
 * @param {object|null} [env.win] - 浏览器 `window`（只取 `AudioContext` / `webkitAudioContext`
 *   / `addEventListener`）。
 * @param {string} [env.baseUrl] - 宿主路由前缀（拼 `/tts?text=` 用）。
 * @param {(url: string) => Promise<object>} [env.request] - `fetch` 的调用点。
 *   由调用方包一层箭头函数而不是直接传 `window.fetch`： detached 的 window 方法在部分
 *   引擎里会 Illegal invocation。
 * @param {(blob: object) => string} [env.toObjectUrl] - `URL.createObjectURL` 的调用点。
 * @param {(headers: object) => {engine?: string, fallback?: string}} [env.readTtsMeta] -
 *   解析 `/tts` 响应头（实现是 `pure/config-normalize.js` 的 `extractTtsMeta`，跨文件依赖按规矩注入）。
 * @returns {{ fetchSpeech: Function, getPlayCtx: Function, armGestureWarmup: Function }}
 *   三个动作 + 七个只读诊断属性（`audioState` / `audioRate` / `audioError` /
 *   `lastTtsError` / `lastTtsEngine` / `lastTtsFallback` / `ttsFallbacks`）。
 */
export function createPlaybackCore(env = {}) {
  const win = env.win ?? null
  const baseUrl = env.baseUrl ?? ''
  const request = typeof env.request === 'function' ? env.request : null
  const toObjectUrl = typeof env.toObjectUrl === 'function' ? env.toObjectUrl : null
  const readTtsMeta = typeof env.readTtsMeta === 'function' ? env.readTtsMeta : null

  /**
   * 最近一次朗读失败的具体原因（诊断用）。
   *
   * 以前这里只 `throw new Error('tts failed')` —— HTTP 状态码和服务端
   * 返回的错误正文全被丢掉了，`ttsFailures` 涨到几十次也查不出为什么。
   * 「朗读没声」排查时最需要的就是这一行原文。
   */
  let lastTtsError = ''
  /** 最近一次 /tts 实际使用的引擎（响应头 x-tts-engine；空串 = 未知/老宿主）。 */
  let lastTtsEngine = ''
  /** 最近一次 /tts 的引擎回退目标（x-tts-engine-fallback：'online' / 'local' / 空）。 */
  let lastTtsFallback = ''
  /** 引擎回退累计次数（诊断 / 界面只提示一次用）。 */
  let ttsFallbackCount = 0

  /** 常驻的播放上下文：复用即可避免每次朗读都重新协商音频路由。 */
  let playCtxCache = null
  /** 播放上下文的最近一次构造/恢复失败原因（诊断用，`__DSH_VOICE_DEBUG__().audioError`）。 */
  let playCtxError = ''
  /** 播放上下文实际使用的采样率（0 表示未知；诊断用）。 */
  let playCtxRate = 0

  /** 朗读引擎：文本 → 可播放 URL。 */
  async function fetchSpeech(text) {
    let resp
    try {
      if (!request) throw new Error('环境没有 fetch')
      resp = await request(`${baseUrl}${ROUTE_PATHS.tts}?text=` + encodeURIComponent(text))
    } catch (error) {
      lastTtsError = '网络错误：' + (error instanceof Error ? error.message : String(error))
      throw error
    }
    if (!resp.ok) {
      // 把状态码与服务端错误正文一起带出来（宿主 500 时会返回 {error}）。
      let detail = ''
      try {
        const raw = await resp.text()
        try {
          const parsed = JSON.parse(raw)
          detail = parsed?.error ?? raw
        } catch { detail = raw }
      } catch { /* 读不到正文就算了 */ }
      lastTtsError = `HTTP ${resp.status}${detail ? '：' + String(detail).slice(0, 160) : ''}`
      throw new Error(lastTtsError)
    }
    // 引擎回退是**用户可见**的事实：本地系统语音失败时宿主会自动改用在线
    //（文本会发到微软），老客户端完全不知道。这里把响应头记下来，由播放循环
    // 通过 hint 提示一次，并挂到诊断快照里。
    try {
      const meta = readTtsMeta ? readTtsMeta(resp.headers) : { engine: '', fallback: '' }
      if (meta.engine) lastTtsEngine = meta.engine
      if (meta.fallback) {
        lastTtsFallback = meta.fallback
        ttsFallbackCount += 1
      }
    } catch { /* 头读不到不影响出声 */ }
    const blob = await resp.blob()
    if (!blob.size) {
      lastTtsError = '返回了空音频（HTTP ' + resp.status + '）'
      throw new Error(lastTtsError)
    }
    lastTtsError = ''
    if (!toObjectUrl) {
      lastTtsError = '环境不能把音频转成 URL'
      throw new Error(lastTtsError)
    }
    return toObjectUrl(blob)
  }

  /**
   * 取得（必要时创建）常驻播放 AudioContext。
   * 每次新建 AudioContext 都要重新协商输出设备，蓝牙耳机上要 1~3 秒，
   * 复用同一个上下文可以把首次朗读的等待压到最短。
   *
   * @returns {object|null} 播放上下文。
   */
  function getPlayCtx() {
    const Ctx = win && (win.AudioContext || win.webkitAudioContext)
    if (!Ctx) { playCtxError = '浏览器不支持 AudioContext'; return null }
    if (!playCtxCache || playCtxCache.state === 'closed') {
      playCtxCache = null
      // 不传 sampleRate：交给浏览器按实际输出设备协商。
      // 传了可能因为设备不支持而抛 NotSupportedError（蓝牙耳机最典型）——
      // 曾经这里写死 `{ sampleRate: 48000 }`：输出设备不支持 48 kHz 时（蓝牙耳机常见
      // 44.1 kHz）构造函数会抛 `NotSupportedError`，缓存永远是 null，`play()` 直接
      // return —— 音频一句都播不出来，界面上却一直显示「朗读中」。
      // 现在先不带参数建，浏览器自己协商采样率；解码后的音频由 `decodeAudioData`
      // 自动重采样到上下文采样率，无需我们指定。
      const attempts = [
        () => new Ctx(),
        // 极少数环境要求显式 rate：退回 48 kHz，再退回 44.1 kHz。
        () => new Ctx({ sampleRate: 48000 }),
        () => new Ctx({ sampleRate: 44100 }),
      ]
      for (const make of attempts) {
        try {
          const ctx = make()
          if (ctx) { playCtxCache = ctx; playCtxError = ''; break }
        } catch (error) {
          playCtxError = error instanceof Error ? error.message : String(error)
        }
      }
      if (!playCtxCache) return null
    }
    playCtxRate = Number(playCtxCache.sampleRate) || 0
    if (playCtxCache.state === 'suspended') {
      playCtxCache.resume?.().catch((error) => {
        playCtxError = error instanceof Error ? error.message : String(error)
      })
    }
    return playCtxCache
  }

  /**
   * 在首次用户手势时预热并恢复播放上下文。
   *
   * 朗读可能在「没开麦克风」时发生（读回复与语音模式无关）。
   * 此时没有任何路径去 resume 播放上下文 —— 浏览器自动播放策略会把它
   * 留在 suspended，于是 source.start() 排队不响、onended 不触发、
   * 朗读管道卡死。这里在第一次点击/按键时把上下文建好并恢复成 running。
   *
   * 由调用方在模块初始化时调一次（和搬出来之前的执行时机一致）。
   */
  function armGestureWarmup() {
    if (!win || typeof win.addEventListener !== 'function') return
    const warmPlaybackOnGesture = () => {
      try {
        const ctx = getPlayCtx()
        void ctx?.resume?.()
      } catch { /* 忽略 */ }
    }
    try {
      win.addEventListener('pointerdown', warmPlaybackOnGesture, { once: true, capture: true })
      win.addEventListener('keydown', warmPlaybackOnGesture, { once: true, capture: true })
    } catch { /* 测试环境可能是没有 addEventListener 的桩，忽略 */ }
  }

  return {
    fetchSpeech,
    getPlayCtx,
    armGestureWarmup,
    // 诊断字段：读的时候取当前值（调试快照与心跳都在运行时反复读）。
    get audioState() { return playCtxCache?.state ?? 'none' },
    get audioRate() { return playCtxRate },
    get audioError() { return playCtxError },
    get lastTtsError() { return lastTtsError },
    get lastTtsEngine() { return lastTtsEngine },
    get lastTtsFallback() { return lastTtsFallback },
    get ttsFallbacks() { return ttsFallbackCount },
  }
}
