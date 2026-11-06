# 技术参考

这份文档讲插件内部怎么运转：宿主接口清单、事件消息的格式、识别与朗读的完整过程、
代码结构与构建产物、配置项之间的配合关系、诊断字段里那些原因码的含义。

使用者不用读它，用法看 [README.md](../README.md)；改这个插件要守什么规矩看
[maintainer-notes.md](maintainer-notes.md)。

> **这份文档从哪来**：内容是原 README 第 9 节（技术参考 + 配置生效条件矩阵）搬过来的，
> 章节号对照如下 —— 原 §9.1 → 本文第 1 节，原 §9.2 → 第 2 节，原 §9.3 → 第 3 节，
> 原 §9.4 → 第 4 节，原 §9.5 → 第 5 节，原 §9.6 → 第 6 节，原「配置项的配合关系」→ 第 7 节。
> `docs/architecture-modernization.md` 那份批次记录里写「README §9.x」的地方，按这个对照读。
> 只有第 8 节是这次搬动时新写的 —— 那五种原因原先散在批次记录里，没有一份汇总的表格。

---

## 1. 宿主接口


全部路由带 `/dsh-voice-typing` 前缀。

> 本表是**给维护者的完整清单**，不是抽样：它和 `cordis.patch.yml` 文件头那份（装机的人在宿主配置里看到的
> 同一张表）都由 `test/route-contract.test.mjs` 的 I 段拿**真装出来的注册表**双向核对 ——
> 少一条、多一条、名字写歪、表格换了标题导致解析失配，都会红并给名字（批次 25，docs §8.73）。
> 这条判据读的**就是本文这一节**（它按小节标题定位、按表格第一列取路由），所以：
> 改标题写法或把这一节搬走时，记得同时改 `test/route-contract.test.mjs`。
> `src/host/index.js` 文件头原来还抄了第三份，它没有判据管着，四条路由就是先后漏在那儿的，批次 25 删掉换成了指针。

| 路由 | 说明 |
| --- | --- |
| `POST /transcribe` | 请求体为 16 kHz 单声道 f32 PCM，返回 `{text, model, language, hotwords, speech}`（最终稿；`speech` 表示是否检测到人声）。可选请求头 `x-dsh-voice-language: zh\|en\|yue\|ja\|ko` 覆盖本次识别语言（全局语音待机用，非法值退回当前生效语言） |
| `POST /asr-stream?sessionId=…` | 送入增量 PCM，返回当前实时文字（流式 zipformer2；模型不可用时返回 `{unavailable:true, reason}`）。出错时的会话语义分两类：**解码侧真出事**（识别器抛错、客户端走了）→ 丢弃该会话的流状态，下一轮从零开始（不留上一句的残留）；**请求级拒绝**（4xx，如 `readBody` 的 413 超限）→ 只回执，不动会话状态（一块过大的分片不该把正在说的这句抹掉）。每一次丢弃都带原因记进 `/diagnostics.streamDiscard`，五种原因见[第 8 节](#8-实时文字被丢弃的五种原因)。见 docs §8.53 / §8.58 |
| `POST /asr-stream/reset?sessionId=…` | 结束该会话的流式解码并丢弃状态 |
| `GET /asr-ready` | 识别模型是否已**下载 + 已加载**（客户端开麦前先问；首次加载要等多久随档位与磁盘变，所以不标具体秒数）。没就绪时 `reason` 给的是**原因码**（四个取值见 `src/shared/asr-readiness.js`），**不是句子** —— 界面那句话由客户端按当前语言查 i18n 出，见 `src/client/pure/asr-ready-text.js` 与 docs §8.60 |
| `POST /asr-warmup` | 确保识别模型真的加载好（没就绪就等到就绪）。`reason` 同样是原因码，同上 |
| `GET /tts?text=…` | 文字 → 音频（在线出 MP3，本地系统语音与本地神经模型出 WAV）。**在线失败自动回退到本地系统语音**，响应头 `x-tts-engine-fallback: local` 标出。四个引擎各自都有**早于客户端 `TTS_TIMEOUT_MS` 的宿主侧上限**（含神经那条「线程活着但不回话」的 20 秒），谁把顺序改反了都会有判据红 —— 见 `docs/maintainer-notes.md` 的「跨端时间契约」 |
| `GET /voices?engine=online\|local` | 音色列表（在线 Edge 列表 / 本地系统语音） |
| `GET /tts/env` | 合成运行环境自检（引擎可用性、平台能力）。`engines[]` 每行是 `{id, available, reason, params, detail, note}`：`reason` 是 `src/shared/tts-env-reasons.js` 里的**原因码**（十四取一），`params` 只带那几个契约值/机器事实（版本号、音色短名、可执行文件路径、平台名、音色数量、档位 id、运行时种类），**界面那句话由客户端字典出**，见 `src/client/pure/tts-env-reason-text.js` 与 docs §8.67。`detail` 是宿主自己写的整句原文，**只给 `/diagnostics` 与装机排查看**，面板不读它；行名也不读宿主的 `label`（那个字段本批已从响应里删掉，见 §8.67 的裁定） |
| `GET /tts/warmup` | 预热在线 TTS 连接（本地引擎没有连接概念，直接返回） |
| `GET /busy` | 助手是否正在生成。**降级用** —— 首选是 SSE 的 `assistant-busy` 事件（零延迟），SSE 断了才回退到轮询 |
| `GET /diagnostics` | 诊断数据（统计、忙状态、各引擎合成失败计数、下载进度、**朗读调度器状态** `readAloud[]`：`mode/outstanding/acks/emitted/stalls/lagMs/playingMs/backlogMs/budgetMs/streaming/skim/trimmed/trimmedParagraphs/trimmedSentences/truncatedParagraphs/awaitingFlush`，以及 `readAloudScheduler` 的 `rejectedAcks/lastRejectedAck`），**全局语音**的 `voicePrompt`（回退注入 `count/failures/lastAt/lastError`）、`uiActions`（最近 50 条界面动作 `{at,requestId,action,ok,error}`，不含参数正文）、`hotkeyHelper`（`enabled/status/reason/platform/tokenReady/detail`，不含 token；`reason` 是 `src/shared/hotkey-reasons.js` 里的原因码，`detail` 是给排查看的原文、不进界面，见 docs §8.61）、**待机 wake-miss** 的 `wakeMiss`（`count/window/events[]`：`{at,text,wake}`，最近 `window` 条听到但没匹配上唤醒词的原文，`count` 是不裁剪的总次数；另有 `byWake[]`：`{wake,count,texts:[{text,count}]}`，把**同一份窗口**按当时的唤醒词分好组、组内按原文去重计数，改过唤醒词之后不用手工分组——分母是窗口而不是 `count`，见 docs §8.74）、**流式会话丢弃**的 `streamDiscard`（`count/window/events[]`：`{at,sessionId,reason,modelId,idleMs}`，`reason` 的五种含义见[第 8 节](#8-实时文字被丢弃的五种原因)；`count` 同样不裁剪，`events` 只留最近 `window` 条且留的是最新的）。**不在 `/config` 里** —— 混进去会被客户端当配置回传 |
| `POST /voice-session` | 客户端心跳与诊断上报（诊断用）：`{sessionId?, client?}`。**只有真的存在 `sessionId` 这个键**才改「边生成边读」的会话指针（值为空 → 清空），所以纯诊断上报一律不带这个键——发送尝试（带目标会话 id）之外的两类上报（`wake-miss`：待机时听到但没匹配上唤醒词的那句；`no_session`：一个会话都没拿到）都**不写这个键**，写空串等于用一句环境闲聊替用户清掉会话指针（`docs/architecture-modernization.md` §8.54）。composer 那只麦克风按钮的心跳同理：没拿到会话 id 的那几次上报也不写这个键，写空串就是每 1.5 秒清一次（§8.55）。`client.kind === 'capture-path'`（浮层这次开麦实际用上的采集路径与回退原因）落进 `stats.capture`，其余落 `stats.client`（两者互不覆盖，`clientCount` 一视同仁计数）。`client.via === 'wake-miss'` 的那条**另外**再进 `/diagnostics.wakeMiss` 的环形缓冲（原文截到 `WAKE_MISS_TEXT_LIMIT` 字，`wake` 取宿主当前配置而不是客户端自报）—— `stats.client` 是单格覆盖，攒不出「哪些说法被听成了什么」的分布 |
| `POST /voice-prompt` | 全局语音的**回退注入**（客户端调用）：客户端优先用 `session.prompt()` 直发，失败时才把 `{sessionId, text, mode, requestId?}` 交给宿主。宿主**只在 `sessionController` 不可用时**才回退 `agents.followup/steer`；`sessionController.prompt` 抛错 → 直接 502（不再二次注入，避免同一条语音入队两遍）。`text` trim 后 ≤4000 字；`requestId` ≤200 字符，用于幂等去重（客户端每条识别文本生成一个，直发与回退共用）。参数非法 → 400 |
| `POST /ui-action-result` | 渲染器执行完 `ui-action` 后的回执（客户端调用）：`{requestId, ok, value?, error?}`。未知/已过期 `requestId` → 404（不静默丢弃）。多窗口时只有认领成功的窗口会回执，其它窗口静默跳过 |
| `POST /ui-action-claim` | UI 动作**认领**（渲染器调用；JSON-only，缺 content-type 或非 JSON → 415）：`{requestId, clientId}` → 200 `{claimed:true|false}` / 400 `invalid_requestId`/`invalid_clientId` / 404 未知或已超时/已回执。第一个 client 认领成功（同一 client 重试幂等 true），其它窗口得到 false 并静默跳过 —— SSE `ui-action` 是广播，没有认领就会多窗口重复执行 |
| `POST /hotkey` | 系统级热键回调（**仅 Windows 路径**）：**唯一调用方是 `src/host/global-hotkey-helper.js` 拉起的 PowerShell 额外进程**（客户端不直接调）；请求头 `x-dsh-voice-token` 鉴权，成功广播 SSE `global-hotkey`；token 不对或 helper 未启用 → 403。macOS/Linux 的 native 热键在宿主进程内直接广播，不走 HTTP |
| `GET/POST /config` | 读写生效配置。POST 是严格校验，不过就回 400 `{ok:false, errors:[{key, reason, detail}]}`：`reason` 是 `src/shared/config-error-codes.js` 里的**原因码**（不是句子），`detail` 是宿主原文（只进响应体与日志，**不进界面**）；红字那两半（字段名 + 句子）都由客户端字典出，见 `src/client/pure/config-error-text.js` 与 docs §8.62。请求体超过 1 MB 走 413，同一份信封、码为 `body-too-large` |
| `GET /models` | 模型档位清单与本地状态（识别 + 合成） |
| `POST /model` | 下载/准备指定档位。202 起下载转后台（进度与结果走 SSE）。失败回执也带原因码：404 `{error, reason:'unknown-model', params:{model}}`、409 `{error, reason:'hosted-unavailable', params:{model}}` —— `reason` 取自 `src/shared/model-download-reasons.js`（十个码），`error` 是宿主原文、只给 `/diagnostics` 与装机排查看，界面那句由客户端字典出（发端批次 22-4-1 见 docs §8.70，收端批次 22-4-2 见 §8.71） |
| `GET /stream` | SSE：`turn-begin` / `turn-end` / `call-end` / `sentence` / `assistant-busy` / `model-progress` / `model-ready` / `model-error` / **`ui-action`** / **`global-hotkey`**。`model-error` 的载荷是 `{id, kind, reason, params, error}`：`reason` 是 `src/shared/model-download-reasons.js` 里的原因码（拿不到码的异常归 `failed-unknown`），`error` 是宿主那句原文（只进诊断与 console，不进界面） |
| `POST /reading-ack` | 客户端朗读进度回报（流控）。请求体 `{sessionId, turnId, count, durationMs?}`（`durationMs` = 这一句真实音频时长，仅 count=1 时用，宿主据此精确计「正在播放的剩余时长」）：每**开始播放**一句回一条，宿主随即补发下一句。收不到 ack 时宿主自动降级为旧的 400ms 时间窗口节奏（老客户端可用） |

## 2. SSE 事件信封

所有 SSE 事件的 `data` 都是同一个信封，业务字段**平铺**在里面：

```
event: sentence
data: {"v":3,"seq":12,"ts":1735000000000,"sessionId":"s1","text":"你好","turnId":"turn-x","index":0,"para":0,"paraStart":true}
```

| 字段 | 含义 |
| --- | --- |
| `v` | 协议版本（当前 3；v3 之后只做**只增不改**的字段扩展，同包同版本一起加载） |
| `seq` | 全局单调递增。**跳号 = 丢了事件** |
| `ts` | 事件产生时刻（epoch 毫秒） |
| `sessionId` | 归属会话；`null` 表示全局事件（如模型下载进度） |

> `call-end` 只表示「这一次 `llm/stream` 调用结束」，**不表示该次调用的句子已经全部发出**：
> `flow`（流控）模式下剩余句子仍会按客户端 ack 逐句补发，所以 `call-end` 之后仍可能出现 `sentence`。
> 真正的「一轮结束」是 `turn-end`（下一轮开始时广播上一轮）。

`sentence` 事件另有业务字段：`text`（要念的句子）、`turnId`（属于哪一轮）、
`index`（本轮第几句，客户端据此去重）、`para`（自然段序号，一轮内从 0 递增）、
`paraStart`（是否该段第一个发出的片段 —— 客户端永不丢弃它）。

客户端据此可以：按 `sessionId` 过滤（多会话不串音）、按 `seq` 发现丢事件、
按 `turnId` 精确到某一轮做静音。

**全局语音 / AI 界面操控新增事件**（业务字段同样平铺在信封里）：

| 事件 | 业务字段 | 含义 |
| --- | --- | --- |
| `ui-action` | `requestId`、`sessionId`、`actions:[{action, params}]`、`confirm`、`expiresAt?` | 宿主 `voice_ui` 工具下发的界面动作；`confirm` 是宿主算好的**生效值**（只读动作永远 `false`）。`expiresAt`（epoch ms，可选）与宿主工具超时**同一个 deadline**：渲染器据此拒绝迟到的确认（回执 `expired`，不执行）。渲染器执行后必须 `POST /ui-action-result` 回执 |
| `global-hotkey` | `action`（`toggle`） | 系统级热键 helper 进程 `POST /hotkey` 后广播；`sessionId` 为 `null`（全局事件）。渲染器据此切换浮层麦克风 |

> v2 之后 `ui-action` 里的 `action` 可能是 14 种之一（8 个语义动作 + 6 个 a11y 原语）；渲染器执行前仍用同一份 UI 动作协议校验，`ref` 只对最近一次快照有效。
>
> 多窗口：执行前必须先 `POST /ui-action-claim` 认领（`{requestId, clientId}`）；认领失败/404/网络错误一律静默跳过（不回执、不执行），由认领成功的那个窗口完成确认/执行/回执。

## 3. 识别链路

浏览器采集 → AudioContext 原始 float32 → 线性重采样到 16 kHz → 上传宿主 →
工作线程里用 sherpa-onnx 识别（SenseVoice / Whisper / Zipformer2，按设置选择）→
Silero VAD 切段（灵敏度 0.5 / 最短语音 0.25 s / 静音断句 0.5 s / 单段最长 20 s，
音点前置补偿 0.3 s）→ 自定义词表与语气词后处理 → 写入草稿并发送。

识别跑在独立工作线程（`lib/asr-worker.js`）里，主线程不会被 0.5~3 秒的同步推理卡住。
本地神经合成同理，放在 `lib/tts-worker.js` 里跑。

> ⚠️ **Zipformer2 是流式模型，必须用 `OnlineRecognizer` + `isReady`/`inputFinished`
> 的解码方式。** 用 `OfflineRecognizer` 配 transducer 会让 sherpa 的原生代码
> **直接终止进程**（整个桌面应用退出）。

## 4. 诊断接口

| 接口 | 用途 |
| --- | --- |
| `GET /dsh-voice-typing/config` | 当前配置（诊断/统计走 `/diagnostics`） |
| `GET /dsh-voice-typing/voices?engine=online\|local` | 音色列表 |
| `GET /dsh-voice-typing/tts?text=…` | 合成测试 |
| `GET /dsh-voice-typing/tts/warmup` | 预热连接 |
| `GET /dsh-voice-typing/busy` | 助手是否在生成 |
| `GET /dsh-voice-typing/stream` | SSE：sentence / turn-begin / turn-end / call-end / assistant-busy / model-* 事件 |

浏览器控制台里 `__DSH_VOICE_DEBUG__()` 能看到 `ttsFailures`、`playSkipped` 等运行时状态。

## 5. 配置文件位置

底层配置落盘在 `~/.dsh/voice-typing.json`，设置面板是它的编辑器（单一数据源）。

## 6. 代码结构

**目录规矩**：`src/` 放原始代码，`lib/` 只放构建产物（`npm run build` = 客户端 + 宿主两端），
发布包 `files` 里只有 `lib`。宿主侧的产物只有四个文件，判据是「有代码按文件路径加载它」：
`lib/index.js`（宿主按 `main` 加载）、`lib/client.js`（按 `exports["./client"]`）、
`lib/asr-worker.js` 与 `lib/tts-worker.js`（各被一个 Worker 按路径加载）。

> **`lib/` 不在版本库里**（批次 23，`docs/architecture-modernization.md` §8.69）。
> 克隆或 `git pull` 之后要先 `pnpm install && pnpm run build`，仓库里才会有这四个产物 ——
> 开发机上 DSH 是**符号链接**指向这份工作树（`~/.dsh/profiles/desktop/node_modules/dsh-voice-typing`），
> 所以「拉了代码没构建」= 插件还在跑上一次那份产物。
> `pnpm test` 已经会在跑测试前先构建两端，`npm publish` / `npm pack` 由 `package.json` 的 `prepack` 兜住。
下表里凡是 `src/host/` 的都是**手写源码**，它们被内联进 `lib/index.js`，不再单独存在于 `lib/`。

| 文件 | 职责 |
| --- | --- |
| `src/host/index.js` | 宿主侧：HTTP 路由、配置读写、模型管理、朗读调度（产物是 `lib/index.js`，自包含单文件，勿手改） |
| `lib/client.js` | 浏览器侧：麦克风按钮、VAD 断句、草稿管理、播放队列、设置面板、**全局语音浮层 + UI 动作执行器（含 v2 a11y 快照/点击/输入/按键）**（构建产物，勿手改；源码在 `src/client/`） |
| `src/host/ui-action-protocol.js` | **UI 动作协议（宿主侧入口）**：实现住在 `src/shared/ui-action-protocol.js`（单源），本文件只做显式具名转发。这条判据两端**常数为零**（动作白名单、参数上限、确认策略两端必须一模一样），所以没有注入步骤。动作枚举、每动作参数白名单/长度上限、确认策略、`ui-action` 载荷与回执校验的**规则**见 shared 文件 |
| `src/host/global-hotkey-helper.js` | **跨平台系统级热键 helper**：Windows 生成 PowerShell `RegisterHotKey` 脚本并拉起/回收子进程（`/hotkey` 的 token 由它生成）；macOS/Linux 动态加载可选依赖 `uiohook-napi`、在宿主进程内监听 keydown 并直接广播 SSE（不走 HTTP）。只在 `globalVoice && globalHotkeyHelper` 时启动。加速键里的修饰键写法**不自己列名单**，从 `src/shared/key-modifiers.js` 现取派生（4.3c），本文件只保留「规范名 → Win32 位」那一层；主键的取值也不再列表，改问 `src/shared/key-names.js`（4.3d，本文件因此 781 → 705 行，`VK_BY_KEY` + `NATIVE_KEY_NAMES` 两张共 46 条的手抄表删掉了）。Windows 子进程 stdout 输出 READY 才把状态从 `starting` 置为 `enabled`（REGISTER_FAILED/提前退出 → `failed`）；退出/失败/dispose 都会删除含 token 的临时 `.ps1` |
| `src/host/config-schema.js` | **配置项的清洗规则（宿主侧入口）**：`validateConfigPatch`（POST /config 严格校验）、`sanitizeConfig`（加载时尽力清洗）、`normalizeTtsEngine`。**字段规则不在这里** —— 类型/枚举/范围/长度上限/默认值住在 `src/shared/config-spec.js`（单源），本文件 import 后按原有名字再导出（历史导出面不变）；**枚举词表**在 `src/shared/config-vocab.js`，同样是 import 再具名导出，两端拿到的是同一个数组对象 |
| `src/host/asr-worker.js` → `lib/asr-worker.js` | 识别工作线程（SenseVoice / Whisper / Zipformer2），产物由 Worker 按 `new URL('./asr-worker.js', import.meta.url)` 加载 |
| `src/host/gate.js` | **流式门限状态机（宿主侧入口）**：`/asr-stream` 的「这一帧要不要喂给解码器」判定。算法不在这里 —— 住在 `src/shared/gate.js`（单源），本文件只做**宿主常数注入**（`DEFAULT_GATE_OPTS`：clamp 0.01/0.045、连续 3 帧才算说完）并保留公共导出面。浏览器侧 `src/client/pure/gate.js` 用的是同一个模块、**不同的常数**，两端由同一张用例表（`test/fixtures/gate-cases.mjs`）驱动 |
| `src/host/tts-worker.js` → `lib/tts-worker.js` | 本地神经合成工作线程（sherpa-onnx VITS），产物由 Worker 按 `join(HERE, 'tts-worker.js')` 加载（HERE 就是 `lib/`） |
| `src/host/edge-tts.js` | Edge 在线朗读（共享连接 + 串行锁） |
| `src/host/local-tts.js` | 跨平台系统语音（Windows SAPI / macOS say / Linux espeak-ng） |
| `src/host/neural-tts.js` | 本地神经 TTS 的宿主侧封装（线程管理、预加载、释放）。合成跑在另一条线程里，线程有四种结束方式：回包 / `error` / `exit` / **活着但不回话**（卡在一次不返回的 native 调用里）—— 前三条由事件叫醒等待者，第四条靠 `NEURAL_WAIT_TIMEOUT_MS`（20 秒）到点给一句人话并把卡住的线程拆掉（不拆的话后面每一句都要再等满这个上限）。预加载与合成共用同一条等待语义（`askTtsWorker`），待回包表**按线程分桶**（旧线程晚到的 `exit` 不许把新线程上正在等的一句误伤掉），那条等待定时器 `unref`（不按住宿主进程），`disposeNeuralTts` 先给回执再拆线程。判据在 `test/neural-worker-exit.test.mjs`（真起子进程 + 永不回话的替身线程 + 驱动自己的 8 秒看门狗） |
| `src/host/sovits-tts.js` | **外部 GPT-SoVITS 引擎客户端**：把每句文本 POST 到用户自己的 `api_v2` 服务；不内置模型、不做克隆、失败不回退 |
| `src/host/model-catalog.js` | 模型档位定义、并行分片下载、缓存、SHA256 校验 |
| `src/host/text-rules.js` | 词表解析、替换、语气词清理、输出规范化 |
| `src/host/read-aloud-policy.js` | **朗读发射规则**（纯函数）：时间窗口、单句上限、`splitLongText`（切成完整句子，绝不断成半句）、`packWindowSentences`（一批取几句，不合并成长文本） |
| `src/host/paragraph.js` | **自然段落切分**（纯函数）：空行 / 列表项 / 标题 / 引用为段落边界，`splitParagraphs` 支持流式累积（末尾未完成段进 `rest`） |
| `src/host/speech-clean.js` | 文本清洗与分句（纯函数）：`stripForSpeech`（Markdown → 纯文本 + SSML 转义）、`splitSentenceParts` |
| `src/host/read-aloud-scheduler.js` | **朗读调度器**：按自然段落收集、按客户端 ack 的播放进度发句（流控），无 ack 时降级为时间窗口；事件带 `para` / `paraStart` |
| `src/host/fence-filter.js` | **流式代码围栏过滤器**（纯函数）：跨 chunk 识别 ``` / ~~~ 围栏（围栏标记本身可能被 chunk 边界切开），围栏内内容一个字都不交给朗读 |
| `src/host/tts-env.js` | 运行环境自检 |
| `src/shared/*.js` | **双端单源的判据**：算法只写一份，宿主 `src/host/*.js` 直接 `import`（构建时内联进产物），浏览器侧经 `src/client/pure/*` 引入后由构建合并进产物。**约束比 `pure/` 更紧**：纯 ESM、零浏览器全局、**零 Node API**（`process` / `require` / `node:` / `__dirname`）、零 React、不反向引用 `main.js`。两侧**需要不同常数**的（门限）用 `createXxx(defaults)` 注入，常数放各自入口；两端必须一样的（UI 动作协议）就直接放 shared，入口纯转发。由 `test/bundle-sync.test.mjs` 机械守卫（含「同一判据不许有第二份实现」） |
| `src/shared/gate.js` | 流式门限状态机的**唯一**实现：`createGate(defaults)` 造出 `advanceGate(state, level, opts)` 纯函数 + `INITIAL_GATE_STATE`（底噪起点 0.004，冻结）。宿主与浏览器两侧各自注入常数 |
| `src/shared/ui-action-protocol.js` | UI 动作协议的**唯一**实现：14 个动作的白名单/参数上限/确认策略，`validateUiAction`、`describeUiAction`、`buildUiActionPayload`（含 `expiresAt`）、`isUiActionExpired`、`validateUiActionResult`。两端**共用同一组常数**（安全边界不许一端宽一端严），所以这个模块没有注入步骤，两个入口纯转发 |
| `src/shared/config-vocab.js` | 配置枚举词表的**唯一**来源（冻结数组）：TTS 引擎、识别语言、GPT-SoVITS 语言、实时字方式、交互模式、注入模式、Edge 输出格式、词表条数/单条字符上限。两端入口只做转发；`main.js` 的下拉直接用这些数组，所以加一个取值只改这一处。**不放**浏览器侧表现层档位（语速/音调/音量、空闲释放档位） |
| `src/shared/key-modifiers.js` | **修饰键词表的唯一来源**（4.3b，4.3c 补齐第三条链路）：11 种写法（`ctrl/control/alt/option/shift/meta/cmd/command/win/windows/super`）→ 四个规范名，加 `KEY_MODIFIER_NAMES`、`STRONG_KEY_MODIFIER_NAMES`（单字母主键必须配的强修饰键）、`canonicalModifier(token)`、`keyModifierSpellings()`（规范名 + 别名去重，给派生表用）。三条链路认的是同一批字 —— 窗口内匹配（`pure/shortcut.js`）、a11y 主动派发（`pure/a11y.js`）、面板的保存校验；宿主原生 helper（`src/host/global-hotkey-helper.js`）的写法表**由这里派生**，它自己只留「规范名 → Win32 位」那一层（`MOD_*` 是 `RegisterHotKey` 的知识）。`test/global-hotkey-helper.test.mjs` 2b 段逐字比两端的写法集合，加一种写法只改一端的后果当场变红。判据一句话：**校验放行的写法，匹配层必须认** |
| `src/shared/key-names.js` | **具名键词表的唯一来源**（4.3d）：一条写法（`Enter` / `Space` / `ArrowUp` / `Del`…）并排给三个环境真正要的值 —— `dom`（`KeyboardEvent.key` 的真值，**空格是 `' '` 不是 `'Space'`**，这是 DOM 规范定的）、`native`（uiohook 键名，macOS/Linux 进程内监听用）、`win`（Win32 虚拟键码，`RegisterHotKey` 用）。四个导出 `keyNameOf` / `domKeyOf` / `uiohookKeyOf` / `windowsVirtualKeyOf`；字母、数字、F1-F24 走形状规则不进表。搬之前是三条链路各一份表（a11y 20 条、helper 23 + 23 条，合计 66 条手抄）加两处「空格特判」，取值实测只差 1 条，但覆盖范围已经漂开（helper 认 `return`/`insert`/`ins`，a11y 不认）。**词表只答「写法 → 值」，不答「这条链路允不允许」**：a11y 的派发名单、helper 的 F13-F24 各自留在调用方。`windowsVirtualKeyOf` 认不出时给 `undefined` 而不是 0（拿 0 去注册会造出「开关显示已启用、实际永不触发」的热键）。`test/key-names.test.mjs`（125 条）逐字比三条链路对同一批写法的取值。见 `docs/architecture-modernization.md` §8.19 |
| `src/shared/config-spec.js` | 配置字段规则的**唯一**来源（冻结）：35 个键的 `CONFIG_SPECS`（类型 + 枚举取值 + 数值区间 + 长度上限 + 默认值 `def`），并由它派生 `CONFIG_DEFAULTS`（宿主 `DEFAULTS` 与客户端 `UI_DEFAULTS` 都**是这个对象本身**，不是抄一份）、`CONFIG_MAX_LENS`（客户端 `STRING_LIMITS` 同样直接引用）、`rangeFor(key)`（客户端夹取函数只问它要区间，自己不留数字）、`DEFAULT_SOVITS_URL`。两端默认值/上限从此不可能不一致 —— 加一个配置项 = 这里加一条 + 设置面板加一行 |
| `src/shared/asr-readiness.js` | **开麦就绪原因码的唯一来源**（批次 18，冻结）：`model-not-found`（设置里那一档在本机清单里查不到）、`not-downloaded`（文件没下齐：sha 对不上或空文件）、`loading`（下好了，识别线程还没加载进内存）、`load-failed`（预热让线程加载，线程回失败）。宿主这两条路由的 `reason` 只能从这里取值，**不给句子**；客户端查 `src/client/pure/asr-ready-text.js` 那张表按当前语言出句子。`isAsrReadyReason()` 是「这个词表外的值该走兜底」的判据，`ASR_READY_REASON_VALUES` 给完整性判据用（四个码逐个被真回出来过、且没有词表外的 reason）。**为什么要有这张表**：以前宿主直接写中文句子，客户端 `data.reason \|\| t('...')` 让宿主那句排在前面，英文界面开麦失败就弹中文。见 `docs/architecture-modernization.md` §8.60 |
| `src/shared/hotkey-reasons.js` | **系统级热键原因码的唯一来源**（批次 19，冻结）：十三个码，按「哪一步没通」分 —— 起不来的三步（`host-address-unknown` 不知道往哪报、`script-build-failed`/`script-write-failed` 脚本没落地、`spawn-failed`/`start-failed` 子进程没起来）、起来又没了（`exited-before-ready`/`exited`）、注册没成功（`register-failed`）、native 那侧（`native-unavailable`）、配置不该起（`invalid-shortcut`/`disabled-by-switch`/`no-global-voice`）、宿主被卸载（`unloaded`）。helper 的 `state().reason` 只能取这里的值或空串（空串=成功/进行中，那句由 `status` 决定），**不给句子**；句子由 `src/client/pure/hotkey-reason-text.js` 查 i18n 出。带变量的原文（组合键名、pid、退出码、系统错误）另走 `detail`，只进 `/diagnostics`。`isHotkeyReason()` 是「词表外的值该走兜底」的判据，`HOTKEY_REASON_VALUES` 给完整性判据用（十三个码逐个被真跑驱动过、且没有词表外的 reason）。**为什么要有这张表**：以前 helper 直接写中文句子并被插进设置面板的文案，英文界面显示热键失败就是中文。见 `docs/architecture-modernization.md` §8.61 |
| `src/shared/config-error-codes.js` | **配置保存失败原因码的唯一来源**（批次 20，冻结）：二十个码，按「一次保存从上到下会碰到的顺序」分五族 —— 整份请求体的四种（`body-not-json`、`body-too-large`、`patch-not-object`、`save-failed`，`key` 是空串）、按 `config-spec.js` 字段类型分的八种（`not-boolean` / `not-in-enum` / `not-a-number` / `not-integer` / `out-of-range` / `not-a-string` / `too-long` / `not-an-array`）、URL 独有的两种（`url-malformed` / `url-not-http`）、词表独有的五种（`words-too-many` / `words-empty-entry` / `words-entry-too-long` / `words-missing-correct` / `words-entry-shape`）、宿主内部写错才可能出现的 `unknown-spec-type`。`validateConfigPatch` 与 `/config` 路由的 `reason` 只能取这里的值，**不给句子**；宿主原来的整句中文搬到 `detail`，只进响应体与日志。`isConfigErrorCode()` 给「词表外的值走兜底」，`CONFIG_ERROR_REASON_VALUES` 给完备性判据用（20-1 记录的分层：schema 层真跑驱动 16 个 + 只在路由层出现的 3 个 + 无法由用户触发的 1 个）。**这里只有「违反了哪一类规则」，没有「规则是什么」** —— 类型/枚举/区间/上限仍在 `config-spec.js`，客户端按 `key` 去那份 spec 取动态值，所以本批没有参数协议。见 `docs/architecture-modernization.md` §8.62 |
| `src/shared/tts-env-reasons.js` | **运行环境自检原因码的唯一来源**（批次 22-3-2，冻结）：十四个码按三个引擎分组 —— 本地系统语音七个（`local-ready-powershell` / `local-missing-powershell` / `local-ready-say` / `local-missing-say` / `local-ready-espeak` / `local-missing-espeak` / `local-platform-unsupported`，**成功也分三套**，因为要填的参数与要人做的事都不一样）、Edge 在线三个（`online-ready` / `online-no-voices` / `online-unreachable`）、本地神经模型四个（`neural-no-tier` / `neural-missing-runtime` / `neural-model-missing` / `neural-ready`）。`/tts/env` 每一行的 `reason` 只能取这里的值，**不给句子**；`TTS_ENV_REASON_PARAMS` 是这个码**必须**带的参数名（版本号 / 音色短名 / 可执行文件路径 / 平台名 / 音色数量 / 档位 id / 运行时种类），宿主少填一个，客户端那句就露一个 `{version}`。`isTtsEnvReason()` 给「词表外的值走兜底」，`TTS_ENV_REASON_VALUES` 给完备性判据用（`test/tts-env-check.test.mjs` 拿真宿主逐个码核对「发出来的 reason 在词表内、params 的名字正好是协议那几个」）。宿主原来那句整句中文搬进 `detail`，**读者是 `/diagnostics` 与装机排查，不是界面**。**为什么要有这张表**：改前 `src/host/tts-env.js` 每行直接写中文（`可用（Windows PowerShell 5.1），默认发音人：…`），面板原样拼上去，英文界面那四行整片是宿主写的中文。见 `docs/architecture-modernization.md` §8.67 |
| `src/shared/model-download-reasons.js` | **「下载模型」原因码的唯一来源**（批次 22-4-1，冻结）：十个码分三段 —— 下载流程七个（`no-downloadable-files` / `file-failed` / `file-not-in-repo` / `chunk-failed` / `chunk-incomplete` / `merged-size-mismatch` / `sha-mismatch`，前六个在 `model-catalog.js` 的抛出点，`file-failed` 是重试跑满的兜底）、路由两个（`unknown-model` = 档位 id 不在表里、`hosted-unavailable` = 内置档位的本地文件不在位，**没有「下载」这条路**）、一个终极兜底（`failed-unknown` = 抛出来的东西压根没带码，例如文件系统错误）。`MODEL_DOWNLOAD_REASON_PARAMS` 点名每个码**必须**带的参数（档位 id / 文件名 / HTTP 状态 / 分片序号 / 字节数），`withModelDownloadReason()` 在抛出现场校验「码在表里 + 参数齐」，填错当场炸；`modelDownloadReasonOf()` 把没带码的异常归到 `failed-unknown`，于是**客户端永远不需要**读宿主那句原文当文案。**表里没有的**：`status ${res.status}`、`stalled`、单文件路径的 `sha mismatch`、`分片大小不对` —— 这四个抛点在重试的 `try` 里面，跑满轮数后外面看到的是 `file-failed`，原文只是重试内部的噪音，按「这句话会不会进界面」那条判据（§8.65）不进表。见 docs §8.70 |
| `src/client/dom/*.js` | 从 `main.js` 闭包里搬出来的 **DOM 胶水**（第 4 步拆分的第一类文件，见 `docs/architecture-modernization.md` §8.12）。和 `pure/` 一样**必须能在 Node 里原生 import** —— 差别是它**持有状态**并且真的操作 DOM，所以浏览器环境（`window`、全局 `fetch` / `URL`、`navigator.mediaDevices`、跨文件的工具函数）**只能从构造函数参数注入**：源码里连裸的 `window` / `document` / `navigator` 字样都不许出现（`test/bundle-sync.test.mjs` 有专节按词边界扫，注释除外）。也禁止 Node API、禁止 React、禁止反向引用 main.js 顶层符号 |
| `src/client/dom/a11y-bridge.js` | `createA11yDomBridge(win, doc)`：a11y 动作的 DOM 执行层 —— 可见性判据（`offsetParent` / `position:fixed` / `aria-hidden` 子树 / `display:none`）、最近一次快照的 **ref→元素 + ref→可读描述**两张表（`record` / `infoFor` / `resolve` / `clear`，新快照整体覆盖旧表）、DOM 事件派发（无环境时退化成普通对象）、React 受控输入的原生 setter 写法。行为回归在 `test/a11y-bridge.test.mjs`（假 window/document 驱动真代码） |
| `src/client/dom/playback-core.js` | `createPlaybackCore({ win, baseUrl, request, toObjectUrl, readTtsMeta })`：朗读链路的**核心** —— 文本 → 可播放 URL（含 HTTP 状态码与服务端错误原文、引擎回退响应头计数）、常驻播放 AudioContext（**采样率阶梯：先不带参数建，再退 48 kHz、退 44.1 kHz**；绝不能写死，蓝牙耳机上写死会一句不出）、首次手势预热。7 个诊断态（`audioState` / `audioRate` / `audioError` / `lastTtsError` / `lastTtsEngine` / `lastTtsFallback` / `ttsFallbacks`）做成 **getter**，因为调试快照与 1.5 秒心跳在运行时反复读。行为回归在 `test/playback-core.test.mjs`（假 fetch / 假 AudioContext），端到端那一半在 `test/client-behavior.test.mjs` 场景 2b |
| `src/client/dom/mic-device.js` | `createMicDevice({ win, readMediaDevices })`：**两个录音入口共用的设备层** —— 这台机器能不能录（`supportsCapture`）、开麦约束（`captureConstraints`：单声道 + 先按 16k 要 + 回声消除/降噪/自动增益，**冻结的一份常量**）、取流（`requestStream`，失败原样抛出去，让调用方决定文案）、「拿到流 ≠ 有声音」（`liveAudioTrack`：空轨道列表与 `ended` 轨道都算没有）、取 `AudioContext`（`createAudioContext`：**拿不到构造器时抛可辨认的 Error**，而不是 `new undefined()` 的 TypeError）、手势里恢复（`resumeContext`）、释放轨道 / 关上下文（`releaseStream` / `closeAudioContext`，后者挂了 catch，不然冒未处理拒绝）。搬之前这六件事在 composer 与全局浮层里各抄一遍（普查：`getUserMedia` 2 处、约束字面量 2 处、`AudioContext \|\| webkit` 2 处、手写 `getTracks().forEach(stop)` 5 处），而且**两份不等价**：composer 少了 AudioContext 守卫（拿不到构造器就卡在「准备中」，再点变成「取消」），浮层少了轨道判据（空轨道也显示「聆听中」—— 本轮没顺手补，那是行为变更，见 §8.17「故意没动的部分」）。`readMediaDevices` 注入的是取值函数而不是 `navigator.mediaDevices` 本身（摘下来的浏览器方法在部分引擎里会 Illegal invocation，且测试要能切换设备有无）。本轮 2 处行为变更 = 补上的那条守卫 + 「没有录音设备」分支漏掉的开关复位。直测在 `test/mic-device.test.mjs`（假 navigator / 假 AudioContext），真产物那一半在 `test/client-behavior.test.mjs` 场景「开麦的时序与就绪判据」（假录音设备六种模式；`getUserMedia` 此前**零运行时覆盖**）。见 `docs/architecture-modernization.md` §8.17 |
| `src/client/pure/*.js` | 浏览器侧的**纯函数源码**（门限状态机、草稿合并、事件信封、定时器登记表、全局语音 VAD、UI 动作协议、a11y 原语、i18n 双语文案、配置归一化、快捷键校验与匹配、采集侧重采样）。不依赖浏览器 API，测试可直接原生 import |
| `src/client/pure/global-voice.js` | 全局语音纯逻辑：VAD 分段状态机（AudioWorklet 内联同一份源码）、识别文本归一化/限长、注入模式归一化、**唤醒词匹配**（`matchWakeWord`：开头锚定 / 语气词标点容错 / ≥3 字时 1 字容错，2 字按同音归一后精确匹配）、**快捷键平台别名**（`effectiveShortcut`：macOS 默认组合额外接受 `Cmd+Option+V`） |
| `src/client/pure/shortcut.js` | **快捷键那一整套判据（4.3 起从 `main.js` 外提）**：`validateShortcut`（设置面板保存前挡非法值）、`matchesShortcut`（修饰键**精确**一致 —— 配 `Alt+V` 时按 `Ctrl+Alt+V` 不算命中，否则两个语音入口一起触发）、`shortcutMatches(event, combo, platform)`（平台别名由外面把 `navigator` 标识传进来，本文件零环境）、`createShortcutFocusTracker()`（「面板正在录键」那份状态：composer 那条监听只看自己那个框，浮层那条两个框都看；卸载必须 `releaseAll()`，否则热键永久失效）。直测在 `test/shortcut.test.mjs`，真产物那一半在 `test/client-behavior.test.mjs` 场景「窗口内快捷键」。4.3 那轮查出三条缺陷（别名写法静默失效、`Space` 永不匹配、两条不可达分支），**4.3b 全处理了**：前两条翻成正向断言、分支删掉，词表归并进 `src/shared/key-modifiers.js`；文件里剩下的两条「现状保留」断言钉的是**故意不动**的旧语义（`Ctrl+Shift`、`Ctrl+Control` 这种把修饰键本身当主键的冷门配置）。4.3d 又把**主键**那半归并了：`matchesShortcut` 先问 `src/shared/key-names.js` 拿 `KeyboardEvent.key` 的真值再比（以前只特判空格一个键，于是 `Ctrl+Up` / `Ctrl+Del` / `Ctrl+Return` 这类写法保存得下去、窗口内永远不触发 —— 同一个配置值在系统级热键却按得动，因为 helper 有自己的表）。**批次 22 起这个文件里一句用户可见的中文都没有**：`validateShortcut` 返回的是 `{ok, reason, params}`（五个码见下面 `shortcut-error-text.js` 那行），改前这里是五条手写中文句子、设置面板原样显示，切英文后那两行红字仍是中文。见 `docs/architecture-modernization.md` §8.14（发现）与 §8.15（修复）、§8.19（主键）、§8.64（文案进字典） |
| `src/client/pure/resample.js` | **采集侧的采样率判据（4.4a 起从 `main.js` 外提）**：`TARGET_SAMPLE_RATE`（客户端上传的一律 16k f32 —— 这是和宿主的契约，`lib/asr-worker.js` / `lib/index.js` 每一处 `acceptWaveform` 都按它解释）、`normalizeSourceRate(value)`（**不是有限的正数就当它已经是 16k**；以前三处调用点各自手写兜底、其中两处 `?? 16000` 挡不住 0/NaN，会算出 `Infinity` 个采样并抛 RangeError）、`mergeChunks(chunks)`（把分块按时间顺序拼成一段；以前手写了三遍）、`resampleTo16k(samples, from)`（线性插值；已经是 16k 时**返回同一个数组**不拷贝）。`main.js` 里那个 16000 从出现 7 次降到 0 次：算法、三处兜底、两处 `getUserMedia` 设备约束都问这一个常量。直测在 `test/resample.test.mjs` |
| `src/client/pure/ui-action-protocol.js` | 客户端 UI 动作协议**入口**（显式具名转发到 `src/shared/ui-action-protocol.js`；浏览器侧不能 `require` 宿主模块是宿主对**产物**的要求，构建期由 esbuild 把 shared 合进单文件产物） |
| `src/client/pure/config-normalize.js` | 客户端配置**入口 + 表现层**：词表从 `src/shared/config-vocab.js` 转发（历史名字 `LANGUAGE_CODES` / `SOVITS_LANGS` / `WORDS_MAX_ENTRIES` / `WORDS_MAX_CHARS` 用局部别名保留），默认值与上限从 `src/shared/config-spec.js` 转发（`UI_DEFAULTS = CONFIG_DEFAULTS`、`STRING_LIMITS = CONFIG_MAX_LENS`，夹取区间问 `rangeFor()` 要）。这个文件里**没有任何一份手抄的宿主规则、也没有任何一句手写的中文**，只剩浏览器侧自己的东西 —— 语速/音调/音量与空闲释放档位、下拉选项文案、`normalizeForSave`/`collectSaveErrors(payload, t)`（批次 20 起红字那两半都问 `t` 要：字段名 = `t(配置键)`，句子 = `pure/config-error-text.js` 那张码表；以前这里是 `UI_SAVE_ERROR_LABELS` 七条手写中文 + `UI_DEFAULT_SAVE_ERROR_TEXT` 一条手写兜底句，和宿主 400 里那句中文拼在一起直接显示）。「两端同源」由 `test/config-contract.test.mjs` 用恒等断言（`a === b`）+「夹取函数不许自带数字」的形状守卫共同看住，「产物里只有一份词表」由 `test/bundle-sync.test.mjs` 守着 |
| `src/client/pure/a11y.js` | **v2 通用 a11y 原语（纯函数）**：可交互元素描述与 `ref`、按键字符串解析（`parseKeySpec`，修饰键别名取自 `src/shared/key-modifiers.js`、主键取值取自 `src/shared/key-names.js`，都不再自带一份表；4.3d 起派发空格用的是规范真值 `' '`）、语音「允许/拒绝」识别（`normalizeConfirmSpeech`）。**能往页面里派发哪些键是这里自己的策略**（`DISPATCHABLE_KEY_SPELLINGS`：单字母/数字/F1-F12 + 那份具名键名单，`Insert`/`Return` 即使在词表里也照旧拒），4.3d 归并词表时一条没扩大；DOM 胶水在 `src/client/dom/a11y-bridge.js`（4.1 起已从 `main.js` 外提） |
| `src/client/pure/tts-env-reason-text.js` | **运行环境自检原因码 → 界面文案的唯一一张表**（批次 22-3-2）：`TTS_ENV_REASON_KEYS` 把 shared 那十四个码映射到 i18n 键，`ttsEnvReasonText(reason, t, params, fallbackKey)` 是唯一出口。十四个码**十四个键、一处都不合并**（和批次 19/20 的「用户能做的事一样才合并」不同：这里连「可用」都分 PowerShell / say / espeak 三套，要填的参数不一样、缺东西时要做的事也不一样）；`paramsFor(code, params, t)` 只挑这个码该带的那几个名字，其余字段（宿主为 `/diagnostics` 留的 `detail`、`note`）结构上进不了句子。`{runtime}` 是这套里唯一还要再过一次字典的参数（`envRuntimeLabel`：契约值 `native` / `wasm` → 「原生加速 / native runtime」，**一个词也是话**）。**词表外的值（旧宿主写来的整句中文、大小写、带空格、`undefined`）一律走 `envReasonUnknown`，宿主原文一个字都不进界面**。引擎行名同理走 `ENV_ENGINE_LABEL_KEYS`（4 个 id → 键，脏 id 那句把 id 露出来），宿主的 `label` 已从渲染点删掉 —— 同一个引擎有两个展示名正是改前英文界面出中文的原因。直测在 `test/i18n-status-line.test.mjs` 末尾那节（十四个码 + 十种词表外值 + runtime 先过一次字典 + 只收协议里的名字 + 判据 18/19 的八条反例），宿主那一头在 `test/tts-env-check.test.mjs`（真自检函数逐个码核对 `reason` 与 `params`），真产物那一半在 `test/client-behavior.test.mjs` 场景「面板·环境自检」。见 `docs/architecture-modernization.md` §8.67 |
| `src/client/pure/i18n.js` | **UI 双语文案（纯数据）+ 填参数的纯函数**：`zh` / `en` 文案对象，由构建合进产物，`main.js` 经 `scope.locale.register(NS, { zh, en })` 注册给宿主 locale 系统；从 `main.js` 单体抽出来，方便改文案、单独校验两端键集一致。批次 22 起这里还有 `interpolate(text, params)`（把句子里的 `{name}` 换成参数值，填不到就**原样留着花括号**，宁可露一个 `{x}` 也不给一句读不通的空）和 `zhTranslate(key, params)`（客户端自己的兜底取词函数）—— 改前三个组件的兜底都写成 `(key) => zh[key] ?? key`，第二个参数被丢掉，带参数的句子在宿主没给 `t` 时直接显示 `不认识的修饰键：{modifier}。`，`out-of-range` 那句区间也一样。**批次 22-2 起这里还是「界面那句话唯一的出处」**：面板那些选项文案（引擎四项、空闲释放档位、「说话人 {index}」、MP3 那两行、词表占位符、「平台：」「显卡：」）和三个「契约值 → i18n 键」的展示名表都住在这里，配四个取词函数 `languageLabel(code, t)` / `voiceLabel(name, t)` / `ttsEngineOptionLabel(engine, t, localSupported)` / `idleReleaseLabel(minutes, t)` —— 以前语言名和音色名虽然也在这个文件里，却是两张**只写中文的表**，切英文照样是中文。词表外的值原样返回（未知音色显示上游短名，不盖成「未知音色」）。这一族**故意不再开新模块**（宿主不参与选项文案，没有跨端码要守），判据改成「面板渲染出来的树里，那段汉字必须能在 `zh` 的值里找到出处」，见 `test/client-behavior.test.mjs` 场景「面板·选项文案」与 docs §8.65。**批次 22-3-1 又加了一条同族的 `MODEL_LABEL_KEYS`（9 个模型档位 id → 键）与 `modelLabel(id, t)`**：宿主目录本来就给每个档位写了中英两份名字（`label` / `labelEn`），面板以前只读中文那份，英文那份从来没上过界面；字典这里抄的是目录那两句，**「逐字等于目录」由 `test/i18n-status-line.test.mjs` 判据 17 锁住**（重复一份文字的代价就是这么付的），渲染侧判据见场景「面板·模型名」与 docs §8.66。**批次 22-3-2 再加两张同族的表**：`ENV_ENGINE_LABEL_KEYS`（4 个引擎 id → 自检行名，脏 id 那句 `envEngineUnknown` 把 id 原样带出来）与 `envRuntimeLabel(kind, t)`（`native` / `wasm` 两个契约值 →「原生加速 / WASM 版」），配 22 句 `envReason*` 状态句（中英各 22，字典 287 → **309** 对）。这两个函数存在理由一样：**自检那四行的行名与状态句曾经由宿主写给界面**，见 `src/client/pure/tts-env-reason-text.js` 与 docs §8.67 |
| `src/client/pure/asr-ready-text.js` | **开麦就绪原因码 → 界面文案的唯一一张表**（批次 18）：`ASR_READY_REASON_KEYS` 把 shared 那四个码映射到 i18n 键（`loading` / `load-failed` 复用界面本来就在用的 `modelLoadingDetail` / `modelFailedDetail`，只有这条链路独有的两种情形用新增键），`asrReadyReasonText(reason, t, fallbackKey)` 是唯一出口。**词表外的值（旧宿主回句子、脏数据、大小写不同）一律走兜底那句，宿主的原样一个字都不进界面**；原始值留在 `__DSH_VOICE_DEBUG__().lastAsrReadyReason` 给排查。状态行短词不随码变（始终是 `modelFailed`），差别只在悬停那句。直测在 `test/i18n-status-line.test.mjs` 末尾那节（四个码 + 七种词表外值 + 可换兜底键），真产物那一半在 `test/client-behavior.test.mjs` 场景「开麦的时序与就绪判据」。见 `docs/architecture-modernization.md` §8.60 |
| `src/client/pure/hotkey-reason-text.js` | **系统级热键原因码 → 界面文案的唯一一张表**（批次 19）：`HOTKEY_REASON_KEYS` 把 shared 那十三个码映射到 i18n 键，`hotkeyReasonText(reason, t, fallbackKey)` 是唯一出口。两处**故意合并**（`script-build-failed`/`script-write-failed` 同一句、`spawn-failed`/`start-failed` 同一句）—— 码要的是「哪一步没通」分得开，文案不必每个都独有一句，差别在 `/diagnostics.hotkeyHelper.detail` 里看。**词表外的值（旧宿主那句中文、大写、带空格、`undefined`）一律走兜底那句 `hotkeyReasonUnknown`，helper 的原样一个字都不进界面**。设置面板的排布跟着变了一次：状态行只放短词（「失败」），原因那句进「说明」行 —— 见 `src/host/global-hotkey-helper.js` 的码表与 docs §8.61。直测在 `test/i18n-status-line.test.mjs` 末尾那节（十三个码 + 九种词表外值 + 可换兜底键 + 字典覆盖与陈旧映射表反例），真产物那一半在 `test/client-behavior.test.mjs` 场景「系统级热键状态行」 |
| `src/client/pure/config-error-text.js` | **配置保存失败原因码 → 界面文案的唯一一张表**（批次 20）：`CONFIG_ERROR_KEYS` 把 shared 那二十个码映射到 i18n 键，`configErrorText(reason, key, t, fallbackKey)` 与 `configFieldLabel(key, t)` 是两个出口 —— 红字那半句「这一格叫什么」也由字典出（`t(配置键)`，面板每行标题用的就是它），所以 `UI_SAVE_ERROR_LABELS` 那张七条手写中文表和 `UI_DEFAULT_SAVE_ERROR_TEXT` 那条手写兜底句一起删了。三处**故意合并**（URL 的非字符串并进 `not-a-string`、URL 超长并进 `too-long`、`words-replace-too-long` 并进 `words-entry-too-long`、`unknown-spec-type` 与词表外值共用兜底）。**和前两批最关键的差别：这里没有参数协议** —— 句子里的允许值列表、区间、长度上限由 `paramsFor(code, key)` 当场从 `src/shared/config-spec.js` / `config-vocab.js` 算出来（两端读同一份规则），函数压根不接宿主的文本，所以「宿主改不了界面那句话」是结构性保证；只有「第几条出错」这类宿主独有信息留在 `detail`，界面不显示。**词表外的值（老宿主写来的整句中文、大写、带空格、`undefined`）一律走 `configErrorUnknown`，宿主原样一个字都不进界面**。直测在 `test/i18n-status-line.test.mjs` 末尾那节（二十个码 + 十种词表外值 + 参数从 spec 推 + 35 个键都有中英字段名），真产物那一半在 `test/config-ui.test.mjs`（记录型取词函数）与 `test/client-behavior.test.mjs` 场景 26。见 `docs/architecture-modernization.md` §8.62 |
| `src/client/pure/shortcut-error-text.js` | **快捷键校验原因码 → 界面文案的唯一一张表**（批次 22）：`SHORTCUT_ERROR_KEYS` 把五个码映射到 i18n 键（`empty` / `too-few-parts` / `unknown-modifier` / `single-letter` / `reserved-paste`，五句各一句、没有故意合并 —— 每句要用户做的动作不一样），`shortcutErrorText(check, t, fallbackKey)` 是唯一出口，`params` 只在非空时往下传。**词表外的值（脏数据、别的调用方塞进来的整句中文）一律走 `shortcutErrorUnknown`，传进来的原文一个字都不进界面。** 和前两批（§8.60/§8.61/§8.62）唯一的差别：**这张表住在客户端而不是 `src/shared/`** —— 写句子的人和读句子的人都在客户端，没有跨进程边界，`params` 就是同一个调用栈里的对象，所以既不需要共享词表，也不需要参数协议；「不许出现第二份」由 `test/bundle-sync.test.mjs` 在产物层守着。直测在 `test/shortcut.test.mjs`（码表完备 + 返回里没有汉字）与 `test/i18n-status-line.test.mjs` 末尾那节（五个码 + 十五种词表外值 + 参数在中英两句里都被用上），真产物那一半在 `test/client-behavior.test.mjs` 场景「面板·快捷键红字」。见 `docs/architecture-modernization.md` §8.64 |
| `src/client/pure/model-download-reason-text.js` | **「下载模型」失败原因码 → 界面文案的唯一一张表**（批次 22-4-2）：`MODEL_DOWNLOAD_REASON_KEYS` 把 shared 那十个码映射到 i18n 键，`modelDownloadReasonText(reason, t, params, noCodeKey)` 是唯一出口。十句**一处都不合并**，因为这一族按「用户该做什么」分三类：再试一次（`file-failed` / `chunk-failed` / `chunk-incomplete` / `merged-size-mismatch` / `sha-mismatch`）、重试没用（`no-downloadable-files` / `file-not-in-repo` / `unknown-model` / `hosted-unavailable`）、什么都不知道（`failed-unknown`）—— 把第二类说成「再试一次」就是让用户白点按钮。「**完全没带码**」与「**码读不出来**」也是两句：前者是旧宿主的兼容路径（默认用短词 `downloadFailed`，调用点可换），后者是两端版本不一致或脏数据（`downloadReasonUnknown`）。`paramsFor(code, params)` 只挑 `MODEL_DOWNLOAD_REASON_PARAMS` 点名的那几个名字，宿主为诊断留的 `error` 原文结构上进不了句子，所以界面那句话里永远没有原文。这一族的两个调用点都在设置面板：SSE 的 `model-error` 监听（改前写的是 `void parseEnvelope(event)`，载荷接过来又丢地上）与 `download()` 里非 2xx 那支（改前是 `setStatus(body?.error ?? …)`，宿主路由层那句原样上界面）。直测在 `test/i18n-status-line.test.mjs` 末尾那节（十个码 + 十二种词表外值 + 只收协议里的名字 + 判据 20/21 的九条反例），真产物那一半在 `test/client-behavior.test.mjs` 场景「面板·模型下载」（恒等 t 判问的是哪个键，中英两轮真字典判句子填得进去），宿主那一头在 `test/model-download.test.mjs` 与 `test/model-state.test.mjs`。见 `docs/architecture-modernization.md` §8.71 |
| `scripts/build-client.mjs` | 浏览器侧构建：用 esbuild 把 `src/client/main.js` 沿 **import 图**（`src/client/pure/`、`src/client/dom/` 以及它们 import 的 `src/shared/`）合成单文件 `lib/client.js`，再包成宿主要求的 `window.__ModuleLoader__.load({ id, factory })` 形态（浏览器模块的 require 只认包名，所以源码必须在构建期合并）。入口清单就是 import 本身，**新增子目录、新增模块都不用改构建脚本**；「有人 import 了它吗」由 `test/bundle-sync.test.mjs` 拿 esbuild metafile 兜底（孤儿文件不进产物 = 红）。`--check` 只校验产物是否最新，CI 用它 |
| `scripts/build-host.mjs` | 宿主侧构建：用 esbuild 沿 **import 图** 把 `src/host/` 合成 `lib/` 里的产物。入口清单 `HOST_ENTRIES` **不是「lib 下所有文件」，而是「有代码按文件路径加载它」的那三个**（`index.js` 由宿主按 `main` 加载，两个 worker 由 Worker 按路径加载）；`packages:'external'` 把**所有裸包名**留在包外 —— 原生模块（sherpa / uiohook）打进产物就是坏的，`msedge-tts`（批次 15 起是 `dependencies` 里的真包）也跟着留在外面，产物里因此一行第三方代码都没有。产物头部除了「构建产物，勿手改」的 banner 不再补别的东西（以前为内联的 CJS vendor 补过一对 `createRequire`，vendor 没了它也跟着删，见 `docs/maintainer-notes.md` 末尾那段「已经翻掉的历史」）。`assertHostShape` 在写盘前拦两件事：banner 掉了、产物里残留相对 import（残留 = 发布物得带上 `src/`）。`--check` 只校验产物是否最新，CI 用它；孤儿守卫（`bundle-sync` 调 `build-host.mjs --check`）递归扫 `src/host/`，子目录里没人 import 的文件也会红 |

---

## 7. 配置项之间的配合关系（生效条件矩阵）

配置统一走 `GET/POST /config`：GET 返回**已归一化**的完整配置；POST 是 **patch**（只接受已声明键）。
加载时非法/越界值回退默认并记入 `/diagnostics.configWarnings`；保存时非法值返回 `400 {ok:false, errors}`，不会静默改值。

| 配置 | 生效条件 / 配合 |
|---|---|
| `readAloud` | 朗读总开关。关闭时 `/tts` 不会被调用；但朗读相关设置仍可编辑/保存 |
| `ttsEngine` | `online`→voice/pitch/volume/ttsFormat；`neural`→neuralModel/neuralSpeaker；`local`→localVoice；`sovits`→sovits*（rate 转 speed_factor）。**非法值保存被拒，运行时不静默落 online** |
| `rate` | 四种引擎都生效（online/local 百分比、neural 倍率、sovits speed_factor 0.5~2） |
| `pitch` / `volume` / `ttsFormat` | 仅特定引擎有效：pitch/format 仅 online，volume 仅 online/local |
| `readAloudLag` | 只在 flow（客户端 ack）模式生效；`0`=关闭追赶；非有限值回退默认（7.5） |
| `language` | **只对 SenseVoice 生效**；Whisper/zipformer2 忽略（UI 按模型禁用/提示） |
| `liveAsr` | `stream` 固定依赖 zipformer2-zh（与 `model` 无关）；不可用时提示并回退整段 |
| `model` | 必须是已声明档位；非法值保存被拒，运行时不再静默回退 SenseVoice |
| `autoSend` | 关闭时 `autoSendExtraMs` 隐藏；`mode=once` 的「说完退出」只在自动发送后发生，因此会禁用并说明 |
| `preloadModels` × `idleReleaseMinutes` | 预加载只覆盖 model/neural（不覆盖 liveAsr 的 zipformer2）；idle 释放不释放当前选中模型；`0`=永不释放 |
| `sovits*` | 只对 `ttsEngine=sovits` 生效；`sovitsRefAudio` 是**服务端机器**可访问路径（官方 api_v2 每请求必填），留空则不带该字段由服务端决定 |
| `words` | 热词仅 zipformer2（transducer）生效；按行保存，保存时 trim/去空 |
| `globalVoice` | 全局语音浮层总开关。关 = 浮层不渲染、不建 SSE 连接、界面动作执行器不存在 |
| `globalShortcut` | 窗口内全局语音快捷键（helper 也用它注册系统级热键）；格式规则同 `shortcut`（至少一个修饰键；单字母需 Ctrl/Alt/Meta） |
| `voicePromptMode` | 语音文本注入方式：`queue`（下一轮）/ `steer`（当前轮下一步） |
| `uiControl` | AI 界面操控总开关（默认关）。**需要 `globalVoice=true` 才有执行器**；关闭时 `voice_ui` 返回 `ui_control_disabled`。v2 共 14 个动作（8 个语义 + 6 个 a11y 原语），新增界面功能不再需要改协议 |
| `uiConfirm` | 危险动作确认（默认开）：切会话/新建/命令/发消息/停止生成 + a11y 点击/输入/按键。只读动作不受影响；用户点「拒绝」或说「拒绝」回执 `confirm_denied`（说「允许」等同点允许） |
| `globalHotkeyHelper` | 拉起跨平台系统级热键（默认关）：Windows 内置 PowerShell helper；macOS/Linux 需可选依赖 `uiohook-napi`（macOS 授权辅助功能、Linux 需 X11）。**还要求 `globalVoice=true`**（没有浮层消费事件时不启动）。失败不影响窗口内快捷键，原因进 `/diagnostics.hotkeyHelper`（`enabled/status/reason/detail`，`reason` 是原因码） |
| `wakeWord` | 全局语音待机唤醒词（默认「小鱼」；空串 = 关闭）。只对浮层生效；待机时非唤醒内容不发送；活跃 60s 无语音回待机（客户端常量 `WAKE_ACTIVE_MS` / `WAKE_HINT_MS`） |

---

## 8. 实时文字被丢弃的五种原因

`/asr-stream` 每丢一次正在累积的流式会话状态，都会在 `/diagnostics.streamDiscard` 里留一条记录：
`count` 是总次数（不裁剪），`events[]` 只留最近 `window` 条、留的是最新的那些。
每条带 `sessionId`、`modelId`、`idleMs`（距上一次喂音频过了多久）和下面这个 `reason`：

| reason | 含义 |
| --- | --- |
| `recognizer-freed` | 识别器正在被释放（重新下载模型 / 换语言 / 切档位 / 插件停用），引用它的会话必须先丢 |
| `recognizer-changed` | 下一次取流时发现句柄已经换了，接着用会把上一轮的残留串进这一轮 |
| `idle-timeout` | 超过 60 秒没有新音频的兜底清理（客户端关掉页面或识别失败时不会发收尾请求） |
| `decode-error` | 解码这一侧真出错了，只能从零开始 |
| `client-reset` | 客户端主动结束这一轮，属于正常路径，不是故障 |

一块过大的分片被拒（413）**不在这份名单里**：那是请求级拒绝，只回执、不动会话状态，
不该把正在说的那句抹掉（docs §8.53）。
