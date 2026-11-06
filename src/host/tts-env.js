/**
 * 语音合成运行环境自检。
 *
 * 回答用户最关心的几个问题：
 *   - 现在能用哪个引擎？（在线 / 系统语音 / 本地神经模型）
 *   - 本地神经模型下好了吗？跑得动吗？
 *   - 缺什么环境依赖？
 *
 * 原则：**自检必须真的探一次**，不能靠「平台对不对」猜。
 * 之前「本地系统语音」的 available 只看 process.platform ∈ {win32,darwin,linux}：
 *   - Linux 发行版默认不装 espeak-ng（最常见）；
 *   - Windows 精简镜像没有 Windows PowerShell 5.1。
 * 自检却报「可用」→ 用户选了本地引擎 → 合成失败 → 静默回退在线
 * → 用户以为在离线，其实文本已经发给了微软。
 *
 * **这里不出界面文案**（批次 22-3-2，docs/architecture-modernization.md §8.67）：
 * 每个探测回 `{available, reason, params, detail}`，`reason` 是 `src/shared/tts-env-reasons.js`
 * 里的码，`params` 是契约值/机器事实（版本号、平台名、档位 id、命令名、数量），
 * `detail` 才是那句中文原文 —— 它的读者是 `/diagnostics` 和装机排查，不是界面。
 * 界面上那句（含引擎行名）由客户端的字典出（`src/client/pure/tts-env-reason-text.js`），
 * 因为界面语言是用户选的，宿主不知道。
 *
 * @module dsh-voice-typing/tts-env
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isLocalSupported, defaultLocalVoice } from './local-tts.js'
import { listVoices } from './edge-tts.js'
import { findTtsModel, isModelReady, TTS_MODELS } from './model-catalog.js'
import { TTS_ENV_REASONS } from '../shared/tts-env-reasons.js'

const run = promisify(execFile)

/** 探测子进程的参数：短超时、隐藏控制台窗口、放大输出上限。 */
const PROBE_OPTS = {
  timeout: 8000,
  // Electron 主进程没有控制台，不隐藏的话每次自检都闪一个黑框。
  windowsHide: true,
  maxBuffer: 4 * 1024 * 1024,
}

/**
 * 把「命令没找到」翻译成人话。
 * @param {any} error - 探测时的错误。
 * @returns {string} 说明文字。
 */
function describeMissing(error) {
  const code = error?.code
  if (code === 'ENOENT') return '命令不存在'
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message ? message.slice(0, 120) : '未知原因'
}

/**
 * 某个包能不能被解析到（不真的 import）。
 *
 * 只做解析是因为真的 import 原生件要加载几十 MB 的动态库，
 * 自检没必要付这个代价；解析不到就说明它压根没装。
 * @param {string} name - 包名。
 * @returns {boolean} 能否解析。
 */
function canResolve(name) {
  try {
    import.meta.resolve(name)
    return true
  } catch {
    return false
  }
}

/**
 * 探测本地推理运行时（sherpa-onnx）。
 *
 * 原生件是 optionalDependencies（可能压根没装），WASM 版是普通依赖。
 * @returns {{ok: boolean, kind: 'native'|'wasm'|''}} 结果。
 */
export function probeSherpaRuntime() {
  if (canResolve('sherpa-onnx-node')) return { ok: true, kind: 'native' }
  if (canResolve('sherpa-onnx')) return { ok: true, kind: 'wasm' }
  return { ok: false, kind: '' }
}

/**
 * 真的跑一次命令，探本地系统语音能不能用。
 * @returns {Promise<{available: boolean, reason: string, params: object, detail: string}>} 结果（`reason` 是码，见 `src/shared/tts-env-reasons.js`）。
 */
async function detectLocalEngine() {
  const platform = process.platform
  if (platform === 'win32') {
    // Windows 精简镜像可能没有 Windows PowerShell 5.1。
    try {
      const { stdout } = await run(
        'powershell',
        ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
        PROBE_OPTS,
      )
      const major = String(stdout).trim()
      return {
        available: true,
        reason: TTS_ENV_REASONS.LOCAL_READY_POWERSHELL,
        params: { version: major || '5', voice: defaultLocalVoice() },
        detail: `可用（Windows PowerShell ${major || '5'}），默认发音人：${defaultLocalVoice()}`,
      }
    } catch (error) {
      return {
        available: false,
        reason: TTS_ENV_REASONS.LOCAL_MISSING_POWERSHELL,
        params: {},
        detail: `找不到可用的 powershell（${describeMissing(error)}）。Windows 精简镜像可能没装 Windows PowerShell 5.1。`,
      }
    }
  }
  if (platform === 'darwin') {
    try {
      await run('say', ['-v', '?'], PROBE_OPTS)
      return {
        available: true,
        reason: TTS_ENV_REASONS.LOCAL_READY_SAY,
        params: { voice: defaultLocalVoice() },
        detail: `可用（macOS 内置 say），默认发音人：${defaultLocalVoice()}`,
      }
    } catch (error) {
      return {
        available: false,
        reason: TTS_ENV_REASONS.LOCAL_MISSING_SAY,
        params: {},
        detail: `找不到 say 命令（${describeMissing(error)}）。`,
      }
    }
  }
  if (platform === 'linux') {
    for (const bin of ['espeak-ng', 'espeak']) {
      try {
        await run(bin, ['--version'], PROBE_OPTS)
        return {
          available: true,
          reason: TTS_ENV_REASONS.LOCAL_READY_ESPEAK,
          params: { bin },
          detail: `可用（${bin}），完全离线朗读。`,
        }
      } catch {
        /* 试下一个 */
      }
    }
    return {
      available: false,
      reason: TTS_ENV_REASONS.LOCAL_MISSING_ESPEAK,
      params: {},
      detail:
        '缺少 espeak-ng（Debian/Ubuntu：apt install espeak-ng；' +
        'Fedora：dnf install espeak-ng；Arch：pacman -S espeak-ng）。',
    }
  }
  return {
    available: false,
    reason: TTS_ENV_REASONS.LOCAL_PLATFORM_UNSUPPORTED,
    params: { platform },
    detail: `当前平台（${platform}）不支持本地系统语音。`,
  }
}

/** 本地引擎探测结果缓存（只缓存成功的结果）。 */
let localProbe = null

/**
 * 探测「本地系统语音」这个引擎能不能真的用。
 *
 * 结果缓存：**只缓存成功**的结果 ——
 * 用户装完 espeak-ng 之后，不该非得重启宿主才能看到「本地引擎可用」。
 * @returns {Promise<{available: boolean, reason: string, params: object, detail: string}>} 结果（`reason` 是码，见 `src/shared/tts-env-reasons.js`）。
 */
export async function probeLocalEngine() {
  if (localProbe) return localProbe
  const result = await detectLocalEngine()
  if (result.available) localProbe = result
  return result
}

/**
 * 探测 NVIDIA 显卡。
 *
 * **仅用于展示**，不是功能依赖：插件的识别与合成都跑在 CPU 上。
 * 实测同一个 VITS 模型，CUDA 的 RTF 是 0.283、CPU 是 0.350 ——
 * GPU 只快 20%，却要额外装约 2GB 的 NVIDIA 运行时 DLL，不划算。
 * 所以这里只把显卡信息显示给用户看，不提供 GPU 加速开关。
 *
 * @returns {Promise<{available: boolean, name: string, memoryMB: number}>} 显卡信息。
 */
async function detectGpu() {
  try {
    const { stdout } = await run('nvidia-smi', [
      '--query-gpu=name,memory.total',
      '--format=csv,noheader,nounits',
    ], PROBE_OPTS)
    const line = stdout.split('\n').find((l) => l.trim())
    if (!line) return { available: false, name: '', memoryMB: 0 }
    const [name, mem] = line.split(',').map((s) => s.trim())
    return { available: true, name: name ?? '', memoryMB: Number(mem) || 0 }
  } catch {
    return { available: false, name: '', memoryMB: 0 }
  }
}

/**
 * 检查在线 TTS 是否可用（能否连上 Edge）。
 *
 * @returns {Promise<{available: boolean, reason: string, params: object, detail: string}>} 结果。
 */
async function checkOnline() {
  try {
    const voices = await listVoices()
    if (Array.isArray(voices) && voices.length) {
      return {
        available: true,
        reason: TTS_ENV_REASONS.ONLINE_READY,
        params: { count: String(voices.length) },
        detail: `可用（服务端返回 ${voices.length} 个音色）`,
      }
    }
    return {
      available: false,
      reason: TTS_ENV_REASONS.ONLINE_NO_VOICES,
      params: {},
      detail: '连上了但没拿到音色列表',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      available: false,
      reason: TTS_ENV_REASONS.ONLINE_UNREACHABLE,
      params: {},
      // 原始错误只给 `/diagnostics`：它是一句机器话（`fetch failed`、ECONNREFUSED 这些），
      // 进界面既读不通、也不该由界面决定要不要给用户看（§8.60 那条判据）。
      detail: `连不上：${message}`,
    }
  }
}

/**
 * 检查本地神经模型能不能用。
 *
 * 两件事都要看：**运行时在不在** + **模型下好了没**。
 * 之前 available 恒为 true，用户选了之后才发现模型根本没下。
 * @param {object} settings - 当前配置。
 * @returns {Promise<{available: boolean, reason: string, params: object, detail: string}>} 结果（`reason` 是码，见 `src/shared/tts-env-reasons.js`）。
 */
async function checkNeural(settings) {
  const tier = findTtsModel(settings?.neuralModel) ?? TTS_MODELS[0]
  if (!tier) {
    return {
      available: false,
      reason: TTS_ENV_REASONS.NEURAL_NO_TIER,
      params: {},
      detail: '没有可用的本地神经模型档位。',
    }
  }
  const runtime = probeSherpaRuntime()
  if (!runtime.ok) {
    return {
      available: false,
      reason: TTS_ENV_REASONS.NEURAL_MISSING_RUNTIME,
      params: {},
      detail: '缺少本地推理运行时（sherpa-onnx 的原生件与 WASM 版都没装上），本地神经模型用不了。',
    }
  }
  const ready = await isModelReady(tier)
  if (!ready) {
    return {
      available: false,
      reason: TTS_ENV_REASONS.NEURAL_MODEL_MISSING,
      // `{model}` 用档位 **id**（§8.66 的裁定：展示名自己带括号，套进句子的括号里读不通）。
      params: { model: tier.id },
      detail: `模型还没下载（${tier.label}），请到设置里点「下载」。`,
    }
  }
  return {
    available: true,
    reason: TTS_ENV_REASONS.NEURAL_READY,
    params: { model: tier.id, runtime: runtime.kind },
    detail:
      `已就绪（${tier.label}，${runtime.kind === 'native' ? '原生加速' : 'WASM 版'}），` +
      '离线神经网络音色，约 1.6 秒/句。',
  }
}

/**
 * 完整的运行环境自检。
 *
 * 每一行引擎给的是 `{id, available, reason, params, detail}`：**没有 `label`**。
 * 改前这里有 `label: 'Edge 在线'` 这类中文，面板 `${e.label}：${e.detail}` 一起照抄，
 * 于是英文界面这一整块是宿主的中文（批次 22-3-2，docs §8.67）。
 * 现在的分工：界面行名由客户端按 `id` 查字典（`ENV_ENGINE_LABEL_KEYS`），
 * 句子由 `reason` 查字典（`TTS_ENV_REASON_KEYS`），`detail` 那句原文只给 `/diagnostics` 读。
 *
 * @param {object} settings - 当前配置。
 * @returns {Promise<object>} 自检结果。
 */
export async function checkTtsEnvironment(settings) {
  const [gpu, online, local, neural] = await Promise.all([
    detectGpu(),
    checkOnline(),
    probeLocalEngine(),
    checkNeural(settings),
  ])

  const engines = [
    {
      id: 'online',
      available: online.available,
      reason: online.reason,
      params: online.params,
      detail: online.detail,
      note: '音质最好，约 0.7 秒/句；需要联网。',
    },
    {
      id: 'local',
      available: local.available,
      reason: local.reason,
      params: local.params,
      detail: local.detail,
      note: '完全离线，约 0.8 秒/句；机器感较强。',
    },
    {
      id: 'neural',
      available: neural.available,
      reason: neural.reason,
      params: neural.params,
      detail: neural.detail,
      note: '用 CPU 跑（实测约 2.9 倍实时）。GPU 只快 20% 却要多装 2GB 依赖，不划算。',
    },
  ]

  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    gpu,
    online,
    engines,
    configured: String(settings?.ttsEngine ?? 'online'),
  }
}

/**
 * 平台是否「声称」支持本地合成（不代表真的能用，真假看 probeLocalEngine）。
 * @returns {boolean} 是否支持。
 */
export function platformSupportsLocal() {
  return isLocalSupported()
}
