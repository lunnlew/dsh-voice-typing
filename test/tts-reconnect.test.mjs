/**
 * 回归测试：Edge 共享连接坏掉之后必须能自动恢复。
 *
 * 真实故障（2026-11-01 实测 /diagnostics）：
 *   onlineTtsFailures: 7
 *   lastOnlineTtsError: "合成结束但没有收到音频数据（服务端可能拒绝了请求）。"
 *
 * 成因：这条错误没有被当成「连接坏了」，于是 `disposeTts()` 不会被执行，
 * 坏掉的共享连接被一直复用 —— 之后每一句都返回空音频，用户听到的就是
 * 「界面显示朗读中、但一点声音都没有」，只有重启 DSH 才能好。
 *
 * 本测试用一个假的合成器注入进去，模拟「连接坏掉后返回空音频」，
 * 断言修复后**第二次合成会重建连接并成功**。
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = new URL('..', import.meta.url)

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

const src = fs.readFileSync(new URL('../lib/edge-tts.js', import.meta.url), 'utf8')

console.log('源码：坏连接必须被丢弃（静态形状）')
check('抽出统一的 isBrokenConnection 判据',
  /function isBrokenConnection\(/.test(src),
  '四处各写一份正则会分叉，改一处漏一处')
check('「没有收到音频数据」被判为坏连接',
  /没有收到音频数据|未收到音频/.test(src) &&
  /isBrokenConnection\([^)]*\)[^\n]*\n?[^\n]*disposeTts\(\)/.test(src),
  '这条错误原来不被当成连接错误，坏连接永远不丢 → 永久无声')
check('空音频分支自己就 disposeTts()',
  /if \(!chunks\.length\) \{[\s\S]{0,200}?disposeTts\(\)[\s\S]{0,120}?throw new Error\('合成结束但没有收到音频数据/.test(src),
  '空音频时必须在抛错前丢掉共享连接，否则后续全部失败')

console.log('\n真跑：用假合成器模拟「坏连接返回空音频」')
{
  // 直接驱动源码里的 synthesizeSpeech —— 把 vendor 换成假的。
  const fakeVendor = `
    let generation = 0
    class FakeTts {
      constructor() { this.g = ++globalThis.__fakeGen }
      async setMetadata() {}
      toStream() {
        // 第 1 代实例：永远返回空音频（模拟坏连接）
        // 第 2 代及以后：返回正常音频（模拟重建后恢复）
        if (this.g === 1) {
          return { audioStream: (async function* () { /* 没有音频 */ })() }
        }
        return { audioStream: (async function* () { yield Buffer.from([0xff, 0xf3, 0x60, 0x00]); yield Buffer.from([1, 2, 3]) })() }
      }
      close() {}
    }
    module.exports = { MsEdgeTTS: FakeTts, OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3' } }
  `
  const tmpDir = fs.mkdtempSync(require('node:os').tmpdir() + '/edge-tts-fix-')
  fs.mkdirSync(tmpDir + '/vendor', { recursive: true })
  // 把源码复制到临时目录，并把 vendor 换成假的
  let code = src.replace("from './vendor/msedge-tts.cjs'", "from './vendor/fake.cjs'")
  fs.writeFileSync(tmpDir + '/edge-tts.mjs', code, 'utf8')
  fs.writeFileSync(tmpDir + '/vendor/fake.cjs', fakeVendor, 'utf8')
  globalThis.__fakeGen = 0

  const mod = await import('file://' + tmpDir.replace(/\\/g, '/') + '/edge-tts.mjs')

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

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
