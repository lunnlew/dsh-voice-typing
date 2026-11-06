/**
 * 发布清单（package.json 的 `files`）完整性检查。
 *
 * 为什么要有这条：本地插件是 **symlink 装到工作区**的（见 docs §8.27），
 * 所以「少发了一个运行时要 import 的文件」这类缺陷在本机永远看不见 —— 那个文件
 * 就在旁边。只有真按 tarball 装（CI、别的机器、用户手动 npm i）才会炸。
 *
 * 这条测试不问「白名单写成了什么」，问「按 npm 的规矩真打出来的包里，
 * 运行时 import 图上的每个文件都在不在」。两侧都钉：
 *   少发 → 装不上（红）；
 *   多发 → 把开发期文件（test / scripts / src/）散播出去（红）。
 *
 * 历史背景：第 6.5 步之前，宿主侧 `lib/*.js` 是手写源码，其中几个在**运行时**
 * 相对 import `../src/shared/*`，于是 `files` 必须带上 `src/shared`，漏了就
 * `ERR_MODULE_NOT_FOUND`。现在 `lib/` 全是产物、产物自包含，`src/` 一个都不发。
 * 因此这条守卫的方向反过来了：从前查「src/ 里的运行时依赖发全了没有」，
 * 现在查「import 图有没有逃出 lib/」。
 *
 * 批次 23 再翻一次：`lib/` 自己也不进版本库了（`.gitignore` 收 `/lib/`，发布前由
 * `prepack` 现生成）。于是多了一节 3b，专门判「产物在不在磁盘、进没进包、prepack 还建不建两端」——
 * 这三条在产物入库的年代是不需要判的（东西就在仓库里）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HOST_ENTRIES } from '../scripts/build-host.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

/* ================= 1. 拿 npm 自己算出来的发布清单 ================= */
// 不自己实现 minimatch 语义，直接问 npm：这是唯一和真发布一致的口径。
// shell:true 是必须的：Windows 上 npm 是 npm.cmd，Node 20.11+ 不允许不带 shell 直接
// spawn 批处理文件（会 EINVAL）。带 shell 时把整条命令写成一个字符串传进去，
// 免得 Node 报 DEP0190（shell 模式下 args 只拼接不转义）。
// `--ignore-scripts`（批次 23 加）：`package.json` 现在挂着 `prepack` 构建产物，
// 而实测 `npm pack` 与 `npm pack --dry-run` **都会执行 prepack**（`--ignore-scripts` 才不执行）。
// 本测试问的是「清单算得对不对」，不是「能不能构建」：不带这个开关的话，
// 构建一坏 npm pack 就以非 0 退出，这里会走到上面那条「⏭ 跳过」并**以 0 退出**（= 假绿），
// 还会每次跑测试都重建一遍 lib。prepack 本身由下面第 3b 节判它存不存在、构不建两端。
const packed = spawnSync('npm pack --dry-run --json --ignore-scripts', {
  cwd: root, encoding: 'utf8', shell: true, maxBuffer: 32 * 1024 * 1024,
})
if (packed.status !== 0 || !packed.stdout) {
  console.log('  ⏭ 跳过：拿不到 npm pack 清单（npm 不可用或报错）—— ' +
    String(packed.stderr || '').split('\n')[0])
  process.exit(0)
}
// npm 的 --json 对 pack 返回的是数组（一个包一项），别按对象读。
// 带 shell 跑时 stdout 前面偶尔混着 notice 行，从第一个 [ 或 { 开始截。
const raw = String(packed.stdout)
let packJson
try {
  const parsed = JSON.parse(raw.slice(raw.search(/[[{]/)))
  packJson = Array.isArray(parsed) ? parsed[0] : parsed
} catch (e) {
  console.log('  ⏭ 跳过：npm pack --json 的输出解析不出来 —— ' + e.message)
  process.exit(0)
}
const LIST = new Set(packJson.files.map((f) => f.path.replace(/\\/g, '/')))

console.log(`\nnpm 认定的发布清单：${packJson.entryCount} 个文件，` +
  `打包 ${(packJson.size / 1024).toFixed(0)} kB / 解压 ${(packJson.unpackedSize / 1024).toFixed(0)} kB`)

/* ================= 2. 运行时 import 图（从入口沿相对路径走） ================= */
/**
 * 抓四种写法，全都要求「语法位置」，散文里的路径提到不算依赖：
 *   from './x.js'        import 与 re-export
 *   import('./x.js')     动态 import
 *   require('./x.js')    CJS（产物里现在没有第三方 CJS，写法仍一起抓）
 *   new URL('./x.js', import.meta.url)   worker / 子进程脚本按路径加载
 * 两个坑（都是实测踩出来的）：
 *   - 引号里不许换行，否则 `require(\n 'x'\n)` 会把整段空白当成一个「看不见的依赖名」；
 *   - 压缩过的第三方包（批次 15 之前是 `src/host/vendor/msedge-tts.cjs`，已内联进 lib/index.js）
 *     里有 `Buffer.from(",")` 这类调用，
 *     `from` 前面带点要先排除，再叠一层「合法模块名字符集」过滤 ——
 *     真的 specifier 不会含逗号、空格、括号。
 *     **这条过滤眼下不承重**：批次 15 实测把它换成「什么字符都放行」，本文件 17 条照旧全绿，
 *     因为产物里已经只剩自家代码。留着是护栏 —— 本仓库的口径是第三方走 `dependencies`，
 *     万一有人再把压缩 CJS 内联进来，没有它这条扫描会先失真。
 * 抓不到的是纯字符串拼接的路径（如 join(HERE, 'tts-worker.js')）——
 * 那些目标当前全在 lib/ 目录内，由 files 里的整目录 "lib" 覆盖，不靠本条守卫。
 */
const SPEC_SHAPE = /^[.@/:A-Za-z][A-Za-z0-9@._+:/-]*$/

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function specifiersOf(text) {
  const out = []
  const src = stripComments(text)
  for (const m of src.matchAll(/(?<![\w.$])(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*['"]([^'"\n]+)['"]/g)) {
    const s = m[1].trim()
    if (SPEC_SHAPE.test(s)) out.push(s)
  }
  for (const m of src.matchAll(/new URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url/g)) {
    const s = m[1].trim()
    if (SPEC_SHAPE.test(s)) out.push(s)
  }
  return out
}

/** 入口：package.json 的 main + exports，宿主加载的就是这几个。 */
function entryPoints() {
  const out = new Set()
  if (pkg.main) out.add(pkg.main)
  const walk = (v) => {
    if (typeof v === 'string') out.add(v)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  Object.values(pkg.exports ?? {}).forEach(walk)
  // exports 里写的是 `./lib/index.js`，统一成包内 posix 路径再进队列；
  // 只用 posix 拼接，否则 Windows 上 path.join 会造出 `lib\index.js`，
  // 而 npm 的清单永远是 `lib/index.js` —— 两边对不上就会全体误报。
  return [...new Set([...out]
    .map((p) => path.posix.normalize(p.startsWith('./') ? p.slice(2) : p))
    .filter((p) => /\.(js|cjs|mjs)$/.test(p)))]
}

const seen = new Set()
const missing = []
const outside = []
/** 裸依赖名 -> 第一个引到它的文件（报错时要能指认是谁引的）。 */
const bareSpecs = new Map()
/**
 * 当成叶子、不爬内容的文件：`lib/client.js` 是 esbuild 单文件产物，
 * 运行时不引任何文件（宿主只 require('react')）。拿正则去扫它 317 KB 的产物字节，
 * 会被里面的字符串（markdown 围栏、模板串）干扰抓出假 specifier ——
 * 它的真实入口清单由 `test/bundle-sync.test.mjs` 用 esbuild metafile 守，不归这条管。
 *
 * `lib/index.js` 也是产物（6.5 起），但它**要爬**：Worker 是「按路径加载」的，
 * `new URL('./asr-worker.js', import.meta.url)` 这条边只有扫产物字节才看得见，
 * 而那条边正是「包里的 asr-worker.js 不能漏发」的唯一机械证据。
 * 误报风险比 client.js 低得多：产物里没有裸 `require('react')` 那种注入点，
 * 相对 import 已被 build-host 的 assertHostShape 拦光（不许残留）。
 */
const LEAVES = new Set(['lib/client.js'])
const queue = entryPoints()
while (queue.length) {
  const rel = queue.shift()
  if (seen.has(rel)) continue
  seen.add(rel)
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) { missing.push(rel); continue }
  if (LEAVES.has(rel)) continue
  for (const spec of specifiersOf(fs.readFileSync(abs, 'utf8'))) {
    if (!spec.startsWith('.')) { if (!bareSpecs.has(spec)) bareSpecs.set(spec, rel); continue }
    const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
    if (next.startsWith('..')) { outside.push(`${rel} -> ${spec}`); continue }
    if (/\.(js|cjs|mjs|json)$/.test(next)) queue.push(next)
  }
}

console.log(`\n从 ${entryPoints().join(' / ')} 出发，运行时 import 图上有 ${seen.size} 个文件` +
  `（叶子不爬：${[...LEAVES].join(', ')}）`)

check('import 图不是空的（扫描逻辑没坏）', seen.size >= 3, `实际 ${seen.size} 个`)
// 6.5 之后产物自包含，import 图应该只剩「按路径加载」的那几条边：
// 入口自身 + 它 new URL 出来的 worker。少了哪一条就是「漏发一个产物」那种装不上的缺陷，
// 所以这里逐条点名，不用「至少 N 个」这种能被多余文件凑数的判据。
for (const entry of ['lib/index.js', 'lib/client.js', 'lib/asr-worker.js']) {
  check(`import 图覆盖 ${entry}`, seen.has(entry), [...seen].join(', '))
}

/* ================= 3. 少发：import 图上的文件必须在包里 ================= */
const notShipped = [...seen].filter((p) => !LIST.has(p))
check('import 图上的每个文件都进了发布包', notShipped.length === 0,
  `漏发 ${notShipped.length} 个：${notShipped.join(', ')}`)
check('没有 import 逃到包外（相对路径不能越出包根）', outside.length === 0, outside.join(' | '))
check('包内不存在断链（import 指向的文件在工作区里也找不到）', missing.length === 0, missing.join(', '))

/* ============ 3b. 产物不入库之后，发布物只能靠构建来（批次 23） ============ */
/**
 * `lib/` 从批次 23 起在 `.gitignore` 里，仓库里没有那四个文件。
 * 于是发布链路上多了两种全新的失败方式，这一节一条管一个：
 *   - **磁盘上没构建出来** → 包里没有产物，装上了也起不来（`check A`）；
 *   - **`.gitignore` 把发布物吃掉** → npm 的 files 允许列表本来优先于 .gitignore，
 *     但这是「 npm 的规矩」而不是我们的约定，所以拿实测的清单钉住（`check B`；
 *     本批改 .gitignore 时正是先用 `npm pack --dry-run --json` 实测过一遍，
 *     清单仍是那 7 个文件 / lib 4 个产物，才敢说这条链路没被挡住）；
 *   - **`prepack` 被删了** → `npm publish` 从此发一份不存在的东西（`check C`）。
 * 产物路径不抄第二份名单：`lib/client.js` 由 build-client 固定，宿主那三个问
 * `scripts/build-host.mjs` 的 `HOST_ENTRIES`（和 `test/bundle-sync.test.mjs` 同一个来源）。
 */
const DECLARED_ARTIFACTS = ['lib/client.js', ...HOST_ENTRIES.map((e) => e.out)]
const onDiskArtifacts = fs.existsSync(path.join(root, 'lib'))
  ? fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`).sort()
  : []
check(`磁盘上四个产物都在（${DECLARED_ARTIFACTS.join(' / ')}）—— 不在就是没跑 pnpm run build`,
  DECLARED_ARTIFACTS.every((p) => onDiskArtifacts.includes(p)), `实际 lib/ 里：${onDiskArtifacts.join(', ') || '(目录不存在)'}`)
check('四个产物都进了发布清单（.gitignore 收了 lib/ 也不许把它们挡在包外）',
  DECLARED_ARTIFACTS.every((p) => LIST.has(p)),
  DECLARED_ARTIFACTS.filter((p) => !LIST.has(p)).join(', ') || '都在')
const prepack = String(pkg.scripts?.prepack ?? '')
check('package.json 有 prepack 且它两端都建（产物不入库，发布前必须现生成）',
  prepack.includes('build-client.mjs') && prepack.includes('build-host.mjs'),
  prepack || '(没有 prepack)')
check('.gitignore 里确实收了 /lib/（这条守卫的前提别再被人悄悄撤掉）',
  /(^|\n)\/?lib\/?(\n|$)/.test(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')),
  '.gitignore 没有 lib 这一行')

/* ================= 4. 裸依赖：不是相对路径的就该有声明 ================= */
const runtimeDeclared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
].map((n) => n.split('/')[0]))
const devDeclared = new Set(Object.keys(pkg.devDependencies ?? {}).map((n) => n.split('/')[0]))
const rootOf = (s) => s.split('/')[0]
const who = (s) => `${s}（${bareSpecs.get(s)} 引的）`
const undeclared = [...bareSpecs.keys()].filter((s) =>
  !s.startsWith('node:') && !runtimeDeclared.has(rootOf(s)) && !devDeclared.has(rootOf(s)))
check(`import 图上的裸依赖都有 package.json 声明（共 ${bareSpecs.size} 个）`,
  undeclared.length === 0, undeclared.map(who).join(', '))
// 只声明在 devDependencies 里的包不该出现在运行时 import 图上：
// 用户按生产依赖装（npm i --omit=dev）之后一 import 就是 ERR_MODULE_NOT_FOUND。
const devOnly = [...bareSpecs.keys()].filter((s) =>
  !s.startsWith('node:') && !runtimeDeclared.has(rootOf(s)) && devDeclared.has(rootOf(s)))
check('运行时 import 图不依赖 devDependencies（装了生产依赖就能跑）', devOnly.length === 0, devOnly.map(who).join(', '))

/* ================= 5. 多发：开发期文件不该散播出去 ================= */
// `src/` 整棵都在这一栏里：6.5 之后宿主侧也走「src 原始代码 → lib 产物」，
// 运行时不需要任何源码文件，把 src 发出去就等于把「还没构建化的那半截」又养回来。
for (const forbidden of ['test/', 'scripts/', 'docs/', 'src/']) {
  const leaked = [...LIST].filter((p) => p.startsWith(forbidden))
  check(`发布包里没有 ${forbidden}（开发期文件）`, leaked.length === 0,
    `${leaked.length} 个：${leaked.slice(0, 3).join(', ')}`)
}
check('发布包里没有 lib/cuda-node（几百 MB 的本地 CUDA 运行库不进 npm）',
  ![...LIST].some((p) => p.includes('cuda-node')))
check('发布包里没有 .npmignore / .gitignore 之类的仓库自用文件',
  ![...LIST].some((p) => p === '.npmignore' || p === '.gitignore' || p.startsWith('.tmp')))

/* ================= 6. 运行时 import 图必须 ⊂ lib/ ================= */
/**
 * 目标形态（第 6 步的落点）：src 放原始代码，lib 放构建结果，发布只发 lib。
 * 浏览器侧早就是这个形态（src/client → esbuild → lib/client.js，自包含）；
 * 6.5 把宿主侧也接上了 —— 内部模块全部内联进 lib/index.js，运行时不再引 src/。
 *
 * 这条计数因此从「进度指标」变成了**硬边界**：一旦 import 图里出现 lib/ 之外的文件，
 * 要么是新造了一个没进产物的运行时依赖（漏发就 ERR_MODULE_NOT_FOUND），
 * 要么是有人把源码直接放进 lib/ 绕过了构建。两种都不该发生。
 *
 * 「src 里每一个发出去的文件都被用到」那条反向守卫被这一条取代了：
 * 现在 src 一个都不发，反向检查退化成上面第 5 栏的「不许有 src/」。
 */
const outsideLib = [...seen].filter((p) => !p.startsWith('lib/'))
console.log(`\n运行时 import 图里 lib/ 之外的文件：${outsideLib.length} 个` +
  (outsideLib.length ? `（不该存在）：${outsideLib.join(', ')}` : '（宿主侧已完全构建化）'))
check('运行时 import 图全部落在 lib/ 里（产物自包含，不需要源码陪跑）',
  outsideLib.length === 0, outsideLib.join(', '))

/* ================= 7. 体积上限：防回潮 ================= */
// 2026-11-05（批次 15 之后）实测 7 个文件 / 解压 680 kB：
// lib/index.js 245,220 字节（第三方代码一行都不内联了，msedge-tts 走 dependencies；
// build-host 那行打印的 222「KB」是**字符数**/1024，中文注释按 UTF-8 占 3 字节，两个口径别混）
// + lib/client.js 317 kB + 两个 worker + README。
// 上一次记录是 2026-11-03 的 1485 kB，其中内联的 msedge-tts 就占 755 kB。
// 越过 2 MB 通常意味着把源码或测试又发出去了，不是正常的功能增长。
// 注意这条判据量的是**发布物**，不是 `node_modules`：依赖化之后用户装的包多了 37 个（axios / ws 那一族），
// 发布清单却反而瘦了一半 —— 这两个数字别混着谈。
check('解压体积不超过 2 MB', packJson.unpackedSize < 2 * 1024 * 1024,
  `实际 ${(packJson.unpackedSize / 1024 / 1024).toFixed(2)} MB`)

/* ================= 8. 带安装脚本的直接依赖必须逐个表态 ================= */
/**
 * 为什么要有这条：pnpm 10+ 对「带 preinstall / install / postinstall 的依赖」默认不放行，
 * 而且这不是警告 —— 没在 pnpm-workspace.yaml 的 `allowBuilds` 里点过名的，
 * `pnpm install --frozen-lockfile` 直接以 1 退出（2026-11-05 实测，本机 pnpm 11.7.0：
 * esbuild / uiohook-napi / msedge-tts 三个名字，前两个在批次 15 之前就在列表里）。
 * 批次 15 把 msedge-tts 从 vendor 搬成 dependencies，这类事故第一次撞到自己头上，
 * 所以把它变成判据：谁没表、谁的表过期了、谁的值写歪了，红了直接给名字。
 *
 * 只爬直接依赖那一层（package.json 里点过名的）。传递依赖的名单由 pnpm 自己算，
 * 装一次就报出来；这里不重复实现它的解析，只保证我们这一层的声明齐且活。
 *
 * `node_modules` 完全没装时整段跳过（新克隆、或只跑了 `--lockfile-only`）：
 * 这条查「配置和依赖声明对不对得上」，不查「依赖装没装」。
 */
const LIFECYCLE = ['preinstall', 'install', 'postinstall']
const directDeps = [...new Set(
  ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .flatMap((g) => Object.keys(pkg[g] ?? {})),
)]
const scriptBearing = []
const notInstalled = []
for (const name of directDeps) {
  const manifest = path.join(root, 'node_modules', name, 'package.json')
  if (!fs.existsSync(manifest)) { notInstalled.push(name); continue }
  const scripts = JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts ?? {}
  const hit = LIFECYCLE.filter((k) => scripts[k])
  if (hit.length) scriptBearing.push({ name, scripts: hit })
}

/**
 * 只读 allowBuilds 这一段，不引进 yaml 库：这文件是我们自己写的，需要读的就这一处。
 * 值必须是 `true` / `false` 字面量 —— pnpm 自动生成的是占位串
 * （`esbuild: set this to true or false`），那种写法装完照样红，所以它算「没表态」，
 * 不能算「表过态」。
 */
const wsPath = path.join(root, 'pnpm-workspace.yaml')
const wsExists = fs.existsSync(wsPath)
const wsLines = wsExists ? fs.readFileSync(wsPath, 'utf8').split('\n') : []
const declared = new Map()
{
  const start = wsLines.findIndex((l) => /^allowBuilds:\s*$/.test(l))
  if (start >= 0) {
    for (const line of wsLines.slice(start + 1)) {
      if (line.trim() && !/^\s/.test(line)) break
      const m = line.match(/^\s+([^:#\s][^:]*):\s*(.+?)\s*$/)
      if (m) declared.set(m[1], m[2])
    }
  }
}

console.log(`\n直接依赖 ${directDeps.length} 个，其中带安装脚本的 ${scriptBearing.length} 个：`
  + scriptBearing.map((d) => `${d.name}(${d.scripts.join('+')})`).join(', ')
  + (notInstalled.length ? ` ｜ 没装、爬不到：${notInstalled.join(', ')}` : ''))

if (notInstalled.length === directDeps.length) {
  console.log('  ⏭ 跳过：node_modules 里一个直接依赖都没有，查不了安装脚本')
} else if (!wsExists) {
  check('pnpm-workspace.yaml 存在（pnpm 10+ 的脚本开关只认这一处）', false, '文件不在')
} else {
  check('扫描真的找到了带安装脚本的直接依赖（判据不空转）', scriptBearing.length >= 1,
    `一个都没有，多半是 node_modules 换了形态，扫描逻辑得跟着改`)
  const missing = scriptBearing.filter((d) => !declared.has(d.name))
    .map((d) => `${d.name}(${d.scripts.join('+')})`)
  check('带安装脚本的直接依赖都在 allowBuilds 里表过态', missing.length === 0,
    `没表态：${missing.join(', ')}`)
  const badValues = [...declared].filter(([, v]) => v !== 'true' && v !== 'false')
    .map(([k, v]) => `${k}: ${v}`)
  check('allowBuilds 的值只有 true / false（占位串不算表态）', badValues.length === 0,
    badValues.join(' | '))
  const stale = [...declared.keys()].filter((k) => !directDeps.includes(k))
  check('allowBuilds 里没有已经不存在的直接依赖', stale.length === 0, stale.join(', '))
  // 这一行是给**还在用 pnpm 9 的人**留的兼容行：pnpm 9 看到 workspace 文件、发现没有
  // `packages` 字段就报 `ERROR packages field missing or empty` 直接失败（实测），
  // pnpm 10/11 不需要它（批次 24 实测：同一份只有 allowBuilds 的文件，11.7.0 装成功）。
  // CI 已经不在这条名单里了 —— 它的 pnpm 版本现在由 package.json 的 packageManager 决定
  // （见下面第 9 节）。本仓库是单包，列表写根包自己。
  const pIndex = wsLines.findIndex((l) => /^packages:\s*$/.test(l))
  const hasPackageEntry = pIndex >= 0 && wsLines.slice(pIndex + 1)
    .some((l) => /^\s*-\s*\S/.test(l))
  check('pnpm-workspace.yaml 有非空 packages（给 pnpm 9 留的兼容行）',
    hasPackageEntry, wsLines.slice(0, 6).join(' / '))

  /**
   * 「不许跑安装脚本」在 Linux 上也成立吗？批次 24 之前 CI 跑的是 pnpm 9，它不读 `allowBuilds`
   * （默认全跑），所以这里写的 false 从来没在流水线上下过功夫；现在 CI 与本机的 pnpm 版本同源，
   * CI 的安装面第一次真按这份名单走。于是必须逐个回答「脚本没跑，这包在 CI 那台 linux-x64 上还能用吗」：
   *   ① 包里自带 prebuilds/linux-*（node-gyp-build 优先挑现成的，压根不编译）；
   *   ② 平台包在它自己的 optionalDependencies 里（@esbuild/linux-x64 那一族，装依赖就带上，
   *      postinstall 只是「找不到就现下载」的兜底）；
   *   ③ 它的生命周期脚本只有 `only-allow` 那一类包管理器守卫，跟编译无关。
   * 三条都不占的名字就是「CI 上会装不出可用产物」的名字 —— 判据红了别去放宽它，
   * 要么给它留 `allowBuilds: true`，要么换一个自带二进制。
   */
  const noBuildFallback = []
  for (const { name, scripts } of scriptBearing) {
    if (declared.get(name) !== 'false') continue
    const dir = path.join(root, 'node_modules', name)
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const hasLinuxPrebuild = fs.existsSync(path.join(dir, 'prebuilds'))
      && fs.readdirSync(path.join(dir, 'prebuilds')).some((d) => d.startsWith('linux-'))
    const hasLinuxPlatformPkg = Object.keys(manifest.optionalDependencies ?? {})
      .some((dep) => dep.includes('linux'))
    const guardOnly = scripts.length === 1 && scripts[0] === 'preinstall'
      && /only-allow/.test(manifest.scripts?.preinstall ?? '')
    if (!hasLinuxPrebuild && !hasLinuxPlatformPkg && !guardOnly) noBuildFallback.push(name)
  }
  check('每个不放行的依赖都有「不跑脚本也能用」的兜底（Linux 二进制 / 平台包 / 只是包管理器守卫）',
    noBuildFallback.length === 0, `三条都不占：${noBuildFallback.join(', ')}`)
}

/* ================= 9. pnpm 版本只有一个来源 ================= */
/**
 * 为什么要有这条：批次 15 那阵子 CI 写 `pnpm/action-setup@v4 + version: 9`，本机是 11.7.0，
 * 两份版本各写各的。后果不是「数字不一样」而是**行为不一样**：pnpm 9 不读 `allowBuilds`
 * （默认全跑安装脚本），所以第 8 节那份名单在流水线上一个字都不生效，§8.56 把它记成
 * 「版本分叉没解决」。批次 24 把版本声明收进 `package.json` 的 `packageManager` ——
 * action-setup v4 在没有 `version` 输入时读这个字段，读不到才失败。
 *
 * 判据问的是「有没有第二处把 pnpm 版本写歪」，不是「版本值对不对」：
 * 只要 workflow 里再出现自带的 pnpm 版本，或者 packageManager 写得 action-setup 认不下来
 * （非精确三段版本），两边就又分叉了，而这种分叉要等流水线红了才看得见。
 *
 * 顺带判一条真会踩的顺序：`actions/setup-node` 带 `cache: pnpm` 时要先能跑 `pnpm`
 * 可执行文件（否则报 `Unable to locate executable file: pnpm`），所以 action-setup 必须排在它前面。
 */
const PM = pkg.packageManager
check('package.json 声明了 packageManager', typeof PM === 'string' && PM !== '', String(PM))
check('packageManager 写的是 pnpm@完整三段版本（corepack 与 action-setup 都不接受范围写法）',
  /^pnpm@\d+\.\d+\.\d+(?:\+.*)?$/.test(PM ?? ''), PM)

const wfDir = path.join(root, '.github', 'workflows')
const workflows = fs.existsSync(wfDir)
  ? fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).sort()
    .map((f) => [f, fs.readFileSync(path.join(wfDir, f), 'utf8').split('\n')])
  : []
check('CI 的 workflow 文件都读到了（判据不空转）', workflows.length >= 2,
  `只有：${workflows.map(([f]) => f).join(', ') || wfDir + ' 不在'}`)

for (const [wfName, lines] of workflows) {
  const setupLines = lines
    .map((l, i) => (/uses:\s*pnpm\/action-setup@/.test(l) ? i : -1))
    .filter((i) => i >= 0)
  const cacheLines = lines
    .map((l, i) => (/^\s*cache:\s*pnpm\s*$/.test(l) ? i : -1))
    .filter((i) => i >= 0)
  const runPnpmLines = lines
    .map((l, i) => (/^\s*run:\s*pnpm\b/.test(l) ? i : -1))
    .filter((i) => i >= 0)
  if (setupLines.length === 0) {
    // 这一步整个被删掉也是一种分叉：作业里照样写 `pnpm install` / `cache: pnpm`，
    // 那就退回「用 runner 镜像里碰巧是哪个版本」的老问题（判据 8 就是为它写的）。
    // 所以这里不许放行：这个文件既然在用 pnpm，就必须自己声明怎么装它。
    check(`${wfName}：既然用到 pnpm（run: pnpm ${runPnpmLines.length} 处 / cache: pnpm ${cacheLines.length} 处），就必须有 pnpm/action-setup 那一步`,
      runPnpmLines.length === 0 && cacheLines.length === 0,
      '装 pnpm 的那一步不在了，但作业还在跑 pnpm')
    continue
  }
  const selfPinned = []
  for (const i of setupLines) {
    for (const next of lines.slice(i + 1, i + 8)) {
      if (/^\s*#/.test(next)) continue
      if (next.trim() && !/^\s/.test(next)) break
      if (/^\s*-\s/.test(next)) break
      const m = /^\s*version:\s*(\S.*?)\s*$/.exec(next)
      if (m) selfPinned.push(m[1])
    }
  }
  check(`${wfName}：pnpm 版本不在 workflow 里自带（唯一来源是 packageManager ${PM}）`,
    selfPinned.length === 0, `自带了：${selfPinned.join(', ')}`)

  const orderBad = cacheLines.filter((c) => !setupLines.some((s) => s < c))
  check(`${wfName}：每个 cache: pnpm 都排在装 pnpm 那一步之后`, orderBad.length === 0,
    orderBad.map((i) => `第 ${i + 1} 行`).join(', ') || `action-setup 在最前：${setupLines.join('/')}`)
  // 上面那条按「文件里有没有更早的 setup 步」判，两个 job 写在同一个文件里时会互相顶替：
  // 后一个 job 少了那一步，前一个 job 的行号也算「在它之前」。这条按数量把这条路堵住。
  check(`${wfName}：每个用 cache: pnpm 的 job 都有自己的装 pnpm 那一步（数量对得上）`,
    cacheLines.length <= setupLines.length,
    `cache: pnpm ${cacheLines.length} 处 / action-setup ${setupLines.length} 处`)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed) process.exit(1)
