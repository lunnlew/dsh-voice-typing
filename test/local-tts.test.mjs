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
 * 本文件留下的是纯函数与真跑：parseMacVoices 的列解析、当前平台的真实合成/枚举/自检、
 * VOICES_CACHE_MS 的量级、package.json 的发布元信息。**一条源码文本判据都没有了。**
 * 搬走的几批各归各位（§8.34 批次 6a）：
 *   - 「宿主往命令行里塞了什么」（三平台 argv、PowerShell 脚本内容、临时文件、
 *     缓存起几个进程、探测参数）→ test/local-tts-command.test.mjs（假 child_process）；
 *   - 「/tts 的回退留痕与 mime」（stats 计数、失败原因/时间、x-tts-engine、
 *     x-tts-engine-fallback、/diagnostics 那三字段、audio/mpeg 与 audio/aiff）
 *     → test/tts-fallback-trace.test.mjs（真宿主路由 + 三个引擎替身）；
 *   - 「环境自检的接线」（available 来自探测、不拿平台当可用性、神经模型两条错误分支、
 *     nvidia-smi 走统一探测参数）→ test/tts-env-check.test.mjs；
 *   - 「神经合成线程不挡住进程退出」→ test/neural-worker-exit.test.mjs
 *     （真起子进程：正向能自己退出，拆掉 unref 的对照退不出来）。
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
} from '../src/host/local-tts.js'
import { probeLocalEngine, probeSherpaRuntime } from '../src/host/tts-env.js'

const root = fileURLToPath(new URL('..', import.meta.url))
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
  // 「起几个进程」那部分搬到了 test/local-tts-command.test.mjs（数真调用次数）。
  check('缓存时长是有限值（不是永久）', Number.isFinite(VOICES_CACHE_MS), String(VOICES_CACHE_MS))
  check('缓存时长不超过 10 分钟', VOICES_CACHE_MS <= 10 * 60 * 1000, String(VOICES_CACHE_MS))
  check('缓存时长不短于 1 分钟（别每次都重探）', VOICES_CACHE_MS >= 60 * 1000, String(VOICES_CACHE_MS))
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
