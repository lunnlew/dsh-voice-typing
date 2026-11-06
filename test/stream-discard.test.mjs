/**
 * 流式会话被丢掉时必须有**原因**可查（批次 16，docs/architecture-modernization.md §8.58）。
 *
 * 判的是什么：浮层里实时文字整段消失是用户看得见的事，代码这边一共有五个入口会丢掉
 * 一个会话的流式状态（识别器被释放、下一次取流时发现句柄换了、空闲超时、解码侧抛错、
 * 客户端主动结束这一轮）。这五处以前全是静默的 —— 装机上问一句「刚那块超限分片有没有
 * 把我的会话抹掉」，`/diagnostics` 答不出来，只能靠读代码相信「批次 12 已经修了」。
 * 现在 `discardStreamingState` 必须报原因，`/diagnostics.streamDiscard` 给出
 * `{count, window, events}`，于是「丢了几次、为什么丢、隔了多少毫秒没音频」是读出来的。
 *
 * 判据一律是**真跑**：真宿主路由 + 真流式解码链路（主线程），只把第三方 sherpa 换成替身，
 * 档位是测试自己算 sha 的合成档（与内置流式档**同 id** 追加，`findModel` 取第一个匹配）。
 * 五个原因各有一个场景把它驱动出来；场景之间靠 sessionId 与新装载的宿主实例分开。
 *
 * 五个入口分别怎么打开：
 *   - `client-reset` —— 直接 POST `/asr-stream/reset`，最干净的一条。
 *   - `decode-error` —— 替身的 `acceptWaveform` 从第 N 帧起抛（`throwAtWaveform`）。
 *   - `recognizer-freed` —— `env.disposePlugin()`（插件停用/重载那一大段清理，批次 7 收的接缝）。
 *   - `recognizer-changed` —— 见 `scenarioRecognizerChanged`：那是一条**跨微任务的竞态**，
 *     生产里要「识别器刚取到手、会话状态还没写进 Map」这一瞬间正好有人释放它。
 *     等运气不是判据，所以替身在 `createStream()` 里给测试留了一个进程内钩子，
 *     由钩子当场把识别器释放掉，窗口就被确定地打开一次。
 *   - `idle-timeout` —— 装载期间接管 `setInterval` 把清扫回调收下来，再把 `Date.now`
 *     挪过空闲上限，由测试自己决定「现在扫一次」。写法与 `test/turn-boundary.test.mjs` 同。
 *
 * 两处诚实边界，写在这里而不是藏在注释末尾：
 *   1. 丢弃日志住在**模块级**（与被记录的 `streamingStates` 同生命周期），不是每宿主实例一份。
 *      本文件每个场景各装一份宿主（各自的临时树 = 各自的模块实例），所以场景内可以数绝对值；
 *      判据仍优先按 sessionId 过滤，这样同一个进程里多实例共用一条日志时也不会串味。
 *   2. `idle-timeout` 那一步把时钟挪 61 秒：过的是流式会话的 60 秒上限，
 *      刻意**不到** 10 分钟的模型空闲释放 —— 两条清扫挤在同一轮里会让 `recognizer-freed`
 *      抢先丢掉了状态，那条判据就测不到它自己要测的东西了。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadHostRoutes, callRoute } from './helpers/host-routes.mjs'
import { fakeSherpa, FAKE_SHERPA_CREATE_STREAM_HOOK } from './helpers/fake-sherpa.mjs'
import { makeReadyTier, placeTierFiles, frameOfLevel } from './helpers/fake-tier.mjs'
import { STREAM_DISCARD_REASONS } from '../src/host/stream-discard-log.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 每个场景实际观察到的原因，最后与词表对一次（见末尾那条完整性判据）。 */
const observedReasons = new Set()

/** 超过读体上限（16 MB）的一块数据：够整就够，内容无所谓（它在读体阶段就被拒）。 */
const OVERSIZE_BODY = () => Buffer.alloc(17 * 1024 * 1024, 7)

/**
 * 一个场景的公共底座：合成流式档 + 假 sherpa + 真宿主路由。
 *
 * @param {object} options - {
 *   label: 目录/仓库名后缀（每个场景一份，互不复用临时树），
 *   fakeOptions: 透传给 `fakeSherpa`（如 `{ throwAtWaveform: 2 }`），
 *   captureIntervals: 装载期间接管 `setInterval`，把清扫回调收进 `sweepers`。
 * }
 * @returns {Promise<object>} {
 *   tier, home, fake, env, discard, feed, reset, streamUrl,
 *   streamIds: ()=>在线流对象的建立次序, freedStreams: ()=>被 free 的编号,
 *   sweepers, tickSweepers, close
 * }
 */
async function setup({ label, fakeOptions = {}, captureIntervals = false }) {
  const tier = makeReadyTier('zipformer2-zh', { engine: 'online', repo: `fake-repo/discard-${label}` })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-discard-${label}-`))
  placeTierFiles(home, tier.tier, tier.bodies)
  const fake = fakeSherpa({ marker: '假识别', ...fakeOptions })
  fake.install()

  const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  const sweepers = new Map()
  if (captureIntervals) {
    globalThis.setInterval = (fn, ms, ...rest) => {
      const id = real.setInterval(fn, ms, ...rest)
      if (typeof fn === 'function') sweepers.set(id, fn)
      return id
    }
    globalThis.clearInterval = (id) => {
      sweepers.delete(id)
      return real.clearInterval(id)
    }
  }
  const env = await loadHostRoutes({
    dshHome: home,
    appendAsrTiers: [tier.tier],
    extraTreeFiles: fake.files,
  })
  if (captureIntervals) {
    globalThis.setInterval = real.setInterval
    globalThis.clearInterval = real.clearInterval
  }

  // 只数**在线识别器**建出来的流：离线那条路（/transcribe 的主线程兜底）也调 createStream。
  const of = (event) => fake.events()
    .filter((row) => row.event === event && row.extra?.owner === 'OnlineRecognizer')
    .map((row) => row.extra)

  const close = () => {
    fake.uninstall()
    try { env.restore() } catch { /* 清理失败不算判据失败 */ }
    for (const dir of [home, fake.dir]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
    }
  }

  return {
    tier,
    home,
    fake,
    env,
    sweepers,
    streamUrl: (sid) => `/dsh-voice-typing/asr-stream?sessionId=${sid}`,
    /** 喂一帧正常音频（真路由、真门限、真解码链路）。 */
    feed: (sid, body = frameOfLevel(0.05)) => callRoute(env, `/dsh-voice-typing/asr-stream?sessionId=${sid}`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/octet-stream' },
    }, 8000),
    reset: (sid) => callRoute(env, `/dsh-voice-typing/asr-stream/reset?sessionId=${sid}`, { method: 'POST' }, 8000),
    /** /diagnostics 里那一块丢弃记录。 */
    discard: async () => (await callRoute(env, '/dsh-voice-typing/diagnostics')).json()?.streamDiscard ?? null,
    /** 只看属于某个会话的事件。 */
    eventsOf: async (sid) => ((await callRoute(env, '/dsh-voice-typing/diagnostics')).json()?.streamDiscard?.events ?? [])
      .filter((row) => row.sessionId === sid),
    /** 在线流的建立次序 / 被 free 的编号（「会话还在不在」就靠这两串数）。 */
    streamIds: () => of('streamCtor').map((row) => row.id),
    freedStreams: () => of('streamFree').map((row) => row.id),
    feedCount: () => of('acceptWaveform').length,
    recognizerFrees: () => fake.events().filter((row) => row.event === 'free'),
    tickSweepers: () => { for (const fn of [...sweepers.values()]) fn() },
    close,
  }
}

/** 把一组事件里的 reason 收进总表，供末尾那条词表完整性判据用。 */
function noteReasons(events) {
  for (const row of events) observedReasons.add(String(row?.reason ?? ''))
  return events
}

/**
 * 场景 1：客户端主动结束这一轮 —— 词表里最干净的一条，顺带把回执形状钉住。
 */
async function scenarioClientReset() {
  const s = await setup({ label: 'reset' })
  const sid = 'discard-reset-1'
  try {
    const before = await s.discard()
    check('[前置] /diagnostics 有 streamDiscard 这一块，形状是 {count, window, events}',
      Boolean(before) && Number.isFinite(before.count) && Number.isFinite(before.window) && Array.isArray(before.events),
      JSON.stringify(before))
    check('[前置] 这份宿主实例刚装上，丢弃数是 0（下面每条都从这条基线数起）',
      before.count === 0, JSON.stringify(before.count))

    const first = await s.feed(sid)
    check('[前置] 第一帧回 200 且在说话（会话状态建立了，「被丢掉」才有主语）',
      first.statusCode === 200 && first.json()?.speech === true,
      JSON.stringify({ status: first.statusCode, body: first.json?.() ?? null }))
    const afterFeed = await s.discard()
    check('[喂帧] 正常喂一帧不记丢弃（还在说话不是被丢掉）',
      afterFeed.count === 0, JSON.stringify(afterFeed.count))

    const reset = await s.reset(sid)
    const rows = noteReasons(await s.eventsOf(sid))
    check('[收尾] 结束这一轮记了 1 条，且只此一条',
      reset.statusCode === 200 && reset.json()?.discarded === true && rows.length === 1,
      JSON.stringify({ status: reset.statusCode, body: reset.json?.() ?? null, rows }))
    check('[收尾] 那条写的是 client-reset + 会话 id + 流式档位',
      rows[0]?.reason === STREAM_DISCARD_REASONS.CLIENT_RESET
        && rows[0]?.sessionId === sid
        && rows[0]?.modelId === s.tier.tier.id,
      JSON.stringify(rows[0]))
    check('[收尾] idleMs 是「距上一次喂音频过了多久」（有限且非负）',
      Number.isFinite(rows[0]?.idleMs) && rows[0].idleMs >= 0,
      JSON.stringify(rows[0]?.idleMs))

    // 反证：这条日志记的是「真的丢了东西」，不是「调用过那个入口」。
    const again = await s.reset(sid)
    const afterSecond = await s.discard()
    check('[反证] 会话已经没了再收尾一次：回执照旧，但不许再多记一条',
      again.statusCode === 200 && again.json()?.discarded === true && afterSecond.count === 1,
      JSON.stringify({ status: again.statusCode, body: again.json?.() ?? null, count: afterSecond.count }))
  } finally {
    s.close()
  }
}

/**
 * 场景 2：解码这一侧真出事 —— 丢弃是**应该**发生的（残留会串到下一轮）。
 */
async function scenarioDecodeError() {
  const s = await setup({ label: 'decode', fakeOptions: { throwAtWaveform: 2 } })
  const sid = 'discard-decode-1'
  try {
    const first = await s.feed(sid)
    const baseline = await s.discard()
    check('[前置] 第一帧正常、丢弃为 0（替身要到第 2 帧才抛）',
      first.statusCode === 200 && first.json()?.speech === true && baseline.count === 0,
      JSON.stringify({ status: first.statusCode, body: first.json?.() ?? null, count: baseline.count }))
    const staleStream = s.streamIds().at(-1)

    const boom = await s.feed(sid)
    const rows = noteReasons(await s.eventsOf(sid))
    check('[解码故障] 第二帧抛错回 500（不是挂死、不是 200 假装成功）',
      boom.statusCode === 500 && /假 acceptWaveform|报错/.test(String(boom.json?.()?.error ?? '')),
      JSON.stringify({ status: boom.statusCode, body: boom.json?.() ?? null }))
    check('[解码故障] 记了一条 decode-error，就是刚那个会话',
      rows.length === 1 && rows[0].reason === STREAM_DISCARD_REASONS.DECODE_ERROR,
      JSON.stringify(rows))
    check('[解码故障] 记录与动作一致：坏掉那个流当场被 free（不然下一轮带着残留）',
      s.freedStreams().includes(staleStream),
      JSON.stringify({ staleStream, freed: s.freedStreams() }))

    const next = await s.feed(sid)
    const afterRebuild = await s.discard()
    check('[解码故障后] 下一帧在新建的流上继续（回 200，流编号换了）',
      next.statusCode === 200 && next.json()?.speech === true && s.streamIds().at(-1) !== staleStream,
      JSON.stringify({ status: next.statusCode, ids: s.streamIds() }))
    check('[解码故障后] 重建这一步不记丢弃（丢弃数仍是 1；它不是「把会话抹了」）',
      afterRebuild.count === 1, JSON.stringify(afterRebuild.count))
  } finally {
    s.close()
  }
}

/**
 * 场景 3：识别器正在被释放（插件停用/重载）—— 引用它的会话必须先丢。
 *
 * 生产里触发点是「重下模型 / 换语言 / 切档位 / 停用」这几条，它们都汇到
 * `freeRecognizer`；接缝 `env.disposePlugin()` 跑的就是停用那一大段清理（批次 7 收的）。
 */
async function scenarioRecognizerFreed() {
  const s = await setup({ label: 'freed' })
  const sid = 'discard-freed-1'
  try {
    const first = await s.feed(sid)
    const before = await s.discard()
    check('[前置] 会话建起来了、丢弃为 0',
      first.statusCode === 200 && first.json()?.speech === true && before.count === 0,
      JSON.stringify({ status: first.statusCode, count: before.count }))
    const streamId = s.streamIds().at(-1)

    let ranCleanups = 0
    let disposeError = null
    try {
      ranCleanups = s.env.disposePlugin()
    } catch (error) {
      disposeError = String(error?.message ?? error)
    }
    const rows = noteReasons(await s.eventsOf(sid))
    check('[停用] 清理跑通（≥1 个），且丢弃记录就在它里面诞生',
      disposeError === null && ranCleanups >= 1 && rows.length === 1,
      disposeError ?? JSON.stringify({ ranCleanups, rows }))
    check('[停用] 那条写的是 recognizer-freed + 档位 id',
      rows[0]?.reason === STREAM_DISCARD_REASONS.RECOGNIZER_FREED
        && rows[0]?.modelId === s.tier.tier.id,
      JSON.stringify(rows[0]))
    check('[停用] 「丢掉会话」与「释放句柄」是同一条路的两半：识别器确实 free 了',
      s.recognizerFrees().length >= 1,
      JSON.stringify(s.recognizerFrees().map((row) => row.extra)))
    check('[停用] 会话那个流也一起被 free（留着就是引用已释放的识别器）',
      s.freedStreams().includes(streamId),
      JSON.stringify({ streamId, freed: s.freedStreams() }))

    const after = await s.feed(sid)
    const finalCount = await s.discard()
    check('[停用后] 再来一帧回 200 且用的是新建的流（停用→再用 这条环跑得通）',
      after.statusCode === 200 && after.json()?.speech === true && s.streamIds().at(-1) !== streamId,
      JSON.stringify({ status: after.statusCode, ids: s.streamIds() }))
    check('[停用后] 重建不额外记丢弃（总数仍是 1）',
      finalCount.count === 1, JSON.stringify(finalCount.count))
  } finally {
    s.close()
  }
}

/**
 * 场景 4：下一次取流时发现句柄已经不是当前那个 —— `recognizer-changed`。
 *
 * 这一条为什么要靠替身钩子：宿主取流的写法是
 *   `const recognizer = await getRecognizer(...)` → 同步 `recognizer.createStream()` → `streamingStates.set(...)`
 * 中间那个窗口，生产里只有「另一个请求正好在这时释放识别器」才撞得进去。
 * `freeRecognizer` 会先把引用它的会话丢掉，所以正常顺序下永远轮不到这条原因 ——
 * 它防的正是那个顺序颠倒的竞态：会话状态里留着一个**已经被释放**的识别器。
 * 于是钩子在 `createStream()` 里跑一次 `disposePlugin()`：识别器当场没了、Map 里还什么都没有，
 * 宿主随后把「拿着坏句柄的会话状态」写了进去。判据看的是下一帧：它必须被丢弃并重建，
 * 而不是继续在坏句柄上喂音频。
 */
async function scenarioRecognizerChanged() {
  const s = await setup({ label: 'changed' })
  const sid = 'discard-changed-1'
  try {
    // 打开窗口：这一帧取流的一瞬间把识别器释放掉。
    // 故意用**第一条**帧来做 —— 此时 Map 里还没有任何会话状态，
    // 那次释放记不到 `recognizer-freed`（什么都没丢），于是后面那条 changed 是唯一的一条。
    let hookRan = 0
    globalThis[FAKE_SHERPA_CREATE_STREAM_HOOK] = () => { hookRan += 1; s.env.disposePlugin() }
    let raced = null
    try {
      raced = await s.feed(sid)
    } finally {
      delete globalThis[FAKE_SHERPA_CREATE_STREAM_HOOK]
    }
    const staleStream = s.streamIds().at(-1)
    const afterRace = await s.discard()
    check('[竞态] 钩子确实被调到一次、会话状态建起来了（没演成就全是空转）',
      hookRan === 1 && raced.statusCode === 200 && raced.json()?.speech === true
        && s.streamIds().length === 1,
      JSON.stringify({ hookRan, status: raced.statusCode, ids: s.streamIds() }))
    check('[竞态] 识别器当场被释放了（不释放就没有「坏句柄」可守，下面那条 changed 会是白判）',
      s.recognizerFrees().length >= 1,
      JSON.stringify(s.recognizerFrees().map((row) => row.extra)))
    check('[竞态] 这一帧本身回 200 且**没记**丢弃：宿主此刻还不知道句柄已经坏了',
      afterRace.count === 0 && s.streamIds().length === 1,
      JSON.stringify(afterRace.count))

    // 关键：下一帧取流时必须认出「句柄已经不是当前那个」，把它丢掉重来。
    const next = await s.feed(sid)
    const rows = noteReasons(await s.eventsOf(sid))
    check('[竞态后] 下一帧认出坏句柄并记了一条 recognizer-changed',
      rows.length === 1 && rows[0].reason === STREAM_DISCARD_REASONS.RECOGNIZER_CHANGED
        && rows[0].modelId === s.tier.tier.id,
      JSON.stringify(rows))
    check('[竞态后] 回的是 200 且在说话（丢弃之后当场重建，用户这一轮没断）',
      next.statusCode === 200 && next.json()?.speech === true,
      JSON.stringify({ status: next.statusCode, body: next.json?.() ?? null }))
    check('[竞态后] 拿到的确实是新建的流，坏的那个被 free 掉了',
      s.streamIds().at(-1) !== staleStream && s.freedStreams().includes(staleStream),
      JSON.stringify({ staleStream, ids: s.streamIds(), freed: s.freedStreams() }))

    // 反证：这个守卫不能每帧都误判，否则「会话还在」这条就永远不成立了。
    const steady = await s.feed(sid)
    const afterSteady = await s.discard()
    check('[反证] 稳定之后继续喂帧不再记丢弃（守卫不是每帧误判，总数仍是 1）',
      steady.statusCode === 200 && afterSteady.count === 1,
      JSON.stringify({ status: steady.statusCode, count: afterSteady.count }))
  } finally {
    s.close()
  }
}

/**
 * 场景 5：空闲清扫 —— 客户端没发 reset（页面关了、识别失败了）时的兜底。
 */
async function scenarioIdleTimeout() {
  const s = await setup({ label: 'idle', captureIntervals: true })
  const sid = 'discard-idle-1'
  const realNow = Date.now
  try {
    check('[前置] 装载期间确实收到了清扫定时器（没有它，下面「扫一次」是空转）',
      s.sweepers.size >= 1, JSON.stringify(s.sweepers.size))
    const first = await s.feed(sid)
    check('[前置] 会话建立、丢弃为 0',
      first.statusCode === 200 && first.json()?.speech === true && (await s.discard()).count === 0,
      JSON.stringify({ status: first.statusCode }))
    const streamId = s.streamIds().at(-1)

    // 反证：时间没挪，扫一遍不该有任何东西被当成空闲丢掉。
    s.tickSweepers()
    const beforeShift = await s.discard()
    check('[反证] 时钟不动时扫一次不记丢弃（挪时间这条判据不是白写的）',
      beforeShift.count === 0, JSON.stringify(beforeShift.count))

    // 挪过流式会话的 60 秒上限（仍不到 10 分钟的模型空闲释放，见文件头第 2 条边界）。
    globalThis.Date.now = () => realNow() + 61_000
    try {
      s.tickSweepers()
    } finally {
      globalThis.Date.now = realNow
    }
    const rows = noteReasons(await s.eventsOf(sid))
    check('[空闲] 扫一次记了 idle-timeout，就是刚那个会话',
      rows.length === 1 && rows[0].reason === STREAM_DISCARD_REASONS.IDLE_TIMEOUT,
      JSON.stringify(rows))
    check('[空闲] idleMs 如实报「隔了多久没音频」（挪了 61 秒就得 ≥60 秒）',
      Number.isFinite(rows[0]?.idleMs) && rows[0].idleMs >= 60_000,
      JSON.stringify(rows[0]?.idleMs))
    check('[空闲] 那个流被 free 掉了（残留的流对象会把上一轮的尾巴串到下一轮）',
      s.freedStreams().includes(streamId),
      JSON.stringify({ streamId, freed: s.freedStreams() }))

    const after = await s.feed(sid)
    const finalRows = await s.eventsOf(sid)
    check('[空闲后] 下一帧在新建的流上正常出字，且不再多记丢弃',
      after.statusCode === 200 && after.json()?.speech === true && s.streamIds().at(-1) !== streamId
        && finalRows.length === 1,
      JSON.stringify({ status: after.statusCode, ids: s.streamIds(), rows: finalRows }))
  } finally {
    globalThis.Date.now = realNow
    s.close()
  }
}

/**
 * 场景 6：请求级拒绝**不许**记丢弃（批次 12 那条语义现在看得见、也读得出了）。
 */
async function scenarioOversizeNotLogged() {
  const s = await setup({ label: 'oversize' })
  const sid = 'discard-oversize-1'
  try {
    const first = await s.feed(sid)
    const streamId = s.streamIds().at(-1)
    check('[前置] 会话建立、丢弃为 0',
      first.statusCode === 200 && first.json()?.speech === true && (await s.discard()).count === 0,
      JSON.stringify({ status: first.statusCode }))

    const over = await s.feed(sid, OVERSIZE_BODY())
    const afterOver = await s.discard()
    check('[超限] 17MB 分片回 413（批次 8 的回执语义没被带坏）',
      over.statusCode === 413, JSON.stringify({ status: over.statusCode, body: over.json?.() ?? null }))
    check('[超限] 超限**没有**被记成丢弃：一块数据太大不是会话坏了',
      afterOver.count === 0 && afterOver.events.length === 0,
      JSON.stringify(afterOver))
    check('[超限] 会话也真的还在（下一帧喂的还是同一个流）',
      s.freedStreams().length === 0 && (await s.feed(sid)).statusCode === 200
        && s.streamIds().at(-1) === streamId,
      JSON.stringify({ streamId, ids: s.streamIds(), freed: s.freedStreams() }))

    // 反证：上面那条「没记」不是因为这块日志根本没接上。
    await s.reset(sid)
    const afterReset = await s.discard()
    check('[反证] 同一个实例随后记到了 client-reset（读数通路是活的）',
      afterReset.count === 1 && afterReset.events[0]?.reason === STREAM_DISCARD_REASONS.CLIENT_RESET,
      JSON.stringify(afterReset))
  } finally {
    s.close()
  }
}

/**
 * 场景 7：窗口只裁事件、不裁总数。
 *
 * 「这一轮被抹了几次」的分母必须是不封顶的 `count`；`events` 只留最近 `window` 条，
 * 留的是**最新**那些 —— 排障看的永远是刚刚发生的事。
 * 窗口大小从 `/diagnostics` 自己读（`window`），不在测试里抄那个数字。
 */
async function scenarioWindowOverflow() {
  const s = await setup({ label: 'window' })
  try {
    const window = (await s.discard()).window
    check('[前置] 读到了窗口大小（判溢出按同一个数写，不抄常量）',
      Number.isFinite(window) && window >= 5, JSON.stringify(window))
    const ids = Array.from({ length: window + 5 }, (_unused, i) => `discard-window-${i}`)
    for (const sid of ids) {
      await s.feed(sid)
      await s.reset(sid)
    }
    const final = await s.discard()
    noteReasons(final.events)
    check('[溢出] 丢弃总数不封顶（count = 窗口 + 5，不是窗口）',
      final.count === window + 5, JSON.stringify({ count: final.count, window }))
    check('[溢出] 事件只留窗口那么多',
      final.events.length === window, JSON.stringify({ length: final.events.length, window }))
    check('[溢出] 留下的是**最新**那些（最早的 5 条被挤掉）',
      final.events[0]?.sessionId === ids[5] && final.events.at(-1)?.sessionId === ids.at(-1),
      JSON.stringify({ first: final.events[0]?.sessionId, last: final.events.at(-1)?.sessionId }))
  } finally {
    s.close()
  }
}

const SCENARIOS = [
  ['客户端主动结束（client-reset）', scenarioClientReset],
  ['解码侧真出事（decode-error）', scenarioDecodeError],
  ['识别器被释放（recognizer-freed）', scenarioRecognizerFreed],
  ['取流时句柄已换（recognizer-changed，演竞态窗口）', scenarioRecognizerChanged],
  ['空闲清扫（idle-timeout）', scenarioIdleTimeout],
  ['请求级拒绝不许记丢弃（批次 12 的可见化）', scenarioOversizeNotLogged],
  ['事件窗口与不封顶总数', scenarioWindowOverflow],
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

// 词表完整性：`STREAM_DISCARD_REASONS` 里每一个原因都得有一个场景把它真跑出来。
// 新增第六个丢弃入口而没写场景时，红的就是这一条 —— 而不是装机上多一条没人知道的丢弃。
{
  const vocabulary = Object.values(STREAM_DISCARD_REASONS)
  const undriven = vocabulary.filter((reason) => !observedReasons.has(reason))
  const unknown = [...observedReasons].filter((reason) => !vocabulary.includes(reason))
  check('词表完整性：五个原因逐个被驱动到、且没有出现词表外的 reason',
    undriven.length === 0 && unknown.length === 0,
    JSON.stringify({ 没驱动到: undriven, 词表外: unknown, 词表: vocabulary }))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
