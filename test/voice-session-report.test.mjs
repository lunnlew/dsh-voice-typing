/**
 * 客户端→宿主的诊断上报通道（/voice-session）：各自的字段各归各位（批次 10，任务 #38）。
 *
 * 这条通道原先只有一个落点 `stats.client`：每条上报都覆盖前一条。
 * 采集路径上报（{kind:'capture-path', path, reason}）要走的正是这条通道 ——
 * 如果照旧塞进 `stats.client`，那么「浮层为什么退回 ScriptProcessor」这条信息
 * 会在下一次语音发送尝试上报时**当场被冲掉**，而那恰恰是最需要它还在的时候（排查失败现场）。
 * 所以宿主按 kind 分流：capture-path 进独立的 `stats.capture`，其余仍进 `stats.client`。
 *
 * 第二条契约更脆：宿主只在请求体**存在** `sessionId` 这个自有属性时才改 `voiceSession`。
 * 采集路径上报必须不带这个键 —— 带了空串就等于把用户当前会话清空，
 * 「顺手把诊断字段都填上」这种写法会直接改变行为。这里两侧都判：
 * 不带 → 会话指针不动；带空串 → 确实会清（证明这条判据不是空转）。
 *
 * 批次 13（docs §8.54）把同一个契约判到**待机 wake-miss** 那条上报上：
 * 用户在待机里说的每句没匹配上唤醒词的闲聊都会走这一条，数量比采集路径多一个数量级，
 * 而客户端 `reportVoiceAttempt` 以前是无条件写 `sessionId: info?.sessionId ?? ''` ——
 * 于是每句闲聊都在替用户把 `voiceSession` 清掉。⑥ 那几行判的就是客户端真发出来的
 * 那两种形状（不带键不动 / 带键登记），并加一条反证：id 只写在 `client` 里不算登记。
 *
 * 批次 13b（docs §8.55）判的是同一条通道上**间隔最短**的那个调用点：composer 麦克风按钮的
 * 心跳（每 1500 毫秒一次）。它读的 sessionId 在还没拿到会话 id 时就是空串，
 * 于是旧写法每 1.5 秒替用户清一次指针 —— 而它恰恰是 `voiceSession` 唯一的正常登记来源。
 * ⑦ 那几行把两头钉住：没 id 时不带键 → 指针不动、状态负载照收；有 id 时带键 → 登记得上
 * （收窄如果做过头，第二判会当场红）。
 *
 * 判据一律真跑：真宿主路由（临时树里的生产 `src/host/index.js`），
 * 不起识别线程、不联网，只用 req/res 直接调处理函数。
 *
 * 运行：node test/voice-session-report.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import osPkg from 'node:os'
import { loadHostRoutes, callRoute } from './helpers/host-routes.mjs'
// 采集路径的取值表从**源码**取，不在测试里抄一份字符串：
// 客户端上报的 path 和这里等的 path 必须是同一个符号，抄的字面量分叉了就判不出来。
import { GLOBAL_CAPTURE_PATHS } from '../src/client/pure/global-voice.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** /diagnostics 里那份 stats（上报落点都在这儿）。 */
async function statsOf(env) {
  const diag = await callRoute(env, '/dsh-voice-typing/diagnostics')
  return diag.json()?.stats ?? null
}

async function scenarioVoiceSessionReport() {
  const home = fs.mkdtempSync(path.join(osPkg.tmpdir(), 'dsh-voice-session-home-'))
  const env = await loadHostRoutes({ dshHome: home })
  const post = (payload) => callRoute(env, '/dsh-voice-typing/voice-session', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  try {
    /* ---- 前置：通道本身是通的，心跳确实会设上会话 ---- */
    const beat = await post({ sessionId: 'sess-1', client: { kind: 'global-voice', ok: true } })
    check('[前置] 带 sessionId 的心跳回 200 且把会话登记上（本场景的前提）',
      beat.statusCode === 200 && beat.json()?.voiceSession === 'sess-1',
      JSON.stringify({ status: beat.statusCode, body: beat.json() }))
    const afterBeat = await statsOf(env)
    check('[前置] 心跳的 client 进了 stats.client（老落点没被改坏）',
      afterBeat?.client?.kind === 'global-voice', JSON.stringify(afterBeat?.client))
    const beatDiag = await callRoute(env, '/dsh-voice-typing/diagnostics')
    check('[前置] 心跳登记的那个会话在 /diagnostics 顶层可读（后面就判它动不动）',
      beatDiag.json()?.voiceSession === 'sess-1', JSON.stringify(beatDiag.json()?.voiceSession))

    /* ---- ① 采集路径上报：进独立字段，不动 stats.client ---- */
    const reported = await post({
      client: {
        kind: 'capture-path',
        path: GLOBAL_CAPTURE_PATHS.scriptProcessor,
        reason: 'worklet 启动失败：fake: addModule rejected',
        at: 1,
      },
    })
    check('[采集] 采集路径上报回 200（宿主认这条上报，不是当成坏请求）',
      reported.statusCode === 200, JSON.stringify({ status: reported.statusCode, body: reported.json() }))
    const stats = await statsOf(env)
    check('[采集] stats.capture 收到了 path（/diagnostics 直接可读，不用再加接口）',
      stats?.capture?.path === GLOBAL_CAPTURE_PATHS.scriptProcessor, JSON.stringify(stats?.capture))
    check('[采集] stats.capture 收到了回退原因（任务 #38 的正题：为什么没走上首选路径要看得见）',
      String(stats?.capture?.reason).includes('addModule rejected'), JSON.stringify(stats?.capture))
    check('[采集] 时刻由宿主盖上（客户端那份 at 不参与，避免两端时钟错位）',
      Number(stats?.capture?.at) > 1, JSON.stringify(stats?.capture?.at))
    check('[采集] 没有把 stats.client 冲掉：那条心跳的现场还留着',
      stats?.client?.kind === 'global-voice', JSON.stringify(stats?.client))
    check('[采集] 采集路径上报也计入 clientCount（通道上的上报条数一视同仁）',
      Number(stats?.clientCount) === 2, JSON.stringify(stats?.clientCount))

    /* ---- ② 上报不带 sessionId：会话指针必须不动 ---- */
    const diagIdle = await callRoute(env, '/dsh-voice-typing/diagnostics')
    check('[会话] 采集路径上报之后，voiceSession 仍是原来那个（纯诊断不改行为）',
      diagIdle.json()?.voiceSession === 'sess-1', JSON.stringify(diagIdle.json()?.voiceSession))

    /* ---- ③ 反证：带空串 sessionId 真的会清空（证明②不是空转） ---- */
    const cleared = await post({ sessionId: '', client: { kind: 'wake-miss', word: '小易' } })
    check('[会话] 带空串 sessionId 的上报**确实**会清空 voiceSession（宿主那条自有属性判据还在）',
      cleared.statusCode === 200 && cleared.json()?.voiceSession === null,
      JSON.stringify(cleared.json()))
    const afterClear = await callRoute(env, '/dsh-voice-typing/diagnostics')
    check('[会话] 所以客户端的诊断上报必须**不带这个键**：清空过一次就不回来了',
      afterClear.json()?.voiceSession === null, JSON.stringify(afterClear.json()?.voiceSession))
    const wakeStats = await statsOf(env)
    check('[会话] 这条走的是普通上报（wake-miss 仍进 stats.client，没被采集分支吃掉）',
      wakeStats?.client?.kind === 'wake-miss', JSON.stringify(wakeStats?.client))

    /* ---- ④ 采集路径可以反复上报，最后一次为准；反向不覆盖 ---- */
    await post({ client: { kind: 'capture-path', path: GLOBAL_CAPTURE_PATHS.worklet, reason: '' } })
    const twice = await statsOf(env)
    check('[采集·覆盖] 再开一次麦之后 capture 改成新的路径与原因（不是一次挂死）',
      twice?.capture?.path === GLOBAL_CAPTURE_PATHS.worklet && twice?.capture?.reason === '',
      JSON.stringify(twice?.capture))
    await post({ client: { kind: 'global-voice', ok: false, error: 'direct:x' } })
    const back = await statsOf(env)
    check('[采集·覆盖] 反过来，语音发送尝试的上报不覆盖 capture（两侧字段互不冲刷）',
      back?.capture?.path === GLOBAL_CAPTURE_PATHS.worklet && back?.client?.error === 'direct:x',
      JSON.stringify({ capture: back?.capture, client: back?.client }))

    /* ---- ⑤ 坏体/空体不能把这条路由搞崩（它现在多了一个分支） ---- */
    const empty = await post({})
    check('[容错] 空对象上报仍回 200（既没 sessionId 也没 client：什么都不动）',
      empty.statusCode === 200 && empty.json()?.ok === true, JSON.stringify(empty.json()))
    const notJson = await callRoute(env, '/dsh-voice-typing/voice-session', {
      method: 'POST',
      body: 'not-json',
      headers: { 'content-type': 'application/json' },
    })
    check('[容错] 非 JSON 的请求体有回执、不是挂住（新分支没把 catch 绕过去）',
      notJson.statusCode >= 400, JSON.stringify({ status: notJson.statusCode, body: notJson.json() }))
    const afterFault = await statsOf(env)
    check('[容错] 一连串坏上报之后 capture/client 两个字段还是那两份（没被写成 undefined）',
      afterFault?.capture?.path === GLOBAL_CAPTURE_PATHS.worklet && afterFault?.client?.kind === 'global-voice',
      JSON.stringify({ capture: afterFault?.capture, client: afterFault?.client }))

    /* ---- ⑥ 待机 wake-miss 上报的形状（批次 13，docs §8.54）---- */
    // 这一节判的是**客户端真发出来的那两种形状**，不是「理论上不带键会怎样」：
    // 上面②③判的是采集路径那一条，而待机时每句没匹配上唤醒词的闲聊都走 wake-miss 这条，
    // 数量比采集路径多一个数量级 —— 它要是带空串的 sessionId，会话指针就被闲聊冲掉了。
    const rearmed = await post({ sessionId: 'sess-2', client: { kind: 'global-voice', via: 'session.prompt', ok: true } })
    check('[wake-miss] 前置：发送尝试的上报（带 sessionId 键）确实把会话登记上（这条通路不许被改坏）',
      rearmed.statusCode === 200 && rearmed.json()?.voiceSession === 'sess-2', JSON.stringify(rearmed.json()))
    const missReport = await post({
      client: { kind: 'global-voice', via: 'wake-miss', ok: false, error: 'wake_miss', text: '小于等于', at: 5 },
    })
    check('[wake-miss] 待机里一句没匹配唤醒词的闲聊：上报被收下（200），不是被当成坏请求',
      missReport.statusCode === 200, JSON.stringify({ status: missReport.statusCode, body: missReport.json() }))
    const afterMiss = await callRoute(env, '/dsh-voice-typing/diagnostics')
    check('[wake-miss] **voiceSession 仍是上一个真会话** —— 纯诊断上报不许替用户改朗读/会话指针（本批的缺陷面）',
      afterMiss.json()?.voiceSession === 'sess-2', JSON.stringify(afterMiss.json()?.voiceSession))
    const missStats = await statsOf(env)
    check('[wake-miss] 识别原文进了 stats.client（用户反馈「喊了不醒」时这是唯一能看到 ASR 给了什么的地方）',
      missStats?.client?.via === 'wake-miss' && String(missStats?.client?.text).includes('小于等于')
      && missStats?.client?.error === 'wake_miss', JSON.stringify(missStats?.client))
    check('[wake-miss] 时刻仍由宿主盖上（客户端那份 at 不参与，和采集路径同一口径）',
      Number(missStats?.client?.at) > 5, JSON.stringify(missStats?.client?.at))
    // 「带键 = 登记 / 不带键 = 不动」这两半都判过之后，客户端少发一个键才是安全的：
    // 反过来（有真会话 id 时也省掉键）就会让 voiceSession 永远登记不上，这里能看见。
    const lostRegister = await post({
      client: { kind: 'global-voice', via: 'session.prompt', mode: 'queue', ok: true, sessionId: 'sess-3' },
    })
    check('[wake-miss] 反证：会话 id 只写在 client 里不算登记（宿主认的是**顶层那个键**，客户端必须把它放在顶层）',
      lostRegister.json()?.voiceSession === 'sess-2', JSON.stringify(lostRegister.json()))

    /* ---- ⑦ composer 心跳的形状（批次 13b，docs §8.55）---- */
    // 心跳是 `voiceSession` 唯一的**正常**登记来源（composer 每 1500 毫秒报一次状态）。
    // 所以这一节两头都判：没 id 时不带键 → 指针不许被每 1.5 秒的冲刷掉；
    // 有 id 时带键 → 登记得上。批次 13 那种「收窄」如果做过头，第二判会立刻红。
    const beatNoId = await post({
      client: { on: true, speaking: false, recognizing: false, hearing: true, rms: 0, partial: '', acks: 3 },
    })
    check('[心跳·没 id] 客户端不发那个键时，voiceSession 仍留在上一个真会话（每 1.5 秒清一次的冲刷被堵住）',
      beatNoId.statusCode === 200 && beatNoId.json()?.voiceSession === 'sess-2',
      JSON.stringify(beatNoId.json()))
    const beatStats = await statsOf(env)
    check('[心跳·没 id] 状态负载本身照样进 stats.client（收掉的只有那个键，诊断面没跟着瞎）',
      beatStats?.client?.on === true && beatStats?.client?.acks === 3, JSON.stringify(beatStats?.client))
    const beatWithId = await post({ sessionId: 'sess-4', client: { on: true, speaking: true } })
    check('[心跳·有 id] 带真 id 的心跳必须登记得上（唯一的正常登记通道不许被收窄掉）',
      beatWithId.json()?.voiceSession === 'sess-4', JSON.stringify(beatWithId.json()))
  } finally {
    env.restore()
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
  }
}

const SCENARIOS = [
  ['采集路径上报各归各位（不冲 stats.client、不动 voiceSession）', scenarioVoiceSessionReport],
]

for (const [label, fn] of SCENARIOS) {
  console.log(`\n${label}`)
  try {
    await fn()
  } catch (error) {
    failed++
    console.log('  FAIL 场景跑通 :: ' + String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '))
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
