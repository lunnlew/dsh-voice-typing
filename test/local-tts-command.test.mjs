/**
 * 集成测试：本地 TTS 到底把什么交给了系统命令（`src/host/local-tts.js`）。
 *
 * 来源（docs/architecture-modernization.md §8.34 批次 1）：
 *   `test/local-tts.test.mjs` 里原来有 59 条**源码文本**判据，形如
 *     check('say 直接写 WAV', localSrc.includes("'--file-format=WAVE'"))
 *     check('路径里的单引号被转义成两个', /replace\(\/'\/g, "''"\)/.test(localSrc))
 *   它们钉的是写法，两头都错：
 *     - 假红：把 `'--file-format=WAVE'` 换成双引号（行为一模一样）它红；
 *     - 漏红：真把 `--data-format=LEI16@22050` 拼成 `LEI16@44100`（音频会变调/加速）
 *       只要那串子字符还在，它绿。
 *   本文件改用 `test/helpers/fake-child-process.mjs` 这个接缝：把 `src/host/**` 拷进临时目录、
 *   把 `node:child_process` 换成记录器、按平台 import，于是
 *     - 命令行参数 → 在**记录下来的 argv** 上比；
 *     - PowerShell 脚本 → 假 powershell 在调用当下把 `-File` 那个脚本读出来，比脚本内容；
 *     - 「产出 WAV」→ 假 say/espeak 真的往 `-o`/`-w` 路径写文件，比**返回的字节是不是 RIFF/WAVE**；
 *     - 缓存 → 数起了几个进程。
 */
import fs from 'node:fs'
import {
  fakeAiffBytes,
  fakeWavBytes,
  loadHostModuleWithFakeCp,
} from './helpers/fake-child-process.mjs'
import { TTS_TIMEOUT_MS } from '../src/client/pure/voice-constants.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 从 argv 里取 `-o` / `-w` 后面的那个路径。 */
function flagValue(args, flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : null
}

/**
 * 读一个「可能已经不在了 / 参数可能没传对」的文件。
 * 假 vendor 里用它：参数不对时，让**判据**去红，而不是让测试进程炸。
 */
function readIf(path) {
  try { return path ? fs.readFileSync(path) : null } catch { return null }
}

/** 写出一个文件（路径不存在于参数里时安静跳过，理由同上）。 */
function writeIf(path, buffer) {
  if (!path) return
  try { fs.writeFileSync(path, buffer) } catch { /* 路径可能无效，判据会因此红，够了 */ }
}

/** 找到某个命令的第一条调用记录。 */
function callOf(calls, cmd) {
  return calls.find((c) => c.cmd === cmd)
}

// ---------------------------------------------------------------------------
// 判据：全部跑在「一次装载」的结果上（装载 = 把宿主源码拷进临时树再 import）
// ---------------------------------------------------------------------------

/**
 * 跑完整套场景，返回每条判据的 {name, ok, detail}。
 * @param {(code: string) => string} [tune] - 对拷出去的源码做的改动（测试替身的注入接缝）。
 * @returns {Promise<Array<{name: string, ok: boolean, detail: string}>>}
 */
async function evaluate(tune = null) {
  const out = []
  const add = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail: String(detail ?? '') })
  /** 每一次真起过的子进程调用都汇到这里，最后按调用逐条查「参数带齐了没」。 */
  const seenCalls = []
  /** 收调用 + 还原临时目录（每个场景结尾都走它，别漏）。 */
  const collect = (env) => { seenCalls.push(...env.calls); env.restore() }
  /** 枚举语音时假 powershell 读到的脚本内容（「编码行在 Add-Type 之前」那两条要用）。 */
  const voicesScripts = []

  // --- macOS：say 直接写 WAV -------------------------------------------
  {
    // 文本文件在 synthesizeMac 的 finally 里就被删了，所以**调用当下**读走内容。
    let textSeen = null
    const env = await loadHostModuleWithFakeCp('local-tts', {
      platform: 'darwin',
      tune,
      vendor: (call) => {
        if (call.cmd !== 'say') return {}
        const out_ = flagValue(call.args, '-o')
        if (!out_) return {}
        textSeen = readIf(flagValue(call.args, '-f'))?.toString('utf8') ?? null
        // 假 say 的行为等价物：给了 --file-format=WAVE 才写 WAV，否则写 macOS 默认的 AIFF。
        writeIf(out_, call.args.includes('--file-format=WAVE') ? fakeWavBytes() : fakeAiffBytes())
        return {}
      },
    })
    const r = await env.mod.synthesizeLocal({ text: '今天下午 3 点开会', voice: 'Tingting', rate: '+20%' })
    const say = callOf(env.calls, 'say')
    add('macOS：真的起了 say 进程', !!say, JSON.stringify(env.calls.map((c) => c.cmd)))
    add('macOS：say 参数里有 --file-format=WAVE', say?.args.includes('--file-format=WAVE'), say?.args.join(' '))
    add('macOS：say 参数里有 --data-format=LEI16@22050（小端 16bit / 22050Hz）',
      say?.args.includes('--data-format=LEI16@22050'), say?.args.join(' '))
    add('macOS：返回的字节真是 WAV 容器（RIFF 头）',
      r?.audio?.slice(0, 4)?.toString() === 'RIFF', r?.audio?.slice(0, 4)?.toString())
    add('macOS：返回的 format 是 wav（宿主按它定 mime）', r?.format === 'wav', r?.format)
    add('macOS：语速换算成了 -r 词数（+20% → 240）',
      flagValue(say?.args ?? [], '-r') === '240', flagValue(say?.args ?? [], '-r'))
    add('macOS：发音人走 -v', say?.args.includes('-v') && say.args.includes('Tingting'), say?.args.join(' '))
    // 文本走文件，不进 argv：say 的选项解析不保证认 `--`，不认的话整句会被读成「--」。
    const textFile = flagValue(say?.args ?? [], '-f')
    add('macOS：文本用 -f 文件传（argv 里没有那段文本）',
      !!textFile && !say.args.some((a) => String(a).includes('开会')), say?.args.join(' '))
    add('macOS：-f 那个文件里就是原文（以 - 开头的行也不当选项）',
      textSeen === '今天下午 3 点开会', JSON.stringify(textSeen))
    add('macOS：子进程参数带 timeout（不会永久挂着）',
      typeof say?.opts?.timeout === 'number' && say.opts.timeout > 0, JSON.stringify(say?.opts))
    add('macOS：子进程参数带 windowsHide（不闪控制台窗）',
      say?.opts?.windowsHide === true, JSON.stringify(say?.opts))
    add('macOS：子进程参数把 maxBuffer 放到 1MB 以上（语音列表会超）',
      say?.opts?.maxBuffer > 1024 * 1024, String(say?.opts?.maxBuffer))
    // 临时文件收尾：合成完了不能把 wav/txt 留在盘上。
    const leftovers = [textFile, flagValue(say.args, '-o')]
      .filter((p) => p && fs.existsSync(p))
    add('macOS：中间文件用完就删（临时目录没留wav/txt）', leftovers.length === 0, leftovers.join(','))
    collect(env)
  }

  // --- macOS 老系统：没有 --file-format，走 afconvert 兜底 ----------------
  {
    // afconvert 读到的中间产物要在**调用当下**记下来：那批临时文件在 finally 里就被清了。
    let aiffSeen = null
    const env = await loadHostModuleWithFakeCp('local-tts', {
      platform: 'darwin',
      tune,
      vendor: (call) => {
        if (call.cmd === 'say' && call.args.includes('--file-format=WAVE')) {
          return { error: { message: 'say: unknown option --file-format', code: 1 } }
        }
        if (call.cmd === 'say') {
          writeIf(flagValue(call.args, '-o'), fakeAiffBytes())
          return {}
        }
        if (call.cmd === 'afconvert') {
          const dst = call.args[call.args.length - 1]
          aiffSeen = readIf(call.args[call.args.length - 2])
          writeIf(dst, fakeWavBytes())
          return {}
        }
        return {}
      },
    })
    const r = await env.mod.synthesizeLocal({ text: '- 列表项开头的文本' })
    const convert = callOf(env.calls, 'afconvert')
    add('macOS 兜底：第一条路失败后确实起了 afconvert', !!convert, JSON.stringify(env.calls.map((c) => c.cmd)))
    add('macOS 兜底：afconvert 的目标容器是 WAVE',
      convert?.args.includes('-f') && convert.args[convert.args.indexOf('-f') + 1] === 'WAVE',
      convert?.args.join(' '))
    add('macOS 兜底：喂给 afconvert 的中间产物是 AIFF（不是空文件）',
      aiffSeen?.slice(0, 4)?.toString() === 'FORM' && aiffSeen?.length > 12,
      aiffSeen === null ? 'afconvert 没被叫到' : String(aiffSeen.length))
    add('macOS 兜底：最终返回给宿主的仍是 WAV（AIFF 只是中间产物）',
      r?.audio?.slice(0, 4)?.toString() === 'RIFF' && r?.format === 'wav', r?.format)
    collect(env)
  }

  // --- macOS：两条路都不成 → 抛错（/tts 才有机会回退在线） ------------------
  {
    const env = await loadHostModuleWithFakeCp('local-tts', {
      platform: 'darwin',
      tune,
      vendor: () => ({ error: { message: 'command died', code: 1 } }),
    })
    const message = await env.mod.synthesizeLocal({ text: 'x' }).then(() => '', (e) => e.message)
    add('macOS：两条路都失败时抛错，而不是返回空音频',
      /macOS 本地合成失败/.test(message), message)
    add('macOS：错误里带上 say 直接写 WAV 的原始失败原因（能查）',
      /command died/.test(message), message)
    collect(env)
  }

  // --- Windows：PowerShell + SAPI ----------------------------------------
  {
    let script = ''
    const env = await loadHostModuleWithFakeCp('local-tts', {
      platform: 'win32',
      tune,
      vendor: (call) => {
        // 认 powershell 也认 pwsh：命令名换成别的应当只让「命令名」那条判据红，
        // 不该因为假 vendor 不接这个命令而把整轮跑炸。
        if (call.cmd !== 'powershell' && call.cmd !== 'pwsh') return {}
        script = readIf(flagValue(call.args, '-File'))?.toString('utf8') ?? ''
        // 假 SAPI：照脚本里 SetOutputToWaveFile 的路径真写出 WAV 文件。
        // 引号两种都认 —— 单引号被写成别的应当只让「输出路径是单引号串」那条红，
        // 不该因为假 SAPI 读不到路径而把整轮跑炸。
        const m = /SetOutputToWaveFile\((['"])([^'"]*)\1\)/.exec(script)
        if (m) writeIf(m[2].replace(/''/g, "'"), fakeWavBytes(16))
        return {}
      },
    })
    const r = await env.mod.synthesizeLocal({ text: "It's $HOME 的路径", voice: 'Microsoft Huihui Desktop', rate: '+30%', volume: '-20%' })
    const ps = callOf(env.calls, 'powershell')
    add('Windows：命令名仍然是 powershell（Windows PowerShell 5.1）', ps?.cmd === 'powershell', ps?.cmd)
    add('Windows：没有换成 pwsh（PS7 的 .NET Core 没有 System.Speech）',
      ps?.cmd !== 'pwsh' && !env.calls.some((c) => c.cmd === 'pwsh'), JSON.stringify(env.calls.map((c) => c.cmd)))
    add('Windows：带 -NoProfile / -ExecutionPolicy Bypass / -File 三件套',
      ps?.args.includes('-NoProfile') && ps?.args.includes('-ExecutionPolicy') && ps?.args.includes('-File'),
      ps?.args.join(' '))
    add('Windows：返回的字节真是 WAV、format 是 wav',
      r?.audio?.slice(0, 4)?.toString() === 'RIFF' && r?.format === 'wav', r?.format)
    // 合成脚本**不需要**编码行：它不往 stdout 写任何东西（读不到中文列表就不存在乱码问题）。
    // 编码行只在枚举语音那条路上判（见下面那节）。
    add('Windows：脚本里输出路径是单引号串（双引号会让用户名里的 $ 被展开）',
      /SetOutputToWaveFile\('[^']*'\)/.test(script) && !/SetOutputToWaveFile\("/.test(script),
      (script.match(/SetOutputToWaveFile\(.*/) ?? [''])[0])
    add('Windows：文本里的单引号被转义成两个（PowerShell 的转义写法）',
      script.includes("$s.Speak('It''s $HOME 的路径')"), (script.match(/\$s\.Speak\(.*/) ?? [''])[0])
    add('Windows：发音人走 SelectVoice，且文本/路径不会互相抢引号',
      script.includes("SelectVoice('Microsoft Huihui Desktop')"), (script.match(/SelectVoice\(.*/) ?? [''])[0])
    add('Windows：语速折成 SAPI 的 -10..10 档（+30% → +5）',
      /\$s\.Rate = 5/.test(script), (script.match(/\$s\.Rate = .*/) ?? [''])[0])
    add('Windows：音量折成 0..100（-20% → 80）',
      /\$s\.Volume = 80/.test(script), (script.match(/\$s\.Volume = .*/) ?? [''])[0])
    add('Windows：ps1 脚本用完即删（临时目录不积累脚本）',
      ps && !fs.existsSync(flagValue(ps.args, '-File')), flagValue(ps?.args ?? [], '-File'))
    collect(env)
  }

  // --- Windows：枚举语音（编码行 + 缓存） ----------------------------------
  {
    const env = await loadHostModuleWithFakeCp('local-tts', {
      platform: 'win32',
      tune,
      vendor: (call) => {
        if (call.cmd !== 'powershell' && call.cmd !== 'pwsh') return {}
        const text = readIf(flagValue(call.args, '-File'))?.toString('utf8') ?? ''
        voicesScripts.push(text)
        return { stdout: JSON.stringify([
          { name: 'Microsoft Huihui Desktop', culture: 'zh-CN', gender: 'Female' },
          { name: 'Microsoft David Desktop', culture: 'en-US', gender: 'Male' },
        ]) }
      },
    })
    const voices = await env.mod.listLocalVoices()
    add('Windows：语音列表来自真探测（两条都在）',
      voices.length === 2 && voices[0].culture === 'zh-CN' && voices[1].gender === 'Male', JSON.stringify(voices))
    add('Windows：枚举脚本第一行就设了 UTF8 输出编码',
      /^\uFEFF?\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/.test(voicesScripts[0] ?? ''),
      (voicesScripts[0] ?? '').slice(0, 60))
    add('Windows：编码行在 Add-Type 之前（放在后面时前面的输出已经按 GBK 走了）',
      (voicesScripts[0] ?? '').indexOf('OutputEncoding') >= 0
      && (voicesScripts[0] ?? '').indexOf('OutputEncoding') < (voicesScripts[0] ?? '').indexOf('Add-Type'),
      voicesScripts[0]?.slice(0, 120))
    add('Windows：起一个进程就能拿到列表', env.calls.length === 1, String(env.calls.length))
    await env.mod.listLocalVoices()
    add('Windows：第二次调用命中缓存（不再起进程）', env.calls.length === 1, String(env.calls.length))
    env.mod.clearVoicesCache()
    await env.mod.listLocalVoices()
    add('Windows：clearVoicesCache() 之后会重新探测', env.calls.length === 2, String(env.calls.length))
    collect(env)
  }

  // --- 缓存会过期（把表观时间往前拨 11 分钟） --------------------------------
  {
    const env = await loadHostModuleWithFakeCp('local-tts', {
      platform: 'win32',
      tune,
      vendor: () => ({ stdout: '[]' }),
    })
    const realNow = Date.now
    try {
      await env.mod.listLocalVoices()
      add('缓存：没有语音的机器上，空结果也被缓存（否则每次合成都起进程）',
        (() => { const before = env.calls.length; return before === 1 })(), String(env.calls.length))
      await env.mod.listLocalVoices()
      add('缓存：空结果命中缓存，没再起第二个进程', env.calls.length === 1, String(env.calls.length))
      const later = realNow() + (11 * 60 * 1000)
      Date.now = () => later
      await env.mod.listLocalVoices()
      add('缓存：过 TTL（10 分钟）之后会重探一次（用户后来装好环境能刷出来）',
        env.calls.length === 2, String(env.calls.length))
      add('缓存：TTL 常量本身是 10 分钟（改它要连着改这条）', env.mod.VOICES_CACHE_MS === 600_000,
        String(env.mod.VOICES_CACHE_MS))
    } finally {
      Date.now = realNow
    }
    collect(env)
  }

  // --- Windows：powershell 不存在 → 人话，而不是静默回退在线 ------------------
  {
    const env = await loadHostModuleWithFakeCp('local-tts', {
      platform: 'win32',
      tune,
      vendor: () => ({ error: Object.assign(new Error('spawn powershell ENOENT'), { code: 'ENOENT' }) }),
    })
    const message = await env.mod.synthesizeLocal({ text: 'x' }).then(() => '', (e) => e.message)
    add('Windows：ENOENT 翻成人话（不是原始的 spawn 错误）', /找不到 powershell/.test(message), message)
    add('Windows：人话里点名要 Windows PowerShell 5.1', /Windows PowerShell 5\.1/.test(message), message)
    add('Windows：人话里说明只有 pwsh 不够（System.Speech 在 .NET Framework 里）',
      /pwsh/.test(message) && /System\.Speech/.test(message), message)
    const voices = await env.mod.listLocalVoices()
    add('Windows：探测失败时语音列表是空数组（不抛到界面）', Array.isArray(voices) && voices.length === 0, JSON.stringify(voices))
    collect(env)
  }

  // --- Linux：espeak-ng / espeak ------------------------------------------
  {
    const env = await loadHostModuleWithFakeCp('local-tts', {
      platform: 'linux',
      tune,
      vendor: (call) => {
        if (call.cmd !== 'espeak-ng') return { error: { message: 'ENOENT', code: 'ENOENT' } }
        writeIf(flagValue(call.args, '-w'), fakeWavBytes())
        return {}
      },
    })
    const r = await env.mod.synthesizeLocal({ text: '- Markdown 列表项' })
    const first = env.calls[0]
    add('Linux：优先试 espeak-ng', first?.cmd === 'espeak-ng', first?.cmd)
    add('Linux：文本前面有 `--`（不然以 - 开头的文本被当成选项）',
      first?.args.includes('--') && first.args[first.args.indexOf('--') + 1] === '- Markdown 列表项',
      first?.args.join(' '))
    add('Linux：`--` 之后就是原文，不经选项解析',
      r?.audio?.slice(0, 4)?.toString() === 'RIFF' && r?.format === 'wav', JSON.stringify(r?.format))
    collect(env)
  }

  // --- Linux：两个都没装 → 安装提示 -----------------------------------------
  {
    const env = await loadHostModuleWithFakeCp('local-tts', {
      platform: 'linux',
      tune,
      vendor: () => ({ error: { message: 'ENOENT', code: 'ENOENT' } }),
    })
    const message = await env.mod.synthesizeLocal({ text: 'x' }).then(() => '', (e) => e.message)
    add('Linux：缺 espeak 时给人话（含两个候选命令名）',
      /espeak-ng/.test(message) && /espeak/.test(message) && /没找到/.test(message), message)
    add('Linux：两个命令名都试过了', env.calls.map((c) => c.cmd).join(',') === 'espeak-ng,espeak',
      env.calls.map((c) => c.cmd).join(','))
    collect(env)
  }

  // --- 平台可用性：不再拿 process.platform 当「可用」 --------------------------
  {
    const env = await loadHostModuleWithFakeCp('local-tts', { platform: 'darwin', tune, vendor: () => ({}) })
    add('win32/darwin/linux 三档都算「支持本地合成」', env.mod.isLocalSupported() === true,
      env.mod.isLocalSupported())
    add('darwin 的默认发音人是 Tingting', env.mod.defaultLocalVoice() === 'Tingting', env.mod.defaultLocalVoice())
    collect(env)
  }
  {
    const env = await loadHostModuleWithFakeCp('local-tts', { platform: 'freebsd', tune, vendor: () => ({}) })
    add('其它平台（freebsd）算不支持', env.mod.isLocalSupported() === false, env.mod.isLocalSupported())
    const message = await env.mod.synthesizeLocal({ text: 'x' }).then(() => '', (e) => e.message)
    add('不支持的平台直接抛「请用在线引擎」', /在线引擎/.test(message), message)
    collect(env)
  }

  // --- 输入边界 -------------------------------------------------------------
  {
    const env = await loadHostModuleWithFakeCp('local-tts', { platform: 'darwin', tune, vendor: () => ({}) })
    const empty = await env.mod.synthesizeLocal({ text: '   ' }).then(() => '', (e) => e.message)
    add('空文本抛中文错误，不起进程', /文本为空/.test(empty) && env.calls.length === 0, `${empty} / ${env.calls.length}`)
    const tooLong = await env.mod.synthesizeLocal({ text: '一'.repeat(3001) }).then(() => '', (e) => e.message)
    add('超过 3000 字抛错并说明上限', /3000/.test(tooLong), tooLong)
    collect(env)
  }

  // --- 引擎自检：available 来自**真探测**，不是「平台对不对」 -------------------
  // 注意 platformHold：tts-env 是在**调用时**读 process.platform 的（不像 local-tts 有模块级
  // 常量），装完模块就还原平台的话，这里跑的三条 macOS/Linux 判据实际全在断 Windows 分支。
  // 覆写会一直留着直到 env.restore()，所以每条路径都必须还原 —— 交给 withTtsEnv 的 finally。
  const withTtsEnv = async (platform, vendor, body) => {
    const env = await loadHostModuleWithFakeCp('tts-env', { platform, tune, vendor, platformHold: true })
    try { await body(env) } finally { collect(env) }
  }
  await withTtsEnv('win32', () => ({ stdout: '5.1.19041.1\n' }), async (env) => {
    // Windows：powershell 存在与否决定可用性；探测参数与合成同一套（不闪窗、缓冲够大）。
    const probe = await env.mod.probeLocalEngine()
    const call = env.calls[0]
    add('自检(Windows)：探的是 powershell 的版本表，不是猜平台',
      call?.cmd === 'powershell' && call.args.includes('$PSVersionTable.PSVersion.Major'), JSON.stringify(call))
    add('自检(Windows)：探测参数也带 windowsHide（自检每次开面板都跑，闪窗很显眼）',
      call?.opts?.windowsHide === true, JSON.stringify(call?.opts))
    add('自检(Windows)：探测参数带 maxBuffer（nvidia-smi 与它同一份 PROBE_OPTS）',
      call?.opts?.maxBuffer > 1024 * 1024, JSON.stringify(call?.opts))
    add('自检(Windows)：探测到 powershell 才算可用，并把版本号写进说明',
      probe.available === true && /Windows PowerShell 5/.test(probe.detail), JSON.stringify(probe))
    const procsAfterFirst = env.calls.length
    await env.mod.probeLocalEngine()
    add('自检：成功结果会缓存（开一次面板不该起两次进程）',
      env.calls.length === procsAfterFirst, `${env.calls.length} vs ${procsAfterFirst}`)
  })
  await withTtsEnv('win32', () => ({ error: { message: 'ENOENT', code: 'ENOENT' } }), async (env) => {
    // Windows：powershell 不在 → available=false，而且说明里讲清是精简镜像那种情况。
    const probe = await env.mod.probeLocalEngine()
    add('自检(Windows)：powershell 缺失时报不可用（不是「平台对就算可用」）',
      probe.available === false, JSON.stringify(probe))
    add('自检(Windows)：不可用的说明里点名 Windows PowerShell 5.1',
      /Windows PowerShell 5\.1/.test(probe.detail), probe.detail)
    const second = await env.mod.probeLocalEngine()
    add('自检：失败结果**不**缓存（用户装好之后不用重启宿主就能刷出来）',
      second.available === false && env.calls.length === 2, String(env.calls.length))
  })
  await withTtsEnv('darwin', () => ({ stdout: 'Alex en_US' }), async (env) => {
    const probe = await env.mod.probeLocalEngine()
    add('自检(macOS)：探的是 say -v ?',
      env.calls[0]?.cmd === 'say' && env.calls[0].args.join(' ') === '-v ?', JSON.stringify(env.calls[0]))
    add('自检(macOS)：探到就算可用', probe.available === true, JSON.stringify(probe))
  })
  await withTtsEnv('linux', (call) => (call.cmd === 'espeak-ng'
    ? { stdout: 'espeak-ng 1.51' }
    : { error: { message: 'ENOENT', code: 'ENOENT' } }), async (env) => {
    const probe = await env.mod.probeLocalEngine()
    add('自检(Linux)：espeak-ng 在就算可用，说明里写的是探到的那个命令名',
      probe.available === true && /espeak-ng/.test(probe.detail), JSON.stringify(probe))
  })
  await withTtsEnv('linux', () => ({ error: { message: 'ENOENT', code: 'ENOENT' } }), async (env) => {
    const probe = await env.mod.probeLocalEngine()
    add('自检(Linux)：两个命令都没探到 → 不可用，且给了三个发行版的安装命令',
      probe.available === false && /apt install espeak-ng/.test(probe.detail)
      && /dnf install espeak-ng/.test(probe.detail) && /pacman -S espeak-ng/.test(probe.detail),
      probe.detail)
    add('自检(Linux)：espeak-ng 与 espeak 都试了', env.calls.map((c) => c.cmd).join(',') === 'espeak-ng,espeak',
      env.calls.map((c) => c.cmd).join(','))
  })
  await withTtsEnv('freebsd', () => ({}), async (env) => {
    const probe = await env.mod.probeLocalEngine()
    add('自检(其它平台)：不可用，说明里带平台名', probe.available === false && /freebsd/.test(probe.detail),
      JSON.stringify(probe))
    add('自检(其它平台)：一个进程都不用起', env.calls.length === 0, String(env.calls.length))
  })

  // 汇总：**每一条真调用记录**都得带 windowsHide（不闪控制台窗）与放大后的 maxBuffer。
  // 替掉的是三条源码正则（「local-tts 用了 windowsHide」「tts-env 用了 windowsHide」
  // 「没有残留的裸 execFile 默认参数」）：那种写法只看代码里出现过没有，
  // 新增一条漏参数的调用它照样绿，换成别的写法它照样红。这里按调用逐条数。
  const bare = seenCalls.filter((c) => c.opts?.windowsHide !== true || !(c.opts.maxBuffer > 1024 * 1024))
  add(`每一次子进程调用都带 windowsHide 与放大后的 maxBuffer（共 ${seenCalls.length} 次调用）`,
    seenCalls.length > 0 && bare.length === 0,
    bare.map((b) => `${b.cmd} ${JSON.stringify(b.opts)}`).join(' | '))

  // 跨端的那条时间契约（批次 21）：宿主这一侧的每一次子进程调用，都要比客户端
  // 「等这一句合成」的那句超时先给结果。客户端的数字只住在
  // `src/client/pure/voice-constants.js`，这里 import 进来比，测试里不另抄一份。
  // 为什么按调用逐条数、而不是读宿主那个常量：那个常量没导出（导出了也没法证明
  // 每一次调用都用了它），而「某一条调用忘了带 timeout」正是挂死的形状。
  const noDeadline = seenCalls.filter((c) => !(typeof c.opts?.timeout === 'number' && c.opts.timeout > 0))
  add(`每一次子进程调用都带了超时（缺的 ${noDeadline.length} 次）`,
    seenCalls.length > 0 && noDeadline.length === 0,
    noDeadline.map((b) => `${b.cmd} ${JSON.stringify(b.opts)}`).join(' | '))
  const tooLate = seenCalls.filter((c) => typeof c.opts?.timeout === 'number' && c.opts.timeout >= TTS_TIMEOUT_MS)
  add(`宿主的超时都早于客户端单句合成超时 ${TTS_TIMEOUT_MS}ms（迟的 ${tooLate.length} 次）`,
    tooLate.length === 0,
    tooLate.map((b) => `${b.cmd} ${b.opts.timeout}ms`).join(' | '))

  return out
}


// ---------------------------------------------------------------------------
// 1) 基线：全绿
// ---------------------------------------------------------------------------
console.log('本地 TTS 的命令行行为（假 child_process，三平台）')
for (const r of await evaluate()) check(r.name, r.ok, r.detail)


console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed) process.exitCode = 1
