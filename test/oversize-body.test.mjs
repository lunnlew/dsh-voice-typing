/**
 * 超限请求必须有回执（批次 8，docs/architecture-modernization.md §8.49）。
 *
 * 这条缺陷是**装机回归**挖出来的，测试挖不出来：
 * 真机上给 `/dsh-voice-typing/transcribe` 发 17 MB 音频（超过读体上限 16 MB），
 * 连接**一直挂着**，20 秒、120 秒都没有任何回执；同一时刻给 `/config`（上限 1 MB）
 * 发 5 MB 却 23 毫秒就回了 500。差别在 `/transcribe` 与 `/asr-stream` 的 catch 里那句
 * `if (controller.signal.aborted) return` —— 它想挡的是「客户端走了，别对着死连接写」，
 * 但在 Node 里「消费方自己提前退出读体循环」（超限抛错正是这种）也会把入站流标成 aborted，
 * 于是主动超限被当成客户端断开，**该写的 413 一个都没写出去**。
 *
 * 为什么测试原先看不见：`test/helpers/host-routes.mjs` 的假 req 是手搓的异步可迭代对象，
 * 消费方提前退出时**不会**触发 `'aborted'`（真 Node 会）。夹具比生产松，缺陷就藏在缝里 ——
 * 本批先把夹具补到和 Node 一样，再让判据打在生产代码上。
 *
 * 判据一律真跑：真宿主路由 + 真识别线程（临时树里的生产 `asr-worker.js`），
 * 只把第三方 sherpa 换成 `test/helpers/fake-sherpa.mjs`。
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

/** 一段足够响的 16k f32 音频（能量门限要过，否则宿主侧就拦掉了）。 */
function loudPcm(samples = 1600) {
  const arr = new Float32Array(samples)
  for (let i = 0; i < samples; i++) arr[i] = (i % 2 ? -0.1 : 0.1)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

/** 读回执正文；「一个字都没写」是要判的状态之一，不能让它把场景带崩。 */
function safeJson(resLike) {
  try { return resLike?.json?.() ?? null } catch { return null }
}

async function scenarioOversizeBody() {
  const tierId = 'test-oversize/model'
  const { tier, files } = makeWhisperTier(tierId, 'fake-repo/oversize')
  const home = fs.mkdtempSync(path.join(osPkg.tmpdir(), 'dsh-oversize-home-'))
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
    // 先把链路跑热：证明「后面那些 413」不是因为整条路由坏了。
    const warm = await callRoute(env, '/dsh-voice-typing/asr-warmup', { method: 'POST', body: '{}' })
    check('[前置] 预热成功（真线程 + 替身 sherpa 就绪）',
      warm.statusCode === 200 && warm.json()?.ready === true,
      `status=${warm.statusCode} ${JSON.stringify(warm.json())}`)
    const ok0 = await callRoute(env, '/dsh-voice-typing/transcribe', {
      method: 'POST',
      body: loudPcm(),
      headers: { 'content-type': 'application/octet-stream' },
    })
    check('[前置] 合法音频回 200 且带文本（链路本身可用）',
      ok0.statusCode === 200 && typeof ok0.json()?.text === 'string',
      `status=${ok0.statusCode} ${JSON.stringify(ok0.json())}`)
    // 记下此刻线程里已经释放了几份：⑥ 用它确认「超限不会顺手释放」。
    const freesBefore = fake.events().filter((row) => row.event === 'free' && row.thread >= 1).length

    // ① 超过读体上限（16 MB）：必须有回执，不能把连接挂住。
    const over = await callRoute(env, '/dsh-voice-typing/transcribe', {
      method: 'POST',
      body: Buffer.alloc(17 * 1024 * 1024, 7),
      headers: { 'content-type': 'application/octet-stream' },
    }, 8000)
    check('[超限·识别] 17MB 音频在限时内拿到回执（不是 0=挂死）',
      over.statusCode !== 0 && over.statusCode >= 400 && over.statusCode < 500,
      JSON.stringify({ status: over.statusCode, body: safeJson(over) }))
    check('[超限·识别] 回执说的是体积超限（413 的语义，不是含糊的 500）',
      over.statusCode === 413, JSON.stringify({ status: over.statusCode, body: safeJson(over) }))
    check('[超限·识别] 正文里能看到「请求体过大」这句（给日志/诊断看的人读原文）',
      /请求体过大|过大|too ?large/i.test(String(safeJson(over)?.error ?? '')),
      JSON.stringify(safeJson(over)))

    // ② 同一条路由在超限之后照常可用（超限不能把路由/线程搞坏）。
    const ok1 = await callRoute(env, '/dsh-voice-typing/transcribe', {
      method: 'POST',
      body: loudPcm(),
      headers: { 'content-type': 'application/octet-stream' },
    })
    check('[超限·识别] 超限之后同一条路由仍能识别（没有把路由搞坏）',
      ok1.statusCode === 200 && typeof ok1.json()?.text === 'string',
      `status=${ok1.statusCode} ${JSON.stringify(ok1.json())}`)

    // ③ 流式那条用的是同一句 aborted 判据，一起修。
    const overStream = await callRoute(env, '/dsh-voice-typing/asr-stream?sessionId=oversize-1', {
      method: 'POST',
      body: Buffer.alloc(17 * 1024 * 1024, 7),
      headers: { 'content-type': 'application/octet-stream' },
    }, 8000)
    check('[超限·流式] 17MB 分片在限时内有回执（不是挂死）',
      overStream.statusCode !== 0 && overStream.statusCode >= 400 && overStream.statusCode < 500,
      JSON.stringify({ status: overStream.statusCode, body: safeJson(overStream) }))
    check('[超限·流式] 回执同样是体积超限（413）',
      overStream.statusCode === 413, JSON.stringify({ status: overStream.statusCode, body: safeJson(overStream) }))

    // ④ 客户端真的走了：处理方不能对着死连接写，也不能抛「write after end」。
    //    夹具里 clientAbort 会在读体提前退出时把 res 一起拆掉，模拟真实断连。
    let threw = ''
    let dead = null
    try {
      dead = await env.request('/dsh-voice-typing/transcribe', {
        method: 'POST',
        body: Buffer.alloc(17 * 1024 * 1024, 7),
        headers: { 'content-type': 'application/octet-stream' },
        clientAbort: true,
      })
    } catch (error) {
      threw = String(error?.message ?? error)
    }
    check('[断连] 客户端中途走了：处理方不抛错（不写死连接）',
      threw === '', threw)
    check('[断连] 确实没往死连接里写正文（一个字节都不写，而不是写了没人收）',
      dead !== null && (dead.chunks?.length ?? 0) === 0 && dead.statusCode === null,
      JSON.stringify({ statusCode: dead?.statusCode, chunks: dead?.chunks?.length }))
    check('[断连] 断连之后服务照常（再来一条合法请求仍能识别）',
      (await callRoute(env, '/dsh-voice-typing/transcribe', {
        method: 'POST',
        body: loudPcm(),
        headers: { 'content-type': 'application/octet-stream' },
      })).statusCode === 200, '后续请求没回 200')

    // ⑤ 这条规则不是只给识别路由打的补丁：别的路由的上限同样要有回执。
    const overConfig = await callRoute(env, '/dsh-voice-typing/config', {
      method: 'POST',
      body: JSON.stringify({ note: 'x'.repeat(2 * 1024 * 1024) }),   // >2MB，超过 /config 自己的 1MB 上限
    }, 8000)
    check('[超限·配置] 2MB 级 JSON 有回执（413/500 都算回了话，就是不能挂住）',
      overConfig.statusCode !== 0 && overConfig.statusCode >= 400,
      JSON.stringify({ status: overConfig.statusCode, body: safeJson(overConfig) }))
    // 上限之下的请求走的是业务校验，不是体积拒绝（证明上限没被顺手改小）。
    const under = await callRoute(env, '/dsh-voice-typing/config', {
      method: 'POST',
      body: JSON.stringify({ ttsEngine: 'nonsense' }),   // 合法体积、枚举外的取值
    }, 8000)
    check('[超限·配置] 上限之下的坏内容仍由业务校验拒绝（不是被体积上限误伤）',
      under.statusCode === 400,
      JSON.stringify({ status: under.statusCode, body: safeJson(under) }))

    // ⑥ 超限不该留下副作用：诊断面读得到、线程里那份识别器没被误释放。
    const diag = await callRoute(env, '/dsh-voice-typing/diagnostics')
    check('[副作用] 一连串超限之后 /diagnostics 仍回 200 ok:true',
      diag.statusCode === 200 && diag.json()?.ok === true, `status=${diag.statusCode}`)
    const ready = await callRoute(env, '/dsh-voice-typing/asr-ready')
    check('[副作用] 超限没有把已加载的模型从名单里带掉（loaded 仍为 true）',
      ready.json()?.loaded === true, JSON.stringify(ready.json()))
    const freesAfter = fake.events().filter((row) => row.event === 'free' && row.thread >= 1).length
    check('[副作用] 超限没有顺手把线程里那份识别器释放掉（free 事件数不变）',
      freesAfter === freesBefore, JSON.stringify({ freesBefore, freesAfter }))
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
  ['超限请求必须有回执（识别 / 流式 / 配置三条路 + 真断连）', scenarioOversizeBody],
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
