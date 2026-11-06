/**
 * 模型下载：真 fetch、真 Range、真落盘（docs §8.34 批次 2a）。
 *
 * 这个文件替代 `test/download.test.mjs` 里那 14 条「扫 model-catalog 源码」的判据。
 * 替代的理由逐条写在这里，方便核对每一条有没有真的变强：
 *
 * | 原来的源码文本判据                      | 现在比的东西                                        |
 * | --------------------------------------- | --------------------------------------------------- |
 * | `/const total = size/`（分片按真实大小切）| 落盘文件字节数 == 服务端真实大小；Range 请求**平铺**覆盖 [0, total-1] 无缝无重叠 |
 * | `/async function probeFileSize/`        | 探测请求真的发出去了（`range: bytes=0-0`），且 progress 的 total 用的是探测值而非声明值 |
 * | `/probed ?? file.bytes/`（探测失败退回） | 服务端不给 Content-Range/Content-Length 时，仍然下得完整，progress 的 total == 声明值 |
 * | `/onProgress\?\.\(from \+ got\)/`（绝对值）| 界面看到的进度序列：不后退、不提前到顶、终值 = 真实总量 |
 * | `/仓库里没有这个文件/`（404 立即失败）   | **4 秒内**失败、错误文案是「仓库里没有这个文件」；请求次数很少 |
 * | `whisperTokens('tiny')` 那一组           | 真请求 URL 的路径段就是 `tiny-tokens.txt`；档位数据里没有任何裸 `tokens.txt` |
 *
 * 顺带修掉两条**被文本判据掩盖的真缺陷**：
 *   1. 404/403 抛出的错误被同一个「换镜像重试」的 catch 吞掉了，所以「404 立即失败」
 *      只在源码里成立，运行时要把 40 轮 × 2 个镜像全跑完（实测好几分钟）才放弃，界面一直卡在「下载中」。
 *      判据改成量时间以后这条才第一次真的有守护。
 *   2. 重试轮次之间进度会**往回跳**：分片下载每一轮的 received 都从 0 重新数，
 *      第一轮数到 87%、第二轮先报 12%。ensureModel 里加了一层「只许前进」的钳制（report()）。
 *      代价要写明白：钳制把「回调报了增量」这类写法错误变得不可见了，
 *      换来的是产品层面真正要的三条：不后退、不超 100%、终值 = 真实总量。
 *
 * 本文件只跑生产代码，不再把它改坏来验守卫（批次 6c 起，见 §8.34）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startFakeCdn, loadModelCatalogOnFakeCdn, patternBuffer, digest } from './helpers/fake-cdn.mjs'
import {
  MODEL_DOWNLOAD_REASONS,
  MODEL_DOWNLOAD_REASON_PARAMS,
  MODEL_DOWNLOAD_REASON_VALUES,
  isModelDownloadReason,
  modelDownloadReasonOf,
  withModelDownloadReason,
} from '../src/shared/model-download-reasons.js'

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/** 大文件门槛（真实大小）：必须 ≥ model-catalog 的 PARALLEL_THRESHOLD 才走分片。 */
const BIG = 9_000_000
/** 分片路径要的重试轮数上限由脚手架改小，见 withScenario 的 scaffold。 */

/** 常驻脚手架：把重试轮数上限压小，判据才能在有界时间内区分「立即失败」和「跑满重试」。 */
const SCAFFOLD = (code) => code
  .replace('for (let round = 1; round <= 40; round++)', 'for (let round = 1; round <= 3; round++)')
  .replace('for (let round = 1; round <= 5; round++)', 'for (let round = 1; round <= 2; round++)')
  // 分片路径的「跑到最后一轮才把真错误抛出去」那道门限（`if (round >= 5)`）必须跟着轮数一起压。
  // 批次 22-4-1 实测踩过：只压轮数不改这道门限，最后一轮的条件永远不成立，
  // chunk-failed / sha-mismatch 被 catch 吞掉、循环自然结束、downloadFile 回 false，
  // ensureModel 于是抛成含糊的 file-failed —— 脚手架把生产里「终态错误照实上报」这条路**伪装**没了。
  .replace('if (round >= 5) throw error', 'if (round >= 2) throw error')

async function withScenario({ files, decide = null }, tune, body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cdn-home-'))
  const cdn = await startFakeCdn({ files, decide })
  const env = await loadModelCatalogOnFakeCdn(cdn.origin, home, {
    tune,
    scaffold: SCAFFOLD,
    extraRewriteChecks: [
      ['脚手架压小了单连接重试轮数', 'for (let round = 1; round <= 40; round++)', 'for (let round = 1; round <= 3; round++)'],
      ['脚手架压小了分片重试轮数', 'for (let round = 1; round <= 5; round++)', 'for (let round = 1; round <= 2; round++)'],
      ['脚手架跟着压了分片「最后一轮才抛」的门限（不然终态错误会被吞成 file-failed）', 'if (round >= 5) throw error', 'if (round >= 2) throw error'],
    ],
  })
  const dir = path.join(home, 'voice-typing', 'models')
  try {
    await body({ env, cdn, home, dir })
  } finally {
    env.restore()
    await cdn.close()
    // Windows 上删临时目录会被杀毒/索引器短暂拦住（EPERM/EBUSY）。
    // 清理失败不能算判据失败——那会让最大的那几个场景随机闪红。
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
  }
}

// ---------------------------------------------------------------------------
// 原因码（批次 22-4-1，docs §8.70）：宿主抛出的错误必须带词表里的码 + 表里点名的参数。
// 界面那句话由客户端字典出（批次 22-4-2），本文件只保证**发端**给的东西是对的。
// ---------------------------------------------------------------------------

/** 本文件真跑触发到的码，末尾那条覆盖率判据读它。 */
const observedReasons = new Set()

/**
 * 从抛出的错误里取出码与参数，并核对参数名对不对得上词表。
 * @returns {{reason: string|null, params: object, missing: string[], extra: string[], message: string}}
 */
function reasonOf(error) {
  const reason = typeof error?.reason === 'string' ? error.reason : null
  if (reason) observedReasons.add(reason)
  const wanted = MODEL_DOWNLOAD_REASON_PARAMS[reason] ?? []
  const params = error?.params && typeof error.params === 'object' ? error.params : {}
  return {
    reason,
    params,
    missing: wanted.filter((name) => params[name] === undefined || params[name] === null),
    extra: Object.keys(params).filter((name) => !wanted.includes(name)),
    message: String(error?.message ?? ''),
  }
}

/** 收集一次 ensureModel 的进度回调序列。 */
function tracker() {  const pairs = []
  return {
    pairs,
    onProgress: (received, total) => pairs.push({ received, total }),
    values: () => pairs.map((p) => p.received),
    totals: () => [...new Set(pairs.map((p) => p.total))],
  }
}

const listFiles = (dir) => {
  const out = []
  const walk = (current) => {
    if (!fs.existsSync(current)) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      out.push(path.relative(dir, full).replace(/\\/g, '/'))
    }
  }
  walk(dir)
  return out
}

// ---------------------------------------------------------------------------
// S1 大文件：按服务端真实大小切分片，并把整个文件下全
// ---------------------------------------------------------------------------
async function scenarioBigFileTiling(add, tune) {
  const body = patternBuffer(BIG, 3)
  const key = 'test/asr/encoder.int8.onnx'
  const model = {
    id: 't-enc', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: 1_000_000, // 故意给一个**偏小的估计值**：这就是当年下不下来的成因
    files: [{ name: 'encoder.int8.onnx', bytes: 1_000_000, sha256: digest(body) }],
  }
  await withScenario({ files: { [key]: { buffer: body } } }, tune, async ({ env, cdn, dir }) => {
    const t = tracker()
    let error = null
    const t0 = Date.now()
    try { await env.mod.ensureModel(model, t.onProgress) } catch (e) { error = e }
    const dest = path.join(dir, 'test/asr', 'encoder.int8.onnx')
    add('S1 大文件下载没有抛错', error === null, String(error?.message ?? error))
    add('S1 落盘文件真实存在且大小 = 服务端真实大小（不是档位里的估计值）',
      fs.existsSync(dest) && fs.statSync(dest).size === BIG,
      fs.existsSync(dest) ? String(fs.statSync(dest).size) : '文件不存在')
    add('S1 落盘内容的 sha256 与服务端一致（尾部字节没丢）',
      fs.existsSync(dest) && digest(fs.readFileSync(dest)) === digest(body))

    const ranges = cdn.requests
      .filter((r) => r.key === key && r.range && !(r.range.start === 0 && r.range.end === 0))
      .map((r) => ({ start: r.range.start, end: Math.min(r.range.end, BIG - 1) }))
      .sort((a, b) => a.start - b.start)
    // 平铺检查：按 start 排序后必须首尾相接，从 0 一直盖到 BIG-1，不重叠不留洞。
    let cursor = 0
    let tiled = ranges.length > 1
    for (const r of ranges) {
      if (r.start !== cursor) { tiled = false; break }
      if (r.end < r.start) { tiled = false; break }
      cursor = r.end + 1
    }
    if (cursor !== BIG) tiled = false
    add(`S1 Range 请求把文件平铺覆盖 [0, ${BIG - 1}]（分片是按真实大小切的）`,
      tiled, `共 ${ranges.length} 段，覆盖到 ${cursor}，第一段 ${JSON.stringify(ranges[0] ?? null)}，最后 ${JSON.stringify(ranges[ranges.length - 1] ?? null)}`)

    add('S1 探测请求确实发出去了（range: bytes=0-0）',
      cdn.requests.some((r) => r.key === key && r.range && r.range.start === 0 && r.range.end === 0))
    add('S1 progress 的总量用的是真实大小，不是档位里的估计值',
      t.totals().length === 1 && t.totals()[0] === BIG, JSON.stringify(t.totals()))
    const v = t.values()
    add('S1 progress 单调不减', v.every((n, i) => i === 0 || n >= v[i - 1]), JSON.stringify(v.slice(0, 12)))
    add('S1 progress 最后恰好等于总量', v.length > 0 && v[v.length - 1] === BIG, String(v[v.length - 1]))
    // 钳制会把「超过总量」压回 100%，所以超本身看不见；看得见的是**提前**到顶：
    // 字节被重复计数时，文件还没下完进度就已经等于总量了。
    add('S1 进度不会提前到达总量（只有收尾那几条才等于总量）',
      v.length > 0 && v.indexOf(BIG) >= v.length - 3, JSON.stringify(v))
    add('S1 下完后 isModelReady 判定就绪', await env.mod.isModelReady(model) === true)
    add('S1 目录里没有残留的 .part/.chunk/.merge',
      !listFiles(dir).some((f) => /\.part$|\.chunk\d+$|\.merge$/.test(f)),
      JSON.stringify(listFiles(dir)))
    add('S1 下载在 60 秒内完成（脚手架压小重试轮数后应远快于此）',
      Date.now() - t0 < 60000, `${Date.now() - t0}ms`)
  })
}

// ---------------------------------------------------------------------------
// S2 服务端不给大小（探测失败）→ 退回声明值，仍然下得完整
// ---------------------------------------------------------------------------
async function scenarioProbeUnusable(add, tune) {
  const size = 300_000
  const body = patternBuffer(size, 11)
  const key = 'test/asr/model.onnx'
  const model = {
    id: 't-2', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: size, files: [{ name: 'model.onnx', bytes: size, sha256: digest(body) }],
  }
  await withScenario({
    files: { [key]: { buffer: body } },
    // 探测请求（bytes=0-0）：既不给 Content-Range 也不给 Content-Length → probeFileSize 只能返回 null
    decide: (record) => (record.range && record.range.start === 0 && record.range.end === 0) ? { chunked: true, noRange: true } : null,
  }, tune, async ({ env, cdn, dir }) => {
    const t = tracker()
    let error = null
    try { await env.mod.ensureModel(model, t.onProgress) } catch (e) { error = e }
    const dest = path.join(dir, 'test/asr', 'model.onnx')
    add('S2 探测拿不到大小时仍然下成功', error === null, String(error?.message ?? error))
    add('S2 落盘大小与内容正确', fs.existsSync(dest) && digest(fs.readFileSync(dest)) === digest(body))
    add('S2 退回声明值：progress 的总量 = 档位里的 bytes',
      t.totals().length === 1 && t.totals()[0] === size, JSON.stringify(t.totals()))
    add('S2 确实试过探测（发过 bytes=0-0）',
      cdn.requests.some((r) => r.range && r.range.start === 0 && r.range.end === 0))
  })
}

// ---------------------------------------------------------------------------
// S3 磁盘上有半截 .part：必须续传，且进度报的是绝对值
// ---------------------------------------------------------------------------
async function scenarioResumeAbsoluteProgress(add, tune) {
  const size = 400_000
  const body = patternBuffer(size, 21)
  const key = 'test/asr/decoder.onnx'
  const model = {
    id: 't-3', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: size, files: [{ name: 'decoder.onnx', bytes: size, sha256: digest(body) }],
  }
  await withScenario({ files: { [key]: { buffer: body } } }, tune, async ({ env, cdn, dir }) => {
    // 预置半截 .part（前 100_000 字节是真的下过的）：这是断点续传最干净的复现方式。
    // 用「服务端中途断流」做同样的事不稳定 —— 客户端 sink.destroy() 会把还在缓冲的字节丢掉，
    // 落盘的 .part 可能是空的，于是第二轮本来就该从头下（见 S3b）。
    const part = path.join(dir, 'test/asr', 'decoder.onnx.part')
    fs.mkdirSync(path.dirname(part), { recursive: true })
    fs.writeFileSync(part, body.subarray(0, 100_000))
    const t = tracker()
    let error = null
    try { await env.mod.ensureModel(model, t.onProgress) } catch (e) { error = e }
    const dest = path.join(dir, 'test/asr', 'decoder.onnx')
    add('S3 半截 .part 能续传完成', error === null, String(error?.message ?? error))
    add('S3 落盘内容完整（sha 对得上）', fs.existsSync(dest) && digest(fs.readFileSync(dest)) === digest(body))
    const resumed = cdn.requests.filter((r) => r.key === key && r.range && r.range.start === 100_000)
    add('S3 重试是真的续传（发了 bytes=100000-，没从头下）', resumed.length >= 1,
      JSON.stringify(cdn.requests.filter((r) => r.key === key).map((r) => r.headers.range ?? null)))
    add('S3 没有把已下好的 100000 字节再下一遍',
      !cdn.requests.some((r) => r.key === key && !r.range), '有一次无 Range 的整文件请求')
    const v = t.values()
    add('S3 进度里没有出现「重复累加」（没有任何值 > 总量）',
      v.every((n) => n <= size), JSON.stringify(v))
    add('S3 进度单调不减（续传那一轮报的是绝对值 from+got）',
      v.every((n, i) => i === 0 || n >= v[i - 1]), JSON.stringify(v))
    add('S3 进度最后恰好等于总量', v.length > 0 && v[v.length - 1] === size, String(v[v.length - 1]))
  })
}

// ---------------------------------------------------------------------------
// S3b 服务端断流：重试以后必须下出完整文件
// ---------------------------------------------------------------------------
async function scenarioStalledThenRecover(add, tune) {
  const size = 350_000
  const body = patternBuffer(size, 27)
  const key = 'test/asr/stalled.onnx'
  const model = {
    id: 't-3b', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: size, files: [{ name: 'stalled.onnx', bytes: size, sha256: digest(body) }],
  }
  let first = true
  await withScenario({
    files: { [key]: { buffer: body } },
    decide: (record) => {
      if (record.range && record.range.start === 0 && record.range.end === 0) return null
      if (first && !record.range) { first = false; return { dropAfterBytes: 100_000 } }
      return null
    },
  }, tune, async ({ env, cdn, dir }) => {
    const t = tracker()
    let error = null
    try { await env.mod.ensureModel(model, t.onProgress) } catch (e) { error = e }
    const dest = path.join(dir, 'test/asr', 'stalled.onnx')
    add('S3b 断流一次以后仍能下完', error === null, String(error?.message ?? error))
    add('S3b 落盘内容完整（断流留下的半截没被当成完整文件）',
      fs.existsSync(dest) && digest(fs.readFileSync(dest)) === digest(body))
    add('S3b 确实重试过（同一个文件请求了两次以上）',
      cdn.requests.filter((r) => r.key === key).length >= 3,
      `${cdn.requests.filter((r) => r.key === key).length} 次`)
    const v = t.values()
    add('S3b 进度只前进不后退、且不超过总量',
      v.every((n, i) => i === 0 || (n >= v[i - 1] && n <= size)), JSON.stringify(v))
    add('S3b 进度最后恰好等于总量', v.length > 0 && v[v.length - 1] === size, String(v[v.length - 1]))
    add('S3b 没有留下 .part 垃圾', !listFiles(dir).some((f) => /\.part$/.test(f)), JSON.stringify(listFiles(dir)))
  })
}

// ---------------------------------------------------------------------------
// S4 分片里有一片失败：第二轮必须跳过已下好的分片，且进度仍是绝对值
// ---------------------------------------------------------------------------
async function scenarioChunkSkip(add, tune) {
  const body = patternBuffer(BIG, 31)
  const key = 'test/asr/big-encoder.onnx'
  const model = {
    id: 't-4', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: BIG, files: [{ name: 'big-encoder.onnx', bytes: BIG, sha256: digest(body) }],
  }
  const chunkSize = Math.ceil(BIG / 8)
  let poisoned = 0
  await withScenario({
    files: { [key]: { buffer: body } },
    decide: (record) => {
      if (!record.range || record.key !== key) return null
      if (record.range.start === 0 && record.range.end === 0) return null
      // 第 3 片第一次只给 1000 字节（大小不对 → 该片失败），第二次正常
      if (record.range.start === 2 * chunkSize && poisoned === 0) { poisoned++; return { dropAfterBytes: 1000 } }
      return null
    },
  }, tune, async ({ env, cdn, dir }) => {
    const t = tracker()
    let error = null
    try { await env.mod.ensureModel(model, t.onProgress) } catch (e) { error = e }
    const dest = path.join(dir, 'test/asr', 'big-encoder.onnx')
    add('S4 有一片断流后仍能下完（重试生效）', error === null, String(error?.message ?? error))
    add('S4 落盘大小 = 真实大小且 sha 对得上',
      fs.existsSync(dest) && fs.statSync(dest).size === BIG && digest(fs.readFileSync(dest)) === digest(body),
      String(error?.message ?? error))
    const round2 = cdn.requests.filter((r) => r.key === key && r.range && r.range.start > 0 && r.range.end !== BIG - 1)
    // 第二轮只该重下那一片：整轮请求数远小于 8
    const rangeRequests = cdn.requests.filter((r) => r.key === key && r.range && !(r.range.start === 0 && r.range.end === 0))
    add('S4 第二轮跳过磁盘上已完成的分片（Range 请求总数 < 8+8）',
      rangeRequests.length < 16, `Range 请求 ${rangeRequests.length} 次，第二轮 ${round2.length} 次`)
    const v = t.values()
    add('S4 跳过已下分片时进度不重复累加（没有任何值 > 总量）',
      v.every((n) => n <= BIG), JSON.stringify(v.slice(0, 20)))
    add('S4 进度单调不减且最后等于总量',
      v.every((n, i) => i === 0 || n >= v[i - 1]) && v[v.length - 1] === BIG,
      JSON.stringify(v.slice(-6)))
    add('S4 进度不会提前到达总量（只有收尾那几条才等于总量）',
      v.length > 0 && v.indexOf(BIG) >= v.length - 3, JSON.stringify(v.slice(0, 20)))
    add('S4 分片临时文件已清干净',
      !listFiles(dir).some((f) => /\.chunk\d+$|\.part$|\.merge$/.test(f)), JSON.stringify(listFiles(dir)))
  })
}

// ---------------------------------------------------------------------------
// S5 仓库里没有这个文件：必须立刻失败（这条是本轮修掉的真缺陷）
// ---------------------------------------------------------------------------
async function scenarioMissingFileFast(add, tune) {
  const model = {
    id: 't-5', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: 200_000, files: [{ name: 'no-such-file.onnx', bytes: 200_000, sha256: 'aa'.repeat(32) }],
  }
  await withScenario({ files: {} }, tune, async ({ env, cdn, dir }) => {
    const t0 = Date.now()
    let error = null
    try { await env.mod.ensureModel(model, () => {}) } catch (e) { error = e }
    const ms = Date.now() - t0
    add('S5 文件不存在时会失败（不会假装成功）', error !== null, '没抛错')
    add('S5 失败原因是「仓库里没有这个文件」，不是「下载失败」这种含糊话',
      /仓库里没有这个文件/.test(String(error?.message)), String(error?.message))
    const r5 = reasonOf(error)
    add('S5 抛出的码是 file-not-in-repo（客户端按它出句子）',
      r5.reason === MODEL_DOWNLOAD_REASONS.FILE_NOT_IN_REPO, String(r5.reason))
    add('S5 参数正好是表里点名的那两个（文件名 + HTTP 状态）',
      r5.missing.length === 0 && r5.extra.length === 0
        && r5.params.file === 'no-such-file.onnx' && r5.params.status === 404,
      JSON.stringify(r5.params))
    add('S5 立即失败（< 4000ms，旧行为是 40 轮 × 2 镜像全跑完）', ms < 4000, `${ms}ms`)
    add('S5 没有把重试轮数跑满（请求次数很少）',
      cdn.requests.filter((r) => r.key === 'test/asr/no-such-file.onnx').length <= 2,
      `${cdn.requests.filter((r) => r.key === 'test/asr/no-such-file.onnx').length} 次`)
    add('S5 失败后没在目录里留下半截文件',
      !fs.existsSync(path.join(dir, 'test/asr', 'no-such-file.onnx')) && listFiles(dir).length === 0,
      JSON.stringify(listFiles(dir)))
  })
}

async function scenarioMissingBigFileFast(add, tune) {
  const model = {
    id: 't-5b', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: BIG, files: [{ name: 'no-such-big.onnx', bytes: BIG, sha256: 'bb'.repeat(32) }],
  }
  await withScenario({ files: {} }, tune, async ({ env, cdn }) => {
    const t0 = Date.now()
    let error = null
    try { await env.mod.ensureModel(model, () => {}) } catch (e) { error = e }
    const ms = Date.now() - t0
    add('S5b 大文件路径（分片）遇到 404 也是立即失败', error !== null && ms < 6000, `${ms}ms / ${String(error?.message)}`)
    add('S5b 报的是真实原因，不是「分片下载失败」',
      /仓库里没有这个文件/.test(String(error?.message)), String(error?.message))
    const r5b = reasonOf(error)
    add('S5b 分片路径的 404 也报同一个码（不是另起一个码）',
      r5b.reason === MODEL_DOWNLOAD_REASONS.FILE_NOT_IN_REPO, String(r5b.reason))
    const n = cdn.requests.filter((r) => r.key === 'test/asr/no-such-big.onnx').length
    add('S5b 剩下 7 片不再各试一遍（清空队列生效）', n <= 10, `${n} 次请求`)
  })
}

// ---------------------------------------------------------------------------
// S6 校验：坏内容绝不能落到最终路径上；已经正确的文件不能被覆盖
// ---------------------------------------------------------------------------
async function scenarioHashMismatch(add, tune) {
  const size = 250_000
  const corrupt = patternBuffer(size, 42)
  const key = 'test/asr/bad.onnx'
  const model = {
    id: 't-6', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: size, files: [{ name: 'bad.onnx', bytes: size, sha256: digest(patternBuffer(size, 41)) }],
  }
  await withScenario({ files: { [key]: { buffer: corrupt } } }, tune, async ({ env, dir }) => {
    const dest = path.join(dir, 'test/asr', 'bad.onnx')
    let error = null
    try { await env.mod.ensureModel(model, () => {}) } catch (e) { error = e }
    add('S6 服务端内容与档位 sha 不符时会失败', error !== null, '没抛错')
    const r6 = reasonOf(error)
    // 单文件路径的 sha 校验在重试的 try 里面：坏内容会被再下几轮，跑满才由 ensureModel 抛成
    // file-failed。所以「sha mismatch」那句原文只是重试内部的噪音，**不进码表**（见 §8.70 那段）。
    add('S6 单文件校验不过最终以 file-failed 收场（带的是文件名，界面能说清是哪个文件）',
      r6.reason === MODEL_DOWNLOAD_REASONS.FILE_FAILED && r6.params.file === 'bad.onnx'
        && r6.missing.length === 0 && r6.extra.length === 0,
      `${r6.reason} ${JSON.stringify(r6.params)}`)
    add('S6 坏内容没有落到最终路径上', !fs.existsSync(dest), '最终路径上出现了文件')
    add('S6 失败后不留 .part/.merge 垃圾',
      !listFiles(dir).some((f) => /\.part$|\.merge$|\.chunk\d+$/.test(f)), JSON.stringify(listFiles(dir)))
  })
}

async function scenarioGoodFileNotOverwritten(add, tune) {
  const size = 250_000
  const good = patternBuffer(size, 41)
  const corrupt = patternBuffer(size, 42)
  const key = 'test/asr/keep.onnx'
  const model = {
    id: 't-6b', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: size, files: [{ name: 'keep.onnx', bytes: size, sha256: digest(good) }],
  }
  await withScenario({ files: { [key]: { buffer: corrupt } } }, tune, async ({ env, cdn, dir }) => {
    const dest = path.join(dir, 'test/asr', 'keep.onnx')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, good)   // 上一轮下好的、内容正确的文件
    let error = null
    try { await env.mod.ensureModel(model, () => {}) } catch (e) { error = e }
    add('S6b 已经正确的文件不会被坏内容覆盖',
      error === null && fs.existsSync(dest) && digest(fs.readFileSync(dest)) === digest(good),
      String(error?.message ?? error))
    add('S6b 校验通过就跳过下载（没有拉过文件体）',
      !cdn.requests.some((r) => r.key === key && !(r.range && r.range.start === 0 && r.range.end === 0)),
      JSON.stringify(cdn.requests.map((r) => r.headers.range ?? null)))
  })
}

// S6c：分片路径的合并校验 —— 大文件内容与服务端声明的 sha 不符时绝不能落位。
async function scenarioBigFileHashMismatch(add, tune) {
  const body = patternBuffer(BIG, 43)
  const key = 'test/asr/big-bad.onnx'
  const model = {
    id: 't-6c', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: BIG, files: [{ name: 'big-bad.onnx', bytes: BIG, sha256: 'cc'.repeat(32) }],
  }
  await withScenario({ files: { [key]: { buffer: body } } }, tune, async ({ env, dir }) => {
    const dest = path.join(dir, 'test/asr', 'big-bad.onnx')
    let error = null
    try { await env.mod.ensureModel(model, () => {}) } catch (e) { error = e }
    add('S6c 大文件拼完校验不过时会失败', error !== null, '没抛错')
    const r6c = reasonOf(error)
    add('S6c 合并后的校验直接抛 sha-mismatch（它在任何重试之外，是真会进界面的那句）',
      r6c.reason === MODEL_DOWNLOAD_REASONS.SHA_MISMATCH && r6c.params.file === 'big-bad.onnx'
        && r6c.missing.length === 0 && r6c.extra.length === 0,
      `${r6c.reason} ${JSON.stringify(r6c.params)}`)
    add('S6c 没校验过的内容没有落到最终路径', !fs.existsSync(dest), '最终路径上出现了文件')
    add('S6c 失败后不留 .merge/.chunk 垃圾',
      !listFiles(dir).some((f) => /\.part$|\.merge$|\.chunk\d+$/.test(f)), JSON.stringify(listFiles(dir)))
  })
}

// S9：磁盘上有一个**截断的**分片。它不能被当成「已经下好了」。
async function scenarioTruncatedChunk(add, tune) {
  const body = patternBuffer(BIG, 44)
  const key = 'test/asr/redo.onnx'
  const model = {
    id: 't-9', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: BIG, files: [{ name: 'redo.onnx', bytes: BIG, sha256: digest(body) }],
  }
  await withScenario({ files: { [key]: { buffer: body } } }, tune, async ({ env, cdn, dir }) => {
    // 预置一个只有 1000 字节的 .chunk0（上一轮崩在这里留下的）。
    const dirOfDest = path.join(dir, 'test/asr')
    fs.mkdirSync(dirOfDest, { recursive: true })
    const chunkSize = Math.ceil(BIG / 8)
    fs.writeFileSync(path.join(dirOfDest, 'redo.onnx.chunk0'), body.subarray(0, 1000))
    const t = tracker()
    let error = null
    try { await env.mod.ensureModel(model, t.onProgress) } catch (e) { error = e }
    const dest = path.join(dirOfDest, 'redo.onnx')
    add('S9 有截断分片时仍能下出完整文件', error === null, String(error?.message ?? error))
    add('S9 落盘大小 = 真实大小', fs.existsSync(dest) && fs.statSync(dest).size === BIG,
      fs.existsSync(dest) ? String(fs.statSync(dest).size) : '没有落盘')
    add('S9 落盘 sha 对得上（截断的分片没被拼进最终文件）',
      fs.existsSync(dest) && digest(fs.readFileSync(dest)) === digest(body))
    add('S9 截断的分片被重新下过（有从 0 开始的 Range 请求）',
      cdn.requests.some((r) => r.key === key && r.range && r.range.start === 0 && r.range.end === chunkSize - 1),
      JSON.stringify(cdn.requests.map((r) => r.headers.range ?? null)))
    add('S9 收尾把分片清干净',
      !listFiles(dir).some((f) => /\.chunk\d+$|\.merge$|\.part$/.test(f)), JSON.stringify(listFiles(dir)))
  })
}

// ---------------------------------------------------------------------------
// S10~S12 原因码的三个还没被上面覆盖到的抛点（批次 22-4-1）
// ---------------------------------------------------------------------------
async function scenarioNoDownloadableFiles(add, tune) {
  const model = { id: 't-10', label: 'T', engine: 'whisper', repo: null, revision: 'main', bytes: 0, files: [] }
  await withScenario({ files: {} }, tune, async ({ env, cdn }) => {
    let error = null
    try { await env.mod.ensureModel(model, () => {}) } catch (e) { error = e }
    const r = reasonOf(error)
    add('S10 档位没有可下载文件时会失败', error !== null, '没抛错')
    add('S10 报的码是 no-downloadable-files，参数是档位 id',
      r.reason === MODEL_DOWNLOAD_REASONS.NO_DOWNLOADABLE_FILES
        && r.params.model === 't-10' && r.missing.length === 0 && r.extra.length === 0,
      `${r.reason} ${JSON.stringify(r.params)}`)
    add('S10 这一条根本没发请求（先查档位再上网）', cdn.requests.length === 0,
      `${cdn.requests.length} 次`)
  })
}

async function scenarioFileKeepsDropping(add, tune) {
  const size = 250_000
  const body = patternBuffer(size, 71)
  const key = 'test/asr/drop.onnx'
  const model = {
    id: 't-11', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: size, files: [{ name: 'drop.onnx', bytes: size, sha256: digest(body) }],
  }
  // 每一次应答都在吐出第一个字节之前断开：网络层永远拿不到内容，重试也救不了。
  await withScenario({ files: { [key]: { buffer: body } }, decide: () => ({ dropAfterBytes: 0 }) }, tune,
    async ({ env, cdn }) => {
      let error = null
      try { await env.mod.ensureModel(model, () => {}) } catch (e) { error = e }
      const r = reasonOf(error)
      add('S11 单文件反复断流会以失败收场', error !== null, '没抛错')
      add('S11 报的码是 file-failed（重试跑满的兜底那句），带文件名',
        r.reason === MODEL_DOWNLOAD_REASONS.FILE_FAILED && r.params.file === 'drop.onnx'
          && r.missing.length === 0 && r.extra.length === 0,
        `${r.reason} ${JSON.stringify(r.params)}`)
      add('S11 确实重试过而不是试一次就放弃（同一路径请求数 > 1）',
        cdn.requests.filter((req) => req.key === key).length > 1,
        `${cdn.requests.filter((req) => req.key === key).length} 次`)
    })
}

async function scenarioChunksKeepDropping(add, tune) {
  const body = patternBuffer(BIG, 72)
  const key = 'test/asr/big-drop.onnx'
  const model = {
    id: 't-12', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: BIG, files: [{ name: 'big-drop.onnx', bytes: BIG, sha256: digest(body) }],
  }
  await withScenario({ files: { [key]: { buffer: body } }, decide: () => ({ dropAfterBytes: 0 }) }, tune,
    async ({ env, dir }) => {
      let error = null
      try { await env.mod.ensureModel(model, () => {}) } catch (e) { error = e }
      const r = reasonOf(error)
      add('S12 大文件分片反复断流会以失败收场', error !== null, '没抛错')
      add('S12 报的码是 chunk-failed，带文件名与失败的分片序号',
        r.reason === MODEL_DOWNLOAD_REASONS.CHUNK_FAILED && r.params.file === 'big-drop.onnx'
          && r.missing.length === 0 && r.extra.length === 0,
        `${r.reason} ${JSON.stringify(r.params)}`)
      const listed = String(r.params.chunks ?? '').split(',').filter(Boolean)
      add('S12 失败的分片序号非空且都是数字（界面那句要把它念出来）',
        listed.length > 0 && listed.every((n) => /^\d+$/.test(n.trim())), String(r.params.chunks))
      add('S12 失败后目录里没有 .merge 残留',
        !listFiles(dir).some((f) => /\.merge$/.test(f)), JSON.stringify(listFiles(dir)))
    })
}

// ---------------------------------------------------------------------------
// S7 tokens 文件名：用真档位数据发一次真请求，看 URL 路径段
// ---------------------------------------------------------------------------
async function scenarioWhisperTokensUrl(add, tune) {
  // 各 Whisper 仓库里 tokens 文件的**真实名字**（这是判据的独立来源，不从档位表里推）：
  // 档位前缀 + `-tokens.txt`。档位表写错一个字符，下面三条都会红。
  const prefixes = {
    'whisper-tiny': 'tiny',
    'whisper-base': 'base',
    'whisper-small': 'small',
    'whisper-medium': 'medium',
    'whisper-turbo': 'turbo',
    'whisper-large-v3': 'large-v3',
  }
  // 档位数据从**临时副本**里读（不是直接 import 真模块）：副本才是这套判据的现场。
  await withScenario({ files: {} }, tune, async ({ env, cdn, home, dir }) => {
    const loaded = env.mod.MODELS
    const tiers = loaded
      .filter((m) => m.engine === 'whisper')
      .map((m) => ({ model: m, tokens: (m.files ?? []).find((f) => /tokens\.txt$/.test(f.name)) }))
    add('S7 六个 whisper 档位都在档位表里', tiers.length >= 6, `${tiers.length} 个`)
    const badNames = []
    for (const { model, tokens } of tiers) {
      const want = prefixes[model.id]
      if (!want) continue
      if (!tokens || tokens.name !== `${want}-tokens.txt`) badNames.push(`${model.id} → ${tokens?.name ?? '（没有 tokens 文件）'}`)
    }
    add('S7 每个档位的 tokens 文件名都带档位前缀', badNames.length === 0, badNames.join(' | '))
    const bare = loaded.flatMap((m) => (m.files ?? [])
      .filter((f) => f.name === 'tokens.txt' && m.engine === 'whisper')
      .map((f) => `${m.id}/${f.name}`))
    add('S7 档位数据里不存在裸的 tokens.txt（whisper 组）', bare.length === 0, bare.join(' | '))
    const wordlists = new Set(tiers.filter((t) => t.tokens).map((t) => `${t.tokens.bytes}:${t.tokens.sha256}`))
    add('S7 六档共用同一份词表（bytes 与 sha256 完全一致）', wordlists.size === 1, [...wordlists].join(' | '))

    // 真请求一次：CDN 只按「带前缀的真实文件名」应答，请求路径写错就 404。
    const first = tiers.find((t) => prefixes[t.model.id])
    const repo = first.model.repo
    const expectedName = `${prefixes[first.model.id]}-tokens.txt`
    const body = patternBuffer(1000, 5)
    const model = { ...first.model, files: [{ ...first.tokens, bytes: 1000, sha256: digest(body) }] }
    const key = `${repo}/${expectedName}`
    const second = await startFakeCdn({ files: { [key]: { buffer: body } } })
    // DSH_HOME 用场景的 home（不是 dir）：cacheRoot() 会自己在下面拼 voice-typing/models，
    // 传 dir 就变成双层嵌套，落盘路径判据永远对不上。
    const env2 = await loadModelCatalogOnFakeCdn(second.origin, home, { tune, scaffold: SCAFFOLD })
    try {
      let error = null
      try { await env2.mod.ensureModel(model, () => {}) } catch (e) { error = e }
      const urls = second.requests.map((r) => r.url)
      add('S7 真请求的 URL 用的就是带前缀的 tokens 文件名',
        urls.some((u) => u.endsWith(`/${expectedName}`)), urls.join(' | '))
      add('S7 落盘路径也是带前缀的名字',
        fs.existsSync(path.join(dir, repo, expectedName)),
        String(error?.message ?? error))
    } finally {
      env2.restore()
      await second.close()
    }
  })
}

// ---------------------------------------------------------------------------
// S8 两个文件，第二个已下好：doneBytes 与当前文件的 fileReceived 必须分开算
// ---------------------------------------------------------------------------
async function scenarioTwoFilesSkipCompleted(add, tune) {
  const a = patternBuffer(120_000, 61)
  const b = patternBuffer(80_000, 62)
  const files = {
    'test/asr/a.onnx': { buffer: a },
    'test/asr/b.onnx': { buffer: b },
  }
  const model = {
    id: 't-8', label: 'T', engine: 'whisper', repo: 'test/asr', revision: 'main',
    bytes: 200_000,
    files: [
      { name: 'a.onnx', bytes: 120_000, sha256: digest(a) },
      { name: 'b.onnx', bytes: 80_000, sha256: digest(b) },
    ],
  }
  await withScenario({ files }, tune, async ({ env, cdn, dir }) => {
    const t1 = tracker()
    await env.mod.ensureModel(model, t1.onProgress)
    const v1 = t1.values()
    add('S8 两个文件都下完，进度最后等于两者之和',
      v1[v1.length - 1] === 200_000 && fs.existsSync(path.join(dir, 'test/asr', 'b.onnx')),
      JSON.stringify(v1))
    const before = cdn.requests.length
    const t2 = tracker()
    await env.mod.ensureModel(model, t2.onProgress)
    const downloaded = cdn.requests.slice(before).filter((r) => r.range && !(r.range.start === 0 && r.range.end === 0))
    add('S8 两个文件都就绪时不再重下（第二轮没有拉过文件体）',
      downloaded.length === 0, `${downloaded.length} 次`)
    const v2 = t2.values()
    add('S8 已就绪的文件按 doneBytes 逐个累加报进度（每档一次、终值=总量）',
      v2.join() === '120000,200000', JSON.stringify(v2))
    add('S8 第二轮的 total 仍是两个文件的真实大小之和',
      [...new Set(t2.pairs.map((p) => p.total))].join() === '200000', JSON.stringify(t2.totals()))
  })
}

// ---------------------------------------------------------------------------
// 跑一遍全部场景，返回判据行（基线一次跑完，逐条打印）
// ---------------------------------------------------------------------------
const SCENARIOS = [
  ['S1 大文件按真实大小切分片', scenarioBigFileTiling],
  ['S2 探测拿不到大小', scenarioProbeUnusable],
  ['S3 半截 .part 续传', scenarioResumeAbsoluteProgress],
  ['S3b 断流后重试', scenarioStalledThenRecover],
  ['S4 分片跳过与绝对进度', scenarioChunkSkip],
  ['S5 文件不存在（单连接）', scenarioMissingFileFast],
  ['S5b 文件不存在（分片）', scenarioMissingBigFileFast],
  ['S6 校验不过不动最终路径', scenarioHashMismatch],
  ['S6b 已正确的文件不被覆盖', scenarioGoodFileNotOverwritten],
  ['S6c 大文件合并校验', scenarioBigFileHashMismatch],
  ['S9 截断分片必须重下', scenarioTruncatedChunk],
  ['S10 档位没有可下载文件（码）', scenarioNoDownloadableFiles],
  ['S11 单文件反复断流（码）', scenarioFileKeepsDropping],
  ['S12 分片反复断流（码）', scenarioChunksKeepDropping],
  ['S7 whisper tokens 文件名', scenarioWhisperTokensUrl],
  ['S8 两文件跳过已完成的', scenarioTwoFilesSkipCompleted],
]

async function evaluate(tune = null) {
  const out = []
  const add = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail: String(detail ?? '') })
  for (const [label, fn] of SCENARIOS) {
    try {
      await fn(add, tune)
    } catch (error) {
      // 场景自己炸了：记一条红，别让后面几节跟着静默跑光。
      add(`${label}：场景跑通`, false, String(error?.message ?? error))
    }
  }
  return out
}



console.log('模型下载：真 fetch / 真 Range / 真落盘（跑生产代码，只把网络换成 127.0.0.1 上的假 CDN）')
const baseline = await evaluate()
for (const row of baseline) check(row.name, row.ok, row.detail)
const dupNames = baseline.map((r) => r.name).filter((n, i, arr) => arr.indexOf(n) !== i)
check(`判据名不重复（共 ${baseline.length} 条）`, dupNames.length === 0, [...new Set(dupNames)].join(' | '))


console.log('\n码表这两个纯函数：填错当场炸、没带码归兜底（shared/model-download-reasons.js）')
{
  const bare = modelDownloadReasonOf(new Error('EACCES: 磁盘不让写'))
  check('不带码的异常归 failed-unknown，原文留给诊断字段',
    bare.reason === MODEL_DOWNLOAD_REASONS.FAILED_UNKNOWN
      && Object.keys(bare.params).length === 0 && bare.message === 'EACCES: 磁盘不让写',
    JSON.stringify(bare))
  check('字符串、undefined 这类非 Error 也不会让取码这一步再抛一次',
    modelDownloadReasonOf('坏了').reason === MODEL_DOWNLOAD_REASONS.FAILED_UNKNOWN
      && modelDownloadReasonOf(undefined).message === '',
    JSON.stringify([modelDownloadReasonOf('坏了'), modelDownloadReasonOf(undefined)]))

  const coded = withModelDownloadReason(new Error('下载失败：a.onnx'),
    MODEL_DOWNLOAD_REASONS.FILE_FAILED, { file: 'a.onnx' })
  const back = modelDownloadReasonOf(coded)
  check('带码的错误取回来还是那个码与那组参数',
    back.reason === MODEL_DOWNLOAD_REASONS.FILE_FAILED && back.params.file === 'a.onnx',
    JSON.stringify(back))

  const extra = withModelDownloadReason(new Error('x'),
    MODEL_DOWNLOAD_REASONS.FILE_NOT_IN_REPO, { file: 'a.onnx', status: 404, secret: '不该上界面' })
  check('表里没点名的参数在挂码这一步就被丢掉（宿主多给的东西不会顺着事件流到界面）',
    Object.keys(extra.params).join() === 'file,status', Object.keys(extra.params).join())

  const throws = (fn) => { try { fn(); return null } catch (e) { return e } }
  check('码不在表里：当场抛，不会留下一个装机上永远显示不出来的码',
    throws(() => withModelDownloadReason(new Error('x'), 'no-such-code', {})) instanceof TypeError)
  check('表里要求的参数少给了：也当场抛（界面那句不会有没填掉的 {file}）',
    throws(() => withModelDownloadReason(new Error('x'), MODEL_DOWNLOAD_REASONS.FILE_FAILED, {})) instanceof TypeError)
  check('isModelDownloadReason 只认表里的值（非字符串、空值都算不认识）',
    isModelDownloadReason(MODEL_DOWNLOAD_REASONS.FILE_FAILED) && !isModelDownloadReason('')
      && !isModelDownloadReason(undefined) && !isModelDownloadReason(404))
}

console.log('\n原因码词表：真跑出来的码都在表里、表里每个码都有着落（批次 22-4-1）')
{
  const stray = [...observedReasons].filter((code) => !isModelDownloadReason(code))
  check(`真跑触发到的 ${observedReasons.size} 个码全在词表里`, stray.length === 0, stray.join(' | '))
  check('词表里每个码都有参数名清单（哪怕是无参数的空数组）',
    MODEL_DOWNLOAD_REASON_VALUES.every((code) => Array.isArray(MODEL_DOWNLOAD_REASON_PARAMS[code])),
    MODEL_DOWNLOAD_REASON_VALUES.filter((code) => !Array.isArray(MODEL_DOWNLOAD_REASON_PARAMS[code])).join(' | '))
  // 本文件没触发的码必须属于这两类之一，写死在这里：
  //   · 路由层那两条（POST /model 的 404/409）由 test/model-state.test.mjs 真跑宿主触发；
  //   · 兜底与合并前的防御性守卫构造不出网络行为（见 §8.70 那段）。
  const elsewhere = new Set([
    MODEL_DOWNLOAD_REASONS.UNKNOWN_MODEL,
    MODEL_DOWNLOAD_REASONS.HOSTED_UNAVAILABLE,
    MODEL_DOWNLOAD_REASONS.FAILED_UNKNOWN,
    MODEL_DOWNLOAD_REASONS.CHUNK_INCOMPLETE,
    MODEL_DOWNLOAD_REASONS.MERGED_SIZE_MISMATCH,
  ])
  const uncovered = MODEL_DOWNLOAD_REASON_VALUES.filter((code) => !observedReasons.has(code) && !elsewhere.has(code))
  check(`其余每个码要么被本文件跑出来，要么在上面那张「别处/防御」名单里（跑出来 ${observedReasons.size} 个）`,
    uncovered.length === 0, `谁都不是：${uncovered.join(' | ')}`)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
