/**
 * 宿主侧门限状态机的单元测试（不依赖活着的插件，也不需要模型）。
 *
 * 背景（2026-10-31）：
 *   集成测试发现「流式·真实语音」只认出「你好明天天怎」，
 *   而整段非流式能认出「你好，今天天气怎么样？」。
 *   原因：门限把中间两块真实语音（rms 0.0255 / 0.0308）挡在了解码器外面。
 *
 *   门限逻辑原先内联在 `/asr-stream` 路由里，改不动也测不了；
 *   现在抽成了纯函数 advanceGate（lib/index.js），
 *   宿主侧与浏览器侧共用同一份用例表（test/fixtures/gate-cases.mjs）。
 *
 * 批次 6h（docs/architecture-modernization.md §8.41）在本文件里加了**两组真跑**：
 *   - `/asr-stream` 逐帧真喂音频，把路由回包的 `speech` 与 `advanceGate` 的 `feed` 对表
 *     —— 替代原来那条「路由里必须写着 `advanceGate(state, level)`」的源码正则；
 *   - `recognizeWithSherpa` 与 `/transcribe` 真跑，看 speech 是不是跟着**每次调用**走
 *     —— 替代原来那三条读源码的正则（模块级变量名、`speech: hadSpeech`、return 形状）。
 *   跑法与 `test/worker-protocol.test.mjs` 同一套路：真宿主路由 + 真识别线程 +
 *   假 sherpa 依赖 + 测试自己算 sha 的合成档位（`helpers/fake-tier.mjs`）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GATE_CASES, GATE_OPTS, GATE_INITIAL_STATE, runGateCase } from './fixtures/gate-cases.mjs'
import { loadHostRoutes } from './helpers/host-routes.mjs'
import { fakeSherpa } from './helpers/fake-sherpa.mjs'
import { makeReadyTier, placeTierFiles, frameOfLevel, samplesOfLevel } from './helpers/fake-tier.mjs'

// 直接引宿主模块的文件路径（插件入口本身也是 ESM，可以直接 import）。
// 门限纯函数与常数走真产物；下面两节真跑走 `helpers/host-routes.mjs` 装的临时树。
const { advanceGate, DEFAULT_GATE_OPTS } = await import('../lib/index.js')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/**
 * 有界地等一条宿主路由。
 *
 * `/transcribe` 走的是识别线程，而线程是 `unref()` 的（不让模型加载拖住应用退出）——
 * 等回包期间进程里可能一个 ref 句柄都没有，Node 会直接退出并留下
 * 「Detected unsettled top-level await」。这里的定时器既是界也是那个句柄。
 * （同 `test/worker-protocol.test.mjs` 的 callRoute。）
 */
async function callRoute(env, url, options = {}, timeoutMs = 20000) {
  let timer = null
  try {
    return await Promise.race([
      env.request(url, options),
      new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${url}：${timeoutMs}ms 内没返回（识别线程 unref，等待期本来没有 ref 句柄）`)),
          timeoutMs,
        )
      }),
    ])
  } catch (error) {
    return { statusCode: 0, text: error.message, json: () => ({ error: error.message }) }
  } finally {
    clearTimeout(timer)
  }
}

console.log('门限纯函数已抽出来')
check('宿主导出了 advanceGate', typeof advanceGate === 'function')
check('advanceGate 不带 opts 也能用（缺省就是 DEFAULT_GATE_OPTS）',
  (() => {
    const a = advanceGate({ ...GATE_INITIAL_STATE }, 0.05)
    const b = advanceGate({ ...GATE_INITIAL_STATE }, 0.05, DEFAULT_GATE_OPTS)
    return JSON.stringify(a) === JSON.stringify(b)
  })())
check('宿主导出了默认门限常数', !!DEFAULT_GATE_OPTS)
// 这一节原来还有一条读宿主人话源码的正则（`/const gateResult = advanceGate\(state, level\)/`），
// 防的是「门限判定被重新内联回 /asr-stream 路由」——内联后本文件的行为测试照样绿，
// 但两份实现会漂移。批次 6h（docs §8.41）把它换成下面那节真跑：
// 逐帧把音频喂给真路由，把回包里的 `speech`（就是路由对这一帧的 feed 决定）
// 和同一份用例表上直接跑 advanceGate 得到的 `feed` 逐帧对表。
// 门限一旦被内联回路由（哪怕只改一个系数），两条序列就会分开。

console.log('\n默认常数与共享用例表一致')
check(
  '用例表的 GATE_OPTS 与宿主的 DEFAULT_GATE_OPTS 完全相同',
  JSON.stringify(GATE_OPTS) === JSON.stringify(DEFAULT_GATE_OPTS),
  `用例表 ${JSON.stringify(GATE_OPTS)}，宿主 ${JSON.stringify(DEFAULT_GATE_OPTS)}`,
)

console.log('\n纯函数性质')
{
  const before = { ...GATE_INITIAL_STATE }
  const snapshot = JSON.stringify(before)
  advanceGate(before, 0.05, GATE_OPTS)
  check('不改传入的 state', JSON.stringify(before) === snapshot, JSON.stringify(before))
}
{
  const input = { ...GATE_INITIAL_STATE }
  const result = advanceGate(input, 0.05, GATE_OPTS)
  check('返回 feed / speech / gate / state', !!result && 'feed' in result && 'speech' in result && 'gate' in result && !!result.state)
  check('返回的新 state 只有三个字段',
    result && Object.keys(result.state).sort().join(',') === 'inSpeech,noiseFloor,silentFrames',
    result ? Object.keys(result.state).join(',') : '没有 state')
  check('新 state 与传入的 state 不是同一个对象', result && result.state !== input)
}
{
  // 同一个输入必须给出同一个结果（可重复）。
  const a = advanceGate({ ...GATE_INITIAL_STATE }, 0.041, GATE_OPTS)
  const b = advanceGate({ ...GATE_INITIAL_STATE }, 0.041, GATE_OPTS)
  check('同样的输入给出同样的输出（可重复）', JSON.stringify(a) === JSON.stringify(b))
}
{
  // feed 与 speech 在本算法下恒等 —— 共享用例表靠这一点两侧通用。
  const result = advanceGate({ ...GATE_INITIAL_STATE }, 0.05, GATE_OPTS)
  check('feed 与 speech 一致（客户端 VAD 可以直接用 speech）', result.feed === result.speech)
}

console.log('\n用共享用例表驱动宿主门限')
for (const gateCase of GATE_CASES) {
  const result = runGateCase(gateCase, advanceGate)
  const fedOk = JSON.stringify(result.fed) === JSON.stringify(gateCase.expectFed)
  check(
    gateCase.name,
    fedOk,
    fedOk ? '' : `喂了 [${result.fed.join(', ')}]，期望 [${gateCase.expectFed.join(', ')}]`,
  )
  if (gateCase.expectFinal) {
    const finalOk = JSON.stringify(result.final) === JSON.stringify(gateCase.expectFinal)
    check(
      gateCase.name + '（结束状态）',
      finalOk,
      finalOk ? '' : `结束状态 ${JSON.stringify(result.final)}，期望 ${JSON.stringify(gateCase.expectFinal)}`,
    )
  }
  const speechOk = JSON.stringify(result.speech) === JSON.stringify(result.fed)
  check(gateCase.name + '（speech 与 feed 一致）', speechOk)
}

console.log('\n回归：真实语音序列的所有非零帧都要被喂')
{
  const gateCase = GATE_CASES.find((c) => c.name.startsWith('真实语音序列'))
  const result = runGateCase(gateCase, advanceGate)
  const spoken = gateCase.levels.filter((l) => l > 0)
  const fedSpoken = gateCase.levels.filter((l, i) => l > 0 && result.fed[i])
  check(
    '所有非零帧都被喂进去了',
    spoken.length === fedSpoken.length,
    `喂了 ${fedSpoken.length}/${spoken.length} 帧`,
  )
  check(
    '尾部静音也喂进去了（解码器需要静音才能定句）',
    result.fed.slice(-2).every(Boolean),
    `尾部两帧 feed=${result.fed.slice(-2).join(', ')}`,
  )
}

console.log('\n回归：门限常数可注入（两端常数不同）')
{
  // 客户端侧的常数（clamp 0.008 / 0.035）跑同一张表，结果必须一致。
  const CLIENT_OPTS = {
    minGate: 0.008,
    maxGate: 0.035,
    multiplier: 2.5,
    offset: 0.003,
    silentFramesToEnd: 3,
  }
  let same = true
  for (const gateCase of GATE_CASES) {
    const host = runGateCase(gateCase, advanceGate)
    const client = runGateCase(gateCase, advanceGate, CLIENT_OPTS)
    if (JSON.stringify(host.fed) !== JSON.stringify(client.fed)) same = false
    if (JSON.stringify(host.final) !== JSON.stringify(client.final)) same = false
  }
  check('换一套门限常数，同一张用例表的结果不变', same)
}

console.log('\n回归：底噪只在不在说话中时更新')
{
  // 说话时底噪不能被自己的声音抬高，否则越说越容易被挡。
  const gateCase = GATE_CASES.find((c) => c.name.startsWith('真实语音序列'))
  const result = runGateCase(gateCase, advanceGate)
  const gates = result.gates
  const drifting = gates.slice(1).some((g, i) => Math.abs(g - gates[i]) > 1e-12)
  check('说话过程中门限不跟着自己的声音往上漂', !drifting, gates.map((g) => g.toFixed(5)).join(', '))
}

console.log('\n真跑 /asr-stream：路由的喂帧决定与 advanceGate 同源')
{
  // 替代旧的那条源码正则（批次 6h，docs §8.41）。
  // 跑的是真链路：真宿主路由 → getStreamingState → 真 recognizer/stream 对象（假 sherpa 依赖）
  // → 真 advanceGate。每帧的 rms 由测试自己造（恒定幅值 → rms 恰等于幅值），
  // 路由回包里的 `speech` 字段就是它对这一帧的 feed 决定。
  const cases = GATE_CASES.filter((c) => !c.opts)   // 带常数覆盖的用例走的是非默认常数，路由用不到
  const streamTier = makeReadyTier('zipformer2-zh', {
    engine: 'online',
    repo: 'fake-repo/gate-host-stream',
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gate-host-stream-'))
  placeTierFiles(home, streamTier.tier, streamTier.bodies)
  const fake = fakeSherpa({ marker: '假识别' })
  fake.install()
  try {
    const env = await loadHostRoutes({
      dshHome: home,
      // 与内置档位**同 id** 追加：findModel 取第一个匹配，于是流式那条路拿到的
      // 是这份测试档位（sha 由测试自己算，isModelReady 走真判据就通过）。
      appendAsrTiers: [streamTier.tier],
      extraTreeFiles: fake.files,
    })
    try {
      let seq = 0
      for (const gateCase of cases) {
        seq += 1
        const sid = `gate-host-${seq}`
        const expected = runGateCase(gateCase, advanceGate).fed
        const actual = []
        let hasSpeechField = true
        for (const level of gateCase.levels) {
          const res = await env.request(`/dsh-voice-typing/asr-stream?sessionId=${sid}`, {
            method: 'POST',
            body: frameOfLevel(level),
            headers: { 'content-type': 'application/octet-stream' },
          })
          const body = res.json?.() ?? {}
          if (typeof body.speech !== 'boolean') hasSpeechField = false
          actual.push(body.speech)
        }
        check(
          `/asr-stream 真的在解码这一帧（回包带布尔 speech，不是 unavailable）：${gateCase.name}`,
          hasSpeechField,
          JSON.stringify(actual),
        )
        const same = JSON.stringify(actual) === JSON.stringify(expected)
        check(
          `/asr-stream 逐帧的 feed 决定 = advanceGate 逐帧的 feed（${gateCase.name}）`,
          same,
          same ? '' : `路由 [${actual.join(', ')}]，纯函数 [${expected.join(', ')}]`,
        )
      }
      // 原 bug 的那条用例在**路由**这一层也过一遍：中间两块低音量帧不能被挡掉。
      const real = cases.find((c) => c.name.startsWith('真实语音序列'))
      seq += 1
      const realSid = `gate-host-${seq}`
      const realFeed = []
      for (const level of real.levels) {
        const res = await env.request(`/dsh-voice-typing/asr-stream?sessionId=${realSid}`, {
          method: 'POST',
          body: frameOfLevel(level),
          headers: { 'content-type': 'application/octet-stream' },
        })
        realFeed.push(res.json?.()?.speech)
      }
      check(
        '真实语音序列从 /asr-stream 回包看也是「每帧都喂」（低音量帧 0.0255 / 0.0308 没被挡）',
        realFeed.every(Boolean),
        JSON.stringify(realFeed),
      )
      // 门限状态是**每个会话**各一份的：另开一个会话喂静音，不该被上面那个会话的说话态带进去。
      const quiet = await env.request('/dsh-voice-typing/asr-stream?sessionId=gate-host-quiet', {
        method: 'POST',
        body: frameOfLevel(0.0001),
        headers: { 'content-type': 'application/octet-stream' },
      })
      check(
        '新会话的第一帧静音不继承别的会话的说话态',
        quiet.json?.()?.speech === false,
        JSON.stringify(quiet.json?.()),
      )
    } finally {
      env.restore()
    }
  } finally {
    fake.uninstall()
    for (const dir of [home, fake.dir]) {
      // Windows 上删临时目录会被杀毒/索引器短暂拦住；清理失败不能算判据失败。
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
    }
  }
}

console.log('\n回归：D5 —— speech 跟着每次调用走（真跑识别函数与 /transcribe）')
{
  // 旧判据是三条源码正则（模块级变量名、`speech: hadSpeech`、return 形状）。
  // 它们保的事是：识别结果里的 speech 必须**随返回值/回包**带出来，不能落在模块级变量上 ——
  // 两个并发 /transcribe（实时字轮询 + 断句识别）会互相覆盖，
  // 客户端据此决定是否回滚实时字，回滚错了就把用户刚说的话吃掉（docs §8.41，批次 6h）。
  // 现在两条都真跑：① 树里那份 `recognizeWithSherpa`（主线程兜底路径），
  // ② `/dsh-voice-typing/transcribe`（真宿主路由 → 真识别线程 → 假 sherpa）。
  const offlineTier = makeReadyTier('test-gate-host-offline', {
    engine: 'whisper',
    repo: 'fake-repo/gate-host-offline',
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gate-host-d5-'))
  placeTierFiles(home, offlineTier.tier, offlineTier.bodies)
  const fake = fakeSherpa({ marker: '假识别' })
  fake.install()
  try {
    const env = await loadHostRoutes({
      dshHome: home,
      appendAsrTiers: [offlineTier.tier],
      rowConfig: { model: offlineTier.tier.id, preloadModels: false },
      extraTreeFiles: fake.files,
    })
    try {
      const loud = samplesOfLevel(0.1)
      const silent = samplesOfLevel(0)
      // ① 主线程那份识别函数：返回值自己带 speech，两档音频各说各话。
      const spoken = await env.mod.recognizeWithSherpa(offlineTier.tier, loud)
      check(
        'recognizeWithSherpa 在**真构造了识别器**的那条路上也返回 {text, speech}（有声）',
        !!spoken && typeof spoken.text === 'string' && spoken.speech === true && spoken.text.length > 0,
        JSON.stringify(spoken),
      )
      const afterLoud = await env.mod.recognizeWithSherpa(offlineTier.tier, silent)
      check(
        '紧接着一次静音调用拿到的是自己的 speech:false（不继承上一次的结果）',
        !!afterLoud && afterLoud.speech === false && afterLoud.text === '',
        JSON.stringify(afterLoud),
      )
      // ② 路由层面：并发两次 /transcribe，各拿各的 speech。
      const post = (body) => callRoute(env, '/dsh-voice-typing/transcribe', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/octet-stream' },
      })
      const loudBody = frameOfLevel(0.1)
      const silentBody = frameOfLevel(0)
      const first = await post(loudBody)
      check(
        'POST /transcribe（有声）回包带 speech:true',
        first.statusCode === 200 && first.json?.()?.speech === true,
        `status=${first.statusCode} ${JSON.stringify(first.json?.())}`,
      )
      const next = await post(silentBody)
      check(
        '紧接着一次静音 /transcribe 回包 speech:false（旧写法在这里会读到上一次的 true，客户端就不回滚实时字了）',
        next.statusCode === 200 && next.json?.()?.speech === false,
        `status=${next.statusCode} ${JSON.stringify(next.json?.())}`,
      )
      const concurrent = await Promise.all([
        post(silentBody),
        post(loudBody),
        post(silentBody),
        post(loudBody),
      ])
      const speeches = concurrent.map((r) => r.json?.()?.speech)
      check(
        '四个并发 /transcribe 各拿各的 speech（false,true,false,true —— 模块级变量会串味）',
        JSON.stringify(speeches) === JSON.stringify([false, true, false, true])
          && concurrent.every((r) => r.statusCode === 200),
        JSON.stringify({ speeches, statuses: concurrent.map((r) => r.statusCode) }),
      )
    } finally {
      env.restore()
    }
  } finally {
    fake.uninstall()
    for (const dir of [home, fake.dir]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
    }
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
