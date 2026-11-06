/**
 * 神经 TTS 工作线程。
 *
 * 为什么要单独一个线程：
 *   VITS 的解码是 CPU 密集的同步计算（实测 RTF 约 0.35，
 *   一句 30 字就要占住主线程 1 秒）。直接放在宿主主线程里跑，
 *   整个 DSH 界面会卡住、SSE 心跳延迟、其它插件全部排队。
 *   识别那条链路早就用 asr-worker.js 解决了，合成这条不能漏。
 *
 * 协议与识别 worker 一致：
 *   主线程 → { id, spec, text }，spec 含模型路径、说话人、语速
 *   worker  → { id, ok: true, samples, sampleRate } 或 { id, ok: false, error }
 *
 * sherpa-onnx 的**原生 addon 装不上时必须能退化到 WASM**：
 * 原生包只覆盖了部分平台（linux-musl/Alpine、linux-arm64、FreeBSD、
 * 部分 aarch64 变体都没有预编译二进制），所以本文件用 resolveSherpa()
 * 做「原生 → WASM」兜底。两个包的 API 差异见 resolveSherpa 的注释。
 */
import { parentPort } from 'node:worker_threads'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 已创建的合成器实例（按模型路径缓存，避免反复加载 170MB 模型）。 */
const instances = new Map()

/**
 * 载入 sherpa-onnx：优先原生 addon（多线程、更快），回落 WASM 包。
 *
 * **两个包的 API 不完全一样**：
 *   - 原生（sherpa-onnx-node）：导出类，`new api.OfflineTts(config)`；
 *   - WASM（sherpa-onnx）：只有工厂函数，`api.createOfflineTts(config)`。
 * 配置文件结构（model.vits / lexicon / tokens / maxNumSentences …）两者**一致**，
 * `generate({text, sid, speed})` 的参数与返回值（{samples, sampleRate}）也一致。
 *
 * 判定「原生还是 WASM」必须看**有没有类**：
 * WASM 包也导出 `createOfflineTts`，用「或」判断会把 WASM 误判成原生，
 * 然后 `new api.OfflineTts(...)` 直接 TypeError。
 * （这里用 OfflineTts 判定：原生包导出这个类，WASM 包不导出任何类。）
 *
 * 这一条兜底尤其重要：神经合成**没有第二条退路** ——
 * 宿主主线程的 getTtsWorker() 拿不到 worker 就直接抛「无法启动本地合成线程」。
 *
 * @param {Function} requireFn - require 实现（单独传进来是为了能测）。
 * @returns {{api: object, kind: 'native'|'wasm'}} 载入结果。
 * @throws 两个包都不可用时抛错。
 */
export function resolveSherpa(requireFn) {
  let lastError = null
  for (const name of ['sherpa-onnx-node', 'sherpa-onnx']) {
    try {
      const mod = requireFn(name)
      const api = mod?.default ?? mod
      if (!api) throw new Error('模块没有导出任何东西')
      const kind = typeof api.OfflineTts === 'function' ? 'native' : 'wasm'
      return { api, kind }
    } catch (error) {
      // 试下一个（原生 addon 在很多平台上没有预编译二进制，会抛 MODULE_NOT_FOUND）。
      lastError = error
    }
  }
  const detail = lastError?.message ? `：${lastError.message.split('\n')[0]}` : ''
  throw new Error(`未找到 sherpa-onnx（原生或 WASM）${detail}`)
}

/** 已载入的 sherpa-onnx（带缓存）。 */
let sherpa = null

/**
 * 载入 sherpa-onnx（带缓存）。
 * @returns {{api: object, kind: 'native'|'wasm'}} 载入结果。
 */
function loadSherpa() {
  if (!sherpa) {
    sherpa = resolveSherpa(require)
  }
  return sherpa
}

/**
 * 取得（必要时创建）合成器实例。
 * @param {object} paths - 模型路径 {model, lexicon, tokens}。
 * @returns {object} OfflineTts 实例。
 */
function getInstance(paths) {
  const key = paths.model
  if (instances.has(key)) return instances.get(key)
  const { api, kind } = loadSherpa()
  const vits = {
    model: paths.model,
    lexicon: paths.lexicon,
    tokens: paths.tokens,
  }
  const config = {
    model: { vits },
    // 逐句合成：一次只合成一句，避免长文本被切成多段产生停顿
    maxNumSentences: 1,
    numThreads: 4,
    provider: 'cpu',
    debug: 0,
  }
  // 原生包导出类，WASM 包只有工厂函数。
  let tts
  if (kind === 'native') {
    tts = new api.OfflineTts(config)
  } else {
    if (typeof api.createOfflineTts !== 'function') {
      throw new Error('sherpa-onnx（WASM）缺少合成器工厂函数')
    }
    tts = api.createOfflineTts(config)
  }
  instances.set(key, tts)
  return tts
}

/**
 * 合成一段文本。
 * @param {object} payload - { id, spec, text }。
 */
async function synthesize(payload) {
  const text = String(payload.text ?? '').trim()
  if (!text) return { samples: [], sampleRate: 16000 }
  const spec = payload.spec ?? {}
  const paths = {
    model: spec.model,
    lexicon: spec.lexicon,
    tokens: spec.tokens,
  }
  const tts = getInstance(paths)
  // generate 的参数与返回值两个包**一致**：
  // 原生读 {text, sid, speed, enableExternalBuffer}，
  // WASM 只读 {text, sid, speed}（多余的键会被忽略，它本来就总是把采样拷进 JS）。
  const result = tts.generate({
    text,
    sid: spec.speakerId ?? 0,
    speed: spec.speed ?? 1,
    // Electron 里不允许外部缓冲
    enableExternalBuffer: false,
  })
  const samples = result?.samples
  if (!samples || !samples.length) throw new Error('本地合成没有产生音频数据。')
  return {
    samples: Array.from(samples),
    sampleRate: result.sampleRate ?? tts.sampleRate ?? 16000,
  }
}

/**
 * 预加载模型（把 170MB 的 VITS 模型读进内存）。
 * 用途：用户在设置里选了本地神经模型后，后台先加载好，
 * 真正要朗读时就不用等几十秒。
 */
function preload(payload) {
  const spec = payload?.spec ?? {}
  const paths = { model: spec.model, lexicon: spec.lexicon, tokens: spec.tokens }
  getInstance(paths)
  return { preloaded: true }
}

// parentPort 只在 worker 线程里有值；主线程里 import 这个文件时是 null。
// 用可选链：这样测试可以直接 import 本文件测纯函数，不必起线程。
parentPort?.on?.('message', (payload) => {
  if (!payload) return
  if (payload.kind === 'preload') {
    try {
      const result = preload(payload)
      parentPort.postMessage({ id: payload.id, ok: true, ...result })
    } catch (error) {
      parentPort.postMessage({
        id: payload.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }
  synthesize(payload)
    .then((result) => parentPort.postMessage({ id: payload.id, ok: true, ...result }))
    .catch((error) => parentPort.postMessage({
      id: payload.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
})
