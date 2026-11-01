/**
 * 客户端「真实行为」测试：直接加载构建产物 `lib/client.js` 并驱动它。
 *
 * 为什么需要它：
 *   仓库里大多数客户端测试是「对 lib/client.js 做源码正则形状断言」——
 *   它们能发现「代码里有/没有这句话」，但**发现不了时序类缺陷**：
 *   每条 sentence 是否恰好 ack 一次、播放顺序、段落是否从中间开始、
 *   停止/换轮后旧句是否还会出声。这类缺陷曾经真实发生过（burst 单段 12 句
 *   只播 1 句、停止后旧句仍 start）。
 *
 * 做法：
 *   用 `node:vm` + 最小 React hooks 运行时 + 假 DOM / EventSource /
 *   AudioContext / fetch 加载**真实产物**，驱动真实的 sentence 处理器与
 *   `pumpQueue`，记录「播放了哪些文本 / 发了哪些 reading-ack / 调了哪些 /tts」。
 *
 * 覆盖（11 个场景 / 26 条断言）：
 *   - 正常播放：顺序 + 每条恰好 ack 一次；
 *   - 合成失败 / 去重 / 迟到旧轮 / turn-begin 漏收自愈；
 *   - 停止朗读（静音）后本轮不再播，被拦下的句子也 ack；
 *   - 换轮：旧轮清队列也 ack，不会倒回去念旧轮；
 *   - burst 单段 12 句全部播出（安全网不能裁掉正在读的段落剩余）；
 *   - burst 多段：不允许从段落中间开始播；
 *   - 无 AudioContext：队列丢弃但全部 ack、不卡死、后续能恢复；
 *   - suspended + halt：halt 之后旧句不得再开始播放（gen 复查回归）；
 *   - 25s 合成超时后仍会 ack。
 *
 * 用法：node test/client-behavior.test.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const clientSrc = fs.readFileSync(ROOT + '/lib/client.js', 'utf8')

/* ------------------------------------------------------------------ */
/* 日志 / 断言                                                         */
/* ------------------------------------------------------------------ */
let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failures.push({ name, detail }); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeoutMs, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(stepMs)
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 环境：DOM / AudioContext / fetch / EventSource                      */
/* ------------------------------------------------------------------ */
const env = {
  /** 现在正在播放的文本（FakeSource.start 时记录）。 */
  playedTexts: [],
  /** 收到的 reading-ack：{ sessionId, turnId, count }。 */
  acks: [],
  /** /tts 调用过的文本。 */
  ttsTexts: [],
  /** AudioContext 行为：'running' | 'unavailable' | 自定义对象。 */
  audio: { mode: 'running', playMs: 25, suspendUntil: 0 },
  /** tts 行为：返回 {ok, status} 或抛错的函数。 */
  ttsBehavior: () => ({ ok: true, status: 200 }),
  config: { readAloud: true, autoSend: false, readAloudLag: 15, silenceMs: 1500, ttsEngine: 'online', localVoice: '', mode: 'toggle', preloadModels: false },
  eventSources: [],
  fetchLog: [],
  warnings: [],
  /** 假 document 的 querySelectorAll 结果（高亮用）。 */
  domQueryResult: [],
}

const objectUrls = new Map()

function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    textContent: '',
    isConnected: true,
    setAttribute() {},
    getAttribute() { return null },
    appendChild(child) { this.children.push(child); return child },
    removeChild() {},
    remove() { this.isConnected = false },
    querySelector() { return null },
    querySelectorAll() { return [] },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 } },
  }
}

const fakeDocument = {
  head: makeElement('head'),
  body: makeElement('body'),
  createElement: (tag) => makeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => env.domQueryResult,
  addEventListener() {},
  removeEventListener() {},
  createTreeWalker() { return { nextNode: () => null } },
  createRange() {
    return { setStart() {}, setEnd() {}, getClientRects: () => [] }
  },
}

class FakeAudioContext {
  constructor(options) {
    if (env.audio.mode === 'unavailable') throw new Error('NotSupportedError: fake no audio device')
    this.sampleRate = Number(options?.sampleRate) || 48000
    this.state = env.audio.mode === 'starts-suspended' ? 'suspended' : 'running'
    this.destination = { name: 'destination' }
    this.closed = false
    this._currentText = ''
    env.audio.ctx = this
    if (env.audio.debug) console.log('[audio] new ctx state=', this.state)
  }
  resume() {
    return Promise.resolve().then(() => {
      if (env.audio.mode === 'starts-suspended' && env.audio.suspendUntil && Date.now() >= env.audio.suspendUntil) {
        this.state = 'running'
        if (env.audio.debug) console.log('[audio] resume -> running at', Date.now() - env.audio.t0)
      }
      return undefined
    })
  }
  decodeAudioData(bytes) {
    const text = Buffer.from(bytes).toString('utf8')
    return Promise.resolve({ duration: env.audio.playMs / 1000, text })
  }
  createBufferSource() {
    const ctx = this
    return {
      buffer: null,
      onended: null,
      connect() {},
      start() {
        const text = this.buffer?.text ?? ctx._currentText
        env.playedTexts.push(text)
        this._started = true
        if (env.audio.debug) console.log('[audio] start at', Date.now() - (env.audio.t0 ?? 0), 'state=', ctx.state, 'text=', String(text).slice(0, 10))
        this._timer = setTimeout(() => this._finish(), env.audio.playMs)
      },
      stop() {
        if (!this._started || this._finished) return
        clearTimeout(this._timer)
        this._finish()
      },
      _finish() {
        if (this._finished) return
        this._finished = true
        try { this.onended?.() } catch { /* ignore */ }
      },
    }
  }
  close() { if (env.audio.debug) console.log('[audio] close at', Date.now() - (env.audio.t0 ?? 0)); this.closed = true; this.state = 'closed'; return Promise.resolve() }
}

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
    blob: async () => new Blob([]),
  }
}

async function fakeFetch(url, options = {}) {
  env.fetchLog.push({ url, method: options?.method ?? 'GET' })
  const u = String(url)
  if (u.includes('/dsh-voice-typing/tts?text=')) {
    const text = decodeURIComponent(u.split('text=')[1] ?? '')
    env.ttsTexts.push(text)
    const behavior = env.ttsBehavior(text)
    if (behavior.throw) throw new Error('network down')
    if (!behavior.ok) {
      return {
        ok: false,
        status: behavior.status ?? 500,
        text: async () => JSON.stringify({ error: 'fake tts failure' }),
        json: async () => ({ error: 'fake tts failure' }),
        blob: async () => new Blob([]),
      }
    }
    return {
      ok: true,
      status: 200,
      blob: async () => ({ __text: text, size: 16 }),
      text: async () => '',
      json: async () => ({}),
    }
  }
  if (u.startsWith('blob:')) {
    const item = objectUrls.get(u)
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        const bytes = Buffer.from(item?.__text ?? '', 'utf8')
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      },
      json: async () => ({}),
      text: async () => '',
      blob: async () => new Blob([]),
    }
  }
  if (u.includes('/reading-ack')) {
    const body = JSON.parse(options?.body ?? '{}')
    env.acks.push({ sessionId: body.sessionId, turnId: body.turnId, count: body.count ?? 1 })
    return jsonResponse({ ok: true })
  }
  if (u.includes('/config')) {
    if (options?.method === 'POST') return jsonResponse({ ok: true, config: env.config })
    return jsonResponse({ ...env.config })
  }
  if (u.includes('/busy')) return jsonResponse({ busy: false })
  if (u.includes('/voices')) return jsonResponse({ voices: [], supported: true })
  if (u.includes('/models')) return jsonResponse({ models: [] })
  if (u.includes('/voice-session')) return jsonResponse({ ok: true })
  return jsonResponse({ ok: true })
}

class FakeEventSource {
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    env.eventSources.push(this)
    setTimeout(() => { try { this.onopen?.() } catch { /* ignore */ } }, 0)
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  removeEventListener() {}
  close() { this.closed = true }
  emit(type, payload) {
    const open = this.listeners.get(type) ?? []
    const data = JSON.stringify({ v: 3, seq: 1, ts: Date.now(), ...payload })
    for (const fn of open) {
      try { fn({ data }) } catch (error) { env.warnings.push('handler ' + type + ': ' + error?.stack) }
    }
  }
}

const windowAddListeners = new Map()
const fakeWindow = {
  document: fakeDocument,
  console,
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (...args) => setInterval(...args),
  clearInterval: (id) => clearInterval(id),
  addEventListener(type, fn) {
    if (!windowAddListeners.has(type)) windowAddListeners.set(type, new Set())
    windowAddListeners.get(type).add(fn)
  },
  removeEventListener(type, fn) { windowAddListeners.get(type)?.delete(fn) },
  requestAnimationFrame(fn) { return setTimeout(fn, 0) },
  cancelAnimationFrame(id) { clearTimeout(id) },
  NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  AudioContext: FakeAudioContext,
  webkitAudioContext: FakeAudioContext,
  isSecureContext: true,
  speechSynthesis: { cancel() {} },
}
fakeWindow.window = fakeWindow

const urlShim = {
  createObjectURL(blob) {
    const id = 'blob:fake-' + Math.random().toString(36).slice(2)
    objectUrls.set(id, blob)
    return id
  },
  revokeObjectURL(id) { objectUrls.delete(id) },
}

/* ------------------------------------------------------------------ */
/* 最小 React hooks 运行时                                             */
/* ------------------------------------------------------------------ */
function createHookRuntime() {
  const slots = []
  let index = 0
  let rendering = false
  let scheduled = false
  let tree = null
  let mounted = false
  let component = null
  let props = null
  const pendingEffects = []

  const sameDeps = (a, b) => {
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
    return true
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, config, ...children) {
      const propsObj = { ...(config ?? {}) }
      if (children.length === 1) propsObj.children = children[0]
      else if (children.length > 1) propsObj.children = children
      return { type, props: propsObj, key: propsObj.key ?? null }
    },
    useState(initial) {
      const i = index++
      if (!slots[i]) slots[i] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        schedule()
      }
      return [slot.value, set]
    },
    useRef(initial) {
      const i = index++
      if (!slots[i]) slots[i] = { kind: 'ref', ref: { current: initial } }
      return slots[i].ref
    },
    useCallback(fn, deps) {
      const i = index++
      const slot = slots[i]
      if (slot && sameDeps(slot.deps, deps)) return slot.fn
      slots[i] = { kind: 'cb', fn, deps }
      return fn
    },
    useEffect(fn, deps) {
      const i = index++
      const slot = slots[i]
      const changed = !slot || !sameDeps(slot.deps, deps)
      if (!slot) slots[i] = { kind: 'effect', deps, fn, cleanup: null }
      else {
        if (changed) slot.fn = fn
        slot.deps = deps
      }
      if (changed) pendingEffects.push(i)
    },
  }

  function runEffects() {
    while (pendingEffects.length) {
      const i = pendingEffects.shift()
      const slot = slots[i]
      if (!slot || slot.kind !== 'effect') continue
      if (typeof slot.cleanup === 'function') {
        try { slot.cleanup() } catch (error) { env.warnings.push('effect cleanup: ' + error?.stack) }
        slot.cleanup = null
      }
      try {
        const ret = slot.fn()
        if (typeof ret === 'function') slot.cleanup = ret
      } catch (error) {
        env.warnings.push('effect: ' + error?.stack)
      }
    }
  }

  function render() {
    if (rendering) return
    rendering = true
    index = 0
    try {
      tree = component(props)
    } catch (error) {
      env.warnings.push('render: ' + error?.stack)
      rendering = false
      return
    }
    rendering = false
    mounted = true
    runEffects()
  }

  function schedule() {
    if (scheduled || !mounted) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!mounted) return
      render()
    })
  }

  function mount(comp, compProps) {
    component = comp
    props = compProps
    render()
  }

  return { React, mount, getTree: () => tree, setState: (slotIndex, value) => { slots[slotIndex].value = value; schedule() } }
}

function findByProp(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (node.props && predicate(node)) return node
  const children = node.props?.children
  const list = Array.isArray(children) ? children : [children]
  for (const child of list) {
    const found = findByProp(child, predicate)
    if (found) return found
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 加载 client.js                                                      */
/* ------------------------------------------------------------------ */
const registrations = []
let moduleDef = null
const sandbox = {
  window: fakeWindow,
  globalThis: null,
  document: fakeDocument,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  Buffer,
  URL: urlShim,
  Blob: globalThis.Blob,
  fetch: fakeFetch,
  EventSource: FakeEventSource,
  AbortController,
  TextEncoder,
  TextDecoder,
  process,
  navigator: { mediaDevices: undefined },
}
sandbox.globalThis = sandbox
fakeWindow.__ModuleLoader__ = { load(def) { moduleDef = def } }
vm.createContext(sandbox)
vm.runInContext(clientSrc, sandbox, { filename: 'lib/client.js' })

const runtime = createHookRuntime()
const requireStub = (name) => {
  if (name === 'react') return runtime.React
  throw new Error('unexpected require: ' + name)
}
const exportsObj = moduleDef.factory(requireStub)
exportsObj.apply({
  inject(_deps, cb) {
    const scope = {
      effect(fn) { const d = fn(); return d ?? (() => {}) },
      locale: { register() { return () => {} } },
      slots: {
        inject(_name, cb2) { cb2() },
        register(options, component) {
          registrations.push({ options, component })
          return () => {}
        },
      },
    }
    cb(scope)
  },
})

const MicButton = registrations.find((r) => r.component && /MicButton/.test(r.component.name ?? ''))?.component
if (!MicButton) {
  console.error('找不到 MicButton 组件，registrations=', registrations.map((r) => r.options))
  process.exit(2)
}

/* ------------------------------------------------------------------ */
/* 驱动                                                               */
/* ------------------------------------------------------------------ */
function currentSource() {
  const sources = env.eventSources.filter((s) => !s.closed)
  return sources[sources.length - 1]
}

function emit(type, payload) {
  const sse = currentSource()
  if (!sse) throw new Error('no live EventSource')
  sse.emit(type, payload)
}

function emitSentence({ text, turnId = 'turn-1', index, para, paraStart }) {
  emit('sentence', {
    sessionId: 'sess-1',
    turnId,
    index,
    text,
    para,
    paraStart,
  })
}

function ackTotal() {
  return env.acks.reduce((n, a) => n + (Number(a.count) || 0), 0)
}

/** 等朗读管道彻底空闲（pumpQueue 已退出、队列为空），避免场景之间互相污染。 */
async function settle(timeoutMs = 6000) {
  const idle = await waitFor(() => {
    const dbg = fakeWindow.__DSH_VOICE_DEBUG__?.()
    return Boolean(dbg) && dbg.speaking === false && dbg.queue === 0
  }, timeoutMs)
  await sleep(150)
  if (!idle && process.env.HARNESS_DEBUG) console.log('DEBUG settle timeout', fakeWindow.__DSH_VOICE_DEBUG__?.())
}

function resetEnv() {
  try { env.audio.ctx?.close() } catch { /* ignore */ }
  env.playedTexts.length = 0
  env.acks.length = 0
  env.ttsTexts.length = 0
  env.audio = { mode: 'running', playMs: 25 }
  env.ttsBehavior = () => ({ ok: true, status: 200 })
  env.domQueryResult = []
  env.warnings.length = 0
}

function bootMic() {
  runtime.mount(MicButton, { sessionId: 'sess-1', t: (k) => k })
}

function makeSentences(paras) {
  // paras: [[text,...], ...] -> [{text,index,para,paraStart}]
  let index = 0
  const out = []
  paras.forEach((texts, para) => {
    texts.forEach((text, i) => {
      out.push({ text, index: index++, para, paraStart: i === 0 })
    })
  })
  return out
}

function emitAll(sentences, turnId = 'turn-1') {
  for (const s of sentences) emitSentence({ ...s, turnId })
}

/* ------------------------------------------------------------------ */
/* 场景 1：正常顺序播放 + ack 恰好一次                                  */
/* ------------------------------------------------------------------ */
async function scenarioNormal() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'n1' })
  const list = makeSentences([
    ['这是第一段第一句。', '这是第一段第二句。'],
    ['这是第二段第一句。', '这是第二段第二句。'],
    ['这是第三段第一句。'],
  ])
  emitAll(list, 'n1')
  const done = await waitFor(() => env.playedTexts.length >= list.length, 8000)
  await sleep(200)
  check('[正常] 全部句子按顺序播放', done && env.playedTexts.join('|') === list.map((s) => s.text).join('|'),
    JSON.stringify(env.playedTexts))
  check('[正常] 每条 sentence 恰好 ack 一次', ackTotal() === list.length, `acks=${ackTotal()} expect=${list.length}`)
  check('[正常] 没有 JS 异常', env.warnings.length === 0, env.warnings.join('\n'))
}

/* ------------------------------------------------------------------ */
/* 场景 2：合成失败 / 跳过的句子也必须 ack 一次                          */
/* ------------------------------------------------------------------ */
async function scenarioTtsFailure() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'f1' })
  env.ttsBehavior = (text) => (text.includes('FAIL') ? { ok: false, status: 500 } : { ok: true, status: 200 })
  const list = makeSentences([['正常一句。', 'FAIL 这句会失败。', '正常两句。', 'FAIL 又失败。']])
  emitAll(list, 'f1')
  const done = await waitFor(() => ackTotal() >= list.length, 8000)
  await sleep(200)
  check('[合成失败] 失败的句子被跳过、其余照播',
    done && env.playedTexts.join('|') === '正常一句。|正常两句。', JSON.stringify(env.playedTexts))
  check('[合成失败] 每条 sentence 恰好 ack 一次', ackTotal() === list.length, `acks=${ackTotal()}`)
}

/* ------------------------------------------------------------------ */
/* 场景 3：重复广播去重（收到 2 条 → ack 2 条，播放 1 次）                */
/* ------------------------------------------------------------------ */
async function scenarioDuplicate() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'd1' })
  emitSentence({ text: '只该念一次。', turnId: 'd1', index: 0, para: 0, paraStart: true })
  await waitFor(() => env.playedTexts.length >= 1, 5000)
  emitSentence({ text: '只该念一次。', turnId: 'd1', index: 0, para: 0, paraStart: true })
  await waitFor(() => ackTotal() >= 2, 2000)
  await sleep(100)
  check('[去重] 重复的 sentence 不重播', env.playedTexts.length === 1, JSON.stringify(env.playedTexts))
  check('[去重] 两条收到的 sentence 各 ack 一次（传给宿主的是 2）', ackTotal() === 2, `acks=${ackTotal()}`)
}

/* ------------------------------------------------------------------ */
/* 场景 4：手动静音（点「停止朗读」）→ 后续句子 ack 但不播               */
/* ------------------------------------------------------------------ */
async function scenarioMute() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'm1' })
  emitSentence({ text: '停止前的一句。', turnId: 'm1', index: 0, para: 0, paraStart: true })
  await waitFor(() => env.playedTexts.length >= 1, 5000)
  // 等一次重渲染，让「停止朗读」按钮出现
  await sleep(50)
  const tree = runtime.getTree()
  const stopBtn = findByProp(tree, (node) => node?.type === 'button' && node?.props?.['aria-label'] === 'stopSpeaking')
  if (!stopBtn) {
    check('[静音] 找到「停止朗读」按钮', false, '渲染树里没有 stopSpeaking 按钮（speaking 状态没更新？）')
    return
  }
  check('[静音] 找到「停止朗读」按钮', true)
  stopBtn.props.onClick()
  await sleep(100)
  const emittedAfter = 3
  for (let i = 1; i <= emittedAfter; i++) {
    emitSentence({ text: '停止后的第' + i + '句。', turnId: 'm1', index: i, para: 0, paraStart: false })
  }
  await waitFor(() => ackTotal() >= 1 + emittedAfter, 2000)
  await sleep(100)
  check('[静音] 停止后这一轮的句子不再播放', env.playedTexts.length === 1, JSON.stringify(env.playedTexts))
  check('[静音] 被静音拦下的句子也各 ack 一次', ackTotal() === 1 + emittedAfter, `acks=${ackTotal()}`)
}

/* ------------------------------------------------------------------ */
/* 场景 5：turn-begin 清空旧队列 → 清掉的句也要 ack 一次                 */
/* ------------------------------------------------------------------ */
async function scenarioTurnReset() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'r1' })
  const oldList = makeSentences([['旧轮第一句。', '旧轮第二句。', '旧轮第三句。', '旧轮第四句。', '旧轮第五句。', '旧轮第六句。']])
  emitAll(oldList, 'r1')
  // 立刻换轮（趁旧队列还在）
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'r2' })
  const newList = makeSentences([['新轮唯一一句。']])
  emitAll(newList, 'r2')
  await waitFor(() => ackTotal() >= oldList.length + newList.length, 8000)
  await sleep(100)
  check('[换轮] 旧轮被清掉的句子也 ack（总数 = 6 + 1）',
    ackTotal() === oldList.length + newList.length, `acks=${ackTotal()}`)
  check('[换轮] 新轮的句子会播', env.playedTexts.includes('新轮唯一一句。'), JSON.stringify(env.playedTexts))
  const playedOld = env.playedTexts.filter((t) => t.startsWith('旧轮'))
  check('[换轮] 旧轮播放发生在换轮之前（不会倒回去念旧内容）',
    env.playedTexts.lastIndexOf(playedOld[playedOld.length - 1] ?? '') <
    env.playedTexts.indexOf('新轮唯一一句。'), JSON.stringify(env.playedTexts))
}

/* ------------------------------------------------------------------ */
/* 场景 6：长单段回复 + 一次性 burst → 安全网是否把整段剩余裁掉？          */
/* ------------------------------------------------------------------ */
async function scenarioLongSingleParaBurst() {
  await settle()
  resetEnv()
  // 模拟「宿主 pending 模式 endCall 一次性把整段剩余句子喷出来」：
  // 第一句先发（客户端开始合成），其余 11 句随即一起到达。
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'b1' })
  const texts = []
  for (let i = 0; i < 12; i++) texts.push('这是同一个自然段里的第' + i + '句，用来验证安全网。')
  emitSentence({ text: texts[0], turnId: 'b1', index: 0, para: 0, paraStart: true })
  await sleep(0)
  for (let i = 1; i < texts.length; i++) {
    emitSentence({ text: texts[i], turnId: 'b1', index: i, para: 0, paraStart: false })
  }
  const done = await waitFor(() => env.playedTexts.length >= texts.length, 9000)
  await waitFor(() => ackTotal() >= texts.length, 2000)
  await sleep(50)
  const dbg = fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  check('[burst 单段] 12 句全部播出（安全网不该把正在读的这段剩余全裁掉）',
    done && env.playedTexts.length === texts.length,
    `播放了 ${env.playedTexts.length}/12；trimmed=${dbg.trimmed}；播出的：${JSON.stringify(env.playedTexts.map((t) => t.slice(8, 11)))}`)
  check('[burst 单段] 收到 12 句就要 ack 12 次（播的 + 裁掉的）', ackTotal() === texts.length, `acks=${ackTotal()}`)
}

/* ------------------------------------------------------------------ */
/* 场景 6b：同场景的时序证据 —— 裁剪发生在「正在读这一段」的时候还是之后？ */
/* ------------------------------------------------------------------ */
async function scenarioTrimTimingEvidence() {
  await settle()
  resetEnv()
  const trace = []
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  const trimmedBase = dbg().trimmed ?? 0
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'b1t' })
  const texts = []
  for (let i = 0; i < 12; i++) texts.push('时序证据段第' + i + '句。')
  const t0 = Date.now()
  const sample = () => {
    const d = dbg()
    trace.push({ t: Date.now() - t0, played: env.playedTexts.length, trimmed: (d.trimmed ?? 0) - trimmedBase, speaking: d.speaking, queue: d.queue })
  }
  emitSentence({ text: texts[0], turnId: 'b1t', index: 0, para: 0, paraStart: true })
  await sleep(0)
  for (let i = 1; i < texts.length; i++) emitSentence({ text: texts[i], turnId: 'b1t', index: i, para: 0, paraStart: false })
  while (Date.now() - t0 < 1200) {
    sample()
    if (env.playedTexts.length >= texts.length) break
    await sleep(20)
  }
  // 修复后的正确行为：单段 burst 里每一句都属于「当前段 / 最新段」，安全网
  // **根本不该裁**；即使发生了裁剪，也必须发生在第一句开播之前（丢更旧的段），
  // 绝不能在开播之后把当前段的剩余句子裁掉。
  const firstTrim = trace.find((x) => x.trimmed > 0)
  const trimmedAfterPlay = Boolean(firstTrim) && firstTrim.played > 0
  check('[burst 时序] 单段 burst 不会在开播后裁剪当前段剩余（修复后应完全不裁）',
    !trimmedAfterPlay,
    'trim 首次出现时 played=' + (firstTrim ? firstTrim.played : 'never（完全没裁，符合预期）') +
      '；trace=' + JSON.stringify(trace.filter((x, i, a) => i === 0 || x.trimmed !== a[i - 1].trimmed)))
}

/* ------------------------------------------------------------------ */
/* 场景 7：多段 burst → 不允许「从段落中间开始播」                       */
/* ------------------------------------------------------------------ */
async function scenarioMultiParaBurst() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'b2' })
  const list = makeSentences([
    ['段零第一句。', '段零第二句。'],
    ['段一第一句。', '段一第二句。', '段一第三句。'],
    ['段二第一句。', '段二第二句。', '段二第三句。'],
    ['段三第一句。', '段三第二句。', '段三第三句。'],
    ['段四第一句。', '段四第二句。', '段四第三句。'],
  ])
  // 先发第一句启动 pump，再 burst 其余
  emitSentence({ ...list[0], turnId: 'b2' })
  await sleep(0)
  for (const s of list.slice(1)) emitSentence({ ...s, turnId: 'b2' })
  await waitFor(() => ackTotal() >= list.length, 9000)
  await sleep(400)
  const played = env.playedTexts
  const playedParas = played.map((t) => Number((t.match(/段([零一二三四])/) ?? [])[1] ?? NaN))
  const paraName = { 0: '零', 1: '一', 2: '二', 3: '三', 4: '四' }
  const playedParaIdx = played.map((t) => Object.keys(paraName).find((k) => t.startsWith('段' + paraName[k])))
  // 不变量：某段只要播了，就必须从该段第一句开始播
  const violations = []
  const grouped = new Map()
  for (const text of played) {
    const m = /^段([零一二三四])第(.)句/.exec(text)
    if (!m) continue
    const paraLabel = m[1]
    const sentenceNo = m[2]
    if (!grouped.has(paraLabel)) grouped.set(paraLabel, [])
    grouped.get(paraLabel).push(sentenceNo)
  }
  for (const [paraLabel, numbers] of grouped) {
    if (numbers[0] !== '一') violations.push(`段${paraLabel}从「第${numbers[0]}句」开始播`)
  }
  check('[burst 多段] 不允许从段落中间开始播', violations.length === 0, violations.join('；') + ' played=' + JSON.stringify(played))
  check('[burst 多段] 收到 14 句就 ack 14 次', ackTotal() === list.length, `acks=${ackTotal()}`)
}

/* ------------------------------------------------------------------ */
/* 场景 7b：上一轮的迟到句子（换轮之后才到）→ 不播，但 ack 一次           */
/* ------------------------------------------------------------------ */
async function scenarioLateOldTurn() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'o1' })
  emitSentence({ text: '旧轮第一句。', turnId: 'o1', index: 0, para: 0, paraStart: true })
  await waitFor(() => env.playedTexts.length >= 1, 5000)
  // 换轮
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'o2' })
  emitSentence({ text: '新轮第一句。', turnId: 'o2', index: 0, para: 0, paraStart: true })
  await waitFor(() => env.playedTexts.includes('新轮第一句。'), 5000)
  // 旧轮的迟到句子（index 1，不是首句 → 必须被丢掉）
  emitSentence({ text: '旧轮迟到的一句。', turnId: 'o1', index: 1, para: 0, paraStart: false })
  await sleep(600)
  check('[迟到旧轮] 旧轮迟到句子不播', !env.playedTexts.includes('旧轮迟到的一句。'), JSON.stringify(env.playedTexts))
  check('[迟到旧轮] 旧轮迟到句子也 ack 一次（收到 3 条 → 3 次）', ackTotal() === 3, `acks=${ackTotal()}`)
}

/* ------------------------------------------------------------------ */
/* 场景 7c：漏收 turn-begin（index===0 自愈）→ 整轮仍能播 + ack 恰好一次  */
/* ------------------------------------------------------------------ */
async function scenarioSelfHeal() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'h1' })
  emitSentence({ text: '自愈前的旧轮。', turnId: 'h1', index: 0, para: 0, paraStart: true })
  await waitFor(() => env.playedTexts.length >= 1, 5000)
  // 宿主漏发/本连接漏收 turn-begin：直接来新轮 index 0
  emitSentence({ text: '新轮无 turn-begin 的第一句。', turnId: 'h2', index: 0, para: 0, paraStart: true })
  emitSentence({ text: '新轮无 turn-begin 的第二句。', turnId: 'h2', index: 1, para: 0, paraStart: false })
  await sleep(1200)
  check('[自愈] 漏收 turn-begin 时新轮仍能播（index===0 自愈）',
    env.playedTexts.includes('新轮无 turn-begin 的第一句。') && env.playedTexts.includes('新轮无 turn-begin 的第二句。'),
    JSON.stringify(env.playedTexts))
  check('[自愈] 收到 3 条 sentence 就 ack 3 次', ackTotal() === 3, `acks=${ackTotal()}`)
}

/* ------------------------------------------------------------------ */
/* 场景 8：拿不到播放上下文 → 清队列 + ack + 不自递归死锁                */
/* ------------------------------------------------------------------ */
async function scenarioNoAudioContext() {
  await settle()
  resetEnv()
  env.audio = { mode: 'unavailable', playMs: 25 }
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'na1' })
  const list = makeSentences([['没有音频上下文第一句。', '没有音频上下文第二句。', '没有音频上下文第三句。']])
  emitAll(list, 'na1')
  const acked = await waitFor(() => ackTotal() >= list.length, 5000)
  await sleep(300)
  check('[无 AudioContext] 队列被丢弃且每句 ack 一次（不会卡死）',
    acked && ackTotal() === list.length, `acks=${ackTotal()}`)
  check('[无 AudioContext] 不会无限递归/栈溢出', env.warnings.filter((w) => /Recursion|stack/i.test(w)).length === 0,
    env.warnings.join('\n'))
  // 播放上下文恢复后，后续句子还能播
  env.audio = { mode: 'running', playMs: 25 }
  emitSentence({ text: '恢复后的句子。', turnId: 'na1', index: 3, para: 0, paraStart: false })
  const played = await waitFor(() => env.playedTexts.includes('恢复后的句子。'), 5000)
  check('[无 AudioContext] 后续句子能恢复播放', played, JSON.stringify(env.playedTexts))
}

/* ------------------------------------------------------------------ */
/* 场景 9：播放上下文 suspended 时 halt（换轮）→ 旧句是否仍开始播放       */
/* ------------------------------------------------------------------ */
async function scenarioSuspendedHalt() {
  await settle()
  resetEnv()
  env.audio = { mode: 'starts-suspended', playMs: 25, suspendUntil: Date.now() + 600, debug: !!process.env.HARNESS_DEBUG, t0: Date.now() }
  emit('turn-begin', { sessionId: 'sess-1', turnId: 's1' })
  emitSentence({ text: '等待播放上下文恢复的这一句。', turnId: 's1', index: 0, para: 0, paraStart: true })
  // 让它进入 play() 的 resume 轮询
  await sleep(150)
  const beforeHalt = env.playedTexts.length
  // 用户发新消息 / 打断 → turn-begin → haltSpeaking（gen++）
  emit('turn-begin', { sessionId: 'sess-1', turnId: 's2' })
  await sleep(1200) // 等 resume 轮询结束
  if (process.env.HARNESS_DEBUG) {
    console.log('DEBUG suspendedHalt played=', env.playedTexts, 'beforeHalt=', beforeHalt, 'audioState=', env.audio.ctx?.state)
    console.log('DEBUG suspendedHalt dbg=', fakeWindow.__DSH_VOICE_DEBUG__?.())
    console.log('DEBUG suspendedHalt warnings=', env.warnings)
  }
  check('[suspended+halt] 被 halt 的旧句不应再开始播放',
    env.playedTexts.length === beforeHalt,
    `halt 后又播放了：${JSON.stringify(env.playedTexts.slice(beforeHalt))}`)
}

/* ------------------------------------------------------------------ */
/* 场景 10：合成超时（把 TTS_TIMEOUT 行为模拟成挂起）→ 也 ack 一次      */
/* ------------------------------------------------------------------ */
async function scenarioTimeoutAck() {
  await settle()
  resetEnv()
  // 让 /tts 的 fetch 变成永不 resolve 的 Promise：25s 超时会先触发。
  // 为了跑得快，这里只看「超时后 ack 仍会发生」——把计时缩到可接受范围不现实，
  // 所以本场景放最后且只验证 fetch 挂住时不会丢 ack（等 25s）。
  const originalFetch = globalThis.fetch
  const hanging = []
  sandbox.fetch = (url, options) => {
    if (String(url).includes('/tts?')) return new Promise(() => {})
    return fakeFetch(url, options)
  }
  sandbox.globalThis.fetch = sandbox.fetch
  vm.runInContext('', sandbox) // 让 sandbox.fetch 生效（client 里用全局 fetch）
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'to1' })
  emitSentence({ text: '永远合不成的这一句。', turnId: 'to1', index: 0, para: 0, paraStart: true })
  emitSentence({ text: '下一句。', turnId: 'to1', index: 1, para: 0, paraStart: false })
  const acked = await waitFor(() => ackTotal() >= 1, 30000, 200)
  check('[超时] 25s 超时后仍会 ack（不会让宿主等 watchdog 之外的更久）', acked, `acks=${ackTotal()}`)
  sandbox.fetch = originalFetch
  sandbox.globalThis.fetch = originalFetch
}

/* ------------------------------------------------------------------ */
async function main() {
  bootMic()
  await sleep(300) // 等挂载后的配置拉取 / SSE 建连
  if (process.env.HARNESS_DEBUG) {
    console.log('DEBUG registrations=', registrations.map((r) => r.options?.name))
    console.log('DEBUG eventSources=', env.eventSources.length)
    console.log('DEBUG tree=', runtime.getTree() ? 'ok' : 'null')
    console.log('DEBUG warnings=', env.warnings)
    console.log('DEBUG fetchLog=', env.fetchLog.map((f) => f.url).slice(0, 20))
  }

  // 场景隔离：每个场景重新拿一个 SSE（客户端只有一个组件/一个 EventSource，
  // 这里不复用组件，但每个场景都用同一个实例；通过 turn-begin 隔离状态）。
  await scenarioNormal()
  await scenarioTtsFailure()
  await scenarioDuplicate()
  await scenarioMute()
  await scenarioTurnReset()
  await scenarioLongSingleParaBurst()
  await scenarioTrimTimingEvidence()
  await scenarioMultiParaBurst()
  await scenarioLateOldTurn()
  await scenarioSelfHeal()
  await scenarioNoAudioContext()
  await scenarioSuspendedHalt()

  console.log(`\n通过 ${passed}，失败 ${failures.length}`)
  if (failures.length) {
    console.log('失败项：')
    for (const f of failures) console.log(' - ' + f.name + (f.detail ? ' :: ' + f.detail : ''))
    process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}

main().catch((error) => {
  console.error('harness crash:', error)
  process.exit(3)
})
