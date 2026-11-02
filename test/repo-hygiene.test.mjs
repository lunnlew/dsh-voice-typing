/**
 * 仓库卫生守卫：本地路径、机器信息、编码损坏、其它插件名。
 *
 * 为什么要有这个：
 *   这些东西一旦写进代码或文档就会跟着插件到处跑 ——
 *   别人克隆下来跑不起来（路径不存在），
 *   或者把自己的用户名/目录结构暴露出去。
 *
 *   之前测试里写死了 20 多处本机绝对路径，
 *   插件换个位置就全挂。
 *
 * 检查项：
 *   1. 没有本机绝对路径（Windows 盘符路径、用户目录）
 *   2. 没有别的插件名（尤其那个明确禁止出现的）
 *   3. 没有编码损坏（U+FFFD 替换字符）
 *   4. 文档里写的路由都真实存在
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/** 要检查的文件（跳过第三方与依赖）。 */
const files = []
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'vendor', 'fixtures'].includes(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (!/\.(js|mjs|cjs|json|md|yml|yaml)$/.test(e.name)) continue
    files.push(p)
  }
}
walk(root)
// 跳过这个文件本身（它必须写出被禁的名字才能检查）
const self = path.basename(fileURLToPath(import.meta.url))
const scanned = files.filter((f) => path.basename(f) !== self)

console.log(`检查 ${scanned.length} 个文件\n`)

console.log('本机绝对路径与机器信息')
{
  const hits = []
  for (const f of files) {
    const rel = path.relative(root, f).replace(/\\/g, '/')
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    lines.forEach((l, i) => {
      // 真实的盘符绝对路径：盘符 + 冒号 + 斜杠 + 至少一级目录。
      // （像 [A-Za-z]:[\\/] 这种正则字符类不算 —— 它没有目录名。）
      if (/\b[A-Za-z]:[\\/][A-Za-z0-9_.-]+[\\/]/.test(l)
        && !/https?:\/\//.test(l) && !/file:\/\//.test(l)) {
        hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 80)}`)
      }
      // 用户目录 / 用户名
      if (/Users[\\/][a-z]+[\\/]/.test(l) || /dsh-tools[\\/]/.test(l)) {
        hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 80)}`)
      }
    })
  }
  check('没有本机绝对路径', hits.length === 0, hits.slice(0, 5).join(' | '))
}

console.log('\n其它插件名（有一个明确禁止出现）')
{
  // 用拼接构造：这个测试文件自己也在扫描范围内，
  // 直接写出来会自己命中自己。
  const banned = ['ha' + 'ndy', 'dsh-voice-' + 'mode', 'dsh-voice-' + 'chat',
    'dsh-voice-' + 'input-plugin', 'dsh-voice-' + 'scribe']
  const hits = []
  for (const f of files) {
    const rel = path.relative(root, f).replace(/\\/g, '/')
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    lines.forEach((l, i) => {
      for (const b of banned) {
        if (l.toLowerCase().includes(b)) hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 70)}`)
      }
    })
  }
  check('没有出现被禁的插件名', hits.length === 0, hits.slice(0, 5).join(' | '))
}

console.log('\n编码损坏（U+FFFD 替换字符）')
{
  const hits = []
  for (const f of files) {
    const rel = path.relative(root, f).replace(/\\/g, '/')
    const txt = fs.readFileSync(f, 'utf8')
    txt.split('\n').forEach((l, i) => {
      if (l.includes('\uFFFD')) hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 70)}`)
    })
  }
  check('没有编码损坏', hits.length === 0, hits.slice(0, 5).join(' | '))
}

console.log('\n文档里写的路由必须真实存在')
{
  const idx = fs.readFileSync(path.join(root, 'lib/index.js'), 'utf8')
  const registered = new Set(
    [...idx.matchAll(/path: '\/dsh-voice-typing([^']*)'/g)].map((m) => m[1]),
  )
  const docsDir = path.join(root, 'docs')
  // docs/ 下的设计文档也属于发布物（随 npm 包/仓库走），里面写的路由同样必须真实存在。
  const docFiles = ['README.md', 'cordis.patch.yml']
  if (fs.existsSync(docsDir)) {
    for (const name of fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'))) {
      docFiles.push(path.join('docs', name))
    }
  }
  for (const doc of docFiles) {
    const txt = fs.readFileSync(path.join(root, doc), 'utf8')
    const mentioned = [...new Set(
      [...txt.matchAll(/\/dsh-voice-typing([a-zA-Z0-9\/\-]*)/g)].map((m) => m[1]),
    )]
    const missing = mentioned.filter((r) => r && !registered.has(r))
    check(`${doc} 里提到的路由都存在`, missing.length === 0,
      missing.map((r) => '/dsh-voice-typing' + r).join(', '))
  }
}

console.log('\n测试不依赖固定路径')
{
  const testDir = path.join(root, 'test')
  const hits = []
  for (const f of fs.readdirSync(testDir).filter((x) => x.endsWith('.mjs'))) {
    const txt = fs.readFileSync(path.join(testDir, f), 'utf8')
    // 与上面同一套判定：真实的盘符路径（盘符 + 斜杠 + 至少一级目录），
    // 正则里的字符类（比如 A-Za-z 后面接冒号再接斜杠）不算。
    if (/\b[A-Za-z]:[\\/][A-Za-z0-9_.-]+[\\/]/.test(txt)) {
      hits.push(f)
    }
  }
  check('测试里没有硬编码路径', hits.length === 0, hits.join(', '))
  const fixtures = path.join(testDir, 'fixtures')
  check('fixtures 目录里有测试音频', fs.existsSync(path.join(fixtures, 'zh-test.wav')))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
