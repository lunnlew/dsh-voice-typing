/**
 * 请求级拒绝不许抹掉流式会话（批次 12，docs/architecture-modernization.md §8.53）。
 *
 * 缺陷（§8.48 装机回归记下、当时只记录不修的最后一条）：
 * `/asr-stream` 的 catch 里是**无条件** `discardStreamingState(sessionId)` ——
 * 它想挡的是「解码这一侧出事了，下一轮从零开始（别留残留）」，
 * 可同一句也接住了「这块数据太大、我们主动拒了」（`readBody` 的 413）。
 * 于一块过大的分片会抹掉正在跑的会话：在线流对象被 free、状态条目被删，
 * 用户看到的是**实时文字整段消失**，下一帧还得从零重建一个流。
 *
 * 修法只有一句：带 4xx 状态码的请求级拒绝不动会话状态，其余照旧丢弃。
 * 所以判据也必须两头都钉住 ——
 *   ① 超限之后会话**还在**（下一帧喂进的还是同一个流对象）；
 *   ② 解码真出事时会话**必须**被丢弃（不然这个修复会把另一条语义一起关掉）。
 * ②那半必须用真故障演：替身的 `acceptWaveform` 在第 N 帧起抛（`throwAtWaveform`）。
 *
 * 「会话还在不在」怎么数出来：`test/helpers/fake-sherpa.mjs` 给每个流对象编号，
 * `streamCtor` / `streamFree` / `acceptWaveform{id}` 三类事件都带号。
 * 于是「下一帧用的是新流」与「还是那个流」是两串不同的事件，不是靠回包里有没有文本猜的。
 *
 * 跑法与 `test/gate-host.test.mjs` / `test/oversize-body.test.mjs` 同一套路：
 * 真宿主路由 + 真流式解码链路（主线程），只把第三方 sherpa 换成替身，
 * 档位是测试自己算 sha 的合成档（与内置流式档**同 id** 追加，`findModel` 取第一个匹配）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadHostRoutes, callRoute } from './helpers/host-routes.mjs'
import { fakeSherpa } from './helpers/fake-sherpa.mjs'
import { makeReadyTier, placeTierFiles, frameOfLevel } from './helpers/fake-tier.mjs'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 读回执正文；「一个字都没写」也是要判的状态之一，不能让它把场景带崩。 */
function safeJson(resLike) {
  try { return resLike?.json?.() ?? null } catch { return null }
}

/** 超过读体上限（16 MB）的一块数据：够整就够，内容无所谓（它在读体阶段就被拒）。 */
const OVERSIZE_BODY = () => Buffer.alloc(17 * 1024 * 1024, 7)

/**
 * 替身事件的三个读数：只认**流式识别器**建出来的那些流。
 * 离线那条路（/transcribe 的主线程兜底）也调 createStream，混在一起数会串台。
 */
function streamReader(fake) {
  const of = (event) => fake.events().filter((row) => row.event === event && row.extra?.owner === 'OnlineRecognizer')
  return {
    /** 目前最后一个在线流对象的编号（还没建过流就是 null）。 */
    latestId: () => of('streamCtor').at(-1)?.extra?.id ?? null,
    /** 已经建出来的在线流总数（重建一次就多一个，「没被抹掉」就是它不涨）。 */
    built: () => of('streamCtor').length,
    /** 被 free 掉的在线流编号。 */
    freedIds: () => of('streamFree').map((row) => row.extra.id),
    /** 每一帧喂给了哪个流（按调用次序）。 */
    feedIds: () => of('acceptWaveform').map((row) => row.extra.id),
    feedCount: () => of('acceptWaveform').length,
  }
}

/**
 * 场景 A：一块超限分片之后，会话必须还是**那个**会话。
 */
async function scenarioOversizeKeepsSession() {
  const tier = makeReadyTier('zipformer2-zh', { engine: 'online', repo: 'fake-repo/session-keep-a' })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-keep-a-'))
  placeTierFiles(home, tier.tier, tier.bodies)
  const fake = fakeSherpa({ marker: '假识别' })
  fake.install()
  const read = streamReader(fake)
  try {
    const env = await loadHostRoutes({
      dshHome: home,
      appendAsrTiers: [tier.tier],
      extraTreeFiles: fake.files,
    })
    const sid = 'keep-a-1'
    const streamUrl = `/dsh-voice-typing/asr-stream?sessionId=${sid}`
    const feed = () => callRoute(env, streamUrl, {
      method: 'POST',
      body: frameOfLevel(0.05),
      headers: { 'content-type': 'application/octet-stream' },
    }, 8000)

    // ① 前置：会话真的建起来了，而且第一帧喂进了这个流。
    const first = await feed()
    check('[前置] 第一帧回 200 且在说话（会话状态建立，后面的判据才有主语）',
      first.statusCode === 200 && first.json()?.speech === true,
      JSON.stringify({ status: first.statusCode, body: safeJson(first) }))
    const streamId = read.latestId()
    check('[前置] 替身确实建过一个在线流对象（编号拿得到）',
      typeof streamId === 'number' && read.feedIds().at(-1) === streamId,
      JSON.stringify({ streamId, feeds: read.feedIds() }))
    check('[前置] 到这儿只建了 1 个流、1 帧音频（后面两次读数都从这条基线比）',
      read.built() === 1 && read.feedCount() === 1,
      JSON.stringify({ built: read.built(), feeds: read.feedCount() }))

    // ② 超限分片：必须有回执，而且**不碰**会话。
    const over = await callRoute(env, streamUrl, {
      method: 'POST',
      body: OVERSIZE_BODY(),
      headers: { 'content-type': 'application/octet-stream' },
    }, 8000)
    check('[超限] 17MB 分片在限时内回 413（批次 8 那条回执语义没被这次改动带坏）',
      over.statusCode === 413, JSON.stringify({ status: over.statusCode, body: safeJson(over) }))
    check('[超限] 被拒的那块数据一帧都没喂进模型（feed 次数还是 1）',
      read.feedCount() === 1, JSON.stringify({ feeds: read.feedCount() }))
    check('[超限] 超限没有释放那个在线流（streamFree 一条都没有）',
      read.freedIds().length === 0, JSON.stringify(read.freedIds()))
    check('[超限] 超限也没有重建流（在线流总数仍是 1；重建就等于把已积累的识别状态丢了）',
      read.built() === 1, JSON.stringify({ built: read.built() }))

    // ③ 关键一条：下一帧喂进的**还是同一个流对象** —— 会话的累积状态还在。
    const after = await feed()
    check('[超限后] 再来一帧正常音频仍回 200 且带实时字（会话没被打断）',
      after.statusCode === 200 && typeof after.json()?.text === 'string' && after.json()?.speech === true,
      JSON.stringify({ status: after.statusCode, body: safeJson(after) }))
    check('[超限后] 这一帧喂进的是**同一个**流对象（id 对得上，不是从零重建）',
      read.feedIds().at(-1) === streamId && read.built() === 1,
      JSON.stringify({ streamId, feeds: read.feedIds(), built: read.built() }))

    // ④ 反证：同一个读数在会话**真被丢弃**时必须变。
    //    没有这一条，上面那两条「id 没变 / 没重建」可能只是我数不出重建。
    const reset = await callRoute(env, `/dsh-voice-typing/asr-stream/reset?sessionId=${sid}`, { method: 'POST' }, 8000)
    check('[反证] 显式收尾（/asr-stream/reset）回 200（这条路本身是好的）',
      reset.statusCode === 200 && reset.json()?.discarded === true,
      JSON.stringify({ status: reset.statusCode, body: safeJson(reset) }))
    check('[反证] 真丢弃时那个流被 free 掉了（读数拿得到，不是恒为空）',
      read.freedIds().includes(streamId), JSON.stringify(read.freedIds()))
    const afterReset = await feed()
    check('[反证] 丢弃后的下一帧用的是**新建**的流（id 变了、总数涨了）',
      afterReset.statusCode === 200 && read.feedIds().at(-1) !== streamId && read.built() === 2,
      JSON.stringify({ feeds: read.feedIds(), built: read.built() }))

    // ⑤ 副作用：拒绝请求不该把宿主的面弄坏。
    const diag = await callRoute(env, '/dsh-voice-typing/diagnostics')
    check('[副作用] 超限之后 /diagnostics 仍回 200 ok:true',
      diag.statusCode === 200 && diag.json()?.ok === true, `status=${diag.statusCode}`)
    // 三条正常帧（第一帧 / 超限后那一帧 / 反证 reset 之后那一帧）各计一次，
    // 被拒的那条 17MB 不许计进去 —— 计数是「宿主收到并处理了一帧音频」的意思。
    check('[副作用] 超限没算进流式喂帧次数（stats.stream 是 3，不是 4）',
      Number(diag.json()?.stats?.stream) === 3,
      JSON.stringify(diag.json()?.stats?.stream))
  } finally {
    fake.uninstall()
    for (const dir of [home, fake.dir]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
    }
  }
}

/**
 * 场景 B：解码侧真出事时，会话**仍然**必须被丢弃（下一轮从零开始）。
 *
 * 故障是替身演的：`throwAtWaveform: 2` —— 每个流对象自己的第 2 帧起 `acceptWaveform` 抛。
 * 计数器挂在流上，所以丢弃之后重建的新流能正常继续，正好把「从零开始」演完。
 */
async function scenarioDecodeErrorDiscards() {
  const tier = makeReadyTier('zipformer2-zh', { engine: 'online', repo: 'fake-repo/session-keep-b' })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-keep-b-'))
  placeTierFiles(home, tier.tier, tier.bodies)
  const fake = fakeSherpa({ marker: '假识别', throwAtWaveform: 2 })
  fake.install()
  const read = streamReader(fake)
  try {
    const env = await loadHostRoutes({
      dshHome: home,
      appendAsrTiers: [tier.tier],
      extraTreeFiles: fake.files,
    })
    const sid = 'keep-b-1'
    const feed = () => callRoute(env, `/dsh-voice-typing/asr-stream?sessionId=${sid}`, {
      method: 'POST',
      body: frameOfLevel(0.05),
      headers: { 'content-type': 'application/octet-stream' },
    }, 8000)

    const first = await feed()
    check('[解码故障·前置] 第一帧正常（替身要到第 2 帧才抛）',
      first.statusCode === 200 && first.json()?.speech === true,
      JSON.stringify({ status: first.statusCode, body: safeJson(first) }))
    const brokenId = read.latestId()

    const boom = await feed()
    check('[解码故障] 第二帧抛错回的是 500 回执（不是挂死、不是 200 假装成功）',
      boom.statusCode === 500 && /假 acceptWaveform|报错/.test(String(safeJson(boom)?.error ?? '')),
      JSON.stringify({ status: boom.statusCode, body: safeJson(boom) }))
    check('[解码故障] 坏掉那个流当场被 free（这条语义必须留着：残留会串到下一轮）',
      read.freedIds().includes(brokenId), JSON.stringify(read.freedIds()))

    const next = await feed()
    check('[解码故障后] 下一帧在新建的流上继续（回 200，id 变了）',
      next.statusCode === 200 && read.feedIds().at(-1) !== brokenId && read.built() === 2,
      JSON.stringify({ status: next.statusCode, feeds: read.feedIds(), built: read.built() }))

    // 会话隔离：上面这个会话坏了不该把别的会话带下去。
    const other = await callRoute(env, '/dsh-voice-typing/asr-stream?sessionId=keep-b-2', {
      method: 'POST',
      body: frameOfLevel(0.05),
      headers: { 'content-type': 'application/octet-stream' },
    }, 8000)
    check('[解码故障后] 另一条会话的第一帧照常（故障只影响它自己那个流）',
      other.statusCode === 200 && other.json()?.speech === true,
      JSON.stringify({ status: other.statusCode, body: safeJson(other) }))
  } finally {
    fake.uninstall()
    for (const dir of [home, fake.dir]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
    }
  }
}

const SCENARIOS = [
  ['超限分片不抹掉流式会话（批次 12 的正命题 + 反证）', scenarioOversizeKeepsSession],
  ['解码侧真出事仍然丢弃会话（批次 12 的另一半语义）', scenarioDecodeErrorDiscards],
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
