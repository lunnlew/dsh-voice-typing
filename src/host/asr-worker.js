/**
 * 识别工作线程（ASR worker）。
 *
 * 识别（SenseVoice / Whisper / zipformer2）是 CPU 密集的同步计算。
 * 放在宿主主线程里跑，会把整个应用卡住 0.5~3 秒 ——
 * 界面无响应、其它请求排队，表现为「识别延迟超高」。
 * 放进独立线程后，主线程始终可响应。
 *
 * 模型在 worker 内缓存复用：第一次加载慢，之后每次都很快。
 * 协议：主线程 → {id, kind, spec, samples}，worker → {id, ok, ...}。
 *
 * sherpa-onnx 的**原生 addon 装不上时必须能退化到 WASM**：
 * 原生包只覆盖了部分平台（linux-musl/Alpine、linux-arm64、FreeBSD、
 * 部分 aarch64 变体都没有预编译二进制），所以本文件用 resolveSherpa()
 * 做「原生 → WASM」兜底。两个包的 API 差异见 resolveSherpa 的注释。
 */
import { parentPort } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { decodeOnlineStream } from './decode-steps.js'

const require = createRequire(import.meta.url)

/** 已创建的识别器（按档位缓存）。 */
const recognizers = new Map()

/** 已创建的 VAD（按模型路径缓存）。 */
const vads = new Map()
/** 能量门限：低于这个值视为静音。 */
const SILENCE_RMS = 0.008

let sherpa = null

/**
 * 载入 sherpa-onnx：优先原生 addon（多线程、更快），回落 WASM 包。
 *
 * **两个包的 API 不完全一样**，所以必须记下用的是哪一种：
 *
 *   |                | 原生 sherpa-onnx-node       | WASM sherpa-onnx              |
 *   |----------------|-----------------------------|-------------------------------|
 *   | 识别器         | `new api.OfflineRecognizer()`| `api.createOfflineRecognizer()`|
 *   | 流式识别器     | `new api.OnlineRecognizer()` | `api.createOnlineRecognizer()`|
 *   | VAD            | `new api.Vad()`              | `api.createVad()`              |
 *   | 喂音频         | `stream.acceptWaveform({sampleRate, samples})` | `stream.acceptWaveform(sampleRate, samples)` |
 *
 *   配置文件结构（featConfig / modelConfig / tokens / numThreads …）两者**一致**。
 *   解码流程（isReady → decode → inputFinished → getResult）两者也一致。
 *
 * 判定「原生还是 WASM」必须看**有没有类**：
 * WASM 包也导出 `createOfflineRecognizer`，用「或」判断会把 WASM 误判成原生，
 * 然后 `new api.OfflineRecognizer(...)` 直接 TypeError。
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
      const kind = typeof api.OfflineRecognizer === 'function' ? 'native' : 'wasm'
      return { api, kind }
    } catch (error) {
      // 试下一个（原生 addon 在很多平台上没有预编译二进制，会抛 MODULE_NOT_FOUND）。
      lastError = error
    }
  }
  const detail = lastError?.message ? `：${lastError.message.split('\n')[0]}` : ''
  throw new Error(`未找到 sherpa-onnx（原生或 WASM）${detail}`)
}

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
 * 计算 RMS 能量。
 * @param {Float32Array} samples - 采样。
 * @returns RMS。
 */
function rmsOf(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

/**
 * 用 Silero VAD 切出语音段。
 * @param {object} vad - VAD 实例。
 * @param {Float32Array} samples - 采样。
 * @returns 语音段数组。
 */
function segmentByVad(vad, samples) {
  if (!vad) return [{ samples, start: 0 }]
  const segments = []
  const drain = () => {
    while (!vad.isEmpty()) {
      // front(false) = 「不要外部缓冲，把采样拷进 JS」。
      // 原生包有这个参数；WASM 包没有这个参数（它本来就总是拷贝），
      // 多传一个实参会被忽略 —— 两边的结果一致，不用分支。
      const segment = vad.front(false)
      segments.push({
        samples: new Float32Array(segment.samples),
        start: typeof segment.start === 'number' ? segment.start : 0,
      })
      vad.pop()
    }
  }
  try {
    vad.reset?.()
    for (let offset = 0; offset < samples.length; offset += 512) {
      vad.acceptWaveform(samples.subarray(offset, offset + 512))
      drain()
    }
    vad.flush?.()
    drain()
  } catch {
    return [{ samples, start: 0 }]
  }
  return segments
}

/**
 * 识别器的缓存键。
 * @param {object} spec - 档位描述。
 * @returns {string} 缓存键。
 */
function recognizerKey(spec) {
  return spec.model + '|' + (spec.encoder ?? '') + '|' + (spec.language ?? 'auto')
}

/**
 * 取得（或创建）离线识别器。
 * @param {object} spec - 档位描述：{ model, encoder, decoder, joiner, tokens, vad, language, kind }。
 * @returns 识别器实例。
 */
function getRecognizer(spec) {
  // 语言也要进缓存键：否则改了「识别语言」后，worker 还在用旧语言的识别器。
  const key = recognizerKey(spec)
  if (recognizers.has(key)) return recognizers.get(key)
  const { api, kind } = loadSherpa()
  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: spec.model,
        language: spec.language && spec.language !== 'auto' ? spec.language : 'auto',
        useInverseTextNormalization: 1,
      },
      tokens: spec.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  }
  if (spec.kind === 'transducer') {
    // transducer（zipformer2）是流式模型：
    //   必须用 OnlineRecognizer（不是 OfflineRecognizer），
    //   解码要用 isReady/decode 的循环，最后 inputFinished。
    // 用错类别会让 sherpa 的原生代码直接终止进程（整个桌面应用退出），
    // 所以这里严格按流式模型的用法来。
    config.modelConfig = {
      transducer: {
        encoder: spec.encoder,
        decoder: spec.decoder,
        joiner: spec.joiner,
      },
      tokens: spec.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
      decodingMethod: 'greedy_search',
    }
  }
  if (spec.kind === 'whisper') {
    config.modelConfig = {
      whisper: { encoder: spec.encoder, decoder: spec.decoder },
      tokens: spec.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    }
  }
  let recognizer
  if (kind === 'native') {
    // 原生包导出类。
    const Ctor = spec.kind === 'transducer' ? api.OnlineRecognizer : api.OfflineRecognizer
    recognizer = new Ctor(config)
  } else {
    // WASM 包**没有类**，只有工厂函数。
    const factory = spec.kind === 'transducer' ? api.createOnlineRecognizer : api.createOfflineRecognizer
    if (typeof factory !== 'function') {
      throw new Error('sherpa-onnx（WASM）缺少识别器工厂函数')
    }
    recognizer = factory(config)
  }
  recognizers.set(key, recognizer)
  return recognizer
}

/**
 * 取得（或创建）VAD。
 * @param {object} spec - 档位描述。
 * @returns VAD 实例或 null。
 */
function getVad(spec) {
  if (!spec.vad) return null
  if (vads.has(spec.vad)) return vads.get(spec.vad)
  const { api, kind } = loadSherpa()
  const config = {
    sileroVad: {
      model: spec.vad,
      threshold: 0.5,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 20,
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: 30,
  }
  // 原生包导出类，WASM 包只有工厂函数。
  const vad = kind === 'native' ? new api.Vad(config) : api.createVad(config)
  vads.set(spec.vad, vad)
  return vad
}

/**
 * 识别一段音频。
 * @param {object} payload - { id, spec, samples }。
 * @returns {Promise<{text: string, speech: boolean}>}。
 */
async function recognize(payload) {
  const samples = payload.samples
  if (!samples || samples.length === 0) return { text: '', speech: false }
  if (rmsOf(samples) < SILENCE_RMS) return { text: '', speech: false }
  const spec = payload.spec
  const { kind } = loadSherpa()
  const vad = getVad(spec)
  const segments = segmentByVad(vad, samples)
  const speech = vad ? segments.some((s) => s.samples.length > 0) : true
  if (!speech) return { text: '', speech: false }
  const recognizer = getRecognizer(spec)
  const texts = []
  for (const segment of segments) {
    if (!segment.samples.length) continue
    // 热词提示：只有 transducer 档位支持，格式「词 :权重」，多个用 / 分隔。
    const hotwords = Array.isArray(spec.hotwords) ? spec.hotwords.filter(Boolean) : []
    const isStreaming = spec.kind === 'transducer'
    const stream = hotwords.length && isStreaming
      ? recognizer.createStream(hotwords.map((w) => `${w} :2.0`).join('/'))
      : recognizer.createStream()
    try {
      // 喂音频：**两个包的参数形式不一样**（见 resolveSherpa 的表格），
      // 喂错了要么静默没结果，要么直接崩。
      if (kind === 'native') {
        stream.acceptWaveform({ sampleRate: 16000, samples: segment.samples })
      } else {
        stream.acceptWaveform(16000, segment.samples)
      }
      if (isStreaming) {
        // 流式模型的解码方式：一直解到「不够解了」为止，再收尾。
        // 循环与上限走那一处实现（src/host/decode-steps.js，批次 6k）——
        // 这里原先是**裸 while 没有上限**：decode 不推进状态时识别线程被自己卡死，
        // 而 recognizeInWorker 的等待没有超时，那条 /transcribe 就永远不回话。
        decodeOnlineStream(recognizer, stream)
        stream.inputFinished?.()
      } else {
        recognizer.decode(stream)
      }
      const text = String(recognizer.getResult(stream).text ?? '').trim()
      if (text) texts.push(text)
    } finally {
      try { stream.free?.() } catch { /* 忽略 */ }
    }
  }
  return { text: texts.join(' ').trim(), speech: true }
}

/**
 * 预加载一个识别器（把模型读进内存）。
 *
 * 用途：用户在设置里启用某个模型后，后台先把模型加载好，
 * 这样真正开始说话时不用干等几十秒。
 */
function preload(payload) {
  const spec = payload?.spec
  if (!spec) throw new Error('preload 缺少 spec')
  getRecognizer(spec)
  return { preloaded: true }
}

/**
 * 释放识别器（把模型从线程内存里踢掉）。
 *
 * 宿主按 recognizerKey(spec) 的同样算法算出 key 再发过来，
 * 所以两边必须用完全一样的缓存键，否则永远命中不了。
 *
 * 支持 `keyPrefix`：同一个模型可能因为语言提示不同而缓存了多份识别器
 *（例如配置 auto 与待机强制 zh 各一份）。空闲释放必须按「模型」整组释放，
 * 否则只释放配置语言那一份，其它语言的副本会一直占着内存。
 *
 * @param {object} payload - {key?, keyPrefix?}。
 * @returns {{released: boolean, releasedCount?: number}} 是否释放成功。
 */
function release(payload) {
  const prefix = typeof payload?.keyPrefix === 'string' ? payload.keyPrefix : ''
  if (prefix) {
    let releasedCount = 0
    for (const [key, entry] of [...recognizers]) {
      if (!key.startsWith(prefix)) continue
      recognizers.delete(key)
      // recognizers 里存的就是识别器本身，所以直接调它的 free()。
      try {
        entry.free?.()
      } catch { /* 忽略 */ }
      releasedCount += 1
    }
    return { released: releasedCount > 0, releasedCount }
  }
  const key = payload?.key
  const entry = recognizers.get(key)
  if (!entry) return { released: false }
  recognizers.delete(key)
  // recognizers 里存的就是识别器本身，所以直接调它的 free()。
  try {
    entry.free?.()
  } catch { /* 忽略 */ }
  return { released: true }
}

// parentPort 只在 worker 线程里有值；主线程里 import 这个文件时是 null。
// 用可选链：这样测试可以直接 import 本文件测纯函数，不必起线程。
parentPort?.on?.('message', (payload) => {
  if (!payload) return
  if (payload.kind === 'recognize') {
    recognize(payload)
      .then((result) => parentPort.postMessage({ id: payload.id, ok: true, ...result }))
      .catch((error) => parentPort.postMessage({ id: payload.id, ok: false, error: error?.message ?? String(error) }))
    return
  }
  if (payload.kind === 'preload') {
    try {
      const result = preload(payload)
      parentPort.postMessage({ id: payload.id, ok: true, ...result })
    } catch (error) {
      parentPort.postMessage({ id: payload.id, ok: false, error: error?.message ?? String(error) })
    }
    return
  }
  if (payload.kind === 'release') {
    try {
      const result = release(payload)
      parentPort.postMessage({ id: payload.id, ok: true, ...result })
    } catch (error) {
      parentPort.postMessage({ id: payload.id, ok: false, error: error?.message ?? String(error) })
    }
  }
})
