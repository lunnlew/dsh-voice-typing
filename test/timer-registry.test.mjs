/**
 * 定时器登记表 —— 单元测试 + linter 探针。
 *
 * 背景（2026-10-31 的真故障）：「助手忙完后自动发送」的定时器只在组件卸载时被清，
 * 于是用户关掉麦克风后它照样在 400 毫秒后触发，把草稿**自动发了出去**。
 * 根因是句柄分散在各自的 ref 里、各自清理、各自可能漏 —— 于是有了这张表。
 *
 * 本文件原来是 17 条**扫源码文本**的判据（批次 4 改写，逐档处置）：
 *
 * 1. 登记表本身的行为（同名先清旧的 / 按 group 清 / clearAll 撤销 / size·ids 诊断）
 *    → 直接 import `src/client/pure/envelope.js`，对着**假 win** 跑：
 *      判的是「win 收到了哪个撤销调用、句柄是哪个、毫秒有没有原样传」，
 *      与生产代码怎么写那几行无关。
 * 2. 「不许有裸的 setTimeout」「id / 组名必须是字符串字面量」
 *    → 写法禁令的家是 linter（`eslint.config.js` 的 4 条 `no-restricted-syntax`）。
 *      本文件只留**可执行探针**：喂一段坏代码给 eslint 看它报不报（7 条）。
 *      「真树到底干净不干净」不在这儿判 —— `test/no-undef.test.mjs` 会对
 *      `src test scripts` 全树跑同一条规则（跑的是真文件），已经覆盖。
 * 3. 「关麦时清 mic 组 / 停麦时清 send 组 / 卸载全清 / keptPartial 在 try 之前 /
 *    自动发送在 catch 之前 / 快照挂在 win 上」
 *    → 组件级行为，在 `test/client-behavior.test.mjs`：
 *      场景 19「关麦复位」数的是 `dbg().timers`（真登记表里的真 id）与真提交；
 *      场景 20「识别中途宿主挂了」判实时字保留与自动发送照样走到。
 *
 * 原来另外保留的 3 条静态判据在批次 6i-c 全部清掉（本文件现在一行源码文本都不读）：
 *   · 「只清自己那份的调试快照通道」→ 删（假 runtime 只有一个实例，那个时序造不出来）；
 *   · 「登记表按注入的 win 创建」→ 负半边归 eslint 的 globals 清单（写 window 就是 no-undef，
 *     由 test/no-undef.test.mjs 全树跑），正半边搬进 client-behavior 场景「关麦复位」（假 win 上
 *     开始数得到每一次 setTimeout/setInterval/clearTimeout/clearInterval）；
 *   · 「调用点先取别名再用」→ 删，理由折进 linter：TIMER_BANS 加了第 5 条选择器，
 *     链式写法 timersRef.current.timeout(变量) 现在也报（下面探针里一正一反钉着）。
 *
 * 计数走两条通道：`add()` = 登记表场景判据（对着假 win 真跑），
 * `check()` = linter 探针与保留的静态判据。
 *
 * 用法：node test/timer-registry.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ENVELOPE = path.join(here, '..', 'src', 'client', 'pure', 'envelope.js')
const envelope = await import(pathToFileURL(ENVELOPE).href)

const scenarioRows = []
const verdictRows = []
function print(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '：' + detail : ''}`)
}
/** 场景判据：对着假 win 真跑出来的每一条。 */
function add(name, ok, detail = '') {
  scenarioRows.push({ name, ok, detail })
  print(name, ok, detail)
}
/** 结论性判据（linter 探针 / 保留的静态判据）：只在收尾这一轮写。 */
function check(name, ok, detail = '') {
  verdictRows.push({ name, ok, detail })
  print(name, ok, detail)
}

/**
 * 假 win：只记「登记表让我做了什么」，不真的起任何定时器。
 *
 * - `handles` 句柄 → {kind, fn, ms}，`fire(handle)` 手动让它到点（interval 可连发）；
 * - `createdTimeout` / `createdInterval` 按创建顺序记 {handle, ms}，
 *   判据看的是**走的是哪个 API、毫秒是多少**，不是源码里那行字怎么写；
 * - `clearedTimeout` / `clearedInterval` 按撤销顺序记句柄，
 *   「清错通道」的退化只有在这里才看得见（真浏览器里 clearTimeout 撤不掉 interval，
 *   于是那个 interval 一直响 —— 正是这批要防的事）。
 */
function makeWin() {
  let seq = 0
  const handles = new Map()
  const win = {
    createdTimeout: [], createdInterval: [], clearedTimeout: [], clearedInterval: [],
    setTimeout(fn, ms) {
      const handle = { kind: 'timeout', id: ++seq }
      handles.set(handle, { fn, ms })
      win.createdTimeout.push({ handle, ms })
      return handle
    },
    setInterval(fn, ms) {
      const handle = { kind: 'interval', id: ++seq }
      handles.set(handle, { fn, ms })
      win.createdInterval.push({ handle, ms })
      return handle
    },
    clearTimeout(handle) { win.clearedTimeout.push(handle) },
    clearInterval(handle) { win.clearedInterval.push(handle) },
    /** 到点：把当初交给 win 的那个回调真调一次（不查登记表是否还认这个句柄）。 */
    fire(handle) { handles.get(handle)?.fn() },
  }
  return win
}

/**
 * 判据本体 —— 对着假 win 真跑登记表（同名先清旧的 / 按组清 / clearAll 撤销）。
 *
 * 每组各起一份新的 win + 新的登记表：状态串了会让「红的那条」说不清是哪条造成的
 * （批次 1 踩过的坑，写在 turn-boundary 文件头）。
 */
function registryBattery(mod) {
  const { createTimerRegistry, sleep } = mod
  scenarioRows.length = 0

  /* ---- 一次性定时器 ---- */
  {
    const win = makeWin()
    const timers = createTimerRegistry(win)
    const ret = timers.timeout('hint', () => {}, 400, 'app')
    add('T1 timeout 走 win.setTimeout，毫秒原样传（不吞参数）',
      win.createdTimeout.length === 1 && win.createdTimeout[0].ms === 400,
      JSON.stringify(win.createdTimeout.map((c) => c.ms)))
    add('T2 timeout 把句柄登记进表（size / ids 都对得上）',
      timers.size() === 1 && timers.ids().join() === 'hint',
      JSON.stringify({ size: timers.size(), ids: timers.ids() }))
    add('T3 timeout 返回 win 给的那个句柄（调用方能拿它比对）', ret === win.createdTimeout[0].handle)
    const seen = []
    timers.timeout('hint', () => seen.push('second'), 500, 'app')
    add('T4 同名 timeout 重复登记：旧的先向 win 撤销，表里只剩一个',
      win.clearedTimeout.length === 1
        && win.clearedTimeout[0] === win.createdTimeout[0].handle
        && timers.size() === 1 && win.createdTimeout.length === 2,
      JSON.stringify({ created: win.createdTimeout.length, cleared: win.clearedTimeout.length, size: timers.size() }))
    win.fire(win.createdTimeout[1].handle)
    win.fire(win.createdTimeout[1].handle)
    add('T5 timeout 到点后条目仍留在表里（诚实钉当前行为：表只按 id 记账，不自动摘除跑完的一次性定时器）',
      timers.size() === 1, JSON.stringify({ size: timers.size(), ids: timers.ids() }))
  }

  /* ---- 重复定时器 ---- */
  {
    const win = makeWin()
    const timers = createTimerRegistry(win)
    timers.interval('flush', () => {}, 900, 'mic')
    add('I1 interval 走 win.setInterval（不是被当成一次性那个 API）',
      win.createdInterval.length === 1 && win.createdTimeout.length === 0,
      JSON.stringify({ interval: win.createdInterval.length, timeout: win.createdTimeout.length }))
    const first = win.createdInterval[0].handle
    let ticks = 0
    timers.interval('flush', () => { ticks += 1 }, 900, 'mic')
    add('I2 同名 interval 重复登记：旧的用 clearInterval 撤销（撤错通道就撤不掉）',
      win.clearedInterval.length === 1 && win.clearedInterval[0] === first
        && win.clearedTimeout.length === 0,
      JSON.stringify({ clearedInterval: win.clearedInterval.length, clearedTimeout: win.clearedTimeout.length }))
    win.fire(win.createdInterval[1].handle)
    win.fire(win.createdInterval[1].handle)
    add('I3 interval 到点两次就调两次，且仍在表里（重复定时器不该自己消失）',
      ticks === 2 && timers.size() === 1, JSON.stringify({ ticks, size: timers.size() }))
  }

  /* ---- clear(id) ---- */
  {
    const win = makeWin()
    const timers = createTimerRegistry(win)
    timers.timeout('a', () => {}, 10, 'app')
    const handleA = win.createdTimeout[0].handle
    timers.timeout('b', () => {}, 10, 'app')
    let threw = null
    try { timers.clear('nope') } catch (err) { threw = err }
    add('C1 clear 不存在的 id 不炸、也不误清别人',
      !threw && timers.size() === 2 && win.clearedTimeout.length === 0,
      String(threw?.message ?? ''))
    timers.clear('a')
    add('C2 clear(id) 撤销的正是当初登记的那个句柄',
      win.clearedTimeout.length === 1 && win.clearedTimeout[0] === handleA,
      JSON.stringify({ cleared: win.clearedTimeout.length, same: win.clearedTimeout[0] === handleA }))
    add('C3 clear 之后表里真的删掉了（size 与 ids 同步）',
      timers.size() === 1 && timers.ids().join() === 'b',
      JSON.stringify({ size: timers.size(), ids: timers.ids() }))
  }

  /* ---- clearGroup(group) ---- */
  {
    const win = makeWin()
    const timers = createTimerRegistry(win)
    timers.timeout('send1', () => {}, 400, 'send')
    timers.timeout('send2', () => {}, 400, 'send')
    timers.interval('poll', () => {}, 700, 'app')
    timers.clearGroup('send')
    add('G1 clearGroup 只清这一组：send 的两个都撤了，app 的那个留着',
      win.clearedTimeout.length === 2 && timers.size() === 1 && timers.ids().join() === 'poll',
      JSON.stringify({ clearedTimeout: win.clearedTimeout.length, size: timers.size(), ids: timers.ids() }))
    add('G2 留下的那一条撤销通道没错（interval 走 clearInterval）',
      win.clearedInterval.length === 0, JSON.stringify({ clearedInterval: win.clearedInterval.length }))
    timers.clearGroup('不存在的组')
    add('G3 clearGroup 用严格相等：组名不匹配时一个都不清',
      timers.size() === 1 && win.clearedInterval.length === 0,
      JSON.stringify({ size: timers.size() }))
    const t = timers.timeout('ungrouped', () => {}, 10)
    add('G4 不传 group 的条目自成一组：clearGroup(undefined) 只清它们',
      timers.size() === 2 && t !== undefined, JSON.stringify({ size: timers.size() }))
    timers.clearGroup()
    add('G5 clearGroup() 不传参时清掉的正是「没分组」的那些（诚实钉当前行为）',
      timers.size() === 1 && timers.ids().join() === 'poll',
      JSON.stringify({ size: timers.size(), ids: timers.ids() }))
  }

  /* ---- clearAll ---- */
  {
    const win = makeWin()
    const timers = createTimerRegistry(win)
    timers.timeout('t1', () => {}, 10, 'app')
    timers.timeout('t2', () => {}, 10, 'send')
    timers.interval('i1', () => {}, 10, 'mic')
    timers.interval('i2', () => {}, 10, 'app')
    const allTimeouts = win.createdTimeout.map((c) => c.handle)
    const allIntervals = win.createdInterval.map((c) => c.handle)
    timers.clearAll()
    add('A1 clearAll 把每个句柄都向 win 撤销过（不是只把表清空）',
      allTimeouts.every((h) => win.clearedTimeout.includes(h))
        && allIntervals.every((h) => win.clearedInterval.includes(h)),
      JSON.stringify({ clearedTimeout: win.clearedTimeout.length, clearedInterval: win.clearedInterval.length }))
    add('A2 clearAll 之后表是空的', timers.size() === 0 && timers.ids().length === 0,
      JSON.stringify({ size: timers.size(), ids: timers.ids() }))
  }

  /* ---- sleep ---- */
  {
    const win = makeWin()
    const timers = createTimerRegistry(win)
    let resolved = false
    const p = sleep(win, 7).then(() => { resolved = true })
    add('S1 sleep 用的是注入的 win.setTimeout，毫秒原样（不绕到全局定时器）',
      win.createdTimeout.length === 1 && win.createdTimeout[0].ms === 7,
      JSON.stringify(win.createdTimeout.map((c) => c.ms)))
    add('S2 sleep 不登记进表（设计上的唯一例外：它必定结束、不跨状态残留）',
      timers.size() === 0, JSON.stringify({ size: timers.size(), ids: timers.ids() }))
    add('S3 假 win 没到点时 sleep 还挂着（resolve 由那个回调驱动，不是当场就完）',
      resolved === false)
    // 万一实现根本不向 win 起定时器（那样这个 promise 永远不 resolve）：
    // 取句柄要防 undefined，等它要设上限 —— 判据本身不能变成「卡死整套」。
    const handle = win.createdTimeout[0]?.handle
    if (handle) win.fire(handle)
    const cap = new Promise((r) => setTimeout(r, 250))
    return Promise.race([p, cap]).then(() => {
      add('S4 到点后 sleep 真的 resolve', resolved === true,
        resolved ? '' : '假 win 到点后没 resolve（说明它绕开了注入的 win）')
      return scenarioRows.slice()
    })
  }
}

console.log('\n登记表行为（对着假 win 跑，判的是它收到了什么调用）')
await registryBattery(envelope)

/* ================================================================== */
/* linter 探针 —— 「写法禁令住在哪」的可执行验证                       */
/* ================================================================== */
console.log('\nlinter 探针（写法禁令由 eslint 执行，这里只验它真的执行）')
let ESLint = null
try {
  ;({ ESLint } = await import('eslint'))
} catch {
  ESLint = null
}
check('eslint 可用（这道守卫不许静默跳过）', ESLint !== null,
  'devDependencies 里的 eslint 没装上：npm install 之后再测')

if (ESLint) {
  const eslint = new ESLint({ cwd: path.join(here, '..') })
  /** 按「假想路径」喂一段代码，拿 no-restricted-syntax 的报错。 */
  const restricted = async (code, filePath) => {
    const [result] = await eslint.lintText(code, { filePath })
    return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax')
  }
  const cases = [
    {
      name: '裸 setTimeout 会被报（原来靠扫文本，现在由 linter 抓）',
      code: 'export const go = () => setTimeout(() => {}, 300)\n',
      filePath: 'src/client/dom/probe.js',
      want: true,
    },
    {
      name: 'win.setInterval 也会被报（成员写法不是漏洞）',
      code: 'export const go = (win) => win.setInterval(() => {}, 900)\n',
      filePath: 'src/client/dom/probe.js',
      want: true,
    },
    {
      name: 'timers.clear(变量) 会被报（拼错的变量名运行时不报错）',
      code: 'export const go = (timers, id) => timers.clear(id)\n',
      filePath: 'src/client/dom/probe.js',
      want: true,
    },
    {
      name: 'timers.clearGroup(变量) 同样会被报',
      code: 'export const go = (timers, g) => timers.clearGroup(g)\n',
      filePath: 'src/client/dom/probe.js',
      want: true,
    },
    {
      name: '登记表挂在对象属性上也报（state.timers.clear(变量) —— 第 4 条选择器不是死配置）',
      code: 'export const go = (state, id) => state.timers.clear(id)\n',
      filePath: 'src/client/dom/probe.js',
      want: true,
    },
    {
      // 这条原来叫「已知缺口（照实记）」，判的是链式写法**不报**（want: false）。
      // 批次 6i-c 把它翻成「链式写法也报」，同时删掉了本文件末尾那条
      // 「调用点先取别名再用」的源码正则 —— 那条存在的唯一理由就是这个缺口：
      // 它靠禁止链式写法来回避选择器认不到链式写法。缺口关掉之后，
      // 「取不取别名」变成纯粹的写法偏好，行为上一条判据都不该钉它。
      //
      // 用 timeout 而不是 clear：第 5 条只管 timeout/interval（链式的 `.current.clear()`
      // 会撞上朗读高亮与 Set 的合法 clear()，见 eslint.config.js 里那条注释）。
      name: '链式写法 timersRef.current.timeout(变量, ...) 现在也报（第 5 条选择器关掉的那个盲区）',
      code: 'export const go = (timersRef, id) => timersRef.current.timeout(id, () => {}, 900)\n',
      filePath: 'src/client/dom/probe.js',
      want: true,
    },
    {
      name: '链式写法带字符串字面量不报（关的是盲区，不是把别名写法也禁掉）',
      code: "export const go = (timersRef) => timersRef.current.timeout('flush', () => {}, 900)\n",
      filePath: 'src/client/dom/probe.js',
      want: false,
    },
    {
      name: '链式的 clear 照旧放过（它在真树上是朗读高亮 / Set 的写法，不是登记表）',
      code: 'export const go = (highlightRef) => highlightRef.current.clear()\n',
      filePath: 'src/client/dom/probe.js',
      want: false,
    },
    {
      name: '合法写法不报（字符串 id + 登记表调用）',
      code: "export const go = (timers) => { timers.timeout('flush', () => {}, 900, 'mic'); timers.clear('flush'); timers.clearGroup('mic') }\n",
      filePath: 'src/client/dom/probe.js',
      want: false,
    },
    {
      name: '登记表自己（pure/envelope.js）豁免 —— 它必须真调 win.setTimeout',
      code: fs.readFileSync(ENVELOPE, 'utf8'),
      filePath: 'src/client/pure/envelope.js',
      want: false,
    },
    {
      name: '禁令只在客户端生效（宿主里裸 setTimeout 不该报）',
      code: 'export const go = () => setTimeout(() => {}, 300)\n',
      filePath: 'src/host/probe.js',
      want: false,
    },
  ]
  for (const c of cases) {
    const hits = await restricted(c.code, c.filePath)
    check(c.name, hits.length > 0 === c.want, hits.map((m) => m.message.slice(0, 40)).join(' | ') || '无报错')
  }
}

/* ================================================================== */
/* 原来保留的 3 条静态判据 —— 批次 6i-c 全部清掉，本节一条源码正则都不留 */
/* ================================================================== */
// 逐条去向（实录见 docs/architecture-modernization.md §8.42）：
//   1. 「调试快照通道：卸载时只清自己那份（先比对再清）」→ **删**（行为上分不出写法）。
//      比不清就清的唯一区别是「旧实例的 cleanup 晚于新实例注册」——本 harness 的假 runtime
//      只有一个组件实例（`runtime.mount` 换组件才重置 slots，同一组件重复 mount 走的是
//      重渲染，不会有两个实例交叠），这个时序造不出来。两种写法在单实例下的可观察结果逐字一样：
//      卸载后 `win.__DSH_VOICE_DEBUG__` 都变成 undefined（client-behavior 场景「关麦复位」
//      一直在读它，读到的是空对象兜底）。
//      推翻条件（什么时候必须写成行为判据）：harness 支持两个 MicButton 实例并存、
//      并且让先挂载那个的 cleanup 在后一个注册之后才跑 —— 那时判「B 的快照还在」。
//   2. 「登记表按注入的 win 创建（不是自己抓全局 window）」→ **换成真跑**。
//      负半边（不许写全局 window）本来就有更强的守卫：`eslint.config.js` 把 `window`
//      从 src/client/** 的 globals 清单里删掉了，写了就是 no-undef，而 test/no-undef.test.mjs
//      对 src/test/scripts 全树跑这条规则。正半边（句柄真的出自注入的那个 win）搬到
//      client-behavior 场景「关麦复位」A 段：假 win 现在把每一次 setInterval/clearInterval
//      都记进 env.winTimerOps，登记表换成抓全局或抓别的对象，那两笔 interval 计数就是 0。
//   3. 「调用点先取别名再用」→ **删**，并把它的存在理由折进 linter。
//      这条写法约定只为一件事：linter 那两条「id/组名必须是字符串字面量」的选择器认不到
//      `timersRef.current.timeout(变量)` 这种链式形状（上面的探针里原来就照实记着这个缺口）。
//      现在加了第 5 条选择器把缺口关掉（见 eslint.config.js 的 TIMER_BANS 末尾那条，
//      上面三个新探针一正一反再加一条边界钉着它），取不取别名从此是纯写法偏好，没有判据该钉它。

const all = [...scenarioRows, ...verdictRows]
const passed = all.filter((r) => r.ok).length
const failed = all.length - passed
console.log(`\n通过 ${passed}，失败 ${failed}（登记表判据 ${scenarioRows.length} 条 + linter 探针 ${verdictRows.length} 条）`)
if (failed) process.exitCode = 1
