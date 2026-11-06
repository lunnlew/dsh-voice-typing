/**
 * 开麦链路上「跟浏览器设备打交道」的那一层。
 *
 * 为什么单独成文件（docs/architecture-modernization.md §5 第 4 步 · 4.4b）：
 *   客户端有**两个**录音入口 —— 输入框旁边那只麦克风按钮（composer），
 *   和屏幕上的全局语音浮层。它们在搬动之前各自手写了同一批六件事：
 *     1. 「这台设备到底能不能录」（`typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia`）；
 *     2. 约束对象（单声道 + 16k + 回声消除 + 降噪 + 自动增益）—— 两处逐字各抄一份；
 *     3. 「拿到了流 ≠ 拿得到声音」这条判据（只有一份有，见下）；
 *     4. 取 `AudioContext` 构造器（`win.AudioContext || win.webkitAudioContext`）；
 *     5. 释放轨道（`getTracks().forEach(stop)`，包在 try 里）；
 *     6. 关上下文（`ctx.close()` 返回 promise，得挂个 catch，否则冒未处理拒绝）。
 *   抄两份的直接后果是**两份不等价**：
 *     - 第 4 件，浮层有 `if (!AudioCtx) throw`，composer 没有 —— 拿不到构造器时
 *       `new undefined()` 抛的是 TypeError，整个 `startMic` 从 try 外面逃出去，
 *       「正在开麦」的标志留在 true，界面从此卡在准备中（下次点按钮被当成「取消」）；
 *     - 第 3 件，composer 会检查「流里有没有活的音频轨道」，浮层不检查 ——
 *       浮层在空轨道上照样进「聆听中」，界面显示在听、其实一句采不到。
 *   收进一份实现之后，这两条分歧不再可能重新长出来；本轮**只补齐 composer 缺的那条守卫**
 *   （浮层少的那条判据属于行为变更，见 §8.17 末尾，没顺手做）。
 *
 * 和 `dom/a11y-bridge.js`、`dom/playback-core.js` 同一类：持有的是浏览器对象、
 * 环境只能从参数进来（源码里不许出现裸 window / document / navigator，
 * 见 `test/bundle-sync.test.mjs`），所以 Node 里能直接 new 一个假环境驱动真代码
 * （`test/mic-device.test.mjs`）。
 *
 * 一条注：`mediaDevices` 是**取值函数**而不是实例本身。两个原因：
 *   ① 摘下来的浏览器方法传出去，在部分引擎里会 Illegal invocation
 *     （`playback-core.js` 里 `request` / `toObjectUrl` 同一个理由）；
 *   ② 调用时才取，测试可以在同一个实例上切换设备可用/不可用，
 *     不用为每个场景重建一份 micDevice。
 */

import { TARGET_SAMPLE_RATE } from '../pure/resample.js'

/**
 * 开麦约束：单声道 + 先按 16k 要（设备给了就是直通，拿不到就走 `pure/resample.js` 的重采样）
 * + 回声消除/降噪/自动增益。
 *
 * 为什么做成模块级冻结常量而不是每次调用新建一个字面量：两处调用点抄的就是这个对象，
 * 冻结之后「一边改了另一边没改」在写法上就不成立；运行时 getUserMedia 只读它，不改它。
 */
const CAPTURE_CONSTRAINTS = Object.freeze({
  audio: Object.freeze({
    channelCount: 1,
    sampleRate: TARGET_SAMPLE_RATE,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }),
})

/**
 * 建一个设备层实例（整个客户端共用一个，两个录音入口都用它）。
 *
 * @param {object} [env] - 注入的环境；缺任何一项都退化成「不能录音」，不抛错。
 * @param {object|null} [env.win] - 浏览器 `window`，只取 `AudioContext` / `webkitAudioContext`。
 * @param {() => object|null} [env.readMediaDevices] - 取设备接口对象（`navigator.mediaDevices`）的调用点。
 * @returns {{ supportsCapture: Function, requestStream: Function, liveAudioTrack: Function,
 *   resumeContext: Function, createAudioContext: Function, releaseStream: Function,
 *   closeAudioContext: Function, captureConstraints: Function }}
 */
export function createMicDevice(env = {}) {
  const win = env.win ?? null
  const readMediaDevices = typeof env.readMediaDevices === 'function' ? env.readMediaDevices : null

  /** 调用时才取设备接口；桩环境（没有注入）返回 null。 */
  function devices() {
    if (!readMediaDevices) return null
    try {
      return readMediaDevices() ?? null
    } catch {
      return null
    }
  }

  return {
    /** 约束对象本身（只读）。测试拿它核对「两处开麦用的是同一份约束」。 */
    captureConstraints() {
      return CAPTURE_CONSTRAINTS
    },

    /** 这台设备能不能录音（对应以前那句 navigator 能力探测）。 */
    supportsCapture() {
      return Boolean(devices()?.getUserMedia)
    },

    /**
     * 请求麦克风流。失败（用户拒绝、无权限、设备被独占）以 reject 的形式出来，
     * 由调用方决定提示哪句文案 —— 两条链路的文案不一样，这里不越权。
     */
    async requestStream() {
      const media = devices()
      if (!media?.getUserMedia) throw new Error('no getUserMedia')
      return media.getUserMedia(CAPTURE_CONSTRAINTS)
    },

    /**
     * 从流里取**第一条还活着**的音频轨道；没有就返回 null。
     *
     * 「getUserMedia 成功不等于有可用的音频输入」：设备可能已被拔掉、被别的程序独占，
     * 或者系统只给了一个空轨道 / 已结束（ended）的轨道。这时候照样能建出音频图、
     * 能跑 VAD，只是永远采不到声音 —— 界面却显示「聆听中」，用户完全看不出来。
     */
    liveAudioTrack(stream) {
      const track = typeof stream?.getAudioTracks === 'function' ? stream.getAudioTracks()[0] : null
      if (!track || track.readyState === 'ended') return null
      return track
    },

    /** 用户手势里恢复上下文（上下文 suspended 时 process 不会跑）。没有 resume 就当成功。 */
    async resumeContext(ctx) {
      await ctx?.resume?.()
    },

    /**
     * 建音频上下文。**拿不到构造器就抛**，而不是 `new undefined()` 抛 TypeError：
     * 抛出去的形状决定了调用方能不能复位自己的「正在开麦」标志。
     */
    createAudioContext() {
      const AudioCtx = win?.AudioContext || win?.webkitAudioContext
      if (!AudioCtx) throw new Error('no AudioContext')
      return new AudioCtx()
    },

    /** 释放麦克风流：轨道全部 stop。桩环境里没有 getTracks 就算了，不抛错。 */
    releaseStream(stream) {
      try { stream?.getTracks?.().forEach((track) => track.stop()) } catch { /* 忽略 */ }
    },

    /** 关上下文：`close()` 返回 promise，得挂 catch，否则冒一个未处理拒绝。 */
    closeAudioContext(ctx) {
      try {
        const closing = ctx?.close?.()
        if (closing && typeof closing.catch === 'function') return closing.catch(() => {})
      } catch { /* 忽略 */ }
      return undefined
    },
  }
}
