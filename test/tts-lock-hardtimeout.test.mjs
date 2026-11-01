/**
 * 回归测试：底层方法**永远不 settle** 时，锁也不能被永久占住。
 *
 * 这是「/tts 一直 pending」的最终根因。
 *
 * 之前的超时都加在「读流」那一层（Promise.race + collect），但 MsEdgeTTS 的
 * `setMetadata()` / `toStream()` **自己也可能永远不返回**（WebSocket 半死、
 * 服务端不回包）。那种情况下 task 内部的所有超时都形同虚设，
 * `synthChain` 就永久待定 —— 后面每一句都在排队，浏览器里全部 pending。
 *
 * 所以锁必须**自己带硬超时**，并且队列指针只等硬超时，绝不等 task。
 */
import fs from 'node:fs'
import os from 'node:os'

const src = fs.readFileSync(new URL('../lib/edge-tts.js', import.meta.url), 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('源码：锁必须自带硬超时')
check('withSynthLock 接受硬超时参数',
  /function withSynthLock\(task, hardTimeoutMs/.test(src))
check('有 hardStop 的 setTimeout',
  /const hardStop = new Promise[\s\S]{0,160}?setTimeout/.test(src),
  '只靠 task 内部超时兜不住「setMetadata/toStream 永不返回」')
check('队列指针等 run（含硬超时），不等 gate',
  /synthChain = run\.then\(/.test(src) && !/synthChain = gate/.test(src),
  '等 gate 的话底层卡死就全线卡死')
check('结果用 Promise.race([gate, hardStop])',
  /Promise\.race\(\[gate, hardStop\]\)/.test(src))

console.log('\n真跑：setMetadata 永久挂住，后续请求必须仍能拿到结果')
{
  const fakeVendor = `
    let gen = 0
    class FakeTts {
      constructor() { this.g = ++globalThis.__gen }
      async setMetadata() {
        // 第 1 代实例：setMetadata 永不返回（模拟 WebSocket 半死）
        if (this.g === 1) await new Promise(() => {})
      }
      toStream() {
        return { audioStream: (async function* () { yield Buffer.from([0xff, 0xf3, 1, 2]) })() }
      }
      close() {}
    }
    module.exports = { MsEdgeTTS: FakeTts, OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'x' } }
  `
  const tmpDir = fs.mkdtempSync(os.tmpdir() + '/edge-hardtimeout-')
  fs.mkdirSync(tmpDir + '/vendor', { recursive: true })
  // 把硬超时改小，好让测试快跑（生产是 15 秒）
  const code = src
    .replace("from './vendor/msedge-tts.cjs'", "from './vendor/fake.cjs'")
    .replace('DEFAULT_TIMEOUT_MS + 3000', '1500')
  fs.writeFileSync(tmpDir + '/edge-tts.mjs', code, 'utf8')
  fs.writeFileSync(tmpDir + '/vendor/fake.cjs', fakeVendor, 'utf8')
  globalThis.__gen = 0

  const mod = await import('file://' + tmpDir.replace(/\\/g, '/') + '/edge-tts.mjs')

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

  const r2 = await Promise.race([
    second,
    new Promise((r) => setTimeout(() => r({ ok: false, err: 'TEST_HUNG' }), 8000)),
  ])
  check('后面那句拿到了结果（锁没有被永久占住）', r2.err !== 'TEST_HUNG', JSON.stringify(r2))
  check('后面那句成功合成', r2.ok === true && r2.bytes > 0, JSON.stringify(r2))

  const ms = Date.now() - t0
  check('整体在合理时间内结束（< 12 秒）', ms < 12000, ms + 'ms')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
