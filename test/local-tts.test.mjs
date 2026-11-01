/**
 * 本地 TTS：跨平台回归 + 健壮性（合并自原 local-tts-crossplat / local-tts-resilience）。
 *
 * 背景：
 *   1. macOS 本地 TTS 完全静音：`say` 默认产出 AIFF，浏览器 decodeAudioData 不认
 *      （只认 WAV/MP3/AAC/FLAC/Opus）→ 整句被丢弃；`say -v ?` 是空格对齐列，
 *      按制表符切会得到空列表。
 *   2. 环境自检必须真的探测可执行文件（不能只按平台判断）。
 *   3. Windows spawn 控制台程序不能闪黑窗；PowerShell 输出走 OEM 代码页会乱码；
 *      Markdown 列表文本以 `-` 开头不能被当选项；路径引号不能让 `$` 被展开。
 *   4. 语音列表缓存不过期 / 失败结果被永久缓存；`powershell` 命令名写死；
 *      本地失败回退在线必须留痕（stats + 响应头 + /diagnostics）。
 *
 * 能真跑的都在这里真跑（当前平台真实合成一段音频），macOS/Linux 分支用形状断言锁住。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  synthesizeLocal,
  parseMacVoices,
  listLocalVoices,
  clearVoicesCache,
  VOICES_CACHE_MS,
} from '../lib/local-tts.js'
import { probeLocalEngine, probeSherpaRuntime } from '../lib/tts-env.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const localSrc = fs.readFileSync(path.join(root, 'lib', 'local-tts.js'), 'utf8')
const envSrc = fs.readFileSync(path.join(root, 'lib', 'tts-env.js'), 'utf8')
const idxSrc = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
const neuralSrc = fs.readFileSync(path.join(root, 'lib', 'neural-tts.js'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

// ---------------------------------------------------------------------------
// A. 跨平台（原 local-tts-crossplat.test.mjs）
// ---------------------------------------------------------------------------
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
  // Windows / macOS 两个分支都必须返回 wav（原来是直接吐 AIFF → 浏览器解码失败）。
  check('Windows 与 macOS 两个分支都返回 wav',
    (localSrc.match(/return \{ audio, format: 'wav' \}/g) || []).length >= 2,
    `出现 ${(localSrc.match(/return \{ audio, format: 'wav' \}/g) || []).length} 处`)
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

// ---------------------------------------------------------------------------
// B. 语音列表缓存 + 真跑（原 resilience 的缓存段 + crossplat 的列表真跑合并，
//    共用一次真实枚举，少起一次 PowerShell/子进程）
// ---------------------------------------------------------------------------
console.log('\n语音列表缓存：要会过期，失败不能永久缓存')
{
  check('缓存时长是有限值（不是永久）', Number.isFinite(VOICES_CACHE_MS), String(VOICES_CACHE_MS))
  check('缓存时长不超过 10 分钟', VOICES_CACHE_MS <= 10 * 60 * 1000, String(VOICES_CACHE_MS))
  check('缓存时长不短于 1 分钟（别每次都重探）', VOICES_CACHE_MS >= 60 * 1000, String(VOICES_CACHE_MS))
  check('源码里记了缓存时刻', /cachedVoicesAt/.test(localSrc))
  check('源码里按 TTL 判断过期', /Date\.now\(\) - cachedVoicesAt < VOICES_CACHE_MS/.test(localSrc))
  check('空结果也会被缓存（否则每次合成都起进程）',
    /cachedVoices = voices/.test(localSrc))
  check('提供了清缓存的入口', typeof clearVoicesCache === 'function')
}

console.log('\n语音列表缓存与列表内容：真跑一遍（当前平台）')
{
  clearVoicesCache()
  const first = await listLocalVoices()
  const second = await listLocalVoices()
  check('两次调用返回同一个数组（缓存生效）', first === second)
  clearVoicesCache()
  const third = await listLocalVoices()
  check('清掉缓存后会重新枚举（不是同一个数组）', third !== first)
  check('重新枚举的结果仍然是数组', Array.isArray(third))
  // 原 crossplat「语音列表真跑一遍」的断言，复用同一次真实枚举结果。
  check('每一项都有 name 与 culture',
    third.every((v) => v && typeof v.name === 'string' && typeof v.culture === 'string'))
  if (process.platform === 'win32' && third.length) {
    // U+FFFD（替换字符）用转义写：字面量会被仓库卫生守卫当成「编码损坏」。
    check('中文语音名没有乱码', !third.some((v) => /\uFFFD/.test(v.name)), JSON.stringify(third.map((v) => v.name)))
  }
}

console.log('\nPowerShell 缺失要说人话（而不是静默回退在线）')
{
  check('有 runPowerShell 助手', /async function runPowerShell\(/.test(localSrc))
  check('命令名仍然写死 powershell', /run\('powershell', args, opts\)/.test(localSrc))
  check('没有改成 pwsh（PS7 没有 System.Speech）', !/'pwsh'/.test(localSrc))
  check('ENOENT 会翻译成中文错误', /error\?\.code === 'ENOENT'/.test(localSrc))
  check('错误里点名 Windows PowerShell 5.1', /Windows PowerShell 5\.1/.test(localSrc))
  check('错误里说明 pwsh 不够', /pwsh/.test(localSrc))
  const calls = [...localSrc.matchAll(/runPowerShell\(/g)].length
  check('枚举与合成两处都走 runPowerShell', calls >= 3, `${calls} 处`)
}

console.log('\n本地失败回退在线必须留痕')
{
  check('stats 里记了失败次数', /localTtsFailures: 0/.test(idxSrc))
  check('stats 里记了失败原因', /lastLocalTtsError: ''/.test(idxSrc))
  check('stats 里记了失败时间', /lastLocalTtsAt: 0/.test(idxSrc))
  check('回退时把失败次数记下来', /stats\.localTtsFailures \+= 1/.test(idxSrc))
  check('回退时把失败原因记下来', /stats\.lastLocalTtsError =/.test(idxSrc))
  check('回退时把失败时间记下来', /stats\.lastLocalTtsAt = Date\.now\(\)/.test(idxSrc))
  check('响应头带上了实际用的引擎', /'x-tts-engine': actualEngine/.test(idxSrc))
  check('回退时带上 x-tts-engine-fallback', /headers\['x-tts-engine-fallback'\] = 'online'/.test(idxSrc))
  check('只有选了 local 且真回退了才加这个头',
    /engine === 'local' && actualEngine !== 'local'/.test(idxSrc))
  check('/diagnostics 暴露了 localTts', /localTts: \{/.test(idxSrc))
  check('/diagnostics 里含失败次数/原因/时间',
    /failures: stats\.localTtsFailures/.test(idxSrc)
    && /lastError: stats\.lastLocalTtsError/.test(idxSrc)
    && /lastAt: stats\.lastLocalTtsAt/.test(idxSrc))
}

console.log('\n在线/神经引擎失败也必须留痕（客户端会静默跳过，用户只见「没声音」）')
{
  check('stats 记了在线失败次数', /onlineTtsFailures: 0/.test(idxSrc))
  check('在线失败时计数并抛回', /stats\.onlineTtsFailures \+= 1/.test(idxSrc)
    && /throw onlineError/.test(idxSrc))
  check('stats 记了神经失败次数', /neuralTtsFailures: 0/.test(idxSrc))
  check('神经失败时计数并抛回', /stats\.neuralTtsFailures \+= 1/.test(idxSrc)
    && /throw neuralError/.test(idxSrc))
  // 「/diagnostics 暴露 onlineTts/neuralTts 字段」已由 event-envelope 的运行时断言覆盖，这里不重复。
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

console.log('\npackage.json 的发布元信息')
{
  check('有 repository', !!pkg.repository, JSON.stringify(pkg.repository))
  check('repository 指向本仓库', String(pkg.repository?.url ?? '').includes('dsh-voice-typing'))
  check('repository 是 git 类型', pkg.repository?.type === 'git')
  check('有 homepage', typeof pkg.homepage === 'string' && pkg.homepage.startsWith('http'))
  check('有 bugs', typeof pkg.bugs?.url === 'string' && pkg.bugs.url.startsWith('http'))
  check('bugs 指向 issues', String(pkg.bugs?.url ?? '').includes('issues'))
  check('package.json 仍是合法 JSON 且类型没变', pkg.type === 'module' && pkg.name === 'dsh-voice-typing')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
