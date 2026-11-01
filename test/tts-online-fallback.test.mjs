/**
 * 端到端：在线引擎失败时必须回退到本地系统语音（保证「总有声音」）。
 *
 * 真实故障：配置 ttsEngine=online，Edge 因代理/网络问题整体不可用
 * （/diagnostics 实测 onlineTts.failures 涨到 77，全部「15000 毫秒无结果」）。
 * 而 /tts 的 online 分支原来**直接抛错、无任何回退** ——
 * 客户端拿到 500 静默跳过每一句，用户听到的就是彻底没声音。
 *
 * 本测试把 edge-tts 换成「一定失败」的假实现，本地引擎用真实的系统语音，
 * 断言 /tts 仍然返回 200 + 可播放音频，并带上 x-tts-engine-fallback: local。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

// 源码形状：online 分支必须有 local 回退
const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
console.log('源码：online 失败必须有本地回退')
check('online 分支捕获到错误后会尝试本地合成',
  /catch \(onlineError\)[\s\S]{0,2400}?synthesizeLocal\(/.test(src),
  '在线失败直接抛错 → 客户端静默跳过 → 彻底没声音')
check('有 fellBack 标志，只有本地也失败才抛原错误',
  /let fellBack = false/.test(src) && /if \(!fellBack\) throw onlineError/.test(src))
check('回退成功时 actualEngine 改成 local',
  /actualEngine = 'local'[\s\S]{0,40}fellBack = true/.test(src))
check('回退会写 x-tts-engine-fallback 响应头',
  /headers\['x-tts-engine-fallback'\] = actualEngine/.test(src))
check('本地不可用的平台上不硬回退',
  /if \(isLocalSupported\(\)\)/.test(src))

console.log('\n真跑：把 edge-tts 替换成「一定失败」，看 /tts 是否仍返回音频')
{
  // 造一个临时包：lib/ 整体复制一份，把 edge-tts 指向假的
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vt-fallback-'))
  fs.mkdirSync(tmp + '/lib', { recursive: true })
  for (const f of fs.readdirSync(LIB)) {
    if (!f.endsWith('.js')) continue
    fs.copyFileSync(path.join(LIB, f), tmp + '/lib/' + f)
  }
  // 覆盖 edge-tts：synthesizeSpeech 一定失败；其余导出保持可用
  fs.writeFileSync(tmp + '/lib/edge-tts.js', [
    'export async function synthesizeSpeech() {',
    "  throw new Error('语音合成超时（15000 毫秒无结果），已丢弃连接。');",
    '}',
    'export async function listVoices() { return [] }',
    'export async function warmUpTts() { return Promise.resolve() }',
    'export function disposeTts() {}',
    'export function synthQueueDepthNow() { return 0 }',
    '',
  ].join('\n'), 'utf8')

  process.env.DSH_HOME = path.join(tmp, 'home')
  fs.mkdirSync(process.env.DSH_HOME, { recursive: true })

  const mod = await import('file://' + (tmp + '/lib/index.js').replace(/\\/g, '/'))
  const routes = new Map()
  const scope = {
    effect(fn) { fn(); return () => {} },
    webServer: { register(d) { routes.set(d.path, d); return () => {} } },
    sessions: { get() {}, list() { return [] } },
  }
  mod.apply({ on() { return () => {} }, inject(_d, fn) { fn(scope); return () => {} } }, {
    ttsEngine: 'online', readAloud: true, preloadModels: false,
  })

  const def = routes.get('/dsh-voice-typing/tts')
  const req = { method: 'GET', url: '/dsh-voice-typing/tts?text=' + encodeURIComponent('回退测试。'), on() { return req } }
  const chunks = []
  const res = {
    statusCode: 0, headers: {}, headersSent: false, writableEnded: false, destroyed: false,
    writeHead(s, h) { this.statusCode = s; this.headers = h ?? {}; this.headersSent = true },
    end(c) { if (c != null) chunks.push(c); this.writableEnded = true },
  }
  await def.handler(req, res)
  const body = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c)))))

  check('状态码 200（不再是 500）', res.statusCode === 200, String(res.statusCode))
  check('真的返回了音频数据', body.length > 1000, body.length + 'B')
  check('音频是 WAV（本地引擎的容器）',
    body.slice(0, 4).toString('ascii') === 'RIFF', body.slice(0, 4).toString('hex'))
  check('响应头标出已回退到 local',
    res.headers['x-tts-engine-fallback'] === 'local', String(res.headers['x-tts-engine-fallback']))
  check('x-tts-engine 报的是实际引擎 local',
    res.headers['x-tts-engine'] === 'local', String(res.headers['x-tts-engine']))
}

console.log('\n通过 ' + passed + '，失败 ' + failed)
process.exitCode = failed ? 1 : 0
