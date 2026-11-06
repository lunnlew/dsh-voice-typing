/**
 * 测试接缝：把宿主模块里的 `node:fs` / `node:fs/promises` 换成一层**记录 + 可注入失败**的包装，
 * 于是「这段代码到底是怎么落盘的」变成能**跑出来看**的事，而不是去源码里正则找关键字。
 *
 * 为什么需要它（docs/architecture-modernization.md §8.34 批次 2c）：
 *   `test/atomic-file.test.mjs` 里有十五条判据长这样：
 *     check('合并写到 .merge 临时文件', /const mergePath = `\$\{dest\}\.merge`/.test(cat))
 *     check('index.js 用的是 writeFileAtomic', /await writeFileAtomic\(path, JSON\.stringify\(next/.test(idx))
 *     check('重试有退避间隔', /setTimeout\(resolve, 200 \* i\)/.test(atomic))
 *   它们钉的全是**写法**：把 `200 * i` 改成 `200`、把 `.merge` 抽成一个变量、
 *   把 `writeFileAtomic(...)` 换成同样原子的别的实现 —— 断言就红了，而产品行为一点没变。
 *   反过来，「rename 遇到 Windows 锁到底重试几次」「写一半失败时旧配置还在不在」
 *   这些**真正要防的事**它一条都判不了。
 *
 *   有了这层包装，同一个问题换成这样问：
 *     - rename 被调用了几次、分别在什么时候（→ 退避是否真等了、非瞬时错误是否只试一次）
 *     - 每一次 writeFile / createWriteStream 的目标路径是什么（→ 最终路径有没有被直接写过）
 *     - 让 writeFile 在第 N 次抛错（→ 最终路径上的旧内容是不是完好、目录里有没有留垃圾）
 *
 * 实现上的四个要点：
 *   1. **包装的是 import 来源，不是全局对象**：Node 的 ESM 里 `node:fs` 没法在运行时替换，
 *      所以走 `copyHostTree` 那条老路 —— 把临时树里每个 `.js` 的
 *      `from 'node:fs/promises'` 改写成 `from './__fake-fs-promises.mjs'`，
 *      包装文件里「本地显式导出的名字」覆盖 `export *` 的同名重导出（Node 认可这种写法，
 *      已在 v24 上实测），没列出来的名字原样透传，测试跑的还是真实现。
 *   2. **包装函数必须是同步的**：`createWriteStream(p)` 的返回值是拿来立刻 `.on('error')` 的，
 *      写成 `async` 就变成 Promise，生产代码会在流上找不到方法而炸。
 *      fs/promises 那边返回的是 Promise，调用方照旧 `await`，语义不变。
 *   3. **holder 靠 id 挂在 globalThis 上，包装文件按 id 取**：一次可以并存多棵树
 *      （atomic-file 一棵、model-catalog 一棵、index 路由一棵），各数各的调用，互不污染。
 *      holder 是**调用时**取的，所以测试中途换 `overrides` 立刻生效，不用重装。
 *   4. **改写自检沿用 `requireRewrite`**：改写了个空 = 测试在偷偷跑真 fs 却报告「通过」，
 *      批次 1 就是靠这条抓到一个静默失效的改写，这里同样留闸。
 *
 * 用法：
 *   const fake = makeFsFake({ label: 'merge' })
 *   const tree = copyHostTree('model-catalog', { transform: fake.transform, requireRewrite: fake.requireRewrite })
 *   writeFsWrappers(tree, fake)          // 包装文件写进临时树（必须在 import 之前）
 *   const mod = await importFromTree(tree)
 *   fake.overrides.rename = ...          // 注入失败（调用时才读，随时可换）
 *   fake.calls                           // [{op, path, args, at, seq}]
 *   fake.dispose()
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'

/** 要换掉的模块说明符 → 包装文件名 + 需要记录/可注入的名字。 */
const TARGETS = [
  {
    specifier: 'node:fs/promises',
    file: '__fake-fs-promises.mjs',
    names: ['mkdir', 'rename', 'rm', 'writeFile', 'readFile', 'stat', 'unlink', 'appendFile'],
    hasDefault: false,
  },
  {
    // `node:fs`（同步 + 流）：合并分片走的是 createWriteStream，
    // 「合并到底往哪个路径写字节」只有在这里才看得见。
    // 只包这两个：同步函数（existsSync/statSync 等）返回值会被 await 语义搞乱，
    // 需要它们判据的时候再单独想办法。
    specifier: 'node:fs',
    file: '__fake-fs.mjs',
    names: ['createReadStream', 'createWriteStream'],
    hasDefault: true,
  },
]

let seq = 0

/**
 * 生成一份包装模块的源码。
 * @param {{specifier: string, file: string, names: string[], hasDefault: boolean}} target - 目标模块。
 * @param {string} id - holder 在 globalThis 上的键。
 * @returns {string} 文件内容。
 */
function wrapperSource(target, id) {
  return [
    '/* 由 test/helpers/fake-fs.mjs 生成的接缝文件（只存在于临时目录里，不进仓库）。 */',
    `import * as real from '${target.specifier}'`,
    '',
    `const holder = () => globalThis.__dshFakeFs?.[${JSON.stringify(id)}]`,
    'const summarize = (v) => {',
    "  if (typeof v === 'string') return v",
    "  if (v && typeof v === 'object' && typeof v.byteLength === 'number') return `<buffer ${v.byteLength}>`",
    "  if (typeof v === 'function') return '[fn]'",
    '  if (v === undefined) return undefined',
    "  if (typeof v === 'object' && v !== null) return JSON.stringify(v)",
    '  return v',
    '}',
    // 同步包装：返回值必须原样、即时交给调用方（见文件头要点 2）。
    'const wrap = (name) => (...args) => {',
    '  const h = holder()',
    `  if (!h) throw new Error('fake-fs：holder 没装上（id=${id}）')`,
    "  const call = { op: name, path: typeof args[0] === 'string' ? args[0] : null,",
    '    args: args.map(summarize), at: Date.now(), seq: h.calls.length + 1 }',
    '  h.calls.push(call)',
    '  const override = h.overrides[name]',
    '  if (override) return override(args, real, call)',
    '  return real[name](...args)',
    '}',
    '',
    // 显式导出覆盖 `export *` 的同名重导出；没列出来的名字照旧透传真实现。
    `export * from '${target.specifier}'`,
    `export const { ${target.names.join(', ')} } =`,
    `  Object.fromEntries(${JSON.stringify(target.names)}.map((n) => [n, wrap(n)]))`,
    ...(target.hasDefault ? ['export default real'] : []),
    '',
  ].join('\n')
}

/**
 * 装一个 fs 接缝。
 *
 * @param {object} [options] - 选项。
 * @param {Record<string, (args: unknown[], real: object, call: object) => unknown>} [options.overrides]
 *   - 按操作名注入实现（`(args, real, call) => ...`）。不给就走真 fs，只是被记录了。
 * @param {string} [options.label] - 报错里用的名字；同时保证多棵树各用各的 holder。
 * @returns {object} 接缝句柄：{id, calls, overrides, transform, wrappers, requireRewrite,
 *   of, reset, dispose, tmpNames}。
 */
export function makeFsFake({ overrides = {}, label = 'fs' } = {}) {
  seq += 1
  const id = `dsh-fake-fs-${label}-${seq}`
  const calls = []
  globalThis.__dshFakeFs = globalThis.__dshFakeFs ?? {}
  globalThis.__dshFakeFs[id] = { calls, overrides }

  // 改写 + 自检清单：改写了个空就等于测试在跑真 fs，必须出声。
  const requireRewrite = []
  const wrappers = {}
  for (const target of TARGETS) {
    requireRewrite.push([
      `${target.specifier} 走接缝（${label}）`,
      `from '${target.specifier}'`,
      `from './${target.file}'`,
    ])
    wrappers[target.file] = wrapperSource(target, id)
  }

  /** copyHostTree / loadHostRoutes 用的 transform。 */
  const transform = (code) => {
    let out = code
    for (const target of TARGETS) {
      out = out.replaceAll(`from '${target.specifier}'`, `from './${target.file}'`)
      out = out.replaceAll(`from "${target.specifier}"`, `from "./${target.file}"`)
    }
    return out
  }

  return {
    id,
    calls,
    overrides,
    transform,
    wrappers,
    requireRewrite,
    /**
     * 按操作名取记录（可选按路径过滤）。
     * @param {string} op - 操作名，如 'rename'。
     * @param {object} [filter] - { pathEq, pathEndsWith, argIndex }：
     *   pathEq / pathEndsWith 比对 `args[argIndex]`（默认第 0 个参数）。
     * @returns {object[]} 命中的调用。
     */
    of(op, filter = {}) {
      const idx = filter.argIndex ?? 0
      return calls.filter((c) => {
        if (c.op !== op) return false
        const target = c.args[idx]
        if (typeof target !== 'string') return false
        if (filter.pathEq !== undefined && target !== filter.pathEq) return false
        if (filter.pathEndsWith !== undefined && !target.endsWith(filter.pathEndsWith)) return false
        return true
      })
    },
    /** 命中路径的列表（报告里当 detail 用）。 */
    paths(op, filter = {}) { return this.of(op, filter).map((c) => c.args[filter.argIndex ?? 0]) },
    /** 清空记录（装好模块之后再跑用例，避免把装载期的调用混进来）。 */
    reset() { calls.length = 0 },
    dispose() { delete globalThis.__dshFakeFs[id] },
  }
}

/**
 * 把包装文件写进临时树的 host 目录（必须在 import 之前调用）。
 * @param {{hostDir: string}} tree - `copyHostTree` 的返回值。
 * @param {{wrappers: Record<string, string>}} fake - `makeFsFake` 的返回值。
 */
export function writeFsWrappers(tree, fake) {
  for (const [name, content] of Object.entries(fake.wrappers)) {
    // 用**真** fs 写：接缝不能套自己。
    writeFileSync(path.join(tree.hostDir, name), content, 'utf8')
  }
}

/**
 * 一步到位：拷树 + 换 fs + 装载。
 *
 * @param {string} name - 要装载的宿主模块名（不含扩展名）。
 * @param {object} [options] - 选项。
 * @param {object} [options.fake] - 已有的 `makeFsFake` 句柄；不给就现场建一个。
 * @param {(code: string, file: string) => string} [options.transform] - 额外的改写（在换 fs 之后跑）。
 * @param {Array<[string, string, string]>} [options.requireRewrite] - 额外的自检清单。
 * @param {string} [options.label] - 建接缝时用的名字。
 * @param {Record<string, Function>} [options.overrides] - 建接缝时的初始注入。
 * @returns {Promise<{mod: object, tree: object, fake: object, remove: Function}>} 装载结果。
 */
export async function loadHostWithFakeFs(name, {
  fake = null,
  transform = null,
  requireRewrite = [],
  label = name,
  overrides = null,
} = {}) {
  // 延迟 require：helper 之间用动态 import，避免谁先被加载都无所谓。
  const { copyHostTree, importFromTree, removeHostTree } = await import('./host-copy.mjs')
  const handle = fake ?? makeFsFake({ label, overrides: overrides ?? {} })
  const tree = copyHostTree(name, {
    transform: (code, file) => {
      let out = handle.transform(code, file)
      if (transform) out = transform(out, file)
      return out
    },
    requireRewrite: [...handle.requireRewrite, ...requireRewrite],
  })
  writeFsWrappers(tree, handle)
  const mod = await importFromTree(tree)
  return { mod, tree, fake: handle, remove: () => removeHostTree(tree.dir) }
}
