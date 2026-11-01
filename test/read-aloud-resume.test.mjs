/**
 * 端到端验证：朗读播放上下文恢复（resume）的两种行为对比。
 *
 * 直接对比两段真实的 play() 恢复逻辑：
 *   OLD（原 lib/client.js 里发出去的那版）：Promise.race([resume(), sleep(1000)])，
 *        1 秒没恢复就静默跳过这一句（没有任何计数）。
 *   NEW（现在的 src/client/main.js）：轮询 resume 最多 8 秒，只有彻底失败才跳过并计数。
 *
 * 场景：resume() 需要 2 秒才把状态变成 running（浏览器等用户授权、蓝牙耳机
 * 重新协商音频路由时有真实发生）。这正是「合成一直在调、但就是没声音」的场景。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 假 AudioContext：resume 要 delayMs 才真正生效。 */
function makeCtx(delayMs) {
  const ctx = { state: 'suspended', started: [], destination: {} }
  ctx.resume = async () => {
    await sleep(delayMs)
    ctx.state = 'running'
  }
  ctx.createBufferSource = () => {
    const src = {
      buffer: null,
      connect() {},
      start() { ctx.started.push(this.buffer.id) },
      stop() {},
      onended: null,
      id: null,
    }
    return src
  }
  return ctx
}

/** OLD：1 秒超时就跳过（静默丢弃，无计数）。 */
async function playOld(playCtx, decoded) {
  try {
    if (playCtx.state === 'suspended') {
      await Promise.race([playCtx.resume(), sleep(1000).then(() => null)])
    }
    if (playCtx.state === 'suspended') return { played: false, skipped: 0 }
  } catch {
    return { played: false, skipped: 0 }
  }
  await startNode(playCtx, decoded)
  return { played: true, skipped: 0 }
}

/** NEW：轮询 resume 最多 8 秒，彻底失败才跳过并计数。 */
async function playNew(playCtx, decoded) {
  let skipped = 0
  try {
    if (playCtx.state === 'suspended') {
      const deadline = Date.now() + 8000
      try { await playCtx.resume() } catch { /* 继续轮询 */ }
      while (playCtx.state === 'suspended' && Date.now() < deadline) {
        await sleep(100)
        if (playCtx.state === 'suspended') {
          try { await playCtx.resume() } catch { /* 继续 */ }
        }
      }
    }
    if (playCtx.state === 'suspended') { skipped += 1; return { played: false, skipped } }
  } catch {
    skipped += 1
    return { played: false, skipped }
  }
  await startNode(playCtx, decoded)
  return { played: true, skipped: 0 }
}

async function startNode(playCtx, decoded) {
  await new Promise((resolve) => {
    const source = playCtx.createBufferSource()
    source.buffer = decoded
    source.connect(playCtx.destination)
    source.onended = resolve
    source.start(0)
    // 立刻结束（模拟正常播完）
    setTimeout(resolve, 10)
  })
}

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('场景：resume 需要 2 秒才生效（浏览器等授权 / 蓝牙耳机重协商音频路由）')
{
  const ctxOld = makeCtx(2000)
  const old = await playOld(ctxOld, { id: 'old' })
  check('旧逻辑：这句话被静默丢弃（这就是「无法朗读」）', old.played === false && ctxOld.started.length === 0,
    JSON.stringify(old))

  const ctxNew = makeCtx(2000)
  const neu = await playNew(ctxNew, { id: 'new' })
  check('新逻辑：等到恢复后正常播出', neu.played === true && ctxNew.started.length === 1, JSON.stringify(neu))
}

console.log('\n场景：resume 立刻生效（正常情况）')
{
  const ctxOld = makeCtx(0)
  const old = await playOld(ctxOld, { id: 'old' })
  const ctxNew = makeCtx(0)
  const neu = await playNew(ctxNew, { id: 'new' })
  check('两者都正常播出', old.played && neu.played)
}

console.log('\n场景：resume 永远失败（自动播放被彻底禁止）')
{
  const ctxNew = makeCtx(0)
  ctxNew.resume = async () => { /* 永远变不成 running */ }
  const t0 = Date.now()
  const neu = await playNew(ctxNew, { id: 'new' })
  const waited = Date.now() - t0
  check('新逻辑：彻底失败才跳过，并记一次可观测计数', neu.played === false && neu.skipped === 1,
    JSON.stringify(neu))
  check('新逻辑：最多等约 8 秒，不会无限卡住管道', waited >= 7800 && waited < 12000,
    `等了 ${waited}ms`)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
