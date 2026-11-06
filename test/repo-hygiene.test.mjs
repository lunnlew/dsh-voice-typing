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
 *   5. 每个 test/*.test.mjs 都有跑法（漏进 `npm test` 串 = 一条从没生效过的守卫）
 *   6. 构建产物（`lib/`）不在版本库里（批次 23）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { hostSource } from './helpers/host-source.mjs'

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
    if (['node_modules', '.git', 'fixtures'].includes(e.name)) continue
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
  // 路由注册表在**手写源码**里读（第 6.5 步之后 lib/index.js 是产物，
  // 产物里没有 `path: '/xxx'` 这种源码写法的可能——位置由 helper 解析）。
  const idx = hostSource('index')
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

console.log('\n测试文件都在 npm test 的串跑清单里')
{
  // 为什么要有这条：`npm test` 是一条 `&&` 串（见 package.json），
  // 新增一个 test/*.test.mjs 忘了接上去，它就只有人手动跑的时候才跑过 ——
  // 表现出来是「CI 全绿但这条守卫从没生效」，和永久绿灯是一回事。
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts
  // 检查是否使用了自动测试运行器（scripts/run-tests.mjs 会自动发现并运行所有测试文件）
  const usesAutoRunner = /node scripts\/run-tests\.mjs/.test(String(scripts.test ?? ''))
  const chained = new Set(
    [...String(scripts.test ?? '').matchAll(/node (test\/[^\s&]+\.mjs)/g)].map((m) => m[1]),
  )
  const ownRunners = new Set(
    Object.entries(scripts)
      .filter(([name, cmd]) => name !== 'test' && /node test\/[^\s&]+\.mjs/.test(String(cmd)))
      .flatMap(([, cmd]) => [...String(cmd).matchAll(/node (test\/[^\s&]+\.mjs)/g)].map((m) => m[1])),
  )
  const onDisk = fs.readdirSync(path.join(root, 'test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => `test/${f}`)
    .sort()
  // 如果使用了自动运行器，所有测试文件都被覆盖
  const orphans = usesAutoRunner ? [] : onDisk.filter((f) => !chained.has(f) && !ownRunners.has(f))
  check(`磁盘上 ${onDisk.length} 个测试文件都有跑法（串跑或自己的 npm script${usesAutoRunner ? '，或使用自动运行器' : ''}）`,
    orphans.length === 0, `没人跑：${orphans.join(', ')}`)
  const stale = [...chained].filter((f) => !onDisk.includes(f))
  check('串跑清单里没有已经不存在的文件', stale.length === 0, stale.join(', '))
}

console.log('\n构建产物不在版本库里（批次 23）')
{
  // 为什么要有这条：`lib/` 退出版本库之后，「谁又把它 add 回来了」这种事不会有任何别的地方报错 ——
  // 磁盘上本来就得有那几个文件（DSH 装机的符号链接读的就是它们），产物入库和出库在运行时看不出区别，
  // 只有 git 能分辨。这里两条一起判：一条看**事实**（跟踪列表里没有 lib 下的文件），
  // 一条看**规则**（`.gitignore` 那条 `/lib/` 真的在起作用，不是写了个不匹配的路径自我安慰）。
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) {
    console.log('  ⏭ 跳过：这里不是 git 工作树（发布物里没有 .git），这条守卫没法判')
  } else {
    const tracked = String(git(['ls-files', '--', 'lib']).stdout).split('\n').filter(Boolean)
    check('版本库里没有 lib/ 下的任何文件（构建产物不入库）', tracked.length === 0,
      `还被跟踪：${tracked.join(', ')}`)
    check('.gitignore 那条规则真的挡住了 lib/client.js', git(['check-ignore', '-q', '--', 'lib/client.js']).status === 0,
      'git check-ignore 没认它是忽略文件')
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
