/**
 * 模块依赖图：让**构建器**告诉我们谁 import 了谁。
 *
 * 为什么要有这个 helper（批次 6d，docs/architecture-modernization.md §8.37）：
 * `test/bundle-sync.test.mjs` 里那批「pure/、dom/、shared/ 不许反向引用 main.js」的判据
 * 本来是拿正则扫每个文件的 import 语句 + 扫 main.js 的顶层符号名，再比字符串。
 * esbuild 解析同一批文件时本来就把这些边算出来了（metafile.inputs[file].imports），
 * 用它判等于用「真的解析出来的是什么」判 —— 写法变了不用回来改正则，
 * 动态 import / 别名 / 换行书写这些都自动算对。
 *
 * 顺带把「这三类目录不许引 Node 内置模块、不许引 react」也纳入同一张图：
 * 外部依赖在 metafile 里带 `external: true`，比文本正则更直说。
 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * @param {string[]} entryPoints 相对仓库根的路径，如 'src/client/pure/gate.js'
 * @returns {Promise<{ edges: Map<string, string[]>, external: Map<string, string[]>, error: string | null }>}
 *   edges：模块 → 它 import 到的**仓内**模块（都是相对根的路径）；
 *   external：模块 → 它 import 到的外部包名（react、node:fs…）。
 */
export async function buildModuleGraph(entryPoints) {
  const edges = new Map()
  const external = new Map()
  let error = null
  let metafile = null
  try {
    const res = await esbuild.build({
      absWorkingDir: root,
      entryPoints,
      bundle: true,
      write: false,
      // 多个入口必须给 outdir（write:false 之下不会真写出文件）。
      outdir: 'tmp-module-graph',
      metafile: true,
      format: 'esm',
      platform: 'neutral',
      // 这些依赖在测试里不当场解析：它们要作为「外部」出现在图里，判据才有话说。
      external: ['react', 'react-dom', 'node:*'],
      logLevel: 'silent',
    })
    metafile = res.metafile
  } catch (e) {
    error = e?.message ?? String(e)
    return { edges, external, error }
  }
  for (const [input, info] of Object.entries(metafile?.inputs ?? {})) {
    const inside = []
    const outside = []
    for (const imp of info.imports ?? []) {
      if (imp.external) {
        // 外部边：path 就是裸包名（'react' / 'node:fs'）。
        outside.push(imp.path)
      } else {
        inside.push(path.normalize(imp.path).replace(/\\/g, '/'))
      }
    }
    const key = path.normalize(input).replace(/\\/g, '/')
    edges.set(key, inside)
    external.set(key, outside)
  }
  return { edges, external, error }
}

/** 从 from 出发沿 edges 能走到的全部模块（含 from 自己）。 */
export function reachable(from, edges) {
  const seen = new Set()
  const stack = [from]
  while (stack.length) {
    const cur = stack.pop()
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const next of edges.get(cur) ?? []) stack.push(next)
  }
  return seen
}
