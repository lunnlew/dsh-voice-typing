/**
 * 「源码形状断言」清点器 —— 数一数 `test/*.test.mjs` 里还有多少条断言
 * 是在**对源码文本做正则/包含判断**，而不是在跑行为。
 *
 * 为什么要这么麻烦（而不是 grep 一下 `match(/`）：
 *   一个断言属于哪一类，看的是它的**判据落在什么对象上**，不是它写了什么关键字。
 *   `check('浮层有 AudioContext 守卫', /createAudioContext/.test(code))` 是形状断言；
 *   `check('浮层有 AudioContext 守卫', dbg().on === false)` 是行为断言 —— 两者字面一样长。
 *   所以这里按「变量来源」追一遍：从读文件的表达式出发，顺着赋值链往下传
 *  （`const lines = code.split('\n')` 也还是源），再看断言实参有没有碰到这些变量。
 *
 * 三类口径（这是给人看的分档，不是机器裁决）：
 *   - 源码文本   —— 判据落在 `src/**.js` 的写法上。这次要清的就是它：
 *                  能跑出来的改成单元/集成/端到端，纯写法直接删。
 *   - 产物文本   —— 判据落在 `lib/**.js` 的字节上（构建产物同步、发布清单、metafile）。
 *                  这一类**天然就是静态检查**，不在清理范围里。
 *   - 执行侧     —— 判据落在真跑出来的值上（含起真 worker、真发 HTTP 的集成）。
 *
 * 用法：
 *   node scripts/count-shape-assertions.mjs                每个文件各档的数量 + 汇总
 *   node scripts/count-shape-assertions.mjs --list         列出「源码文本」那几条的断言名
 *   node scripts/count-shape-assertions.mjs --sample 5     抽样打印判据原文，用来核分档准不准
 *   node scripts/count-shape-assertions.mjs --trace 上限   打印某条判据（断言名或行号）的污点链，
 *                                                          任何一档都能追 —— 漏报就藏在「执行侧」里
 *   node scripts/count-shape-assertions.mjs --json         机器可读（趋势对比用）
 *   node scripts/count-shape-assertions.mjs --only config-ui
 *
 * 已知是启发式的几处（每一条都是被实测顶出来的，别当成可以随手简化的地方）：
 *   1) 变量解析只做两层：「当前作用域的形参 → 回到它所在函数的调用点看实参」，
 *      以及「不是形参就取断言之前最近的一次声明」。完整的闭包/块级作用域推导没有做，
 *      所以同名变量在相邻函数之间的连线仍可能判错 —— --trace 是用来核这个的；
 *   2) 本地文本加工函数（stripNoise / sanitize 这类）按「被带污点实参调用过」整体判污；
 *   3) 跨文件 helper（blockOf 之类）靠名字认，不跟到实现里；
 *   4) 判据落在**函数值本身**上（`typeof collect === 'function'`）时不进它的函数体 ——
 *      收集/加工函数的体里出现 SRC 是常态，连进去就是一整批误报；
 *   5) 写在循环里的一条判据静态只能数到 1，所以「执行侧」是**下界**，
 *      报告里带一句「循环内 N 处」让这个下界看得见；
 *   6) 所有「这段代码里有没有某个标识符 / 某句读文件」的检测都在**注释抹平 + 字面量抹平**
 *      的等长文本上做（view / codeText），找到位置后再回原文读实参。试过反过来偷懒：
 *      在带字面量的文本上扫，字符串里那句 `check('…')` 就成了假调用点，模板串里那句
 *      `maxLen=${SRC}` 成了假赋值点，判据文本里的 `/const X = (\d+)/` 成了假声明。
 *      也试过**更激进**的抹平（blankNestedBodies：取标识符前先把嵌套函数体抹掉），
 *      那会把「在嵌套函数里捕获自由变量」的真判据一起抹没（config-writeback 实测漏报），
 *      所以那条已经删掉，改成按标识符所在最内层函数逐个解析。
 *   它给的是**趋势和入口清单**，每条要不要搬、搬成哪一档还得人看 —— 所以有 --sample/--trace。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEST_DIR = path.join(ROOT, 'test')

/**
 * 「源码/产物文本」的来源：读文件的 helper、直接 readFileSync、块提取器。
 *
 * readFileSync 那两条为什么写成「目录名 + 分隔符」两种形态：仓库里路径拼法有三种
 * （`root + '/src/client/x.js'`、`` `${root}/src/client/${f}` ``、`join(root, 'src', 'client', …)`），
 * 只认带斜杠的那一种会把后两种判成执行侧 —— 那是**漏报**，比虚高更危险
 * （待清理项会躲在「执行侧」那一栏里不出声）。fixture 测试里钉着这三条。
 */
const READERS = [
  { kind: 'src', re: /\b(clientSource|pureSourceFiles|domSourceFiles)\s*\(/ },
  { kind: 'src', re: /\bhostSource[A-Za-z]*\s*\(/ },
  { kind: 'src', re: /\bblockOf\s*\(/ },
  { kind: 'src', re: /\breadFileSync\s*\([^)]*\bsrc[/'"`]/ },
  { kind: 'src', re: /\bjoin\s*\([^)]*\bsrc[/'"`]/ },
  { kind: 'lib', re: /\breadFileSync\s*\([^)]*\blib[/'"`]/ },
  { kind: 'lib', re: /\bjoin\s*\([^)]*\blib[/'"`]/ },
  { kind: 'lib', re: /\b(BUNDLE|ARTIFACT|LIB_CLIENT|clientBundle)\b/ },
]

/**
 * 跳过一个字符串 / 模板 / 注释 / 正则字面量，返回结束后的下标。
 * 不跳这些的话，判据里的 `/(?:const|let)\s*\(/` 会把括号深度算乱，
 * 表达式边界就会切错 —— 这正是上一版把 749 条虚报出来的地方之一。
 */
function literalEnd(text, i) {
  const ch = text[i]
  const next = text[i + 1]
  if (ch === '/' && next === '/') {
    // 停在换行**上**（不含）：行注释不许把下一行也吃掉。上一版返回 nl + 1，于是
    // `const m = new Map()   // 说明` 后面的 for 循环被并进这条声明的表达式，
    // 循环里那句 readFileSync 就把整条链染成「源码文本」了（漏报→误报各来一遍）。
    const nl = text.indexOf('\n', i)
    return nl < 0 ? text.length : nl
  }
  if (ch === '/' && next === '*') {
    const end = text.indexOf('*/', i + 2)
    return end < 0 ? text.length : end + 2
  }
  if (ch === '"' || ch === "'") {
    let j = i + 1
    while (j < text.length) {
      if (text[j] === '\\') j += 2
      else if (text[j] === ch || text[j] === '\n') return j + 1
      else j += 1
    }
    return text.length
  }
  if (ch === '`') {
    let j = i + 1
    let depth = 0
    while (j < text.length) {
      if (text[j] === '\\') { j += 2; continue }
      if (text[j] === '$' && text[j + 1] === '{') { depth++; j += 2; continue }
      if (depth > 0 && text[j] === '}') { depth--; j++; continue }
      if (text[j] === '`' && depth === 0) return j + 1
      j += 1
    }
    return text.length
  }
  if (ch === '/') return regexEnd(text, i)
  return -1
}

/** 正则字面量：只有前一个有效字符允许「这里该是一个值」时，`/` 才是开正则。 */
function regexEnd(text, i) {
  let k = i - 1
  while (k >= 0 && /\s/.test(text[k])) k -= 1
  const prev = k >= 0 ? text[k] : ''
  if (prev && !/[(,=:[!&|?{};+*/%~^<>]/.test(prev)) return -1
  let j = i + 1
  let inClass = false
  while (j < text.length) {
    const c = text[j]
    if (c === '\\') { j += 2; continue }
    if (c === '\n') return -1
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) {
      j += 1
      while (j < text.length && /[gimsuyd]/.test(text[j])) j += 1
      return j
    }
    j += 1
  }
  return -1
}

/** 行尾是运算符 / 逗号 / 开括号 —— 表达式还没写完。 */
const CONTINUES_EOL = /(?:[,;:&|.?([{}]|=>|\+\+|--|===?|!==?|\breturn|\btypeof|\bawait|\bcase)$/
/** 下一行以延续符开头（成员链、闭括号、三元/逻辑续行）。 */
const CONTINUES_SOL = /^(?:\.\w|\.\.\.|=>|[.?!]|\)|\]|\}|&&|\|\||[+\-*/%<>=!&|^:])/

/**
 * 把注释抹成空格（长度不变、换行不动），字符串与正则字面量原样保留。
 *
 * 为什么单独要它（而不是复用 stripLiterals）：判「表达式写完没写完」看的是**行尾和
 * 下一行行首**，而注释会污染这两处 —— 上一版把 `event-envelope` 的执行侧断言算成
 * 源码形状断言，就是因为
 *   `const { buildEventEnvelope } = await import('../lib/index.js')`
 * 后面跟了一行说明注释，那行以斜杠开头，撞上 CONTINUES_SOL 的运算符字符集，
 * 于是把再下面的 `hostSource('index')` 一起吞进了这条声明的表达式里。
 */
export function blankComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '/' && (next === '/' || next === '*')) {
      const end = literalEnd(text, i)
      out += text.slice(i, end).replace(/[^\n]/g, ' ')
      i = end
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = literalEnd(text, i)
      out += text.slice(i, end)
      i = end
      continue
    }
    if (ch === '/') {
      // 先认正则，否则 `x.replace(/\/\//, …)` 里的双斜杠会被当成行注释吃掉半行。
      const end = regexEnd(text, i)
      if (end > i) {
        out += text.slice(i, end)
        i = end
        continue
      }
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * 从 `=` 后面（或 `(` 后面）读一个表达式：按括号深度走，深度 0 遇到 `;`、
 * 配对的闭括号、或「行尾行首都不要求续行」的换行，就算结束。
 * 续行判断一律用 `view`（注释已抹平）—— 注释不参与语法，不该左右边界。
 */
export function readExpression(text, from, view = blankComments(text)) {
  let depth = 0
  let i = from
  while (i < text.length) {
    const end = literalEnd(text, i)
    if (end > i) { i = end; continue }
    const ch = text[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return text.slice(from, i)
      depth--
    } else if (ch === ';' && depth === 0) {
      return text.slice(from, i)
    } else if (ch === '\n' && depth === 0) {
      const lineStart = view.lastIndexOf('\n', i - 1) + 1
      const before = view.slice(lineStart, i).trimEnd()
      let j = i + 1
      while (j < view.length && /\s/.test(view[j])) j += 1
      const nextLine = view.slice(j, j + 3)
      const needsMore = CONTINUES_EOL.test(before) || CONTINUES_SOL.test(nextLine)
      if (before && !needsMore) return text.slice(from, i)
    }
    i += 1
  }
  return text.slice(from)
}

function referencesName(expr, name) {
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`)
  return re.test(expr)
}

/**
 * 把字符串 / 模板 / 注释 / 正则字面量抹成空格（长度不变，行号照旧）。
 * 找「表达式里引用了哪些变量」必须用它：断言的**名字**里经常直接写出被检查的
 * 标识符（`check('浮层 import 了 GLOBAL_VAD_PROCESSOR', ...)`），
 * 不抹掉的话每条断言的文案都会把自己的变量名带脏。
 */
function stripLiterals(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const end = literalEnd(text, i)
    if (end > i) {
      out += text.slice(i, end).replace(/[^\n]/g, ' ')
      i = end
      continue
    }
    out += text[i]
    i += 1
  }
  return out
}

/** 表达式里出现的变量名，带回每个名字在原文里的偏移（分档要按**它自己所在位置**查作用域）。 */
function identifierSites(codeOnly) {
  const out = []
  for (const m of codeOnly.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])(?!\s*:)/g)) out.push({ name: m[1], offset: m.index })
  return out
}

/** 表达式里出现的变量名（跳过对象字面量的键 `k:` 和属性访问 `.k`）。 */
function identifiersOf(codeOnly) {
  return identifierSites(codeOnly).map((s) => s.name)
}

/** 形参表里有没有这个名字（解构写法 `{ tune = null }` 里的名字也算）。 */
function paramsMention(params, name) {
  return identifiersOf(stripLiterals(params)).includes(name)
}

/**
 * 这条表达式本身是不是「一个函数值」（`async (a, b) => {…}` / `function (…) {…}`）。
 *
 * 为什么要单独认（批次 6b 的第二处漏判）：`readExpression` 读 `const helper = async (…) => { … }`
 * 会把**整个函数体**当成这个变量的来源文本，于是体内那些跟本次判断无关的名字
 * （edge-tts 里的 `code ← SRC.replace(...)` ← `hostSource('edge-tts')`）会被连成一条污点链，
 * 把 8 条行为判据报成源码文本。函数值的「内容」是它**返回什么**，由调用点决定，
 * 不在这里连文本；真返回源码文本的那类（`const getSrc = () => readFileSync(…)`）
 * 由第 2 步的本地文本函数表按调用点认。
 *
 * 判据只认「表达式开头就是函数」，`src.split('\n').map((l) => l.trim())` 这种
 * 箭头出现在后面的不算 —— 它判的是文本，砍掉就成漏报了。
 */
function isFunctionValue(expr) {
  const code = blankComments(expr).replace(/^\s+/, '')
  if (/^(?:async[ \t\r\n]+)?function\b/.test(code)) return true
  const m = /^(?:async[ \t\r\n]+)?(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))[ \t\r\n]*=>/.exec(code)
  return Boolean(m)
}

/** 按顶层分隔符切开（跳过括号与字符串/模板/正则字面量），带回每段在原文里的偏移。 */
function splitTopLevel(code, sep) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < code.length; i += 1) {
    const end = literalEnd(code, i)
    if (end > i) { i = end - 1; continue }
    const ch = code[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === sep && depth === 0) { out.push({ code: code.slice(start, i), offset: start }); start = i + 1 }
  }
  out.push({ code: code.slice(start), offset: start })
  return out
}

/**
 * 形参的名字按位置排开；碰上解构 / 对象形参就返回 null（位置对不上，宁可整份实参一起看）。
 * 只认位置这一层，是为了把递归的**分叉数**压住：
 * 若把整个实参表当成一个名字的来源，每个形参解析都会炸开成一串新标识符再各自往下追，
 * 实测会把清点器跑成不结束（批次 6b 第一版就是这么挂的）。
 */
function paramSlots(params) {
  const out = []
  for (const part of splitTopLevel(stripLiterals(params), ',')) {
    const m = /^([A-Za-z_$][\w$]*)/.exec(part.code.trim().replace(/^\.\.\./, ''))
    if (!m) return null
    out.push(m[1])
  }
  return out
}

function readerKindOf(expr) {
  // 注释里写一句「读 src/foo.js」不算真去读文件，所以先抹注释、留字符串
  // （reader 的路径本来就写在字符串里）。
  const code = blankComments(expr)
  for (const { kind, re } of READERS) if (re.test(code)) return kind
  return null
}

/**
 * 「模块加载边界」：`await import(path)` / `require(path)`。
 *
 * 为什么单独一档（它**截断**污点链，而不是继续往上追）：
 * 路径常量（`HOST_PATH`）确实指向 `src/**`，但 `await import(HOST_PATH)` 拿到的是
 * **被执行出来的模块对象**，后面 `Object.keys(host)`、`host.validateUiAction('…') === {…}`
 * 判的是运行时值 —— 那就是执行侧断言，正是这次要保留的形态，不是要清的形状断言。
 * 上一版没有这条边界，ui-action-protocol 的 9 条里有 7 条被误报成源码文本
 * （审计员照着这个数给了「7 条重复可删」的处置，真去删就把唯一的行为覆盖删掉了）。
 *
 * 反过来，`const SRC = readFileSync(HOST_PATH)` 没有 import，照旧判污 ——
 * 那条才是「对源码文本做正则」。
 */
const MODULE_LOAD = /(?:\bawait\s+)?\bimport\s*\(|\brequire\s*\(/

/**
 * 「这一行是一条判据」怎么认。
 *
 * 三代口径，每一代都是被实测顶出来的：
 *   1. 内置名 + `function checkXxx/assertXxx/verifyXxx` —— 够用，但**判据收集函数**认不出：
 *      `const add = (name, ok, detail) => out.push({ name, ok, detail })` 这类写法把判据
 *      先收进数组、后面统一过，19 条 `add(...)` 一条都不计（i18n-status-line 实测），
 *      「执行侧」那一栏于是是个**下界**。
 *   2. 补一条按**形参签名**认：本地声明的函数/箭头，第二个形参就叫 `ok`
 *      （`check(name, ok, detail)` 的形状），它的调用点就是判据。
 *      不认函数名是因为名字太多（add / record / note / push…），而形状是稳定的。
 *   3. 同时**不把 helper 自己的实现算成判据**：`function check(name, ok, detail) { … }`
 *      的声明行里那句 `check(` 也被上一版数成一条（neural-worker-exit 数 11、实跑 10），
 *      这是**上界**噪声。所以先收集所有判据 helper 的函数体跨度，落在里面的调用点一律不算。
 */
/** 从 `openIdx`（指向 `{`）做括号配对，跳过字符串/模板/注释/正则字面量。 */
function braceEnd(text, openIdx, view) {
  let depth = 0
  let i = openIdx
  while (i < text.length) {
    const end = literalEnd(text, i)
    if (end > i) { i = end; continue }
    const ch = view[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return i + 1 }
    i += 1
  }
  return text.length
}

/**
 * 收集函数作用域：形参表 + 函数体跨度（名字认不出的匿名箭头也要收）。
 *
 * 为什么要收匿名的：`scaffold: (code) => code.replace(…)` 里那个 `code` 是这条箭头的形参，
 * 上一版的作用域表里没有它，于是「断言之前最近的同名声明」把 `code` 连到了别处
 * `const code = SRC.replace(…)` —— edge-tts 的 8 条行为判据就是这么被判成源码文本的。
 * 认全所有函数体之后，「这个名字在当前作用域里是形参」才判得准。
 *
 * 三种写法都要认：`function f(a, b) {…}`、`const f = (a, b) => {…}`、`const f = (a, b) => …`
 * （最后一种是单表达式体，跨度取到那条语句结束）。
 */
function functionScopes(view, text) {
  const fns = []
  // 找「哪里有函数」要在**字面量已抹平**的文本上找（位置与 view 一一对应，跨度计算照旧用原文件）：
  // 判据里那句 `/const MAX_DECODE_STEPS = (\d+)/` 在原始文本上长得就像一条声明，
  // 上一版因此凭空造出一个「名叫 MAX_DECODE_STEPS 的函数」，把真变量 `idx` 抹掉，
  // decode-guard 的 1 条源码文本判据就被降级成执行侧（漏报，批次 6b 实测）。
  const probe = stripLiterals(view)
  const record = (name, params, headerStart, headerEnd) => {
    let bodyStart = -1
    let k = headerEnd
    while (k < view.length && /[\s=]/.test(view[k])) k += 1
    if (view[k] === '{') bodyStart = k
    if (bodyStart >= 0) {
      fns.push({ name, params, headerStart, bodyStart, bodyEnd: braceEnd(view, bodyStart, view) })
      return
    }
    // 单表达式体（`=> out.push(…)` / `=> x === y`）：读到这条语句结束。
    const expr = readExpression(text, headerEnd, view)
    fns.push({ name, params, headerStart, bodyStart: headerEnd, bodyEnd: headerEnd + expr.length })
  }
  for (const m of probe.matchAll(/\bfunction\s*([A-Za-z0-9_$]*)\s*\(([^()]*)\)/g)) {
    record(m[1], m[2], m.index, m.index + m[0].length)
  }
  for (const m of probe.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(([^()]*)\)\s*=>/g,
  )) record(m[1], m[2], m.index, m.index + m[0].length)
  // 匿名箭头：形参表里不许出现括号和换行，否则 `check('…', x.map((w)` 这种
  // 「左括号一直配到后面某个右括号」的写法会造出一支假箭头，把真判据的变量抹掉。
  for (const m of probe.matchAll(/\(([^()]*)\)\s*=>/g)) {
    // 具名箭头（`const helper = (code) => …`）已经被上一轮收过：这里的同一份形参表不能再记成
    // 「匿名作用域」，否则 helper 体内的 `code` 会往匿名那层解析，调用点就找不回来了。
    if (fns.some((fn) => fn.name && fn.headerStart <= m.index && m.index <= fn.bodyStart)) continue
    record('', m[1], m.index, m.index + m[0].length)
  }
  return fns
}

/** 有名字的函数作用域（用来认判据 helper 与「这条判据写在 helper 自己体内」）。 */
function localFunctions(view, text) {
  return functionScopes(view, text).filter((fn) => fn.name)
}

/** 第二个形参是不是 `ok`（判据收集函数的形状）。 */
function takesOkAsSecondResult(params) {
  const list = params.split(',').map((p) => p.trim().split(/[=:]/)[0].trim())
  return list[1] === 'ok'
}

/** 认出的判据 helper 名字（内置 + 本地按形状/前缀收集的）。 */
function assertionNames(view) {
  const names = new Set(['check', 'ok', 'fail', 'deepStrictEqual', 'strictEqual'])
  const probe = stripLiterals(view)
  for (const m of probe.matchAll(/\bfunction\s+((?:check|assert|verify)[A-Za-z0-9_$]*)\s*\(/g)) names.add(m[1])
  for (const fn of localFunctions(view, view)) {
    if (takesOkAsSecondResult(fn.params)) names.add(fn.name)
  }
  return names
}

function matcherFor(names) {
  const all = new Set(names)
  const alt = [...all].sort((a, b) => b.length - a.length).join('|')
  // assert.ok / assert.equal / assert.match …：前缀是 `assert.`，单独一条分支。
  return new RegExp(`(?:^|[^.\\w$])((?:assert\\s*\\.\\s*\\w+)|(?:${alt}))\\s*\\(`, 'g')
}

/**
 * 这条调用点是不是写在某个循环 / `forEach` / `map` 的体里。
 *
 * 只是**标注**，不改分档：循环里的一条 `check(` 运行时跑 N 次，静态只能数到 1，
 * 所以「执行侧」那一栏是下界。给个「循环内 N 条」的脚注，让下界看得见，
 * 而不是假装能算出 N 次。近似的地方：无花括号的单语句循环体认不出（往外找最近的 `{`，
 * 看它前面 160 个字符里有没有 for/while/forEach/map）。
 */
function insideLoop(codeText, at) {
  let depth = 0
  for (let i = at; i >= 0; i -= 1) {
    const ch = codeText[i]
    if (ch === '}') depth += 1
    else if (ch === '{') {
      if (depth === 0) {
        const head = codeText.slice(Math.max(0, i - 160), i)
        if (/\bfor\s*(?:await\s*)?\(|\bwhile\s*\(|\.forEach\s*\(|\.map\s*\(|\.filter\s*\(/.test(head)) return true
      } else depth -= 1
    }
  }
  return false
}

/**
 * 扫一个测试文件。返回每条断言的分档 + 命中的变量链（--sample/--trace 用来核分档准不准）。
 */
export function scan(file, traceName = null) {
  return analyzeText(fs.readFileSync(path.join(TEST_DIR, file), 'utf8'), traceName)
}

/**
 * 豁免清单（照样报数，只是不进「待清理」那一栏）。
 *
 * 为什么不是静默跳过：这个文件的 fixture 里**必须原样写出** `readFileSync(join(root,
 * 'src', …))` 这类读文件的文本 —— 那正是它要喂给分类器的输入。判据落在 fixture 文本上，
 * 不落在 `src/**.js` 上，按口径属于执行侧；但启发式认的是字符串里的路径，会把这 17 条
 * 报成源码文本。豁免是**记账式的**：报告里单独列出它有多少条，将来谁把别的文件塞进
 * 这张表，数字会立刻变大，藏不住。
 */
const EXEMPT = new Map([
  ['shape-assert-count-instrument.test.mjs', '清点器自己的 fixture：判据落在喂给分类器的合成文本上'],
])

/**
 * 分析一段测试源码文本。单独拆出来是为了能被 fixture 直接喂 ——
 * 清点器自己也得有回归测试，否则它会以「修好的数字」的名义把误报一直带着走
 * （上一版就是这么把 749 报成 519 的）。
 */
export function analyzeText(text, traceName = null) {
  // 声明表 / 断言点都在 view（注释已抹平）上找：注释里写了读文件不算真读。
  // view 与 text 等长，下标可以直接混用。
  const view = blankComments(text)
  // 与 view 等长、但字符串/模板/正则字面量已抹平的文本：所有「这段代码里有没有某个标识符」
  // 的检测都在它上面做（路径字符串里那句 `readFileSync(join(root,'src',…)` 不算真读文件）。
  // 下标与 view / text 一一对应，所以找到位置之后读实参仍用原文。
  const codeText = stripLiterals(view)

  // 1) 声明表：一个语句里可能解构出多个名字，全部收下。
  //    和下面几步一样在 codeText 上找：判据里那句 `/const MAX_DECODE_STEPS = (\d+)/`
  //    在带字面量的文本上长得就像一条声明，会造出一个假变量（批次 6b 实测到的漏报源头）。
  const decls = []
  for (const m of codeText.matchAll(/\b(?:const|let|var)\s+([A-Za-z0-9_$, {}\t\r\n]+?)\s*=(?!=)/g)) {
    const names = m[1].trim().replace(/[{}\[\]]/g, ' ').split(/[\s,]+/).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
    const eq = m.index + m[0].length
    const expr = readExpression(text, eq, view)
    for (const name of names) decls.push({ name, at: m.index, exprAt: eq, expr })
  }
  // 纯赋值（`let x` 先声明、后面在循环里 `x = block.text`）也算来源。
  // 没有这一条，taint 链会在「先声明成空串、循环里才拿到文本」这种写法上**断掉**，
  // 那一整批源码文本判据会被报成执行侧 —— 数字变小、代码没变，正是最坏的一种假绿
  // （批次 4c 把 state-reset 瘦到 3 条时实测到：3 条全被报成执行侧）。
  // 两条防误报的边界，都是实测出来的：
  //   - 只在**字符串字面量已被抹平**的文本上找赋值点：模板串里写的 `maxLen=…`
  //     不是赋值语句（config-contract 就是这么被顶出两条假源码文本的）；
  //   - 自指的赋值（`code = tune(code)`）不改变来源：它换的是内容，不是出处。
  //     否则「 SRC.replace() 之后又被 tune/scaffold 加工」的链会断在这里，
  //     正确的源码文本判据会被降级成执行侧（edge-tts 的那一条就是这么丢的）。
  for (const m of codeText.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
    const before = codeText.slice(Math.max(0, m.index - 12), m.index)
    if (/(?:^|[^\w$.])(?:const|let|var)[ \t\r\n]+$/.test(before)) continue
    const eq = m.index + m[0].length
    const expr = readExpression(text, eq, view)
    if (referencesName(stripLiterals(expr), m[1])) continue
    decls.push({ name: m[1], at: m.index, exprAt: eq, expr })
  }

  // 2) 本地文本加工函数：只要它被「带 reader 的实参」调用过，返回值整体判污。
  const localFns = new Set()
  for (const m of codeText.matchAll(/\bfunction\s+([A-Za-z0-9_$]+)\s*\(/g)) localFns.add(m[1])
  for (const m of codeText.matchAll(/\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function|[(])/g)) localFns.add(m[1])
  const textFns = new Map()
  for (let round = 0; round < 3; round++) {
    let changed = false
    for (const fn of localFns) {
      if (textFns.has(fn)) continue
      const callRe = new RegExp(`(?<![\\w$.])${fn.replace(/\$/g, '\\$')}\\s*\\(`, 'g')
      for (const m of codeText.matchAll(callRe)) {
        const args = readExpression(text, m.index + m[0].length, view)
        // 同一个边界也拦这里：`use(await import(…))` 的实参是活模块，不是文本。
        let kind = MODULE_LOAD.test(blankComments(args)) ? null : readerKindOf(args)
        if (!kind) {
          for (const [known, k] of textFns) if (referencesName(stripLiterals(args), known)) { kind = k; break }
        }
        if (kind) {
          textFns.set(fn, kind)
          changed = true
          break
        }
      }
      if (textFns.has(fn)) break
    }
    if (!changed) break
  }

  // 3) 解析一个名字在某个位置上的来源：取「该位置之前最近的一次声明」，递归。
  //    trace 非空时顺带记链条，给 --trace 用人核分档。

  // 函数体跨度表：用来判断「这个名字在当前作用域里是不是形参」。
  const fnScopes = functionScopes(view, text)
  /** 包住 `at` 的那个函数（取最内层；形参表也算在体内，`(code) => code…` 的 `code` 归它）。 */
  function enclosingFn(at) {
    let best = null
    for (const fn of fnScopes) {
      if (fn.headerStart < at && at < fn.bodyEnd && (!best || fn.headerStart > best.headerStart)) best = fn
    }
    return best
  }
  const callSiteCache = new Map()
  const resolvingFns = new Set()
  /** 某个本地函数的调用点（声明处与它自己的递归调用不算；匿名函数没有调用点可找）。 */
  function callSitesOf(fnName) {
    if (!fnName) return []
    if (callSiteCache.has(fnName)) return callSiteCache.get(fnName)
    // 正在解析这个名字的调用点（A 的实参里又要求 A 的形参来源）：这次给空，但不写进缓存。
    if (resolvingFns.has(fnName)) return []
    const out = []
    resolvingFns.add(fnName)
    const scope = fnScopes.find((fn) => fn.name === fnName)
    const re = new RegExp(`(?<![\\w$.])${fnName.replace(/\$/g, '\\$')}\\s*\\(`, 'g')
    for (const m of codeText.matchAll(re)) {
      const head = view.slice(Math.max(0, m.index - 20), m.index)
      // `function f(` 的声明头不是调用；`const f = (` 因为中间有 `=`，本来就匹配不上。
      if (/\bfunction[ \t\r\n]+$/.test(head)) continue
      if (scope && m.index >= scope.bodyStart && m.index < scope.bodyEnd) continue
      out.push(m.index + m[0].length)
    }
    resolvingFns.delete(fnName)
    callSiteCache.set(fnName, out)
    return out
  }

  function kindOfName(name, before, seen = new Set(), trace = null) {
    if (seen.has(name) || seen.size > 8) return null
    seen.add(name)
    // 形参不是「文件里同名的另一处声明」。这一条是被实测顶出来的（批次 6b）：
    // edge-tts 的 8 条行为判据被判成源码文本，链条是
    //   mod ← loadEdgeTtsWithFakeVendor(fakeVendor, { tune }) → … → tune（**场景函数的形参**）
    //     → 却解析到了另一个函数 `loadEdgeTts…` 的形参默认值 → 那里的 code ← SRC.replace(…)
    //     → hostSource('edge-tts')。
    // 上一版没有作用域，「断言之前最近的同名声明」把两个不相干函数的同名形参连成了一条链。
    // 现在的做法：形参的来源由**该函数的调用点实参**决定；调用点里确实传了源码文本的，
    // 污点照样流过来（不是简单地判成执行侧 —— 那样会把真形状断言藏进下界里）。
    const scope = enclosingFn(before)
    if (scope && paramsMention(scope.params, name)) {
      const slots = paramSlots(scope.params)
      const wanted = slots ? slots.indexOf(name) : -1
      let kind = null
      for (const at of callSitesOf(scope.name)) {
        if (kind) break
        const raw = readExpression(text, at, view)
        const args = splitTopLevel(raw, ',')
        const argList = wanted >= 0 ? [args[wanted]] : args
        for (const arg of argList) {
          if (kind || !arg || !arg.code.trim()) continue
          if (MODULE_LOAD.test(blankComments(arg.code))) continue
          const k = kindOfExpr(arg.code, at + arg.offset, new Set(seen), trace)
          if (k) kind = k
        }
      }
      if (trace) trace.push(`${'  '.repeat(trace.length)}${name} 是 ${scope.name || '匿名箭头'}() 的${slots ? `第 ${wanted + 1} 号形参` : '形参（解构写法，不分位置）'} ← ${kind ? '调用点在这里传了源码文本' : '调用点没传源码文本'}（L${lineOf(text, before)}）`)
      return kind
    }
    let decl = null
    for (const d of decls) if (d.name === name && d.at < before && (!decl || d.at > decl.at)) decl = d
    if (!decl) return null
    if (isFunctionValue(decl.expr)) {
      if (trace) trace.push(`${'  '.repeat(trace.length)}${name} ← L${lineOf(text, decl.at)}（函数值：判的是它返回什么，不在这里连文本）`)
      return null
    }
    if (trace) trace.push(`${'  '.repeat(trace.length)}${name} ← L${lineOf(text, decl.at)} ${oneLine(decl.expr)}`)
    return kindOfExpr(decl.expr, decl.exprAt, seen, trace)
  }

  function kindOfExpr(expr, at, seen = new Set(), trace = null) {
    // 模块加载边界优先于 reader：见 MODULE_LOAD 的注释。
    if (MODULE_LOAD.test(blankComments(expr))) {
      if (trace) trace.push(`${'  '.repeat(trace.length)}（模块加载边界：判的是跑出来的值，不算文本）`)
      return null
    }
    // reader 在**整段表达式**上找：`{ text: hostSource('x'), n: 3 }` 这种对象字面量
    // 里的读文件动作是真去了读，不能因为写法就把污点丢掉（漏报比虚高危险）。
    const direct = readerKindOf(expr)
    if (direct) {
      if (trace) trace.push(`${'  '.repeat(trace.length)}命中 reader：${oneLine(expr)}`)
      return direct
    }
    const codeOnly = stripLiterals(expr)
    for (const [fn, kind] of textFns) {
      if (referencesName(codeOnly, fn)) {
        if (trace) trace.push(`${'  '.repeat(trace.length)}经过本地文本函数 ${fn}()`)
        return kind
      }
    }
    // 往上传污点时按**每个变量自身的位置**查作用域（见 kindOfName 的形参分支）。
    // 试过更狠的做法：把嵌套函数体整段抹掉再取自由变量 —— 那样连
    // `writes.filter((w) => w.line > micStart)` 里的 `micStart` 一起没了，
    // config-writeback 那条真源码文本判据就被降级成执行侧（漏报，比虚高危险）。
    for (const site of identifierSites(codeOnly)) {
      const k = kindOfName(site.name, at + site.offset, new Set(seen), trace)
      if (k) return k
    }
    return null
  }

  // 4) 逐条断言分档。
  const hits = { src: [], lib: [] }
  const traced = []
  let other = 0
  let inLoops = 0
  const names = assertionNames(view)
  // 判据 helper 自己的**声明与函数体**里那些调用点是实现，不算一条判据：
  // `function check(name, ok, detail) { … }` 这一行的 `check(` 上一版也被数成一条
  // （neural-worker-exit 报 11、实跑 10），所以跨度从 `function` 关键字起算，不只从 `{`。
  const helperBodies = localFunctions(view, text)
    .filter((fn) => names.has(fn.name))
    .map((fn) => [fn.headerStart, fn.bodyEnd])
  // 调用点在「字面量已抹平」的文本上找：判据名字出现在字符串/模板里的（比如把一段
  // `check('…')` 当数据写的 fixture）不是真调用点。位置与原文件一一对应，读实参仍用原文。
  for (const m of codeText.matchAll(matcherFor(names))) {
    const open = m.index + m[0].length - 1
    if (helperBodies.some(([s, e]) => m.index > s && m.index < e)) continue
    const call = readExpression(text, open + 1, view)
    const label = (call.match(/(['"`])(?:[^\\]|\\.)*?\1/) ?? [])[0] ?? ''
    const trimmed = label.slice(1, -1)
    const trace = []
    const kind = kindOfExpr(call, open + 1, new Set(), trace)
    const loop = insideLoop(codeText, m.index)
    if (loop) inLoops += 1
    // --trace 要能追**任何一档**的判据：清点到「执行侧」里藏着的漏报（真形状断言被降级），
    // 只看源码文本那一栏是永远发现不了的。
    if (traceName && (trimmed.includes(traceName) || String(lineOf(text, m.index)) === traceName)) {
      traced.push({ name: trimmed, at: m.index, kind: kind ?? 'exec', call, trace, loop })
    }
    if (kind === 'src') hits.src.push({ name: trimmed, at: m.index, call, trace, loop })
    else if (kind === 'lib') hits.lib.push({ name: trimmed, at: m.index, call, trace, loop })
    else other += 1
  }
  return { ...hits, other, inLoops, traced, text }
}

function oneLine(s) {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > 90 ? t.slice(0, 90) + '…' : t
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

/** 汇总 + 打印。参数化是为了能被测试直接调（见 test/shape-assert-count-instrument.test.mjs）。 */
export function report(argv = process.argv.slice(2)) {
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs')).sort()
  const onlyIdx = argv.indexOf('--only')
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null
  const targets = only ? files.filter((f) => f.includes(only)) : files
  const wantList = argv.includes('--list')
  const sampleIdx = argv.indexOf('--sample')
  const sampleN = sampleIdx >= 0 ? Number(argv[sampleIdx + 1] || 10) : 0
  const traceIdx = argv.indexOf('--trace')
  const traceArg = traceIdx >= 0 ? String(argv[traceIdx + 1] || '') : null
  const wantJson = argv.includes('--json')

  const rows = []
  const exemptRows = []
  for (const f of targets) {
    const r = scan(f, traceArg)
    const row = {
      file: f,
      src: r.src.length,
      lib: r.lib.length,
      other: r.other,
      inLoops: r.inLoops,
      names: r.src.map((h) => h.name),
      samples: r.src.slice(0, sampleN).map((h) => ({
        line: lineOf(r.text, h.at),
        name: h.name,
        call: h.call.replace(/\s+/g, ' ').trim().slice(0, 150),
      })),
      traced: r.traced.map((h) => ({
        line: lineOf(r.text, h.at),
        name: h.name,
        kind: h.kind,
        call: oneLine(h.call),
        trace: h.trace,
      })),
    }
    if (EXEMPT.has(f)) exemptRows.push(row)
    else rows.push(row)
  }
  rows.sort((a, b) => b.src - a.src || a.file.localeCompare(b.file))

  const totalSrc = rows.reduce((a, r) => a + r.src, 0)
  const totalLib = rows.reduce((a, r) => a + r.lib, 0)
  const totalOther = rows.reduce((a, r) => a + r.other, 0)
  const totalLoops = rows.reduce((a, r) => a + r.inLoops, 0)
  const total = totalSrc + totalLib + totalOther

  if (wantJson) {
    console.log(JSON.stringify({
      total, src: totalSrc, lib: totalLib, exec: totalOther, inLoops: totalLoops,
      exempt: exemptRows.map((r) => ({ file: r.file, src: r.src, lib: r.lib, other: r.other, reason: EXEMPT.get(r.file) })),
      files: rows.map((r) => ({ file: r.file, src: r.src, lib: r.lib, other: r.other, inLoops: r.inLoops })),
    }, null, 2))
  } else {
    for (const r of rows) {
      if (r.src + r.lib + r.other === 0) continue
      const extra = `${r.inLoops ? `  循环内 ${r.inLoops}` : ''}`
      console.log(`${String(r.src).padStart(4)} 源码文本  ${String(r.lib).padStart(4)} 产物文本  ${String(r.other).padStart(4)} 执行侧  ${extra}   ${r.file}`)
    }
    console.log(`\n合计 ${total} 条断言：源码文本 ${totalSrc}（${((totalSrc / total) * 100).toFixed(1)}%）`
      + ` / 产物文本 ${totalLib} / 执行侧 ${totalOther}`)
    console.log(`另记：判据写在循环里的有 ${totalLoops} 处 —— 循环里一条静态只数到 1，`
      + `所以「执行侧」那一栏是**下界**。`)
    console.log('要清的是「源码文本」那一栏：搬成单元/集成/端到端，或者（纯写法的）直接删。')
    for (const r of exemptRows) {
      console.log(`\n豁免（不进上面的合计）：${r.file} 源码文本 ${r.src} 条 —— ${EXEMPT.get(r.file)}`)
    }
  }

  if (wantList) {
    for (const r of rows) {
      if (!r.names.length) continue
      console.log(`\n### ${r.file}（${r.names.length} 条源码文本断言）`)
      for (const n of r.names) console.log(`  - ${n}`)
    }
  }

  if (sampleN) {
    for (const r of rows) {
      if (!r.samples.length) continue
      console.log(`\n### ${r.file}`)
      for (const s of r.samples) console.log(`  L${s.line}  ${s.call}`)
    }
  }

  if (traceArg) {
    const BUCKET_LABEL = { src: '源码文本', lib: '产物文本', exec: '执行侧' }
    for (const r of rows) {
      if (!r.traced.length) continue
      console.log(`\n### ${r.file} —— 这 ${r.traced.length} 条为什么落在该档里`)
      for (const t of r.traced) {
        console.log(`  L${t.line}  【${BUCKET_LABEL[t.kind] ?? t.kind}】${t.name}${t.loop ? '（写在循环里）' : ''}`)
        for (const step of t.trace) console.log(`      ${step}`)
        console.log(`      判据：${t.call}`)
      }
    }
  }

  return { total, src: totalSrc, lib: totalLib, exec: totalOther, rows }
}

// 只有直接跑才打印，被测试 import 时安静（否则测试一 import 就刷一屏）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) report()
