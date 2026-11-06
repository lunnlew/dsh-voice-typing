/**
 * 测试接缝：给临时宿主树塞一个**假 sherpa-onnx**，让识别/合成线程的「成功路径」能真跑。
 *
 * 为什么需要它（docs/architecture-modernization.md §8.38，批次 6e）：
 *   `test/worker-protocol.test.mjs` 里那 8 条判据读的是宿主与 worker 的源码正则
 *   （`/task\.resolve\(message\)/`、`/Boolean\(value\?\.ok\)/`、`/ok: true, \.\.\.result/` …），
 *   它们保的是一件当年真的坏掉过的事：`asrPending` 表被三种请求共用而回包形状不同，
 *   主线程 handler 统一预筛成 `{text, speech}` 之后，**preload 即使成功也永远报告失败**，
 *   用户看到的是「识别模型加载失败、开麦卡住」。
 *   想真跑这条链路就差一样东西：worker 要能真的把识别器「加载成功」。
 *   真模型 230MB，测试机没有，也不该有 —— 于是把**第三方依赖**换成假的：
 *   生产代码（宿主的路由、worker 的协议与回包构造）一个字都没改，
 *   只有 `require('sherpa-onnx-node')` 拿到的是这里这份替身。
 *   这和 `fake-cdn`（网络）、`fake-fs`（磁盘）、`fake-child-process`（子进程）是同一类替身。
 *
 * 批次 6g 把它从「一份原生替身」扩成**两种档**（`kind: 'native' | 'wasm'`）：
 *   `test/worker-fallback.test.mjs` 要判的是「原生装不上时改用 WASM 工厂函数、
 *   喂音频的参数形式也跟着变」，以前只有扫 worker 源码的正则。
 *   现在同一份替身按档只导出**类**或**工厂函数**（另一边一个都不给，走错分支就 TypeError），
 *   并且把 `acceptWaveform` 的**调用形状**记进事件（几个参数、第一个是不是带 sampleRate 的对象）。
 *   于是判据变成：起真 worker、发真消息、看收回来的事件里到底调了哪个入口。
 *
 * 四条实现上的注意：
 *   1. **必须放在临时树里，而且要明白「另一档加载不出来」现在靠什么成立**。
 *      worker 里用的是 `createRequire(import.meta.url)`，它从**自己所在的目录**一层层往上找
 *      `node_modules`，所以假包写进 `<base>/host/node_modules/` 一定命中 —— 它是查找路径上的第一站。
 *      但「仓库那份真的不在查找路径上」这句话**已经过期了**（批次 15，docs §8.57）：
 *      宿主树现在建在仓库根下的 `.tmp-host-*` 里（裸依赖要能按生产规则解析），
 *      往上走一步就是仓库的 `node_modules`，真 `sherpa-onnx-node` 在那儿躺着 ——
 *      WASM 档那棵树里 `require('sherpa-onnx-node')` 会加载到**真的原生 addon**，
 *      拿假模型路径去构造识别器直接把进程搞崩（Windows 退出码 0xC0000409，无堆栈）。
 *      现在这条隔离由 `host-copy.mjs` 的**可选依赖防火墙**提供：
 *      树里给 dev / peer / optional 的每个包名放一个「只有清单、没有入口」的壳，
 *      于是它们在树里都是 MODULE_NOT_FOUND，在场与否**由替身写出来**。
 *      还留在 `os.tmpdir()` 下的树（`worker-fallback.test.mjs` 的 `makeWorkerTree`）
 *      靠的是位置隔离，两种隔离给的是同一个结果。
 *      「这一档确实加载不出来」由判据自己探一次（见 `worker-fallback.test.mjs` 第 3b 节），
 *      不靠本文件这句话。
 *   2. **假包必须是 CommonJS**：worker 用的是 `require`。嵌套的 `package.json` 不写 `"type"`
 *      就是 CJS，不受临时树顶层 `{"type":"module"}` 影响。
 *   3. **回包里带 threadId 标记**：`/transcribe` 在 worker 拒绝时会回落到主线程同步识别
 *      （`recognizeWithSherpa`），那条路用的是同一份假包。文本里带上 `#thread=<id>`
 *      才能区分「真的走了线程」（≥1）和「回落成功」（0）。
 *   4. **包名跟着档走**：`native` → `sherpa-onnx-node`，`wasm` → `sherpa-onnx`。
 *      `resolveSherpa` 是先试原生再试 WASM，放错位置就变成两份替身同时在场，测的不是那条分支。
 *
 * 用法：
 *   const fake = fakeSherpa({ marker: '假识别' })            // 默认原生档
 *   const fake = fakeSherpa({ kind: 'wasm', vad: 'yield' })  // WASM 档 + 能切出语音段的 VAD
 *   fake.install()                       // 把事件文件路径写进 env（worker 继承父进程 env）
 *   const env = await loadHostRoutes({ extraTreeFiles: fake.files, ... })
 *   fake.events()                        // [{event:'ctor'|'factory'|'createStream'|'streamCtor'|'streamFree'|…, thread:1, extra:…}, …]
 *   …
 *   fake.uninstall(); fs.rmSync(fake.dir, {recursive:true, force:true})
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** worker 与主线程之间传事件用的环境变量名。 */
export const FAKE_SHERPA_MARK_ENV = 'DSH_FAKE_SHERPA_MARK'

/**
 * 「取流的那一刻」的进程内钩子挂在这个全局名上（批次 16，`test/stream-discard.test.mjs`）。
 *
 * 为什么假包要有这种东西：有些时机不是「等一等」就能等到的。
 * 宿主取流式的解码器写的是 `await getRecognizer(...)` 之后同步 `recognizer.createStream()`，
 * 中间那个窗口（识别器已经拿到、会话状态还没写进 Map）在生产里只有并发释放能撞进去 ——
 * 测试没法用「起两个请求然后希望它们恰好交错」去演一条**依赖运气**的路径。
 * 于是让假包在 `createStream()` 里回调一下：测试把释放动作放进这个回调，
 * 窗口就**确定地**被打开一次。钩子只在 `OnlineRecognizer` 上触发，
 * 谁挂、什么时候摘都由测试负责（见那个场景里的 try/finally）。
 */
export const FAKE_SHERPA_CREATE_STREAM_HOOK = '__dshFakeSherpaCreateStreamHook'

/**
 * 生成假包文件，并准备好事件回收。
 * @param {object} [options] - {
 *   marker: 识别文本里带的标记词（会进 /transcribe 的响应），
 *   kind: 'native'（默认，导出类）| 'wasm'（导出工厂函数，**不**导出任何类），
 *   vad: 'empty'（默认，永远切不出语音段）| 'yield'（把喂进去的采样当成一段吐回来），
 *   onlineReady: 流式识别器的 `isReady` 怎么答（批次 6k，docs §8.44）——
 *     'never'（默认，一次都不让解，等于「正常路径」）|
 *     'always'（永远说还能解，等于「decode 不推进状态」那种坏情况，用来判上限）|
 *     数字 n（前 n 次为真，用来判「需要 n 步的流会不会被上限截断」），
 *   throwAtWaveform: 第几帧起 `acceptWaveform` 抛错（批次 12，docs §8.53；0 = 永不抛）。
 *     流式那条 catch 的语义是「解码侧真出事就丢弃会话」，判它就得能造出解码侧的故障。
 *     计数器挂在**每个流对象**上，所以第 N 帧抛完之后、重建的新流又从 1 数起（还能正常跑）。
 * }
 * @returns {{files: Record<string,string>, dir: string, markFile: string,
 *            install: ()=>void, uninstall: ()=>void, events: ()=>Array, pkgDir: string}}
 */
export function fakeSherpa({ marker = '假识别', kind = 'native', vad: vadMode = 'empty', onlineReady = 'never', throwAtWaveform = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fake-sherpa-'))
  const markFile = path.join(dir, 'events.jsonl')
  // 包名必须与 kind 对齐：resolveSherpa 是**先试原生再试 WASM**，
  // 放错位置就变成两份替身同时在场，测的就不是那一条分支了。
  const pkgName = kind === 'wasm' ? 'sherpa-onnx' : 'sherpa-onnx-node'
  const PKG_DIR = `node_modules/${pkgName}`

  const source = `"use strict"
// 假 sherpa-onnx（${kind} 档）：只为测试提供「加载成功」这条路径，不做任何识别。
const { threadId } = require('node:worker_threads')
const fsx = require('node:fs')
const MARKER = ${JSON.stringify(marker)}
const WASM = ${kind === 'wasm' ? 'true' : 'false'}
const VAD_YIELDS = ${vadMode === 'yield' ? 'true' : 'false'}
// 流式识别器 isReady 的答法：'never' | 'always' | 数字（前 n 次为真）。
const ONLINE_READY = ${JSON.stringify(onlineReady)}
// 第几帧起 acceptWaveform 抛错（0 = 永不抛）。批次 12 用它造「解码侧真出事」。
const THROW_AT_WAVEFORM = ${JSON.stringify(throwAtWaveform)}
// 流对象的编号：模块级递增，所以「这一帧喂进的还是不是同一个流」是数得出来的。
let STREAM_SEQ = 0
function record(event, extra) {
  const file = process.env.${FAKE_SHERPA_MARK_ENV}
  if (!file) return
  try {
    fsx.appendFileSync(file, JSON.stringify({ event, thread: threadId, extra: extra ?? null }) + '\\n')
  } catch { /* 记账失败不许影响被测试的代码 */ }
}
// 从 modelConfig 里认出「这是哪个模型的哪一档」：
// 键是 senseVoice / whisper / transducer 这类子结构，模型路径在它上面的 model 或 encoder 字段。
// 只取文件名（路径含临时目录，每次都不同；判据要的是「同一档的几份副本」这种可比对的粒度）。
function modelKey(mc) {
  const kind2 = mc ? Object.keys(mc).filter((k) => mc[k] && k !== 'tokens')[0] : null
  const sub = kind2 ? mc[kind2] : null
  const raw = String((sub && (sub.model || sub.encoder)) || '')
  const last = raw.split('/').pop().split(String.fromCharCode(92)).pop()
  return { kind: kind2 || null, base: last }
}
class FakeStream {
  constructor(owner) {
    // 批次 12（docs §8.53）：判据要能说出「这一帧喂进的还是**同一个**流对象」。
    // 流式会话被抹掉时用户看到的是实时文字整段消失，而「下一帧重建了流」只有给流编号才数得出来。
    this.owner = owner            // 谁的流：OnlineRecognizer / OfflineRecognizer（离线那条也建流）
    this.id = ++STREAM_SEQ        // 全模块递增：跨识别器、跨线程都不同号，够用来配对
    this.waveforms = 0            // 这个流自己被喂过几帧
    record('streamCtor', { owner: this.owner, id: this.id })
  }
  acceptWaveform(...args) {
    // 喂音频的参数形式就是原生档与 WASM 档的差别（对象 vs 位置参数），
    // 记下来让判据能直接看**调用形状**，不用扫生产源码的正则。
    this.waveforms += 1
    const first = args[0]
    record('acceptWaveform', {
      id: this.id,
      owner: this.owner,
      at: this.waveforms,
      argc: args.length,
      firstType: Array.isArray(first) || (first && typeof first === 'object') ? 'object' : typeof first,
      hasSampleRateKey: Boolean(first && typeof first === 'object' && typeof first.sampleRate === 'number'),
    })
    // 「解码这一侧真出事」是流式 catch 的**另一半**语义（它必须丢弃会话），
    // 没有这个入口就没法证明修复没把丢弃一并关掉。第 N 帧起抛，抛在第几帧由测试定。
    if (THROW_AT_WAVEFORM > 0 && this.waveforms >= THROW_AT_WAVEFORM) {
      throw new Error('假 acceptWaveform 报错（测试注入的解码侧故障）')
    }
  }
  inputFinished() { record('inputFinished', { id: this.id, owner: this.owner }) }
  free() { record('streamFree', { id: this.id, owner: this.owner }) }
}
class FakeEntry {
  constructor(name, config) {
    // event 名按档分开：native 走类构造（ctor），wasm 走工厂函数（factory）。
    // 「用了哪一种」就是 worker-fallback 那批判据要看的东西。
    const mc = config && config.modelConfig
    const key = modelKey(mc)
    record(WASM ? 'factory' : 'ctor', {
      name,
      modelKind: key.kind,
      // 模型文件名（不含目录）：批次 7 要数「同一个模型的几份识别器是不是都被释放了」，
      // 光有类名分不出来，完整路径又每次都变（临时目录）。
      modelFile: key.base,
    })
    this.name = name
    this.config = config
  }
  free() { record('free', { name: this.name, modelFile: modelKey(this.config && this.config.modelConfig).base }) }
}
class FakeRecognizer extends FakeEntry {
  constructor(name, config) {
    super(name, config)
    // 批次 6k 要判的是「解码循环有没有步数上限」，那是**次数**意义上的事，
    // 所以替身自己得能把次数留在手上：每一步都记（一次同步写文件）在
    // 「上限=10000」这种场景会把测试拖垮，所以前 5 步照记、之后每 2000 步记一次，
    // 总数挂在实例上，由 getResult 的那条记录带回去。
    this.decodes = 0
    this.readyCalls = 0
  }
  createStream() {
    record('createStream', { name: this.name })
    const stream = new FakeStream(this.name)
    // 批次 16：「识别器在取流这一瞬间被释放」那条竞态只有这一个窗口能演（理由见
    // FAKE_SHERPA_CREATE_STREAM_HOOK 的注释）。钩子由测试自己挂、自己摘。
    if (this.name === 'OnlineRecognizer') {
      globalThis.${FAKE_SHERPA_CREATE_STREAM_HOOK}?.({ id: stream.id })
    }
    return stream
  }
  decode() {
    this.decodes += 1
    if (this.decodes <= 5 || this.decodes % 2000 === 0) record('decode', { name: this.name, at: this.decodes })
  }
  getResult() {
    record('getResult', { name: this.name, decodes: this.decodes, readyCalls: this.readyCalls })
    return { text: MARKER + '#thread=' + threadId }
  }
}
class OfflineRecognizer extends FakeRecognizer {
  constructor(config) { super('OfflineRecognizer', config) }
}
class OnlineRecognizer extends FakeRecognizer {
  constructor(config) { super('OnlineRecognizer', config) }
  isReady() {
    // 「还能再解一步吗」就是解码循环的全部依据，所以它必须能被测试调成三种：
    // never（正常路径：解一次就够）、always（坏情况：decode 不推进状态）、数字 n（要 n 步的流）。
    this.readyCalls += 1
    if (ONLINE_READY === 'always') return true
    if (typeof ONLINE_READY === 'number') return this.readyCalls <= ONLINE_READY
    return false
  }
}
class OfflineTts extends FakeEntry {
  constructor(config) { super('OfflineTts', config) }
  generate(params) {
    record('ttsGenerate', { name: 'OfflineTts', text: String(params?.text ?? '').slice(0, 12) })
    return { samples: new Float32Array([0.1, -0.1, 0.2, 0]), sampleRate: 22050 }
  }
}
class Vad extends FakeEntry {
  constructor(config) { super('Vad', config); this.buf = [] }
  acceptWaveform(samples) { if (VAD_YIELDS) for (let i = 0; i < samples.length; i++) this.buf.push(samples[i]) }
  isEmpty() { return this.buf.length === 0 }
  front() { return { samples: this.buf.slice(), start: 0 } }
  pop() { this.buf = [] }
  reset() {}
  flush() {}
}
const CLASSES = { OfflineRecognizer, OnlineRecognizer, OfflineTts, Vad }
const FACTORIES = {
  createOfflineRecognizer: (config) => new OfflineRecognizer(config),
  createOnlineRecognizer: (config) => new OnlineRecognizer(config),
  createOfflineTts: (config) => new OfflineTts(config),
  createVad: (config) => new Vad(config),
}
// resolveSherpa 靠「有没有 OfflineRecognizer / OfflineTts 这些类」判原生还是 WASM：
// native 档只给类，wasm 档只给工厂函数（类一个都不给）——
// 于是「代码走错分支」在测试里就是 TypeError，而不是悄悄跑成另一条路。
module.exports = WASM ? { ...FACTORIES } : { ...CLASSES }
`

  const files = {
    [`${PKG_DIR}/package.json`]: JSON.stringify({
      name: pkgName,
      version: '0.0.0-test-only',
      main: 'index.js',
      description: '测试替身：只为让识别/合成线程的加载成功路径能真跑，不做任何识别。',
    }, null, 2) + '\n',
    [`${PKG_DIR}/index.js`]: source,
  }

  let saved = null
  return {
    files,
    dir,
    markFile,
    pkgDir: PKG_DIR,
    /** 设 env：Worker 继承父进程 env，所以必须在起线程之前调用。 */
    install() {
      saved = process.env[FAKE_SHERPA_MARK_ENV] ?? null
      fs.writeFileSync(markFile, '')
      process.env[FAKE_SHERPA_MARK_ENV] = markFile
    },
    /** 还原 env（不删文件，事件还能读最后一次快照）。 */
    uninstall() {
      if (saved === null) delete process.env[FAKE_SHERPA_MARK_ENV]
      else process.env[FAKE_SHERPA_MARK_ENV] = saved
    },
    /** 读回假识别器的事件（ctor / createStream / decode / getResult / free / vad）。 */
    events() {
      let text = ''
      try {
        text = fs.readFileSync(markFile, 'utf8')
      } catch {
        return []
      }
      const out = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { out.push(JSON.parse(line)) } catch { /* 半行：还没刷进去，忽略 */ }
      }
      return out
    },
  }
}
