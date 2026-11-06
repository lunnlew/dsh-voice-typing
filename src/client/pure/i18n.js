/**
 * UI 文案（纯数据，zh/en 双语）+ 填参数的纯函数 —— 浏览器侧设置面板与全局浮层共用。
 *
 * 为什么单独放：src/client/main.js 是 7k+ 行的单体，文案占了近 400 行，
 * 纯数据夹杂在 React 组件与状态胶水里很难导航。这里把**纯数据**抽出来，
 * 由 main.js 顶层 `import { zh, en }` 带进构建产物 —— 组件仍能直接引用
 * zh / en，但改文案不用再翻大文件。
 *
 * 字典之外这里还有九个纯函数（`languageLabel` / `voiceLabel` / `zhTranslate` /
 * `ttsEngineOptionLabel` / `idleReleaseLabel` / `modelLabel` / `envEngineLabel` /
 * `envRuntimeLabel` / `interpolate`）：前八个都是「查这张表」，
 * 不是逻辑；`interpolate` 则是「句子里的 `{名字}` 怎么填」，属于字典自己的规矩。
 * 三处组件的兜底取词共用 `zhTranslate`（批次 22，§8.64），语言名、音色名、
 * 引擎选项、空闲释放档位的展示名也一律回到这里查（批次 22-2，§8.65），
 * 模型档位名同样如此（批次 22-3-1，§8.66 —— 宿主目录里本来就有中英两份名字，
 * 但客户端只读中文那份，英文那份从来没上过界面），
 * 环境自检的引擎行名与运行时种类也一样（批次 22-3-2，§8.67 —— 那两个名字改前住在
 * `src/host/tts-env.js` 的行里，客户端连探测结果带名字一起照抄宿主的中文）——
 * **设置面板与浮层上那些看得见的中文，只能由这个文件出**（字典侧判据见
 * `test/i18n-status-line.test.mjs` 判据 13–18，渲染侧见 client-behavior 的「面板·选项文案」
 * 「面板·模型名」与「面板·环境自检」）。
 * 这句话不是「全仓库只有这里有汉字」：唤醒词的同音表、无障碍的允许/禁止词表、
 * 判全角标点的正则都合法地含汉字，它们住在别的 `pure/` 文件里。
 *
 * 这一族**不再加新模块**（选项文案不配有自己的模块），住在这里是因为它们就是「查这张表」。
 * 搬的时候**展示名一个字没改**：这批改的是「这句话住在哪儿」，不是「这句话怎么说」；
 * 音色名里那些「（女·普通话）」照旧留着，它们是改前面板就在显示的选项说明，删掉是产品回退。
 * 模型那九句是把目录的 `label` / `labelEn` 逐字抄进来，等值由判据 17 锁住 ——
 * 重复一份文字的代价就是这么付的，不是靠「记得两边都改」。
 * 全角标点（`：`、`（）`）留在面板里 —— 那是排版，不是话（§8.65 记为待办）。
 *
 * 约束（与其它 pure/* 一致）：本文件不依赖浏览器 API，也不依赖 React，
 * Node 里可原生 import（test/bundle-sync 与其它单测直接 import 它）。
 *
 * 注册给宿主 locale 系统的入口在 main.js：scope.locale.register(NS, { zh, en })。
 */

export const zh = {
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
  modelLoadingDetail: '正在加载识别模型，请稍候（第一次比之后慢）。',
  modelFailed: '模型加载失败',
  modelFailedDetail: '请到设置里检查该档位。',
  // 开麦前问宿主「模型好了吗」，宿主只回原因码（`src/shared/asr-readiness.js`），
  // 这句话由码查出来。状态行短词统一用上面那条，只有长说明随码分档。
  modelNotFoundDetail: '设置里选的那一档在这台机器上没有，请到设置里重新选一个档位。',
  modelNotDownloadedDetail: '识别模型还没下载，请到设置里先把那一档下载下来。',
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
  // 配置键本身也是这一行的字段名（校验失败那行红字用它，见 configFieldLabel）。
  localVoice: '系统语音发音人',
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
  // 请求根本没发出去 / 没拿到回执时的那句（批次 22-3-3，docs §8.68）。
  // 改前这里是 `${saveFailed}：${error.message}`，界面上出现的是浏览器给的技术串
  // （`Failed to fetch` 这类），中文界面是英文串、英文界面也不告诉人该做什么。
  // 原始 message 只进 console.warn，`saveFailed` 那短词仍是状态行用的。
  saveFailedNetwork: '保存失败：连不上本机的语音服务，请确认它在运行后重试。',
  // ---- 设置面板自己的选项文案（批次 22-2，docs §8.65）----
  // 这一族和批次 18/19/20 的区别只在「说话的人是谁」：那些是宿主写来的句子，
  // 这些是面板组件里手写的中文。两边症状一样 —— 界面切英文后它们仍是中文。
  // 「会不会进界面」才是判据，所以处理方式一样：句子里只留字典键，值由参数填。
  wordsPlaceholder: '正确=错误\n专业术语',
  liveAsrStreamNeedsOption: '（需先下载 {model}）',
  engineOptionOnline: 'Edge 在线（音质好，需联网）',
  engineOptionNeural: '本地神经模型（离线 · 音质接近在线）',
  engineOptionLocal: '本地系统语音（离线可用，速度快）',
  engineOptionLocalUnsupported: '本地系统语音（当前平台不支持）',
  engineOptionSovits: 'GPT-SoVITS 外部服务（用你自己配置好的服务）',
  engineOptionUnknown: '这个合成引擎不认识，请重新选一个。',
  ttsFormatMp3Small: 'MP3 24kHz/48kbps（推荐，体积小）',
  ttsFormatMp3Quality: 'MP3 24kHz/96kbps（音质更好）',
  idleReleaseNever: '永不释放',
  idleReleaseInMinutes: '{minutes} 分钟',
  idleReleaseInHours: '{hours} 小时',
  neuralSpeakerOption: '说话人 {index}',
  envPlatformLabel: '平台',
  envGpuLabel: '显卡',
  envGpuNone: '未检测到 NVIDIA 显卡',
  // ---- 运行环境自检那四行（批次 22-3-2，docs §8.67）----
  // 改前这几句住在 `src/host/tts-env.js` 里：宿主探测完直接把中文塞进 `detail`，
  // 面板 `${e.label}：${e.detail}` 原样上界面，于是英文界面这一整块是中文。
  // 现在宿主只回码 + 参数（`src/shared/tts-env-reasons.js`），句子在这里。
  // 参数占位符只填契约值或机器事实：{version} 版本号、{voice} 系统音色短名、
  // {bin} 命令名、{platform} 平台名、{count} 数量、{model} 档位 id、{runtime} 运行时种类。
  envEngineOnline: 'Edge 在线',
  envEngineLocal: '本地系统语音',
  envEngineNeural: '本地神经模型',
  envEngineSovits: 'GPT-SoVITS 外部服务',
  envEngineUnknown: '另一个引擎（{id}）',
  envRuntimeNative: '原生加速',
  envRuntimeWasm: 'WASM 版',
  envReasonUnknown: '这一项的状态读不出来（宿主回了一个不认识的码）。',
  envReasonLocalReadyPowershell: '可用（Windows PowerShell {version}），默认发音人：{voice}',
  envReasonLocalMissingPowershell: '找不到可用的 powershell；Windows 精简镜像可能没装 Windows PowerShell 5.1。',
  envReasonLocalReadySay: '可用（macOS 内置 say），默认发音人：{voice}',
  envReasonLocalMissingSay: '找不到 say 命令。',
  envReasonLocalReadyEspeak: '可用（{bin}），完全离线朗读。',
  envReasonLocalMissingEspeak: '缺少 espeak-ng（Debian/Ubuntu：apt install espeak-ng；Fedora：dnf install espeak-ng；Arch：pacman -S espeak-ng）。',
  envReasonLocalPlatformUnsupported: '当前平台（{platform}）不支持本地系统语音。',
  envReasonOnlineReady: '可用（服务端返回 {count} 个音色）',
  envReasonOnlineNoVoices: '连上了，但没拿到音色列表',
  envReasonOnlineUnreachable: '连不上 Edge 在线服务。',
  envReasonNeuralNoTier: '没有可用的本地神经模型档位。',
  envReasonNeuralMissingRuntime: '缺少本地推理运行时（sherpa-onnx 的原生件与 WASM 版都没装上），本地神经模型用不了。',
  envReasonNeuralModelMissing: '模型还没下载（{model}），请到设置里点「下载」。',
  envReasonNeuralReady: '已就绪（{model}，{runtime}），离线神经网络音色，约 1.6 秒/句。',
  // 模型下载失败那行（批次 22-4-2，docs §8.71）：宿主只回原因码 + 参数
  // （`src/shared/model-download-reasons.js`），句子在这里。十个码分三类要做的事 ——
  // 再试一次 / 重试没用（档位本身的问题）/ 读不出来，所以一句都不合并。
  downloadReasonUnknown: '下载状态读不出来（宿主回了一个不认识的原因码）。',
  downloadReasonFailedUnknown: '下载没成功，具体原因看诊断。',
  downloadReasonNoDownloadableFiles: '这个档位没有可下载的文件（{model}），重试也不会好，是档位表本身的问题。',
  downloadReasonFileFailed: '{file} 没下载下来，网络或镜像可能一时不通，可以稍后再试一次。',
  downloadReasonNotInRepo: '模型仓库里没有 {file}（HTTP {status}），这个档位下载不了，需要更新档位表。',
  downloadReasonChunkFailed: '{file} 的某几分片没下全（失败的第 {chunks} 片），可以再试一次。',
  downloadReasonChunkIncomplete: '{file} 的分片在合并前就缺了一块（第 {chunk} 片），可以再试一次。',
  downloadReasonMergedSizeMismatch: '{file} 拼出来的大小不对（{got} 字节，应为 {expected}），坏的分片已经清掉，可以再试一次。',
  downloadReasonShaMismatch: '{file} 校验没过（下载到的内容与档位声明的不一致），可以再试一次。',
  downloadReasonUnknownModel: '没有这个档位（{model}），请重新打开设置再看。',
  downloadReasonHostedUnavailable: '内置档位 {model} 的本地文件不在位，它不走下载，需要装 DSH 的语音输入组件。',
  // 语言展示名（批次 22-2）：以前 `LANGUAGE_LABELS` 是一张只有中文的表，
  // 英文界面打开语言下拉看到的还是「中文（普通话）/粤语」。契约值有六个（`ASR_LANGUAGES`），
  // 每个都必须在两端各有一句 —— 「漏一个」由 test/i18n-status-line.test.mjs 判红。
  langAuto: '自动识别',
  langZh: '中文（普通话）',
  langEn: '英语',
  langYue: '粤语',
  langJa: '日语',
  langKo: '韩语',
  // 音色展示名（批次 22-2）：同一族，24 个上游音色名各有中、英两种写法。
  // 英文那侧不给音译以外的东西 —— 用户看得懂的就是上游那个短名，这里只补「性别·口音」。
  voiceXiaoxiao: '晓晓（女·普通话）',
  voiceXiaoyi: '晓伊（女·普通话）',
  voiceYunjian: '云健（男·普通话·浑厚）',
  voiceYunxi: '云希（男·普通话·活泼）',
  voiceYunxia: '云夏（男·普通话·少年）',
  voiceYunyang: '云扬（男·普通话·专业）',
  voiceXiaobei: '晓北（女·东北话）',
  voiceXiaoni: '晓妮（女·陕西话）',
  voiceHiuGaai: '曉佳（女·粤语）',
  voiceHiuMaan: '曉曼（女·粤语）',
  voiceWanLung: '雲龍（男·粤语）',
  voiceHsiaoChen: '曉臻（女·台湾）',
  voiceHsiaoYu: '曉雨（女·台湾）',
  voiceYunJhe: '雲哲（男·台湾）',
  voiceHuihui: '慧慧（系统·女）',
  voiceZira: 'Zira（系统·英文女）',
  voiceTingting: '婷婷（系统·普通话女）',
  voiceMeijia: '美佳（系统·台湾女）',
  voiceSinji: '新知（系统·普通话女）',
  voiceYuShu: '语舒（系统·普通话女）',
  voiceLiMu: '李慕（系统·普通话男）',
  voiceCmn: '普通话（espeak·中文）',
  voiceCmnPinyin: '普通话拼音（espeak）',
  voiceYue: '粤语（espeak）',
  // 模型档位名（批次 22-3-1）：这九句是**逐字抄 `src/host/model-catalog.js` 的 `label`**，
  // 英文侧抄同一档的 `labelEn`。`test/i18n-status-line.test.mjs` 判「字典里这两句必须和目录相等」——
  // 目录改了名字而这里没跟，当场红（重复的成本由这条判据付掉）。
  // 为什么要抄进字典：宿主那份英文从来没上过界面（客户端只读 `label`），
  // 而界面语言是宿主 `t` 决定的，客户端拿不到语言码，只能自己按 id 查这张表。
  modelSensevoice: 'SenseVoice（推荐 · 中文强 · 带标点与数字规范化）',
  modelZipformer2Zh: 'Zipformer2 中文（流式 · 精度一般 · 较慢）',
  modelWhisperTiny: 'Whisper tiny（最轻 · 99MB）',
  modelWhisperBase: 'Whisper base（轻量 · 153MB）',
  modelWhisperSmall: 'Whisper small（均衡 · 358MB）',
  modelWhisperMedium: 'Whisper medium（较准 · 902MB）',
  modelWhisperTurbo: 'Whisper large-v3-turbo（很准 · 989MB）',
  modelWhisperLargeV3: 'Whisper large-v3（最准 · 1.7GB）',
  modelVitsMeloZhEn: 'MeloTTS 中英（多说话人 · 本地离线 · 音质好）',
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
  wakeWordHint: '待机时先说这个词再下命令（默认「小鱼」）。2 个字的唤醒词按同音字归一后精确匹配（如「小渔」也算「小鱼」）；3 个字以上允许 1 个字的识别误差（同音/口音）。可用 | 或中文逗号分隔多个别名（如「小鱼|小渔|你好小鱼」）提高唤醒率。留空 = 关闭唤醒词（说话直接发送）。只对全局语音浮层生效，输入框麦克风不受影响；注意常开麦待机会持续占用麦克风（耗电/隐私）。',
  globalWakeStandby: '待机 · 说『{word}』唤醒',
  globalWakeActive: '已唤醒 · 直接说即可',
  globalWakeStandbyHint: '待机中 · 说『{word}』唤醒',
  globalWakeMiss: '待机中 · 听到「{text}」',
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
  // 状态行只放短词：「为什么失败、能怎么办」由下面这批按宿主报的码出
  // （批次 19，docs/architecture-modernization.md §8.61 —— 宿主不再写句子）。
  hotkeyStatusFailed: '失败',
  hotkeyStatusRefresh: '刷新状态',
  hotkeyStatusNeedsOverlay: '需要同时开启「全局语音浮层」才会生效：服务端已跳过系统级热键。',
  // ---- 热键原因码对应的句子（码表见 src/shared/hotkey-reasons.js）----
  hotkeyReasonAddress: '宿主地址没定下来，热键助手没法启动。',
  hotkeyReasonScript: '热键助手脚本没能准备好（磁盘写入或参数问题）。',
  hotkeyReasonHelperStart: '热键助手进程没能启动。',
  hotkeyReasonBeforeReady: '热键助手启动后又退出了，热键没注册上。',
  hotkeyReasonRegister: '这个组合键没能注册上，很可能已经被别的程序占用，换一个组合键再试。',
  hotkeyReasonExited: '热键助手已经退出，快捷键暂时按不动。',
  hotkeyReasonNative: '这台机器上的原生热键模块用不上（可能缺依赖、没有辅助功能权限，或没有图形界面）。',
  hotkeyReasonShortcut: '设置里的快捷键没法用作系统热键：至少需要一个修饰键，单个字母要配 Ctrl/Alt/Win。',
  hotkeyReasonSwitchOff: '设置里没开启系统级热键。',
  hotkeyReasonOverlayOff: '全局语音浮层没开，服务端跳过了系统级热键的注册。',
  hotkeyReasonUnloaded: '插件已停止，系统热键的注册已释放。',
  hotkeyReasonUnknown: '原因未知（详见诊断）。',
  // ---- 「保存设置没存进去」那行红字（码表见 src/shared/config-error-codes.js）----
  // 前面会拼上字段名（唤醒词 / 词表 / 语音引擎…），所以除整份请求的错之外
  // 都不必再重复「这一项」；动态数字（上限、区间、允许值）由 shared 的规则现场算，
  // 不是宿主传过来的（批次 20，docs/architecture-modernization.md §8.62）。
  configErrorBodyNotJson: '这次保存的请求没能读出来，请重新保存一次。',
  configErrorBodyTooLarge: '这次保存的内容太大，没有存进去。',
  configErrorPatchNotObject: '这次保存的请求形状不对，没有存进去。',
  configErrorSaveFailed: '保存没成功，请重试；一直失败就到诊断里看原因。',
  configErrorBoolean: '只能选开或者关。',
  configErrorEnum: '只能填这些里的一个：{values}。',
  configErrorNumber: '要填一个数字。',
  configErrorInteger: '要填一个整数。',
  configErrorRange: '要在 {min} 到 {max} 之间。',
  configErrorString: '要填一段文字。',
  configErrorTooLong: '不能超过 {maxLen} 个字。',
  configErrorNotArray: '这一格的内容没能读成列表。',
  configErrorUrlMalformed: '地址写法不对，例如 http://127.0.0.1:9880。',
  configErrorUrlScheme: '地址要用 http:// 或者 https:// 开头。',
  configErrorWordsTooMany: '词表最多 {max} 条，先删掉一些再保存。',
  configErrorWordsEmpty: '词表里有空行，删掉再保存。',
  configErrorWordsEntryTooLong: '词表里每条都不能超过 {max} 个字，改短一点再保存。',
  configErrorWordsMissingCorrect: '词表里有一条没写「正确的说法」，补上再保存。',
  configErrorWordsEntryShape: '词表里有一条看不懂，请写成「说法=正确的说法」。',
  configErrorUnknown: '这一项没通过校验，具体原因请到诊断里看。',
  // 快捷键那两行红字：`pure/shortcut.js` 只给原因码，句子在这一份字典里（批次 22）。
  shortcutErrorEmpty: '不能为空。',
  shortcutErrorTooFewParts: '至少要两个键，例如 Ctrl+Shift+Space。',
  shortcutErrorUnknownModifier: '不认识的修饰键：{modifier}。',
  shortcutErrorSingleLetter: '别用单个字母（{key}），否则打字会误触发（单字母需要搭配 Ctrl/Alt）。',
  shortcutErrorReservedPaste: '{combo} 是浏览器的「粘贴为纯文本」，换一个。',
  shortcutErrorUnknown: '这个组合键的写法不合法。',
  // 响应体只说「没通过」、一条错误都没给时的那句（不是某个码，是整份的结论）。
  configSaveRejected: '保存没成功：这一份配置没通过校验。',
}

export const en = {
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
  modelLoadingDetail: 'Loading the recognition model, please wait (the first time is slower).',
  modelFailed: 'Model failed',
  modelFailedDetail: 'Check the tier in settings.',
  // 与中文侧同一批（开麦前宿主只回原因码，这句话由码查出来；短词共用上面那条）。
  modelNotFoundDetail: 'The tier chosen in settings is not on this machine. Pick a tier in settings.',
  modelNotDownloadedDetail: 'The recognition model is not downloaded yet. Download that tier in settings.',
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
  // The config key doubles as this row's field name (see configFieldLabel).
  localVoice: 'System voice',
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
  // Same two sentences as the Chinese side (batch 22-3-3, docs §8.68):
  // the browser's raw message ("Failed to fetch") goes to console.warn, never to the UI.
  saveFailedNetwork: 'Save failed: cannot reach the local voice service. Make sure it is running, then try again.',
  // ---- Settings-panel option labels (batch 22-2, docs §8.65) ----
  wordsPlaceholder: 'correct=wrong\nspecialist term',
  liveAsrStreamNeedsOption: ' (needs {model} downloaded first)',
  engineOptionOnline: 'Edge online (better quality, requires network)',
  engineOptionNeural: 'Local neural model (offline · quality close to online)',
  engineOptionLocal: 'Local system voice (offline, fast)',
  engineOptionLocalUnsupported: 'Local system voice (not supported on this platform)',
  engineOptionSovits: 'GPT-SoVITS external service (your own configured server)',
  engineOptionUnknown: 'This synthesis engine is not recognized. Pick another one.',
  ttsFormatMp3Small: 'MP3 24kHz/48kbps (recommended, smaller)',
  ttsFormatMp3Quality: 'MP3 24kHz/96kbps (better quality)',
  idleReleaseNever: 'Never release',
  // 单位用缩写而不是整词：英文的「1 hour / 2 hours」要按数量变形，
  // 而这个字典没有复数规则（一句 key 就是一句句子）。缩写 '1 h' / '30 min' 两边都读得通。
  // 推翻条件：真给文案层加了复数规则，就把这两句换回整词。
  idleReleaseInMinutes: '{minutes} min',
  idleReleaseInHours: '{hours} h',
  neuralSpeakerOption: 'Speaker {index}',
  envPlatformLabel: 'Platform',
  envGpuLabel: 'GPU',
  envGpuNone: 'No NVIDIA GPU detected',
  // ---- Environment-check rows (batch 22-3-2, docs §8.67) ----
  // 命令名、包名、平台名是数据不是话，中英两句里都照写：`powershell`、`espeak-ng`、`sherpa-onnx`。
  envEngineOnline: 'Edge online',
  envEngineLocal: 'Local system voice',
  envEngineNeural: 'Local neural model',
  envEngineSovits: 'GPT-SoVITS external service',
  envEngineUnknown: 'Another engine ({id})',
  envRuntimeNative: 'native runtime',
  envRuntimeWasm: 'WASM runtime',
  envReasonUnknown: "Can't read this item's status (the host returned an unknown code).",
  envReasonLocalReadyPowershell: 'Available (Windows PowerShell {version}); default voice: {voice}',
  envReasonLocalMissingPowershell: 'No usable powershell found. A trimmed-down Windows image may not include Windows PowerShell 5.1.',
  envReasonLocalReadySay: 'Available (macOS built-in say); default voice: {voice}',
  envReasonLocalMissingSay: 'The say command was not found.',
  envReasonLocalReadyEspeak: 'Available ({bin}); fully offline read-aloud.',
  envReasonLocalMissingEspeak: 'espeak-ng is missing (Debian/Ubuntu: apt install espeak-ng; Fedora: dnf install espeak-ng; Arch: pacman -S espeak-ng).',
  envReasonLocalPlatformUnsupported: 'Local system voice is not supported on this platform ({platform}).',
  envReasonOnlineReady: 'Available (the server returned {count} voices)',
  envReasonOnlineNoVoices: 'Connected, but no voice list was returned',
  envReasonOnlineUnreachable: 'Cannot reach the Edge online service.',
  envReasonNeuralNoTier: 'No usable local neural model tier.',
  envReasonNeuralMissingRuntime: 'The local inference runtime is missing (neither the sherpa-onnx native package nor the WASM build is installed), so the local neural model cannot be used.',
  envReasonNeuralModelMissing: 'The model is not downloaded yet ({model}); download it in Settings.',
  envReasonNeuralReady: 'Ready ({model}, {runtime}); offline neural voices, about 1.6 s per sentence.',
  downloadReasonUnknown: "Can't read the download status (the host returned an unknown reason code).",
  downloadReasonFailedUnknown: 'Download failed; see diagnostics for the reason.',
  downloadReasonNoDownloadableFiles: 'This tier has no files to download ({model}); retrying will not help - the model catalog itself is incomplete.',
  downloadReasonFileFailed: 'Could not download {file}. The network or mirror may be unavailable; try again later.',
  downloadReasonNotInRepo: '{file} is not in the model repository (HTTP {status}); this tier cannot be downloaded until the catalog is fixed.',
  downloadReasonChunkFailed: 'Some chunks of {file} did not finish (failed chunk {chunks}); you can try again.',
  downloadReasonChunkIncomplete: 'A chunk of {file} was missing before the pieces were joined (chunk {chunk}); you can try again.',
  downloadReasonMergedSizeMismatch: 'The merged size of {file} is wrong ({got} bytes, expected {expected}); the bad chunks were removed, you can try again.',
  downloadReasonShaMismatch: '{file} failed its checksum (what was downloaded differs from the catalog); you can try again.',
  downloadReasonUnknownModel: 'No such model tier ({model}); reopen Settings and try again.',
  downloadReasonHostedUnavailable: 'Files for the built-in tier {model} are missing. It is not downloaded - install the DSH speech input component instead.',
  langAuto: 'Auto-detect',
  langZh: 'Chinese (Mandarin)',
  langEn: 'English',
  langYue: 'Cantonese',
  langJa: 'Japanese',
  langKo: 'Korean',
  voiceXiaoxiao: 'Xiaoxiao (female · Mandarin)',
  voiceXiaoyi: 'Xiaoyi (female · Mandarin)',
  voiceYunjian: 'Yunjian (male · Mandarin · deep)',
  voiceYunxi: 'Yunxi (male · Mandarin · lively)',
  voiceYunxia: 'Yunxia (male · Mandarin · teen)',
  voiceYunyang: 'Yunyang (male · Mandarin · professional)',
  voiceXiaobei: 'Xiaobei (female · Northeastern accent)',
  voiceXiaoni: 'Xiaoni (female · Shaanxi accent)',
  voiceHiuGaai: 'Hiu Gaai (female · Cantonese)',
  voiceHiuMaan: 'Hiu Maan (female · Cantonese)',
  voiceWanLung: 'Wan Lung (male · Cantonese)',
  voiceHsiaoChen: 'Hsiao Chen (female · Taiwan)',
  voiceHsiaoYu: 'Hsiao Yu (female · Taiwan)',
  voiceYunJhe: 'Yun Jhe (male · Taiwan)',
  voiceHuihui: 'Huihui (system · female)',
  voiceZira: 'Zira (system · English female)',
  voiceTingting: 'Tingting (system · Mandarin female)',
  voiceMeijia: 'Meijia (system · Taiwan female)',
  voiceSinji: 'Sinji (system · Mandarin female)',
  voiceYuShu: 'Yu-shu (system · Mandarin female)',
  voiceLiMu: 'Li-mu (system · Mandarin male)',
  voiceCmn: 'Mandarin (espeak · Chinese)',
  voiceCmnPinyin: 'Mandarin pinyin (espeak)',
  voiceYue: 'Cantonese (espeak)',
  // Model tier display names (batch 22-3-1): copied verbatim from `src/host/model-catalog.js`
  // (`labelEn`), same judge as the Chinese side — the dictionary must equal the catalog.
  // These nine English sentences used to exist only in the host and never reached the UI:
  // the client rendered `m.label` (the Chinese one) no matter what language was selected.
  modelSensevoice: 'SenseVoice (recommended · strong Mandarin, punctuation + ITN)',
  modelZipformer2Zh: 'Zipformer2 Mandarin (streaming · lower accuracy · slower)',
  modelWhisperTiny: 'Whisper tiny (lightest · 99MB)',
  modelWhisperBase: 'Whisper base (light · 153MB)',
  modelWhisperSmall: 'Whisper small (balanced · 358MB)',
  modelWhisperMedium: 'Whisper medium (accurate · 902MB)',
  modelWhisperTurbo: 'Whisper large-v3-turbo (very accurate · 989MB)',
  modelWhisperLargeV3: 'Whisper large-v3 (most accurate · 1.7GB)',
  modelVitsMeloZhEn: 'MeloTTS Chinese+English (multi-speaker, local, good quality)',
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
  wakeWordHint: 'While the global voice overlay is in standby, say this word before a command (default "小鱼"). A 2-character wake word is matched after homophone normalization (e.g. 小渔 also matches 小鱼); 3+ characters allow one character of recognition tolerance. Separate aliases with | or a comma (e.g. "小鱼|小渔|你好小鱼") to improve hit rate. Empty = off (speech is sent directly). Only applies to the global overlay, not the composer mic; always-on standby keeps the microphone busy (battery/privacy).',
  globalWakeStandby: 'Standby · say "{word}" to wake',
  globalWakeActive: 'Awake — just speak',
  globalWakeStandbyHint: 'Standby · say "{word}" to wake',
  globalWakeMiss: 'Standby · heard "{text}"',
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
  // Short status word only: which step failed is said by the keys below,
  // looked up from the code the host reports (batch 19, docs §8.61).
  hotkeyStatusFailed: 'Failed',
  hotkeyStatusRefresh: 'Refresh status',
  hotkeyStatusNeedsOverlay: 'Requires "Global voice overlay" to be on as well — the server has skipped OS-level hotkeys.',
  // ---- Sentences for the OS-hotkey reason codes (table: src/shared/hotkey-reasons.js) ----
  hotkeyReasonAddress: 'The host address is not settled, so the hotkey helper cannot start.',
  hotkeyReasonScript: 'The hotkey helper script could not be prepared (disk write or argument problem).',
  hotkeyReasonHelperStart: 'The hotkey helper process could not start.',
  hotkeyReasonBeforeReady: 'The hotkey helper started but exited again, so the hotkey was never registered.',
  hotkeyReasonRegister: 'This key combination could not be registered — another program most likely holds it. Try a different combination.',
  hotkeyReasonExited: 'The hotkey helper has exited, so the shortcut does nothing right now.',
  hotkeyReasonNative: 'The native hotkey module is unavailable on this machine (missing dependency, no Accessibility permission, or no graphical session).',
  hotkeyReasonShortcut: 'The shortcut in settings cannot be used as a system hotkey: at least one modifier is required, and a single letter needs Ctrl/Alt/Win.',
  hotkeyReasonSwitchOff: 'The OS-level hotkey is turned off in settings.',
  hotkeyReasonOverlayOff: 'The global voice overlay is off, so the server skipped OS-level hotkey registration.',
  hotkeyReasonUnloaded: 'The plugin has stopped and released the system hotkey registration.',
  hotkeyReasonUnknown: 'Unknown reason (see diagnostics).',
  // ---- "Saving settings did not go through" lines (codes: src/shared/config-error-codes.js) ----
  // The field name is prefixed, so only the whole-request cases need to restate a subject;
  // numbers (limits, ranges, allowed values) are recomputed from the shared rules instead of
  // being carried over by the host (batch 20, docs/architecture-modernization.md §8.62).
  configErrorBodyNotJson: 'This save request could not be read. Please save again.',
  configErrorBodyTooLarge: 'This save request is too large, so nothing was saved.',
  configErrorPatchNotObject: 'This save request is not a settings object, so nothing was saved.',
  configErrorSaveFailed: 'Saving failed. Try again; if it keeps failing, check the reason in diagnostics.',
  configErrorBoolean: 'This can only be on or off.',
  configErrorEnum: 'Use one of: {values}.',
  configErrorNumber: 'Enter a number.',
  configErrorInteger: 'Enter a whole number.',
  configErrorRange: 'Use a value between {min} and {max}.',
  configErrorString: 'Enter text.',
  configErrorTooLong: 'Must be {maxLen} characters or fewer.',
  configErrorNotArray: 'This value could not be read as a list.',
  configErrorUrlMalformed: 'That address is not written correctly, e.g. http://127.0.0.1:9880.',
  configErrorUrlScheme: 'The address must start with http:// or https://.',
  configErrorWordsTooMany: 'The word list holds at most {max} entries. Remove some and save again.',
  configErrorWordsEmpty: 'The word list has an empty line. Remove it and save again.',
  configErrorWordsEntryTooLong: 'Each word-list entry must be {max} characters or fewer. Shorten it and save again.',
  configErrorWordsMissingCorrect: 'One word-list entry has no "correct wording". Add it and save again.',
  configErrorWordsEntryShape: 'One word-list entry could not be read. Write it as "say=correct wording".',
  configErrorUnknown: 'This entry failed validation. See diagnostics for the exact reason.',
  // Shortcut red lines: `pure/shortcut.js` only returns reason codes (batch 22).
  shortcutErrorEmpty: 'Cannot be empty.',
  shortcutErrorTooFewParts: 'Use at least two keys, for example Ctrl+Shift+Space.',
  shortcutErrorUnknownModifier: 'Unknown modifier key: {modifier}.',
  shortcutErrorSingleLetter: 'Do not use a single letter ({key}); it fires while you type (pair it with Ctrl or Alt).',
  shortcutErrorReservedPaste: '{combo} is the browser shortcut for "Paste as plain text". Pick another one.',
  shortcutErrorUnknown: 'This shortcut is not valid.',
  // Shown when the response only says "rejected" and lists no error at all.
  configSaveRejected: 'Not saved: this configuration failed validation.',
}

/**
 * 把句子里的 `{名字}` 换成参数值（批次 22，docs §8.64）。
 *
 * 为什么字典里需要一个填参数的函数：这一族的句子有几条必须点名用户刚写的那个东西
 * （「不认识的修饰键：{modifier}」），而**码表只负责选句子，选不出内容** ——
 * 内容只有校验那一侧知道，所以 `t(key, params)` 是两段式的：键决定句式，参数决定填进去的字。
 * 宿主 locale 系统给的 `props.t` 自己会填；这里的函数是**客户端自己的那条兜底路**在用。
 *
 * 取不到的名字保持原样（宁可让用户看到一个 `{modifier}`，也不要一句读不通的空）。
 *
 * @param {string} text - 字典里那句原文。
 * @param {object} [params] - 参数表；非对象时原样返回。
 * @returns {string} 填好的句子。
 */
export function interpolate(text, params) {
  if (params === undefined || params === null || typeof params !== 'object') return String(text)
  return String(text).replace(/\{(\w+)\}/g, (whole, name) => {
    const value = params[name]
    return value === undefined || value === null ? whole : String(value)
  })
}

/**
 * 客户端自己的兜底取词函数（`(key, params) => 句子`）。
 *
 * 以前三个组件里各写了一遍 `(key) => zh[key] ?? key` —— 那个形状**接不到第二个参数**，
 * 于是宿主没给 `props.t` 时，带参数的句子会原样显示成「不认识的修饰键：{modifier}。」。
 * 现在三处都 import 这一个函数：键找不到仍退回键名（照旧），参数会真的填进句子。
 *
 * @param {string} key - 字典键。
 * @param {object} [params] - 要填进句子的参数。
 * @returns {string} `zh` 里那句（填好参数），没有该键时是键名本身。
 */
export function zhTranslate(key, params) {
  return interpolate(zh[key] ?? key, params)
}

/**
 * 识别语言的展示名怎么查（批次 22-2，docs §8.65）。
 *
 * 改前这里是一张**只有中文**的表（`{ auto: '自动识别', zh: '中文（普通话）', ... }`），
 * 英文界面打开语言下拉看到的还是中文。现在表里存的是 i18n 键，句子在中英文典里各一份。
 * 六个取值就是契约里的 `ASR_LANGUAGES`；词表外的值仍按老行为原样返回（那是用户/宿主自己写的代码，
 * 不是一句要翻译的话）。
 */
export const LANGUAGE_LABEL_KEYS = Object.freeze({
  auto: 'langAuto',
  zh: 'langZh',
  en: 'langEn',
  yue: 'langYue',
  ja: 'langJa',
  ko: 'langKo',
})

/**
 * 把语言代码转成展示名。
 * @param {string} code - 语言代码（契约值，见 `src/shared/config-vocab.js` 的 `ASR_LANGUAGES`）。
 * @param {(key: string, params?: object) => string} [t] - 取词函数；没传时用客户端自己的中文兜底。
 * @returns {string} 展示名；词表外的代码原样返回。
 */
export function languageLabel(code, t) {
  const translate = typeof t === 'function' ? t : zhTranslate
  const key = String(code ?? '').trim()
  const i18nKey = LANGUAGE_LABEL_KEYS[key]
  return i18nKey ? translate(i18nKey) : key
}

/**
 * 音色展示名怎么查（批次 22-2）。
 *
 * 上游那 24 个短名（`zh-CN-XiaoxiaoNeural`、`Microsoft Zira Desktop`、`cmn`……）是**契约值**，
 * 展示名才是话。改前这张表只有中文，英文界面选音色时读不懂。
 * 词表外的音色（宿主新加的、用户手填的）原样返回短名，不丢信息 —— 这条行为没变。
 */
export const VOICE_LABEL_KEYS = Object.freeze({
  'zh-CN-XiaoxiaoNeural': 'voiceXiaoxiao',
  'zh-CN-XiaoyiNeural': 'voiceXiaoyi',
  'zh-CN-YunjianNeural': 'voiceYunjian',
  'zh-CN-YunxiNeural': 'voiceYunxi',
  'zh-CN-YunxiaNeural': 'voiceYunxia',
  'zh-CN-YunyangNeural': 'voiceYunyang',
  'zh-CN-liaoning-XiaobeiNeural': 'voiceXiaobei',
  'zh-CN-shaanxi-XiaoniNeural': 'voiceXiaoni',
  'zh-HK-HiuGaaiNeural': 'voiceHiuGaai',
  'zh-HK-HiuMaanNeural': 'voiceHiuMaan',
  'zh-HK-WanLungNeural': 'voiceWanLung',
  'zh-TW-HsiaoChenNeural': 'voiceHsiaoChen',
  'zh-TW-HsiaoYuNeural': 'voiceHsiaoYu',
  'zh-TW-YunJheNeural': 'voiceYunJhe',
  'Microsoft Huihui Desktop': 'voiceHuihui',
  'Microsoft Zira Desktop': 'voiceZira',
  // macOS say 语音
  Tingting: 'voiceTingting',
  Meijia: 'voiceMeijia',
  Sinji: 'voiceSinji',
  'Yu-shu': 'voiceYuShu',
  'Li-mu': 'voiceLiMu',
  // Linux espeak-ng 语音
  cmn: 'voiceCmn',
  'cmn-latn-pinyin': 'voiceCmnPinyin',
  yue: 'voiceYue',
})

/**
 * 把音色短名转成展示名。
 * @param {string} name - 上游音色短名。
 * @param {(key: string, params?: object) => string} [t] - 取词函数；没传时用客户端自己的中文兜底。
 * @returns {string} 展示名；词表外的音色原样返回短名。
 */
export function voiceLabel(name, t) {
  const translate = typeof t === 'function' ? t : zhTranslate
  const key = String(name ?? '').trim()
  const i18nKey = VOICE_LABEL_KEYS[key]
  return i18nKey ? translate(i18nKey) : key
}

/**
 * 模型档位 id → 展示名键（批次 22-3-1，docs §8.66）。
 *
 * id 是契约值（`src/host/model-catalog.js` 的 `MODELS` / `TTS_MODELS`），面板、下载列表、
 * `/diagnostics` 都拿它当身份；这里只管「界面上怎么称呼它」。
 */
export const MODEL_LABEL_KEYS = Object.freeze({
  sensevoice: 'modelSensevoice',
  'zipformer2-zh': 'modelZipformer2Zh',
  'whisper-tiny': 'modelWhisperTiny',
  'whisper-base': 'modelWhisperBase',
  'whisper-small': 'modelWhisperSmall',
  'whisper-medium': 'modelWhisperMedium',
  'whisper-turbo': 'modelWhisperTurbo',
  'whisper-large-v3': 'modelWhisperLargeV3',
  'vits-melo-zh_en': 'modelVitsMeloZhEn',
})

/**
 * 把模型档位 id 转成展示名。
 *
 * 词表外**原样返回 id**（同 `voiceLabel` 的裁定）：目录新加一档而字典还没跟上时，
 * 界面上看到的是一个读得出身份的 id，不是一句编的「未知模型」。
 * 漏登记由 `test/i18n-status-line.test.mjs` 那条「目录里每个 id 中英两句都得有」判红，
 * 不靠这句文案兜底。
 * @param {string} id - 档位 id。
 * @param {(key: string, params?: object) => string} [t] - 取词函数；没传时用客户端自己的中文兜底。
 * @returns {string} 展示名。
 */
export function modelLabel(id, t) {
  const translate = typeof t === 'function' ? t : zhTranslate
  const key = String(id ?? '').trim()
  const i18nKey = MODEL_LABEL_KEYS[key]
  return i18nKey ? translate(i18nKey) : key
}

/**
 * 合成引擎那一行下拉的展示名（批次 22-2）。
 *
 * 引擎 id 是契约值（`src/shared/config-vocab.js` 的 `TTS_ENGINES`），后面括号里那句
 * 「音质好，需联网」是话 —— 改前它手写在面板组件里，所以英文界面这四项仍是中文。
 * `local` 独有两句话：平台支不支持本地系统语音是运行期事实，两种情形要说的不是一句。
 * 词表外的 id（脏配置、未来新增）走 `engineOptionUnknown` 那句，不把 id 显示给用户。
 */
export const TTS_ENGINE_OPTION_KEYS = Object.freeze({
  online: 'engineOptionOnline',
  neural: 'engineOptionNeural',
  local: 'engineOptionLocal',
  sovits: 'engineOptionSovits',
})

/**
 * @param {string} engine - 引擎 id。
 * @param {(key: string, params?: object) => string} t - 取词函数。
 * @param {boolean} [localSupported] - 当前平台是否支持本地系统语音（只影响 `local`）。
 * @returns {string} 选项那一句。
 */
export function ttsEngineOptionLabel(engine, t, localSupported = true) {
  const translate = typeof t === 'function' ? t : zhTranslate
  const id = String(engine ?? '').trim()
  if (id === 'local' && !localSupported) return translate('engineOptionLocalUnsupported')
  const i18nKey = TTS_ENGINE_OPTION_KEYS[id]
  return i18nKey ? translate(i18nKey) : translate('engineOptionUnknown')
}

/**
 * 空闲释放档位那一句（批次 22-2）。
 *
 * 档位数字来自 `IDLE_RELEASE_OPTIONS`（契约），这里只管「这个数字怎么说」：
 * 0 是「永不释放」，整小时的按小时说，其余按分钟说 —— 分支只看数字，不看语言，
 * 所以中英文都读得通（60 → 「1 小时」/ "1 hour"）。
 *
 * @param {number|string} minutes - 档位值（分钟）。
 * @param {(key: string, params?: object) => string} t - 取词函数。
 * @returns {string} 选项那一句。
 */
export function idleReleaseLabel(minutes, t) {
  const translate = typeof t === 'function' ? t : zhTranslate
  const value = Number(minutes)
  if (Number.isFinite(value) && value > 0) {
    // 整小时的按小时说（60 → 「1 小时」），其余按分钟；这个分支只看数字，不看语言。
    return value % 60 === 0
      ? translate('idleReleaseInHours', { hours: String(value / 60) })
      : translate('idleReleaseInMinutes', { minutes: String(value) })
  }
  // 0 表示「一直留着」；拿不到数（空串/NaN）也按这句显示，
  // 因为面板那边已经把非法值夹回档位了，这里不该再编一个「NaN 分钟」出来。
  return translate('idleReleaseNever')
}


/**
 * 运行环境自检每一行的引擎名（批次 22-3-2，docs §8.67）。
 *
 * 定义域是契约词表 `TTS_ENGINES`（`src/shared/config-vocab.js`），不是手抄的四个 id；
 * 判据拿它逐 id 核对「中英各有一句」（`test/i18n-status-line.test.mjs` 判据 18）。
 *
 * **为什么不复用 `ttsEngineOptionLabel`**：那张表是下拉框的选项文案，
 * 括号里带「音质好，需联网」这种选购说明；自检每一行后面已经跟了一句探测结果，
 * 名字再来一长串就变成两句话挤在同一行。两个渲染点、两种长度，各自一张表 ——
 * 这和批次 22-2 给 `modelLabel` / `MODEL_LABEL_KEYS` 定下的分工一致。
 *
 * 宿主那三行的 `label`（'Edge 在线' 这些）客户端不再读：同一个引擎有两个展示名
 * 正是改前英文界面出中文的原因，删掉读的那一头才算把源头掐了。
 */
export const ENV_ENGINE_LABEL_KEYS = Object.freeze({
  online: 'envEngineOnline',
  local: 'envEngineLocal',
  neural: 'envEngineNeural',
  sovits: 'envEngineSovits',
})

/**
 * @param {string} id - 引擎 id（`/tts/env` 每一行的 `id`）。
 * @param {(key: string, params?: object) => string} [t] - 取词函数；没传时用客户端自己的中文兜底。
 * @returns {string} 行名；词表外的 id 走 `envEngineUnknown` 那句（把 id 显示出来，因为它读得出身份）。
 */
export function envEngineLabel(id, t) {
  const translate = typeof t === 'function' ? t : zhTranslate
  const key = String(id ?? '').trim()
  const i18nKey = ENV_ENGINE_LABEL_KEYS[key]
  return i18nKey ? translate(i18nKey) : translate('envEngineUnknown', { id: key })
}

/**
 * 本地推理运行时的种类（批次 22-3-2）。
 *
 * 宿主回的是契约值 `native` / `wasm`（`probeSherpaRuntime()` 的 `kind`），
 * 界面上要说「原生加速 / WASM 版」—— 一个词也是话，所以它同样必须有中英两句，
 * 不能让宿主那句中文借「参数」这条路回到界面里。词表外的值原样显示：
 * 未知种类仍然是个读得出的技术值，不是一句编造的「未知运行时」。
 *
 * @param {string} kind - `native` | `wasm` | 别的。
 * @param {(key: string, params?: object) => string} [t] - 取词函数。
 * @returns {string} 展示名。
 */
export function envRuntimeLabel(kind, t) {
  const translate = typeof t === 'function' ? t : zhTranslate
  const value = String(kind ?? '').trim()
  if (value === 'native') return translate('envRuntimeNative')
  if (value === 'wasm') return translate('envRuntimeWasm')
  return value
}
