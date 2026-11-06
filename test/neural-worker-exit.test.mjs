/**
 * 集成测试：神经合成那条工作线程的两族语义（本文件现在守两件事）。
 *
 * 第一族（批次 6a）：**不能挡住宿主进程退出**。
 *
 * 原来这里只有一条源码文本判据（`test/local-tts.test.mjs`）：
 *   check('neural-tts 里 worker.unref?.() 存在', /worker\.unref\?\.\(\)/.test(neuralSrc))
 * 它钉的是一行字面量：把这行改成 `if (worker.unref) worker.unref()`（行为一模一样）它会红；
 * 而真把那句挪进别的分支（线程再也没 unref 过，插件 dispose 没被调用时宿主永远关不掉）
 * 只要那行字还在原处，它照样绿。
 *
 * 现在改成**真起一个子进程**跑临时树里的 `neural-tts.js`：
 *   - `tts-worker.js` 换成「起来就往盘上写个标记、然后开一个 1 秒定时器永远不退」的替身
 *     （真 worker 要 load 约 170MB 模型，测试不该付这个代价，也不该看本机有没有下过模型）；
 *   - 驱动脚本调完 `preloadNeural()` 之后**不**调 `process.exit()`，只等自己的定时器到点；
 *   - 于是判据变成：主线程没事干了，进程能不能自己退出来。
 * 两条防假绿的判据：「线程确实建起来了」看替身留在盘上的 `worker-started.txt`；
 * 「那次 unref 调用还在不在」看拷进临时树的那份源码。
 * 原来还有一组「故意把 unref 拆掉、看进程是不是退不出来」的反向对照，批次 6c 起
 * 随变异自证一起删了（用户明确不要这类测试）。
 *
 * 运行：node test/neural-worker-exit.test.mjs
 *
 * 批次 21 在本文件里加了第二族（docs §8.63）：**线程活着、就是不回话**。
 * `error` / `exit` 两个事件都会把等待者叫醒，唯独「卡在一次不返回的 native 调用里」没有出口 ——
 * 修前那个 Promise 永远不 settle（驱动里那条 8 秒看门狗钉的就是它：挂死时打不出 RESULT，
 * 只能由看门狗以退出码 7 收场；改前的一次性复现脚本实测 8 秒观察窗口到点仍无结果），
 * 于是 `/tts` 一直 pending，客户端 25 秒放弃后用户看到的是彻底没声音，
 * 连 `stats.neuralTtsFailures` 都不涨。修后：等待有上限、上限早于客户端那句、
 * 到点把卡住的线程拆掉（否则后面每一句都要再等满这个上限）、那条定时器不按住进程。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { copyHostTree } from './helpers/host-copy.mjs'
import { TTS_TIMEOUT_MS } from '../src/client/pure/voice-constants.js'
import { NEURAL_WAIT_TIMEOUT_MS } from '../src/host/neural-tts.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 「这次调用还在不在」的探针：整个文件不能再出现这个标识符。 */
const UNREF_PROBE = 'worker.unref'

/** 替身 tts-worker：留个「我真的起来了」的标记，然后自己永远不退。 */
const FAKE_WORKER = `import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
// 标记由线程自己写：主线程那份驱动不写，于是「线程建起来了」是独立证据。
fs.writeFileSync(fileURLToPath(new URL('./worker-started.txt', import.meta.url)), 'started')
// 永远活着的线程：不给宿主留下任何会自己结束的句柄。
setInterval(() => {}, 1000)
`

/**
 * 驱动脚本：造出线程、等一小会儿让线程把标记落盘，然后**主动什么都不做**。
 * 400ms 的定时器是唯一合法的保持句柄：到点之后主线程就没有事干了 ——
 * 这时进程还能自己退出，只能是那句 unref 起了作用。
 */
const DRIVER = `import { preloadNeural } from './neural-tts.js'
const model = process.argv[2]
// preloadNeural 的回信永远不会来（替身不回话），这里不 await：
// 未定来的 Promise 本身不是事件循环句柄，不会把进程留住。
preloadNeural({ model, lexicon: model, tokens: model }).catch(() => {})
setTimeout(() => { console.log('DONE') }, 400)
`

/**
 * 拷一棵临时树：装上假 worker + 驱动。
 *
 * 这里**不用** `requireRewrite`：它会在「源码写法变了」时直接抛错，把信号变成一个崩溃。
 * 改成把拷贝后的源码读出来当判据（`copied`），于是「替身有没有生效」是一条会红的判据。
 * @returns {{tree: object, driver: string, model: string, hostDir: string, copied: string}} 路径们与拷贝后的源码。
 */
function prepareTree() {
  const tree = copyHostTree('neural-tts')
  const hostDir = tree.hostDir
  fs.writeFileSync(path.join(hostDir, 'tts-worker.js'), FAKE_WORKER, 'utf8')
  fs.writeFileSync(path.join(hostDir, '__driver.mjs'), DRIVER, 'utf8')
  const model = path.join(hostDir, 'model-dummy.onnx')
  // preloadNeural 先 existsSync 再建线程：给个占位文件让它走到建线程那一步。
  fs.writeFileSync(model, 'placeholder', 'utf8')
  return {
    tree,
    driver: path.join(hostDir, '__driver.mjs'),
    model,
    hostDir,
    copied: fs.readFileSync(path.join(hostDir, 'neural-tts.js'), 'utf8'),
  }
}

/**
 * 跑一次子进程，看它能不能自己退出。
 * @param {object} options - { driver, model, hostDir, waitMs }
 * @returns {Promise<{exitedByItself: boolean, code: number|null, signal: string|null, stdout: string, stderr: string, ms: number}>}
 */
function runDriver({ driver, model, hostDir, waitMs }) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [driver, model], {
      cwd: hostDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    const finish = (code, signal, exitedByItself) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ exitedByItself, code, signal, stdout, stderr, ms: Date.now() - started })
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('exit', (code, signal) => finish(code, signal, true))
    child.on('error', (error) => finish(null, `spawn-error: ${error?.message ?? error}`, false))
    timer = setTimeout(() => {
      // 观察窗口到点还没退：这就是「线程把进程钉住了」，替宿主杀掉它并报告「没自己退出」。
      try { child.kill('SIGKILL') } catch { /* 忽略 */ }
      finish(null, 'killed-by-test', false)
    }, waitMs)
  })
}

console.log('\n生产代码（带 unref）：主线程空了就能自己退出')
{
  const prepared = prepareTree()
  const flagFile = path.join(prepared.hostDir, 'worker-started.txt')
  try {
    const r = await runDriver({ ...prepared, waitMs: 10_000 })
    // 只判「这棵树里到底有没有那次 unref 调用」，不判它怎么写：
    // 写成 `if (worker.unref) worker.unref()` 一样算数：判的是有没有这次调用，不是哪一行字面量。
    check('临时拷贝里确实有那次 unref 调用（正向测的就是生产行为）',
      prepared.copied.includes(UNREF_PROBE), JSON.stringify(
        prepared.copied.split('\n').filter((l) => l.includes('unref'))))
    check('驱动跑到了「主线程没事干」那一步（DONE 打出来了）',
      r.stdout.includes('DONE'), JSON.stringify({ out: r.stdout, err: r.stderr }))
    check('工作线程确实建起来了（替身留下了标记）',
      fs.existsSync(flagFile), flagFile)
    check('没调 process.exit，进程是自己退出的（不是被测试杀掉）',
      r.exitedByItself === true && r.signal === null,
      JSON.stringify({ code: r.code, signal: r.signal, ms: r.ms, err: r.stderr }))
    check('退出码 0（线程没把宿主拖成非零退出）', r.code === 0, String(r.code))
    check('退得够快（400ms 定时器到点就走，没用满观察窗口）',
      r.ms < 8000, `${r.ms}ms`)
  } finally {
    fs.rmSync(prepared.tree.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

console.log('\n线程活着、这次合成永不回话：等待者要有回执，卡住的线程要换掉（批次 21）')
{
  // 替身线程：每次启动往文件追加一行（于是「起了几个线程」是线程那一侧留下的证据），
  // 收到消息也不回话 —— 模拟卡在一次不返回的 native 合成里。
  const STUCK_WORKER = `import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parentPort, threadId } from 'node:worker_threads'
fs.appendFileSync(fileURLToPath(new URL('./worker-starts.txt', import.meta.url)), 'started ' + threadId + '\\n')
parentPort.on('message', () => { /* 就是不回话 */ })
setInterval(() => {}, 1000)
`

  // 主线程这一侧的 Worker 替身：把每个线程的 exit / error 记下来。
  // 「卡住的那条被拆掉了」只能从主线程这一侧看 —— 线程被 terminate 时自己来不及留痕迹。
  const TRACKED_WORKER = `import { Worker as RealWorker } from 'node:worker_threads'
const log = (globalThis.__dshTtsWorkerLog ??= [])
export class Worker extends RealWorker {
  constructor(...args) {
    super(...args)
    const entry = { exits: [], errors: [] }
    log.push(entry)
    this.on('exit', (code) => { entry.exits.push(code) })
    this.on('error', (e) => { entry.errors.push(String((e && e.message) || e)) })
  }
}
`

  const DRIVER = `import { synthesizeNeural } from './neural-tts.js'
const model = process.argv[2]
const log = (globalThis.__dshTtsWorkerLog ??= [])
// 把 setTimeout 包一层：这条等待登记在多少毫秒上、它有没有按住进程。
const realSetTimeout = globalThis.setTimeout
const timers = []
globalThis.setTimeout = (fn, ms, ...rest) => {
  const handle = realSetTimeout(fn, ms, ...rest)
  if (handle && typeof handle.hasRef === 'function' && ms >= 100) {
    const entry = { ms, hasRef: null }
    timers.push(entry)
    // 读数为什么要在 queueMicrotask 里取，而不是拿到 handle 就读、也不是末尾再读：
    // setTimeout 刚返回那一刻任何定时器都是 ref 着的（unref 是调用方紧接着做的一步），
    // 立刻读等于没读；而等它烧完再读也不行 —— 实测「已经到点的定时器 hasRef() 报回 true」，
    // 这条上限偏偏就是会自己到点的那一条。setImmediate 也不行：旧线程的 exit 落在
    // poll 阶段，能把整段驱动带到打印，immediate 还没轮到（实测读出 null）。
    // queueMicrotask 落在「这一步同步执行完」的那一刻：unref 已经做完，定时器不可能已经烧过。
    queueMicrotask(() => { entry.hasRef = handle.hasRef() })
  }
  return handle
}
const call = () => synthesizeNeural({ text: '这一句永远合成不完', paths: { model, lexicon: model, tokens: model } })
  .then(() => 'resolved', (e) => 'rejected:' + String((e && e.message) || e))
let first = null
let second = null
// 驱动自己的看门狗：一条**按住进程**的定时器。为什么需要它 ——
// 修后那条等待定时器是 unref 的（那正是下面一条判据），线程也被 unref 过，
// 主线程 await 期间一个 ref 句柄都没有；Node 于是会在「顶层 await 永不 settle」时
// 直接以退出码 13 结束进程，测试拿不到任何回执（第一版就是这么翻车的）。
// 给它 8 秒：两次等待各 1500ms，正常应在 3 秒内走完；真触发就代表「还挂着」，
// 于是「修前那种永不回话」留在 stdout 与退出码 7 上，而不是伪装成一次崩溃。
const keepAlive = realSetTimeout(() => {
  console.log('WATCHDOG-FIRED 8 秒内两次等待都没有 settle：还是挂着')
  process.exit(7)
}, 8000)
// 反证用的参照：一条真按住进程的定时器（5 秒，比两次等待都长），
// 与上面两条上限定时器在同一时刻（queueMicrotask）读数 ——
// 于是「hasRef=false」不是恒 false，而是那次 unref 换来的。
const proof = realSetTimeout(() => {}, 5000)
let proofRef = null
queueMicrotask(() => { proofRef = proof.hasRef() })
first = await call()
const tFirst = Date.now()
second = await call()
globalThis.clearTimeout(keepAlive)
globalThis.clearTimeout(proof)
console.log('RESULT=' + JSON.stringify({
  first, second, timers, proofRef, gap: Date.now() - tFirst,
  workers: log.map((w) => ({ exits: w.exits, errors: w.errors })),
}))
`

  const tree = copyHostTree('neural-tts', {
    transform: (code, file) => {
      if (file !== 'neural-tts.js') return code
      return code
        .replace("import { Worker } from 'node:worker_threads'", "import { Worker } from './tracked-worker.mjs'")
        .replace('export const NEURAL_WAIT_TIMEOUT_MS = 20000', 'export const NEURAL_WAIT_TIMEOUT_MS = 1500')
    },
    requireRewrite: [
      ['Worker 换成带记录的替身', "import { Worker } from 'node:worker_threads'", "import { Worker } from './tracked-worker.mjs'"],
      ['等待上限改小（不然这条判据要真等满 20 秒）',
        'export const NEURAL_WAIT_TIMEOUT_MS = 20000', 'export const NEURAL_WAIT_TIMEOUT_MS = 1500'],
    ],
  })
  const hostDir = tree.hostDir
  fs.writeFileSync(path.join(hostDir, 'tts-worker.js'), STUCK_WORKER, 'utf8')
  fs.writeFileSync(path.join(hostDir, 'tracked-worker.mjs'), TRACKED_WORKER, 'utf8')
  fs.writeFileSync(path.join(hostDir, '__stuck-driver.mjs'), DRIVER, 'utf8')
  const model = path.join(hostDir, 'model-dummy.onnx')
  fs.writeFileSync(model, 'placeholder', 'utf8')
  const startsFile = path.join(hostDir, 'worker-starts.txt')
  try {
    const r = await runDriver({
      driver: path.join(hostDir, '__stuck-driver.mjs'), model, hostDir, waitMs: 20_000,
    })
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT='))
    const out = line ? JSON.parse(line.slice('RESULT='.length)) : null
    check('[卡住] 驱动跑完了两次等待并打出结果（不是被测试杀掉的）',
      r.exitedByItself === true && !!out, JSON.stringify({ signal: r.signal, out: r.stdout, err: r.stderr.slice(0, 300) }))
    check('[卡住] 看门狗没触发（8 秒内两次等待都自己 settle 了；触发 = 还是挂着）',
      !r.stdout.includes('WATCHDOG-FIRED') && r.code !== 7,
      JSON.stringify({ code: r.code, out: r.stdout.slice(0, 200) }))
    check('[卡住] 替身线程真的起来过（线程自己往文件里追加了标记）',
      fs.existsSync(startsFile), startsFile)
    check('[卡住] 第一次等待拿到的是回执而不是「永远挂着」（修前 = 8 秒观察窗口到点仍无结果）',
      !!out && String(out.first).startsWith('rejected:'), out ? out.first : 'no RESULT')
    check('[卡住] 那句错误说清楚是「本地合成线程没有回话」（客户端/诊断都读得懂）',
      !!out && /没有结果/.test(out.first) && /没有回话/.test(out.first), out ? out.first : 'no RESULT')
    check('[卡住] 它等的是那条等待上限（临时树里改小的 1500ms，不是随手一个定时器）',
      !!out && out.timers.some((t) => t.ms === 1500), out ? JSON.stringify(out.timers) : 'no RESULT')
    check('[卡住] 这条定时器不按住进程（hasRef=false；停用之后宿主该能退）',
      !!out && out.timers.filter((t) => t.ms === 1500).every((t) => t.hasRef === false),
      out ? JSON.stringify(out.timers) : 'no RESULT')
    check('[卡住·反证] hasRef 这个读数不是恒 false（驱动自己那条是 true）',
      !!out && out.proofRef === true, out ? String(out.proofRef) : 'no RESULT')
    check('[卡住] 卡住的那条线程被拆掉了（主线程看到它的 exit）',
      !!out && out.workers.length >= 1 && out.workers[0].exits.length === 1,
      out ? JSON.stringify(out.workers) : 'no RESULT')
    check('[卡住] 第二次请求照样拿到回执（不是一次性修复）',
      !!out && String(out.second).startsWith('rejected:'), out ? out.second : 'no RESULT')
    // 这一条钉的是「按线程分桶的那张待回包表」：改前所有线程共用一张表，
    // 旧线程那条晚到的 exit 会把新线程上正在等的一句一起拒掉，
    // 实测（改前那一趟）第二次拿到的是「本地合成线程已退出。」而不是它该等的上限。
    check('[卡住] 第二次等的是它自己那条线程的上限，不是被旧线程的退出误伤（改前 = 本地合成线程已退出）',
      !!out && /没有回话/.test(String(out.second)) && out.gap >= 1200,
      out ? JSON.stringify({ second: out.second, gap: out.gap }) : 'no RESULT')
    check('[卡住] 第二次是在**另一条线程**上等的（卡住的那条没留着让后面每句再等满上限）',
      fs.existsSync(startsFile) && fs.readFileSync(startsFile, 'utf8').trim().split('\n').length >= 2
      && !!out && out.workers.length >= 2,
      JSON.stringify({ starts: fs.existsSync(startsFile) ? fs.readFileSync(startsFile, 'utf8').trim() : '', workers: out?.workers?.length, second: out?.second }))
    check('[卡住] 线程报错没有变成崩溃（子进程退出码 0）',
      r.code === 0 && !out?.workers?.some((w) => w.errors.length),
      JSON.stringify({ code: r.code, err: r.stderr.slice(0, 200), workers: out?.workers }))
    check('[卡住] 全程远快于「挂着不退」（子进程自己结束用了不到 15 秒）',
      r.ms < 15_000, `${r.ms}ms`)
  } finally {
    fs.rmSync(tree.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

console.log('\n这条等待上限与客户端那句超时的关系（读生产常量，不是临时树里改小的那个）')
check('神经合成的等待上限早于客户端单句合成超时（宿主总比客户端先给回执）',
  NEURAL_WAIT_TIMEOUT_MS < TTS_TIMEOUT_MS,
  `宿主 ${NEURAL_WAIT_TIMEOUT_MS}ms vs 客户端 ${TTS_TIMEOUT_MS}ms`)

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
