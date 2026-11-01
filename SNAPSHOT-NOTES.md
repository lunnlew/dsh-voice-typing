# dsh-voice-typing 代码快照说明

版本：0.0.3 　生成时间：2026-11-01 21:40（0.0.3：外部 GPT-SoVITS 引擎 + 配置项校验/联动全面加固）

## 文件结构

| 文件 | 职责 |
|---|---|
| `lib/index.js` | **宿主端**（DSH 插件的 Node 侧）：HTTP 路由、识别 worker 管理、模型预加载与空闲释放、TTS 合成、`llm/stream` 钩子（按句广播） |
| `lib/client.js` | **浏览器端**：麦克风按钮组件、录音与 VAD、草稿管理（三段拼接）、朗读队列与播放、设置面板 |
| `lib/asr-worker.js` | 识别工作线程（SenseVoice / Whisper / Zipformer2 离线推理），避免阻塞宿主主线程；支持预加载与释放 |
| `lib/edge-tts.js` | Edge 在线 TTS：共享连接 + 互斥锁 + 预热 |
| `lib/local-tts.js` | 本地 TTS：调用 Windows SAPI（PowerShell）/ macOS say / espeak-ng，完全离线 |
| `lib/neural-tts.js` | 本地神经 TTS（sherpa-onnx VITS）宿主侧封装：工作线程收发、预加载与释放、WAV 编码 |
| `lib/sovits-tts.js` | **外部 GPT-SoVITS 引擎客户端**：按官方 `api_v2` 的 `/tts` 契约转发文本（含用户配置的参考音频/文本/语言），拿回 wav；不内置模型、不做克隆、失败不回退 |
| `lib/config-schema.js` | **配置 schema**（纯函数）：28 个键的类型/枚举/范围/URL/词表校验；加载 `sanitizeConfig`（非法回退默认 + warnings）、保存 `validateConfigPatch`（非法 → 400 errors） |
| `lib/tts-worker.js` | 本地神经 TTS 工作线程（VITS 推理） |
| `lib/tts-env.js` | 合成运行环境自检（引擎可用性、平台能力） |
| `src/client/pure/*.js` | 浏览器侧纯函数源码（门限 / 草稿 / 信封 / 朗读积压 / 定时器），由脚本内联进 `lib/client.js` |
| `lib/text-rules.js` | 文本规则：词表解析与替换、语气词清理、输出规范化 |
| `lib/turn-model.js` | 回合判定模型（`createTurnModel` 工厂）：判定新一轮、分配 turnId、句子序号、空闲清理 |
| `lib/sse-envelope.js` | SSE 事件信封协议层：`EVENT_PROTOCOL_VERSION`、全局事件序号、`buildEventEnvelope` |
| `lib/speech-clean.js` | 文本清洗与分句：`stripForSpeech`（Markdown → 纯文本）、`splitSentenceParts` |
| `lib/read-aloud-policy.js` | **朗读切句/发射规则**（纯函数）：`splitLongText`（完整句子切分，绝不断成半句）、`packWindowSentences`（相邻短句合成 ≤ 上限的片段）、`MAX_SENTENCE_CHARS`；`EMIT_WINDOW_MS` 仅用于「收不到 ack 的老客户端」降级节奏 |
| `lib/paragraph.js` | **自然段落切分**（纯函数）：空行 / 列表项 / 标题 / 引用为段落边界；`splitParagraphs` 支持流式累积（末尾未完成段进 `rest`） |
| `lib/read-aloud-scheduler.js` | **朗读调度器**：按自然段落收集、按客户端 ack 的播放进度发句（流控）；追赶最新（超预算整段跳旧段、保留最新 3 段）；生成很快时 skim（每段只读首句）；无 ack 时降级为旧的 400ms 时间窗口节奏 |
| `lib/fence-filter.js` | **流式代码围栏过滤器**（纯函数）：跨 chunk 识别 ``` / ~~~ 围栏；围栏标记被 chunk 边界切开也不会漏代码 / 丢正文 |
| `lib/model-catalog.js` | 模型档位目录与下载缓存（识别 + 神经 TTS 档位、分片并行下载、SHA256 校验） |

## 核心数据流

### 语音输入
```
麦克风常开 → ScriptProcessor 采集 → 滚动缓冲 chunksRef
  → VAD 每 100ms 检测能量
  → 静音断句（默认 1.5 秒）→ 取当前段音频
  → POST /transcribe → worker 线程 SenseVoice 识别
  → syncUserEdit() 检测用户是否手动改过草稿
  → composeDraft() 写入输入框
  → 助手空闲 → 自动发送；助手忙 → 暂存，结束后发
```

### 流式识别（`/asr-stream`）
```
增量 PCM → 能量门限判定
  → 静音帧：不喂解码器（防模型凭空造字），并更新底噪
  → 语音帧：喂给解码器 → 取 getResult().text
  → 说话中：单帧偏低照喂，连续 3 帧静音才退出说话态
```

底噪**只在静音时**更新。每帧都更新的话，底噪会被语音自己抬高，
门限跟着涨——汉语的轻声和句尾的下降音天然偏低，
一刀切掉的话解码器缺了那段音频，识别结果会**截断**
（实测「你好，今天天气怎么样？」只认出「你好明天天怎」）。

### 朗读（边生成边朗读）
```
助手流式输出 → llm/stream 钩子过滤代码块 → 正文喂给 lib/read-aloud-scheduler.js
  → 调度器按自然段落收集、段内按句末标点切句
  → 积压（待朗读音频估算时长）超过 readAloudLag（默认 7.5s，0=关闭）→ 整段跳旧段、保留最新 3 段（从最新第 3 条开始读）
  → 生成中且超预算时「每段只读首句」就跳走（不再等整段读完）；生成结束后恢复正常完整朗读
  → 按客户端播放进度发句（客户端每开始播一句回 POST /reading-ack）
      · 已发未确认句数上限 READ_ALOUD_LEAD=3
      · 没有 ack（老客户端）→ 降级为旧的 400ms 时间窗口节奏
  → 广播 sentence 事件（SSE，带 turnId/index/para/paraStart）
  → 客户端按 (turnId,index) 去重 → 3 路并行合成 → 顺序播放 → 开始播一句就 ack 一句
  → 你说话 → 停朗读；新一轮开始（turn-begin）→ haltSpeaking() 停旧朗读
```

两条硬规则（详见 README「朗读切分」「朗读发送节奏」两节）：

- **代码块（```…```）一律不朗读**：按 text-delta 逐块过滤 + `lib/fence-filter.js` 的
  跨 chunk 围栏状态机（`~~~` 围栏要求行首），代码内容一个字都不进朗读队列。
  不能先拼 buffer 再判断 —— 流式时围栏和代码不在同一块里到达，而且围栏标记本身
  也可能被 chunk 边界切开（"``" + "`js"），旧实现会在这种切法下把代码念出来、
  把围栏后的正文当代码丢掉。
- **按客户端播放进度发句（流控）+ 追赶最新**：`READ_ALOUD_LEAD=3`（已发未确认上限），
  客户端每开始播一句回 `/reading-ack`，宿主才补发；积压超过 `readAloudLag` 就按整段
  保留最新 3 段。没有 ack（老客户端）时降级为旧的 400ms 时间窗口节奏，收尾等 1.2s
  grace 后一次发完（不丢尾巴）。
- **列表编号不当句子念**：`1. 第一步…` 的 `1.` 曾被当成一句「一」读出来。
  `splitSentenceParts` 排除列表编号作为句界，`stripForSpeech` 去掉
  `1.` / `1)` / `一、` / `-` 等前缀（但 `1.5 倍速` 这类正文必须保留）。

## 关键设计决策

### 1. 麦克风全程不关
只在退出语音模式时关闭。识别、等回复、朗读期间都开着——这是"实时对话"体验的基础。

### 2. 单一状态源
客户端只有 `on`（开关）、`speaking`（朗读中）、`hint`（临时提示）三个渲染状态。
所有判断依据用 ref，不用 state（避免渲染延迟）。

### 3. 草稿归属：三个变量各管各的
草稿由三段拼接而成，顺序固定：

| 变量 | 含义 | 生命周期 |
|---|---|---|
| `baseDraftRef` | 用户开麦前自己输入的内容 | 整轮保持 |
| `committedRef` | 已识别完成的各段语音 | **累积**，互不覆盖 |
| `segmentRef` | 当前这一段的实时字 | 被下一段替换 |

最终草稿 = `baseDraftRef + committedRef + segmentRef`，由 `composeDraft()` 统一写入。

早先只用一个 `baseDraftRef` 同时表示「用户已有内容」和「本轮语音内容」，
写完第一段就把它清空，于是**第二段会把整个草稿覆盖掉**——
用户手打的内容和第一段的识别结果一起消失。改成三段之后这个问题消失。

**但三段只是「我们以为输入框里的内容」。** 用户手动删掉一段之后，
那份记录就过期了——再拼一次就会把用户刚删掉的字原样塞回去。

所以拆成两个纯函数：

| 函数 | 职责 | 调用时机 |
|---|---|---|
| `syncUserEdit()` | 检测用户是否改过草稿（输入框当前内容 vs 我们最后写入的内容），改过就以用户当前内容为基准 | **写入新内容之前** |
| `mergeDraft()` | 纯拼接，不做任何判断 | 任何时候 |

顺序很重要：把编辑检测放进 `mergeDraft()` 里的话，
一旦判定为「用户改过」，就会把**刚识别到的新内容**也清掉——
用户删掉一段之后，接下来识别到的句子会凭空消失。

另外 `lastWrittenRef` 仍用于判断「草稿是不是我们写进去的」，
以便在识别失败时只回滚自己那一段，不误伤用户内容。
注意「有没有写过」不能只看内容是否为空——首次写入会被误判成「用户改过」。

### 4. 识别放进 worker 线程
SenseVoice 是 CPU 密集的同步计算，放主线程会卡住整个应用 0.5~3 秒。
`lib/asr-worker.js` 里模型常驻缓存，单次识别 30~100ms。

**Zipformer2 是流式模型，必须用 `OnlineRecognizer` + `isReady`/`inputFinished`
的解码方式。** 用 `OfflineRecognizer` 配 transducer，sherpa 的原生代码会
**直接终止进程**（整个桌面应用退出）——不是抛异常，宿主连错误都接不住。

### 5. TTS 三引擎

> **外部 GPT-SoVITS 引擎**（2026-11 追加）：插件不内置 GPT-SoVITS、不做声音克隆；用户自己跑官方
> `api_v2` 服务（默认 `127.0.0.1:9880`），插件只把每句文本 POST 到 `/tts`（携带用户配置的
> `ref_audio_path` / `prompt_text` / 语言），拿回 wav 走现有播放管线。失败**不回退**其它引擎
> （隐私 + 音色一致性），超时 20s < 客户端 25s，失败计数进 `/diagnostics.sovitsTts`。
- **online**：Edge 云端，音质好，~600ms（预热后）
- **neural**：本地 VITS 模型，离线可用，~1.6s
- **local**：Windows SAPI / macOS say / espeak-ng，离线可用，~800ms
本地引擎合成失败自动回退在线。

神经引擎的 VITS 解码同样是 CPU 密集的同步计算（RTF 约 0.35，一句话占住主线程 1 秒），
所以它也放在独立工作线程 `lib/tts-worker.js` 里，不占宿主主线程。

### 6. 模型预加载与空闲释放
模型常驻内存，体积都不小（Zipformer2 约 160MB，神经 TTS 约 170MB）。

- **预加载**：选中档位后后台先把模型读进内存。Zipformer2 首次加载要 40 秒，
  预加载后第一次说话只要 300ms。加载在 worker 里进行，界面全程可用。
- **空闲释放**：闲置超过设定时长就自动释放。扫描每 60 秒跑一次。

释放识别模型时**必须显式通知识别工作线程**——模型住在 worker 里，
宿主主线程的缓存表是空的，只清表等于什么都没释放。
另外 worker 的 `recognizers` 里存的就是识别器本身，释放要调 `entry.free()`，
写成 `entry.recognizer.free()` 会静默失败（报告「已释放」但实际没释放）。

### 7. 朗读互斥与打断
- `speakGenRef` 代次机制：新一代开始，所有旧的合成/播放作废
- `haltSpeaking()`：停 source + 清队列，保证同一时刻只有一个朗读
- `withSynthLock()`：Edge 实例共享连接，串行化避免串音

**停止必须切断所有还活着的音频源**，不能只靠「当前那一个取消句柄」：
那个句柄在句与句之间的空隙里是 null，更早那一句的 `onended` 也会把它清成 null。
这两种时刻点点「停止朗读」都停不掉真正在响的东西。
现在登记所有源（`speakSourcesRef`），停止时逐个 `stop()`。

朗读的 SSE 连接是**常驻**的（朗读不应该依赖「语音模式开着」，
否则勾了「朗读回复」却没开麦克风按钮就完全没声音，而设置里没写这个前提）。
常驻带来两个必须配套的东西：

- `mutedTurnIdRef`：**本轮手动静音**标记。用户点了「停止朗读」后，
  后续到达的句子会被它拦住——否则清完队列又会被新句子填满，
  表现为「我明明停止了，它又自己开始」。
  下一轮（收到 `turn-begin`）或重新开麦时自动解除。
  标记为**空串**表示「静音到下一个 `turn-begin` 为止」——
  这条路必须真的实现，否则拿不到轮次 id 时「停止朗读」等于没按。
- 停止朗读要**三件事一起做**：清队列 + 代次自增 + 停掉当前播放。
  少一件就会出现「停了还在播」。

### 7.1 回合判定：用请求里的消息，不要读 session
「这是不是新的一轮对话」读 session 里的用户消息条数是不行的：
本轮用户消息写入 session 的时机和 LLM 开始输出**不一致**，
于是要么新一轮的 `turn-begin` 不发（客户端不解除静音），
要么（配 5 秒时间窗兜底）工具调用跑久了把**同一轮**再判成新一轮，
客户端就把用户的「停止朗读」撤销了。

现在数 `llm/stream` **请求里**的 `options.messages`：
请求就是这次真正发给模型的消息，用户消息一定在里面，没有时序竞态。
同一轮里多次调用（工具调用链）条数不变，用户新发一条才 +1。

轮次 `turnId` 用**递增序号**，不用「本轮最后一条 user 消息的内容锚点」——
锚点在本轮消息还没写进 session 时还指着上一轮那条，两轮会共用同一个 id。

### 7.2 朗读贴着最新内容
生成比朗读快时（模型一次性吐出整段回复），待播句子会越积越多，
听到的内容离最新回复越来越远，甚至新一轮都开始念了还在念上一轮的旧内容。

- 只读**当前这一轮**的句子（`turnId` 对不上就丢）。
- 待播有上限（`MAX_PENDING`），超了丢**最旧的可丢项**
  （`src/client/pure/backlog.js` 的 `trimBacklog`）。
- 本轮**第一句**不丢 —— 朗读的第一声应该是回复的开头。
- ⚠️ 专家评审发现并修复：`trimBacklog` 只看队头，受保护的首句挡在队头时
  会退而丢**最新**的句子（违背「丢最旧」）。要跳过首句找最旧的**可丢**项。
  评审还发现：宿主不给 `index`（老宿主）时首句保护失效 ——
  客户端用本地序号 `turnSentenceSeqRef` 补，保证每句都有合法 `index`。

### 7.3 朗读管道不能永久卡死（评审后新增）
`pumpQueue` 的消费循环 `await` 每句的合成 promise。若某句 TTS 请求挂住，
`await` 永不 resolve → `pumpingRef` 卡 true → 之后所有句子只入队不播，
且无报错。评审发现三处会导致或加重此问题的缺陷，均已修复：

- **每句合成加超时**：`await Promise.race([promise, sleep(...)])`，超时当失败跳过。
- **播放上下文在 try 内取**：`getPlayCtx()` 构造抛错（部分设备对固定
  `sampleRate` 不买账）时，若在 try 外取会跳过 finally、`pumpingRef` 永久卡。
- **object URL 在 `finally` 释放**：失败/打断路径不再泄漏。
- 宿主 `llm/stream` 里 `next()` **同步抛错时复位 busy**（两处 `next()` 调用
  都要包 try/catch）：否则 `busySession` 永久卡 true，自动发送链路失效。

### 7.4 状态行只放短词
麦克风旁边的状态行内联在按钮旁边，文字越长整行越挤、界面位置跟着跳。
状态行只显示短词（「加载模型…」「朗读中」「已停止」），
完整说明放到 `…Detail` 文案里，鼠标悬停显示；状态行给 `minWidth`，
换状态时宽度不变。

### 7.5 架构迁移：协议 v3 + 回合模型独立模块（评审后落地）
专家评审的两个架构项已落地：

- **协议 v3（`EVENT_PROTOCOL_VERSION = 3`）**：事件命名对齐语义。
  - `turn-end` 现在表示**真正的一轮结束**（下一轮开始时，宿主广播上一轮的
    `turn-end`，带上一轮的 `turnId`）。DSH 没有显式「一轮结束」回调，只有
    「新一轮出现」才知道上一轮没了，所以单次调用不会立刻出现 `turn-end`。
  - 原「一次 `llm/stream` 调用结束」改名为 `call-end`。v2 里它叫 `turn-end`，
    名字与语义不符；v3 改名对齐。
  - 宿主与客户端**同包、同版本**一起加载（junction 指向本工作区，重载即同步），
    无需跨版本兼容/双发。
- **回合判定抽到独立模块 `lib/turn-model.js`**（`createTurnModel` 工厂）：
  封装 `countRequestUserMessages` / `isNewUserTurn` / `resolveTurnAnchor` /
  `detectTurn` / `nextSentenceIndex` 及全部回合状态（几张 Map + 计数器）。
  宿主 `lib/index.js` 只委托（`turnModel.countRequestUserMessages(...)` 等）。
  隔离后便于测试，也避免「改一轮的判定」误碰朗读/识别。
  - 客户端仍**不**在 `turn-end` / `call-end` 里清 `currentTurnIdRef`：
    一轮结束后、下一轮 `turn-begin` 前可能还有**迟到**的本轮句子到达，
    清空会让它们被放行混进新一轮。

### 7.6 演进项：可观测性 + 状态清理 + 继续拆模块（评审后落地）
评审的三个演进项已落地，行为保持不变：

- **A 组 · 合成失败不再静默**（「朗读没声」要能查）：
  - 宿主 `/diagnostics` 新增 `onlineTts` / `neuralTts`（连同已有 `localTts`），
    各含 `failures` / `lastError` / `lastAt`。在线与神经引擎失败原来**无回退、
    无日志**，客户端静默跳过那一句，用户只见「没声音」。
  - 客户端 `synth` 失败时：`ttsFailuresRef` 计数 + **节流**（>4s）弹一次短词
    「朗读失败」（`ttsFailed`），完整说明走 `ttsFailedDetail` 悬停。
  - `__DSH_VOICE_DEBUG__()` 新增 `ttsFailures`。
- **D9 · 回合状态表不再无限增长**：
  - 宿主没有「会话结束」回调，用空闲超时兜底：`turnModel.prune(now)` 把
    超过 `TURN_STATE_TTL_MS`（10 分钟）没活动的会话状态（`turnUserCounts` /
    `turnRequestUserCounts` / `lastTurnAt` / `turnIds` / `turnAnchors` /
    `turnIndexes`）清掉。挂进现有 `idleSweeper`（每分钟跑一次）。
  - 每次 `detectTurn` 都更新 `lastActivityAt`，作为空闲判定依据。
- **B4/B5 · 继续拆「上帝模块」**：
  - `lib/sse-envelope.js`：`EVENT_PROTOCOL_VERSION`、全局事件序号、
    `buildEventEnvelope` 从宿主迁出，宿主 re-export（对外接口不变）。
  - `lib/speech-clean.js`：`stripForSpeech`、`splitSentenceParts`、
    `splitSentenceParts` / `splitLongText` 等纯函数迁出，宿主流式循环直接复用。

### 7.7 朗读无声根因：播放上下文卡在 suspended（实测定位）
实测 `GET /diagnostics` 时客户端报告 `speaking: true`（卡住）但**没有声音**，
且 `hearing: false`（没开麦克风）、所有 TTS 失败计数为 0。根因：

- 朗读与语音模式无关（7.4 已改），但**没开麦克风**就没有任何路径去
  `resume()` 播放 `AudioContext`。
- `getPlayCtx()` 里 `resume()` 是**发后不管**（`.catch(() => {})`），而
  `resume()` 是异步的 —— 若上下文还没恢复完就 `source.start(0)`，
  音频一直排队不响，`onended` 永不触发，`play()` 的 promise 永不 resolve，
  **整条朗读管道卡死**：`speaking` 恒为 true、无声。

修复：
- `play()` 在 `source.start(0)` 前**await** `resume()`；
  超时后仍挂起就跳过这一句，不让管道卡死。
- 首次用户手势（pointerdown/keydown，一次性）时预热并恢复播放上下文，
  保证「没开麦克风、首次点击发送」也能在收到回复前就把上下文跑起来。
- 测试环境 `window` 可能只是没有 `addEventListener` 的桩：手势监听器
  只在 `typeof window.addEventListener === 'function'` 时注册，且 try/catch，
  绝不让模块加载崩掉。

#### 7.7.1 修正：1 秒超时会丢句 → 改成轮询等 8 秒
上一版用 `Promise.race([resume(), sleep(1000)])`，1 秒没恢复就静默跳过这一句。
但 `resume()` 稍慢（等浏览器授权、蓝牙耳机重新协商音频路由）实测要 1~3 秒 ——
于是**每一句都被静默丢弃**：`/tts` 一直在调、界面一直显示「朗读中」，
却一点声音都没有。用户报的「无法朗读」就是它。

现在的做法：
- 先 `await playCtx.resume()`，再**轮询**到 `state === 'running'`，最多等 8 秒。
- 8 秒还挂起才算彻底失败（自动播放被完全禁止），跳过这一句并
  `playSkippedRef += 1`；调试快照 `__DSH_VOICE_DEBUG__().playSkipped` 可查。
  只记 `ttsFailures` 会漏掉它——那句的**合成是成功的**，是播放被跳过了。
- 回归测试：`test/client-behavior.test.mjs` 加载真实 `lib/client.js` 产物 + 假 DOM/AudioContext
  驱动真实播放循环（覆盖 resume/gen 复查、ack 恰好一次、停止/换轮后不出声）；
  仓库内原 `read-aloud-resume.test.mjs` 测的是复制逻辑（已删）。
  断言「resume 要 2 秒时旧逻辑丢句、新逻辑照样播」，并断言失败时最多等约 8 秒。

#### 7.7.2 教训：改完 `src/client/` 必须重新 bundle
这一版的修复**曾经**做在 `src/client/main.js` 里，但忘了跑
`node scripts/bundle-client.mjs`，于是 `lib/client.js`（浏览器实际加载的那份）
还是旧代码 —— 源码是对的、测试也是对的，唯独**发出去的不是它**。
`npm test` 里的 `bundle-sync.test.mjs` 就是专门挡这个的，改了源码一定要跑一遍
`npm run build:client`。


### 7.8 朗读节奏：从「固定时间窗口」改为「客户端播放进度流控」（用户两次反馈后重做）

用户反馈（2026-11-01，第二次）：
「不是按自然段落读的，总挑到最新段落里非首句的句子」；
「已经念到后面了，又回去念前面的」。

**根因不是切分算法，是生产/消费速率失衡**：
- 宿主旧逻辑按 `EMIT_WINDOW_MS=400ms` 一句猛发（2.5 句/秒）；
- 浏览器真正「念」受音频播放时长限制（2~3 秒/句）；
- 生产速度是消费速度的 5~8 倍 → 客户端积压 + `trimBacklog` 丢「最旧的可丢项」
  = **丢掉接下来马上要播的那几句** → 播放位置不断向前跳，落点在段落中间
  → 「不是按自然段落朗读」的听感。（现在 `MAX_PENDING=8`，且只作安全网：
  按整段丢弃、保护正在播的段 / 首段 / 最新段，可丢的组都在受保护组之后时
  宁可不丢＝软上限。）
- 旧实现里段落补全时用字符串 `startsWith(curParaSent)` 减前缀、**没有兜底**：
  一旦不匹配就把整个段落（含已发句子）当新段落再发一遍 → 「读完后面又回去读前面」。

**新设计**（唯一实现 `lib/read-aloud-scheduler.js`）：
- 段落是朗读单元：段落内句子全部发出后才轮到下一段（`splitParagraphs` + 段内切句）；
- **流控**：宿主维护「已发未确认」句数，上限 `READ_ALOUD_LEAD=3`；
  客户端每**开始播放**一句就 `POST /dsh-voice-typing/reading-ack`（`{sessionId,turnId,count}`），
  宿主才补发下一句 → 朗读节奏 = 真实播放节奏，不积压、不跳段、不滞后太多；
- 事件新增 `para`（段序号）与 `paraStart`（段首片段）：客户端据此**按整段裁剪**、
  按 `(turnId,index)` 去重；`MAX_PENDING` 只做异常安全网（按整段丢最旧的、
  保护正在播的段与本轮第一段）；
- **追赶最新**（用户追加需求：全部朗读虽正确，但长回复会越读越滞后）：调度器估算待朗读音频时长
  （已发未确认 + 队列 + 当前段剩余，约 210ms/字），超过设置项 `readAloudLag`（默认 7.5 秒，0=关闭）
  就**整段跳到最新几段**：保留「已开读的段」+「**最新 3 段**」，中间未开始发的完整段落整段跳过 ——
  跳过时只整段丢「还没开始发」的段；**例外**：生成很快、仍在流式输出时，正在读的段
  可以**只读首句就跳走**（见下一条 skim）；生成结束后的剩余段落完整读完；
  于是长回复的听感是"一直贴着最新内容念"；
- **生成很快时只读首句**（用户要求）：`streaming` 且「还没发出去的内容（`backlogMs`，不含流水线提前量）」超预算时，
  正在读的段落发出首句后即放弃剩余句子直接跳走
  （`skim=true`；诊断用 `trimmedSentences/truncatedParagraphs` 计数）；生成结束（`streaming=false`）后剩余段落完整读完、不截断结尾。
- **评审后加固**（P2）：watchdog 只在真发句 / 收到 ack 时重新计时（持续 push 不会拖住放行）；
  pending 收尾加 1.2s grace（等首条 ack，流控/追赶才生效；老客户端到点照旧排空）；
  SSE 新连接清零旧「已发未确认」（刷新后首句不再等 10 秒）；`~~~` 围栏要求行首（正文里的连续 ~ 不吞后文）；
  curPara 尾部未成句时也算最新内容（超预算不再先读旧段）；dispose / 换轮后旧 reader 失效；
  诊断增加 `awaitingFlush` / `playingMs` / `budgetMs` 与 `readAloudScheduler.rejectedAcks/lastRejectedAck`；
- **追赶计时修正**（用户反馈「15s 没把朗读算进去」）：客户端在**开始播放**时就 ack，被 ack 的句子还要播 2~5 秒 ——
  追赶计时现在把「正在播放的剩余时长」也算进积压，并且客户端通过 ack 的 `durationMs` 回传真实音频时长（老客户端退回按字数估算）；
- **本轮调优汇总**（用户连续反馈后定稿）：
  - 预算 15s → **7.5s**（一半），设置项 0.5s 步进；
  - 追赶目标从「只留最新 1 段」改为「**保留最新 3 段**」（跳到最新第 3 条）；
  - 生成很快时 **skim：每段只读首句就跳**（判据 `backlogMs`，不是含流水线提前量的 `lagMs`）；
  - 计时含「正在播放的剩余时长」，客户端 ack 带真实音频时长 `durationMs`；
  - 诊断补齐：`playingMs` / `backlogMs` / `budgetMs` / `streaming` / `skim` /
    `keepParagraphs` / `trimmedSentences` / `truncatedParagraphs` / `awaitingFlush` /
    `readAloudScheduler.rejectedAcks`；
- 兼容/兜底：收不到 ack 时自动降级为旧的 400ms 时间窗口节奏（积压超预算时收尾先等 1.2s grace 再排空）；
  `flow` 模式下某句 `ACK_STALL_MS=10s` 没有 ack 就 watchdog 放行一条，永不永久卡死；
- **朗读高亮覆盖层**（2026-11-01 用户反馈修复）：覆盖层 `z-index: 2147483647` 会在
  设置弹框打开时画到弹框上面 → 改为 `z-index: 900`（高于正文、低于 DSH 的 1000 级浮层）；
  另外检测到 `[aria-modal="true"] / [role="dialog"] / [role="alertdialog"]` 时直接隐藏
  覆盖层（MutationObserver 监听挂载/卸载，关闭后自动重画）；旧样式会在下次 `set()` 时覆写；
  同时把每个色块**裁剪到「会话滚动视口 ∩ 窗口 ∩（底部输入区以上）」**——
  消息滚出视口后 Range 仍会报原位置，不裁剪就会画到输入框/顶栏上面
  （用户第二次反馈：滚动到输入框下方，高亮显示在输入框上）；
  回归 `test/highlight-overlay.test.mjs`；
- 回归：`test/read-aloud-scheduler.test.mjs`（纯逻辑）、`test/read-aloud-chain.test.mjs`
  （真实钩子 + 模拟客户端 ack 的端到端）、`test/read-aloud-catchup.test.mjs`（含 pending 收尾时限）。

### 8. 聆听与朗读是两个独立的事

麦克风按钮**只管聆听**；朗读有独立的「停止朗读」按钮和设置里的总开关。

| 入口 | 职责 |
|---|---|
| `stopListening()` | 关麦、识别状态、草稿基准、各类定时器 |
| `stopPlayback()` | 清朗读队列、代次自增、停当前播放、标记本轮静音 |
| `stopAll()` | 两者都停，**只在组件卸载时用** |

以前是一个动作干两件事（点麦克风 = 关麦 + 停朗读 + 清草稿基准），
带来两个问题：「停止朗读但继续听」做不到；
`once` 模式「说完就关麦」会顺手把这一轮的朗读也清掉
（LLM 响应够快时，刚入队的第一句就被清掉 → 这一轮一句都读不出来）。

朗读按钮只在**正在朗读时**出现，不占地方也不会误点。

> 真实模型的慢集成（SenseVoice 预加载等）：`DSH_VT_SLOW_TESTS=1 npm test`；默认套件走快速路径并显式跳过。

### 7.10 配置校验与配合（2026-11）

- **统一 schema**（`lib/config-schema.js`）：加载时 sanitize（非法/越界回退默认，可观测到 `/diagnostics.configWarnings`）；保存时 validate（非法 → `400 {ok:false,errors}`）。
- **引擎归一化**：`online/local/neural/sovits` 白名单；非法值不会再静默落 online（不再把文本误发给 Edge）；`/tts/warmup` 只对 online 预热；`/voices` 对 neural/sovits 返回空列表；`/tts/env` 含 sovits。
- **识别模型解析一致**：非法档位保存被拒、运行时 400（不再静默回退 SenseVoice）；空闲释放保护实际解析出的模型。
- **UI 联动/依赖**：language 只对 SenseVoice 生效；`liveAsr=stream` 依赖 zipformer2-zh；`autoSend=false` 时 `mode=once` 禁用；朗读关闭时仍可预配引擎；`words` 输入保留原始文本、保存时归一化；reload 不再清掉未保存修改；本地→在线回退会在 UI 提示。
- 见 README「配置项的配合关系（生效条件矩阵）」。

## 已知限制

1. **本地 TTS 每次要起 PowerShell 进程**（~800ms），可以改成常驻进程但复杂度高
2. **`scope.sessions` 只缓存插件启动时的会话**，切换会话后需要等宿主重新注入
3. **TTS 预热在开麦和勾选「朗读回复」时触发**（也有独立的 `GET /tts/warmup` 可单独调用）。
   预热是为了省掉首次合成的 TLS 握手（约 2.5 秒），
   没预热时首句会明显慢一点
4. **识别无重试机制**，网络失败时保留实时字并提示用户

## 调试入口

| 接口 | 用途 |
|---|---|
| `GET /dsh-voice-typing/config` | 当前配置（诊断/统计走 `/diagnostics`） |
| `GET /dsh-voice-typing/voices?engine=online\|local` | 音色列表 |
| `GET /dsh-voice-typing/tts?text=…` | 合成测试 |
| `GET /dsh-voice-typing/tts/warmup` | 预热连接 |
| `GET /dsh-voice-typing/busy` | 助手是否在生成 |
| `GET /dsh-voice-typing/stream` | SSE：sentence / turn-begin / turn-end / call-end / assistant-busy / model-* 事件 |

## 回归测试

```bash
npm test             # 42 个测试文件（不连宿主；先跑 bundle-sync + client-behavior）
npm run build:client # 把 src/client/pure/ 内联进 lib/client.js
npm run check:client # 只校验产物是否最新（CI 用）
npm run test:silence -- http://127.0.0.1:<端口>   # 静音与流式识别回归（需要宿主在运行）
```

`npm test` 里有一部分是「静态正则匹配源码」的断言，
它们能挡住回归，但重构时会误报或漏报；
涉及行为的断言会**从源码里提取纯函数出来求值**再跑场景
（见 `test/draft-merge.test.mjs`、`test/gate-host.test.mjs`）。

行为正确性仍以实测为准。
