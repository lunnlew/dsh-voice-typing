/**
 * 浏览器侧构建：src/client/main.js → lib/client.js（单文件产物）。
 *
 * 入口就是一个真 ESM 模块：`main.js` 顶层 import 它要用的那些模块，并导出
 * `buildClientModule(require)`。本脚本只做两件事：
 *   1. 让 esbuild 沿 import 图把 src/client/ 打成一段 CJS；
 *   2. 套回宿主要的形态：`window.__ModuleLoader__.load({ id, factory: (require) => … })`。
 *
 * 历史包袱（2026-11-03 摘掉）：源码里曾有 25 个 `@bundle` 路径标记，由本脚本翻译成
 * import。那是「用正则做文本内联」时代留下的入口清单；换成真打包器之后，入口清单
 * 本来就归 import 图管，标记只剩一个副作用 —— 逼着 main.js 保持「factory 体缩进 4 空格」
 * 的畸形形状，好让本脚本用锚点把它挖出来重排。现在两样都没了。
 * 代价是**孤儿文件的防线要另找**：过去「漏写标记」= 文件不进产物，现在「没人 import」
 * = 文件不进产物，同一个洞。这条职责移交给 test/bundle-sync.test.mjs：拿 esbuild
 * metafile 的 inputs 清单，要求 src/client/{pure,dom} 下每个文件都真的被打包进来。
 *
 * 产物形态（宿主契约，一个字都不能改）：
 *   window.__ModuleLoader__.load({
 *     id: 'dsh-voice-typing',
 *     factory: (require) => { …; return module.exports.buildClientModule(require) },
 *   })
 * require 只允许出现 'react'（宿主静态模块表提供，见 docs/architecture-modernization.md §2 H4）。
 *
 * 用法：
 *   node scripts/build-client.mjs            # 生成 lib/client.js
 *   node scripts/build-client.mjs --check    # 只校验产物是否最新（CI 用，不写盘）
 * 也可以被 import：renderClient() 只计算不写盘（测试用它，避免写副作用）。
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
const sourceRel = 'src/client/main.js'
const target = path.join(root, 'lib', 'client.js')
/**
 * `module` 这个名字由包装层的 factory 作用域提供，不能塞进 esbuild 的 banner：
 * CJS 产物会生成 `module.exports = __toCommonJS(…)`，另外还会留一行
 * `0 && (module.exports = { … })` 的死代码 —— 两者都要求 `module` 和 factory
 * 的返回值在同一个作用域里，否则产物拿到的是另一个对象。
 */
const MODULE_DECL = '    const module = { exports: {} }'
/**
 * bundle 段只**定义** buildClientModule，真正调用它的是包装层：
 * React 只能从宿主传进 factory 的那个 require 拿。
 */
const FACTORY_CALL = '    return module.exports.buildClientModule(require)'

/** 把 esbuild 的错误摊成一行消息（带文件和行号）。 */
function describeErrors(errors) {
  return (errors ?? []).map((e) => `${e.text}（${e.location?.file ?? '?'}:${e.location?.line ?? '?'}）`).join('\n')
}

/**
 * 计算产物内容（不写盘）。测试用：可以校验「产物与源一致 + 计算幂等」而不产生写副作用。
 * @returns {{ content: string, used: string[] }} used = 真的被打包进来的 src/client 模块
 *   （相对 src/client/ 的路径，不含入口自身），供「每个文件都得进产物」那条守卫用。
 */
export async function renderClient() {
  let res
  try {
    res = await esbuild.build({
      entryPoints: [sourceRel],
      absWorkingDir: root,
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'browser',
      target: 'es2020',
      external: ['react'],
      legalComments: 'none',
      metafile: true,
      // 别把中文转义成 \uXXXX：测试与面板都按字面文案匹配产物。
      charset: 'utf8',
    })
  } catch (error) {
    const list = error?.errors?.length ? error.errors : [{ text: String(error?.message ?? error) }]
    throw new Error(describeErrors(list))
  }
  if (res.errors.length) throw new Error(describeErrors(res.errors))
  const raw = res.outputFiles[0].text

  const used = Object.keys(res.metafile?.inputs ?? {})
    .filter((k) => k.startsWith('src/client/') && k !== sourceRel)
    .map((k) => k.slice('src/client/'.length))
    .sort()
  if (!used.length) {
    throw new Error('入口的 import 图里没有任何 src/client 模块 —— 产物基本是空的')
  }

  assertHostShape(raw)

  // `module` 由包装层的 factory 作用域提供，esbuild 生成的
  // `module.exports = __toCommonJS(…)` 直接落在它上面。
  const indented = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.length ? '    ' + l : l))
    .join('\n')
  const content =
    `/* 构建产物，勿手改：由 scripts/build-client.mjs 从 src/client/ 生成。\n` +
    `   浏览器模块的 require 只认包名，所以源码在这里合成单文件；改 src/client/ 后要重新构建。 */\n` +
    `window.__ModuleLoader__.load({\n` +
    `  id: 'dsh-voice-typing',\n` +
    `  factory: (require) => {\n` +
    MODULE_DECL + '\n' +
    indented + '\n' +
    FACTORY_CALL + '\n' +
    `  },\n` +
    `})\n`
  return { content, used }
}

/**
 * esbuild 会把入口函数的形参 `require` 改名成 `require2`（产物顶层它自己占用了
 * `require` 这个名字）。只匹配 `require(` 的话这条守卫会一条都不命中，
 * 变成一颗「宿主解析不了的 require」永远查不出来的假绿灯 —— 所以数字后缀要一起吃下。
 * 这里只**禁非 react**，不要求「必须有 react」：本脚本也要对最小工程跑通
 * （见 test/atomic-file.test.mjs 的临时工程），那条正向断言住在 test/bundle-sync.test.mjs。
 */
const HOST_REQUIRE = /\brequire\d*\(\s*["']([^"']+)["']\s*\)/g

/** 列出产物里所有 require 的模块名（去重）。 */
function requiredIds(text) {
  return [...new Set([...text.matchAll(HOST_REQUIRE)].map((m) => m[1]))]
}

/**
 * 产物形态守卫：宿主契约里不能出现的东西，构建时就拦下，别留给运行时。
 */
function assertHostShape(raw) {
  const requires = requiredIds(raw)
  const bad = requires.filter((r) => r !== 'react')
  if (bad.length) {
    throw new Error(`产物里出现了宿主解析不了的 require：${bad.join(', ')}（只允许 'react'）`)
  }
  if (/^import[\s{]/m.test(raw)) throw new Error('产物里残留 ESM import 语句')
  if (/^export[\s{]/m.test(raw)) throw new Error('产物里残留 ESM export 语句')
  if (!/\bfunction buildClientModule\b/.test(raw)) {
    throw new Error('产物里没有 function buildClientModule —— 入口的导出形状变了，包装层那一句会调空')
  }
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
    const { content, used } = await renderClient()
    if (process.argv.includes('--check')) {
      let current = ''
      try {
        current = fs.readFileSync(target, 'utf8')
      } catch {
        /* 产物还不存在 */
      }
      if (content !== current) {
        console.error('✗ lib/client.js 与 src/client/ 不同步 —— 跑 npm run build:client')
        process.exit(1)
      }
      console.log('✓ lib/client.js 已是最新')
      process.exit(0)
    }
    await writeFileAtomic(target, content, { encoding: 'utf8' })
    console.log(`✓ 已生成 lib/client.js（esbuild 沿 import 图合并 ${used.length} 个源文件）`)
    console.log(`  ${used.join(', ')}`)
    // 字节口径，理由同 build-host：`content.length` 数的是字符，中文注释按 UTF-8 占 3 字节。
    console.log(`  ${content.split('\n').length} 行 / ${(Buffer.byteLength(content, 'utf8') / 1024).toFixed(0)} KiB`)
  } catch (error) {
    // 构建失败要**出声**并留非 0 退出码（CI 的 check:client / 测试都靠这个信号），
    // 但不要甩一屏堆栈：错误消息本身已经说清了是哪个文件、哪一步。
    console.error('✗ 浏览器侧构建失败：' + (error?.message ?? error))
    process.exit(1)
  }
}
