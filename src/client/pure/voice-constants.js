/**
 * 语音输入相关常量（纯数据，零环境依赖）。
 *
 * 为什么单独成文件：
 *   - main.js 顶层常量被多个组件引用（MicButton、GlobalVoiceOverlay）
 *   - 提取组件时需要通过工厂参数传递，签名会很大
 *   - 收成独立文件后，组件可以直接 import，工厂签名简化
 *
 * 分类：
 *   - 超时时间：TRANSCRIBE_TIMEOUT_MS / TTS_TIMEOUT_MS / MAX_RECORD_MS / WAKE_ACTIVE_MS / WAKE_HINT_MS / CONFIRM_TIMEOUT_MS
 *   - 队列上限：MAX_PENDING / MAX_SEEN_SENTENCE_KEYS
 *   - 事件名：GLOBAL_MIC_ON_EVENT / GLOBAL_MIC_OFF_EVENT / GLOBAL_TOGGLE_EVENT
 *   - DOM ID：GLOBAL_OVERLAY_ID
 */

// 超时时间（毫秒）
export const TRANSCRIBE_TIMEOUT_MS = 15000
/**
 * 客户端等一句合成最多等多久 —— **跨端时间契约的基准线**。
 *
 * 数字只有这一处：宿主四个引擎各自的上限（`edge-tts.js` / `local-tts.js` /
 * `sovits-tts.js` / `neural-tts.js`）都在自己文件里写注释指向这里，不复述数值；
 * 谁把顺序改反了，由 `test/edge-tts.test.mjs`、`test/local-tts-command.test.mjs`、
 * `test/sovits-tts.test.mjs`、`test/neural-worker-exit.test.mjs` 四条判据分别红给你看
 * （见 `docs/architecture-modernization.md` §8.63）。
 * 顺序为什么这样定：宿主先给回执，客户端才有错误可显示；反过来用户只看到「没声音」。
 */
export const TTS_TIMEOUT_MS = 25000
export const MAX_RECORD_MS = 30000
export const WAKE_ACTIVE_MS = 60000
export const WAKE_HINT_MS = 30000
export const CONFIRM_TIMEOUT_MS = 30000

// 队列上限
export const MAX_PENDING = 8
export const MAX_SEEN_SENTENCE_KEYS = 512

// 事件名（自定义事件，用于跨组件通信）
export const GLOBAL_MIC_ON_EVENT = 'dsh-voice-typing:global-mic-on'
export const GLOBAL_MIC_OFF_EVENT = 'dsh-voice-typing:global-mic-off'
export const GLOBAL_TOGGLE_EVENT = 'dsh-voice-typing:toggle-global'

// DOM ID
export const GLOBAL_OVERLAY_ID = 'dsh-voice-typing-global'
