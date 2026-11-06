/**
 * ESLint 配置：开三类规则，别的都不开。
 *   - `no-undef`（全树）—— 主角，理由见下面那段；
 *   - `no-restricted-syntax`（src/client/**）—— 定时器必须走登记表（批次 4 从测试源码扫描搬来）、
 *     路由路径必须走 `pure/routes.js` 的表（批次 6j 从 test/route-contract.test.mjs 的源码扫描搬来）、
 *     数值区间必须走 `rangeFor(key)`（批次 6l-b 从 test/config-contract.test.mjs 的源码正则搬来）、
 *     「聆听中」标志必须走 `mic-button.js` 的 `markListening`（批次 6l-e 从
 *     test/listening-ready.test.mjs 的「数源码里 setOn(true) 出现几次」搬来，见 §8.46）；
 *   - `no-restricted-syntax`（src/host/**）—— 解码循环必须走 `decode-steps.js` 那一处实现
 *     （批次 6k 从 test/decode-guard.test.mjs 的源码扫描搬来，见 §8.44）；
 *   - `no-restricted-imports` + 「globals 清单收窄」（pure/ dom/ shared/）——
 *     环境只能从参数注入（批次 6d 从 test/bundle-sync.test.mjs 的源码正则搬来，见 §8.37）。
 *
 * 为什么只要有这一条（docs/architecture-modernization.md §8.32）：
 *   第 5 步把「@bundle 正则文本内联」换成真 ESM 之后，每个文件的作用域变实了。
 *   内联时代「同一个顶层作用域里随手引用的名字」全部失效，但代码不会报错 ——
 *   它变成运行时的 ReferenceError。装机回归里抓到三处：
 *     - 浮层里裸调 generateId（它是 client-id.js 的闭包局部）→ 发识别文本就炸；
 *     - 浮层漏 import DEFAULT_VAD_OPTIONS → AudioWorklet 和 ScriptProcessor
 *       **两条采集路径都**在 try 里抛 → 浮层永远开不了麦；
 *     - 宿主 preloadInWorker 里 asrPending.set 带了个 `keyPrefix`（从
 *       releaseInWorker 复制过来的死字段，那边有同名局部变量）→ /asr-warmup 恒 500。
 *   这三处 61 个测试文件、322 条 bundle-sync 检查、esbuild 构建全都不报警：
 *   esbuild 把未知标识符当外部全局留着（它不该猜），测试没走到那条分支。
 *   `no-undef` 是唯一能在**构建期**把它们全抓出来的那一道。
 *
 * 代价与解除条件：
 *   - 新增 devDependency eslint（77 个包，只进 devDependencies，发布包不受影响：
 *     package.json 的 files 白名单里没有它）。版本写死 `10.14.0` 而不是 `^10.14.0`：
 *     守卫的输出必须可复现，flat config 的行为在 minor 之间会变过。
 *   - globals 清单要**手动维护**。用到清单外的浏览器/Node 名字时测试会红，
 *     报的就是「'X' is not defined」—— 那时往这里加一个名字，不要往源码里加变量。
 *     这条噪声是有意的：它要求「新环境依赖」必须过一次人的眼睛。
 *   - 若哪天判定这道守卫不值得留：删掉本文件、`npm run lint` 脚本、
 *     test/no-undef.test.mjs 与 devDependencies.eslint 即可，源码不受牵连。
 *
 * 分作用域，是因为「哪边能看见什么全局」本来就该不同：
 *   - `src/client/**` 只能看见浏览器名字；
 *   - `src/host/**` 只能看见 Node 名字；
 *   - `src/client/pure/**` 与 `src/client/dom/**` 看浏览器名字里**去掉环境那几个**（window/document/navigator…）；
 *   - `src/shared/**` 两边都会内联，给「浏览器 ∪ Node」再同样去掉环境名字 ——
 *     也就是**两侧都能安全跑**的那一小撮。
 *   这样宿主代码手滑写 `window` 也一样报 —— 它运行时真的没有；
 *   pure/dom/shared 手滑写 `document` 也一样报 —— Node 侧 import 就是 ReferenceError。
 */

/** 浏览器侧全局（只列这个插件真用到的那些）。 */
const browserGlobals = {
  AudioContext: 'readonly',
  AudioWorkletNode: 'readonly',
  Blob: 'readonly',
  CustomEvent: 'readonly',
  DOMException: 'readonly',
  Element: 'readonly',
  EventSource: 'readonly',
  EventTarget: 'readonly',
  HTMLElement: 'readonly',
  Intl: 'readonly',
  KeyboardEvent: 'readonly',
  MediaRecorder: 'readonly',
  MutationObserver: 'readonly',
  Node: 'readonly',
  ResizeObserver: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  WebSocket: 'readonly',
  Window: 'readonly',
  Worker: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  ReadableStream: 'readonly',
  TransformStream: 'readonly',
  WritableStream: 'readonly',
  BroadcastChannel: 'readonly',
  MessageChannel: 'readonly',
  MessagePort: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  getComputedStyle: 'readonly',
  globalThis: 'readonly',
  localStorage: 'readonly',
  location: 'readonly',
  matchMedia: 'readonly',
  navigator: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  structuredClone: 'readonly',
  sessionStorage: 'readonly',
  window: 'readonly',
}

/** Node 侧全局（宿主跑在 DSH 的 Node worker 里）。 */
const nodeGlobals = {
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Blob: 'readonly',
  Buffer: 'readonly',
  EventSource: 'readonly',
  FormData: 'readonly',
  Intl: 'readonly',
  MessageChannel: 'readonly',
  MessagePort: 'readonly',
  Request: 'readonly',
  ReadableStream: 'readonly',
  Response: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLPattern: 'readonly',
  URLSearchParams: 'readonly',
  WebSocket: 'readonly',
  WritableStream: 'readonly',
  TransformStream: 'readonly',
  ByteLengthQueuingStrategy: 'readonly',
  Console: 'readonly',
  crypto: 'readonly',
  console: 'readonly',
  globalThis: 'readonly',
  performance: 'readonly',
  process: 'readonly',
  queueMicrotask: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  fetch: 'readonly',
  global: 'readonly',
  navigator: 'readonly',
  structuredClone: 'readonly',
  module: 'readonly',
  require: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  exports: 'writable',
}

/** 两侧共用（src/shared 会被内联进两个产物，test/scripts 跑在 Node 里）。 */
const unionGlobals = { ...browserGlobals, ...nodeGlobals }

const js = {
  ecmaVersion: 2024,
  sourceType: 'module',
}

/**
 * 定时器这族**写法禁令**（批次 4 之前住在 test/timer-registry.test.mjs 的源码扫描里，
 * 批次 6i-c 又把「调用点必须先取别名」那条写法判据折进来）。
 * 写法禁令的家是 linter：它跟着文件走、改一行就报，不需要测试去扫整份文本。
 * 测试侧只留「喂一段坏代码给 linter，看它报不报」的集成判据（同目录 timer-registry），
 * 真树由 test/no-undef.test.mjs 全树跑同一条规则。
 */
const TIMER_BANS = [
  {
    selector: 'CallExpression[callee.name=/^(setTimeout|setInterval)$/]',
    message: '定时器要走登记表 timers.timeout / timers.interval（src/client/pure/envelope.js）：裸起的定时器在状态复位/卸载时清不掉，会在你关掉麦克风之后照样把草稿自动发出去。',
  },
  {
    selector: 'CallExpression[callee.property.name=/^(setTimeout|setInterval)$/]',
    message: '同上：win.setTimeout / window.setInterval 也要走登记表（唯一例外是 pure/envelope.js —— 登记表本身与 sleep 住在那里）。',
  },
  {
    selector: 'CallExpression[callee.object.name=\'timers\'][callee.property.name=/^(timeout|interval|clear|clearGroup)$/][arguments.0.type!="Literal"]',
    message: '定时器 id / 组名写死成字符串字面量：登记表按 id 记账，拼错的变量名如果指向另一个合法字符串，运行时不报错、行为测试也测不出。',
  },
  {
    selector: 'CallExpression[callee.object.property.name=\'timers\'][callee.property.name=/^(timeout|interval|clear|clearGroup)$/][arguments.0.type!="Literal"]',
    message: '同上（登记表存在 ref 里的写法）。',
  },
  {
    // 批次 6i-c：上面第 3/4 条认的是 `timers.*` 与 `x.timers.*` 两种形状，
    // 从 ref 里直接取出来调（`timersRef.current.timeout(id, ...)`）是第三种，会从它们眼皮底下过去。
    // 原先靠 test/timer-registry.test.mjs 的一条源码正则逼「调用点先取别名再用」——
    // 那是条写法判据，而且它只扫得到别名写法，真改成链式它反而看不见（探针里原来照实记着这个缺口）。
    // 现在把盲区本身关掉：链式的 timeout / interval 也管，取不取别名从此无所谓。
    //
    // 为什么这条**不含** clear / clearGroup：`*.current.clear()` 在真树上撞上两处无关写法
    // （`readingHighlightRef.current?.clear()` 是朗读高亮，`seenSentenceKeysRef.current.clear()`
    // 是一个 Set 的 clear），而零参数时 `[arguments.0.type!="Literal"]` 也算成立 —— 会误伤。
    // 登记表的 clear 都带字面量 id，链式漏网的那一小撮不值得为它禁掉高亮/Set 的合法写法。
    selector: 'CallExpression[callee.object.property.name=\'current\'][callee.property.name=/^(timeout|interval)$/][arguments.0.type!="Literal"]',
    message: '同上（从 ref 里直接取出来调的写法：timersRef.current.timeout(...)）。定时器 id 写死成字符串字面量。',
  },
]

/**
 * 「路由路径只有一个来源」这一族禁令（批次 6j 起住在 linter 里，见 §8.43）。
 *
 * 为什么必须有它，而不是一条测试里的源码扫描：
 *   `test/route-contract.test.mjs` 判的是「客户端调的路由宿主都得有」。以前客户端
 *   集合靠两条正则从源码里抠，那就得一直扫下去；现在客户端集合是
 *   `src/client/pure/routes.js` 的导出数据，测试只比数据。
 *   **表要保持是唯一来源，缺的是「不许在别处再手写前缀」这条约束** ——
 *   那是写法约定，写法约定的家是 linter（跟定时器那族同一个道理）。
 *   真树上它由 `test/no-undef.test.mjs` 的全树 lint 执行，边界由那里的探针钉住。
 *
 * 锚在**字面量的开头**，不是「文本里出现」：
 *   `pure/i18n.js` 给设置页看的提示文案（「宿主 GET /dsh-voice-typing/diagnostics：…」）
 *   路径在句子中间，那种句子该留着 —— 它是给人读的话，不是调用点。
 *   试过不锚开头的 `value=/dsh-voice-typing\//`，实测会把这两句文案一起报掉。
 */
const ROUTE_PREFIX_BAN = [
  {
    selector: 'Literal[value=/^\\/dsh-voice-typing\\//]',
    message: '路由路径要从 src/client/pure/routes.js 的 ROUTES / ROUTE_PATHS 取（批次 6j）：客户端调了哪些路由是那张表，路由契约测试比的是表里的数据。这里再手写一条，表就不再是唯一来源了。',
  },
  {
    selector: 'TemplateElement[value.raw=/^\\/dsh-voice-typing\\//]',
    message: '同上：模板片段也不许以路由前缀开头，路径名走 ROUTES.xxx（拼接的 query 留在调用点）。',
  },
  {
    // 前缀本身也别在各处重写一遍 —— 它现在只有 ROUTE_BASE 一个出处（main.js 往外传的就是它）。
    selector: 'Literal[value=/^\\/dsh-voice-typing$/]',
    message: '宿主路由前缀要走 src/client/pure/routes.js 的 ROUTE_BASE（批次 6j）：前缀散成多处字面量，route 表和实际请求就可能不是同一套路径。',
  },
]

/**
 * 「解码循环只有一处实现」这一族禁令（批次 6k 起住在 linter 里，见 §8.44）。
 *
 * 为什么必须有它：
 *   `test/decode-guard.test.mjs` 原来那 6 条判据是**扫 src/host/index.js 的源码正则**，
 *   其中一条写着「所有解码循环都加了步数上限」。它数得到的「所有」只有它扫的那一个文件里的
 *   两处 —— 而 `src/host/asr-worker.js` 里那第三处当时**真的没有上限**
 *   （`while (recognizer.isReady(stream)) recognizer.decode(stream)`）。
 *   现在的判据是三条真路径各跑一遍（主线程兜底 / /asr-stream 一帧 / worker 里的 /transcribe），
 *   「有没有第四条没人跑的路」这件事不靠测试再扫一遍源码，靠这里：
 *   循环的写法本身被禁掉，唯一能写它的地方是 `src/host/decode-steps.js`。
 *
 * 为什么锚在「while 的条件里有 isReady 调用」而不是「任何 isReady 引用」：
 *   调用点还要**判断这个包有没有 isReady**（`if (!recognizer.isReady)` 那类属性读取），
 *   那是合法的形状；禁的是把循环自己写出来。四种循环形状（while / do-while × 直接调用 / && 组合）
 *   都在下面，把 isReady 取成别名再调（`const ready = rec.isReady; while (ready(s))`）
 *   仍然逃得过 —— 那是「诚实边界」那条，见 §8.44 与 decode-guard 文件头。
 */
const HOST_DECODE_LOOP_BAN = [
  {
    selector: 'WhileStatement > CallExpression[callee.property.name="isReady"]',
    message: '解码循环要走 src/host/decode-steps.js 的 decodeOnlineStream（批次 6k）：这个 while 少了步数上限就会把跑它的那条线程卡死 —— 主线程是「DSH 闪退」，识别线程是那条 /transcribe 永远不回话（等待侧没有超时）。',
  },
  {
    selector: 'WhileStatement > LogicalExpression > CallExpression[callee.property.name="isReady"]',
    message: '同上：条件里用 && 组合的写法也管（上限与循环就是那一处实现，散成多处就会有一处漏掉上限）。',
  },
  {
    selector: 'DoWhileStatement > CallExpression[callee.property.name="isReady"]',
    message: '同上：do…while 形状也管。',
  },
  {
    selector: 'DoWhileStatement > LogicalExpression > CallExpression[callee.property.name="isReady"]',
    message: '同上：do…while 里 && 组合的写法也管。',
  },
  {
    // 把 isReady 取成属性引用再直接调（`const ready = rec.isReady.bind(rec)` 之后的 ready(stream)）
    // 是第五种形状；名字就叫 isReady 的那一类顺手管掉，起别的名字的逃得过（诚实边界）。
    selector: 'WhileStatement > CallExpression[callee.name="isReady"], WhileStatement > LogicalExpression > CallExpression[callee.name="isReady"]',
    message: '同上：条件里调 isReady 的写法（取出来再调的那种）也走 decodeOnlineStream。',
  },
]

/**
 * 「数值区间只有一个来源」这一族禁令（批次 6l-b 起住在 linter 里，见 §8.46）。
 *
 * 为什么必须有它：
 *   `src/client/pure/config-normalize.js` 里的夹取函数曾经自带数字
 *   （`normalizeNumber(text, { min: 500, max: 5000, … })`），宿主改范围时客户端不会跟着动，
 *   表现是滑杆能拖出 400 / 保存被宿主打回。区间现在只从 `rangeFor(key)` 来（它读宿主 schema）。
 *   守这件事的老判据是 `test/config-contract.test.mjs` 里的一条源码正则
 *   （`matchAll(/normalizeNumber\([^)]*min:\s*\d/g)`），它有两处对不上：
 *   一、判的是**写法**而不是行为，行为侧「夹到 schema 区间」在同文件的逐键循环里已经真跑过了；
 *   二、只认 `min:` 紧贴数字那一种排版，`{ min: 500 }` 换个空格、写成 `{integer: true, min: 500}`
 *      之外再多包一层变量它就看不见（清点器甚至把它报成执行侧，属口径漏报）。
 *   写法约定的家是 linter：跟着文件走、改一行就报，边界由 test/no-undef.test.mjs 的探针钉住。
 *
 * 只禁 `min` / `max` 两个键的数字字面量：`fallback` 是**客户端输入框**自己的兜底值
 * （UI_DEFAULTS 里的常量或写死的默认），不是宿主的区间，禁掉它会误伤真写法。
 */
const RANGE_LITERAL_BAN = [
  {
    selector: 'CallExpression[callee.name="normalizeNumber"] Property[key.name="min"][value.type="Literal"]',
    message: '夹取区间的 min 要从 rangeFor(key) 取（它读宿主 schema，src/shared/config-spec.js）：这里写死一个数字，宿主改范围时客户端不会跟着动，滑杆就能拖出非法值。',
  },
  {
    selector: 'CallExpression[callee.name="normalizeNumber"] Property[key.name="max"][value.type="Literal"]',
    message: '同上：max 也走 rangeFor(key)。',
  },
  {
    // 负数区间（`{ min: -5 }`）的 AST 是 UnaryExpression 而不是 Literal，顺手一起管掉。
    selector: 'CallExpression[callee.name="normalizeNumber"] Property[key.name="min"][value.type="UnaryExpression"] > Literal',
    message: '同上：负数字面量也算写死区间。',
  },
  {
    selector: 'CallExpression[callee.name="normalizeNumber"] Property[key.name="max"][value.type="UnaryExpression"] > Literal',
    message: '同上：负数字面量也算写死区间。',
  },
]

/**
 * 「聆听中」标志只有一个设置点这一族禁令（批次 6l-e 起住在 linter 里，见 §8.46）。
 *
 * 为什么必须有它：
 *   进入「聆听中」之前，模型与麦克风都必须真的就绪（2026-10-31 的装机反馈：
 *   先切界面再开麦，用户说的话整段丢掉）。这件事的**行为**部分由
 *   `test/client-behavior.test.mjs` 场景 12「开麦的时序与就绪判据」逐个分支证（假设备、
 *   可控的 /asr-ready：等模型、模型没就绪、被拒绝、空轨道、ended 轨道、没有设备、无 AudioContext）。
 *   老判据证的是另一件事：`test/listening-ready.test.mjs` 里一条源码正则数
 *   「`setOn(true)` 在客户端真代码里出现几次，必须正好 1 次」。它有两处对不上：
 *   一、写法一改就红（把 `setOn(true)` 拆成 `const v = true; setOn(v)` 就数不到，
 *   而那确实是多了一个设置点）；写法不改而行为坏掉反而绿；
 *   二、它只能数**字面量那一种拼法**，`setOn(alias)`、改名后的 setter 一律看不见。
 *   这条约束本来就不是「跑出来的行为」——它是「全树只有一处能这么写」，
 *   正是 linter 的形状：跟着文件走、在 offending 那一行报、改一行立刻红。
 *
 * 两条一起禁（`setOn(true)` 与 `onRef.current = true`），豁免只给那个具名设置点
 * `markListening`：界面标志与 ref 必须成对出现在同一处，分开写就是「状态与界面分家」。
 *
 * 边界（诚实，见 §8.46 的代价）：锚在名字上。别的文件另起一个 listening 标志
 * （浮层用的就是 `setListening`）这条禁令看不见 —— 它管的是「mic-button 这一个标志
 * 不许有第二处设置点」，不是「全客户端只有一个聆听标志」。
 */
const LISTENING_ON_BAN = [
  {
    selector: 'CallExpression[callee.name="setOn"]:has(> Literal[value=true]):not(VariableDeclarator[id.name="markListening"] *)',
    message: '「聆听中」的界面标志只有一个设置点：src/client/dom/mic-button.js 的 markListening。这里多一处 setOn(true) 就多一处绕过「模型 + 麦克风都就绪」直接进聆听态的地方，而行为测试只会碰到被跑到的那些分支。',
  },
  {
    // ref 那一半：`onRef.current = true` 的 AST 是「赋值 → 右侧字面量」，
    // 与上面那条选择器结构不同，得单列一条。
    selector: 'AssignmentExpression[left.object.name="onRef"][left.property.name="current"] > Literal[value=true]:not(VariableDeclarator[id.name="markListening"] *)',
    message: '同上：onRef.current = true 要和 setOn(true) 成对住在 markListening 里，分开写就是界面与 ref 分家（ref 说在听、界面说没听，或反过来）。',
  },
]

/**
 * 「环境只能从参数注入」这一族禁令（批次 6d 起住在 linter 里，见 §8.37）。
 * 以前它住在 test/bundle-sync.test.mjs 的源码正则里（`!\bwindow\./.test(code)` 那一族，
 * 注释要自己抹平、`typeof` 要自己豁免）；判据本身一个字没改，改的是它住的地方。
 *
 * 写法是**从这些目录的 globals 清单里把环境名字删掉**，而不是再叠一条限制规则：
 *   - 自由变量引用 `document` → 这个名字在这个作用域里根本没绑定 → `no-undef` 直接报，
 *     和「漏 import」同一套机制（这一族判据的本来含义就是「Node 里 import 它会 ReferenceError」）；
 *   - `win.document` / `globalThis.navigator` 这类**属性位置**不算引用，照旧放过 ——
 *     这正是旧判据的边界（旧的正则找的是 `document.` 这种成员访问的左边，
 *     真树上 `const doc = win.document`、`const nav = globalThis.navigator` 都是合法写法）；
 *   - `typeof document !== 'undefined'` 这类防御性检查也放过：`no-undef` 对 typeof 操作数
 *     本来就不报。旧判据明确允许 typeof（dom/ 那节注释写着「允许 typeof 检查」），
 *     试过 `no-restricted-globals` —— 它连 typeof 一起报（实测 5 条），语义比旧判据更严，
 *     所以不用它；试过 `no-restricted-syntax` 的 AST 选择器 —— 属性位置误伤 5 处，也不用。
 *   这三条边界都由 test/no-undef.test.mjs 的内存探针钉住。
 */
const BANNED_ENV_GLOBALS = [
  // 浏览器侧：写了就是「Node 里 import 这个文件会炸」。
  'window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage',
  // Node 侧：写了就是「合进浏览器产物之后那一侧没有」。
  'process', 'require', 'module', 'exports', '__dirname', '__filename', 'Buffer',
  'global', 'setImmediate', 'clearImmediate',
]
/** 从给定 globals 里删掉一批名字，剩下「只能从参数进来的那几个环境」。 */
function withoutGlobals(list) {
  const out = { ...list }
  for (const name of BANNED_ENV_GLOBALS) delete out[name]
  return out
}
const injectedClientGlobals = withoutGlobals(browserGlobals)
const injectedUnionGlobals = withoutGlobals(unionGlobals)

/**
 * `src/client/**` 的语法禁令 = 定时器那族 + 路由前缀那族 + 数值区间那族 + 聆听标志那族。
 */
const CLIENT_SYNTAX_BANS = [...TIMER_BANS, ...ROUTE_PREFIX_BAN, ...RANGE_LITERAL_BAN, ...LISTENING_ON_BAN]

export default [
  {
    // 构建产物（lib/）、第三方内联包（vendor）、依赖与开发期临时文件。
    ignores: ['lib/**', 'node_modules/**', 'src/host/vendor/**', '.tmp*', 'tmp-*'],
  },
  {
    // 整个 src/client/** 用「去掉环境名字」的清单：pure/ dom/ 本来就只能注入，
    // 而 flat config 的 globals 是**多个块相加**（不是后写覆盖），所以收窄必须写在最宽的那一块上，
    // 再由真正需要环境的入口 `main.js` 自己把名字加回来 —— 反过来写等于没收窄。
    files: ['src/client/**/*.js'],
    languageOptions: { ...js, globals: injectedClientGlobals },
    rules: { 'no-undef': 'error' },
  },
  {
    // 入口是唯一「亲手碰浏览器环境」的地方：它把 window/document/navigator 转成注入的
    // browserEnv（forwardEnv 那几行），所以给它完整清单。
    files: ['src/client/main.js'],
    languageOptions: { ...js, globals: browserGlobals },
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['src/client/**/*.js'],
    rules: { 'no-restricted-syntax': ['error', ...CLIENT_SYNTAX_BANS] },
  },
  {
    files: ['src/host/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: { ...js, globals: nodeGlobals },
    rules: { 'no-undef': 'error' },
  },
  {
    // 批次 6k：宿主侧的解码循环只许住在 decode-steps.js 那一处（上面那族的理由写在那儿）。
    files: ['src/host/**/*.js'],
    rules: { 'no-restricted-syntax': ['error', ...HOST_DECODE_LOOP_BAN] },
  },
  {
    // 那一处实现本体：它必须写这个 while，正如登记表必须裸起定时器（pure/envelope.js 同理）。
    // 只摘掉这一族禁令，no-undef 由上面那块照常管着。
    files: ['src/host/decode-steps.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: { ...js, globals: unionGlobals },
    rules: { 'no-undef': 'error' },
  },
  {
    // pure/ 与 dom/：这两块目录**只**要额外的两条 import 禁令；globals 的收窄已经写在
    // 上面那块 `src/client/**` 里了（这里重复列一次是为了让「这两个目录看不见环境名字」
    // 在配置里读得出来，删掉它也不改变行为 —— 因为 globals 是相加的）。
    files: ['src/client/pure/**/*.js', 'src/client/dom/**/*.js'],
    languageOptions: { ...js, globals: injectedClientGlobals },
    rules: {
      'no-undef': 'error',
      'no-restricted-syntax': ['error', ...CLIENT_SYNTAX_BANS],
      // 旧判据里的 `from 'node:'` 与 `\bReact\b` 两条文本正则的等价写法：
      // React 只能从产物的 factory(require) 拿，这两个目录不许 import 它。
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['node:*'], message: '这些模块要被浏览器产物 import，不许引 Node 内置模块。' },
          { group: ['react', 'react-dom', 'react/*'], message: 'React 只能从产物的 factory(require) 拿，纯模块不许直接 import。' },
        ],
      }],
    },
  },
  {
    // shared/：两侧都要用（宿主直接 import、浏览器侧经 pure/ 合并进产物），
    // 所以给「两边交集」——浏览器全局与 Node 全局都不许裸用。
    files: ['src/shared/**/*.js'],
    languageOptions: { ...js, globals: injectedUnionGlobals },
    rules: {
      'no-undef': 'error',
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['node:*'], message: 'shared 会被合进浏览器产物，也会被宿主 import：引 Node 内置模块就是一侧能跑一侧炸。' },
          { group: ['react', 'react-dom', 'react/*'], message: 'React 只能从产物的 factory(require) 拿，shared 不许 import 它。' },
        ],
      }],
    },
  },
  {
    // 登记表的实现就是 win.setTimeout / win.setInterval，sleep 也住在这个文件 —— 豁免它自己。
    // 「登记表外面不许裸起定时器」这条由 test/timer-registry.test.mjs 的 linter 探针守着。
    // 只豁免定时器：环境禁令走的是 globals 清单，这个文件照旧受约束。
    files: ['src/client/pure/envelope.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // 批次 6j：路由表本体就是唯一该写前缀的地方 —— **只**把路由前缀那族摘掉，
    // 其余各族（定时器 / 数值区间 / 聆听标志）在这里逐条列出来照旧生效。
    // 「别的文件不许再手写前缀」由 test/no-undef.test.mjs 的全树 lint + 那里的探针钉住。
    files: ['src/client/pure/routes.js'],
    rules: { 'no-restricted-syntax': ['error', ...TIMER_BANS, ...RANGE_LITERAL_BAN, ...LISTENING_ON_BAN] },
  },
]
