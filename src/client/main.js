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

window.__ModuleLoader__.load({
  id: 'dsh-voice-typing',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React

    const NS = 'voice-typing'
    /** 单次识别的最长等待，超过就放弃并回到空闲。 */
    const TRANSCRIBE_TIMEOUT_MS = 15000
    /**
     * 单句 TTS 合成的最长等待。超时让该句失败跳过，不卡死朗读管道。
     *
     * **必须显著大于服务端最坏耗时**，否则会出现「服务端明明成功、客户端却说失败」：
     * 服务端冷启动首句要新建 WebSocket + TLS 握手，实测 9~19 秒；
     * 而这里原来只有 15 秒 —— 一超时客户端就丢弃这句并计一次 `ttsFailures`，
     * 用户听到的就是「第一句经常没声音」，可服务端日志里全是 200。
     * 服务端自身的超时是 12 秒，正常会在它之前返回，这里只是兜底。
     */
    const TTS_TIMEOUT_MS = 25000
    /** 单次录音的最长时长，防止一次请求过大把宿主堵住。 */
    const MAX_RECORD_MS = 30000
    /**
     * 待播句子的上限（还在排队 + 正在合成），单位是「句」。
     *
     * 现在**正常情况下根本触不到这个上限**：宿主按「已发未确认句数 <=
     * READ_ALOUD_LEAD」发句，客户端每开始播一句就回一条 reading-ack，
     * 队列长度被宿主流控钉在 3~4 条（见 ackReading）。
     *
     * 保留上限只是**安全网**（老宿主、ack 丢失、重连、宿主降级回 400ms
     * 时间窗口）。真积压时必须按**整段**丢 —— 绝不能保留某段的段尾、
     * 丢掉它的段首，否则用户会听到「从段落中间开始播」（本次修复要消灭的
     * 听感）。规则在纯函数 trimBacklog 里（src/client/pure/backlog.js）。
     */
    const MAX_PENDING = 8

    /**
     * 句子去重带的上限（条）。
     *
     * 宿主重复广播同一条 sentence（重连补发、重复 emit）时，同一句绝不能
     * 播两遍 —— 那正是「读完后面又读前面」的听感。key 是 `${turnId}:${index}`，
     * 每轮不同，所以这个带子只需要有界，不需要精确淘汰。
     */
    const MAX_SEEN_SENTENCE_KEYS = 512
    const BASE = '/dsh-voice-typing'

    /**
     * 全局浮层与 composer 麦克风按钮的互斥事件。
     *
     * 两个录音引擎同时开麦会把同一句话识别两遍、往会话里送两条 ——
     * 所以全局浮层开麦前派发 on，composer 侧收到后主动关自己的麦。
     */
    const GLOBAL_MIC_ON_EVENT = 'dsh-voice-typing:global-mic-on'
    const GLOBAL_MIC_OFF_EVENT = 'dsh-voice-typing:global-mic-off'
    /**
     * 全局语音开启后，composer 的快捷键改为「切换全局浮层麦克风」。
     *
     * 为什么：两个麦克风 + 两套快捷键（Alt+V / Ctrl+Alt+V）用户会混。
     * 统一成「一个入口、一个动作」：浮层开启时输入框麦克风隐藏，
     * 按 Alt+V 等同于点浮层麦克风，不再存在两套语音模式。
     */
    const GLOBAL_TOGGLE_EVENT = 'dsh-voice-typing:toggle-global'

    /**
     * 设置面板里「全局语音快捷键」输入框是否正在聚焦（模块级）。
     *
     * 与 composer 那个 shortcutFieldFocused 分开：两个快捷键是两套设置，
     * 录其中一个时不应该触发另一个。
     */
    let globalShortcutFieldFocused = false

    /** 全局浮层在 shell.overlay 里的注册 id（契约固定值）。 */
    const GLOBAL_OVERLAY_ID = 'dsh-voice-typing-global'

    /**
     * 唤醒后的活跃时长（毫秒）。
     *
     * 60 秒没说话自动回待机：常开麦待机本身就有隐私/耗电代价，
     * 唤醒后也不该无限期保持「可下命令」——避免一次误唤醒后一直把闲聊送进会话。
     */
    const WAKE_ACTIVE_MS = 60000

    /** 待机时「说唤醒词」提示的最小间隔（30 秒），防止环境噪声反复刷屏。 */
    const WAKE_HINT_MS = 30000

    /**
     * 客户端确认条超时（毫秒）。
     *
     * 宿主约 20 秒就放弃该动作并告诉模型失败（`ui_timeout`），但客户端确认条
     * 没有超时的话会一直挂着：`uiBusyRef` 卡 true（之后所有动作都被回 busy），
     * 且用户迟到点「允许」会让一个宿主早已判失败的动作真正执行（ghost action）。
     * 取 30 秒 = 比宿主略长（给用户一点操作余量），超时后自动按「拒绝」回执。
     */
    const CONFIRM_TIMEOUT_MS = 30000

    /* ================= 多窗口去重 / 请求 id ================= */

    /** clientId 的持久化键：sessionStorage 优先（同标签页共享，多标签页互不干扰）。 */
    const CLIENT_ID_KEY = 'dsh-voice-typing:client-id'

    /**
     * 生成一个随机 id。
     * @param {string} prefix - 退化路径的前缀（crypto.randomUUID 可用时不加）。
     * @returns {string} 随机 id。
     */
    function generateId(prefix) {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
          return crypto.randomUUID()
        }
      } catch {
        /* 退化到时间+随机（不用于安全场景，只做去重标识） */
      }
      return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    /**
     * 读取/创建本渲染器实例的 clientId。
     *
     * 为什么用 sessionStorage：多标签页各有一份（这正是要区分的对象），
     * 同一标签页刷新后保持不变；无痕模式/被禁用时退回 localStorage，再失败就
     * 只存在内存里（退化为"刷新后视为新窗口"，多窗口仍能靠先到先得去重）。
     *
     * @returns {string} 本窗口的稳定 id。
     */
    function resolveClientId() {
      try {
        if (typeof window !== 'undefined') {
          const storages = [window.sessionStorage, window.localStorage]
          for (const storage of storages) {
            if (!storage) continue
            const existing = String(storage.getItem(CLIENT_ID_KEY) ?? '').trim()
            if (existing) return existing
            const created = generateId('client')
            storage.setItem(CLIENT_ID_KEY, created)
            return created
          }
        }
      } catch {
        /* 存储被禁用：退化到内存 id */
      }
      return generateId('client')
    }

    /** 本窗口的 clientId（模块初始化时确定，所有 ui-action 认领共用）。 */
    const CLIENT_ID = resolveClientId()

    /**
     * 向宿主认领一个 ui-action（多窗口先到先得）。
     *
     * 宿主的 `ui-action` 是广播：两个 DSH 窗口各有一个浮层时，两边都会收到。
     * 只有 claim 成功的那个窗口才允许弹确认/执行，否则 `send_prompt` 这类动作
     * 会被执行两次。404（旧宿主/路由未就绪）与网络错误一律保守跳过 ——
     * 宁可这次动作没执行，也不要多窗口重复执行。
     *
     * @param {string} requestId - 动作请求 id。
     * @returns {Promise<boolean>} 是否认领成功。
     */
    async function claimUiAction(requestId) {
      try {
        const resp = await fetch(`${BASE}/ui-action-claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId, clientId: CLIENT_ID }),
        })
        if (!resp.ok) return false
        const data = await resp.json().catch(() => null)
        return data?.claimed === true
      } catch {
        return false
      }
    }

    /** 中文词典。 */
    const zh = {
      buttonHint: '点一下开始 / 停止语音模式',
      stopHint: '语音对话中 · 点一下退出',
      listening: '聆听中',
      speaking: '朗读中',
      stopSpeaking: '停止朗读',
      stopSpeakingHint: '停止朗读，并让这一轮不再朗读',
      // 状态行是内联在按钮旁边的：文字越长，界面越挤。
      // 所以状态行只放**短词**，完整说明放到「…Detail」里，
      // 鼠标悬停在状态文字上就能看到（title 属性）。
      stoppedSpeaking: '已停止',
      micDenied: '麦克风被拒',
      micDeniedDetail: '无法访问麦克风（检查浏览器权限）。',
      micUnsupported: '不支持录音',
      micUnsupportedDetail: '当前浏览器不支持录音。',
      micStarting: '打开麦克风…',
      micFailed: '麦克风打不开',
      micFailedDetail: '没有可用的音频输入设备（可能被其它程序独占）。',
      modelLoading: '加载模型…',
      modelLoadingDetail: '正在加载识别模型（首次需要 20~40 秒）。',
      modelFailed: '模型加载失败',
      modelFailedDetail: '请到设置里检查该档位。',
      empty: '没听清',
      emptyDetail: '没听清，请再说一次。',
      recognizeFailed: '识别失败',
      recognizeFailedDetail: '文字已保留在输入框。',
      ttsFailed: '朗读失败',
      ttsFailedDetail: '语音合成失败，这一句被跳过。看 /diagnostics 或控制台 __DSH_VOICE_DEBUG__().ttsFailures。',
      model: '识别模型',
      modelHint: 'SenseVoice 为内置本地模型，零下载；Whisper 各档首次使用需下载。',
      downloading: '下载中…',
      ready2: '已就绪',
      language: '识别语言',
      words: '自定义词表',
      wordsHint: '一行一条：写「正确=错误」把错词换成对词，例如「深度求索=深度球搜」；只写「正确」仅作为热词提示，且只有 Zipformer2（流式）模型支持，其它模型请用 = 写法。',
      autoSend: '识别后自动发送',
      readAloud: '朗读回复',
      readAloudHint: '把助手的回复念出来。关闭后下面所有朗读参数都不生效。不需要开语音模式，只要这个开关打开就会朗读。',
      readAloudLag: '朗读追赶最新（秒）',
      readAloudLagHint: '生成远比朗读快时，允许朗读最多落后屏幕这么多秒（默认 7.5 秒）；超过就整段跳过旧段落、保留最新 3 段（不会从段落中间开始念）。0 = 全部朗读、不跳段（长回复会越读越滞后）。',
      liveAsr: '实时字方式',
      liveAsrHint: '说话时实时出字用哪种方式。「整段重识别」精度最好，但段越长越慢；「流式解码」延迟低、长句不变快，但精度略低。最终稿始终用当前模型。',
      liveAsrFull: '整段重识别（精度最好）',
      liveAsrStream: '流式解码（更快）',
      liveAsrAuto: '自动（流式模型用流式）',
      secRecognition: '语音识别',
      secRecognitionHint: '选择识别模型、语言提示与实时出字方式。',
      secSynthesis: '语音合成',
      secSynthesisHint: '朗读回复的音色、引擎与语速等参数。',
      secModels: '模型与下载',
      secModelsHint: '预加载、空闲释放、环境自检与模型下载。',
      secInteraction: '语音交互',
      secInteractionHint: '说完一段之后的行为、断句与发送节奏。',
      secText: '文本处理',
      secTextHint: '识别结果的清理与自定义词表。',
      secAdvanced: '高级与诊断',
      secAdvancedHint: '排查问题时才需要；平时不用展开。',
      advancedDiagnostics: '诊断接口',
      advancedDiagnosticsHint: '宿主 GET /dsh-voice-typing/diagnostics：包含朗读调度器状态、TTS 失败计数、configWarnings（配置清洗告警）等。',
      advancedDebug: '调试快照',
      advancedDebugHint: '浏览器控制台执行 __DSH_VOICE_DEBUG__()：查看朗读队列、ack/回退计数、播放上下文状态与高亮诊断。',
      silenceMsHint: '静音多久算说完一句。太短会切断长句，太长回复慢。',
      autoSendHint: '识别完成后自动发送。关闭后文字只留在输入框里。',
      autoSendExtraMs: '发送前等待（毫秒）',
      autoSendExtraMsHint: '说完后再等一会儿才发，用来合并短句、避免抢话。',
      removeFillersHint: '去掉「嗯」「啊」「那个」这类口头禅。',
      unsaved: '有未保存的改动',
      loadingConfig: '正在加载配置…',
      configLoadFailed: '配置加载失败，请重试',
      modelNoReady: '（请先在模型管理里下载）',
      modelInUse: '当前使用',
      preloadModels: '启用后预加载模型',
      preloadModelsHint: '选了模型就后台加载好，第一次说话不用等（zipformer2 首次要 40 秒）。',
      idleReleaseMinutes: '空闲释放（分钟）',
      idleReleaseMinutesHint: '模型闲置超过这个时间就自动从内存里释放。0 表示一直留着。',
      ttsCurrent: '当前朗读方式',
      localVoiceDefault: '系统默认发音人',
      removeFillers: '清理语气词',
      silenceMs: '静音断句（毫秒）',
      shortcut: '语音模式快捷键',
      shortcutHint: '按一下切换语音模式（等同点麦克风按钮）：关 → 开并开始听，开 → 停朗读并关闭。格式如 Alt+V，改完立即生效。别用 Ctrl+Shift+V（浏览器的「粘贴为纯文本」），Ctrl+Space 会被输入法占用。',
      mode: '交互模式',
      modeHint: '按钮点一下 = 切换语音模式（边说边出字，静音自动发送，读完继续下一轮）；右键同样是停止。下拉框决定「说完一段之后」是继续听还是退出。',
      modeToggle: '连续对话',
      modeOnce: '说完就关',
      ttsEngine: '语音引擎',
      ttsEngineHint: '在线音质好但需要网络；神经模型完全离线且音质接近在线；系统语音最快但机器感较强；GPT-SoVITS 使用你自己跑的服务（插件只转发文本合成）。',
      sovitsHint: '外部 GPT-SoVITS：插件不内置模型、也不做克隆，只把每句文本 POST 到你自己的 api_v2 服务（默认 127.0.0.1:9880）；参考音频/文本由你配置，失败不会回退在线引擎。',
      sovitsUrl: 'GPT-SoVITS 服务地址',
      sovitsUrlHint: '官方 api_v2 默认 http://127.0.0.1:9880；填到 /tts 或只填服务根地址都行。',
      sovitsRefAudio: '服务端参考音频路径',
      sovitsRefAudioHint: '必须是 GPT-SoVITS 所在机器上可访问的 wav 路径（官方 api_v2 每个请求都要求它）。',
      sovitsPromptText: '参考音频文本',
      sovitsPromptTextHint: '参考音频里说的内容；留空则使用服务端默认。',
      sovitsTextLang: '合成语言',
      sovitsPromptLang: '参考音频语言',
      neuralModel: '神经模型',
      neuralSpeaker: '说话人',
      neuralReady: '已就绪',
      neuralDownload: '下载模型',
      neuralDownloading: '下载中…',
      neuralNoModel: '（还没有可用模型）',
      neuralNoModelHint: '还没有已下载可用的模型，请先在下面下载。',
      neuralReadyModels: '共 {count} 个可用模型',
      envCheck: '运行环境自检',
      envChecking: '检查中…',
      envRecheck: '重新检查',
      modelGroupAsr: '识别模型',
      modelGroupTts: '合成模型',
      modelBuiltIn: '内置',
      voice: '朗读音色',
      voiceHint: '中文音色效果最好；带 Neural 后缀的是神经网络音色。',
      pitch: '朗读音调',
      volume: '朗读音量',
      ttsFormat: '音频格式',
      rate: '朗读语速',
      section: '语音输入',
      save: '保存',
      saved: '已保存',
      downloadFailed: '下载失败',
      retry: '重试',
      envCurrent: '当前使用',
      envSovitsUrl: '服务地址',
      readAloudOffNotice: '朗读回复已关闭：以下语音合成设置仍会保存，但不会生效。',
      ttsEngineInvalid: '配置里的语音引擎无效，已按「Edge 在线」处理；保存时会修正。',
      neuralModelMissingWarning: '配置的本地神经模型未安装（或已丢失），保存时会自动改用第一个已就绪的模型。',
      languageModelUnsupported: '当前识别模型不支持语言提示（只有 SenseVoice 支持），此设置不生效。',
      languageNotInModel: '当前识别模型不支持该语言，保存时会回退到「自动」。',
      liveAsrStreamNeedsModel: '「流式解码」需要先下载 Zipformer2 中文模型（zipformer2-zh）。',
      modeOnceNeedsAutoSend: '「说完就关」依赖自动发送；已关闭自动发送，此模式不会生效。',
      ttsFallbackOnline: '本地语音合成失败，已自动回退到 Edge 在线（需要联网）。',
      ttsFallbackLocal: '在线语音合成失败，已自动回退到本地系统语音。',
      saveFailed: '保存失败',
      // ---- 全局语音浮层 + AI 界面操控（设置项与浮层共用） ----
      globalVoice: '全局语音浮层',
      globalVoiceHint: '在任意页面右下角常驻一个麦克风浮层。开启后自动打开麦克风进入待机/聆听：有唤醒词时先说唤醒词才接收命令（唤醒词留空则直接聆听）。开启期间输入框麦克风会隐藏，Alt+V 改为切换这个浮层（只剩一个语音入口）；关闭即恢复原状。窗口隐藏/最小化时渲染器定时器会被节流，后台可靠性有限（已优先用 AudioWorklet 绕过）。',
      globalShortcut: '全局语音快捷键',
      globalShortcutHint: '窗口内任意页面按一下切换全局语音（默认 Ctrl+Alt+V；macOS 上同时支持 Cmd+Option+V 别名）。与输入框里的「语音模式快捷键」是两套；要在其它应用前台时也能用，需打开下面的「系统级全局热键」。',
      voicePromptMode: '语音文本注入方式',
      voicePromptModeHint: '「排到下一轮」把识别文本排进当前会话的下一轮；「插入下一步」在助手生成中打断并插入（steer）。',
      voicePromptModeQueue: '排到下一轮（queue）',
      voicePromptModeSteer: '插入下一步（steer）',
      uiControl: '允许 AI 操控界面',
      uiControlHint: '开启后模型可调用 voice_ui 操作界面（本开关关闭时工具根本不存在）。界面动作由全局语音浮层执行，所以还需开启「全局语音浮层」。a11y 边界：密码框禁止代填；外链/文件选择器等会离开应用的点击被拒绝；多窗口时只有最先响应的窗口执行；危险动作必须先经确认（可点确认条或说「允许/拒绝」）。',
      uiConfirm: '危险 UI 动作需要确认',
      uiConfirmHint: '切换会话 / 新建会话 / 执行命令 / 发送消息 / 停止生成 / a11y 点击与输入会先弹确认条（或等语音「允许/拒绝」）；用户拒绝或超时则不执行。',
      globalHotkeyHelper: '系统级全局热键',
      globalHotkeyHelperHint: '让快捷键在 DSH 窗口未聚焦时也生效。Windows 用 PowerShell 子进程注册；macOS/Linux 依赖可选原生模块 uiohook-napi（需在插件目录 pnpm install；macOS 还需在「系统设置 → 隐私与安全性 → 辅助功能」里授权 DSH）。必须同时开启「全局语音浮层」；失败会静默降级（窗口内快捷键不受影响），实际状态见下方「系统级热键状态」与 /diagnostics。',
      globalIdle: '全局语音 · 待机',
      globalListening: '全局语音 · 聆听中',
      globalTranscribing: '识别中…',
      globalSending: '发送中…',
      globalSent: '已发送',
      globalQueued: '已排队（助手正在生成，回复结束后处理）',
      globalNoSession: '没有当前会话',
      globalCreatingSession: '正在新建会话…',
      globalSendFailed: '发送失败',
      globalRecognizeFailed: '识别失败',
      globalStartHint: '点一下开始 / 停止全局语音',
      globalMicOnHint: '全局语音聆听中 · 点一下关闭',
      globalAskConfirm: 'AI 请求执行界面操作',
      globalAllow: '允许',
      globalDeny: '拒绝',
      globalUiRunning: '执行界面操作…',
      globalUiFailed: '界面操作失败',
      globalConfirmAllowed: '已允许',
      globalConfirmDenied: '已拒绝',
      globalConfirmSpeakHint: '也可以直接说「允许」或「拒绝」',
      // 确认条的目标描述：只说 ref（ui_click: e12）用户根本不知道在批准什么。
      globalConfirmClick: '点击「{name}」（{ref}）',
      globalConfirmType: '在「{name}」（{ref}）输入「{text}」',
      globalConfirmTypeFallback: '在 {ref} 输入「{text}」',
      globalConfirmKey: '发送按键「{key}」',
      globalConfirmTimeout: '确认超时，已取消',
      globalActionExpired: '动作已超时，未执行',
      // ---- v3 唤醒词（全局语音待机） ----
      wakeWord: '唤醒词',
      wakeWordHint: '待机时先说这个词再下命令（默认「小D」）。2 个字的唤醒词必须精确匹配；3 个字以上允许 1 个字的识别误差（同音/口音）。留空 = 关闭唤醒词（说话直接发送）。只对全局语音浮层生效，输入框麦克风不受影响；注意常开麦待机会持续占用麦克风（耗电/隐私）。',
      globalWakeStandby: '待机 · 说『{word}』唤醒',
      globalWakeActive: '聆听中（说『{word}』唤醒）',
      globalWakeStandbyHint: '待机中 · 说『{word}』唤醒',
      globalWakeListening: '在听，请说命令',
      wakeWordOffNotice: '唤醒词已关闭：说话会直接发送（v2 行为）。',
      // ---- 系统级热键只读状态（设置面板「高级与诊断」） ----
      hotkeyStatusTitle: '系统级热键状态',
      hotkeyStatusLabel: '状态',
      hotkeyStatusPlatform: '平台',
      hotkeyStatusReason: '说明',
      hotkeyStatusLoading: '读取中…',
      hotkeyStatusUnknown: '未知（诊断不可用）',
      hotkeyStatusDisabled: '未开启',
      hotkeyStatusStarting: '等待注册…',
      hotkeyStatusEnabled: '已启用（{accelerator}）',
      hotkeyStatusFailed: '失败（{reason}）',
      hotkeyStatusRefresh: '刷新状态',
      hotkeyStatusNeedsOverlay: '需要同时开启「全局语音浮层」才会生效：服务端已跳过系统级热键。',
    }

    /** 英文词典。 */
    const en = {
      buttonHint: 'Click to start / stop voice mode',
      stopHint: 'Voice conversation on · click to stop',
      listening: 'Listening',
      speaking: 'Reading',
      stopSpeaking: 'Stop reading',
      stopSpeakingHint: 'Stop reading aloud, and skip the rest of this reply',
      // The status line sits next to the button, so it only carries a short
      // word; the full explanation lives in the "…Detail" entry and shows up
      // as the tooltip when hovering the status text.
      stoppedSpeaking: 'Stopped',
      micDenied: 'Mic blocked',
      micDeniedDetail: 'Cannot access the microphone (check permission).',
      micUnsupported: 'No recording',
      micUnsupportedDetail: 'Recording is not supported in this browser.',
      micStarting: 'Opening mic…',
      micFailed: 'Mic unavailable',
      micFailedDetail: 'No usable audio input device (it may be in use by another app).',
      modelLoading: 'Loading model…',
      modelLoadingDetail: 'Loading the recognition model (20–40s the first time).',
      modelFailed: 'Model failed',
      modelFailedDetail: 'Check the tier in settings.',
      empty: 'Nothing heard',
      emptyDetail: 'Nothing heard, please try again.',
      recognizeFailed: 'Recognition failed',
      recognizeFailedDetail: 'The text is still in the composer.',
      ttsFailed: 'TTS failed',
      ttsFailedDetail: 'Speech synthesis failed; this sentence was skipped. See /diagnostics or __DSH_VOICE_DEBUG__().ttsFailures.',
      model: 'Recognition model',
      modelHint: 'SenseVoice is built in (no download); Whisper tiers download on first use.',
      downloading: 'Downloading…',
      ready2: 'Ready',
      language: 'Recognition language',
      words: 'Custom word list',
      wordsHint: 'One per line: "correct=wrong" replaces the wrong word, e.g. "深度求索=深度球搜"; a bare "correct" is a hotword hint — only supported by the Zipformer2 (streaming) model, other models should use the = form.',
      autoSend: 'Send automatically after recognition',
      readAloud: 'Read the reply aloud',
      readAloudHint: 'Speak the assistant replies. When off, all reading options below are ignored. No need to enable voice mode — this switch alone is enough.',
      readAloudLag: 'Catch up to latest (seconds)',
      readAloudLagHint: 'When generation outpaces speech, allow the readout to lag at most this many seconds behind the screen (default 7.5s); beyond that it skips whole paragraphs and keeps the newest 3 (never starts mid-paragraph). 0 = read everything, no skipping (long replies fall further and further behind).',
      liveAsr: 'Live text mode',
      liveAsrHint: 'How the live text is produced while you speak. "Full re-recognition" is the most accurate but slows down on long sentences; "streaming" stays fast but is slightly less accurate. The final text always uses the current model.',
      liveAsrFull: 'Full re-recognition (most accurate)',
      liveAsrStream: 'Streaming decode (faster)',
      liveAsrAuto: 'Auto (stream for streaming models)',
      secRecognition: 'Speech recognition',
      secRecognitionHint: 'Recognition model, language hint and live-text mode.',
      secSynthesis: 'Speech synthesis',
      secSynthesisHint: 'Voice, engine and speaking parameters for read-aloud replies.',
      secModels: 'Models & downloads',
      secModelsHint: 'Preload, idle release, environment check and model downloads.',
      secInteraction: 'Voice interaction',
      secInteractionHint: 'What happens after a turn, silence detection and send timing.',
      secText: 'Text processing',
      secTextHint: 'Post-processing of recognition results and custom word list.',
      secAdvanced: 'Advanced & diagnostics',
      secAdvancedHint: 'Only needed for troubleshooting; usually collapsed.',
      advancedDiagnostics: 'Diagnostics endpoint',
      advancedDiagnosticsHint: 'Host GET /dsh-voice-typing/diagnostics: read-aloud scheduler state, TTS failure counters, configWarnings and more.',
      advancedDebug: 'Debug snapshot',
      advancedDebugHint: 'Run __DSH_VOICE_DEBUG__() in the browser console: read-aloud queue, ack/fallback counters, playback context state and highlight diagnostics.',
      silenceMsHint: 'How long silence counts as "finished". Too short cuts long sentences, too long delays replies.',
      autoSendHint: 'Send automatically after recognition. When off, text stays in the composer.',
      autoSendExtraMs: 'Wait before sending (ms)',
      autoSendExtraMsHint: 'Wait a moment after you stop speaking, to merge short sentences.',
      removeFillersHint: 'Remove filler words like "um", "uh", "er".',
      unsaved: 'Unsaved changes',
      loadingConfig: 'Loading configuration…',
      configLoadFailed: 'Failed to load configuration, please retry',
      modelNoReady: '(download one in Models first)',
      modelInUse: 'in use',
      preloadModels: 'Preload models when enabled',
      preloadModelsHint: 'Load the selected model in the background so the first utterance does not wait.',
      idleReleaseMinutes: 'Release when idle (min)',
      idleReleaseMinutesHint: 'Free the model after this many idle minutes. 0 keeps it loaded.',
      ttsCurrent: 'Current voice',
      localVoiceDefault: 'system default voice',
      removeFillers: 'Remove filler words',
      silenceMs: 'Silence break (ms)',
      shortcut: 'Voice mode shortcut',
      shortcutHint: 'Press to toggle voice mode (same as the mic button): off turns it on and starts listening, on stops the readout and closes the mic. Format like Alt+V; takes effect immediately. Avoid Ctrl+Shift+V and Ctrl+Space.',
      mode: 'Interaction mode',
      modeHint: 'Click the button to toggle voice mode (text streams in, silence auto-sends, next turn starts after the reply is read); right-click stops as well. The dropdown decides whether to keep listening after each turn.',
      modeToggle: 'Continuous conversation',
      modeOnce: 'Say once',
      ttsEngine: 'Speech engine',
      ttsEngineHint: 'Online sounds best but needs network; neural models are offline with near-online quality; system voices are fastest but robotic; GPT-SoVITS uses your own server (the plugin only forwards text for synthesis).',
      sovitsHint: 'External GPT-SoVITS: the plugin ships no model and does no cloning — it only POSTs each sentence to your api_v2 server (default 127.0.0.1:9880). Reference audio/text are configured by you; failures never fall back to online.',
      sovitsUrl: 'GPT-SoVITS server URL',
      sovitsUrlHint: 'Official api_v2 defaults to http://127.0.0.1:9880; either the /tts endpoint or the service root works.',
      sovitsRefAudio: 'Reference audio path (server-side)',
      sovitsRefAudioHint: 'A wav path readable on the GPT-SoVITS machine (the official api_v2 requires it on every request).',
      sovitsPromptText: 'Reference audio text',
      sovitsPromptTextHint: 'What the reference audio says; leave empty to use the server default.',
      sovitsTextLang: 'Synthesis language',
      sovitsPromptLang: 'Reference audio language',
      neuralModel: 'Neural model',
      neuralSpeaker: 'Speaker',
      neuralReady: 'Ready',
      neuralDownload: 'Download model',
      neuralDownloading: 'Downloading…',
      neuralNoModel: '(no available model)',
      neuralNoModelHint: 'No downloaded model yet — download one below.',
      neuralReadyModels: '{count} model(s) available',
      envCheck: 'Environment check',
      envChecking: 'Checking…',
      envRecheck: 'Re-check',
      modelGroupAsr: 'Recognition models',
      modelGroupTts: 'Speech models',
      modelBuiltIn: 'Built-in',
      voice: 'Read-aloud voice',
      voiceHint: 'Chinese voices work best; Neural voices are higher quality.',
      pitch: 'Read-aloud pitch',
      volume: 'Read-aloud volume',
      ttsFormat: 'Audio format',
      rate: 'Read-aloud speed',
      section: 'Voice input',
      save: 'Save',
      saved: 'Saved',
      downloadFailed: 'Download failed',
      retry: 'Retry',
      envCurrent: 'In use',
      envSovitsUrl: 'Server URL',
      readAloudOffNotice: 'Read-aloud is off: the speech settings below are still saved, but will not take effect.',
      ttsEngineInvalid: 'The configured speech engine is invalid; treating it as "Edge online". It will be fixed on save.',
      neuralModelMissingWarning: 'The configured local neural model is not installed (or was removed); saving will switch to the first ready model.',
      languageModelUnsupported: 'The current recognition model does not support a language hint (only SenseVoice does); this setting has no effect.',
      languageNotInModel: 'The current recognition model does not support this language; saving will fall back to "Auto".',
      liveAsrStreamNeedsModel: '"Streaming decode" requires the Zipformer2 Chinese model (zipformer2-zh) to be downloaded first.',
      modeOnceNeedsAutoSend: '"Say once" relies on auto-send; auto-send is off, so this mode has no effect.',
      ttsFallbackOnline: 'Local speech synthesis failed; fell back to Edge online (requires network).',
      ttsFallbackLocal: 'Online speech synthesis failed; fell back to local system voices.',
      saveFailed: 'Save failed',
      // ---- Global voice overlay + AI UI control (shared by settings and overlay) ----
      globalVoice: 'Global voice overlay',
      globalVoiceHint: 'An always-available mic pill in the bottom-right corner on any page. Turning it on opens the mic automatically and enters standby/listening: with a wake word it only accepts commands after the wake word (leave the wake word empty to listen directly). While on, the composer mic is hidden and Alt+V toggles this overlay (a single voice entry); turn it off to restore the old behaviour. Timers are throttled while the window is hidden/minimized, so background reliability is limited (AudioWorklet is used to work around it).',
      globalShortcut: 'Global voice shortcut',
      globalShortcutHint: 'Press anywhere in the window to toggle global voice (default Ctrl+Alt+V; on macOS Cmd+Option+V is also accepted). Separate from the composer "Voice mode shortcut" above; to use it while another app is focused, turn on "OS-level global hotkeys" below.',
      voicePromptMode: 'Voice text injection mode',
      voicePromptModeHint: '"Queue next turn" adds the recognized text to the current session\'s next turn; "Steer" interrupts the running generation and inserts it.',
      voicePromptModeQueue: 'Queue next turn (queue)',
      voicePromptModeSteer: 'Steer current turn (steer)',
      uiControl: 'Let the AI control the UI',
      uiControlHint: 'When enabled the model can call the voice_ui tool to operate the UI (the tool does not exist while this is off). Actions are executed by the global voice overlay, so "Global voice overlay" must be on too. a11y boundaries: password fields are never filled; clicks that leave the app (external links, file pickers) are refused; with multiple windows only the first responder executes; dangerous actions always ask for confirmation (confirmation bar or "allow/deny" spoken).',
      uiConfirm: 'Confirm dangerous UI actions',
      uiConfirmHint: 'Switch session / new session / run command / send prompt / stop generation / a11y click & type first show a confirmation bar (or wait for spoken "allow/deny"); rejecting or timing out means nothing runs.',
      globalHotkeyHelper: 'OS-level global hotkeys',
      globalHotkeyHelperHint: 'Makes the shortcut work while the DSH window is not focused. Windows uses a PowerShell child process; macOS/Linux rely on the optional native module uiohook-napi (run pnpm install in the plugin directory; macOS also requires granting DSH Accessibility permission in System Settings → Privacy & Security → Accessibility). The "Global voice overlay" switch must be on as well; failures degrade silently (the in-window shortcut still works) and the live state is shown under "OS-level hotkey status" below and in /diagnostics.',
      globalIdle: 'Global voice · idle',
      globalListening: 'Global voice · listening',
      globalTranscribing: 'Recognizing…',
      globalSending: 'Sending…',
      globalSent: 'Sent',
      globalQueued: 'Queued (assistant is replying; handled after this turn)',
      globalNoSession: 'No current session',
      globalCreatingSession: 'Creating a session…',
      globalSendFailed: 'Send failed',
      globalRecognizeFailed: 'Recognition failed',
      globalStartHint: 'Click to start / stop global voice',
      globalMicOnHint: 'Global voice listening · click to stop',
      globalAskConfirm: 'AI wants to control the UI',
      globalAllow: 'Allow',
      globalDeny: 'Deny',
      globalUiRunning: 'Running UI action…',
      globalUiFailed: 'UI action failed',
      globalConfirmAllowed: 'Allowed',
      globalConfirmDenied: 'Denied',
      globalConfirmSpeakHint: 'You can also say "allow" or "deny"',
      globalConfirmClick: 'Click "{name}" ({ref})',
      globalConfirmType: 'Type "{text}" into "{name}" ({ref})',
      globalConfirmTypeFallback: 'Type "{text}" into {ref}',
      globalConfirmKey: 'Press key "{key}"',
      globalConfirmTimeout: 'Confirmation timed out; cancelled',
      globalActionExpired: 'Action expired; not executed',
      // ---- v3 wake word (global voice standby) ----
      wakeWord: 'Wake word',
      wakeWordHint: 'While the global voice overlay is in standby, say this word before a command (default "小D"). A 2-character wake word must match exactly; 3+ characters allow one character of recognition tolerance. Empty = off (speech is sent directly). Only applies to the global overlay, not the composer mic; always-on standby keeps the microphone busy (battery/privacy).',
      globalWakeStandby: 'Standby · say "{word}" to wake',
      globalWakeActive: 'Listening (say "{word}")',
      globalWakeStandbyHint: 'Standby · say "{word}" to wake',
      globalWakeListening: 'Listening — say your command',
      wakeWordOffNotice: 'Wake word is off: speech is sent directly (v2 behavior).',
      // ---- OS-level hotkey status (read-only row in Advanced & diagnostics) ----
      hotkeyStatusTitle: 'OS-level hotkey status',
      hotkeyStatusLabel: 'Status',
      hotkeyStatusPlatform: 'Platform',
      hotkeyStatusReason: 'Detail',
      hotkeyStatusLoading: 'Loading…',
      hotkeyStatusUnknown: 'Unknown (diagnostics unavailable)',
      hotkeyStatusDisabled: 'Off',
      hotkeyStatusStarting: 'Waiting for registration…',
      hotkeyStatusEnabled: 'Enabled ({accelerator})',
      hotkeyStatusFailed: 'Failed ({reason})',
      hotkeyStatusRefresh: 'Refresh status',
      hotkeyStatusNeedsOverlay: 'Requires "Global voice overlay" to be on as well — the server has skipped OS-level hotkeys.',
    }

    /**
     * 识别语言的中文名映射。
     * 语言代码（auto/zh/en/yue…）直接显示不直观。
     */
    const LANGUAGE_LABELS = {
      auto: '自动识别',
      zh: '中文（普通话）',
      en: '英语',
      yue: '粤语',
      ja: '日语',
      ko: '韩语',
    }

    /**
     * 把语言代码转成中文展示名。
     * @param {string} code - 语言代码。
     * @returns {string} 展示名。
     */
    function languageLabel(code) {
      const key = String(code ?? '').trim()
      return LANGUAGE_LABELS[key] ?? key
    }

    /**
     * 音色中文名映射。
     * Edge 音色名是英文短名（zh-CN-YunxiNeural），直接显示不直观，
     * 这里映射成「中文名（性别·地区）」的展示形式。
     */
    const VOICE_LABELS = {
      'zh-CN-XiaoxiaoNeural': '晓晓（女·普通话）',
      'zh-CN-XiaoyiNeural': '晓伊（女·普通话）',
      'zh-CN-YunjianNeural': '云健（男·普通话·浑厚）',
      'zh-CN-YunxiNeural': '云希（男·普通话·活泼）',
      'zh-CN-YunxiaNeural': '云夏（男·普通话·少年）',
      'zh-CN-YunyangNeural': '云扬（男·普通话·专业）',
      'zh-CN-liaoning-XiaobeiNeural': '晓北（女·东北话）',
      'zh-CN-shaanxi-XiaoniNeural': '晓妮（女·陕西话）',
      'zh-HK-HiuGaaiNeural': '曉佳（女·粤语）',
      'zh-HK-HiuMaanNeural': '曉曼（女·粤语）',
      'zh-HK-WanLungNeural': '雲龍（男·粤语）',
      'zh-TW-HsiaoChenNeural': '曉臻（女·台湾）',
      'zh-TW-HsiaoYuNeural': '曉雨（女·台湾）',
      'zh-TW-YunJheNeural': '雲哲（男·台湾）',
      'Microsoft Huihui Desktop': '慧慧（系统·女）',
      'Microsoft Zira Desktop': 'Zira（系统·英文女）',
      // macOS say 语音
      Tingting: '婷婷（系统·普通话女）',
      Meijia: '美佳（系统·台湾女）',
      Sinji: '新知（系统·普通话女）',
      'Yu-shu': '语舒（系统·普通话女）',
      'Li-mu': '李慕（系统·普通话男）',
      // Linux espeak-ng 语音
      cmn: '普通话（espeak·中文）',
      'cmn-latn-pinyin': '普通话拼音（espeak）',
      'yue': '粤语（espeak）',
    }

    /**
     * 把音色名转成中文展示名。
     * 未知音色原样返回，避免丢失信息。
     * @param {string} name - 音色短名。
     * @returns {string} 展示名。
     */
    function voiceLabel(name) {
      const key = String(name ?? '').trim()
      return VOICE_LABELS[key] ?? key
    }

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
    const DEFAULT_CONFIG = {}

    /**
     * 最近一次朗读失败的具体原因（诊断用）。
     *
     * 以前这里只 `throw new Error('tts failed')` —— HTTP 状态码和服务端
     * 返回的错误正文全被丢掉了，`ttsFailures` 涨到几十次也查不出为什么。
     * 「朗读没声」排查时最需要的就是这一行原文。
     */
    let lastTtsError = ''
    /** 最近一次 /tts 实际使用的引擎（响应头 x-tts-engine；空串 = 未知/老宿主）。 */
    let lastTtsEngine = ''
    /** 最近一次 /tts 的引擎回退目标（x-tts-engine-fallback：'online' / 'local' / 空）。 */
    let lastTtsFallback = ''
    /** 引擎回退累计次数（诊断 / 界面只提示一次用）。 */
    let ttsFallbackCount = 0

    /** 朗读引擎：文本 → 可播放 URL。 */
    async function fetchSpeech(text) {
      let resp
      try {
        resp = await fetch(`${BASE}/tts?text=` + encodeURIComponent(text))
      } catch (error) {
        lastTtsError = '网络错误：' + (error instanceof Error ? error.message : String(error))
        throw error
      }
      if (!resp.ok) {
        // 把状态码与服务端错误正文一起带出来（宿主 500 时会返回 {error}）。
        let detail = ''
        try {
          const raw = await resp.text()
          try {
            const parsed = JSON.parse(raw)
            detail = parsed?.error ?? raw
          } catch { detail = raw }
        } catch { /* 读不到正文就算了 */ }
        lastTtsError = `HTTP ${resp.status}${detail ? '：' + String(detail).slice(0, 160) : ''}`
        throw new Error(lastTtsError)
      }
      // 引擎回退是**用户可见**的事实：本地系统语音失败时宿主会自动改用在线
      //（文本会发到微软），老客户端完全不知道。这里把响应头记下来，由播放循环
      // 通过 hint 提示一次，并挂到诊断快照里。
      try {
        const meta = extractTtsMeta(resp.headers)
        if (meta.engine) lastTtsEngine = meta.engine
        if (meta.fallback) {
          lastTtsFallback = meta.fallback
          ttsFallbackCount += 1
        }
      } catch { /* 头读不到不影响出声 */ }
      const blob = await resp.blob()
      if (!blob.size) {
        lastTtsError = '返回了空音频（HTTP ' + resp.status + '）'
        throw new Error(lastTtsError)
      }
      lastTtsError = ''
      return URL.createObjectURL(blob)
    }

    /** 常驻的播放上下文：复用即可避免每次朗读都重新协商音频路由。 */
    let playCtxCache = null
    /** 播放上下文的最近一次构造/恢复失败原因（诊断用，`__DSH_VOICE_DEBUG__().audioError`）。 */
    let playCtxError = ''
    /** 播放上下文实际使用的采样率（0 表示未知；诊断用）。 */
    let playCtxRate = 0

    /**
     * 取得（必要时创建）常驻播放 AudioContext。
     * 每次新建 AudioContext 都要重新协商输出设备，蓝牙耳机上要 1~3 秒，
     * 复用同一个上下文可以把首次朗读的等待压到最短。
     *
     * **绝不能强制指定 `sampleRate`**（曾经写死 `{ sampleRate: 48000 }`）：
     * 输出设备不支持 48 kHz 时（蓝牙耳机常见 44.1 kHz）构造函数会抛
     * `NotSupportedError`，`playCtxCache` 永远是 null，`play()` 直接 return ——
     * 音频一句都播不出来，界面上却一直显示「朗读中」。
     * 现在是「先不带参数建，浏览器自己协商采样率」，
     * 解码后的音频由 `decodeAudioData` 自动重采样到上下文采样率，无需我们指定。
     *
     * @returns {AudioContext|null} 播放上下文。
     */
    function getPlayCtx() {
      const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)
      if (!Ctx) { playCtxError = '浏览器不支持 AudioContext'; return null }
      if (!playCtxCache || playCtxCache.state === 'closed') {
        playCtxCache = null
        // 不传 sampleRate：交给浏览器按实际输出设备协商。
        // 传了可能因为设备不支持而抛 NotSupportedError（蓝牙耳机最典型）。
        const attempts = [
          () => new Ctx(),
          // 极少数环境要求显式 rate：退回 48 kHz，再退回 44.1 kHz。
          () => new Ctx({ sampleRate: 48000 }),
          () => new Ctx({ sampleRate: 44100 }),
        ]
        for (const make of attempts) {
          try {
            const ctx = make()
            if (ctx) { playCtxCache = ctx; playCtxError = ''; break }
          } catch (error) {
            playCtxError = error instanceof Error ? error.message : String(error)
          }
        }
        if (!playCtxCache) return null
      }
      playCtxRate = Number(playCtxCache.sampleRate) || 0
      if (playCtxCache.state === 'suspended') {
        playCtxCache.resume?.().catch((error) => {
          playCtxError = error instanceof Error ? error.message : String(error)
        })
      }
      return playCtxCache
    }

    /**
     * 在首次用户手势时预热并恢复播放上下文。
     *
     * 朗读可能在「没开麦克风」时发生（读回复与语音模式无关）。
     * 此时没有任何路径去 resume 播放上下文 —— 浏览器自动播放策略会把它
     * 留在 suspended，于是 source.start() 排队不响、onended 不触发、
     * 朗读管道卡死。这里在第一次点击/按键时把上下文建好并恢复成 running。
     */
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const warmPlaybackOnGesture = () => {
        try {
          const ctx = getPlayCtx()
          void ctx?.resume?.()
        } catch { /* 忽略 */ }
      }
      try {
        window.addEventListener('pointerdown', warmPlaybackOnGesture, { once: true, capture: true })
        window.addEventListener('keydown', warmPlaybackOnGesture, { once: true, capture: true })
      } catch { /* 测试环境 window 可能是没有 addEventListener 的桩，忽略 */ }
    }

    /**
     * 线性重采样到 16k 单声道。
     * @param samples - 原始采样。
     * @param from - 原始采样率。
     * @returns 16k 采样。
     */
    function resampleTo16k(samples, from) {
      if (from === 16000) return samples
      const ratio = from / 16000
      const outLength = Math.max(1, Math.floor(samples.length / ratio))
      const out = new Float32Array(outLength)
      for (let i = 0; i < outLength; i++) {
        const pos = i * ratio
        const idx = Math.floor(pos)
        const frac = pos - idx
        const a = samples[idx] ?? 0
        const b = samples[idx + 1] ?? a
        out[i] = a + (b - a) * frac
      }
      return out
    }

    /**
     * 设置面板的快捷键输入框是否正在聚焦：聚焦时不应该触发录音。
     */
    let shortcutFieldFocused = false;

    /**
     * 校验快捷键格式。
     * 必须带至少一个修饰键，且主键不能是单独一个字母（否则打字会误触发）。
     * @param {string} value - 用户填写的组合键。
     * @returns {{ok: boolean, message: string}} 校验结果。
     */
    function validateShortcut(value) {
      const text = String(value ?? '').trim();
      if (!text) return { ok: false, message: '不能为空' };
      const parts = text.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
      if (parts.length < 2) return { ok: false, message: '至少要两个键，例如 Ctrl+Shift+Space' };
      const modifiers = parts.slice(0, -1);
      const key = parts[parts.length - 1];
      const allowed = ['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd', 'command', 'win', 'super'];
      for (const modifier of modifiers) {
        if (!allowed.includes(modifier)) return { ok: false, message: '不认识的修饰键：' + modifier };
      }
      if (modifiers.length === 0) return { ok: false, message: '至少要一个修饰键（Ctrl/Alt/Shift）' };
      // 单字母主键只有在配上 Ctrl/Alt/Meta 这类「强修饰键」时才安全；
      // 光 Shift+字母 会和正常打大写字母冲突，要拒绝。
      // 注意：默认快捷键 Alt+V 必须通过校验（以前这条规则会把它判为非法，
      // 于是「保存前校验快捷键」会直接把默认配置的保存按钮永久禁用）。
      const strongModifier = modifiers.some((m) => ['ctrl', 'control', 'alt', 'meta', 'cmd', 'command', 'win', 'super'].includes(m));
      if (key.length === 1 && /[a-z]/.test(key) && !strongModifier) {
        return { ok: false, message: '别用单个字母，否则打字会误触发（单字母需要搭配 Ctrl/Alt）' };
      }
      if (key === ' ') return { ok: false, message: '空格键写成 Space' };
      if (text.toLowerCase() === 'ctrl+shift+v') return { ok: false, message: 'Ctrl+Shift+V 是浏览器的「粘贴为纯文本」' };
      return { ok: true, message: '' };
    }

    /**
     * 全局共享的配置存储。
     * 设置面板与麦克风按钮是两个独立组件、各自持一份 config，
     * 保存后不互通就会导致「改了要刷新页面才生效」。这里用共享存储打通。
     */


    /* @bundle pure/gate.js */


    /* @bundle pure/draft.js */

    /**
     * 支持流式解码（边喂边出字）的模型 id。
     *
     * 只有 zipformer2 是流式模型 —— 宿主的 `/asr-stream` 只认它。
     *
     * 客户端不能 import 宿主模块（浏览器模块的 require 只能解析包名），
     * 所以这里维护一份。**换流式模型时要同步改这里** ——
     * test/live-asr.test.mjs 会检查它与宿主的 STREAM_MODEL_ID 一致。
     */
    const STREAM_MODEL_IDS = ['zipformer2-zh']


    /* @bundle pure/envelope.js */


    /* @bundle pure/backlog.js */


    /* @bundle pure/highlight.js */

    /*
     * 全局语音的纯逻辑（VAD 状态机 / 文本归一化 / AudioWorklet 源码生成）。
     * 与宿主侧无关，只被下面的 GlobalVoiceOverlay 使用。
     */
    /* @bundle pure/global-voice.js */

    /*
     * UI 动作协议（宿主 lib/ui-action-protocol.js 的镜像，两端逐条同构）。
     * 浮层执行模型下发的界面动作前，必须先过这里的校验。
     */
    /* @bundle pure/ui-action-protocol.js */

    /*
     * v2 通用 a11y 原语（快照/描述/按键解析/语音确认词，纯逻辑，可 Node 测试）。
     * 浏览器里只做「取元素、打 ref、派发事件」，判定逻辑都在这里。
     */
    /* @bundle pure/a11y.js */


    /* ================= 配置归一化 / 校验辅助（纯函数，可单测） ================= */
    /**
     * 这些常量的唯一真源在宿主 `lib/index.js` 的 DEFAULTS / 枚举；
     * 客户端要维护一份**只用于 UI 兜底与保存前归一化**的副本（浏览器模块
     * 不能 import 宿主模块）。test/config-ui.test.mjs 会校验两边关键默认值一致。
     */
    const TTS_ENGINES = ['online', 'neural', 'local', 'sovits']
    const LANGUAGE_CODES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']
    const LIVE_ASR_MODES = ['full', 'stream', 'auto']
    const INTERACTION_MODES = ['toggle', 'once']
    /** 语音文本注入方式：排到下一轮 / 插入当前回合（steer）。 */
    const VOICE_PROMPT_MODES = ['queue', 'steer']
    const RATE_OPTIONS = ['-50%', '-40%', '-30%', '-20%', '-10%', '+0%', '+10%', '+15%', '+20%', '+30%', '+40%', '+50%', '+75%', '+100%']
    const PITCH_OPTIONS = ['-50Hz', '-30Hz', '-20Hz', '-10Hz', '+0Hz', '+10Hz', '+20Hz', '+30Hz', '+50Hz']
    const VOLUME_OPTIONS = ['-50%', '-30%', '-20%', '-10%', '+0%', '+10%', '+20%', '+30%', '+50%']
    /** rate / pitch / volume 是宿主 schema 里的自由字符串；收窄到 UI 认识的形状。 */
    const RATE_PATTERN = /^[+-]?\d+(?:\.\d+)?%$/
    const PITCH_PATTERN = /^[+-]?\d+(?:\.\d+)?Hz$/
    const VOLUME_PATTERN = /^[+-]?\d+(?:\.\d+)?%$/
    const TTS_FORMATS = ['AUDIO_24KHZ_48KBITRATE_MONO_MP3', 'AUDIO_24KHZ_96KBITRATE_MONO_MP3']
    const SOVITS_LANGS = ['zh', 'en', 'ja', 'ko', 'yue']
    /** 「空闲释放」UI 提供的档位（宿主 schema 允许 0..1440 任意整数，UI 只给常用值）。 */
    const IDLE_RELEASE_OPTIONS = [0, 5, 10, 30, 60]
    /** 字符串字段的长度上限（与 lib/config-schema.js 对齐，避免保存时被 400 打回）。 */
    const STRING_LIMITS = {
      model: 64,
      voice: 200,
      localVoice: 200,
      neuralModel: 64,
      sovitsRefAudio: 1024,
      sovitsPromptText: 500,
      shortcut: 64,
      // 与宿主 schema 的 globalShortcut 上限对齐（保存时超长会被 400 打回）。
      globalShortcut: 64,
      // v3 唤醒词：与宿主 schema maxLen:32 对齐。
      wakeWord: 32,
    }
    const WORDS_MAX_ENTRIES = 200
    const WORDS_MAX_CHARS = 100
    /** UI 兜底用的默认配置（与宿主 DEFAULTS 对齐；加载失败/残缺配置时显示用）。 */
    const UI_DEFAULTS = {
      model: 'sensevoice',
      language: 'auto',
      liveAsr: 'full',
      ttsEngine: 'online',
      voice: 'zh-CN-XiaoxiaoNeural',
      localVoice: '',
      neuralModel: 'vits-melo-zh_en',
      neuralSpeaker: 0,
      sovitsUrl: 'http://127.0.0.1:9880',
      sovitsRefAudio: '',
      sovitsPromptText: '',
      sovitsTextLang: 'zh',
      sovitsPromptLang: 'zh',
      rate: '+10%',
      pitch: '+0Hz',
      volume: '+0%',
      ttsFormat: 'AUDIO_24KHZ_48KBITRATE_MONO_MP3',
      autoSend: true,
      readAloud: false,
      readAloudLag: 7.5,
      mode: 'toggle',
      silenceMs: 1500,
      autoSendExtraMs: 1200,
      removeFillers: false,
      words: [],
      shortcut: 'Alt+V',
      idleReleaseMinutes: 10,
      preloadModels: true,
      // ---- 全局语音 + AI 界面操控（与宿主 DEFAULTS 逐键对齐） ----
      globalVoice: false,
      globalShortcut: 'Ctrl+Alt+V',
      voicePromptMode: 'queue',
      uiControl: false,
      uiConfirm: true,
      globalHotkeyHelper: false,
      // v3：全局语音待机唤醒词；空串 = 关闭唤醒词（回到 v2「说话直接发」）。
      wakeWord: '小D',
    }

    /** 归一化语音引擎；非法返回 ''（调用方决定回退值）。 */
    function normalizeEngine(value) {
      const text = String(value ?? '').trim().toLowerCase()
      return TTS_ENGINES.includes(text) ? text : ''
    }

    /** 归一化枚举；非法回退 fallback。 */
    function normalizeEnum(value, allowed, fallback) {
      const text = String(value ?? '').trim().toLowerCase()
      return allowed.includes(text) ? text : fallback
    }

    /** 识别语言：非法回退 auto。 */
    function normalizeLanguage(value) {
      return normalizeEnum(value, LANGUAGE_CODES, 'auto')
    }

    /** GPT-SoVITS 语言：非法回退 zh。 */
    function normalizeSovitsLang(value) {
      return normalizeEnum(value, SOVITS_LANGS, 'zh')
    }

    /** 数值归一化：非法/越界 → 回退/夹取；整数可指定取整。 */
    function normalizeNumber(value, { min, max, fallback, integer = false }) {
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      let out = Math.max(min, Math.min(max, n))
      if (integer) out = Math.round(out)
      return out
    }

    /** 「发送前等待」：空输入回退 1200（而不是 Number('')=0）。 */
    function clampAutoSendExtraMs(raw) {
      const text = String(raw ?? '').trim()
      if (!text) return UI_DEFAULTS.autoSendExtraMs
      return normalizeNumber(text, { min: 0, max: 5000, fallback: UI_DEFAULTS.autoSendExtraMs, integer: true })
    }

    /** 静音断句：空/非法回退 1500，范围 500..5000。 */
    function clampSilenceMs(raw) {
      const text = String(raw ?? '').trim()
      if (!text) return UI_DEFAULTS.silenceMs
      return normalizeNumber(text, { min: 500, max: 5000, fallback: UI_DEFAULTS.silenceMs, integer: true })
    }

    /** 追赶秒数：空/非法回退 7.5；范围 0..120，0.5 秒步进。 */
    function clampReadAloudLag(raw) {
      const text = String(raw ?? '').trim()
      if (!text) return UI_DEFAULTS.readAloudLag
      const n = Number(text)
      if (!Number.isFinite(n)) return UI_DEFAULTS.readAloudLag
      return Math.max(0, Math.min(120, Math.round(n * 2) / 2))
    }

    /**
     * 词表文本 → 数组（保存/失焦时用）。
     * 逐行 trim、去空行、单条 ≤100 字符、最多 200 条。
     */
    function parseWordsText(text) {
      return String(text ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.slice(0, WORDS_MAX_CHARS))
        .slice(0, WORDS_MAX_ENTRIES)
    }

    /** 词表数组 → textarea 文本（显示用；**不做 trim**，保留用户输入原样）。 */
    function formatWordsText(words) {
      if (!Array.isArray(words)) return ''
      return words.map((w) => String(w ?? '')).join('\n')
    }

    /**
     * 空闲释放分钟数归一化（宿主 schema：0..1440 的整数；UI 只列常用档位）。
     */
    function normalizeIdleReleaseMinutes(value) {
      return normalizeNumber(value, {
        min: 0, max: 1440, fallback: UI_DEFAULTS.idleReleaseMinutes, integer: true,
      })
    }

    /** 截断到指定长度（宿主 schema 的 maxLen，避免保存时 400）。 */
    function limitString(value, maxLen, fallback) {
      const text = String(value ?? '').trim()
      if (!text) return fallback
      return text.length > maxLen ? text.slice(0, maxLen) : text
    }

    /**
     * 唤醒词归一化：trim + ≤32 字符。
     *
     * **不能用 limitString**：唤醒词允许空串（= 关闭唤醒词），
     * 而 limitString 的约定是「空 → 回退默认值」——那会把用户特意清空的
     * 唤醒词又变回「小D」，等于关不掉。
     *
     * @param {unknown} value - 表单/配置里的唤醒词。
     * @returns {string} 归一化后的唤醒词（可能为空串）。
     */
    function normalizeWakeWord(value) {
      const text = String(value ?? '').trim()
      return text.length > STRING_LIMITS.wakeWord ? text.slice(0, STRING_LIMITS.wakeWord) : text
    }

    /**
     * 形如 `+25%` / `-5Hz` 的「选项字符串」：不符合形状/超长 → 回退默认。
     * 宿主 schema 对 rate/pitch/volume 允许自由字符串（Edge 支持任意值），
     * 但 UI 只认识这几种形状；坏值不应被原样保存（到合成期才失败）。
     */
    function limitChoiceString(value, pattern, fallback) {
      const text = String(value ?? '').trim()
      if (!text || text.length > 16 || !pattern.test(text)) return fallback
      return text
    }

    /**
     * UI 下拉的选项列表里补上「当前值」。
     *
     * 宿主 schema 对 rate/pitch/volume/idle 允许列表外的值（老配置可能有），
     * 直接渲染会让浏览器显示成第一项（看起来像被改了）。把当前值作为额外
     * 选项保留下来，保存时也原样保留，避免「一保存就被悄悄改值」。
     */
    function withCurrentOption(options, current) {
      const list = Array.isArray(options) ? options.slice() : []
      const value = current === undefined || current === null ? '' : String(current)
      if (value && !list.includes(value)) list.push(value)
      return list
    }

    /**
     * 保存前归一化：把表单值收敛成宿主 schema 能接受的形状。
     *
     * - 枚举非法 → 回退默认（ttsEngine/language/liveAsr/mode/rate/pitch/volume/ttsFormat/sovits*）；
     * - 数值越界/非法 → 夹取/回退默认；
     * - `neuralModel` 不在已就绪列表且列表非空 → 自动改用第一个（避免宿主「未知的本地神经模型」）；
     * - 单说话人模型 → neuralSpeaker 归 0；
     * - 识别语言按当前模型过滤（非 SenseVoice / 模型不支持的语言 → auto）。
     *
     * @param {object} raw - 表单里的 config。
     * @param {{readyNeuralIds?: string[], asrModel?: object, neuralSpeakers?: number}} [ctx]
     * @returns {object} 可 POST 的完整配置。
     */
    function normalizeForSave(raw, ctx = {}) {
      const cfg = raw && typeof raw === 'object' ? raw : {}
      const engine = normalizeEngine(cfg.ttsEngine) || UI_DEFAULTS.ttsEngine
      const model = String(cfg.model ?? '').trim() || UI_DEFAULTS.model

      // 识别语言按「当前实际选中的模型」过滤：只有 SenseVoice 真正消费 language；
      // 其它模型（whisper / zipformer2）在宿主里根本不读它 → 保存成实际有效的值。
      let language = normalizeLanguage(cfg.language)
      if (ctx.asrModel) {
        const langs = Array.isArray(ctx.asrModel.languages) && ctx.asrModel.languages.length
          ? ctx.asrModel.languages
          : null
        const supportsLanguage = ctx.asrModel.engine === 'sensevoice'
        if (!supportsLanguage) language = 'auto'
        else if (langs && language !== 'auto' && !langs.includes(language)) language = 'auto'
      }

      // 神经模型：配置里的值如果不在已下载列表里，宿主合成时会报「未知的本地神经模型」
      //（整段朗读全部失败）。保存时自动纠正到第一个已就绪模型。
      const readyNeuralIds = Array.isArray(ctx.readyNeuralIds) ? ctx.readyNeuralIds.filter(Boolean) : null
      let neuralModel = String(cfg.neuralModel ?? '').trim() || UI_DEFAULTS.neuralModel
      if (engine === 'neural' && readyNeuralIds && readyNeuralIds.length && !readyNeuralIds.includes(neuralModel)) {
        neuralModel = readyNeuralIds[0]
      }
      let neuralSpeaker = normalizeNumber(cfg.neuralSpeaker, {
        min: 0, max: 1000, fallback: UI_DEFAULTS.neuralSpeaker, integer: true,
      })
      const speakers = Number(ctx.neuralSpeakers)
      if (Number.isFinite(speakers) && speakers <= 1) neuralSpeaker = 0

      return {
        model: limitString(model, STRING_LIMITS.model, UI_DEFAULTS.model),
        language,
        liveAsr: normalizeEnum(cfg.liveAsr, LIVE_ASR_MODES, UI_DEFAULTS.liveAsr),
        ttsEngine: engine,
        voice: limitString(cfg.voice, STRING_LIMITS.voice, UI_DEFAULTS.voice),
        localVoice: limitString(cfg.localVoice, STRING_LIMITS.localVoice, ''),
        neuralModel: limitString(neuralModel, STRING_LIMITS.neuralModel, UI_DEFAULTS.neuralModel),
        neuralSpeaker,
        // 空串 = 使用默认服务地址（宿主 schema：url 类型，空串合法）。
        sovitsUrl: String(cfg.sovitsUrl ?? '').trim(),
        sovitsRefAudio: limitString(cfg.sovitsRefAudio, STRING_LIMITS.sovitsRefAudio, ''),
        sovitsPromptText: limitString(cfg.sovitsPromptText, STRING_LIMITS.sovitsPromptText, ''),
        sovitsTextLang: normalizeSovitsLang(cfg.sovitsTextLang),
        sovitsPromptLang: normalizeSovitsLang(cfg.sovitsPromptLang),
        // 宿主 schema 里 rate/pitch/volume 是字符串（Edge 允许任意 "+25%"/"-5Hz"），
        // UI 只列常用档位；**不要**把列表外的合法值强制改成默认（会悄悄改用户设置）。
        rate: limitChoiceString(cfg.rate, RATE_PATTERN, UI_DEFAULTS.rate),
        pitch: limitChoiceString(cfg.pitch, PITCH_PATTERN, UI_DEFAULTS.pitch),
        volume: limitChoiceString(cfg.volume, VOLUME_PATTERN, UI_DEFAULTS.volume),
        ttsFormat: normalizeEnum(cfg.ttsFormat, TTS_FORMATS, UI_DEFAULTS.ttsFormat),
        autoSend: cfg.autoSend !== false,
        readAloud: cfg.readAloud === true,
        readAloudLag: clampReadAloudLag(cfg.readAloudLag),
        mode: normalizeEnum(cfg.mode, INTERACTION_MODES, UI_DEFAULTS.mode),
        silenceMs: clampSilenceMs(cfg.silenceMs),
        autoSendExtraMs: clampAutoSendExtraMs(cfg.autoSendExtraMs),
        removeFillers: cfg.removeFillers === true,
        words: parseWordsText(formatWordsText(cfg.words)),
        shortcut: limitString(cfg.shortcut, STRING_LIMITS.shortcut, UI_DEFAULTS.shortcut),
        idleReleaseMinutes: normalizeIdleReleaseMinutes(cfg.idleReleaseMinutes),
        preloadModels: cfg.preloadModels !== false,
        // ---- 全局语音 + AI 界面操控 ----
        // 布尔一律严格比较：旧配置里可能是字符串 "false"（手改 settings.yaml），
        // 用 != false 会把它当成 true，等于偷偷打开了麦克风常驻。
        globalVoice: cfg.globalVoice === true,
        // 快捷键格式由设置面板用 validateShortcut 挡；这里只做长度收敛，
        // 空串回退默认值（不能把空快捷键存进去 —— 保存成功但热键永久失效）。
        globalShortcut: limitString(cfg.globalShortcut, STRING_LIMITS.globalShortcut, UI_DEFAULTS.globalShortcut),
        voicePromptMode: normalizeEnum(cfg.voicePromptMode, VOICE_PROMPT_MODES, UI_DEFAULTS.voicePromptMode),
        uiControl: cfg.uiControl === true,
        uiConfirm: cfg.uiConfirm !== false,
        globalHotkeyHelper: cfg.globalHotkeyHelper === true,
        // v3：空串是合法值（= 关闭唤醒词），不能走 limitString 的「空→默认」。
        wakeWord: normalizeWakeWord(cfg.wakeWord),
      }
    }

    /** 兜底错误文案（collectSaveErrors 拿不到可读原因时用）。 */
    const UI_DEFAULT_SAVE_ERROR_TEXT = '保存失败：配置未通过校验'

    /**
     * 新配置键的中文名（仅用于把 400 的 `{key,reason}` 展示得更像人话）。
     * 旧键不在此表里，保持原来的「key：reason」格式（既有测试依赖该形状）。
     */
    const UI_SAVE_ERROR_LABELS = {
      globalVoice: '全局语音',
      globalShortcut: '全局快捷键',
      voicePromptMode: '语音注入方式',
      uiControl: 'AI 界面操控',
      uiConfirm: 'UI 动作确认',
      globalHotkeyHelper: '全局热键 helper',
      wakeWord: '唤醒词',
    }

    /**
     * 把 POST /config 的 400 响应（`{ok:false, errors:[{key,reason}]}`）变成可读字符串列表。
     * 兼容：errors 为字符串数组 / 对象数组 / 单个字符串 / `{error}`。
     */
    function collectSaveErrors(payload) {
      const out = []
      const push = (value) => {
        if (value === undefined || value === null) return
        if (Array.isArray(value)) { for (const item of value) push(item); return }
        if (typeof value === 'string') {
          const text = value.trim()
          if (text) out.push(text)
          return
        }
        if (typeof value === 'object') {
          const reason = value.reason ?? value.message ?? value.error
          if (reason === undefined || reason === null || reason === '') return
          const key = value.key === undefined || value.key === null ? '' : String(value.key)
          // 新键映射成中文名，旧键保持原样（既有测试断言 `ttsEngine：…` 的形状）。
          const label = UI_SAVE_ERROR_LABELS[key] ?? key
          out.push(label ? `${label}：${String(reason)}` : String(reason))
        }
      }
      if (payload && typeof payload === 'object') {
        push(payload.errors)
        if (!out.length) push(payload.error)
        if (!out.length && payload.ok === false) out.push(UI_DEFAULT_SAVE_ERROR_TEXT)
      }
      return out.slice(0, 20)
    }

    /**
     * 读取 /tts 响应头里的引擎信息（`x-tts-engine` / `x-tts-engine-fallback`）。
     * 头对象可能是 Headers（有 get）或普通对象；拿不到就返回空串，绝不抛错。
     */
    function extractTtsMeta(headers) {
      const get = (name) => {
        try {
          if (!headers) return ''
          if (typeof headers.get === 'function') return String(headers.get(name) ?? '')
          const lower = name.toLowerCase()
          return String(headers[name] ?? headers[lower] ?? '')
        } catch {
          return ''
        }
      }
      return {
        engine: get('x-tts-engine').trim().toLowerCase(),
        fallback: get('x-tts-engine-fallback').trim().toLowerCase(),
      }
    }

    /**
     * 归一化 `/tts/env` 的引擎清单（宿主新版可能返回 `supported/configured/url` 形状）。
     * 返回 `[{ id, label, status: 'ok'|'bad'|'', detail, current }]`；字段缺失不崩。
     */
    function formatEnvEngines(envInfo, currentEngine) {
      const list = Array.isArray(envInfo?.engines) ? envInfo.engines : []
      const configured = typeof envInfo?.configured === 'string' ? envInfo.configured : ''
      const active = configured || normalizeEngine(currentEngine) || 'online'
      return list.map((item, index) => {
        if (!item || typeof item !== 'object') {
          return { id: `engine-${index}`, label: String(item ?? ''), status: '', detail: '', current: false }
        }
        const id = String(item.id ?? `engine-${index}`)
        // 宿主两种行形状：
        //   { available, detail }（online/local/neural，真探测过）
        //   { supported, url, configured }（sovits 外部服务 —— **不探测**，别显示成 ✓/✗）
        let available
        if (item.available !== undefined) available = item.available
        else if (id === 'sovits' && item.supported === true) available = undefined
        else if (item.supported !== undefined) available = item.supported
        const status = available === true ? 'ok' : available === false ? 'bad' : ''
        let detail = ''
        if (item.detail !== undefined && item.detail !== null && item.detail !== '') detail = String(item.detail)
        else if (item.url) detail = String(item.url)
        else if (item.reason) detail = String(item.reason)
        return {
          id,
          label: String(item.label ?? item.id ?? ''),
          status,
          detail,
          current: item.configured === true || (Boolean(active) && id === active),
        }
      })
    }

    const configStore = {
      value: { ...DEFAULT_CONFIG },
      listeners: new Set(),
      /**
       * 是否已经被**真实配置**填充过。
       *
       * 用来区分「共享存储里还是默认值」和「设置面板已经加载/保存过」。
       * 没有这个标志的话，麦克风按钮那份「挂载时发出的 fetch」
       * 会在稍后回来时把用户刚保存的配置覆盖掉 ——
       * 症状是「明明取消了朗读，过一会儿朗读又回来了」。
       */
      loaded: false,
      /** 更新配置并通知所有订阅者。 */
      set(next) {
        this.value = { ...this.value, ...next }
        for (const listener of this.listeners) listener(this.value)
      },
      /** 订阅配置变化。 */
      subscribe(listener) {
        this.listeners.add(listener)
        listener(this.value)
        return () => this.listeners.delete(listener)
      },
    }

    /**
     * 朗读高亮覆盖层控制器。
     *
     * 完全不碰消息 DOM（见组件里 `readingHighlightRef` 处的说明）。
     * 纯函数 `matchInNodes` 只做字符串对齐，这里负责：
     *   定位当前回复容器 → 收集文本节点 → 找命中区间 → 建 Range →
     *   取矩形 → 在 fixed 覆盖层里画半透明色块。
     *
     * @param {object} win - 浏览器 window（注入以便在其它环境里复用/测试）。
     * @returns {{ set(text: string): void, clear(): void, dispose(): void }}
     */
    function createReadingHighlight(win) {
      const doc = win.document
      const STYLE_ID = 'dsh-voice-reading-style'
      /** 覆盖层：fixed、盖满视口、不拦截事件，色块放它里面。 */
      let layer = null
      /** 是否在活跃（正在朗读）。 */
      let active = false
      /** 当前要高亮的句子文本（已还原、未归一化）。 */
      let currentText = ''
      /** 节流用的 rAF 句柄。 */
      let raf = 0
      /** 绑定到 window 的滚动/缩放监听（活跃时才挂）。 */
      let boundScroll = null

      /** 最近一次 render 的诊断结果（挂到 __DSH_VOICE_DEBUG__ 里排查「为什么没高亮」）。 */
      const diag = {
        active: false,
        target: '',
        containerCount: 0,
        foundContainer: false,
        matchCount: -1,
        rectCount: 0,
        layerChildren: 0,
        /** 宿主弹框/遮罩是否打开（打开时覆盖层隐藏，避免画在弹框上面）。 */
        modalOpen: false,
        /** 是否按「会话滚动视口 ∩（底栏输入区以上）」裁剪过高亮。 */
        clipped: false,
        /** 因裁剪被完全丢掉的矩形数（这一句滚出视口/滚到输入框下面时 > 0）。 */
        skippedRects: 0,
        error: '',
      }

      /**
       * 覆盖层 z-index。
       *
       * 不能取整型最大值：DSH 的弹框/遮罩是 `z-index:1000` 级别的浮层，
       * 覆盖层如果取 `2147483647`，**设置弹框打开时高亮会画在弹框上面**（用户反馈）。
       * 取 900：高于消息正文（正文没有 z-index），低于弹框（1000+）。
       * 另外还有一道保险：检测到弹框打开时直接隐藏覆盖层（见 syncModal）。
       */
      const OVERLAY_Z_INDEX = 900

      const ensureStyle = () => {
        const css = [
          `[data-voice-reading]{position:absolute;pointer-events:none;background:rgba(255,214,0,.32);border-radius:2px;}`,
          `[data-voice-reading-overlay]{position:fixed;inset:0;pointer-events:none;z-index:${OVERLAY_Z_INDEX};}`,
          `[data-voice-reading-overlay][data-voice-reading-hidden]{display:none;}`,
        ].join('\n')
        const existing = doc.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
        if (existing) {
          // 旧版本注入的是 z-index:2147483647 —— 升级后要把已存在的样式改过来，
          // 否则页面没刷新时会继续盖在弹框上面。
          if (existing.textContent !== css) existing.textContent = css
          return
        }
        const tag = doc.createElement('style')
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = css
        doc.head.appendChild(tag)
      }

      /** 宿主弹框/遮罩是否打开。 */
      let modalOpen = false
      /** 监视弹框打开/关闭的 MutationObserver。 */
      let modalObserver = null

      const hasOpenModal = () => {
        try {
          return Boolean(doc.querySelector(
            '[aria-modal="true"], [role="dialog"], [role="alertdialog"]',
          ))
        } catch {
          return false
        }
      }

      /** 弹框状态变化：隐藏/恢复覆盖层（打开时绝不能画在弹框上面）。 */
      const syncModal = () => {
        const nowOpen = hasOpenModal()
        const applyHidden = () => {
          if (!layer) return
          if (modalOpen) layer.setAttribute('data-voice-reading-hidden', '')
          else layer.removeAttribute('data-voice-reading-hidden')
        }
        if (nowOpen === modalOpen) {
          // 状态没变也要对齐一次 DOM（layer 可能刚被重建，属性丢了）。
          applyHidden()
          return
        }
        modalOpen = nowOpen
        diag.modalOpen = modalOpen
        applyHidden()
        if (!modalOpen && active && currentText) scheduleRender()
      }

      const ensureModalWatch = () => {
        if (modalObserver) return
        try {
          modalObserver = new win.MutationObserver(() => syncModal())
          modalObserver.observe(doc.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['role', 'aria-modal', 'hidden', 'style'],
          })
        } catch { /* 老环境没有 MutationObserver：只靠 z-index 兜底 */ }
        syncModal()
      }

      const ensureLayer = () => {
        if (layer && layer.isConnected) return layer
        layer = doc.createElement('div')
        layer.setAttribute('data-voice-reading-overlay', '')
        doc.body.appendChild(layer)
        return layer
      }

      const clear = () => {
        if (layer) layer.textContent = ''
      }

      /** 收集容器里非空的文本节点（按文档顺序）。 */
      const collectTextNodes = (root) => {
        const nodes = []
        const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT, {
          acceptNode: (node) => {
            const v = node.nodeValue
            return v && v.trim() !== '' ? win.NodeFilter.FILTER_ACCEPT : win.NodeFilter.FILTER_REJECT
          },
        })
        let node
        while ((node = walker.nextNode())) nodes.push(node)
        return nodes
      }

      /**
       * 定位当前回复容器。
       *
       * 实测（2026-11-01）发现：**正在流式输出的助手回复并不在
       * `[data-step-process-content]` 里**，而是在
       * `[data-chat-flow-kind="assistant-step"]`（更精确）或外层
       * `[data-chat-flow]` / `[data-slot="conversation.chat.flow"]` 里。
       * 只搜 `[data-step-process-content]` 会漏掉「当前正在朗读的那一句」，
       * 于是 foundContainer=false、什么都不高亮。
       *
       * 所以这里搜三类候选，凡是归一化后包含目标句的都收进来，
       * 然后取 **textContent 最短**（最深层、最精确）的那个容器。
       * 这样：新回复命中 assistant-step；已归档回复命中
       * data-step-process-content；都能拿到精确的矩形。
       *
       * @param {string} targetNorm - 已归一化的目标句。
       * @returns {Element|null}
       */
      const findContainer = (targetNorm) => {
        const sel = [
          '[data-step-process-content]',
          '[data-chat-flow-key][data-chat-flow-kind="assistant-step"]',
          '[data-chat-flow]',
          '[data-slot="conversation.chat.flow"]',
        ].join(',')
        const candidates = doc.querySelectorAll(sel)
        let best = null
        let bestLen = Infinity
        for (const el of candidates) {
          const txt = collapseWhitespace(el.textContent ?? '')
          if (txt.includes(targetNorm) && txt.length < bestLen) {
            best = el
            bestLen = txt.length
          }
        }
        return best
      }

      /**
       * 找「会话滚动视口」：从消息容器往上找 `overflow-y:auto/scroll/overlay` 的祖先。
       *
       * 为什么需要：消息滚出视口后，Range/元素矩形**仍然会报原位置**
       * （父级的 `overflow:hidden` 只是视觉裁掉），于是固定在视口的覆盖层会把
       * 高亮画到**输入框/顶栏上面**（用户反馈：滚动到输入框下方，高亮显示在输入框上）。
       * 所以覆盖层必须自己裁剪到滚动视口。
       */
      const findScrollViewport = (el) => {
        let node = el
        while (node && node !== doc.body && node !== doc.documentElement) {
          try {
            const style = typeof win.getComputedStyle === 'function' ? win.getComputedStyle(node) : null
            if (style && /auto|scroll|overlay/.test(style.overflowY)) return node
          } catch { /* 忽略 */ }
          node = node.parentElement
        }
        return null
      }

      /**
       * 底部输入区（composer）的顶部；找不到返回 null。
       *
       * 只认「下半屏、够宽」的输入元素，避免把顶栏的搜索框当成底栏把高亮裁没了。
       */
      const findBottomChromeTop = () => {
        let top = null
        try {
          const els = doc.querySelectorAll(
            '[data-slot*="composer"], [data-testid*="composer"], textarea, [contenteditable="true"]',
          )
          const vh = win.innerHeight || 0
          for (const el of els) {
            const r = el.getBoundingClientRect()
            if (r.width < 100 || r.height < 10) continue
            if (vh && r.top < vh * 0.5) continue
            if (top === null || r.top < top) top = r.top
          }
        } catch { /* 忽略 */ }
        return top
      }

      /** 高亮允许出现的区域：滚动视口 ∩ 窗口 ∩（底栏输入区以上）。 */
      const computeClipRect = (container) => {
        const vw = win.innerWidth || 0
        const vh = win.innerHeight || 0
        const clip = { left: 0, top: 0, right: vw, bottom: vh }
        const scrollEl = findScrollViewport(container)
        if (scrollEl) {
          try {
            const r = scrollEl.getBoundingClientRect()
            clip.left = Math.max(clip.left, r.left)
            clip.top = Math.max(clip.top, r.top)
            clip.right = Math.min(clip.right, r.right)
            clip.bottom = Math.min(clip.bottom, r.bottom)
          } catch { /* 忽略 */ }
        }
        const chromeTop = findBottomChromeTop()
        if (chromeTop !== null && Number.isFinite(chromeTop)) {
          clip.bottom = Math.min(clip.bottom, chromeTop)
        }
        diag.clipped = Boolean(scrollEl) || chromeTop !== null
        return clip
      }

      /** 画一个矩形色块（视口坐标 → fixed 层内的绝对定位；先按 `clip` 裁剪）。 */
      const drawRect = (rect, clip) => {
        if (!rect) return
        const left = Number(rect.left) || 0
        const top = Number(rect.top) || 0
        const right = Number.isFinite(rect.right) ? rect.right : left + (Number(rect.width) || 0)
        const bottom = Number.isFinite(rect.bottom) ? rect.bottom : top + (Number(rect.height) || 0)
        const x0 = Math.max(left, clip.left)
        const x1 = Math.min(right, clip.right)
        const y0 = Math.max(top, clip.top)
        const y1 = Math.min(bottom, clip.bottom)
        // 整块都在可视区外（比如这一句已经滚到输入框下面/顶栏上面）：不画。
        if (x1 - x0 <= 0 || y1 - y0 <= 0) {
          diag.skippedRects += 1
          return
        }
        const span = doc.createElement('span')
        span.setAttribute('data-voice-reading', '')
        span.style.left = `${x0}px`
        span.style.top = `${y0}px`
        span.style.width = `${x1 - x0}px`
        span.style.height = `${y1 - y0}px`
        layer.appendChild(span)
      }

      /** 从矩形集合画色块（按会话滚动视口裁剪，绝不画到视口外）。 */
      const drawRects = (rects, clip) => {
        clear()
        diag.skippedRects = 0
        for (const rect of rects) drawRect(rect, clip)
      }

      /** 重算当前句的矩形并重画（滚动/重排时也调用）。 */
      const render = () => {
        raf = 0
        if (!active || !currentText) return
        // 弹框/遮罩打开时不画高亮（z-index 再低也可能遇到高浮层；直接隐藏最稳）。
        if (modalOpen) {
          clear()
          diag.rectCount = 0
          diag.layerChildren = 0
          return
        }
        diag.active = true
        diag.target = currentText
        diag.error = ''
        const targetNorm = collapseWhitespace(unescapeSpeechText(currentText))
        if (!targetNorm) { clear(); diag.error = 'empty-target'; return }
        const container = findContainer(targetNorm)
        diag.containerCount = doc.querySelectorAll('[data-step-process-content],[data-chat-flow-key][data-chat-flow-kind="assistant-step"],[data-chat-flow],[data-slot="conversation.chat.flow"]').length
        diag.foundContainer = !!container
        if (!container) {
          clear()
          diag.error = 'no-container'
          win.console.debug(`[dsh-voice-typing] 高亮：找不到含目标句的容器（共 ${diag.containerCount} 个候选），target="${targetNorm.slice(0, 40)}"`)
          return
        }
        const textNodes = collectTextNodes(container)
        const ranges = matchInNodes(textNodes.map((n) => n.nodeValue), targetNorm)
        diag.matchCount = ranges ? ranges.length : 0
        // 高亮只能出现在「会话滚动视口 ∩ 底栏输入区以上」：
        // 已经滚出视口/滚到输入框下面的句子不画（用户反馈：会画到输入框上面）。
        const clip = computeClipRect(container)
        if (!ranges) {
          win.console.debug(`[dsh-voice-typing] 高亮：目标句在容器内匹配不上，降级为整段高亮。target="${targetNorm.slice(0, 40)}"`)
        }
        if (!ranges || !ranges.length) {
          // 整句匹配不上（跨块/软换行错位）→ 降级：整段浅高亮。
          const rect = container.getBoundingClientRect()
          drawRects([rect], clip)
          diag.rectCount = layer ? layer.children.length : 0
          diag.layerChildren = layer ? layer.children.length : 0
          return
        }
        try {
          const range = doc.createRange()
          const first = ranges[0]
          const last = ranges[ranges.length - 1]
          range.setStart(textNodes[first.nodeIndex], first.start)
          range.setEnd(textNodes[last.nodeIndex], last.end)
          drawRects(range.getClientRects(), clip)
          diag.rectCount = layer ? layer.children.length : 0
        } catch (err) {
          diag.error = String(err)
          /* 节点被 React 移除等异常：忽略，下次 render 再试 */
        }
      }

      const scheduleRender = () => {
        if (raf) return
        raf = win.requestAnimationFrame(render)
      }

      const set = (text) => {
        ensureStyle()
        ensureLayer()
        ensureModalWatch()
        // 重新确保一次弹框态（layer 可能刚被重建，属性丢了）。
        syncModal()
        active = true
        currentText = String(text ?? '')
        scheduleRender()
        if (!boundScroll) {
          boundScroll = () => scheduleRender()
          win.addEventListener('scroll', boundScroll, true)
          win.addEventListener('resize', boundScroll)
        }
      }

      const clearReading = () => {
        active = false
        currentText = ''
        diag.active = false
        clear()
        if (raf) { win.cancelAnimationFrame(raf); raf = 0 }
        if (boundScroll) {
          win.removeEventListener('scroll', boundScroll, true)
          win.removeEventListener('resize', boundScroll)
          boundScroll = null
        }
      }

      const dispose = () => {
        clearReading()
        if (modalObserver) {
          try { modalObserver.disconnect() } catch { /* 忽略 */ }
          modalObserver = null
        }
        if (layer) { layer.remove(); layer = null }
        const style = doc.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
        if (style) style.remove()
      }

      const getState = () => ({ ...diag })

      return { set, clear: clearReading, dispose, getState }
    }

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
        typeof props?.t === 'function' ? props.t : (key) => zh[key] ?? key,
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
        if (typeof sessionId === 'string' && sessionId) persistLastSessionId(sessionId)
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
            const resp = await fetch(`${BASE}/busy`)
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
       *   - 识别模型首次加载要 20~40 秒；
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
      const hintTimerRef = useRef(null)
      const onRef = useRef(false)
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
      const noiseFloorRef = useRef(0.004)
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
        const total = Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : 1
        acksSentRef.current += total
        const sid = sessionId ?? ''
        const tid = turnId ?? ''
        const dur = Number(durationMs)
        const hasDur = total === 1 && Number.isFinite(dur) && dur > 0
        for (let left = total; left > 0; left -= 64) {
          const n = Math.min(left, 64)
          try {
            void fetch(`${BASE}/reading-ack`, {
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
        readingHighlightRef.current = createReadingHighlight(window)
      }

      // 定时器登记表：本组件所有定时器都登记在这里，
      // 状态复位时按 group 清，卸载时全清。
      const timersRef = useRef(null)
      // 登记表要拿到 window：源文件是纯函数（不直接依赖浏览器全局），
      // 这样测试能在 Node 里原生 import 它。
      if (!timersRef.current) timersRef.current = createTimerRegistry(window)
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
          const resp = await fetch(`${BASE}/config`)
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
        if (hintTimerRef.current) { window.clearTimeout(hintTimerRef.current); hintTimerRef.current = null }
        setHintState(value ?? '')
        setHintDetailState(detail ?? '')
        if (value) timers.timeout('hint', () => { setHintState(''); setHintDetailState(''); hintTimerRef.current = null }, 2500, 'ui')
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
        if (typeof window === 'undefined') return undefined
        window.__DSH_VOICE_DEBUG__ = () => ({
          on: onRef.current,
          speaking: speakingRef.current,
          muted: mutedTurnIdRef.current,
          turnId: currentTurnIdRef.current,
          hearing: hearingRef.current,
          recognizing: recognizingRef.current,
          assistantRunning: assistantRunningRef.current,
          pendingAutoSend: pendingAutoSendRef.current,
          queue: speakQueueRef.current.length,
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
          ttsFallbacks: ttsFallbackCount,
          lastTtsFallback,
          lastTtsEngine,
          // 播放上下文的真实状态（「朗读中但没声音」最需要的三项）：
          //   audioState —— running / suspended / closed（suspended 就播不出声）
          //   audioRate  —— 实际协商到的采样率
          //   audioError —— 构造/恢复失败的原因（例如设备不支持被我们指定的采样率）
          audioState: playCtxCache?.state ?? 'none',
          audioRate: playCtxRate,
          audioError: playCtxError,
          // 最近一次朗读失败的具体原因（HTTP 状态码 + 服务端错误正文）。
          lastTtsError,
          // 朗读高亮的诊断（排查「明明在朗读、界面上却没有高亮」）。
          // 字段含义见 createReadingHighlight 里的 diag。
          readingHighlight: readingHighlightRef.current?.getState?.() ?? null,
        })
        return () => {
          try { delete window.__DSH_VOICE_DEBUG__ } catch { /* 忽略 */ }
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
          const resp = await fetch(`${BASE}/asr-stream?sessionId=${encodeURIComponent(sid)}`, {
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
          await fetch(`${BASE}/asr-stream/reset?sessionId=${encodeURIComponent(sid)}`, { method: 'POST' })
        } catch { /* 忽略 */ }
      }, [])

      const closeMic = useCallback(() => {
        recorderActiveRef.current = false
        const mic = micRef.current
        if (mic) {
          try { if (mic.processor) { mic.processor.onaudioprocess = null; mic.processor.disconnect() } } catch { /* 忽略 */ }
          try { mic.ctx?.close().catch(() => {}) } catch { /* 忽略 */ }
          try { mic.stream?.getTracks().forEach((tr) => tr.stop()) } catch { /* 忽略 */ }
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
        // 也不该调 window.speechSynthesis.cancel()：
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
          window.clearTimeout(pendingAutoSendTimerRef.current)
          pendingAutoSendTimerRef.current = null
        }
        // 提示定时器同理：状态都复位了，再弹一句提示就不对了
        if (hintTimerRef.current) {
          window.clearTimeout(hintTimerRef.current)
          hintTimerRef.current = null
        }
        // 噪音基准：下一轮重新测，别拿上一轮的旧值当基准
        noiseFloorRef.current = 0.004
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
          let total = 0
          for (const chunk of chunks) total += chunk.length
          const merged = new Float32Array(total)
          let offset = 0
          for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }
          const rate = micRef.current?.ctx?.sampleRate ?? 16000
          const samples = resampleTo16k(merged, rate)

          // 段已切走，现在可以安全地开始下一段了
          hearingRef.current = false

          // 必须有超时：请求挂住时 recognizingRef 会一直是 true，
          // 之后所有识别都被直接跳过，麦克风彻底失聪，只能关掉重开。
          const ctrl = new AbortController()
          timers.timeout('transcribe-abort', () => ctrl.abort(), TRANSCRIBE_TIMEOUT_MS, 'request')
          let resp
          try {
            resp = await fetch(`${BASE}/transcribe`, {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength),
              signal: ctrl.signal,
            })
          } finally {
            // 清掉超时定时器。
            // 注意：这里**不能**用 window.clearTimeout(timer) ——
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
              window.clearTimeout(pendingSendTimerRef.current)
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
              }, autoSendExtraMs)
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
            url = await fetchSpeech(sentence)
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
                await sleep(window, 100)
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
          playCtx = getPlayCtx()
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
              await sleep(window, 120)
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
                  await sleep(window, 80)
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
                sleep(window, TTS_TIMEOUT_MS).then(() => null),
              ])
              // 这一句「已被消耗」：要么播、要么跳过；两种情况都要回执 1 条，
              // 把宿主配额还回去，否则宿主会以为我们还没拿到这一句。
              if (decoded) {
                // 引擎回退可见（审计 F3）：本地系统语音失败时宿主会自动回退在线，
                // 文本会发到微软 —— 用户必须知道，不能悄悄换引擎。
                // 只在检测到**新一次**回退时提示（ttsFallbackCount 由 fetchSpeech 递增）。
                if (ttsFallbackCount !== ttsFallbackSeenRef.current) {
                  ttsFallbackSeenRef.current = ttsFallbackCount
                  const fallbackKey = lastTtsFallback === 'local' ? 'ttsFallbackLocal' : 'ttsFallbackOnline'
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
        const source = new EventSource(`${BASE}/stream`)
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
          void fetch(`${BASE}/busy`)
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
        if (pendingAutoSendTimerRef.current) window.clearTimeout(pendingAutoSendTimerRef.current)
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
        }, 400)
      }, [assistantRunning, on, inputActions])

      /* ================= 开麦 ================= */

      /**
       * 确保识别模型已经加载进内存。
       *
       * 首次加载 SenseVoice 要 20~40 秒。不确认就开麦的话：
       *   用户说完 → 识别请求在模型就绪前就失败 → 音频已经被切走 → **整句话丢掉**。
       *
       * 流程：
       *   1. 先问宿主「好了吗」（GET /asr-ready）—— 已经好了就零延迟通过；
       *   2. 没有好就调 /asr-warmup，一直等到就绪（期间界面显示「正在加载模型…」）；
       *   3. 失败则返回原因，由调用方保持关闭状态并提示。
       *
       * @returns {Promise<{ok: boolean, reason?: string}>} 是否可以开始聆听。
       */
      const ensureModelReady = useCallback(async () => {
        try {
          const check = await fetch(`${BASE}/asr-ready`)
          if (check.ok) {
            const data = await check.json().catch(() => null)
            if (data?.ready) return { ok: true }
            if (data && data.downloaded === false) {
              return { ok: false, reason: data.reason || '识别模型还没下载' }
            }
          }
        } catch {
          /* 问不到就当没就绪，交给下面的 warmup 处理 */
        }
        setHint(t('modelLoading'), t('modelLoadingDetail'))
        try {
          const resp = await fetch(`${BASE}/asr-warmup`, { method: 'POST' })
          const data = await resp.json().catch(() => null)
          if (resp.ok && data?.ready) return { ok: true }
          return { ok: false, reason: data?.reason || t('modelFailed') }
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : String(error) }
        }
      }, [t])

      const startMic = useCallback(async () => {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
          setHint(t('micUnsupported'), t('micUnsupportedDetail'))
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
          // 原因可能是一整句话（宿主给的），直接塞进状态行会把界面挤开。
          // 状态行只放短词，完整原因放到悬停提示里。
          const reason = String(modelReady.reason || '')
          setHint(t('modelFailed'), reason || t('modelFailedDetail'))
          startingRef.current = false
          setStarting(false)
          onRef.current = false
          setOn(false)
          return
        }

        let stream
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          })
        } catch {
          setHint(t('micDenied'), t('micDeniedDetail'))
          // 失败了就复位开关：否则按钮显示「语音对话中」，用户以为在录音
          startingRef.current = false
          setStarting(false)
          onRef.current = false
          setOn(false)
          return
        }
        // getUserMedia 成功**不等于**有可用的音频输入：
        // 设备可能已被拔掉、被别的程序独占，或者系统只给了一个空轨道。
        // 这时候照样能建出音频图、能跑 VAD，只是永远采不到声音 ——
        // 界面却显示「聆听中」，用户完全看不出来。
        const audioTrack = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks()[0] : null
        if (!audioTrack || audioTrack.readyState === 'ended') {
          try { stream.getTracks().forEach((tr) => tr.stop()) } catch { /* 忽略 */ }
          setHint(t('micFailed'), t('micFailedDetail'))
          startingRef.current = false
          setStarting(false)
          onRef.current = false
          setOn(false)
          return
        }
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        const ctx = new AudioCtx()
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
        try { await ctx.resume() } catch { /* 忽略 */ }
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
          const warm = getPlayCtx()
          await warm?.resume?.()
        } catch { /* 忽略 */ }
        // 后台预热 TTS 连接：第一次合成要付 TLS 握手（4~5 秒），
        // 提前建好连接，真正要朗读时第一句就不用干等。
        fetch(`${BASE}/tts/warmup`).catch(() => {})
        // 加载模型 / 授权弹窗期间用户可能已经点了取消
        // （toggleVoice 在 starting 期间再点一次）：
        // 这时必须把刚拿到的麦克风释放掉，否则麦克风一直开着（UI 却显示已关闭）。
        if (!startingRef.current) {
          try { stream.getTracks().forEach((tr) => tr.stop()) } catch { /* 忽略 */ }
          try { await ctx.close() } catch { /* 忽略 */ }
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
        onRef.current = true
        setOn(true)
        startingRef.current = false
        setStarting(false)
        chunksRef.current = []
        segStartRef.current = 0
        hearingRef.current = false
        livePartialRef.current = ''
        noiseFloorRef.current = 0.004
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
          // 门限逻辑抽成了纯函数 advanceGate()（与宿主侧同名同签名），
          // 两边由同一份用例表驱动，防止「同一判据两处实现」分叉。
          const gated = advanceGate(
            { noiseFloor: noiseFloorRef.current, inSpeech: hearingRef.current, silentFrames: 0 },
            rms,
            { minGate: 0.008, maxGate: 0.035, multiplier: 2.5, offset: 0.003, silentFramesToEnd: 1 },
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
        }, 100)

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
          let len = 0
          for (const p of segChunks) len += p.length
          // 太短（< 0.25 秒）先不跑，避免看到半截碎字
          if (len < 4000) return
          liveBusy = true
          try {
            const merged = new Float32Array(len)
            let off = 0
            for (const p of segChunks) { merged.set(p, off); off += p.length }
            const rate = micRef.current?.ctx?.sampleRate ?? 16000
            const samples = resampleTo16k(merged, rate)
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

            const resp = await fetch(`${BASE}/transcribe`, {
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
        }, 900)
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
          return shortcutMatches(event, combo)
        }
        const down = (event) => {
          // 设置面板里正在编辑快捷键时，不要触发
          if (shortcutFieldFocused) return
          // 全局语音开启时：输入框麦克风已隐藏，Alt+V 改为切换浮层麦克风。
          // 这样用户只需要记「按一下开始/停止说话」，不会同时开两个语音模式。
          if (configRef.current?.globalVoice === true) {
            if (!matches(event)) return
            event.preventDefault()
            if (event.repeat) return
            try { window.dispatchEvent(new CustomEvent(GLOBAL_TOGGLE_EVENT)) } catch { /* 测试桩环境 */ }
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
        window.addEventListener('keydown', down, true)
        return () => window.removeEventListener('keydown', down, true)
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
          window.addEventListener(GLOBAL_MIC_ON_EVENT, onGlobalMicOn)
        } catch {
          // 测试环境的 window 是桩（没有 addEventListener）时直接跳过。
          return undefined
        }
        return () => {
          try { window.removeEventListener(GLOBAL_MIC_ON_EVENT, onGlobalMicOn) } catch { /* 忽略 */ }
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
          // 提示定时器也要清：不清的话组件卸载后它还会触发一次 setHintState
          if (hintTimerRef.current) {
            window.clearTimeout(hintTimerRef.current)
            hintTimerRef.current = null
          }
          // 「助手忙完后自动发送」的定时器同理
          if (pendingAutoSendTimerRef.current) {
            window.clearTimeout(pendingAutoSendTimerRef.current)
            pendingAutoSendTimerRef.current = null
          }
        }
      }, [stopAll])

      /* ================= 状态上报（诊断用） ================= */

      useEffect(() => {
        if (!on) return undefined
        timers.interval('shortcut', () => {
          fetch(`${BASE}/voice-session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId,
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
                audioState: playCtxCache?.state ?? 'none',
                audioRate: playCtxRate,
                audioError: playCtxError,
                ttsFailures: ttsFailuresRef.current,
                playSkipped: playSkippedRef.current,
                // 朗读流控：acks 不涨 = 宿主补发句子的凭据没送到；trimmed > 0 =
                // 宿主流控失效、安全网兜底在丢句。dropped = 其它原因（无 AudioContext /
                // 管道异常）丢的句数，与流控无关。
                acks: acksSentRef.current,
                trimmed: trimmedRef.current,
                dropped: droppedRef.current,
                // 引擎回退（本地失败 → 在线）：以为在离线时先看这里。
                ttsFallbacks: ttsFallbackCount,
                lastTtsFallback,
                lastTtsEngine,
                lastTtsError,
                // 朗读高亮诊断：让我能在宿主 /diagnostics 里直接看到
                // 「为什么没高亮」（找不到容器 / 匹配数 / 矩形数 / 异常）。
                readingHighlight: readingHighlightRef.current?.getState?.() ?? null,
              },
            }),
          }).catch(() => {})
        }, 1500)
        // 清掉心跳定时器。
        // 注意：原来这里写的是 `window.clearInterval(timer)` ——
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

      const micIcon = React.createElement(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        React.createElement('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3 }),
        React.createElement('path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0' }),
        React.createElement('line', { x1: 12, y1: 18, x2: 12, y2: 21.5 }),
      )

      const button = React.createElement(
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
        ? React.createElement(
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
            React.createElement(
              'svg',
              { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
              React.createElement('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }),
            ),
          )
        : null

      return React.createElement(
        'div',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        // 全局语音开启时输入框麦克风隐藏：语音入口只剩右下角浮层一个。
        globalVoiceOn ? null : button,
        stopSpeakingButton,
        !globalVoiceOn && singleText
          ? React.createElement(
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

    /* ================= 全局语音浮层（任意页面常驻） ================= */

    /**
     * 插件客户端 ctx 的模块级引用。
     *
     * 槽位组件是宿主渲染的，拿不到 apply(ctx) 的参数；而全局浮层需要
     * `ctx.sessions`（定位当前会话/直接发消息）、`ctx.get('uiWorkspace')`、
     * `ctx.get('layout')` 这些服务 —— 只能在 apply 时把 ctx 存下来。
     */
    let pluginCtx = null

    /**
     * 通过 `ctx.inject(['sessions'])` 捕获的会话服务。
     *
     * 为什么还要这一份：有些 DSH 版本的客户端 ctx 上不直接挂 `sessions`
     * （只有注入作用域里才拿得到），而浮层定位当前会话/直接发消息都依赖它。
     * 这是一个**只读**的兜底捕获，不注册任何东西；拿不到也不影响其它槽位。
     */
    let capturedSessionsService = null

    /**
     * 「上次使用的会话」持久化键。
     *
     * 为什么需要持久化：主视图保留（retainedBy.mainView）只在对话页存在。
     * 用户在设置页/首页启用全局浮层时没有任何 mainView 保留，光靠会话列表
     * 无法知道「上次聊的是哪个会话」；记住它，切到非对话页后语音仍然有目标。
     */
    const LAST_SESSION_KEY = 'dsh-voice-typing:last-session'
    /** 模块级缓存：避免每次渲染都读 localStorage（读操作也走同步 IO）。 */
    let lastPersistedSessionId = null

    /**
     * 读持久化的上次会话 id（无痕模式/禁用 localStorage 时静默返回空串）。
     * @returns {string} 会话 id；没有/读取失败返回空串。
     */
    function readLastSessionId() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return ''
        return String(window.localStorage.getItem(LAST_SESSION_KEY) ?? '')
      } catch {
        return ''
      }
    }

    /**
     * 持久化「上次使用的会话」。
     *
     * 调用点可能很频繁（MicButton 每次会话 id 变化、浮层每次快照更新），
     * 所以先用模块级变量比对：相同 id 直接返回，不做任何写入/读取。
     *
     * @param {string} id - 会话 id。
     */
    function persistLastSessionId(id) {
      const value = typeof id === 'string' ? id.trim() : ''
      if (!value || value === lastPersistedSessionId) return
      lastPersistedSessionId = value
      try {
        if (typeof window === 'undefined' || !window.localStorage) return
        window.localStorage.setItem(LAST_SESSION_KEY, value)
      } catch {
        /* 无痕模式/配额/被策略禁用：持久化只是增强，失败不能影响语音 */
      }
    }

    /**
     * 取客户端服务：优先注入作用域捕获的 sessions，再优先 ctx 上直接挂的
     * （sessions/slots/…），最后退回 ctx.get(name)。几种取法都试，
     * 避免 DSH 版本差异让浮层直接失效。
     *
     * @param {string} name - 服务名。
     * @returns {object|null} 服务对象；拿不到返回 null。
     */
    function clientService(name) {
      // 注入作用域捕获的 sessions 最可靠：ctx 上没有时它是唯一来源。
      if (name === 'sessions' && capturedSessionsService) return capturedSessionsService
      if (!pluginCtx) return null
      // 顺序很重要：**先试 ctx.get()，再试 ctx[name]**。
      //
      // 反过来会踩一个很隐蔽的坑：插件只声明了 inject=['slots','locale']，
      // 直接读 ctx.layout 会抛 "cannot get property without inject"，
      // 外层 try/catch 一兜就直接返回 null —— 看起来像「服务不存在」，
      // 于是 toggle_sidebar / switch_session 全都报 unsupported。
      // ctx.get()（reflect.get）本来可以绕过 inject 拿到服务，所以必须先走它。
      try {
        if (typeof pluginCtx.get === 'function') {
          const viaGet = pluginCtx.get(name)
          if (viaGet) return viaGet
        }
      } catch {
        /* 再试直接属性 */
      }
      try {
        return pluginCtx[name] ?? null
      } catch {
        return null
      }
    }

    /**
     * 确认条的目标描述：把 ref 翻译成「点击「插件」（e12）」这类人能判断的文案。
     *
     * 为什么不能只显示 `describeUiAction` 的结果：协议层只知道动作名和第一个参数，
     * `ui_click` 只能显示 `ui_click: e12` —— 用户看不到自己要批准的是哪个按钮
     *（尤其 ui_snapshot 也会拍到设置面板里的危险开关），二次确认就退化成橡皮图章。
     * 有快照信息时用可读名；没有（快照被新动作覆盖/元素没名字）时退回原描述。
     *
     * @param {object} request - {action, params}。
     * @param {Function} t - 翻译函数。
     * @returns {string} 确认条描述文本。
     */
    function describeConfirmTarget(request, t) {
      const action = String(request?.action ?? '')
      const params = request?.params && typeof request.params === 'object' ? request.params : {}
      const fallback = () => describeUiAction(action, params)
      try {
        if (action === 'ui_key') return t('globalConfirmKey', { key: String(params.key ?? '') })
        if (action === 'ui_click' || action === 'ui_type') {
          const info = a11ySnapshotInfo.get(String(params.ref ?? '')) ?? null
          const name = typeof info?.name === 'string' && info.name ? info.name : ''
          if (action === 'ui_type') {
            const raw = String(params.text ?? '')
            // 输入内容预览截断：确认条不是正文展示区（协议上限 4000 字）。
            const preview = raw.length > 40 ? raw.slice(0, 40) + '…' : raw
            if (name) return t('globalConfirmType', { name, ref: params.ref, text: preview })
            if (info) return t('globalConfirmTypeFallback', { ref: params.ref, text: preview })
            return fallback()
          }
          if (name) return t('globalConfirmClick', { name, ref: params.ref })
          return fallback()
        }
        return fallback()
      } catch {
        return fallback()
      }
    }

    /**
     * 判断 window keydown 事件是否命中某个组合键。
     *
     * 与 composer 麦克风那边的匹配规则一致：修饰键必须**精确**一致 ——
     * 配置 Alt+V 时按下 Ctrl+Alt+V 不算命中（否则两个语音入口会一起被触发）。
     *
     * @param {KeyboardEvent} event - 键盘事件。
     * @param {string} combo - 形如 `Ctrl+Alt+V` 的配置值。
     * @returns {boolean} 是否命中。
     */
    function matchesShortcut(event, combo) {
      const parts = String(combo ?? '').split('+').map((part) => part.trim().toLowerCase()).filter(Boolean)
      if (!parts.length) return false
      const key = parts[parts.length - 1]
      if (!event || typeof event.key !== 'string') return false
      if (event.key.toLowerCase() !== key) return false
      if (parts.includes('ctrl') !== !!event.ctrlKey) return false
      if (parts.includes('shift') !== !!event.shiftKey) return false
      if (parts.includes('alt') !== !!event.altKey) return false
      if (parts.includes('meta') !== !!event.metaKey) return false
      return true
    }

    /**
     * 当前平台标识（只用于快捷键别名；测试桩没有 navigator 时返回空串）。
     * @returns {string} navigator.platform 或 userAgent。
     */
    function clientPlatform() {
      try {
        if (typeof navigator === 'undefined') return ''
        return String(navigator.platform || navigator.userAgent || '')
      } catch {
        return ''
      }
    }

    /**
     * 把平台标识转成展示名（设置面板「系统级热键状态」用）。
     * @param {string} raw - navigator.platform / process.platform 等原始标识。
     * @returns {string} Windows / macOS / Linux / 原值；无法识别返回 '—'。
     */
    function describePlatformName(raw) {
      const text = String(raw ?? '').trim()
      if (!text) return '—'
      const lower = text.toLowerCase()
      if (lower.includes('win')) return 'Windows'
      if (lower.includes('mac') || lower.includes('darwin')) return 'macOS'
      if (lower.includes('linux')) return 'Linux'
      return text
    }

    /**
     * 快捷键匹配（含平台别名）。
     *
     * macOS 上默认的 Ctrl+Alt+V 不顺手：配置值保持不变，但匹配时额外接受
     * Meta+Alt+V（Cmd+Alt+V）—— 见 pure/global-voice.js 的 effectiveShortcut。
     *
     * @param {KeyboardEvent} event - 键盘事件。
     * @param {string} combo - 配置里的组合键。
     * @returns {boolean} 是否命中任一可接受的组合。
     */
    function shortcutMatches(event, combo) {
      const candidates = effectiveShortcut(combo, clientPlatform())
      return candidates.some((candidate) => matchesShortcut(event, candidate))
    }

    /**
     * 读取 sessions.list 的快照。
     * 服务可能还没就绪，或不同版本用了 snapshot/getSnapshot —— 都试一遍，拿不到返回 null。
     *
     * @param {object} sessionsService - ctx.sessions。
     * @returns {object|null} SessionListState 快照。
     */
    function readSessionSnapshot(sessionsService) {
      try {
        const list = sessionsService?.list
        if (!list) return null
        if (typeof list.getSnapshot === 'function') return list.getSnapshot()
        return list.snapshot ?? null
      } catch {
        return null
      }
    }

    /**
     * 从会话列表快照里找「当前正在看的会话」。
     *
     * 判据与 DSH 核心完全一致：`retainedBy.mainView > 0` 的那一项。
     * 宿主侧没有 active session 概念，这是唯一可靠来源。
     * 具体实现已抽到纯函数模块（findMainViewSessionId，可单测）；这里保留同名
     * 包装，避免浮层里所有调用点都改成新名字。
     *
     * @param {object|null} snapshot - SessionListState 快照。
     * @returns {string} 会话 id；没有返回空串。
     */
    function pickMainViewSessionId(snapshot) {
      return findMainViewSessionId(snapshot)
    }

    /* ================= v2 通用 a11y 界面操作（DOM 侧胶水） ================= */

    /**
     * 最近一次 `ui_snapshot` 的 ref → 元素表。
     *
     * 为什么必须是模块级：ui_snapshot 与 ui_click/ui_type 是**两次独立的 SSE 动作**，
     * 中间隔着模型思考与用户确认；ref 只在最近一次快照内有效（契约），
     * 新快照整体覆盖旧表，避免点到上一页的同名 ref。
     */
    let a11ySnapshotElements = new Map()

    /**
     * 最近一次 `ui_snapshot` 的 ref → 可读描述（{ref, role, name, tag}）。
     *
     * 用途：确认条要告诉用户「你在批准什么」。只显示 ref（`ui_click: e12`）
     * 等于让用户盲签 —— a11y 动作能点到任意按钮，尤其是危险开关。
     * 快照时一起存，确认条渲染时查。
     */
    let a11ySnapshotInfo = new Map()

    /** 清掉旧快照：摘掉 DOM 上的 ref 标记并清空两张表（旧 ref 立即失效）。 */
    function clearA11ySnapshot() {
      for (const el of a11ySnapshotElements.values()) {
        try { el.removeAttribute?.('data-dsh-voice-ref') } catch { /* 节点可能已卸载 */ }
      }
      a11ySnapshotElements = new Map()
      a11ySnapshotInfo = new Map()
    }

    /**
     * 元素是否「可见可交互」。
     *
     * 判据与契约一致：`offsetParent !== null` 或 `position:fixed`；
     * 跳过 `aria-hidden="true"` 子树（屏幕阅读器也看不到的东西不该进快照）。
     * disabled 元素**保留**（快照里带 disabled 字段），由执行动作时拒绝。
     *
     * @param {Element} el - DOM 元素。
     * @returns {boolean} 是否纳入快照。
     */
    function isA11yElementVisible(el) {
      try {
        if (!el || typeof el !== 'object') return false
        if (typeof el.closest === 'function' && el.closest('[aria-hidden="true"]')) return false
        let style = null
        try {
          if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
            style = window.getComputedStyle(el)
          }
        } catch {
          style = null
        }
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
        if (el.offsetParent === null) {
          // position:fixed 的元素（浮层/对话框）offsetParent 也是 null，但可见。
          return Boolean(style && style.position === 'fixed')
        }
        return true
      } catch {
        return false
      }
    }

    /**
     * 派发 DOM 事件：浏览器里用真构造器；测试桩环境退化成普通对象（不抛错）。
     * @param {Element} el - 目标元素。
     * @param {string} type - 事件类型。
     * @param {object} [init] - 事件初始化参数。
     */
    function dispatchDomEvent(el, type, init = {}) {
      try {
        const win = typeof window !== 'undefined' ? window : null
        const Ctor = win && (type === 'keydown' || type === 'keyup' ? win.KeyboardEvent : win.Event)
        if (Ctor) {
          el.dispatchEvent(new Ctor(type, init))
          return
        }
      } catch {
        /* 继续用退化对象 */
      }
      try {
        el.dispatchEvent({ type, ...init, preventDefault() {}, stopPropagation() {} })
      } catch {
        /* 桩元素没有 dispatchEvent：忽略 */
      }
    }

    /**
     * 写 React 受控输入。
     *
     * 直接 `el.value = x` 会被 React 的 value tracker 当成「值没变」，onChange
     * 不会触发 —— 必须调用原型上的原生 setter 绕过 tracker，再派发 input/change。
     * 这是 React 受控输入的标准写法（语音/模型代填必须让界面真的收到变化）。
     *
     * @param {Element} el - input/textarea。
     * @param {string} value - 目标文本。
     */
    function setNativeInputValue(el, value) {
      const tag = String(el?.tagName ?? '').toUpperCase()
      let setter = null
      try {
        const win = typeof window !== 'undefined' ? window : null
        const proto = tag === 'TEXTAREA' ? win?.HTMLTextAreaElement?.prototype : win?.HTMLInputElement?.prototype
        if (proto) setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set ?? null
      } catch {
        setter = null
      }
      try {
        if (setter) setter.call(el, value)
        else el.value = value
      } catch {
        try { el.value = value } catch { /* 忽略 */ }
      }
      dispatchDomEvent(el, 'input', { bubbles: true })
      dispatchDomEvent(el, 'change', { bubbles: true })
    }

    /**
     * 解析 ref → 元素：必须在最近一次快照表里、仍在 DOM、可见。
     * 任何一条不满足都返回 null（调用方回 `stale_ref`，让模型重新拍快照）。
     *
     * @param {string} ref - 快照 ref（如 e12）。
     * @returns {Element|null} 目标元素。
     */
    function resolveA11yElement(ref) {
      const key = String(ref ?? '')
      const el = a11ySnapshotElements.get(key)
      if (!el) return null
      try {
        if (typeof document !== 'undefined' && typeof document.contains === 'function' && !document.contains(el)) return null
      } catch {
        /* 桩环境没有 contains：跳过 */
      }
      if (!isA11yElementVisible(el)) return null
      return el
    }

    // 浮层容器的视觉效果集中在这里：底部右侧常驻，只有卡片本身接收鼠标事件。
    const GLOBAL_OVERLAY_WRAPPER_STYLE = {
      position: 'fixed',
      right: 16,
      bottom: 16,
      zIndex: 900,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 8,
      // shell.overlay 是挂在 AppFrame 上的独立层，不一定继承正文字色；
      // 这里显式给一个主题文字色，避免浅色主题下继承到黑色（黑底黑字看不见）。
      color: 'var(--dsw-alias-label-primary, currentColor)',
      // 外层穿透：浮层覆盖在任意页面上，不能挡住底下的按钮/输入框。
      pointerEvents: 'none',
    }
    const GLOBAL_OVERLAY_CARD_STYLE = {
      pointerEvents: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      maxWidth: 360,
      padding: '7px 10px',
      borderRadius: 999,
      border: '1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.14))',
      // 用真实存在的主题表面色（bg-base 深浅主题都有定义）。
      // 以前用的 bg-l2 在 0.2.1-rc.5 的 token 里不存在，回退成了深色底，
      // 而浅色主题的 label-primary 是黑色 → 黑底黑字，识别文本完全看不见。
      background: 'var(--dsw-alias-bg-base, #1c1c20)',
      color: 'var(--dsw-alias-label-primary, currentColor)',
      boxShadow: '0 4px 18px rgba(0, 0, 0, 0.22)',
      fontSize: 12,
      lineHeight: 1.4,
    }
    const GLOBAL_OVERLAY_ACTION_STYLE = {
      padding: '4px 12px',
      borderRadius: 999,
      border: '1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.18))',
      background: 'transparent',
      color: 'inherit',
      fontSize: 12,
      cursor: 'pointer',
    }

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
    function GlobalVoiceOverlay(props) {
      // 引用必须稳定：任何 effect/SSE 依赖它，裸箭头函数会让 effect 无限重跑。
      const t = useCallback(
        typeof props?.t === 'function' ? props.t : (key) => zh[key] ?? key,
        [props?.t],
      )

      // 定时器登记表：浮层里所有跨状态存活的定时器都登记在这里，卸载时全清。
      const timersRef = useRef(null)
      if (!timersRef.current) timersRef.current = createTimerRegistry(window)
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
          const resp = await fetch(`${BASE}/config`)
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
          const state = snapshot && snapshot.byId ? snapshot : readSessionSnapshot(clientService('sessions'))
          const mainViewId = findMainViewSessionId(state)
          if (mainViewId) {
            // 只有真正的主视图会话才写进持久化；fallback 选中的不覆盖，
            // 否则一次临时兜底会污染「上次聊的会话」。
            lastKnownSessionRef.current = mainViewId
            persistLastSessionId(mainViewId)
          }
          const picked = pickSessionId(state, { lastKnown: lastKnownSessionRef.current })
          if (picked) sessionIdRef.current = picked
        }

        // sessions 服务可能比组件晚就绪（注入作用域是异步解析的）：
        // 拿不到就短轮询几次再挂；一直拿不到就降级（发送时会尝试新建会话）。
        const attach = () => {
          if (!alive) return
          const sessionsService = clientService('sessions')
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
        if (!lastKnownSessionRef.current) lastKnownSessionRef.current = readLastSessionId()
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
        try {
          window.__DSH_VOICE_GLOBAL_DEBUG__ = () => {
            const sessionsService = clientService('sessions')
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
            }
          }
        } catch {
          // 非浏览器桩环境（没有 window）：跳过注册，不影响浮层功能。
        }
        return () => {
          try { delete window.__DSH_VOICE_GLOBAL_DEBUG__ } catch { /* 忽略 */ }
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
        const sessionsService = clientService('sessions')
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
          const workspace = clientService('uiWorkspace')
          if (typeof workspace?.openSession === 'function') await workspace.openSession(createdId)
        } catch {
          // 新建成功但打开视图失败：会话本身已经可用（binding/回退注入都不依赖视图），
          // 不因此丢掉这句话；下一帧列表快照会重新解析出它。
        }
        return createdId
      }, [t, setHint])

      /**
       * 发送识别文本到当前会话。
       *
       * ① 优先走客户端会话 RPC：与用户在输入框里手打完全同一条路
       *    （正常落库、正常渲染、正常触发模型），且不要求 composer 挂载；
       * ② 失败/拿不到 binding 时回退宿主 POST /voice-prompt（冷会话也能恢复）；
       * ③ 一个会话都没有时先自动新建一个再发；
       * ④ 都失败才在浮层提示 —— 绝不静默丢话。
       *
       * @param {string} text - 已归一化的文本。
       * @returns {Promise<boolean>} 是否送出去了。
       */
      /**
       * 把一次「语音 → 会话」的尝试上报给宿主（只进 /diagnostics，不改变行为）。
       *
       * 为什么需要：浮层发送失败时用户只看到一句「发送失败」，
       * 而宿主 /diagnostics 里原先只有 /voice-prompt 回退路径的计数 ——
       * 直发 `session.prompt` 失败时什么痕迹都没有，排查只能靠猜。
       * 这里复用已有的 /voice-session 心跳通道（客户端→宿主，无副作用）。
       *
       * @param {object} info - { sessionId, via, mode, ok, error }。
       */
      const reportVoiceAttempt = useCallback((info) => {
        try {
          void fetch(`${BASE}/voice-session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: info?.sessionId ?? '',
              client: { kind: 'global-voice', ...info, at: Date.now() },
            }),
          }).catch(() => { /* 诊断上报失败不影响发送 */ })
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
          const state = readSessionSnapshot(clientService('sessions'))
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
        const requestId = generateId('req')
        setHint(t('globalSending'))
        /** 直发失败的原因（透传到 /diagnostics，方便定位）。 */
        let directError = ''
        try {
          const sessionsService = clientService('sessions')
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
          const resp = await fetch(`${BASE}/voice-prompt`, {
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
        const pcm = resampleTo16k(samples, Number(sampleRate) > 0 ? Number(sampleRate) : 16000)
        if (!pcm.length) return
        setHint(t('globalTranscribing'))
        try {
          const resp = await fetch(`${BASE}/transcribe`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
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
                // 静默丢弃，但「待机中」提示最多每 WAKE_HINT_MS 一次，让用户知道还活着。
                if (now - standbyHintAtRef.current >= WAKE_HINT_MS) {
                  standbyHintAtRef.current = now
                  setHint(t('globalWakeStandbyHint', { word: wakeWord }), '', 2000)
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
            // 已唤醒：每句话直接发送，并顺延活跃时间。
            armActive()
            setLastText(text)
            await sendVoiceText(text)
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
       * @returns {Promise<boolean>} 成功返回 true；不可用/失败返回 false（调用方回退）。
       */
      const startWorkletVad = useCallback(async (media, source) => {
        const ctx = media?.ctx
        if (!ctx || !ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') return false
        if (typeof AudioWorkletNode !== 'function') return false
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
          return true
        } catch {
          return false
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
       * @returns {boolean} 是否成功搭起来。
       */
      const startScriptProcessorVad = useCallback((media, source) => {
        const ctx = media?.ctx
        if (!ctx || typeof ctx.createScriptProcessor !== 'function') return false
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
          }
          const emit = () => {
            if (!segment.length) return
            let total = 0
            for (const chunk of segment) total += chunk.length
            const samples = new Float32Array(total)
            let offset = 0
            for (const chunk of segment) {
              samples.set(chunk, offset)
              offset += chunk.length
            }
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
            while (pre.length > options.startFrames) pre.shift()
          }
          media.processor = processor
          source.connect(processor)
          const sink = ctx.createGain()
          sink.gain.value = 0
          processor.connect(sink)
          sink.connect(ctx.destination)
          media.sink = sink
          return true
        } catch {
          return false
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
          try {
            const closing = media.ctx?.close?.()
            if (closing && typeof closing.catch === 'function') closing.catch(() => {})
          } catch { /* 忽略 */ }
          try { media.stream?.getTracks?.().forEach?.((track) => track.stop()) } catch { /* 忽略 */ }
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
        try { window.dispatchEvent(new CustomEvent(GLOBAL_MIC_OFF_EVENT)) } catch { /* 测试桩环境 */ }
      }, [timers])

      /**
       * 开始聆听：先让 composer 麦克风让位 → 打开麦克风 → AudioWorklet VAD
       * （失败回退 ScriptProcessor）。任何一步失败都复位开关并提示原因。
       */
      const startListening = useCallback(async () => {
        if (listeningRef.current || startingRef.current) return
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
          setHint(t('micUnsupported'), 'error', 2500)
          return
        }
        // 先通知 composer 麦克风让位：两个引擎同时开麦会重复识别、重复发送。
        try { window.dispatchEvent(new CustomEvent(GLOBAL_MIC_ON_EVENT)) } catch { /* 测试桩环境 */ }
        startingRef.current = true
        setStarting(true)
        setHint(t('micStarting'))
        let stream
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          })
        } catch {
          startingRef.current = false
          if (aliveRef.current) setStarting(false)
          setHint(t('micDenied'), 'error', 2500)
          try { window.dispatchEvent(new CustomEvent(GLOBAL_MIC_OFF_EVENT)) } catch { /* 忽略 */ }
          return
        }
        // 打开期间用户可能已经点了一次「关闭」：把刚拿到的轨道释放掉。
        if (!aliveRef.current || !startingRef.current) {
          try { stream.getTracks().forEach((track) => track.stop()) } catch { /* 忽略 */ }
          return
        }
        let ctx
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext
          if (!AudioCtx) throw new Error('no AudioContext')
          ctx = new AudioCtx()
          // 用户手势里 resume，避免上下文 suspended 导致 process 不跑。
          await ctx.resume?.()
        } catch {
          try { stream.getTracks().forEach((track) => track.stop()) } catch { /* 忽略 */ }
          startingRef.current = false
          if (aliveRef.current) setStarting(false)
          setHint(t('micFailed'), 'error', 2500)
          try { window.dispatchEvent(new CustomEvent(GLOBAL_MIC_OFF_EVENT)) } catch { /* 忽略 */ }
          return
        }
        const media = { ctx, stream, source: null, node: null, processor: null, sink: null }
        mediaRef.current = media
        try {
          media.source = ctx.createMediaStreamSource(stream)
          const workletOk = await startWorkletVad(media, media.source)
          if (!workletOk) startScriptProcessorVad(media, media.source)
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
          stopListening()
          setHint(t('micFailed'), 'error', 2500)
        }
      }, [t, setHint, stopListening, startWorkletVad, startScriptProcessorVad])

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
          await fetch(`${BASE}/ui-action-result`, {
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
        const sessionsService = clientService('sessions')
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
            const layout = clientService('layout')
            const workspace = clientService('uiWorkspace')
            // 侧边栏方向：layout 服务只暴露 toggleSidebar，没有可读快照。
            // 唯一可靠信号是 AppFrame 渲染的 `data-sidebar-collapsed` 标记
            // （收起时存在，展开时不存在）。读不到（没有 frame / DOM 桩）返回 null，
            // 模型就别硬猜方向 —— 宁可先问一句，也别反着操作。
            let sidebarCollapsed = null
            try {
              if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
                sidebarCollapsed = document.querySelector('[data-sidebar-collapsed]') !== null
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
            const workspace = clientService('uiWorkspace')
            if (typeof workspace?.openSession !== 'function') return { ok: false, error: 'unsupported' }
            workspace.openSession(params.sessionId)
            return { ok: true, value: { switched: params.sessionId } }
          }
          case 'new_session': {
            const workspace = clientService('uiWorkspace')
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
            const layout = clientService('layout')
            if (typeof layout?.toggleSidebar !== 'function') return { ok: false, error: 'unsupported' }
            layout.toggleSidebar()
            return { ok: true, value: { toggled: true } }
          }
          // ---- v2：语义导航 ----
          case 'set_sidebar': {
            const layout = clientService('layout')
            if (typeof layout?.toggleSidebar !== 'function') return { ok: false, error: 'unsupported' }
            // 方向只能从 DOM 标记读：layout 服务只暴露 toggleSidebar，没有可读状态。
            // 读不到就回 unknown_state，绝不盲切 —— 说「收起」结果展开是最糟的体验。
            let collapsed = null
            try {
              if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
                collapsed = document.querySelector('[data-sidebar-collapsed]') !== null
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
            const navigation = clientService('pluginNavigation')
            if (typeof navigation?.openList !== 'function') return { ok: false, error: 'unsupported' }
            navigation.openList()
            return { ok: true, value: { opened: true } }
          }
          // ---- v2：通用 a11y 原语 ----
          case 'ui_snapshot': {
            try {
              if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
                return { ok: false, error: 'unsupported' }
              }
              // 新快照整体覆盖旧表（ref 只在最近一次快照内有效）。
              clearA11ySnapshot()
              const all = document.querySelectorAll('*')
              const elements = []
              for (let i = 0; i < all.length && elements.length < MAX_SNAPSHOT_ELEMENTS; i++) {
                const el = all[i]
                if (!isA11yElementVisible(el)) continue
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
                a11ySnapshotElements.set(info.ref, el)
                // 同时记可读名：确认条要把「ui_click: e12」翻译成「点击「发送」（e12）」。
                a11ySnapshotInfo.set(info.ref, info)
                elements.push(info)
              }
              let sidebarCollapsed = null
              try {
                sidebarCollapsed = document.querySelector('[data-sidebar-collapsed]') !== null
              } catch {
                sidebarCollapsed = null
              }
              return { ok: true, value: { elements, count: elements.length, sidebarCollapsed } }
            } catch {
              return { ok: false, error: 'snapshot_failed' }
            }
          }
          case 'ui_click': {
            const el = resolveA11yElement(params.ref)
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
            const el = resolveA11yElement(params.ref)
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
              setNativeInputValue(el, String(params.text))
              return { ok: true, value: { typed: params.text.length, tag: writableKind } }
            }
            try {
              el.textContent = String(params.text)
              dispatchDomEvent(el, 'input', { bubbles: true })
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
            try { target = document.activeElement ?? document.body ?? null } catch { target = null }
            if (!target) return { ok: false, error: 'unsupported' }
            const init = {
              // Space 的 KeyboardEvent.key 是 ' '（不是 'Space'），按真实规范派发。
              key: parsed.key === 'Space' ? ' ' : parsed.key,
              bubbles: true,
              cancelable: true,
              ctrlKey: parsed.ctrl === true,
              altKey: parsed.alt === true,
              shiftKey: parsed.shift === true,
              metaKey: parsed.meta === true,
            }
            dispatchDomEvent(target, 'keydown', init)
            dispatchDomEvent(target, 'keyup', init)
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
        if (!(await claimUiAction(requestId))) return
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
       * 设置面板正在录制快捷键时（两个模块级聚焦标志任一为真）直接忽略，
       * 否则用户按 Ctrl+Alt+V 想改键，反而把浮层打开了。
       */
      useEffect(() => {
        const down = (event) => {
          if (shortcutFieldFocused || globalShortcutFieldFocused) return
          if (configRef.current.globalVoice !== true) return
          const combo = configRef.current.globalShortcut ?? UI_DEFAULTS.globalShortcut
          if (!shortcutMatches(event, combo)) return
          event.preventDefault()
          if (event.repeat) return
          toggleListening()
        }
        try {
          window.addEventListener('keydown', down, true)
        } catch {
          return undefined
        }
        return () => {
          try { window.removeEventListener('keydown', down, true) } catch { /* 忽略 */ }
        }
      }, [toggleListening])

      /**
       * composer 快捷键在全局语音开启时改为「切换浮层麦克风」（见 GLOBAL_TOGGLE_EVENT）。
       * 输入框麦克风已隐藏，所以 Alt+V 和 Ctrl+Alt+V 最终都落到同一个入口。
       */
      useEffect(() => {
        const onToggle = () => toggleListening()
        try {
          window.addEventListener(GLOBAL_TOGGLE_EVENT, onToggle)
        } catch {
          return undefined
        }
        return () => {
          try { window.removeEventListener(GLOBAL_TOGGLE_EVENT, onToggle) } catch { /* 忽略 */ }
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
            source = new EventSource(`${BASE}/stream`)
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
        return React.createElement('div', {
          style: { display: 'none' },
          'aria-hidden': 'true',
          'data-dsh-voice-typing-global': GLOBAL_OVERLAY_ID,
        })
      }

      // v3：有唤醒词时，状态文字由「待机/活跃」推导（而不是沿用固定文案）：
      // 待机 · 说『小D』唤醒 / 聆听中（说『小D』唤醒）。无唤醒词维持 v2 行为。
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
      const micIcon = React.createElement(
        'svg',
        { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        React.createElement('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3 }),
        React.createElement('path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0' }),
        React.createElement('line', { x1: 12, y1: 18, x2: 12, y2: 21.5 }),
      )
      const micButton = React.createElement(
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
        ? React.createElement(
            'div',
            { style: { ...GLOBAL_OVERLAY_CARD_STYLE, flexDirection: 'column', alignItems: 'flex-start', gap: 6, borderRadius: 12 } },
            React.createElement(
              'span',
              { style: { fontSize: 12, opacity: 0.95 } },
              // 有快照信息时翻译成「点击「插件」（e12）」；没有则退回协议描述。
              `${t('globalAskConfirm')}：${describeConfirmTarget(confirmRequest, t)}`,
            ),
            // 语音确认提示：确认条挂着时直接说「允许/拒绝」也生效
            //（由 transcribeSegment 拦截识别结果，不发送该句）。
            React.createElement(
              'span',
              { style: { fontSize: 11, opacity: 0.7 } },
              t('globalConfirmSpeakHint'),
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', gap: 8 } },
              React.createElement(
                'button',
                {
                  type: 'button',
                  onClick: () => answerConfirm(true),
                  style: { ...GLOBAL_OVERLAY_ACTION_STYLE, borderColor: 'var(--dsw-alias-state-success, #2ea043)', color: 'var(--dsw-alias-state-success, #2ea043)' },
                },
                t('globalAllow'),
              ),
              React.createElement(
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

      return React.createElement(
        'div',
        { style: GLOBAL_OVERLAY_WRAPPER_STYLE, 'data-dsh-voice-typing-global': GLOBAL_OVERLAY_ID },
        confirmBar,
        React.createElement(
          'div',
          { style: GLOBAL_OVERLAY_CARD_STYLE },
          micButton,
          React.createElement(
            'span',
            { title: statusText, style: { maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: statusColor } },
            statusText,
          ),
          lastText
            ? React.createElement(
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

    /**
     * 设置面板：模型、词表、朗读与交互开关。
     * @param props - slot 注入的属性。
     * @returns 设置表单。
     */
    /**
     * 设置面板用的三个小组件。
     *
     * **必须在模块级定义。**
     * 定义在组件体内的话，每次渲染它们都是新的函数 →
     * React 认为组件类型变了 → 卸载并重建 →
     * 设置面板里的输入框**每敲一个字符就失焦**
     *（词表、快捷键、两个毫秒数全中招）。
     */
    const labelStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      marginBottom: 14,
      fontSize: 13,
    }
    const Label = (props) => React.createElement('label', { style: labelStyle }, props.children)

    /**
     * 分组标题（可带说明，可折叠）。
     *
     * 用原生 `<details>/<summary>` 做折叠：SSR 友好、不依赖 hooks/state，
     * 浏览器里默认就是「点标题展开/收起」。高级与诊断区默认收起。
     * @param {{title: string, subtitle?: string, collapsible?: boolean, defaultOpen?: boolean, children?: any}} props
     */
    const Section = (props) => {
      const titleRow = React.createElement(
        'div',
        {
          style: {
            fontSize: 12,
            fontWeight: 600,
            opacity: 0.65,
            letterSpacing: '0.04em',
            marginBottom: props.subtitle ? 4 : 10,
            paddingBottom: 5,
            borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08))',
          },
        },
        props.title,
      )
      const subtitle = props.subtitle
        ? React.createElement(
            'div',
            { style: { fontSize: 12, opacity: 0.6, marginBottom: 10, lineHeight: 1.5 } },
            props.subtitle,
          )
        : null
      const body = React.createElement('div', null, props.children)
      if (!props.collapsible) {
        return React.createElement(
          'div',
          { style: { marginBottom: 18 } },
          titleRow,
          subtitle,
          body,
        )
      }
      // 折叠态：原生 <details>/<summary>（浏览器自带可更新的展开箭头，SSR 直接输出）。
      // `defaultOpen=false` 时不写 open 属性 → 默认收起。
      const detailsProps = { style: { marginBottom: 18 } }
      if (props.defaultOpen !== false) detailsProps.open = true
      return React.createElement(
        'details',
        detailsProps,
        React.createElement(
          'summary',
          { style: { cursor: 'pointer', outline: 'none' } },
          titleRow,
          subtitle,
        ),
        body,
      )
    }

    /**
     * 短字段并排（紧凑布局）。
     *
     * 窄面板自动换列（auto-fit + minmax）；**模块级组件**（不能有 hooks，
     * 否则每次渲染类型都变、输入框会失焦）。
     */
    const Row = (props) => React.createElement(
      'div',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          columnGap: 14,
          alignItems: 'start',
        },
      },
      props.children,
    )

    /**
     * 开关行（带说明）。
     * @param {object} props - {label, hint, checked, onChange}。
     */
    const Toggle = (props) => React.createElement(
      'label',
      { style: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, marginBottom: 10, cursor: 'pointer' } },
      React.createElement('input', {
        type: 'checkbox',
        checked: props.checked === true,
        onChange: (event) => props.onChange(event.target.checked),
        style: { marginTop: 2 },
      }),
      React.createElement(
        'span',
        null,
        React.createElement('span', null, props.label),
        props.hint
          ? React.createElement('span', { style: { display: 'block', fontSize: 12, opacity: 0.65, marginTop: 2 } }, props.hint)
          : null,
      ),
    )

    function VoiceSettingsSection(props) {
      // 必须用 useCallback 稳住引用。
      // 直接写箭头函数的话，每次渲染都是新函数，
      // 而下面监听 SSE 的 effect 依赖 [reload, t] ——
      // 于是 effect 反复重跑：EventSource 刚连上就被 close() 关掉，
      // 永远收不到 model-progress（下载看不到进度），
      // 同时 void reload() → setConfig → 渲染 → 又触发 effect，陷入死循环。
      const t = useCallback(
        typeof props?.t === 'function' ? props.t : (key) => zh[key] ?? key,
        [props?.t],
      )
      // 初始配置：默认取共享的 configStore。
      // __initialConfig 是给测试用的专用入口（宿主不会传这个名字），
      // 避免和宿主可能存在的 props.config 撞车。
      const [config, setConfig] = useState(props?.__initialConfig ?? configStore.value)
      // 词表输入框显示**用户原始输入**（空格/换行不能逐键归一化，否则键盘打不了）。
      // config.words 只在失焦/保存时归一化写入（审计 F1）。
      const [wordsText, setWordsText] = useState(() => formatWordsText((props?.__initialConfig ?? configStore.value)?.words))
      const [models, setModels] = useState(props?.__initialModels ?? [])
      const [voices, setVoices] = useState([])
      /** 本地引擎在当前平台是否可用（Windows/macOS/Linux）。 */
      const [localSupported, setLocalSupported] = useState(true)
      /** 运行环境自检结果。 */
      const [envInfo, setEnvInfo] = useState(null)
      /** 是否正在做环境自检。 */
      const [checkingEnv, setCheckingEnv] = useState(false)
      const [dirty, setDirty] = useState(false)
      /** 初始配置是否已从宿主加载完成。未完成时禁止保存，
       *  否则会用默认值覆盖用户已有的设置（比如把「朗读回复」关掉）。 */
      const [loaded, setLoaded] = useState(false)
      const [status, setStatus] = useState('')
      /** 配置加载失败的提示（加载失败时保持 loaded=false、保存按钮禁用）。 */
      const [loadError, setLoadError] = useState('')
      /** POST /config 的 400 校验错误（可读文案列表）。 */
      const [saveErrors, setSaveErrors] = useState([])
      const [progress, setProgress] = useState(null)
      /**
       * 系统级热键 helper 的实时状态（只读展示）。
       *
       * null = 还没拉过（SSR/首次渲染）；{ok:false} = 诊断接口不可用；
       * {ok:true, platform,status,enabled,reason,accelerator} = 宿主状态。
       * 单独一份 state，绝不参与配置加载/保存（避免把只读诊断写进配置）。
       */
      const [hotkeyStatus, setHotkeyStatus] = useState(null)

      const set = (key, value) => {
        setConfig((prev) => ({ ...prev, [key]: value }))
        setDirty(true)
      }

      /**
       * 按引擎加载音色列表。
       * 必须跟随当前引擎：之前写死 engine=online，
       * 导致选了本地引擎后，下拉里还是 Edge 的音色列表。
       * @param {string} engine - online / local / neural / sovits。
       */
      const loadVoices = useCallback(async (engine) => {
        const normalized = normalizeEngine(engine) || 'online'
        // 神经模型 / GPT-SoVITS 没有可枚举的「音色列表」：
        // 前者用模型+说话人，后者由用户自己的服务端管理。
        if (normalized === 'neural' || normalized === 'sovits') {
          setVoices([])
          return
        }
        const target = normalized === 'local' ? 'local' : 'online'
        try {
          const resp = await fetch(`${BASE}/voices?engine=${target}${target === 'online' ? '&lang=zh' : ''}`)
          if (!resp.ok) return
          const data = await resp.json().catch(() => null)
          if (!data) return
          if (data.voices) setVoices(data.voices)
          if (target === 'local' && data.supported === false) setLocalSupported(false)
        } catch {
          /* 忽略 */
        }
      }, [])

      // 未保存改动标志的 ref 版：reload 是 useCallback，
      // 直接依赖 dirty 会在每次改动后重建它（依赖不稳定）。
      const dirtyRef = useRef(false)
      useEffect(() => { dirtyRef.current = dirty }, [dirty])
      // 面板卸载时复位「快捷键输入框聚焦」标志：模块级标志若卡在 true，
      // 全局快捷键会永久失效（卸载不保证触发 blur，审计 F14）。
      useEffect(() => () => { shortcutFieldFocused = false }, [])
      // 全局语音快捷键输入框是另一套设置，聚焦标志也要在卸载时复位。
      useEffect(() => () => { globalShortcutFieldFocused = false }, [])

      const reload = useCallback(async () => {
        try {
          const resp = await fetch(`${BASE}/config`)
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const data = await resp.json()
          if (!data || typeof data !== 'object') throw new Error('bad config payload')
          // **有未保存改动时绝不覆盖表单，也绝不把 dirty 清掉。**
          //
          // reload() 会在多个时机被调用：挂载、模型下载完成（model-ready）、
          // 换引擎换音色……用户正在改设置时它一跑，旧实现会 setConfig +
          // setDirty(false)：界面显示「没有未保存的改动」、保存按钮变灰，
          // 用户刚改的东西既没保存也不会被重置（审计 F2）。
          //
          // 共享存储照常更新（那是服务端的权威值），但表单只在没有本地改动时刷新。
          if (!dirtyRef.current) {
            setConfig((prev) => ({ ...prev, ...data }))
            setWordsText(formatWordsText(data.words))
            setDirty(false)
          }
          configStore.set(data)
          configStore.loaded = true
          setLoaded(true)
          setLoadError('')
          // 音色列表跟随（服务端生效的）引擎加载。
          void loadVoices(data.ttsEngine)
        } catch (error) {
          // 加载失败时保持 loaded=false（保存按钮禁用），并给出可重试提示。
          // 旧实现这里 setLoaded(true)：用户会拿默认/旧快照去保存，覆盖服务端配置。
          setLoaded(false)
          setStatus('')
          setLoadError(t('configLoadFailed'))
          try {
            if (typeof process !== 'undefined' && process?.env?.DSH_VT_DEBUG) {
              console.warn('[dsh-voice-typing] config load failed:', error)
            }
          } catch { /* 忽略 */ }
        }
      }, [loadVoices, t])

      /**
       * 拉取模型档位清单（识别 + 合成）。
       *
       * 下载完成后模型列表必须重新拉：
       * 之前只在组件挂载时拉一次，model-ready 事件只调 reload()，
       * 而 reload() 刷的是 /config 不是 /models ——
       * 结果下载完成了，列表里的 ready 还是 false，按钮还是「下载模型」。
       */
      const loadModels = useCallback(async () => {
        try {
          const resp = await fetch(`${BASE}/models`)
          if (!resp.ok) return null
          const data = await resp.json()
          if (data?.models) setModels(data.models)
          return data
        } catch {
          return null
        }
      }, [])

      /**
       * 拉一次系统级热键的实时状态（GET /diagnostics）。
       *
       * 只读展示：失败就显示「未知（诊断不可用）」，不重试、不抛错、不进配置。
       * 宿主 state() 当前返回 {enabled, status, reason}；platform/accelerator
       * 属于可选字段（不同版本/未来扩展），取值时都要防御。
       */
      const loadHotkeyStatus = useCallback(async () => {
        try {
          const resp = await fetch(`${BASE}/diagnostics`)
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const data = await resp.json().catch(() => null)
          if (!data || typeof data !== 'object') throw new Error('bad diagnostics payload')
          const hh = data.hotkeyHelper && typeof data.hotkeyHelper === 'object' ? data.hotkeyHelper : {}
          setHotkeyStatus({
            ok: true,
            platform: typeof hh.platform === 'string' ? hh.platform : '',
            status: typeof hh.status === 'string' ? hh.status : '',
            enabled: hh.enabled === true,
            reason: typeof hh.reason === 'string' ? hh.reason : '',
            accelerator: typeof hh.accelerator === 'string' ? hh.accelerator : '',
          })
        } catch {
          setHotkeyStatus({ ok: false })
        }
      }, [])

      // 热键状态只读：面板挂载时拉一次（失败显示未知，不循环重试）。
      useEffect(() => {
        void loadHotkeyStatus()
      }, [loadHotkeyStatus])

      useEffect(() => {
        void reload()
        // 先问宿主当前平台支不支持本地合成，不支持就把该选项禁用。
        fetch(`${BASE}/voices?engine=local`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => { if (data && data.supported === false) setLocalSupported(false) })
          .catch(() => {})
        void loadModels().then((data) => {
          // 恢复下载中的状态：
          // 设置面板关掉再打开时，组件重新挂载、组件内的状态全丢。
          // 宿主那边下载还在跑（activeDownloads），进度也在宿主侧，
          // 这里从 /models 的 downloading / received / total 恢复，
          // 否则用户看到的永远是「刚点了下载」却没有任何进度。
          //
          // 注意：不要把这段塞进 setModels 的更新函数里 ——
          // 在状态更新函数里调别的 setState 是 React 反模式，
          // 更新函数必须是纯的。
          const downloading = data?.models?.find((m) => m.downloading)
          if (!downloading) return
          setProgress({
            id: downloading.id,
            received: downloading.received ?? 0,
            total: downloading.total ?? 0,
          })
          setStatus(t('downloading'))
        })
        const source = new EventSource(`${BASE}/stream`)
        source.addEventListener('model-progress', (event) => {
          try {
            const payload = parseEnvelope(event)
            if (!payload) return
            // percent 由宿主算好 —— 两端各算一次会分叉
            // （宿主知道 total 的真实值，客户端只知道最近一次拿到的）。
            setProgress({
              id: payload.id,
              received: payload.received,
              total: payload.total,
              percent: payload.percent,
            })
            // 同步模型列表里的「下载中」状态
            setModels((prev) => prev.map((m) => (
              m.id === payload.id
                ? { ...m, downloading: true, received: payload.received, total: payload.total }
                : m
            )))
          } catch {
            /* 忽略 */
          }
        })
        source.addEventListener('model-ready', (event) => {
          void parseEnvelope(event)
          setProgress(null)
          setStatus(t('ready2'))
          // 模型刚下载好，刷新模型列表：
          // 不刷的话列表里的 ready 还是 false，按钮一直显示「下载模型」。
          void loadModels()
          void reload()
        })
        source.addEventListener('model-error', (event) => {
          void parseEnvelope(event)
          setProgress(null)
          setStatus(t('downloadFailed'))
          // 失败也要刷：把「下载中」的标记去掉，否则按钮一直禁用
          void loadModels()
        })
        return () => source.close()
      }, [reload, t, loadModels])

      /** 识别模型（不含合成模型）。 */
      const asrModels = models.filter((m) => m.category !== 'tts')
      /** 合成模型（从统一列表里取）。 */
      const ttsModels = models.filter((m) => m.category === 'tts')
      /** 已下载可用的合成模型（只有这些能被选中）。 */
      const readyNeural = ttsModels.filter((m) => m.ready)
      /** 已下载可用的识别模型（只有这些能被选中）。 */
      // host 模型不再无条件当作可用：
    // 用户没装 DSH 语音输入 Bundle 时，SenseVoice 既没有宿主那份、
    // 也没下载过 —— 它其实不可用，必须显示成「需要下载」。
    // 之前用 `m.ready || m.host`，界面显示「已就绪」，
    // 一用就报错（模型文件找不到）。
    const readyAsr = asrModels.filter((m) => m.ready)

      const save = useCallback(async () => {
        // 保存前先做一次 UI 侧归一化（枚举/数值/模型残留），然后交给宿主 schema 校验。
        // 宿主非法时返回 400 {ok:false, errors:[{key,reason}]} → 可读展示、保持 dirty。
        const asrModel = asrModels.find((m) => m.id === config.model)
        const readyNeuralIds = readyNeural.map((m) => m.id)
        const selectedNeural = readyNeural.find((m) => m.id === config.neuralModel) ?? readyNeural[0]
        const neuralSpeakers = Number(selectedNeural?.speakers)
        const payload = normalizeForSave(
          { ...config, words: parseWordsText(wordsText) },
          { readyNeuralIds, asrModel, neuralSpeakers },
        )
        try {
          const resp = await fetch(`${BASE}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const data = await resp.json().catch(() => null)
          if (!resp.ok) {
            const errors = collectSaveErrors(data)
            setSaveErrors(errors.length ? errors : [t('saveFailed')])
            setStatus(t('saveFailed'))
            return
          }
          setDirty(false)
          setSaveErrors([])
          setStatus(t('saved'))
          // 同步到共享配置：麦克风按钮立刻用新参数，不用刷新页面。
          configStore.set(payload)
          configStore.loaded = true
          // 以服务端返回的生效配置为准回填，避免界面与实际不一致
          const effective = data?.config && typeof data.config === 'object' ? data.config : payload
          setConfig((prev) => ({ ...prev, ...effective }))
          setWordsText(formatWordsText(effective.words))
          configStore.set(effective)
          // 保存后宿主会按新配置重新 sync helper：再拉一次只读状态，
          // 让用户立刻看到「已启用/失败原因」，而不用重新打开面板。
          void loadHotkeyStatus()
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          setSaveErrors([`${t('saveFailed')}${detail ? '：' + detail : ''}`])
          setStatus(t('saveFailed'))
        }
      }, [config, wordsText, asrModels, readyNeural, t, loadHotkeyStatus])

      /**
       * 运行环境自检：看哪个朗读引擎能用、机器上有没有 NVIDIA 显卡。
       *
       * 注意：显卡信息只是**展示**用的。插件的推理一律走 CPU ——
       * 实测 CUDA 只比 CPU 快 20%，却要额外装 2GB 的 NVIDIA 运行时，
       * 不划算，所以没有做 GPU 加速。
       */
      const runEnvCheck = useCallback(async () => {
        setCheckingEnv(true)
        try {
          const resp = await fetch(`${BASE}/tts/env`)
          const data = resp.ok ? await resp.json() : null
          if (data) setEnvInfo(data)
        } catch {
          /* 忽略 */
        } finally {
          setCheckingEnv(false)
        }
      }, [])

      const download = useCallback(
        async (id) => {
          setStatus(t('downloading'))
          setProgress({ id, received: 0, total: 0 })
          // 立刻把这一行标成「下载中」：
          // 否则要等 SSE 的第一条 model-progress 回来才变，
          // 用户会以为「点了没反应」。
          setModels((prev) => prev.map((m) => (m.id === id ? { ...m, downloading: true } : m)))
          try {
            const resp = await fetch(`${BASE}/model`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id }),
            })
            if (!resp.ok) {
              const body = await resp.json().catch(() => ({}))
              setStatus(body?.error ?? t('downloadFailed'))
              setModels((prev) => prev.map((m) => (m.id === id ? { ...m, downloading: false } : m)))
            }
          } catch {
            setStatus(t('downloadFailed'))
            setModels((prev) => prev.map((m) => (m.id === id ? { ...m, downloading: false } : m)))
          }
        },
        [t],
      )


      const inputStyle = {
        padding: '6px 8px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
      }

      // 当前引擎：决定哪些参数有意义。非法值按 online 处理并提示（保存时会修正）。
      const engineRaw = String(config.ttsEngine ?? '').trim().toLowerCase()
      const engine = normalizeEngine(engineRaw) || UI_DEFAULTS.ttsEngine
      const engineInvalid = Boolean(engineRaw) && engineRaw !== engine
      const isOnline = engine === 'online'
      const isNeural = engine === 'neural'
      const isLocal = engine === 'local'
      const isSovits = engine === 'sovits'
      const readAloudOn = config.readAloud === true

      // ---- 识别侧联动 ----
      const selectedAsrModel = asrModels.find((m) => m.id === config.model) ?? null
      const asrModelLanguages = Array.isArray(selectedAsrModel?.languages) && selectedAsrModel.languages.length
        ? selectedAsrModel.languages
        : null
      /** 只有 SenseVoice 真正消费 language（其它模型的 worker 配置里没有 language）。 */
      const languageSupported = selectedAsrModel ? selectedAsrModel.engine === 'sensevoice' : true
      const languageValue = String(config.language ?? UI_DEFAULTS.language)
      const languageOptions = LANGUAGE_CODES.filter(
        (code) => code === 'auto' || !asrModelLanguages || asrModelLanguages.includes(code),
      )
      const languageWarn = languageSupported
        ? (Boolean(asrModelLanguages) && languageValue !== 'auto' && !asrModelLanguages.includes(languageValue))
        : true
      const streamModel = models.find((m) => m.id === STREAM_MODEL_IDS[0]) ?? null
      const streamReady = Boolean(streamModel?.ready)
      const liveAsrValue = String(config.liveAsr ?? UI_DEFAULTS.liveAsr)
      const autoSendOff = config.autoSend === false
      const modeValue = String(config.mode ?? UI_DEFAULTS.mode)
      const onceUnavailable = modeValue === 'once' && autoSendOff
      // ---- 合成侧联动 ----
      const neuralModelMissing = isNeural && readyNeural.length > 0
        && !readyNeural.some((m) => m.id === config.neuralModel)
      const selectedNeural = readyNeural.find((m) => m.id === config.neuralModel) ?? readyNeural[0]
      const speakerCount = Number(selectedNeural?.speakers)
      // 快捷键非法时阻止保存（旧实现只显示红字但仍允许保存 → 保存后热键静默失效）。
      const shortcutCheck = validateShortcut(config.shortcut ?? UI_DEFAULTS.shortcut)
      // 全局语音快捷键是**另一套**配置：同样复用 validateShortcut 规则，
      // 非法时也要阻止保存（否则保存成功但窗口内快捷键永久不触发）。
      const globalShortcutValue = String(config.globalShortcut ?? UI_DEFAULTS.globalShortcut)
      const globalShortcutCheck = validateShortcut(globalShortcutValue)
      const voicePromptModeValue = VOICE_PROMPT_MODES.includes(String(config.voicePromptMode))
        ? String(config.voicePromptMode)
        : UI_DEFAULTS.voicePromptMode
      // 唤醒词：显示原样（trim 后），空串合法 = 关闭唤醒词。
      const wakeWordValue = String(config.wakeWord ?? UI_DEFAULTS.wakeWord).trim()
      const saveDisabled = !dirty || !loaded || !shortcutCheck.ok || !globalShortcutCheck.ok
      const envEngines = formatEnvEngines(envInfo, engine)
      // 下拉显示用：把存量值收敛到 UI 认识的形状，并把列表外的合法值补成额外选项
      // （避免「保存在即悄悄改成第一项」）。
      const rateValue = limitChoiceString(config.rate, RATE_PATTERN, UI_DEFAULTS.rate)
      const pitchValue = limitChoiceString(config.pitch, PITCH_PATTERN, UI_DEFAULTS.pitch)
      const volumeValue = limitChoiceString(config.volume, VOLUME_PATTERN, UI_DEFAULTS.volume)
      const ttsFormatValue = TTS_FORMATS.includes(config.ttsFormat) ? config.ttsFormat : UI_DEFAULTS.ttsFormat
      const idleValue = normalizeIdleReleaseMinutes(config.idleReleaseMinutes)

      // ---- 系统级热键只读状态（纯展示，不参与 normalizeForSave / 保存）----
      const helperOn = config.globalHotkeyHelper === true
      const overlayOn = config.globalVoice === true
      // 平台优先用宿主 state() 给的（未来版本可能有），否则从渲染器平台推断。
      const hotkeyPlatformText = describePlatformName(
        hotkeyStatus?.ok === true && hotkeyStatus.platform ? hotkeyStatus.platform : clientPlatform(),
      )
      let hotkeyStatusText = ''
      let hotkeyStatusReasonText = ''
      if (!helperOn) {
        // 本地开关关着：宿主可能还没来得及 sync，直接显示关了，比旧状态更可信。
        hotkeyStatusText = t('hotkeyStatusDisabled')
      } else if (!hotkeyStatus) {
        hotkeyStatusText = t('hotkeyStatusLoading')
      } else if (hotkeyStatus.ok !== true) {
        hotkeyStatusText = t('hotkeyStatusUnknown')
      } else {
        const helperState = hotkeyStatus.status
        // 已启用时显示组合键：宿主 state() 没带 accelerator，就用当前配置值。
        const accelerator = hotkeyStatus.accelerator || String(config.globalShortcut ?? UI_DEFAULTS.globalShortcut)
        if (hotkeyStatus.enabled === true || helperState === 'enabled') {
          hotkeyStatusText = t('hotkeyStatusEnabled', { accelerator })
        } else if (helperState === 'starting' || helperState === 'loading') {
          hotkeyStatusText = t('hotkeyStatusStarting')
        } else if (helperState === 'failed' || helperState === 'exited') {
          hotkeyStatusText = t('hotkeyStatusFailed', { reason: hotkeyStatus.reason || helperState })
        } else {
          hotkeyStatusText = t('hotkeyStatusDisabled')
        }
        // failed/exited 的 reason 已嵌进文案里；其它状态（如「浮层未开启已跳过」）单独展示。
        if (helperState !== 'failed' && helperState !== 'exited') hotkeyStatusReasonText = hotkeyStatus.reason || ''
      }
      const hotkeyNeedsOverlay = helperOn && !overlayOn

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 2px' } },

        /* ============ 一、语音识别 ============ */
        React.createElement(
          Section,
          { title: t('secRecognition'), subtitle: t('secRecognitionHint'), collapsible: true },
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('model')),
            React.createElement(
              'select',
              {
                value: config.model ?? UI_DEFAULTS.model,
                onChange: (event) => set('model', event.target.value),
                style: inputStyle,
              },
              // 只列出「已下载可用」的识别模型。
              // 没下好的模型不允许被选中 —— 只能去模型管理区下载。
              (readyAsr.length
                ? readyAsr.map((model) => React.createElement(
                    'option',
                    { key: model.id, value: model.id },
                    model.label,
                  ))
                : [React.createElement('option', { key: '__none', value: '' }, t('modelNoReady'))]),
              readyAsr.length
                ? React.createElement(
                    'span',
                    { style: { fontSize: 12, opacity: 0.7 } },
                    t('modelHint'),
                  )
                : null,
            ),
          ),
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('language')),
            React.createElement(
              'select',
              {
                value: languageValue,
                disabled: !languageSupported,
                onChange: (event) => set('language', event.target.value),
                style: { ...inputStyle, opacity: languageSupported ? 1 : 0.55 },
              },
              // 只有 SenseVoice 真正消费 language；其它模型把选项过滤到模型自己支持的语言，
              // 模型完全不支持语言提示时就禁用（审计 F4）。
              LANGUAGE_CODES.map((lang) => React.createElement(
                'option',
                {
                  key: lang,
                  value: lang,
                  disabled: !languageOptions.includes(lang),
                },
                languageLabel(lang),
              )),
            ),
            !languageSupported
              ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } }, t('languageModelUnsupported'))
              : languageWarn
                ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } }, t('languageNotInModel'))
                : null,
          ),

          /* 实时字方式：整段重识别 vs 流式解码 */
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('liveAsr')),
            React.createElement(
              'select',
              {
                value: liveAsrValue,
                onChange: (event) => set('liveAsr', event.target.value),
                style: inputStyle,
              },
              [
                ['full', t('liveAsrFull')],
                // 流式解码依赖 zipformer2-zh；没下载时禁用并说明（审计：隐藏依赖）。
                ['stream', streamReady ? t('liveAsrStream') : `${t('liveAsrStream')}（需先下载 zipformer2-zh）`],
                ['auto', t('liveAsrAuto')],
              ].map(([v, label]) => React.createElement(
                'option',
                { key: v, value: v, disabled: v === 'stream' && !streamReady },
                label,
              )),
            ),
            React.createElement(
              'span',
              { style: { fontSize: 12, opacity: 0.7 } },
              t('liveAsrHint'),
            ),
            !streamReady
              ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } }, t('liveAsrStreamNeedsModel'))
              : null,
          ),
        ),

        /* ============ 二、语音交互 ============ */
        React.createElement(
          Section,
          { title: t('secInteraction'), subtitle: t('secInteractionHint'), collapsible: true },
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('mode')),
            React.createElement(
              'select',
              {
                value: modeValue,
                onChange: (event) => set('mode', event.target.value),
                style: inputStyle,
              },
              [
                { value: 'toggle', label: t('modeToggle'), disabled: false },
                // 「说完就关」的退出发生在自动发送分支里：autoSend 关闭时它不会生效。
                { value: 'once', label: t('modeOnce'), disabled: autoSendOff },
              ].map((item) => React.createElement(
                'option',
                { key: item.value, value: item.value, disabled: item.disabled },
                item.label,
              )),
            ),
            React.createElement(
              'span',
              { style: { fontSize: 12, opacity: 0.7 } },
              t('modeHint'),
            ),
            onceUnavailable
              ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } }, t('modeOnceNeedsAutoSend'))
              : null,
          ),
          React.createElement(
            Toggle,
            {
              label: t('autoSend'),
              hint: t('autoSendHint'),
              checked: config.autoSend !== false,
              onChange: (v) => set('autoSend', v),
            },
          ),
          // 短字段并排：断句时长 + 发送前等待（后者只在自动发送打开时有意义）
          React.createElement(
            Row,
            null,
            // 断句时长：直接决定「说完一句」判定，影响体验最明显
            React.createElement(
              Label,
              null,
              React.createElement('span', null, t('silenceMs')),
              React.createElement(
                'input',
                {
                  type: 'number',
                  min: 500,
                  max: 5000,
                  step: 100,
                  value: config.silenceMs ?? 1500,
                  onChange: (event) => set('silenceMs', Math.max(500, Math.min(5000, Number(event.target.value) || 1500))),
                  style: { ...inputStyle, width: 120 },
                },
              ),
              React.createElement(
                'span',
                { style: { fontSize: 12, opacity: 0.7 } },
                t('silenceMsHint'),
              ),
            ),
            config.autoSend !== false
              ? React.createElement(
                  Label,
                  null,
                  React.createElement('span', null, t('autoSendExtraMs')),
                  React.createElement(
                    'input',
                    {
                      type: 'number',
                      min: 0,
                      max: 5000,
                      step: 100,
                      value: config.autoSendExtraMs ?? UI_DEFAULTS.autoSendExtraMs,
                      onChange: (event) => set('autoSendExtraMs', clampAutoSendExtraMs(event.target.value)),
                      style: { ...inputStyle, width: 120 },
                    },
                  ),
                  React.createElement(
                    'span',
                    { style: { fontSize: 12, opacity: 0.7 } },
                    t('autoSendExtraMsHint'),
                  ),
                )
              : null,
          ),
          // 快捷键单独一行（输入框需要完整宽度）
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('shortcut')),
            React.createElement('input', {
              value: config.shortcut ?? UI_DEFAULTS.shortcut,
              onChange: (event) => set('shortcut', event.target.value),
              placeholder: UI_DEFAULTS.shortcut,
              // 聚焦这个输入框时，快捷键不应该触发录音。
              onFocus: () => { shortcutFieldFocused = true },
              onBlur: () => { shortcutFieldFocused = false },
              style: inputStyle,
            }),
            React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, t('shortcutHint')),
            !shortcutCheck.ok
              ? React.createElement(
                  'span',
                  { style: { fontSize: 12, color: 'var(--dsw-alias-state-danger, #d13438)' } },
                  shortcutCheck.message,
                )
              : null,
          ),

          /* ---- 全局语音浮层（任意页面常驻，与上面的 composer 语音两条链路） ---- */
          React.createElement(
            Toggle,
            {
              label: t('globalVoice'),
              hint: t('globalVoiceHint'),
              checked: config.globalVoice === true,
              onChange: (v) => set('globalVoice', v),
            },
          ),
          // 全局快捷键单独一行（输入框需要完整宽度）。
          // 聚焦期间把模块级标志置真：两套快捷键（composer/全局）都不触发，
          // 否则用户想改键，反而先把自己的语音打开。
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('globalShortcut')),
            React.createElement('input', {
              value: globalShortcutValue,
              onChange: (event) => set('globalShortcut', event.target.value),
              placeholder: UI_DEFAULTS.globalShortcut,
              onFocus: () => { globalShortcutFieldFocused = true },
              onBlur: () => { globalShortcutFieldFocused = false },
              style: inputStyle,
            }),
            React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, t('globalShortcutHint')),
            !globalShortcutCheck.ok
              ? React.createElement(
                  'span',
                  { style: { fontSize: 12, color: 'var(--dsw-alias-state-danger, #d13438)' } },
                  globalShortcutCheck.message,
                )
              : null,
          ),
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('voicePromptMode')),
            React.createElement(
              'select',
              {
                value: voicePromptModeValue,
                onChange: (event) => set('voicePromptMode', event.target.value),
                style: inputStyle,
              },
              [
                { value: 'queue', label: t('voicePromptModeQueue') },
                { value: 'steer', label: t('voicePromptModeSteer') },
              ].map((item) => React.createElement('option', { key: item.value, value: item.value }, item.label)),
            ),
            React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, t('voicePromptModeHint')),
          ),
          // v3 唤醒词：留空 = 关闭唤醒词（回到「说话直接发送」）。
          // 输入框保留用户原始输入（不逐键 trim），保存时由 normalizeForSave 收敛。
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('wakeWord')),
            React.createElement('input', {
              value: config.wakeWord ?? UI_DEFAULTS.wakeWord,
              maxLength: STRING_LIMITS.wakeWord,
              onChange: (event) => set('wakeWord', event.target.value),
              placeholder: UI_DEFAULTS.wakeWord,
              style: inputStyle,
            }),
            React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, t('wakeWordHint')),
            // 当前生效值便于排查（例如留空时明确告诉用户「唤醒词已关闭」）。
            !wakeWordValue
              ? React.createElement(
                  'span',
                  { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } },
                  t('wakeWordOffNotice'),
                )
              : null,
          ),
        ),

        /* ============ 三、文本处理 ============ */
        React.createElement(
          Section,
          { title: t('secText'), subtitle: t('secTextHint'), collapsible: true },
          React.createElement(
            Toggle,
            {
              label: t('removeFillers'),
              hint: t('removeFillersHint'),
              checked: config.removeFillers === true,
              onChange: (v) => set('removeFillers', v),
            },
          ),
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('words')),
            React.createElement('textarea', {
              // 显示用户原始输入；空格/换行在失焦或保存时才归一化（审计 F1：
              // 旧实现每键 split/trim/filter，键盘根本打不出空格和换行）。
              value: wordsText,
              onChange: (event) => {
                setWordsText(event.target.value)
                setDirty(true)
              },
              onBlur: () => set('words', parseWordsText(wordsText)),
              placeholder: '正确=错误\n专业术语',
              rows: 5,
              style: { ...inputStyle, resize: 'vertical' },
            }),
            React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, t('wordsHint')),
          ),
        ),

        /* ============ 四、语音合成 ============ */
        React.createElement(
          Section,
          { title: t('secSynthesis'), subtitle: t('secSynthesisHint'), collapsible: true },
          // 当前合成方式放在本区顶部（原在模型管理区）：先看到「现在用什么在念」。
          React.createElement(
            'div',
            {
              style: {
                fontSize: 12,
                marginBottom: 10,
                padding: '8px 10px',
                border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
                borderRadius: 8,
                opacity: 0.9,
              },
            },
            `${t('ttsCurrent')}: ${engine === 'sovits'
              ? `GPT-SoVITS (${config.sovitsUrl ?? 'http://127.0.0.1:9880'})`
              : engine === 'neural'
                ? (readyNeural.find((x) => x.id === config.neuralModel)?.label ?? t('neuralNoModel'))
                : engine === 'local'
                  ? (voiceLabel(config.localVoice ?? '') || t('localVoiceDefault'))
                  : (voiceLabel(config.voice ?? '') || (config.voice ?? ''))}`,
          ),
          // 总开关放最前：关掉时整个合成区无意义
          React.createElement(
            Toggle,
            {
              label: t('readAloud'),
              hint: t('readAloudHint'),
              checked: readAloudOn,
              onChange: (v) => set('readAloud', v),
            },
          ),
          readAloudOn
            ? null
            : React.createElement(
                'span',
                { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } },
                t('readAloudOffNotice'),
              ),
          // 非法引擎值（旧配置/手改文件）按 online 处理并明确提示；保存时会被修正。
          engineInvalid
            ? React.createElement(
                'span',
                { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } },
                t('ttsEngineInvalid'),
              )
            : null,
          // 即使朗读关闭也渲染全部合成设置：允许用户预先配置引擎/SoVITS
          // （审计 F17：旧实现整块隐藏，必须先开朗读保存后才能配置）。
          React.createElement(
                React.Fragment,
                null,
                // 「追赶最新」：生成远快于朗读时，最多允许落后屏幕多少秒。
                // 超过就按整段跳到最新内容（宿主 lib/read-aloud-scheduler.js 实现）。
                // 0 = 关闭追赶（全部朗读，长回复会越读越滞后）。
                React.createElement(
                  Label,
                  null,
                  React.createElement('span', null, t('readAloudLag')),
                  React.createElement('input', {
                    type: 'number',
                    min: 0,
                    max: 120,
                    step: 0.5,
                    value: config.readAloudLag ?? UI_DEFAULTS.readAloudLag,
                    onChange: (event) => {
                      // <input type="number"> 在空串/非法内容时给的是 ''，而
                      // `Number('')` 是 0（**不是** NaN）—— 清空输入框或粘贴非法内容
                      // 会把追赶关掉（0 = 全部朗读、越读越滞后）。
                      // 空/非法 → 回退默认 7.5；合法值 clamp 0..120 后按 0.5 秒取整。
                      const raw = String(event.target.value ?? '').trim()
                      const n = Number(raw)
                      const next = raw === '' || !Number.isFinite(n)
                        ? 7.5
                        : Math.max(0, Math.min(120, Math.round(n * 2) / 2))
                      set('readAloudLag', next)
                    },
                    style: inputStyle,
                  }),
                  React.createElement(
                    'span',
                    { style: { fontSize: 12, opacity: 0.7 } },
                    t('readAloudLagHint'),
                  ),
                ),
                React.createElement(
                  Label,
                  null,
                  React.createElement('span', null, t('ttsEngine')),
                  React.createElement(
                    'select',
                    {
                      value: engine,
                      onChange: (event) => {
                        const next = event.target.value
                        set('ttsEngine', next)
                        // 切换引擎后立刻换成对应引擎的音色列表
                        void loadVoices(next)
                      },
                      style: inputStyle,
                    },
                    [
                      ['online', 'Edge 在线（音质好，需联网）'],
                      ['neural', '本地神经模型（离线 · 音质接近在线）'],
                      ['local', localSupported
                        ? '本地系统语音（离线可用，速度快）'
                        : '本地系统语音（当前平台不支持）'],
                      ['sovits', 'GPT-SoVITS 外部服务（用你自己配置好的服务）'],
                    ].map(([v, label]) => React.createElement('option', { key: v, value: v, disabled: v === 'local' && !localSupported }, label)),
                  ),
                  React.createElement(
                    'span',
                    { style: { fontSize: 12, opacity: 0.7 } },
                    t('ttsEngineHint'),
                  ),
                ),

                /* GPT-SoVITS 外部服务：插件只转发文本，不做克隆/模型管理 */
                isSovits
                  ? React.createElement(
                      React.Fragment,
                      null,
                      React.createElement(
                        Label,
                        null,
                        React.createElement('span', null, t('sovitsUrl')),
                        React.createElement('input', {
                          type: 'text',
                          value: config.sovitsUrl ?? UI_DEFAULTS.sovitsUrl,
                          onChange: (event) => set('sovitsUrl', event.target.value),
                          style: inputStyle,
                        }),
                        React.createElement(
                          'span',
                          { style: { fontSize: 12, opacity: 0.7 } },
                          t('sovitsUrlHint'),
                        ),
                      ),
                      React.createElement(
                        Label,
                        null,
                        React.createElement('span', null, t('sovitsRefAudio')),
                        React.createElement('input', {
                          type: 'text',
                          value: config.sovitsRefAudio ?? '',
                          placeholder: '/path/to/reference.wav',
                          onChange: (event) => set('sovitsRefAudio', event.target.value),
                          style: inputStyle,
                        }),
                        React.createElement(
                          'span',
                          { style: { fontSize: 12, opacity: 0.7 } },
                          t('sovitsRefAudioHint'),
                        ),
                      ),
                      React.createElement(
                        Label,
                        null,
                        React.createElement('span', null, t('sovitsPromptText')),
                        React.createElement('input', {
                          type: 'text',
                          value: config.sovitsPromptText ?? '',
                          onChange: (event) => set('sovitsPromptText', event.target.value),
                          style: inputStyle,
                        }),
                        React.createElement(
                          'span',
                          { style: { fontSize: 12, opacity: 0.7 } },
                          t('sovitsPromptTextHint'),
                        ),
                      ),
                      React.createElement(
                        Label,
                        null,
                        React.createElement('span', null, t('sovitsTextLang')),
                        React.createElement(
                          'select',
                          {
                            value: normalizeSovitsLang(config.sovitsTextLang),
                            onChange: (event) => set('sovitsTextLang', event.target.value),
                            style: inputStyle,
                          },
                          SOVITS_LANGS.map((v) => React.createElement('option', { key: v, value: v }, v)),
                        ),
                      ),
                      React.createElement(
                        Label,
                        null,
                        React.createElement('span', null, t('sovitsPromptLang')),
                        React.createElement(
                          'select',
                          {
                            value: normalizeSovitsLang(config.sovitsPromptLang),
                            onChange: (event) => set('sovitsPromptLang', event.target.value),
                            style: inputStyle,
                          },
                          SOVITS_LANGS.map((v) => React.createElement('option', { key: v, value: v }, v)),
                        ),
                      ),
                      React.createElement(
                        'span',
                        { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.5 } },
                        t('sovitsHint'),
                      ),
                    )
                  : null,

                /* 音色：在线用 Edge 音色，神经用模型+说话人，本地用系统语音 */
                isNeural
                  ? React.createElement(
                      React.Fragment,
                      null,
                      React.createElement(
                        Label,
                        null,
                        React.createElement('span', null, t('neuralModel')),
                        React.createElement(
                          'select',
                          {
                            value: readyNeural.length
                              ? (readyNeural.some((m) => m.id === config.neuralModel) ? config.neuralModel : readyNeural[0].id)
                              : '',
                            onChange: (event) => set('neuralModel', event.target.value),
                            style: inputStyle,
                          },
                          readyNeural.length
                            ? readyNeural.map((m) => React.createElement('option', { key: m.id, value: m.id }, m.label))
                            : [React.createElement('option', { key: '__none', value: '' }, t('neuralNoModel'))],
                        ),
                        React.createElement(
                          'span',
                          { style: { fontSize: 12, opacity: 0.7 } },
                          readyNeural.length ? t('neuralReadyModels', { count: readyNeural.length }) : t('neuralNoModelHint'),
                        ),
                        neuralModelMissing
                          ? React.createElement(
                              'span',
                              { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } },
                              t('neuralModelMissingWarning'),
                            )
                          : null,
                      ),
                      (() => {
                        const tier = readyNeural.find((m) => m.id === config.neuralModel) ?? readyNeural[0]
                        // 单说话人模型没有「选说话人」的意义，隐藏（审计 F18）。
                        if (!tier?.speakers || Number(tier.speakers) <= 1) return null
                        return React.createElement(
                          Label,
                          null,
                          React.createElement('span', null, t('neuralSpeaker')),
                          React.createElement(
                            'select',
                            {
                              value: String(Math.min(
                                Math.max(0, Number(config.neuralSpeaker) || 0),
                                Math.max(0, Number(tier.speakers) - 1),
                              )),
                              onChange: (event) => set('neuralSpeaker', Number(event.target.value)),
                              style: inputStyle,
                            },
                            Array.from({ length: tier.speakers }, (_, i) =>
                              React.createElement('option', { key: i, value: String(i) }, '说话人 ' + i),
                            ),
                          ),
                        )
                      })(),
                    )
                  : isSovits
                    ? null
                    : React.createElement(
                      Label,
                      null,
                      React.createElement('span', null, t('voice')),
                      React.createElement(
                        'select',
                        {
                          value: isLocal ? (config.localVoice ?? '') : (config.voice ?? UI_DEFAULTS.voice),
                          onChange: (event) => set(isLocal ? 'localVoice' : 'voice', event.target.value),
                          style: inputStyle,
                        },
                        (voices.length
                          ? voices
                          : [{
                              name: (isLocal ? config.localVoice : config.voice)
                                ?? (isLocal ? '' : UI_DEFAULTS.voice),
                              locale: '',
                              gender: '',
                            }]
                        ).map((v) => React.createElement(
                          'option',
                          { key: v.name, value: v.name },
                          voiceLabel(v.name),
                        )),
                      ),
                      React.createElement(
                        'span',
                        { style: { fontSize: 12, opacity: 0.7 } },
                        t('voiceHint'),
                      ),
                    ),

                /* 短字段并排：语速 + 音调（+音量/格式按引擎条件） */
                React.createElement(
                  Row,
                  null,
                  // 语速：四种引擎都支持
                  React.createElement(
                    Label,
                    null,
                    React.createElement('span', null, t('rate')),
                    React.createElement(
                      'select',
                      {
                        value: rateValue,
                        onChange: (event) => set('rate', event.target.value),
                        style: inputStyle,
                      },
                      withCurrentOption(RATE_OPTIONS, rateValue)
                        .map((v) => React.createElement('option', { key: v, value: v }, v)),
                    ),
                  ),
                  // 音调：只有在线 Edge 支持
                  isOnline
                    ? React.createElement(
                        Label,
                        null,
                        React.createElement('span', null, t('pitch')),
                        React.createElement(
                          'select',
                          {
                            value: pitchValue,
                            onChange: (event) => set('pitch', event.target.value),
                            style: inputStyle,
                          },
                          withCurrentOption(PITCH_OPTIONS, pitchValue)
                            .map((v) => React.createElement('option', { key: v, value: v }, v)),
                        ),
                      )
                    : null,
                  // 音量：神经模型与 GPT-SoVITS 外部服务不支持
                  !isNeural && !isSovits
                    ? React.createElement(
                        Label,
                        null,
                        React.createElement('span', null, t('volume')),
                        React.createElement(
                          'select',
                          {
                            value: volumeValue,
                            onChange: (event) => set('volume', event.target.value),
                            style: inputStyle,
                          },
                          withCurrentOption(VOLUME_OPTIONS, volumeValue)
                            .map((v) => React.createElement('option', { key: v, value: v }, v)),
                        ),
                      )
                    : null,
                  // 音频格式：只有在线 Edge 支持
                  isOnline
                    ? React.createElement(
                        Label,
                        null,
                        React.createElement('span', null, t('ttsFormat')),
                        React.createElement(
                          'select',
                          {
                            value: ttsFormatValue,
                            onChange: (event) => set('ttsFormat', event.target.value),
                            style: inputStyle,
                          },
                          [
                            ['AUDIO_24KHZ_48KBITRATE_MONO_MP3', 'MP3 24kHz/48kbps（推荐，体积小）'],
                            ['AUDIO_24KHZ_96KBITRATE_MONO_MP3', 'MP3 24kHz/96kbps（音质更好）'],
                            // 注意：msedge-tts 的 OUTPUT_FORMAT 里只有上面这两个键。
                            // 之前还有个「48kHz/192kbps」的选项，但 vendor 根本没有这个键，
                            // 选它会被静默回落到 24kHz/48kbps —— 用户以为换了格式，其实没换。
                            // 真要更高音质得改用本地神经引擎。
                          ].map(([v, label]) => React.createElement('option', { key: v, value: v }, label)),
                        ),
                      )
                    : null,
                ),
            ),
        ),

        /* ============ 五、模型与下载 ============ */
        React.createElement(
          Section,
          { title: t('secModels'), subtitle: t('secModelsHint'), collapsible: true },
          // 预加载
          React.createElement(
            Toggle,
            {
              label: t('preloadModels'),
              hint: t('preloadModelsHint'),
              checked: config.preloadModels !== false,
              onChange: (v) => set('preloadModels', v),
            },
          ),
          // 短字段并排：空闲释放 + 环境自检
          React.createElement(
            Row,
            null,
            React.createElement(
              Label,
              null,
              React.createElement('span', null, t('idleReleaseMinutes')),
              React.createElement(
                'select',
                {
                  value: String(idleValue),
                  onChange: (event) => set('idleReleaseMinutes', Number(event.target.value)),
                  style: inputStyle,
                },
                withCurrentOption(
                  IDLE_RELEASE_OPTIONS.map((v) => String(v)),
                  String(idleValue),
                ).map((v) => React.createElement(
                  'option',
                  { key: v, value: v },
                  {
                    0: '永不释放', 5: '5 分钟', 10: '10 分钟', 30: '30 分钟', 60: '1 小时',
                  }[v] ?? `${v} 分钟`,
                )),
              ),
              React.createElement(
                'span',
                { style: { fontSize: 12, opacity: 0.7 } },
                t('idleReleaseMinutesHint'),
              ),
            ),
            React.createElement(
              Label,
              null,
              React.createElement('span', null, t('envCheck')),
              React.createElement(
                'button',
                {
                  type: 'button',
                  onClick: () => void runEnvCheck(),
                  style: {
                    padding: '4px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
                    background: 'transparent',
                    color: 'inherit',
                    fontSize: 12,
                    cursor: 'pointer',
                  },
                },
                checkingEnv ? t('envChecking') : t('envRecheck'),
              ),
            ),
          ),
          envInfo
            ? React.createElement(
                'div',
                { style: { fontSize: 12, opacity: 0.85, marginBottom: 12, lineHeight: 1.7 } },
                React.createElement('div', null, `平台：${envInfo.platform} ${envInfo.arch}`),
                React.createElement('div', null, `显卡：${envInfo.gpu?.available ? envInfo.gpu.name + ' (' + envInfo.gpu.memoryMB + 'MB)' : '未检测到 NVIDIA 显卡'}`),
                // 引擎行：兼容宿主的两种行形状（{available,detail} / 新 sovits 行
                // {supported, url, configured}），字段缺失不崩（审计 F10）。
                ...envEngines.map((e) => React.createElement(
                  'div',
                  { key: e.id, style: { opacity: e.current ? 1 : 0.85 } },
                  `${e.status === 'ok' ? '✓' : e.status === 'bad' ? '✗' : '·'} ${e.label}${e.current ? `（${t('envCurrent')}）` : ''}${e.detail ? '：' + e.detail : ''}`,
                )),
              )
            : null,
          // 模型下载列表（ASR + TTS）
          React.createElement(
            'div',
            { style: { padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))', borderRadius: 8 } },
            ...[
              { key: 'asr', title: t('modelGroupAsr'), list: asrModels },
              { key: 'tts', title: t('modelGroupTts'), list: ttsModels },
            ].map((group) => React.createElement(
              'div',
              { key: group.key, style: { marginBottom: 8 } },
              React.createElement('div', { style: { fontSize: 12, opacity: 0.65, marginBottom: 4 } }, group.title),
              group.list.length
                ? group.list.map((m) => React.createElement(
                    'div',
                    { key: m.id, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 5 } },
                    React.createElement('span', { style: { flex: '1 1 auto' } }, m.label),
                    React.createElement(
                      'span',
                      { style: { opacity: 0.7, minWidth: 62, textAlign: 'right' } },
                      m.ready ? t('neuralReady')
                        : m.downloading
                          ? m.total
                            ? `${t('neuralDownloading')} ${Math.round(((m.received ?? 0) / m.total) * 100)}%`
                            : t('neuralDownloading')
                          : m.ready && m.host ? t('modelBuiltIn')
                            : `${Math.round((m.bytes ?? 0) / 1048576)}MB`,
                    ),
                    // 当前正在用的模型：一眼看出在用哪个。
                    // 合成模型只有在「引擎=神经模型」时才算在用 ——
                    // 用在线/系统语音时，神经模型根本没被调用，不能标成当前使用。
                    (m.category === 'asr' && m.id === config.model)
                      || (m.category === 'tts'
                        && engine === 'neural'
                        && m.id === (readyNeural.some((x) => x.id === config.neuralModel)
                          ? config.neuralModel
                          : readyNeural[0]?.id))
                      ? React.createElement(
                          'span',
                          { style: { fontSize: 11, opacity: 0.75, minWidth: 46, textAlign: 'right' } },
                          t('modelInUse'),
                        )
                      : null,
                    m.ready
                      ? React.createElement('span', { style: { color: 'var(--dsw-alias-state-success, #107c10)', minWidth: 16, textAlign: 'center' } }, '✓')
                      : React.createElement(
                          'button',
                          {
                            type: 'button',
                            disabled: m.downloading,
                            onClick: () => void download(m.id),
                            style: {
                              padding: '3px 9px',
                              borderRadius: 6,
                              border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
                              background: 'transparent',
                              color: 'inherit',
                              fontSize: 12,
                              cursor: m.downloading ? 'default' : 'pointer',
                              opacity: m.downloading ? 0.5 : 1,
                            },
                          },
                          m.downloading ? t('neuralDownloading') : t('neuralDownload'),
                        ),
                  ))
                : React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, '—'),
            )),
            progress
              ? React.createElement(
                  'div',
                  { style: { fontSize: 12, opacity: 0.8, marginTop: 6 } },
                  `${t('neuralDownloading')} ${Math.round(((progress.received ?? 0) / Math.max(1, progress.total ?? 1)) * 100)}%`,
                )
              : null,
          ),
        ),

        /* ============ 六、高级与诊断（默认收起） ============ */
        React.createElement(
          Section,
          { title: t('secAdvanced'), subtitle: t('secAdvancedHint'), collapsible: true, defaultOpen: false },
          /* ---- AI 界面操控与系统级热键（默认都关，属于高级能力） ---- */
          React.createElement(
            Toggle,
            {
              label: t('uiControl'),
              hint: t('uiControlHint'),
              checked: config.uiControl === true,
              onChange: (v) => set('uiControl', v),
            },
          ),
          React.createElement(
            Toggle,
            {
              label: t('uiConfirm'),
              hint: t('uiConfirmHint'),
              checked: config.uiConfirm !== false,
              onChange: (v) => set('uiConfirm', v),
            },
          ),
          React.createElement(
            Toggle,
            {
              label: t('globalHotkeyHelper'),
              hint: t('globalHotkeyHelperHint'),
              checked: config.globalHotkeyHelper === true,
              onChange: (v) => set('globalHotkeyHelper', v),
            },
          ),
          /* ---- 系统级热键只读状态（不提交、不参与保存）---- */
          React.createElement(
            'div',
            {
              style: {
                fontSize: 12,
                opacity: 0.85,
                lineHeight: 1.7,
                marginTop: 10,
                marginBottom: 12,
                padding: '8px 10px',
                border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
                borderRadius: 8,
              },
            },
            React.createElement('div', { style: { fontWeight: 600, marginBottom: 2 } }, t('hotkeyStatusTitle')),
            React.createElement('div', null, `${t('hotkeyStatusLabel')}：${hotkeyStatusText}`),
            React.createElement('div', null, `${t('hotkeyStatusPlatform')}：${hotkeyPlatformText}`),
            hotkeyStatusReasonText
              ? React.createElement('div', { style: { opacity: 0.8 } }, `${t('hotkeyStatusReason')}：${hotkeyStatusReasonText}`)
              : null,
            hotkeyNeedsOverlay
              ? React.createElement(
                  'div',
                  { style: { color: 'var(--dsw-alias-state-warning, #9a6700)', marginTop: 2 } },
                  t('hotkeyStatusNeedsOverlay'),
                )
              : null,
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: () => void loadHotkeyStatus(),
                style: {
                  marginTop: 4,
                  padding: '3px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                },
              },
              t('hotkeyStatusRefresh'),
            ),
          ),
          React.createElement(
            'div',
            { style: { fontSize: 12, opacity: 0.8, lineHeight: 1.7 } },
            React.createElement('div', { style: { fontWeight: 600, marginBottom: 2 } }, t('advancedDiagnostics')),
            React.createElement('div', null, t('advancedDiagnosticsHint')),
          ),
          React.createElement(
            'div',
            { style: { fontSize: 12, opacity: 0.8, lineHeight: 1.7, marginTop: 8 } },
            React.createElement('div', { style: { fontWeight: 600, marginBottom: 2 } }, t('advancedDebug')),
            React.createElement('div', null, t('advancedDebugHint')),
          ),
        ),

        /* ============ 保存栏 ============ */
        React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: () => void save(),
                // 加载完成前禁止保存：此时表单里还是默认值，
                // 一点保存就会把用户已有的设置（比如「朗读回复」）覆盖掉。
                // 快捷键非法时也禁止保存（旧实现只显示红字，保存后热键静默失效）。
                disabled: saveDisabled,
                style: {
                  padding: '7px 16px',
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: 13,
                  cursor: saveDisabled ? 'default' : 'pointer',
                  opacity: saveDisabled ? 0.5 : 1,
                },
              },
              t('save'),
            ),
            // 加载失败：不放开保存（否则旧快照会覆盖服务端配置），给重试按钮。
            loadError
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    onClick: () => { setLoadError(''); void reload() },
                    style: {
                      padding: '5px 12px',
                      borderRadius: 8,
                      border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
                      background: 'transparent',
                      color: 'inherit',
                      fontSize: 12,
                      cursor: 'pointer',
                    },
                  },
                  t('retry'),
                )
              : null,
            !loaded
              ? React.createElement('span', { style: { fontSize: 12, opacity: 0.75 } }, loadError || t('loadingConfig'))
              : dirty
                ? React.createElement('span', { style: { fontSize: 12, opacity: 0.75 } }, t('unsaved'))
                : null,
            status ? React.createElement('span', { style: { fontSize: 12, opacity: 0.75 } }, status) : null,
          ),
          // POST /config 校验失败的可读错误（宿主返回 400 {errors:[{key,reason}]}）。
          saveErrors.length
            ? React.createElement(
                'div',
                { style: { fontSize: 12, color: 'var(--dsw-alias-state-danger, #d13438)', lineHeight: 1.6 } },
                ...saveErrors.map((message, index) => React.createElement('div', { key: index }, message)),
              )
            : null,
        ),
      )
    }

    /** 浏览器半侧入口。 */
    function apply(ctx) {
      // 槽位组件拿不到 ctx：全局浮层需要 sessions/uiWorkspace/layout 这些服务，
      // 在这里留存模块级引用（读取时统一走 clientService，失败可降级）。
      pluginCtx = ctx
      // 专用 inject 只用来**捕获** sessions 服务（不注册任何东西）：
      // 有的 DSH 版本客户端 ctx 上不直接挂 sessions，只有注入作用域里才有；
      // 解析失败/服务不存在时什么都不发生，绝不影响下面的 slots/locale 注册
      //（exports.inject 保持 ['slots','locale']，缺 sessions 也不能丢麦克风/设置/浮层）。
      try {
        ctx.inject(['sessions'], (scope) => {
          capturedSessionsService = scope?.sessions ?? null
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
      matchesShortcut,
      pickMainViewSessionId,
      // ---- 当前会话解析 / 持久化（task-8；test/global-voice.test.mjs 覆盖） ----
      LAST_SESSION_KEY,
      pickSessionId,
      findMainViewSessionId,
      // ---- UI 动作协议（与宿主同构，test/ui-action-protocol.test.mjs 做双端一致性） ----
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
      normalizeWakeWord,
      WAKE_ACTIVE_MS,
      WAKE_HINT_MS,
      // ---- 快捷键平台别名（macOS 默认组合，test/global-voice.test.mjs 覆盖） ----
      effectiveShortcut,
      // ---- 客户端服务取值（test/client-service-order.test.mjs 覆盖） ----
      // 必须导出：这里曾经因为「先读 ctx[name] 抛错被 catch 吞掉」导致
      // toggle_sidebar/switch_session 一律 unsupported，回归测试要钉住取值顺序。
      clientService,
    }
    return module.exports
  },
})
