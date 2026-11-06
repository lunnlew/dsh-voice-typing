/**
 * 开麦设备层的行为回归（第 4 步 4.4b 的第一块）。
 *
 * 为什么要单独测：`getUserMedia` 这条链路在此之前**没有任何运行时覆盖** ——
 * `test/listening-ready.test.mjs` 用的是「扫 `main.js` 源码里有没有那几行」，
 * 只能证明代码写了，证明不了空轨道真的进不了聆听态、也证明不了
 * composer 少写的那条 `if (!AudioCtx) throw` 守卫会带来什么。
 * 这一文件用假环境驱动真代码，把设备层自己的判据钉住；
 * 「接在组件上」的那一半在 `test/client-behavior.test.mjs` 的开麦场景里。
 *
 * 覆盖（按搬出来之前那六件事排）：
 *   能力探测 / 约束对象单源 / 取流失败原样抛 / 「有流 ≠ 有声音」/
 *   AudioContext 取法与守卫 / 释放轨道 / 关上下文不冒未处理拒绝。
 */
import { createMicDevice } from '../src/client/dom/mic-device.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/** 造一条轨道。 */
function makeTrack(readyState = 'live') {
  return { readyState, kind: 'audio', label: 'fake-mic', stopped: 0, stop() { this.stopped += 1 } }
}

/** 造一个流：tracks 里就是 getAudioTracks / getTracks 的返回内容。 */
function makeStream(tracks) {
  return {
    tracks,
    getAudioTracks: () => tracks.slice(),
    getTracks: () => tracks.slice(),
  }
}

/**
 * 假设备接口：记录每一次 getUserMedia 收到的约束。
 * @param {object} [opts] - `noGum`（没有 getUserMedia）/ `reject`（拒绝）/ `tracks`（给的流）。
 */
function makeMediaDevices(opts = {}) {
  const calls = []
  async function gum(constraints) {
    calls.push(constraints)
    if (opts.reject) throw new Error('NotAllowedError')
    return makeStream(opts.tracks ?? [makeTrack()])
  }
  // noGum 要有「对象在、方法不在」这个形状，所以不能只传一个空函数。
  return { md: opts.noGum ? {} : { getUserMedia: gum }, calls }
}

/** 假 AudioContext：够设备层用（resume / close），音频图的细节不归这里。 */
function makeCtxFactory(opts = {}) {
  const built = []
  const ctor = function FakeCtx() {
    if (opts.throws) throw new Error('NotSupportedError: no audio device')
    const ctx = {
      sampleRate: opts.sampleRate ?? 48000,
      resumes: 0,
      closes: 0,
      resume() {
        ctx.resumes += 1
        return opts.resumeRejects ? Promise.reject(new Error('gesture required')) : Promise.resolve()
      },
      close() {
        ctx.closes += 1
        if (opts.closeThrowsSync) throw new Error('close exploded')
        return opts.closeRejects ? Promise.reject(new Error('cannot close')) : Promise.resolve()
      },
    }
    built.push(ctx)
    return ctx
  }
  return { ctor, built }
}

function makeWin(ctor, opts = {}) {
  const win = {}
  if (opts.webkitOnly) win.webkitAudioContext = ctor
  else win.AudioContext = ctor
  if (opts.neither) return {}
  if (opts.alsoWebkit) win.webkitAudioContext = opts.alsoWebkit
  return win
}

console.log('\n桩环境（什么都没注入）：只能退化，不许抛')
{
  const mic = createMicDevice()
  check('没有注入时 supportsCapture 为假', mic.supportsCapture() === false)
  const err = await mic.requestStream().then(() => null, (e) => e)
  check('没有注入时 requestStream 以 reject 失败（不是同步抛出）', err instanceof Error)
  check('没有注入时 createAudioContext 抛「no AudioContext」而不是 new undefined 的 TypeError',
    (() => {
      try { mic.createAudioContext(); return false } catch (e) { return e instanceof Error && !/is not a constructor/.test(e.message) }
    })())
  check('releaseStream(undefined) 不抛错', (() => { try { mic.releaseStream(undefined); return true } catch { return false } })())
  check('closeAudioContext(undefined) 不抛错也不返回 promise', mic.closeAudioContext(undefined) === undefined)
  check('liveAudioTrack(undefined) 返回 null', mic.liveAudioTrack(undefined) === null)
}

console.log('\n能力探测：三种「不能录」都要认出来')
{
  const readThrows = createMicDevice({ readMediaDevices: () => { throw new Error('no navigator in this stub') } })
  check('取值函数本身抛错时算「不能录」', readThrows.supportsCapture() === false)
  const noDevices = createMicDevice({ readMediaDevices: () => null })
  check('设备接口取不到时算「不能录」', noDevices.supportsCapture() === false)
  const withoutGum = makeMediaDevices({ noGum: true })
  const noGum = createMicDevice({ readMediaDevices: () => withoutGum.md })
  check('有 mediaDevices 但没有 getUserMedia 时算「不能录」', noGum.supportsCapture() === false)
  const err = await noGum.requestStream().then(() => null, (e) => e)
  check('这种设备上 requestStream 也失败', err instanceof Error)
  const withGum = makeMediaDevices()
  check('有 getUserMedia 时算「能录」', createMicDevice({ readMediaDevices: () => withGum.md }).supportsCapture() === true)
}

console.log('\n约束对象：两个录音入口必须拿到同一份')
{
  const devices = makeMediaDevices()
  const mic = createMicDevice({ readMediaDevices: () => devices.md })
  await mic.requestStream()
  await mic.requestStream()
  const [a, b] = devices.calls
  check('两次取流拿到的是**同一个**约束对象（不是各写一份字面量）', a === b)
  check('约束的内容就是搬动前那五项',
    a.audio.channelCount === 1 && a.audio.sampleRate === 16000
    && a.audio.echoCancellation === true && a.audio.noiseSuppression === true && a.audio.autoGainControl === true,
    JSON.stringify(a))
  check('约束是冻结的（改一边不会影响另一边）', Object.isFrozen(a) && Object.isFrozen(a.audio))
  check('captureConstraints() 暴露的也是同一份', mic.captureConstraints() === a)
}

console.log('\n取流失败：原因原样交给调用方（两条链路的文案不同）')
{
  const devices = makeMediaDevices({ reject: true })
  const mic = createMicDevice({ readMediaDevices: () => devices.md })
  const err = await mic.requestStream().then(() => null, (e) => e)
  check('getUserMedia 被拒时 requestStream 抛出的是设备给的那个错', err instanceof Error && /NotAllowedError/.test(err.message))
}

console.log('\n「拿到流」不等于「拿得到声音」')
{
  const mic = createMicDevice()
  check('空轨道列表 → 没有可用轨道', mic.liveAudioTrack(makeStream([])) === null)
  const ended = makeTrack('ended')
  check('已结束（ended）的轨道 → 没有可用轨道', mic.liveAudioTrack(makeStream([ended])) === null)
  const live = makeTrack('live')
  check('活着的轨道原样返回', mic.liveAudioTrack(makeStream([live])) === live)
  check('流里没有 getAudioTracks 时算没有可用轨道（不抛错）',
    mic.liveAudioTrack({ getTracks: () => [] }) === null)
  // 现状标注：'muted' 在规范里是「轨道存在但被别处静音」，仍能出数据（音频图照跑），
  // 所以搬动前后都只拦 ended。改成拦 muted 会误伤「被系统静音但随时可恢复」的设备。
  check('muted 轨道仍算可用（本轮只搬判据，未扩判据）',
    mic.liveAudioTrack(makeStream([makeTrack('muted')])) !== null)
}

console.log('\nAudioContext 取法与守卫')
{
  const primary = makeCtxFactory()
  const fallback = makeCtxFactory()
  const mic = createMicDevice({ win: makeWin(primary.ctor, { alsoWebkit: fallback.ctor }) })
  const ctx = mic.createAudioContext()
  check('两个构造器都在时优先用标准名', primary.built.includes(ctx) && fallback.built.length === 0)
  const webkit = makeCtxFactory()
  const micWebkit = createMicDevice({ win: makeWin(webkit.ctor, { webkitOnly: true }) })
  check('只有 webkit 前缀时用它（旧内核）', micWebkit.createAudioContext() === webkit.built[0])
  const neither = createMicDevice({ win: makeWin(null, { neither: true }) })
  const err = (() => { try { neither.createAudioContext(); return null } catch (e) { return e } })()
  check('两个都没有时抛的是可辨认的 Error（不是 TypeError）', err instanceof Error && /AudioContext/.test(err.message))
  const throwing = makeCtxFactory({ throws: true })
  const micThrows = createMicDevice({ win: makeWin(throwing.ctor) })
  check('构造器存在但自己抛错时，错误照旧出去（由调用方复位状态）',
    (() => { try { micThrows.createAudioContext(); return false } catch (e) { return /NotSupportedError/.test(e.message) } })())
  check('没有注入 win 时也是抛 Error，不是 new undefined 的 TypeError',
    (() => { try { createMicDevice().createAudioContext(); return false } catch (e) { return !(e instanceof TypeError) } })())
}

console.log('\nresume：手势里恢复，没有 resume 就当成功')
{
  const ok = makeCtxFactory()
  const mic = createMicDevice({ win: makeWin(ok.ctor) })
  const ctx = mic.createAudioContext()
  await mic.resumeContext(ctx)
  check('调用了 ctx.resume', ctx.resumes === 1)
  const bare = { }
  check('上下文没有 resume 方法时不抛错（旧内核）', await mic.resumeContext(bare).then(() => true, () => false))
  const rejecting = makeCtxFactory({ resumeRejects: true })
  const micReject = createMicDevice({ win: makeWin(rejecting.ctor) })
  const err = await micReject.resumeContext(micReject.createAudioContext()).then(() => null, (e) => e)
  check('resume 被拒时错误要能传出去（浮层靠它决定要不要释放麦克风）', err instanceof Error)
}

console.log('\n释放轨道')
{
  const tracks = [makeTrack(), makeTrack('ended')]
  const mic = createMicDevice()
  mic.releaseStream(makeStream(tracks))
  check('每条轨道都 stop 一次', tracks.every((tr) => tr.stopped === 1))
  const again = makeTrack()
  mic.releaseStream(makeStream([again]))
  check('同一个流可以重复释放（stop 是幂等的，这里只数次数）', again.stopped === 1)
  check('getTracks 抛错时释放动作不外泄（不能盖住真正的失败原因）',
    (() => { try { mic.releaseStream({ getTracks: () => { throw new Error('stream detached') } }); return true } catch { return false } })())
  check('没有 getTracks 的流（桩）也不会抛',
    (() => { try { mic.releaseStream({}); return true } catch { return false } })())
}

console.log('\n关上下文')
{
  const factory = makeCtxFactory()
  const mic = createMicDevice({ win: makeWin(factory.ctor) })
  const ctx = mic.createAudioContext()
  const ret = mic.closeAudioContext(ctx)
  check('close() 被调用', ctx.closes === 1)
  check('close() 返回 promise 时把它交回调用方（开麦取消那条路要 await 它）',
    Boolean(ret) && typeof ret.then === 'function' && await Promise.resolve(ret).then(() => true, () => false))
  const rejecting = makeCtxFactory({ closeRejects: true })
  const micReject = createMicDevice({ win: makeWin(rejecting.ctor) })
  const ctxReject = micReject.createAudioContext()
  const promise = micReject.closeAudioContext(ctxReject)
  check('close() 返回被拒的 promise 时挂上了 catch（不会冒未处理拒绝）',
    promise && typeof promise.then === 'function' && await Promise.resolve(promise).then(() => true, () => false))
  const sync = makeCtxFactory({ closeThrowsSync: true })
  const micSync = createMicDevice({ win: makeWin(sync.ctor) })
  check('close() 同步抛错时吞掉',
    (() => { try { micSync.closeAudioContext(micSync.createAudioContext()); return true } catch { return false } })())
  check('上下文没有 close 方法时不抛（旧内核）',
    (() => { try { mic.closeAudioContext({}); return true } catch { return false } })())
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
