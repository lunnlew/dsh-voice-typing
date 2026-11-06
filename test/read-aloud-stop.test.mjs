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
 * 宿主侧用**真的钩子 + 真的 SSE 连接**跑（不连模型、不联网）。
 * 客户端侧（批次 3 之后）：能在行为上判出来的都搬去了 test/client-behavior.test.mjs
 * 的场景（文件头有对照表）。
 *
 * 批次 6f 把最后 6 条源码文本判据清掉了（原来 20 条 → 6 条 → **0 条**），
 * 这个文件现在一行客户端源码都不读。6 条的去向：
 *   1. 「自愈时采纳新轮次并停掉上一轮朗读」→ client-behavior 场景「自愈」新增一段：
 *      把每句响的时长调长，让上一轮的源还挂着时新轮的 index 0 到达，
 *      判快照里 turnId 换成新的 + 那个源被当场 stop + 新轮句子照播。
 *      （原来留着的理由是「harness 里自愈发生在两句之间、上一句早已播完」——
 *       那是当时没构造这个形状，不是判不了。）
 *   2. 「管道结束/异常路径也清掉 playingPara 的陈旧值」→ 调试快照新增 `playingPara` 一项
 *      （生产改动，就一行），于是「burst 单段」判开始消耗这句时钉的是它的段号、播完回到 -1，
 *      「关麦复位」D 段判点停止同时把它复位。第三条复位点（拿不到播放上下文的早退）
 *      仍无行为面，原因与推翻条件写在该处注释里。
 *   3. 「trimmed 只统计安全网裁剪，另加 dropped 计数」→ 两边分别真跑：
 *      「burst 多段」把每句调到 400ms 让安全网真的裁（trimmed 涨、dropped 不涨），
 *      「无 AudioContext」走另一格（dropped 涨、trimmed 不涨）。都按**增量**判。
 *   4. 「追赶秒数空/非法回退 7.5、clamp 0..120、0.5 步进」→ 新场景「面板·追赶秒数」：
 *      挂真面板、往真输入框敲 7 种值、看发出去的 POST /config 里的 readAloudLag。
 *      （它自己原本就写着「归批次 5 与 config-ui 一起换组件级判据」。）
 *   5. 「ackReading 的 count 上限 64、超了拆批」→ 拆批算术抽进
 *      `src/client/pure/reading-ack.js`，`test/reading-ack-contract.test.mjs` 第 6 节
 *      对着**真宿主**跑：200 拆成 64/64/64/8，逐批发出去，累计 acks 正好 +200。
 *   6. 「停止切的是在册的每一个源 + 句柄条件清空」→ **删**（没有行为对应物）：
 *      播放是串行的，同一时刻只有一个在册源，两种写法在任何可达状态下结果一样。
 *      现在有实测支撑：场景「自愈」的前置判据数到的在册源就是 1 个。
 *      推翻条件（什么时候必须回来写成行为判据）写在原处注释里。
 *
 * 判据之外另有两处诚实边界，写在 client-behavior.test.mjs 文件头：
 * 「payload.sessionId 优先」被 `belongsToSession` 先丢整条挡住判不动；
 * 假 window 不实现 `{ once: true }`，预热「只响一次」判不动。
 */
import os from 'node:os'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'

// 配置读写都指向临时目录：别碰用户的 ~/.dsh。
const tmpHome = path.join(os.tmpdir(), 'dsh-voice-typing-read-aloud-stop')
await mkdir(tmpHome, { recursive: true })
process.env.DSH_HOME = tmpHome

const { apply } = await import('../lib/index.js')
const { trimBacklog } = await import('../src/client/pure/backlog.js')
// 批次 6f 之后这个文件**不再读客户端源码**：剩下的判据要么真跑宿主路由、
// 要么直接 import 纯函数跑场景（`trimBacklog`），要么在别处真跑（见下面各处注释）。

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

    // 旧 turn-end（一次调用结束）不应再以 turn-end 名义出现：
    // 两次调用 = 两条 call-end；turn-end 只表示「真正一轮结束」，
    // 只应在下一轮开始时为**上一轮**广播一条。
    check('一次调用结束只发 call-end，不冒充 turn-end',
      callEnds.length === 2
      && turnEnds.length === 1
      && turnEnds.every((e) => e.data.turnId === begins[0].data.turnId),
      `callEnds=${callEnds.length} turnEnds=${turnEnds.map((e) => e.data.turnId).join(',')}`)
  } finally {
    sse.close()
  }
}

// 注：「session 条数 + TURN_WINDOW_MS(5000) 时间窗」兜底路径当前**没有测试**。
// 原因：lib/turn-model.js 的 isNewUserTurn 不注入 now（只有 prune 可注入），
// 真实覆盖必须真的等 5 秒。旧版本这里有一个 6.1s 的用例，但它走的是
// requestUserCount 路径、与时间窗无关，且与上面的「同一轮两次调用」重复 ——
// 属于假慢 + 重复，已删除。

// ---------------------------------------------------------------------------
// 2) 客户端：停止朗读必须真的切断声音
// ---------------------------------------------------------------------------
// 这一组原来五条全是扫源码句子（`speakSourcesRef = useRef(new Set())`、
// `for (const source of [...sources])`、`.add(source)`、`.delete(source)`、
// `if (speakCancelRef.current === cancelOne)`）。批次 3 之后：
//   - 「点停止时那个还在响的源真的被 stop 了」→ test/client-behavior.test.mjs
//     场景「停止朗读」判源对象上的 `stopRequested`（假 AudioContext 记的）；
//   - 「播完/停掉的源从在册名单摘干净」→ 同一场景判调试快照的 `playSources === 0`；
//   - 「停止之后这一轮保持静音」「排在后面的不再开播」→ 同一场景（含同轮 turn-begin、
//     没有 turnId 的句子、call-end、turn-end 迟到句四种解除尝试，全部拦下）。
// 注：这里原来有一条「停止切的是**在册的每一个源**，句柄只在『我还是当前句柄』时才清空」
// 的源码写法判据（批次 6f 删掉）。删的理由不是「不重要」，而是**行为上分不出来**：
// 播放是串行的（`pumpQueue` 一句接一句 await，同一时刻只有一句在响），
// 所以「遍历在册的每一个源」与「只掐当前那一个句柄」在任何可达状态下结果一样。
// 这条现在有实测支撑：`test/client-behavior.test.mjs` 场景「自愈」的前置判据
// `[自愈] 前置：上一轮这一句真的还在响` 数到的在册源恒为 **1** 个（queued 还有下一句时也是 1）。
// **推翻条件**：朗读改成并行/重叠播放（同一时刻有 ≥2 个在册源）时，必须回来写成行为判据 ——
// 让两个源同时在册、点停止，判 `liveSources().every((s) => s.stopRequested === true)`。
// 生产代码 1136-1147 行的注释留着（讲的就是这两件事为什么要那样写）。

// ---------------------------------------------------------------------------
// 3) 静音、状态行、合成失败留痕 —— 批次 3 全部换成跑出来的判据
// ---------------------------------------------------------------------------
// 下面十条原来钉的是写法（`mutedTurnIdRef.current === ''`、`isNewTurn`、
// `turn-end` 里不许出现 `currentTurnIdRef.current = null`、`addEventListener('call-end'`、
// `setHint(t('stoppedSpeaking'))`、`minWidth: 48`、`title: singleDetail`、`maxWidth: 120`、
// `ttsFailuresRef.current += 1`、`ttsFailures:`），现在由 test/client-behavior.test.mjs
// 场景「停止朗读」与场景「开麦的时序与就绪判据」判渲染产物与调试快照：
//   静音不被同轮 turn-begin / 无 turnId 句子 / call-end / turn-end 迟到句解除，
//   真正的新轮才恢复；点停止弹短回执、宽度上下限在 span 的 style 上、
//   长说明落在 title；合成失败进 ttsFailures 且提示用短词。
// 「4 秒内两次失败只提示一次」那条节流没有行为对应物（两次弹的是同一个短词，
// 界面看不出来），随这组一起撤下 —— 它是降噪偏好，不是缺陷防线。
// 「没就绪不开麦」的四条（`ensureModelReady()` 排在 `getUserMedia` 之前之类）
// 已在批次 3 前半搬到开麦场景，见 test/listening-ready.test.mjs 的文件头。

console.log('\n客户端：朗读流控（reading-ack）—— 生成快于播放时不再丢句跳段')
// 「只读当前这一轮 + index===0 自愈」「turnId:index 去重」「解析 para/paraStart」
// 「待播上限只是安全网」四条原来扫源码，已由 test/client-behavior.test.mjs 的场景
// 「自愈」「去重」「burst 多段」「burst 时序」（加上本文件真跑的 trimBacklog）判出来，删。
// 批次 4d 再删一条「入队时带上段落/轮次/会话信息」：harness 现在直接按 env.acks 的 turnId
// 分账 —— 场景「换轮」判旧轮被清掉的 6 句记在旧轮 r1、新轮播出的 1 句记在 r2，
// 场景「迟到旧轮」判上一轮迟到的 2 句记在旧轮、本轮 1 句记在新轮。
// 入队项没带 turnId 就分不开这两笔账，比钉 `speakQueueRef.current.push({...})` 那三行强。
// 批次 6f：这一条也搬走了 —— 原来留着的理由是「harness 里自愈发生在两句之间、
// 上一句早已播完，行为上分不出有没有这一步」，那其实是**当时没构造那个形状**：
// 把每句的响时长调长，自愈入口在 SSE handler 里（不被播放循环阻塞），
// 「上一轮的源还挂着」和「新轮 index 0 到来了」就能同时成立。
// 现在由 `test/client-behavior.test.mjs` 场景「自愈」真跑判三件可观察的事：
//   快照里的 turnId 换成新的（采纳新轮次）、上一轮那个还在响的源被当场 stop（haltSpeaking 生效）、
//   新轮第一句照常播得出来且旧轮句子没有回来重播。

console.log('\n客户端：每一条收到的 sentence 都必须恰好回执一次（漏了宿主等 watchdog 10 秒）')
// ①②③④⑤ 这五条原来钉的是「ackReading 出现在哪几个分支里」的写法。
// 同一件事在 test/client-behavior.test.mjs 里是真的数出来的：
//   ①正常播（场景「正常」：每条恰好 ack 一次）、②合成失败（场景「合成失败」）、
//   ③入队前被丢弃（场景「静音」「迟到旧轮」）、④安全网裁剪（场景「burst 单段」：
//   收到 12 句就 ack 12 次）、⑤halt 清队列（场景「换轮」：旧轮 6 句 + 新轮 1 句 = 7 次）。
// 批次 4d 把剩下四条里判得动的都接走了，对照关系：
//   「回执可带真实音频时长」+「回执用 payload 的 session/turn」→ 场景「回执账目」：
//     数 env.acks 的 durationMs（真播出音频的那条带、合成失败的那条不带），
//     以及句子没带 sessionId 时回执落回本地会话、turnId 落在当轮。
//     判不动的一半记在该场景文件头：payload **带了**外来 sessionId 时「优先用 payload」
//     判不出来，`belongsToSession` 先把整条丢掉，走不到 ackReading。
//   「入队带上段落/轮次/会话」→ 见上面「换轮」「迟到旧轮」的按轮分账。
// 只剩下面这一条：拆批要一次塞 65 句以上，而待播队列上限是 8，harness 压不到那个形状。
// 批次 6f：最后这条（「ackReading：POST reading-ack，count 单次上限 64（超了拆批）」，
// 五条正则连判：函数头、URL、method、`for (let left = total; left > 0; left -= 64)`、`count: n`）删掉。
// 原来留着的理由是「要触发拆批得一次丢 65 句以上，而待播队列上限是 8，harness 压不到那个形状」——
// 压不到队列不等于判不了：把拆批的算术从组件里抽进 `src/client/pure/reading-ack.js`，
// 就能对着**真宿主**跑。现在 `test/reading-ack-contract.test.mjs` 第 6 节判的是：
//   1/64/65/200 各拆成什么形状、每批都在 1..64、总和正好等于要还的条数、
//   异常值（0/负数/非数字/NaN/Infinity）按 1 计、小数按 trunc，
//   再把 200 拆出的 4 批**真发给真宿主**，`/diagnostics` 的累计 acks 必须正好 +200。
// 「POST /reading-ack」「method: POST」那两条正则原本守的东西，
// client-behavior 场景「回执账目」早就在数真的请求了（env.acks 条数与 durationMs）。

// ---------------------------------------------------------------------------
// 客户端：播放前必须等播放上下文恢复（否则 suspended 卡死整条管道）
//   —— 本组 5 条源码文本判据批次 4d 全部删掉，换成真的按秒计数的场景。
// ---------------------------------------------------------------------------
// 这四条（play 前 await resume / 8 秒轮询不丢句 / 超时跳过并计数 / 首次手势预热）
// 加下面那条 P2 早退，已由 test/client-behavior.test.mjs 场景「挂起三档+手势」四段真跑判掉：
//   A 上下文怎么 resume 都不恢复 → 等满 8 秒兜底（判 waitedA>=6000：改成 1 秒就丢句会红，
//     那正是「每句都被静默丢弃、/tts 却一直调」的原症状）、这一句不播、playSkipped+1、
//     回执照发；随后上下文恢复 → 下一句照播（管道没被这一次死锁）。
//   B A 的半途换轮 → halt 后 1 秒内 playSkipped 就涨（轮询里那次代次复查提前退出，
//     不是傻等满 8 秒），旧句始终没 start。
//   C 3 秒后才 running → 这一句仍然播得出来，且确实等了 ≥2 秒（不是「等一会儿就静默丢句」）。
//   D 关掉所有上下文后派发 pointerdown / keydown → 两条预热监听都在 window 上装着
//     （从 addEventListener 登记表读，不扫源码），各自把常驻上下文建起来并当场 resume，
//     预热期间一句都不播、一条都不 ack。
// 判不动的：假 window 不实现 `{ once: true }`，「预热只响一次」在这里判不了（该场景注释里记着）。
// 本组 5 条源码文本判据全部删掉 —— 时长类的写法判据换成真的按秒计数的场景。

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

console.log('\n客户端：评审 P1/P2/P3 回归（只剩行为上分不出写法的那几条）')
// P1「播完一句先 trimPending 再复位 playingPara」原来钉的是两行代码的先后次序。
// 它要防的后果有明确的行为对应物：顺序反了 → 当前段的剩余被整段裁掉 →
// 「一段 12 句只念第一句」。test/client-behavior.test.mjs 场景「burst 单段」
// 判 12 句全部播出、场景「burst 时序」判裁剪绝不在开播之后落在当前段上 —— 两条都比
// 顺序本身强，删。
// P2「resume 结束后、source.start 前再查一次代次」同批删除：
// 场景「suspended+halt」在上下文挂起期间换轮，判被 halt 的旧句不再 start。
// 批次 4d 又删两条：
//   「P2 轮询中代次失效立刻退出」→ 场景「挂起三档+手势」B 段，halt 后 1 秒内 playSkipped
//     就涨（少了这次复查要再白等 7 秒，判的是时长而不是写法）；
//   「P3 高亮 set 用 try/catch 包住」→ 场景「高亮抛错」：假 document 的 querySelector
//     当场炸（`set()` 第一步就走它，异常同步冲出来），判两句照播照 ack、
//     没有 unhandled rejection 冲出管道、speaking 正常复位。
// 批次 6f：「P1 管道结束/异常路径也清掉 playingPara 的陈旧值」这条源码计数判据删掉。
// 删的办法不是放弃它，而是把那个保护值**做成看得见的**：调试快照新增一项 `playingPara`
// （`src/client/dom/mic-button.js` 的 debugSnapshot），于是三条复位路径里能真跑的两条
// 有了行为对应物 —— `test/client-behavior.test.mjs`：
//   「burst 单段」：开始消耗这一句时快照里钉的是它的段落号（0），整轮播完回到 -1；
//   「关麦复位」D 段：点停止那一刻正在响的源被掐掉，同时保护值回到 -1（halt 这条路径）。
// 第三条（`if (!playCtx)` 早退时的复位）**仍然判不出来**，如实记着：那条路径在 pump 开头
// 取上下文就失败了，保护值还没来得及被钉成任何段号（本来就该是 -1），
// 少写那一行复位在行为上没有差别 —— 它是防御性的，不是可达状态。
// **推翻条件**：若改成「进 pump 就先钉段号、再取上下文」，这条就有行为面了，
// 要回来补一段「上下文不可用时保护值不残留」的判据。
// 批次 6f：「trimmed 只统计安全网裁剪，另加 dropped 计数并进调试快照」这条五条正则的
// 记账判据删掉 —— 原来留着的理由是「正常流控下两边都是 0，行为上分不出来」，
// 那是**没把两边分别跑出来**：把每句的响时长调到 400ms，安全网就会真的裁（trimmed 涨），
// 把播放上下文设成不可用，走的就是另一格（dropped 涨）。两条现在各判一边、能分别红：
//   `test/client-behavior.test.mjs`「burst 多段」：前置判这一轮真裁过（trimmedDelta>0），
//     再判 droppedDelta 必须是 0；
//   「无 AudioContext」：清掉的三句全进 dropped，trimmedDelta 必须是 0。
// 组件不重挂、计数是 ref 上的累计值，所以两条都按**增量**判（基线在场景开头采）。
// 批次 6f：「追赶秒数空/非法回退默认 7.5、合法值 clamp 0..120 / 0.5 步进」这条删掉。
// 它自己留着一句「归批次 5 与 config-ui 一起换成组件级判据」，这一批真的换了：
// `test/client-behavior.test.mjs` 场景「面板·追赶秒数」把真面板挂起来、
// 往真输入框敲 ''/'abc'/'300'/'-5'/'7.7'/'7.8'/'0'，
// 判的是发出去的 POST /config 里 `readAloudLag` 的值（7.5/7.5/120/0/7.5/8/0）。
// 这条尤其值得换 —— 旧写法最容易踩的坑是「清空输入框 → `Number('')` 是 0」，
// 而 0 在这套配置里的意思是「关掉追赶、全部朗读」，用户只是删了个数字而已。

// ---------------------------------------------------------------------------
// 客户端：配置同步必须真的拿到「朗读回复」
//   —— 本组 4 条源码文本判据批次 4d 全部删掉，换成 client-behavior 的真跑四段。
// ---------------------------------------------------------------------------
// 这四条（配置与存储合并 / 不再用 loaded 整份丢弃 / 拉取失败会重试 / 开麦时再对一次配置）
// 已由 test/client-behavior.test.mjs 场景「配置同步」的四段真跑判掉，写法判据删。
// 四条防的是同一类装机故障：「设置里勾了朗读却不出声，而且全程没有报错」——
// configRef 停在默认值（readAloud:false）时就是这个样子。对照关系：
//   ① 存储里有值的键优先：store 写 readAloud:false、宿主给 true → 这一句不播（但照样 ack）；
//   ② loaded 不再整份丢掉这次 fetch：store 只存过一个无关键且 loaded=true →
//     宿主那份 readAloud:true 照样生效，句子念得出来（旧写法在这里永远不出声）；
//   ③ 拉取失败会重试：第一次 GET /config 失败 → 数得到第二次 GET，且重试拿到的配置真生效；
//   ④ 开麦时再对一次配置：先按挂载拉到的配置念出一句，再把朗读关掉、开麦 →
//     后一句当场不念（配额照样还给宿主）。
// 坑（记在该场景注释里）：配置只在挂载和 `on` 翻转时拉，没有轮询 ——
// 改 `env.config` 必须重新挂载才可能被读到，否则判的是上一段残留的 configRef。

console.log('\n宿主：next() 同步抛错必须复位 busy（真跑钩子，两条分支各一遍）')
// 其余「回合判定抽到 turn-model / 只认条数增加 / turnId 递增序号」的形状断言
// 与本文件重复（批次 4 之前它们在 test/turn-boundary.test.mjs 里对 turn-model.js 扫文本）。
// 那边已改成**真跑 createTurnModel 的单元测试**，本文件继续用真钩子 + 真 SSE 数发出来的帧
// （同一轮两句共用 turnId、两轮 turnId 不同、turn-end 带的是刚结束的上一轮）—— 两边各判一层，
// 没有谁被删空。
//
// busy 复位这一条原来是扫源码数写法（`catch (err) { ... markBusy(sessionId, false) ... throw err }`
// 出现 ≥2 次），只能证明「两处都写了」，证明不了写完还有效（实参写反、markBusy 里少广播一步
// 都照样绿）。现在改成真的把 next() 换成当场抛错，判**外部可观测面**：
//   - 错误照常往外抛（不是被吞掉）；
//   - SSE 的 assistant-busy 置位之后必须跟一条 busy:false；
//   - `/busy` 路由回到 busy:false —— 「/busy 永远 true → 客户端 assistantRunning 恒真
//     → 识别出的文字永远发不出去、全程无报错」正是这条缺陷的原始症状（2026-11-01）。
// 两条分支（不朗读 / 朗读）各跑一遍 = 原来那句「两处都要有」。
{
  async function getBusy(h) {
    const res = makeRes()
    await h.routes.get('/dsh-voice-typing/busy').handler({ method: 'GET' }, res)
    return JSON.parse(res.body)
  }
  for (const readAloud of [false, true]) {
    const label = readAloud ? '朗读' : '不朗读'
    const h = makeHost({ readAloud, preloadModels: false })
    const sse = connectSse(h)
    try {
      let threw = null
      try {
        const stream = h.handlers.get('llm/stream')(
          { sessionId: `busy-${label}`, messages: requestWith(1) },
          () => { throw new Error('fake: 模型/连接当场抛错') },
        )
        for await (const _chunk of stream) { /* 走一遍，把 generator 的 finally 也跑到 */ }
      } catch (error) {
        threw = error
      }
      check(`busy 复位（${label}分支）：错误照常往外抛，不吞`, threw instanceof Error, String(threw))
      const busyFlags = sse.events()
        .filter((e) => e.event === 'assistant-busy')
        .map((e) => e.data.busy)
      // SSE 一连上，宿主会先把当前「忙不忙」推一帧（busy:false），所以判的是
      // 「置位那一条」之后有没有跟着复位那一条，而不是整个序列的形状。
      const trueAt = busyFlags.indexOf(true)
      check(`busy 复位（${label}分支）：置位恰好一次，且之后必有 busy:false`,
        busyFlags.filter((x) => x === true).length === 1
        && trueAt !== -1
        && busyFlags.slice(trueAt + 1).includes(false),
        `assistant-busy=[${busyFlags.join(',')}]`)
      const after = await getBusy(h)
      check(`busy 复位（${label}分支）：/busy 回到不忙（客户端轮询的降级口）`,
        after?.busy === false, JSON.stringify(after))
    } finally {
      sse.close()
    }
  }
}

// ---------------------------------------------------------------------------
// 客户端：朗读管道不能永久卡死（超时/异常兜底）
//   —— 本组判据批次 3 搬走四条，批次 4d 搬走最后一条「合成有超时兜底」，这里不再有源码文本判据。
// ---------------------------------------------------------------------------
// 四条换成/删掉了：
//   - 「播放上下文在 try 内获取」+「拿不到播放上下文时清队列退出」
//     → test/client-behavior.test.mjs 场景「无 AudioContext」（构造就抛错的设备）：
//       三句各 ack 一次、不递归爆栈、上下文恢复后后续句子照播。这两条比写法强，删。
//   - 「object URL 在 finally 里释放」→ 场景「解码失败」（合成成功、解码抛错）：
//     直接数「建了几个 Blob、还剩几个没撤」，泄漏一个就红。
//   - 「宿主不给 index 时本地补序号」→ 场景「老宿主无 index」：7 句全部播出。
//     没有补号时它们全撞在同一个去重键 `turnId:undefined` 上，只剩第一句 ——
//     「一轮只念第一句」正是这条缺陷的原始症状。
// 「合成有超时兜底（Promise.race + sleep）」这条写法判据批次 4d 删掉：
// test/client-behavior.test.mjs 场景「合成挂住」把 /tts 换成永不 resolve，判的是
// 两句都在几十毫秒内走兜底并各 ack 一次、都不播、宿主恢复后下一句照播、没有异常冲出管道。
// 原先它只能扫写法，因为要**真等 25 秒**（`TTS_TIMEOUT_MS`），写好的 `scenarioTimeoutAck`
// 一直没接进 main()（批次 3 记的）。现在传给假 window 的长定时器由 `env.winSleepCapMs` 压短：
// 判的是「兜底会顶上、管道不死」，**不是 25 秒这个数字**（数字由常量决定，harness 不判它）。

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
