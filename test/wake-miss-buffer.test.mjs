/**
 * 待机 wake-miss 的混淆样本要攒得出来（批次 14，docs §8.56）。
 *
 * 判的是宿主 `/voice-session` 收到 `via === 'wake-miss'` 那条上报之后**多出来的那一层收纳**：
 * `stats.wakeMissCount`（总次数）+ 诊断记录器里 `wakeMiss` 那组的环形缓冲（最近若干条 `{at, text, wake}`），
 * 全部经 `/diagnostics` 读出。
 *
 * 为什么要有这一层：`stats.client` 是**单格覆盖**，待机时每句没匹配上唤醒词的闲聊都把前一句冲掉，
 * 于是装机上问「喊了为什么不醒」只能看到最后一句，攒不出分布。
 * 而唤醒方案（A 折算回拼音 / B 音频级 KWS / C 零代码缓解）选哪个，判据正是分布：
 * 「这些错法里有多少，听起来其实就就是唤醒词」—— 那句话只能从混淆样本堆上算出来。
 *
 * 全部真跑：真宿主路由（临时树里的生产 `src/host/index.js`），不起识别线程、不联网，
 * 只用 req/res 直接调处理函数，再从 `/diagnostics` 读回。
 *
 * 判据一律从源码取常量，不在测试里抄第二份数字：
 *   - 窗口大小 = `MAX_EVENTS_PER_GROUP`、截断长度 = `WAKE_MISS_TEXT_LIMIT`（都在 `src/host/diagnostics.js`）；
 *   - 「进不进这个组」按 `via` 的字面判，而那个字面由客户端上报（这里演的就是它的形状）。
 *
 * 运行：node test/wake-miss-buffer.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadHostRoutes, callRoute } from './helpers/host-routes.mjs'
// 窗口上限与截断长度都从**源码**取：这两条判据要能在有人把 20 改成 50、把 80 改成 200 之后
// 照样成立，抄数字就变成第二份实现。
import { MAX_EVENTS_PER_GROUP, WAKE_MISS_TEXT_LIMIT } from '../src/host/diagnostics.js'
// 采集路径的取值表也从源码走：本批要保证「采集路径上报不许混进 wakeMiss 组」，
// 用真常量比手写字符串更能说明那条上报真的走到了宿主的采集分支。
import { GLOBAL_CAPTURE_PATHS } from '../src/client/pure/global-voice.js'
// 二级索引是宿主里那个**纯函数**算出来的（批次 26）：⑥ 判它在真链路上的读数，
// ⑦ 判它在真链路上不容易造出来的形状（空窗口、缺字段、次数相同怎么排）。
import { groupWakeMissByWake } from '../src/host/wake-miss-index.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + ' :: ' + (detail ?? '')) }
}

/** 宿主 wakeWord 档位里那一条的载荷形状（客户端真发出来的就是这个样子：没有 sessionId 键）。 */
function wakeMissBody(text, extra = {}) {
  return {
    client: {
      kind: 'global-voice',
      via: 'wake-miss',
      ok: false,
      error: 'wake_miss',
      text,
      at: 5,
      ...extra,
    },
  }
}

async function scenarioWakeMissBuffer() {
  // 唤醒词故意配成一个**客户端永远不会自报**的词：这样「读回来的 wake 是宿主那一份」
  // 和「客户端上报里带了什么」就能分开判（见 ① 的第三条）。
  const HOST_WAKE = '小鲸'
  // ⑥ 要把配置里的唤醒词换成另一个词：混着两个词的窗口才是这笔欠账的原始形状。
  const NEW_WAKE = '小虾'
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wake-miss-home-'))
  // `preloadModels: false`：⑥ 会 POST /config 换词，那次保存顺带排了一次后台预加载，
  // 这里不想要它（它要起识别线程，而本文件判的是收纳与索引，不起线程）。
  const env = await loadHostRoutes({ dshHome: home, rowConfig: { wakeWord: HOST_WAKE, preloadModels: false } })
  const post = (payload) => callRoute(env, '/dsh-voice-typing/voice-session', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  const diag = async () => (await callRoute(env, '/dsh-voice-typing/diagnostics')).json() ?? {}
  /** `/diagnostics` 里那一组 wake-miss 现场。 */
  const miss = async () => {
    const block = (await diag()).wakeMiss ?? null
    return { block, count: block?.count ?? -1, window: block?.window ?? -1, events: block?.events ?? [] }
  }
  try {
    /* ---- ① 前置：通道是通的，第一条样本收得下来，字段按形状落 ---- */
    const first = await post(wakeMissBody('小于等于'))
    check('[收纳] 待机里一句没匹配上唤醒词的闲聊回 200（通道认它，不是当成坏请求）',
      first.statusCode === 200, JSON.stringify({ status: first.statusCode, body: first.json() }))
    const one = await miss()
    check('[收纳] /diagnostics.wakeMiss.events 里数到 1 条，text 就是识别原文',
      one.events.length === 1 && String(one.events[0]?.text) === '小于等于',
      JSON.stringify(one.events))
    check('[收纳] 时刻由宿主盖上（客户端那份 at 不参与，和 stats.client 同一口径）',
      Number(one.events[0]?.at) > 5, JSON.stringify(one.events[0]?.at))
    check('[收纳] 总次数计数跟着涨（这是判唤醒方案时的分母，不随窗口裁剪）',
      one.count === 1 && one.block?.window === MAX_EVENTS_PER_GROUP,
      JSON.stringify({ count: one.count, window: one.window }))
    // 「宿主自己盖 wake」要单独一步判：把 post 塞进 check 的条件里，红了也说不清
    // 是那条上报没走到、还是走到了却取了客户端那份。
    await post(wakeMissBody('关于小鱼', { wake: '客户端自己说的' }))
    const withClientWake = await miss()
    check('[收纳] wake 取的是**宿主配置**那一份，客户端自报的不认',
      withClientWake.events[1]?.wake === HOST_WAKE,
      JSON.stringify(withClientWake.events[1]))

    /* ---- ② 只认 wake-miss：通道上另外三种负载一条都不许混进这个组 ---- */
    const before = await miss()
    const beforeClientCount = Number((await diag()).stats?.clientCount ?? 0)
    await post({ sessionId: 'sess-9', client: { kind: 'global-voice', via: 'session.prompt', ok: true } })
    await post({ client: { kind: 'global-voice', via: 'none', ok: false, error: 'no_session', text: '小鱼' } })
    await post({ client: { kind: 'capture-path', path: GLOBAL_CAPTURE_PATHS.worklet, reason: '' } })
    await post({ client: { on: true, speaking: false, recognizing: false, hearing: true } })
    const afterOthers = await miss()
    const statsAfter = (await diag()).stats ?? {}
    check('[分组] 发送尝试 / no_session / 采集路径 / 心跳都没进 wakeMiss 组',
      afterOthers.events.length === before.events.length && afterOthers.count === before.count,
      JSON.stringify({ before: before.events.length, after: afterOthers.events.length }))
    // 判「恰好 +4」而不是「在涨」：上面那条判据才不至于只是「这四条根本没发出去」。
    // 采集路径那条走 stats.capture 分支，但通道一视同仁地计数，所以 4 条全算。
    check('[分组] 那四条都被通道收下了（clientCount 正好 +4）—— 上面那条不是「发不出去」',
      Number(statsAfter.clientCount) === beforeClientCount + 4,
      JSON.stringify({ before: beforeClientCount, after: statsAfter.clientCount }))

    /* ---- ③ 溢出：窗口只留最近 MAX 条，计数照涨 ---- */
    // 灌到 MAX + 3 条，每条带一个能看出序号的文本。
    const TOTAL_BEFORE = (await miss()).count
    const EXTRA = MAX_EVENTS_PER_GROUP + 3
    for (let i = 0; i < EXTRA; i++) await post(wakeMissBody(`混淆#${i}`))
    const spilled = await miss()
    check(`[窗口] 灌入 ${EXTRA} 条之后 events 停在上限 ${MAX_EVENTS_PER_GROUP} 条（环形缓冲，不无限涨）`,
      spilled.events.length === MAX_EVENTS_PER_GROUP, JSON.stringify({ n: spilled.events.length }))
    check('[窗口] 丢的是最旧的：第一条是最后一批里的第 4 条（#3），不是 #0',
      String(spilled.events[0]?.text) === '混淆#3'
        && String(spilled.events[spilled.events.length - 1]?.text) === `混淆#${EXTRA - 1}`,
      JSON.stringify({ head: spilled.events[0]?.text, tail: spilled.events.at(-1)?.text }))
    check('[窗口] 计数不受裁剪影响（总次数 = 前面那些 + 这一批），读的人能知道被截了',
      spilled.count === TOTAL_BEFORE + EXTRA, JSON.stringify({ count: spilled.count, before: TOTAL_BEFORE }))

    /* ---- ④ 形状兜底：缺文本 / 超长文本 ---- */
    await post({ client: { kind: 'global-voice', via: 'wake-miss', ok: false, error: 'wake_miss' } })
    const emptyRow = (await miss()).events.at(-1) ?? {}
    check('[兜底] 没有 text 的一条仍然收下（text 是空串）—— 识别成空本身就是有价值的失败样本',
      emptyRow.text === '', JSON.stringify(emptyRow))
    const longText = '鱼'.repeat(300)
    await post(wakeMissBody(longText))
    const longRow = (await miss()).events.at(-1) ?? {}
    // 判「正好等于上限」而不是「不超过上限」：`String(undefined).length` 是 9，
    // 一条没记下来的记录会让「<= 80」这种写法照样绿（探针实测过，见 §8.56 的红色探针）。
    check('[兜底] 超长原文截到上限（诊断面不许变成对话内容的第二份副本）',
      typeof longRow.text === 'string'
        && longRow.text.length === WAKE_MISS_TEXT_LIMIT
        && longRow.text.startsWith('鱼'),
      JSON.stringify({ len: longRow.text?.length, limit: WAKE_MISS_TEXT_LIMIT, head: String(longRow.text).slice(0, 4) }))

    /* ---- ⑤ 批次 13 的既有语义没被带坏 ---- */
    const statsBefore = (await diag()).stats ?? {}
    check('[共存] stats.client 仍是「最后一条覆盖」（本批只往旁边加了一组，没动它）',
      String(statsBefore.client?.text ?? '').startsWith('鱼'),
      JSON.stringify(statsBefore.client))
    await post({ client: { kind: 'global-voice', via: 'wake-miss', ok: false, error: 'wake_miss', text: '小于等于' } })
    const finalDiag = await diag()
    const finalEvents = (await miss()).events
    // 到这里缓冲早就灌满了（③ 把它顶到 MAX），所以**不能**判「条数 +1」—— 那条数本来就加不上去。
    // 改判「最后一条就是刚发的那句」：满了也照样成立，而且顺带把「新的挤掉旧的」钉住。
    check('[共存] wake-miss 上报依旧不动 voiceSession（批次 13 那条契约仍然成立）',
      finalDiag?.voiceSession === 'sess-9'
        && finalEvents.at(-1)?.text === '小于等于'
        && finalEvents.length === MAX_EVENTS_PER_GROUP,
      JSON.stringify({ voiceSession: finalDiag?.voiceSession, tail: finalEvents.at(-1)?.text, n: finalEvents.length }))

    /* ---- ⑥ 二级索引：改过唤醒词之后，分布按当时的词分格读出来（批次 26，docs §8.74） ---- */
    // 到这里窗口里全是 `小鲸` 那一批。先把配置换成另一个词，再喂三条样本 ——
    // 「混着两个词的窗口」是这笔欠账的原始形状，只有真的换过一次词才判得到分组。
    const oneGroup = (await miss()).block?.byWake ?? null
    check('[索引] 换词之前它已经在了，且只有一格（分组的键取的就是 events 里那份 wake）',
      Array.isArray(oneGroup) && oneGroup.length === 1
        && oneGroup[0]?.wake === HOST_WAKE
        && oneGroup[0]?.count === MAX_EVENTS_PER_GROUP,
      JSON.stringify(oneGroup))

    const swapped = await callRoute(env, '/dsh-voice-typing/config', {
      method: 'POST',
      body: JSON.stringify({ wakeWord: NEW_WAKE }),
    })
    check('[索引] 换唤醒词这一步本身走通了（否则下面判的是同一格，等于没判）',
      swapped.statusCode === 200 && swapped.json()?.config?.wakeWord === NEW_WAKE,
      JSON.stringify({ status: swapped.statusCode, body: swapped.json() }))

    await post(wakeMissBody('关于小鱼'))
    await post(wakeMissBody('关于小鱼'))
    await post(wakeMissBody('洗澡时间'))
    const mixed = await miss()
    const groups = mixed.block?.byWake ?? []
    const byWord = Object.fromEntries(groups.map((g) => [g.wake, g]))
    check('[索引] 窗口里两个词各占一格，新词那格正好 3 条（客户端自报的 wake 不参与分组）',
      groups.length === 2 && byWord[NEW_WAKE]?.count === 3,
      JSON.stringify(groups.map((g) => ({ wake: g.wake, count: g.count }))))
    check('[索引] 组内按原文去重计数：重复出现的那句排在前，次数写得住',
      JSON.stringify(byWord[NEW_WAKE]?.texts ?? null)
        === JSON.stringify([{ text: '关于小鱼', count: 2 }, { text: '洗澡时间', count: 1 }]),
      JSON.stringify(byWord[NEW_WAKE]?.texts))
    check('[索引] 组之间按次数从多到少排（旧词那格还压着窗口里的多数，它就在前）',
      groups.length === 2 && groups[0]?.wake === HOST_WAKE && groups[0].count > groups[1].count,
      JSON.stringify(groups.map((g) => ({ wake: g.wake, count: g.count }))))
    // 这一条是「算出来的、不是另存一份」的证据：新样本挤进窗口之后，旧词那格跟着少 3。
    // 如果索引是独立累积的，它会停在 20 不动 —— 那才是这里最坏的那种坏读数。
    check('[索引] 旧词那格跟着窗口回落（20 → 少 3）：分母是窗口，不是不裁剪的总次数',
      byWord[HOST_WAKE]?.count === MAX_EVENTS_PER_GROUP - 3,
      JSON.stringify({ got: byWord[HOST_WAKE]?.count, window: MAX_EVENTS_PER_GROUP }))
    const sum = groups.reduce((acc, g) => acc + Number(g.count ?? 0), 0)
    check('[索引] 各组次数加起来正好等于窗口条数、且不超过 wakeMiss.count',
      sum === mixed.events.length && sum <= mixed.count,
      JSON.stringify({ sum, events: mixed.events.length, count: mixed.count }))

    /* ---- ⑦ 索引的口径细节：换词这件事在真链路上不好造的形状，直接驱动那个纯函数 ---- */
    // 每条是 [喂进去的明细, 该读出来的索引, 这条判的是什么]。
    const shapes = [
      [[], [], '空窗口 → 空索引（不是 undefined，读的人不用先判存在）'],
      [[null], [], '窗口里混进非对象条目也不许把整份索引带崩（跳过去，不给它造一格）'],
      [[{ text: '啊' }], [{ wake: '', count: 1, texts: [{ text: '啊', count: 1 }] }], '缺 wake → 单独归到空串那一格（配置被清空这件事要看得见）'],
      [[{ wake: 'X' }], [{ wake: 'X', count: 1, texts: [{ text: '', count: 1 }] }], '缺 text → 空串原文照样收（识别成空本身就是样本，批次 14 的口径）'],
      // 「甲」的码位比「乙」大，所以这条 fixture 是挑过的：先出现的排在前面 = 首次出现顺序；
      // 排字母序会把它倒过来。上一版写的是「乙→甲」，两种排法读出来一模一样，
      // 探针 2（把组改成排字母序）当场只红了一条 —— 那条判据等于没判（批次 26 记下的自纠）。
      [[{ wake: '甲' }, { wake: '乙' }], [{ wake: '甲', count: 1, texts: [{ text: '', count: 1 }] }, { wake: '乙', count: 1, texts: [{ text: '', count: 1 }] }], '次数相同的组按首次出现排（不排字母序：刚发生的不该被挤到后面）'],
      // 组内同理：'z' 的码位比 'y' 大，先出现的排前面才和「按字母序」区分得开。
      [[{ wake: 'X', text: 'z' }, { wake: 'X', text: 'y' }], [{ wake: 'X', count: 2, texts: [{ text: 'z', count: 1 }, { text: 'y', count: 1 }] }], '组内次数相同也按首次出现排'],
      [[{ wake: 'X', text: 'a' }, { wake: 'X', text: 'a' }, { wake: 'Y', text: 'b' }], [{ wake: 'X', count: 2, texts: [{ text: 'a', count: 2 }] }, { wake: 'Y', count: 1, texts: [{ text: 'b', count: 1 }] }], '去重 + 跨组：同一句在同一格里只一条、次数累加'],
    ]
    for (const [events, expectShape, label] of shapes) {
      const frozenBefore = JSON.stringify(events)
      const got = groupWakeMissByWake(events)
      check(`[索引·形状] ${label}`,
        JSON.stringify(got) === JSON.stringify(expectShape),
        JSON.stringify({ got, expect: expectShape }))
      check(`[索引·形状] 「${label}」这一趟没改动喂进去的那份明细`,
        JSON.stringify(events) === frozenBefore, JSON.stringify(events))
    }
  } finally {
    env.restore()
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
  }
}

const SCENARIOS = [
  ['待机 wake-miss 的混淆样本攒得出来（环形缓冲 + 总计数）', scenarioWakeMissBuffer],
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
