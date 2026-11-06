/**
 * 注入环境（browserEnv）的转发行为检查。
 *
 * 这条测试存在的理由是一次真实崩溃（2026-11-03 装机实测）：
 * 第 4 步把组件抽进 dom/ 之后，main.js 里的 `browserEnv.win` 是一份**手写成员清单**
 * （setTimeout / addEventListener / AudioContext 等十几个）。清单漏了 `document`，
 * 而 `pure/reading-highlight.js` 第一行就是 `const doc = win.document`，
 * 于是 MicButton 卸载时 dispose 报
 * `TypeError: Cannot read properties of undefined (reading 'querySelector')`，
 * 整个 main.conversation 槽位被打崩。
 *
 * 为什么当时的 59 个测试文件全绿：dom/ 组件在 Node 里跑的是**测试自己造的 mock env**，
 * 那份 mock 恰好带 document。产物的清单再窄，测试也看不见。
 *
 * 修法是把清单换成整对象转发（forwardEnv）。这条测试钉住修好的行为：
 *   1. 源码里真的用到的每一个 `win.X / doc.X / nav.X`，从产物的注入环境里都取得到
 *      —— 清单一旦被改窄回去，这一条立刻红；
 *   2. 取到的方法是绑回真身的（浏览器里不绑就是 Illegal invocation）；
 *   3. 同一个方法两次取到的是**同一个引用**（否则 add/removeEventListener 配不成对）；
 *   4. `__DSH_` 诊断通道落在真实 window 上，别的赋值不污染真实 window；
 *   5. 没有 document/navigator 的环境里整套 factory 仍然跑得起来（桩环境）。
 *
 * 2026-11-04 批次 6l-d：「成员清单」不再只有一个来源。
 *   原先第 1 条的名单靠正则扫 `src/client/{dom,pure}/*.js`，于是需要两条守着扫描本身：
 *   「扫出来的清单非空」和「清单里有 win.document」。这两条判的都是文本，
 *   而真正要防的是「跑到那一行代码时拿不到成员」。现在名单有两个来源：
 *     - 扫文本（覆盖面广，包含没被驱动到的分支）；
 *     - 真代码摸到的（`pure/reading-highlight.js` + `pure/envelope.js` 的定时器登记
 *       + `dom/mic-device.js`，都通过产物内部那一份 forwardEnv 走一遍）。
 *   「非空」由真驱动兜住，「win.document」那条变成当年的崩溃复现（set/getState/clear/dispose
 *   全程不抛）。代价与不补的那条判据写在下面「真代码摸到的成员」那一节边上，
 *   裁定见 docs/architecture-modernization.md §8.46（6l-d）。
 */
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createReadingHighlight } from '../src/client/pure/reading-highlight.js'
import { matchInNodes, collapseWhitespace, unescapeSpeechText } from '../src/client/pure/highlight.js'
import { createTimerRegistry } from '../src/client/pure/envelope.js'
import { createMicDevice } from '../src/client/dom/mic-device.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundled = fs.readFileSync(root + '/lib/client.js', 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/**
 * 「真代码摸到过哪些环境成员」。
 *
 * 批次 6l-d 之前这份名单只有一个来源：拿正则扫 `src/client/{dom,pure}/*.js` 里的
 * `win.X / doc.X / nav.X`。那条路有两处守不住：
 *   - 扫描本身坏掉（目录改名、正则写歪）时清单变成空集，而「提供源码用到的全部 0 个成员」
 *     照样绿 —— 所以要加「清单非空」，加了又变成「判扫描脚手架」的源码文本判据；
 *   - 「当年崩的那个成员在不在清单里」判的是文本里有没有那句 `win.document`，
 *     不是「真跑一遍会不会崩」。
 * 现在改成：把假 window / document / navigator 各套一层记录器，让**真代码**走过去摸一遍
 * （高亮的 set/clear/dispose、定时器登记、开麦设备层），摸到什么记什么。
 * `recording` 只在驱动那几行打开，本文件自己读写这些对象不算。
 */
const TOUCHED = { win: new Set(), doc: new Set(), nav: new Set() }
let recording = false

/** 注释里写「用了 window.xxx」是正常文档，不该算进环境的依赖清单。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/* ================= 1. 源码到底用了环境的哪些成员 ================= */

// 名单从源码读，不硬编码：新用了一个浏览器 API，它自动进入检查范围。
// 6l-d 起这份「文本扫出来的清单」只当**覆盖面**用（它比真跑摸到的广），
// 「扫到东西了没有」「当年那个成员在不在」这两件事改由下面的真驱动判。
const USED = { win: new Set(), doc: new Set(), nav: new Set() }
for (const dir of ['dom', 'pure']) {
  for (const f of fs.readdirSync(`${root}/src/client/${dir}`).filter((x) => x.endsWith('.js'))) {
    const raw = stripComments(fs.readFileSync(`${root}/src/client/${dir}/${f}`, 'utf8'))
    for (const m of raw.matchAll(/\b(win|doc|nav)\.([A-Za-z_$][\w$]*)/g)) {
      USED[m[1]].add(m[2])
    }
  }
}
// 诊断通道走的是「转发给真实 window」那条分支，不该被当成 window 的固有成员来查。
for (const key of Object.keys(USED)) {
  for (const name of [...USED[key]]) {
    if (name.startsWith('__DSH_')) USED[key].delete(name)
  }
}

/* ================= 2. 一份「只列真实浏览器有的东西」的假环境 ================= */

/**
 * 每个方法都记录自己被调用时的 `this`。
 * 注入环境如果直接交出裸方法（没 bind），调用方拿到的是 Proxy 而非真身 ——
 * 浏览器里这就是 Illegal invocation，这里就是 receiver 记错。
 *
 * 第二层：`touchKey` 给上之后，这个对象再被包一层**读取记录器**（见上面的 TOUCHED）。
 * 绑回真身那条判据核对的「真身」就是这一层包装对象 —— 注入环境绑的确实是它，
 * 语义没变（判的是「有没有绑到调用方临时给的接收者上」）。
 */
function makeObject(members, touchKey) {
  const calls = []
  const raw = {}
  for (const [name, value] of Object.entries(members)) {
    if (typeof value === 'function') {
      raw[name] = function (...args) {
        calls.push({ name, receiver: this })
        return value.apply(this, args)
      }
    } else {
      raw[name] = value
    }
  }
  if (!touchKey) return { obj: raw, calls }
  const obj = new Proxy(raw, {
    get(t, p) {
      if (recording && typeof p === 'string') TOUCHED[touchKey].add(p)
      return Reflect.get(t, p)
    },
    set(t, p, value) {
      if (recording && typeof p === 'string') TOUCHED[touchKey].add(p)
      return Reflect.set(t, p, value)
    },
  })
  return { obj, calls }
}

const listeners = {}
// 假元素给到「真代码会写到的那几样」：`tag.dataset.pluginCss = …` 要 dataset，
// `existing.textContent !== css` 要 textContent，`layer.children.length` 要 children。
// 几何相关的都留空 —— 本文件判的是成员转发，高亮的几何由 test/highlight-overlay.test.mjs 判。
const fakeElement = {
  tagName: 'DIV', style: {}, dataset: {}, textContent: '', children: [],
  appendChild(node) { this.children.push(node) }, removeChild() {}, remove() {},
  setAttribute() {}, removeAttribute() {}, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
}
const fakeRange = { selectNodeContents() {}, detach() {}, setStart() {}, setEnd() {}, cloneRange() { return fakeRange }, collapse() {} }

const doc = makeObject({
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => fakeElement,
  createTextNode: () => ({ nodeType: 3 }),
  createTreeWalker: () => ({ nextNode: () => null }),
  createRange: () => fakeRange,
  contains: () => false,
  // 属性成员：真实 document 上它们是节点对象，这里给同样的形状。
  head: fakeElement,
  body: fakeElement,
  documentElement: fakeElement,
  activeElement: fakeElement,
}, 'doc')

const win = makeObject({
  setTimeout: () => 1,
  clearTimeout: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn) },
  removeEventListener: (type, fn) => {
    if (listeners[type]) listeners[type] = listeners[type].filter((x) => x !== fn)
  },
  dispatchEvent: () => true,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  // 构造器类成员：这里给普通函数（`new` 一个普通函数一样能得到实例），
  // 但它们不能进「按方法调用」那一批，所以放在下面单独排除。
  Event: function Event(type) { this.type = type },
  KeyboardEvent: function KeyboardEvent(type) { this.type = type },
  MutationObserver: function MutationObserver() { this.observe = () => {}; this.disconnect = () => {} },
  AudioContext: function AudioContext() { this.state = 'running' },
  webkitAudioContext: function webkitAudioContext() { this.state = 'running' },
  NodeFilter: { SHOW_TEXT: 4 },
  speechSynthesis: { speaking: false, getVoices: () => [], speak() {}, cancel() {} },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  fetch: () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => '', headers: { get: () => null } }),
  console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  innerWidth: 1280,
  innerHeight: 800,
}, 'win')

const nav = makeObject({
  language: 'zh-CN',
  userAgent: 'node-vm-test',
  platform: 'Win32',
  // 开麦设备层摸的就是这一条（navigator 上的 mediaDevices）。
  // 真浏览器里 navigator 一直有它，桩环境不给就等于少一个成员。
  mediaDevices: {
    getUserMedia: async () => ({ getAudioTracks: () => [], getTracks: () => [] }),
    enumerateDevices: async () => [],
  },
}, 'nav')

/** 只在这些成员上验证「绑回真身」，构造器与属性成员不适用（调用形状不同）。 */
const METHOD_CHECK = {
  win: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'addEventListener',
    'removeEventListener', 'dispatchEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle'],
  doc: ['querySelector', 'querySelectorAll', 'createElement', 'createTreeWalker', 'createRange', 'contains'],
  nav: [],
}

function buildSandbox(withBrowserGlobals) {
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    Buffer, URL, TextEncoder, TextDecoder, process, AbortController, Promise,
    EventSource: function () {},
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' }),
  }
  if (withBrowserGlobals) {
    sandbox.window = win.obj
    sandbox.document = doc.obj
    sandbox.navigator = nav.obj
    // window 上常见的自引用：产物里读 window.window 的地方按浏览器语义给上。
    win.obj.window = sandbox.window
    win.obj.document = doc.obj
    win.obj.navigator = nav.obj
  } else {
    // 「宿主只给了一个 window 挂加载器，页面里没有 document/navigator」这种最瘦的桩环境
    // （test/client-behavior 那类跑法就是它）：factory 必须照样建得起来。
    sandbox.window = {}
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  let def = null
  // 宿主契约是 `window.__ModuleLoader__.load(…)`：产物读的是 window 上的这个属性，
  // 而这里 window 是假对象（不是 sandbox 本身），所以挂载点必须跟着放到 window 上。
  const loader = { load: (d) => { def = d } }
  sandbox.__ModuleLoader__ = loader
  sandbox.window.__ModuleLoader__ = loader
  vm.runInContext(bundled, sandbox, { filename: 'lib/client.js' })
  const react = new Proxy({ createElement: () => null, Fragment: 'F' }, {
    get: (t, p) => (p in t ? t[p] : () => undefined),
  })
  const exp = def.factory((n) => {
    if (n === 'react') return react
    throw new Error('不该 require：' + n)
  })
  return { sandbox, exp }
}

console.log('产物在有浏览器全局的环境里能建出注入环境')
const built = (() => {
  try {
    return buildSandbox(true)
  } catch (e) {
    check('factory(require) 在假 window/document/navigator 下能执行', false, e.message)
    return null
  }
})()
if (!built) {
  console.log(`\n通过 ${passed}，失败 ${failed}`)
  process.exitCode = failed ? 1 : 0
  throw new Error('后面的断言依赖产物已经执行，直接收场')
}
check('factory(require) 在假 window/document/navigator 下能执行', true)
const env = built.exp.__test.browserEnv
check('__test 里导出了 browserEnv（不然这条测试无从下手）', !!env)

/* ================= 3. 真代码走注入环境摸一遍（批次 6l-d） ================= */

/**
 * 三条链路都是**真模块**：`pure/reading-highlight.js`（就是当年崩的那一个）、
 * `pure/envelope.js` 的定时器登记、`dom/mic-device.js` 的开麦设备层。
 * 它们拿到的 `env.win / env.nav` 是产物内部那一份 forwardEnv，
 * 所以「转发有没有改窄回去」是真的会被走到 —— 少了成员不是「清单里少一行」，
 * 而是这条链路当场抛 TypeError，跟浏览器里的表现一样。
 */
console.log('\n真代码走注入环境摸一遍：摸到什么记什么')
const driveErrors = []
{
  recording = true
  try {
    const timers = createTimerRegistry(env.win)
    timers.timeout('env-timeout', () => {}, 10_000, 'env-probe')
    timers.interval('env-interval', () => {}, 10_000, 'env-probe')
    if (timers.size() !== 2) throw new Error(`登记数不对：${timers.size()}`)
    timers.clearGroup('env-probe')
    if (timers.size() !== 0) throw new Error(`清组之后还剩 ${timers.size()} 个`)
  } catch (error) { driveErrors.push(`定时器登记：${error?.message ?? error}`) }

  try {
    // 高亮这条链要有对照：set() 会往 window 挂 scroll/resize，走到链尾（clear + dispose）
    // 该一个都不剩。只判「没抛」的话，中间少调用一步也不会红。
    // 诚实边界：这个对照判不到「dispose 自己有没有清样式/覆盖层」—— 监听在 clear() 就摘了，
    // 删掉 dispose() 那一行照样绿（探针实测过）。dispose 清没清干净由
    // test/highlight-overlay.test.mjs 判（批次 5d 建的假 DOM 带父节点追踪），这里不重复。
    const watchTypes = ['scroll', 'resize']
    const liveCount = () => watchTypes.reduce((n, type) => n + (listeners[type]?.length ?? 0), 0)
    const highlight = createReadingHighlight(env.win, { matchInNodes, collapseWhitespace, unescapeSpeechText })
    highlight.set('这是一句用来摸环境成员的话')
    const during = liveCount()
    highlight.getState()
    highlight.clear()
    highlight.dispose()
    const after = liveCount()
    for (const type of watchTypes) delete listeners[type]
    if (during === 0) throw new Error('set() 没往 window 挂 scroll/resize 监听，链尾的对照没有对象')
    if (after !== 0) throw new Error(`走到链尾 window 上还挂着 ${after} 个 scroll/resize 监听`)
  } catch (error) { driveErrors.push(`朗读高亮：${error?.message ?? error}`) }

  try {
    const micDevice = createMicDevice({
      win: env.win,
      readMediaDevices: () => env.nav?.mediaDevices,
    })
    if (!micDevice.supportsCapture()) throw new Error('桩环境给了 mediaDevices.getUserMedia，却判成不能录音')
    const ctx = micDevice.createAudioContext()
    micDevice.closeAudioContext(ctx)
  } catch (error) { driveErrors.push(`开麦设备层：${error?.message ?? error}`) }
  recording = false

  const counts = { win: TOUCHED.win.size, doc: TOUCHED.doc.size, nav: TOUCHED.nav.size }
  check('三组都真有成员被**代码**摸到（旧判据数的是文本扫出来的清单非空）',
    counts.win > 0 && counts.doc > 0 && counts.nav > 0, JSON.stringify(counts))
  // 当年那次装机崩溃的具体形状：`const doc = win.document` 拿到 undefined，
  // 下一句 `doc.querySelector` 抛 TypeError。现在这一条判的是「真读了、且整条没抛」。
  check('高亮真读了 win.document，set→getState→clear→dispose 走完整条链（window 监听挂上又摘干净；当年崩的就是这一步）',
    TOUCHED.win.has('document') && !driveErrors.some((e) => e.startsWith('朗读高亮')),
    `摸到 document=${TOUCHED.win.has('document')}；${driveErrors.join(' | ') || '没有抛错'}`)
  check('三条真代码链路都没抛错', driveErrors.length === 0, driveErrors.join(' | '))
  console.log(`    摸到的成员：win ${[...TOUCHED.win].sort().join(', ')}`)
  console.log(`    摸到的成员：doc ${[...TOUCHED.doc].sort().join(', ')}`)
  console.log(`    摸到的成员：nav ${[...TOUCHED.nav].sort().join(', ')}`)
}

const REAL = { win: win.obj, doc: doc.obj, nav: nav.obj }

// 覆盖面清单 = 文本扫出来的（广，包含没被驱动到的分支）∪ 真跑摸到的（实，扫描坏掉也非空）。
// 两个来源并起来之后，「清单非空」不再需要单独判 —— 它由上面那条「真代码摸到」兜住。
const WANTED = {}
for (const key of ['win', 'doc', 'nav']) {
  WANTED[key] = new Set([...USED[key], ...TOUCHED[key]])
}

console.log('\n每一个环境成员（文本扫出来的 + 真跑摸到的）都从注入环境里拿得到（清单改窄就会红）')
for (const key of ['win', 'doc', 'nav']) {
  const missing = [...WANTED[key]].filter((name) => env[key]?.[name] === undefined)
  check(`${key} 提供全部 ${WANTED[key].size} 个成员（扫文本 ${USED[key].size} + 真摸到 ${TOUCHED[key].size}）`,
    missing.length === 0, missing.length ? `缺：${missing.join(', ')}` : '')
}

// 备注（批次 6l-d 的裁定，展开写在 docs §8.46）：这里**不**再补一条
// 「真摸到的成员都在文本清单里」的判据。它想兜的是「文本扫描被改窄/写歪」，
// 但它本身正是一条源码文本判据（拿真跑的集合去比一份扫出来的清单），
// 加回来等于把这批要清掉的东西换个名字再造一遍。
// 目录级的坏法（`dom/` 改名、没进产物）由 bundle-sync 那条
// 「dom/ 目录里有文件被合并」的下界兜；正则写歪这种坏法现在只剩一个可见症状：
// 上面那三行的「扫文本 N」会掉到 0，覆盖面缩到真摸到的那十几个。

console.log('\n方法是绑回真身的，不是裸方法')
for (const key of ['win', 'doc', 'nav']) {
  for (const name of METHOD_CHECK[key]) {
    const holder = { win, doc, nav }[key]
    const before = holder.calls.length
    try {
      // 故意用一个无关的接收者调用：绑过就忽略它，没绑就记成 Proxy。
      env[key][name].call({ fake: 'receiver' }, () => {})
    } catch (e) {
      check(`${key}.${name} 能被调用`, false, e.message)
      continue
    }
    const last = holder.calls.slice(before).at(-1)
    check(`${key}.${name} 的 this 是真身而非包装对象`, last && last.receiver === REAL[key],
      last ? `实际 this = ${last.receiver === undefined ? 'undefined' : (last.receiver.fake ? '调用方给的接收者' : '别的对象')}` : '没有被调用')
  }
}

console.log('\n同一个方法两次取到的是同一个引用（否则事件解绑配不成对）')
{
  check('win.addEventListener 两次取到同一函数', env.win.addEventListener === env.win.addEventListener)
  check('win.removeEventListener 两次取到同一函数', env.win.removeEventListener === env.win.removeEventListener)
  const handler = () => {}
  env.win.addEventListener('voice-test', handler)
  const added = (listeners['voice-test'] ?? []).length
  env.win.removeEventListener('voice-test', handler)
  const left = (listeners['voice-test'] ?? []).length
  check('经注入环境注册的监听器能被同一条路径摘掉', added === 1 && left === 0, `注册 ${added} 个，摘完剩 ${left} 个`)
  delete listeners['voice-test']
}

console.log('\n诊断通道落真实 window，别的赋值不污染真实 window')
{
  env.win.__DSH_ENV_TEST__ = 42
  check('__DSH_ 开头的赋值出现在真实 window 上', win.obj.__DSH_ENV_TEST__ === 42)
  check('__DSH_ 开头的读取拿的是真实 window 的值', env.win.__DSH_ENV_TEST__ === 42)
  delete env.win.__DSH_ENV_TEST__
  check('__DSH_ 开头的删除作用在真实 window 上', win.obj.__DSH_ENV_TEST__ === undefined)

  env.win.localShadow = 'shadow'
  check('非诊断通道的赋值不会写进真实 window', win.obj.localShadow === undefined)
  check('非诊断通道的赋值仍然能从注入环境读回来', env.win.localShadow === 'shadow')
}

console.log('\n没有 document/navigator 时环境对象为 null，factory 仍能跑（桩环境）')
{
  let ok = true
  let reason = ''
  let nullEnv = null
  try {
    const bare = buildSandbox(false)
    nullEnv = bare.exp.__test.browserEnv
  } catch (e) {
    ok = false
    reason = e.message
  }
  check('factory 在没有 document/navigator 的沙箱里不抛错', ok, reason)
  check('doc / nav 退化为 null', !!nullEnv && !nullEnv.doc && !nullEnv.nav,
    nullEnv ? `doc=${nullEnv.doc} nav=${nullEnv.nav}` : '没拿到 env')
  check('win 仍然存在，但读不到任何浏览器成员', !!nullEnv && !!nullEnv.win && nullEnv.win.document === undefined,
    nullEnv ? `win.document=${nullEnv.win && nullEnv.win.document}` : '没拿到 env')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
