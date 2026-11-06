/**
 * Edge 在线合成：并发/卡死/重连（合并自原 tts-pending / tts-reconnect / tts-lock-hardtimeout）。
 *
 * 三个真实故障，逐个守护：
 *   1. 「/tts 一直 pending」：串行锁没有上限、超时后 collect 的迭代器还在读同一条
 *      audioStream（占着接收通道）、服务端超时比客户端还长。
 *   2. 「界面显示朗读中、但一点声音都没有」：连接坏掉（空音频）后不丢弃共享实例，
 *      之后每一句都返回空音频，只有重启 DSH 才能好。
 *   3. 「锁被永久占住」的最终根因：`setMetadata` / `toStream` **自己**也可能永远不返回，
 *      此时 task 内部的所有超时都形同虚设 —— 锁必须自带硬超时，队列指针只等硬超时。
 *
 * 全部真跑：把真实 `src/host/edge-tts.js` 复制到临时目录、在它旁边造一份**假的 msedge-tts 包**
 * （`<tmp>/node_modules/msedge-tts`），于是驱动的是**生产代码本身**、连 import 语句都没改，
 * 只把网络层变成可控的。装载完会核对「用上的确实是假包」，核对不上直接抛错 ——
 * 否则会静默走到仓库真装的那一份，判据就在测真网络。
 *
 * 这一文件的旧形态是「17 条源码正则 + 3 段真跑」（docs §8.34 批次 1）。
 * 那 17 条钉的全是写法：`/const MAX_SYNTH_QUEUE = \d+/`、`/synthChain = run\.then\(/`、
 * `/Promise\.race\(\[gate, hardStop\]\)/`……把 `'排队过多'` 改成 `"排队过多"` 它红，
 * 真把 DEFAULT_TIMEOUT_MS 改回 30000（回到那个卡死 bug）只要那行常量还在它就绿。
 * 现在换成跑出来的东西：
 *   - 排队上限：真把队列打满，看后到的句子是不是**立刻**拿到「排队过多」；
 *   - 超时先后：把 setTimeout 换成记录器，量**实际登记的那几个毫秒数**是否早于客户端的
 *     `TTS_TIMEOUT_MS`（客户端的值从 `src/client/pure/voice-constants.js` import 进来比，
 *     测试里不抄第二份数字）；
 *   - 超时放流：假 audioStream 自己数 `return()` 被叫了几次；
 *   - 坏连接：按错误类型逐个看**下一次调用有没有重建实例**
 *     （该重建的重建、不该重建的不许重建 —— 「不该重建」这条以前根本没人测，
 *     只有「抽了统一函数」这种写法约束，而抽函数不保证分支没写反）。
 *
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostSource } from './helpers/host-source.mjs'
import { TTS_TIMEOUT_MS } from '../src/client/pure/voice-constants.js'
// 输出格式的键名走单源：面板能选到哪些格式由词表说，不由这个测试抄一份字符串。
import { TTS_FORMATS } from '../src/shared/config-vocab.js'
import { CONFIG_SPECS } from '../src/shared/config-spec.js'

/** 仓库根：临时树放这里的 `.tmp*` 下，裸包名才解析得到（理由见 loadEdgeTtsWithFakeVendor）。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

// 读**手写源码**：这个测试把它复制到临时目录真跑（驱动生产代码本身），
// 位置由 helpers/host-source.mjs 解析 —— 第 6.5 步它搬进 src/host/ 之后照样找得到。
const SRC = hostSource('edge-tts')

/** 每次装载建一个临时树；跑完统一删（它们就在仓库里，不能留）。 */
const tmpDirs = []
function cleanupTmpDirs() {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 删不掉不该影响结论 */ }
  }
}
// 抛错、`process.exit`、判据全红之后正常退出 —— 三条路都要经过这里。
process.on('exit', cleanupTmpDirs)

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/**
 * 载入「真实 edge-tts 源码 + 假 msedge-tts 包」的临时模块。
 *
 * 批次 15 之前这里做的事是**改写源码**：把 `from './vendor/msedge-tts.cjs'` 换成
 * `from './vendor/fake.cjs'`。现在 `msedge-tts` 是真依赖（裸包名），改写法这条路等于
 * 往生产代码里塞一条它自己不会走的路径。所以换成另一件事：
 * 在临时树里造一份 `<tmp>/node_modules/msedge-tts`，Node 的解析规则会先撞上它 ——
 * **被测文件与 `src/host/edge-tts.js` 逐字相同**（除了 tune / scaffold 那两道明写在参数里的加工）。
 *
 * @param {string} fakeVendor - 假包的 CJS 源码（`module.exports = { MsEdgeTTS, OUTPUT_FORMAT }`）。
 * @param {{globalName?: string, tune?: (code: string) => string, scaffold?: (code: string) => string}} [opts] -
 *   globalName：假包用来记代次的全局变量名（各段互不干扰）；
 *   tune：装载前的第一道替换（基线不传，留着与 scaffold 走同一条通道）；
 *   scaffold：**测试脚手架**要做的替换（例如把排队上限调小），在 tune 之后再打，
 *     两道分先后，「替换打了哪一处」与「上限调小有没有生效」不会互相掩盖。
 * @returns {Promise<object>} 临时目录里的 edge-tts 模块。
 */
async function loadEdgeTtsWithFakeVendor(fakeVendor, { globalName = '__gen', tune = null, scaffold = null } = {}) {
  // 临时树放仓库根下的 `.tmp*`（.gitignore 第一条就盖住），与 helpers/host-copy.mjs 同一个口径：
  // 裸包名的解析要能往上走到某处 node_modules，而假包必须比仓库那一份更近。
  const tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-edge-tts-'))
  tmpDirs.push(tmpDir)
  const pkgDir = path.join(tmpDir, 'node_modules', 'msedge-tts')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'msedge-tts', version: '0.0.0-fake-for-tests', main: './index.cjs' }) + '\n', 'utf8')
  // 假包被 import 时把**自己的文件路径**记进全局变量：装载完就能核对「用上的到底是哪一份」。
  // 不核对的话，一旦假包目录写法坏了（路径拼错、package.json 少 main），
  // Node 会安静地往上走到仓库真装的 msedge-tts —— 判据测的就是真网络实现，全绿但全假。
  fs.writeFileSync(path.join(pkgDir, 'index.cjs'),
    `globalThis.${globalName}PkgFile = __filename\n${fakeVendor}`, 'utf8')
  let code = SRC
  if (tune) code = tune(code)
  if (scaffold) code = scaffold(code)
  fs.writeFileSync(path.join(tmpDir, 'edge-tts.mjs'), code, 'utf8')
  globalThis[globalName] = 0
  const mod = await import('file://' + tmpDir.replace(/\\/g, '/') + '/edge-tts.mjs')
  const loadedFrom = String(globalThis[`${globalName}PkgFile`] ?? '')
  if (!loadedFrom.startsWith(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    throw new Error(`假 msedge-tts 没被用上：装载到的那份在「${loadedFrom || '（假包根本没被 import 到）'}」，`
      + `期望在临时树 ${tmpDir} 里。继续跑就是在测真实现（甚至真联网），宁可现在炸。`)
  }
  return mod
}

/** 假包的骨架：每次 new 都记一代（`this.g` 给场景用，全局计数给判据用）。 */
function vendorSource(genName, body) {
  return `
    class FakeTts {
      constructor() { globalThis.${genName} = (globalThis.${genName} ?? 0) + 1; this.g = globalThis.${genName} }
      ${body}
      close() {}
    }
    module.exports = { MsEdgeTTS: FakeTts, OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'x' } }
  `
}

// ---------------------------------------------------------------------------
// 判据：全部跑在「一次装载」的结果上（装载一次，八条场景共用）
// ---------------------------------------------------------------------------

/**
 * 给「可能永远不 settle 的 promise」套一个哨兵超时。
 *
 * 为什么要它：锁的硬超时那一处一旦退化（它正是下面几条判据要防的回归），被测代码**就是**会永久 pending ——
 * 那不是测试写错了，那就是那个回归的样子。没有哨兵的话整个测试进程挂在那儿，
 * 结论从「判据翻红」变成「跑不完」，等于什么都没测到。
 * @param {Promise<any>} promise - 要等的 promise。
 * @param {number} ms - 哨兵：超过它给出 { hung: true }。
 * @returns {Promise<any>} 原结果，或者 { hung: true }。
 */
function withGuard(promise, ms) {
  let timer = null
  const sentinel = new Promise((resolve) => { timer = setTimeout(() => resolve({ hung: true }), ms) })
  return Promise.race([promise, sentinel]).finally(() => clearTimeout(timer))
}

/**
 * A. 第一句永不返回：它必须超时失败，后面的句子不能被它拖死（原「/tts 一直 pending」）。
 */
async function scenarioStuckFirst(tune, add) {
  const fakeVendor = vendorSource('__gen', `
    async setMetadata() {}
    toStream() {
      const self = this
      return { audioStream: (async function* () {
        if (self.g === 1) {
          await new Promise(() => {}) // 永不结束
        }
        yield Buffer.from([0xff, 0xf3, 0x00, 0x00])
      })() }
    }
  `)
  const mod = await loadEdgeTtsWithFakeVendor(fakeVendor, { globalName: '__gen', tune })
  const stuck = mod.synthesizeSpeech({ text: '卡住的一句' }, 1000).then(
    () => 'resolved',
    (e) => 'rejected:' + String(e.message).slice(0, 20),
  )
  const t0 = Date.now()
  const follow = mod.synthesizeSpeech({ text: '后面的一句' }, 6000).then(
    (b) => 'ok:' + b.length,
    (e) => 'rejected:' + String(e.message).slice(0, 30),
  )
  const r1 = await stuck
  const r2 = await follow
  const ms = Date.now() - t0
  add('卡住的那句会超时失败（不会永久 pending）', /^rejected/.test(r1), r1)
  add('后面那句不会跟着永久卡死（在 10 秒内有了结果）', ms < 10000, ms + 'ms → ' + r2)
  add('后面那句最终成功（换了新实例）', /^ok:/.test(r2), r2)
  add('队列深度已归还', mod.synthQueueDepthNow() === 0, String(mod.synthQueueDepthNow()))
}

/**
 * B. 坏连接返回空音频：下一次必须重建实例并成功。
 */
async function scenarioEmptyAudio(tune, add) {
  const fakeVendor = vendorSource('__fakeGen', `
    async setMetadata() {}
    toStream() {
      if (this.g === 1) {
        return { audioStream: (async function* () { /* 没有音频 */ })() }
      }
      return { audioStream: (async function* () { yield Buffer.from([0xff, 0xf3, 0x60, 0x00]); yield Buffer.from([1, 2, 3]) })() }
    }
  `)
  const mod = await loadEdgeTtsWithFakeVendor(fakeVendor, { globalName: '__fakeGen', tune })
  let firstError = null
  try {
    await mod.synthesizeSpeech({ text: '第一句。' })
  } catch (e) { firstError = e.message }
  add('第一次合成因为空音频失败', firstError && /没有收到音频数据/.test(firstError), String(firstError))
  let second = null
  let secondError = null
  try {
    second = await mod.synthesizeSpeech({ text: '第二句。' })
  } catch (e) { secondError = e.message }
  add('第二次合成自动恢复（重建连接后有音频）',
    second && second.length > 0,
    secondError ? '还是失败：' + secondError : JSON.stringify(second))
  add('确实重建了合成器实例', globalThis.__fakeGen >= 2, 'generation=' + globalThis.__fakeGen)
}

/**
 * C. `setMetadata` 永久挂住：锁的硬超时必须放行后面的句子。
 */
async function scenarioHardTimeout(tune, add) {
  const fakeVendor = vendorSource('__gen', `
    async setMetadata() {
      if (this.g === 1) await new Promise(() => {})
    }
    toStream() {
      return { audioStream: (async function* () { yield Buffer.from([0xff, 0xf3, 1, 2]) })() }
    }
  `)
  const mod = await loadEdgeTtsWithFakeVendor(fakeVendor, {
    globalName: '__gen',
    tune,
    // 把硬超时改小，好让测试快跑（生产是 DEFAULT_TIMEOUT_MS + 3000）
    scaffold: (code) => code.replace('DEFAULT_TIMEOUT_MS + 3000', '1500'),
  })
  const t0 = Date.now()
  const first = mod.synthesizeSpeech({ text: '会卡死的一句' }).then(
    () => ({ ok: true }), (e) => ({ ok: false, err: e.message }),
  )
  const second = mod.synthesizeSpeech({ text: '后面的一句' }).then(
    (b) => ({ ok: true, bytes: b.length }), (e) => ({ ok: false, err: e.message }),
  )
  // 哨兵：万一「锁的硬超时」这一处退化（它正是这条判据要防的回归），
  // 让判据红，而不是让整个测试进程永远卡在这儿。
  // 注意 withGuard 的定时器**不能 unref**：unref 之后，如果其它一切都永远 pending，
  // Node 会以「unsettled top-level await」直接退出，把结论变成一条警告了事。
  const guarded1 = await withGuard(first, 6000)
  const r1 = guarded1.hung ? { ok: true, err: '永久 pending（测试哨兵 6 秒到点）' } : guarded1
  add('挂住的那句最终失败退出（不是永久 pending）', r1.ok === false, JSON.stringify(r1))
  add('失败原因是超时', r1.ok === false && /超时/.test(r1.err), r1.err)
  // 兜底定时器：这里**不** unref —— unref 的哨兵在「其它一切都永远 pending」时会让 Node
  // 直接以「unsettled top-level await」退出，把结论变成一条警告。用 withGuard 的
  // 定时器保持引用，最多等 8 秒，然后由判据红出来。
  const guarded2 = await withGuard(second, 8000)
  const r2 = guarded2.hung ? { ok: false, err: 'TEST_HUNG' } : guarded2
  add('后面那句拿到了结果（锁没有被永久占住）', r2.err !== 'TEST_HUNG', JSON.stringify(r2))
  add('后面那句成功合成', r2.ok === true && r2.bytes > 0, JSON.stringify(r2))
  add('整体在合理时间内结束（< 12 秒）', Date.now() - t0 < 12000, (Date.now() - t0) + 'ms')
}

/**
 * D. 排队上限：队列打满之后，新到的句子**立刻**失败，而不是排到永远。
 *
 * 上限用脚手架调成 2：生产值是 8，真要把它打满得排 8 句、每句都要过一遍锁，
 * 测试不该为一条判据等那 8 次。判据钉的是「满了会快速失败」这个**行为**，不是那个数字。
 */
async function scenarioQueueOverflow(tune, add) {
  const fakeVendor = vendorSource('__qGen', `
    async setMetadata() {}
    toStream() {
      return { audioStream: (async function* () {
        await new Promise((r) => setTimeout(r, 250))
        yield Buffer.from([0xff, 0xf3, 0, 0])
      })() }
    }
  `)
  const mod = await loadEdgeTtsWithFakeVendor(fakeVendor, {
    globalName: '__qGen',
    tune,
    scaffold: (code) => code.replace('const MAX_SYNTH_QUEUE = 8', 'const MAX_SYNTH_QUEUE = 2'),
  })
  const t0 = Date.now()
  const settled = await Promise.all([1, 2, 3, 4, 5].map((i) =>
    mod.synthesizeSpeech({ text: '第' + i + '句' }).then(() => 'ok', (e) => 'err:' + e.message)))
  const ms = Date.now() - t0
  const overflow = settled.filter((s) => /排队过多/.test(s))
  add('队列打满之后新到的句子直接失败（不是排到永远）', overflow.length >= 1, JSON.stringify(settled))
  add('快速失败说的是「前面的请求卡住了」这种人话',
    overflow.length >= 1 && overflow.every((s) => /前面的请求卡住/.test(s)), overflow[0])
  add('被拒的句子没等任何超时（整批 2 秒内 settle）', ms < 2000, ms + 'ms → ' + JSON.stringify(settled))
  add('排队结束（含被拒的）之后队列深度归零', mod.synthQueueDepthNow() === 0, String(mod.synthQueueDepthNow()))

  // 反证：真实上限（8）之下并发 5 句是正常负载，不该误伤。
  const calm = await loadEdgeTtsWithFakeVendor(fakeVendor, { globalName: '__qGen2', tune })
  const calmResults = await Promise.all([1, 2, 3, 4, 5].map((i) =>
    calm.synthesizeSpeech({ text: '第' + i + '句' }).then(() => 'ok', (e) => 'err:' + e.message)))
  add('真实上限之下（并发 5 句）一句都不该被拒', calmResults.every((s) => s === 'ok'), JSON.stringify(calmResults))
}

/**
 * E. 超时用的毫秒数必须**早于**客户端的单句超时，且超时后要主动放掉那条流。
 *
 * 做法：把 setTimeout 换成记录器（长于一拍的定时器不真的等），
 * 于是「服务端超时是多少」变成了**登记出来的数字**，不是抄在测试里的第二份常量；
 * 客户端那个值直接从 pure/voice-constants.js import 进来比。
 */
async function scenarioTimeoutOrder(tune, add) {
  const fakeVendor = vendorSource('__toGen', `
    async setMetadata() {}
    toStream() {
      const it = {
        // 永远不 resolve 的 next：模拟「服务端在这条流上不给音频」。
        next: () => new Promise(() => {}),
        // 生产代码超时后要主动叫它收摊；这里数它被叫了几次。
        return: () => { globalThis.__toReturned = (globalThis.__toReturned ?? 0) + 1; return Promise.resolve({ done: true }) },
      }
      return { audioStream: { [Symbol.asyncIterator]: () => it } }
    }
  `)
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  // 场景之间留下的全局计数必须先清：不清的话「return() 被叫过」在下一条场景里
  // 也是真的，那条判据就永远抓不到「不放流」这个回归。
  globalThis.__toReturned = 0
  const registered = []
  const armed = []
  globalThis.setTimeout = (fn, ms, ...rest) => {
    // 只截长定时器（100ms 以上）：合成路径上真正的超时都在 8 秒以上，
    // 短的（测试自己要用的那 10ms 一拍）继续走真的，不然这里跑不动。
    if (ms >= 100) { registered.push(ms); armed.push(fn); return { __fakeTimer: armed.length } }
    return realSetTimeout(fn, ms, ...rest)
  }
  globalThis.clearTimeout = (handle) => {
    if (handle && handle.__fakeTimer) return
    return realClearTimeout(handle)
  }
  let outcome = 'resolved'
  try {
    const mod = await loadEdgeTtsWithFakeVendor(fakeVendor, { globalName: '__toGen', tune })
    const pending = mod.synthesizeSpeech({ text: '永远收不到音频的一句' }).then(
      () => 'resolved', (e) => 'rejected:' + e.message)
    // 让 collect 的超时与锁的硬超时都登记好（各一拍宏任务）。
    for (let i = 0; i < 6 && armed.length < 2; i++) await new Promise((r) => realSetTimeout(r, 5))
    add('这一次合成确实挂了不止一个超时（内部超时 + 锁的硬超时）', armed.length >= 2,
      `登记了 ${armed.length} 个：${registered.join(', ')}`)
    add('登记的那些超时全都早于客户端单句超时（服务端先让出锁）',
      registered.length >= 2 && Math.max(...registered) < TTS_TIMEOUT_MS,
      `${Math.max(...(registered.length ? registered : [0]))}ms vs 客户端 ${TTS_TIMEOUT_MS}ms（${registered.join(', ')}）`)
    // 到点：手动叫它们响，而不是真等 12 秒。
    for (const fire of armed.splice(0)) { try { fire() } catch { /* 已经 settle 的那个会安静下来 */ } }
    outcome = await pending
    add('超时给出的是「超时」那个人话错误', /^rejected:.*超时/.test(outcome), outcome)
    add('超时之后主动 return 掉 audioStream 的迭代器（不放过它下一句会被踩）',
      (globalThis.__toReturned ?? 0) >= 1, String(globalThis.__toReturned))
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

/**
 * F. 坏连接判据：按**跑出来的结果**分该不该丢共享实例。
 *
 * 数法：先制造一次带某个错误的调用，紧接着跑一次健康的调用，看它**新建了几个实例**。
 * 新建 1 个 = 上一次确实把连接丢了；新建 0 个 = 复用了原来那条连接。
 */
async function scenarioBrokenConnectionMatrix(tune, add) {
  const fakeVendor = vendorSource('__gMade', `
    async setMetadata() { if (globalThis.__gThrow) throw new Error(globalThis.__gThrow) }
    toStream() {
      if (globalThis.__gEmpty) return { audioStream: (async function* () { /* 一条音频都不给 */ })() }
      return { audioStream: (async function* () { yield Buffer.from([9, 9, 9]) })() }
    }
  `)
  const mod = await loadEdgeTtsWithFakeVendor(fakeVendor, { globalName: '__gMade', tune })

  /**
   * 跑「先出错、再健康一句」这一对，返回第二次调用新建了几个实例。
   */
  async function probe({ throwMessage = '', empty = false }) {
    globalThis.__gThrow = throwMessage
    globalThis.__gEmpty = empty
    await mod.synthesizeSpeech({ text: '会失败的一句' }).then(() => {}, () => {})
    globalThis.__gThrow = ''
    globalThis.__gEmpty = false
    const before = globalThis.__gMade
    const recovered = await mod.synthesizeSpeech({ text: '恢复后的一句' })
      .then((b) => 'ok:' + b.length, (e) => 'err:' + e.message)
    return { created: globalThis.__gMade - before, recovered }
  }

  // 服务端把这条连接废掉的几种说法：全都要丢实例，否则后面每一句都失败。
  for (const [label, throwMessage] of [
    ['WebSocket 被服务端关闭', 'WebSocket connection is closed'],
    ['读的时候连接重置', 'read ECONNRESET'],
    ['域名都解析不了', 'connect ENOTFOUND media-apis.office.com'],
  ]) {
    const r = await probe({ throwMessage })
    add(`坏连接（${label}）之后下一次会重建实例`, r.created === 1, JSON.stringify(r))
    add(`坏连接（${label}）之后能真的出声`, r.recovered === 'ok:3', r.recovered)
  }
  const emptyAudio = await probe({ empty: true })
  add('坏连接（合成结束却没有音频数据）之后下一次会重建实例', emptyAudio.created === 1, JSON.stringify(emptyAudio))
  add('坏连接（合成结束却没有音频数据）之后能真的出声', emptyAudio.recovered === 'ok:3', emptyAudio.recovered)

  // 与连接无关的错误（服务端拒了这段文本）：连接是好的，不许丢 ——
  // 丢了下一次要重新握手，实测首句要多等 4~5 秒。
  const notConnection = await probe({ throwMessage: '服务端拒绝了这段 SSML（发音人参数非法）' })
  add('与连接无关的错误不该丢共享实例（丢了首句要重新握手）',
    notConnection.created === 0, JSON.stringify(notConnection))
  add('与连接无关的错误仍然报给人话（不是静默成功）',
    notConnection.recovered === 'ok:3', notConnection.recovered)
}

/**
 * G. 真装的那份 msedge-tts：形状要对得上生产写法（批次 15 从 vendor 改成依赖之后新增）。
 *
 * 前面六段全都跑在假包上 —— 假包是照着「生产怎么用这个依赖」写的，
 * 所以万一上游改了导出形状（改名、改成只有具名导出、把默认导出变成 namespace），
 * 那六段照样绿，真装的那份却在装载时就炸。这一段判的是**真包**，不联网、不合成，只看形状。
 *
 * 判据里的键名一律从单源取：`TTS_FORMATS`（面板能选到的格式）与
 * `SPECS.ttsFormat.def`（生产的回落那一支用的默认值），测试不抄第二份字符串。
 */
async function scenarioRealPackage() {
  const declared = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    .dependencies?.['msedge-tts']
  check('[真包] package.json 的 dependencies 里声明了 msedge-tts（不是 dev/optional —— 线上引擎要用它）',
    typeof declared === 'string' && declared.length > 0, JSON.stringify(declared))

  let mod = null
  let loadError = null
  try {
    mod = await import('msedge-tts')
  } catch (error) { loadError = error }
  check('[真包] 真装的那一份能 import 进来（声明了却没装上 = 装机一开朗读就炸）',
    !!mod, loadError ? `${loadError.constructor.name}: ${loadError.message}` : '')
  if (!mod) return

  // 生产写的是 `import msedgeTts from 'msedge-tts'` 再解构 —— CJS/ESM 互操作里
  // 只有「默认导出 = module.exports」这一条有保证。上游换成纯 ESM 或把默认导出让给
  // namespace 时，红的是这一条，而不是用户那边的「朗读没声音」。
  const shape = mod.default ?? mod
  check('[真包] 默认导入能拿到 MsEdgeTTS 而且是可 new 的构造函数（生产就用这一条通道）',
    typeof shape?.MsEdgeTTS === 'function',
    JSON.stringify({ defaultType: typeof mod.default, hasCtor: typeof shape?.MsEdgeTTS }))
  check('[真包] 真 new 出一个实例不抛（构造里不碰网络，所以这条能裸判）',
    (() => { try { return !!new shape.MsEdgeTTS() } catch (error) { return error.message } })() === true,
    '')

  const keys = Object.keys(shape?.OUTPUT_FORMAT ?? {})
  for (const format of TTS_FORMATS) {
    check(`[真包] 面板给的输出格式 ${format} 上游真认（不认就会被静默回落到默认格式）`,
      keys.includes(format), JSON.stringify(keys))
  }
  check('[真包] 配置的默认格式在真包里也有（生产回落那一支指的就是它）',
    keys.includes(CONFIG_SPECS.ttsFormat.def), JSON.stringify({ def: CONFIG_SPECS.ttsFormat.def, keys }))

  // 装到的主版本要和声明的范围同一档：lockfile 漂到 3.x 而代码按 2.x 的形状写，
  // 上面几条不一定抓得到（构造函数还在），这条抓。
  const wantMajor = String(declared).replace(/^[\^~>=\s]*/, '').split('.')[0]
  const installedVersion = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, 'node_modules', 'msedge-tts', 'package.json'), 'utf8')).version
  check('[真包] 装上的版本与声明的范围同一主版本（漂版本时上面的形状判据不一定抓得到）',
    String(installedVersion).split('.')[0] === wantMajor,
    `声明 ${declared} → 主版本 ${wantMajor}，装的是 ${installedVersion}`)
}

/** 跑完整套场景。 */
async function evaluate(tune = null) {
  const out = []
  const add = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail: String(detail ?? '') })
  for (const scenario of [
    scenarioStuckFirst,
    scenarioEmptyAudio,
    scenarioHardTimeout,
    scenarioQueueOverflow,
    scenarioTimeoutOrder,
    scenarioBrokenConnectionMatrix,
  ]) {
    await scenario(tune, add)
  }
  return out
}


// ---------------------------------------------------------------------------
// 1) 基线：全绿
// ---------------------------------------------------------------------------
console.log('Edge 在线合成：排队、超时、坏连接（真跑生产代码 + 假 msedge-tts 包）')
for (const r of await evaluate()) check(r.name, r.ok, r.detail)
cleanupTmpDirs()

// ---------------------------------------------------------------------------
// 2) 真装的那份依赖：形状对得上生产写法（批次 15）
// ---------------------------------------------------------------------------
console.log('\n真装的 msedge-tts：装载形状与配置词表对得上')
await scenarioRealPackage()
cleanupTmpDirs()


console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
