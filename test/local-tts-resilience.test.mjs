/**
 * 本地 TTS 的健壮性回归测试（缓存过期 / PowerShell 缺失 / 回退可见性）。
 *
 * 背景（2026-10-31 跨平台审查）：
 *   1. 语音列表缓存不过期，而且**失败结果被永久缓存**：
 *      第一次探测失败（PowerShell 还没就绪 / espeak 没装）→ 缓存成空列表 →
 *      用户后来把环境修好了，列表还是空的，而且永远刷不出来。
 *   2. /tts 的 local 引擎失败后静默回退在线，连日志都没打 ——
 *      用户以为在离线，文本其实发给了微软。
 *   3. `powershell` 命令名写死：只装了 PowerShell 7（pwsh）的机器上
 *      它可能压根不在 PATH；而且不能简单换成 pwsh（PS7 没有 System.Speech）。
 *   4. 注释说 Linux「退化到 piper」，代码里却没有 piper 分支。
 *   5. package.json 缺 repository / homepage / bugs（npm publish 会 warn）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listLocalVoices, clearVoicesCache, VOICES_CACHE_MS } from '../lib/local-tts.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const localSrc = fs.readFileSync(path.join(root, 'lib', 'local-tts.js'), 'utf8')
const idxSrc = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('语音列表缓存：要会过期，失败不能永久缓存')
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

console.log('\n语音列表缓存：真跑一遍')
{
  clearVoicesCache()
  const first = await listLocalVoices()
  const second = await listLocalVoices()
  check('两次调用返回同一个数组（缓存生效）', first === second)
  clearVoicesCache()
  const third = await listLocalVoices()
  check('清掉缓存后会重新枚举（不是同一个数组）', third !== first)
  check('重新枚举的结果仍然是数组', Array.isArray(third))
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

console.log('\n注释不能撒谎（Linux 没有 piper 分支）')
{
  check('local-tts.js 不再提 piper', !/piper/i.test(localSrc))
  check('注释说明 Linux 只支持 espeak-ng / espeak', /espeak-ng/.test(localSrc))
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
  check('/diagnostics 暴露了 onlineTts 与 neuralTts',
    /onlineTts: \{[\s\S]{0,120}?failures: stats\.onlineTtsFailures/.test(idxSrc)
    && /neuralTts: \{[\s\S]{0,120}?failures: stats\.neuralTtsFailures/.test(idxSrc))
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
