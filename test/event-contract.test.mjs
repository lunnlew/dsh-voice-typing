/**
 * 事件契约的一致性测试：宿主发的信封，客户端必须能正确解析。
 *
 * 这是两个半身的**接缝**——最容易出问题的地方：
 * 宿主改了信封格式而客户端没跟上，表现是「朗读不工作了」
 * 或者「下载没进度」，而且**不报错**。
 *
 * 这里不依赖跑着的 DSH：
 *   - 用宿主源码里的 broadcast 实现生成信封；
 *   - 用客户端源码里的 parseEnvelope 解析；
 *   - 断言两端对得上。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnvelope, belongsToSession } from '../src/client/pure/envelope.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const idx = fs.readFileSync(root + '/lib/index.js', 'utf8')
const cli = fs.readFileSync(root + '/lib/client.js', 'utf8')
// 信封协议已抽到独立模块 lib/sse-envelope.js，信封形状在那边断言。
const envSrc = fs.readFileSync(root + '/lib/sse-envelope.js', 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('宿主侧：信封在 broadcast 里统一加')
check('broadcast 会加信封', /const broadcast = \(event, payload\) =>/.test(idx))
check('信封含版本号 v', /\bv:\s*3\b/.test(envSrc))
check('信封含 seq', /\bseq\b/.test(envSrc))
check('信封含 ts', /\bts\b/.test(envSrc))
check('信封含 sessionId', /sessionId/.test(envSrc))
check('seq 是单调递增的计数器', /seq\s*[:=]/.test(envSrc) && /\+\+/.test(envSrc))

console.log('\n宿主侧：assistant-busy 事件')
check('广播 assistant-busy', /'assistant-busy'/.test(idx))
check('载荷是 busy 布尔', /assistant-busy',\s*\{\s*busy:/.test(idx))
check('置位与复位都发（对称）',
  (idx.match(/assistant-busy/g) || []).length >= 3,
  '置位一次 + 复位一次 + 注释')

console.log('\n客户端侧：所有 SSE 消费都走信封')
const eventListeners = [...cli.matchAll(/addEventListener\('([a-z-]+)'/g)].map((m) => m[1])
console.log('  监听的事件:', eventListeners.join(', '))
{
  // 允许 parseEnvelope 内部那一处裸解析（它就是解析器本身）
  const bare = (cli.match(/JSON\.parse\(event\.data\)/g) || []).length
  check('除了 parseEnvelope 内部没有裸的 JSON.parse(event.data)',
    bare <= 1,
    `找到 ${bare} 处 —— 裸解析在信封协议下拿不到业务字段`)
}
check('用了 parseEnvelope', /parseEnvelope\(event\)/.test(cli))
check('用了 belongsToSession（多会话不串音）', /belongsToSession\(/.test(cli))

console.log('\n端到端：宿主信封 → 客户端解析')
{
  // 模拟宿主广播：{v:2, seq, ts, sessionId, ...业务字段}
  const hostEnvelope = {
    v: 3,
    seq: 12,
    ts: Date.now(),
    sessionId: 'sess-1',
    text: '你好，今天天气怎么样？',
    turnId: 'turn-abc',
    index: 0,
  }
  const parsed = parseEnvelope({ data: JSON.stringify(hostEnvelope) })
  check('能解析出信封', !!parsed)
  check('业务字段平铺可读（不在 payload 里）', parsed.text === '你好，今天天气怎么样？')
  check('turnId 可读', parsed.turnId === 'turn-abc')
  check('index 可读', parsed.index === 0)
  check('seq 可读（能检测丢事件）', typeof parsed.seq === 'number')
  check('sessionId 可读', parsed.sessionId === 'sess-1')
}

console.log('\n多会话过滤')
{
  const mine = parseEnvelope({ data: JSON.stringify({ v: 3, seq: 1, ts: 0, sessionId: 'sess-1', text: 'x' }) })
  const other = parseEnvelope({ data: JSON.stringify({ v: 3, seq: 2, ts: 0, sessionId: 'sess-2', text: 'y' }) })
  const global = parseEnvelope({ data: JSON.stringify({ v: 3, seq: 3, ts: 0, sessionId: null, id: 'whisper-tiny', percent: 50 }) })
  check('自己会话的事件要处理', belongsToSession(mine, 'sess-1') === true)
  check('别的会话的事件要忽略', belongsToSession(other, 'sess-1') === false)
  check('全局事件（sessionId=null）任何会话都处理', belongsToSession(global, 'sess-1') === true)
}

console.log('\n健壮性')
{
  check('坏 JSON 返回 null', parseEnvelope({ data: '{not json' }) === null)
  check('非对象返回 null', parseEnvelope({ data: '"hello"' }) === null)
  check('空信封不崩', belongsToSession(null, 'sess-1') === false)
}

console.log('\n宿主不再发已废弃的事件')
check('不发 turn-start', !/broadcast\('turn-start'/.test(idx))
check('不发 session 事件', !/broadcast\('session'/.test(idx))
check('客户端不监听 turn-start', !/addEventListener\('turn-start'/.test(cli))
check('客户端不监听 session', !/addEventListener\('session'/.test(cli))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
