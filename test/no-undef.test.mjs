/**
 * 守卫：源码里不许出现「没绑定的标识符」（ESLint `no-undef`），以及三类纯目录的
 * **环境禁令**真的在生效（`no-restricted-imports` + globals 清单收窄）。
 *
 * 为什么专门有这道守卫（docs/architecture-modernization.md §8.32、§8.37）：
 *
 * 第 5 步（`4529e89`）把浏览器侧的「@bundle 正则文本内联」换成真 ESM import 图。
 * 内联时代所有源文件拼在同一个顶层作用域里，跨文件随手引用名字是**能跑的**；
 * 换成真模块之后作用域变实，那些没 import 的名字当场变成运行时的
 * `ReferenceError` —— 而构建不报错、测试也不报错（没走到那条分支）。
 *
 * 装机回归里抓到三处，全都是这一类：
 *   1. `src/client/dom/global-voice-overlay.js` 裸调 `generateId('req')`
 *      （`generateId` 是 `dom/client-id.js` 里 `createClientId` 的闭包局部）
 *      → 浮层发送识别文本时抛。
 *   2. 同文件漏 import `DEFAULT_VAD_OPTIONS`（它 export 在 `pure/global-voice.js`）
 *      → AudioWorklet 与 ScriptProcessor **两条采集路径都在 try 里抛**
 *      → 浮层永远开不了麦，而且失败被 `catch { return false }` 咽掉了。
 *   3. `src/host/index.js` 的 `preloadInWorker` 里 `asrPending.set(id, { keyPrefix, … })`
 *      （`keyPrefix` 是从 `releaseInWorker` 复制来的死字段，只有那边才有同名局部变量）
 *      → `new Promise(executor)` 把 executor 的同步抛转成 rejection，
 *        外面那层 `try/catch` 抓不到 → `/asr-warmup` 恒 500、启动预加载恒静默失败、
 *        客户端开麦前的「确保模型就绪」拿到 500 直接报「模型加载失败」。
 *
 * 三处的共同点：**只有真的调用到那行代码才会暴露**。61 个测试文件、
 * 322 条 bundle-sync 检查、esbuild 构建全绿。esbuild 把未知标识符原样留着
 * 是对的（它无权猜那是不是外部全局），所以这一类必须由一个**懂作用域**的工具查。
 *
 * 断言：
 *   - eslint 必须装着（没装 = 这道守卫等于没跑，直接判失败，不许静默跳过）；
 *   - `src/ test/ scripts/` 全树跑配置里**开着的每一条规则**，零 error；
 *   - 探针：喂一段用了没绑定名字的代码给同一条规则，它必须报（防止配置写错导致「永远绿」）；
 *   - 批次 6d 起再加五探针，钉住 pure/ dom/ shared/ 那批环境禁令的四条边界
 *     （裸用环境名字要报、`typeof` 防御要放过、属性位置要放过、`node:*` 与 react 的
 *     import 要报、而入口 `main.js` 自己碰 window 不算违规）。
 *     这五条边界是从 `test/bundle-sync.test.mjs` 的源码正则里抄过来的语义 ——
 *     判据没变，只是搬了个会懂作用域的家。
 *   - 批次 6j 起再加五探针，钉住**路由前缀禁令**的边界（字面量要报、模板片段要报、
 *     光把前缀重写一遍也要报；给人看的提示文案不报；路由表本体 `pure/routes.js` 是唯一豁免处）。
 *     这族禁令的前提是「客户端路由集合 = `pure/routes.js` 那张表」，
 *     契约判据本身在 `test/route-contract.test.mjs`，那边只比数据、不再扫源码。
 *   - 批次 6k 起再加五探针，钉住**解码循环禁令**（HOST_DECODE_LOOP_BAN）的边界：
 *     while 与 do…while 两种形状要报、worker 里那种「裸 while isReady 没有上限」要报
 *     （老的 decode-guard 扫 index.js，那处从来不在它视野里）、
 *     `src/host/decode-steps.js` 那一处实现本体豁免、只判断包有没有 isReady 的属性读取放过。
 *     三路径真跑的判据在 `test/decode-guard.test.mjs`，这里只管「别处不许再手写第四裸循环」。
 *   - 批次 6l-b 起再加五条探针，钉住**数值区间禁令**（RANGE_LITERAL_BAN）的边界：
 *     `{ min: 500 }` 要报、`{ min: -5 }`（负数是另一种 AST 节点）也要报、
 *     从 `rangeFor(key)` 解构出来的写法不报、`fallback` 写数字不报（那是客户端输入框自己的兜底值，
 *     不是宿主区间）、宿主侧不受这条管（schema 本来就是数值的出处）。
 *     这族禁令接管的是 `test/config-contract.test.mjs` 里那条源码正则 ——
 *     它找的是 `min:` 紧跟数字，负区间从它眼下过去；而且清点器把它报成执行侧（口径漏报），
 *     判的其实一直是源码文本。夹取**行为**的判据在 config-contract 的逐键循环里，没动。
 *   - 批次 6l-e 起再加九条探针，钉住**聆听标志禁令**（LISTENING_ON_BAN）的边界：
 *     `setOn(true)` 与 `onRef.current = true` 只许住在具名的 `markListening` 里 ——
 *     豁免里那一处不报、外面再多一处要报、两处并存时只报外面那一处（行号也核对）、
 *     把设置点改名（markListening2）要报（豁免锚在名字上）、`setOn(false)` 不误伤、
 *     另起一个 listening 标志（浮层那份 `setListening`）这条禁令看不见 —— 明确探针成「不报」，
 *     这是已知边界（见 §8.46 的代价），不是漏配。顺带一条：`pure/routes.js` 的豁免块
 *     只摘路由前缀那一族，数值区间禁令在它还照管。
 *     「只有一个设置点」的**行为**侧（就绪之前不进聆听态）在
 *     `test/client-behavior.test.mjs` 场景 12，这里只管「别处不许再有第二处写法」。
 *
 * globals 清单在 `eslint.config.js`，是**手写的**。用到清单外的浏览器/Node 名字时
 * 这里会红并报「'X' is not defined」—— 那时改清单，不要改源码去绕它。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}
/**
 * 把 eslint 的结果压成「文件:行:列 信息」。
 *
 * 注意：`LintResult.messages` 里**没有** `filePath`（它在 result 上），
 * 所以先拍平成 {file, message} 对，别一 map 到底再取 m.filePath —— 那是 undefined。
 */
function summarize(messages, limit = 25) {
  return messages
    .map(({ file, message }) => `${path.relative(root, file)}:${message.line}:${message.column} ` +
      `${message.message}` + (message.ruleId ? ` [${message.ruleId}]` : ''))
    .slice(0, limit)
    .join('\n    ')
}

let ESLint = null
try {
  ;({ ESLint } = await import('eslint'))
} catch {
  ESLint = null
}
check('eslint 可用（这道守卫不许静默跳过）', ESLint !== null,
  'devDependencies 里的 eslint 没装上：跑 pnpm install / npm install 之后再测')

if (ESLint) {
  const run = async (patterns) => {
    // useEslintrc 不存在于 flat config 时代；eslint 9+ 自动读 cwd 下的 eslint.config.js。
    const eslint = new ESLint({ cwd: root, errorOnUnmatchedPattern: false })
    const results = await eslint.lintFiles(patterns)
    const errors = results.flatMap((r) => r.messages
      .filter((m) => m.severity === 2)
      .map((m) => ({ file: r.filePath, message: m })))
    return { errors, files: results.length }
  }

  const { errors, files } = await run(['src', 'test', 'scripts'])
  console.log(`lint 覆盖 ${files} 个文件`)
  check('src/test/scripts 全树零 error（no-undef + 定时器禁令 + 三类目录的环境禁令）',
    errors.length === 0, errors.length ? summarize(errors) : '')

  // 解析错误也会以 severity 2 + ruleId null 的形式出现，上面那条已经含住了；
  // 这里单独分一类，是为了让「配置文件写错」和「源码有未定义引用」报错长得不一样。
  const parseErrors = errors.filter((e) => e.message.ruleId === null)
  check('eslint 配置本身能解析所有文件（不是靠解析失败冒充通过）',
    parseErrors.length === 0, parseErrors.length ? summarize(parseErrors) : '')

  // 探针：喂一段「用了没绑定的名字」的代码给同一条规则，它必须报。
  // 用内存里的 fixture，不改生产文件 —— 这条判的是「配置有没有真的生效」，
  // 「真树干净不干净」由上面那条全树 lint 负责。
  {
    const eslint = new ESLint({ cwd: root, errorOnUnmatchedPattern: false })
    const [result] = await eslint.lintText(
      'export const go = () => __definitelyNotDefined__(1)\n',
      { filePath: 'src/client/pure/probe.js' },
    )
    const hits = (result?.messages ?? []).filter((m) => m.severity === 2)
    check('探针：用了没绑定的名字，no-undef 会报（防止配置写错导致永远绿）',
      hits.some((m) => /__definitelyNotDefined__/.test(m.message)),
      hits.map((m) => m.message).join(' | ') || '没抓到 → 配置或作用域写错了')
  }

  // 批次 6d：pure/ dom/ shared/ 的「环境只能从参数注入」从源码正则搬进配置之后，
  // 这七条探针钉住搬过来的**边界**（全树那条只证明「现在的代码合规」，
  // 证明不了「配置真的会管」—— 写错 globals 的话它会永远绿）。
  // 判据名字里带的就是旧判据原话，方便对着 `test/bundle-sync.test.mjs` 的历史看有没有丢东西。
  {
    const eslint = new ESLint({ cwd: root, errorOnUnmatchedPattern: false })
    const probe = async (code, filePath) => {
      const [result] = await eslint.lintText(code, { filePath })
      return (result?.messages ?? []).filter((m) => m.severity === 2)
    }
    const cases = [
      {
        name: '探针：pure/ 里裸用 window，守卫会报（旧判据「不依赖浏览器全局」）',
        code: 'export const f = () => window.foo()\n',
        filePath: 'src/client/pure/probe.js',
        want: true,
      },
      {
        name: '探针：dom/ 里裸用 document，守卫会报（旧判据「环境全部来自注入」）',
        code: 'export const d = document\n',
        filePath: 'src/client/dom/probe.js',
        want: true,
      },
      {
        name: '探针：typeof 防御不算违规（旧判据明确放过 typeof）',
        code: 'export const ok = typeof document !== "undefined"\n',
        filePath: 'src/client/dom/probe.js',
        want: false,
      },
      {
        name: '探针：从注入对象上取属性不算违规（win.document 是设计本身）',
        code: 'export const g = (win) => win.document\n',
        filePath: 'src/client/dom/probe.js',
        want: false,
      },
      {
        name: '探针：shared/ 引 node: 内置模块会被报（旧判据「不依赖 Node API」）',
        code: 'import fs from "node:fs"\nexport const x = fs\n',
        filePath: 'src/shared/probe.js',
        want: true,
      },
      {
        name: '探针：纯模块 import react 会被报（旧判据「不依赖 React」）',
        code: 'import React from "react"\nexport const y = React\n',
        filePath: 'src/client/pure/probe.js',
        want: true,
      },
      {
        name: '探针：入口 main.js 自己碰 window 不报（收窄没误伤真正需要环境的地方）',
        code: 'export const w = () => window.addEventListener("x", y)\nfunction y() {}\n',
        filePath: 'src/client/main.js',
        want: false,
      },
      // 批次 6j：路由前缀禁令（ROUTE_PREFIX_BAN）的四条边界。
      // 这三条判的是「表还是不是客户端路由的唯一来源」—— 是 route-contract 那条数据判据的前提，
      // 前提由 linter 钉，不靠测试再扫一遍源码。
      {
        name: '探针：dom/ 里手写路由字面量会被报（路由只能从 pure/routes.js 的表取）',
        code: 'export const u = () => fetch("/dsh-voice-typing/new-route")\n',
        filePath: 'src/client/dom/probe.js',
        want: true,
      },
      {
        name: '探针：模板片段以路由前缀开头同样被报（带 query 的写法也管）',
        code: 'export const u = (q) => fetch(`/dsh-voice-typing/new-route?x=${q}`)\n',
        filePath: 'src/client/dom/probe.js',
        want: true,
      },
      {
        name: '探针：把前缀本身重写一遍也会被报（前缀只有 ROUTE_BASE 一个出处）',
        code: 'export const base = "/dsh-voice-typing"\n',
        filePath: 'src/client/main.js',
        want: true,
      },
      {
        name: '探针：给人看的提示文案里带路径不报（禁令锚在字面量开头）',
        code: 'export const hint = "宿主 GET /dsh-voice-typing/diagnostics：包含朗读调度器状态"\n',
        filePath: 'src/client/pure/probe.js',
        want: false,
      },
      {
        name: '探针：路由表本体写前缀不报（唯一豁免处）',
        code: 'export const ROUTE_BASE = "/dsh-voice-typing"\nexport const p = "/dsh-voice-typing/config"\n',
        filePath: 'src/client/pure/routes.js',
        want: false,
      },
      // 批次 6k：解码循环禁令（HOST_DECODE_LOOP_BAN）。老的 decode-guard 扫 index.js，
      // 于是 worker 里那处**没有上限**的裸 while 从来不在它的视野里 ——
      // 下面第二条探针钉的就是那个形状，钉在会真的报它的地方。
      {
        name: '探针：宿主里自己写解码循环会被报（循环与上限只有 decode-steps.js 那一处实现）',
        code: 'export const run = (rec, s) => { let n = 0; while (rec.isReady(s) && n++ < 5) rec.decode(s) }\n',
        filePath: 'src/host/index.js',
        want: true,
      },
      {
        name: '探针：worker 里那种「裸 while isReady、没有上限」同样被报（老判据看不见这一处的那个形状）',
        code: 'export const run = (rec, s) => { while (rec.isReady(s)) rec.decode(s) }\n',
        filePath: 'src/host/asr-worker.js',
        want: true,
      },
      {
        name: '探针：do…while 形状也报（换个关键字不算绕过去）',
        code: 'export const run = (rec, s) => { let n = 0; do { rec.decode(s); n++ } while (rec.isReady(s) && n < 5) }\n',
        filePath: 'src/host/index.js',
        want: true,
      },
      {
        name: '探针：decode-steps.js 本体写这个循环不报（唯一豁免处）',
        code: 'export const MAX = 2\nexport const run = (rec, s) => { let n = 0; while (rec.isReady(s) && n++ < MAX) rec.decode(s) }\n',
        filePath: 'src/host/decode-steps.js',
        want: false,
      },
      {
        name: '探针：只是判断这个包有没有 isReady（属性读取）不报（调用点还需要这个分支）',
        code: 'export const has = (rec) => typeof rec.isReady === "function"\n',
        filePath: 'src/host/index.js',
        want: false,
      },
      // 批次 6l-b：数值区间禁令（RANGE_LITERAL_BAN）。老判据是 config-contract 里的一条源码正则，
      // 只认 `normalizeNumber(… min: 500` 紧贴的那一种排版；这里钉新禁令的四条边界。
      {
        name: '探针：客户端把 min 写成数字字面量会被报（区间只能从 rangeFor 来）',
        code: 'export const f = (n) => normalizeNumber(n, { min: 500, max: 5000, fallback: 0 })\nfunction normalizeNumber(v, o) { return o }\n',
        filePath: 'src/client/pure/probe.js',
        want: true,
      },
      {
        name: '探针：负数区间（UnaryExpression）同样被报（换个符号不算绕过去）',
        code: 'export const f = (n) => normalizeNumber(n, { min: -5, max: 5000, fallback: 0 })\nfunction normalizeNumber(v, o) { return o }\n',
        filePath: 'src/client/pure/probe.js',
        want: true,
      },
      {
        name: '探针：区间从 rangeFor 解构出来不报（这就是唯一合规写法）',
        code: 'const { min, max } = rangeFor("silenceMs")\nexport const f = (n) => normalizeNumber(n, { min, max, fallback: 0 })\nfunction normalizeNumber(v, o) { return o }\nfunction rangeFor() { return { min: 0, max: 1 } }\n',
        filePath: 'src/client/pure/probe.js',
        want: false,
      },
      {
        name: '探针：fallback 写数字不报（它是客户端输入框自己的兜底值，不是宿主区间）',
        code: 'const r = rangeFor("silenceMs")\nexport const f = (n) => normalizeNumber(n, { ...r, fallback: 800 })\nfunction normalizeNumber(v, o) { return o }\nfunction rangeFor() { return { min: 0, max: 1 } }\n',
        filePath: 'src/client/pure/probe.js',
        want: false,
      },
      {
        name: '探针：宿主侧写死区间不报（这条禁令只管客户端，宿主的 schema 本来就是数值的出处）',
        code: 'export const f = (n) => normalizeNumber(n, { min: 500, max: 5000, fallback: 0 })\nfunction normalizeNumber(v, o) { return o }\n',
        filePath: 'src/host/index.js',
        want: false,
      },
      // 批次 6l-e：聆听标志禁令（LISTENING_ON_BAN）。老判据是 listening-ready 里数
      // 「`setOn(true)` 出现几次」的那条源码正则；下面这批钉新禁令的边界。
      // 探针代码都自己声明 setOn / onRef —— 不声明的话 no-undef 会先报，
      // 「有没有报」就不等于「这族禁令有没有生效」了。
      {
        name: '探针：markListening 里那一处 setOn(true) + onRef.current = true 不报（唯一豁免处）',
        code: 'const [on, setOn] = [false, () => {}]\nconst onRef = { current: false }\nexport const markListening = () => { onRef.current = true; setOn(true) }\nvoid on\n',
        filePath: 'src/client/dom/probe.js',
        want: false,
      },
      {
        name: '探针：豁免之外再多一处 setOn(true) 要报（多一个设置点就多一条绕过就绪判据的路）',
        code: 'const [on, setOn] = [false, () => {}]\nconst onRef = { current: false }\nexport const markListening = () => { onRef.current = true; setOn(true) }\nexport const alsoOn = () => setOn(true)\nvoid on\n',
        filePath: 'src/client/dom/probe.js',
        want: true,
      },
      {
        name: '探针：onRef.current = true 单写在豁免外也要报（界面与 ref 必须成对）',
        code: 'const onRef = { current: false }\nexport const bad = () => { onRef.current = true }\n',
        filePath: 'src/client/dom/probe.js',
        want: true,
      },
      {
        name: '探针：把设置点改名（markListening2）就没了豁免（豁免锚在名字上）',
        code: 'const [on, setOn] = [false, () => {}]\nconst onRef = { current: false }\nexport const markListening2 = () => { onRef.current = true; setOn(true) }\nvoid on\n',
        filePath: 'src/client/dom/probe.js',
        want: true,
      },
      {
        name: '探针：setOn(false) 与 onRef.current = false 不误伤（关聆听态有十处，那是正常写法）',
        code: 'const [on, setOn] = [false, () => {}]\nconst onRef = { current: false }\nexport const off = () => { onRef.current = false; setOn(false) }\nvoid on\n',
        filePath: 'src/client/dom/probe.js',
        want: false,
      },
      {
        name: '探针：禁令只认字面量，把 true 提成变量再 setOn(v) 报不出来（已知边界，见 §8.46 代价）',
        code: 'const [on, setOn] = [false, () => {}]\nconst yes = true\nexport const bad = () => setOn(yes)\nvoid on\n',
        filePath: 'src/client/dom/probe.js',
        want: false,
      },
      {
        name: '探针：别的文件另起一个聆听标志（浮层那份 setListening）这族禁令看不见（已知边界）',
        code: 'const [listening, setListening] = [false, () => {}]\nexport const on2 = () => setListening(true)\nvoid listening\n',
        filePath: 'src/client/dom/probe2.js',
        want: false,
      },
      {
        name: '探针：routes.js 的豁免只摘前缀那族，数值区间禁令在它还照管（防止豁免块少列一族）',
        code: 'export const f = (n) => normalizeNumber(n, { min: 500, max: 5000, fallback: 0 })\nfunction normalizeNumber(v, o) { return o }\n',
        filePath: 'src/client/pure/routes.js',
        want: true,
      },
    ]
    for (const c of cases) {
      const hits = await probe(c.code, c.filePath)
      check(c.name, (hits.length > 0) === c.want,
        hits.length ? hits.map((m) => m.message).join(' | ') : '一条都没报')
    }

    // 上面那批只判「报没报」。这一条判**报几处、报在哪一行**：
    // 豁免写歪了会把合法那处一起报（两条），禁令写歪了会一条都不报 —— 两种都不算守住。
    const both = await probe(
      'const [on, setOn] = [false, () => {}]\n'
      + 'const onRef = { current: false }\n'
      + 'export const markListening = () => { onRef.current = true; setOn(true) }\n'
      + 'export const alsoOn = () => setOn(true)\nvoid on\n',
      'src/client/dom/probe.js',
    )
    check('探针：豁免里一处 + 豁免外一处，只报豁免外那一处（第 4 行，一条不多一条不少）',
      both.length === 1 && both[0].line === 4,
      both.map((m) => `第 ${m.line} 行 ${String(m.message).slice(0, 20)}`).join(' | ')
      || '一条都没报')
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed) process.exitCode = 1
