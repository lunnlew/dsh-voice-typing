/**
 * 本地神经语音合成（sherpa-onnx VITS）。
 *
 * 用途：完全离线的神经网络 TTS，音质明显优于系统语音（SAPI/say/espeak），
 * 接近在线 Edge TTS 的水平，但不需要网络。
 *
 * 运行时复用识别用的 sherpa-onnx（同一份原生库），模型也共用同一套下载缓存
 * （~/.dsh/voice-typing/models），因此不额外增加依赖体积。
 *
 * 关于 GPU：
 *   实测（官方 CLI，同一模型同一参数）：
 *     CPU : RTF 0.350 —— 约 2.9 倍实时
 *     CUDA: RTF 0.283 —— 约 3.5 倍实时
 *   GPU 只快 20%，但要额外装 2GB 的 NVIDIA 运行时 DLL，
 *   而且每次初始化多花 10 秒。VITS 的解码是自回归的，GPU 并行不上。
 *   所以这里一律用 CPU，不引入 CUDA 依赖。
 *
 * @module dsh-voice-typing/neural-tts
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

/** 本文件所在目录（worker 脚本在同目录）。 */
const HERE = fileURLToPath(new URL('.', import.meta.url))

/** TTS 工作线程（合成是 CPU 密集的同步计算，不能放在宿主主线程）。 */
let ttsWorker = null
/** 工作线程的待回包任务表。 */
const ttsPending = new Map()
/** 请求序号。 */
let ttsSeq = 0

/**
 * 预加载神经 TTS 模型。
 *
 * 在后台把模型加载好，用户真正要朗读时就不用干等几十秒。
 * @param {object} paths - 模型路径 {model, lexicon, tokens}。
 * @returns {Promise<boolean>} 是否加载成功。
 */
export async function preloadNeural(paths) {
  if (!paths?.model) return false
  if (!existsSync(paths.model)) return false
  const worker = getTtsWorker()
  if (!worker) return false
  const id = ++ttsSeq
  try {
    await new Promise((resolve, reject) => {
      ttsPending.set(id, { resolve, reject })
      worker.postMessage({
        id,
        kind: 'preload',
        spec: { model: paths.model, lexicon: paths.lexicon, tokens: paths.tokens },
      })
    })
    return true
  } catch {
    return false
  }
}

/**
 * 释放神经 TTS 模型（终止工作线程，内存立刻归还）。
 * @returns {void}
 */
export function releaseNeural() {
  if (ttsWorker) {
    try { ttsWorker.terminate() } catch { /* 忽略 */ }
    ttsWorker = null
  }
  for (const [, pending] of ttsPending) {
    try { pending.reject(new Error('本地合成线程已释放。')) } catch { /* 忽略 */ }
  }
  ttsPending.clear()
}

/**
 * 取得（必要时启动）TTS 工作线程。
 * @returns {Worker|null} 工作线程。
 */
function getTtsWorker() {
  if (ttsWorker) return ttsWorker
  try {
    const worker = new Worker(join(HERE, 'tts-worker.js'))
    worker.on('message', (payload) => {
      const pending = ttsPending.get(payload?.id)
      if (!pending) return
      ttsPending.delete(payload.id)
      if (payload.ok) pending.resolve(payload)
      else pending.reject(new Error(payload.error ?? '本地合成失败。'))
    })
    worker.on('error', (error) => {
      // 线程崩了：把所有等待中的任务都拒掉，避免调用方永远挂着
      for (const [, pending] of ttsPending) pending.reject(error)
      ttsPending.clear()
    })
    worker.on('exit', () => {
      for (const [, pending] of ttsPending) pending.reject(new Error('本地合成线程已退出。'))
      ttsPending.clear()
      ttsWorker = null
    })
    // 不让 worker 阻止进程退出（与 asr-worker 一致）：
    // 插件 dispose 没被调用时，Node 事件循环会一直等着这个线程。
    worker.unref?.()
    ttsWorker = worker
    return worker
  } catch {
    return null
  }
}

/**
 * 列出模型支持的说话人。
 *
 * 说话人数是模型的固有属性，直接从档位描述里取，
 * 不用为了问一句话就把 170MB 模型加载进主线程。
 * @param {object} paths - 模型路径。
 * @param {number} [fallback] - 未知时的默认说话人数。
 * @returns {number[]} 说话人 id 列表。
 */
export function listSpeakers(paths, fallback = 1) {
  const count = Number(paths?.speakers ?? fallback) || fallback
  return Array.from({ length: count }, (_, i) => i)
}

/**
 * 用本地神经模型合成一段文本。
 *
 * @param {object} options - 合成参数。
 * @param {string} options.text - 要朗读的文本。
 * @param {object} options.paths - 模型路径 {model, lexicon, tokens}。
 * @param {number} [options.speakerId] - 说话人 id。
 * @param {number} [options.speed] - 语速倍率（1 = 正常）。
 * @returns {Promise<{audio: Float32Array, sampleRate: number}>} 音频数据。
 */
export async function synthesizeNeural(options) {
  const text = String(options?.text ?? '').trim()
  if (!text) throw new Error('要合成的文本为空。')
  const paths = options?.paths
  if (!paths?.model) throw new Error('本地神经模型未准备好，请先在设置里下载。')

  // 模型文件不在位时，sherpa-onnx 只会报一句没头没脑的
  // "Please check your config!"，这里先自己检查并给出人话提示。
  if (!existsSync(paths.model)) {
    throw new Error('本地神经模型还没下载完成，请到设置里点「下载模型」。')
  }

  // 交给工作线程合成：CPU 密集的同步计算不能占住宿主主线程
  const worker = getTtsWorker()
  if (!worker) throw new Error('无法启动本地合成线程。')

  const id = ++ttsSeq
  const result = await new Promise((resolve, reject) => {
    ttsPending.set(id, { resolve, reject })
    try {
      worker.postMessage({
        id,
        text,
        spec: {
          model: paths.model,
          lexicon: paths.lexicon,
          tokens: paths.tokens,
          speakerId: options?.speakerId ?? 0,
          speed: options?.speed ?? 1,
        },
      })
    } catch (error) {
      ttsPending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })

  const samples = result?.samples
  if (!samples || !samples.length) throw new Error('本地合成没有产生音频数据。')
  return {
    audio: Float32Array.from(samples),
    sampleRate: result.sampleRate ?? 16000,
  }
}

/**
 * 把 Float32 采样编码成 WAV（16bit PCM）。
 * 浏览器可直接播放 AudioContext 里的 WAV blob。
 *
 * @param {Float32Array} samples - 采样。
 * @param {number} sampleRate - 采样率。
 * @returns {Buffer} WAV 字节。
 */
export function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2
  const buffer = Buffer.alloc(44 + samples.length * bytesPerSample)
  // RIFF 头
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + samples.length * bytesPerSample, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // fmt chunk size
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // 单声道
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28)
  buffer.writeUInt16LE(bytesPerSample, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(samples.length * bytesPerSample, 40)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buffer.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, offset)
    offset += 2
  }
  return buffer
}

/**
 * 释放所有已加载的合成器（退出或换模型时调用）。
 */
export function disposeNeuralTts() {
  if (ttsWorker) {
    try { ttsWorker.terminate() } catch { /* 忽略 */ }
    ttsWorker = null
  }
  ttsPending.clear()
}
