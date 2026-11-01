/**
 * 构建产物一致性检查。
 *
 * lib/client.js 是**构建产物**（由 scripts/bundle-client.mjs 从 src/client/ 生成）。
 * 浏览器模块的 require 只能解析包名、不能 import 本地相对路径，
 * 所以纯函数的源码只能有一份，靠这个脚本内联进产物。
 *
 * 这个测试保证：
 *   1. 产物与源文件同步（改了 src 忘了 bundle → CI 报错）；
 *   2. 每个源文件只被内联一次（重复内联会导致函数重复定义）；
 *   3. 产物里没有残留的 bundle 标记（说明忘了跑脚本）。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundled = fs.readFileSync(root + '/lib/client.js', 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('产物与源文件同步')
try {
  execFileSync('node', [root + '/scripts/bundle-client.mjs', '--check'], { stdio: 'pipe' })
  check('lib/client.js 已是最新（--check 通过）', true)
} catch (e) {
  check('lib/client.js 已是最新（--check 通过）', false,
    '改了 src/client/ 之后要跑 node scripts/bundle-client.mjs')
}

console.log('\n产物结构')
check('产物里没有残留的 bundle 标记', !/\/\* @bundle /.test(bundled),
  '说明忘了跑 bundle 脚本')

// 源码与产物必须**分离**。
// 之前是「读 lib/client.js → 替换标记 → 写回 lib/client.js」——
// 那是破坏性的：跑一次标记就没了，再跑就静默产出一个没内联的文件，
// 而 --check 还报「已是最新」。
console.log('\n源码与产物分离（bundle 必须可重复运行）')
{
  const source = fs.readFileSync(root + '/src/client/main.js', 'utf8')
  check('源码在 src/client/main.js', source.length > 0)
  const markers = [...source.matchAll(/@bundle (\S+)/g)].map((m) => m[1])
  check('源码里有 @bundle 标记', markers.length > 0)
  check('每个源文件只有一个标记（两个标记会把纯函数内联两次）',
    markers.length === [...new Set(markers)].length,
    `${markers.length} 个标记 / ${[...new Set(markers)].length} 个源文件`)
  check('产物里每个纯函数恰好定义一次', (() => {
    for (const fn of ['advanceGate', 'mergeDraft', 'syncUserEdit', 'parseEnvelope',
      'belongsToSession', 'createTimerRegistry', 'sleep']) {
      const c = (bundled.match(new RegExp('function ' + fn + '\\b', 'g')) || []).length
      if (c !== 1) return false
    }
    return true
  })())
  // 跑两次，产物必须不变（幂等）
  const before = bundled
  execFileSync('node', [root + '/scripts/bundle-client.mjs'], { stdio: 'pipe' })
  const after = fs.readFileSync(root + '/lib/client.js', 'utf8')
  check('bundle 脚本可重复运行（幂等）', before === after)
}
for (const [fn, file] of [
  ['advanceGate', 'pure/gate.js'],
  ['mergeDraft', 'pure/draft.js'],
  ['syncUserEdit', 'pure/draft.js'],
  ['parseEnvelope', 'pure/envelope.js'],
  ['belongsToSession', 'pure/envelope.js'],
  ['createTimerRegistry', 'pure/envelope.js'],
  ['sleep', 'pure/envelope.js'],
]) {
  const count = (bundled.match(new RegExp(`function ${fn}\\b`, 'g')) || []).length
  check(`${fn} 在产物里恰好定义一次（来自 ${file}）`, count === 1, `实际 ${count} 处`)
}

console.log('\n源文件是纯的（能在 Node 里原生 import）')
for (const f of ['pure/gate.js', 'pure/draft.js', 'pure/envelope.js']) {
  const raw = fs.readFileSync(`${root}/src/client/${f}`, 'utf8')
  // 剥离注释后再检查 —— 注释里提到 window 是正常的
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  check(`${f} 不依赖浏览器全局`,
    !/\bwindow\.|\bdocument\.|navigator\./.test(code),
    '纯函数文件要能在 Node 里 import，浏览器 API 由参数传入')
  check(`${f} 不依赖 React`, !/\bReact\b/.test(code))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
