/**
 * 客户端**源码**读取器 —— 给「源码形状」类断言用。
 *
 * 为什么读源码而不是 `lib/client.js`：
 *   产物是 esbuild 的输出，引号风格（`'x'` → `"x"`）、空白、顶层声明的顺序
 *   都由构建器决定（例如它会为了「返回值没人用」把 `void loadModels()` 里的 `void` 去掉）。
 *   拿产物字节做正则，等于在要求构建器保持人类写法，改构建器就会一片红，
 *   而这些断言真正要守的是「源码别退回旧写法」。
 *   **行为断言仍然要加载真产物**（见 test/client-behavior.test.mjs）——
 *   这里只管形状。
 *
 * `main.js` 现在是个真 ESM 模块（顶层 import + `export function buildClientModule(require)`），
 * 函数体基准缩进 2 空格，所以入口这里按 2 拍平，断言可以照旧从列 0 写。
 * （2026-11-03 之前它整体是 factory 体、基准 4 空格，靠 `@bundle` 标记拼源文件；
 *  标记摘掉之后，入口清单归构建脚本的 esbuild metafile 管，见 test/bundle-sync.test.mjs。）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))

/** 入口函数体的基准缩进（`export function` 里那一层）。 */
const ENTRY_BASE_INDENT = 2

/**
 * 去掉每行 `n` 空格基准 —— 入口的函数体拍平成「从列 0 写断言」。
 */
export function dedentEntry(text, n = ENTRY_BASE_INDENT) {
  const pad = ' '.repeat(n)
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith(pad) ? line.slice(n) : line))
    .join('\n')
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

/** `src/client/pure/` 下的纯模块相对路径（排序，保证两次运行一致）。 */
export function pureSourceFiles() {
  const dir = path.join(root, 'src', 'client', 'pure')
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => `src/client/pure/${f}`)
}

/**
 * `src/client/<子目录>/` 下的源码文件（相对路径，排序）。
 * 子目录还不存在时返回空数组 —— 拆分是渐进的，不该要求每条断言跟着改。
 */
function filesIn(subdir) {
  const dir = path.join(root, 'src', 'client', subdir)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => `src/client/${subdir}/${f}`)
}

/** `src/client/dom/` 下的 DOM 胶水文件（有状态、环境注入）。 */
export function domSourceFiles() {
  return filesIn('dom')
}

/**
 * 浏览器侧源码整体：main.js（拍平）+ `dom/*` + 全部 pure 文件。
 *
 * 为什么把拆出去的子目录也算进来：从 main.js 搬到 `src/client/dom/` 的代码
 * 仍然必须留在形状断言的视野里 —— 否则「搬家」会顺手把一条守卫变成永久绿灯。
 */
export function clientSource() {
  const parts = [dedentEntry(read('src/client/main.js'))]
  for (const rel of domSourceFiles()) parts.push(read(rel))
  for (const rel of pureSourceFiles()) parts.push(read(rel))
  return parts.join('\n')
}
