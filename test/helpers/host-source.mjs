/**
 * 宿主侧**源码**读取器 —— 给「源码形状」类断言用（客户端先例：client-source.mjs）。
 *
 * 要解决的问题：第 6.5 步要把 `lib/` 里那 21 个内部模块搬进 `src/host/`、
 * 构建出自包含的 `lib/index.js`。而这仓库里有二十个测试文件在
 * `readFileSync('lib/index.js')` 上做正则断言 —— 搬一次家要改二十个文件，
 * 而漏改的那一处不会报「路径错了」，它要么直接 ENOENT 崩掉整个测试文件
 * （看起来像一片红其实只有一处笔误），要么更糟：读到内联之后的**产物**，
 * 于是断言悄悄变成在验 esbuild 的输出格式，而不是「源码别退回旧写法」。
 *
 * 所以这里只留一张解析规则，搬家时改的是规则而不是二十处调用：
 *   1. 先找 `src/host/`，再找 `lib/`（6.5 之后 src/host 是唯一答案）；
 *   2. **带产物 banner 的文件一律跳过** —— 产物是构建器的输出，引号风格、
 *      空白、变量改名（`configStore2`）都由它决定，拿来做形状断言就是要求
 *      构建器保持人类写法。这条规则同时意味着：`lib/index.js` 一旦变成产物，
 *      所有还写着 `'index'` 的断言自动改读 `src/host/index.js`，不用回来改调用点。
 *
 * **行为断言仍然要加载真产物**（照 worker-fallback 的做法：形状读源码、行为读产物）——
 * 这里只管形状。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))

/** 与 scripts/build-*.mjs 的 banner 同一句话；产物靠它自报身份，不靠路径名单。 */
const ARTIFACT_BANNER = '构建产物，勿手改'

/** 查找顺序：源码目录优先，lib 是搬家前的临时位置。 */
const HOST_SOURCE_DIRS = ['src/host', 'lib']

function readAbs(abs) {
  return fs.readFileSync(abs, 'utf8')
}

function isBuildArtifact(abs) {
  try {
    return readAbs(abs).slice(0, 400).includes(ARTIFACT_BANNER)
  } catch {
    return false
  }
}

/**
 * 模块名 → 仓库内相对路径。名字可以写 `'index'`、`'index.js'`，带子目录的写 `'sub/x.js'`。
 * 找不到手写源码时抛错并说清找过哪些地方 —— 让「文件搬家了」表现为一条可读的错误，
 * 而不是 ENOENT 或者一次静默的降级。
 */
export function hostSourcePath(name) {
  const file = /\.(?:js|cjs|mjs)$/.test(name) ? name : `${name}.js`
  const tried = []
  for (const dir of HOST_SOURCE_DIRS) {
    const rel = `${dir}/${file}`
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      tried.push(`${rel}（不存在）`)
      continue
    }
    if (isBuildArtifact(abs)) {
      tried.push(`${rel}（构建产物，不参与形状断言）`)
      continue
    }
    return rel
  }
  throw new Error(`找不到 ${file} 的手写源码 —— ${tried.join('；')}`)
}

/** 模块的手写源码内容。 */
export function hostSource(name) {
  return readAbs(path.join(root, hostSourcePath(name)))
}

/**
 * 按名字动态 import 宿主模块（行为类断言用）。
 *
 * 为什么连 import 也要走这里：`import('../lib/read-aloud-scheduler.js')` 这种
 * 「按路径加载**内部模块**」在第 6.5 步之后会 ENOENT —— 那个文件被内联进产物，
 * `lib/` 里不再有它。按名字走就自动跟着源码住哪儿。
 * 例外是四个真入口（`lib/index.js`、`lib/client.js`、`lib/{asr,tts}-worker.js`）：
 * 它们是宿主/Worker 按路径加载的产物，名字在这里也能解析，但**行为断言请直接 import 产物路径**，
 * 验的才是真会被加载的那份文件。
 *
 * @param {string} name 模块名（`'paragraph'` / `'read-aloud-scheduler'` / 带扩展名也行）
 * @param {{nocache?: boolean}} [opts] `nocache` 给 URL 加时间戳查询串，
 *   用于「同一个模块要反复重新求值」的探测（原来那些 `?probe=` 写法）。
 */
export async function hostModule(name, opts = {}) {
  const rel = hostSourcePath(name)
  const abs = path.join(root, rel)
  const url = pathToFileURL(abs).href + (opts.nocache ? `?probe=${Date.now()}` : '')
  return import(url)
}

/**
 * 多个模块的 `[相对路径, 内容]` 列表 —— 给「逐文件扫一遍并按路径报告命中行」的断言用。
 * 名单写模块名而不是写路径：`lib/x.js` 搬到 `src/host/x.js` 之后，
 * 报告里显示的是**实际**读到的那份路径，而断言本身不用改。
 */
export function hostSourceEntries(names) {
  return names.map((name) => {
    const rel = hostSourcePath(name)
    return [rel, readAbs(path.join(root, rel))]
  })
}

/** 某个目录下全部宿主源码（相对路径，排序）；目录还不存在时返回空数组。 */
export function hostSourceFiles(dir = 'src/host') {
  const abs = path.join(root, dir)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs)
    .filter((f) => /\.(?:js|cjs|mjs)$/.test(f))
    .sort()
    .map((f) => `${dir}/${f}`)
}

/** 解析规则用的目录顺序，测试里报告「现在住在哪」时要用。 */
export { HOST_SOURCE_DIRS, root as repoRoot }
