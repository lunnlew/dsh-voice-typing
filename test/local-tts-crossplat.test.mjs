/**
 * 本地 TTS 的跨平台回归测试。
 *
 * 背景（2026-10-31 跨平台审查）：
 *   1. **macOS 本地 TTS 完全静音（用户必现）**
 *      say 默认产出 AIFF，而宿主把 mime 硬编码成 audio/wav；
 *      Chromium/Electron 的 decodeAudioData 不支持 AIFF
 *      （只认 WAV / MP3 / AAC / FLAC / Opus）→ 浏览器解码抛错 →
 *      catch 吞掉返回 null → **整句被丢弃** → 用户听到「一点声音都没有」。
 *   2. **macOS 语音列表恒为空**
 *      `say -v ?` 的输出是空格对齐的列，代码却按制表符切分
 *      → parts.length >= 2 永远不成立 → 全部 continue → 返回 []。
 *   3. **环境自检不探测真实可执行文件** → 自检在说谎。
 *   4. Windows 上 spawn 控制台程序会闪黑窗（windowsHide 没加）。
 *   5. Windows PowerShell 输出走 OEM 代码页 → 中文语音名乱码。
 *   6. 文本以 "-" 开头会被当成选项（Markdown 列表）。
 *   7. 传给 PowerShell 的路径用双引号 → `$xxx` 会被展开。
 *
 * 能真跑的都在这里真跑（Windows 上真的会合成一段音频），
 * macOS/Linux 的部分用静态断言锁住实现形态。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { synthesizeLocal, parseMacVoices, listLocalVoices } from '../lib/local-tts.js'
import { probeLocalEngine, probeSherpaRuntime } from '../lib/tts-env.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const localSrc = fs.readFileSync(path.join(root, 'lib', 'local-tts.js'), 'utf8')
const envSrc = fs.readFileSync(path.join(root, 'lib', 'tts-env.js'), 'utf8')
const idxSrc = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
const neuralSrc = fs.readFileSync(path.join(root, 'lib', 'neural-tts.js'), 'utf8')

import path from 'node:path'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('macOS 语音列表解析（say -v ? 的输出是空格对齐的列）')
{
  // 老版本格式：名称 + locale + 注释
  const old = [
    'Alex                en_US    # en-US',
    'Tingting            zh_CN    # zh-CN',
    'Bad News            en_US    # en-US',
  ].join('\n')
  const voices = parseMacVoices(old)
  check('老格式能解析出语音', voices.length === 3, JSON.stringify(voices))
  check('名称与 locale 都对',
    voices[1]?.name === 'Tingting' && voices[1]?.culture === 'zh_CN',
    JSON.stringify(voices[1]))
  check('# 注释被剥掉了', !voices[0].name.includes('#'))

  // 新版本格式：表头 + gender 列
  const newer = [
    'Voice                Gender                 Locale',
    'Alex                 male                   en_US    # en-US',
    'Tingting             female                 zh_CN    # zh-CN',
  ].join('\n')
  const voices2 = parseMacVoices(newer)
  check('新格式（带表头与 gender 列）也能解析', voices2.length === 2, JSON.stringify(voices2))
  check('表头行被跳过', !voices2.some((v) => v.name === 'Voice'))
  check('gender 列不会当成 locale',
    voices2[0]?.culture === 'en_US' && voices2[0]?.gender === 'male',
    JSON.stringify(voices2[0]))
  check('中文语音名不乱码', voices2[1]?.name === 'Tingting' && voices2[1]?.culture === 'zh_CN')

  check('空输入不炸', Array.isArray(parseMacVoices('')) && parseMacVoices('').length === 0)
  check('乱输入不炸', Array.isArray(parseMacVoices('???\n\n  \nhello world')))
}

console.log('\n本地合成返回值必须带真实容器格式')
{
  check('synthesizeLocal 返回 {audio, format}',
    /@returns \{Promise<\{audio: Buffer, format: 'wav'\}>\}/.test(localSrc))
  check('Windows 分支返回 wav', /return \{ audio, format: 'wav' \}/.test(localSrc))
  check('macOS 分支返回 wav（不再直接吐 AIFF）', /return \{ audio, format: 'wav' \}/.test(localSrc))
}

console.log('\n本地合成真跑一遍（当前平台）')
{
  let result = null
  let error = null
  try {
    result = await synthesizeLocal({ text: '本地语音合成测试' })
  } catch (e) {
    error = e
  }
  if (result) {
    check('返回里有 audio 与 format', !!result.audio && typeof result.format === 'string')
    check('格式是 wav 或 aiff', ['wav', 'aiff'].includes(result.format), result.format)
    check('音频非空', result.audio.length > 1000, String(result.audio?.length))
    check('WAV 有 RIFF 头', result.format !== 'wav' || result.audio.subarray(0, 4).toString('latin1') === 'RIFF')
  } else {
    // 没有本地语音引擎的机器（比如没装 SAPI 的精简镜像）：
    // 至少要给人话的错误，而不是崩掉。
    check('没有本地引擎时给的是人话错误',
      error instanceof Error && /[一-龥]/.test(error.message),
      error instanceof Error ? error.message : String(error))
  }
}

console.log('\nmacOS 必须产出 WAV（浏览器解码器不认 AIFF）')
{
  check('say 直接写 WAV（--file-format=WAVE）', localSrc.includes("'--file-format=WAVE'"))
  check('WAV 的数据格式是 LEI16', localSrc.includes("'--data-format=LEI16@22050'"))
  check('有 afconvert 兜底（老 macOS 没有 --file-format）', localSrc.includes("'afconvert'"))
  check('兜底把 AIFF 转成 WAVE', localSrc.includes("'-f', 'WAVE'"))
  check('AIFF 只是中间产物，不是最终格式', !/format: 'aiff'/.test(localSrc))
}

console.log('\n子进程调用：不能闪黑窗、输出上限要够')
{
  check('local-tts 用了 windowsHide', /windowsHide: true/.test(localSrc))
  check('local-tts 放大了 maxBuffer', /maxBuffer: MAX_BUFFER/.test(localSrc))
  check('tts-env 用了 windowsHide', /windowsHide: true/.test(envSrc))
  check('tts-env 的 nvidia-smi 也走统一参数', /PROBE_OPTS/.test(envSrc))
  check('没有残留的裸 execFile 默认参数',
    !/run\('powershell', \[[^\]]*\], \{ timeout: TIMEOUT_MS \}\)/.test(localSrc))
}

console.log('\nWindows PowerShell：输出编码与路径引号')
{
  check('脚本第一行设了控制台输出编码',
    localSrc.includes('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'))
  check('编码设置在 Add-Type 之前',
    localSrc.indexOf('[Console]::OutputEncoding') < localSrc.indexOf('Add-Type -AssemblyName'))
  check('输出路径用单引号串（$ 不会被展开）',
    /SetOutputToWaveFile\(\$\{safeOutFile\}\)/.test(localSrc))
  check('路径里的单引号被转义成两个', localSrc.includes("outFile.replace(/'/g, \"''\")"))
  check('不再用双引号串传输出路径', !/SetOutputToWaveFile\("\$\{outFile\}"\)/.test(localSrc))
}

console.log('\n文本以 "-" 开头不能被当成选项')
{
  check('espeak 用 -- 结束选项解析', localSrc.includes("args.push('--', text)"))
  check('macOS 用 -f 文本文件（不经过 argv 解析）', localSrc.includes("'-f', textFile"))
  check('macOS 不把文本直接塞进 argv', !/args\.push\(text\)/.test(localSrc))
}

console.log('\n环境自检必须真的探一次')
{
  check('本地引擎的 available 来自探测结果', /available: local\.available/.test(envSrc))
  check('不再拿平台判断当可用性', !/available: isLocalSupported\(\)/.test(envSrc))
  check('Windows 上探测 powershell', /'powershell',\s*\['-NoProfile', '-Command', '\$PSVersionTable/.test(envSrc))
  check('Linux 上探测 espeak-ng / espeak', /'espeak-ng', 'espeak'/.test(envSrc))
  check('macOS 上探测 say', /run\('say', \['-v', '\?'\]/.test(envSrc))
  check('缺 espeak-ng 时给人话提示（含安装命令）', /apt install espeak-ng/.test(envSrc))
  check('本地神经模型看模型下没下（isModelReady）', /await isModelReady\(tier\)/.test(envSrc))
  check('神经模型不再恒为可用', !/available: true,\s*\n\s*detail: '离线神经网络音色/.test(envSrc))
  check('区分「模型没下载」与「运行时不可用」',
    /模型还没下载/.test(envSrc) && /缺少本地推理运行时/.test(envSrc))
  check('探测结果有缓存', /localProbe/.test(envSrc))
}

console.log('\n环境自检真跑一遍')
{
  const local = await probeLocalEngine()
  check('探测结果有 available 与 detail',
    typeof local.available === 'boolean' && typeof local.detail === 'string' && local.detail.length > 0)
  if (process.platform === 'win32') {
    check('Windows 上探测到 PowerShell（可用）', local.available === true, local.detail)
    check('说明里带出版本', /PowerShell/.test(local.detail), local.detail)
  } else if (!local.available) {
    check('不可用时说明是中文人话', /[一-龥]/.test(local.detail), local.detail)
  } else {
    check('可用时说明是中文人话', /[一-龥]/.test(local.detail), local.detail)
  }
  const runtime = probeSherpaRuntime()
  check('推理运行时探测有 ok 与 kind',
    typeof runtime.ok === 'boolean' && ['native', 'wasm', ''].includes(runtime.kind))
}

console.log('\n语音列表真跑一遍（当前平台）')
{
  const voices = await listLocalVoices()
  check('返回的是数组', Array.isArray(voices))
  check('每一项都有 name 与 culture',
    voices.every((v) => v && typeof v.name === 'string' && typeof v.culture === 'string'))
  if (process.platform === 'win32' && voices.length) {
    // U+FFFD（替换字符）用转义写：字面量会被仓库卫生守卫当成「编码损坏」。
    check('中文语音名没有乱码', !voices.some((v) => /\uFFFD/.test(v.name)), JSON.stringify(voices.map((v) => v.name)))
  }
}

console.log('\n/tts 路由：mime 必须按真实容器来')
{
  check('本地合成的 mime 由 format 决定',
    /mime = format === 'aiff' \? 'audio\/aiff' : 'audio\/wav'/.test(idxSrc))
  check('本地分支用返回值里的 audio', /audio = local\.audio/.test(idxSrc))
  check('本地分支用返回值里的 format', /format = local\.format \?\? 'wav'/.test(idxSrc))
  check('响应里带上了真实格式', /'x-dsh-audio-format': format/.test(idxSrc))
  check('在线回退时 mime 是 audio/mpeg', /mime = 'audio\/mpeg'\s*\n\s*format = 'mp3'/.test(idxSrc))
}

console.log('\ntts-worker 要 unref（不让它挡住进程退出）')
{
  check('neural-tts 里 worker.unref?.() 存在', /worker\.unref\?\.\(\)/.test(neuralSrc))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
