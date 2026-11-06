/**
 * 本地语音合成（跨平台）。
 *
 * 用途：完全离线的 TTS 备选方案。不依赖网络，也不消耗在线服务的请求配额。
 * 音质明显不如在线神经网络音色（机器感强），但胜在离线可用、稳定。
 *
 * 跨平台实现：每个平台一个适配器，都输出音频文件再读回字节。
 *   - Windows：PowerShell + System.Speech（SAPI）→ WAV
 *   - macOS  ：系统自带的 say 命令 → **WAV**（见 synthesizeMac 的说明）
 *   - Linux  ：espeak-ng（首选）或 espeak → WAV
 *   - 其它   ：不支持，调用方应回退到在线引擎
 *
 * Linux 只支持 espeak-ng / espeak（不装就没有本地语音，
 * 自检里会明确告诉用户去装 —— 见 lib/tts-env.js）。
 *
 * 音频格式：synthesizeLocal 返回 {audio, format}，
 * format 各平台当前都产出 **'wav'**，调用方按它设 mime ——
 * 之所以每个平台都转成 WAV：Chromium/Electron 的 decodeAudioData 不认 AIFF，
 * 格式报错的话浏览器解码抛错，整句语音被丢掉（用户听到「一点声音都没有」）。
 *
 * @module dsh-voice-typing/local-tts
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)

/**
 * 合成超时（毫秒）。
 *
 * 必须早于客户端单句合成超时（`src/client/pure/voice-constants.js` 的 `TTS_TIMEOUT_MS`，
 * 数字只有那一处，这里不复述）：命令卡住（系统语音在某些发音人上真的会不返回）时，
 * 客户端等到的应该是这一句的错误，而不是一片静音。
 * 判据在 `test/local-tts-command.test.mjs` 末尾：按**每一次真调用**记下来的
 * `opts.timeout` 逐条数，缺一条或者比客户端那个值晚都会红。
 */
const TIMEOUT_MS = 20000

/**
 * 子进程输出上限（字节）。
 * execFile 默认只给 1MB，语音列表（尤其是 macOS 的 say -v ?，
 * 有上百行）在有些系统上会超 → 直接抛错 → 语音列表整个是空的。
 */
const MAX_BUFFER = 4 * 1024 * 1024

/**
 * 统一的子进程参数。
 *
 * windowsHide 必须在：Electron 主进程是**没有控制台**的 GUI 程序，
 * 默认的 windowsHide:false 会让每次合成都闪一个黑框（Windows 上）。
 */
const EXEC_OPTS = {
  timeout: TIMEOUT_MS,
  windowsHide: true,
  maxBuffer: MAX_BUFFER,
}

/** 当前平台标识：win32 / darwin / linux / 其它。 */
const PLATFORM = process.platform

/**
 * 当前平台是否支持本地合成。
 * @returns {boolean} 是否支持。
 */
export function isLocalSupported() {
  return PLATFORM === 'win32' || PLATFORM === 'darwin' || PLATFORM === 'linux'
}

/**
 * 当前平台的默认发音人。
 * @returns {string} 发音人名（为空表示用系统默认）。
 */
export function defaultLocalVoice() {
  if (PLATFORM === 'win32') return 'Microsoft Huihui Desktop'
  if (PLATFORM === 'darwin') return 'Tingting'
  return ''
}

/**
 * 发音人列表的缓存时长（毫秒）。
 *
 * 10 分钟：既不至于每次合成都起一个 PowerShell 进程（实测 1~20 秒），
 * 又能让「用户后来把语音装好了 / 删掉了」在十分钟内刷出来。
 */
export const VOICES_CACHE_MS = 10 * 60 * 1000

/** 发音人缓存：避免每次都枚举系统语音。 */
let cachedVoices = null
/** 缓存的时刻（用来算过期）。 */
let cachedVoicesAt = 0

/**
 * 清掉发音人缓存（下次调用会重新枚举）。
 * @returns {void}
 */
export function clearVoicesCache() {
  cachedVoices = null
  cachedVoicesAt = 0
}

/**
 * 列出系统已安装的本地语音。
 *
 * 缓存会**过期**：以前这个缓存不过期，而且失败结果被永久写进去 ——
 * 第一次探测失败（PowerShell 还没就绪 / espeak 没装）→ 缓存成空列表 →
 * 用户后来把环境修好了，列表还是空的，而且永远刷不出来。
 * @returns {Promise<Array<{name: string, culture: string, gender: string}>>} 语音列表。
 */
export async function listLocalVoices() {
  if (cachedVoices && Date.now() - cachedVoicesAt < VOICES_CACHE_MS) return cachedVoices
  let voices = []
  try {
    voices = await listVoicesByPlatform()
  } catch {
    voices = []
  }
  // 空结果也缓存（否则每次合成都得起一次进程，没有语音的机器上会慢到不可用），
  // 但缓存**会过期**：十分钟后自动重探一次，用户装好环境就能刷出来。
  cachedVoices = voices
  cachedVoicesAt = Date.now()
  return voices
}

/**
 * 按平台枚举语音。
 * @returns {Promise<Array<{name: string, culture: string, gender: string}>>} 语音列表。
 */
async function listVoicesByPlatform() {
  if (PLATFORM === 'win32') return listWindowsVoices()
  if (PLATFORM === 'darwin') return listMacVoices()
  if (PLATFORM === 'linux') return listLinuxVoices()
  return []
}

/**
 * 跑一次 Windows PowerShell。
 *
 * 命令名写死 `powershell`（Windows PowerShell 5.1）：
 *   - 只装了 PowerShell 7（`pwsh`）的机器上，`powershell` 可能压根不在 PATH
 *     （Windows Server Core、精简镜像）；
 *   - 但也**不能**简单换成 `pwsh` —— PS7 跑在 .NET Core 上，没有 System.Speech
 *     （该程序集属于 .NET Framework / Windows-only），换过去 SAPI 直接不可用。
 *
 * 所以：找不到就报人话（告诉用户要装 Windows PowerShell 5.1），
 * 而不是让错误一路冒到「静默回退在线」——
 * 那样用户以为在离线，文本其实发给了微软。
 *
 * @param {string[]} args - powershell 的参数。
 * @param {object} [opts] - 子进程参数。
 * @returns {Promise<{stdout: string, stderr: string}>} 输出。
 */
async function runPowerShell(args, opts = EXEC_OPTS) {
  try {
    return await run('powershell', args, opts)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        '找不到 powershell（Windows PowerShell 5.1）。' +
        '只装 PowerShell 7（pwsh）不够：SAPI 的 System.Speech 程序集只在 .NET Framework 里。',
      )
    }
    throw error
  }
}

/**
 * Windows：枚举 SAPI 语音。
 * @returns {Promise<Array<object>>} 语音列表。
 */
async function listWindowsVoices() {
  // 第一行必须先把控制台输出编码设成 UTF8：
  // PowerShell 的输出流默认走**控制台代码页**（中文系统是 936/GBK），
  // 而 Node 按 UTF-8 解码 → 语音名里的中文变成乱码，
  // 严重时 JSON.parse 直接抛错 → 语音列表整个是空的。
  // （脚本文件带 BOM 只解决**脚本本身**的编码，管不到输出流。）
  const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$out = @()
foreach ($v in $s.GetInstalledVoices()) {
  $i = $v.VoiceInfo
  $out += [PSCustomObject]@{ name = $i.Name; culture = $i.Culture.Name; gender = $i.Gender.ToString() }
}
$s.Dispose()
ConvertTo-Json -InputObject $out -Compress
`
  // 用随机文件名：固定名字的话，并发调用会互相覆盖
  // 正在被 PowerShell 读取的脚本，导致语法错误。
  const file = join(tmpdir(), `dsh-voice-typing-voices-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`)
  await writeFile(file, '\uFEFF' + script, 'utf8')
  try {
    const { stdout } = await runPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file])
    const parsed = JSON.parse(stdout.trim() || '[]')
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list
      .filter((v) => v && v.name)
      .map((v) => ({ name: String(v.name), culture: String(v.culture ?? ''), gender: String(v.gender ?? '') }))
  } finally {
    await unlink(file).catch(() => {})
  }
}

/**
 * 解析 `say -v ?` 的输出。
 *
 * 输出是**空格对齐的列**，不是制表符，而且各版本的列数不一样：
 *   老版本：Alex            en_US    # en-US
 *   新版本：先来一行表头 Voice Gender Locale，再是
 *           Alex             male     en_US    # en-US
 *
 * 所以既不能按制表符切（parts.length >= 2 永远不成立 → 语音列表恒为空），
 * 也不能假设第二列就是 locale（新版本第二列是 gender）。
 * 这里按「第一个词是名称、后面找形如 zh_CN / pt-BR 的 locale」来解析。
 *
 * @param {string} text - say -v ? 的原始输出。
 * @returns {Array<{name: string, culture: string, gender: string}>} 语音列表。
 */
export function parseMacVoices(text) {
  const voices = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // 去掉 # 注释
    const commentAt = trimmed.indexOf('#')
    const body = (commentAt >= 0 ? trimmed.slice(0, commentAt) : trimmed).trim()
    if (!body) continue
    const parts = body.split(/\s+/).filter(Boolean)
    if (parts.length < 2) continue
    const name = parts[0]
    if (!name || name.startsWith('?')) continue
    // 表头行（Voice Gender Locale）要跳过
    if (/^voice$/i.test(name)) continue
    const rest = parts.slice(1)
    const localeAt = rest.findIndex((p) => /^[a-z]{2,3}[_-][A-Za-z]{2,4}$/.test(p))
    if (localeAt < 0) continue
    // gender（male/female）排在 locale 前面
    const gender = rest.slice(0, localeAt).find((p) => /^(male|female)$/i.test(p)) ?? ''
    voices.push({ name, culture: rest[localeAt], gender: gender ? gender.toLowerCase() : '' })
  }
  return voices
}

/**
 * macOS：枚举 say 命令的语音。
 * @returns {Promise<Array<object>>} 语音列表。
 */
async function listMacVoices() {
  const { stdout } = await run('say', ['-v', '?'], EXEC_OPTS)
  return parseMacVoices(stdout)
}

/**
 * Linux：枚举 espeak-ng / espeak 的语音。
 * @returns {Promise<Array<object>>} 语音列表。
 */
async function listLinuxVoices() {
  for (const bin of ['espeak-ng', 'espeak']) {
    try {
      const { stdout } = await run(bin, ['--voices=cmn'], EXEC_OPTS)
      const voices = []
      for (const line of stdout.split('\n').slice(1)) {
        const m = line.match(/^\s*\d+\s+(\S+)\s+(\S+)\s+(.*)$/)
        if (m) voices.push({ name: m[1], culture: m[2], gender: '' })
      }
      if (voices.length) return voices
    } catch { /* 试下一个 */ }
  }
  return []
}

/**
 * 用系统语音合成一段文本，返回音频字节。
 *
 * @param {object} options - 合成参数。
 * @param {string} options.text - 要朗读的文本。
 * @param {string} [options.voice] - 发音人名（留空用系统默认）。
 * @param {string} [options.rate] - 语速，形如 '+15%'。
 * @param {string} [options.volume] - 音量，形如 '+0%'。
 * @returns {Promise<{audio: Buffer, format: 'wav'}>} 音频字节与**真实容器格式**。
 * @throws 平台不支持或合成失败时抛中文错误。
 */
export async function synthesizeLocal(options) {
  const text = String(options?.text ?? '').trim()
  if (!text) throw new Error('要合成的文本为空。')
  if (text.length > 3000) throw new Error('本地合成单次文本不能超过 3000 字符。')
  if (!isLocalSupported()) {
    throw new Error(`当前平台（${PLATFORM}）不支持本地语音合成，请使用在线引擎。`)
  }
  const ratePct = Number.parseInt(String(options?.rate ?? '').replace(/[^-\d]/g, ''), 10)
  const volPct = Number.parseInt(String(options?.volume ?? '').replace(/[^-\d]/g, ''), 10)

  if (PLATFORM === 'win32') {
    return synthesizeWindows(text, options?.voice, ratePct, volPct)
  }
  if (PLATFORM === 'darwin') {
    return synthesizeMac(text, options?.voice, ratePct)
  }
  return synthesizeLinux(text, options?.voice, ratePct)
}

/**
 * Windows SAPI 合成。
 * @param {string} text - 文本。
 * @param {string} voice - 发音人。
 * @param {number} ratePct - 语速百分比。
 * @param {number} volPct - 音量百分比。
 * @returns {Promise<{audio: Buffer, format: 'wav'}>} 音频。
 */
async function synthesizeWindows(text, voice, ratePct, volPct) {
  // SAPI 的 Rate 是 -10..10 的整数档位，'+15%' 大致对应 +2~3 档
  const sapiRate = Number.isFinite(ratePct) ? Math.max(-10, Math.min(10, Math.round(ratePct / 6))) : 0
  const sapiVolume = Number.isFinite(volPct) ? Math.max(0, Math.min(100, 100 + volPct)) : 100
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const outFile = join(tmpdir(), `dsh-tts-${stamp}.wav`).replace(/\\/g, '/')
  const psFile = join(tmpdir(), `dsh-tts-${stamp}.ps1`)
  const safeText = "'" + text.replace(/'/g, "''") + "'"
  const safeVoice = "'" + String(voice ?? '').replace(/'/g, "''") + "'"
  // 输出路径也必须用**单引号**串：
  // 双引号串里 $ 开头的会被 PowerShell 当变量展开，
  // 而 Windows 用户名是允许带 $ 的（展开后路径就不对了）。
  const safeOutFile = "'" + outFile.replace(/'/g, "''") + "'"

  const script = `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
${voice ? `try { $s.SelectVoice(${safeVoice}) } catch { }` : ''}
$s.Rate = ${sapiRate}
$s.Volume = ${sapiVolume}
$s.SetOutputToWaveFile(${safeOutFile})
$s.Speak(${safeText})
$s.Dispose()
`
  await writeFile(psFile, '\uFEFF' + script, 'utf8')
  try {
    await runPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile])
    const audio = await readFile(outFile)
    if (!audio.length) throw new Error('本地合成没有产生音频数据。')
    return { audio, format: 'wav' }
  } finally {
    await unlink(psFile).catch(() => {})
    await unlink(outFile).catch(() => {})
  }
}

/**
 * macOS say 合成。
 *
 * **必须产出 WAV**：Chromium/Electron 的 decodeAudioData 不支持 AIFF
 * （只认 WAV / MP3 / AAC / FLAC / Opus）。
 * 宿主若把 AIFF 当 audio/wav 发出去 → 浏览器解码抛错 → 整句被丢掉 →
 * 用户看到的就是「本地系统语音一点声音都没有」。
 *
 * 两条路：
 *   1) say 直接写 WAV：--file-format=WAVE --data-format=LEI16@22050
 *      （--file-format 自 macOS 10.15 起可用；LEI16 = 小端 16bit PCM，正是 WAV 要的）；
 *   2) 退回 AIFF，再用系统自带的 afconvert 转成 WAV（更老的 macOS）。
 * 两条都不成 → 抛错 → /tts 路由回退在线引擎（保证「总有声音」）。
 *
 * 文本用 `-f 文本文件` 传，不作为 argv 元素：
 * say 的选项解析器不保证支持 `--` 这个「选项结束」标记，
 * 万一不认，`--` 会被当成**要朗读的内容**（整句变成「--」）。
 * 走文件则完全不经过 argv 解析，文本以 "-" 开头（Markdown 列表）也安全。
 *
 * @param {string} text - 文本。
 * @param {string} voice - 发音人。
 * @param {number} ratePct - 语速百分比。
 * @returns {Promise<{audio: Buffer, format: 'wav'}>} 音频。
 */
async function synthesizeMac(text, voice, ratePct) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const wavFile = join(tmpdir(), `dsh-tts-${stamp}.wav`)
  const aiffFile = join(tmpdir(), `dsh-tts-${stamp}.aiff`)
  const textFile = join(tmpdir(), `dsh-tts-${stamp}.txt`)
  // say 的 -r 是「每分钟词数」，中文大约 180~400，默认 200。
  const wpm = Math.max(120, Math.min(500, Math.round(200 * (1 + (Number.isFinite(ratePct) ? ratePct : 0) / 100))))
  const voiceArgs = voice ? ['-v', voice] : []
  let firstError = null
  try {
    await writeFile(textFile, text, 'utf8')
    // 方案一：say 直接写 WAV。
    try {
      await run('say', [
        '-o', wavFile,
        '--file-format=WAVE',
        '--data-format=LEI16@22050',
        '-r', String(wpm),
        ...voiceArgs,
        '-f', textFile,
      ], EXEC_OPTS)
      const audio = await readFile(wavFile)
      if (audio.length) return { audio, format: 'wav' }
      firstError = new Error('say 没有产出音频数据')
    } catch (error) {
      firstError = error
      await rm(wavFile, { force: true }).catch(() => {})
    }
    // 方案二：AIFF + afconvert（macOS 10.15 以前没有 --file-format）。
    try {
      await run('say', ['-o', aiffFile, '-r', String(wpm), ...voiceArgs, '-f', textFile], EXEC_OPTS)
      await run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', aiffFile, wavFile], EXEC_OPTS)
      const audio = await readFile(wavFile)
      if (audio.length) return { audio, format: 'wav' }
      throw new Error('afconvert 没有产出音频数据')
    } catch (error) {
      throw new Error(
        `macOS 本地合成失败：${error instanceof Error ? error.message : String(error)}` +
        (firstError ? `（say 直接写 WAV 也失败了：${firstError instanceof Error ? firstError.message : String(firstError)}）` : ''),
      )
    }
  } finally {
    await rm(wavFile, { force: true }).catch(() => {})
    await rm(aiffFile, { force: true }).catch(() => {})
    await rm(textFile, { force: true }).catch(() => {})
  }
}

/**
 * Linux espeak-ng 合成。
 * @param {string} text - 文本。
 * @param {string} voice - 发音人。
 * @param {number} ratePct - 语速百分比。
 * @returns {Promise<{audio: Buffer, format: 'wav'}>} 音频。
 */
async function synthesizeLinux(text, voice, ratePct) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const outFile = join(tmpdir(), `dsh-tts-${stamp}.wav`)
  // espeak 的 -s 是词速（默认 175），-a 音量 0~200，-p 音高 0~99
  const speed = Math.max(80, Math.min(450, Math.round(175 * (1 + (Number.isFinite(ratePct) ? ratePct : 0) / 100))))
  let lastError = null
  for (const bin of ['espeak-ng', 'espeak']) {
    const args = ['-w', outFile, '-s', String(speed)]
    if (voice) args.push('-v', voice)
    // `--` 结束选项解析：文本以 "-" 开头时（Markdown 列表「- 项目说明」）
    // 不加它会被当成选项，合成直接失败。
    args.push('--', text)
    try {
      await run(bin, args, EXEC_OPTS)
      const audio = await readFile(outFile)
      if (audio.length) return { audio, format: 'wav' }
    } catch (error) {
      lastError = error
    } finally {
      await rm(outFile, { force: true }).catch(() => {})
    }
  }
  throw new Error(
    `本地合成失败：系统里没找到 espeak-ng 或 espeak。${lastError?.message ? '（' + String(lastError.message).slice(0, 120) + '）' : ''}`,
  )
}
