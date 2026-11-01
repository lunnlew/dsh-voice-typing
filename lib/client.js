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
      wordsHint: '一行一条：写「正确=错误」把错词换成对词，例如「深度求索=深度球搜」；只写「正确」则作为热词提示。',
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
      secSynthesis: '语音合成',
      secModels: '模型管理',
      secInteraction: '交互与后处理',
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
      wordsHint: 'One per line: "correct=wrong" replaces the wrong word, e.g. "深度求索=深度球搜"; a bare "correct" works as a hotword hint.',
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
      secSynthesis: 'Speech synthesis',
      secModels: 'Models',
      secInteraction: 'Interaction & post-processing',
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
      if (key.length === 1 && /[a-z]/.test(key)) return { ok: false, message: '别用单个字母，否则打字会误触发' };
      if (key === ' ') return { ok: false, message: '空格键写成 Space' };
      if (text.toLowerCase() === 'ctrl+shift+v') return { ok: false, message: 'Ctrl+Shift+V 是浏览器的「粘贴为纯文本」' };
      return { ok: true, message: '' };
    }

    /**
     * 全局共享的配置存储。
     * 设置面板与麦克风按钮是两个独立组件、各自持一份 config，
     * 保存后不互通就会导致「改了要刷新页面才生效」。这里用共享存储打通。
     */


    /**
     * 门限状态机（纯函数）。
     *
     * 宿主侧（/asr-stream）与浏览器侧（VAD）用**同一套算法**，
     * 由同一份用例表（test/fixtures/gate-cases.mjs）驱动，
     * 防止「同一判据两处实现」分叉。
     *
     * 分叉过的后果很具体：宿主侧曾把真实语音的低音量帧
     * （rms 0.0255 / 0.0308）挡在解码器外面，
     * 流式只认出「你好明天天怎」，整段非流式却能认出「你好，今天天气怎么样？」。
     */

    /**
     * 推进门限状态机。
     *
     * 语义：
     *   底噪**只在不在说话中时**更新 —— 否则说话时底噪被语音自己抬高，
     *   门限跟着涨，越说越容易被判成静音。
     *   进入说话态后，单帧偏低不退出（汉语轻声、句尾下降音天然偏低）；
     *   连续若干帧都低才退出。
     *
     * 纯函数：不修改传入的 state，返回新的 state。
     *
     * @param {object} state - {noiseFloor, inSpeech, silentFrames}。
     * @param {number} level - 本帧 RMS。
     * @param {object} opts - {minGate, maxGate, multiplier, offset, silentFramesToEnd}。
     * @returns {{feed: boolean, speech: boolean, gate: number, state: object}} 本帧的判定与新状态。
     */
    function advanceGate(state, level, opts) {
      const prev = state || { noiseFloor: 0.004, inSpeech: false, silentFrames: 0 }
      const minGate = opts?.minGate ?? 0.008
      const maxGate = opts?.maxGate ?? 0.035
      const multiplier = opts?.multiplier ?? 2.5
      const offset = opts?.offset ?? 0.003
      const silentFramesToEnd = opts?.silentFramesToEnd ?? 1

      // 1) 底噪只在不在说话中时更新
      const noiseFloor = prev.inSpeech
        ? prev.noiseFloor
        : prev.noiseFloor * 0.95 + level * 0.05

      // 2) 门限
      const gate = Math.min(Math.max(minGate, noiseFloor * multiplier + offset), maxGate)

      // 3) 说话态推进
      let inSpeech = prev.inSpeech
      let silentFrames = prev.silentFrames
      let feed = false
      if (inSpeech) {
        if (level < gate) silentFrames += 1
        else silentFrames = 0
        if (silentFrames >= silentFramesToEnd) {
          inSpeech = false
          silentFrames = 0
        }
        // 说话中一律喂 —— 包括「退出说话态」的那一帧。
        // 那一帧是「刚说完」的那一下，喂给解码器它才能定句。
        feed = true
      } else if (level < gate) {
        feed = false
        silentFrames = 0
      } else {
        inSpeech = true
        silentFrames = 0
        feed = true
      }
      return {
        feed,
        // 与 feed 恒等：说话段内的帧一律算语音。
        speech: feed,
        gate,
        state: { noiseFloor, inSpeech, silentFrames },
      }
    }



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
     * 检测用户是否手动改过草稿，并据此重设基准。
     *
     * **必须在写入新内容之前调用**：
     * 放进合并逻辑里的话，一旦判定为「用户改过」，
     * 就会把刚识别到的新内容也清掉 ——
     * 用户删掉一段之后，接下来识别到的句子会凭空消失。
     *
     * @param {object} parts - {base, committed, current, ours}。
     * @returns {{base: string, committed: string, edited: boolean}} 同步结果。
     */
    function syncUserEdit(parts) {
      const current = String(parts?.current ?? '').trim()
      const ours = String(parts?.ours ?? '').trim()
      // ours 为空说明我们还没写过任何东西，此时不该判定为「用户改过」
      // （输入框里本来就只有用户自己输入的内容）。
      const edited = ours !== '' && current !== ours
      if (!edited) {
        return {
          base: String(parts?.base ?? '').trim(),
          committed: String(parts?.committed ?? '').trim(),
          edited: false,
        }
      }
      // 用户改过时，current 里已经包含他们想保留的一切（含之前各段），
      // 所以把基准换成它、旧记录清空是等价的，不会丢内容。
      return { base: current, committed: '', edited: true }
    }

    /**
     * 合并草稿的三个部分。
     *
     * 只做拼接，不做任何判断 —— 判断在 syncUserEdit() 里，
     * 且必须在写入新内容之前完成。
     *
     * @param {object} parts - {base, committed, segment}。
     * @returns {{base: string, committed: string, segment: string, out: string}} 合并结果。
     */
    function mergeDraft(parts) {
      const base = String(parts?.base ?? '').trim()
      const committed = String(parts?.committed ?? '').trim()
      const segment = String(parts?.segment ?? '').trim()
      const out = [base, committed, segment].filter(Boolean).join(' ')
      return { base, committed, segment, out }
    }


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


    /**
     * SSE 事件信封与定时器登记（纯函数 / 无浏览器 API 依赖）。
     *
     * 这些文件被 `scripts/bundle-client.mjs` 内联进 lib/client.js，
     * 同时也可以被 Node 里的测试**原生 import**（不需要「从大文件里提取源码再求值」）。
     */

    /**
     * 解析 SSE 事件信封。
     *
     * 协议 v3：所有事件的 data 都是同一个信封
     *   { v: 3, seq, ts, sessionId, ...payload }
     *
     * 统一信封的好处：
     *   - 客户端能靠 seq 发现丢事件（重连后 seq 跳变）；
     *   - sessionId 让多会话不会串音（客户端只处理自己会话的事件）；
     *   - 业务字段直接放在信封里，不用再包一层。
     *
     * @param {object} event - EventSource 的事件对象（只需要 data）。
     * @returns {object|null} 信封；解析失败返回 null。
     */
    function parseEnvelope(event) {
      try {
        const raw = JSON.parse(event.data)
        if (!raw || typeof raw !== 'object') return null
        return raw
      } catch {
        return null
      }
    }

    /**
     * 判断一个事件是不是属于当前会话。
     *
     * sessionId 为 null 的事件是全局事件（模型下载进度之类），
     * 任何会话都要处理。
     *
     * @param {object} envelope - 事件信封。
     * @param {string} currentSessionId - 当前会话 id。
     * @returns {boolean} 是否属于当前会话。
     */
    function belongsToSession(envelope, currentSessionId) {
      if (!envelope) return false
      const sid = envelope.sessionId
      if (!sid) return true
      if (!currentSessionId) return true
      return sid === currentSessionId
    }

    /**
     * 定时器登记表。
     *
     * 为什么要有它：这个插件里「停麦之后还留着定时器」造成过严重故障 ——
     * 「助手忙完后自动发送」的定时器之前只在组件卸载时被清，
     * 于是用户关掉麦克风后它照样在 400 毫秒后触发，把草稿自动发了出去。
     *
     * 定时器句柄分散在各自的 ref 里，各自清理、各自可能漏。
     * 登记到一张表之后：
     *   - 状态复位时按 group 一次清干净；
     *   - 卸载时 clearAll() 兜底；
     *   - 漏登记的定时器能被静态检查抓到（源码里不该再有裸的
     *     window.setTimeout / window.setInterval）。
     *
     * @param {object} win - 提供 setTimeout/setInterval/clearTimeout/clearInterval 的对象。
     * @returns {object} 登记表。
     */
    function createTimerRegistry(win) {
      const timers = new Map()
      const clearOne = (id) => {
        const t = timers.get(id)
        if (!t) return
        if (t.kind === 'interval') win.clearInterval(t.handle)
        else win.clearTimeout(t.handle)
        timers.delete(id)
      }
      return {
        /** 登记一个重复定时器；同名会先清掉旧的。 */
        interval(id, fn, ms, group) {
          clearOne(id)
          const handle = win.setInterval(fn, ms)
          timers.set(id, { handle, kind: 'interval', group })
          return handle
        },
        /** 登记一个一次性定时器；同名会先清掉旧的。 */
        timeout(id, fn, ms, group) {
          clearOne(id)
          const handle = win.setTimeout(fn, ms)
          timers.set(id, { handle, kind: 'timeout', group })
          return handle
        },
        /** 清掉一个。 */
        clear(id) { clearOne(id) },
        /** 清掉某一组（状态复位时用）。 */
        clearGroup(group) {
          for (const [id, t] of [...timers]) if (t.group === group) clearOne(id)
        },
        /** 全清（卸载时兜底）。 */
        clearAll() { for (const id of [...timers.keys()]) clearOne(id) },
        /** 当前登记了多少个（诊断用）。 */
        size() { return timers.size },
        /** 已登记的 id 列表（诊断用）。 */
        ids() { return [...timers.keys()] },
      }
    }

    /**
     * 短时等待。
     *
     * 唯一的例外：它不登记到定时器表 ——
     * 它必定结束、不会跨状态残留，登记反而是负担。
     * 所有**跨状态存活**的定时器都必须走登记表。
     *
     * @param {object} win - 提供 setTimeout 的对象。
     * @param {number} ms - 毫秒。
     * @returns {Promise<void>} 等待结束。
     */
    function sleep(win, ms) {
      return new Promise((resolve) => win.setTimeout(resolve, ms))
    }



    /**
     * 朗读积压裁剪（依赖无关、可独立测试的模块）。
     *
     * 背景（2026-11-01 修订）：
     *   旧实现按「丢最旧的非首句」裁剪，看着像「贴着最新内容」，实际上丢掉的
     *   正是**接下来马上要播的那几句** —— 用户听到的是「首句 → 直接跳到最新
     *   内容」，落点常常在某段中间，正是「挑到最新段落中非首句的句子」这个听感；
     *   如果后续又插进旧段落（宿主重复发/换轮迟到），还会「读完后面又读前面」。
     *
     *   现在宿主改成了**流控**（已发未确认句数 <= READ_ALOUD_LEAD，客户端每开始
     *   播一句回一条 reading-ack），生成快于播放时句子不再涌进客户端队列 ——
     *   正常情况下这里根本不会被调用。它退化成**安全网**（老宿主、ack 丢失、
     *   重连、宿主降级回 400ms 时间窗口）。
     *
     *   安全网也必须守住「段落完整性」与「追赶最新」两个方向：
     *     - 按 `para`（宿主给的自然段序号）**整段**丢弃；
     *     - 保护「含本轮首句(index===0)的段落」、「正在播放的段落」、以及
     *       **最新的一组（最后一个 group）** —— 绝不能为了压到上限把最新段丢掉，
     *       那正好和「追赶最新」相反（评审 P2）；
     *     - 只从**最旧**的未保护组开始丢；若丢完仍超上限（剩下的全是受保护组），
     *       接受**软上限**：宁可暂时多留几句，也不丢正在读的段或最新段；
     *     - 绝不允许「保留段尾、丢掉段首」—— 那还是会从段落中间开始播；
     *     - `para < 0`（老宿主没给）时退化成「每句各成一段」，仍然能裁剪。
     *
     * 注意：这里**不是**严格意义「不修改入参」的纯函数 ——
     * 它原地裁剪调用方自己的数组（朗读队列是 `pumpQueue` 内的局部数组，
     * 换新引用会让主循环/后台任务读到旧引用，风险大于收益）。
     * 它仍然是**依赖无关、无 IO、可被测试原生 import 跑场景**的单元。
     */

    /**
     * 裁剪待播句子，只留最新的若干句（**以段落为最小单位**）。
     *
     * 语义要点：
     *   - 受保护的组不丢：含本轮首句(index===0)的组、正在播放的组、**最新一组**；
     *   - 只从最旧的可丢组开始整段丢（追赶最新方向）；
     *   - 丢不动了就接受**软上限**：返回的 `dropped` 可能不足以把总数压到 `max`，
     *     调用方不要把它当成「一定 ≤ max」。
     *
     * @param {Array<{index: number, para?: number}>} inflight - 正在合成的句子
     *   （按播放顺序在前；FIFO，旧的在前）。
     * @param {Array<{index: number, para?: number}>} queue - 还没开始合成的句子
     *   （FIFO，更新的在后）。两者拼起来就是全局待播顺序。
     * @param {number} max - 待播上限（句）。
     * @param {{playingPara?: number|null}} [options] - `playingPara`：正在播放的
     *   段落序号；整段保护，避免只播了段首、剩下的被裁掉。
     * @returns {{inflight: Array, queue: Array, dropped: number, droppedItems: Array}}
     *   裁剪后的两个队列、**被丢掉的句数**，以及**被丢掉的那些队列项**
     *   （调用方要按句子自己的 sessionId/turnId 回执，把宿主配额还回去）。
     */
    function trimBacklog(inflight, queue, max, options = {}) {
      const a = inflight ?? []
      const b = queue ?? []
      const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 1
      const playingPara = Number.isInteger(options?.playingPara) && options.playingPara >= 0
        ? options.playingPara
        : null
      if (a.length + b.length <= limit) return { inflight: a, queue: b, dropped: 0, droppedItems: [] }

      // 1) 按播放顺序拼起来，再聚成「整段」。
      //    para < 0 的项无法判断属于哪一段 —— 每句各成一组：
      //    既不会把老客户端的句子并成一大段（那样会丢得过多），也不会让裁剪失效。
      const groups = []
      for (const item of [...a, ...b]) {
        const para = Number.isInteger(item?.para) && item.para >= 0 ? item.para : -1
        const last = groups[groups.length - 1]
        if (para >= 0 && last && last.para === para) {
          last.items.push(item)
          continue
        }
        groups.push({ para, items: [item] })
      }

      // 2) 保护三类组：
      //    - 含本轮首句（index===0）的组：开头不能缺；
      //    - 正在播放的段落（playingPara）：不能只留半段；
      //    - **最后一组（最新内容）**：安全网绝不能为了压到上限而丢掉最新段 ——
      //      那与「追赶最新」正好相反（评审 P2：受保护组超上限时会丢最新段）。
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i]
        group.protected =
          i === groups.length - 1 ||
          group.items.some((item) => item?.index === 0) ||
          (group.para >= 0 && group.para === playingPara)
      }

      // 3) 从**最旧**的组开始整段丢，直到降到上限；受保护的组整段跳过。
      //    若丢完所有可丢组仍然超上限（剩下的全是受保护组），接受**软上限**：
      //    宁可暂时多留几句，也不为了压数字去丢正在读的段或最新段。
      const toDrop = new Set()
      const droppedItems = []
      let total = a.length + b.length
      let dropped = 0
      for (const group of groups) {
        if (total <= limit) break
        if (group.protected) continue
        for (const item of group.items) {
          toDrop.add(item)
          droppedItems.push(item)
          total -= 1
          dropped += 1
        }
      }

      // 4) 原地删除（保持数组引用不变：调用方持有这两个数组）。
      if (dropped > 0) {
        const removeDropped = (arr) => {
          let write = 0
          for (let read = 0; read < arr.length; read++) {
            if (toDrop.has(arr[read])) continue
            arr[write++] = arr[read]
          }
          arr.length = write
        }
        removeDropped(a)
        removeDropped(b)
      }

      return { inflight: a, queue: b, dropped, droppedItems }
    }



    /**
     * 朗读高亮的纯匹配逻辑（依赖无关、可独立测试）。
     *
     * 背景：
     *   朗读时宿主广播的 `sentence { text, turnId, index }` 里，`text` 是
     *   `stripForSpeech()` 的产物 —— **纯文本**（markdown 已剥离、SSML 已转义）。
     *   屏幕上渲染的是带格式的 markdown DOM。要在消息里把「正在朗读的一句」
     *   圈出来，必须把纯文本 `text` 对齐到渲染后的 DOM 文本上。
     *
     *   这个文件只做**字符串层面的对齐**：把「若干个文本节点的原文」拼成
     *   一个归一化字符串，找到目标句的位置，再映射回「每个节点里的原始区间」。
     *   真正的 DOM 操作（splitText / Range / 覆盖层）在 main.js 里做 ——
     *   纯函数无法碰 DOM，但可以被 Node 测试原生 import。
     *
     * 为什么归一化：
     *   - DOM 文本里可能有 `\u00a0`、软换行、HTML 实体还原后的连续空白；
     *   - 宿主广播的句子是折叠过空白的（stripForSpeech 里 `[ \t]+`→` `）。
     *   两者不逐字相等，所以匹配前都要把「空白串」折叠成单个空格。
     */

    /**
     * 反转 stripForSpeech 的 SSML 转义。
     *
     * 宿主把 `&`→`&amp;`、`<`→`&lt;`（Edge TTS 的 SSML 模板需要合法 XML），
     * 所以 `sentence.text` 里出现的是 `&amp;` / `&lt;`。
     * 而 DOM 里渲染出来的是 `&` / `<`。匹配前必须还原，否则永远匹配不上。
     *
     * @param {string} text - 宿主广播的句子文本（可能已 SSML 转义）。
     * @returns {string} 还原后的纯文本。
     */
    function unescapeSpeechText(text) {
      return String(text ?? '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
    }

    /**
     * 把一个文本节点的原文归一化：空白串（含 `\u00a0`）折叠成单个空格。
     *
     * 返回的 `map` 让「归一化字符下标」能映射回「原文区间」：
     *   map[i] = { start, len } —— 归一化第 i 个字符对应原文 [start, start+len)。
     * 折叠的空白串被当作**一个**空格字符，其 len 覆盖整段空白，
     * 于是匹配时能整段圈住，不会只圈到空白的一半。
     *
     * @param {string} raw - 一个文本节点的原始内容。
     * @returns {{ text: string, map: Array<{start: number, len: number}> }}
     */
    function normalizeRun(raw) {
      const s = String(raw ?? '')
      const chars = []
      const map = []
      let i = 0
      while (i < s.length) {
        const ch = s[i]
        if (/\s/.test(ch) || ch === '\u00a0') {
          let j = i
          while (j < s.length && (/\s/.test(s[j]) || s[j] === '\u00a0')) j++
          // 折叠空白串 → 一个空格；紧挨着已有的空格就不再重复加。
          // （避免「原文行尾空格 + 下一节点行首空格」拼成两个空格，
          //   与宿主的「折叠后仍是一个空格」不一致。）
          if (chars.length === 0 || chars[chars.length - 1] !== ' ') {
            chars.push(' ')
            map.push({ start: i, len: j - i })
          }
          i = j
        } else {
          chars.push(ch)
          map.push({ start: i, len: 1 })
          i++
        }
      }
      return { text: chars.join(''), map }
    }

    /**
     * 折叠目标字符串的空白（用于与归一化后的节点文本比较）。
     *
     * 宿主广播的句子已 `trim()` 过，且空白已折叠成单个空格；
     * 这里再做一次幂等折叠，作为防御。
     *
     * @param {string} text - 目标句。
     * @returns {string} 折叠后的目标。
     */
    function collapseWhitespace(text) {
      return String(text ?? '').replace(/[ \t\r\n\u00a0]+/g, ' ').trim()
    }

    /**
     * 在多个文本节点的原文里定位目标句。
     *
     * 把 `nodeTexts` 依次拼成一个归一化字符串，找出目标（同样归一化）的位置，
     * 再映射回**每个节点内部的原始区间**。返回 `null` 表示整句都匹配不上
     * （跨块/跨节点导致的错位，调用方应降级为整段高亮）。
     *
     * @param {string[]} nodeTexts - 有序的文本节点原文（按文档顺序）。
     * @param {string} target - 要定位的句子（宿主的 `sentence.text`，未还原也可，
     *   内部会先 unescapeSpeechText + collapseWhitespace）。
     * @returns {Array<{nodeIndex: number, start: number, end: number}>|null}
     *   每个要高亮的节点区间；整句无命中返回 null。
     */
    function matchInNodes(nodeTexts, target) {
      if (!Array.isArray(nodeTexts) || nodeTexts.length === 0) return null
      const targetNorm = collapseWhitespace(unescapeSpeechText(target))
      if (!targetNorm) return null

      // 拼归一化字符串 + 记录每个归一化字符落在哪个节点的哪个原文区间。
      const normChars = []
      const normMap = [] // 每个归一化字符 -> { nodeIndex, start, len }
      for (let n = 0; n < nodeTexts.length; n++) {
        const { text, map } = normalizeRun(nodeTexts[n])
        for (let k = 0; k < text.length; k++) {
          normChars.push(text[k])
          normMap.push({ nodeIndex: n, start: map[k].start, len: map[k].len })
        }
      }
      const normalized = normChars.join('')
      const idx = normalized.indexOf(targetNorm)
      if (idx < 0) return null
      const last = idx + targetNorm.length - 1
      if (last >= normMap.length) return null

      const firstCell = normMap[idx]
      const lastCell = normMap[last]
      // 逐节点收集 [start, end)。
      const ranges = []
      for (let n = firstCell.nodeIndex; n <= lastCell.nodeIndex; n++) {
        const nodeRaw = nodeTexts[n]
        let start = 0
        let end = nodeRaw.length
        if (n === firstCell.nodeIndex) start = firstCell.start
        if (n === lastCell.nodeIndex) end = lastCell.start + lastCell.len
        // 跨多个节点时，中间节点整个覆盖；两端按命中边界截。
        ranges.push({ nodeIndex: n, start, end })
      }
      return ranges
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
          const parts = combo.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean)
          if (!parts.length) return false
          const key = parts[parts.length - 1]
          if (event.key?.toLowerCase() !== key) return false
          if (parts.includes('ctrl') !== !!event.ctrlKey) return false
          if (parts.includes('shift') !== !!event.shiftKey) return false
          if (parts.includes('alt') !== !!event.altKey) return false
          if (parts.includes('meta') !== !!event.metaKey) return false
          return true
        }
        const down = (event) => {
          // 设置面板里正在编辑快捷键时，不要触发
          if (shortcutFieldFocused) return
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
        button,
        stopSpeakingButton,
        singleText
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
     * 分组标题。
     * 设置项按「识别 / 合成 / 交互 / 高级」分组，
     * 否则二十多个选项平铺在一起根本分不清谁管什么。
     */
    const Section = (props) => React.createElement(
      'div',
      { style: { marginBottom: 18 } },
      React.createElement(
        'div',
        {
          style: {
            fontSize: 12,
            fontWeight: 600,
            opacity: 0.65,
            letterSpacing: '0.04em',
            marginBottom: 10,
            paddingBottom: 5,
            borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08))',
          },
        },
        props.title,
      ),
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
      const [progress, setProgress] = useState(null)

      const set = (key, value) => {
        setConfig((prev) => ({ ...prev, [key]: value }))
        setDirty(true)
      }

      /**
       * 按引擎加载音色列表。
       * 必须跟随当前引擎：之前写死 engine=online，
       * 导致选了本地引擎后，下拉里还是 Edge 的音色列表。
       * @param {string} engine - online / local。
       */
      const loadVoices = useCallback(async (engine) => {
        // GPT-SoVITS 的音色/参考音频都在用户自己的服务端配置，插件没有音色列表可加载。
        if (engine === 'sovits') return
        const target = engine === 'local' ? 'local' : 'online'
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

      const reload = useCallback(async () => {
        try {
          const resp = await fetch(`${BASE}/config`)
          if (!resp.ok) return
          const data = await resp.json()
          // **有未保存改动时不要覆盖表单。**
          //
          // reload() 会在多个时机被调用：挂载、模型下载完成（model-ready）、
          // 换引擎换音色……用户正在改设置时它一跑，改动就被冲掉了，
          // 而且 setDirty(false) 还会让界面显示「没有未保存的改动」——
          // 用户以为自己改的东西还在，其实已经没了。
          //
          // 共享存储照常更新（那是服务端的权威值），
          // 但**表单**只在没有本地改动时才跟着刷新。
          if (!dirtyRef.current) setConfig((prev) => ({ ...prev, ...data }))
          // 同步回共享存储：设置面板与麦克风按钮读的是同一份配置。
          configStore.set(data)
          // 标记「共享存储已是真实配置」：
          // 麦克风按钮那份挂载时的 fetch 回来后就不该再覆盖它。
          configStore.loaded = true
          setDirty(false)
          setLoaded(true)
          // 音色列表跟随当前引擎加载
          void loadVoices(data.ttsEngine ?? 'online')
        } catch {
          // 加载失败时放开保存：此时保存请求同样会失败（连不上宿主），
          // 不会真的写坏配置；但也不能一直卡住不让用户操作。
          setLoaded(true)
          setStatus(t('configLoadFailed'))
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
        try {
          // 整体提交，不要逐个列字段：
          // 之前是手写字段列表，每加一个配置项就会漏掉
          // （ttsEngine / localVoice / pitch / volume / ttsFormat 都曾漏掉，
          //  导致在界面切换了引擎但保存的仍是旧值）。
          const resp = await fetch(`${BASE}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(config),
          })
          if (resp.ok) {
            setDirty(false)
            setStatus(t('saved'))
            // 同步到共享配置：麦克风按钮立刻用新参数，不用刷新页面。
            configStore.set(config)
            configStore.loaded = true
            // 以服务端返回的生效配置为准回填，避免界面与实际不一致
            try {
              const data = await resp.json().catch(() => null)
              if (data?.config) {
                setConfig((prev) => ({ ...prev, ...data.config }))
                configStore.set(data.config)
              }
            } catch { /* 忽略 */ }
          }
        } catch {
          /* 忽略 */
        }
      }, [config, t])

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

      // 当前引擎：决定哪些参数有意义
      const engine = config.ttsEngine ?? 'online'
      const isOnline = engine === 'online'
      const isNeural = engine === 'neural'
      const isLocal = engine === 'local'
      const isSovits = engine === 'sovits'
      /** GPT-SoVITS 官方 api_v2 支持的合成/参考语言。 */
      const SOVITS_LANGS = ['zh', 'en', 'ja', 'ko', 'yue']
      const readAloudOn = config.readAloud === true

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 2px' } },

        /* ============ 一、语音识别 ============ */
        React.createElement(
          Section,
          { title: t('secRecognition') },
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('model')),
            React.createElement(
              'select',
              {
                value: config.model,
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
                value: config.language,
                onChange: (event) => set('language', event.target.value),
                style: inputStyle,
              },
              ['auto', 'zh', 'en', 'yue', 'ja', 'ko'].map((lang) =>
                React.createElement('option', { key: lang, value: lang }, languageLabel(lang)),
              ),
            ),
          ),
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('mode')),
            React.createElement(
              'select',
              {
                value: config.mode,
                onChange: (event) => set('mode', event.target.value),
                style: inputStyle,
              },
              [
                { value: 'toggle', label: t('modeToggle') },
                { value: 'once', label: t('modeOnce') },
              ].map((item) => React.createElement('option', { key: item.value, value: item.value }, item.label)),
            ),
            React.createElement(
              'span',
              { style: { fontSize: 12, opacity: 0.7 } },
              t('modeHint'),
            ),
          ),
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

          /* 实时字方式：整段重识别 vs 流式解码 */
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('liveAsr')),
            React.createElement(
              'select',
              {
                value: String(config.liveAsr ?? 'full'),
                onChange: (event) => set('liveAsr', event.target.value),
                style: inputStyle,
              },
              [
                ['full', t('liveAsrFull')],
                ['stream', t('liveAsrStream')],
                ['auto', t('liveAsrAuto')],
              ].map(([v, label]) => React.createElement('option', { key: v, value: v }, label)),
            ),
            React.createElement(
              'span',
              { style: { fontSize: 12, opacity: 0.7 } },
              t('liveAsrHint'),
            ),
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
          // 只有自动发送打开时，「发送前等待」才有意义
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
                    value: config.autoSendExtraMs ?? 1200,
                    onChange: (event) => set('autoSendExtraMs', Math.max(0, Math.min(5000, Number(event.target.value) || 0))),
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

        /* ============ 二、语音合成 ============ */
        React.createElement(
          Section,
          { title: t('secSynthesis') },
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
            ? React.createElement(
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
                    value: config.readAloudLag ?? 7.5,
                    onChange: (event) => {
                      // <input type="number"> 在空串/非法内容时给的是 ''，而
                      // `Number('')` 是 0（**不是** NaN）—— 以前清空输入框或粘贴
                      // 非法内容会把追赶关掉（0 = 全部朗读、越读越滞后），
                      // `: 15` 兜底几乎走不到（评审 P3）。
                      // 现在：空/非法 → 回退默认 7.5；合法值 clamp 0..120 后按 0.5 秒取整。
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
                          value: config.sovitsUrl ?? 'http://127.0.0.1:9880',
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
                            value: config.sovitsTextLang ?? 'zh',
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
                            value: config.sovitsPromptLang ?? 'zh',
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
                      ),
                      (() => {
                        const tier = readyNeural.find((m) => m.id === config.neuralModel) ?? readyNeural[0]
                        if (!tier?.speakers) return null
                        return React.createElement(
                          Label,
                          null,
                          React.createElement('span', null, t('neuralSpeaker')),
                          React.createElement(
                            'select',
                            {
                              value: String(config.neuralSpeaker ?? 0),
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
                          value: isLocal ? (config.localVoice ?? '') : (config.voice ?? 'zh-CN-XiaoxiaoNeural'),
                          onChange: (event) => set(isLocal ? 'localVoice' : 'voice', event.target.value),
                          style: inputStyle,
                        },
                        (voices.length
                          ? voices
                          : [{ name: (isLocal ? config.localVoice : config.voice) ?? '', locale: '', gender: '' }]
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

                /* 语速：三个引擎都支持 */
                React.createElement(
                  Label,
                  null,
                  React.createElement('span', null, t('rate')),
                  React.createElement(
                    'select',
                    {
                      value: config.rate ?? '+0%',
                      onChange: (event) => set('rate', event.target.value),
                      style: inputStyle,
                    },
                    ['-50%', '-40%', '-30%', '-20%', '-10%', '+0%', '+10%', '+15%', '+20%', '+30%', '+40%', '+50%', '+75%', '+100%']
                      .map((v) => React.createElement('option', { key: v, value: v }, v)),
                  ),
                ),
                /* 音调：只有在线 Edge 支持 */
                isOnline
                  ? React.createElement(
                      Label,
                      null,
                      React.createElement('span', null, t('pitch')),
                      React.createElement(
                        'select',
                        {
                          value: config.pitch ?? '+0Hz',
                          onChange: (event) => set('pitch', event.target.value),
                          style: inputStyle,
                        },
                        ['-50Hz', '-30Hz', '-20Hz', '-10Hz', '+0Hz', '+10Hz', '+20Hz', '+30Hz', '+50Hz']
                          .map((v) => React.createElement('option', { key: v, value: v }, v)),
                      ),
                    )
                  : null,
                /* 音量：神经模型与 GPT-SoVITS 外部服务不支持 */
                !isNeural && !isSovits
                  ? React.createElement(
                      Label,
                      null,
                      React.createElement('span', null, t('volume')),
                      React.createElement(
                        'select',
                        {
                          value: config.volume ?? '+0%',
                          onChange: (event) => set('volume', event.target.value),
                          style: inputStyle,
                        },
                        ['-50%', '-30%', '-20%', '-10%', '+0%', '+10%', '+20%', '+30%', '+50%']
                          .map((v) => React.createElement('option', { key: v, value: v }, v)),
                      ),
                    )
                  : null,
                /* 音频格式：只有在线 Edge 支持 */
                isOnline
                  ? React.createElement(
                      Label,
                      null,
                      React.createElement('span', null, t('ttsFormat')),
                      React.createElement(
                        'select',
                        {
                          value: config.ttsFormat ?? 'AUDIO_24KHZ_48KBITRATE_MONO_MP3',
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
              )
            : null,
        ),

        /* ============ 三、模型与下载管理 ============ */
        React.createElement(
          Section,
          { title: t('secModels') },
          React.createElement(
            'div',
            { style: { padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))', borderRadius: 8 } },
            // 当前实际用的合成方式（在线/系统语音时不在模型列表里，单独说明）
            React.createElement(
              'div',
              { style: { fontSize: 12, marginBottom: 8, opacity: 0.85 } },
              `${t('ttsCurrent')}: ${engine === 'sovits'
                ? `GPT-SoVITS (${config.sovitsUrl ?? 'http://127.0.0.1:9880'})`
                : engine === 'neural'
                  ? (readyNeural.find((x) => x.id === config.neuralModel)?.label ?? t('neuralNoModel'))
                  : engine === 'local'
                    ? (voiceLabel(config.localVoice ?? '') || t('localVoiceDefault'))
                    : (voiceLabel(config.voice ?? '') || (config.voice ?? ''))}`,
            ),
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
          // 预加载与空闲释放
          React.createElement(
            Toggle,
            {
              label: t('preloadModels'),
              hint: t('preloadModelsHint'),
              checked: config.preloadModels !== false,
              onChange: (v) => set('preloadModels', v),
            },
          ),
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('idleReleaseMinutes')),
            React.createElement(
              'select',
              {
                value: String(config.idleReleaseMinutes ?? 10),
                onChange: (event) => set('idleReleaseMinutes', Number(event.target.value)),
                style: inputStyle,
              },
              [
                [0, '永不释放'],
                [5, '5 分钟'],
                [10, '10 分钟'],
                [30, '30 分钟'],
                [60, '1 小时'],
              ].map(([v, label]) => React.createElement('option', { key: v, value: String(v) }, label)),
            ),
            React.createElement(
              'span',
              { style: { fontSize: 12, opacity: 0.7 } },
              t('idleReleaseMinutesHint'),
            ),
          ),

          // 环境自检
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
          envInfo
            ? React.createElement(
                'div',
                { style: { fontSize: 12, opacity: 0.85, marginBottom: 12, lineHeight: 1.7 } },
                React.createElement('div', null, `平台：${envInfo.platform} ${envInfo.arch}`),
                React.createElement('div', null, `显卡：${envInfo.gpu?.available ? envInfo.gpu.name + ' (' + envInfo.gpu.memoryMB + 'MB)' : '未检测到 NVIDIA 显卡'}`),
                ...(envInfo.engines ?? []).map((e) => React.createElement(
                  'div',
                  { key: e.id },
                  `${e.available ? '✓' : '✗'} ${e.label}：${e.detail}`,
                )),
              )
            : null,
        ),

        /* ============ 四、交互与后处理 ============ */
        React.createElement(
          Section,
          { title: t('secInteraction') },
          React.createElement(
            Label,
            null,
            React.createElement('span', null, t('shortcut')),
            React.createElement('input', {
              value: config.shortcut ?? '',
              onChange: (event) => set('shortcut', event.target.value),
              placeholder: 'Alt+V',
              // 聚焦这个输入框时，快捷键不应该触发录音。
              onFocus: () => { shortcutFieldFocused = true },
              onBlur: () => { shortcutFieldFocused = false },
              style: inputStyle,
            }),
            React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, t('shortcutHint')),
            (() => {
              const check = validateShortcut(config.shortcut);
              if (check.ok) return null;
              return React.createElement(
                'span',
                { style: { fontSize: 12, color: 'var(--dsw-alias-state-danger, #d13438)' } },
                check.message,
              );
            })(),
          ),
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
              value: (config.words ?? []).join('\n'),
              onChange: (event) => set('words', event.target.value.split('\n').map((x) => x.trim()).filter(Boolean)),
              placeholder: '正确=错误\n专业术语',
              rows: 5,
              style: { ...inputStyle, resize: 'vertical' },
            }),
            React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, t('wordsHint')),
          ),
        ),

        /* ============ 保存栏 ============ */
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 } },
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => void save(),
              // 加载完成前禁止保存：此时表单里还是默认值，
              // 一点保存就会把用户已有的设置（比如「朗读回复」）覆盖掉。
              disabled: !dirty || !loaded,
              style: {
                padding: '7px 16px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
                background: 'transparent',
                color: 'inherit',
                fontSize: 13,
                cursor: dirty && loaded ? 'pointer' : 'default',
                opacity: dirty && loaded ? 1 : 0.5,
              },
            },
            t('save'),
          ),
          !loaded
            ? React.createElement('span', { style: { fontSize: 12, opacity: 0.75 } }, t('loadingConfig'))
            : dirty
              ? React.createElement('span', { style: { fontSize: 12, opacity: 0.75 } }, t('unsaved'))
              : null,
          status ? React.createElement('span', { style: { fontSize: 12, opacity: 0.75 } }, status) : null,
        ),
      )
    }

    /** 浏览器半侧入口。 */
    function apply(ctx) {
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
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
