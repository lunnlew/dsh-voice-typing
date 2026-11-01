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
// 信封的**真实**实现（唯一真源）：不再把信封手写成字面对象，
// 也不用正则去"猜"版本号 —— 直接拿宿主用的同一个 buildEventEnvelope 造信封。
import { buildEventEnvelope, EVENT_PROTOCOL_VERSION } from '../lib/sse-envelope.js'
// sentence 事件的**真实产出方**（宿主 llm/stream 钩子把正文喂给它）：
// 用它断言 para/paraStart 的字段与语义，而不是只匹配源码正则。
import { createReadAloudScheduler } from '../lib/read-aloud-scheduler.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const idx = fs.readFileSync(root + '/lib/index.js', 'utf8')
const cli = fs.readFileSync(root + '/lib/client.js', 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('宿主侧：信封在 broadcast 里统一加（用真实 buildEventEnvelope 断言）')
check('broadcast 会加信封', /const broadcast = \(event, payload\) =>/.test(idx))
check('宿主唯一信封实现来自 lib/sse-envelope.js（index.js 不另写一套）',
  /from '\.\/sse-envelope\.js'/.test(idx))
{
  const env = buildEventEnvelope({ sessionId: 'sess-1', text: '你好' })
  check('版本号 v 就是 EVENT_PROTOCOL_VERSION（当前 3）',
    EVENT_PROTOCOL_VERSION === 3 && env.v === EVENT_PROTOCOL_VERSION, String(env.v))
  check('信封含整数 seq', Number.isInteger(env.seq), String(env.seq))
  check('信封含 epoch 毫秒 ts', Number.isFinite(env.ts) && env.ts > 1600000000000, String(env.ts))
  check('sessionId 从载荷里取', env.sessionId === 'sess-1', JSON.stringify(env.sessionId))
  check('业务字段平铺在顶层（没有 payload 嵌套层）',
    env.text === '你好' && !('payload' in env), JSON.stringify(env))
  const env2 = buildEventEnvelope({ sessionId: 'sess-2' })
  check('seq 全局严格递增（每次广播 +1）', env2.seq === env.seq + 1, `${env.seq} → ${env2.seq}`)
}

console.log('\n宿主侧：assistant-busy 事件')
check('广播 assistant-busy', /'assistant-busy'/.test(idx))
check('载荷是 busy 布尔', /assistant-busy',\s*\{\s*busy:/.test(idx))
{
  // 计数断言不能把注释也算进去（之前 `(idx.match(/assistant-busy/g)||[]).length >= 3`
  // 注释里出现两次就能过，等于没断言）。改成断言「真实的广播调用」与「对称的置位/复位调用」：
  const emitLine = /emitBroadcast\?\.\('assistant-busy', \{ busy: busyValue/.test(idx)
  const setCalls = (idx.match(/markBusy\(sessionId, true\)/g) || []).length
  const resetCalls = (idx.match(/markBusy\(sessionId, false\)/g) || []).length
  check('置位与复位都真发（emit 调用 + true/false 各至少一处）',
    emitLine && setCalls >= 1 && resetCalls >= 2,
    `emitLine=${emitLine} set=${setCalls} reset=${resetCalls}`)
}

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

console.log('\n端到端：宿主真实信封 → 客户端解析（业务字段平铺）')
{
  // 关键：信封由**宿主用的同一个** buildEventEnvelope 生成（不是手写字面对象），
  // 这样「宿主信封形状」和「客户端解析」才是真正在测接缝。
  const hostEnvelope = buildEventEnvelope({
    sessionId: 'sess-1',
    text: '你好，今天天气怎么样？',
    turnId: 'turn-abc',
    index: 0,
    para: 0,
    paraStart: true,
  })
  check('信封由真实 buildEventEnvelope 生成（v 是协议常量）',
    hostEnvelope.v === EVENT_PROTOCOL_VERSION, String(hostEnvelope.v))
  const parsed = parseEnvelope({ data: JSON.stringify(hostEnvelope) })
  check('能解析出信封', !!parsed)
  check('业务字段平铺可读（不在 payload 里）', parsed.text === '你好，今天天气怎么样？')
  check('turnId 可读', parsed.turnId === 'turn-abc')
  check('index 可读', parsed.index === 0)
  check('para 可读（段落序号）', parsed.para === 0)
  check('paraStart 可读（段首标记）', parsed.paraStart === true)
  check('seq 可读（能检测丢事件）', typeof parsed.seq === 'number')
  check('sessionId 可读', parsed.sessionId === 'sess-1')
}

console.log('\nsentence 事件契约：真实调度器产出 para/paraStart（→ 真实信封 → 客户端解析）')
{
  // 宿主 llm/stream 钩子把「围栏外正文」喂给调度器，句子由调度器 emit。
  // 这里直接驱动真实调度器，断言它产出的业务字段满足客户端依赖的契约：
  //   - 类型正确；index 从 0 连续；para 从 0 递增且段内连续；
  //   - 每个 para 只有第一个片段 paraStart=true（客户端「永不丢弃段首」的依据）。
  const emitted = []
  let seqIndex = 0
  const scheduler = createReadAloudScheduler({
    emit: (event, payload) => emitted.push({ event, payload }),
    nextIndex: () => seqIndex++,
  })
  // 段落 0 故意超过单句上限（60 字）→ 段内切成多个片段；
  // 段落 1 很短 → 只有一个片段。这样能同时验证「多片段段首」和「单片段段首」。
  const para0 = '这是用来测试段落内多个片段的第一句话。'
    + '这是第二句话，内容要足够长以便超过单句上限。'
    + '这是第三句话，继续补充一些内容让总长度明显超过六十个字的上限。'
  const reader = scheduler.reader('sess-1', 'turn-abc')
  reader.push(para0 + '\n\n第二段只有一句话。\n\n')
  reader.end()

  const sentences = emitted.filter((x) => x.event === 'sentence').map((x) => x.payload)
  check('前置：至少切出 2 段、3 个片段', sentences.length >= 3, `pieces=${sentences.length}`)
  check('每条 sentence 带 text/turnId/index/para/paraStart（类型正确）',
    sentences.every((s) => typeof s.text === 'string' && s.text.trim().length > 0
      && typeof s.turnId === 'string' && s.turnId.length > 0
      && Number.isInteger(s.index) && s.index >= 0
      && Number.isInteger(s.para) && s.para >= 0
      && typeof s.paraStart === 'boolean'),
    JSON.stringify(sentences[0]))
  check('sentence.text 是清洗后的纯文本（不含 Markdown 标记）',
    sentences.every((s) => !/[#*`>]/.test(s.text)), JSON.stringify(sentences.map((s) => s.text)))
  check('index 从 0 连续递增（客户端按 (turnId,index) 去重的前提）',
    sentences.every((s, i) => s.index === i), JSON.stringify(sentences.map((s) => s.index)))
  check('para 从 0 开始、单调不减',
    sentences[0]?.para === 0 && sentences.every((s, i) => i === 0 || s.para >= sentences[i - 1].para),
    JSON.stringify(sentences.map((s) => s.para)))
  const flagsByPara = new Map()
  for (const s of sentences) {
    if (!flagsByPara.has(s.para)) flagsByPara.set(s.para, [])
    flagsByPara.get(s.para).push(s.paraStart)
  }
  check('每个 para 只有第一个片段 paraStart=true、其余 false',
    [...flagsByPara.values()].every((flags) => flags[0] === true
      && flags.slice(1).every((f) => f === false)),
    JSON.stringify([...flagsByPara.entries()]))
  check('同一 para 的片段连续出现（段落不交叉）',
    (() => {
      const seen = new Set()
      let last = -1
      for (const s of sentences) {
        if (s.para === last) continue
        if (seen.has(s.para)) return false
        seen.add(s.para)
        last = s.para
      }
      return true
    })(),
    JSON.stringify(sentences.map((s) => s.para)))

  // 接缝第二步：这些业务字段必须能被**真实信封 + 客户端解析**原样带过去。
  const roundTrip = sentences.map((s) => parseEnvelope({ data: JSON.stringify(buildEventEnvelope(s)) }))
  check('真实信封 + parseEnvelope 后 para/paraStart/index/turnId/text 原样保留',
    roundTrip.every((p, i) => p.v === EVENT_PROTOCOL_VERSION
      && p.para === sentences[i].para
      && p.paraStart === sentences[i].paraStart
      && p.index === sentences[i].index
      && p.turnId === sentences[i].turnId
      && p.text === sentences[i].text),
    JSON.stringify(roundTrip[0]))
  scheduler.dispose()
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
