/**
 * 全局语音纯函数测试：VAD 分段状态机、文本归一化、AudioWorklet 源码。
 *
 * 覆盖：
 *   - VAD：开口去抖、静音断句、短停顿不切段、自适应门限、状态不可变；
 *   - 文本：归一化（去开头标点/压空白）、限长（4000 上限，按码点切）、注入模式；
 *   - 毫秒 → 帧数换算（48k/128、ScriptProcessor 4096 两种 quantum）；
 *   - Worklet 源码：语法可解析 + 用桩环境真正跑一遍 process()，
 *     验证「同一份状态机源码内联进 worklet」不是一句空话（start/segment 都出得来）。
 *
 * 用法：node test/global-voice.test.mjs
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  VOICE_TEXT_MAX,
  GLOBAL_VAD_PROCESSOR,
  DEFAULT_VAD_OPTIONS,
  createVadState,
  advanceVad,
  normalizeVoiceText,
  limitVoiceText,
  prepareVoiceText,
  normalizeVoicePromptMode,
  vadFramesForMs,
  vadWorkletSource,
  pickSessionId,
  findMainViewSessionId,
  matchWakeWord,
  effectiveShortcut,
} from '../src/client/pure/global-voice.js'

const root = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/* ================================================================ */
console.log('纯函数约束（Node 可原生 import，不碰浏览器 API）')
{
  const raw = fs.readFileSync(root + '/src/client/pure/global-voice.js', 'utf8')
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  check('不依赖 window/document/navigator',
    !/\bwindow\.|\bdocument\.|navigator\./.test(code),
    '纯函数文件要能在 Node 里 import，浏览器 API 由调用方传入')
  check('不依赖 React', !/\bReact\b/.test(code))
}

/* ================================================================ */
console.log('\nVAD 分段状态机')
{
  const opts = { startFrames: 3, silenceFrames: 5, threshold: 0.012 }

  // 1) 静音不开口
  {
    let state = createVadState()
    const events = []
    for (let i = 0; i < 20; i++) {
      const r = advanceVad(state, 0.001, opts)
      state = r.state
      if (r.event) events.push(r.event)
    }
    check('持续静音不产生任何事件', events.length === 0, JSON.stringify(events))
    check('静音时保持不在语音段', state.inSpeech === false)
  }

  // 2) 开口去抖：连续 startFrames 帧超门限才 start（且只 start 一次）
  {
    let state = createVadState()
    const events = []
    const loud = 0.2
    for (let i = 0; i < 2; i++) {
      const r = advanceVad(state, loud, opts)
      state = r.state
      if (r.event) events.push(r.event)
    }
    check('连续 2 帧（< startFrames）还不算开口', events.length === 0)
    const third = advanceVad(state, loud, opts)
    state = third.state
    check('第 3 帧触发 start', third.event === 'start', String(third.event))
    check('start 后进入语音段', state.inSpeech === true)
    const fourth = advanceVad(state, loud, opts)
    check('语音段内不会重复 start', fourth.event !== 'start', String(fourth.event))
  }

  // 3) 短停顿不切段：连续静音 < silenceFrames 时保持语音段
  {
    let state = createVadState()
    let r = advanceVad(state, 0.2, opts)
    state = r.state
    // 跳过 startFrames 剩余帧
    for (let i = 1; i < opts.startFrames; i++) { r = advanceVad(state, 0.2, opts); state = r.state }
    // 4 帧静音（< 5）→ 不结束
    let ended = false
    for (let i = 0; i < opts.silenceFrames - 1; i++) {
      r = advanceVad(state, 0.001, opts)
      state = r.state
      if (r.event === 'end') ended = true
    }
    check('短停顿（< silenceFrames）不结束语音段', ended === false && state.inSpeech === true)
    // 再来 2 帧静音 → 第 5 帧结束
    let endEvent = null
    for (let i = 0; i < 2 && !endEvent; i++) {
      r = advanceVad(state, 0.001, opts)
      state = r.state
      endEvent = r.event
    }
    check('连续静音达到 silenceFrames 触发 end', endEvent === 'end', String(endEvent))
    check('end 后退出语音段', state.inSpeech === false)
    check('end 后静音帧计数归零', state.silentFrames === 0)
  }

  // 4) 完整一轮：start 恰好一次、end 恰好一次
  {
    let state = createVadState()
    const events = []
    const feed = (rms, count) => {
      for (let i = 0; i < count; i++) {
        const r = advanceVad(state, rms, opts)
        state = r.state
        if (r.event) events.push(r.event)
      }
    }
    feed(0.2, 5)          // 开口
    feed(0.001, 10)       // 停顿 → end
    feed(0.001, 10)       // 继续静音
    check('一轮里 start/end 各恰好一次',
      events.filter((e) => e === 'start').length === 1
      && events.filter((e) => e === 'end').length === 1,
      JSON.stringify(events))
  }

  // 5) 状态不可变（纯函数）
  {
    const state = createVadState()
    const snapshot = JSON.parse(JSON.stringify(state))
    advanceVad(state, 0.5, opts)
    check('advanceVad 不修改传入的 state', JSON.stringify(state) === JSON.stringify(snapshot))
  }

  // 6) 自适应门限：持续低噪会让门限上升（但被 maxGate 夹住）
  {
    let state = createVadState()
    const first = advanceVad(state, 0.001, opts)
    state = first.state
    for (let i = 0; i < 200; i++) {
      const r = advanceVad(state, 0.006, opts)
      state = r.state
    }
    const later = advanceVad(state, 0.006, opts)
    check('持续底噪抬高门限', later.gate > first.gate, `${first.gate} → ${later.gate}`)
    check('门限不超过 maxGate', later.gate <= DEFAULT_VAD_OPTIONS.maxGate + 1e-9, String(later.gate))
  }

  // 7) 非法输入不抛错
  {
    const r1 = advanceVad(null, NaN, opts)
    const r2 = advanceVad(createVadState(), 'abc', {})
    check('rms 非数字不抛错、按 0 处理', r1.event === null && r2.event === null)
  }
}

/* ================================================================ */
console.log('\n识别文本归一化与限长')
{
  check('去开头中文标点', normalizeVoiceText('，你好世界') === '你好世界')
  check('去开头英文标点', normalizeVoiceText(' , hello') === 'hello')
  check('压连续空白', normalizeVoiceText('你好   世界\n第二行') === '你好 世界 第二行')
  check('trim', normalizeVoiceText('  你好  ') === '你好')
  check('保留句尾问号（不改语义）', normalizeVoiceText('你好吗？') === '你好吗？')
  check('null → 空串', normalizeVoiceText(null) === '')
  check('只有标点/空白 → 空串', normalizeVoiceText('，。！  ') === '')

  check('VOICE_TEXT_MAX 是 4000（与宿主 /voice-prompt 上限对齐）', VOICE_TEXT_MAX === 4000)
  check('短文本不截断', limitVoiceText('你好') === '你好')
  const long = '啊'.repeat(4500)
  check('超长截断到 4000', Array.from(limitVoiceText(long)).length === 4000)
  check('自定义上限', limitVoiceText('abcdef', 3) === 'abc')
  // 按码点切：直接把 UTF-16 切在代理对中间会产出乱码字符。
  const emoji = '😀'.repeat(10)
  const cut = limitVoiceText(emoji, 3)
  check('按码点截断不切坏 emoji', cut === '😀😀😀' && cut.length === 6, cut)

  check('prepareVoiceText 组合归一化+限长',
    prepareVoiceText(' ，' + '你'.repeat(10) + '  ') === '你'.repeat(10))
  check('prepareVoiceText 空输入 → 空串', prepareVoiceText('   ') === '')

  check('注入模式 queue', normalizeVoicePromptMode('queue') === 'queue')
  check('注入模式 steer 大小写/空白归一化', normalizeVoicePromptMode(' STEER ') === 'steer')
  check('非法注入模式回退 queue', normalizeVoicePromptMode('bogus') === 'queue')
  check('null 注入模式回退 queue', normalizeVoicePromptMode(null) === 'queue')
}

/* ================================================================ */
console.log('\n毫秒 → Worklet/ScriptProcessor 帧数')
{
  check('1500ms @48k/128 = 563 帧', vadFramesForMs(1500, 48000) === 563, String(vadFramesForMs(1500, 48000)))
  check('30s @48k/128 = 11250 帧', vadFramesForMs(30000, 48000) === 11250)
  check('1500ms @48k/4096 = 18 帧（ScriptProcessor 一帧 4096 采样）',
    vadFramesForMs(1500, 48000, 4096) === 18, String(vadFramesForMs(1500, 48000, 4096)))
  check('非法采样率回退 48000', vadFramesForMs(1000, 0) === vadFramesForMs(1000, 48000))
  check('帧数至少 1', vadFramesForMs(0, 48000) === 1)
}

/* ================================================================ */
console.log('\nAudioWorklet 源码（同一份状态机内联）')
{
  const source = vadWorkletSource(GLOBAL_VAD_PROCESSOR)
  check('包含 registerProcessor', source.includes('registerProcessor('))
  check('处理器名正确', source.includes(JSON.stringify(GLOBAL_VAD_PROCESSOR)))
  check('内联了 advanceVad / createVadState', source.includes('function advanceVad(') && source.includes('function createVadState('))
  check('源码语法可解析', (() => {
    try { new Function(source); return true } catch { return false }
  })())

  // 用桩环境真正执行 worklet 源码，驱动 process()，验证分段消息出得来。
  const messages = []
  class FakeAudioWorkletProcessor {
    constructor() {
      this.port = {
        postMessage: (message) => { messages.push(message) },
      }
    }
  }
  let RegisteredClass = null
  const registerProcessor = (name, klass) => {
    if (name === GLOBAL_VAD_PROCESSOR) RegisteredClass = klass
  }
  const factory = new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    source + '\nreturn GlobalVoiceVadProcessor;',
  )
  const ProcessorClass = factory(FakeAudioWorkletProcessor, registerProcessor)
  check('registerProcessor 收到处理器类', typeof RegisteredClass === 'function')
  check('new Function 返回同一个类', ProcessorClass === RegisteredClass)

  const options = {
    ...DEFAULT_VAD_OPTIONS,
    startFrames: 1,
    silenceFrames: 2,
    maxFrames: 100,
  }
  const processor = new ProcessorClass({ processorOptions: options })
  const loud = () => new Float32Array(128).fill(0.4)
  const quiet = () => new Float32Array(128).fill(0.0001)
  // 1 帧开口 → start 消息；再 2 帧静音 → segment 消息。
  processor.process([[loud()]])
  check('开口帧产生 start 消息', messages.some((m) => m.type === 'start'), JSON.stringify(messages.map((m) => m.type)))
  processor.process([[quiet()]])
  check('静音不足 silenceFrames 时还没有 segment 消息',
    !messages.some((m) => m.type === 'segment'))
  processor.process([[quiet()]])
  const segment = messages.find((m) => m.type === 'segment')
  check('达到 silenceFrames 后发出 segment 消息', Boolean(segment))
  check('segment 带 Float32Array 音频', segment?.samples instanceof Float32Array)
  check('segment 含开口帧 + 2 帧静音', segment?.samples?.length === 128 * 3,
    String(segment?.samples?.length))

  // maxFrames 强制切段（长时间连续说话不能无限缓存）
  messages.length = 0
  const processor2 = new ProcessorClass({
    processorOptions: { ...options, startFrames: 1, maxFrames: 2, silenceFrames: 100 },
  })
  processor2.process([[loud()]])
  processor2.process([[loud()]])
  const forced = messages.find((m) => m.type === 'segment')
  check('连续说话达到 maxFrames 强制切段', Boolean(forced) && forced.forced === true)
}

/* ================================================================ */
console.log('\n当前会话解析 pickSessionId（task-8：非对话页也要有目标会话）')
{
  /** 造一个会话行（字段形状与 dsh-api-session-controller 的 projectList 一致）。 */
  const row = (id, extra = {}) => ({ id, displayTitle: id, running: false, blank: false, ...extra })
  const snap = (ids, rows) => ({ ids, byId: rows })
  const mainView = (n = 1) => ({ retainedBy: { mainView: n } })

  // 1) 主视图优先于 lastKnown 与时间戳
  {
    const s = snap(['a', 'b'], {
      a: row('a', { ...mainView(1), updatedAt: 100 }),
      b: row('b', { updatedAt: 999999 }),
    })
    check('主视图优先（即使 lastKnown 指向别的会话）',
      pickSessionId(s, { lastKnown: 'b' }) === 'a')
    check('主视图优先（即使别的会话更新）',
      pickSessionId(s, {}) === 'a')
  }

  // 2) 主视图选择的确定性：ids 顺序 → byId 键顺序
  {
    const both = { a: row('a', mainView()), b: row('b', mainView()) }
    check('多个主视图：按 ids 顺序取第一个',
      pickSessionId(snap(['b', 'a'], both)) === 'b')
    check('没有 ids：按 byId 键顺序取第一个',
      pickSessionId({ byId: both }) === 'a')
    check('主视图用 row.id 而不是 byId 的键',
      pickSessionId({ byId: { k: row('real-id', mainView()) } }) === 'real-id')
  }

  // 3) lastKnown 兜底（存在才用）
  {
    const s = snap(['a', 'b'], {
      a: row('a', { updatedAt: 100 }),
      b: row('b', { updatedAt: 999999 }),
    })
    check('没有主视图时用 lastKnown（即使它不是最近）',
      pickSessionId(s, { lastKnown: 'a' }) === 'a')
    check('陈旧 lastKnown（不在列表里）被忽略，退回最近的会话',
      pickSessionId(s, { lastKnown: 'gone' }) === 'b')
    check('lastKnown 为空串不影响解析',
      pickSessionId(s, { lastKnown: '' }) === 'b')
    check('lastKnown 非字符串被忽略',
      pickSessionId(s, { lastKnown: 42 }) === 'b')
  }

  // 4) 最近会话：lastPromptAt / updatedAt / createdAt / lastActiveAt 取最大
  {
    const s = snap(['a', 'b', 'c'], {
      a: row('a', { updatedAt: 100 }),
      b: row('b', { updatedAt: 200 }),
      c: row('c', { updatedAt: 50 }),
    })
    check('按 updatedAt 取最近', pickSessionId(s) === 'b')

    const nested = snap(['a', 'b'], {
      // 真实形状：投影里的人类提示时间（number）；比旧的 updatedAt 更能代表「最近聊过」。
      a: row('a', {
        updatedAt: 100,
        projectionValues: { sessionListMetadata: { blank: false, lastPromptAt: 5000 } },
      }),
      b: row('b', { updatedAt: 200 }),
    })
    check('projectionValues.sessionListMetadata.lastPromptAt 参与比较',
      pickSessionId(nested) === 'a')
    check('顶层 lastPromptAt 参与比较',
      pickSessionId(snap(['a', 'b'], {
        a: row('a', { lastPromptAt: 7000 }),
        b: row('b', { updatedAt: 200 }),
      })) === 'a')
    check('createdAt 参与比较',
      pickSessionId(snap(['a', 'b'], {
        a: row('a', { createdAt: 8000 }),
        b: row('b', { updatedAt: 200 }),
      })) === 'a')
    check('lastActiveAt 参与比较',
      pickSessionId(snap(['a', 'b'], {
        a: row('a', { lastActiveAt: 9000 }),
        b: row('b', { updatedAt: 200 }),
      })) === 'a')
    check('时间戳并列时按 ids 顺序取第一个（确定性）',
      pickSessionId(snap(['b', 'a'], {
        a: row('a', { updatedAt: 500 }),
        b: row('b', { updatedAt: 500 }),
      })) === 'b')
  }

  // 5) 时间戳类型兼容：ISO 字符串 / 数字字符串
  {
    const s = snap(['a', 'b'], {
      a: row('a', { updatedAt: '2026-01-01T00:00:00.000Z' }),
      b: row('b', { updatedAt: '2025-01-01T00:00:00.000Z' }),
    })
    check('ISO 字符串时间戳可比较（同一年份里新的胜出）',
      pickSessionId(s) === 'a')
    const numeric = snap(['a', 'b'], {
      a: row('a', { updatedAt: '100' }),
      b: row('b', { updatedAt: '200' }),
    })
    check('数字字符串时间戳可比较', pickSessionId(numeric) === 'b')
    const bad = snap(['a', 'b'], {
      a: row('a', { updatedAt: 'not-a-date' }),
      b: row('b', { updatedAt: 5 }),
    })
    check('无法解析的时间戳当成最旧，不抛错', pickSessionId(bad) === 'b')
  }

  // 6) 子代理行不参与「最近」排序
  {
    const s = snap(['sub', 'real'], {
      sub: row('sub', { origin: 'subagent', updatedAt: 999999 }),
      real: row('real', { updatedAt: 100 }),
    })
    check('跳过 origin=subagent 的行', pickSessionId(s) === 'real')
    const onlySub = snap(['sub'], { sub: row('sub', { origin: 'subagent', updatedAt: 1 }) })
    check('只有子代理行时仍返回 ids[0]（不返回空串）',
      pickSessionId(onlySub) === 'sub')
    // fork 出来的用户会话也有 parentId，不能被当成子代理跳过
    const fork = snap(['fork'], {
      fork: row('fork', { parentId: 'source', updatedAt: 1 }),
    })
    check('有 parentId 的用户会话（fork）不被跳过', pickSessionId(fork) === 'fork')
  }

  // 7) ids[0] / 第一个键兜底
  {
    const s = snap(['c', 'b'], {
      c: row('c'),
      b: row('b'),
    })
    check('没有时间戳时按 ids[0] 兜底', pickSessionId(s) === 'c')
    check('ids[0] 不在 byId 里时退到第一个键',
      pickSessionId(snap(['ghost'], { x: row('x') })) === 'x')
    check('ids 不是数组时按 byId 键顺序',
      pickSessionId({ ids: 'nope', byId: { a: row('a'), b: row('b') } }) === 'a')
  }

  // 8) 畸形/空快照：绝不抛错
  {
    for (const [label, value] of [
      ['null', null],
      ['undefined', undefined],
      ['空对象', {}],
      ['byId=null', { byId: null }],
      ['空 byId', { byId: {} }],
      ['byId 是字符串', { byId: 'nope' }],
      ['行是 null', { ids: ['a'], byId: { a: null } }],
      ['行是字符串', { ids: ['a'], byId: { a: 'nope' } }],
    ]) {
      let result = 'THREW'
      try { result = pickSessionId(value) } catch { /* 记为 THREW */ }
      check(`畸形快照（${label}）返回空串且不抛错`, result === '', String(result))
    }
  }

  // 9) findMainViewSessionId（浮层持久化只在「真主视图」时写入用）
  {
    check('findMainViewSessionId 找到主视图',
      findMainViewSessionId(snap(['a'], { a: row('a', mainView()) })) === 'a')
    check('findMainViewSessionId 没有主视图返回空串',
      findMainViewSessionId(snap(['a'], { a: row('a') })) === '')
    check('findMainViewSessionId 畸形快照返回空串',
      findMainViewSessionId(null) === '' && findMainViewSessionId({ byId: {} }) === '')
  }
}

/* ================================================================ */
console.log('\nv3 唤醒词匹配 matchWakeWord')
{
  /** 期望命中：matched=true、rest 正确、via 正确。 */
  const allow = (text, wake, rest, via) => {
    const r = matchWakeWord(text, wake)
    check(`「${text}」唤醒「${wake}」`, r.matched === true && r.rest === rest && r.via === via,
      JSON.stringify(r))
  }
  /** 期望不命中：正文原样返回，via 为空。 */
  const deny = (text, wake) => {
    const r = matchWakeWord(text, wake)
    check(`「${text}」不唤醒「${wake}」`, r.matched === false && r.rest === text && r.via === '',
      JSON.stringify(r))
  }

  // 1) 空唤醒词 = 关闭：不匹配，正文原样交回
  deny('打开设置', '')
  deny('打开设置', '   ')
  check('空唤醒词返回原文本', matchWakeWord('你好 世界', null).rest === '你好 世界')

  // 2) 精确 / 连说命令 / trim
  allow('小D', '小D', '', 'head')
  allow('小D打开设置', '小D', '打开设置', 'head')
  allow('小D 打开设置', '小D', '打开设置', 'head')
  allow('小D   打开设置   ', '小D', '打开设置', 'head')
  allow('小D打开设置', '  小D  ', '打开设置', 'head')

  // 3) 标点（开头/唤醒词后/包裹）
  allow('小D，打开设置', '小D', '打开设置', 'head')
  allow('，小D。打开设置', '小D', '打开设置', 'head')
  allow('小D。', '小D', '', 'head')
  allow('「小D」打开设置', '小D', '打开设置', 'head')

  // 4) 开头语气词
  allow('嗯，小D，打开设置', '小D', '打开设置', 'head')
  allow('呃小D', '小D', '', 'head')
  allow('喂，小D 你好', '小D', '你好', 'head')
  allow('我说小D打开设置', '小D', '打开设置', 'head')

  // 5) 容错 1 字（同音/口音）：**只有 ≥3 字唤醒词才启用**
  //    两字唤醒词（默认「小D」）1 字容错 = 只要求首字对得上 → 误唤醒 + 吞命令首字，
  //    所以两字必须精确匹配（评审 P1-1）。下面三条是评审给出的真实反例。
  deny('小区门口', '小D')
  deny('小张来了', '小D')
  deny('小打开设置', '小D')
  deny('小滴打开设置', '小D') // 两字唤醒词：错一个字也不能唤醒
  // 3 字唤醒词仍保留 1 字容错
  allow('大助手打开设置', '小助手', '打开设置', 'fuzzy') // 错第一个字（1 个字距离）
  allow('助手打开设置', '小助手', '打开设置', 'fuzzy') // 少第一个字
  allow('小助首打开设置', '小助手', '打开设置', 'fuzzy') // 错最后一个字，命令首字不丢
  allow('小小助手打开设置', '小助手', '打开设置', 'fuzzy') // 多一个字
  deny('大助首打开设置', '小助手') // 错两个字

  // 6) 不允许句中匹配（只认开头）
  deny('请打开小D', '小D')
  deny('不要小助手', '小助手')
  deny('abcde小D打开', '小D')

  // 7) 大小写不敏感（英文）
  allow('hey d open settings', 'Hey D', 'open settings', 'head')
  allow('HEY D', 'hey d', '', 'head')

  // 8) 单字唤醒词不启用模糊容错（1 字距离 = 完全不同）
  allow('小D打开', '小', 'D打开', 'head')
  deny('大D打开', '小')

  // 9) 异常输入不抛错
  deny('', '小D')
  check('非字符串文本不抛错', matchWakeWord(null, '小D').matched === false)
  check('超长唤醒词不抛错', matchWakeWord('你好', '唤'.repeat(200)).matched === false)
  check('唤醒词比文本长不匹配', matchWakeWord('小', '小助手').matched === false)
  check('剩余文本去掉前导标点/空白', matchWakeWord('小D，。 打开设置', '小D').rest === '打开设置')
}

/* ================================================================ */
console.log('\n快捷键平台别名 effectiveShortcut（macOS 默认组合）')
{
  check('非 macOS 只接受配置值',
    JSON.stringify(effectiveShortcut('Ctrl+Alt+V', 'Win32')) === JSON.stringify(['Ctrl+Alt+V']))
  check('Linux 只接受配置值',
    JSON.stringify(effectiveShortcut('Ctrl+Alt+V', 'Linux x86_64')) === JSON.stringify(['Ctrl+Alt+V']))
  check('macOS 默认组合额外接受 Meta+Alt+V（Cmd+Alt+V）',
    JSON.stringify(effectiveShortcut('Ctrl+Alt+V', 'MacIntel')) === JSON.stringify(['Ctrl+Alt+V', 'Meta+Alt+V']))
  check('userAgent 含 Mac 也识别',
    JSON.stringify(effectiveShortcut('Ctrl+Alt+V', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'))
      === JSON.stringify(['Ctrl+Alt+V', 'Meta+Alt+V']))
  check('darwin 平台名也识别',
    effectiveShortcut('Ctrl+Alt+V', 'darwin').includes('Meta+Alt+V'))
  check('大小写/空白不影响默认值判定',
    effectiveShortcut(' ctrl+alt+v ', 'MacIntel').includes('Meta+Alt+V'))
  check('自定义组合不做平台翻译（只保留原值）',
    JSON.stringify(effectiveShortcut('Ctrl+Shift+K', 'MacIntel')) === JSON.stringify(['Ctrl+Shift+K']))
  check('非默认组合不追加 Meta 变体',
    !effectiveShortcut('Alt+V', 'MacIntel').includes('Meta+Alt+V'))
  check('空配置返回空数组',
    effectiveShortcut('', 'MacIntel').length === 0 && effectiveShortcut(null, 'MacIntel').length === 0)
  check('返回数组第一个元素始终是原配置',
    effectiveShortcut('Ctrl+Alt+V', 'MacIntel')[0] === 'Ctrl+Alt+V')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
