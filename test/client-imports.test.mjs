/**
 * 跨模块引用守卫：src/client 里每个文件用到的「别的模块的顶层导出」，
 * 必须在文件头 import 进来。入口 main.js 也在扫描范围内。
 *
 * 为什么要有这一条：产物是 esbuild 沿 import 图合成的单文件。搬代码时如果一段
 * 引用了别的模块的导出、却没 import，esbuild 不会报错 —— 它把没绑定的标识符当
 * 全局变量原样留在产物里，于是产物中那个名字谁都没定义，运行时才 ReferenceError。
 * 浮层外提（4.7）就踩过：readSessionSnapshot / matchWakeWord / vadWorkletSource
 * 等 13 个名字全靠「留在原来那个作用域」才成立，搬完之后那些调用点又在 try 里，
 * 异常被吞掉，表现成「热键没反应 / 说没有当前会话」，测试也照不到。
 *
 * 判据只问一件事：用了 sibling 的导出名，却没 import、也没在本文件里绑定。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = path.join(root, 'src', 'client')

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failures.push({ name, detail }); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 去掉块注释、行注释和字符串字面量，避免把注释/文案里的词当成引用。 */
function stripNoise(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""')
}

/** 一个模块的顶层导出名（和构建脚本 exportsOf 读法一致）。 */
function exportsOf(code) {
  const names = new Set()
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1])
  }
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop().trim()
      if (t) names.add(t)
    }
  }
  return [...names]
}

/** import { a, b as c } from '...' 里的本地名字。 */
function importedNames(code) {
  const out = new Set()
  for (const m of code.matchAll(/^import\s*(?:type\s*)?\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"]/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(t)) out.add(t)
    }
  }
  for (const m of code.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from/gm)) out.add(m[1])
  return out
}

/**
 * 本文件里绑定过的名字：声明、解构、函数/箭头参数。
 * 目的只有一个 —— 别把「注入进来的同名参数」报成漏 import，所以宁可多收（漏报）
 * 也不要误报（把合规文件判红）。
 */
function boundNames(code) {
  const out = new Set()
  const addList = (text) => {
    for (const part of String(text).split(',')) {
      const t = part.trim()
      if (!t) continue
      // `a: b` 取 b；`a = 1` 取 a；`...rest` 取 rest
      const colon = t.split(':').pop().trim()
      const base = (colon.split('=')[0] || '').trim().replace(/^\.\.\./, '')
      if (/^[A-Za-z_$][\w$]*$/.test(base)) out.add(base)
    }
  }
  const clean = stripNoise(code)
  for (const m of clean.matchAll(/(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1])
  for (const m of clean.matchAll(/(?:const|let|var)\s*[{\[]([\s\S]*?)[}\]]\s*=/g)) addList(m[1])
  // function foo(a, b) / 箭头 (a, b) =>
  for (const m of clean.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g)) addList(m[1])
  for (const m of clean.matchAll(/\(([^()]*)\)\s*=>/g)) addList(m[1])
  for (const m of clean.matchAll(/(?:for\s*\(\s*(?:const|let|var)\s+|catch\s*\()([A-Za-z_$][\w$]*)/g)) out.add(m[1])
  return out
}

const dirs = ['pure', 'dom']
// 入口也在范围内：它现在是个真 ESM 模块，引用别模块的导出同样得 import。
const files = ['main.js']
for (const d of dirs) {
  for (const f of fs.readdirSync(path.join(clientDir, d))) {
    if (f.endsWith('.js')) files.push(`${d}/${f}`)
  }
}

const exportMap = new Map()   // 名字 -> 定义它的文件
for (const rel of files) {
  const code = fs.readFileSync(path.join(clientDir, rel), 'utf8')
  for (const name of exportsOf(code)) if (!exportMap.has(name)) exportMap.set(name, rel)
}

check(`扫描 ${files.length} 个 src/client 模块，收集到 ${exportMap.size} 个可引用的导出名`, files.length > 0 && exportMap.size > 0)

const offenders = []
/** 「这个标识符有没有被引用」的正则缓存（26 个文件 × 140 多个名字，别每次重编译）。 */
const usePatterns = new Map()

/**
 * 「前面是点 = 属性名，不算引用」这条判据会被**展开运算符**误伤：
 * `{ ...DEFAULT_VAD_OPTIONS, silenceFrames }` 里 `DEFAULT_VAD_OPTIONS` 前面就是点，
 * 而它是真引用。浮层漏 import 那处（docs/architecture-modernization.md §8.32）
 * 就是这么被漏掉的 —— 展开的三种点先换成占位符，属性的单点照旧。
 */
function usageText(clean) {
  return clean.replace(/\.\.\./g, '§')
}

function isReferenced(clean, name) {
  let re = usePatterns.get(name)
  if (!re) {
    // 出现即引用：`f(`、`f.x`、`[f`、`{ a, f }`（对象简写）都是真引用。
    // 只排除两种位置 —— 前面是点（那是属性名，不是这个变量），
    // 后面是冒号（对象字面量的键，值在别处）。
    re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])(?!\\s*:)`)
    usePatterns.set(name, re)
  }
  return re.test(clean)
}

for (const rel of files) {
  const raw = fs.readFileSync(path.join(clientDir, rel), 'utf8')
  const clean = usageText(stripNoise(raw))
  const allowed = new Set([...importedNames(raw), ...boundNames(raw), ...exportsOf(raw)])
  for (const [name, owner] of exportMap) {
    if (owner === rel || allowed.has(name)) continue
    if (isReferenced(clean, name)) offenders.push(`${rel} 用了 ${owner} 的 ${name}，但没 import`)
  }
}

check('每个文件用到的跨模块导出名都 import 了', offenders.length === 0, offenders.join('\n'))

console.log(`\n通过 ${passed}，失败 ${failures.length}`)
if (failures.length) {
  console.log('失败项：')
  for (const f of failures) console.log(' - ' + f.name + (f.detail ? '\n   ' + f.detail : ''))
  process.exitCode = 1
}
