/**
 * 回归测试：并发合成不能把后面的请求永久卡住（「/tts 一直 pending」）。
 *
 * 真实故障（2026-11-01）：
 *   用户报「tts 一直也是 pending」—— 浏览器里 /tts 请求挂住不返回，一句都不出声。
 *
 * 三个叠加的成因，本测试逐个挡住：
 *   1. 串行锁没有上限：客户端 3 路并行预取 + 逐句入队，一旦前面卡住，
 *      后面的全在排队，永远 pending。→ 排队超限要**快速失败**。
 *   2. 超时后 collect 的后台迭代器还在读同一条 audioStream，继续占着接收通道，
 *      下一次合成被它踩 → 新的也收不到音频。→ 超时必须主动 return() 掉这条流。
 *   3. 服务端超时（30s）比客户端（15s）长：客户端早已放弃，服务端还占着锁。
 *      → 服务端超时必须更短。
 */
import fs from 'node:fs'
import os from 'node:os'

const root = new URL('..', import.meta.url)

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

const src = fs.readFileSync(new URL('../lib/edge-tts.js', import.meta.url), 'utf8')

console.log('源码：排队有上限、超时更短、超时会放掉流')
check('排队有上限（MAX_SYNTH_QUEUE）',
  /const MAX_SYNTH_QUEUE = \d+/.test(src) && /synthQueueDepth >= MAX_SYNTH_QUEUE/.test(src),
  '没有上限的话前面卡住 → 后面全部 pending')
check('超限时快速失败而不是排队',
  /synthQueueDepth >= MAX_SYNTH_QUEUE[\s\S]{0,200}?Promise\.reject/.test(src))
check('队列深度会归还（finally 里减一）',
  /\.finally\(\(\) => \{ synthQueueDepth = Math\.max\(0, synthQueueDepth - 1\) \}\)/.test(src),
  '不归还的话跑几句之后永久超限，等于再也不能合成')
check('服务端超时短于客户端 15 秒',
  (() => {
    const m = /const DEFAULT_TIMEOUT_MS = (\d+)/.exec(src)
    return m && Number(m[1]) < 15000
  })(),
  '服务端比客户端后放弃的话，它一直占着串行锁')
check('超时时主动 return 掉 audioStream 的迭代器',
  /iterator\?\.return\?\./.test(src) && /abandonStream/.test(src),
  '不放过它的话，它继续占着接收通道，下一个请求被踩')
check('暴露队列深度（诊断用）',
  /export function synthQueueDepthNow\(/.test(src))

console.log('\n真跑：并发 3 句 + 一个坏实例，后面的必须能失败退出而不是永久 pending')
{
  const fakeVendor = `
    let gen = 0
    class FakeTts {
      constructor() { this.g = ++globalThis.__gen }
      async setMetadata() {}
      toStream() {
        // 第 1 代：第一句永不返回（模拟连接半死）
        // 第 2 代起：正常返回
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
  const tmpDir = fs.mkdtempSync(os.tmpdir() + '/edge-pending-')
  fs.mkdirSync(tmpDir + '/vendor', { recursive: true })
  const code = src.replace("from './vendor/msedge-tts.cjs'", "from './vendor/fake.cjs'")
  fs.writeFileSync(tmpDir + '/edge-tts.mjs', code, 'utf8')
  fs.writeFileSync(tmpDir + '/vendor/fake.cjs', fakeVendor, 'utf8')
  globalThis.__gen = 0

  const mod = await import('file://' + tmpDir.replace(/\\/g, '/') + '/edge-tts.mjs')

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

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
