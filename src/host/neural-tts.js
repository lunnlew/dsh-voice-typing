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
/**
 * 每条线程自己的待回包任务表。
 *
 * **为什么按线程分桶、不用一张全局表**：`exit` / `error` 事件说的是「这一条线程没了」，
 * 可它到达的时刻已经隔了半个事件循环 —— 拆掉卡住的那条之后驱动会立刻重建并接上新的请求，
 * 旧线程那条迟到的 `exit` 若照着一张全局表清，就会把**新线程上正在等的那一句**一起拒掉
 * （实测：第二次拿到的是「本地合成线程已退出」，而不是它该等的上限），
 * 还会顺手把 `ttsWorker` 槽位清空 —— 槽位上那条新线程其实活得好好的。
 */
const workerPending = new WeakMap()
/** 请求序号。 */
let ttsSeq = 0

/**
 * 一次问话最多等多久（毫秒）。
 *
 * **为什么要这个上限**：线程有三种结束方式（回包、`error`、`exit`），这三种都会把等待者叫醒；
 * 但「线程活着、这一次合成就是不回话」没有出口 —— 那个 Promise 永远不 settle，
 * `/tts` 就一直 pending，客户端那句超时之后用户看到的是**彻底没声音**，
 * 连 `stats.neuralTtsFailures` 都不会涨（实测：假线程不回话，8 秒观察窗口到点仍无结果）。
 * 这是批次 8（超限必须有回执）与批次 11（线程死了要告知等待者）的同一族，缺的是「卡住」这一档。
 *
 * **为什么必须早于客户端的单句合成超时**：那条上限住在
 * `src/client/pure/voice-constants.js` 的 `TTS_TIMEOUT_MS`（数字只有那一处，这里不复述）。
 * 客户端先走、宿主这边还在等，等待者拿不到任何错误，界面只能显示静音。
 *
 * 判据在 `test/neural-worker-exit.test.mjs`（真起子进程 + 永不回话的假线程）。
 */
export const NEURAL_WAIT_TIMEOUT_MS = 20000

/**
 * 把某条线程拆掉、只通知还在这条线程上等回包的调用方。
 *
 * 卡住的线程留着没有用：sherpa 那次合成是同步的，它占着线程，后面每一句都得再等满
 * `NEURAL_WAIT_TIMEOUT_MS`。拆掉之后 `getTtsWorker()` 会在下一次请求时重建一份，
 * 代价是那一次要重新加载模型 —— 比「整个会话再也读不出声」小。
 * @param {Worker} stuckWorker - 要拆掉的线程（通常是当前在任的那条）。
 * @param {Error} reason - 给这条线程上还在等的那些调用方的错误。
 * @returns {void}
 */
function retireStuckWorker(stuckWorker, reason) {
  // 槽位只在「卡住的这条就是在任的那条」时清：否则会把后来接班的线程误说成没有了。
  if (ttsWorker === stuckWorker) ttsWorker = null
  const pending = workerPending.get(stuckWorker)
  const waiting = pending ? [...pending.values()] : []
  if (pending) pending.clear()
  try { stuckWorker.terminate() } catch { /* 忽略：拆不掉也只是线程自己会结束 */ }
  for (const entry of waiting) {
    try { entry.reject(reason) } catch { /* 忽略 */ }
  }
}

/**
 * 给工作线程发一条消息并等回包 —— 两个调用点（预加载、合成）共用这一条等待语义。
 *
 * @param {Worker} worker - 工作线程。
 * @param {object} message - 要发的载荷（不含 `id`，这里自己编号）。
 * @param {string} label - 出错文案里那句「这一件事」（「预加载本地神经模型」/「合成这一句」）。
 * @returns {Promise<object>} 线程的回包。
 */
function askTtsWorker(worker, message, label) {
  const id = ++ttsSeq
  return new Promise((resolve, reject) => {
    // 这张表由 `getTtsWorker()` 在造线程时一起挂上：调用方拿到的线程必然带着它。
    const pending = workerPending.get(worker)
    let timer = null
    const stopWaiting = () => {
      if (timer) clearTimeout(timer)
      pending.delete(id)
    }
    pending.set(id, {
      resolve: (payload) => { stopWaiting(); resolve(payload) },
      reject: (error) => { stopWaiting(); reject(error) },
    })
    timer = setTimeout(() => {
      pending.delete(id)
      const stuck = new Error(
        `${label}等了 ${Math.round(NEURAL_WAIT_TIMEOUT_MS / 1000)} 秒还没有结果（本地合成线程没有回话）。`)
      retireStuckWorker(worker, stuck)
      reject(stuck)
    }, NEURAL_WAIT_TIMEOUT_MS)
    // 不按住进程（同批次 11）：宿主停用之后不该为一条等回包的定时器最多干等这个上限。
    timer.unref?.()
    try {
      worker.postMessage({ id, ...message })
    } catch (error) {
      stopWaiting()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

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
  try {
    await askTtsWorker(worker, {
      kind: 'preload',
      spec: { model: paths.model, lexicon: paths.lexicon, tokens: paths.tokens },
    }, '预加载本地神经模型')
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
  const worker = ttsWorker
  ttsWorker = null
  if (worker) {
    try { worker.terminate() } catch { /* 忽略 */ }
  }
  const pending = worker ? workerPending.get(worker) : null
  if (!pending) return
  for (const [, entry] of pending) {
    try { entry.reject(new Error('本地合成线程已释放。')) } catch { /* 忽略 */ }
  }
  pending.clear()
}

/**
 * 取得（必要时启动）TTS 工作线程。
 * @returns {Worker|null} 工作线程。
 */
function getTtsWorker() {
  if (ttsWorker) return ttsWorker
  try {
    const worker = new Worker(join(HERE, 'tts-worker.js'))
    // 这条线程专属的任务表：`message` / `error` / `exit` 都只动它自己的那一份，
    // 别的一条线程的事件不该把这里正在等的调用方顺手拒掉（见 `workerPending` 那段）。
    const pending = new Map()
    workerPending.set(worker, pending)
    const rejectAll = (error) => {
      for (const [, entry] of pending) {
        try { entry.reject(error) } catch { /* 忽略 */ }
      }
      pending.clear()
    }
    worker.on('message', (payload) => {
      const entry = pending.get(payload?.id)
      if (!entry) return
      pending.delete(payload.id)
      if (payload.ok) entry.resolve(payload)
      else entry.reject(new Error(payload.error ?? '本地合成失败。'))
    })
    worker.on('error', (error) => {
      // 线程崩了：把这条线程上等待中的任务都拒掉，避免调用方永远挂着
      rejectAll(error)
    })
    worker.on('exit', () => {
      rejectAll(new Error('本地合成线程已退出。'))
      // 只有还在任的那条才清槽位：被拆掉的旧线程，它的 `exit` 会晚一步到达，
      // 那时接班的新线程已经站在槽位上了。
      if (ttsWorker === worker) ttsWorker = null
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

  const result = await askTtsWorker(worker, {
    text,
    spec: {
      model: paths.model,
      lexicon: paths.lexicon,
      tokens: paths.tokens,
      speakerId: options?.speakerId ?? 0,
      speed: options?.speed ?? 1,
    },
  }, '合成这一句')

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
 *
 * 以前这里只是把任务表 `clear()` 掉：表是清了，等回包的那一个个 Promise 却没人叫醒，
 * 宿主停用之后它们永远不 settle —— 和本批次修的「线程不回话」是同一族，
 * 少的那一步是「清表之前先给等待者一个回执」。
 * @returns {void}
 */
export function disposeNeuralTts() {
  releaseNeural()
}
