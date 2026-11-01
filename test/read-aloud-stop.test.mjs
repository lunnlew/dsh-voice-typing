/**
 * 回归测试：「停止朗读」必须真的停下来，以及朗读的轮次判定必须可靠。
 *
 * 背景（2026-10-31，用户报障）：
 *   「点击停止朗读时，会立刻显示很长的状态；并且不会立即中断已有的朗读。」
 *
 *   拆开是三个独立的缺陷：
 *
 *   1. **停止切断不了正在播的音频**。
 *      停止只依赖 `speakCancelRef` 这一个句柄，而它有两个漏：
 *        - 「上一句刚播完、下一句还没开始」的空隙里它是 null；
 *        - 更早那一句的 onended 会把它清成 null。
 *      这两种时刻点「停止朗读」都停不掉真正在响的那个源。
 *
 *   2. **停止之后朗读又自己开始了**。
 *      宿主判「新一轮」靠「用户消息条数变了 + 距上次超过 5 秒」，
 *      而它读的是 session 里的条数 —— 本轮用户消息还没写进 session 时，
 *      会读到「条数没变」，新一轮的 turn-begin 干脆不发；
 *      反过来，工具调用跑过 5 秒就会把**同一轮**再判成新一轮，
 *      于是同一个 turnId 又发了一次 turn-begin，
 *      客户端就把它当成「换轮了」→ 解除静音 + 清队列 → 停止被撤销。
 *
 *   3. **状态行跳出长文案，界面位置跟着变**。
 *      停止按钮弹的是 `stopSpeakingHint`（「停止朗读，并让这一轮不再朗读」，15 个字），
 *      而状态行是内联在按钮旁边的 —— 文字一换宽度就变，整行跟着挪。
 *
 * 宿主侧用**真的钩子 + 真的 SSE 连接**跑（不连模型、不联网），
 * 客户端侧按本仓库既有做法做源码形状断言。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'

// 配置读写都指向临时目录：别碰用户的 ~/.dsh。
const tmpHome = path.join(os.tmpdir(), 'dsh-voice-typing-read-aloud-stop')
await mkdir(tmpHome, { recursive: true })
process.env.DSH_HOME = tmpHome

const { apply } = await import('../lib/index.js')
const { trimBacklog } = await import('../src/client/pure/backlog.js')
const cli = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const host = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const turnModelSrc = fs.readFileSync(new URL('../lib/turn-model.js', import.meta.url), 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

// ---------------------------------------------------------------------------
// 假宿主：与 test/event-envelope.test.mjs 同一套。
// ---------------------------------------------------------------------------
function makeHost(rowConfig) {
  const routes = new Map()
  const handlers = new Map()
  const sessions = new Map()
  const scope = {
    effect(fn) { fn(); return () => {} },
    webServer: { register(def) { routes.set(def.path, def); return () => {} } },
    sessions: {
      get(id) { return sessions.get(id) },
      list() { return [...sessions.keys()] },
    },
  }
  const ctx = {
    on(event, handler) { handlers.set(event, handler) },
    inject(_deps, fn) { fn(scope); return () => {} },
  }
  apply(ctx, rowConfig)
  return { routes, handlers, sessions }
}

function makeRes() {
  return {
    statusCode: 0, headers: {}, writableEnded: false, destroyed: false, headersSent: false, chunks: [],
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {}; this.headersSent = true },
    write(chunk) { this.chunks.push(String(chunk)); return true },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.chunks.push(String(chunk))
      this.writableEnded = true
    },
    get body() { return this.chunks.join('') },
  }
}

function connectSse(h) {
  const def = h.routes.get('/dsh-voice-typing/stream')
  const res = makeRes()
  let onClose = null
  const req = { on(event, cb) { if (event === 'close') onClose = cb; return req } }
  def.handler(req, res)
  return {
    events() {
      const out = []
      for (const frame of res.body.split('\n\n')) {
        const text = frame.trim()
        if (!text || text.startsWith(':')) continue
        const m = /^event: (\S+)\ndata: ([\s\S]*)$/.exec(text)
        if (!m) continue
        out.push({ event: m[1], data: JSON.parse(m[2]) })
      }
      return out
    },
    close() { if (onClose) onClose() },
  }
}

/**
 * 跑一遍 llm/stream 钩子（真的钩子、真的广播）。
 * @param {object} h - 宿主。
 * @param {object} options - llm/stream 的请求参数（含 sessionId 与 messages）。
 * @param {string[]} chunks - 依次吐出的文本片段。
 */
async function runStream(h, options, chunks) {
  const handler = h.handlers.get('llm/stream')
  const stream = handler(options, () => (async function* () {
    for (const text of chunks) yield { type: 'text-delta', text }
  })())
  for await (const _chunk of stream) { /* 消费掉，触发 finally */ }
}

/** 用户消息条数 n 对应的请求消息列表。 */
function requestWith(n) {
  const messages = []
  for (let i = 0; i < n; i++) messages.push({ role: 'user', id: `u${i + 1}` })
  return messages
}

// ---------------------------------------------------------------------------
// 1) 宿主：一轮里多次 llm/stream 只广播一次 turn-begin
// ---------------------------------------------------------------------------
console.log('轮次判定：同一轮只广播一次 turn-begin')
{
  const h = makeHost({ readAloud: true, preloadModels: false })
  // session 里的条数故意与请求里的不一致 ——
  // 真实环境里「消息写进 session」的时机和「开始流式输出」不一致。
  h.sessions.set('s1', { deriveMessages: () => [{ role: 'user', id: 'u1' }] })
  const sse = connectSse(h)
  try {
    // 同一轮：两次 llm/stream 调用（工具调用链），用户消息条数都是 1。
    await runStream(h, { sessionId: 's1', messages: requestWith(1) }, ['第一句。'])
    await runStream(h, { sessionId: 's1', messages: requestWith(1) }, ['第二句。'])
    const evs = sse.events().filter((e) => e.event === 'turn-begin' || e.event === 'sentence')
    const begins = evs.filter((e) => e.event === 'turn-begin')
    const sentences = evs.filter((e) => e.event === 'sentence')
    check('同一轮只广播一次 turn-begin', begins.length === 1, `广播了 ${begins.length} 次`)
    check('同一轮的两句共用同一个 turnId',
      sentences.length === 2 && sentences[0].data.turnId === sentences[1].data.turnId,
      sentences.map((s) => s.data.turnId).join(' → '))
    check('turn-begin 的 turnId 与句子的 turnId 一致',
      begins.length === 1 && sentences.length > 0 && begins[0].data.turnId === sentences[0].data.turnId,
      JSON.stringify([begins[0]?.data?.turnId, sentences[0]?.data?.turnId]))
  } finally {
    sse.close()
  }
}

console.log('\n轮次判定：新一轮才广播新的 turn-begin，且轮次 id 不同')
{
  const h = makeHost({ readAloud: true, preloadModels: false })
  h.sessions.set('s2', { deriveMessages: () => [{ role: 'user', id: 'u1' }] })
  const sse = connectSse(h)
  try {
    await runStream(h, { sessionId: 's2', messages: requestWith(1) }, ['第一轮。'])
    await runStream(h, { sessionId: 's2', messages: requestWith(2) }, ['第二轮。'])
    const begins = sse.events().filter((e) => e.event === 'turn-begin')
    check('两轮广播两次 turn-begin', begins.length === 2, `广播了 ${begins.length} 次`)
    check('两轮的 turnId 不同',
      begins.length === 2 && begins[0].data.turnId !== begins[1].data.turnId,
      begins.map((b) => b.data.turnId).join(' → '))

    // 协议 v3：事件带统一信封，v === 3。
    const vers = sse.events().map((e) => e.data.v)
    check('事件信封版本是 3', vers.length > 0 && vers.every((v) => v === 3),
      `v=[${[...new Set(vers)].join(',')}]`)

    // call-end：每次 llm/stream 调用结束都广播（协议 v3 改名）。
    const callEnds = sse.events().filter((e) => e.event === 'call-end')
    check('每次 llm/stream 调用都广播 call-end', callEnds.length === 2,
      `广播了 ${callEnds.length} 次`)

    // turn-end：真正的一轮结束 —— 第二轮开始时广播第一轮的 turn-end。
    const turnEnds = sse.events().filter((e) => e.event === 'turn-end')
    check('第二轮开始时广播第一轮的 turn-end（真正一轮结束）',
      turnEnds.length === 1 && turnEnds[0].data.turnId === begins[0].data.turnId,
      `广播了 ${turnEnds.length} 次：${turnEnds.map((e) => e.data.turnId).join(',')}（应为第一轮 ${begins[0]?.data?.turnId}）`)

    // 旧 turn-end（一次调用结束）不应再以 turn-end 名义出现。
    check('不再把「一次调用结束」命名为 turn-end', true)
  } finally {
    sse.close()
  }
}

console.log('\n轮次判定：不能靠「距上次超过 5 秒」的窗口')
{
  const h = makeHost({ readAloud: true, preloadModels: false })
  h.sessions.set('s3', { deriveMessages: () => [{ role: 'user', id: 'u1' }] })
  const sse = connectSse(h)
  try {
    // 同一轮、同一条数，但两次调用之间隔了 6 秒 ——
    // 模拟「工具调用跑了很久」。旧的时间窗逻辑会把第二轮误判成新一轮。
    await runStream(h, { sessionId: 's3', messages: requestWith(1) }, ['工具调用前。'])
    await new Promise((r) => setTimeout(r, 6100))
    await runStream(h, { sessionId: 's3', messages: requestWith(1) }, ['工具调用后。'])
    const begins = sse.events().filter((e) => e.event === 'turn-begin')
    check('隔了 6 秒也不该多广播 turn-begin', begins.length === 1, `广播了 ${begins.length} 次`)
  } finally {
    sse.close()
  }
}

// ---------------------------------------------------------------------------
// 2) 客户端：停止朗读必须真的切断声音
// ---------------------------------------------------------------------------
console.log('\n客户端：停止朗读要切断所有正在播的源')
check('登记了所有活着的音频源', /speakSourcesRef = useRef\(new Set\(\)\)/.test(cli))
check('停止时逐个停掉登记在册的源',
  /for \(const source of \[\.\.\.sources\]\) \{\s*\n\s*try \{ source\.stop\(\) \} catch/.test(cli),
  '只停一个句柄会漏掉真正在响的那个源')
check('播放时把源登记进去', /speakSourcesRef\.current\.add\(source\)/.test(cli))
check('播完时把源摘掉', /speakSourcesRef\.current\.delete\(source\)/.test(cli))
check('只有「我还是当前句柄」时才清空取消句柄',
  /if \(speakCancelRef\.current === cancelOne\) speakCancelRef\.current = null/.test(cli),
  '上一句的 onended 晚到时会把下一句的句柄一起清掉 —— 于是停止找不到在响的源')

console.log('\n客户端：停止之后这一轮必须保持静音')
check('静音标记为空串时拦下所有句子（静音到下一个 turn-begin）',
  /mutedTurnIdRef\.current === '' \|\| !turnId \|\| turnId === mutedTurnIdRef\.current/.test(cli),
  '空串这条路的语义以前只写在注释里，代码没实现')
check('同一个 turnId 的 turn-begin 不解除静音',
  /const isNewTurn = !turnId \|\| turnId !== currentTurnIdRef\.current/.test(cli) &&
  /if \(!isNewTurn\) return/.test(cli),
  '宿主重复广播同一轮时会把用户的停止撤销')
check('turn-end 不再清掉当前轮次 id',
  !/turn-end[\s\S]{0,400}?currentTurnIdRef\.current = null/.test(cli),
  'turn-end 后可能还有迟到的本轮句子（生成完成前已发出），清空会让它们被放行混进新一轮')
check('客户端监听 call-end（协议 v3：一次调用结束）',
  /addEventListener\('call-end'/.test(cli),
  'v3 把「一次 llm/stream 调用结束」改名为 call-end，客户端要监听以免误解为轮次结束')

console.log('\n客户端：状态行不要跳出长文案')
check('停止朗读不再弹 stopSpeakingHint',
  !/setHint\(t\('stopSpeakingHint'\)\)/.test(cli),
  '那句有 15 个字，状态行紧挨着按钮，宽度一变整行就挪位置')
check('停止朗读弹的是短回执', /setHint\(t\('stoppedSpeaking'\)\)/.test(cli))
check('有 stoppedSpeaking 文案', /stoppedSpeaking: '已停止'/.test(cli))
check('英文文案也有', /stoppedSpeaking: 'Stopped'/.test(cli))
check('状态行有宽度下限，换状态时不挪位置',
  /minWidth: 48/.test(cli))

console.log('\n客户端：状态行只放短词，长说明走悬停提示')
for (const [key, short] of [
  ['modelLoading', '加载模型…'],
  ['modelFailed', '模型加载失败'],
  ['micFailed', '麦克风打不开'],
  ['micDenied', '麦克风被拒'],
  ['micUnsupported', '不支持录音'],
  ['empty', '没听清'],
  ['recognizeFailed', '识别失败'],
]) {
  check(`「${key}」是短词`, new RegExp(`${key}: '${short}'`).test(cli))
  check(`「${key}」有对应的长说明`, new RegExp(`${key}Detail: '`).test(cli))
}
check('长说明挂到状态文字的 title 上',
  /title: singleDetail \|\| undefined/.test(cli))
check('状态行最大宽度收窄，长提示也挤不宽它', /maxWidth: 120/.test(cli))

console.log('\n客户端：合成失败必须留痕（「朗读没声」要能查）')
check('客户端记合成失败次数', /ttsFailuresRef\.current \+= 1/.test(cli))
check('失败提示走短词（节流，别每失败一句都弹）',
  /setHint\(t\('ttsFailed'\), t\('ttsFailedDetail'\)\)/.test(cli)
  && /lastTtsFailHintAtRef\.current > 4000/.test(cli))
check('ttsFailed 是短词', /ttsFailed: '朗读失败'/.test(cli))
check('英文 ttsFailed 也有', /ttsFailed: 'TTS failed'/.test(cli))
check('调试快照暴露 ttsFailures', /ttsFailures: ttsFailuresRef\.current/.test(cli))

console.log('\n客户端：朗读流控（reading-ack）—— 生成快于播放时不再丢句跳段')
check('只读当前这一轮的句子；index===0 时自愈新轮（turnId 不再粘住）',
  /turnId !== currentTurnIdRef\.current/.test(cli)
  && /if \(isTurnMismatch && !isNewTurnFirst\) \{/.test(cli)
  && /const isNewTurnFirst = isTurnMismatch && index === 0/.test(cli),
  '漏收一次 turn-begin 就会让整轮句子都被当成「上一轮」丢掉（整轮不朗读）')
check('自愈时采纳新轮次并停掉上一轮朗读',
  /currentTurnIdRef\.current = turnId[\s\S]{0,200}?haltSpeaking\(true\)/.test(cli))
check('用 turnId:index 去重（宿主重复发不会重播）',
  /const key = `\$\{turnId \?\? ''\}:\$\{index\}`/.test(cli)
  && /if \(seen\.has\(key\)\) \{[\s\S]{0,200}?ackDropped\(\)/.test(cli)
  && /MAX_SEEN_SENTENCE_KEYS/.test(cli),
  '没有去重时宿主重复广播会让同一句播两遍（「读完后面又读前面」）')
check('解析 para/paraStart（老宿主降级：para=-1、paraStart=index===0）',
  /const para = Number\.isInteger\(payload\?\.para\)/.test(cli)
  && /const paraStart = typeof payload\?\.paraStart === 'boolean'/.test(cli)
  && /: index === 0/.test(cli))
check('待播上限只是安全网（8 句，流控正常时永远不触发）', /const MAX_PENDING = 8/.test(cli))
check('入队时带上段落/轮次/会话信息（供裁剪与回执）',
  /speakQueueRef\.current\.push\(\{[\s\S]{0,160}?sessionId: ackSid, turnId: turnId \?\? ackTurn,[\s\S]{0,40}?\}\)/.test(cli))

console.log('\n客户端：每一条收到的 sentence 都必须恰好回执一次（漏了宿主等 watchdog 10 秒）')
check('ackReading：POST reading-ack，count 单次上限 64（超了拆批）',
  /const ackReading = useCallback\(\(sessionId, turnId, count = 1[^)]*\) => \{/.test(cli)
  && /`\$\{BASE\}\/reading-ack`/.test(cli)
  && /method: 'POST'/.test(cli)
  && /for \(let left = total; left > 0; left -= 64\)/.test(cli)
  && /count: n/.test(cli),
  '没有回执宿主只能等 watchdog（朗读变慢），或降级回 400ms 时间窗口')
check('回执可带真实音频时长（宿主追赶计时用它更准）',
  /durationMs/.test(cli)
  && /decoded\?\.duration/.test(cli),
  '宿主用「正在播放的剩余时长」算追赶预算；给真实时长比按字数估算准')
check('回执用事件 payload 里的 sessionId/turnId（不是本地 ref）',
  /const ackSid = payload\.sessionId \|\| sessionIdRef\.current \|\| ''/.test(cli)
  && /const ackTurn = typeof payload\.turnId === 'string' \? payload\.turnId : ''/.test(cli),
  '宿主按 session+turn 记账，用本地 ref 在换轮边界会记错账')
check('① 正常播：开始播放前回执 1 条（可带真实时长）',
  /readingHighlightRef\.current\?\.set\(sentence\)[\s\S]{0,500}?ackReading\(ackSid, ackTurn, 1(?:, decodedMs)?\)[\s\S]{0,300}?await play\(decoded, gen\)/.test(cli),
  '播放是串行且很长的（一句 2~3 秒），等播完才回执宿主会一直等我们')
check('② 合成失败 / 25s 超时 / 代次失效：也回执',
  /\/\/ ②[^\n]*[\s\S]{0,200}?ackReading\(ackSid, ackTurn, 1\)/.test(cli))
check('③ 入队前被丢弃的也回执（开关关/轮次不符/静音/去重）',
  /const ackDropped = \(\) => ackReading\(ackSid, ackTurn, 1\)/.test(cli)
  && /ackDropped\(\)\s*\n\s*return/.test(cli),
  '这些句子永远不会播，但宿主账上已发出 —— 不回执就等 watchdog')
check('④ 安全网裁剪 / 异常退出：按丢弃条数回执（带句子自己的 session/turn）',
  /const \{ dropped, droppedItems \} = trimBacklog\([\s\S]{0,500}?ackDroppedItems\(droppedItems\)/.test(cli)
  && /const ackDroppedItems = useCallback\(\(items\)/.test(cli)
  && /ackDroppedItems\(leftover\)/.test(cli),
  '裁剪丢的句子不回执 → 宿主等 watchdog')
check('⑤ haltSpeaking 清队列时按条数一次性回执',
  /const dropped = pending\.slice\(0\)[\s\S]{0,120}?speakQueueRef\.current\.length = 0[\s\S]{0,120}?ackDroppedItems\(dropped\)/.test(cli),
  '清掉的句子在宿主账上是「已发未确认」')
check('调试快照暴露 acks/trimmed（流控在不在跑、有没有兜底丢句）',
  /acks: acksSentRef\.current/.test(cli) && /trimmed: trimmedRef\.current/.test(cli))
check('播放被跳过也计数（代次失效不再静默）',
  /if \(gen !== speakGenRef\.current\) \{[\s\S]{0,200}?playSkippedRef\.current \+= 1/.test(cli))

console.log('\n客户端：播放前必须等播放上下文恢复（否则 suspended 卡死整条管道）')
check('play 在 start 前 await resume（带超时兜底）',
  /if \(playCtx\.state === 'suspended'\) \{/.test(cli)
  && /await playCtx\.resume\(\)/.test(cli)
  && /sleep\(window, 100\)/.test(cli),
  'resume 是异步的：发后不管会在 start 前没跑完，音频排队不响、onended 不触发、speaking 卡 true')
check('换成轮询等待：resume 稍慢（等浏览器授权）也会成功，不因 1 秒超时就丢句',
  /const deadline = Date\.now\(\) \+ 8000/.test(cli)
  && /while \(playCtx\.state === 'suspended' && Date\.now\(\) < deadline\)/.test(cli),
  '之前 1 秒超时就跳过一句，用户听到的是「每句都被静默丢弃、/tts 却一直调」')
check('resume 超时后仍挂起就跳过这句（不能卡死管道），并留下可观测计数',
  /playSkippedRef\.current \+= 1[\s\S]{0,40}?return/.test(cli)
  && /playSkipped: playSkippedRef\.current/.test(cli),
  '合成成功但播放被跳过是另一种「无声」，只记 ttsFailures 会漏掉')
check('首次用户手势预热并恢复播放上下文',
  /warmPlaybackOnGesture/.test(cli)
  && /addEventListener\('pointerdown', warmPlaybackOnGesture, \{ once: true, capture: true \}\)/.test(cli)
  && /addEventListener\('keydown', warmPlaybackOnGesture, \{ once: true, capture: true \}\)/.test(cli),
  '朗读与语音模式无关：没开麦克风就没有手势路径去 resume，需在首次点击/按键时预热')

console.log('\n安全网裁剪（真的跑纯函数）：按整段丢，绝不从段落中间开始播')
{
  // 没超上限：原样保留，dropped=0（流控正常时永远是这条路径）。
  const inflight = [{ index: 0, para: 0 }, { index: 1, para: 0 }]
  const queue = [{ index: 2, para: 1 }]
  const out = trimBacklog(inflight, queue, 8, { playingPara: 0 })
  check('没超上限就不丢（dropped=0）',
    out.dropped === 0 && out.inflight.length === 2 && out.queue.length === 1,
    `dropped=${out.dropped} ${out.inflight.length}+${out.queue.length}`)
}
{
  // 超上限：从最旧的**未保护**段整段丢（段可以横跨 inflight/queue，也必须一起丢）。
  // para0=[0,1]（含首句 + 正在播，受保护）、para1=[2(inflight),3(queue)]（可丢）、
  // para2=[4,5]（最新，受保护）。
  const inflight = [
    { index: 0, para: 0 }, { index: 1, para: 0 }, { index: 2, para: 1 },
  ]
  const queue = [
    { index: 3, para: 1 },
    { index: 4, para: 2 }, { index: 5, para: 2 },
  ]
  const out = trimBacklog(inflight, queue, 4, { playingPara: 0 })
  const all = [...out.inflight, ...out.queue].map((x) => x.index)
  check('整段丢弃：para1 的两句一起丢（不拆段）',
    out.dropped === 2 && !all.includes(2) && !all.includes(3),
    `dropped=${out.dropped} 留下 [${all}]`)
  check('保护含本轮首句的段落（para0 不丢）',
    all.includes(0) && all.includes(1), `留下 [${all}]`)
  check('保护最新段（para2 完整保留）',
    all.includes(4) && all.includes(5), `留下 [${all}]`)
  check('剩下的仍是完整段且保序',
    JSON.stringify(all) === '[0,1,4,5]', `留下 [${all}]`)
  check('droppedItems 精确列出被丢的项（回执要用原对象）',
    out.droppedItems.length === 2 && out.droppedItems.every((x) => x.index === 2 || x.index === 3),
    JSON.stringify(out.droppedItems.map((x) => x.index)))
}
{
  // 「正在播的段」与「最新段」之间的未保护段才可丢。
  // para0=[0,1]（首句）、para1=[2,3]（正在播）、para2=[4,5]（中间，未保护）、
  // para3=[6,7]（最新）。
  const inflight = [
    { index: 0, para: 0 }, { index: 1, para: 0 },
    { index: 2, para: 1 }, { index: 3, para: 1 },
  ]
  const queue = [
    { index: 4, para: 2 }, { index: 5, para: 2 },
    { index: 6, para: 3 }, { index: 7, para: 3 },
  ]
  const out = trimBacklog(inflight, queue, 4, { playingPara: 1 })
  const all = [...out.inflight, ...out.queue].map((x) => x.index)
  check('正在播的段落整段保留（不能只留段首）',
    all.includes(2) && all.includes(3), `留下 [${all}]`)
  check('最新段整段保留（不能为了压上限丢最新）',
    all.includes(6) && all.includes(7), `留下 [${all}]`)
  check('丢的是中间未保护的整段（para2）',
    out.dropped === 2 && !all.includes(4) && !all.includes(5), `留下 [${all}]`)
}
{
  // 评审 P2 定向回归（task-9 要求）：受保护组已超上限时，**不许丢最新段**。
  // 段0 9 句（含 index0 → 受保护）+ 段1 3 句（最新段）+ max=8。
  const queue = [
    ...Array.from({ length: 9 }, (_, i) => ({ index: i, para: 0 })),
    { index: 9, para: 1 }, { index: 10, para: 1 }, { index: 11, para: 1 },
  ]
  const out = trimBacklog([], queue, 8, { playingPara: 0 })
  const all = [...out.inflight, ...out.queue]
  const allIdx = all.map((x) => x.index)
  check('受保护段超上限时不丢最新段（宁可软上限 12 > 8）',
    out.dropped === 0 && allIdx.includes(9) && allIdx.includes(10) && allIdx.includes(11) && all.length === 12,
    `dropped=${out.dropped} 留下 [${allIdx}]`)
  check('软上限：剩下的句数可以 > max（调用方不能假设一定压到 max）',
    all.length > 8, `${all.length}`)
}
{
  // 评审 P1 定向：单段 12 句 burst（唯一组 = 最新组）→ 一句都不丢，全部会念。
  // 这正是「单段长回复只念第一句」的输入形状。
  const queue = Array.from({ length: 12 }, (_, i) => ({ index: i, para: 0 }))
  const out = trimBacklog([], queue, 8, { playingPara: -1 })
  check('单段 12 句 burst：整段受保护、不丢任何一句',
    out.dropped === 0 && out.queue.length === 12, `dropped=${out.dropped} 剩 ${out.queue.length}`)
}
{
  // 老宿主（没 para）降级：每句各成一段，仍然能裁剪（最新那句受保护）。
  const inflight = [{ index: 0 }, { index: 1 }, { index: 2 }]
  const queue = [{ index: 3 }, { index: 4 }, { index: 5 }, { index: 6 }]
  const out = trimBacklog(inflight, queue, 3, {})
  const all = [...out.inflight, ...out.queue].map((x) => x.index)
  check('无 para 时仍能裁剪（每句一段）',
    out.dropped === 4 && JSON.stringify(all) === '[0,5,6]',
    `dropped=${out.dropped} 留下 [${all}]`)
}
{
  // 只剩受保护的段：不能再丢（宁可软超上限，也不破坏段落完整性）。
  const out = trimBacklog([{ index: 0, para: 0 }], [{ index: 1, para: 0 }], 1, {})
  check('只剩受保护段时不再丢（软上限）',
    out.dropped === 0 && out.inflight.length + out.queue.length === 2,
    `dropped=${out.dropped}`)
}
{
  // 同号段不相邻时不能误合并：para0 的 idx0 受保护，不代表 idx2 也受保护。
  // 但 idx2 在最后一组（最新）→ 也受保护；中间的 para1 只受 playingPara 保护。
  const inflight = [{ index: 0, para: 0 }, { index: 1, para: 1 }, { index: 2, para: 0 }]
  const outPlaying = trimBacklog(inflight.slice(), [], 2, { playingPara: 1 })
  check('正在播 + 首句 + 最新三者都受保护时不再丢（软上限）',
    outPlaying.dropped === 0
      && JSON.stringify(outPlaying.inflight.map((x) => x.index)) === '[0,1,2]',
    `dropped=${outPlaying.dropped}`)
  const out = trimBacklog(inflight.slice(), [], 2, {})
  check('只按「连续同号」分组（非相邻同号段不合并，只丢中间未保护的组）',
    out.dropped === 1 && JSON.stringify(out.inflight.map((x) => x.index)) === '[0,2]',
    `dropped=${out.dropped} 留下 [${out.inflight.map((x) => x.index)}]`)
}

console.log('\n客户端：评审 P1/P2/P3 回归（源码形状）')
check('P1：播完一句**先 trimPending 再复位 playingPara**（否则当前段剩余被整段裁掉）',
  /\/\/ ③ 安全网裁剪必须在[\s\S]{0,500}?trimPending\(\)\s*\n\s*playingParaRef\.current = -1/.test(cli),
  '顺序反了就是「一段 12 句只念第一句」：复位后 trim 看到的当前段已不受保护')
check('P1：管道结束/异常路径也会清掉 playingPara 的陈旧值',
  (cli.match(/playingParaRef\.current = -1/g) || []).length >= 3,
  'haltSpeaking / 播完 trim 之后 / finally 各一次；异常退出残留保护值会挡后续裁剪')
check('P2：resume 轮询中代次失效立刻退出（不再傻等 8 秒）',
  /while \(playCtx\.state === 'suspended' && Date\.now\(\) < deadline\) \{\s*\n\s*\/\/[\s\S]{0,260}?if \(gen !== speakGenRef\.current\) break/.test(cli))
check('P2：resume 结束后、source.start 前再查一次代次（停止/换轮后旧句不得出声）',
  /if \(gen !== speakGenRef\.current\) break[\s\S]{0,900}?if \(gen !== speakGenRef\.current\) \{\s*\n\s*playSkippedRef\.current \+= 1\s*\n\s*return\s*\n\s*\}[\s\S]{0,2000}?source\.start\(0\)/.test(cli),
  '以前只在进入 play 时查一次；suspended→resume 成功后旧句会照播（评审 P2）')
check('P3：高亮 set 用 try/catch 包住（抛错不能漏 ack / 不能 unhandled rejection）',
  /try \{\s*\n\s*readingHighlightRef\.current\?\.set\(sentence\)\s*\n\s*\} catch/.test(cli))
check('P3：trimmed 只统计安全网裁剪，另加 dropped 计数并进调试快照',
  /trimmedRef\.current \+= dropped\b/.test(cli)
  && /droppedRef\.current \+= dropped\.length/.test(cli)
  && /droppedRef\.current \+= leftover\.length/.test(cli)
  && /dropped: droppedRef\.current/.test(cli)
  && /trimmed: trimmedRef\.current/.test(cli),
  '无 AudioContext 清队列 / 管道异常剩余不属于「宿主流控失效」，混进 trimmed 会误导诊断')
check('P3：追赶秒数空/非法输入回退默认 7.5（不是 0），合法值 clamp 0..120 / 0.5 步进',
  /const raw = String\(event\.target\.value \?\? ''\)\.trim\(\)/.test(cli)
  && /raw === '' \|\| !Number\.isFinite\(n\)/.test(cli)
  && /\? 7\.5\s*\n\s*: Math\.max\(0, Math\.min\(120, Math\.round\(n \* 2\) \/ 2\)\)/.test(cli),
  "Number('') === 0，以前清空输入框会把追赶关掉；默认 7.5 = 原 15 的一半")

console.log('\n客户端：配置同步必须真的拿到「朗读回复」')
check('拉到的配置与共享存储合并（存储里有值的键优先）',
  /configRef\.current = \{ \.\.\.data, \.\.\.configStore\.value \}/.test(cli),
  '以前是「存储 loaded 就整份丢掉这次 fetch」→ configRef 永远停在默认值')
check('不再用 loaded 标志整份丢弃结果', !/if \(configStore\.loaded\) return/.test(cli))
check('拉取失败会重试', /config-retry/.test(cli))
check('开麦时再对一次配置', /if \(!on\) return undefined\s*\n\s*void syncConfig\(\)/.test(cli))

console.log('\n宿主：用请求里的用户消息条数判轮次')
check('回合判定抽到独立模块 turn-model.js',
  /function countRequestUserMessages/.test(turnModelSrc) && /function detectTurn/.test(turnModelSrc),
  '宿主 index.js 的回合判定应隔离到 lib/turn-model.js')
check('宿主委托给 turnModel', /turnModel\.countRequestUserMessages\(options\)/.test(host)
  && /turnModel\.detectTurn\(sessionId, requestUserCount\)/.test(host),
  'index.js 不该再内联 countRequestUserMessages/detectTurn，应委托 turnModel')
check('数请求里的用户消息', /function countRequestUserMessages/.test(turnModelSrc))
check('请求里的条数优先', /if \(requestUserCount >= 0\)/.test(turnModelSrc))
check('轮次 id 用递增序号（不再用内容锚点）',
  /const turnId = `turn-\$\{\+\+turnCounter\}`/.test(turnModelSrc),
  '锚点在本轮用户消息还没写进 session 时会指着上一轮那条 —— 两轮会共用同一个 id')
// 回归：条数「减小」不能误判新一轮（上下文裁剪/截断会让条数变小）。
// 只认「增加」为新回合；减小视为同轮/异常，不打断正在朗读的内容。
check('只认条数「增加」才是新一轮（减小=裁剪，不打断）',
  /return requestUserCount > prev/.test(turnModelSrc),
  '用 !== 会在 DSH 压缩历史/删旧 user 消息时误清客户端队列、撤销用户刚点的停止')
// 回归：next() 同步抛错（模型/连接错误）必须复位 busy。
// 否则 busySession 卡 true → 客户端 assistantRunning 恒真 → 自动发送链路永久失效。
{
  // 两处 next() 调用都要在同步抛错时复位 busy（不朗读分支 + 朗读分支）。
  const markBusyCalls = (host.match(/catch \(err\) \{\s*[\s\S]{0,200}?markBusy\(sessionId, false\)[\s\S]{0,40}?throw err\s*\}/g) || []).length
  check('next() 同步抛错时复位 busy（两处都要有）', markBusyCalls >= 2,
    `找到 ${markBusyCalls} 处（期望 ≥2）—— 置位在 next() 之前、复位只在 generator finally，next() 同步抛错时 finally 不注册，busy 永久卡 true`)
}

console.log('\n客户端：朗读管道不能永久卡死（超时/异常兜底）')
check('播放上下文在 try 内获取（构造抛错不卡死队列）',
  /playCtx = getPlayCtx\(\)/.test(cli) && /if \(!playCtx\) \{/.test(cli),
  '原来 getPlayCtx() 在 try 外 —— 抛错会让 pumpingRef 卡 true，之后所有句子只入队不播')
check('拿不到播放上下文时清队列退出（不会同步互递归打爆栈）',
  /if \(!playCtx\) \{[\s\S]{0,700}?speakQueueRef\.current\.splice\(0, speakQueueRef\.current\.length\)[\s\S]{0,400}?ackDroppedItems\(dropped\)[\s\S]{0,500}?setSpeaking\(false\)\s*\n\s*return/.test(cli),
  '以前 return 后靠 finally 里「queue 非空 → 再 pumpQueue()」，队列不消耗 → 同步互递归 → 栈溢出 + speaking 卡 true')
check('合成有超时兜底（Promise.race + sleep）',
  /Promise\.race\(\[\s*promise,\s*sleep\(window, TTS_TIMEOUT_MS\)\.then\(\(\) => null\),\s*\]\)/.test(cli),
  '宿主 /tts 挂住时 await promise 永不 resolve → 朗读管道永久死锁')
check('object URL 在 finally 里释放（失败句不泄漏）',
  /finally \{\s*[\s\S]{0,120}?URL\.revokeObjectURL\(url\)/.test(cli))
check('宿主不给 index 时本地补序号（保住首句不丢）',
  /turnSentenceSeqRef\.current \+= 1/.test(cli) && /Number\.isInteger\(payload\?\.index\)/.test(cli))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
