/**
 * 测试接缝的地基：把 `src/host/**` 整树拷进临时目录，逐文件过一次改写函数，
 * 再把要驱动的那个模块从临时目录 import 进来。
 *
 * 为什么要单独抽出来：批次 1（docs §8.34）的 `fake-child-process.mjs` 和批次 2 的
 * `fake-cdn.mjs` 需要的是同一件事 —— **跑生产代码本身**，只把外面那一层（子进程 / 网络）换成可控的。
 * 两处的差别只在「改哪一行」，拷贝逻辑没必要各写一份。
 *
 * 三条实现上的注意（沿用批次 1 踩过的）：
 *   1. **整树拷贝**：`tts-env.js` 会 import `./local-tts.js`、`./edge-tts.js`，
 *      `model-catalog.js` 会 import `./atomic-file.js`。只拷一个文件的话相对 import 直接炸。
 *      同一棵临时树里还要有 `src/shared`：`sovits-tts.js`、`index.js` 这些是
 *      `import '../shared/config-spec.js'` —— 目录结构必须照抄 `src/` 那一层的形状
 *      （`<base>/host/**` + `<base>/shared/**`），否则装载就报 ERR_MODULE_NOT_FOUND。
 *   2. 临时目录里放一份 `package.json`：没有它 Node 要靠「解析失败再重 parse」才认出 ESM，
 *      每次装载刷一条 MODULE_TYPELESS_PACKAGE_JSON 警告，把测试输出淹掉。
 *   3. **改写必须自检**：拿 `requireRewrite` 检查改写真打上了。
 *      打空了不会报错，只会让测试悄悄跑真实现 —— 批次 1 就是靠这条抓到一个静默失效的改写。
 *
 * 临时树为什么放在**仓库里**（`.tmp-host-*`，批次 15）：
 * 宿主代码现在有真裸依赖（`edge-tts.js` import `'msedge-tts'`）。放在 `os.tmpdir()` 下，
 * Node 沿临时树往上找 `node_modules` 永远找不到仓库那一份，装载直接 `ERR_MODULE_NOT_FOUND` ——
 * 而且报的是「找不到 msedge-tts」，看上去像依赖没装，其实是测试接缝的位置问题。
 * 放进仓库根下的 `.tmp*`（`.gitignore` 第一条就盖住它），往上走一步就是仓库的 `node_modules`，
 * 裸依赖按**和生产完全相同**的规则解析。没有选「在临时目录里造一份 node_modules 软链」：
 * 那要动 Windows junction，而 `rmSync(recursive)` 对联接目录的行为一旦和预期不符，
 * 删临时树就变成删仓库依赖 —— 为了少一个 `.tmp*` 目录去冒这个险不值。
 *
 * 搬进仓库的代价，以及本文件为此必须做的一件事（批次 15 踩出来的，docs §8.57）：
 * **仓库的 `node_modules` 从此对这棵树可见**，「这个包没装」不再能靠环境成立。
 * 第一次撞上是 `test/worker-fallback.test.mjs` 第 3b 节：WASM 档那棵树里只放 WASM 假包，
 * 原本指望 `require('sherpa-onnx-node')` 必然 MODULE_NOT_FOUND，搬树之后它往上落到了仓库里
 * **真的原生 addon**，拿假模型路径去构造识别器 → 进程当场崩（Windows 退出码 0xC0000409，
 * 无堆栈、无 stderr，只表现为测试文件跑到那一行就没输出）。
 * 于是有了下面那道**可选依赖防火墙**：`package.json` 里凡是 dev / peer / optional 的裸名，
 * 树里一律造成「没装」。口径只有一条：
 *   `dependencies` = 生产必需 = 装机一定在场 = 树里也看得见（按真实规则解析）；
 *   其余 = 装机不一定有 = 树里默认没有，**在场与否由替身写出来**。
 * 名字表从 `package.json` 派生，不在这里手抄 —— 抄一份就会跟着依赖表过期。
 * 判据那边也要跟着表态：凡靠「这一档加载不出来」成立的判据，必须自己探一次树里确实加载不出来
 * （见 `worker-fallback.test.mjs` 第 3b 节那两条 `probe`），否则漏到真包时它会安静地绿。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const HOST_DIR = path.join(ROOT, 'src', 'host')
/** 宿主侧会跨目录 import 的共享模块（`../shared/*.js`）。 */
const SHARED_DIR = path.join(ROOT, 'src', 'shared')

/**
 * 「装机不一定在场」的裸包名：dev / peer / optional 三张表并集，减去 dependencies。
 *
 * 减 dependencies 是因为它代表「生产必需」—— 真装机一定装得上，树里也该按真实规则解析得到
 * （批次 15 之后宿主代码真的 `import 'msedge-tts'`，挡掉它就是把生产形态测错了）。
 * 名字表从 `package.json` 派生：手抄一份就会跟着依赖表过期，
 * 加一个可选依赖而忘了同步，防火墙就漏一个 —— 而那正是这套机制要防的事。
 */
const NOT_GUARANTEED_DEPS = (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const required = new Set(Object.keys(pkg.dependencies ?? {}))
  const out = []
  for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (!required.has(name) && !out.includes(name)) out.push(name)
    }
  }
  return out
})()

/**
 * 在树里造一道「这些包没装上」的防火墙。
 *
 * 做法是给每个名字放一个**只有 `package.json` 的壳**，`main` 指向一个不存在的 `index.js`：
 * `require` 得到 MODULE_NOT_FOUND、`import` 得到 ERR_MODULE_NOT_FOUND，
 * 而解析**不会**因为主文件缺失就继续往上落到仓库那份真的（本轮在仓库里分三个进程实测过）。
 * 为什么不放一个「抛错的 index.js」：那是「装了但坏了」，不是「没装」，
 * 生产里这两条路的处理不一样（`resolveSherpa` 会把细节拼进报错文案）。
 *
 * 谁想在这一档造出「在场」，就在 `<dir>/node_modules/<name>/` 里写真替身 —— 壳只有 package.json，
 * 会被替身自己的 package.json 覆盖掉，所以「在场与否」始终由测试说了算。
 *
 * @param {string} dir - 要放 `node_modules` 的目录（树里模块往上走的第一站）。
 * @returns {string[]} 造了壳的名字（给调用方自检/报错用）。
 */
export function firewallOptionalDeps(dir) {
  const made = []
  for (const name of NOT_GUARANTEED_DEPS) {
    const target = path.join(dir, 'node_modules', ...name.split('/'), 'package.json')
    // 已经有人写过这个包就别覆盖：调用方可能在调用前就塞好了替身。
    if (fs.existsSync(target)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify({
      name,
      version: '0.0.0-not-installed',
      main: 'index.js',
      description: '测试临时树的依赖防火墙：只有清单、没有入口，于是这个包在树里等于没装。'
        + '理由见 helpers/host-copy.mjs 头部（批次 15，docs §8.57）。',
    }, null, 2) + '\n', 'utf8')
    made.push(name)
  }
  return made
}

/**
 * 拷树并装载。
 *
 * @param {string} name - 要 import 的模块名（不含扩展名）。
 * @param {object} [options] - 选项。
 * @param {(code: string, file: string) => string} [options.transform] -
 *   对每个 `.js` 文件调一次（file 是文件名）。返回改写后的源码。
 * @param {Array<[string, string, string]>} [options.requireRewrite] -
 *   自检清单：`[说明, 原文里应有的片段, 产物里应有的片段]`。
 *   原始源码树里必须找得到第一个片段（否则这条自检已经过期，该跟着生产代码改），
 *   改写后的产物里必须找得到第二个片段（否则改写了个空）—— 两条都不成立就抛错，
 *   绝不让测试悄悄跑真实现。
 * @returns {{dir: string, modulePath: string, files: Map<string, string>}}
 *   dir=临时目录，modulePath=要 import 的文件绝对路径，files=每个 `.js` 的改写结果。
 */
export function copyHostTree(name, { transform = null, requireRewrite = [] } = {}) {
  const base = fs.mkdtempSync(path.join(ROOT, `.tmp-host-${name}-`))
  // 照抄 src/ 那层的形状：host/ 里是宿主模块，同级 shared/ 给 `../shared/*.js` 用。
  const dir = path.join(base, 'host')
  fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(SHARED_DIR)) fs.cpSync(SHARED_DIR, path.join(base, 'shared'), { recursive: true })
  fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n', 'utf8')
  // 依赖防火墙。放在 `base` 而不是 `base/host`：这棵树里 host/ 和 shared/ 两块都要被盖住，
  // 而 Node 从树里任一模块往上走，第二站就是 `<base>/node_modules` —— 比仓库那份近。
  // 替身照样能赢：`extraTreeFiles` 写进 `<base>/host/node_modules/`，那是**第一站**。
  firewallOptionalDeps(base)
  const files = new Map()
  let originals = ''
  for (const entry of fs.readdirSync(HOST_DIR, { withFileTypes: true })) {
    const from = path.join(HOST_DIR, entry.name)
    const to = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      fs.cpSync(from, to, { recursive: true })
      continue
    }
    if (!entry.name.endsWith('.js')) {
      fs.copyFileSync(from, to)
      continue
    }
    const original = fs.readFileSync(from, 'utf8')
    originals += original
    const code = transform ? transform(original, entry.name) : original
    files.set(entry.name, code)
    fs.writeFileSync(to, code, 'utf8')
  }
  const rewritten = [...files.values()].join('\n')
  for (const [label, before, after] of requireRewrite) {
    if (!originals.includes(before)) {
      throw new Error(`接缝自检失败：${label} —— 原始源码里已经找不到这段：${before}。`
        + '要么生产代码改了写法，要么这条自检该跟着改。')
    }
    if (!rewritten.includes(after)) {
      throw new Error(`接缝自检失败：${label} —— 改写没打上（产物里没有这段：${after}）。`
        + '继续跑下去测的就是真实现，宁可现在炸。')
    }
  }
  return { dir: base, hostDir: dir, modulePath: path.join(dir, `${name}.js`), files }
}

/**
 * 装载临时目录里的那份模块。
 * @param {{modulePath: string}} tree - `copyHostTree` 的返回值。
 * @returns {Promise<object>} import 到的模块。
 */
export async function importFromTree(tree) {
  return import('file://' + tree.modulePath.replace(/\\/g, '/'))
}

/**
 * 删掉临时目录。
 * @param {string} dir - `copyHostTree` 返回的目录。
 */
export function removeHostTree(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}
