/**
 * Edge 在线合成：并发/卡死/重连（合并自原 tts-pending / tts-reconnect / tts-lock-hardtimeout）。
 *
 * 三个真实故障，逐个守护：
 *   1. 「/tts 一直 pending」：串行锁没有上限、超时后 collect 的迭代器还在读同一条
 *      audioStream（占着接收通道）、服务端超时比客户端还长。
 *   2. 「界面显示朗读中、但一点声音都没有」：连接坏掉（空音频）后不丢弃共享实例，
 *      之后每一句都返回空音频，只有重启 DSH 才能好。
 *   3. 「锁被永久占住」的最终根因：`setMetadata` / `toStream` **自己**也可能永远不返回，
 *      此时 task 内部的所有超时都形同虚设 —— 锁必须自带硬超时，队列指针只等硬超时。
 *
 * 全部真跑：把真实 `lib/edge-tts.js` 复制到临时目录、只把 vendor 换成假合成器，
 * 于是驱动的是**生产代码本身**，只把网络层变成可控的。
 */
import fs from 'node:fs'
import os from 'node:os'

const SRC = fs.readFileSync(new URL('../lib/edge-tts.js', import.meta.url), 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/**
 * 载入「真实 edge-tts 源码 + 假 vendor」的临时模块。
 *
 * @param {string} fakeVendor - 假 vendor 的 CJS 源码（module.exports = { MsEdgeTTS, OUTPUT_FORMAT }）。
 * @param {{globalName?: string, tune?: (code: string) => string}} [opts] -
 *   globalName：假 vendor 用来记代次的全局变量名（各段互不干扰）；
 *   tune：对复制出来的源码做参数替换（例如把硬超时改小）。
 * @returns {Promise<object>} 临时目录里的 edge-tts 模块。
 */
async function loadEdgeTtsWithFakeVendor(fakeVendor, { globalName = '__gen', tune = null } = {}) {
  const tmpDir = fs.mkdtempSync(os.tmpdir() + '/edge-tts-test-')
  fs.mkdirSync(tmpDir + '/vendor', { recursive: true })
  let code = SRC.replace("from './vendor/msedge-tts.cjs'", "from './vendor/fake.cjs'")
  if (tune) code = tune(code)
  fs.writeFileSync(tmpDir + '/edge-tts.mjs', code, 'utf8')
  fs.writeFileSync(tmpDir + '/vendor/fake.cjs', fakeVendor, 'utf8')
  globalThis[globalName] = 0
  return import('file://' + tmpDir.replace(/\\/g, '/') + '/edge-tts.mjs')
}

// ---------------------------------------------------------------------------
// A. 源码约束（合并三个文件的静态守卫）
// ---------------------------------------------------------------------------
console.log('源码：排队有上限、超时更短、超时会放掉流')
check('排队有上限（MAX_SYNTH_QUEUE）',
  /const MAX_SYNTH_QUEUE = \d+/.test(SRC) && /synthQueueDepth >= MAX_SYNTH_QUEUE/.test(SRC),
  '没有上限的话前面卡住 → 后面全部 pending')
check('超限时快速失败而不是排队',
  /synthQueueDepth >= MAX_SYNTH_QUEUE[\s\S]{0,200}?Promise\.reject/.test(SRC))
check('队列深度会归还（finally 里减一）',
  /\.finally\(\(\) => \{ synthQueueDepth = Math\.max\(0, synthQueueDepth - 1\) \}\)/.test(SRC),
  '不归还的话跑几句之后永久超限，等于再也不能合成')
check('服务端超时短于客户端 15 秒',
  (() => {
    const m = /const DEFAULT_TIMEOUT_MS = (\d+)/.exec(SRC)
    return m && Number(m[1]) < 15000
  })(),
  '服务端比客户端后放弃的话，它一直占着串行锁')
check('超时时主动 return 掉 audioStream 的迭代器',
  /iterator\?\.return\?\./.test(SRC) && /abandonStream/.test(SRC),
  '不放过它的话，它继续占着接收通道，下一个请求被踩')
check('暴露队列深度（诊断用）',
  /export function synthQueueDepthNow\(/.test(SRC))

console.log('\n源码：坏连接必须被丢弃（静态形状）')
check('抽出统一的 isBrokenConnection 判据',
  /function isBrokenConnection\(/.test(SRC),
  '四处各写一份正则会分叉，改一处漏一处')
check('「没有收到音频数据」被判为坏连接',
  /没有收到音频数据|未收到音频/.test(SRC) &&
  /isBrokenConnection\([^)]*\)[^\n]*\n?[^\n]*disposeTts\(\)/.test(SRC),
  '这条错误原来不被当成连接错误，坏连接永远不丢 → 永久无声')
check('空音频分支自己就 disposeTts()',
  /if \(!chunks\.length\) \{[\s\S]{0,200}?disposeTts\(\)[\s\S]{0,120}?throw new Error\('合成结束但没有收到音频数据/.test(SRC),
  '空音频时必须在抛错前丢掉共享连接，否则后续全部失败')

console.log('\n源码：锁必须自带硬超时')
check('withSynthLock 接受硬超时参数',
  /function withSynthLock\(task, hardTimeoutMs/.test(SRC))
check('有 hardStop 的 setTimeout',
  /const hardStop = new Promise[\s\S]{0,160}?setTimeout/.test(SRC),
  '只靠 task 内部超时兜不住「setMetadata/toStream 永不返回」')
check('队列指针等 run（含硬超时），不等 gate',
  /synthChain = run\.then\(/.test(SRC) && !/synthChain = gate/.test(SRC),
  '等 gate 的话底层卡死就全线卡死')
check('结果用 Promise.race([gate, hardStop])',
  /Promise\.race\(\[gate, hardStop\]\)/.test(SRC))

// ---------------------------------------------------------------------------
// B. 真跑：并发 3 句 + 一个坏实例，后面的必须能失败退出而不是永久 pending
// ---------------------------------------------------------------------------
console.log('\n真跑：并发 3 句 + 一个坏实例，后面的必须能失败退出而不是永久 pending')
{
  // 第 1 代：第一句永不返回（模拟连接半死）；第 2 代起：正常返回。
  const fakeVendor = `
    let gen = 0
    class FakeTts {
      constructor() { this.g = ++globalThis.__gen }
      async setMetadata() {}
      toStream() {
        const self = this
        return { audioStream: (async function* () {
          if (self.g === 1) {
            await new Promise(() => {}) // 永不结束
          }
          yield Buffer.from([0xff, 0xf3, 0x00, 0x00])
        })() }
      }
      close() {}
    }
    module.exports = { MsEdgeTTS: FakeTts, OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'x' } }
  `
  const mod = await loadEdgeTtsWithFakeVendor(fakeVendor, { globalName: '__gen' })

  // 一句会卡住的（第 1 代），给它 1 秒超时
  const stuck = mod.synthesizeSpeech({ text: '卡住的一句' }, 1000).then(
    () => 'resolved',
    (e) => 'rejected:' + String(e.message).slice(0, 20),
  )
  // 同时排上来的一句（正常路径，应当很快返回）
  const t0 = Date.now()
  const follow = mod.synthesizeSpeech({ text: '后面的一句' }, 6000).then(
    (b) => 'ok:' + b.length,
    (e) => 'rejected:' + String(e.message).slice(0, 30),
  )
  const r1 = await stuck
  const r2 = await follow
  const ms = Date.now() - t0

  check('卡住的那句会超时失败（不会永久 pending）', /^rejected/.test(r1), r1)
  check('后面那句不会跟着永久卡死（在 10 秒内有了结果）', ms < 10000, ms + 'ms → ' + r2)
  check('后面那句最终成功（换了新实例）', /^ok:/.test(r2), r2)
  check('队列深度已归还', mod.synthQueueDepthNow() === 0, String(mod.synthQueueDepthNow()))
}

// ---------------------------------------------------------------------------
// C. 真跑：坏连接返回空音频 → 下一次必须重建实例并成功
// ---------------------------------------------------------------------------
console.log('\n真跑：用假合成器模拟「坏连接返回空音频」')
{
  // 第 1 代实例：永远返回空音频（模拟坏连接）；第 2 代及以后：正常音频。
  const fakeVendor = `
    let generation = 0
    class FakeTts {
      constructor() { this.g = ++globalThis.__fakeGen }
      async setMetadata() {}
      toStream() {
        if (this.g === 1) {
          return { audioStream: (async function* () { /* 没有音频 */ })() }
        }
        return { audioStream: (async function* () { yield Buffer.from([0xff, 0xf3, 0x60, 0x00]); yield Buffer.from([1, 2, 3]) })() }
      }
      close() {}
    }
    module.exports = { MsEdgeTTS: FakeTts, OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3' } }
  `
  const mod = await loadEdgeTtsWithFakeVendor(fakeVendor, { globalName: '__fakeGen' })

  // 第一次：坏连接 → 空音频
  let firstError = null
  try {
    await mod.synthesizeSpeech({ text: '第一句。' })
  } catch (e) { firstError = e.message }
  check('第一次合成因为空音频失败', firstError && /没有收到音频数据/.test(firstError), String(firstError))

  // 第二次：必须新建实例（generation 2）并成功
  let second = null
  let secondError = null
  try {
    second = await mod.synthesizeSpeech({ text: '第二句。' })
  } catch (e) { secondError = e.message }
  check('第二次合成自动恢复（重建连接后有音频）',
    second && second.length > 0,
    secondError ? '还是失败：' + secondError : JSON.stringify(second))
  check('确实重建了合成器实例', globalThis.__fakeGen >= 2, 'generation=' + globalThis.__fakeGen)
}

// ---------------------------------------------------------------------------
// D. 真跑：setMetadata 永久挂住，后续请求必须仍能拿到结果
// ---------------------------------------------------------------------------
console.log('\n真跑：setMetadata 永久挂住，后续请求必须仍能拿到结果')
{
  // 第 1 代实例：setMetadata 永不返回（模拟 WebSocket 半死）。
  const fakeVendor = `
    let gen = 0
    class FakeTts {
      constructor() { this.g = ++globalThis.__gen }
      async setMetadata() {
        if (this.g === 1) await new Promise(() => {})
      }
      toStream() {
        return { audioStream: (async function* () { yield Buffer.from([0xff, 0xf3, 1, 2]) })() }
      }
      close() {}
    }
    module.exports = { MsEdgeTTS: FakeTts, OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'x' } }
  `
  const mod = await loadEdgeTtsWithFakeVendor(fakeVendor, {
    globalName: '__gen',
    // 把硬超时改小，好让测试快跑（生产是 DEFAULT_TIMEOUT_MS + 3000）
    tune: (code) => code.replace('DEFAULT_TIMEOUT_MS + 3000', '1500'),
  })

  const t0 = Date.now()
  const first = mod.synthesizeSpeech({ text: '会卡死的一句' }).then(
    () => ({ ok: true }), (e) => ({ ok: false, err: e.message }),
  )
  // 紧接着排队的一句：第 2 代实例，应当正常返回
  const second = mod.synthesizeSpeech({ text: '后面的一句' }).then(
    (b) => ({ ok: true, bytes: b.length }), (e) => ({ ok: false, err: e.message }),
  )

  const r1 = await first
  check('挂住的那句最终失败退出（不是永久 pending）', r1.ok === false, JSON.stringify(r1))
  check('失败原因是超时', r1.ok === false && /超时/.test(r1.err), r1.err)

  // 兜底定时器必须 clear + unref：否则断言 1.5s 就结束，进程还要被它拖住 8 秒。
  let hungTimer = null
  const hung = new Promise((r) => {
    hungTimer = setTimeout(() => r({ ok: false, err: 'TEST_HUNG' }), 8000)
    hungTimer.unref?.()
  })
  const r2 = await Promise.race([second, hung])
  clearTimeout(hungTimer)
  check('后面那句拿到了结果（锁没有被永久占住）', r2.err !== 'TEST_HUNG', JSON.stringify(r2))
  check('后面那句成功合成', r2.ok === true && r2.bytes > 0, JSON.stringify(r2))

  const ms = Date.now() - t0
  check('整体在合理时间内结束（< 12 秒）', ms < 12000, ms + 'ms')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
