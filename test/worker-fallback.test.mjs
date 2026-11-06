/**
 * worker 的「原生 → WASM」兜底测试。
 *
 * 背景（2026-10-31）：
 *   `sherpa-onnx-node`（原生 addon）被挪到 optionalDependencies ——
 *   前提就是「装不上原生包也能用」。
 *   但原生包只覆盖了部分平台（linux-musl/Alpine、linux-arm64、FreeBSD、
 *   部分 aarch64 变体都没有预编译二进制），装不上是常态而不是意外。
 *
 *   之前宿主主线程有兜底（lib/index.js 的 loadSherpa），
 *   两个 worker 线程却只有一句 `require('sherpa-onnx-node')`：
 *     - ASR 侧还能靠「worker 起不来 → 回主线程推理」兜着（但会卡 UI）；
 *     - **神经 TTS 侧完全没有退路** —— 拿不到 worker 就抛
 *       「无法启动本地合成线程」，本地神经合成直接不可用。
 *
 * 这个测试钉死三件事：
 *   1. 兜底顺序：先原生，原生装不上才用 WASM，两个都没有才报错；
 *   2. **两个包的 API 确实不一样**（构造方式、喂音频的参数形式），
 *      代码必须按 kind 分支 —— 这是最容易「改一半」的地方。
 *      批次 6g 起这一条不看源码正见了：把真 worker 放进一棵**只装有假包**的临时树里跑，
 *      判据看的是假包记下来的「到底被调的是类构造还是工厂函数、喂音频是几个参数」。
 *      批次 6l 起同一套跑法也覆盖**宿主主线程**那份 `loadSherpa`（第 3b 节）——
 *      它原来由 `test/atomic-file.test.mjs` 的一条源码正则代理（「代码里有那句循环」）。
 *   3. worker 线程改完之后还能正常起来、能回消息（parentPort 的改动不能弄坏它）。
 *
 * 不需要模型、不需要网络。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { fakeSherpa } from './helpers/fake-sherpa.mjs'
import { loadHostRoutes } from './helpers/host-routes.mjs'
import { makeReadyTier, placeTierFiles } from './helpers/fake-tier.mjs'

const require = createRequire(import.meta.url)

// 下面这两条 import 走的是 **lib/ 产物**：要验的是真会被 Worker 加载的那份文件，
// 不是源码（同 test/client-behavior.test.mjs 的分工：形状读源码、行为读产物）。
// worker 文件在主线程里 import 是安全的（parentPort 为 null 时什么都不做）。
const { resolveSherpa: resolveAsrSherpa } = await import('../lib/asr-worker.js')
const { resolveSherpa: resolveTtsSherpa } = await import('../lib/tts-worker.js')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

// ---------------------------------------------------------------------------
// 1) 兜底逻辑本身（用假的 require 驱动真的代码）
// ---------------------------------------------------------------------------
console.log('兜底顺序：原生 → WASM')

/** 假的原生包（有类，没有工厂函数）。 */
const FAKE_NATIVE = {
  OfflineRecognizer: class FakeOfflineRecognizer {},
  OnlineRecognizer: class FakeOnlineRecognizer {},
  OfflineTts: class FakeOfflineTts {},
  Vad: class FakeVad {},
}
/** 假的 WASM 包（只有工厂函数，没有类）。 */
const FAKE_WASM = {
  createOfflineRecognizer: () => ({}),
  createOnlineRecognizer: () => ({}),
  createOfflineTts: () => ({}),
  createVad: () => ({}),
}

for (const [label, resolve] of [['识别 worker', resolveAsrSherpa], ['合成 worker', resolveTtsSherpa]]) {
  {
    const calls = []
    const result = resolve((name) => { calls.push(name); return FAKE_NATIVE })
    check(`${label}：原生可用时直接用原生`, result.kind === 'native' && result.api === FAKE_NATIVE, result.kind)
    check(`${label}：先试原生`, calls[0] === 'sherpa-onnx-node', calls.join(','))
  }
  {
    const calls = []
    const result = resolve((name) => {
      calls.push(name)
      // 原生 addon 装不上时的真实报错形态。
      if (name === 'sherpa-onnx-node') throw new Error("Cannot find module 'sherpa-onnx-node'")
      return FAKE_WASM
    })
    check(`${label}：原生装不上时回落 WASM`, result.kind === 'wasm' && result.api === FAKE_WASM, result.kind)
    check(`${label}：两个包都试过`, calls.join(',') === 'sherpa-onnx-node,sherpa-onnx', calls.join(','))
  }
  {
    let thrown = null
    try {
      resolve(() => { throw new Error('这个包根本没装') })
    } catch (error) {
      thrown = error
    }
    check(`${label}：两个包都没有时抛错（不静默失败）`,
      !!thrown && /未找到 sherpa-onnx/.test(thrown.message), String(thrown?.message))
  }
  {
    // 有些打包方式会把 CJS 包包成 { default: ... }。
    const mod = { default: FAKE_NATIVE }
    const result = resolve(() => mod)
    check(`${label}：兼容 { default: ... } 形式的导出`,
      result.kind === 'native' && result.api === FAKE_NATIVE, result.kind)
  }
}

// ---------------------------------------------------------------------------
// 2) 真实的两个包：API 确实不一样（代码的分支依据）
// ---------------------------------------------------------------------------
console.log('\n真实包：原生与 WASM 的 API 差异')

let nativeApi = null
let wasmApi = null
try { nativeApi = require('sherpa-onnx-node') } catch { nativeApi = null }
try { wasmApi = require('sherpa-onnx') } catch { wasmApi = null }

check('WASM 包装着（可选依赖必须真的装得上）', !!wasmApi)
if (wasmApi) {
  check('WASM 包导出工厂函数', typeof wasmApi.createOfflineRecognizer === 'function' &&
    typeof wasmApi.createOnlineRecognizer === 'function' &&
    typeof wasmApi.createOfflineTts === 'function' &&
    typeof wasmApi.createVad === 'function')
  check('WASM 包**不**导出类（所以不能 new）',
    typeof wasmApi.OfflineRecognizer === 'undefined' &&
    typeof wasmApi.OnlineRecognizer === 'undefined' &&
    typeof wasmApi.OfflineTts === 'undefined' &&
    typeof wasmApi.Vad === 'undefined')
  check('WASM 包被正确判定成 wasm',
    resolveAsrSherpa(() => wasmApi).kind === 'wasm' &&
    resolveTtsSherpa(() => wasmApi).kind === 'wasm')
}
if (nativeApi) {
  check('原生包导出类', typeof nativeApi.OfflineRecognizer === 'function' &&
    typeof nativeApi.OnlineRecognizer === 'function' &&
    typeof nativeApi.OfflineTts === 'function' &&
    typeof nativeApi.Vad === 'function')
  check('原生包不导出工厂函数', typeof nativeApi.createOfflineRecognizer === 'undefined')
  check('原生包被正确判定成 native',
    resolveAsrSherpa(() => nativeApi).kind === 'native' &&
    resolveTtsSherpa(() => nativeApi).kind === 'native')
} else {
  console.log('  · 本机没有原生 addon，跳过原生包的断言（这正是兜底存在的理由）')
}

console.log('\n喂音频的参数形式（最容易改错的地方）')
{
  // 原生：acceptWaveform({sampleRate, samples})（对象，1 个参数）
  // WASM ：acceptWaveform(sampleRate, samples)    （位置参数，2 个参数）
  //
  // WASM 包没有导出流类（只导出 createOnlineRecognizer / OfflineRecognizer），
  // 所以那一侧只能看它的源码签名。
  let nativeArity = null
  let wasmPositional = null
  try {
    const { OfflineStream } = require('sherpa-onnx-node/non-streaming-asr.js')
    nativeArity = OfflineStream.prototype.acceptWaveform.length
  } catch { /* 包结构变了就跳过 */ }
  try {
    const indexPath = require.resolve('sherpa-onnx')
    const asrSource = fs.readFileSync(path.join(path.dirname(indexPath), 'sherpa-onnx-asr.js'), 'utf8')
    wasmPositional = /acceptWaveform\(sampleRate, samples\)/.test(asrSource)
  } catch { /* 包结构变了就跳过 */ }
  if (nativeArity !== null) {
    check('原生流是对象参数（1 个）', nativeArity === 1, String(nativeArity))
  }
  if (wasmPositional !== null) {
    check('WASM 流是位置参数（sampleRate, samples）', wasmPositional === true)
    check('两个包的喂音频参数形式确实不同（所以必须按 kind 分支）',
      nativeArity === null || nativeArity !== 2, `原生 ${nativeArity} vs WASM 2`)
  }
}

// ---------------------------------------------------------------------------
// 3) 真跑：临时树里只放一档假包，看 worker 到底走了哪条分支
// ---------------------------------------------------------------------------
console.log('\n真跑：只有假包的临时树里，worker 走的是哪条路')

/**
 * 探一次「这一档 sherpa 在树里到底是加载得出来还是加载不出来」。
 *
 * 为什么要单独探：本节一半的判据是**计数为零**那种（「一次类构造都没有」「一个工厂函数都没调」），
 * 它们成立的前提是「树里只有另一档包」。批次 15 之前这个前提由位置保证
 * （临时树在 `os.tmpdir()` 下，仓库 `node_modules` 不在查找路径上）；
 * 宿主树搬进仓库之后，前提改由 `host-copy.mjs` 的可选依赖防火墙保证，
 * 而**任何一层机制都可以过期**。漏到仓库里那份真的原生 addon 时，
 * 表现不是红而是进程当场崩（0xC0000409，无堆栈、无 stderr）——
 * 所以判据不许再引用注释当证据，自己探一次：树里加载不出来就如实报出来。
 *
 * @param {string} anchorFile - 树里那份**真正做 require 的文件**的路径（不必存在，只用它定位目录）。
 * @param {string} treeRoot - 临时树的根，解析结果落在它里面就等于「用的是树里那份替身」。
 * @param {'native'|'wasm'} kind - 这棵树里放了哪一档替身。
 * @param {object} [options] - {requireOtherAbsent}：另一档是否**必须**加载不出来。
 *   worker 那两棵树在 `os.tmpdir()` 下，靠位置就该没有；宿主树在仓库里，
 *   WASM 档必须靠防火墙挡住（兜底发生过的前提），而原生树里 WASM 档在场是**生产实况**
 *   —— 它在 `dependencies` 里，装机一定在场，且 `resolveSherpa` 先试原生、走不到它。
 * @returns {{tested: object, other: object, premise: boolean}}
 *   tested=该在场的那档，other=另一档，premise=本节判据的前提成不成立
 */
function probeSherpa(anchorFile, treeRoot, kind, { requireOtherAbsent = true } = {}) {
  const from = createRequire(anchorFile)
  const nameOf = (k) => (k === 'wasm' ? 'sherpa-onnx' : 'sherpa-onnx-node')
  const one = (k) => {
    const name = nameOf(k)
    try {
      const resolved = from.resolve(name)
      return { name, state: resolved.startsWith(treeRoot) ? 'tree' : 'outside' }
    } catch (error) {
      return { name, state: 'missing', code: String(error?.code ?? error?.message ?? error) }
    }
  }
  const tested = one(kind)
  const other = one(kind === 'wasm' ? 'native' : 'wasm')
  return {
    tested,
    other,
    premise: tested.state === 'tree' && (!requireOtherAbsent || other.state === 'missing'),
  }
}

/**
 * 起一棵「只装有假 sherpa」的临时树，树里的 worker 就是真产物（`lib/` 那两份）。
 *
 * 为什么要临时树：worker 里用的是 `createRequire(import.meta.url)`，它从**自己所在的
 * 目录**一层层往上找 `node_modules`。把 worker 拷到 `os.tmpdir()` 下的一棵树里，
 * 仓库 `node_modules` 里那份真的就不在它的查找路径上了 ——
 * 于是「树里只有 WASM 假包」就等于「原生那条路必然 MODULE_NOT_FOUND」，
 * 「兜底真的发生过」不用正则来证明，看假包记下来的事件就行。
 * 反过来，代码里要是还留着裸的 `require('sherpa-onnx-node')`，这棵树里 worker 直接起不来。
 *
 * 这一棵树**仍然**放在 `os.tmpdir()`：worker 不需要裸依赖，位置隔离就够，
 * 而位置隔离比防火墙更硬（没有「包名列表过期」这种事）。
 * 第 3b 节那棵宿主树放在仓库里（它要能解析 `msedge-tts`），隔离换了来源，
 * 所以那一节必须自己探 —— 见上面的 `probeSherpa`。
 *
 * @param {Record<string,string>} files - 要写进树里的额外文件（假包的 `node_modules/**`）。
 * @returns {string} 树目录。
 */
function makeWorkerTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worker-tree-'))
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n', 'utf8')
  for (const name of ['asr-worker.js', 'tts-worker.js']) {
    fs.copyFileSync(new URL(`../lib/${name}`, import.meta.url), path.join(dir, name))
  }
  for (const [rel, content] of Object.entries(files)) {
    const to = path.join(dir, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, content, 'utf8')
  }
  return dir
}

/** 有声音的采样（要超过 worker 的静音门限，recognize 才会真的去建识别器）。 */
const LOUD_SAMPLES = new Float32Array(1600).fill(0.1)
/** SenseVoice 那种离线档，再带上 VAD：一次 recognize 就把识别器、VAD、流全都建出来。 */
const OFFLINE_SPEC = { kind: 'sensevoice', model: 'fake-model.onnx', tokens: 'fake-tokens.txt', vad: 'fake-vad.onnx', language: 'auto' }
/** zipformer2 流式档：走的是 OnlineRecognizer / createOnlineRecognizer 那一条。 */
const STREAMING_SPEC = { kind: 'transducer', model: '', encoder: 'fake-e.onnx', decoder: 'fake-d.onnx', joiner: 'fake-j.onnx', tokens: 'fake-tokens.txt' }
const TTS_SPEC = { model: 'fake-vits.onnx', lexicon: 'fake-lex.txt', tokens: 'fake-tokens.txt' }

/**
 * 在一棵树里把两个 worker 各跑一遍（离线识别 / 流式识别 / 合成）。
 * @param {string} kind - 假包的档：'native' | 'wasm'。
 * @returns {Promise<{events: Array, offline: object, streaming: object, tts: object}>}
 */
async function runBothWorkers(kind) {
  const fake = fakeSherpa({ kind, marker: '假识别', vad: 'yield' })
  const dir = makeWorkerTree(fake.files)
  fake.install()
  try {
    const probes = probeSherpa(path.join(dir, 'asr-worker.js'), dir, kind)
    // 前提不成立就**不跑 worker**：这棵树要是能解析到仓库里那个真原生 addon，
    // 表现不是红灯而是进程当场崩（0xC0000409，无堆栈、无 stderr），整个文件一条判据都印不出来。
    // 宁可在这里摊成一条说清了名字的失败。
    if (!probes.premise) {
      const why = `本节前提不成立：${JSON.stringify(probes)}`
      return { probes, events: [], offline: { ok: false, error: why }, streaming: { ok: false, error: why }, tts: { ok: false, error: why } }
    }
    const offline = await runWorker(path.join(dir, 'asr-worker.js'),
      { id: 1, kind: 'recognize', samples: LOUD_SAMPLES, spec: OFFLINE_SPEC })
    const streaming = await runWorker(path.join(dir, 'asr-worker.js'),
      { id: 2, kind: 'recognize', samples: LOUD_SAMPLES, spec: STREAMING_SPEC })
    const tts = await runWorker(path.join(dir, 'tts-worker.js'),
      { id: 3, kind: 'synthesize', text: '说一句。', spec: TTS_SPEC })
    return { probes, events: fake.events(), offline, streaming, tts }
  } finally {
    fake.uninstall()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const wasmRun = await runBothWorkers('wasm')
{
  const of = (name) => wasmRun.events.filter((e) => e.event === name)
  const built = of('factory').map((e) => e.extra?.name).filter(Boolean)
  const ctorred = of('ctor')
  check('WASM 树：该在场的那档解析到树里的替身，另一档在树里加载不出来（下面「一次类构造都没有」的前提）',
    wasmRun.probes.tested.state === 'tree' && wasmRun.probes.other.state === 'missing',
    JSON.stringify(wasmRun.probes))
  check('WASM 树：离线识别器由工厂函数建出来（旧判据扫的是 api.createOfflineRecognizer）',
    built.includes('OfflineRecognizer'), built.join(','))
  check('WASM 树：流式识别器也由工厂函数建出来（旧判据扫的是 api.createOnlineRecognizer）',
    built.includes('OnlineRecognizer'), built.join(','))
  check('WASM 树：VAD 走 createVad（旧判据扫的是 api.createVad）',
    built.includes('Vad'), built.join(','))
  check('WASM 树：合成器走 createOfflineTts（旧判据扫的是 api.createOfflineTts）',
    built.includes('OfflineTts'), built.join(','))
  check('WASM 树：一次类构造都没发生（确实走的是 WASM 那条分支，不是「两个包都在」蒙过去的）',
    ctorred.length === 0, JSON.stringify(ctorred.slice(0, 2)))
  const feeds = of('acceptWaveform')
  check('WASM 树：喂音频是位置参数（旧判据扫的是 acceptWaveform(16000, …)）',
    feeds.length > 0 && feeds.every((e) => e.extra?.argc === 2 && e.extra?.firstType === 'number'),
    JSON.stringify(feeds.slice(0, 2)))
  check('WASM 树：离线识别真跑出了文本、流式档也是、合成真跑出了音频',
    wasmRun.offline?.ok === true && /假识别/.test(String(wasmRun.offline?.text))
    && wasmRun.streaming?.ok === true && /假识别/.test(String(wasmRun.streaming?.text))
    && wasmRun.tts?.ok === true && wasmRun.tts?.samples?.length > 0,
    JSON.stringify({ o: wasmRun.offline, s: wasmRun.streaming, t: wasmRun.tts }))
}

const nativeRun = await runBothWorkers('native')
{
  const of = (name) => nativeRun.events.filter((e) => e.event === name)
  const built = of('ctor').map((e) => e.extra?.name).filter(Boolean)
  check('原生树：该在场的那档解析到树里的替身，另一档在树里加载不出来（下面「一个工厂函数都没调」的前提）',
    nativeRun.probes.tested.state === 'tree' && nativeRun.probes.other.state === 'missing',
    JSON.stringify(nativeRun.probes))
  check('原生树：识别器/VAD/合成器都由类构造出来（原生包没有工厂函数）',
    ['OfflineRecognizer', 'OnlineRecognizer', 'Vad', 'OfflineTts'].every((n) => built.includes(n)),
    built.join(','))
  check('原生树：一个工厂函数都没调（走错分支在这里就是 TypeError，不会静默跑成另一条路）',
    of('factory').length === 0, JSON.stringify(of('factory').slice(0, 2)))
  const feeds = of('acceptWaveform')
  check('原生树：喂音频是对象参数 {sampleRate, samples}（旧判据扫的是那行字面量）',
    feeds.length > 0 && feeds.every((e) => e.extra?.argc === 1 && e.extra?.hasSampleRateKey === true),
    JSON.stringify(feeds.slice(0, 2)))
  check('原生树：识别与合成都真跑出了结果',
    nativeRun.offline?.ok === true && /假识别/.test(String(nativeRun.offline?.text))
    && nativeRun.tts?.ok === true && nativeRun.tts?.sampleRate === 22050,
    JSON.stringify({ o: nativeRun.offline, t: nativeRun.tts }))
}

{
  // 两个包都没有：必须响亮地报错，而不是把线程搞崩、也不是静默返回空结果。
  const dir = makeWorkerTree({})
  const asr = await runWorker(path.join(dir, 'asr-worker.js'),
    { id: 1, kind: 'preload', spec: OFFLINE_SPEC })
  const tts = await runWorker(path.join(dir, 'tts-worker.js'),
    { id: 2, kind: 'preload', spec: TTS_SPEC })
  fs.rmSync(dir, { recursive: true, force: true })
  check('两个包都没有：识别线程回 ok:false（线程本身没崩，错误走回包）',
    asr?.ok === false && !asr?.timeout, JSON.stringify(asr))
  check('两个包都没有：报错文案还是「未找到 sherpa-onnx（原生或 WASM）」',
    /未找到 sherpa-onnx（原生或 WASM）/.test(String(asr?.error)), String(asr?.error))
  check('两个包都没有：合成线程同样报错（神经合成没有第二条退路，只能响亮地失败）',
    tts?.ok === false && /未找到 sherpa-onnx/.test(String(tts?.error)), JSON.stringify(tts))
}

check('两个 worker 都导出了 resolveSherpa（第 1 节能直接驱动真的代码）',
  typeof resolveAsrSherpa === 'function' && typeof resolveTtsSherpa === 'function',
  `${typeof resolveAsrSherpa} / ${typeof resolveTtsSherpa}`)

// ---------------------------------------------------------------------------
// 3b) 宿主**主线程**那份兜底（批次 6l：atomic-file 里旧判据扫的就是那一句 for 循环）
// ---------------------------------------------------------------------------
console.log('\n真跑：宿主主线程的 loadSherpa 也走同一套兜底')

/**
 * 起一棵「真宿主 + 只装一档假包」的临时树，把主线程识别跑一遍。
 *
 * 为什么单独一节：worker 那两节证的是 `asr-worker.js` / `tts-worker.js` 里的兜底，
 * 而主线程还有一份**同样的**逻辑（`src/host/index.js` 的 `loadSherpa`）。
 * 原来它靠 `test/atomic-file.test.mjs` 里一条正则证明「代码里有那一句循环」，
 * 于是循环在、分支坏掉时不会红 —— 这里改成把宿主真装起来、真识别，
 * 看假包记到的到底是工厂函数还是类构造、喂音频是几个参数。
 *
 * @param {'native'|'wasm'} kind - 临时树里那唯一一档假包的档。
 * @returns {Promise<{probes: object, runs: Array<{id:string, res:object, events:Array}>, events: Array}>}
 */
async function runMainThread(kind) {
  const onlineTier = makeReadyTier('wf-6l-online', { engine: 'online', repo: 'fake-repo/wf-6l-online' })
  const offlineTier = makeReadyTier('wf-6l-offline', { engine: 'whisper', repo: 'fake-repo/wf-6l-offline' })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worker-fallback-main-'))
  placeTierFiles(home, onlineTier.tier, onlineTier.bodies)
  placeTierFiles(home, offlineTier.tier, offlineTier.bodies)
  const fake = fakeSherpa({ kind, marker: '假识别' })
  fake.install()
  const runs = []
  let allEvents = []
  let probes = null
  let env = null
  try {
    env = await loadHostRoutes({
      dshHome: home,
      appendAsrTiers: [onlineTier.tier, offlineTier.tier],
      rowConfig: { model: onlineTier.tier.id, preloadModels: false },
      extraTreeFiles: fake.files,
    })
    // 锚点用 `<base>/host/index.js`：主线程那份 loadSherpa 就住在这个目录里，
    // 从别的目录探会得到另一套查找路径，判的就不是同一件事了。
    probes = probeSherpa(path.join(env.dir, 'host', 'index.js'), env.dir, kind,
      { requireOtherAbsent: kind === 'wasm' })
    // 同 worker 那节：前提不成立就不驱动识别。漏到仓库那份真 addon 时，
    // 「识别器加载失败」在这里不是返回值，而是整个测试进程没了。
    if (!probes.premise) return { probes, runs, events: [] }
    // 每次识别之前记一个游标：两次调用喂音频的形状不一样（流式带采样率，离线只给采样），
    // 混在一份事件流里就没法分开判。
    for (const tier of [onlineTier, offlineTier]) {
      const mark = fake.events().length
      // 认不出来就如实摊成一次「跑了但抛错」，不许让整个文件挂在这里：
      // 分支走错时这里得到的是 TypeError，判据要能把它报成一条红，而不是崩栈。
      let res = null
      let error = null
      try {
        res = await env.mod.recognizeWithSherpa(tier.tier, LOUD_SAMPLES, { language: 'zh' })
      } catch (e) {
        error = String(e?.message ?? e)
      }
      runs.push({ id: tier.tier.id, engine: tier.tier.engine, res, error, events: fake.events().slice(mark) })
    }
    // 整份事件流必须在**拆树之前**读：假包的事件文件就写在那棵树里，
    // 拆完再读只会得到空数组，「一次类构造都没有」那一条就变成空转（本轮实测踩过）。
    allEvents = fake.events()
  } finally {
    if (env) env.restore()
    fake.uninstall()
    for (const dir of [home, fake.dir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch { /* 清理失败不算判据失败 */ }
    }
  }
  return { probes, runs, events: allEvents }
}

const mainWasm = await runMainThread('wasm')
{
  // 防空转：下面「一次类构造都没有」「一个工厂函数都没调」这两条是**计数为零**的判据，
  // 事件流为空时它们会照样绿。所以先把「假包确实记到账」钉住 ——
  // 它为零有两种成因：脚手架没读到（本轮开发时踩过一次，拆树后读文件必然为空），
  // 或者识别器根本没被建出来（分支走错、构造前就抛错）。两种都该红。
  check('主线程·WASM 树：假包记到了账（为零 = 要么脚手架没读到，要么识别器根本没建起来）',
    mainWasm.events.length > 0, `实际 ${mainWasm.events.length} 条`)
  // 这两条是上面那些「计数为零」判据的**前提**，所以单独探：宿主树搬进仓库之后，
  // 「另一档加载不出来」不再由位置保证，改由 host-copy.mjs 的可选依赖防火墙保证，
  // 而防火墙一旦漏名字，这里得到的不是红而是进程崩（批次 15 实测 0xC0000409）。
  check('主线程·WASM 树：原生 addon 在这棵树里确实加载不出来（兜底真的发生过，不是被仓库那份真包满足了）',
    mainWasm.probes.other.state === 'missing', JSON.stringify(mainWasm.probes.other))
  check('主线程·WASM 树：WASM 档解析到的是树里那份替身（判据看到的工厂函数确实出自替身）',
    mainWasm.probes.tested.state === 'tree', JSON.stringify(mainWasm.probes.tested))
  const namesOf = (run) => [...new Set((run?.events ?? []).filter((e) => e.event === 'factory').map((e) => e.extra?.name))]
  const online = mainWasm.runs.find((r) => r.engine === 'online')
  const offline = mainWasm.runs.find((r) => r.engine !== 'online')
  check('主线程·WASM 树：流式档的识别器由 createOnlineRecognizer 建出来（旧判据只能证明那句循环在）',
    namesOf(online).includes('OnlineRecognizer'), namesOf(online).join(','))
  check('主线程·WASM 树：离线档由 createOfflineRecognizer 建出来',
    namesOf(offline).includes('OfflineRecognizer'), namesOf(offline).join(','))
  check('主线程·WASM 树：一次类构造都没有（走错分支在这里就是 TypeError，不会静默跑成另一条路）',
    mainWasm.events.filter((e) => e.event === 'ctor').length === 0,
    JSON.stringify(mainWasm.events.filter((e) => e.event === 'ctor').slice(0, 2)))
  const onlineFeeds = (online?.events ?? []).filter((e) => e.event === 'acceptWaveform')
  check('主线程·WASM 树：流式档喂音频是位置参数 (16000, samples)',
    onlineFeeds.length > 0 && onlineFeeds.every((e) => e.extra?.argc === 2 && e.extra?.firstType === 'number'),
    JSON.stringify(onlineFeeds.slice(0, 2)))
  const offlineFeeds = (offline?.events ?? []).filter((e) => e.event === 'acceptWaveform')
  check('主线程·WASM 树：离线档喂音频只给采样（一个参数）',
    offlineFeeds.length > 0 && offlineFeeds.every((e) => e.extra?.argc === 1),
    JSON.stringify(offlineFeeds.slice(0, 2)))
  check('主线程·WASM 树：两个档都真跑出了识别文本（兜底不是死代码，是会被用户撞上的那条路）',
    !online?.error && !offline?.error
    && /假识别/.test(String(online?.res?.text)) && /假识别/.test(String(offline?.res?.text)),
    JSON.stringify({ online: online?.res ?? online?.error, offline: offline?.res ?? offline?.error }))
}

const mainNative = await runMainThread('native')
{
  check('主线程·原生树：假包记到了账（同一份脚手架，另一档包；「一个工厂函数都没调」要靠这条才不是空转）',
    mainNative.events.length > 0, `实际 ${mainNative.events.length} 条`)
  // 另一档（WASM）在这棵树里在场与否**不影响**本节判据：`resolveSherpa` 先试原生，
  // 原生命中就不会走到它。所以原生树只探「命中的是替身还是仓库那份真 addon」这一条。
  check('主线程·原生树：原生档解析到的是树里那份替身（不是仓库 node_modules 里那个真 addon）',
    mainNative.probes.tested.state === 'tree', JSON.stringify(mainNative.probes.tested))
  const namesOf = (run) => [...new Set((run?.events ?? []).filter((e) => e.event === 'ctor').map((e) => e.extra?.name))]
  const online = mainNative.runs.find((r) => r.engine === 'online')
  const offline = mainNative.runs.find((r) => r.engine !== 'online')
  check('主线程·原生树：识别器由类构造出来（同一份代码、另一档包，分支确实跟着包走）',
    namesOf(online).includes('OnlineRecognizer') && namesOf(offline).includes('OfflineRecognizer'),
    JSON.stringify({ online: namesOf(online), offline: namesOf(offline) }))
  check('主线程·原生树：一个工厂函数都没调',
    mainNative.events.filter((e) => e.event === 'factory').length === 0,
    JSON.stringify(mainNative.events.filter((e) => e.event === 'factory').slice(0, 2)))
  const feeds = mainNative.events.filter((e) => e.event === 'acceptWaveform')
  check('主线程·原生树：喂音频是对象参数 {sampleRate, samples}',
    feeds.length > 0 && feeds.every((e) => e.extra?.argc === 1 && e.extra?.hasSampleRateKey === true),
    JSON.stringify(feeds.slice(0, 2)))
  check('主线程·原生树：识别照样跑出文本',
    !online?.error && !offline?.error
    && /假识别/.test(String(online?.res?.text)) && /假识别/.test(String(offline?.res?.text)),
    JSON.stringify({ online: online?.res ?? online?.error, offline: offline?.res ?? offline?.error }))
}

// ---------------------------------------------------------------------------
// 4) worker 线程还能正常起来（parentPort 的改动不能弄坏它）
// ---------------------------------------------------------------------------
console.log('\nworker 线程照常工作')

/**
 * 起一个 worker、发一条消息、等它回话。
 * @param {string} target - `lib/` 下的文件名，或临时树里 worker 的绝对路径。
 * @param {object} payload - 要发的消息。
 * @returns {Promise<object>} worker 的回话。
 */
function runWorker(target, payload, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const worker = new Worker(
      path.isAbsolute(target) ? target : new URL(`../lib/${target}`, import.meta.url),
    )
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate().catch(() => {})
      resolve(value)
    }
    const timer = setTimeout(() => finish({ timeout: true }), timeoutMs)
    worker.on('message', (msg) => finish(msg))
    worker.on('error', (error) => finish({ error: error?.message ?? String(error) }))
    worker.postMessage(payload)
  })
}

{
  // 空采样：worker 直接返回「没有语音」，不需要模型、不需要 sherpa。
  const reply = await runWorker('asr-worker.js', {
    id: 1,
    kind: 'recognize',
    samples: new Float32Array(0),
    spec: {},
  })
  check('识别 worker 能起来并回话',
    reply && reply.ok === true && reply.id === 1 && reply.text === '' && reply.speech === false,
    JSON.stringify(reply))
}
{
  // 空文本：合成 worker 直接返回空音频，同样不需要模型。
  const reply = await runWorker('tts-worker.js', {
    id: 2,
    kind: 'synthesize',
    text: '',
    spec: {},
  })
  check('合成 worker 能起来并回话',
    reply && reply.ok === true && reply.id === 2 && Array.isArray(reply.samples) && reply.samples.length === 0,
    JSON.stringify(reply))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
