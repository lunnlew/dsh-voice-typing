/** 代码块排除的各种边界情况。 */
import os from 'node:os'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'

const tmpHome = path.join(os.tmpdir(), 'dsh-vt-fence2')
await mkdir(tmpHome, { recursive: true })
process.env.DSH_HOME = tmpHome

const { apply } = await import('../lib/index.js')
const { EMIT_WINDOW_MS } = await import('../lib/read-aloud-policy.js')

// 只 apply 一次，所有用例共用同一套路由与 SSE 订阅。
const routes = new Map()
const handlers = new Map()
const scope = {
  effect(fn) { fn(); return () => {} },
  webServer: { register(d) { routes.set(d.path, d); return () => {} } },
  sessions: { get() { return { deriveMessages: () => [] } }, list() { return [] } },
}
apply(
  { on(e, h) { handlers.set(e, h) }, inject(_d, fn) { fn(scope); return () => {} } },
  { readAloud: true, preloadModels: false },
)

const events = []
const seen = new Set()
const def = routes.get('/dsh-voice-typing/stream')
const res = {
  headersSent: false, writableEnded: false, destroyed: false,
  writeHead() { this.headersSent = true },
  write(c) {
    for (const frame of String(c).split('\n\n')) {
      const body = frame.trim()
      if (!body || body.startsWith(':')) continue
      const m = /^event: (\S+)\ndata: ([\s\S]*)$/.exec(body)
      if (!m) continue
      let o
      try { o = JSON.parse(m[2]) } catch { continue }
      if (seen.has(o.seq)) continue
      seen.add(o.seq)
      events.push({ event: m[1], data: o })
    }
    return true
  },
  end() { this.writableEnded = true },
}
def.handler({ on() { return this } }, res)

/** 跑一段流，返回这次产生的 sentence 文本。 */
async function run(chunks) {
  const before = events.length
  const stream = handlers.get('llm/stream')(
    { sessionId: 's' + Math.random(), messages: [{ role: 'user', id: 'u1' }] },
    () => (async function* () {
      for (const c of chunks) yield { type: 'text-delta', text: c }
    })(),
  )
  for await (const _ of stream) { /* consume */ }
  await new Promise((r) => setTimeout(r, EMIT_WINDOW_MS * 14 + 1500))
  return events
    .slice(before)
    .filter((e) => e.event === 'sentence')
    .map((e) => e.data.text)
}

let pass = 0
let fail = 0
const check = (n, ok, d) => {
  if (ok) { pass++; console.log('  ok   ' + n) }
  else { fail++; console.log('  FAIL ' + n + (d ? ' :: ' + d : '')) }
}

// 1) 两个连续代码块
{
  const s = await run([
    '第一段正文。\n', '```js\ncodeA();\n```\n', '中间正文。\n',
    '```python\ncodeB()\n```\n', '最后正文。',
  ])
  const j = s.join('')
  console.log('  用例1 朗读:', JSON.stringify(s))
  check('两个代码块：正文都在',
    j.includes('第一段正文') && j.includes('中间正文') && j.includes('最后正文'))
  check('两个代码块：代码都没念', !j.includes('codeA') && !j.includes('codeB'))
}

// 2) 代码块跨多个 chunk（流式最真实的情况）
{
  const s = await run([
    '看看这段。\n```', 'js\n', 'function test() {', '\n  return 42;', '\n}\n', '```\n', '就是这样。',
  ])
  const j = s.join('')
  console.log('  用例2 朗读:', JSON.stringify(s))
  check('跨 chunk 代码块：正文都在', j.includes('看看这段') && j.includes('就是这样'))
  check('跨 chunk 代码块：代码没念', !j.includes('function') && !j.includes('return 42'))
}

// 3) 行内代码（反引号）
{
  const s = await run(['请把 `foo()` 这个函数改成 `bar()` 那种写法。'])
  const j = s.join('')
  console.log('  用例3 朗读:', JSON.stringify(s))
  check('行内代码仍可朗读（不误伤正文）', j.includes('请把') && j.includes('这个函数'))
}

// 4) 未闭合的代码块（回复被中断）
{
  const s = await run(['正常开头。\n```js\n', 'const a = 1;\n', 'const b = 2;\n'])
  const j = s.join('')
  console.log('  用例4 朗读:', JSON.stringify(s))
  check('未闭合围栏：前面的正文保留', j.includes('正常开头'))
  check('未闭合围栏：后续代码不念', !j.includes('const a'))
}

// 5) 没有代码块时完全正常
{
  const s = await run(['这是一句普通的话。', '这也是普通的话。'])
  console.log('  用例5 朗读:', JSON.stringify(s))
  check('无代码块时正常朗读', s.join('').includes('普通的话'))
}

// 6) 围栏标记本身被 chunk 边界切成两半（真实 token 流式会这样）
//
// 旧实现逐块 `chunk.text.split('```')`：chunk 末尾只有 "``" 时识别不出围栏，
// 两个反引号被当正文；下一块的 "`js" 又让状态机错位 —— 实测代码被念出来，
// 而围栏**之后**的正文反而被当代码整段丢掉。现在由 lib/fence-filter.js 跨 chunk 处理。
{
  const reply = '下面是一段示例代码：\n```js\nconst x = 1\nconsole.log(x)\n```\n代码执行完之后会输出结果。'
  const chunks = []
  for (let i = 0; i < reply.length; i += 4) chunks.push(reply.slice(i, i + 4))
  const s = await run(chunks)
  const j = s.join('')
  console.log('  用例6 朗读:', JSON.stringify(s))
  check('围栏被 chunk 切开：围栏前的正文在', j.includes('下面是一段示例代码'))
  check('围栏被 chunk 切开：围栏后的正文也在（不被当代码丢掉）', j.includes('代码执行完之后会输出结果'))
  check('围栏被 chunk 切开：代码一个字都没念',
    !j.includes('const x') && !j.includes('console.log') && !/\bjs\b/.test(j))
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exitCode = fail ? 1 : 0
process.exit(fail ? 1 : 0)
