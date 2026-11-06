/**
 * 全局语音浮层组件。
 *
 * 职责（契约 §6）：
 *   1. 任意页面常驻的麦克风/状态条（`shell.overlay`，点击穿透的根上只让卡片可点）；
 *   2. 自己的录音链路：getUserMedia → AudioWorklet VAD（首选，后台不被定时器节流）
 *      → 否则 ScriptProcessor 回退 → POST /transcribe → 文本直接送**当前会话**
 *      （`ctx.sessions.binding(id).session.prompt(...)`，失败回退 POST /voice-prompt）；
 *   3. 全局快捷键（窗口内捕获阶段，阻止浏览器默认行为）；
 *   4. UI 动作执行器：订阅插件自己的 SSE（`ui-action` / `global-hotkey`），
 *      校验、确认、执行、回执，一个都不能少（宿主工具在等回执）。
 *
 * 环境注入：
 *   - 浏览器 API 通过 browserEnv 注入（win/doc/nav）；
 *   - 服务实例通过 serviceEnv 注入（sessionContext/micDevice/a11yBridge/clientIdentity/configStore/timers）。
 *
 * @module dsh-voice-typing/client/dom/global-voice-overlay
 */

// 导入 pure/ 模块的函数和常量
import { parseEnvelope, createTimerRegistry } from '../pure/envelope.js'
import { shortcutMatches, shortcutFocus } from '../pure/shortcut.js'
import { resampleTo16k, normalizeSourceRate, mergeChunks } from '../pure/resample.js'
import { clientPlatform } from '../pure/platform.js'
import {
  createVadState,
  advanceVad,
  prepareVoiceText,
  normalizeVoicePromptMode,
  GLOBAL_VAD_PROCESSOR,
  GLOBAL_CAPTURE_PATHS,
  DEFAULT_VAD_OPTIONS,
  vadFramesForMs,
  vadWorkletSource,
  findMainViewSessionId,
  pickSessionId,
  matchWakeWord,
  resolveActiveUtterance,
  resolveWakeLanguage,
} from '../pure/global-voice.js'
import { actionNeedsConfirm } from '../pure/ui-action-protocol.js'
import {
  describeInteractiveElement,
  parseKeySpec,
  normalizeConfirmSpeech,
  describeConfirmTarget,
  classifyWritableTarget,
  isUnsafeClickTarget,
  MAX_SNAPSHOT_ELEMENTS,
} from '../pure/a11y.js'
import { UI_DEFAULTS } from '../pure/config-normalize.js'
import { ROUTES } from '../pure/routes.js'
import { readSessionSnapshot } from './session-context.js'
import {
  MAX_RECORD_MS,
  GLOBAL_MIC_ON_EVENT,
  GLOBAL_MIC_OFF_EVENT,
  GLOBAL_TOGGLE_EVENT,
  GLOBAL_OVERLAY_ID,
  WAKE_ACTIVE_MS,
  WAKE_HINT_MS,
  CONFIRM_TIMEOUT_MS,
} from '../pure/voice-constants.js'
import {
  GLOBAL_OVERLAY_WRAPPER_STYLE,
  GLOBAL_OVERLAY_CARD_STYLE,
  GLOBAL_OVERLAY_ACTION_STYLE,
} from '../pure/voice-styles.js'
import { validateUiAction, describeUiAction, buildUiActionPayload, isUiActionExpired, validateUiActionResult } from '../pure/ui-action-protocol.js'
import { zhTranslate } from '../pure/i18n.js'

/**
 * 创建全局语音浮层组件。
 *
 * @param {object} R - React 库（{ useState, useCallback, useEffect, useRef, createElement }）。
 * @param {object} browserEnv - 浏览器环境注入对象（win/doc/nav API）。
 * @param {object} serviceEnv - 服务实例注入对象。
 * @returns {function} React 组件函数。
 */
export function createGlobalVoiceOverlay(R, browserEnv, serviceEnv) {
  const { useState, useCallback, useEffect, useRef, createElement: h, Fragment } = R
  const { win, doc, nav } = browserEnv
  const { sessionContext, micDevice, a11yBridge, clientIdentity, configStore } = serviceEnv

    function GlobalVoiceOverlay(props) {
      // 引用必须稳定：任何 effect/SSE 依赖它，裸箭头函数会让 effect 无限重跑。
      const t = useCallback(
        typeof props?.t === 'function' ? props.t : zhTranslate,
        [props?.t],
      )

      // 定时器登记表：浮层里所有跨状态存活的定时器都登记在这里，卸载时全清。
      const timersRef = useRef(null)
      if (!timersRef.current) timersRef.current = createTimerRegistry(win)
      const timers = timersRef.current

      // 配置：共享存储 + 可选的测试注入（__initialConfig 宿主不会传）。
      const [config, setConfig] = useState(() => ({ ...configStore.value, ...(props?.__initialConfig ?? {}) }))
      const configRef = useRef(config)
      // 每次渲染同步 ref：SSE/快捷键回调里要读**最新**配置（改了设置不用刷新页面）。
      configRef.current = config

      /**
       * 当前会话 id（只存 ref，不触发渲染）。
       *
       * 浮层界面不显示会话名，但发送/动作执行都要用它；用 state 会让
       * 切换会话触发一次无意义的整树渲染。
       */
      const sessionIdRef = useRef('')
      /**
       * 持久化的「上次主视图会话」id（localStorage 读入）。
       *
       * 从对话页切到设置页/首页后，retainedBy.mainView 会消失；只要这个 id
       * 还在会话列表里，就应该继续把语音送进这个会话。
       */
      const lastKnownSessionRef = useRef('')
      const aliveRef = useRef(true)

      const [listening, setListening] = useState(false)
      const listeningRef = useRef(false)
      const [starting, setStarting] = useState(false)
      const startingRef = useRef(false)
      const [status, setStatus] = useState('')
      const [statusTone, setStatusTone] = useState('')
      const [lastText, setLastText] = useState('')
      /** 等待用户确认的 UI 动作（null = 没有）。 */
      const [confirmRequest, setConfirmRequest] = useState(null)
      const confirmRequestRef = useRef(null)
      /** 确认条的 Promise resolve（用户点「允许/拒绝」或组件卸载时兑现）。 */
      const confirmResolveRef = useRef(null)
      /**
       * answerConfirm 的 ref 版。
       *
       * transcribeSegment 定义在 answerConfirm 之前（语音识别链路先于 UI 动作
       * 执行器），但语音确认需要在识别回调里调 answerConfirm。直接把它放进
       * useCallback 依赖数组会在渲染时读到 TDZ（answerConfirm 还没初始化）→
       * 整个浮层白屏。用 ref 间接引用：渲染完成后由赋值语句填上。
       */
      const answerConfirmRef = useRef(null)
      const [uiBusy, setUiBusy] = useState(false)
      const uiBusyRef = useRef(false)
      /** 麦克风/音频图（{ctx, stream, source, node, processor, sink}）。 */
      const mediaRef = useRef(null)
      /**
       * 这一次开麦**实际用上**的采集路径与回退原因（批次 10，任务 #38）。
       *
       * 为什么要有：§8.32 那次装机，浮层「聆听中」亮着却一个采样都不进，
       * 根因就住在这两条采集路径里，而当时界面上、控制台里都看不出来是哪条、为什么退的。
       * 值同时进 `__DSH_VOICE_GLOBAL_DEBUG__()` 和宿主 /diagnostics 的 `stats.capture`。
       */
      const captureRef = useRef({ path: '', reason: '', at: 0 })

      /* ---- v3 唤醒词待机状态 ---- */
      /**
       * false = 待机（麦克风开着，但只认唤醒词，其余话丢弃）；
       * true  = 已唤醒（接下来每句话都直接发进会话）。
       */
      const activeRef = useRef(false)
      /** 活跃态到期时间戳；每次说话顺延 WAKE_ACTIVE_MS。 */
      const activeUntilRef = useRef(0)
      /** 上次「待机中」提示时间（WAKE_HINT_MS 节流用）。 */
      const standbyHintAtRef = useRef(0)
      /** awake 的 state 版：状态文字要随待机/活跃切换重新渲染。 */
      const [awake, setAwake] = useState(false)

      /**
       * 设置短提示。tone：'' 普通 / 'ok' / 'error'；clearMs > 0 时自动清空。
       * 所有异步回调都经过它，保证「停在旧状态」不会一直显示。
       */
      const setHint = useCallback((text, tone = '', clearMs = 0) => {
        if (!aliveRef.current) return
        setStatus(String(text ?? ''))
        setStatusTone(String(tone ?? ''))
        if (clearMs > 0) {
          timers.timeout('gv-status', () => {
            if (!aliveRef.current) return
            setStatus('')
            setStatusTone('')
          }, clearMs, 'global-voice')
        }
      }, [timers])

      /** 从宿主拉一次配置。失败返回 false（由调用方决定是否重试）。 */
      const syncConfig = useCallback(async () => {
        try {
          const resp = await fetch(ROUTES.config)
          if (!resp.ok) return false
          const data = await resp.json().catch(() => null)
          if (!data || typeof data !== 'object') return false
          // 合并规则与 MicButton 一致：共享存储里的值更新（用户刚保存），优先。
          const merged = { ...data, ...configStore.value }
          configRef.current = merged
          if (aliveRef.current) setConfig(merged)
          return true
        } catch {
          return false
        }
      }, [])

      // 配置同步：挂载时拉一次（失败重试两次），并订阅共享存储。
      // 少了这一步，浮层会一直用 UI_DEFAULTS（globalVoice=false）——永远不显示。
      useEffect(() => {
        let alive = true
        const pull = async (attempt = 0) => {
          if (!alive) return
          const ok = await syncConfig()
          if (ok || !alive || attempt >= 2) return
          timers.timeout('gv-config-retry', () => { void pull(attempt + 1) }, 800 * (attempt + 1), 'config')
        }
        void pull()
        const unsubscribe = configStore.subscribe((next) => {
          if (!alive || !next) return
          const merged = { ...configRef.current, ...next }
          configRef.current = merged
          setConfig(merged)
        })
        return () => {
          alive = false
          timers.clear('gv-config-retry')
          try { if (typeof unsubscribe === 'function') unsubscribe() } catch { /* 忽略 */ }
        }
      }, [syncConfig, timers])

      // 当前会话跟踪：
      //   1. 优先主视图保留（retainedBy.mainView > 0）；
      //   2. 没有主视图（设置页/首页）时退到持久化的「上次主视图会话」；
      //   3. 再退到最近的会话（时间戳），最后是列表第一项。
      // 过去只看 mainView，于是在设置页启用浮层后永远「没有当前会话」。
      useEffect(() => {
        let alive = true
        let unsubscribe = null
        let attachAttempts = 0

        const applySnapshot = (snapshot) => {
          if (!alive) return
          const state = snapshot && snapshot.byId ? snapshot : readSessionSnapshot(sessionContext.clientService('sessions'))
          const mainViewId = findMainViewSessionId(state)
          if (mainViewId) {
            // 只有真正的主视图会话才写进持久化；fallback 选中的不覆盖，
            // 否则一次临时兜底会污染「上次聊的会话」。
            lastKnownSessionRef.current = mainViewId
            sessionContext.persistLastSessionId(mainViewId)
          }
          const picked = pickSessionId(state, { lastKnown: lastKnownSessionRef.current })
          if (picked) sessionIdRef.current = picked
        }

        // sessions 服务可能比组件晚就绪（注入作用域是异步解析的）：
        // 拿不到就短轮询几次再挂；一直拿不到就降级（发送时会尝试新建会话）。
        const attach = () => {
          if (!alive) return
          const sessionsService = sessionContext.clientService('sessions')
          const list = sessionsService?.list
          if (!list) {
            attachAttempts += 1
            if (attachAttempts <= 10) timers.timeout('gv-session-attach', attach, 500, 'config')
            return
          }
          applySnapshot(readSessionSnapshot(sessionsService))
          if (typeof list.subscribe === 'function') {
            try { unsubscribe = list.subscribe(applySnapshot) } catch { unsubscribe = null }
          }
        }
        // 先恢复持久化的上次会话，保证第一帧快照就能用上。
        if (!lastKnownSessionRef.current) lastKnownSessionRef.current = sessionContext.readLastSessionId()
        attach()
        return () => {
          alive = false
          timers.clear('gv-session-attach')
          try { if (typeof unsubscribe === 'function') unsubscribe() } catch { /* 忽略 */ }
        }
      }, [timers])

      /**
       * 诊断快照：现场问题（例如「一直说没有当前会话」）时在控制台执行
       * `__DSH_VOICE_GLOBAL_DEBUG__()` 就能看到会话解析的全部输入，不用猜。
       * 只含 id/布尔，不含任何对话内容。
       */
      useEffect(() => {
        // 声明放在 try 外面：卸载时要拿它核对「现在挂着的还是不是我」，
        // 留在 try 里就是块级作用域，cleanup 闭包看不见这个变量。
        const debugSnapshot = () => {
          const sessionsService = sessionContext.clientService('sessions')
          const state = readSessionSnapshot(sessionsService)
          return {
            sessionId: sessionIdRef.current || null,
            hasSessionsService: Boolean(sessionsService),
            hasList: Boolean(sessionsService?.list),
            listIds: Array.isArray(state?.ids) ? state.ids.slice(0, 50) : [],
            mainViewId: findMainViewSessionId(state) || null,
            lastKnown: lastKnownSessionRef.current || null,
            globalVoice: configRef.current.globalVoice === true,
            listening: listeningRef.current,
            // 采集路径与回退原因（批次 10，任务 #38）。
            // 这里只有 API 名和错误消息，不含任何音频内容或对话内容。
            capture: { ...captureRef.current },
            // 唤醒状态（批次 13，docs §8.54）：待机/活跃是「这句话要不要送去会话」的开关，
            // 现场排查「喊了不醒」时必须能看见当前处在哪个态、什么时候到期、认的是哪个词。
            // 依旧只含 id/布尔/数字，不含任何识别文本或对话内容。
            wakeWord: String(configRef.current.wakeWord ?? '').trim(),
            awake: activeRef.current,
            awakeUntil: activeUntilRef.current,
          }
        }
        try {
          win.__DSH_VOICE_GLOBAL_DEBUG__ = debugSnapshot
        } catch {
          // 非浏览器桩环境（没有 window）：跳过注册，不影响浮层功能。
        }
        return () => {
          // 只清自己那份：旧实例的 cleanup 可能在新实例注册之后才跑，无脑清会抹掉新快照。
          // 理由同 mic-button.js 里的调试通道那段注释。
          try {
            if (win.__DSH_VOICE_GLOBAL_DEBUG__ === debugSnapshot) win.__DSH_VOICE_GLOBAL_DEBUG__ = undefined
          } catch { /* 忽略 */ }
        }
      }, [])

      /**
       * 一个会话都没有时（首页/设置页首次使用）：新建一个会话作为语音目标。
       *
       * 只从 sendVoiceText 调用，且只在「列表里确实没有会话」时调用 ——
       * 有会话时应该走 fallback 选中，绝不能每说一句都新建。
       *
       * @returns {Promise<string>} 新会话 id；失败返回空串（调用方提示没有会话）。
       */
      const createSessionForVoice = useCallback(async () => {
        const sessionsService = sessionContext.clientService('sessions')
        if (!sessionsService || typeof sessionsService.create !== 'function') return ''
        setHint(t('globalCreatingSession'))
        let createdId = ''
        try {
          const created = await sessionsService.create({})
          // 不同版本返回形状不同：id 字符串 / {sessionId} / {id} 都兼容。
          createdId = typeof created === 'string'
            ? created
            : String(created?.sessionId ?? created?.id ?? '')
        } catch {
          return ''
        }
        if (!createdId) return ''
        sessionIdRef.current = createdId
        try {
          const workspace = sessionContext.clientService('uiWorkspace')
          if (typeof workspace?.openSession === 'function') await workspace.openSession(createdId)
        } catch {
          // 新建成功但打开视图失败：会话本身已经可用（binding/回退注入都不依赖视图），
          // 不因此丢掉这句话；下一帧列表快照会重新解析出它。
        }
        return createdId
      }, [t, setHint])

      /**
       * 把一次「语音 → 会话」的尝试上报给宿主（只进 /diagnostics，不改变行为）。
       *
       * 为什么需要：浮层发送失败时用户只看到一句「发送失败」，
       * 而宿主 /diagnostics 里原先只有 /voice-prompt 回退路径的计数 ——
       * 直发 `session.prompt` 失败时什么痕迹都没有，排查只能靠猜。
       * 这里复用已有的 /voice-session 心跳通道（客户端→宿主，无副作用）。
       *
       * **「无副作用」要靠不发那个键来保证**（批次 13，docs §8.54）：
       * 宿主看见请求体里有自有属性 `sessionId` 就把 `voiceSession` 改成它，空串等于清空。
       * 清空了就只剩坏处：`/diagnostics` 顶层那一项答不出「哪句话对着哪个会话」
       * （待机时每句闲聊都会走到这里上报），而批次 13 当初要防的正是用一句环境闲聊替用户清掉指针。
       * （那时候还有第二个读处 —— `GET /latest-message` 在调用方没带 sessionId 时拿它当回退目标，
       * 会话不唯一时清空了就直接 400。那条路由是客户端早已不调的死链，批次 17 退役了它，
       * 见 docs §8.59；上面这条理由不依赖它。）
       * 所以只有**真的拿着会话 id 要登记**的调用才带这个键（发送尝试那几条传的是 targetId）。
       *
       * @param {object} info - { sessionId?, via, mode, ok, error }；`sessionId` 为空/缺省时整个键都不发。
       */
      const reportVoiceAttempt = useCallback((info) => {
        const sessionId = String(info?.sessionId ?? '')
        const client = { kind: 'global-voice', ...info, at: Date.now() }
        try {
          void fetch(ROUTES.voiceSession, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(sessionId ? { sessionId, client } : { client }),
          }).catch(() => { /* 诊断上报失败不影响发送 */ })
        } catch {
          /* 非浏览器桩环境（没有 fetch）：跳过 */
        }
      }, [])

      /**
       * 把这一次开麦**实际用上**的采集路径上报给宿主（批次 10，任务 #38）。
       *
       * 走的是 `reportVoiceAttempt` 同一条 /voice-session 通道，但**故意不带 sessionId 键**：
       * 宿主只在请求体里存在这个自有属性时才动 `voiceSession`，
       * 带空串会把当前会话清掉 —— 采集路径是纯诊断，绝不能改行为。
       *
       * @param {{path: string, reason: string}} info - 见 `GLOBAL_CAPTURE_PATHS`。
       */
      const recordCapture = useCallback((info) => {
        captureRef.current = {
          path: String(info?.path ?? ''),
          reason: String(info?.reason ?? ''),
          at: Date.now(),
        }
        try {
          void fetch(ROUTES.voiceSession, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              client: { kind: 'capture-path', path: captureRef.current.path, reason: captureRef.current.reason, at: captureRef.current.at },
            }),
          }).catch(() => { /* 诊断上报失败不影响采集 */ })
        } catch {
          /* 非浏览器桩环境（没有 fetch）：跳过 */
        }
      }, [])

      /**
       * 发送成功后的提示。
       *
       * 助手正在生成时，`queue` 模式只是把话排进下一轮 —— 用户看不到任何变化，
       * 很容易以为「说了没反应」。这里按会话列表里的 running 标记给不同提示，
       * 让「已排队」和「已发送」可区分。
       *
       * @param {string} targetId - 目标会话 id。
       */
      const announceSent = useCallback((targetId) => {
        let running = false
        try {
          const state = readSessionSnapshot(sessionContext.clientService('sessions'))
          running = state?.byId?.[targetId]?.running === true
        } catch {
          /* 拿不到快照就当未在生成 */
        }
        if (running) setHint(t('globalQueued'), 'ok', 3000)
        else setHint(t('globalSent'), 'ok', 1500)
      }, [t, setHint])

      const sendVoiceText = useCallback(async (text) => {
        let targetId = sessionIdRef.current
        if (!targetId) {
          // 列表完全为空（或 sessions 服务尚未就绪）：自动建一个会话。
          // 失败就提示「没有当前会话」，不无限重试。
          targetId = await createSessionForVoice()
          if (!targetId) {
            setHint(t('globalNoSession'), 'error', 2500)
            reportVoiceAttempt({ sessionId: '', via: 'none', ok: false, error: 'no_session' })
            return false
          }
        }
        const mode = normalizeVoicePromptMode(configRef.current.voicePromptMode)
        // 每条识别文本一个稳定 requestId：直发（session.prompt 第 4 参）与
        // /voice-prompt 回退共用它，宿主据此去重 —— 同一条话在重试/回退时
        // 不会重复注入（评审 P3：客户端以前完全不传 requestId）。
        // id 生成器由 clientIdentity 注入（它才知道 crypto 怎么用、怎么退化）；
        // 这里曾经裸调 generateId —— 那是 main.js 时代的局部函数，
        // 换真 ESM 之后作用域变实，一调用就 ReferenceError。
        const requestId = clientIdentity.generateId('req')
        setHint(t('globalSending'))
        /** 直发失败的原因（透传到 /diagnostics，方便定位）。 */
        let directError = ''
        try {
          const sessionsService = sessionContext.clientService('sessions')
          const binding = sessionsService?.binding?.(targetId)
          const session = binding?.session
          if (session && typeof session.prompt === 'function') {
            // 返回 undefined 表示老版本没给结果；只有明确 ok===false 才当失败。
            // 第 4 参 requestId 用于宿主去重（部分版本忽略未知参数，无害）。
            const result = await session.prompt([{ type: 'text', text }], mode, undefined, requestId)
            if (result === undefined || result === null || result.ok !== false) {
              announceSent(targetId)
              reportVoiceAttempt({ sessionId: targetId, via: 'session.prompt', mode, ok: true })
              return true
            }
            directError = String(result?.error?.code ?? result?.error?.message ?? 'prompt_rejected')
          } else {
            directError = 'no_binding'
          }
        } catch (error) {
          // 直发失败 → 走宿主回退路径（原因留给诊断）
          directError = error instanceof Error ? error.message : String(error)
        }
        try {
          const resp = await fetch(ROUTES.voicePrompt, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // requestId 与直发路径相同：宿主可用它做幂等去重（重试不重复注入）。
            body: JSON.stringify({ sessionId: targetId, text, mode, requestId }),
          })
          const data = await resp.json().catch(() => null)
          if (resp.ok && data?.ok !== false) {
            announceSent(targetId)
            reportVoiceAttempt({ sessionId: targetId, via: 'host', mode, ok: true, error: directError })
            return true
          }
          const hostError = data?.error?.message ?? data?.error?.code ?? `http_${resp.status}`
          reportVoiceAttempt({ sessionId: targetId, via: 'host', mode, ok: false, error: `direct:${directError}; host:${hostError}` })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          reportVoiceAttempt({ sessionId: targetId, via: 'host', mode, ok: false, error: `direct:${directError}; host:${message}` })
        }
        setHint(t('globalSendFailed'), 'error', 3000)
        return false
      }, [t, setHint, createSessionForVoice, reportVoiceAttempt, announceSent])

      /**
       * 把一段 16k 单声道音频交给宿主识别，成功则直接送进会话。
       * 识别请求失败会提示（不能静默）；识别出空文本按「没听清」处理。
       *
       * @param {Float32Array} samples - 原始采样（任意采样率）。
       * @param {number} sampleRate - 原始采样率。
       */
      const transcribeSegment = useCallback(async (samples, sampleRate) => {
        if (!samples || !samples.length) return
        // 统一重采样到 16k：宿主 /transcribe 只认 16k 单声道 f32。
        // 采样率兜底走 normalizeSourceRate（以前这里手写了「>0 才用」的判断，
        // 而另外两处只写了 `?? 16000`，挡不住 0 和 NaN —— 现在三处同一个判据）。
        const pcm = resampleTo16k(samples, normalizeSourceRate(sampleRate))
        if (!pcm.length) return
        setHint(t('globalTranscribing'))
        try {
          // 待机唤醒识别需要显式语言提示：短唤醒词（如「小鱼」）在 auto 下容易被
          // SenseVoice 判成英文（实测识别成「I.」），导致永远唤不醒。
          // 语言优先级：显式配置 > 唤醒词脚本 > 系统语言（resolveWakeLanguage）。
          // **只覆盖待机**这一种请求；进入活跃态后的对话不带这个头，由宿主按
          // 配置（auto = 系统默认语言）识别，双语/混合语种用户的行为保持不变。
          const wakeWordNow = String(configRef.current.wakeWord ?? '').trim()
          const standbyWake = Boolean(wakeWordNow) && !activeRef.current
          const systemLocale = typeof navigator !== 'undefined' ? nav.language : ''
          const wakeLanguage = standbyWake
            ? resolveWakeLanguage(configRef.current.language, wakeWordNow, systemLocale)
            : 'auto'
          const transcribeHeaders = { 'content-type': 'application/octet-stream' }
          if (standbyWake && wakeLanguage && wakeLanguage !== 'auto') {
            transcribeHeaders['x-dsh-voice-language'] = wakeLanguage
          }
          const resp = await fetch(ROUTES.transcribe, {
            method: 'POST',
            headers: transcribeHeaders,
            body: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
          })
          const data = await resp.json().catch(() => null)
          if (!resp.ok) {
            setHint(t('globalRecognizeFailed'), 'error', 2500)
            return
          }
          const text = prepareVoiceText(data?.text)
          if (!text) {
            // 宿主的 speech 标记是「确实有人说话」；说了没识别出来要提示，
            // 纯静音（环境噪声）则静默，不然每次呼吸都弹一次「没听清」。
            if (data?.speech === true) setHint(t('empty'), 'error', 2000)
            return
          }
          if (!aliveRef.current) return
          // v2 语音确认：确认条挂着时说「允许 / 拒绝」等价于点按钮。
          // 这句话只用于回答确认，**不能**再当聊天内容发出去 —— 否则用户
          // 为了放行一个界面动作，顺手往会话里塞了一条多余消息。
          // 不是确认词则照旧发送（确认条继续等，不打扰正常对话）。
          if (confirmRequestRef.current) {
            const decision = normalizeConfirmSpeech(text)
            if (decision === 'allow' || decision === 'deny') {
              answerConfirmRef.current?.(decision === 'allow')
              setLastText(text)
              setHint(
                decision === 'allow' ? t('globalConfirmAllowed') : t('globalConfirmDenied'),
                decision === 'allow' ? 'ok' : '',
                2000,
              )
              return
            }
          }
          // v3 唤醒词待机：确认条拦截**优先于**唤醒词（用户回答确认时不需要先喊唤醒词），
          // 之后才按待机/活跃两态处理这句话。
          const wakeWord = String(configRef.current.wakeWord ?? '').trim()
          if (wakeWord) {
            const now = Date.now()
            // 活跃态超时（WAKE_ACTIVE_MS 没说话）→ 回待机；然后按待机逻辑处理本句。
            if (activeRef.current && now > activeUntilRef.current) {
              activeRef.current = false
              if (aliveRef.current) setAwake(false)
            }
            /** 唤醒/续期：顺延到期时间，并重排「回待机」定时器。 */
            const armActive = () => {
              activeUntilRef.current = now + WAKE_ACTIVE_MS
              timers.timeout('gv-wake-idle', () => {
                if (!activeRef.current) return
                // 定时器排队期间用户又说了话并顺延了到期时间：让下一轮再判。
                if (Date.now() < activeUntilRef.current) return
                activeRef.current = false
                activeUntilRef.current = 0
                if (aliveRef.current) setAwake(false)
              }, WAKE_ACTIVE_MS, 'global-voice')
            }
            if (!activeRef.current) {
              // 待机：只认唤醒词。非唤醒内容一律丢弃 ——
              // 这是隐私边界（不把环境闲聊送进会话），也避免噪声触发误操作。
              const matched = matchWakeWord(text, wakeWord)
              if (!matched.matched) {
                // 先清掉「识别中…」这个临时提示：它不是状态，留着会让浮层
                // 一直显示识别中（直到 30 秒节流窗口过去），看不到待机状态。
                setHint('', '', 0)
                // 上报「待机时听到但没匹配唤醒词」的文本到宿主诊断：
                // 用户反馈「喊了不醒」时，这是唯一能看到 ASR 到底识别成什么的方式
                //（内容只进 /diagnostics.stats.client，不会发送到会话）。
                // 注意：不要带 sessionId（空串会把宿主的 voiceSession 清空）。
                reportVoiceAttempt({
                  via: 'wake-miss',
                  ok: false,
                  error: 'wake_miss',
                  text: String(text ?? '').slice(0, 60),
                })
                // 静默丢弃，但提示最多每 WAKE_HINT_MS 一次；
                // 带上「听到的文本」让用户能立刻发现是识别错字（如「小D」→「小弟」）。
                if (now - standbyHintAtRef.current >= WAKE_HINT_MS) {
                  standbyHintAtRef.current = now
                  const heard = String(text ?? '').slice(0, 20)
                  setHint(
                    heard
                      ? t('globalWakeMiss', { text: heard })
                      : t('globalWakeStandbyHint', { word: wakeWord }),
                    '',
                    2500,
                  )
                }
                return
              }
              activeRef.current = true
              if (aliveRef.current) setAwake(true)
              armActive()
              const rest = matched.rest
              if (!rest) {
                // 只喊了唤醒词：提示接着说命令（活跃态保留 WAKE_ACTIVE_MS）。
                setHint(t('globalWakeListening'), 'ok', 2500)
                return
              }
              // 「唤醒词 + 命令连说」只发命令部分，不要把唤醒词也送进会话。
              setLastText(rest)
              await sendVoiceText(rest)
              return
            }
            // 已唤醒：普通对话直接发送，并顺延活跃时间。
            // 但唤醒词不能进会话消息：只喊唤醒词 → 忽略；唤醒词+命令 → 只发命令。
            armActive()
            const activeUtterance = resolveActiveUtterance(text, wakeWord)
            if (activeUtterance.action === 'wake-only') {
              setHint(t('globalWakeListening'), 'ok', 2000)
              return
            }
            setLastText(activeUtterance.text)
            await sendVoiceText(activeUtterance.text)
            return
          }
          setLastText(text)
          await sendVoiceText(text)
        } catch {
          setHint(t('globalRecognizeFailed'), 'error', 2500)
        }
      }, [t, setHint, sendVoiceText, timers])

      /** VAD 切出一段音频后的统一入口（Worklet 与 ScriptProcessor 两条路共用）。 */
      const onSegment = useCallback((samples, sampleRate) => {
        void transcribeSegment(samples, sampleRate)
      }, [transcribeSegment])

      /**
       * 首选路径：AudioWorklet VAD。
       *
       * 为什么优先它：窗口隐藏/最小化时 Chromium 会把主线程定时器节流到 1 次/秒，
       * 基于 setInterval 的 VAD 在后台等于失效。AudioWorklet 在音频线程里持续
       * 跑 process()，不受定时器节流影响；分段结果通过 port.postMessage 回主线程。
       *
       * @param {object} media - 音频图容器。
       * @param {MediaStreamAudioSourceNode} source - 麦克风源节点。
       * @returns {Promise<{ok: boolean, reason: string}>} 成功 `{ok:true, reason:''}`；
       *   失败时 `reason` 是**给用户以外的人看的那句话**（为什么没能走首选路径），
       *   它会随采集路径一起上报到宿主 /diagnostics（批次 10，任务 #38）。
       *   原先这两处 `catch { return false }` 把错吞了，回退原因装机上查不到。
       */
      const startWorkletVad = useCallback(async (media, source) => {
        const ctx = media?.ctx
        if (!ctx || !ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') {
          return { ok: false, reason: 'audioWorklet.addModule 不可用' }
        }
        if (typeof AudioWorkletNode !== 'function') {
          return { ok: false, reason: 'AudioWorkletNode 全局不存在' }
        }
        let url = ''
        try {
          // Worklet 不能 import 模块：把同一份 VAD 状态机源码整段注入。
          url = URL.createObjectURL(new Blob([vadWorkletSource(GLOBAL_VAD_PROCESSOR)], { type: 'application/javascript' }))
          await ctx.audioWorklet.addModule(url)
          const silenceMs = Number(configRef.current.silenceMs) > 0 ? Number(configRef.current.silenceMs) : 1500
          const node = new AudioWorkletNode(ctx, GLOBAL_VAD_PROCESSOR, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1,
            processorOptions: {
              ...DEFAULT_VAD_OPTIONS,
              // 毫秒 → 帧数在**主线程**换算一次：worklet 只知道采样率。
              silenceFrames: vadFramesForMs(silenceMs, ctx.sampleRate),
              maxFrames: vadFramesForMs(MAX_RECORD_MS, ctx.sampleRate),
              preRollFrames: vadFramesForMs(DEFAULT_VAD_OPTIONS.preRollMs, ctx.sampleRate),
            },
          })
          media.node = node
          node.port.onmessage = (event) => {
            const data = event?.data
            if (!data || typeof data !== 'object') return
            if (data.type === 'segment' && data.samples instanceof Float32Array) {
              onSegment(data.samples, ctx.sampleRate)
            }
          }
          source.connect(node)
          // 必须把节点接到 destination（哪怕经过 0 增益），否则部分 Chromium
          // 版本会认为输出没有被消费而不再调度 process()。
          const sink = ctx.createGain()
          sink.gain.value = 0
          node.connect(sink)
          sink.connect(ctx.destination)
          media.sink = sink
          return { ok: true, reason: '' }
        } catch (error) {
          // 把真实原因留下：Blob 被 CSP 拦、处理器名没注册上、上下文已关闭，
          // 这三种在界面上长得一模一样（都退回 ScriptProcessor），排查时必须分得开。
          return { ok: false, reason: `worklet 启动失败：${String(error?.message ?? error)}` }
        } finally {
          // addModule 读完后 Blob URL 就可以释放（不释放会一直占着这个脚本）。
          try { if (url) URL.revokeObjectURL(url) } catch { /* 忽略 */ }
        }
      }, [onSegment])

      /**
       * 回退路径：ScriptProcessor + 主线程 VAD。
       *
       * 旧内核/Blob 被 CSP 拦截时 AudioWorklet 不可用。这条路径在窗口可见时
       * 工作正常；窗口隐藏时主线程回调同样可能被节流 —— 这是回退的已知代价，
       * 设置面板的说明里已注明后台可靠性有限。
       *
       * @param {object} media - 音频图容器。
       * @param {MediaStreamAudioSourceNode} source - 麦克风源节点。
       * @returns {{ok: boolean, reason: string}} 是否搭起来；失败时 reason 说明为什么。
       */
      const startScriptProcessorVad = useCallback((media, source) => {
        const ctx = media?.ctx
        if (!ctx || typeof ctx.createScriptProcessor !== 'function') {
          return { ok: false, reason: 'createScriptProcessor 不可用' }
        }
        try {
          const processor = ctx.createScriptProcessor(4096, 1, 1)
          const stateRef = { current: createVadState() }
          const pre = []
          const segment = []
          let segmentFrames = 0
          const silenceMs = Number(configRef.current.silenceMs) > 0 ? Number(configRef.current.silenceMs) : 1500
          const options = {
            ...DEFAULT_VAD_OPTIONS,
            // ScriptProcessor 一帧 4096 采样，换算帧数时要带上 quantum，
            // 否则静音判据会短 30 倍（一帧 85ms 却按 2.7ms 算）。
            silenceFrames: vadFramesForMs(silenceMs, ctx.sampleRate, 4096),
            maxFrames: vadFramesForMs(MAX_RECORD_MS, ctx.sampleRate, 4096),
            preRollFrames: vadFramesForMs(DEFAULT_VAD_OPTIONS.preRollMs, ctx.sampleRate, 4096),
          }
          const emit = () => {
            if (!segment.length) return
            const samples = mergeChunks(segment)
            segment.length = 0
            segmentFrames = 0
            onSegment(samples, ctx.sampleRate)
          }
          processor.onaudioprocess = (event) => {
            if (!mediaRef.current || mediaRef.current.processor !== processor) return
            const input = event?.inputBuffer?.getChannelData?.(0)
            if (!input) return
            let sum = 0
            for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
            const rms = Math.sqrt(sum / input.length)
            const result = advanceVad(stateRef.current, rms, options)
            stateRef.current = result.state
            const frame = new Float32Array(input)
            if (result.event === 'start') {
              segment.push(...pre)
              pre.length = 0
              segment.push(frame)
              segmentFrames = segment.length
              return
            }
            if (result.event === 'end') {
              if (segment.length) segment.push(frame)
              emit()
              return
            }
            if (result.state.inSpeech) {
              segment.push(frame)
              segmentFrames += 1
              if (segmentFrames >= options.maxFrames) emit()
              return
            }
            pre.push(frame)
            // 预录环上界用 preRollFrames（按毫秒算），不是 startFrames：
            // 开口判定滞后半秒级，按 startFrames 留帧等于没留（见 pure/global-voice.js）。
            while (pre.length > options.preRollFrames) pre.shift()
          }
          media.processor = processor
          source.connect(processor)
          const sink = ctx.createGain()
          sink.gain.value = 0
          processor.connect(sink)
          sink.connect(ctx.destination)
          media.sink = sink
          return { ok: true, reason: '' }
        } catch (error) {
          // 同样不吞错：bufferSize 非法、上下文已关闭都在这里冒出来。
          return { ok: false, reason: `ScriptProcessor 启动失败：${String(error?.message ?? error)}` }
        }
      }, [onSegment])

      /**
       * 停止聆听并释放麦克风/音频图。
       * 不碰朗读（朗读归 composer 那套链路），只关自己的采集。
       */
      const stopListening = useCallback(() => {
        const media = mediaRef.current
        mediaRef.current = null
        if (media) {
          try { if (media.processor) media.processor.onaudioprocess = null } catch { /* 忽略 */ }
          try {
            if (media.node) {
              media.node.port.onmessage = null
              media.node.disconnect()
            }
          } catch { /* 忽略 */ }
          try { media.source?.disconnect?.() } catch { /* 忽略 */ }
          try { media.sink?.disconnect?.() } catch { /* 忽略 */ }
          micDevice.closeAudioContext(media.ctx)
          micDevice.releaseStream(media.stream)
        }
        listeningRef.current = false
        startingRef.current = false
        // 关麦 = 回待机：再开麦时重新从待机开始（有唤醒词时必须先喊唤醒词）。
        activeRef.current = false
        activeUntilRef.current = 0
        standbyHintAtRef.current = 0
        timers.clearGroup('global-voice')
        if (aliveRef.current) {
          setListening(false)
          setStarting(false)
          setAwake(false)
          setStatus('')
          setStatusTone('')
        }
        // 通知对方「全局麦已关」：composer 侧据此恢复自己的按钮状态语义。
        try { win.dispatchEvent(new CustomEvent(GLOBAL_MIC_OFF_EVENT)) } catch { /* 测试桩环境 */ }
      }, [timers])

      /**
       * 开始聆听：先让 composer 麦克风让位 → 打开麦克风 → AudioWorklet VAD
       * （失败回退 ScriptProcessor）。任何一步失败都复位开关并提示原因。
       */
      const startListening = useCallback(async () => {
        if (listeningRef.current || startingRef.current) return
        if (!micDevice.supportsCapture()) {
          setHint(t('micUnsupported'), 'error', 2500)
          return
        }
        // 先通知 composer 麦克风让位：两个引擎同时开麦会重复识别、重复发送。
        try { win.dispatchEvent(new CustomEvent(GLOBAL_MIC_ON_EVENT)) } catch { /* 测试桩环境 */ }
        startingRef.current = true
        setStarting(true)
        setHint(t('micStarting'))
        let stream
        try {
          // 约束对象与 composer 那条链路是同一份（dom/mic-device.js）。
          stream = await micDevice.requestStream()
        } catch {
          startingRef.current = false
          if (aliveRef.current) setStarting(false)
          setHint(t('micDenied'), 'error', 2500)
          try { win.dispatchEvent(new CustomEvent(GLOBAL_MIC_OFF_EVENT)) } catch { /* 忽略 */ }
          return
        }
        // 打开期间用户可能已经点了一次「关闭」：把刚拿到的轨道释放掉。
        if (!aliveRef.current || !startingRef.current) {
          micDevice.releaseStream(stream)
          return
        }
        // getUserMedia 成功**不等于**有可用的音频输入：设备可能已被拔掉、被别的程序
        // 独占，或者系统只给了一个空轨道 / 已结束（ended）的轨道。判据与 composer 一致
        //（dom/mic-device.js 的 liveAudioTrack）。不检查就建音频图会显示「聆听中」但采不到声音。
        if (!micDevice.liveAudioTrack(stream)) {
          micDevice.releaseStream(stream)
          startingRef.current = false
          if (aliveRef.current) setStarting(false)
          setHint(t('micFailed'), 'error', 2500)
          try { win.dispatchEvent(new CustomEvent(GLOBAL_MIC_OFF_EVENT)) } catch { /* 忽略 */ }
          return
        }
        let ctx
        try {
          ctx = micDevice.createAudioContext()
          // 用户手势里 resume，避免上下文 suspended 导致 process 不跑。
          await micDevice.resumeContext(ctx)
        } catch {
          micDevice.releaseStream(stream)
          startingRef.current = false
          if (aliveRef.current) setStarting(false)
          setHint(t('micFailed'), 'error', 2500)
          try { win.dispatchEvent(new CustomEvent(GLOBAL_MIC_OFF_EVENT)) } catch { /* 忽略 */ }
          return
        }
        const media = { ctx, stream, source: null, node: null, processor: null, sink: null }
        mediaRef.current = media
        try {
          media.source = ctx.createMediaStreamSource(stream)
          const worklet = await startWorkletVad(media, media.source)
          // 回退路径的返回值也要看。
          // 之前这里写完 `if (!workletOk) startScriptProcessorVad(...)` 就往下走，
          // 两条都没搭起音频图时照样进「聆听中」—— 麦克风开着、一个采样都不进，
          // 用户看到「聆听中」说半天没反应。浮层漏 import `DEFAULT_VAD_OPTIONS`
          // 那段日子就是这个现象（两条路径都在自己的 try 里抛、都 return false），
          // 而界面上看不出来，见 docs/architecture-modernization.md §8.32。
          const scriptProcessor = worklet.ok ? null : startScriptProcessorVad(media, media.source)
          // 三条腿都要有名字和原因（批次 10，任务 #38）：
          // worklet 成了 → 记 worklet；
          // worklet 退了、ScriptProcessor 顶上 → 记 scriptProcessor，并把 worklet 为什么退一起带上；
          // 两条都没搭起来 → 记 none + 两条的原因，再抛错（绝不带着空音频图进「聆听中」）。
          const capture = worklet.ok
            ? { path: GLOBAL_CAPTURE_PATHS.worklet, reason: '' }
            : scriptProcessor?.ok
              ? { path: GLOBAL_CAPTURE_PATHS.scriptProcessor, reason: worklet.reason }
              : {
                path: GLOBAL_CAPTURE_PATHS.none,
                reason: `worklet: ${worklet.reason} / scriptProcessor: ${String(scriptProcessor?.reason ?? '')}`,
              }
          recordCapture(capture)
          if (capture.path === GLOBAL_CAPTURE_PATHS.none) throw new Error(`no capture graph (${capture.reason})`)
          if (!aliveRef.current || !startingRef.current) {
            // 启动期间被关闭（或被卸载）：收掉刚搭好的音频图。
            stopListening()
            return
          }
          listeningRef.current = true
          startingRef.current = false
          setListening(true)
          setStarting(false)
          // v3：有唤醒词时从**待机**开始（麦克风常开，但只认唤醒词）。
          // 状态文字由 awake 推导，不能再用粘性 hint 盖住（否则唤醒后还显示旧文案）。
          activeRef.current = false
          activeUntilRef.current = 0
          setAwake(false)
          setHint(String(configRef.current.wakeWord ?? '').trim() ? '' : t('globalListening'))
        } catch {
          // 收回 composer 的让位信号这件事由 stopListening() 末尾那句
          // GLOBAL_MIC_OFF_EVENT 负责（其余每条提前 return 的失败分支自己发）。
          stopListening()
          setHint(t('micFailed'), 'error', 2500)
        }
      }, [t, setHint, stopListening, startWorkletVad, startScriptProcessorVad, recordCapture])

      const toggleListening = useCallback(() => {
        if (listeningRef.current || startingRef.current) {
          stopListening()
          return
        }
        void startListening()
      }, [startListening, stopListening])

      /**
       * 「不想操作」：全局语音开着时自动开始聆听一次。
       *
       * 用户明确说过不想每次都点按钮/按快捷键。这里只自动**开一次**：
       * - 只在浮层这次挂载里尝试一次（autoStartedRef），用户手动关闭后不会反复弹开；
       * - 麦克风权限/音频上下文还没就绪时失败一次就算了，不循环重试（避免弹权限框打扰）；
       * - 仍然保留按钮和快捷键可以随时停/再开。
       *
       * 注意：没有加新配置项 —— 用户的原话就是「不想操作」，默认行为直接按这个来。
       */
      const autoStartedRef = useRef(false)
      useEffect(() => {
        if (config.globalVoice !== true || autoStartedRef.current) return undefined
        const timer = timers.timeout('gv-autostart', () => {
          if (!aliveRef.current || configRef.current.globalVoice !== true) return
          autoStartedRef.current = true
          if (listeningRef.current || startingRef.current) return
          void startListening()
        }, 1200, 'config')
        return () => timers.clear('gv-autostart')
      }, [config.globalVoice, startListening, timers])

      /** 回执：无论成功、失败还是异常都必须 POST，否则宿主工具只能等到超时。 */
      const postResult = useCallback(async (requestId, ok, value, error) => {
        if (!requestId) return
        const payload = { requestId, ok: ok === true }
        if (value !== undefined) payload.value = value
        if (error !== undefined) payload.error = String(error)
        // POST 前先按同一套协议校验一遍：字段写错时本地就能发现，
        // 而不是让宿主 400 之后把这次动作当成「成功但没结果」。
        const checked = validateUiActionResult(payload)
        const body = checked.ok ? checked.value : { requestId, ok: false, error: checked.error }
        try {
          await fetch(ROUTES.uiActionResult, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        } catch {
          // 回执失败没有别的补救办法；宿主 20 秒后按超时处理。
        }
      }, [])

      /**
       * 弹确认条并等待用户选择（返回 true=允许，false=拒绝/超时/组件卸载）。
       *
       * @param {object} request - 待确认的动作 {requestId, action, params}。
       * @param {number} [timeoutMs] - 本动作的确认超时（默认 CONFIRM_TIMEOUT_MS）；
       *   带 expiresAt 的动作会传 min(30s, expiresAt-now-1000)，保证不会在宿主
       *   已放弃该动作之后才允许执行。
       */
      const requestConfirm = useCallback((request, timeoutMs = CONFIRM_TIMEOUT_MS) => new Promise((resolve) => {
        confirmResolveRef.current = resolve
        confirmRequestRef.current = request
        setConfirmRequest(request)
        // 客户端兜底超时（CONFIRM_TIMEOUT_MS，或按 expiresAt 收紧）：宿主 ~20s
        // 就放弃该动作并告诉模型失败；确认条不能无限期挂着 —— 否则 uiBusyRef
        // 卡 true（后续动作全回 busy），用户迟到的「允许」还会执行一个宿主早已
        // 判失败的动作（ghost action）。超时按「拒绝」兑现，让 handleUiAction
        // 走 confirm_denied 回执收尾。
        const rawWait = Number.isFinite(timeoutMs) ? Number(timeoutMs) : CONFIRM_TIMEOUT_MS
        const wait = Math.max(0, Math.min(CONFIRM_TIMEOUT_MS, rawWait))
        timers.timeout('gv-confirm-timeout', () => {
          if (!confirmResolveRef.current) return
          setHint(t('globalConfirmTimeout'), 'error', 2500)
          answerConfirmRef.current?.(false)
        }, wait, 'confirm')
      }), [timers, t, setHint])

      /** 用户点了允许/拒绝（或超时/组件卸载时兜底兑现 false）。 */
      const answerConfirm = useCallback((allowed) => {
        const resolve = confirmResolveRef.current
        confirmResolveRef.current = null
        confirmRequestRef.current = null
        // 用户已经回答：立即清掉兜底超时定时器（否则它稍后还会再触发一次）。
        timers.clear('gv-confirm-timeout')
        if (aliveRef.current) setConfirmRequest(null)
        if (typeof resolve === 'function') resolve(allowed === true)
      }, [timers])
      // 供 transcribeSegment（语音确认）间接调用；每次渲染同步，保证拿到的
      // 是最新的回调引用（它自身 deps 为空、引用稳定，这里只是防御）。
      answerConfirmRef.current = answerConfirm

      /**
       * 执行一个界面动作。
       *
       * 只用已核实的客户端 API（契约 §6），绝不执行任意 JS/DOM 选择器：
       *   state           → 汇总当前会话/模式/开关；
       *   list_sessions   → 宿主自己会直接答，这里只是兜底；
       *   switch_session  → ctx.get('uiWorkspace').openSession(id)；
       *   new_session     → ctx.get('uiWorkspace').startSession(workspaceId, {})；
       *   run_command     → binding.session.command(line)；
       *   send_prompt     → binding.session.prompt([{type:'text',text}], mode)；
       *   stop_generation → binding.session.cancel()；
       *   toggle_sidebar  → ctx.get('layout').toggleSidebar()；
       *   v2 新增：
       *   set_sidebar     → 读 [data-sidebar-collapsed] 后按方向 toggleSidebar()（读不到 → unknown_state）；
       *   open_plugins    → ctx.get('pluginNavigation').openList()；
       *   ui_snapshot     → 遍历可见可交互元素，打 data-dsh-voice-ref，存 ref→元素表；
       *   ui_click        → 按 ref 点击（stale_ref / disabled）；
       *   ui_type         → input/textarea 原生 setter + input/change，contenteditable 设 textContent；
       *   ui_key          → parseKeySpec 后在 activeElement 上派发 keydown/keyup。
       *
       * @param {string} action - 已校验的规范动作名。
       * @param {object} params - 已校验的参数。
       * @returns {Promise<{ok:boolean, value?:any, error?:string}>} 执行结果。
       */
      const executeUiAction = useCallback(async (action, params) => {
        const sessionsService = sessionContext.clientService('sessions')
        const targetId = params?.sessionId || sessionIdRef.current
        const session = (() => {
          if (!targetId) return null
          try { return sessionsService?.binding?.(targetId)?.session ?? null } catch { return null }
        })()
        switch (action) {
          case 'state': {
            const snapshot = readSessionSnapshot(sessionsService)
            const entry = snapshot?.byId?.[sessionIdRef.current] ?? null
            // 界面能力探测：这两个是 UI 动作能否执行的前提。
            // 之前 clientService 的取值顺序有 bug（见其注释），
            // 结果 toggle_sidebar/switch_session 一律 unsupported；
            // 把探测结果带进 state，模型和排查都能立刻看出缺哪个服务。
            const layout = sessionContext.clientService('layout')
            const workspace = sessionContext.clientService('uiWorkspace')
            // 侧边栏方向：layout 服务只暴露 toggleSidebar，没有可读快照。
            // 唯一可靠信号是 AppFrame 渲染的 `data-sidebar-collapsed` 标记
            // （收起时存在，展开时不存在）。读不到（没有 frame / DOM 桩）返回 null，
            // 模型就别硬猜方向 —— 宁可先问一句，也别反着操作。
            let sidebarCollapsed = null
            try {
              if (typeof document !== 'undefined' && typeof doc.querySelector === 'function') {
                sidebarCollapsed = doc.querySelector('[data-sidebar-collapsed]') !== null
              }
            } catch {
              sidebarCollapsed = null
            }
            return {
              ok: true,
              value: {
                sessionId: sessionIdRef.current || null,
                title: typeof entry?.title === 'string' ? entry.title : '',
                mode: normalizeVoicePromptMode(configRef.current.voicePromptMode),
                globalVoice: configRef.current.globalVoice === true,
                listening: listeningRef.current,
                uiControl: configRef.current.uiControl === true,
                hasLayout: typeof layout?.toggleSidebar === 'function',
                hasWorkspace: typeof workspace?.openSession === 'function',
                sidebarCollapsed,
                // v3：唤醒词与待机/活跃状态（模型判断「现在要不要先喊唤醒词」的依据）。
                wakeWord: String(configRef.current.wakeWord ?? '').trim(),
                awake: activeRef.current,
              },
            }
          }
          case 'list_sessions': {
            const snapshot = readSessionSnapshot(sessionsService)
            const byId = snapshot?.byId && typeof snapshot.byId === 'object' ? snapshot.byId : {}
            const sessions = Object.keys(byId).map((key) => ({
              id: String(byId[key]?.id ?? key),
              title: typeof byId[key]?.title === 'string' ? byId[key].title : '',
            }))
            return { ok: true, value: { sessions } }
          }
          case 'switch_session': {
            const workspace = sessionContext.clientService('uiWorkspace')
            if (typeof workspace?.openSession !== 'function') return { ok: false, error: 'unsupported' }
            workspace.openSession(params.sessionId)
            return { ok: true, value: { switched: params.sessionId } }
          }
          case 'new_session': {
            const workspace = sessionContext.clientService('uiWorkspace')
            if (typeof workspace?.startSession !== 'function') return { ok: false, error: 'unsupported' }
            const created = workspace.startSession(params.workspaceId, {})
            return { ok: true, value: { created: created === undefined ? true : true } }
          }
          case 'run_command': {
            if (!session || typeof session.command !== 'function') return { ok: false, error: 'no_session' }
            await session.command(params.line)
            return { ok: true, value: { ran: params.line } }
          }
          case 'send_prompt': {
            if (!session || typeof session.prompt !== 'function') return { ok: false, error: 'no_session' }
            const mode = normalizeVoicePromptMode(configRef.current.voicePromptMode)
            const result = await session.prompt([{ type: 'text', text: params.text }], mode)
            if (result && result.ok === false) return { ok: false, error: 'send_failed' }
            return { ok: true, value: { sent: true } }
          }
          case 'stop_generation': {
            if (!session || typeof session.cancel !== 'function') return { ok: false, error: 'no_session' }
            await session.cancel()
            return { ok: true, value: { stopped: true } }
          }
          case 'toggle_sidebar': {
            const layout = sessionContext.clientService('layout')
            if (typeof layout?.toggleSidebar !== 'function') return { ok: false, error: 'unsupported' }
            layout.toggleSidebar()
            return { ok: true, value: { toggled: true } }
          }
          // ---- v2：语义导航 ----
          case 'set_sidebar': {
            const layout = sessionContext.clientService('layout')
            if (typeof layout?.toggleSidebar !== 'function') return { ok: false, error: 'unsupported' }
            // 方向只能从 DOM 标记读：layout 服务只暴露 toggleSidebar，没有可读状态。
            // 读不到就回 unknown_state，绝不盲切 —— 说「收起」结果展开是最糟的体验。
            let collapsed = null
            try {
              if (typeof document !== 'undefined' && typeof doc.querySelector === 'function') {
                collapsed = doc.querySelector('[data-sidebar-collapsed]') !== null
              }
            } catch {
              collapsed = null
            }
            if (collapsed === null) return { ok: false, error: 'unknown_state' }
            const target = params.collapsed === true
            if (collapsed !== target) layout.toggleSidebar()
            return { ok: true, value: { collapsed: target } }
          }
          case 'open_plugins': {
            const navigation = sessionContext.clientService('pluginNavigation')
            if (typeof navigation?.openList !== 'function') return { ok: false, error: 'unsupported' }
            navigation.openList()
            return { ok: true, value: { opened: true } }
          }
          // ---- v2：通用 a11y 原语 ----
          case 'ui_snapshot': {
            try {
              if (typeof document === 'undefined' || typeof doc.querySelectorAll !== 'function') {
                return { ok: false, error: 'unsupported' }
              }
              // 新快照整体覆盖旧表（ref 只在最近一次快照内有效）。
              a11yBridge.clear()
              const all = doc.querySelectorAll('*')
              const elements = []
              for (let i = 0; i < all.length && elements.length < MAX_SNAPSHOT_ELEMENTS; i++) {
                const el = all[i]
                if (!a11yBridge.isVisible(el)) continue
                // 浮层自己也是 DOM 的一部分：不排除的话模型可能点到自己的
                // 麦克风/确认按钮，形成"模型操作浮层 → 浮层执行动作"的环路。
                // 浮层所有节点都带 data-dsh-voice-typing-global 标记，整体跳过。
                try {
                  if (typeof el.closest === 'function' && el.closest('[data-dsh-voice-typing-global]')) continue
                } catch { /* 忽略 */ }
                // 序号从 1 开始：ref 形如 e1、e2…（人读/模型读都更自然）。
                const info = describeInteractiveElement(el, elements.length + 1)
                if (!info) continue
                try { el.setAttribute('data-dsh-voice-ref', info.ref) } catch { /* 忽略 */ }
                // 元素表 + 可读名一起记：确认条要把「ui_click: e12」翻译成「点击「发送」（e12）」。
                a11yBridge.record(info.ref, el, info)
                elements.push(info)
              }
              let sidebarCollapsed = null
              try {
                sidebarCollapsed = doc.querySelector('[data-sidebar-collapsed]') !== null
              } catch {
                sidebarCollapsed = null
              }
              return { ok: true, value: { elements, count: elements.length, sidebarCollapsed } }
            } catch {
              return { ok: false, error: 'snapshot_failed' }
            }
          }
          case 'ui_click': {
            const el = a11yBridge.resolve(params.ref)
            if (!el) return { ok: false, error: 'stale_ref' }
            if (el.disabled === true || String(el.getAttribute?.('aria-disabled') ?? '') === 'true') {
              return { ok: false, error: 'disabled' }
            }
            // 拒绝会离开应用/弹系统框的点击（评审 P3）：外链导航、target=_blank、
            // file input。a11y 原语只操作应用内界面；点出去后浮层随页面消失，
            // 而会话/工具调用还挂着。内部锚点与相对路径仍允许。
            if (isUnsafeClickTarget({
              tag: el.tagName,
              type: el.type ?? el.getAttribute?.('type'),
              href: el.getAttribute?.('href') ?? el.href,
              target: el.getAttribute?.('target'),
            })) {
              return { ok: false, error: 'unsupported' }
            }
            if (typeof el.click !== 'function') return { ok: false, error: 'unsupported' }
            el.click()
            return { ok: true, value: { clicked: params.ref } }
          }
          case 'ui_type': {
            const el = a11yBridge.resolve(params.ref)
            if (!el) return { ok: false, error: 'stale_ref' }
            const tag = String(el.tagName ?? '').toUpperCase()
            const inputType = String(el.type ?? el.getAttribute?.('type') ?? '').toLowerCase()
            // 密码框永远不允许模型/语音代填：不可逆的隐私边界（契约 §客户端实现要点 3）。
            if (tag === 'INPUT' && inputType === 'password') return { ok: false, error: 'forbidden' }
            if (el.disabled === true) return { ok: false, error: 'disabled' }
            // 只允许真正可写的文本目标：文本类 input / textarea / contenteditable。
            // checkbox/radio/file/range/color/date… 走原生 setter 会被吞掉却报 ok
            // （评审 P3「假成功」），这里统一 unsupported。
            const writableKind = classifyWritableTarget(
              tag,
              inputType,
              el.isContentEditable === true ? true : el.getAttribute?.('contenteditable'),
            )
            if (!writableKind) return { ok: false, error: 'unsupported' }
            if (writableKind === 'input' || writableKind === 'textarea') {
              // readOnly 输入框写不进去，别报假成功。
              if (el.readOnly === true) return { ok: false, error: 'unsupported' }
              a11yBridge.setNativeInputValue(el, String(params.text))
              return { ok: true, value: { typed: params.text.length, tag: writableKind } }
            }
            try {
              el.textContent = String(params.text)
              a11yBridge.dispatchDomEvent(el, 'input', { bubbles: true })
              return { ok: true, value: { typed: params.text.length, tag: 'contenteditable' } }
            } catch {
              return { ok: false, error: 'unsupported' }
            }
          }
          case 'ui_key': {
            const parsed = parseKeySpec(params.key)
            if (!parsed.ok) return { ok: false, error: 'invalid_param:key' }
            if (typeof document === 'undefined') return { ok: false, error: 'unsupported' }
            let target = null
            try { target = doc.activeElement ?? doc.body ?? null } catch { target = null }
            if (!target) return { ok: false, error: 'unsupported' }
            const init = {
              // 值来自词表（src/shared/key-names.js），已经是 `KeyboardEvent.key` 的真值
              // —— 空格就是 `' '`。以前这里写着 `parsed.key === 'Space' ? ' ' : parsed.key`，
              // 等于把「DOM 里空格键的真值是什么」这条知识放在调用方（4.3d 收进词表）。
              key: parsed.key,
              bubbles: true,
              cancelable: true,
              ctrlKey: parsed.ctrl === true,
              altKey: parsed.alt === true,
              shiftKey: parsed.shift === true,
              metaKey: parsed.meta === true,
            }
            a11yBridge.dispatchDomEvent(target, 'keydown', init)
            a11yBridge.dispatchDomEvent(target, 'keyup', init)
            return { ok: true, value: { key: params.key } }
          }
          default:
            return { ok: false, error: 'unknown_action' }
        }
      }, [])

      /**
       * 处理宿主下发的 `ui-action`。
       *
       * 顺序很重要：先校验（绝不执行未校验参数）→ 需要确认时等用户 →
       * 执行 → 回执。任何异常都要回执，不能静默（宿主工具会一直等）。
       *
       * `payload.confirm` 是宿主算好的**生效值**（只读动作永远 false），
       * 客户端直接信它，不再自己叠加 uiConfirm —— 否则 state 也会弹确认。
       *
       * @param {object} payload - SSE 信封里的 ui-action 载荷。
       */
      const handleUiAction = useCallback(async (payload) => {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : ''
        if (!requestId) return
        // 先看宿主的动作截止时间（expiresAt，task-17 新增）。
        // 已经过期就立刻回执 expired：不弹确认、不执行 —— 否则用户迟到的
        // 「允许」会触发一个宿主工具早已按 ui_timeout 失败的动作（ghost action）。
        // 放在 busy 判断之前：过期是更准确的原因，也避免过期动作继续占住 uiBusy。
        if (isUiActionExpired(payload, Date.now())) {
          setHint(t('globalActionExpired'), 'error', 3000)
          await postResult(requestId, false, undefined, 'expired')
          return
        }
        // 一次只处理一个动作：确认条还挂着时再来一个动作直接拒绝，避免回执串号。
        if (uiBusyRef.current) {
          await postResult(requestId, false, undefined, 'busy')
          return
        }
        const actions = Array.isArray(payload?.actions) ? payload.actions : []
        if (!actions.length) {
          await postResult(requestId, false, undefined, 'invalid_action')
          return
        }
        // 多窗口/多标签去重：宿主的 ui-action 是**广播**，先向宿主认领这个请求。
        // 只有 claimed:true 的窗口才允许弹确认/执行；claimed:false、404（旧宿主/
        // 路由未就绪）或 fetch 失败 → 静默跳过且**不回执**（另一个窗口会回执；
        // 回执反而制造 404/busy 噪声，还可能让宿主误以为是这个窗口处理的）。
        if (!(await clientIdentity.claimUiAction(requestId))) return
        uiBusyRef.current = true
        if (aliveRef.current) setUiBusy(true)
        setHint(t('globalUiRunning'))
        try {
          // 同一个 SSE 载荷只有一个 deadline；数组里每个动作都受它约束。
          const expiresAt = typeof payload?.expiresAt === 'number' && Number.isFinite(payload.expiresAt)
            ? payload.expiresAt
            : null
          let lastValue
          for (const item of actions) {
            const checked = validateUiAction(item?.action, item?.params)
            if (!checked.ok) {
              await postResult(requestId, false, undefined, checked.error)
              return
            }
            if (payload.confirm === true && actionNeedsConfirm(checked.action)) {
              // 确认条计时器必须**早于**宿主 deadline 结束：留 1 秒余量给网络/渲染。
              // 剩余时间已经不足 1 秒时，直接按 expired 处理（连确认条都不弹），
              // 保证客户端永远不可能在宿主超时之后才放行执行。
              const remaining = expiresAt === null
                ? CONFIRM_TIMEOUT_MS
                : Math.min(CONFIRM_TIMEOUT_MS, expiresAt - Date.now() - 1000)
              if (remaining <= 0) {
                setHint(t('globalActionExpired'), 'error', 3000)
                await postResult(requestId, false, undefined, 'expired')
                return
              }
              const allowed = await requestConfirm({
                requestId,
                action: checked.action,
                params: checked.params,
              }, remaining)
              if (!allowed) {
                // 用户拒绝：明确回执 confirm_denied（tool 会原样返回给模型）。
                await postResult(requestId, false, { cancelled: true }, 'confirm_denied')
                return
              }
            }
            // 用户点「允许」后、真正执行前**再检查一次** deadline：
            // 确认条可能挂到宿主 deadline 之后（宿主已判失败），此时必须回执
            // expired，绝不能执行（评审 P1「ghost action」）。
            if (isUiActionExpired(payload, Date.now())) {
              setHint(t('globalActionExpired'), 'error', 3000)
              await postResult(requestId, false, undefined, 'expired')
              return
            }
            const result = await executeUiAction(checked.action, checked.params)
            if (!result.ok) {
              setHint(t('globalUiFailed'), 'error', 3000)
              await postResult(requestId, false, undefined, result.error)
              return
            }
            lastValue = result.value
          }
          await postResult(requestId, true, lastValue === undefined ? { done: true } : lastValue)
          setHint('', '', 0)
        } catch (error) {
          // 执行器异常也必须回执（不能静默），错误文本限长由 validateUiActionResult 兜住。
          await postResult(requestId, false, undefined, error instanceof Error ? error.message : String(error))
        } finally {
          uiBusyRef.current = false
          if (aliveRef.current) setUiBusy(false)
        }
      }, [t, setHint, postResult, requestConfirm, executeUiAction])

      /* ================= 事件监听 ================= */

      /**
       * 全局快捷键：捕获阶段监听 window keydown。
       *
       * 用捕获阶段的原因与 composer 相同：输入框/组件在冒泡阶段
       * stopPropagation() 后，冒泡监听就收不到事件（表现为「按了没反应」）。
       *
       * 设置面板正在录制快捷键时（两个输入框任一聚焦）直接忽略，
       * 否则用户按 Ctrl+Alt+V 想改键，反而把浮层打开了。
       */
      useEffect(() => {
        const down = (event) => {
          if (shortcutFocus.anyFocused()) return
          if (configRef.current.globalVoice !== true) return
          const combo = configRef.current.globalShortcut ?? UI_DEFAULTS.globalShortcut
          if (!shortcutMatches(event, combo, clientPlatform())) return
          event.preventDefault()
          if (event.repeat) return
          toggleListening()
        }
        try {
          win.addEventListener('keydown', down, true)
        } catch {
          return undefined
        }
        return () => {
          try { win.removeEventListener('keydown', down, true) } catch { /* 忽略 */ }
        }
      }, [toggleListening])

      /**
       * composer 快捷键在全局语音开启时改为「切换浮层麦克风」（见 GLOBAL_TOGGLE_EVENT）。
       * 输入框麦克风已隐藏，所以 Alt+V 和 Ctrl+Alt+V 最终都落到同一个入口。
       */
      useEffect(() => {
        const onToggle = () => toggleListening()
        try {
          win.addEventListener(GLOBAL_TOGGLE_EVENT, onToggle)
        } catch {
          return undefined
        }
        return () => {
          try { win.removeEventListener(GLOBAL_TOGGLE_EVENT, onToggle) } catch { /* 忽略 */ }
        }
      }, [toggleListening])

      /**
       * 插件自己的 SSE：`global-hotkey`（helper 进程转发）+ `ui-action`（模型操控界面）。
       *
       * 总开关关闭时不建连：浮层不渲染，就不该有后台 UI 动作执行器
       * （没有执行器时宿主工具会按超时失败，这是契约允许的降级）。
       */
      useEffect(() => {
        if (config.globalVoice !== true) return undefined
        /** 当前连接；error 后置空，由重连定时器重建。 */
        let source = null
        let disposed = false
        /**
         * 建连并在断开后重建。
         *
         * 为什么要自己重连：EventSource 只在「网络错误」时自动重试；
         * 插件热更新（宿主插件 HMR）期间路由会短暂消失，返回 404 →
         * 浏览器按规范**永久放弃**这条 EventSource，不刷新页面就再也收不到
         * ui-action/global-hotkey（表现就是「界面动作一直超时、唤醒没反应」）。
         * 这里显式重建，热更新后能自己缓过来。
         */
        const connect = () => {
          if (disposed) return
          try {
            source = new EventSource(ROUTES.stream)
          } catch {
            source = null
            // 重连定时器必须用**独立分组** 'sse'：stopListening() 会
            // clearGroup('global-voice')，若把重连放进那个组，用户在重试窗口里
            // 停一次麦就会把重连清掉 —— 连接已断、定时器已删，执行器永久失联。
            // 卸载时 timers.clearAll() 仍会兜底清理。
            timers.timeout('gv-sse-retry', connect, 3000, 'sse')
            return
          }
          source.addEventListener('global-hotkey', (event) => {
            try {
              const payload = parseEnvelope(event)
              if (!payload) return
              if (payload.action && payload.action !== 'toggle') return
              toggleListening()
            } catch { /* 忽略 */ }
          })
          source.addEventListener('ui-action', (event) => {
            try {
              const payload = parseEnvelope(event)
              if (payload) void handleUiAction(payload)
            } catch { /* 忽略 */ }
          })
          source.onerror = () => {
            // 先关掉自己：readyState=CLOSED 时浏览器不会再重试。
            try { source?.close?.() } catch { /* 忽略 */ }
            source = null
            if (disposed) return
            // 同上：重连定时器放独立分组 'sse'，不被 stopListening 清掉。
            timers.timeout('gv-sse-retry', connect, 3000, 'sse')
          }
        }
        connect()
        return () => {
          disposed = true
          timers.clear('gv-sse-retry')
          try { source?.close?.() } catch { /* 忽略 */ }
        }
      }, [config.globalVoice, toggleListening, handleUiAction, timers])

      /**
       * 总开关被关掉时立刻收摊：停止录音、取消未决的确认条
       * （不取消的话那个 Promise 永远挂着，宿主只能等 20 秒超时）。
       */
      useEffect(() => {
        if (config.globalVoice === true) return undefined
        // 关掉总开关时重置「本次挂载已自动开麦」标记。
        // 组件不会卸载（只是早退不渲染 UI），不重置的话再次打开 globalVoice
        // 就不会自动进入待机（评审 P3-3），用户会以为"开了但没反应"。
        autoStartedRef.current = false
        if (listeningRef.current || startingRef.current) stopListening()
        const resolve = confirmResolveRef.current
        confirmResolveRef.current = null
        confirmRequestRef.current = null
        setConfirmRequest(null)
        if (typeof resolve === 'function') resolve(false)
        return undefined
      }, [config.globalVoice, stopListening])

      // 卸载兜底：清定时器、关麦克风、兑现未决的确认 Promise。
      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
          try { stopListening() } catch { /* 忽略 */ }
          timers.clearAll()
          const resolve = confirmResolveRef.current
          confirmResolveRef.current = null
          confirmRequestRef.current = null
          if (typeof resolve === 'function') resolve(false)
        }
      }, [stopListening, timers])

      /* ================= 界面 ================= */

      // 总开关关闭：不渲染任何可见 UI。
      // 为什么返回隐藏占位而不是 null：仓库的 SSR 冒烟测试要求每个注册槽位
      // 默认渲染出非空 HTML；display:none + aria-hidden 对用户等价于「不存在」。
      if (config.globalVoice !== true) {
        return h('div', {
          style: { display: 'none' },
          'aria-hidden': 'true',
          'data-dsh-voice-typing-global': GLOBAL_OVERLAY_ID,
        })
      }

      // v3：有唤醒词时，状态文字由「待机/活跃」推导（而不是沿用固定文案）：
      // 待机 · 说『小鱼』唤醒 / 已唤醒 · 直接说即可。
      // 活跃态那句**不能再写「说『小鱼』唤醒」**—— 唤醒一次之后 WAKE_ACTIVE_MS 内
      // 每句都直接进会话，文案还要求唤醒词，用户就会以为每句都得先喊一遍（§8.33）。
      // 无唤醒词时维持 v2 行为（一直显示聆听中）。
      const wakeWordText = String(config.wakeWord ?? '').trim()
      const wakeStatusText = wakeWordText
        ? (awake
          ? t('globalWakeActive', { word: wakeWordText })
          : t('globalWakeStandby', { word: wakeWordText }))
        : t('globalListening')
      const statusText = uiBusy
        ? t('globalUiRunning')
        : starting
          ? t('micStarting')
          : status || (listening ? wakeStatusText : t('globalIdle'))
      const statusColor = statusTone === 'error'
        ? 'var(--dsw-alias-state-danger, #d13438)'
        : statusTone === 'ok'
          ? 'var(--dsw-alias-state-success, #2ea043)'
          : starting || listening
            ? 'var(--dsw-alias-state-business-primary, #4d6bfe)'
            : 'var(--dsw-alias-label-secondary, inherit)'
      const micIcon = h(
        'svg',
        { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3 }),
        h('path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0' }),
        h('line', { x1: 12, y1: 18, x2: 12, y2: 21.5 }),
      )
      const micButton = h(
        'button',
        {
          type: 'button',
          onClick: toggleListening,
          onContextMenu: (event) => { event.preventDefault(); toggleListening() },
          title: listening ? t('globalMicOnHint') : t('globalStartHint'),
          'aria-label': listening ? t('globalMicOnHint') : t('globalStartHint'),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 999,
            border: '1px solid ' + (listening
              ? 'var(--dsw-alias-state-business-primary, #4d6bfe)'
              : 'transparent'),
            background: listening
              ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 14%, transparent)'
              : 'transparent',
            color: listening
              ? 'var(--dsw-alias-state-business-primary, #4d6bfe)'
              : 'inherit',
            cursor: 'pointer',
            padding: 0,
            touchAction: 'none',
            userSelect: 'none',
          },
        },
        micIcon,
      )
      const confirmBar = confirmRequest
        ? h(
            'div',
            { style: { ...GLOBAL_OVERLAY_CARD_STYLE, flexDirection: 'column', alignItems: 'flex-start', gap: 6, borderRadius: 12 } },
            h(
              'span',
              { style: { fontSize: 12, opacity: 0.95 } },
              // 有快照信息时翻译成「点击「插件」（e12）」；没有则退回协议描述。
              `${t('globalAskConfirm')}：${describeConfirmTarget(confirmRequest, t, describeUiAction, a11yBridge.infoFor)}`,
            ),
            // 语音确认提示：确认条挂着时直接说「允许/拒绝」也生效
            //（由 transcribeSegment 拦截识别结果，不发送该句）。
            h(
              'span',
              { style: { fontSize: 11, opacity: 0.7 } },
              t('globalConfirmSpeakHint'),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 8 } },
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => answerConfirm(true),
                  style: { ...GLOBAL_OVERLAY_ACTION_STYLE, borderColor: 'var(--dsw-alias-state-success, #2ea043)', color: 'var(--dsw-alias-state-success, #2ea043)' },
                },
                t('globalAllow'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => answerConfirm(false),
                  style: GLOBAL_OVERLAY_ACTION_STYLE,
                },
                t('globalDeny'),
              ),
            ),
          )
        : null

      return h(
        'div',
        { style: GLOBAL_OVERLAY_WRAPPER_STYLE, 'data-dsh-voice-typing-global': GLOBAL_OVERLAY_ID },
        confirmBar,
        h(
          'div',
          { style: GLOBAL_OVERLAY_CARD_STYLE },
          micButton,
          h(
            'span',
            { title: statusText, style: { maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: statusColor } },
            statusText,
          ),
          lastText
            ? h(
                'span',
                {
                  title: lastText,
                  // 识别文本用次级文字色并显式给出回退：不能只靠父级继承，
                  // 否则在浅色主题的深色卡片上会变成「黑底黑字」。
                  style: {
                    maxWidth: 150,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--dsw-alias-label-secondary, currentColor)',
                    opacity: 0.95,
                  },
                },
                lastText.length > 24 ? lastText.slice(0, 24) + '…' : lastText,
              )
            : null,
        ),
      )
    }
  return GlobalVoiceOverlay
}
