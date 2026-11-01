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
 *
 * 这个测试**真起一个 worker**、真发消息、真收回包 ——
 * 光看源码断言不出来（契约错位是运行时的事）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const idx = fs.readFileSync(path.join(root, 'lib/index.js'), 'utf8')
const workerSrc = fs.readFileSync(path.join(root, 'lib/asr-worker.js'), 'utf8')

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

console.log('主线程：handler 必须传整个 message')
{
  const handler = idx.slice(idx.indexOf("worker.on('message'"), idx.indexOf("worker.on('message'") + 900)
  check('handler 传的是 message 本身', /task\.resolve\(message\)/.test(handler),
    '预筛成 {text, speech} 会把 preload / release 的字段丢掉')
  check('不再预筛成 {text, speech}', !/task\.resolve\(\{\s*text:/.test(handler))
}

console.log('\n主线程：各用途自己解包')
{
  const preload = idx.slice(idx.indexOf('function preloadInWorker'), idx.indexOf('function preloadInWorker') + 1200)
  check('preload 检查 value?.ok', /Boolean\(value\?\.ok\)/.test(preload))
  const release = idx.slice(idx.indexOf('function releaseInWorker'), idx.indexOf('function releaseInWorker') + 1200)
  check('release 检查 value?.released', /Boolean\(value\?\.released\)/.test(release))
  const recognize = idx.slice(idx.indexOf('function recognizeInWorker'), idx.indexOf('function recognizeInWorker') + 1200)
  check('recognize 自己取 text/speech', /message\?\.text/.test(recognize) && /message\?\.speech/.test(recognize))
}

console.log('\nworker：三种回包必须带对应字段')
{
  check('preload 回包带 preloaded', /ok: true, \.\.\.result/.test(workerSrc) && /preloaded: true/.test(workerSrc))
  check('release 回包带 released', /released: (true|false)/.test(workerSrc))
  check('失败回包带 ok:false 与 error', /ok: false, error:/.test(workerSrc))
}

console.log('\n真跑一个 worker（不加载模型，只验证消息契约）')
{
  const worker = new Worker(path.join(root, 'lib/asr-worker.js'))
  const received = []
  let timer = null
  const done = new Promise((resolve) => {
    worker.on('message', (m) => { received.push(m); resolve(m) })
    worker.on('error', (e) => { received.push({ error: e.message }); resolve(null) })
    // 兜底定时器：unref + 拿到结果后 clear —— 不能让它把进程拖住 8 秒。
    timer = setTimeout(() => resolve(null), 8000)
    timer.unref?.()
  })
  // 发一个必然失败的 preload（缺 spec）—— 目的是看**失败**回包的形状
  worker.postMessage({ kind: 'preload', id: 1 })
  const msg = await done
  clearTimeout(timer)
  check('worker 回了消息', !!msg, JSON.stringify(msg))
  if (msg) {
    check('失败回包带 ok:false', msg.ok === false, JSON.stringify(msg))
    check('失败回包带 error', typeof msg.error === 'string' && msg.error.length > 0, JSON.stringify(msg))
    check('失败回包带 id（主线程靠它对上号）', msg.id === 1, JSON.stringify(msg))
  }
  await worker.terminate()
}

console.log('\n预加载成功路径的真实验证（加载 SenseVoice，慢集成，默认不跑）')
if (!SLOW_TESTS) {
  // 显式 skip（输出里说明原因），不参与失败计数；代码保留在 else 分支里，
  // 需要时用 DSH_VT_SLOW_TESTS=1 单跑，断言不会丢。
  console.log('  ⏭ 跳过：真实 SenseVoice 预加载集成默认不跑（设 DSH_VT_SLOW_TESTS=1 启用；本机需有模型）。')
} else {
  const cat = await import('../lib/model-catalog.js?probe=' + Date.now())
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
