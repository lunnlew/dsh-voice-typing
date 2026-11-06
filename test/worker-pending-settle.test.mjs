/**
 * 等识别线程的人必须被告知线程死了；等回包的定时器不许按住进程（批次 11，docs §8.52）。
 *
 * 两条缺陷同一个根：宿主把请求挂进 `asrPending` 那张表，然后等线程回包，
 * 但**线程出事时没人结算这张表**。
 *
 *   1. `worker.on('exit')` 以前只写 `asrWorker = null`。
 *      而 `'exit'` 是**不带错误对象**的那一条：线程被原生代码干掉（sherpa 的 C++ 崩溃、OOM、
 *      以及批次 7 里见过的「原生直接终止进程」那些形态）时，Node 只发 'exit'，不发 'error'。
 *      于是 `recognizeInWorker` 那个 Promise 永远不会 settle —— 注意它**连超时定时器都没有**。
 *      「recognizeInWorker 没有等待超时」这条怀疑的真身因此不是「该加超时」
 *      （§8.48 裁定过：拍一个错误的上限会把合法的慢识别判死），
 *      而是「退出时没人通知等待者」。表现就是批次 8 那一类：**连接一直挂着，一个字节都不回**。
 *   2. `preloadInWorker` 等回包用的是 **120 秒**定时器、`releaseInWorker` 用的是 **15 秒**，
 *      两个都**没 `unref()`**。宿主进程要退出时，这些还挂着句柄的定时器会把事件环按住不放
 *      （停用一次插件 = 每个已加载档位一个 15 秒；预加载在途 = 最多 120 秒）。
 *
 * 怎么判（全部真跑）：真宿主路由 + **真的 `node:worker_threads` 线程**。
 * 替身线程说的是同一套消息协议，只是行为可控：是否「收到 recognize 就当场退出」由父进程的环境变量决定
 * （`new Worker` 默认继承父进程 env，所以翻这个开关能控制**下一个被建出来**的线程）。
 * sherpa 换成 `test/helpers/fake-sherpa.mjs`，它按 `thread=<id>` 标记结果出自哪一侧，
 * 于是「线程死了之后回退有没有真的把识别器建出来」是数得出来的。
 * 定时器那一侧不读源码：把 `globalThis.setTimeout` 包一层，记下真实返回的句柄，
 * 判的是句柄上的 `hasRef()` —— 生产里写成 `timer.unref()` 还是别的等价形式都不影响判据。
 *
 * 运行：node test/worker-pending-settle.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import osPkg from 'node:os'
import { startFakeCdn } from './helpers/fake-cdn.mjs'
import { loadHostRoutes, callRoute } from './helpers/host-routes.mjs'
import { fakeSherpa } from './helpers/fake-sherpa.mjs'
import { makeWhisperTier, placeTierFiles, cdnFiles } from './helpers/fake-asr-tier.mjs'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 演「原生把线程干掉」的那个开关（替身线程启动时读它）。 */
const DIE_ENV = 'DSH_FAKE_ASR_WORKER_DIE'

/** 一段足够响的 16k f32 音频（能量门限要过，否则宿主侧就拦掉了）。 */
function loudPcm(samples = 1600) {
  const arr = new Float32Array(samples)
  for (let i = 0; i < samples; i++) arr[i] = (i % 2 ? -0.1 : 0.1)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

/**
 * 替身识别线程：说宿主那套协议，但三种消息各有行为。
 *
 * - `preload`：**照旧回 ok** —— 「已加载」名单里要有这一档，停用时才会真的发出 release
 *   （不然那条 15 秒定时器根本不会出现，判据就是空转）。
 * - `release`：**故意不回** —— 演「线程收了释放请求却卡住」，把那条等待定时器露出来。
 * - `recognize`：开关打开时**不回话、20ms 后整个线程退出**（只发 'exit' 不发 'error'，
 *   这正是原缺陷的触发条件）；开关关掉时回一条 `ok:false`（线程活着，宿主走主线程回退）。
 */
const DEAD_WORKER = `import { parentPort } from 'node:worker_threads'
const die = process.env.${DIE_ENV} === '1'
parentPort.on('message', (message) => {
  const id = message?.id
  if (message?.kind === 'preload') { parentPort.postMessage({ ok: true, id, preloaded: true }); return }
  if (message?.kind === 'release') return
  if (message?.kind === 'recognize') {
    if (die) { setTimeout(() => process.exit(7), 20); return }
    parentPort.postMessage({ ok: false, id, error: 'fake worker: 这一档不响应 recognize' })
    return
  }
  parentPort.postMessage({ ok: false, id, error: 'fake worker: 未预期的消息 ' + String(message?.kind) })
})
`

/** 把 `new Worker(new URL('./asr-worker.js', …))` 换成上面那个替身线程文件。 */
const REAL_WORKER_URL = "new URL('./asr-worker.js', import.meta.url)"
const FAKE_WORKER_URL = "new URL('./asr-worker-dead.js', import.meta.url)"

async function scenarioWorkerPendingSettle() {
  const tierId = 'test-dead-worker/model'
  const { tier, files } = makeWhisperTier(tierId, 'fake-repo/dead-worker')
  const home = fs.mkdtempSync(path.join(osPkg.tmpdir(), 'dsh-dead-worker-home-'))
  placeTierFiles(home, tier, files)
  const cdn = await startFakeCdn({ files: cdnFiles(tier, files) })
  const fake = fakeSherpa({ marker: '假识别' })
  fake.install()

  // 定时器句柄记录器：包一层真 setTimeout，只记账、不改行为。
  const handles = []
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (...args) => {
    const handle = realSetTimeout(...args)
    handles.push({ delay: Number(args[1]) || 0, handle })
    return handle
  }
  /** 某个等待时长上记到的句柄。 */
  const byDelay = (delay) => handles.filter((row) => row.delay === delay)
  /** 这些句柄里还按住事件环的。 */
  const stillRefed = (rows) => rows.filter((row) => row.handle?.hasRef?.() !== false)

  // 一开始就把「recognize 当场死」打开：预热用的那次 preload 不受影响。
  process.env[DIE_ENV] = '1'
  const env = await loadHostRoutes({
    dshHome: home,
    cdnOrigin: cdn.origin,
    appendAsrTiers: [tier],
    scaffoldRounds: true,
    rowConfig: { model: tierId, language: 'en', preloadModels: false },
    extraTreeFiles: { ...fake.files, 'asr-worker-dead.js': DEAD_WORKER },
    // 自检：替身线程必须真的换上了。换不掉（宿主那句写法变了）就是判据失效，
    // 而不是「这次刚好没挂住」——那种绿会把缺陷重新藏回去。
    requireRewrite: [['识别线程换成会当场退出的替身', REAL_WORKER_URL, FAKE_WORKER_URL]],
    transform: (code, file) => (file === 'index.js' ? code.replace(REAL_WORKER_URL, FAKE_WORKER_URL) : code),
  })
  const stream = env.openStream()
  try {
    /* ---- 前置：替身线程在场，链路跑得通 ---- */
    const warm = await callRoute(env, '/dsh-voice-typing/asr-warmup', { method: 'POST', body: '{}' })
    check('[前置] 预热在替身线程里回 ready:true（下面那些「挂住」才有对照）',
      warm.statusCode === 200 && warm.json()?.ready === true,
      `status=${warm.statusCode} ${JSON.stringify(warm.json())}`)

    /* ---- ① 线程被原生干掉：等待者必须被告知 ---- */
    const dead1 = await callRoute(env, '/dsh-voice-typing/transcribe', {
      method: 'POST',
      body: loudPcm(),
      headers: { 'content-type': 'application/octet-stream' },
    }, 8000)
    check('[线程死] 线程当场退出之后，/transcribe 在限时内**有回执**（修前 = 0，一直挂着）',
      dead1.statusCode !== 0, `status=${dead1.statusCode}`)
    check('[线程死] 回执是 200，文本出自主线程回退（线程没了还得能识别，不是抛个错就算完）',
      dead1.statusCode === 200 && String(dead1.json()?.text ?? '').includes('#thread=0'),
      JSON.stringify({ status: dead1.statusCode, body: dead1.json() }))
    const mainCtor = fake.events().filter((row) => row.thread === 0 && (row.event === 'ctor' || row.event === 'factory'))
    check('[线程死] 主线程那份识别器是真的建出来的（不是随手补的默认文本）',
      mainCtor.length >= 1, JSON.stringify(fake.events().slice(-6)))

    // 第二次：线程已被重建（`getAsrWorker` 见 null 就新建），再死一遍。
    // 这条判的是「结算挂在**每次新建**的线程上」，不是只给第一个线程补的补丁。
    const dead2 = await callRoute(env, '/dsh-voice-typing/transcribe', {
      method: 'POST',
      body: loudPcm(),
      headers: { 'content-type': 'application/octet-stream' },
    }, 8000)
    check('[线程死·第二次] 重建后的线程又死一次，等待者第二次同样被告知（不是一次性修复）',
      dead2.statusCode === 200 && String(dead2.json()?.text ?? '').includes('#thread=0'),
      JSON.stringify({ status: dead2.statusCode, body: dead2.json() }))
    const diag = await callRoute(env, '/dsh-voice-typing/diagnostics')
    check('[线程死·副作用] 两次线程死亡之后 /diagnostics 仍回 200 ok:true',
      diag.statusCode === 200 && diag.json()?.ok === true, `status=${diag.statusCode}`)
    const ready = await callRoute(env, '/dsh-voice-typing/asr-ready')
    check('[线程死·副作用] /asr-ready 照常应答（线程死了不该把路由面一起带崩）',
      ready.statusCode === 200, JSON.stringify(ready.json()))

    /* ---- ② 等待回包的定时器不许按住进程 ---- */
    // 关掉「当场死」，让下一个线程活着建起来：release 只有在有线程时才发得出去。
    process.env[DIE_ENV] = '0'
    const alive = await callRoute(env, '/dsh-voice-typing/transcribe', {
      method: 'POST',
      body: loudPcm(),
      headers: { 'content-type': 'application/octet-stream' },
    }, 8000)
    check('[前置·定时器] 替身线程活着时也走得通（这一步把线程重新建起来，供 release 用）',
      alive.statusCode === 200, `status=${alive.statusCode}`)
    const preloadRows = byDelay(120000)
    check('[定时器·预热] 这一趟真的出现过那条 120 秒等待定时器（判据不是空转）',
      preloadRows.length >= 1, JSON.stringify({ 记到: preloadRows.length }))
    check('[定时器·预热] 它不按住事件环（宿主退出时不该为一条等回包的定时器最多等 120 秒）',
      stillRefed(preloadRows).length === 0,
      JSON.stringify(preloadRows.map((row) => row.handle?.hasRef?.())))
    const releaseRowsBefore = byDelay(15000).length
    let disposeError = ''
    let ran = 0
    try { ran = env.disposePlugin() } catch (error) { disposeError = String(error?.message ?? error) }
    check('[停用] 插件停用清理跑起来了（release 就是从这儿发出去的）',
      disposeError === '' && ran >= 1, disposeError || JSON.stringify({ ran }))
    const releaseRows = byDelay(15000)
    check('[定时器·释放] 停用确实发出了 release 并出现过那条 15 秒等待定时器（替身故意不回话）',
      releaseRows.length > releaseRowsBefore,
      JSON.stringify({ before: releaseRowsBefore, now: releaseRows.length }))
    check('[定时器·释放] 它也 unref 了（§8.48 记录不修的那一笔，本批修掉）',
      stillRefed(releaseRows).length === 0,
      JSON.stringify(releaseRows.map((row) => row.handle?.hasRef?.())))
    const refed = handles.filter((row) => row.handle?.hasRef?.() === true)
    check('[定时器·反证] 同一趟里**别的**定时器仍然是 ref 的（证明 hasRef 这个读数不是恒 false）',
      refed.length >= 1, JSON.stringify({ 记到: handles.length, ref: refed.length }))
  } finally {
    // 记录过的定时器**全部清掉**：替身线程故意不回 release，
    // 不清的话这条测试自己会把测试进程按住 15 秒（判据跑完了却不退出）。
    for (const row of handles) { try { realClearTimeout(row.handle) } catch { /* 忽略 */ } }
    globalThis.setTimeout = realSetTimeout
    delete process.env[DIE_ENV]
    stream.close()
    env.restore()
    fake.uninstall()
    await cdn.close()
    for (const dir of [home, fake.dir]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
    }
  }
}

const SCENARIOS = [
  ['线程死了要告知等待者；等待定时器不许按住进程', scenarioWorkerPendingSettle],
]

for (const [label, fn] of SCENARIOS) {
  console.log(`\n${label}`)
  try {
    await fn()
  } catch (error) {
    failed++
    console.log('  FAIL 场景跑通 :: ' + String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '))
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
