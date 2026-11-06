/**
 * 宿主侧构建：`src/host/*.js` → `lib/*.js`（每个入口一个自包含产物）。
 *
 * 为什么宿主侧也要构建（第 6 步，见 docs §8.28）：
 *   浏览器侧早就是「src 原始代码 → esbuild → lib 产物」那一套标准形态，宿主侧不是 ——
 *   `lib/` 里的文件本身就是手写源码，其中几个还在**运行时**相对 import `../src/shared/*`，
 *   于是 npm 的 `files` 必须把 `src/shared` 一起发出去，漏了就 `ERR_MODULE_NOT_FOUND`。
 *   本脚本把那套形态推进到宿主侧：`src/` 放原始代码，`lib/` 只放产物，发布只发 `lib`。
 *
 * **入口不是「lib 里所有文件」**，而是「有代码按文件路径加载它」的那几个（实测清单）：
 *   `lib/index.js`       宿主按 `main` / `exports["."]` 加载
 *   `lib/client.js`      宿主按 `exports["./client"]` 加载       —— 归 build-client.mjs 管
 *   `lib/asr-worker.js`  Worker 按 `new URL('./asr-worker.js', import.meta.url)` 加载
 *   `lib/tts-worker.js`  Worker 按 `join(HERE, 'tts-worker.js')` 加载（HERE 就是 lib/）
 * 没列进来的那些 `lib/*.js` 是内部模块；6.5 把它们全部内联进 index.js 之后就从 lib/ 消失。
 * Worker / 子进程这类「按路径加载」的东西**必须**是独立产物，不能合进单文件里 ——
 * 合进去就没有那个路径了。
 *
 * 用法：
 *   node scripts/build-host.mjs           # 写盘
 *   node scripts/build-host.mjs --check   # 只校验（CI / 测试用，不写盘）：产物是否最新 + src/host 里有没有孤儿模块
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { writeFileAtomic } from '../src/host/atomic-file.js'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/**
 * 入口清单：新增条目的条件是「有代码按文件路径加载这个产物」。
 * 导出给测试用（bundle-sync 靠它知道「哪些 lib 文件是构建脚本宣布的产物」），
 * 所以这里加一个入口，产物豁免名单自动跟着长，不用两头改。
 */
export const HOST_ENTRIES = [
  { in: 'src/host/index.js', out: 'lib/index.js' },
  { in: 'src/host/asr-worker.js', out: 'lib/asr-worker.js' },
  { in: 'src/host/tts-worker.js', out: 'lib/tts-worker.js' },
]

const BANNER =
  `/* 构建产物，勿手改：由 scripts/build-host.mjs 从 src/host/ 生成。\n` +
  `   改 src/host/ 之后要跑 npm run build:host（校验用 npm run check:host）。 */\n`
  // 这里以前还接了两行 `createRequire` 垫片（批次 15 之前）。它只为一个东西存在：
  // 内联进产物的第三方 CJS（`src/host/vendor/msedge-tts.cjs`）里那些运行时才走的
  // `require("node:util")` —— esbuild 把它们换成自带的 __require 垫片，而垫片在 ESM 里
  // 找不到 `require`，构建期什么都看不出来、一 import 产物就炸。
  // 现在 msedge-tts 是真依赖：产物里第三方代码一行都没有，`grep -c "require(" lib/index.js` = 0。
  // 垫片留着不会坏事，但它会让「产物还需要 require」这个已经不成立的前提一直写在脸上 ——
  // 哪天又有人把 CJS 内联进来，正确的做法是把它做成依赖，而不是想起这两行。

/** 把 esbuild 的错误摊成一行消息（带文件和行号）。 */
function describeErrors(errors) {
  return (errors ?? [])
    .map((e) => `${e.text}（${e.location?.file ?? '?'}:${e.location?.line ?? '?'}）`)
    .join('\n')
}

/**
 * 产物形态守卫：宿主侧产物里不该出现的东西，构建时就拦下。
 * 相对 import 必须已被内联 —— 留着就是在要求「发布物带上 src/」，
 * 而这条正是第 6 步要消掉的东西（见 docs §8.28 M8）。
 */
function assertHostShape(content, entry) {
  if (!content.startsWith('/* 构建产物，勿手改')) {
    throw new Error(`${entry.out} 没有生成说明头 —— banner 掉了？`)
  }
  const leftover = [...content.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)].map((m) => m[1])
  if (leftover.length) {
    throw new Error(`${entry.out} 里残留相对 import：${leftover.join(', ')} —— bundle 没生效，产物不自包含`)
  }
}

/**
 * 计算所有入口的产物内容（不写盘）。测试用它校验「产物与源一致 + 计算幂等」。
 * @returns {{ built: Array<{out:string, content:string, used:string[]}>, inputs: Set<string> }}
 *   `used` = 该入口真被打进来的 src/host 模块（不含入口自身）；
 *   `inputs` = 全部产物的输入并集，供 `assertNoOrphanHostModules` 判「有没有文件没进过任何 import 图」。
 */
export async function renderHost() {
  const built = []
  const inputs = new Set()
  for (const entry of HOST_ENTRIES) {
    let res
    try {
      res = await esbuild.build({
        entryPoints: [entry.in],
        absWorkingDir: root,
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        target: ['node22'],
        // 裸包名一律外部化：原生模块（sherpa-onnx-node / uiohook-napi）打进产物就是坏的，
        // 而且它们本来就是 optionalDependencies，装了才引得到。
        packages: 'external',
        charset: 'utf8',
        banner: { js: BANNER },
        metafile: true,
        logLevel: 'silent',
      })
    } catch (error) {
      throw new Error(`${entry.out} 构建失败：${describeErrors(error.errors) || error.message}`)
    }
    const content = res.outputFiles[0].text
    assertHostShape(content, entry)
    const used = Object.keys(res.metafile.inputs)
      .filter((k) => k.startsWith('src/host/') && k !== entry.in)
      .sort()
    for (const k of Object.keys(res.metafile.inputs)) inputs.add(k)
    built.push({ out: entry.out, content, used, entry: entry.in })
  }
  return { built, inputs }
}

/**
 * 递归列 `src/host/` 下的代码文件（相对仓库根、正斜杠）。
 * 子目录也要扫：只扫顶层就等于给「搬进子目录但没人 import」留了一个看不见的角落。
 * （历史上这里扫的是 `src/host/vendor/`；批次 15 把那份内联包换成真依赖之后 vendor 没了，
 * 递归本身留着 —— 它拦的是目录级死角，不是某一个目录。）
 */
export function listHostModules() {
  const out = []
  const walk = (dir) => {
    for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`
      if (ent.isDirectory()) walk(rel)
      else if (/\.(?:js|cjs|mjs)$/.test(ent.name)) out.push(rel)
    }
  }
  if (fs.existsSync(path.join(root, 'src', 'host'))) walk('src/host')
  return out.sort()
}

/**
 * 「src/host 下有文件没进任何产物的 import 图」= 写了但永远不会执行 = 死代码。
 *
 * 这条判据原来住在 `test/bundle-sync.test.mjs` 里（批次 6l 之前），
 * 判的是「测试自己扫一遍目录，再和构建脚本给的输入清单比」。
 * 搬到这里来的理由：**算 import 图的人本来就知道谁没进图**，
 * 测试再扫一次目录只是复刻同一件事，还得为它多养一条「扫描非空」的防空转判据
 * （扫描静默返回空数组时，「没有孤儿」会照样绿）。
 * 现在测试改判「真命令的真退出码」，这条不变量还能顺带拦住构建本身。
 *
 * @param {Set<string>} inputs - `renderHost()` 返回的全部产物输入并集。
 * @returns {number} 扫到的文件数（给 --check 的那行报告用）。
 */
export function assertNoOrphanHostModules(inputs) {
  const files = listHostModules()
  // 空扫描不许算成「没有孤儿」：目录没了、列目录的写法坏了，表现都是静默通过。
  if (files.length === 0) throw new Error('src/host 下一个代码文件都没扫到 —— 目录还在吗？')
  const orphans = files.filter((f) => !inputs.has(f))
  if (orphans.length) {
    throw new Error(`src/host 下有 ${orphans.length} 个文件没进任何产物的 import 图：${orphans.join(', ')} —— `
      + '没被 import 就是永远不会执行的死代码：要么让某个入口 import 它，要么删掉')
  }
  return files.length
}

const isMain = (() => {
  try {
    return path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  try {
    const { built, inputs } = await renderHost()
    const stale = built.filter(({ out, content }) => {
      let current = ''
      try {
        current = fs.readFileSync(path.join(root, out), 'utf8')
      } catch {
        /* 产物还不存在 */
      }
      return current !== content
    })
    if (process.argv.includes('--check')) {
      // 孤儿模块这一族也归这里判（理由见 assertNoOrphanHostModules 的注释）。
      const total = assertNoOrphanHostModules(inputs)
      if (stale.length) {
        console.error(`✗ ${stale.map((s) => s.out).join(', ')} 与 src/host/ 不同步 —— 跑 npm run build:host`)
        process.exit(1)
      }
      console.log(`✓ ${built.map((b) => b.out).join(', ')} 已是最新`)
      console.log(`✓ src/host 的 ${total} 个文件都进了某个产物的 import 图（无孤儿）`)
      process.exit(0)
    }
    for (const { out, content, used, entry } of built) {
      await writeFileAtomic(path.join(root, out), content, { encoding: 'utf8' })
      const extra = used.length ? `（另内联 ${used.length} 个：${used.join(', ')}）` : '（无内部依赖）'
      console.log(`✓ 已生成 ${out} ${extra}`)
      // 报**字节**：`content.length` 是字符数，中文注释按 UTF-8 一个字符占 3 字节，
      // 所以旧口径打出来的数比文件真实大小小一截（lib/index.js 245,220 字节被打成「222 KB」）。
      // 这行是给「产物瘦身了没有」当证据的，单位不能糊。
      console.log(`  ${content.split('\n').length} 行 / ${(Buffer.byteLength(content, 'utf8') / 1024).toFixed(0)} KiB ← ${entry}`)
    }
    if (stale.length === 0) console.log('  （内容与上次一致，没有实际变化）')
  } catch (error) {
    // 构建失败要**出声**并留非 0 退出码（CI 的 check:host / 测试都靠这个信号）。
    console.error(`✗ ${error.message}`)
    process.exit(1)
  }
}
