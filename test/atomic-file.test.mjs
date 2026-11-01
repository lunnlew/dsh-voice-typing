/**
 * 原子写文件 + 模型就绪校验的回归测试。
 *
 * 背景（2026-10-31 跨平台审查）：
 *   P0 —— 分片并行下载把分片**直接拼进最终路径**：
 *     合并中途崩溃 → 最终路径上留下截断文件 → isModelReady 只看
 *     「文件存在且非空」→ 判定「已就绪」→ 下载路由回 alreadyReady →
 *     **永远不再重下** → 用户卡在「界面显示已就绪、模型却加载不了」的状态。
 *     Windows 上还多一层：最终路径若被 sherpa-onnx 的 mmap 占着，
 *     直接写会 EBUSY/EPERM（POSIX 允许覆盖已打开的文件）。
 *
 *   P1 —— 配置文件直接覆盖写：
 *     写到一半被中断 → JSON 截断 → readOverrides 的 catch 把 parse 错误吞掉 →
 *     用户配置**静默回到默认值**，界面上一点提示都没有。
 *
 *   P3 —— bundle 脚本的标记正则对 CRLF 静默失配 →
 *     产出一个没有内联的 client.js，而 --check 还报「已是最新」。
 *
 * 这里既做功能验证（真的写文件、真的合并分片、真的校验哈希），
 * 也用静态断言锁住「不许退回直接写最终路径」这类结构性错误。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileAtomic, writeJsonAtomic, replaceFile } from '../lib/atomic-file.js'
import { mergeChunksAtomic, isModelReady, sha256Of } from '../lib/model-catalog.js'

const root = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/** 造一个临时目录（测试结束会清掉）。 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-atomic-'))
function tmpDir(name) {
  const dir = path.join(tmpRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

console.log('原子写文件：writeFileAtomic')
{
  const dir = tmpDir('atomic')
  const dest = path.join(dir, 'a.json')
  await writeFileAtomic(dest, '{"x":1}\n')
  check('内容写进去了', fs.readFileSync(dest, 'utf8') === '{"x":1}\n')
  check(
    '目录里没有留下临时文件',
    fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length === 0,
    fs.readdirSync(dir).join(', '),
  )

  await writeFileAtomic(dest, '{"x":2}\n')
  check('能覆盖已有文件', fs.readFileSync(dest, 'utf8') === '{"x":2}\n')

  await writeJsonAtomic(dest, { x: 3 })
  const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'))
  check('writeJsonAtomic 写出合法 JSON', parsed.x === 3)
  check('JSON 结尾有换行', fs.readFileSync(dest, 'utf8').endsWith('}\n'))
}

console.log('\n原子写文件：失败时不能破坏原有内容')
{
  const dir = tmpDir('atomic-fail')
  const dest = path.join(dir, 'b.json')
  fs.writeFileSync(dest, '原有内容', 'utf8')
  // 让写入失败：目标是一个**目录**，rename 必然失败。
  const blocked = path.join(dir, 'blocked')
  fs.mkdirSync(blocked, { recursive: true })
  let threw = false
  try {
    await writeFileAtomic(blocked, '新内容')
  } catch {
    threw = true
  }
  check('写不进去时会抛错', threw)
  check(
    '失败后没有留下临时文件',
    fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length === 0,
    fs.readdirSync(dir).join(', '),
  )
  check('别的文件内容没被影响', fs.readFileSync(dest, 'utf8') === '原有内容')
}

console.log('\nreplaceFile 能覆盖已有目标')
{
  const dir = tmpDir('replace')
  const from = path.join(dir, 'x.tmp')
  const to = path.join(dir, 'x.txt')
  fs.writeFileSync(from, '新的', 'utf8')
  fs.writeFileSync(to, '旧的', 'utf8')
  await replaceFile(from, to)
  check('目标被覆盖成新内容', fs.readFileSync(to, 'utf8') === '新的')
  check('源文件已经不在了', !fs.existsSync(from))
}

console.log('\nP0：分片合并必须是原子的')
{
  const dir = tmpDir('merge')
  const c1 = path.join(dir, 'c1')
  const c2 = path.join(dir, 'c2')
  fs.writeFileSync(c1, 'AAA', 'utf8')
  fs.writeFileSync(c2, 'BBB', 'utf8')
  const dest = path.join(dir, 'model.onnx')
  const total = 6
  await mergeChunksAtomic(dest, [c1, c2], total, sha256('AAABBB'))
  check('合并结果按顺序拼接', fs.readFileSync(dest, 'utf8') === 'AAABBB')
  check('没有留下 .merge 临时文件', !fs.existsSync(`${dest}.merge`))
}

console.log('\nP0：合并中途失败不能留下截断的最终文件')
{
  const dir = tmpDir('merge-fail')
  const c1 = path.join(dir, 'c1')
  fs.writeFileSync(c1, 'AAA', 'utf8')
  const missing = path.join(dir, 'missing')
  const dest = path.join(dir, 'model.onnx')
  let threw = false
  try {
    await mergeChunksAtomic(dest, [c1, missing], 6, sha256('AAABBB'))
  } catch {
    threw = true
  }
  check('合并失败会抛错', threw)
  check(
    '最终路径上没有留下截断文件',
    !fs.existsSync(dest),
    fs.existsSync(dest) ? `留下了 ${fs.statSync(dest).size} 字节` : '')
  check('没有留下 .merge 临时文件', !fs.existsSync(`${dest}.merge`))
}

console.log('\nP0：sha256 不匹配时最终文件必须保持原样')
{
  const dir = tmpDir('merge-sha')
  const c1 = path.join(dir, 'c1')
  fs.writeFileSync(c1, 'AAA', 'utf8')
  const dest = path.join(dir, 'model.onnx')
  fs.writeFileSync(dest, '上一轮下好的完整文件', 'utf8')
  let threw = false
  try {
    await mergeChunksAtomic(dest, [c1], 3, sha256('完全不同的内容'))
  } catch {
    threw = true
  }
  check('sha 不匹配会抛错', threw)
  check(
    '最终路径上的旧内容没被破坏',
    fs.readFileSync(dest, 'utf8') === '上一轮下好的完整文件',
    fs.readFileSync(dest, 'utf8'),
  )
  check('没有留下 .merge 临时文件', !fs.existsSync(`${dest}.merge`))
}

console.log('\nP0：大小不对时也不能落位')
{
  const dir = tmpDir('merge-size')
  const c1 = path.join(dir, 'c1')
  fs.writeFileSync(c1, 'AAA', 'utf8')
  const dest = path.join(dir, 'model.onnx')
  let threw = false
  try {
    await mergeChunksAtomic(dest, [c1], 999, null)
  } catch {
    threw = true
  }
  check('大小不对会抛错', threw)
  check('最终路径上没有文件', !fs.existsSync(dest))
}

console.log('\nP0：isModelReady 必须校验内容，光看「存在且非空」不够')
{
  const home = tmpDir('home')
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const repo = 'fake/repo'
  const dir = path.join(home, 'voice-typing', 'models', repo)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'model.onnx')
  fs.writeFileSync(file, 'abc', 'utf8')
  const model = { id: 'fake', repo, files: [{ name: 'model.onnx', bytes: 3, sha256: sha256('abc') }] }

  check('内容正确时是就绪的', (await isModelReady(model)) === true)

  // 同样的长度、内容不同 —— 就是「合并中断留下的截断/损坏文件」那种情况。
  fs.writeFileSync(file, 'xyz', 'utf8')
  // 显式改一下修改时间，避免同一毫秒内写入导致缓存命中。
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(file, future, future)
  check(
    '内容被改坏后**不能**再说就绪',
    (await isModelReady(model)) === false,
    '判成就绪的话，下载路由会回 alreadyReady，永远不再重下',
  )

  // 清单里没有 sha256 的文件（HF 上非 LFS 的小文件）不能被误判。
  const modelNoHash = { id: 'fake2', repo, files: [{ name: 'model.onnx', bytes: 3 }] }
  check('清单里没有 sha256 时按就绪处理', (await isModelReady(modelNoHash)) === true)

  process.env.DSH_HOME = prevHome
}

console.log('\nP0：合并后的文件 sha256 校验能通过')
{
  const dir = tmpDir('merge-verify')
  const c1 = path.join(dir, 'c1')
  fs.writeFileSync(c1, 'hello', 'utf8')
  const dest = path.join(dir, 'm.bin')
  await mergeChunksAtomic(dest, [c1], 5, sha256('hello'))
  check('落位后的文件 sha256 正确', (await sha256Of(dest)) === sha256('hello'))
}

console.log('\nP1：配置写入要走原子写')
{
  const idx = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
  check('index.js 用的是 writeFileAtomic', /await writeFileAtomic\(path, JSON\.stringify\(next/.test(idx))
  check('index.js 不再直接 writeFile 配置文件', !/writeFile\(path, JSON\.stringify/.test(idx))
  check('index.js 从共用模块引入 writeFileAtomic', /from '\.\/atomic-file\.js'/.test(idx))
  check('index.js 不再从 fs/promises 引入 writeFile', !/import \{[^}]*\bwriteFile\b[^}]*\} from 'node:fs\/promises'/.test(idx))
}

console.log('\nP0：model-catalog 的结构性约束')
{
  const cat = fs.readFileSync(path.join(root, 'lib', 'model-catalog.js'), 'utf8')
  check('replaceFile 从共用模块引入', /import \{ replaceFile \} from '\.\/atomic-file\.js'/.test(cat))
  check('合并写到 .merge 临时文件', /const mergePath = `\$\{dest\}\.merge`/.test(cat))
  check('合并不再直接写最终路径', !/createWriteStream\(dest\)/.test(cat))
  check('合并失败不会删掉最终路径上的文件', !/rm\(dest, \{ force: true \}\)/.test(cat))
  check('合并校验通过后才落位', /await replaceFile\(mergePath, dest\)/.test(cat))
  check('isModelReady 会校验 sha256', /await fileMatchesHash\(path, file\)/.test(cat))
}

console.log('\nP3：bundle 脚本对 CRLF 必须稳')
{
  const script = fs.readFileSync(path.join(root, 'scripts', 'bundle-client.mjs'), 'utf8')
  check('标记正则容忍行尾的 \\r', /MARKER = .*\\r\?\$/m.test(script))
  check('产物是原子写的', /await writeFileAtomic\(target, out/.test(script))
  check('源文件的 CRLF 会归一化', script.includes("replace(/\\r\\n/g, '\\n')"))
  check('一个标记都没匹配到时会出声', /used\.size === 0/.test(script))
}

console.log('\nP3：CRLF 的源文件照样能内联（真跑一遍 bundle 脚本）')
{
  // 在临时目录里搭一个和真实仓库同构的最小工程，用 CRLF 写文件。
  const fake = tmpDir('bundle')
  fs.mkdirSync(path.join(fake, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(fake, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(fake, 'src', 'client', 'pure'), { recursive: true })
  fs.copyFileSync(path.join(root, 'scripts', 'bundle-client.mjs'), path.join(fake, 'scripts', 'bundle-client.mjs'))
  fs.copyFileSync(path.join(root, 'lib', 'atomic-file.js'), path.join(fake, 'lib', 'atomic-file.js'))
  // 临时工程也要声明 ESM，否则 Node 会警告「模块类型未指定」。
  fs.writeFileSync(path.join(fake, 'package.json'), '{"type":"module"}\n', 'utf8')
  // 源码在 src/client/main.js，产物在 lib/client.js ——
  // 两者是**分离**的（之前是「读产物 → 替换标记 → 写回产物」，破坏性）。
  fs.mkdirSync(path.join(fake, 'src', 'client'), { recursive: true })
  fs.writeFileSync(
    path.join(fake, 'src', 'client', 'main.js'),
    'const a = 1\n/* @bundle pure/x.js */\nconst b = 2\n',
    'utf8',
  )
  fs.writeFileSync(
    path.join(fake, 'src', 'client', 'pure', 'x.js'),
    'export function hello() {\r\n  return 1\r\n}\r\n',
    'utf8',
  )
  let out = ''
  let failedRun = false
  try {
    out = execFileSync('node', [path.join(fake, 'scripts', 'bundle-client.mjs')], { encoding: 'utf8' })
  } catch (e) {
    failedRun = true
    out = String(e.stderr ?? e.message)
  }
  check('bundle 脚本跑通了', !failedRun, out)
  const bundled = fs.readFileSync(path.join(fake, 'lib', 'client.js'), 'utf8')
  check('CRLF 的源文件被内联进产物', bundled.includes('function hello()'))
  check('产物里不再有 bundle 标记', !bundled.includes('@bundle'))
  check('产物里没有混进 \\r（行尾统一成 LF）', !bundled.includes('\r'))
}

console.log('\n跨平台：所有「改名成最终文件」必须走 replaceFile')
{
  // Windows 上 rename 覆盖已存在目标会 EPERM/EBUSY（POSIX 不会），
  // 所以「改名成最终文件」都必须走 lib/atomic-file.js 里的 replaceFile。
  const atomic = fs.readFileSync(path.join(root, 'lib', 'atomic-file.js'), 'utf8')
  const cat = fs.readFileSync(path.join(root, 'lib', 'model-catalog.js'), 'utf8')
  const idx = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
  check('replaceFile 已定义', /export async function replaceFile\(from, to/.test(atomic))
  check('helper 内部是「先试 rename，失败再退避重试」',
    /await rename\(from, to\)/.test(atomic)
    && /EPERM/.test(atomic) && /EBUSY/.test(atomic),
    'Windows 上目标被杀毒软件/索引器瞬时占用时 rename 会 EPERM/EBUSY，需要重试')
  check('重试有退避间隔', /setTimeout\(resolve, 200 \* i\)/.test(atomic))
  check('非瞬时错误不重试（直接抛出）', /if \(!transient \|\| i === attempts\) throw error/.test(atomic))

  // helper 之外不能有裸的 await rename（改名成最终文件都要走重试）
  for (const [name, src] of [['model-catalog.js', cat], ['index.js', idx]]) {
    const bare = [...src.matchAll(/await rename\(/g)]
    check(`${name} 里没有裸的 await rename`, bare.length === 0, `${bare.length} 处`)
    check(`${name} 用的是共用模块的 replaceFile`, /from '\.\/atomic-file\.js'/.test(src))
  }
}

console.log('\n跨平台：原生模块必须声明为 optionalDependencies')
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const idx = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
  // 代码里有 WASM 兜底，说明设计上支持「原生装不上」
  const hasFallback = /for \(const name of \['sherpa-onnx-node', 'sherpa-onnx'\]\)/.test(idx)
  check('代码里有原生 → WASM 的兜底', hasFallback)
  check('原生模块不在 dependencies 里（否则装不上就 install 失败）',
    !pkg.dependencies?.['sherpa-onnx-node'],
    '有 WASM 兜底却把它写死在 dependencies 里，装不上就是硬失败')
  check('原生模块在 optionalDependencies 里',
    !!pkg.optionalDependencies?.['sherpa-onnx-node'])
  check('WASM 版 sherpa-onnx 在 dependencies 里',
    !!pkg.dependencies?.['sherpa-onnx'])
}

console.log('\n跨平台：路径分隔符 / ESM 限制 / DSH_HOME 覆盖')
{
  const files = ['lib/index.js', 'lib/model-catalog.js', 'lib/local-tts.js',
    'lib/neural-tts.js', 'lib/edge-tts.js', 'lib/asr-worker.js', 'lib/tts-worker.js']
  const hits = []
  for (const f of files) {
    const txt = fs.readFileSync(path.join(root, f), 'utf8')
    txt.split('\n').forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      // 手写分隔符拼接路径
      if (/['"]\/['"]\s*\+|['"]\\\\['"]\s*\+/.test(code)) {
        hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 70)}`)
      }
    })
  }
  check('没有手写分隔符拼路径', hits.length === 0, hits.slice(0, 3).join(' | '))

  const esmFiles = ['lib/index.js', 'lib/model-catalog.js', 'lib/local-tts.js',
    'lib/neural-tts.js', 'lib/edge-tts.js', 'lib/asr-worker.js', 'lib/tts-worker.js',
    'lib/tts-env.js', 'lib/text-rules.js', 'scripts/bundle-client.mjs']
  const esmHits = []
  for (const f of esmFiles) {
    const txt = fs.readFileSync(path.join(root, f), 'utf8')
    txt.split('\n').forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (/(?<![a-zA-Z_$])__(dirname|filename)\b/.test(code)) {
        esmHits.push(`${f}:${i + 1}: ${l.trim().slice(0, 70)}`)
      }
    })
  }
  check('没有 __dirname / __filename（ESM 里不存在）',
    esmHits.length === 0, esmHits.slice(0, 3).join(' | '))

  for (const f of ['lib/index.js', 'lib/model-catalog.js']) {
    const txt = fs.readFileSync(path.join(root, f), 'utf8')
    check(`${f} 支持 DSH_HOME 覆盖`, /process\.env\.DSH_HOME/.test(txt))
    check(`${f} 默认用 homedir()`, /homedir\(\)/.test(txt))
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
fs.rmSync(tmpRoot, { recursive: true, force: true })
process.exitCode = failed ? 1 : 0
