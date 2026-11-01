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
 *      代码必须按 kind 分支 —— 这是最容易「改一半」的地方；
 *   3. worker 线程改完之后还能正常起来、能回消息（parentPort 的改动不能弄坏它）。
 *
 * 不需要模型、不需要网络。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'

const require = createRequire(import.meta.url)
const ASR_SRC = fs.readFileSync(new URL('../lib/asr-worker.js', import.meta.url), 'utf8')
const TTS_SRC = fs.readFileSync(new URL('../lib/tts-worker.js', import.meta.url), 'utf8')

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
// 3) 源码：兜底与分支都还在（防止以后被改掉）
// ---------------------------------------------------------------------------
console.log('\n源码：兜底与 kind 分支都在')
for (const [label, src] of [['识别 worker', ASR_SRC], ['合成 worker', TTS_SRC]]) {
  check(`${label}：有「原生 → WASM」的兜底循环`,
    /for \(const name of \['sherpa-onnx-node', 'sherpa-onnx'\]\)/.test(src))
  check(`${label}：没有裸的 require('sherpa-onnx-node')`,
    !/require\('sherpa-onnx-node'\)/.test(src))
  check(`${label}：抛错文案是「未找到 sherpa-onnx（原生或 WASM）」`,
    /未找到 sherpa-onnx（原生或 WASM）/.test(src))
  check(`${label}：按 kind 分支（原生走类，WASM 走工厂函数）`,
    /if \(kind === 'native'\) \{/.test(src) && /api\.create/.test(src))
}
check('识别 worker：WASM 用工厂函数建识别器',
  /api\.createOnlineRecognizer/.test(ASR_SRC) && /api\.createOfflineRecognizer/.test(ASR_SRC))
check('识别 worker：WASM 用工厂函数建 VAD', /api\.createVad/.test(ASR_SRC))
check('识别 worker：喂音频按 kind 分支（对象 vs 位置参数）',
  /acceptWaveform\(\{ sampleRate: 16000, samples: segment\.samples \}\)/.test(ASR_SRC) &&
  /acceptWaveform\(16000, segment\.samples\)/.test(ASR_SRC))
check('合成 worker：WASM 用工厂函数建合成器', /api\.createOfflineTts/.test(TTS_SRC))
check('两个 worker 都导出 resolveSherpa（测试能直接驱动真的代码）',
  /export function resolveSherpa/.test(ASR_SRC) && /export function resolveSherpa/.test(TTS_SRC))

// ---------------------------------------------------------------------------
// 4) worker 线程还能正常起来（parentPort 的改动不能弄坏它）
// ---------------------------------------------------------------------------
console.log('\nworker 线程照常工作')

/**
 * 起一个 worker、发一条消息、等它回话。
 * @param {string} file - worker 文件名。
 * @param {object} payload - 要发的消息。
 * @returns {Promise<object>} worker 的回话。
 */
function runWorker(file, payload, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL(`../lib/${file}`, import.meta.url))
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
