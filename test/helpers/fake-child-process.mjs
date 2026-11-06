/**
 * 测试接缝：把 `src/host/**` 拷进临时目录，把 `node:child_process` 换成 recorder，
 * 再 import 目标模块 —— 于是「宿主到底往命令行里塞了什么」变成**能跑出来看的东西**，
 * 而不是对源码做正则。
 *
 * 为什么需要它（docs/architecture-modernization.md §8.34 批次 1）：
 *   `test/local-tts.test.mjs` 里 59 条断言是源码文本判据，长这样：
 *     check('say 直接写 WAV', localSrc.includes("'--file-format=WAVE'"))
 *     check('路径里的单引号被转义成两个', /replace\(\/'\/g, "''"\)/.test(localSrc))
 *   它们钉的是**写法**：把 `'--file-format=WAVE'` 改成 `"--file-format=WAVE"`（行为一个字没变）它会红；
 *   而真把 `--data-format` 拼错成 `LEI16@44100`，只要源码里那串还在，它照样绿。
 *   换成这个接缝之后：假 say 收到什么 argv 就比什么，PowerShell 拿到哪个脚本就读那个脚本，
 *   「写 WAV」变成**返回的字节是不是 RIFF/WAVE**，转义变成「脚本里那行单引号串展开后是不是原路径」。
 *
 * 用法：
 *   const env = await loadHostModuleWithFakeCp('local-tts', { platform: 'darwin', vendor })
 *   const r = await env.mod.synthesizeLocal({ text: '你好' })
 *   env.calls  // [{ cmd, args, opts }]
 *   env.restore()  // 拷出去的临时目录清掉；platform 覆写还原
 *
 * 三条实现上的注意（都是踩过的）：
 *   1. **整树拷贝，且照抄 `src/` 那一层的形状**：`tts-env.js` 会 `import './local-tts.js'`、
 *      `'./edge-tts.js'`，还会 `import '../shared/tts-env-reasons.js'`（批次 22-3-2 的码表）。
 *      只拷一个文件、或者只拷 `src/host` 一层，相对 import 都会直接炸。
 *      树由 `helpers/host-copy.mjs` 的 `copyHostTree` 建（`<base>/host/**` + 同级 `<base>/shared/**`），
 *      本文件不再自己拷一遍 —— 拷贝口径只有一份。
 *      1.3MB 的 src/host 拷一次几十毫秒，比造模块图解析器便宜。
 *   2. **`promisify(execFile)` 的返回形状**：真 execFile 带 `util.promisify.custom`，
 *      resolve 出的是 `{ stdout, stderr }`。假的那边必须**同样**给 `{stdout, stderr}`，
 *      否则调用点 `const { stdout } = await run(…)` 解构到 undefined，测出来的是假接缝的 bug。
 *      这里由替身模块的包装函数自带 `[promisify.custom]`，形状只在那一处定义。
 *   3. **platform 是模块级常量**（`const PLATFORM = process.platform`），所以覆写必须在
 *      import **之前**发生、import 之后立刻还原 —— 晚还原会影响同一进程里其它测试。
 */
import fs from 'node:fs'
import path from 'node:path'
import { copyHostTree, importFromTree, removeHostTree } from './host-copy.mjs'

/**
 * 假的 `execFile`：记下调用，再按 `respond` 的决定回话。
 *
 * @param {Array<object>} calls - 记录数组（外部持有，断言就读它）。
 * @param {(call: object) => object} [respond] - 每次调用的应答策略。
 * @returns {{execFile: Function}} 可以 spread 进 `node:child_process` 替换模块的成员。
 */
function makeFakeChildProcess(calls, respond) {
  const execFile = (cmd, args, opts, cb) => {
    const options = typeof opts === 'function' ? {} : (opts ?? {})
    const callback = typeof opts === 'function' ? opts : cb
    const call = { cmd, args: args ?? [], opts: options }
    calls.push(call)
    let decided = {}
    try {
      decided = respond ? (respond(call, calls.length - 1) ?? {}) : {}
    } catch (error) {
      // 应答策略自己抛错 = 测试写错了，直接响着错误的名字炸出来，别假装是子进程的错。
      callback?.(new Error(`fake execFile 的 respond 抛错：${error?.message ?? error}`))
      return
    }
    if (decided.error) {
      const error = decided.error instanceof Error
        ? decided.error
        : Object.assign(new Error(decided.error.message ?? 'fake command failed'), decided.error)
      // 真 execFile 的错误上带 stdout/stderr；调用点偶尔会读，给齐。
      error.stdout = decided.stdout ?? ''
      error.stderr = decided.stderr ?? ''
      setImmediate(() => callback?.(error))
      return
    }
    const result = { stdout: decided.stdout ?? '', stderr: decided.stderr ?? '' }
    if (decided.delayMs) {
      setTimeout(() => callback?.(null, result), decided.delayMs)
    } else {
      setImmediate(() => callback?.(null, result))
    }
  }
  // 说明：这里**不**给 execFile 挂 promisify.custom。真挂的是替身模块里
  // 那个被 import 出去的包装函数（见 fakeModuleSource），它才是 `promisify(execFile)` 的对象。
  return { execFile }
}

/**
 * 拷出去的 `node:child_process` 替身模块的源码。
 *
 * 两条路都要给齐，因为 `promisify` 只看被 import 出来的那个函数：
 *   - 挂了 `[promisify.custom]` → 由它决定 resolve 的形状；
 *   - 没挂的调用点（直接 `execFile(..., cb)`）→ 走回调。
 * 统一形状 `{stdout, stderr}`，与真 execFile 一致 —— 调用点写的是
 * `const { stdout } = await run(…)`，形状不对的话测到的是替身的 bug。
 *
 * @param {string} globalKey - 挂在 globalThis 上的键名，测试与替身模块靠它对接。
 * @returns {string} 模块源码。
 */
function fakeModuleSource(globalKey) {
  return `const holder = globalThis[${JSON.stringify(globalKey)}]
export const execFile = (cmd, args, opts, cb) => {
  const callback = typeof opts === 'function' ? opts : cb
  holder.execFile(cmd, args, typeof opts === 'function' ? {} : opts, callback)
}
execFile[Symbol.for('nodejs.util.promisify.custom')] = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    holder.execFile(cmd, args, opts ?? {}, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
export const spawn = (cmd, args, opts) => {
  holder.execFile(cmd, args, opts ?? {}, () => {})
  return { on() {}, kill() {}, stdout: { on() {} }, stderr: { on() {} } }
}
export default { execFile, spawn }
`
}

/**
 * 装载宿主模块，`node:child_process` 全部走假实现。
 *
 * @param {string} name - 模块名（不含扩展名），如 'local-tts' / 'tts-env'。
 * @param {object} [options] - 选项。
 * @param {string} [options.platform] - 假装的平台（覆写 process.platform，import 后立刻还原）。
 * @param {(call: object, index: number) => object} [options.vendor] - 每次子进程调用的应答。
 *   返回 `{ stdout?, stderr?, error?: {message, code?} }`；也可以直接在里面对真实临时文件做读写
 *   （真的 say/espeak 就是这么留下音频文件的，假的一样留，于是「返回的字节是不是 WAV」可测）。
 * @param {(code: string) => string} [options.tune] - 对拷出去的源码再做一次改写（少数场景要拆掉兜底）。
 * @param {boolean} [options.platformHold] - **import 之后不立刻还原** process.platform，
 *   留给 `restore()` 还原。给 `tts-env` 这类「调用时才看平台」（`detectLocalEngine()` 里
 *   读的是 `process.platform`，不是模块级常量）的模块用：不加这个，装完模块平台就被改回去了，
 *   跑出来的全是当前机器（win32）那一条分支，macOS/Linux 的判据全都在断Windows。
 *   用了它就要保证**每条路径都调 `restore()`**，否则平台覆写会泄漏给同进程里的其它测试。
 * @returns {Promise<{mod: object, calls: Array<object>, dir: string, restore: () => void}>}
 */
export async function loadHostModuleWithFakeCp(name, { platform = null, vendor = null, tune = null, platformHold = false } = {}) {
  const seq = (globalThis.__dshFakeCpSeq = (globalThis.__dshFakeCpSeq ?? 0) + 1)
  const globalKey = `__dshFakeCp${seq}`
  const calls = []
  const holder = { execFile: makeFakeChildProcess(calls, vendor).execFile, calls }
  globalThis[globalKey] = holder

  // 树交给 `copyHostTree` 建：它已经定好了口径 —— 临时树照抄 `src/` 那一层的形状
  // （`<base>/host/**` + 同级 `<base>/shared/**`），宿主模块里那些 `import '../shared/xxx.js'`
  // （批次 22-3-2 给 `tts-env.js` 加的码表 import 就是这一类）才解得开。
  // 早先这里自己拷了一遍**扁平**的 `src/host/*`，那种形状下 `../shared` 会跑到仓库根上，
  // 只因为当时还没有宿主模块 import shared 才没炸；两处拷贝逻辑合成一处，形状只有一份。
  // 临时树放在仓库根下的 `.tmp*`（不是 `os.tmpdir()`）：宿主代码有真裸依赖（`edge-tts.js`
  // import `'msedge-tts'`），放外面往上找不到 `node_modules`，装载就报 ERR_MODULE_NOT_FOUND。
  // 完整理由与依赖防火墙都写在 helpers/host-copy.mjs 的头部（两处必须是同一个口径）。
  const tree = copyHostTree(name, {
    transform: (code) => {
      let next = code
      if (next.includes("from 'node:child_process'")) {
        next = next.replace(/from 'node:child_process'/g, `from './__fake-cp-${seq}.mjs'`)
        next = next.replace(/import \{ execFile \} from/g, 'import { execFile } from')
      }
      return tune ? tune(next) : next
    },
  })
  fs.writeFileSync(path.join(tree.hostDir, `__fake-cp-${seq}.mjs`), fakeModuleSource(globalKey), 'utf8')

  const previousPlatform = process.platform
  if (platform && platform !== previousPlatform) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }
  try {
    const mod = await importFromTree(tree)
    return {
      mod,
      calls,
      /** 临时树的根（`<base>`）：里面有 `host/` 与 `shared/` 两块。 */
      dir: tree.dir,
      /** 宿主模块那一层（`<base>/host`）—— 要在临时树里读某个文件的产物就用它。 */
      hostDir: tree.hostDir,
      restore() {
        if (platform && platform !== previousPlatform) {
          Object.defineProperty(process, 'platform', { value: previousPlatform, configurable: true })
        }
        delete globalThis[globalKey]
        removeHostTree(tree.dir)
      },
    }
  } finally {
    // PLATFORM 在模块加载时就被捕成常量了，这里必须还原，晚一毫秒都可能影响同进程里的其它测试。
    // 例外：platformHold —— 这个模块是**调用时**才读 process.platform 的，还原要交给 restore()。
    if (!platformHold && platform && platform !== previousPlatform) {
      Object.defineProperty(process, 'platform', { value: previousPlatform, configurable: true })
    }
  }
}

/**
 * 一个能过 `decodeAudioData` 的最小合法 WAV（1 个采样点，静音）。
 * 假 vendor 用它证明自己写出来的东西确实是 WAV 容器。
 * @param {number} [samples] - 采样数。
 * @returns {Buffer} WAV 字节。
 */
export function fakeWavBytes(samples = 8) {
  const data = Buffer.alloc(samples * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(22050, 24)
  header.writeUInt32LE(44100, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** AIFF 的四个字节头标识（`FORM…AIFC`/`AIFF`）——用来断言最终产物**不是** AIFF。 */
export function fakeAiffBytes(samples = 8) {
  const body = Buffer.alloc(8 + samples * 2)
  body.write('FORM', 0)
  body.write('AIFF', 12)
  return body
}
