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
 *
 * 桩打在 `src/host/edge-tts.js`（构建之前），再跑真管线造产物 ——
 * 第 6.5 步之后产物是单个自包含的 `lib/index.js`，里面没有「可覆盖的 lib/edge-tts.js」了。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const SRC = fileURLToPath(new URL('../src/', import.meta.url))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

// 「online 分支必须有 local 回退」那 5 条源码文本判据已删（§8.34 批次 6a）：
// 同一批契约改由 test/tts-fallback-trace.test.mjs 在**真宿主路由**上判（第 4、5 节：
// 在线失败→回退本地并带 x-tts-engine-fallback: local；本地也不成→500 抛在线原错误）。
// 本文件留的是端到端那一层：桩打在 src/host/edge-tts.js，走**真构建管线**造产物再 import，
// 于是「产物里带着那份失败的实现」这件事也被验了一次（那是产物层，不是源码形状）。

console.log('\n真跑：把 edge-tts 替换成「一定失败」，看 /tts 是否仍返回音频')
{
  // 造一个**仓库内**的最小工程：src/ 全量镜像 + 真构建脚本，然后在 src/host/ 这一层打桩，
  // 再跑 build-host.mjs 造出「带着桩的产物」，最后 import 那个产物。
  //
  // 为什么不能像以前那样直接覆盖 lib/edge-tts.js：第 6.5 步把内部模块内联进 lib/index.js 了，
  // 产物里**不再有** lib/edge-tts.js 这个文件，覆盖它等于什么都没干 ——
  // 实测表现是「桩没生效、真 Edge 服务被调到、在线成功返回 MP3」，三条回退断言全红。
  // 所以桩只能打在**构建之前**。这反而是更强的验证：跑的是真管线产出的那份字节，
  // 「行为读产物」这条分工没有被削弱（见 docs §8.28 第 6 步）。
  //
  // 必须在仓库内：构建脚本要 require('esbuild')，Node 只能沿目录树往上找 node_modules。
  // 目录名以 `.tmp` 开头，已在 .gitignore 里，收尾会删掉。
  const tmp = path.join(root, '.tmp-tts-fallback')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  fs.cpSync(SRC, tmp + '/src', { recursive: true })
  fs.mkdirSync(tmp + '/scripts', { recursive: true })
  fs.copyFileSync(path.join(root, 'scripts', 'build-host.mjs'), tmp + '/scripts/build-host.mjs')
  // 临时目录的 package.json 只要两件事：声明 ESM（否则 Node 把 .js 先当 CJS 试一遍），
  // 以及 main 指向要 import 的产物。
  fs.writeFileSync(tmp + '/package.json', '{"type":"module"}\n', 'utf8')
  // 覆盖 edge-tts：synthesizeSpeech 一定失败；其余导出保持可用
  fs.writeFileSync(tmp + '/src/host/edge-tts.js', [
    'export async function synthesizeSpeech() {',
    "  throw new Error('语音合成超时（15000 毫秒无结果），已丢弃连接。');",
    '}',
    'export async function listVoices() { return [] }',
    'export async function warmUpTts() { return Promise.resolve() }',
    'export function disposeTts() {}',
    'export function synthQueueDepthNow() { return 0 }',
    '',
  ].join('\n'), 'utf8')

  // 真跑构建管线：桩在 src/host/ 里，产物 lib/index.js 里就是那份失败的实现。
  execFileSync(process.execPath, [path.join(tmp, 'scripts', 'build-host.mjs')], { stdio: 'pipe' })
  check('带桩工程能构建出产物（build-host 在临时工程里跑通）',
    fs.existsSync(tmp + '/lib/index.js'), tmp + '/lib/index.js')

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

  // 收尾：删掉带桩工程（开头也删一次，保证下一次跑的产物不是上一次的残留）。
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n通过 ' + passed + '，失败 ' + failed)
process.exitCode = failed ? 1 : 0
