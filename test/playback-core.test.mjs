/**
 * 播放核心的行为回归（第 4 步 4.2：从 main.js 闭包搬出来的第二块）。
 *
 * 和 `test/a11y-bridge.test.mjs` 同一个思路：环境从参数进来，
 * 所以 Node 里用假 fetch / 假 AudioContext 就能驱动**真代码** ——
 * 不再靠正则扫 `main.js` 的源码形状。
 *
 * 为什么值得单独测（这些都是历史上真出过的事）：
 *   - 采样率阶梯：写死 `sampleRate` 会让构造函数在蓝牙耳机上抛
 *     `NotSupportedError`，于是「界面显示朗读中、实际一句不出」。
 *     只有先不带参数建、再逐级退化，才可能出声 —— 顺序本身就是行为。
 *   - 上下文复用：每次新建都要重新协商输出设备（1~3 秒），且 closed 后必须重建。
 *   - suspended 必须 resume，且 resume 被拒时原因要落到诊断字段里。
 *   - `lastTtsError` 是「朗读没声」唯一的原文线索：HTTP 状态码和服务端正文不能丢。
 *   - 引擎回退（本地失败 → 在线，文本发给微软）是用户可见事实，计数要准。
 *   - 诊断字段必须是**活的**：调试快照与 1.5 秒心跳在运行时反复读，
 *     存一份拷贝就会显示「running」而实际早就 suspended。
 */
import { createPlaybackCore } from '../src/client/dom/playback-core.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/**
 * 造一个假的 `/tts` 响应。
 * @param {object} [opts] - `ok` / `status` / `bodyText` / `error`（抛错）/ `blobSize` / `headers`。
 */
function makeResp(opts = {}) {
  const {
    ok = true,
    status = 200,
    bodyText = '',
    textThrows = false,
    blobSize = 1024,
    headers = {},
  } = opts
  return {
    ok,
    status,
    headers,
    async text() {
      if (textThrows) throw new Error('读不到正文')
      return bodyText
    },
    async blob() {
      return { size: blobSize }
    },
  }
}

/** 假 window：只给 AudioContext 与 addEventListener，其它一律没有。 */
function makeWin(ctxFactory, capabilities = {}) {
  const win = {
    __listeners: [],
    addEventListener(type, handler, init) {
      if (capabilities.addEventListenerThrows) throw new Error('no listener')
      win.__listeners.push({ type, handler, init })
    },
  }
  if (!capabilities.noAudioContext) {
    win.AudioContext = function AudioContext(options) {
      return ctxFactory(options)
    }
  }
  if (capabilities.webkitOnly) {
    delete win.AudioContext
    win.webkitAudioContext = function WebkitAudioContext(options) {
      return ctxFactory(options)
    }
  }
  return win
}

/** 造一个能用的播放上下文对象（state / sampleRate / resume 都可编程）。 */
function makeCtx(opts = {}) {
  const { state = 'running', sampleRate = 48000, resumeResult = null, throwOnStart = false } = opts
  const ctx = {
    state,
    sampleRate,
    __resumeCalls: 0,
    __startThrows: throwOnStart,
    resume() {
      ctx.__resumeCalls += 1
      if (resumeResult instanceof Error) return Promise.reject(resumeResult)
      if (resumeResult) ctx.state = resumeResult
      return Promise.resolve()
    },
  }
  return ctx
}

/** 建一个注入了全套假环境的播放核心。 */
function makeCore(responses = [], opts = {}) {
  const calls = []
  const objectUrls = []
  const queue = Array.isArray(responses) ? responses.slice() : [responses]
  const core = createPlaybackCore({
    win: opts.win ?? null,
    baseUrl: opts.baseUrl ?? '/dsh-voice-typing',
    request: async (url) => {
      calls.push(url)
      if (opts.requestThrows) throw new Error(opts.requestThrows)
      const next = queue.shift()
      if (next === undefined) throw new Error('测试没有更多的 /tts 响应')
      if (next instanceof Error) throw next
      return next
    },
    toObjectUrl: (blob) => {
      objectUrls.push(blob)
      return `blob:fake/${objectUrls.length}`
    },
    // `noMeta: true` 用来模拟「老宿主根本没带这些响应头，客户端也没法解析」。
    ...(opts.noMeta ? {} : { readTtsMeta: (headers) => headers?.__meta ?? { engine: '', fallback: '' } }),
  })
  return { core, calls, objectUrls }
}

console.log('\nfetchSpeech：URL、错误原文与引擎回退')
{
  const { core, calls, objectUrls } = makeCore([makeResp({ blobSize: 2048 })])
  const url = await core.fetchSpeech('你好，世界')
  check('按前缀拼出 /tts 请求', calls.length === 1 && calls[0].startsWith('/dsh-voice-typing/tts?text='), calls[0])
  check('文本被 encodeURIComponent（空格与中文都不丢）',
    calls[0] === '/dsh-voice-typing/tts?text=' + encodeURIComponent('你好，世界'), calls[0])
  check('返回可用的对象 URL', url === 'blob:fake/1' && objectUrls.length === 1, url)
  check('成功一次后 lastTtsError 清空', core.lastTtsError === '', core.lastTtsError)
  check('没有回退时 ttsFallbacks 为 0', core.ttsFallbacks === 0, String(core.ttsFallbacks))
}

{
  const { core } = makeCore([], { requestThrows: '网络断了' })
  let thrown = null
  try { await core.fetchSpeech('x') } catch (error) { thrown = error }
  check('请求失败照样抛出（播放循环靠它计数）', thrown instanceof Error, String(thrown))
  check('诊断里带「网络错误：」原文', core.lastTtsError === '网络错误：网络断了', core.lastTtsError)
}

{
  const { core } = makeCore([makeResp({ ok: false, status: 500, bodyText: '{"error":"本地语音不可用"}' })])
  let message = ''
  try { await core.fetchSpeech('x') } catch (error) { message = error.message }
  check('HTTP 错误把服务端 error 字段带进异常', message === 'HTTP 500：本地语音不可用', message)
  check('同一条原文也进了诊断字段', core.lastTtsError === 'HTTP 500：本地语音不可用', core.lastTtsError)
}

{
  const { core } = makeCore([makeResp({ ok: false, status: 503, bodyText: 'not ready' })])
  try { await core.fetchSpeech('x') } catch { /* 忽略 */ }
  check('正文不是 JSON 时原样带上', core.lastTtsError === 'HTTP 503：not ready', core.lastTtsError)
}

{
  const { core } = makeCore([makeResp({ ok: false, status: 502, bodyText: 'x'.repeat(400) })])
  try { await core.fetchSpeech('x') } catch { /* 忽略 */ }
  check('超长正文截到 160（诊断行不能撑爆心跳）',
    core.lastTtsError.length <= 'HTTP 502：'.length + 160, String(core.lastTtsError.length))
}

{
  const { core } = makeCore([makeResp({ ok: false, status: 500, textThrows: true })])
  let message = ''
  try { await core.fetchSpeech('x') } catch (error) { message = error.message }
  check('读不到正文也只剩状态码（不额外抛错）', message === 'HTTP 500', message)
}

{
  const { core } = makeCore([makeResp({ blobSize: 0 })])
  let message = ''
  try { await core.fetchSpeech('x') } catch (error) { message = error.message }
  check('空音频被当成失败抛出', message === '返回了空音频（HTTP 200）', message)
  check('空音频也留在诊断里', core.lastTtsError === '返回了空音频（HTTP 200）', core.lastTtsError)
}

{
  const meta = { __meta: { engine: 'online', fallback: 'online' } }
  const { core } = makeCore([makeResp({ headers: meta }), makeResp({ headers: meta })])
  await core.fetchSpeech('一')
  check('记下实际引擎', core.lastTtsEngine === 'online', core.lastTtsEngine)
  check('回退目标与次数都可见', core.lastTtsFallback === 'online' && core.ttsFallbacks === 1,
    `${core.lastTtsFallback}/${core.ttsFallbacks}`)
  await core.fetchSpeech('二')
  check('每次回退都加一次（界面靠「变化」只提示一次）', core.ttsFallbacks === 2, String(core.ttsFallbacks))
}

{
  const { core } = makeCore([makeResp({ headers: { __meta: { engine: 'local', fallback: '' } } })])
  await core.fetchSpeech('x')
  check('没有回退时只记引擎、不涨次数', core.lastTtsEngine === 'local' && core.ttsFallbacks === 0,
    `${core.lastTtsEngine}/${core.ttsFallbacks}`)
}

{
  // 解析响应头这件事本身不能影响出声（老宿主可能压根没带这些头）。
  const { core } = makeCore([makeResp()], { noMeta: true })
  const url = await core.fetchSpeech('x')
  check('没有注入响应头解析时照样出声（返回 URL）', url === 'blob:fake/1', url)
  check('此时引擎与回退字段留空', core.lastTtsEngine === '' && core.ttsFallbacks === 0)
}

console.log('\ngetPlayCtx：采样率阶梯、复用与恢复')
{
  const made = []
  const ctx = makeCtx({ state: 'running', sampleRate: 44100 })
  const win = makeWin((options) => { made.push(options ?? null); return ctx })
  const { core } = makeCore([], { win })
  const got = core.getPlayCtx()
  check('首次不带 sampleRate 建（交给浏览器协商）', got === ctx && made.length === 1 && made[0] === null,
    JSON.stringify(made))
  check('实际协商到的采样率进了诊断', core.audioRate === 44100, String(core.audioRate))
  check('running 状态不需要 resume', ctx.__resumeCalls === 0, String(ctx.__resumeCalls))
  const again = core.getPlayCtx()
  check('第二次复用同一个上下文（省 1~3 秒设备协商）', again === ctx && made.length === 1, String(made.length))
}

{
  const made = []
  const win = makeWin((options) => {
    made.push(options ?? null)
    if (made.length === 1) throw new Error('NotSupportedError')
    return { state: 'running', sampleRate: options?.sampleRate ?? 0, resume: () => Promise.resolve() }
  })
  const { core } = makeCore([], { win })
  const got = core.getPlayCtx()
  check('第一级失败后退到 48 kHz', made.length === 2 && made[1].sampleRate === 48000, JSON.stringify(made))
  check('拿到的是退化档位建出来的上下文', got.sampleRate === 48000, String(got.sampleRate))
}

{
  const made = []
  const win = makeWin((options) => {
    made.push(options ?? null)
    throw new Error(`设备不支持 ${options?.sampleRate ?? '自动'}`)
  })
  const { core } = makeCore([], { win })
  check('三级都失败 → 返回 null（调用方跳过播放而不是卡死）', core.getPlayCtx() === null)
  check('阶梯完整走过：自动 → 48k → 44.1k',
    made.length === 3 && made[0] === null && made[1].sampleRate === 48000 && made[2].sampleRate === 44100,
    JSON.stringify(made))
  check('最后一次的失败原因留在诊断里', core.audioError === '设备不支持 44100', core.audioError)
}

{
  const { core } = makeCore([], { win: makeWin(() => ({}), { noAudioContext: true }) })
  check('没有 AudioContext 时返回 null 不抛错', core.getPlayCtx() === null)
  check('原因写「浏览器不支持 AudioContext」', core.audioError === '浏览器不支持 AudioContext', core.audioError)
}

{
  const { core } = makeCore([], { win: makeWin(() => makeCtx(), { webkitOnly: true }) })
  check('只认 webkitAudioContext 的老引擎也能建', core.getPlayCtx() !== null, core.audioError)
}

{
  const made = []
  let live = makeCtx({ state: 'suspended', resumeResult: 'running' })
  const win = makeWin((options) => {
    const ctx = live
    made.push(ctx)
    void options
    return ctx
  })
  const { core } = makeCore([], { win })
  const first = core.getPlayCtx()
  check('suspended 的上下文会被 resume', first.__resumeCalls === 1, String(first.__resumeCalls))
  check('诊断反映当前状态', core.audioState === 'running', core.audioState)
  const second = core.getPlayCtx()
  check('恢复成 running 后不再重复 resume', second.__resumeCalls === 1, String(second.__resumeCalls))
}

{
  const closed = makeCtx({ state: 'closed' })
  const fresh = makeCtx({ state: 'running' })
  const made = []
  let n = 0
  const win = makeWin(() => {
    const ctx = n++ === 0 ? closed : fresh
    made.push(ctx)
    return ctx
  })
  const { core } = makeCore([], { win })
  core.getPlayCtx()
  const rebuilt = core.getPlayCtx()
  check('closed 的上下文必须重建（不能继续用死的）', rebuilt === fresh && made.length === 2, String(made.length))
  check('重建后诊断跟着换成新上下文', core.audioState === 'running', core.audioState)
}

{
  const rejected = makeCtx({ state: 'suspended', resumeResult: new Error('autoplay policy') })
  const win = makeWin(() => rejected)
  const { core } = makeCore([], { win })
  core.getPlayCtx()
  await new Promise((resolve) => setTimeout(resolve, 0))
  check('resume 被拒时原因落到 audioError', core.audioError === 'autoplay policy', core.audioError)
  check('诊断状态仍是 suspended（这就是「有队列没声音」）', core.audioState === 'suspended', core.audioState)
}

{
  const weird = { state: 'running', sampleRate: 'not-a-number', resume: () => Promise.resolve() }
  const win = makeWin(() => weird)
  const { core } = makeCore([], { win })
  core.getPlayCtx()
  check('采样率读不到就记 0（不写出 NaN）', core.audioRate === 0, String(core.audioRate))
}

{
  const win = makeWin(() => makeCtx())
  const { core } = makeCore([], { win })
  check('还没建上下文时 audioState 报 none', core.audioState === 'none', core.audioState)
  core.getPlayCtx()
  check('建好之后同一个字段变成真状态', core.audioState === 'running', core.audioState)
}

console.log('\narmGestureWarmup：首次手势预热')
{
  const win = makeWin(() => makeCtx({ state: 'suspended', resumeResult: 'running' }))
  const { core } = makeCore([], { win })
  core.armGestureWarmup()
  check('pointerdown 与 keydown 各登记一次', win.__listeners.length === 2
    && win.__listeners.map((l) => l.type).sort().join(',') === 'keydown,pointerdown',
    win.__listeners.map((l) => l.type).join(','))
  check('都用 once + capture（预热只做一次，且抢先于页面）',
    win.__listeners.every((l) => l.init?.once === true && l.init?.capture === true),
    JSON.stringify(win.__listeners.map((l) => l.init)))
  win.__listeners[0].handler()
  check('手势里就把上下文建好并 resume', core.audioState === 'running' && core.audioRate > 0,
    `${core.audioState}/${core.audioRate}`)
}

{
  const { core } = makeCore([], { win: makeWin(() => makeCtx(), { addEventListenerThrows: true }) })
  let ok = true
  try { core.armGestureWarmup() } catch { ok = false }
  check('登记监听器失败也只是不预热（不影响启动）', ok)
}

{
  const bare = createPlaybackCore({ baseUrl: '/x' })
  let ok = true
  let url = 'unset'
  try {
    bare.armGestureWarmup()
    url = await bare.fetchSpeech('x')
  } catch (error) {
    ok = error instanceof Error
  }
  check('完全没有环境时：预热不抛、取音频抛出可读原因', ok && url === 'unset', url)
  check('失败原因进了诊断', bare.lastTtsError.startsWith('网络错误：'), bare.lastTtsError)
}

console.log('\n实例之间互不干扰（状态在闭包里，不在模块上）')
{
  const winA = makeWin(() => makeCtx({ state: 'running', sampleRate: 48000 }))
  const a = createPlaybackCore({ win: winA, baseUrl: '/a', request: async () => makeResp(), toObjectUrl: () => 'blob:a' })
  const b = createPlaybackCore({ win: null, baseUrl: '/b', request: async () => makeResp({ ok: false, status: 500, bodyText: 'boom' }), toObjectUrl: () => 'blob:b' })
  a.getPlayCtx()
  try { await b.fetchSpeech('x') } catch { /* 忽略 */ }
  check('一边建好上下文不影响另一边的诊断', a.audioState === 'running' && b.audioState === 'none',
    `${a.audioState}/${b.audioState}`)
  check('一边的失败原因不串到另一边', b.lastTtsError === 'HTTP 500：boom' && a.lastTtsError === '',
    `${b.lastTtsError}|${a.lastTtsError}`)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
