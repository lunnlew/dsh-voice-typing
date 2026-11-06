/**
 * dsh-voice-typing —— 浏览器侧。
 *
 * 交互：
 *   - **开关式语音模式**：麦克风按钮点一下就开，再点一下（或右键）就关；
 *     全局热键（默认 Alt+V）按一下同样是开/关切换，**不是**按住说话。
 *   - **连续对话**（mode=toggle，默认）：开麦 → 持续聆听 → 静音断句 →
 *     自动发送 → 等回复 → 朗读 → 自动接下一轮。
 *   - **说完就关**（mode=once）：说一段 → 发送 → 朗读 → 自动退出语音模式。
 *
 * 关于回声：toggle 模式下麦克风全程开着（只在退出语音模式时才关），
 * 不靠「朗读时关麦」来避回声，而是靠 echoCancellation + 能量门限，
 * 并且朗读期间你说话会触发打断（barge-in）。
 * once 模式在发送后就关麦，所以朗读时不会录到自己。
 *
 * 音频链路：getUserMedia → AudioContext → 线性重采样到 16k → f32 PCM 上传宿主。
 * 识别在宿主完成（SenseVoice / Whisper / Zipformer2，按设置选择）。
 *
 * 草稿是**三段拼接**的，改这块前务必读懂：
 *   userBase   —— 用户开麦前自己输入的内容，全程保留
 *   committed  —— 已识别完成的各段语音，**累积**，互不覆盖
 *   segment    —— 当前这一段的实时字，会被下一段替换
 * 合成顺序是 userBase + committed + segment。
 * 早先只用一个基准变量，同时表示「用户已有内容」和「本轮语音内容」，
 * 写完第一段就把它清空，于是第二段会把整个草稿覆盖掉 ——
 * 用户手打的内容和第一段的识别结果一起消失。三个变量各管各的，别再合并。
 *
 * 快捷键监听用**捕获阶段**（addEventListener 的第三个参数为 true）：
 * 冒泡阶段的话，输入框的 keydown 处理器一旦 stopPropagation()，
 * 这个监听就收不到事件 —— 表现为「在输入框里按快捷键没反应」。
 *
 * @module dsh-voice-typing/client
 */

import { GLOBAL_OVERLAY_ID, WAKE_ACTIVE_MS, WAKE_HINT_MS } from './pure/voice-constants.js'
import { ROUTE_BASE } from './pure/routes.js'
import { createClientId } from './dom/client-id.js'
import { zh, en } from './pure/i18n.js'
import { createPlaybackCore } from './dom/playback-core.js'
import { createMicDevice } from './dom/mic-device.js'
import { createSessionContext } from './dom/session-context.js'
import {
  createShortcutFocusTracker,
  matchesShortcut,
  shortcutFocus,
  shortcutMatches,
  validateShortcut,
} from './pure/shortcut.js'
import {
  DEFAULT_VAD_OPTIONS,
  GLOBAL_VAD_PROCESSOR,
  VOICE_TEXT_MAX,
  advanceVad,
  createVadState,
  effectiveShortcut,
  findMainViewSessionId,
  inferWakeLanguage,
  limitVoiceText,
  matchWakeWord,
  normalizeVoicePromptMode,
  normalizeVoiceText,
  pickSessionId,
  prepareVoiceText,
  resolveActiveUtterance,
  resolveAsrLanguage,
  resolveWakeLanguage,
  vadFramesForMs,
  vadWorkletSource,
} from './pure/global-voice.js'
import {
  UI_ACTION_LIMITS,
  UI_ACTION_NAMES,
  UI_ACTION_PARAMS,
  UI_ACTION_REQUIRED,
  UI_CONFIRM_ACTIONS,
  actionNeedsConfirm,
  buildUiActionPayload,
  describeUiAction,
  getUiActionSpec,
  isUiActionExpired,
  validateUiAction,
  validateUiActionResult,
} from './pure/ui-action-protocol.js'
import {
  A11Y_REF_PREFIX,
  MAX_SNAPSHOT_ELEMENTS,
  classifyWritableTarget,
  describeInteractiveElement,
  isInteractiveTag,
  isUnsafeClickTarget,
  isWritableInputType,
  normalizeConfirmSpeech,
  parseKeySpec,
} from './pure/a11y.js'
import {
  LANGUAGE_CODES,
  RATE_OPTIONS,
  SOVITS_LANGS,
  STREAM_MODEL_IDS,
  TTS_ENGINES,
  TTS_FORMATS,
  UI_DEFAULTS,
  VOICE_PROMPT_MODES,
  clampAutoSendExtraMs,
  clampReadAloudLag,
  clampSilenceMs,
  collectSaveErrors,
  extractTtsMeta,
  formatEnvEngines,
  formatWordsText,
  normalizeEngine,
  normalizeForSave,
  normalizeIdleReleaseMinutes,
  normalizeLanguage,
  normalizeNumber,
  normalizeSovitsLang,
  normalizeWakeWord,
  parseWordsText,
} from './pure/config-normalize.js'
import { configStore } from './dom/config-store.js'
import { createMicButton } from './dom/mic-button.js'
import { createA11yDomBridge } from './dom/a11y-bridge.js'
import { createGlobalVoiceOverlay } from './dom/global-voice-overlay.js'
import { createVoiceSettingsSection } from './dom/voice-settings-section.js'
/**
 * 浏览器侧模块入口。
 *
 * 宿主契约里 factory 拿到的是它自己的 require，React 只能从那儿来，
 * 所以 require 作参数传进来，而不是在文件顶层 import。
 *
 * @param {(name: string) => any} require - 宿主提供的模块解析（只认 'react'）。
 * @returns {object} 这个插件暴露给宿主的导出面。
 */
export function buildClientModule(require) {
  const module = { exports: {} }
  const exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

  const React = require('react')

  /** 插件命名空间（i18n / slot 注册都用这个名字）。 */
  const NS = 'voice-typing'


  /* ================= 浏览器环境注入对象 ================= */
  /**
   * 浏览器环境注入对象。
   *
   * 组件不再直接访问 window/document/navigator，而是从这个对象获取浏览器 API。
   * 这样做的目的：
   *   1. dom/ 文件可以遵守「不直接访问浏览器全局」的约束；
   *   2. 测试桩环境可以传入 mock 实现，让组件能在 Node.js 里被单独驱动。
   *
   * 注意：这里的成员不是手写清单，而是对真实对象的整对象转发（见 forwardEnv）。
   * 桩环境（测试）里 window/document/navigator 可能不存在，此时退化为 null/undefined。
   */
  /**
   * 组件挂到 window 上的诊断通道（`__DSH_VOICE_DEBUG__` 等）。
   *
   * 这类名字必须直接落在真实 window 上：DevTools 里输入
   * `__DSH_VOICE_DEBUG__()` 看的是当前活着的组件实例，测试也从 window 读它。
   * 包装对象会把赋值截在自己身上，所以凡是以 `__DSH_` 开头的属性，
   * 读、写、删都转发给真实 window。
   */
  const debugChannelPrefix = '__DSH_'

  /**
   * 把真实浏览器对象包成「整对象转发」的注入环境。
   *
   * 为什么不是手写成员清单：第 4 步把组件抽进 dom/ 之后，这里曾是一份只列了
   * 十几个成员的清单。清单漏一个成员，浏览器里就是
   * `Cannot read properties of undefined` —— reading-highlight 的 dispose 读
   * `win.document` 崩掉整个 main.conversation 槽位（2026-11-03 装机实测），
   * 而 Node 侧测试全绿：测试传的是自己的 mock env，根本不走这一份清单。
   * 一份「靠人记得列全」的清单必然再次漏，所以改成转发：**要什么给什么**。
   *
   * 两个必须处理的细节：
   *   1. 函数要绑回真身。`doc.createElement` 拿到手再当普通函数调用，
   *      浏览器里是 Illegal invocation（this 不是 document）。
   *   2. 绑定结果要按名字缓存。每次读都新建一个 bound 函数的话，
   *      同一个事件的两边 `win.addEventListener` / `win.removeEventListener`
   *      拿到的就不是同一个引用，监听器永远解绑不掉。
   *
   * 其余语义与原清单一致：`__DSH_` 读写删都落真实 window；别的赋值落在包装对象
   * 自己身上（不污染全局），读的时候也优先读自己身上这份。
   *
   * @param {object|null} real - 真实 window / document / navigator，桩环境为 null。
   * @returns {object|null} 注入用环境；real 不存在时返回 null，组件内部全部退化不抛错。
   */
  function forwardEnv(real) {
    if (!real) return null
    const bound = new Map()
    return new Proxy(Object.create(null), {
      get(shadow, prop) {
        if (typeof prop !== 'string') return Reflect.get(shadow, prop)
        if (prop.startsWith(debugChannelPrefix)) return real[prop]
        if (Object.prototype.hasOwnProperty.call(shadow, prop)) return shadow[prop]
        const value = real[prop]
        if (typeof value !== 'function') return value
        let fn = bound.get(prop)
        if (!fn) {
          fn = value.bind(real)
          bound.set(prop, fn)
        }
        return fn
      },
      set(shadow, prop, value) {
        if (typeof prop === 'string' && prop.startsWith(debugChannelPrefix)) {
          real[prop] = value
          return true
        }
        return Reflect.set(shadow, prop, value)
      },
      deleteProperty(shadow, prop) {
        if (typeof prop === 'string' && prop.startsWith(debugChannelPrefix)) {
          delete real[prop]
          return true
        }
        return Reflect.deleteProperty(shadow, prop)
      },
    })
  }

  const browserEnv = {
    win: forwardEnv(typeof window !== 'undefined' ? window : null),
    doc: forwardEnv(typeof document !== 'undefined' ? document : null),
    nav: forwardEnv(typeof navigator !== 'undefined' ? navigator : null),
  }

  /* ================= 多窗口去重 / 请求 id ================= */
  const clientIdentity = createClientId({
    getWindow: () => (typeof window !== 'undefined' ? window : null),
    getCrypto: () => (typeof crypto !== 'undefined' ? crypto : null),
    baseUrl: ROUTE_BASE,
  })


  //
  // 这里**不再保留一份配置键清单**。
  //
  // 之前客户端有一份 12 键的 DEFAULT_CONFIG，宿主有 20 键的 DEFAULTS ——
  // 两份清单必然会分叉（加配置项时客户端这边经常漏）。
  // 分叉的后果很具体：/config 拉取失败时，客户端会拿残缺的默认值去跑，
  // 比如 readAloud 的默认值两边不一样，用户改了设置却被默认值覆盖回去。
  //
  // 现在配置清单的**唯一真源在宿主**（GET /config 返回生效配置）。
  // 客户端所有读取点都带 ?? 兜底（例如 silenceMs ?? 1500），
  // 拉取失败时用各处的兜底值即可，不需要一整份重复的清单。
  //

  /* ================= 朗读播放核心（文本 → 音频 + 常驻播放上下文） ================= */

  /**
   * 播放核心的那一份实例。
   *
   * 实现住在 `src/client/dom/playback-core.js`（持有状态、只碰注入进来的环境），
   * 这里只建实例 —— 所以它能被 Node 单测直接驱动（test/playback-core.test.mjs）。
   * 搬动的原因、以及「绝不能强制指定 sampleRate」这条教训的来龙去脉，都写在那文件里。
   *
   * 环境在**建实例时**捕获：产物的 factory 在页面里执行时 window 已就绪；
   * 桩环境（测试里 `def.factory(require)`）没有的就是 null，内部全部退化不抛错。
   * 下面三个包装函数保留的是「和搬出来之前一模一样的全局调用点」（`fetch(url)`、
   * `URL.createObjectURL(blob)`、`extractTtsMeta(headers)`），
   * 而不是把方法从 window 上摘下来传过去 —— 摘下来的 window 方法在部分引擎里会 Illegal invocation。
   */
  const playCore = createPlaybackCore({
    win: typeof window !== 'undefined' ? window : null,
    baseUrl: ROUTE_BASE,
    // 这三个包装函数都是「调用时才取全局」：产物的 factory 执行时 fetch 未必已就位。
    request: (url) => fetch(url),
    toObjectUrl: (blob) => URL.createObjectURL(blob),
    readTtsMeta: (headers) => extractTtsMeta(headers),
  })
  // 首次点击/按键时把播放上下文建好并恢复成 running（浏览器自动播放策略要求手势）。
  playCore.armGestureWarmup()

  /**
   * 开麦设备层的那一份实例（composer 与全局浮层两个录音入口共用）。
   *
   * 实现住在 `src/client/dom/mic-device.js`：能力探测、约束对象、
   * 「拿到流 ≠ 拿得到声音」这条判据、AudioContext 的取法与守卫、轨道释放、上下文关闭。
   * 搬动之前这六件事在两个组件里各写一遍，而且**两份不等价** ——
   * 少的那两条各会带来什么，写在那文件的文件头。
   *
   * `readMediaDevices` 传的是**取值函数**而不是设备接口本身：摘下来的浏览器方法
   * 在部分引擎里会 Illegal invocation（`playCore` 的 `request` / `toObjectUrl` 同一个理由），
   * 顺带让 Node 单测能在同一个实例上切换「设备可用 / 不可用」。
   */
  const micDevice = createMicDevice({
    win: typeof window !== 'undefined' ? window : null,
    readMediaDevices: () => (typeof navigator === 'undefined' ? null : navigator.mediaDevices),
  })

  /**
   * 会话上下文：插件 ctx 的模块级引用 + 上次会话 id 的持久化。
   *
   * 搬之前 main.js 里有三个顶层 `let`（pluginCtx / capturedSessionsService / lastPersistedSessionId）
   * 和三个相关函数（readLastSessionId / persistLastSessionId / clientService），
   * 占了约 90 行，且 `clientService` 在 15+ 处被调用。拆出去之后 main.js 顶层 `let` 从 3 个降到 0 个。
   * 为什么这样判、以及存储注入的设计，都写在 `src/client/dom/session-context.js` 的文件头。
   */
  const sessionContext = createSessionContext({
    readStorage: () => (typeof window !== 'undefined' && window.localStorage ? window.localStorage : null),
    writeStorage: () => (typeof window !== 'undefined' && window.localStorage ? window.localStorage : null),
  })

  /**
   * 采集侧的音频算式（拼 chunks / 归一采样率 / 线性重采样到 16k）。
   *
   * 「客户端把音频变成 16k」是两端之间的契约：宿主那边每一处 `acceptWaveform`
   * 与特征配置都写 16000，而浏览器给的麦克风采样率是设备说了算。
   * 搬之前实现只有一份，但**取采样率那一步手写了三遍**（两处 `?? 16000` 挡不住
   * 0 / NaN，一处自带判断），拼 chunks 也手写了三遍 —— 现在都问这一个文件。
   * 为什么这样判、以及 `resampleTo16k` 在 16k 时**返回同一个数组**这件事，
   * 都写在 `src/client/pure/resample.js` 的文件头。
   */

  /**
   * 快捷键的校验与匹配判据（validateShortcut / matchesShortcut / shortcutMatches）
   * 与「设置面板正在录键」这份状态，实现都在 `src/client/pure/shortcut.js`。
   *
   * 为什么状态做成实例而不是两个模块级 `let`：
   *   composer 的快捷键输入框和全局语音的快捷键输入框是**两套**设置，
   *   但「正在录键时不要触发录音」这条规则要看的是同一份焦点状态 ——
   *   composer 那条监听只看自己那个框（isFocused('composer')），
   *   全局语音那条监听两个框都认（anyFocused()）。
   *   卸载时必须 releaseAll()：面板销毁不保证触发 blur，
   *   标志留在 true 快捷键就永久失效（审计 F14）。
   */
  // shortcutFocus 是 pure/shortcut.js 导出的全局单例（不再在此处定义，
  // 避免被 bundle-sync 的单向引用检查抓到）。

  /**
   * 全局共享的配置存储。
   * 设置面板与麦克风按钮是两个独立组件、各自持一份 config，
   * 保存后不互通就会导致「改了要刷新页面才生效」。这里用共享存储打通。
   */











  /*
   * 全局语音的纯逻辑（VAD 状态机 / 文本归一化 / AudioWorklet 源码生成）。
   * 与宿主侧无关，只被下面的 GlobalVoiceOverlay 使用。
   */

  /*
   * UI 动作协议：算法只有一份，住在 src/shared/ui-action-protocol.js
   * （宿主 lib/ui-action-protocol.js 引的是同一个模块，两端不可能分叉）。
   * 浮层执行模型下发的界面动作前，必须先过这里的校验。
   */

  /*
   * v2 通用 a11y 原语（快照/描述/按键解析/语音确认词，纯逻辑，可 Node 测试）。
   * 浏览器里只做「取元素、打 ref、派发事件」，判定逻辑都在这里。
   */

  /*
   * 配置词表 + 保存前归一化：原先内联在本文件（原 541–937 行），
   * 实测零浏览器全局、零对本文件的回头引用，已抽到 pure/config-normalize.js。
   * 双向副本的漂移由 test/config-contract.test.mjs 横断言拦住。
   */

  /*
   * 朗读高亮覆盖层工厂。原先内联在本文件（原 964–1348 行），
   * 对 pure/highlight.js 的引用已改成显式注入（见调用点），保持单向。
   */

  /**
   * 麦克风按钮 —— 实时对话模式（重写版）。
   *
   * 设计原则：
   *   1. 单一状态：语音模式只有开/关（`on`）。显示由 `on` + `speaking` + `hint` 推导。
   *   2. 麦克风一次打开、只关一次（退出时）。识别、等回复、朗读期间都开着。
   *   3. 所有识别文字一律进输入框（草稿），绝不在按钮旁另设预览。
   *   4. 是否自动发送只看一件事：助手此刻忙不忙。忙 → 文字留在草稿；闲 → 自动发送。
   *   5. 识别在宿主 worker 线程里跑，不阻塞。
   *
   * @param props - slot 注入的会话属性。
   * @returns 按钮与状态。
   */
  const MicButton = createMicButton(React, browserEnv, {
    sessionContext,
    micDevice,
    playCore,
    configStore,
  })

  /* ================= 全局语音浮层（任意页面常驻） ================= */


  /* ================= v2 通用 a11y 界面操作（DOM 侧胶水） ================= */

  /**
   * 浮层的 DOM 桥：可见性判据、ref→元素/描述两张表、事件派发、React 受控输入写入。
   *
   * 实现住在 `src/client/dom/a11y-bridge.js`（有状态、只碰注入进来的环境），
   * 这里只建实例 —— 所以它能被 Node 单测直接驱动（test/a11y-bridge.test.mjs）。
   *
   * 环境在**建实例时**捕获：产物的 factory 在页面里执行时 window/document 已就绪；
   * 桩环境（测试里 `def.factory(require)`）没有的就是 null，桥内部全部退化不抛错。
   */
  const a11yBridge = createA11yDomBridge(
    typeof window !== 'undefined' ? window : null,
    typeof document !== 'undefined' ? document : null,
  )


  /**
   * 全局语音浮层。
   *
   * 职责（契约 §6）：
   *   1. 任意页面常驻的麦克风/状态条（`shell.overlay`，点击穿透的根层上只让卡片可点）；
   *   2. 自己的录音链路：getUserMedia → AudioWorklet VAD（首选，后台不被定时器节流）
   *      → 否则 ScriptProcessor 回退 → POST /transcribe → 文本直接送**当前会话**
   *      （`ctx.sessions.binding(id).session.prompt(...)`，失败回退 POST /voice-prompt）；
   *   3. 全局快捷键（窗口内捕获阶段，阻止浏览器默认行为）；
   *   4. UI 动作执行器：订阅插件自己的 SSE（`ui-action` / `global-hotkey`），
   *      校验、确认、执行、回执，一个都不能少（宿主工具在等回执）。
   *
   * 所有 hooks 必须在条件 return 之前 —— 总开关关闭时只是不渲染可见 UI，
   * 但组件仍然挂载（配置从 false 改成 true 时要立刻生效，不能要求刷新页面）。
   *
   * @param {object} props - slot 注入属性（t/__initialConfig 等）。
   * @returns {any} 浮层元素或隐藏占位。
   */
  const GlobalVoiceOverlay = createGlobalVoiceOverlay(React, browserEnv, {
    sessionContext,
    micDevice,
    a11yBridge,
    clientIdentity,
    configStore,
  })


  const VoiceSettingsSection = createVoiceSettingsSection(React)

  /** 浏览器半侧入口。 */
  function apply(ctx) {
    // 槽位组件拿不到 ctx：全局浮层需要 sessions/uiWorkspace/layout 这些服务，
    // 在这里留存模块级引用（读取时统一走 clientService，失败可降级）。
    sessionContext.setPluginCtx(ctx)
    // 专用 inject 只用来**捕获** sessions 服务（不注册任何东西）：
    // 有的 DSH 版本客户端 ctx 上不直接挂 sessions，只有注入作用域里才有；
    // 解析失败/服务不存在时什么都不发生，绝不影响下面的 slots/locale 注册
    //（exports.inject 保持 ['slots','locale']，缺 sessions 也不能丢麦克风/设置/浮层）。
    try {
      ctx.inject(['sessions'], (scope) => {
        sessionContext.setCapturedSessionsService(scope?.sessions ?? null)
      })
    } catch {
      /* 老版本不支持按服务注入：clientService 还有 ctx 直取 / ctx.get 两条路 */
    }
    ctx.inject(['slots', 'locale'], (scope) => {
      scope.effect(() => {
        try {
          return scope.locale.register(NS, { zh, en })
        } catch (error) {
          if (error instanceof Error && error.message.includes('already has locale')) return () => {}
          throw error
        }
      })
      scope.slots.inject('conversation.input.right', () =>
        scope.slots.register(
          {
            name: 'conversation.input.right',
            id: 'dsh-voice-typing',
            order: 90,
            locale: NS,
          },
          MicButton,
        ),
      )
      scope.slots.inject('settings.section', () =>
        scope.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-voice-typing',
            order: 200,
            // 注意：这里不能用 t('section')。
            // t 是组件内部的局部变量（const t = props.t ?? ...），
            // 在这个模块级作用域里根本不存在 —— 引用它会抛 ReferenceError，
            // 整个设置面板直接白屏。
            label: () => zh.section,
            locale: NS,
          },
          VoiceSettingsSection,
        ),
      )
      // 全局语音浮层：注册在 root/list 的 `shell.overlay`（常驻任意页面、点击穿透）。
      // 用 slots.inject 而不是直接 register：宿主没有这个槽位时（老版本/裁剪版）
      // 静默不注册，绝不能让 apply 抛错 —— 那会把设置面板和麦克风按钮一起弄没。
      scope.slots.inject('shell.overlay', () =>
        scope.slots.register(
          {
            name: 'shell.overlay',
            id: GLOBAL_OVERLAY_ID,
            // 与 composer 麦克风（order 90）错开，浮层排在它之后。
            order: 91,
            locale: NS,
          },
          GlobalVoiceOverlay,
        ),
      )
    })
  }

  exports.apply = apply
  exports.inject = ['slots', 'locale']
  // 纯函数测试入口（Node 侧 test/config-ui.test.mjs 直接调用；浏览器里没有副作用）。
  exports.__test = {
    UI_DEFAULTS,
    TTS_ENGINES,
    LANGUAGE_CODES,
    SOVITS_LANGS,
    RATE_OPTIONS,
    TTS_FORMATS,
    STREAM_MODEL_IDS,
    normalizeEngine,
    normalizeLanguage,
    normalizeSovitsLang,
    normalizeNumber,
    clampAutoSendExtraMs,
    clampSilenceMs,
    clampReadAloudLag,
    normalizeIdleReleaseMinutes,
    parseWordsText,
    formatWordsText,
    normalizeForSave,
    collectSaveErrors,
    extractTtsMeta,
    formatEnvEngines,
    validateShortcut,
    // ---- 全局语音（纯函数 + 常量，test/global-voice.test.mjs 直接调用） ----
    VOICE_PROMPT_MODES,
    GLOBAL_VAD_PROCESSOR,
    VOICE_TEXT_MAX,
    DEFAULT_VAD_OPTIONS,
    createVadState,
    advanceVad,
    normalizeVoiceText,
    limitVoiceText,
    prepareVoiceText,
    normalizeVoicePromptMode,
    vadFramesForMs,
    vadWorkletSource,
    // ---- 快捷键（实现在 src/client/pure/shortcut.js）----
    // test/shortcut.test.mjs 直接 import 那份纯判据；
    // test/client-behavior.test.mjs 的「窗口内快捷键」场景走**真实产物**：
    // 派发 window keydown → 监听 → 焦点屏蔽 → preventDefault。
    matchesShortcut,
    shortcutMatches,
    createShortcutFocusTracker,
    // 两条监听与两个输入框共享的那一份焦点状态。测试要读它，
    // 才能证明「面板卸载后标志复位」而不是「代码里写了 releaseAll」。
    shortcutFocus,
    // ---- 配置共享存储（模块级单例）----
    // 测试跨挂载复位它。生产语义是「刚保存的值优先」
    // （`configRef.current = { ...data, ...configStore.value }`），
    // 所以设置面板存过一份配置之后，它会盖住后续每一次 GET /config 的结果；
    // 场景之间不清空的话，上一个场景存的 `autoSend: false`
    // 会漏进下一个场景，把「自动发送」这类链路整条掐掉。
    configStore,
    // ---- 当前会话解析 / 持久化（task-8；test/global-voice.test.mjs 覆盖） ----
    pickSessionId,
    findMainViewSessionId,
    // ---- UI 动作协议（实现在 src/shared/ui-action-protocol.js；test/ui-action-protocol.test.mjs 驱动） ----
    UI_ACTION_NAMES,
    UI_CONFIRM_ACTIONS,
    UI_ACTION_LIMITS,
    UI_ACTION_PARAMS,
    UI_ACTION_REQUIRED,
    getUiActionSpec,
    actionNeedsConfirm,
    validateUiAction,
    describeUiAction,
    buildUiActionPayload,
    validateUiActionResult,
    // 动作截止时间判断（task-18 ghost action 修复；test/ui-action-protocol.test.mjs 覆盖）。
    isUiActionExpired,
    // ---- v2 通用 a11y 原语（test/a11y.test.mjs 直接调用） ----
    A11Y_REF_PREFIX,
    MAX_SNAPSHOT_ELEMENTS,
    describeInteractiveElement,
    isInteractiveTag,
    parseKeySpec,
    normalizeConfirmSpeech,
    // task-21：ui_type 可写目标白名单 / ui_click 外链与文件选择器判定。
    isWritableInputType,
    classifyWritableTarget,
    isUnsafeClickTarget,
    // ---- v3 唤醒词（纯函数 + 常量，test/global-voice.test.mjs 覆盖） ----
    matchWakeWord,
    resolveActiveUtterance,
    inferWakeLanguage,
    resolveWakeLanguage,
    resolveAsrLanguage,
    normalizeWakeWord,
    WAKE_ACTIVE_MS,
    WAKE_HINT_MS,
    // ---- 快捷键平台别名（macOS 默认组合，test/global-voice.test.mjs 覆盖） ----
    effectiveShortcut,
    // ---- 客户端服务取值（test/client-service-order.test.mjs 覆盖） ----
    // 必须导出：这里曾经因为「先读 ctx[name] 抛错被 catch 吞掉」导致
    // toggle_sidebar/switch_session 一律 unsupported，回归测试要钉住取值顺序。
    clientService: sessionContext.clientService,
    // ---- 开麦设备层那一份实例（test/client-behavior.test.mjs 的开麦场景用） ----
    // 导出实例而不是工厂：场景要核对「两个录音入口拿到的是同一个约束对象」，
    // 只有拿到真实例才证得出来（工厂再 new 一份就 proves nothing）。
    micDevice,
    // ---- 注入给 dom/ 组件的浏览器环境（test/env-forwarding.test.mjs 用） ----
    // 2026-11-03 装机实测崩过一次：这里曾是手写成员清单，漏了 document，
    // reading-highlight 的 dispose 读 win.document 直接把 main.conversation 槽位打崩，
    // 而 Node 测试全绿（测试传的是自己的 mock env）。清单换成整对象转发之后，
    // 「转发是否真的发生」只能从产物内部把这一份 env 拿出来对着假 window 验，
    // 所以它必须导出 —— 否则同类回归照样测不到。
    browserEnv,
  }
  return module.exports
}
