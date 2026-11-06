/**
 * 识别线程的释放语义（批次 7，docs/architecture-modernization.md §8.47）。
 *
 * 这一批判的是**「宿主说释放了，线程里到底有没有真的释放」**。
 * 起因是 6l-e 复核时发现三处对不上（逐行核对过 `src/host/index.js`）：
 *
 *   1. `/model` 重新下载完成后只调 `releaseRecognizer(model.id)` —— 那是主线程回退路径用的
 *      那份 Map 与「已加载」名单，**线程一个消息都没收到**。而线程里的识别器缓存键是
 *      `model|encoder|language`（`src/host/asr-worker.js` 的 `recognizerKey`），只看路径不看文件内容。
 *      于是「下载修复损坏的模型」这条用户流程修不动：文件换过了，线程继续用按旧文件建好的那份。
 *   2. `releaseInWorker` 算了 `keyPrefix`（要按「同一个模型」整组释放），也把它挂进了任务表，
 *      但 `postMessage` 只发了 `key` → 线程永远走精确键分支。
 *      同一份模型因为语言提示不同缓存的其它识别器（配置语言 + 待机强制语言）就一直占着内存。
 *   3. 插件停用/重载那条：`releaseAllRecognizers()` 只遍历主线程 Map（识别器住在线程里时它是空的），
 *      线程既没收到 release、也没被 terminate → 停用清理里那句「释放常驻的识别器
 *      （不然一直占着几百 MB）」承诺了没做的事。裁定的处理是**释放识别器、保留线程**（场景 B）。
 *
 * 还有一处顺带整理的：`releaseInWorker` 开头那句 `asrLoadedModels.delete(spec.modelId)` 是死代码
 * （唯一调用方传的是 `{model, encoder, language}`，不带 modelId）。名单改由 `releaseRecognizer`
 * 单点负责 —— 那处删除没有可观察行为差，所以**没有**为它写判据，理由写在 docs §8.47 的诚实边界里。
 *
 * 怎么判：跑真链路 —— 真宿主路由（`/asr-warmup`、`/transcribe`、`/model`）
 * + 真识别线程（临时树里的生产 `asr-worker.js`）+ 真本地下载（假 CDN），
 * 只把最外层的第三方依赖换成 `test/helpers/fake-sherpa.mjs`。
 * 替身会把每次 `ctor`（构造识别器）与 `free`（释放）记成事件流，
 * 于是「释放到底有没有生效」是**数得出来**的，不靠读源码。
 */
import fs from 'node:fs'
import path from 'node:path'
import osPkg from 'node:os'
import { startFakeCdn } from './helpers/fake-cdn.mjs'
import { loadHostRoutes, waitUntil, callRoute } from './helpers/host-routes.mjs'
import { fakeSherpa } from './helpers/fake-sherpa.mjs'
import { makeWhisperTier, placeTierFiles, cdnFiles } from './helpers/fake-asr-tier.mjs'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 一段足够响的 16k f32 音频（能量门限要过，否则宿主侧就拦掉了，到不了线程）。 */
function loudPcm(samples = 1600) {
  const arr = new Float32Array(samples)
  for (let i = 0; i < samples; i++) arr[i] = (i % 2 ? -0.1 : 0.1)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

/** 事件流里按类型挑出来（带线程号与 extra）。 */
const eventsOf = (rows, event) => rows.filter((row) => row.event === event)
const ctorRows = (fake) => eventsOf(fake.events(), 'ctor').filter((row) => row.thread >= 1)
const freeRows = (fake) => eventsOf(fake.events(), 'free').filter((row) => row.thread >= 1)

/**
 * 场景 A：线程里同一份模型缓存了**两个语言**的识别器时，
 * 「重新下载」必须把它们整组释放，之后重新预热要构造**新的**识别器。
 */
async function scenarioReleaseOnRedownload() {
  const tierId = 'test-asr-release/model'
  const { tier, files } = makeWhisperTier(tierId, 'fake-repo/asr-release')
  const home = fs.mkdtempSync(path.join(osPkg.tmpdir(), 'dsh-asr-release-home-'))
  placeTierFiles(home, tier, files)
  const modelDir = path.join(home, 'voice-typing', 'models', tier.repo)
  const cdn = await startFakeCdn({ files: cdnFiles(tier, files) })
  const fake = fakeSherpa({ marker: '假识别' })
  fake.install()   // 必须在起线程之前：Worker 继承父进程 env
  const env = await loadHostRoutes({
    dshHome: home,
    cdnOrigin: cdn.origin,
    appendAsrTiers: [tier],
    scaffoldRounds: true,
    // 配置语言给 en：下面再用请求头喂一份 zh 的副本，制造「同一模型两份缓存」的状态。
    rowConfig: { model: tierId, language: 'en', preloadModels: false },
    extraTreeFiles: fake.files,
  })
  const stream = env.openStream()
  try {
    // ① 预热 = 线程里构造第一份（语言取 currentLanguage()，配置是 'en'）。
    const warm = await callRoute(env, '/dsh-voice-typing/asr-warmup', { method: 'POST', body: '{}' })
    check('[A·预热] /asr-warmup 回 ready:true（真线程的成功回执）',
      warm.statusCode === 200 && warm.json()?.ready === true,
      `status=${warm.statusCode} ${JSON.stringify(warm.json())}`)
    check('[A·预热] 线程里构造了 1 份识别器',
      ctorRows(fake).length === 1, JSON.stringify(ctorRows(fake).map((row) => row.extra)))

    // ② 用请求头换一种语言识别 → 线程按 `model|encoder|language` 再缓存一份。
    const t = await callRoute(env, '/dsh-voice-typing/transcribe', {
      method: 'POST',
      body: loudPcm(),
      headers: { 'content-type': 'application/octet-stream', 'x-dsh-voice-language': 'zh' },
    })
    check('[A·两份副本] 换语言的 /transcribe 走通了（回包里有线程带回来的文本）',
      t.statusCode === 200 && /#thread=[1-9]/.test(String(t.json()?.text ?? '')),
      `status=${t.statusCode} ${JSON.stringify(t.json())}`)
    check('[A·两份副本] 线程里现在是**两份**识别器（同一模型、不同语言）',
      ctorRows(fake).length === 2, JSON.stringify(ctorRows(fake).map((row) => row.extra)))
    check('[A·两份副本] 两份的模型文件是同一个（差异只在语言那一维）',
      new Set(ctorRows(fake).map((row) => row.extra?.modelFile)).size === 1,
      JSON.stringify(ctorRows(fake).map((row) => row.extra?.modelFile)))

    // ③ 删掉磁盘上的 encoder → 真 `/model` 重下 → 完成回调。
    fs.rmSync(path.join(modelDir, 'model-encoder.onnx'))
    const started = await callRoute(env, '/dsh-voice-typing/model', {
      method: 'POST', body: JSON.stringify({ id: tierId }),
    })
    check('[A·重下] 缺文件就重新下：/model 回 202 started',
      started.statusCode === 202 && started.json()?.started === true && started.json()?.alreadyReady !== true,
      `status=${started.statusCode} ${JSON.stringify(started.json())}`)
    const gotReady = await waitUntil(
      () => stream.events().some((event) => event.event === 'model-ready' && event.data?.id === tierId),
      { timeoutMs: 20000, label: tierId },
    )
    check('[A·重下] 真下载跑完并广播了 model-ready',
      gotReady, JSON.stringify(stream.events().map((event) => event.event)))

    // ④ 释放要落到**线程**里：同一模型的几份识别器整组 free（不是只 free 配置语言那一份）。
    const freed = await waitUntil(() => freeRows(fake).length >= 2, { timeoutMs: 10000 })
    check('[A·释放] 重下完成后，线程里两份识别器都被释放（按模型整组，不是只一份）',
      freed, JSON.stringify({ frees: freeRows(fake).map((row) => row.extra), 期望: 2 }))
    check('[A·释放] 释放的都是这一档的模型文件（没有顺手把别档释放掉）',
      freeRows(fake).length >= 2
        && new Set(freeRows(fake).map((row) => row.extra?.modelFile)).size === 1
        && freeRows(fake).every((row) => row.extra?.modelFile === 'model-encoder.onnx'),
      JSON.stringify(freeRows(fake).map((row) => row.extra)))

    // ⑤ 名单侧：文件重新齐了，但 loaded 必须回到 false（客户端因此会先预热再开麦）。
    const ready = (await callRoute(env, '/dsh-voice-typing/asr-ready')).json()
    check('[A·名单] 重下后 loaded=false 且 downloaded=true',
      ready?.loaded === false && ready?.downloaded === true, JSON.stringify(ready))

    // ⑥ 再预热必须构造**新的**识别器：旧缓存已经不在线程里了。
    const ctorsBefore = ctorRows(fake).length
    const again = await callRoute(env, '/dsh-voice-typing/asr-warmup', { method: 'POST', body: '{}' })
    const ctorsAfter = ctorRows(fake).length
    check('[A·换新] 重下后再预热，线程里真的重新构造了识别器（不是命中旧文件建的那份）',
      again.json()?.ready === true && ctorsAfter > ctorsBefore,
      JSON.stringify({ ready: again.json(), ctorsBefore, ctorsAfter }))
    const reloaded = await callRoute(env, '/dsh-voice-typing/asr-ready')
    check('[A·换新] 之后 loaded 回到 true（记入与摘除能反复成对）',
      reloaded.json()?.loaded === true, JSON.stringify(reloaded.json()))
  } finally {
    stream.close()
    env.restore()
    fake.uninstall()
    await cdn.close()
    for (const dir of [home, fake.dir]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
    }
  }
}

/**
 * 场景 B：插件停用/重载 —— 识别器要真的从线程里放掉，线程本身保留。
 *
 * 这是一处**取舍**（用户裁定：释放识别器、保留线程），理由是本机实测
 * 「起线程 + 加载 SenseVoice 228 MB」约 1.1 秒，而停用期间占着的正是这几百 MB。
 * 老写法只遍历主线程那张 `recognizers` Map（识别器住在线程里时它是空的），
 * 于是停用清理里那句「释放常驻的识别器」承诺了没做的事（docs §8.46 的 6l-e 发现 1）。
 *
 * 判据形态：
 *   - 「真的放掉了」= 替身事件流里出现 `free`（按模型整组，两份语言副本都算）；
 *   - 「名单也翻回来」= `/asr-ready` 的 `loaded` 变 false；
 *   - 「线程保留」= 再预热时新构造的识别器**同一个 threadId**（重起线程会是新的 id），
 *     并且它是一次**真的构造**（ctor 数增加），说明缓存确实不在线程里了。
 */
async function scenarioReleaseOnDispose() {
  const tierId = 'test-asr-dispose/model'
  const { tier, files } = makeWhisperTier(tierId, 'fake-repo/asr-dispose')
  const home = fs.mkdtempSync(path.join(osPkg.tmpdir(), 'dsh-asr-dispose-home-'))
  placeTierFiles(home, tier, files)
  const cdn = await startFakeCdn({ files: cdnFiles(tier, files) })
  const fake = fakeSherpa({ marker: '假识别' })
  fake.install()
  const env = await loadHostRoutes({
    dshHome: home,
    cdnOrigin: cdn.origin,
    appendAsrTiers: [tier],
    scaffoldRounds: true,
    rowConfig: { model: tierId, language: 'en', preloadModels: false },
    extraTreeFiles: fake.files,
  })
  const stream = env.openStream()
  try {
    // ① 预热一份，再用请求头造出同一模型的第二份语言副本。
    const warm = await callRoute(env, '/dsh-voice-typing/asr-warmup', { method: 'POST', body: '{}' })
    check('[B·预热] /asr-warmup 回 ready:true',
      warm.statusCode === 200 && warm.json()?.ready === true,
      `status=${warm.statusCode} ${JSON.stringify(warm.json())}`)
    const t = await callRoute(env, '/dsh-voice-typing/transcribe', {
      method: 'POST',
      body: loudPcm(),
      headers: { 'content-type': 'application/octet-stream', 'x-dsh-voice-language': 'zh' },
    })
    check('[B·两份副本] 换语言的 /transcribe 走通了（真是线程在干活）',
      t.statusCode === 200 && /#thread=[1-9]/.test(String(t.json()?.text ?? '')),
      `status=${t.statusCode} ${JSON.stringify(t.json())}`)
    check('[B·两份副本] 线程里现在是两份识别器',
      ctorRows(fake).length === 2, JSON.stringify(ctorRows(fake).map((row) => row.extra)))
    const threadBefore = new Set(ctorRows(fake).map((row) => row.thread))
    check('[B·两份副本] 这两份住在**同一个**线程里（threadId 只有一个）',
      threadBefore.size === 1, JSON.stringify([...ctorRows(fake).map((row) => row.thread)]))
    const readyBefore = (await callRoute(env, '/dsh-voice-typing/asr-ready')).json()
    check('[B·停用前] /asr-ready 的 loaded=true（名单里有这一档）',
      readyBefore?.loaded === true, JSON.stringify(readyBefore))

    // ② 跑一次「插件停用/重载」的清理（生产里挂在 ctx.inject 回调的返回值上）。
    let disposeError = null
    let ranCleanups = 0
    try {
      ranCleanups = env.disposePlugin()
    } catch (error) {
      disposeError = String(error?.message ?? error)
    }
    check('[B·停用] 停用清理存在且跑完不抛错',
      disposeError === null && ranCleanups >= 1,
      disposeError ?? JSON.stringify({ ranCleanups }))

    // ③ 线程里那份（含语言副本）真的被 free。
    const freed = await waitUntil(() => freeRows(fake).length >= 2, { timeoutMs: 10000 })
    check('[B·停用] 停用把线程里两份识别器都释放了（按模型整组）',
      freed, JSON.stringify({ frees: freeRows(fake).map((row) => row.extra), 期望: 2 }))
    check('[B·停用] 释放的都是这一档的模型文件',
      freeRows(fake).length >= 2
        && freeRows(fake).every((row) => row.extra?.modelFile === 'model-encoder.onnx'),
      JSON.stringify(freeRows(fake).map((row) => row.extra)))

    // ④ 名单同步翻回来：客户端下次开麦会先预热。
    const readyAfter = (await callRoute(env, '/dsh-voice-typing/asr-ready')).json()
    check('[B·名单] 停用后 loaded=false 但 downloaded=true（模型还在盘上，只是不在内存里）',
      readyAfter?.loaded === false && readyAfter?.downloaded === true, JSON.stringify(readyAfter))

    // ⑤ 线程保留：再预热是「重新加载模型」，不是「重起线程」。
    const ctorsBefore = ctorRows(fake).length
    const again = await callRoute(env, '/dsh-voice-typing/asr-warmup', { method: 'POST', body: '{}' })
    const ctorsAfter = ctorRows(fake).length
    check('[B·线程保留] 停用后再预热回 ready:true（路由与线程都还在）',
      again.json()?.ready === true, JSON.stringify(again.json()))
    check('[B·线程保留] 再预热是一次真的重新加载（构造数增加，旧缓存不在线程里）',
      ctorsAfter > ctorsBefore, JSON.stringify({ ctorsBefore, ctorsAfter }))
    const threadsAfter = new Set(ctorRows(fake).map((row) => row.thread))
    check('[B·线程保留] 新构造的识别器还在**同一个**线程里（没有为它重起线程）',
      threadsAfter.size === 1 && threadsAfter.has([...threadBefore][0]),
      JSON.stringify({ before: [...threadBefore], after: [...threadsAfter] }))
    const reloaded = await callRoute(env, '/dsh-voice-typing/asr-ready')
    check('[B·线程保留] 之后 loaded 回到 true（停用→重载→再用 这条环跑得通）',
      reloaded.json()?.loaded === true, JSON.stringify(reloaded.json()))
  } finally {
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
  ['重新下载真的换掉了线程里的识别器（含多语言副本整组释放）', scenarioReleaseOnRedownload],
  ['插件停用/重载：识别器真的从线程里放掉，线程本身保留', scenarioReleaseOnDispose],
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
