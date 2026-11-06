/**
 * 守卫：形状断言清点器（scripts/count-shape-assertions.mjs）自己必须准。
 *
 * 为什么这道守卫存在（docs/architecture-modernization.md §8.34）：
 *   P3 那一批「把源码形状断言换成单元/集成/端到端」的工作量、批次顺序、完成判据，
 *   全都建立在这个清点器给的数字上。数字错了，campaign 就是照着错的地图行军 ——
 *   而且**错得没有体感**：误报会把执行侧断言也算成待清理项（虚高），漏报会让
 *   真正的形状断言悄悄躲在「执行侧」那一栏里（虚低），两边都不会让任何测试变红。
 *
 *   上一版就两个都犯了：
 *     - 虚高：续行判断的字符集没闭合，正则失配后表达式一路读到文件末尾（749 条）；
 *     - 虚高：`const { x } = await import('../lib/index.js')` 后面紧跟一行说明注释，
 *       行首的斜杠被当成「表达式还没写完」，于是把注释下面两行的 `hostSource(…)`
 *       吞进这条声明的表达式 —— event-envelope 里 14 条纯执行侧断言被判成源码形状
 *       断言（40 条 → 修完 14 条）。
 *   两次都是**我读源码没看出来、跑一遍又只是扫一眼总数**才发现的。所以这里不测
 *   「总数看着合理」，测的是一条条具体的判据该落在哪一栏。
 *
 * 口径分三档（与清点器头注释一致）：源码文本 / 产物文本 / 执行侧。
 * 判据只按「读的是源码、是产物，还是跑出来的值」分栏。
 *
 * 断言分两类：
 *   1. 单元：喂 fixture 文本，逐条核对分档（含两条已知误报的回归）。
 *   2. 单元：blankComments / readExpression 这两个「边界判断」单独钉住。
 *   （还有第三类「把某条判据规则拆掉、看数字跟着变」的自证变异，批次 6c 起删了。）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = path.join(root, 'scripts', 'count-shape-assertions.mjs')

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

const { analyzeText, blankComments, readExpression } = await import(pathToFileURL(SCRIPT).href)

/** 取分档结果里某个名字落在哪一栏（fixture 里断言名唯一，直接查）。 */
function bucketOf(result, name) {
  if (result.src.some((h) => h.name === name)) return 'src'
  if (result.lib.some((h) => h.name === name)) return 'lib'
  return 'exec'
}

// ---------------------------------------------------------------------------
// 1) 分档判据：fixture 逐条核对
// ---------------------------------------------------------------------------
console.log('\n分档：读源码文件的判据要落到「源码文本」')
{
  const r = analyzeText([
    "const SRC = readFileSync(join(root, 'src', 'client', 'main.js'), 'utf8')",
    "check('有 import', /import/.test(SRC))",
    "check('和源码无关', 1 + 1 === 2)",
  ].join('\n'))
  check('readFileSync(join("src", …)) 的判据算源码文本', bucketOf(r, '有 import') === 'src', bucketOf(r, '有 import'))
  check('同一文件里的纯算术断言仍算执行侧', bucketOf(r, '和源码无关') === 'exec', bucketOf(r, '和源码无关'))
}
{
  // 仓库里路径拼法有三种，只认一种就是把另外两种的待清理项判成执行侧（漏报）。
  for (const [name, decl] of [
    ['root + 字符串拼接', "const SRC = fs.readFileSync(root + '/src/client/main.js', 'utf8')"],
    ['模板字符串', 'const SRC = fs.readFileSync(`${root}/src/client/${f}`, "utf8")'],
    ['new URL 相对路径', "const SRC = fs.readFileSync(new URL('../src/host/asr-worker.js', import.meta.url), 'utf8')"],
  ]) {
    const r = analyzeText([decl, "check('判据', /import/.test(SRC))"].join('\n'))
    check(`源码路径的${name}形态也算源码文本`, bucketOf(r, '判据') === 'src', bucketOf(r, '判据'))
  }
}
{
  const r = analyzeText([
    'const CLI = clientSource()',
    "const lines = CLI.split('\\n')",
    "check('行数够', lines.length > 10)",
  ].join('\n'))
  check('污点顺着赋值链往下传（lines 派生自 CLI）', bucketOf(r, '行数够') === 'src', bucketOf(r, '行数够'))
}

console.log('\n分档：赋值点（不是声明）也必须参与污点链')
{
  // 「先声明成空串，循环里才赋上文本」——只认 const/let 声明时这条会掉进执行侧。
  // 批次 4c 就是把 state-reset 瘦成这种写法时实测到的：3 条源码文本判据全被报成执行侧，
  // 于是「待清理」那一栏凭空少 3 条，而代码一行没变 —— 数字变小不代表事情变好。
  const r = analyzeText([
    "const SRC = readFileSync(join(root, 'src', 'client', 'mic-button.js'), 'utf8')",
    "const lines = SRC.split('\\n')",
    "let body = ''",
    "for (let i = 0; i < lines.length; i++) {",
    "  const block = blockOf(lines, 'const stopListening = useCallback', i)",
    "  if (block.text.includes('closeMic')) { body = block.text; break }",
    '}',
    "check('里面有 clearTimeout', /clearTimeout/.test(body))",
    "check('和它无关', 1 + 1 === 2)",
  ].join('\n'))
  check('循环里赋值的 body 仍然带着 SRC 的污点', bucketOf(r, '里面有 clearTimeout') === 'src', bucketOf(r, '里面有 clearTimeout'))
  check('同一文件里的纯算术断言不因这条改动被顶成源码文本', bucketOf(r, '和它无关') === 'exec', bucketOf(r, '和它无关'))
}
{
  // 自指赋值（`code = tune(code)`）换的是内容，不是出处：不能让它切断链。
  // edge-tts 的真实形状就是 SRC.replace() 之后再过 tune / scaffold 两道加工。
  const r = analyzeText([
    "const SRC = hostSource('edge-tts')",
    'let code = SRC.replace("a", "b")',
    'if (tune) code = tune(code)',
    "check('源码里有 class', /class/.test(code))",
  ].join('\n'))
  check('自指赋值不切断污点链（加工过还是源码文本）', bucketOf(r, '源码里有 class') === 'src', bucketOf(r, '源码里有 class'))
}
{
  // 反过来：字符串里的 `x=` 长得像赋值，但它不是判据的输入。
  // config-contract 撞上过的形状是断言文案里写 `${key}：maxLen=${…}`，
  // 于是 `maxLen` 凭空多了一条「声明」，把两条纯值比较判成了源码文本。
  const r = analyzeText([
    "const SRC = readFileSync(join(root, 'src', 'shared', 'config.js'), 'utf8')",
    'const spec = CONFIG_SPECS[key]',
    "must(`${key}：maxLen=${SRC} 是正整数`, () => {})",
    "check('maxLen 是正整数', Number.isInteger(spec.maxLen))",
  ].join('\n'))
  check('模板串里的「maxLen=」不算赋值点（不被串里的 SRC 污到）',
    bucketOf(r, 'maxLen 是正整数') === 'exec', bucketOf(r, 'maxLen 是正整数'))
}

console.log('\n分档：读构建产物的判据要落到「产物文本」（不在清理范围）')
{
  const r = analyzeText([
    "const BUNDLE = readFileSync(join(root, 'lib', 'client.js'), 'utf8')",
    "check('产物有 import', /import/.test(BUNDLE))",
  ].join('\n'))
  check('lib/**.js 的字节检查算产物文本，不算源码文本', bucketOf(r, '产物有 import') === 'lib', bucketOf(r, '产物有 import'))
}

console.log('\n分档：回归 —— 注释不能把下面一行的读文件算进这条声明')
{
  // 这就是 event-envelope 里真实撞过的形状（14 条执行侧断言曾被判成源码文本）。
  const r = analyzeText([
    "const { buildEventEnvelope } = await import('../lib/index.js')",
    '// 形状断言读手写源码（helpers/host-source.mjs 解析位置），上面那份 import 才是真产物。',
    "const HOST_SRC = hostSource('index')",
    "const env = buildEventEnvelope({ text: 'x' })",
    "check('v 固定为 3', env.v === 3)",
    "check('源码里确实调了信封', /buildEventEnvelope\\(/.test(HOST_SRC))",
  ].join('\n'))
  check('跑真函数拿返回值 → 执行侧（曾被注释带污成源码文本）',
    bucketOf(r, 'v 固定为 3') === 'exec', bucketOf(r, 'v 固定为 3'))
  check('同一文件里 .test(HOST_SRC) 仍然算源码文本（别修过头变成漏报）',
    bucketOf(r, '源码里确实调了信封') === 'src', bucketOf(r, '源码里确实调了信封'))
}

console.log('\n分档：模块加载边界 —— import 出来的活模块不是「源码文本」')
{
  // ui-action-protocol 的真实形状：路径常量指向 src，但断言判的是 import 出来的对象。
  // 上一版把这条链一路追到 HOST_PATH，于是 9 条里 7 条执行侧断言被判成源码文本，
  // 审计员照着那个数给了「7 条重复可删」—— 真删就把唯一的行为覆盖删掉了。
  const r = analyzeText([
    "const HOST_PATH = `${root}/${hostSourcePath('ui-action-protocol')}`",
    'const host = await import(pathToFileURL(HOST_PATH).href)',
    "const shared = await import('../src/shared/ui-action-protocol.js')",
    "check('导出面一致', JSON.stringify(Object.keys(host).sort()) === JSON.stringify(names))",
    "check('归一化结果正确', host.validateUiAction('send_prompt', { text: ' 你好 ' }).ok === true)",
    "const SRC = readFileSync(HOST_PATH, 'utf8')",
    "check('源码里没第二份表', !/const ACTION_SPECS = \\{/.test(SRC))",
  ].join('\n'))
  check('import 出来的模块上做值比较 → 执行侧',
    bucketOf(r, '导出面一致') === 'exec', bucketOf(r, '导出面一致'))
  check('调 import 出来的函数判返回值 → 执行侧',
    bucketOf(r, '归一化结果正确') === 'exec', bucketOf(r, '归一化结果正确'))
  check('同一个路径常量拿去 readFileSync 仍然算源码文本（边界不许吞掉真文本检查）',
    bucketOf(r, '源码里没第二份表') === 'src', bucketOf(r, '源码里没第二份表'))
  {
    // 边界只能在 import/require 那一步截断，不能写成「文件里有 import 就全豁免」：
    // 那样整份 event-envelope 都会溜过去。
    const r2 = analyzeText([
      "const mod = await import('../src/host/x.js')",
      "const SRC = readFileSync(join(root, 'src', 'host', 'x.js'), 'utf8')",
      "check('文本检查', /maxBuffer/.test(SRC))",
      "check('值检查', mod.MAX_BUFFER === 30_000)",
    ].join('\n'))
    check('边界是按断言算的，不是按文件算的',
      bucketOf(r2, '文本检查') === 'src' && bucketOf(r2, '值检查') === 'exec',
      `${bucketOf(r2, '文本检查')}/${bucketOf(r2, '值检查')}`)
  }
}

console.log('\n分档：断言文案里提到的变量名不算判据的输入')
{
  const r = analyzeText([
    'function handler() { return { event: 1 } }',
    "const events = [handler(), handler()]",
    "check('HOST_SRC 里有 broadcast 调用', events.length === 2)",
    "check('对象字面量的键不是变量', /x/.test(JSON.stringify({ text: 'y' })))",
  ].join('\n'))
  check('断言名里写出 HOST_SRC 不会把它自己判成源码文本',
    bucketOf(r, 'HOST_SRC 里有 broadcast 调用') === 'exec', bucketOf(r, 'HOST_SRC 里有 broadcast 调用'))
  check('`{ text: … }` 的键名不会撞到源码变量',
    bucketOf(r, '对象字面量的键不是变量') === 'exec', bucketOf(r, '对象字面量的键不是变量'))
}

console.log('\n分档：跨行表达式要跟到底，但只在语法真需要时')
{
  const r = analyzeText([
    "const SRC = hostSource('index')",
    "  .split('\\n')",
    "  .filter((l) => l.startsWith('export'))",
    "check('有导出', SRC.length > 0)",
  ].join('\n'))
  check('成员链续行（下一行以 . 开头）不切断表达式',
    bucketOf(r, '有导出') === 'src', bucketOf(r, '有导出'))
}

// ---------------------------------------------------------------------------
// 2) 边界判断的两个底层件
// ---------------------------------------------------------------------------
console.log('\nblankComments：抹注释、留字符串和正则、长度不变')
check('行注释抹平且换行保住', blankComments('a // b\nc') === 'a     \nc', JSON.stringify(blankComments('a // b\nc')))
check('块注释抹平', blankComments('a /* x */ b') === 'a         b', JSON.stringify(blankComments('a /* x */ b')))
{
  const s = "join(root, 'src', 'client', 'main.js') // 读源码"
  const out = blankComments(s)
  check('字符串里的斜杠不当成注释（reader 路径靠它）', out.includes("'src'"), JSON.stringify(out))
  check('输出与输入等长（下标可以直接混用）', out.length === s.length, `${out.length} vs ${s.length}`)
}
{
  // 正则字面量里的 `\/\/` 不是注释：吃掉它会把整条判据抹没（漏报）。
  const code = String.raw`check('注释符', /\/\//.test(SRC))`
  const out = blankComments(code)
  check('正则字面量里的双斜杠不当成行注释', out === code, JSON.stringify(out))
}

console.log('\nreadExpression：括号深度、分号、注释都不能把边界读错')
{
  const code = "const a = f(1, 'x')\nconst b = 2\n"
  const got = readExpression(code, code.indexOf('=') + 1)
  check('表达式在行尾收住（不把下一条声明吞进来）', got.trim() === 'f(1, \'x\')', JSON.stringify(got))
}
{
  const code = "const a = f(1,\n  2)\nconst b = 3\n"
  const got = readExpression(code, code.indexOf('=') + 1)
  check('深度未闭合时跨行继续读', got.includes('f(1,') && got.includes('2)') && !got.includes('const b'), JSON.stringify(got))
}
{
  const code = "const a = import('x.js')\n// 说明注释\nconst b = hostSource('y')\n"
  const got = readExpression(code, code.indexOf('=') + 1)
  check('注释不参与续行判断（这就是那处误报的根）', !got.includes('hostSource'), JSON.stringify(got))
}

// ---------------------------------------------------------------------------
// 3) 对着真仓库跑一遍：清点器不许崩，且已知的派生式守卫文件得是 0
// ---------------------------------------------------------------------------
console.log('\n真仓库：跑通 + 抽查已知文件的分档')
{
  const r = analyzeText(fs.readFileSync(path.join(root, 'test', 'client-imports.test.mjs'), 'utf8'))
  check('client-imports（把源码解析成派生事实再判）算 0 条源码文本断言',
    r.src.length === 0, `${r.src.length} 条：${r.src.map((h) => h.name).join(' | ')}`)
}
{
  const r = analyzeText(fs.readFileSync(path.join(root, 'test', 'event-envelope.test.mjs'), 'utf8'))
  const names = r.src.map((h) => h.name)
  check('event-envelope 的源码文本断言只剩真形状那几条（<20）',
    r.src.length < 20, `${r.src.length} 条`)
  check('event-envelope 不再把跑出来的信封判成形状断言',
    !names.some((n) => n.includes('v 固定') || n.includes('seq 是整数') || n.includes('ts 是 epoch')), names.join(' | '))
}

console.log(`\n通过 ${passed}，失败 ${failures.length}`)
if (failures.length) process.exitCode = 1
