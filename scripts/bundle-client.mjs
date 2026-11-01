/**
 * 把 src/client/ 下的纯函数内联进 lib/client.js。
 *
 * 为什么需要它：
 *   浏览器模块的 require 只能解析**包名**，不能 import 本地相对路径
 *   —— 所以两个半身不能共享代码文件，纯函数只能各写一份。
 *
 *   但「各写一份」意味着会分叉：宿主侧曾把真实语音的低音量帧
 *   挡在解码器外面，流式只认出「你好明天天怎」。
 *
 *   折中：源码只写一份（src/client/），由本脚本内联进产物。
 *   产物 lib/client.js 仍然是单文件，行为不变；
 *   而测试可以直接原生 import src/client/ 下的纯函数
 *   （它们不依赖浏览器 API），不需要「从大文件里提取源码再求值」。
 *
 * 零新依赖：只用 Node 内置的 fs / path / url。
 *
 * 用法：
 *   node scripts/bundle-client.mjs          # 生成
 *   node scripts/bundle-client.mjs --check  # 只校验产物是否最新（CI 用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileAtomic } from '../lib/atomic-file.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
// 源码与产物分离：
//   src/client/main.js —— 源码（含 @bundle 标记）
//   lib/client.js      —— 产物（纯函数已内联，浏览器模块直接加载这个）
//
// 之前是「读 lib/client.js → 替换标记 → 写回 lib/client.js」，
// 那是**破坏性**的：跑一次标记就没了，再跑就静默产出一个没内联的文件。
const source = path.join(root, 'src', 'client', 'main.js')
const target = path.join(root, 'lib', 'client.js')
const srcDir = path.join(root, 'src', 'client')

/**
 * 内联标记：/* @bundle <相对路径> *\/ *
 *
 * 必须容忍 CRLF：行尾是 \r\n 时，`[ \t]*$` 匹配不上（$ 前面多了一个 \r），
 * 于是**所有标记都失配** → 产物里没有内联任何东西，
 * 而 --check 还报「已是最新」→ 静默产出一份坏产物。
 * 所以行尾显式允许一个 \r。
 */
const MARKER = /^[ \t]*\/\* @bundle (\S+) \*\/[ \t]*\r?$/gm

/** 源文件里的 export 关键字：内联进产物后要去掉（产物不是 ESM 模块）。 */
function stripExports(code) {
  return code
    .replace(/^export\s+(async\s+)?function\s+/gm, '$1function ')
    .replace(/^export\s+(const|let|var)\s+/gm, '$1 ')
}

/**
 * 把源文件内容转成产物里的片段（缩进 + 去掉 export）。
 * 统一成 LF：源文件若是 CRLF，内联进 LF 的产物里会留下混排的行尾。
 */
function toFragment(code) {
  const stripped = stripExports(code.replace(/\r\n/g, '\n'))
  return stripped
    .split('\n')
    .map((line) => (line.length ? '    ' + line : line))
    .join('\n')
}

function bundle() {
  const original = fs.readFileSync(source, 'utf8')
  const used = new Set()
  const out = original.replace(MARKER, (_m, rel) => {
    const file = path.join(srcDir, rel)
    if (!fs.existsSync(file)) {
      throw new Error(`bundle 找不到源文件：${file}`)
    }
    used.add(rel)
    return toFragment(fs.readFileSync(file, 'utf8'))
  })
  return { original, out, used }
}

const { original, out, used } = bundle()

// 一个标记都没匹配到 → 产物里没有内联任何东西。
// 这不是错误（还没加标记时是正常状态），但必须**说出来**，
// 否则会静默产出一份「看着正常、其实没有内联」的产物。
if (used.size === 0) {
  console.warn('⚠ 没匹配到任何 /* @bundle */ 标记 —— 产物没有被内联任何源文件')
}

if (process.argv.includes('--check')) {
  let current = ''
  try { current = fs.readFileSync(target, 'utf8') } catch { /* 产物还不存在 */ }
  if (out !== current) {
    console.error('✗ lib/client.js 与 src/client/main.js 不同步 —— 跑 node scripts/bundle-client.mjs')
    process.exit(1)
  }
  console.log('✓ lib/client.js 已是最新')
  process.exit(0)
}

// 原子写：先写临时文件再替换。
// 直接覆盖的话，写到一半被中断 → 产物是半截的 JS，
// 而这份文件是要注入浏览器的，坏了极难排查。
await writeFileAtomic(target, out, { encoding: 'utf8' })
console.log(`✓ 已生成 lib/client.js（内联 ${used.size} 个源文件：${[...used].join(', ')}）`)
console.log(`  ${original.length} → ${out.length} 字节`)
