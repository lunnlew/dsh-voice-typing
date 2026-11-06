/**
 * 麦克风按钮组件（实时对话模式）。
 *
 * 设计原则：
 *   1. 单一状态：语音模式只有开/关（`on`）。显示由 `on` + `speaking` + `hint` 推导。
 *   2. 麦克风一次打开、只关一次（退出时）。识别、等回复、朗读期间都开着。
 *   3. 所有识别文字一律进输入框（草稿），绝不在按钮旁另设预览。
 *   4. 是否自动发送只看一件事：助手此刻忙不忙。忙 → 文字留在草稿；闲 → 自动发送。
 *   5. 识别在宿主 worker 线程里跑，不阻塞。
 *
 * 环境注入：
 *   - 浏览器 API 通过 browserEnv 注入（window/document/navigator）；
 *   - 服务实例通过 serviceEnv 注入（sessionContext/micDevice/playCore/configStore/timers）。
 *
 * @module dsh-voice-typing/client/dom/mic-button
 */

// 导入 pure/ 模块的函数和常量
import { mergeDraft, syncUserEdit } from '../pure/draft.js'
import { parseEnvelope, belongsToSession, createTimerRegistry, sleep } from '../pure/envelope.js'
import { trimBacklog } from '../pure/backlog.js'
import { ackBatches, normalizeAckCount } from '../pure/reading-ack.js'
import { unescapeSpeechText, collapseWhitespace, matchInNodes } from '../pure/highlight.js'
import { createReadingHighlight } from '../pure/reading-highlight.js'
import { shortcutMatches, shortcutFocus } from '../pure/shortcut.js'
import { resampleTo16k, normalizeSourceRate, mergeChunks } from '../pure/resample.js'
import { clientPlatform } from '../pure/platform.js'
import { INITIAL_GATE_STATE, advanceGate } from '../pure/gate.js'
import { STREAM_MODEL_IDS } from '../pure/config-normalize.js'
import { ROUTES } from '../pure/routes.js'
import { zhTranslate } from '../pure/i18n.js'
import { asrReadyReasonText } from '../pure/asr-ready-text.js'
import {
  TRANSCRIBE_TIMEOUT_MS,
  TTS_TIMEOUT_MS,
  MAX_RECORD_MS,
  MAX_PENDING,
  MAX_SEEN_SENTENCE_KEYS,
  GLOBAL_MIC_ON_EVENT,
  GLOBAL_TOGGLE_EVENT,
} from '../pure/voice-constants.js'

/**
 * 创建麦克风按钮组件。
 *
 * @param {object} R - React 库（{ useState, useCallback, useEffect, useRef, createElement }）。
 * @param {object} browserEnv - 浏览器环境注入对象（window/document/navigator API）。
 * @param {object} serviceEnv - 服务实例注入对象（sessionContext/micDevice/playCore/configStore/timers）。
 * @returns {function} React 组件函数。
 */
export function createMicButton(R, browserEnv, serviceEnv) {
  const { useState, useCallback, useEffect, useRef, createElement: h, Fragment } = R
  const { win, doc, nav } = browserEnv
  const { sessionContext, micDevice, playCore, configStore } = serviceEnv


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
    function MicButton(props) {
      const inputActions = props?.inputActions
      // 必须用 useCallback 稳住引用。
      // 直接写箭头函数的话，每次渲染都是新函数，
      // 而下面监听 SSE 的 effect 依赖 [reload, t] ——
      // 于是 effect 反复重跑：EventSource 刚连上就被 close() 关掉，
      // 永远收不到 model-progress（下载看不到进度），
      // 同时 void reload() → setConfig → 渲染 → 又触发 effect，陷入死循环。
      const t = useCallback(
        typeof props?.t === 'function' ? props.t : zhTranslate,
        [props?.t],
      )

      const sessionState = typeof props?.useSession === 'function' ? props.useSession((s) => s) : undefined
      // sessionId 的 ref 版：SSE 回调里要读**最新**的会话 id
      //（切换会话后，老连接还在，不能再把别的会话的事件当自己的处理）。
      const sessionIdRef = useRef('')
      const sessionId = props?.sessionId ?? props?.session?.sessionId ?? sessionState?.sessionId ?? sessionState?.id ?? ''
      useEffect(() => { sessionIdRef.current = sessionId ?? '' }, [sessionId])

      // 把「当前打开的会话」持久化给全局浮层（LAST_SESSION_KEY）：
      // 现场案例是「先在对话页，再切到设置页启用浮层」—— 那时主视图保留已经
      // 消失，只有这里记下的 id 还能告诉浮层该发进哪个会话。
      // 代价接近 0：persistLastSessionId 内部先比对模块级缓存，不触发 setState。
      useEffect(() => {
        if (typeof sessionId === 'string' && sessionId) sessionContext.persistLastSessionId(sessionId)
      }, [sessionId])

      // SSE 是否已连上：连上了就不用轮询 /busy 了。
      const liveConnectedRef = useRef(false)

      /**
       * 「助手是否忙」的最近记录（环形，最多 12 条）。
       *
       * 用途：宿主说「不忙」而客户端说「忙」时，靠它分辨是
       *   - 事件没到（没收到）；
       *   - 事件到了但被会话过滤丢掉；
       *   - 事件到了也处理了，但状态被别处改回去。
       * 三种情况的现象一样，光看最终状态分不出来。
       */
      const busyLogRef = useRef([])

      // 助手是否在生成：以宿主推送的 assistant-busy 事件为准。
      // 会话对象上没有 running 字段，前端任何取值都拿不到，
      // 之前用 sessionState.running 恒为 false —— 这就是「生成期间说的话
      // 从来不进队列」的根因。宿主在 llm/stream 开始/结束时维护该状态。
      const [assistantRunning, setAssistantRunning] = useState(false)
      const assistantRunningRef = useRef(false)
      useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const resp = await fetch(ROUTES.busy)
            if (!resp.ok) return
            const data = await resp.json().catch(() => null)
            if (!alive || !data) return
            const value = data.busy === true
            busyLogRef.current = [
              { src: 'poll', busy: value, sid: data.sessionId ?? null, mine: true, at: Date.now() },
              ...busyLogRef.current,
            ].slice(0, 12)
            if (value !== assistantRunningRef.current) {
              assistantRunningRef.current = value
              setAssistantRunning(value)
            }
          } catch { /* 忽略 */ }
        }
        void tick()
        // 轮询只是**降级**：SSE 连上之后（assistant-busy 事件）就停掉。
        // 之前是每 700ms 轮询一次 /busy —— 助手忙的感知要慢最多 700ms，
        // 自动发送的时机也跟着漂。
        timers.interval('busy-poll', () => {
          if (liveConnectedRef.current) return
          void tick()
        }, 700, 'app')
        return () => { alive = false; timers.clear('busy-poll') }
      }, [])

      const renderDraft = typeof props?.useInput === 'function' ? props.useInput((s) => s.draft) : ''
      const draftRef = useRef(typeof renderDraft === 'string' ? renderDraft : '')
      // 必须每次渲染同步：draftRef 之前只在挂载时初始化，之后永远是空值，
      // 导致所有「草稿是不是我们写的」判断、空结果回滚、基准捕获全部失效 ——
      // 这正是「自动出现旧数据」「删不掉」的来源。
      if (typeof renderDraft === 'string') draftRef.current = renderDraft

      const [on, setOn] = useState(false)
      /**
       * 正在打开麦克风 / 正在加载模型。
       *
       * 「开启语音模式」与「真的能识别了」是两件事：
       *   - 识别模型首次加载要等一会儿（时长没有可靠上界，所以文案里不写具体秒数）；
       *   - 麦克风可能被拒绝、被独占、拿到空轨道。
       *
       * 以前是**先**把界面切成「聆听中」**再**去开麦和加载 ——
       * 于是用户看到「聆听中」，识别却根本没开始：
       * 说的话要么全丢（模型没就绪，识别请求失败），
       * 要么界面骗人（麦克风其实没打开）。
       *
       * 现在：模型与麦克风都真的就绪了，才进入「聆听中」。
       * 期间显示「正在加载模型…」/「正在打开麦克风…」，失败则保持关闭并说明原因。
       */
      const [starting, setStarting] = useState(false)
      const startingRef = useRef(false)
      const [speaking, setSpeaking] = useState(false)
      const [hint, setHintState] = useState('')
      /** 提示的完整说明：状态行只显示短词，完整说明靠悬停显示。 */
      const [hintDetail, setHintDetailState] = useState('')
      /**
       * 最近一次「开麦没过去」的**原始原因**（只给排查看，不进界面）。
       *
       * 宿主回的是原因码（`src/shared/asr-readiness.js`），界面那句由 i18n 按当前语言出
       * （批次 18，docs §8.60）。这里留着原样：词表外的码（宿主和产物版本不一致）与
       * 请求根本没回来的异常消息都记下来，`__DSH_VOICE_DEBUG__().lastAsrReadyReason` 读得到。
       */
      const lastAsrReadyReasonRef = useRef('')
      // 提示的自动清除走 timers 登记表（id 为 'hint'）：同名会先清旧的，卸载时 clearAll 兜底。
      // 这里原先还挂着一个 hintTimerRef —— 它从来没被赋过非 null 值，
      // 于是四处 `if (hintTimerRef.current) clearTimeout(...)` 全是空转（批次 9，docs §8.50）。
      const onRef = useRef(false)
      /**
       * 「聆听中」标志的**唯一**设置点：界面（on）与 ref（onRef）必须在这一处成对翻起来。
       *
       * 为什么把它单独提成一个函数，而不是在就绪那一步直接写两行：
       *   这一处是「一切就绪」之后才允许走到的（见调用点上那段顺序说明），
       *   别处再写一遍 `setOn(true)` 就是绕过就绪判据的第二条路。
       *   名字固定下来之后，eslint 能把「别处不许再这么写」钉成构建期报错
       *   （eslint.config.js 的 LISTENING_ON_BAN，边界探针在 test/no-undef.test.mjs），
       *   行为侧的分枝覆盖在 test/client-behavior.test.mjs 场景 12。
       */
      const markListening = () => {
        onRef.current = true
        setOn(true)
      }
      const speakingRef = useRef(false)

      const micRef = useRef(null)
      const chunksRef = useRef([])
      const segStartRef = useRef(0)
      const hearingRef = useRef(false)
      const recognizingRef = useRef(false)
      const livePartialRef = useRef('')
      /**
       * 流式实时字的会话 id。
       *
       * 流式解码器是**有状态**的：它一边累积上下文一边解码，
       * 所以每次开麦要用一个新的会话 id，不能跨轮复用。
       */
      const streamSessionIdRef = useRef('')
      /** 已经喂给流式解码器的样本数（16kHz）。下次只喂新增的部分。 */
      const streamFedRef = useRef(0)
      /** 流式实时字是否可用（模型是流式的、或者用户强制开启）。 */
      const streamLiveRef = useRef(false)
      // 底噪起点取自门限模块（同一个算法认的起点），不在此写死数字。
      const noiseFloorRef = useRef(INITIAL_GATE_STATE.noiseFloor)
      const baseDraftRef = useRef('')
      /** 已完成各段的语音文本（累积，不覆盖）。 */
      const committedRef = useRef('')
      /** 当前段的实时字/最终稿（覆盖上一段实时字）。 */
      const segmentRef = useRef('')
      const recorderActiveRef = useRef(false)

      const speakCancelRef = useRef(null)
      /**
       * 当前还活着的音频源（AudioBufferSourceNode）。
       *
       * 为什么不能只靠 speakCancelRef 这一个句柄：
       *   它在「上一句刚播完、下一句还没开始」的空隙里是 null；
       *   而更早那一句的 onended 也会把它清成 null。
       * 这两种时刻点「停止朗读」都找不到真正在响的那个源 ——
       * 表现就是「点了停止朗读，朗读还在继续」。
       *
       * 这里登记**所有**还没结束的源，停止时逐个停掉：
       * 只要还有源在响，就一定会被切断。
       */
      const speakSourcesRef = useRef(new Set())
      /**
       * 用户手动停止朗读后，本轮不再朗读。
       *
       * 为什么需要它：
       *   点麦克风按钮会执行 haltSpeaking(true) —— 清空队列 + 停掉当前播放。
       *   但 SSE 连接还在（朗读不应该依赖「语音模式开着」），
       *   之后到达的 sentence 事件会继续入队、继续播 ——
       *   表现就是「我明明点击麦克风按钮停止了朗读，过一会儿它又开始了」。
       *
       * 语义：手动停止只影响**当前这一轮**；
       * 下一轮回复开始（收到 turn-begin）时自动恢复朗读。
       */
      /**
       * 被静音的回合 id。
       *
       * 「停止朗读」只影响**当前这一轮** —— 下一轮要自动恢复。
       * 以前只能靠「收到 turn-start 就解除静音」，
       * 而 turn-start 的广播时机靠启发式判定，可能多一次少一次。
       *
       * 现在有了 turnId（宿主按内容锚点分配），
       * 静音可以精确地记在某一轮上：
       *   - 句子里带的 turnId 等于 mutedTurnId → 这轮不播；
       *   - 收到新回合的 turn-begin → 解除静音。
       *
       * 拿不到 turnId 时（老宿主）退回原来的布尔语义。
       */
      const mutedTurnIdRef = useRef(null)
      /** 当前回合的 id（宿主分配，用于按轮同步）。 */
      const currentTurnIdRef = useRef(null)
      /** 本轮内已收到的句子序号（宿主不给 index 时本地补，保住「首句不丢」）。 */
      const turnSentenceSeqRef = useRef(0)

      /** 朗读代次：递增即可让所有旧的朗读作废。 */
      const speakGenRef = useRef(0)
      /** 朗读队列：边生成边朗读时，句子先进这里排队。 */
      const speakQueueRef = useRef([])
      /** 队列是否正在消费（避免并发重入）。 */
      const pumpingRef = useRef(false)
      /** 客户端侧语音合成失败的次数（「朗读没声」但无任何提示时，靠它定位）。 */
      const ttsFailuresRef = useRef(0)
      /** 上次提示「朗读失败」的时间（节流：别每失败一句都弹一次提示）。 */
      const lastTtsFailHintAtRef = useRef(0)
      /**
       * 播放阶段因上下文无法恢复而被跳过的句子数。
       * 与 ttsFailuresRef 分开：synth 成功但播放被跳过（/tts 在调、没声音）
       * 是另一种「无声」，光看 ttsFailures 会漏掉。
       */
      const playSkippedRef = useRef(0)
      /**
       * 正在播放的句子所属自然段（宿主给的 `para`；-1 表示未知/老宿主）。
       * 安全网裁剪时整段保护它：正在播的段落不能只留段首、把剩下的裁掉。
       */
      const playingParaRef = useRef(-1)
      /**
       * 已处理过的句子去重键（`${turnId}:${index}`）。
       *
       * 宿主重复广播同一条 sentence（重连补发、重复 emit）时不能让同一句重播。
       * 有界：超过 MAX_SEEN_SENTENCE_KEYS 就丢掉最早插入的（Set 保持插入顺序）。
       */
      const seenSentenceKeysRef = useRef(null)
      if (!seenSentenceKeysRef.current) seenSentenceKeysRef.current = new Set()
      /** 已发出的 reading-ack 条数（诊断用：宿主流控是否真的在跑）。 */
      const acksSentRef = useRef(0)
      /** 因**安全网裁剪**而被丢掉的句子数（诊断用；正常应为 0，>0 说明宿主流控失效）。 */
      const trimmedRef = useRef(0)
      /** 已提示过的引擎回退次数（避免每句都弹提示）。 */
      const ttsFallbackSeenRef = useRef(0)
      /**
       * 因**非裁剪**原因被丢掉的句子数（无 AudioContext 时清队列 / 管道异常退出剩的 inflight）。
       * 与 trimmed 分开计数：这两类丢弃与「宿主流控是否失效」无关，
       * 混在一起会让诊断误判（评审 P3）。
       */
      const droppedRef = useRef(0)

      const pendingSendTimerRef = useRef(null)
      // 生成期间说的话：先留在草稿，等这轮结束后自动发送
      const pendingAutoSendRef = useRef(false)
      /** 「助手忙完后自动发送」的定时器（不放 effect 里，避免被 cleanup 清掉）。 */
      const pendingAutoSendTimerRef = useRef(null)
      /**
       * 朗读进度回执：告诉宿主「这一句已经被消费（开始播 / 被跳过 / 被丢弃）」。
       *
       * 宿主的流控是「已发未确认句数 <= READ_ALOUD_LEAD(3)」：客户端每回执一条，
       * 宿主才补发下一句。所以**每一条收到的 sentence 最终都必须恰好回执一次** ——
       * 漏回执的话宿主会一直等到 watchdog（ACK_STALL_MS=10 秒）才继续，朗读明显变慢。
       *
       * 回执时机的分类：
       *   1. 开始播放前（decoded 有效、调 play 之前）—— 播放是串行且很长的
       *      （一句 2~3 秒），等播完才回执宿主会一直等我们；
       *   2. 句子被跳过（合成失败 / 超时 / 代次失效 / 播放上下文跳过）——
       *      不会出声，但配额必须归还；
       *   3. 入队前就被丢掉（去重命中 / 轮次不匹配 / 被静音 / 朗读开关已关）；
       *   4. 安全网裁剪、haltSpeaking 清队列 —— 按条数整批归还。
       *
       * `sessionId`/`turnId` 优先取**事件 payload 里的**：宿主的配额按
       * session+turn 记账，用本地 ref 在换轮边界上容易记错账。
       *
       * count 单次上限 64（宿主按 int 累加，防异常大数）；超过就分多批发。
       * 失败只忽略、不重试、不阻塞播放：宿主收不到回执会自己降级回 400ms
       * 时间窗口节奏（这也是老客户端的兼容路径）。
       *
       * `durationMs`（可选，仅 count=1 时有意义）：这一句的**真实音频时长**。
       * 宿主用它精确估算「正在播放的剩余时长」来算追赶预算；不传就退回按字数估算。
       *
       * @param {string} sessionId - 句子所属会话。
       * @param {string} turnId - 句子所属轮次（宿主按轮次记账）。
       * @param {number} [count] - 回执条数（默认 1）。
       * @param {number} [durationMs] - 真实音频时长（毫秒，可选）。
       */
      const ackReading = useCallback((sessionId, turnId, count = 1, durationMs = undefined) => {
        const total = normalizeAckCount(count)
        acksSentRef.current += total
        const sid = sessionId ?? ''
        const tid = turnId ?? ''
        const dur = Number(durationMs)
        const hasDur = total === 1 && Number.isFinite(dur) && dur > 0
        // 宿主的 count clamp 是 1..64：一次还更多必须自己拆成几条，
        // 否则被 clamp 掉的那部分配额永远还不回去（朗读越来越慢直到停住）。
        // 拆批的算术在 `pure/reading-ack.js`，判据在 `test/reading-ack-contract.test.mjs` 第 6 节。
        for (const n of ackBatches(total)) {
          try {
            void fetch(ROUTES.readingAck, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(hasDur
                ? { sessionId: sid, turnId: tid, count: n, durationMs: Math.round(dur) }
                : { sessionId: sid, turnId: tid, count: n }),
            }).catch(() => { /* 老宿主没有这个端点（404）→ 忽略，宿主会降级 */ })
          } catch { /* fetch 本身同步抛错（极少）：朗读不能因此中断 */ }
        }
      }, [])
      /**
       * 把一批**已入队但不会再播**的句子按 (sessionId, turnId) 分组回执。
       *
       * 用于：安全网裁剪 / haltSpeaking 清队列 / 管道异常退出。
       * 这些句子在宿主账上都是「已发未确认」，不回执宿主会等 watchdog（10 秒）。
       * 按句子自己的 sessionId/turnId 记账（宿主按 session+turn 计数）——
       * turn-begin 里会先换轮次再清队列，用 currentTurnIdRef 会记到新轮上。
       *
       * @param {Array<{sessionId?: string, turnId?: string}>} items - 被丢弃的队列项。
       * @returns {number} 实际回执条数（拿不到 sessionId/turnId 的项跳过）。
       */
      const ackDroppedItems = useCallback((items) => {
        if (!Array.isArray(items) || !items.length) return 0
        const groups = new Map()
        for (const item of items) {
          const sid = item?.sessionId || sessionIdRef.current || ''
          const tid = item?.turnId || currentTurnIdRef.current || ''
          // 拿不到 sessionId/turnId 就不回执：宿主下一轮会重置，硬回执反而记错账。
          if (!sid || !tid) continue
          const key = sid + '\u0000' + tid
          const group = groups.get(key)
          if (group) group.count += 1
          else groups.set(key, { sid, tid, count: 1 })
        }
        let acked = 0
        for (const group of groups.values()) {
          ackReading(group.sid, group.tid, group.count)
          acked += group.count
        }
        return acked
      }, [ackReading])
      /**
       * 停止并清空所有正在进行的朗读。
       * 同一时刻只能有一个朗读在播，否则新旧内容会重叠。
       *
       * 清队列时必须把清掉的条数回执掉（见 ackDroppedItems）：
       * 那些句子在宿主账上是「已发未确认」，不回执宿主会等 watchdog。
       *
       * @param {boolean} clearQueue - 是否同时清空待播队列。
       */
      const haltSpeaking = useCallback((clearQueue = true) => {
        speakGenRef.current += 1
        // 正在播的段落一并失效：裁剪保护不能指向一段已经不播的内容。
        playingParaRef.current = -1
        if (clearQueue) {
          const pending = speakQueueRef.current
          if (pending.length) {
            // 先留一份给回执（清空后原数组内容就没了），再清空队列。
            const dropped = pending.slice(0)
            speakQueueRef.current.length = 0
            ackDroppedItems(dropped)
          }
        }
        // 停掉**所有**正在播的源。
        //
        // 以前只调 speakCancelRef 这一个句柄，而它有两个漏：
        //   1. 「上一句刚播完、下一句还没开始」的空隙里它是 null；
        //   2. 更早那一句的 onended 会把它清成 null。
        // 这两种时刻点点「停止朗读」都停不掉真正在响的东西 ——
        // 表现就是「停止总停止不了正在进行的朗读」。
        // 登记所有活着的源，逐个停掉，就不会再漏。
        const sources = speakSourcesRef.current
        for (const source of [...sources]) {
          try { source.stop() } catch { /* 忽略 */ }
        }
        sources.clear()
        const cancel = speakCancelRef.current
        speakCancelRef.current = null
        try { cancel?.() } catch { /* 忽略 */ }
        speakingRef.current = false
        setSpeaking(false)
        // 朗读被打断/停止/新一轮：同步清掉高亮。
        readingHighlightRef.current?.clear()
      }, [ackDroppedItems])
      /** 我们最后一次写进草稿的内容：用来区分「我们的残留」和「用户自己打的字」。 */
      const lastWrittenRef = useRef('')

      /* ================= 朗读高亮（覆盖层，不碰消息 DOM） ================= */

      /**
       * 「正在朗读的文本」高亮控制器。
       *
       * 为什么用**覆盖层**而不是给消息里的文本节点包 `<mark>`：
       *   消息是 React 渲染的。给 React 管理的文本节点 `splitText()` 再插入
       *   我们自己的元素，会留下 React 不知道的孤儿节点 —— 一旦 React 因为
       *   流式更新重渲染那条消息（朗读期间内容仍在增长），它只更新自己引用
       *   的文本节点，我们插进去的高亮节点就成了**残留**，表现为文字重复、
       *   消息流被弄乱 —— 正是需求里「不影响消息流」要避免的。
       *
       *   所以这里**完全不碰消息 DOM**：用 `Range.getClientRects()` 拿到
       *   命中文本的**视口矩形**，在 `position:fixed` 的覆盖层里画几个
       *   半透明色块垫在文字下面。文字节点一个都不动，React 完全不受影响。
       *
       *   覆盖层是 `fixed`，滚动/缩放会错位，所以滚动时用 rAF 节流重算矩形。
       */
      const readingHighlightRef = useRef(null)
      if (!readingHighlightRef.current) {
        readingHighlightRef.current = createReadingHighlight(win, {
          // 显式注入 pure/highlight.js 的对齐函数（工厂在 pure/reading-highlight.js）。
          // 不靠内联顺序隐式可见 —— 引用只允许从 main.js 指向 pure，不能反向。
          matchInNodes,
          collapseWhitespace,
          unescapeSpeechText,
        })
      }

      // 定时器登记表：本组件所有定时器都登记在这里，
      // 状态复位时按 group 清，卸载时全清。
      const timersRef = useRef(null)
      // 登记表要拿到 window：源文件是纯函数（不直接依赖浏览器全局），
      // 这样测试能在 Node 里原生 import 它。
      if (!timersRef.current) timersRef.current = createTimerRegistry(win)
      const timers = timersRef.current

      const configRef = useRef(configStore.value)
      /**
       * 全局语音浮层是否开启（决定输入框麦克风是否让位）。
       *
       * 需要 state 而不是只读 ref：浮层是另一个组件，用户一开全局语音，
       * 这个按钮要**立刻**消失（不能等下一次开麦/别的状态变化才重渲染）。
       */
      const [globalVoiceOn, setGlobalVoiceOn] = useState(configRef.current?.globalVoice === true)

      /**
       * 从宿主拉一次配置并合并进 configRef。
       *
       * 合并规则：宿主返回的是「发起请求那一刻」的快照，
       * 共享存储（configStore）里的是用户**刚保存**的值 —— 后者更新，优先。
       *
       * 以前是「configStore.loaded 为 true 就把这次 fetch 的结果整份丢掉」。
       * 那会挖出一个洞：
       *   「设置面板先加载过（loaded=true）→ 麦克风按钮后挂载」
       *   → 麦克风按钮挂载时那次 fetch 回来什么都不写
       *   → configRef 永远停在默认值（readAloud=false）
       *   → 勾了「朗读回复」也不出声，且全程没有任何报错。
       * 合并之后：存储里有值的键以存储为准，其余用宿主这份补齐 ——
       * 两个问题（读到旧快照 / 永远读不到）同时消失。
       *
       * @returns {Promise<boolean>} 是否成功拿到配置。
       */
      const syncConfig = useCallback(async () => {
        try {
          const resp = await fetch(ROUTES.config)
          if (!resp.ok) return false
          const data = await resp.json()
          if (!data || typeof data !== 'object') return false
          configRef.current = { ...data, ...configStore.value }
          setGlobalVoiceOn(configRef.current.globalVoice === true)
          return true
        } catch {
          return false
        }
      }, [])

      // 配置同步：从宿主拉取真实配置，并订阅共享存储的变化。
      // 少了这一步，configRef 永远是默认值（readAloud: false），
      // 于是「朗读回复」永远不触发 —— 也就是「对话没声音」。
      useEffect(() => {
        let alive = true
        /**
         * 拉配置，失败就重试。
         *
         * 只拉一次的话：宿主刚启动、或者网络抖一下，
         * configRef 就永远停在默认值 ——
         * 「朗读回复」勾了也不出声，而且界面上没有任何提示。
         */
        const pull = async (attempt = 0) => {
          if (!alive) return
          const ok = await syncConfig()
          if (ok || !alive || attempt >= 2) return
          timers.timeout('config-retry', () => { void pull(attempt + 1) }, 800 * (attempt + 1), 'config')
        }
        void pull()
        const unsubscribe = configStore.subscribe((next) => {
          if (alive && next) configRef.current = next
          if (alive && next) setGlobalVoiceOn(next.globalVoice === true)
        })
        return () => { alive = false; timers.clear('config-retry'); unsubscribe() }
      }, [syncConfig, timers])

      // 开麦时再对一次配置。
      // 挂载时那一次可能失败（宿主还没起来），而这一次的失败是静默的 ——
      // 于是「朗读回复」勾着也不出声。重新对一次就把它补回来了。
      useEffect(() => {
        if (!on) return undefined
        void syncConfig()
        return undefined
      }, [on, syncConfig])


    /**
     * 草稿归属与合并（纯函数）。
     *
     * 草稿由三段组成：
     *   base      —— 用户开麦前自己输入的内容
     *   committed —— 已经识别完成的各段语音
     *   segment   —— 当前这一段的实时字
     *
     * 但这三段只是「我们以为输入框里的内容」。
     * 用户手动删掉一段之后，那份记录就过期了 ——
     * 再拼一次就会把用户刚删掉的字原样塞回去。
     */




      /**
       * 把三段内容组合成最终草稿并写入输入框。
       *
       * 为什么要分三段：
       *   userBase   —— 用户开麦前自己输入的内容（一直保留）
       *   committed  —— 已经识别完成的各段语音（累积，不能互相覆盖）
       *   segment    —— 当前这一段的实时字（会被下一段替换）
       *
       * 之前只用一个 baseDraftRef 同时表示「用户已有内容」和「本轮语音内容」，
       * 写完第一段就把它清空，于是第二段会把整个草稿覆盖掉 ——
       * 用户手打的内容和第一段的识别结果一起消失。
       */
      const composeDraft = useCallback(() => {
        // 只做拼接。用户手动改过草稿的检测在 syncUserEdit() 里，
        // 必须在写入新内容**之前**做 ——
        // 放在这里的话，判定为「改过」会把刚识别到的新内容也清掉。
        const merged = mergeDraft({
          base: baseDraftRef.current,
          committed: committedRef.current,
          segment: segmentRef.current,
        })
        baseDraftRef.current = merged.base
        committedRef.current = merged.committed
        segmentRef.current = merged.segment
        const out = merged.out
        try {
          if (typeof inputActions?.setDraft === 'function') {
            inputActions.setDraft(out)
            lastWrittenRef.current = out
          }
        } catch { /* 忽略 */ }
        return out
      }, [inputActions])

      /**
       * 临时提示。
       *
       * 状态行是内联在按钮旁边的，放长句会把整行挤开（界面位置跟着跳），
       * 所以这里只显示**短词**，完整说明交给 detail ——
       * 鼠标悬停在状态文字上就能看到（title 属性）。
       *
       * @param {string} value - 短提示。
       * @param {string} [detail] - 完整说明（悬停可见）。
       */
      const setHint = useCallback((value, detail = '') => {
        setHintState(value ?? '')
        setHintDetailState(detail ?? '')
        // timers.timeout 同名会先清掉旧的那一个，所以不需要在这里自己 clearTimeout。
        if (value) timers.timeout('hint', () => { setHintState(''); setHintDetailState('') }, 2500, 'ui')
      }, [])

      /* ================= 调试快照 ================= */

      // 把关键状态挂到 window 上，方便在浏览器控制台里查问题。
      //
      // 这个插件出过好几次「不报错、只是没效果」的问题，
      // 没有可观测性就只能靠猜。
      //
      // 用法（浏览器控制台）：
      //   __DSH_VOICE_DEBUG__()          看当前状态
      //   __DSH_VOICE_DEBUG__().timers   看还挂着哪些定时器
      useEffect(() => {
        // 没有 window 就跳过（SSR / 纯 Node 测试环境）。
        // 注意：不能检查 win.__DSH_VOICE_DEBUG__ === undefined ——
        // 那个属性正是我们要注册的，注册前当然是 undefined。
        if (!win) return undefined
        const debugSnapshot = () => ({
          on: onRef.current,
          // 「正在开麦」的标志：开麦失败时它必须被复位，否则界面永远停在「准备中」，
          // 下一次点按钮会被当成「取消」而不是「重试」（test/client-behavior 的开麦场景钉住这条）。
          starting: startingRef.current,
          // 「开麦没过去」的原始原因（`__DSH_VOICE_DEBUG__().lastAsrReadyReason`）：
          // 宿主回的原因码原样，请求根本没回来时是 `error: <异常消息>`。
          // 界面那句话不由它出（批次 18，docs §8.60），这里只保证原始信息不丢。
          lastAsrReadyReason: lastAsrReadyReasonRef.current,
          speaking: speakingRef.current,
          muted: mutedTurnIdRef.current,
          turnId: currentTurnIdRef.current,
          hearing: hearingRef.current,
          recognizing: recognizingRef.current,
          assistantRunning: assistantRunningRef.current,
          pendingAutoSend: pendingAutoSendRef.current,
          queue: speakQueueRef.current.length,
          // 还在册的播放源个数（播完/停止都会摘掉）。
          // 「按了停止却还有声音」与「源登记越积越多」都先看它：
          // 停止是对在册的每一个源下手的，非零就说明有源没被摘干净。
          playSources: speakSourcesRef.current.size,
          // 安全网裁剪靠的这个「正在播的段落」保护值（-1 = 当前没有）。
          // 排查「一段只念了第一句」与「裁剪少丢了几句」都要先看它：
          // 管道结束/停止朗读之后它必须回到 -1，残留成旧段号会让裁剪保护错段落。
          playingPara: playingParaRef.current,
          gen: speakGenRef.current,
          draft: (draftRef.current ?? '').slice(0, 80),
          config: {
            readAloud: configRef.current?.readAloud,
            autoSend: configRef.current?.autoSend,
            mode: configRef.current?.mode,
          },
          // 下面几项是为了诊断「宿主说不忙、客户端说忙」这类不一致：
          //   live  —— SSE 到底连上了没（连上了就不轮询 /busy 了）
          //   sid   —— 客户端认为的会话 id（用来核对事件归属）
          //   busyLog —— 最近几条「忙」状态来源（事件 / 轮询），含是否被会话过滤
          live: liveConnectedRef.current,
          sid: sessionIdRef.current,
          busyLog: busyLogRef.current.slice(0, 8),
          timers: timers.ids(),
          // 客户端侧语音合成失败次数（「朗读没声」先看它）。
          ttsFailures: ttsFailuresRef.current,
          // 播放阶段因上下文无法恢复而被跳过的句子数（合成成功但没播出来）。
          playSkipped: playSkippedRef.current,
          // 朗读流控（reading-ack）：ack 是宿主补发下一句的凭据。
          //   acks    —— 已发出的回执条数（为 0 而宿主一直发来句子 → 流控没跑）
          //   trimmed —— **安全网裁剪**掉的句数（正常应为 0；>0 说明宿主流控失效）
          //   dropped —— 其它原因丢掉的句数（无 AudioContext 清队列 / 管道异常剩余，
          //              与流控无关；排查时别和 trimmed 混为一谈）
          acks: acksSentRef.current,
          trimmed: trimmedRef.current,
          dropped: droppedRef.current,
          // 引擎回退（/tts 响应头）：发生次数 / 最近一次回退目标 / 实际引擎。
          // 本地失败会静默回退在线（文本发给微软），排查「以为在离线」先看这里。
          ttsFallbacks: playCore.ttsFallbacks,
          lastTtsFallback: playCore.lastTtsFallback,
          lastTtsEngine: playCore.lastTtsEngine,
          // 播放上下文的真实状态（「朗读中但没声音」最需要的三项）：
          //   audioState —— running / suspended / closed（suspended 就播不出声）
          //   audioRate  —— 实际协商到的采样率
          //   audioError —— 构造/恢复失败的原因（例如设备不支持被我们指定的采样率）
          audioState: playCore.audioState,
          audioRate: playCore.audioRate,
          audioError: playCore.audioError,
          // 最近一次朗读失败的具体原因（HTTP 状态码 + 服务端错误正文）。
          lastTtsError: playCore.lastTtsError,
          // 朗读高亮的诊断（排查「明明在朗读、界面上却没有高亮」）。
          // 字段含义见 createReadingHighlight 里的 diag。
          readingHighlight: readingHighlightRef.current?.getState?.() ?? null,
        })
        win.__DSH_VOICE_DEBUG__ = debugSnapshot
        return () => {
          // 卸载时清场，但要认「现在挂着的还是不是我」：
          // React 严格模式/快速重挂载时，旧实例的 cleanup 可能在新实例注册**之后**才跑，
          // 无脑清会把新实例的快照一起抹掉。注入的 win 上这些 __DSH_ 通道是转发到
          // 真实 window 的（见 main.js 的 winShim Proxy），所以赋值和删除都能透传，
          // 用赋 undefined 是为了语义清楚：通道还在，只是当前没有实例占着。
          try {
            if (win.__DSH_VOICE_DEBUG__ === debugSnapshot) win.__DSH_VOICE_DEBUG__ = undefined
          } catch { /* 忽略 */ }
        }
      }, [timers])

      /* ================= 麦克风 ================= */

      /**
       * 把新增音频喂给流式解码器，取回实时文字。
       *
       * 与「整段重识别」的区别：只喂**新增**的那部分，
       * 解码器自己保留上下文 —— 于是实时字的延迟不随段长增长。
       *
       * @param {Float32Array} samples - 16kHz 单声道，新增部分。
       * @returns {Promise<string>} 实时文字；失败返回空串。
       */
      const feedStream = useCallback(async (samples) => {
        const sid = streamSessionIdRef.current
        if (!sid || !samples.length) return ''
        try {
          const resp = await fetch(`${ROUTES.asrStream}?sessionId=${encodeURIComponent(sid)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength),
          })
          if (!resp.ok) return ''
          const data = await resp.json().catch(() => null)
          if (data?.unavailable) {
            // 流式模型不可用 → 关掉流式，退回整段重识别
            streamLiveRef.current = false
            return ''
          }
          return String(data?.text ?? '').trim()
        } catch {
          return ''
        }
      }, [])

      /**
       * 结束流式会话并丢弃解码状态。
       *
       * 必须在断句和关麦时调用 ——
       * 否则解码器会留着上一段的状态，下一段的识别会被污染。
       *
       * @returns {Promise<void>} 结束。
       */
      const resetStream = useCallback(async () => {
        const sid = streamSessionIdRef.current
        streamSessionIdRef.current = ''
        streamFedRef.current = 0
        if (!sid) return
        try {
          await fetch(`${ROUTES.asrStreamReset}?sessionId=${encodeURIComponent(sid)}`, { method: 'POST' })
        } catch { /* 忽略 */ }
      }, [])

      const closeMic = useCallback(() => {
        recorderActiveRef.current = false
        const mic = micRef.current
        if (mic) {
          try { if (mic.processor) { mic.processor.onaudioprocess = null; mic.processor.disconnect() } } catch { /* 忽略 */ }
          micDevice.closeAudioContext(mic.ctx)
          micDevice.releaseStream(mic.stream)
        }
        micRef.current = null
        // 关麦 = 麦克风这一组的状态复位。
        // 用登记表按 group 清，而不是逐个 ref 清 —— 逐个清总会漏一个
        // （「助手忙完后自动发送」的定时器就是这么漏的，
        //   结果关麦后草稿自己发出去）。
        timers.clearGroup('mic')
        // 流式解码器是有状态的：不丢弃的话，它的上下文会带到下一轮。
        void resetStream()
      }, [timers, resetStream])

      /**
       * 停止聆听（麦克风、识别、草稿基准）。
       *
       * 与 stopPlayback 分开，是因为这两件事**语义不同**：
       *   聆听 —— 「我在不在听你说话」
       *   朗读 —— 「我要不要听它念回复」
       * 之前它们绑在一起（点麦克风按钮 = 关麦 + 停朗读），
       * 于是「停止朗读但继续听」做不到，
       * 而且 once 模式「说完就关麦」会顺手把这一轮的朗读也清掉。
       */
      const stopListening = useCallback(() => {
        closeMic()
        chunksRef.current = []
        segStartRef.current = 0
        livePartialRef.current = ''
        hearingRef.current = false
        recognizingRef.current = false
        // 这里**不能**动朗读轴（speakingRef / setSpeaking）。
        // 朗读轴归 stopPlayback 管 —— 两轴正交，关麦不该让界面显示的
        // 「朗读中」消失（那时可能正在朗读）。
        //
        // 也不该调 win.speechSynthesis.cancel()：
        // 本插件根本不用 Web Speech API，
        // 调它会顺手取消**页面上其它组件**正在进行的系统语音朗读。
        // 草稿相关的状态必须一起清干净。
        // 不清的话下次开麦时基准还是旧值，新识别的结果会拼上旧内容 ——
        // 这就是「自动出现旧数据、还删不掉」的来源。
        baseDraftRef.current = ''
        committedRef.current = ''
        segmentRef.current = ''
        lastWrittenRef.current = ''
        pendingAutoSendRef.current = false
        timers.clearGroup('send')
        // 「助手忙完后自动发送」的定时器也必须清。
        // 它之前只在组件卸载时被清 —— 于是用户关掉麦克风之后，
        // 这个定时器照样会在 400 毫秒后触发，把草稿**自动发出去**。
        // 用户明明已经停了对话，草稿却自己跑掉了。
        if (pendingAutoSendTimerRef.current) {
          win.clearTimeout(pendingAutoSendTimerRef.current)
          pendingAutoSendTimerRef.current = null
        }
        // 提示定时器：这里原先有一段「同理清掉」的写法，但它判的 hintTimerRef 从来是 null，
        // 于是那两行一直是空转（批次 9 删除）。要不要真取消它是个**行为问题**：
        // 'hint' 那条定时器的回调做的是「把提示收回去」，取消它反而会让提示一直挂在屏幕上。
        // 所以状态复位时不取消它，让它照常把上一轮的提示收掉。
        // 噪音基准：下一轮重新测，别拿上一轮的旧值当基准
        noiseFloorRef.current = INITIAL_GATE_STATE.noiseFloor
      }, [closeMic])

      /**
       * 停止朗读：清空队列 + 停掉正在播的 + 标记本轮不再朗读。
       *
       * 「本轮不再朗读」是为了解决「我明明点击了麦克风按钮停止朗读，
       * 为什么等一会儿之后他又开始朗读了」——
       * SSE 连接是常驻的，停止之后新到的句子会继续入队，
       * 除非用这个标记拦住。
       */
      const stopPlayback = useCallback(() => {
        // 必须清空队列，否则 pumpQueue 的循环条件
        // （inflight.length || 队列长度）仍然成立，会把剩下的句子接着播完 ——
        // 这就是「点了停止按钮还在朗读」的原因。
        haltSpeaking(true)
      }, [haltSpeaking])

      /** 停止聆听 + 停止朗读（卸载、异常清理等「全部收摊」的场合）。 */
      const stopAll = useCallback(() => {
        stopListening()
        stopPlayback()
      }, [stopListening, stopPlayback])

      /* ================= 识别：取当前段，交 worker ================= */

      const transcribeSegment = useCallback(async () => {
        // 上一段还没识别完：直接返回，不动任何状态。
        // 音频会留在缓冲区里（segStart 没推进），等这次识别完再一起处理，
        // 既不会丢话，也不会出现两段识别互相覆盖草稿。
        if (recognizingRef.current) return
        recognizingRef.current = true
        // keptPartial 必须在 try 外面取：
        // catch 分支要用它来保留「已经识别出来的那部分」。
        // 定义在 try 块内部的话，catch 里会抛 ReferenceError，
        // 把真正的错误原因盖掉。
        const keptPartial = livePartialRef.current
        livePartialRef.current = ''
        try {
          const chunks = chunksRef.current.slice(segStartRef.current)
          if (!chunks.length) return
          // 裁剪已识别过的音频，防止 chunksRef 无限增长（长时间开麦会吃满内存）。
          // 注意顺序：先取出本段 chunks，再裁数组，最后把起点归位。
          if (segStartRef.current > 64) {
            chunksRef.current = chunksRef.current.slice(segStartRef.current)
            segStartRef.current = 0
          }
          segStartRef.current = chunksRef.current.length
          // hearingRef 要等识别真正开始后才置 false，
          // 否则「新段开始」分支会在识别中途被触发，把基准覆盖错。
          const samples = resampleTo16k(mergeChunks(chunks), normalizeSourceRate(micRef.current?.ctx?.sampleRate))

          // 段已切走，现在可以安全地开始下一段了
          hearingRef.current = false

          // 必须有超时：请求挂住时 recognizingRef 会一直是 true，
          // 之后所有识别都被直接跳过，麦克风彻底失聪，只能关掉重开。
          const ctrl = new AbortController()
          timers.timeout('transcribe-abort', () => ctrl.abort(), TRANSCRIBE_TIMEOUT_MS, 'request')
          let resp
          try {
            resp = await fetch(ROUTES.transcribe, {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength),
              signal: ctrl.signal,
            })
          } finally {
            // 清掉超时定时器。
            // 注意：这里**不能**用 win.clearTimeout(timer) ——
            // 那个写法是改造前的：超时定时器已经改用登记表
            // （timers.timeout('transcribe-abort', ...)），
            // 变量名 timer 根本不存在 → ReferenceError。
            //
            // 后果很隐蔽：异常从 try 抛出，被外层 catch 接住，
            // 而 catch 里又要用 keptPartial（定义在 try 块内部，取不到）
            // → 又抛一次 → **识别之后的整段逻辑都没执行**
            //   （包括「自动发送」）。
            // 症状是「文字出现在输入框里，但永远不自动发送」。
            timers.clear('transcribe-abort')
          }
          const data = await resp.json().catch(() => null)
          const text = ((data && data.text) || '').trim()

          if (!text) {
            // 没识别出字：把我们写进草稿的实时字剥掉，还原成录音起点。
            // 但只有「确认是静音」才回滚；如果主机判定有人说话（speech=true）
            // 却识别不出来，保留实时字，别让用户说的话凭空消失。
            // 只回滚「当前段」，已完成的各段和用户手打的内容都要保留。
            const reallySilent = data?.speech !== true
            if (reallySilent) {
              segmentRef.current = ''
              composeDraft()
            }
            if (data?.speech === true) setHint(t('empty'), t('emptyDetail'))
            return
          }

          // 写入草稿之前，先同步用户的手动修改。
          //
          // 三段内容只是「我们以为输入框里的内容」。用户手动删掉一段之后，
          // 那份记录就过期了 —— 再拼一次就会把用户刚删掉的字原样塞回去。
          //
          // 关键：这一步必须在**写入新内容之前**做。
          // 如果放到合并里，一旦判定为「用户改过」，
          // 就会把刚识别到的这一段也清掉 —— 用户删掉一段之后，
          // 接下来识别到的句子会凭空消失。
          const synced = syncUserEdit({
            base: baseDraftRef.current,
            committed: committedRef.current,
            current: draftRef.current,
            ours: lastWrittenRef.current,
          })
          baseDraftRef.current = synced.base
          committedRef.current = synced.committed
          // 这一段识别完成，累积到 committed（不清空其它内容）
          committedRef.current = committedRef.current
            ? (committedRef.current + ' ' + text).trim()
            : text
          segmentRef.current = ''
          composeDraft()

          // 自动发送：助手忙 → 留在草稿；助手闲 → 自动发送
          if (configRef.current.autoSend !== false) {
            // 先取消上一段挂着的发送定时器：
            // 不取消的话，两次识别间隔若短于 1.2 秒，会触发两次 submit。
            if (pendingSendTimerRef.current) {
              win.clearTimeout(pendingSendTimerRef.current)
              pendingSendTimerRef.current = null
            }
            // 用 ref 而不是 state：这段代码是被 VAD 定时器调用的，
            // 定时器闭包里捕获的是创建时的 transcribeSegment，
            // 读 state 会拿到过期值（助手状态早就变了却还按旧的判断）。
            if (assistantRunningRef.current) {
              // 生成期间说的话：先留在草稿，等这一轮结束后自动发送。
              pendingAutoSendRef.current = true
              // **必须**把可能存在的发送定时器清掉。
              //
              // 两条发送通路原本用两个不同的定时器 id：
              //   pending-send      —— 助手闲时，1200ms 后发
              //   pending-auto-send —— 助手忙完后，400ms 后发
              // 两者互不取消，于是可以同时存在 →
              //   同一段话被 submit 两次（用户看到「已经发出去的消息又出现」）。
              //
              // 助手从「闲」变「忙」时尤其容易撞上：
              //   先设了 pending-send → 助手开始生成 → 又走了忙的分支
              //   → pending-send 照常触发，助手忙完 effect 又触发一次 → 发两遍。
              //
              // 现在两条通路共用同一个 id，谁后设谁覆盖前一个。
              timers.clear('pending-send')
            } else {
              const autoSendExtraMs = configRef.current.autoSendExtraMs ?? 1200
              // 同上：两条发送通路共用一个 id，先清掉另一个。
              timers.clear('pending-auto-send')
              timers.timeout('pending-send', () => {
                pendingSendTimerRef.current = null
                try { inputActions?.submit?.() } catch { /* 忽略 */ }
                // once 模式：说完一句就退出语音模式
                if ((configRef.current.mode ?? 'toggle') === 'once') {
                  onRef.current = false
                  setOn(false)
                  // once 的语义是「说完一句就退出**聆听**」。
                  // 之前调的是 stopAll()，会连朗读一起清掉 ——
                  // LLM 响应够快时（< 1.2 秒），刚入队的第一句就被清掉，
                  // 表现是「这一轮一句都读不出来」。
                  stopListening()
                }
                // 不要主动清空输入框：submit() 成功后 composer 自己会清，
                // 我们抢着清只会把还没被消费的内容抹掉（文字丢失就是这么来的）。
                // 这里只重置「我们自己的」记账，不碰草稿内容。
                baseDraftRef.current = ''
                committedRef.current = ''
                segmentRef.current = ''
                lastWrittenRef.current = ''
              }, autoSendExtraMs, 'send')
            }
          }
        } catch (error) {
          // 识别请求失败（网络断、宿主重启等）：绝不能静默丢弃。
          // 之前这里直接 /* 忽略 */，用户说的话就凭空消失了。
          // 现在把实时字保留在草稿里，并提示失败原因。
          // 识别请求失败：至少把已经识别出来的那部分留在输入框
          const partial = (keptPartial || '').trim()
          if (partial) {
            segmentRef.current = partial
            composeDraft()
          }
          setHint(t('recognizeFailed'), t('recognizeFailedDetail'))
        } finally {
          recognizingRef.current = false
        }
      }, [inputActions, t, stopAll])

      /* ================= 朗读 ================= */



      /**
       * 消费朗读队列：逐句取出 → 合成 → 播放。
       * 与 speak() 共用代次：任何新的朗读回合都会让队列里旧句作废。
       */
      const pumpQueue = useCallback(async () => {
        if (pumpingRef.current) return
        // 队列是空的就不要把状态设成「朗读中」。
        // 之前是无条件 setSpeaking(true)，于是：
        //   用户点停止 → 队列清空 → 但 pumpQueue 又被调用了一次（比如新句子刚到）
        //   → 先闪一下「朗读中」，再在 finally 里改回 false。
        // 界面上就是「我明明停了，它又显示朗读中」。
        if (!speakQueueRef.current.length) return
        pumpingRef.current = true
        speakingRef.current = true
        setSpeaking(true)
        // 播放上下文在 try 里再取：构造 AudioContext 可能抛错（部分设备对
        // 固定 sampleRate 不买账）。若在 try 之外取，异常会让 pumpingRef 卡在
        // true，之后所有句子入队却永不播放（永久死锁）。在 try 里取则异常
        // 被 finally 接住、复位 pumpingRef，队列不会卡死。
        let playCtx = null
        /** 合成一句并解码；失败返回 null。 */
        const synth = async (sentence, gen) => {
          let url = null
          try {
            url = await playCore.fetchSpeech(sentence)
            // 代次已失效（被打断）：合成出来的音频不会再播，直接丢掉，
            // 省下一次解码开销，也避免旧内容混进新一轮。
            if (gen !== speakGenRef.current) return null
            const bytes = await (await fetch(url)).arrayBuffer()
            if (gen !== speakGenRef.current) return null
            const decoded = await playCtx.decodeAudioData(bytes.slice(0))
            return decoded
          } catch {
            // 合成失败：这一句被静默跳过 —— 用户只看到「没声音」。
            // 必须留下痕迹（计数 + 节流提示），否则没法定位。
            ttsFailuresRef.current += 1
            const now = Date.now()
            if (now - lastTtsFailHintAtRef.current > 4000) {
              lastTtsFailHintAtRef.current = now
              setHint(t('ttsFailed'), t('ttsFailedDetail'))
            }
            return null
          } finally {
            // 无论成功失败都释放 object URL，避免每个失败句子泄漏一个。
            if (url) { try { URL.revokeObjectURL(url) } catch { /* 忽略 */ } }
          }
        }
        /** 播放一段已解码音频。 */
        const play = async (decoded, gen) => {
          // 代次检查：被 haltSpeaking 打断后，已经合成好的音频不能再播出来，
          // 否则「打断」之后还会冒出最多 3 句旧内容（听起来像没打断干净）。
          //
          // 之前这里不看代次，是为了避免「内容被静默丢弃」——
          // 那个问题的真因是宿主在每次 llm/stream 调用都广播回合开始事件，
          // 导致代次在工具调用之间被刷新。现在宿主只在真正的新一轮才广播，
          // 代次就只会在「用户发起新一轮」「用户插话」「关闭朗读」时变化，
          // 此时丢弃旧音频正是想要的。
          if (gen !== speakGenRef.current) {
            // 代次已失效（被打断 / 换轮）：这句不会出声。
            // 它是「被跳过」，要留痕 —— 以前静默 return，诊断里看不出来。
            playSkippedRef.current += 1
            return
          }
          if (!decoded) return
          // 播放上下文可能因浏览器自动播放策略而处于 suspended。
          // 之前 getPlayCtx() 里 resume() 是**发后不管**的（.catch(() => {})），
          // 而 resume() 是异步的 —— 若上下文还没 resume 完就 source.start(0)，
          // 音频会一直排队不响，onended 永不触发，play() 的 promise 永不 resolve，
          // 整个朗读管道卡死：speaking 恒为 true、**没有声音**。
          //
          // 这里在 source.start(0) 前等上下文变成 running。注意：**不能**因为
          // resume 没在 1 秒内完成就跳过这一句 —— 用户已经触发朗读（有交互），
          // resume 稍慢（等浏览器授权）也会成功，跳过会让「每句都被静默丢弃」
          // 而 /tts 却一直调用（听着像「在合成但没声音」）。
          // 所以这里**轮询等待**到 running，最多等 8 秒；只有彻底失败才跳过，
          // 并留下可观测的跳过计数（__DSH_VOICE_DEBUG__().playSkipped）。
          try {
            if (playCtx.state === 'suspended') {
              const deadline = Date.now() + 8000
              // 先发一次 resume，再轮询。
              try { await playCtx.resume() } catch { /* 可能被拒，继续轮询 */ }
              while (playCtx.state === 'suspended' && Date.now() < deadline) {
                // 等 resume 的最多 8 秒里，用户可能点了「停止朗读」、插话或换了
                // 新一轮（gen 变了）：必须立刻退出，绝不能再把旧句子 start 出去
                // （点停止本身就是手势，往往让 resume 随后成功 → 旧内容照播，评审 P2）。
                if (gen !== speakGenRef.current) break
                await sleep(win, 100)
                if (playCtx.state === 'suspended') {
                  try { await playCtx.resume() } catch { /* 继续 */ }
                }
              }
            }
            // resume 等待结束后**再查一次代次**：进入 play 时 gen 还是有效的，
            // 但等 resume 的这几秒里可能已被 halt/换轮；不查就会把旧句子播出来。
            if (gen !== speakGenRef.current) {
              playSkippedRef.current += 1
              return
            }
            // 仍然挂起：自动播放策略彻底拒绝（无任何手势 / 浏览器禁止）。
            // 跳过这一句，但留下计数，别再「无声却查不到原因」。
            if (playCtx.state === 'suspended') {
              playSkippedRef.current += 1
              return
            }
          } catch {
            playSkippedRef.current += 1
            return
          }
          await new Promise((resolve) => {
            const source = playCtx.createBufferSource()
            source.buffer = decoded
            source.connect(playCtx.destination)
            let settled = false
            // 登记这个源：停止朗读时靠它把声音切断。
            speakSourcesRef.current.add(source)
            /** 停掉这一个源。 */
            const cancelOne = () => { try { source.stop() } catch { /* 忽略 */ } }
            const finish = () => {
              if (settled) return
              settled = true
              speakSourcesRef.current.delete(source)
              // 只有「我还是当前那个取消句柄」时才清空。
              // 以前是无条件清空 —— 上一句的 onended 晚到时会把
              // **下一句**的句柄一起清掉，于是「停止朗读」找不到在响的源。
              if (speakCancelRef.current === cancelOne) speakCancelRef.current = null
              // 兜底定时器要跟着这一句一起清掉。
              timers.clear('speak-end')
              resolve()
            }
            speakCancelRef.current = cancelOne
            source.onended = finish
            try { source.start(0) } catch { finish() }
            // **onended 兜底**：onended 并不保证一定触发 ——
            // 音频设备被独占、Electron 的 AudioContext 在切设备/静音时、
            // 或者 start() 成功但音频根本没被调度，它都可能永不回调。
            // 那时 `play()` 永不返回 → pumpingRef 卡 true → speaking 恒为 true、
            // 队列清空、**后面一句都播不出来**（实测快照就是
            // speaking=true / queue=0 / ttsFailures=0）。
            // 所以按音频真实时长算一个上限，到点就当作播完，继续下一句。
            //
            // 播放本身是串行的（pumpQueue 一句接一句 await），
            // 同一时刻只有一句在播，所以用固定 id 不会互相踩。
            if (!settled) {
              const durMs = Math.max(1000, Math.ceil((Number(decoded?.duration) || 0) * 1000))
              timers.timeout('speak-end', finish, durMs + 3000, 'speak')
            }
          })
        }
        try {
          // 在 try 里取播放上下文：构造 AudioContext 可能抛错（部分设备对
          // 固定 sampleRate 不买账）。若在 try 之外取，异常会让 pumpingRef
          // 卡在 true → 之后所有句子只入队不播（永久死锁）。这里取到 null
          // 就整体退出，finally 复位 pumpingRef，管道不会卡死。
          playCtx = playCore.getPlayCtx()
          if (!playCtx) {
            // 拿不到播放上下文 = 这一轮不可能出声。
            //
            // 绝不能只 `return` 了事：finally 里「队列非空 → 再 pumpQueue()」
            // 会在队列完全不消耗的情况下**同步互递归**（每轮递归都把队列
            // 原样带回来），一路打到栈溢出，随后 speaking 卡 true、队列再也
            // 不消费 —— 表现是「朗读中」恒亮且彻底没声。
            //
            // 正确做法：清空队列（这些句子在宿主那边是「已发未确认」，
            // 按条数回执归还配额），复位朗读状态，让用户下一次交互重试。
            const dropped = speakQueueRef.current.splice(0, speakQueueRef.current.length)
            if (dropped.length) {
              // 这不是「安全网裁剪」，记 dropped（清队列原因是音频输出不可用）。
              droppedRef.current += dropped.length
              ackDroppedItems(dropped)
            }
            playingParaRef.current = -1
            speakingRef.current = false
            setSpeaking(false)
            return
          }
          // 真正的并行流水线：由独立的后台任务持续补充合成，
          // 播放循环只负责按顺序 await 已排好的 promise。
          // 之前是「await play() 然后才 pumpPrefetch()」，播放期间不补充合成，
          // 实际深度只有 1，句间仍要等一整个 TTS 往返（1.2~1.7 秒）。
          const inflight = [] // [{ promise, gen, index }]
          let prefetching = true
          const pumpPrefetch = () => {
            while (inflight.length < 3 && speakQueueRef.current.length) {
              const item = speakQueueRef.current.shift()
              if (!item) continue
              // 不按代次过滤：已经排队的句子都要念出去。
              // 之前这里会丢弃 gen 不符的句子，而回合开始事件每次 LLM 调用都触发，
              // 结果大量内容被静默丢弃 —— 用户听到的就是「很多没播报」。
              // 保留 sentence：播放到这句时要据此高亮「正在朗读的文本」。
              // 保留 sessionId/turnId：回执按 (session, turn) 记账要用；
              // 保留 para/paraStart：安全网按段裁剪要用。
              inflight.push({
                promise: synth(item.sentence, item.gen),
                gen: item.gen,
                index: item.index,
                para: item.para,
                paraStart: item.paraStart,
                sessionId: item.sessionId,
                turnId: item.turnId,
                sentence: item.sentence,
              })
            }
          }
          /**
           * 安全网裁剪：按**整段**丢，绝不从段落中间开始播。
           *
           * 正常情况下队列被宿主流控（reading-ack）钉在 3~4 条，这里只是兜底
           * （老宿主 / ack 丢失 / 重连 / 宿主降级回 400ms 窗口）。规则在纯函数
           * trimBacklog 里（src/client/pure/backlog.js）：超限时从最旧的段落
           * **整段**丢，保护「含本轮首句的段落」和「正在播放的段落」。
           *
           * 被丢的句子不会出声，但在宿主编账里是「已发未确认」—— 必须按条数
           * 回执归还配额，否则宿主会一直等到 watchdog 才发现（朗读变慢甚至停）。
           */
          const trimPending = () => {
            const { dropped, droppedItems } = trimBacklog(
              inflight,
              speakQueueRef.current,
              MAX_PENDING,
              { playingPara: playingParaRef.current },
            )
            if (dropped > 0) {
              trimmedRef.current += dropped
              ackDroppedItems(droppedItems)
            }
          }
          // 后台补齐：播放期间也会持续把队列里的句子送去合成
          const filler = (async () => {
            while (prefetching) {
              pumpPrefetch()
              trimPending()
              // 等到有新句子或者要收尾
              await sleep(win, 120)
            }
          })()
          try {
            pumpPrefetch()
            trimPending()
            // 退出条件必须是「队列和 inflight 都为空」。
            // 之前只看 inflight.length：inflight 空但队列里刚来了新句子时，
            // 循环直接退出，最后那一句永远不会被消费 —— 表现就是「最后一句没播报」。
            while (inflight.length || speakQueueRef.current.length) {
              if (!inflight.length) {
                // inflight 暂时空了但队列里还有：补一轮再继续
                pumpPrefetch()
                trimPending()
                if (!inflight.length) {
                  await sleep(win, 80)
                  continue
                }
              }
              const { promise, gen, sentence, para, sessionId: itemSid, turnId: itemTurn } =
                inflight.shift()
              // 一句开始消耗（播或跳过）就把它「钉」成正在播的段落：
              // 安全网裁剪靠它整段保护，避免只播了段首、剩下的被裁掉。
              playingParaRef.current = Number.isInteger(para) ? para : -1
              // 回执用**句子自己的** sessionId/turnId（payload 里的），
              // 换轮边界上用本地 ref 会把旧轮的账记到新轮上。
              const ackSid = itemSid || sessionIdRef.current || ''
              const ackTurn = itemTurn || currentTurnIdRef.current || ''
              // 合成要有超时兜底：宿主 /tts 挂住时（网络 stall、宿主忙、
              // 后台节流）若没有超时，await 永不 resolve → 整个朗读管道
              // 卡死（pumpingRef 卡 true，之后所有句子只入队不播）。
              // 超时就把这句当成失败跳过，继续后面的句子。
              const decoded = await Promise.race([
                promise,
                sleep(win, TTS_TIMEOUT_MS).then(() => null),
              ])
              // 这一句「已被消耗」：要么播、要么跳过；两种情况都要回执 1 条，
              // 把宿主配额还回去，否则宿主会以为我们还没拿到这一句。
              if (decoded) {
                // 引擎回退可见（审计 F3）：本地系统语音失败时宿主会自动回退在线，
                // 文本会发到微软 —— 用户必须知道，不能悄悄换引擎。
                // 只在检测到**新一次**回退时提示（ttsFallbacks 由 fetchSpeech 递增）。
                if (playCore.ttsFallbacks !== ttsFallbackSeenRef.current) {
                  ttsFallbackSeenRef.current = playCore.ttsFallbacks
                  const fallbackKey = playCore.lastTtsFallback === 'local' ? 'ttsFallbackLocal' : 'ttsFallbackOnline'
                  setHint(t(fallbackKey), t(fallbackKey))
                }
                // 正在朗读的文本 → 高亮。放在 play 之前，让「朗读中」
                // 与「高亮」严格同步；这一句播完、进入下一句时再覆盖。
                // 高亮是 DOM 操作（ensureStyle/ensureLayer），抛错绝不能影响
                // 播放与回执：以前它抛错会让这一句既没播也没 ack（宿主等 watchdog），
                // 异常还会从 pumpQueue 冲出去变成 unhandled rejection。
                try {
                  readingHighlightRef.current?.set(sentence)
                } catch { /* 忽略：高亮不是关键路径 */ }
                // ① 开始播放前回执：宿主据此补发下一句，于是播放这 2~3 秒里
                // 下一句已经在合成（合成延迟继续被藏住），队列也不会积压。
                // 同时把**真实音频时长**告诉宿主：宿主用它把「正在播放的剩余时长」
                // 算进追赶预算（否则预算实际会变成「预算 + 正在念的那句」）。
                const decodedMs = Number(decoded?.duration) > 0
                  ? Math.round(Number(decoded.duration) * 1000)
                  : undefined
                ackReading(ackSid, ackTurn, 1, decodedMs)
                await play(decoded, gen)
              } else {
                // ② 合成失败 / 25s 超时 / 代次失效：这句不会出声，
                // 但配额必须归还，否则宿主要白等 watchdog。
                ackReading(ackSid, ackTurn, 1)
              }
              // ③ 安全网裁剪必须在**复位 playingPara 之前**跑：这一句刚播完，
              // 它所属段落的**剩余句子**还得继续受保护 —— 否则「一段 12 句」
              // 只会念第一句，剩下 11 句被整段裁掉（评审 P1）。
              // 下一轮循环开头会立刻把 playingPara 设成下一句的段，保护不会过期。
              trimPending()
              playingParaRef.current = -1
            }
          } finally {
            prefetching = false
            await filler.catch(() => {})
            // 异常退出（例如 play 抛错）时 inflight 里可能还有已合成但没播的句子：
            // 它们已经被宿主算作「已发未确认」，逐条归还配额，别让宿主等 watchdog。
            // 这类丢弃不属于「安全网裁剪」，记到 dropped（不是 trimmed），
            // 否则诊断里会误判成「宿主流控失效」。
            if (inflight.length) {
              const leftover = inflight.splice(0, inflight.length)
              droppedRef.current += leftover.length
              ackDroppedItems(leftover)
            }
            // 管道结束时清掉「正在播的段」这个陈旧保护值（异常退出时可能没复位）。
            playingParaRef.current = -1
          }
        } finally {
          pumpingRef.current = false
          // 收尾时队列里若又进了新句子（宿主的尾句常在生成结束时才到），
          // 立刻再起一轮，别让最后一句丢掉。
          if (speakQueueRef.current.length) {
            void pumpQueue()
          } else {
            speakingRef.current = false
            setSpeaking(false)
            // 队列空了，没有正在朗读的文本了 → 清高亮。
            readingHighlightRef.current?.clear()
          }
        }
      }, [ackReading, ackDroppedItems])

      /* ================= 边生成边朗读 ================= */
      // 助手是流式输出的，宿主每写完一句就广播 sentence 事件。
      // 这里收到一句就排队播一句，不必等整段回复结束 ——
      // 之前是「生成完 → 取全文 → 再读」，用户要等到最后才听见声音。
      // 合成有 800ms 起步延迟，边生成边读能把这段等待完全藏进生成时间里。
      //
      // 注意：这里**不能**因为「语音模式没开」就不连 SSE。
      //
      // 之前写成 `if (!on) return undefined`，于是「朗读回复」必须同时满足
      // 两个条件才会出声：勾了开关 **且** 开着语音模式（麦克风按钮）。
      // 但设置面板里那个开关的说明是「把助手的回复念出来」，
      // 压根没提这个前置条件 —— 用户勾了却听不到声音，完全不知道该开什么。
      //
      // 现在改成：勾了「朗读回复」就朗读，与语音模式无关。
      // 组件卸载（离开会话页）时 cleanup 会关掉连接，队列也随之清空。
      useEffect(() => {
        const source = new EventSource(ROUTES.stream)
        // 连接状态：连上了就不用轮询 /busy 了。
        source.onopen = () => {
          liveConnectedRef.current = true
          // 连接建立时对齐一次「助手忙不忙」。
          //
          // 轮询与事件是两条通路，必须在同一时刻给出同一个答案。
          // 之前只有轮询在 SSE 连上**之前**跑：
          //   轮询读到 busy=true → 客户端标记「忙」
          //   → SSE 连上 → 轮询停掉
          //   → 而 SSE 只在状态**变化**时才发事件，
          //     连接建立这一刻没有状态变化，永远不会收到事件
          //   → 客户端的「忙」永远停在 true。
          //
          // 症状：宿主 /busy 说 false，客户端说 true；
          //       「助手忙时说的话先留草稿、忙完再发」永远走不到发送那一步。
          //
          // 现在连接一建立就拉一次当前状态（宿主在 SSE 握手时也会推一次快照，
          // 这里是双保险 —— 任一侧实现缺失都不会卡住）。
          void fetch(ROUTES.busy)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              const value = data?.busy === true
              if (value !== assistantRunningRef.current) {
                assistantRunningRef.current = value
                setAssistantRunning(value)
              }
            })
            .catch(() => {})
        }
        source.onerror = () => { liveConnectedRef.current = false }
        // 助手是否在生成：宿主推送 assistant-busy 事件。
        //
        // 之前是每 700ms 轮询一次 /busy —— 助手忙的感知要慢最多 700ms，
        // 「助手忙时说的话先留在草稿、忙完再发」这条链路的时机也跟着漂。
        source.addEventListener('assistant-busy', (event) => {
          try {
            const payload = parseEnvelope(event)
            const mine = belongsToSession(payload, sessionIdRef.current)
            const value = payload?.busy === true
            busyLogRef.current = [
              { src: 'event', busy: value, sid: payload?.sessionId ?? null, mine, at: Date.now() },
              ...busyLogRef.current,
            ].slice(0, 12)
            if (!payload || !mine) return
            if (value !== assistantRunningRef.current) {
              assistantRunningRef.current = value
              setAssistantRunning(value)
            }
          } catch { /* 忽略 */ }
        })
        // 新一轮对话开始 → 立刻停掉旧的朗读，否则新旧内容会重叠。
        // 判断依据是宿主广播的 turn-begin，而不是猜测时间间隔。
        //
        // **只有真的换了一轮**才解除静音 + 停旧朗读。
        //
        // 宿主那边 turn-begin 是跟着「一次 llm/stream 调用」发的，
        // 而同一轮里可能有多次调用（工具调用链）。
        // 宿主判「新一轮」的依据是「请求里的用户消息条数变了」——
        // 同一轮的多次调用条数不变，所以一轮只发一次 turn-begin；
        // 万一宿主仍然多发了一次（同一个 turnId），
        // 这里靠轮次 id 比对挡住。
        //
        // 以前每次 turn-begin 都无条件解除静音 + 清队列：
        //   用户点「停止朗读」→ mutedTurnIdRef 设成当前轮次
        //   → 宿主又发了一次 turn-begin（同一个 turnId）
        //   → 静音被解除、队列被清空
        //   → 后续句子照常播出来
        // 表现就是「停止总停止不了正在进行的朗读」。
        source.addEventListener('turn-begin', (event) => {
          try {
            const payload = parseEnvelope(event)
            if (!payload || !belongsToSession(payload, sessionIdRef.current)) return
            const turnId = typeof payload?.turnId === 'string' ? payload.turnId : null
            const isNewTurn = !turnId || turnId !== currentTurnIdRef.current
            if (!isNewTurn) return
            // 新的一轮：解除手动静音，恢复朗读
            mutedTurnIdRef.current = null
            if (turnId) currentTurnIdRef.current = turnId
            turnSentenceSeqRef.current = 0
            // 新一轮：去重带清空（key 里已经带 turnId，这里只是防长跑会话里
            // 一直不换轮时 Set 缓慢增长；有上限兜底，不会无限涨）。
            seenSentenceKeysRef.current.clear()
            if (configRef.current.readAloud !== true) return
            haltSpeaking(true)
          } catch { /* 忽略 */ }
        })
        // 这一轮说完了。
        // 真正的一轮结束了（协议 v3：下一轮开始时宿主广播上一轮的 turn-end）。
        source.addEventListener('turn-end', (event) => {
          try {
            const payload = parseEnvelope(event)
            if (!payload || !belongsToSession(payload, sessionIdRef.current)) return
            // **不要**在这里清掉 currentTurnIdRef。
            //
            // 一轮结束后、下一轮 turn-begin 到达前，可能还有**迟到**的句子
            // （生成完成前就已经发出的句子）带着这一轮的 turnId 到达。
            // 若在这里把 currentTurnIdRef 清成 null，sentence 处理里的
            // 「turnId && currentTurnIdRef.current && turnId !== currentTurnIdRef.current」
            // 会因为 currentTurnIdRef 是 null 而短路 —— 迟到的旧轮句子被当成
            // 「没有轮次」放行，混进新一轮朗读（听着像答非所问）。
            //
            // 轮次 id 由下一个 turn-begin 覆盖，语义正好：
            // 迟到句子仍带着旧 turnId，会被「turnId !== 新 turnId」拒掉。
          } catch { /* 忽略 */ }
        })
        // 一次 llm/stream 调用结束（协议 v3）。**不是**一轮结束 ——
        // 一轮里可能有多次调用（工具调用链）。这里只做信息记录，
        // 不改变任何朗读状态；真正的一轮收尾由 turn-end 表达。
        source.addEventListener('call-end', (event) => {
          try {
            void parseEnvelope(event)
          } catch { /* 忽略 */ }
        })
        // 收到一句 → 入队 → 逐句朗读。
        //
        // 用户手动停止过 → 被静音的那一轮不再朗读。
        //
        // 静音**只由 turnId 表达**，没有布尔回退：
        //   null  → 没在静音
        //   ''    → 静音到下一个 turn-begin 为止（还没拿到轮次 id 时）
        //   'turn-x' → 只静音这一轮
        //
        // '' 这条路以前**没有实现**：
        // 注释写着「静音到下一个 turn-begin 为止」，
        // 代码却只在「句子里没有 turnId」时才拦。
        // 于是「停止朗读」拿不到轮次 id 时（当前轮次已结束、
        // 或者一轮里有多次 llm/stream 调用），
        // 后续句子全都照播 —— 停止按钮等于没按。
        // 现在按注释的语义实现：'' = 静音到下一个 turn-begin。
        source.addEventListener('sentence', (event) => {
          try {
            const payload = parseEnvelope(event)
            if (!payload || !belongsToSession(payload, sessionIdRef.current)) return
            // 回执用**事件 payload 里的** sessionId/turnId（宿主按这两项记账）。
            // **每一条收到的 sentence 最终都必须恰好回执一次**：真正会播的由
            // pumpQueue 在「开始播 / 被跳过」时回执，这里只负责「入队前就被
            // 丢弃」的那些 —— 漏回执的话宿主会一直等到 watchdog（10 秒）才发下一句，
            // 朗读就会一顿一顿地变慢。
            const ackSid = payload.sessionId || sessionIdRef.current || ''
            const ackTurn = typeof payload.turnId === 'string' ? payload.turnId : ''
            const ackDropped = () => ackReading(ackSid, ackTurn, 1)
            const sentence = String(payload?.text ?? '').trim()
            if (!sentence || configRef.current.readAloud !== true) {
              // 空句 / 朗读开关已关：宿主可能还在按旧配置发句 —— 归还配额。
              ackDropped()
              return
            }
            const turnId = typeof payload?.turnId === 'string' ? payload.turnId : null
            // index：本轮内第几句（认「首句」/ 与 turnId 组成去重键）。
            const index = Number.isInteger(payload?.index) && payload.index >= 0
              ? payload.index
              : turnSentenceSeqRef.current
            // 只读**当前这一轮**的句子（上一轮的流还在跑时会有迟到的旧句子）。
            // 例外：index===0 且轮次不同 = 新一轮第一句，要能穿过 muted === ''。
            const isTurnMismatch = Boolean(turnId) && Boolean(currentTurnIdRef.current) &&
              turnId !== currentTurnIdRef.current
            const isNewTurnFirst = isTurnMismatch && index === 0
            // 上一轮的迟到句子：不播，但配额照样归还。
            if (isTurnMismatch && !isNewTurnFirst) {
              ackDropped()
              return
            }
            if (!isNewTurnFirst && mutedTurnIdRef.current !== null) {
              if (mutedTurnIdRef.current === '' || !turnId || turnId === mutedTurnIdRef.current) {
                // 被静音拦下的句子：不播，但配额照样归还。
                ackDropped()
                return
              }
            }
            if (isNewTurnFirst) {
              // 自愈：采纳新轮次、解除静音、停掉上一轮的朗读 —— 等价于收到 turn-begin。
              // 为什么必须自愈：宿主漏发 / 本连接漏收 turn-begin 时，turnId 会永远
              // 粘在旧轮，之后所有句子都被当成「上一轮」丢掉（表现为整轮不朗读）；
              // 而 currentTurnIdRef 为 null 时又完全不过滤（旧轮迟到句子混进来）。
              currentTurnIdRef.current = turnId
              mutedTurnIdRef.current = null
              turnSentenceSeqRef.current = 0
              haltSpeaking(true)
            }
            // 段落信息（宿主流控协议新增，老宿主没有这两个字段）：
            //   para      —— 该句所属自然段在本轮内的序号（-1 = 未知）
            //   paraStart —— 该段第一个发出的片段（老宿主降级为 index===0）
            // 安全网裁剪靠 para 整段丢、绝不从段落中间开始播；没有 para 时
            // trimBacklog 会退化成「每句一段」，仍然能裁剪。
            const para = Number.isInteger(payload?.para) && payload.para >= 0
              ? payload.para
              : -1
            const paraStart = typeof payload?.paraStart === 'boolean'
              ? payload.paraStart
              : index === 0
            // 去重：宿主重复广播同一条 sentence（重连补发、重复 emit）时，
            // 同一句绝不能播两遍 —— 那正是「读完后面又读前面」的听感。
            const key = `${turnId ?? ''}:${index}`
            const seen = seenSentenceKeysRef.current
            if (seen.has(key)) {
              // 重复句：不播，但配额要归还（否则宿主等 watchdog）。
              ackDropped()
              return
            }
            seen.add(key)
            if (seen.size > MAX_SEEN_SENTENCE_KEYS) {
              // Set 保持插入顺序：删最早插入的那条（有界，不无限增长）。
              const oldest = seen.values().next().value
              if (oldest !== undefined) seen.delete(oldest)
            }
            // 只排队，不在句与句之间做任何轮次判断
            const gen = speakGenRef.current
            turnSentenceSeqRef.current += 1
            speakQueueRef.current.push({
              sentence, gen, index, para, paraStart,
              sessionId: ackSid, turnId: turnId ?? ackTurn,
            })
            void pumpQueue()
          } catch { /* 忽略 */ }
        })
        return () => source.close()
      }, [pumpQueue, haltSpeaking])

      // 单独维护 assistantRunningRef，保证 tick 读到的是最新值
      useEffect(() => {
        assistantRunningRef.current = assistantRunning
        // 这里绝不能清空朗读队列：已排队的句子是「已经生成好的内容」，
        // 必须念完。之前每次生成开始都清空，导致大量内容没播报。
      }, [assistantRunning])

      /* ================= 生成期间说的话：助手空闲后自动发送 ================= */
      // 只要「助手空闲」且「有待发送内容」就发，不依赖状态边沿：
      // 写草稿时助手可能还没开始跑，或状态有抖动，边沿检测会漏掉。
      useEffect(() => {
        if (!on || assistantRunning || !pendingAutoSendRef.current) return undefined
        pendingAutoSendRef.current = false
        // 定时器放在 ref 里，不随 effect 清理：
        // 之前放在 effect 里，assistantRunning 抖动一次（true→false→true）
        // 就会把定时器清掉，而标志已经清成 false → 这段话永远不会被发送。
        if (pendingAutoSendTimerRef.current) win.clearTimeout(pendingAutoSendTimerRef.current)
        // 与「助手闲」那条通路共用同一个 id：
        // 两条发送通路并存 = 同一段话发两遍。
        timers.clear('pending-send')
        timers.timeout('pending-send', () => {
          pendingAutoSendTimerRef.current = null
          try { inputActions?.submit?.() } catch { /* 忽略 */ }
          baseDraftRef.current = ''
          committedRef.current = ''
          segmentRef.current = ''
          lastWrittenRef.current = ''
        }, 400, 'send')
      }, [assistantRunning, on, inputActions])

      /* ================= 开麦 ================= */

      /**
       * 确保识别模型已经加载进内存。
       *
       * 首次加载要等多久没有可靠上界（装机实测 tiny 0.4 秒、228 MB 的 SenseVoice 回热约 1 秒）。
       * 不确认就开麦的话：
       *   用户说完 → 识别请求在模型就绪前就失败 → 音频已经被切走 → **整句话丢掉**。
       *
       * 流程：
       *   1. 先问宿主「好了吗」（GET /asr-ready）—— 已经好了就零延迟通过；
       *   2. 没有好就调 /asr-warmup，一直等到就绪（期间界面显示「正在加载模型…」）；
       *   3. 失败则返回**已经翻好的那句说明**，由调用方保持关闭状态并提示。
       *
       * 宿主这两条链路回的是**原因码**，不是句子（`src/shared/asr-readiness.js`）。
       * 界面那句话由 `pure/asr-ready-text.js` 按当前语言查 i18n 出（批次 18，docs §8.60）：
       *   以前这里是 `data.reason || '识别模型还没下载'` —— 宿主那句中文优先塞进界面，
       *   英文界面上开麦失败就弹中文。现在宿主说什么语言都不影响界面，
       *   词表外的码一律走兜底那句。
       *
       * @returns {Promise<{ok: boolean, detail?: string}>} 是否可以开始聆听；
       *   失败时 `detail` 是悬停要显示的长说明（当前语言）。
       */
      const ensureModelReady = useCallback(async () => {
        try {
          const check = await fetch(ROUTES.asrReady)
          if (check.ok) {
            const data = await check.json().catch(() => null)
            if (data?.ready) return { ok: true }
            if (data && data.downloaded === false) {
              // 压根没下载：不用去预热（预热带不动没下好的文件），直接说明。
              lastAsrReadyReasonRef.current = String(data.reason ?? '')
              return {
                ok: false,
                detail: asrReadyReasonText(data.reason, t, 'modelNotDownloadedDetail'),
              }
            }
          }
        } catch {
          /* 问不到就当没就绪，交给下面的 warmup 处理 */
        }
        setHint(t('modelLoading'), t('modelLoadingDetail'))
        try {
          const resp = await fetch(ROUTES.asrWarmup, { method: 'POST' })
          const data = await resp.json().catch(() => null)
          if (resp.ok && data?.ready) return { ok: true }
          lastAsrReadyReasonRef.current = String(data?.reason ?? '')
          return { ok: false, detail: asrReadyReasonText(data?.reason, t) }
        } catch (error) {
          // 请求根本没回来（宿主没起来 / 链路断）。没有码可翻，用兜底那句。
          // 异常消息本身不进气泡：它的语言由浏览器决定，跟界面语言无关。
          lastAsrReadyReasonRef.current = `error: ${error instanceof Error ? error.message : String(error)}`
          return { ok: false, detail: asrReadyReasonText('', t) }
        }
      }, [t])

      const startMic = useCallback(async () => {
        if (!micDevice.supportsCapture()) {
          setHint(t('micUnsupported'), t('micUnsupportedDetail'))
          // 失败了就复位开关（和下面每条失败分支一致）。
          // 搬动之前这条分支只复位了「聆听中」，没复位「正在开麦」：
          // 没有录音设备的机器上点一次麦克风，界面就停在「准备中」再也出不来，
          // 再点一次被当成「取消」而不是「重试」。
          startingRef.current = false
          setStarting(false)
          onRef.current = false
          setOn(false)
          return
        }
        // **先确保模型加载好了**。
        //
        // 顺序很关键：模型没就绪就开麦的话，用户说的话会全丢
        // （识别请求失败，而音频已经被切走）。
        // 反过来先加载模型再开麦，用户最多等一会儿，不会丢内容。
        const modelReady = await ensureModelReady()
        if (!modelReady.ok) {
          // 状态行只放短词（一整句长说明会把整行挤开），完整原因放悬停提示。
          // 这句原因说明由 `ensureModelReady` 按当前语言翻好（原因码 → i18n，
          // 见 `pure/asr-ready-text.js`），宿主的原文一个字都不会进界面。
          setHint(t('modelFailed'), modelReady.detail || t('modelFailedDetail'))
          startingRef.current = false
          setStarting(false)
          onRef.current = false
          setOn(false)
          return
        }

        let stream
        try {
          // 约束对象与浮层那条链路是同一份（dom/mic-device.js）：先按 16k 要，
          // 设备给了就是直通，拿不到就走 pure/resample.js 的重采样。
          stream = await micDevice.requestStream()
        } catch {
          setHint(t('micDenied'), t('micDeniedDetail'))
          // 失败了就复位开关：否则按钮显示「语音对话中」，用户以为在录音
          startingRef.current = false
          setStarting(false)
          onRef.current = false
          setOn(false)
          return
        }
        // getUserMedia 成功**不等于**有可用的音频输入：设备可能已被拔掉、被别的程序
        // 独占，或者系统只给了一个空轨道。判据住在 dom/mic-device.js（两处开麦共用）。
        if (!micDevice.liveAudioTrack(stream)) {
          micDevice.releaseStream(stream)
          setHint(t('micFailed'), t('micFailedDetail'))
          startingRef.current = false
          setStarting(false)
          onRef.current = false
          setOn(false)
          return
        }
        // 取不到 AudioContext 构造器时这里抛的是可辨认的 Error，而不是 `new undefined()`
        // 的 TypeError —— 搬动之前 composer 这条链路没有这道守卫，异常从 try 外面逃出去，
        // 「正在开麦」的标志留在 true，界面从此卡在准备中（浮层那条一直有）。
        let ctx
        try {
          ctx = micDevice.createAudioContext()
        } catch {
          micDevice.releaseStream(stream)
          setHint(t('micFailed'), t('micFailedDetail'))
          startingRef.current = false
          setStarting(false)
          onRef.current = false
          setOn(false)
          return
        }
        const source = ctx.createMediaStreamSource(stream)
        const processor = ctx.createScriptProcessor(4096, 1, 1)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        source.connect(analyser)
        processor.onaudioprocess = (event) => {
          if (!recorderActiveRef.current) return
          chunksRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)))
        }
        source.connect(processor)
        const sink = ctx.createGain()
        sink.gain.value = 0
        processor.connect(sink)
        sink.connect(ctx.destination)

        // 用户点按钮触发，这里 resume 确保音频上下文处于运行态（朗读要用它播放）
        try { await micDevice.resumeContext(ctx) } catch { /* 忽略 */ }
        // 实时字走哪种方式：
        //   'stream' —— 强制用流式模型（zipformer2）边喂边解码
        //   'full'   —— 强制每 900ms 把整段音频重新识别一遍
        //   'auto'   —— 当前模型是流式模型就用流式，否则整段重识别
        //
        // 流式解码器是有状态的，必须每次开麦开一个新会话。
        {
          const mode = String(configRef.current.liveAsr ?? 'full')
          const modelId = String(configRef.current.model ?? '')
          const isStreamModel = STREAM_MODEL_IDS.includes(modelId)
          streamLiveRef.current = mode === 'stream' || (mode === 'auto' && isStreamModel)
          streamSessionIdRef.current = streamLiveRef.current
            ? `voice-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
            : ''
          streamFedRef.current = 0
        }

        // 提前创建常驻播放上下文：用户点按钮是合法手势，
        // 此时建好可以省掉首次朗读时 1~3 秒的设备协商（蓝牙尤甚）。
        try {
          const warm = playCore.getPlayCtx()
          await warm?.resume?.()
        } catch { /* 忽略 */ }
        // 后台预热 TTS 连接：第一次合成要付 TLS 握手（4~5 秒），
        // 提前建好连接，真正要朗读时第一句就不用干等。
        fetch(ROUTES.ttsWarmup).catch(() => {})
        // 加载模型 / 授权弹窗期间用户可能已经点了取消
        // （toggleVoice 在 starting 期间再点一次）：
        // 这时必须把刚拿到的麦克风释放掉，否则麦克风一直开着（UI 却显示已关闭）。
        if (!startingRef.current) {
          micDevice.releaseStream(stream)
          await micDevice.closeAudioContext(ctx)
          startingRef.current = false
          setStarting(false)
          onRef.current = false
          setOn(false)
          return
        }
        micRef.current = { ctx, source, processor, analyser, stream }
        recorderActiveRef.current = true
        // 一切就绪 —— 这时才进入「聆听中」。
        //
        // 顺序很重要：模型没加载好、麦克风没真正打开之前，
        // 界面就不应该显示「聆听中」。
        // 置位走 markListening（唯一的设置点，定义处有说明）：
        // 界面上的 on 与 ref 里的 onRef 必须在这一处一起翻起来。
        markListening()
        startingRef.current = false
        setStarting(false)
        chunksRef.current = []
        segStartRef.current = 0
        hearingRef.current = false
        livePartialRef.current = ''
        noiseFloorRef.current = INITIAL_GATE_STATE.noiseFloor
        // 开麦时把用户已有的内容存为基准，并清掉上一轮的语音内容
        baseDraftRef.current = (draftRef.current ?? '').trim()
        committedRef.current = ''
        segmentRef.current = ''

        // VAD / 断句，每 100ms
        let lastSound = Date.now()
        let speechMs = 0
        // 本段已录到的时长：超过上限就强制断句提交。
        // 否则一直说话时音频会无限累积（吃内存），识别也迟迟不提交。
        let recordMs = 0
        // 朗读打断的连续计数：需要连续几次超门槛才算用户开口
        let bargeStreak = 0
        const fft = new Float32Array(analyser.fftSize)
        timers.interval('vad', () => {
          if (!recorderActiveRef.current) return
          analyser.getFloatTimeDomainData(fft)
          let sum = 0
          for (let i = 0; i < fft.length; i++) sum += fft[i] * fft[i]
          const rms = Math.sqrt(sum / fft.length)
          // 门限判定是**单源**纯函数：算法在 src/shared/gate.js（宿主 lib/gate.js 同一个模块），
          // 浏览器侧的常数在 src/client/pure/gate.js 的 CLIENT_GATE_OPTS（clamp 0.008/0.035、1 帧）。
          // 之前这里把五个常数抄了一遍，等于第四份副本 —— 现在由 createGate 注入。
          const gated = advanceGate(
            { noiseFloor: noiseFloorRef.current, inSpeech: hearingRef.current, silentFrames: 0 },
            rms,
          )
          const gate = gated.gate
          noiseFloorRef.current = gated.state.noiseFloor
          const now = Date.now()
          // 朗读中的打断：音量够大且持续一小段时间，就判定为你开口。
          // 之前门槛是 max(0.02, noiseFloor*3)，太高了：朗读时 noiseFloor 被朗读声
          // 本身抬高，门槛跟着涨，你说话几乎触发不了 —— 表现为「打断不了」。
          // 改成固定下限 0.012（不随 noiseFloor 放大），用「持续 400ms」防误触。
          if (speakingRef.current) {
            const bargeGate = 0.012
            if (rms > bargeGate) {
              bargeStreak += 1
            } else {
              bargeStreak = 0
            }
            // 连续 4 次（约 400ms）都超过门槛，才认定是用户在说话
            if (bargeStreak >= 4) {
              bargeStreak = 0
              haltSpeaking(true)
            }
          } else {
            bargeStreak = 0
          }
          if (rms > gate) {
            lastSound = now
            speechMs += 100
            if (!hearingRef.current) {
              hearingRef.current = true
              // 新的一段开始：只确定「基准」，绝不清空草稿。
              // 基准 = 用户自己的内容（不含我们写进去的东西）。
              // 之前这里会把「我们上次写的内容」清掉，但那段内容可能还没发送，
              // 清掉就等于把用户刚说的话抹掉 —— 文字丢失的来源之一。
              if (!recognizingRef.current) {
                try {
                  const cur = (draftRef.current ?? '').trim()
                  const ours = (lastWrittenRef.current ?? '').trim()
                  if (ours && cur === ours) {
                    // 草稿就是我们上次写的 → 基准保持不变（内容和基准一致）
                    // 不清空：新一段的识别结果会替换它
                  } else {
                    // 草稿是用户自己的（或已清空）→ 以它为新基准
                    baseDraftRef.current = cur
                  }
                } catch { /* 忽略 */ }
              }
            }
            return
          }
          // 底噪已由 advanceGate 更新（只在静音时更新），这里不再重复处理。
          recordMs += 100
          // 每次都读最新值：在 startMic 时捕获会导致「改了设置要重启麦克风才生效」
          const silenceMs = configRef.current.silenceMs ?? 1500
          if (now - lastSound < silenceMs) return
          if (!hearingRef.current) { lastSound = now; return }
          if (speechMs < 200 && recordMs < MAX_RECORD_MS) { lastSound = now; return }
          speechMs = 0
          recordMs = 0
          // 断句了：丢弃流式解码状态（否则下一段会被上一段的上下文污染）。
          void resetStream()
          void transcribeSegment()
        }, 100, 'mic')

        // 实时字：每 900ms 用同一个模型（SenseVoice）重跑「当前整段」音频。
        // SenseVoice 加载后单次 30~100ms，用同一模型的好处是
        // 实时字和最终稿完全同源，不会出现「字跳变」。
        // 间隔取 900ms：400ms 太密（长时间说话会产生上百次请求，CPU 到 85%），
        // 900ms 既能看出「字在长」，负载也降下来。
        let liveBusy = false
        timers.interval('flush', async () => {
          if (!recorderActiveRef.current || !hearingRef.current) return
          if (liveBusy || recognizingRef.current) return
          const segChunks = chunksRef.current.slice(segStartRef.current)
          if (!segChunks.length) return
          // len 只为「太短先不跑」这条门槛服务，先算出来再决定要不要拼（拼了才分配内存）。
          let len = 0
          for (const p of segChunks) len += p.length
          // 太短（< 0.25 秒）先不跑，避免看到半截碎字
          if (len < 4000) return
          liveBusy = true
          try {
            const samples = resampleTo16k(mergeChunks(segChunks), normalizeSourceRate(micRef.current?.ctx?.sampleRate))
            if (!samples.length) return

            // 流式模式：只喂**新增**的那部分，解码器自己保留上下文。
            //
            // 与整段重识别的区别：
            //   整段重识别 —— 每 900ms 把当前整段音频重新跑一遍，
            //                 段越长越慢（一段 5 秒的语音会重复识别 5 次，
            //                 累计处理的音频量是段长的平方倍）。
            //   流式       —— 只喂新增部分，延迟不随段长增长。
            if (streamLiveRef.current) {
              const already = streamFedRef.current
              if (samples.length <= already) return
              const delta = samples.subarray(already)
              streamFedRef.current = samples.length
              const partial = await feedStream(delta)
              if (!partial || partial === livePartialRef.current) return
              livePartialRef.current = partial
              segmentRef.current = partial
              composeDraft()
              return
            }

            const resp = await fetch(ROUTES.transcribe, {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength),
            })
            if (!resp.ok) return
            const data = await resp.json().catch(() => null)
            const partial = String((data && data.text) || '').trim()
            if (!partial || partial === livePartialRef.current) return
            livePartialRef.current = partial
            // 实时字写进「当前段」：只替换当前段的实时字，
            // 不动已完成的各段和用户手打的内容。
            segmentRef.current = partial
            composeDraft()
          } catch { /* 忽略 */ } finally {
            liveBusy = false
          }
        }, 900, 'mic')
      }, [t, transcribeSegment, inputActions, haltSpeaking])

      /* ================= 开关 ================= */

      const toggleVoice = useCallback(() => {
        // 已经在聆听，或正在开麦（加载模型 / 授权弹窗期间）：这次点击是「关掉/取消」。
        if (onRef.current || startingRef.current) {
          startingRef.current = false
          setStarting(false)
          onRef.current = false
          setOn(false)
          // 麦克风按钮**只管聆听**。
          // 朗读是独立的：这里不停朗读 ——
          //   一是「停止朗读但继续听」应该做得到；
          //   二是以前这里顺带把朗读也停了，导致
          //      「关闭语音对话后朗读还在继续」这类语义混淆。
          // 要停朗读请用朗读时的「停止朗读」按钮，或设置里的「朗读回复」开关。
          stopListening()
          return
        }
        // 开麦：**不要**在这里就 setOn(true)。
        // 那是「模型与麦克风都真的就绪了」的结论，等 startMic 确认后再设。
        // 否则用户会看到「聆听中」，而识别其实还没开始
        // （模型还在加载 / 麦克风被拒绝 / 设备被独占）。
        startingRef.current = true
        setStarting(true)
        // 注意：**不要**在这里清静音标记。
        //
        // 「停止朗读」是用户明确的意图（这一轮别念了）。
        // 点麦克风开麦是另一件事（我要继续说话），
        // 不该撤销那个意图 —— 否则会出现：
        //   点「停止朗读」→ 后面还有句子没来 → 点麦克风 → 剩余句子又响了。
        //
        // 静音要到下一轮（收到 turn-begin）才自动解除。
        void startMic()
      }, [stopListening, startMic])

      /* ================= 快捷键：切换语音模式 ================= */

      /**
       * 快捷键监听。
       *
       * 注意：监听必须「始终注册」，不能只在语音模式开启时注册 ——
       * 否则就出现死结：语音模式关着时按快捷键没反应（因为没监听），
       * 而开启后快捷键又只用来停朗读，开不了机。
       *
       * 行为：按一下 = 切换语音模式的开关（等同点麦克风按钮）。
       * 语音模式开着时，按快捷键会先停掉正在进行的朗读，再关闭麦克风。
       */
      useEffect(() => {
        // 每次触发时再解析快捷键，改了设置不用刷新页面。
        const matches = (event) => {
          const combo = String(configRef.current.shortcut ?? 'Alt+V')
          // 走平台别名匹配（macOS 上默认全局组合额外接受 Cmd+Alt+V）。
          return shortcutMatches(event, combo, clientPlatform())
        }
        const down = (event) => {
          // 设置面板里正在编辑快捷键时，不要触发
          if (shortcutFocus.isFocused('composer')) return
          // 全局语音开启时：输入框麦克风已隐藏，Alt+V 改为切换浮层麦克风。
          // 这样用户只需要记「按一下开始/停止说话」，不会同时开两个语音模式。
          if (configRef.current?.globalVoice === true) {
            if (!matches(event)) return
            event.preventDefault()
            if (event.repeat) return
            try { win.dispatchEvent(new CustomEvent(GLOBAL_TOGGLE_EVENT)) } catch { /* 测试桩环境 */ }
            return
          }
          if (!matches(event)) return
          event.preventDefault()
          if (event.repeat) return
          // 和点麦克风按钮完全一致：开 → 关，关 → 开
          toggleVoice()
        }
        // 用捕获阶段（第三个参数 true）：
        // 冒泡阶段的话，输入框的 keydown 处理器一旦调用 stopPropagation()，
        // 这个监听就收不到事件 —— 表现为「在输入框里按快捷键没反应」。
        win.addEventListener('keydown', down, true)
        return () => win.removeEventListener('keydown', down, true)
      }, [toggleVoice])

      /* ================= 与全局语音浮层互斥 ================= */

      /**
       * 全局浮层开麦时，这只 composer 麦克风必须让位。
       *
       * 两个录音引擎同时开麦的后果不是「多录一点」：同一句话会被识别两遍、
       * 往会话里送两条，而且两套 VAD 会互相打断。全局浮层在自己开麦前派发
       * `global-mic-on`，这里收到就把自己的麦克风关掉（只关聆听，不动朗读）。
       */
      useEffect(() => {
        const onGlobalMicOn = () => {
          if (!onRef.current && !startingRef.current) return
          startingRef.current = false
          setStarting(false)
          onRef.current = false
          setOn(false)
          stopListening()
        }
        try {
          win.addEventListener(GLOBAL_MIC_ON_EVENT, onGlobalMicOn)
        } catch {
          // 测试环境的 window 是桩（没有 addEventListener）时直接跳过。
          return undefined
        }
        return () => {
          try { win.removeEventListener(GLOBAL_MIC_ON_EVENT, onGlobalMicOn) } catch { /* 忽略 */ }
        }
      }, [stopListening])

      /**
       * 全局语音开启时输入框麦克风让位：正在聆听就先停掉，按钮随后隐藏。
       *
       * 互斥事件只能覆盖「浮层先开麦」这一半；如果用户先开了输入框麦克风、
       * 再去设置里打开全局语音，会短暂存在两个引擎 —— 这里补上另一半。
       */
      useEffect(() => {
        if (!globalVoiceOn) return
        if (onRef.current || startingRef.current) {
          startingRef.current = false
          setStarting(false)
          onRef.current = false
          setOn(false)
          stopListening()
        }
      }, [globalVoiceOn, stopListening])

      /* ================= 卸载收尾 ================= */

      useEffect(() => {
        return () => {
          // 卸载兜底：所有登记过的定时器一次清干净。
          // 之前是逐个 ref 清，漏一个就是一个「组件卸载后还在跑」的定时器。
          timers.clearAll()
          stopAll()
          // 卸载时把高亮覆盖层连根清掉（移除色块与样式）。
          readingHighlightRef.current?.dispose()
          // 提示定时器不用再单独清：上面 timers.clearAll() 已经把登记过的 'hint' 清掉了
          // （原先这里的 hintTimerRef 分支判的是一直为 null 的 ref，从未生效过）。
          // 「助手忙完后自动发送」的定时器同理
          if (pendingAutoSendTimerRef.current) {
            win.clearTimeout(pendingAutoSendTimerRef.current)
            pendingAutoSendTimerRef.current = null
          }
        }
      }, [stopAll])

      /* ================= 状态上报（诊断用） ================= */

      useEffect(() => {
        if (!on) return undefined
        timers.interval('shortcut', () => {
          // `sessionId` 为空时**整个键都不发**（批次 13b，docs §8.55）。
          // 宿主的契约是「请求体里有这个自有属性就把 voiceSession 改成它」，空串等于清空 ——
          // 于是这个还没拿到会话 id 的麦克风按钮，每 1500 毫秒替用户清一次会话指针，
          // 而它本意只是报状态。同 §8.54：语义由这里决定，注释和调用方都守不住。
          const sid = String(sessionId ?? '')
          fetch(ROUTES.voiceSession, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...(sid ? { sessionId: sid } : {}),
              client: {
                on: true,
                speaking: speakingRef.current,
                recognizing: recognizingRef.current,
                hearing: hearingRef.current,
                // rmsRef 之前根本没有声明：这里会抛 ReferenceError，
                // 被 .catch() 吞掉，于是整个心跳上报从来没成功过（诊断全为 null）。
                rms: 0,
                partial: (livePartialRef.current ?? '').slice(0, 40),
                assistantRunning: assistantRunning,
                pending: pendingAutoSendRef.current,
                draftLength: (draftRef.current ?? '').length,
                // 播放上下文的真实状态：这是「朗读中却没声音」的唯一可靠线索。
                // 之前心跳里根本没有这一项，只能靠猜。
                audioState: playCore.audioState,
                audioRate: playCore.audioRate,
                audioError: playCore.audioError,
                ttsFailures: ttsFailuresRef.current,
                playSkipped: playSkippedRef.current,
                // 朗读流控：acks 不涨 = 宿主补发句子的凭据没送到；trimmed > 0 =
                // 宿主流控失效、安全网兜底在丢句。dropped = 其它原因（无 AudioContext /
                // 管道异常）丢的句数，与流控无关。
                acks: acksSentRef.current,
                trimmed: trimmedRef.current,
                dropped: droppedRef.current,
                // 引擎回退（本地失败 → 在线）：以为在离线时先看这里。
                ttsFallbacks: playCore.ttsFallbacks,
                lastTtsFallback: playCore.lastTtsFallback,
                lastTtsEngine: playCore.lastTtsEngine,
                lastTtsError: playCore.lastTtsError,
                // 朗读高亮诊断：让我能在宿主 /diagnostics 里直接看到
                // 「为什么没高亮」（找不到容器 / 匹配数 / 矩形数 / 异常）。
                readingHighlight: readingHighlightRef.current?.getState?.() ?? null,
              },
            }),
          }).catch(() => {})
        }, 1500)
        // 清掉心跳定时器。
        // 注意：原来这里写的是 `win.clearInterval(timer)` ——
        // 那个 timer 变量在本 effect 里**从来不存在**
        // （间隔设置早已改成登记表的 timers.interval('shortcut', ...)），
        // 于是 cleanup 每次都抛 ReferenceError：
        //   - 心跳 interval 永远清不掉（每次 on 变化就多一个，泄漏）；
        //   - 异常从 React 的 cleanup 抛出来，打断渲染流程。
        return () => timers.clear('shortcut')
      }, [on, sessionId])

      /* ================= 界面 ================= */

      const statusText = starting
        ? t('modelLoading')
        : !on ? '' : speaking ? t('speaking') : t('listening')
      const singleText = hint || statusText
      // 完整说明：提示有 detail 就用它，否则用状态本身的说明。
      // 状态行只显示短词，鼠标悬停才看得到长说明。
      const singleDetail = hint ? hintDetail : starting ? t('modelLoadingDetail') : ''
      const singleColor = hint
        ? 'var(--dsw-alias-label-tertiary, rgba(0,0,0,0.5))'
        : speaking
          ? 'var(--dsw-alias-state-success, #2ea043)'
          : 'var(--dsw-alias-state-business-primary, #4d6bfe)'

      const micIcon = h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3 }),
        h('path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0' }),
        h('line', { x1: 12, y1: 18, x2: 12, y2: 21.5 }),
      )

      const button = h(
        'button',
        {
          type: 'button',
          onClick: toggleVoice,
          onContextMenu: (event) => { event.preventDefault(); toggleVoice() },
          title: on ? t('stopHint') : t('buttonHint'),
          'aria-label': on ? t('stopHint') : t('buttonHint'),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 9,
            border: '1px solid ' + (on ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : 'transparent'),
            background: on ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 10%, transparent)' : 'transparent',
            color: on ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : 'var(--dsw-alias-label-secondary, inherit)',
            cursor: 'pointer',
            touchAction: 'none',
            userSelect: 'none',
          },
        },
        micIcon,
      )

      // 独立的「停止朗读」按钮。
      //
      // 麦克风按钮现在只管聆听，朗读是独立的：
      // 想停朗读不必去动麦克风（那会连带停止聆听）。
      // 只在正在朗读时出现 —— 不占地方，也不会误点。
      const stopSpeakingButton = speaking
        ? h(
            'button',
            {
              type: 'button',
              onClick: () => {
                // 记住被静音的是哪一轮 —— 下一轮（turn-begin）自动恢复。
                // 拿不到轮次 id 时用空串：静音到下一个 turn-begin 为止。
                mutedTurnIdRef.current = currentTurnIdRef.current ?? ''
                stopPlayback()
                // 回执用**短句**。
                // 以前这里弹的是 stopSpeakingHint（「停止朗读，并让这一轮不再朗读」，
                // 15 个字），而状态行是内联在按钮旁边的：
                // 文字一换，状态行的宽度就变，整行跟着挪位置。
                setHint(t('stoppedSpeaking'))
              },
              title: t('stopSpeakingHint'),
              'aria-label': t('stopSpeaking'),
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 30,
                height: 30,
                borderRadius: 9,
                border: '1px solid var(--dsw-alias-state-success, #2ea043)',
                background: 'color-mix(in srgb, var(--dsw-alias-state-success, #2ea043) 12%, transparent)',
                color: 'var(--dsw-alias-state-success, #2ea043)',
                cursor: 'pointer',
                touchAction: 'none',
                userSelect: 'none',
              },
            },
            h(
              'svg',
              { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
              h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }),
            ),
          )
        : null

      return h(
        'div',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        // 全局语音开启时输入框麦克风隐藏：语音入口只剩右下角浮层一个。
        globalVoiceOn ? null : button,
        stopSpeakingButton,
        !globalVoiceOn && singleText
          ? h(
              'span',
              {
                title: singleDetail || undefined,
                style: {
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                  // 状态行只放短词，最大宽度收窄一点，
                  // 免得偶尔的长提示把整行挤开。
                  maxWidth: 120,
                  // 状态行紧挨着按钮，宽度一变整行就挪位置。
                  // 给一个下限（够放下「聆听中」「朗读中」「已停止」），
                  // 换状态时宽度不变，界面不会跳。
                  minWidth: 48,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  color: singleColor,
                },
              },
              singleText,
            )
          : null,
      )
    }

  return MicButton
}
