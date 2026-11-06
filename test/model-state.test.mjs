/**
 * 模型下载状态链路：宿主路由（/models、/model、SSE）的**真实行为**判据。
 *
 * 它替换掉 `test/download.test.mjs` 里那七条读 `src/host/index.js` 源码正行的判据
 * （docs/architecture-modernization.md §8.34 批次 2b）。逐条对应关系：
 *
 *   旧判据（源码文本）                                              | 新判据（跑出来的东西）
 *   ---------------------------------------------------------------|----------------------------------------------------------
 *   `/const downloadProgress = new Map\(\)/`（维护了进度表）        | 下载进行中 GET /models 的响应里出现数值 received/total，且随轮次增长
 *   `/category: 'asr',\s*\n\s*downloading: activeDownloads.has/`    | /models 响应里**每一条 asr 档位**都有布尔 downloading（缺字段就是当年那个 bug）
 *   `/\.\.\.\(downloadProgress\.get\(m\.id\) \?\? \{\}\)/`          | 正在下的那一条带 received/total；没在下的那一条两个字段都不存在
 *   `/downloadProgress\.set\(model\.id, \{ received, total \}\)/`   | 多次轮询收到的 total 恒等于**服务端真实大小**（档位里故意写 1 字节），received 单调不减
 *   `/downloadProgress\.delete\(model\.id\)/`                      | 下载结束后再拉 /models，那两个字段消失（界面上不会停在一个假百分比）
 *   `/activeDownloads\.delete\(..\)\{0,120\}broadcast\('model-ready'/` | 在收到 model-ready 的**那一刻**同步发起的 GET，响应里 downloading 已经是 false
 *   同上（model-error）                                             | 失败后同样的当场 GET 里 downloading=false 且 ready=false（按钮不会永远禁用）
 *
 * 为什么最后两条值得做（以及它的**诚实边界**）：
 *   当年那条判据盯的是「源码里两行的先后」。把生产代码改成
 *   `broadcast(...) ; setTimeout(() => activeDownloads.delete(id), 50)`
 *   ——即「清状态被挪到事件之后的某个异步尾巴上」——真实客户端就会踩到「收到就绪事件、
 *   立刻刷新、结果还是下载中、界面永远回不来」。本用例抓的就是这个形状。
 *   反过来，把**同一 tick 里**的相邻两行互换，客户端在任何时刻都观察不到差别，
 *   那条旧判据锁的那种「写法顺序」本来就不是行为约束 —— 这里明确不假装能抓它。
 *
 * 跑法：`node test/model-state.test.mjs`（全程本地 HTTP + 临时目录，不联网）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startFakeCdn, patternBuffer, digest } from './helpers/fake-cdn.mjs'
import { loadHostRoutes, waitUntil } from './helpers/host-routes.mjs'
import { MODEL_DOWNLOAD_REASONS, isModelDownloadReason } from '../src/shared/model-download-reasons.js'

/** 真实大小：≥ model-catalog 的 PARALLEL_THRESHOLD(8MB)，于是走分片路径，进度才有多个台阶。 */
const BIG = 9_000_000
/** 分片并发数（生产常量，这里只用来算「重复点击不该起第二份下载」的请求数上限）。 */
const CHUNK_REQUESTS = 8

/**
 * `add()` 是唯一的判据通道：每一条场景跑出来的结论都在这里计数并当场打印，
 * 最后一行的「通过/失败」就由它们构成。
 * （批次 2 这里曾有第二条通道专门收变异轮的累计结论，批次 6c 起变异轮已删。）
 */
const rows = []
function add(name, ok, detail = '') {
  rows.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '：' + detail : ''}`)
}

/**
 * 造一个**合成档位**：内容 sha 由测试自己算，于是宿主状态机跑真代码，
 * 模型文件却是本地可控的那份。`bytes` 故意写 1（当年档位里的估计值就是这个坑的来源），
 * 这样「/models 报的 total 用的是真实大小」才是一条能证伪的判据。
 */
function makeTier(id, repo, name, body) {
  return {
    id,
    label: `测试档位 ${id}`,
    labelEn: `Test ${id}`,
    engine: 'whisper',
    repo,
    revision: 'main',
    bytes: 1,
    note: '',
    noteEn: '',
    languages: ['zh'],
    files: [{ name, bytes: 1, sha256: digest(body) }],
  }
}

/**
 * 起一套「假宿主 + 假 CDN」，跑一次场景。
 * @param {object} spec - { files, decide, tiers, transform }
 * @param {(ctx: object) => Promise<void>} body - 场景体。
 */
async function withHost({ files = {}, decide = null, tiers = [], transform = null }, body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-home-'))
  const cdn = await startFakeCdn({ files, decide })
  const env = await loadHostRoutes({
    dshHome: home,
    cdnOrigin: cdn.origin,
    appendAsrTiers: tiers,
    // 压小重试轮数：万一「404 立即失败」那一处退化，用例也得在有界时间内跑完。
    scaffoldRounds: true,
    transform,
  })
  try {
    await body({ env, cdn, home, dir: path.join(home, 'voice-typing', 'models') })
  } finally {
    env.restore()
    await cdn.close()
    // Windows 上删临时目录会被杀毒/索引器短暂拦住；清理失败不能算判据失败。
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
  }
}

/** 从 /models 响应里取某档位。 */
const entryOf = (res, id) => res.json().models.find((m) => m.id === id)

/** 按「这一片在文件的哪个位置」给不同时延：分片错峰完成，received 才会有多个台阶。
 * 返回的是 fake-cdn 的 `{ delayMs }` 应答策略（不是数字 —— 数字会被当成「没有策略」）。 */
function staggeredDelay(record) {
  if (!record.range) return { delayMs: 40 }
  if (record.range.start === 0 && record.range.end === 0) return { delayMs: 10 } // 探测请求
  const fraction = record.range.start / BIG
  return { delayMs: 250 + Math.round(fraction * 2500) }
}

// ---------------------------------------------------------------------------
// S1 空闲态：/models 的形状
// ---------------------------------------------------------------------------
async function scenarioIdle(transform) {
  const body = patternBuffer(BIG, 1)
  const tier = makeTier('t-state/idle', 'test/idle', 'model.onnx', body)
  await withHost({ tiers: [tier], transform }, async ({ env }) => {
    const res = await env.request('/dsh-voice-typing/models')
    add('S1 GET /models 返回 200 与档位清单', res.statusCode === 200 && Array.isArray(res.json().models), `status=${res.statusCode}`)
    const models = res.json().models
    const asr = models.filter((m) => m.category === 'asr')
    add('S1 识别档位不是空的（asr 也进了同一份清单）', asr.length > 0, `asr ${asr.length} 条`)
    // 当年只有 TTS 档位带 downloading，识别模型下载中时界面显示「下载模型」，用户完全看不出正在下。
    add('S1 每一条识别档位都带布尔 downloading 字段',
      asr.every((m) => typeof m.downloading === 'boolean'),
      asr.filter((m) => typeof m.downloading !== 'boolean').map((m) => m.id).join(' | '))
    add('S1 每一条合成档位也带布尔 downloading 字段',
      models.filter((m) => m.category === 'tts').every((m) => typeof m.downloading === 'boolean'))
    add('S1 空闲时没有档位报 downloading=true', asr.every((m) => m.downloading === false))
    add('S1 没有下载在进行时不挂 received/total',
      models.every((m) => m.received === undefined && m.total === undefined))
    add('S1 没下过的档位 ready=false', entryOf(res, tier.id)?.ready === false, JSON.stringify(entryOf(res, tier.id) ?? null))
    add('S1 响应带着当前选中的档位', typeof res.json().selected === 'string' && res.json().selected.length > 0, String(res.json().selected))
  })
}

// ---------------------------------------------------------------------------
// S2 下载中：/models 与 SSE 里的进度
// ---------------------------------------------------------------------------
async function scenarioInFlight(transform) {
  const body = patternBuffer(BIG, 2)
  const tier = makeTier('t-state/fly', 'test/fly', 'model.onnx', body)
  const key = 'test/fly/model.onnx'
  await withHost({
    files: { [key]: { buffer: body } },
    decide: staggeredDelay,
    tiers: [tier],
    transform,
  }, async ({ env, cdn }) => {
    const stream = env.openStream()
    try {
      const post = await env.request('/dsh-voice-typing/model', { method: 'POST', body: JSON.stringify({ id: tier.id }) })
      add('S2 下载请求回 202 且 started=true（不占着 HTTP 请求等下载完）',
        post.statusCode === 202 && post.json().started === true, `${post.statusCode} ${post.text}`)

      const seen = []
      let doubleClick = false
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const res = await env.request('/dsh-voice-typing/models')
        const entry = entryOf(res, tier.id)
        if (entry?.downloading) seen.push(entry)
        // 下载还没完就再点一次：必须复用进行中的那一份，不能起第二份下载。
        if (!doubleClick && entry?.downloading) {
          doubleClick = true
          const again = await env.request('/dsh-voice-typing/model', { method: 'POST', body: JSON.stringify({ id: tier.id }) })
          add('S2 下载中重复点击回 alreadyRunning（不起第二份下载）',
            again.statusCode === 202 && again.json().alreadyRunning === true, `${again.statusCode} ${again.text}`)
        }
        if (stream.events().some((e) => e.event === 'model-ready')) break
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
      const fly = stream.events().filter((e) => e.event === 'model-progress')
      // 带进度的那些次轮询（进度表已经在写）；第一次回调之前抢到的轮询本来就没有这两个字段，
      // 那不算缺陷 —— 所以判据只针对「写了字段的那些响应」。
      const timed = seen.filter((m) => m.received !== undefined || m.total !== undefined)

      add('S2 下载进行中 /models 报 downloading=true', seen.length > 0, `抓到 ${seen.length} 次`)
      add('S2 正在下的档位带数值 received / total',
        timed.length > 0 && timed.every((m) => Number.isInteger(m.received) && Number.isInteger(m.total)),
        JSON.stringify(timed[0] ?? seen[0] ?? null))
      // 档位里写的是 1 字节；宿主报的总量必须是服务端真实大小。
      add('S2 进度总量用的是服务端真实大小（不是档位里的估计值）',
        timed.length > 0 && timed.every((m) => m.total === BIG),
        timed.map((m) => m.total).join(' | '))
      const received = timed.map((m) => m.received)
      add('S2 轮询期间 received 单调不减', received.every((v, i) => i === 0 || v >= received[i - 1]), received.join(' → '))
      const percents = fly.map((e) => e.data.percent)
      // 「多档中间值」判 SSE 事件而不是轮询采样：事件是全量的，采样会漏（漏了不是缺陷）。
      add('S2 进度出现过多档中间值（不是一次跳到 100）',
        new Set(percents.filter((p) => p > 0 && p < 100)).size >= 3, percents.join(' → '))
      add('S2 SSE 的 model-progress 带着宿主算好的 percent',
        fly.length > 0 && percents.every((p) => Number.isInteger(p) && p >= 0 && p <= 100),
        percents.join(' → '))
      // 批次 6i-b（docs §8.42）：这条替掉 event-envelope 里那条
      // 「`broadcast('model-progress', {…kind…}` 写在宿主源码里」的正则 ——
      // 客户端进度行是按 kind 归类的，所以要看的是**收到的事件里有没有这个字段**。
      add('S2 model-progress 每一帧都带 kind（客户端不用自己猜这是哪一类模型）',
        fly.length > 0 && fly.every((e) => e.data.kind === 'asr'),
        JSON.stringify(fly.slice(0, 2).map((e) => e.data.kind)))
      add('S2 percent 单调不减且最后到 100',
        percents.every((p, i) => i === 0 || p >= percents[i - 1]) && percents[percents.length - 1] === 100,
        percents.join(' → '))
      add('S2 事件信封是统一的 {v,seq,ts,sessionId:null} + 平铺字段',
        fly.length > 0 && fly.every((e) => typeof e.data.v === 'number' && typeof e.data.seq === 'number'
          && typeof e.data.ts === 'number' && e.data.sessionId === null && e.data.id === tier.id))
      const chunkRequests = cdn.requests.filter((r) => r.key === key && r.range && !(r.range.start === 0 && r.range.end === 0)).length
      add('S2 重复点击没有把同一个文件再下一遍（分片请求数没有翻倍）',
        chunkRequests <= CHUNK_REQUESTS + 2, `分片请求 ${chunkRequests} 次`)
    } finally {
      stream.close()
    }
  })
}

// ---------------------------------------------------------------------------
// S3 下载完成：事件与状态必须同时到位
// ---------------------------------------------------------------------------
async function scenarioReady(transform) {
  const body = patternBuffer(BIG, 3)
  const tier = makeTier('t-state/ok', 'test/ok', 'model.onnx', body)
  const key = 'test/ok/model.onnx'
  await withHost({ files: { [key]: { buffer: body } }, tiers: [tier], transform }, async ({ env, dir }) => {
    const stream = env.openStream()
    // 「收到事件的那一刻」同步发起的刷新：模拟客户端收到 model-ready 立刻拉 /models。
    let snapshot = null
    const originalWrite = stream.res.write.bind(stream.res)
    stream.res.write = (chunk, ...rest) => {
      const r = originalWrite(chunk, ...rest)
      if (snapshot === null && String(chunk).includes('event: model-ready')) snapshot = env.request('/dsh-voice-typing/models')
      return r
    }
    try {
      await env.request('/dsh-voice-typing/model', { method: 'POST', body: JSON.stringify({ id: tier.id }) })
      const ok = await waitUntil(() => stream.events().some((e) => e.event === 'model-ready'), { timeoutMs: 15000 })
      add('S3 下载完成后 SSE 广播 model-ready', ok, '没收到事件')
      const at = snapshot === null ? await env.request('/dsh-voice-typing/models') : await snapshot
      add('S3 收到 model-ready 的当场刷新，不会再报 downloading=true',
        entryOf(at, tier.id)?.downloading === false, JSON.stringify(entryOf(at, tier.id) ?? null))
      const after = await env.request('/dsh-voice-typing/models')
      add('S3 事件之后 /models 显示 ready=true', entryOf(after, tier.id)?.ready === true, JSON.stringify(entryOf(after, tier.id) ?? null))
      add('S3 下载结束后进度字段从响应里消失（不会停在一个假百分比）',
        entryOf(after, tier.id)?.received === undefined && entryOf(after, tier.id)?.total === undefined,
        JSON.stringify(entryOf(after, tier.id) ?? null))
      const readyEvent = stream.events().find((e) => e.event === 'model-ready')
      add('S3 model-ready 带的是这条档位与 asr 类别',
        readyEvent?.data?.id === tier.id && readyEvent?.data?.kind === 'asr', JSON.stringify(readyEvent?.data ?? null))
      const dest = path.join(dir, 'test/ok', 'model.onnx')
      add('S3 路由这条链路真的把文件落到位（字节数对得上）',
        fs.existsSync(dest) && fs.statSync(dest).size === BIG, dest)
      const leftovers = fs.existsSync(path.dirname(dest))
        ? fs.readdirSync(path.dirname(dest)).filter((n) => /\.(part|chunk|merge)$/.test(n)) : []
      add('S3 完成后目录里不留 .part/.chunk/.merge 残留', leftovers.length === 0, leftovers.join(' | '))
    } finally {
      stream.res.write = originalWrite
      stream.close()
    }
  })
}

// ---------------------------------------------------------------------------
// S4 下载失败：状态与错误原因都得如实回给界面
// ---------------------------------------------------------------------------
async function scenarioError(transform) {
  const tier = makeTier('t-state/404', 'test/404', 'missing.onnx', patternBuffer(1000, 4))
  await withHost({ files: {}, tiers: [tier], transform }, async ({ env, dir }) => {
    const stream = env.openStream()
    let snapshot = null
    const originalWrite = stream.res.write.bind(stream.res)
    stream.res.write = (chunk, ...rest) => {
      const r = originalWrite(chunk, ...rest)
      if (snapshot === null && String(chunk).includes('event: model-error')) snapshot = env.request('/dsh-voice-typing/models')
      return r
    }
    try {
      const t0 = Date.now()
      await env.request('/dsh-voice-typing/model', { method: 'POST', body: JSON.stringify({ id: tier.id }) })
      const ok = await waitUntil(() => stream.events().some((e) => e.event === 'model-error'), { timeoutMs: 10000 })
      const ms = Date.now() - t0
      add('S4 文件不存在时 SSE 广播 model-error', ok, '没收到事件')
      // 「404 被当成网络错误重试 40 轮」会让界面卡在下载中好几分钟：时间就是判据。
      add('S4 失败是在几秒内报出来的（不是白跑满重试轮数）', ms < 6000, `${ms}ms`)
      const at = snapshot === null ? await env.request('/dsh-voice-typing/models') : await snapshot
      add('S4 收到 model-error 的当场刷新不再报 downloading',
        entryOf(at, tier.id)?.downloading === false, JSON.stringify(entryOf(at, tier.id) ?? null))
      const errEvent = stream.events().find((e) => e.event === 'model-error')
      add('S4 错误文案说清了原因（仓库里没这个文件），不是一句「下载失败」',
        /仓库里没有这个文件/.test(String(errEvent?.data?.error ?? '')), String(errEvent?.data?.error ?? ''))
      // 批次 22-4-1（docs §8.70）：事件里除了给诊断看的原文，还必须带**原因码 + 参数**，
      // 界面那句话由客户端字典出。以前这条链路上面板只拿得到一句 `下载失败`。
      add('S4 model-error 带的 reason 是词表里的 file-not-in-repo',
        errEvent?.data?.reason === MODEL_DOWNLOAD_REASONS.FILE_NOT_IN_REPO,
        String(errEvent?.data?.reason))
      add('S4 model-error 的参数带得上（文件名 + HTTP 状态），界面那句才填得满',
        errEvent?.data?.params?.file === 'missing.onnx' && errEvent?.data?.params?.status === 404,
        JSON.stringify(errEvent?.data?.params ?? null))
      // 批次 6i-b（docs §8.42）：失败事件也得带 id 与 kind —— 面板要能把进度行
      // 收回正确的那一格（缺 kind 时那一格会一直挂着「下载中」）。
      add('S4 model-error 带的是这条档位与 asr 类别',
        errEvent?.data?.id === tier.id && errEvent?.data?.kind === 'asr',
        JSON.stringify(errEvent?.data ?? null))
      const after = await env.request('/dsh-voice-typing/models')
      add('S4 失败后 ready 仍是 false', entryOf(after, tier.id)?.ready === false)
      const dirOfDest = path.join(dir, 'test/404')
      const leftovers = fs.existsSync(dirOfDest) ? fs.readdirSync(dirOfDest) : []
      add('S4 失败后目录里没有半截文件', leftovers.length === 0, leftovers.join(' | '))
    } finally {
      stream.res.write = originalWrite
      stream.close()
    }
  })
}

// ---------------------------------------------------------------------------
// S5 路由的其它契约：未知档位 / 已就绪 / 方法不对 / 没有可下载文件的档位
// ---------------------------------------------------------------------------
async function scenarioContract(transform) {
  const body = patternBuffer(4000, 5)
  const tier = makeTier('t-state/ready', 'test/ready', 'model.onnx', body)
  const noFiles = { ...makeTier('t-state/nofile', 'test/nofile', 'x.onnx', body), files: [] }
  await withHost({ files: { 'test/ready/model.onnx': { buffer: body } }, tiers: [tier, noFiles], transform }, async ({ env, cdn }) => {
    const stream2 = env.openStream()
    try {
      const unknown = await env.request('/dsh-voice-typing/model', { method: 'POST', body: JSON.stringify({ id: 'no/such/tier' }) })
    add('S5 不存在的档位报 404 并把 id 说清楚',
      unknown.statusCode === 404 && String(unknown.json().error).includes('no/such/tier'), `${unknown.statusCode} ${unknown.text}`)
    add('S5 不存在的档位回的是原因码 + 参数（面板那句由字典出，不再原样显示宿主的话）',
      unknown.json()?.reason === MODEL_DOWNLOAD_REASONS.UNKNOWN_MODEL
        && unknown.json()?.params?.model === 'no/such/tier', JSON.stringify(unknown.json()))

    const wrongMethod = await env.request('/dsh-voice-typing/model', { method: 'GET' })
    add('S5 下载路由不接受 GET（405）', wrongMethod.statusCode === 405, String(wrongMethod.statusCode))

    const noDownload = await env.request('/dsh-voice-typing/model', { method: 'POST', body: JSON.stringify({ id: noFiles.id }) })
    // 这条路由**本来就是立即 202**（下载在后台跑），所以「不假装成功」的证据是后台的失败事件，
    // 不是这个响应的状态码。
    add('S5 没有可下载文件的档位先回 202（下载在后台，不占请求）',
      noDownload.statusCode === 202 && noDownload.json().started === true, `${noDownload.statusCode} ${noDownload.text}`)
    const failed = await waitUntil(() => stream2.events()
      .some((e) => e.event === 'model-error' && e.data?.id === noFiles.id), { timeoutMs: 8000 })
    const errText = String(stream2.events().find((e) => e.event === 'model-error' && e.data?.id === noFiles.id)?.data?.error ?? '')
    add('S5 没有可下载文件的档位会以 model-error 收场，并说清原因',
      failed && /没有可下载的文件/.test(errText), errText)
    add('S5 那条 model-error 带的 reason 是 no-downloadable-files，参数是档位 id',
      stream2.events().some((e) => e.event === 'model-error' && e.data?.id === noFiles.id
        && e.data?.reason === MODEL_DOWNLOAD_REASONS.NO_DOWNLOADABLE_FILES
        && e.data?.params?.model === noFiles.id), errText)

    const first = await env.request('/dsh-voice-typing/model', { method: 'POST', body: JSON.stringify({ id: tier.id }) })
    const ready = await waitUntil(async () => (entryOf(await env.request('/dsh-voice-typing/models'), tier.id))?.ready === true, { timeoutMs: 15000 })
    add('S5 小档位能经路由下完并转为就绪', first.statusCode === 202 && ready, String(first.statusCode))
    const requestsBefore = cdn.requests.length
    const again = await env.request('/dsh-voice-typing/model', { method: 'POST', body: JSON.stringify({ id: tier.id }) })
    add('S5 已就绪的档位再点一次是 alreadyReady（不重下）',
      again.statusCode === 200 && again.json().alreadyReady === true, `${again.statusCode} ${again.text}`)
    add('S5 alreadyReady 这条路径一个请求都没多发', cdn.requests.length === requestsBefore,
      `${requestsBefore} → ${cdn.requests.length}`)
    } finally {
      stream2.close()
    }
  })
}

const SCENARIOS = [
  ['S1 空闲态 /models', scenarioIdle],
  ['S2 下载中的进度', scenarioInFlight],
  ['S3 完成时的状态与事件', scenarioReady],
  ['S4 失败时的状态与原因', scenarioError],
  ['S5 路由契约', scenarioContract],
]

async function evaluate(transform = null) {
  rows.length = 0
  for (const [label, fn] of SCENARIOS) {
    console.log(`\n${label}`)
    try {
      await fn(transform)
    } catch (error) {
      add(`${label}：场景跑通`, false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '))
    }
  }
  return rows.slice()
}


const scenarioRows = await evaluate(null)
// 最终那一行只认场景跑出来的结论。
const passed = scenarioRows.filter((r) => r.ok).length
const failed = scenarioRows.length - passed
console.log(`\n通过 ${passed}，失败 ${failed}（场景判据 ${scenarioRows.length} 条）`)
// 宿主插件里有未 unref 的定时器（SSE keepalive、空闲扫描），
// 场景都调了 restore()/close() 收掉；兜底用 exit，别让这个文件把整条测试串拖住。
if (failed) process.exitCode = 1
process.exit(process.exitCode ?? 0)
