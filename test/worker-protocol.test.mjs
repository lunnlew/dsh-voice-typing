/**
 * 回归测试：识别 worker 的消息契约。
 *
 * 背景（2026-10-31，用户反馈「点击提示识别模型加载失败」）：
 *   `asrPending` 这张表被三种请求共用，而它们的回包形状**不同**：
 *     recognize → {ok, text, speech}
 *     preload   → {ok, preloaded}
 *     release   → {ok, released}
 *
 *   但主线程的 message handler 统一转成了 `{text, speech}`
 *   （为 recognize 设计的形状）——于是：
 *     preload 收到的 value 里**没有 ok 字段**
 *       → `Boolean(value?.ok)` 恒为 false
 *       → **预加载即使成功也永远报告失败**
 *       → 客户端「识别模型加载失败」，开麦被卡住。
 *     release 同理，`value.released` 永远是 undefined。
 *
 * 规则（可执行）：
 *   1. handler 传**整个 message**，不预筛字段；
 *   2. 各用途在自己的 resolve 包装里解包；
 *   3. worker 的三种回包必须真的带对应的字段。
 *   4. （本轮新加）预加载用的缓存键必须和识别时算的是**同一个** ——
 *      否则预热的那份模型永远用不到，还漏在 worker 内存里不被释放。
 *
 * 怎么执行这些规则（批次 6e，docs/architecture-modernization.md §8.38）：
 *   这个文件**一行源码正则都不读**。原来那 8 条 `/task\.resolve\(message\)/`、
 *   `/Boolean\(value\?\.ok\)/`、`/ok: true, \.\.\.result/` 型的判据换成两次真跑：
 *     · 第一组走 `test/helpers/host-routes.mjs`（真宿主路由）+ 临时树里的真
 *       `asr-worker.js`（真生产源码），只有最外层的第三方依赖 `sherpa-onnx-node`
 *       换成 `test/helpers/fake-sherpa.mjs` —— 于是「模型加载成功」这条路径不需要 230MB 模型；
 *     · 第二组直接对 `lib/asr-worker.js`（真会被加载的那份产物）发三条不需要模型的消息：
 *       失败的 preload、没加载过的 release、空音频的 recognize，收回包验形状。
 *   契约错位是运行时的事，本来就只能这么验。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { hostModule } from './helpers/host-source.mjs'
import { loadHostRoutes, callRoute } from './helpers/host-routes.mjs'
import { fakeSherpa } from './helpers/fake-sherpa.mjs'
import { makeWhisperTier, placeTierFiles } from './helpers/fake-asr-tier.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/**
 * 慢集成开关：真实加载 SenseVoice（约 230MB）默认**不跑**。
 *
 * 原因：CI 上既没有 DSH 语音输入 Bundle 也没下载过模型（跑了也是 skip/名义覆盖）；
 * 开发机有模型时单跑要 80~90s，与「单元测试套件」的定位不符。
 * 要跑真实预加载集成时显式设置 `DSH_VT_SLOW_TESTS=1`（本机需已有 SenseVoice 模型）。
 */
const SLOW_TESTS = process.env.DSH_VT_SLOW_TESTS === '1'

// 合成档位与摆盘在 `test/helpers/fake-asr-tier.mjs`（批次 6l-e 搬过去共用，
// 那份文件头写清了「为什么文件名必须是 encoder / decoder / tokens 这三个」）。
// 这里只留三个文件：whisper 档位没有 vad —— worker 里 `getVad` 拿到 null 就跳过切段，
// 识别路径最短。

/** 造一段「肯定过能量门限」的 f32 PCM（门限 0.008，这里振幅 0.1）。 */
function loudPcm(samples = 1600) {
  const arr = new Float32Array(samples)
  for (let i = 0; i < samples; i++) arr[i] = (i % 2 ? -0.1 : 0.1)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

// 「有界地等一条会起线程的宿主路由」住在 test/helpers/host-routes.mjs 的 callRoute
// （批次 6l-e 搬过去：listening-ready 的「记入/摘除」真跑要等的是同一类路由，
//  那里的理由写在那份导出的注释里 —— 识别线程 unref，等待期没有 ref 句柄）。

console.log('宿主 + 识别线程：三种回包各真跑一次（真生产代码 + 假 sherpa 依赖）')
{
  // 这一节替代 8 条源码正则（`/task\.resolve\(message\)/`、`/Boolean\(value\?\.ok\)/`、
  // `/ok: true, \.\.\.result/` …）。批次 6e，docs §8.38。
  //
  // 跑的是真链路：真宿主路由（/asr-warmup、/transcribe）→ 真 `getAsrWorker` 与它的
  // message handler → 真 `lib`-外的**临时树里的** `asr-worker.js`（生产源码本身）→
  // 只有最外层的第三方依赖 `sherpa-onnx-node` 换成 `test/helpers/fake-sherpa.mjs`。
  // 为什么替身是这一层：当年坏掉的是**消息契约**，而它的成功路径需要一个「加载成功的模型」；
  // 真模型 230MB 不该进测试，可一旦把模型换成假的，契约就还是真跑的。
  const tierId = 'test-worker-protocol/model'
  const { tier, files } = makeWhisperTier(tierId, 'fake-repo/worker-protocol')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worker-protocol-home-'))
  placeTierFiles(home, tier, files)
  const fake = fakeSherpa({ marker: '假识别' })
  fake.install()   // 必须在起线程之前：Worker 继承父进程 env
  try {
    const env = await loadHostRoutes({
      dshHome: home,
      appendAsrTiers: [tier],
      rowConfig: { model: tierId },
      extraTreeFiles: fake.files,
    })
    try {
      // ① preload 的**成功**路径 —— 旧 bug 在这里的表现就是 `ready:false`
      //    （handler 把回包预筛成 {text, speech}，`Boolean(value?.ok)` 恒为 false）。
      const warm = await callRoute(env, '/dsh-voice-typing/asr-warmup', { method: 'POST', body: '{}' })
      const warmBody = warm.json?.() ?? {}
      check('POST /asr-warmup 在模型可加载时回 ready:true（旧 bug：成功也报「识别模型加载失败」）',
        warm.statusCode === 200 && warmBody.ready === true,
        `status=${warm.statusCode} ${JSON.stringify(warmBody)}`)
      check('预热真的在**线程里**构造了识别器（threadId ≥ 1，不是主线程回落）',
        fake.events().some((e) => e.event === 'ctor' && e.thread >= 1),
        JSON.stringify(fake.events()))
      // ② recognize —— 回包里的 text/speech 必须由 recognizeInWorker 自己从**整个 message** 取。
      const ctorsBeforeRecognize = fake.events().filter((e) => e.event === 'ctor').length
      const t = await callRoute(env, '/dsh-voice-typing/transcribe', {
        method: 'POST',
        body: loudPcm(),
        headers: { 'content-type': 'application/octet-stream' },
      })
      const tBody = t.json?.() ?? {}
      check('POST /transcribe 拿到线程里的识别文本（回包形状对得上才传得出来）',
        t.statusCode === 200 && typeof tBody.text === 'string' && /#thread=[1-9]/.test(tBody.text),
        `status=${t.statusCode} ${JSON.stringify(tBody)}`)
      check('POST /transcribe 的 speech 也是真回包带的（不是主线程补的默认值）',
        tBody.speech === true, JSON.stringify(tBody))
      // ②b 预热完马上识别，**不该**再构造第二个识别器。
      //     worker 的缓存键是 `model|encoder|language`，而 /asr-warmup 过去传的是
      //     `resolveLanguage(settings.language)`（配置写 auto 就是 'auto'）、
      //     /transcribe 传的是 `currentLanguage()`（auto 会被解析成系统语言，如 'zh'）——
      //     两边对不上，开麦预热的那份永远用不到：模型加载两遍、首次识别照样等几十秒，
      //     空闲释放也按 `currentLanguage()` 算键，那份 'auto' 的副本还永远漏在内存里。
      //     本轮（批次 6e，docs §8.38）由这条真跑判据抓到，修法见同批的生产改动。
      const ctorsAfterRecognize = fake.events().filter((e) => e.event === 'ctor').length
      check('预热后的首次 /transcribe 复用预热好的那份识别器（预热语言与识别语言同源）',
        ctorsAfterRecognize === ctorsBeforeRecognize,
        `构造次数 ${ctorsBeforeRecognize} → ${ctorsAfterRecognize}：预热的那份没被用上，说明两边的缓存键不一致`)
      // ③ 同一个模型再预热一次：应该走「已加载」快路径，不再重新构造识别器。
      //    这条钉的是 `asrLoadedModels` 是在**解包成功之后**记的 —— 旧 bug 那种
      //    「回包被筛掉 → ok 恒 false」的写法会连着把这条一起打红。
      //    数的是**增量**而不是总数：前面任何一步在线程里建过识别器，都不该让这条误红。
      const ctorsBefore = fake.events().filter((e) => e.event === 'ctor').length
      const again = await callRoute(env, '/dsh-voice-typing/asr-warmup', { method: 'POST', body: '{}' })
      const ctorsAfter = fake.events().filter((e) => e.event === 'ctor').length
      check('同一个模型再次预热走「已加载」快路径（不再新构造识别器）',
        again.json?.()?.ready === true && ctorsAfter === ctorsBefore,
        JSON.stringify({ res: again.json?.(), ctorsBefore, ctorsAfter }))
    } finally {
      env.restore()
    }
  } finally {
    fake.uninstall()
    for (const dir of [home, fake.dir]) {
      // Windows 上删临时目录会被杀毒/索引器短暂拦住；清理失败不能算判据失败。
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
    }
  }
}

console.log('\n真跑一个 worker（不加载模型，只验证消息契约）')
{
  // 这一节验的是 **lib/ 里那份真会被加载的产物**：三条消息都不需要模型，
  // 所以能在普通测试里当场跑出回包形状（批次 6e 用它替代
  // 「`/ok: false, error:/`、`/released: (true|false)/` 这类 worker 源码正则」）。
  const worker = new Worker(path.join(root, 'lib/asr-worker.js'))
  const errors = []
  worker.on('error', (e) => { errors.push(e.message) })
  /** 发一条消息，等**同一个 id** 的回包（worker 是单线程串行处理，不会串号）。 */
  const ask = (payload, timeoutMs = 8000) => new Promise((resolve) => {
    // 兜底定时器：unref + 拿到结果后 clear —— 不能让它把进程拖住 8 秒。
    const timer = setTimeout(() => resolve(null), timeoutMs)
    timer.unref?.()
    const found = (m) => { if (m.id !== payload.id) return; worker.off('message', found); clearTimeout(timer); resolve(m) }
    worker.on('message', found)
    worker.postMessage(payload)
  })

  // ① 必然失败的 preload（缺 spec）—— 看**失败**回包的形状。
  const fail = await ask({ kind: 'preload', id: 1 })
  check('worker 回了消息（preload 缺 spec 这条有回包）', !!fail, JSON.stringify(fail))
  if (fail) {
    check('失败回包带 ok:false', fail.ok === false, JSON.stringify(fail))
    check('失败回包带 error', typeof fail.error === 'string' && fail.error.length > 0, JSON.stringify(fail))
    check('失败回包带 id（主线程靠它对上号）', fail.id === 1, JSON.stringify(fail))
  }

  // ② release 一个没加载过的键 —— 不需要模型，就能看**成功**回包带不带 `released`。
  const rel = await ask({ kind: 'release', id: 2, key: 'never-loaded|' })
  check('release 成功回包带 ok:true 与布尔 released（旧判据扫的是源码里的 /released: (true|false)/）',
    !!rel && rel.ok === true && typeof rel.released === 'boolean' && rel.released === false,
    JSON.stringify(rel))

  // ③ 空音频的 recognize —— 走到 `return {text:'', speech:false}` 这条**不加载模型**的
  //    早退分支，于是能当场验「成功回包把 ...result 摊平了」。
  const rec = await ask({ kind: 'recognize', id: 3, spec: {}, samples: new Float32Array(0) })
  check('recognize 成功回包带 text 与 speech（旧判据扫的是 /ok: true, \\.\\.\\.result/）',
    !!rec && rec.ok === true && typeof rec.text === 'string' && typeof rec.speech === 'boolean',
    JSON.stringify(rec))

  check('这三条消息都没把 worker 线程搞崩（错误都走 ok:false 回包）',
    errors.length === 0, errors.join(' | '))
  await worker.terminate()
}

console.log('\n预加载成功路径的真实验证（加载 SenseVoice，慢集成，默认不跑）')
if (!SLOW_TESTS) {
  // 显式 skip（输出里说明原因），不参与失败计数；代码保留在 else 分支里，
  // 需要时用 DSH_VT_SLOW_TESTS=1 单跑，断言不会丢。
  console.log('  ⏭ 跳过：真实 SenseVoice 预加载集成默认不跑（设 DSH_VT_SLOW_TESTS=1 启用；本机需有模型）。')
} else {
  const cat = await hostModule('model-catalog', { nocache: true })
  const model = cat.findModel('sensevoice')
  let paths = null
  try { paths = cat.modelPaths(model) } catch { }
  if (!paths) {
    // 需要真实 SenseVoice 模型（约 230MB）。CI 上既没有 DSH 语音输入 Bundle，
    // 也没下载过模型 —— 硬要失败只会让每次 push 都红，而且与代码正确性无关。
    console.log('  ⏭ 跳过：本机没有 SenseVoice 模型（宿主未装语音输入 Bundle，且未下载）。需要模型才能真跑预加载。')
  } else {
    const worker = new Worker(path.join(root, 'lib/asr-worker.js'))
    let timer = null
    const done = new Promise((resolve) => {
      worker.on('message', (m) => resolve(m))
      worker.on('error', (e) => resolve({ ok: false, error: e.message }))
      // 模型加载可能要十几秒；90s 兜底定时器同样 unref + 用后清理。
      timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 90000)
      timer.unref?.()
    })
    worker.postMessage({
      kind: 'preload',
      id: 7,
      spec: {
        modelId: model.id,
        kind: 'sensevoice',
        model: paths.model,
        encoder: null, decoder: null, joiner: null,
        tokens: paths.tokens,
        vad: paths.vad ?? null,
        language: 'auto',
      },
    })
    const msg = await done
    clearTimeout(timer)
    check('预加载成功时回包带 ok:true', msg?.ok === true, JSON.stringify(msg)?.slice(0, 160))
    check('回包带 preloaded', msg?.preloaded === true, JSON.stringify(msg)?.slice(0, 160))
    // 这才是关键：主线程的解包逻辑必须能把它认成成功
    check('主线程的解包能认出成功（Boolean(value?.ok) === true）',
      Boolean(msg?.ok) === true)
    await worker.terminate()
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
