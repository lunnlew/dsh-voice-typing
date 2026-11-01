/**
 * GPT-SoVITS「外部服务」TTS 客户端（宿主侧）。
 *
 * 定位：
 *   GPT-SoVITS 是 PyTorch 推理体系（官方只提供 `api_v2.py` HTTP 服务），
 *   没有能在 Electron 里直接跑的 ONNX 推理管线。所以插件**不内置**它，
 *   而是把用户**自己配置好**的 GPT-SoVITS 服务当成一个外部 TTS 引擎：
 *     - 插件不管理模型、不做声音克隆、不处理参考音频；
 *     - 只把每句文本按官方 `/tts` 契约发过去，拿回 wav 交给现有播放管线；
 *     - 参考音频/参考文本/语言等参数由用户在设置里填写（值必须是**服务端
 *       机器上可访问的路径**），插件只做转发。
 *
 * 官方契约（api_v2.py，2026-11 版本）：
 *   POST {baseUrl}/tts  JSON:
 *     { text, text_lang, ref_audio_path, prompt_lang, prompt_text?,
 *       text_split_method?, speed_factor?, media_type?, streaming_mode? }
 *   必填：text / text_lang / ref_audio_path / prompt_lang（缺一返回 400，
 *   响应体是 {message: "..."}）。成功时直接返回音频字节（media_type=wav）。
 *
 * 这里的所有函数都接受注入的 `fetchImpl`，方便单测；生产用全局 fetch。
 */

/** 默认服务地址（官方 api_v2 默认绑定 127.0.0.1:9880）。 */
export const DEFAULT_SOVITS_URL = 'http://127.0.0.1:9880'

/**
 * 请求超时（毫秒）。
 *
 * 必须明显小于客户端单句合成超时（`TTS_TIMEOUT_MS = 25s`）：
 * 否则客户端先放弃、宿主这边还在等，错误就只剩一句「没声音」。
 */
export const SOVITS_TIMEOUT_MS = 20000

/** 官方 API 支持的语言（v2 系：zh/en/ja/ko + yue；'auto' 官方接口不接受）。 */
export const SOVITS_LANGUAGES = ['zh', 'en', 'ja', 'ko', 'yue']

/** 官方支持的文本切分方式（默认 cut5）。 */
export const SOVITS_TEXT_SPLIT_METHODS = ['cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5']

/** 单次请求最多转发的字符数（一句通常远小于此；防异常长文本把服务打爆）。 */
const MAX_TEXT_CHARS = 2000

/**
 * 把用户填的地址规范成 `.../tts` 端点。
 *
 * 允许用户填 `http://127.0.0.1:9880`、`http://127.0.0.1:9880/`、
 * 或者已经带 `/tts` 的完整地址；空/非法则回退默认地址。
 *
 * @param {string} rawUrl - 用户配置的地址。
 * @returns {string} POST 端点。
 */
export function sovitsEndpoint(rawUrl) {
  const raw = String(rawUrl ?? '').trim()
  let parsed
  try {
    parsed = new URL(raw || DEFAULT_SOVITS_URL)
  } catch {
    throw new Error(`GPT-SoVITS 服务地址不合法：${raw || '（空）'}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`GPT-SoVITS 服务地址必须是 http(s)：${raw}`)
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  if (pathname.endsWith('/tts')) {
    parsed.pathname = pathname
  } else {
    parsed.pathname = (pathname || '') + '/tts'
  }
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

/**
 * 规范语言代码：只接受官方支持的语言，其它回退 `fallback`。
 *
 * @param {string} value - 用户配置/请求里的语言。
 * @param {string} [fallback] - 回退语言。
 * @returns {string} 语言代码。
 */
export function normalizeSovitsLang(value, fallback = 'zh') {
  const lang = String(value ?? '').trim().toLowerCase()
  if (SOVITS_LANGUAGES.includes(lang)) return lang
  return fallback
}

/**
 * 语速百分比（`settings.rate`，如 '+10%'）→ GPT-SoVITS 的 `speed_factor`。
 *
 * @param {string} rate - 形如 '+10%' / '-20%' / '+0%'。
 * @returns {number} 0.5 ~ 2.0 的倍率。
 */
export function sovitsSpeedFromRate(rate) {
  const percent = Number.parseInt(String(rate ?? '').replace(/[^-\d]/g, ''), 10)
  const factor = 1 + (Number.isFinite(percent) ? percent : 0) / 100
  return Math.max(0.5, Math.min(2, Math.round(factor * 100) / 100))
}

/**
 * 构造官方 `/tts` 的请求体。
 *
 * 只带非空的可选字段：这样「用户的服务端已经配好默认参考音频」时，
 * 不填 `sovitsRefAudio` 也不会覆盖服务端配置（由服务端决定行为）。
 *
 * @param {{text: string, settings?: object, speed?: number}} options - 参数。
 * @returns {object} JSON 请求体。
 */
export function buildSovitsPayload({ text, settings = {}, speed } = {}) {
  const payload = {
    text: String(text ?? '').trim().slice(0, MAX_TEXT_CHARS),
    text_lang: normalizeSovitsLang(settings.sovitsTextLang),
    prompt_lang: normalizeSovitsLang(settings.sovitsPromptLang),
    media_type: 'wav',
    streaming_mode: false,
    text_split_method: 'cut5',
    speed_factor: Number.isFinite(speed) ? speed : sovitsSpeedFromRate(settings.rate),
  }
  const refAudio = String(settings.sovitsRefAudio ?? '').trim()
  if (refAudio) payload.ref_audio_path = refAudio
  const promptText = String(settings.sovitsPromptText ?? '').trim()
  if (promptText) payload.prompt_text = promptText
  return payload
}

/**
 * 调外部 GPT-SoVITS 合成一句。
 *
 * 失败时抛错（**不回退其它引擎**）：用户选这个引擎就是要自己的声音，
 * 偷偷回退到微软在线会把文本发出去、还换了音色，绝对不行。
 *
 * @param {{text: string, settings?: object, fetchImpl?: Function, timeoutMs?: number}} options - 参数。
 * @returns {Promise<{audio: Buffer, format: 'wav', mime: 'audio/wav'}>} wav 音频。
 */
export async function synthesizeSovits({
  text,
  settings = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = SOVITS_TIMEOUT_MS,
} = {}) {
  const endpoint = sovitsEndpoint(settings.sovitsUrl)
  const payload = buildSovitsPayload({ text, settings })
  if (!payload.text) throw new Error('GPT-SoVITS 合成为空文本')

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller
    ? setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || SOVITS_TIMEOUT_MS))
    : null
  let response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`GPT-SoVITS 请求超时（${timeoutMs}ms）：服务未在时限内返回音频`)
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`连不上 GPT-SoVITS 服务（${endpoint}）：${detail}`)
  } finally {
    if (timer) clearTimeout(timer)
  }

  if (!response?.ok) {
    const status = response?.status ?? 0
    let detail = ''
    try {
      const body = await response.text()
      try {
        const parsed = JSON.parse(body)
        detail = String(parsed?.message ?? parsed?.error ?? body)
      } catch {
        detail = body
      }
    } catch { /* 读不到响应体就只报状态码 */ }
    detail = detail.trim().slice(0, 300)
    let hint = ''
    if (/ref_audio_path/i.test(detail)) {
      hint = '（官方 api_v2 要求每个请求带参考音频路径：请在设置里填写「服务端参考音频路径」，或使用已封装好默认参考音频的服务）'
    }
    throw new Error(`GPT-SoVITS 合成失败（HTTP ${status}）${detail ? '：' + detail : ''}${hint}`)
  }

  let buffer
  try {
    buffer = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw new Error(`读取 GPT-SoVITS 音频失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!buffer.length) throw new Error('GPT-SoVITS 返回了空音频')
  return { audio: buffer, format: 'wav', mime: 'audio/wav' }
}
