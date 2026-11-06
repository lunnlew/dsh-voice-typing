# 维护者须知

改这个插件之前先读这份文档。它记录的是**反复出问题的地方和对应的硬规则**，
每一条都对应一个真实修过的 bug；以及改完之后要跑什么、怎么发布。

- 接口形状、事件格式、代码结构、配置之间的配合关系：看 [reference.md](reference.md)。
- 每一轮架构改造改了什么、为什么、怎么验的：看
  [architecture-modernization.md](architecture-modernization.md)（下面简称「批次记录」）。

> **这份文档从哪来**：主体是原 README 的 §9.7「维护者须知」，一字未改地搬过来；
> 原 §9.7 里那张「配置项的配合关系」表搬去了 [reference.md 第 7 节](reference.md)，
> 最后一节新增了原 SNAPSHOT-NOTES.md 里仍然成立的设计决策与已知限制。
> 批次记录里写「README §9.7」的地方，指的就是本文。

---

## 1. 反复出问题的地方与对应的硬规则

这一节的每一条都对应一个真实修过的 bug。**改动这块代码前请先读一遍。**

#### 作用域：三个地方拿不到东西

宿主侧有三层作用域，引用错了会抛 ReferenceError，
而表现常常是「某个功能安静地不工作」，不报错。

| 位置 | 能拿到 | 拿不到 |
| --- | --- | --- |
| 模块级函数 | 只有模块级变量 | `settings`、`scope`、`t` |
| `ctx.on('llm/stream', ...)`（注册在 inject 之外）| 模块级变量 | `scope`、`settings` |
| `ctx.inject([...], cb)` 回调内 | 全部 | — |

**规则**

- `llm/stream` 钩子里要用配置，走模块级的 `currentSettings`，不要写 `settings`。
- 翻译函数 `t` **不能**在模块级函数里用；模块级 `label: () => ...` 只能写死文案（写 `() => t('x')` 会让设置面板白屏）。

#### 组件必须在模块级定义

`Label` / `Section` / `Toggle` 这类小组件如果定义在组件体内，
每次渲染它们都是新的函数 → React 认为组件类型变了 → 卸载并重建 →
**设置面板里的输入框每敲一个字符就失焦**。

**规则**

- 任何被 `React.createElement` 当作类型用的组件，都定义在模块级。
- 组件体内只放「每次渲染都该新建」的东西（style 对象、回调）。

#### 引用稳定性：effect 的依赖必须稳定

`useCallback` 写成裸箭头函数时，**每次渲染都是新引用**，
依赖它的 effect 会反复重跑：连接刚建立就被关掉、无限重渲染、
点一下按钮就滚到顶部。

**规则**

- 所有传给 `useEffect` 依赖数组的值都要 `useCallback` 包住，且依赖完整
  （漏依赖 = 读到过期值）。
- 翻译函数 `t` 必须 `useCallback` 包装。

#### 静默失败：空 catch 会掩盖故障

`catch {}` 到处都是。改动时至少要区分「可忽略」和「要上报」。

**规则**

- 面向用户的失败必须有可见反馈（提示条 / 状态文字），不能只写日志。
- `catch {}` 里至少留一行注释说明为什么可以忽略。

#### 状态复位：关掉什么就要清什么

**规则**

- 任何「停止」类动作，都要把该动作涉及的所有状态一次清干净：
  定时器、队列、标志位、草稿基准。
- 定时器**必须**跟着状态一起清。漏清的后果是「关了麦草稿还自己发出去」。
- 清状态的职责要单一：`stopListening`（聆听侧）、`stopPlayback`（朗读侧）、
  `stopAll`（两者，仅卸载时用）。一个动作不要隐式包含多个不相关职责。

#### 共享状态：过期快照不能写回

异步请求拿到的数据是**发起请求那一刻**的快照。

**规则**

- 拿到配置后**不要**无条件写回共享存储（`configStore.set(next)`）。
  用户在这期间改过设置的话，旧快照会把他的修改覆盖掉。
- 共享存储的权威来源只有一个（设置面板：加载时和保存时）。
- 读配置时要**合并**，不要整份取舍：
  `configRef = { ...宿主返回的, ...共享存储 }` ——
  存储里有值的键以存储为准（它是用户刚保存的），其余用宿主这份补齐。
- 拉配置要**能重试**：只拉一次的话，宿主刚启动时那一次失败就再也补不回来。

#### 回合边界：不要用启发式

「这是不是新的一轮对话」曾经用「会话里的用户消息条数变化」判断 ——
但本轮用户消息写入 session 的时机和 LLM 开始输出**不一致**。

**规则**

- 判定新回合必须容忍「消息延迟写入」：同一回合内多次 `llm/stream`
  （工具调用链）不能重复触发打断。
- **用 `llm/stream` 请求里的 `options.messages` 数用户消息条数**，
  不要读 session 里的。**只认「条数增加」为新回合**。
- 这套回合判定抽在**独立模块** `src/host/turn-model.js`（`createTurnModel` 工厂）。
- **每一轮对话有唯一的 id**（`turnId`，递增序号），句子里带着它。
  ⚠️ 轮次 id **不能**用「本轮最后一条 user 消息的内容锚点」生成。
- 回合事件只有 `turn-begin` / `turn-end` 两个，**不要**再加别名事件。
- `turn-end`（协议 v3）表示**真正的一轮结束**；`call-end` 表示**一次** `llm/stream` 调用结束。
- 回合状态表**不会无限增长**：用空闲超时兜底 —— `turnModel.prune()` 每 60 秒
  清掉超过 10 分钟没活动的会话的回合状态。

#### 外部 GPT-SoVITS：只做转发，不内置、不克隆、不回退

GPT-SoVITS 是 PyTorch 推理体系（官方只提供 `api_v2.py` HTTP 服务），没有能在 Electron 里直接跑的 ONNX 管线。
所以插件把它当成**外部 TTS 引擎**：

- 插件不管理模型/参考音频、不做声音克隆，只按官方 `/tts` 契约转发 `text`/`text_lang`/`prompt_lang`
  （以及用户配置的 `ref_audio_path`/`prompt_text`），拿回 wav；
- **失败绝不回退** Edge/系统语音：用户选它就是要自己的声音与隐私，不能偷偷把文本发给微软、也不能换音色；
- 宿主的请求超时（`SOVITS_TIMEOUT_MS`）必须早于客户端单句合成超时（`TTS_TIMEOUT_MS`），
  否则客户端先放弃、错误只剩「没声音」—— 这条是四个引擎共同的，见下面「跨端时间契约」；
- 失败计入 `/diagnostics.sovitsTts`（`failures`/`lastError`/`lastAt`）。

回归：`test/sovits-tts.test.mjs`（契约/URL 规范化/失败/超时/不回退 + 宿主接线 + 构建产物 UI）。

#### 跨端时间契约：每个引擎都要比客户端先给回执

客户端等一句合成最多 `TTS_TIMEOUT_MS`（这个数字**只住在** `src/client/pure/voice-constants.js`）。
顺序必须是「宿主先返回、客户端后放弃」：反过来用户看到的就是一片静音，
因为宿主那个错误到不了界面。四个引擎各自的上限与守着它的判据：

| 引擎 | 宿主侧上限 | 判据 |
| --- | --- | --- |
| 在线（Edge） | `DEFAULT_TIMEOUT_MS`（+3 秒的串行锁硬超时） | `test/edge-tts.test.mjs`：把 `setTimeout` 换成记录器，量**实际登记的毫秒数** |
| 本地系统语音 | `TIMEOUT_MS`（未导出，随 `execFile` 的 `opts.timeout` 走） | `test/local-tts-command.test.mjs` 末尾：按**每一次真调用**逐条数「带 timeout」+「早于客户端」 |
| GPT-SoVITS | `SOVITS_TIMEOUT_MS` | `test/sovits-tts.test.mjs`：常量层面比 + 不传 `timeoutMs` 真跑默认那条，看中止登记在哪个毫秒 |
| 本地神经 | `NEURAL_WAIT_TIMEOUT_MS` | `test/neural-worker-exit.test.mjs`：真起子进程 + 永不回话的替身线程（到点给回执、拆线程、定时器不按住进程），末尾另有一条读生产常量比先后 |

**为什么不把这些数字搬进 `src/shared/`**：客户端那两条 deadline 在宿主运行期从来不被消费，
搬过去只是搬文件。这条关系是**契约**，由判据守着（改反了就红），不是由目录结构守着。
注释里也**不复述另一端的数字**（历史上复述过一次就过期了：`edge-tts.js` 写过「客户端 15000」，实际早已 25000），
只写常量名 + 判据在哪个文件。

#### 朗读失败不静默（可观测性）

「朗读没声」最怕无从排查。现在三种情况都留痕：

- **宿主**：`/diagnostics` 里 `localTts` / `onlineTts` / `neuralTts` 各带
  `failures` / `lastError` / `lastAt`。
- **客户端**：`synth` 失败时 `ttsFailuresRef` 计数 + **节流**（>4 秒）弹一次短词
  「朗读失败」，完整说明走悬停。
- **调试**：浏览器控制台 `__DSH_VOICE_DEBUG__()` 能看到 `ttsFailures`。

#### 朗读无声：共享连接坏掉后必须丢弃（最坑的一条）

在线（Edge）合成复用**同一个 WebSocket 实例**，换连接单句要贵 4~5 秒。
复用本身没错，错在**什么时候该丢掉它**。真实故障是「合成结束但没有收到音频数据」
—— 这也是连接坏了。这条原来**不丢连接**，坏连接被一直复用，之后每一句都返回空音频。

**规则**

- 判断「该不该丢连接」必须走**同一个判据** `isBrokenConnection()`，不要四处各写正则。
- 它的正则必须包含「没有收到音频数据 / 超时」。只判 WebSocket 字面错误必然漏。
- `chunks.length === 0` 那条分支要**自己调 `disposeTts()` 再抛错**，别指望外层 catch。
- 回归测试 `test/edge-tts.test.mjs`（合并了原 tts-pending/reconnect/lock-hardtimeout）：用假合成器模拟「坏连接返回空音频」，
  断言第二次调用会**重建实例并成功**。
- 改完要**重启 DSH**（`src/host/edge-tts.js` 是宿主侧模块）。

#### 朗读无声：播放上下文必须等恢复

浏览器**自动播放策略**会把新创建的 `AudioContext` 留在 `suspended`。
若在上下文恢复完之前就 `source.start(0)`，音频会一直排队不响。

修复：`play()` 在 `start` 前 **await** `resume()`，并在首次用户手势（点击/按键）时
预热并恢复播放上下文。

**等多久、超时怎么办**：

- **不能只等 1 秒就跳过**。`resume()` 是异步的，实测要 1~3 秒。
- 现在的做法：先 `await playCtx.resume()`，再**轮询**到 `state === 'running'`，
  最多等 8 秒。
- 8 秒还挂起才算彻底失败，这时跳过这一句并 `playSkippedRef += 1`，
  调试快照 `__DSH_VOICE_DEBUG__().playSkipped` 能查到。
- 回归测试：`test/client-behavior.test.mjs` 用**真实构建产物** `lib/client.js`（vm + 假 DOM/AudioContext）
  驱动真实播放循环，覆盖 resume/gen 复查、ack 恰好一次、停止/换轮后不出声等行为；
  仓库内原 `read-aloud-resume.test.mjs` 测的是复制出来的逻辑（已与真实实现漂移），已删除。

#### 朗读队列：代次机制

`speakGenRef` 递增即作废所有旧音频。

**规则**

- 停止朗读要**三件事一起做**：清队列 + 代次自增 + 停掉当前播放。
  少一件就会出现「停了还在播」。
- 停当前播放**不能**只靠「当前那一个取消句柄」：要登记**所有**还活着的音频源，停止时逐个 `stop()`。
- SSE 是常驻的，所以「本轮不再朗读」必须有单独的标记（`mutedTurnIdRef`）。
- 队列为空时**不要**把状态设成「朗读中」。

#### 朗读切分：按段落收集，段内再按完整句子，代码块绝不能念

**层级**：

1. **先按段落收集**（splitParagraphs，src/host/paragraph.js）：空行 / 列表项 / 标题 / 引用为段落边界。段落是朗读的基本单元，段内句子连贯、不混入其它段落。
2. **段落内按句末标点切句**（splitLongText）：保证完整句子，绝不在句子中间 / 词汇中间断开。

**两条硬规则**：

1. **不要在句子中间切断**。切分优先级（`splitLongText`）：
   - 句末标点 `。！？；` → 完整句子；
   - 句内标点 `，、：` → 半句，**仅在远超上限（>2 倍）时**才用；
   - 硬切（无任何标点）→ 停顿怪，但总比无限长好。
   - 略超上限但不到 2 倍 → **整句不切**。
2. **代码块一个字都不能念**。围栏识别必须在**流层面**做，而且必须**跨 chunk**（``` 与旧行为一致：任意位置；`~~~` 围栏按 Markdown 规范要求**行首**，避免正文里 3 个连续 `~` 把后文静默吞掉）（`src/host/fence-filter.js`）：模型按 token 流式输出，围栏标记 `` ``` `` 可能正好被 chunk 边界切成两半（"``" + "`js"）。旧实现逐块 `split('```')` 会在这种切法下状态错位：代码被念出来、围栏后的正文反而被当代码丢掉。

回归：`test/read-aloud-fence.test.mjs`、`test/read-aloud-list.test.mjs`。

> **当前策略速查（2026-11-01 定稿）**
>
> | 项 | 值/行为 |
> |---|---|
> | 发句节奏 | 客户端每**开始播放**一句回 `/reading-ack`，宿主补发；未确认上限 `READ_ALOUD_LEAD=3` |
> | 追赶预算 | `readAloudLag`，**默认 7.5 秒**（0 = 关闭追赶，全部朗读） |
> | 追上去哪 | 跳过未开始的整段旧段落，**保留最新 3 段**（从最新第 3 段开始读） |
> | 生成很快时 | skim：正在读的段**只读首句**就跳走（判据 `backlogMs` 超预算且仍在生成） |
> | 计时口径 | `lagMs` = 正在播放的剩余时长 + 已发未确认 + 队列未发 + 当前段尾巴（含流水线提前量） |
> | 收尾 | `pending`（无 ack）+ 超预算：等 1.2s grace 再排空；`flow`：按 ack 逐句补发 |
> | 兜底 | watchdog 10s 放行一条；SSE 重连清零旧未确认；客户端安全网按整段软上限裁剪 |
> | 诊断 | `/diagnostics` 的 `readAloud[]`：`lagMs/playingMs/backlogMs/budgetMs/skim/trimmed*/keepParagraphs/awaitingFlush` |
#### 朗读发送节奏：客户端播放进度流控（不是固定时间窗口）

助手一次可能吐出一大段文本，而浏览器真正「念出来」受音频播放时长限制
（2~3 秒/句）。如果宿主只管按固定节奏猛发（历史上是 400ms/句 = 2.5 句/秒），
生产速度是消费速度的 5~8 倍 —— 客户端必然积压，最后只能丢内容，
表现为「朗读不按自然段落、总挑到段落中间」。所以节奏必须由**播放进度**驱动。

**规则**（唯一实现在 `src/host/read-aloud-scheduler.js`）：

- **客户端播放进度驱动**：宿主维护「已发未确认」句数，上限 `READ_ALOUD_LEAD`（3）。
  客户端每**开始播放**一句就 `POST /reading-ack` 回一条，宿主才补发下一句。
  于是朗读节奏 = 真实播放节奏：不积压、不跳段，和屏幕内容的差距恒定在几句以内。
- **首句不排队**：第一句**无条件立刻发**（实测 0ms），用户尽早听到声音。
- **段落是朗读单元**：一段的句子全部发出后才轮到下一段；**短段落（≤60 字）整段作为一个朗读片段**
  （仍然是完整句子），超过单句上限才按句末标点切句。正常情况下绝不从段落中间开始念
  （事件带 `para` / `paraStart`，客户端据此按整段裁剪）；**例外**是下面的
  「生成很快时只读首句」——此时正在读的段允许在首句后截断（用户明确要求）。
- **老客户端兼容**：收不到 ack 时自动降级为旧的 400ms 时间窗口节奏；
  `pending`（旧）模式下调用结束时同步发完剩余句子（不丢尾巴）。
- **追赶最新（可调，默认 7.5 秒）**：估算「待朗读音频时长」= **正在播放的剩余时长** + 已发未确认 + 队列里没发的 + 当前段落剩余文本（按约 210ms/字估算，客户端会回传真实音频时长所以一般更准）；超过设置项 `readAloudLag` 就**跳到最新几段**：保留「已开读的段」+「**最新 3 段**」，中间未开始发的完整段落整段跳过（当前段读完后，下一段是**最新第 3 段**，再顺序读到最新段 —— 既追上最新内容，又保留一点上下文）。
- **生成很快时每段只读首句就跳**：仍在生成中、且「还没发出去的内容」（`backlogMs`，不含正在播放/已发未播的流水线提前量）超过预算时，正在读的段落**不再强制读完** —— 发出首句后就把该段剩余句子放弃，直接跳到下一段/最新段（任务要求：跳走时只需要读首句）。判断用 `backlogMs` 而不是 `lagMs`：生成慢时流水线提前量本身就可能超过预算，用 `lagMs` 会把正常朗读也截断。生成结束后（或 `backlogMs` 回到预算内）恢复正常完整朗读，剩余段落不会被读残。
  跳过时只整段丢「还没开始发」的段；**例外**：生成很快、仍在流式输出时，正在读的段可以
  **只读首句就跳走**（下方的 skim），不再强制整段读完；生成结束后的剩余段落完整读完。
  `0` = 关闭追赶（全部朗读，长回复会越读越滞后）。
- **watchdog 只在真发句 / 收到 ack 时重新计时**：持续收到文本不算进度 —— 否则客户端不 ack 时 watchdog 永远不会触发（评审实测 2.2s 放行 0 次）。
- **收尾 grace**：`pending`（老客户端 / 首条 ack 未到）且积压超预算时，一次调用结束**先等 `FLUSH_GRACE_MS`（1.2s）**再同步排空；期间 ack 到了就切 flow 走追赶（否则"结束即排空"会让追赶在这条调用上完全失效）。老客户端没有 ack，grace 到点后照旧发完，不丢尾巴。
- **SSE 重连释放配额**：页面刷新 / 断线重连时，旧连接遗留的「已发未确认」永远不会再被 ack，新连接建立即清零（否则新页面首句要等 watchdog 10 秒）。
- **watchdog**：`flow` 模式下某句发出去 `ACK_STALL_MS`（10 秒）还没 ack
  （客户端掉线 / 播放被跳过；长句播放本身也可能十几秒，所以阈值不能太短），
  放行一条，保证朗读不会永久卡死。

回归：`test/read-aloud-scheduler.test.mjs`（调度器纯逻辑：流控/追赶/保留 3 段/skim/watchdog/重连）、
`test/read-aloud-catchup.test.mjs`（真实钩子 + 真实 ack 的追赶端到端）、
`test/reading-ack-contract.test.mjs`（ack 契约/边界）、
`test/read-aloud-catchup.test.mjs` 的 e2（pending 收尾时限）、端到端 `test/read-aloud-chain.test.mjs`。

#### 客户端安全网：按整段裁剪（不承担「追最新」职责）

> 「追赶最新」由**宿主侧**负责（`readAloudLag`，见上一节）：积压超预算就整段跳旧段、
> 保留最新 3 段，生成很快时每段只读首句。
> 下面客户端的安全网只兜底「老宿主 / ack 丢失 / 重连」这类异常，正常流控下不会触发。

生成通常比朗读快。客户端待播队列积压太多时，听到的内容会离屏幕越来越远；
但**绝不能丢「接下来马上要播的那几句」** —— 那会让播放位置向前跳、落点在段落
中间（用户听到的就是「不是按自然段落朗读，总挑到非首句」）。

**规则**

- **只读当前这一轮的句子**：句子的 `turnId` 与当前轮次不一致就丢掉。
- **安全网裁剪（`MAX_PENDING`）按整段进行，且是软上限**：超限时从最旧开始**整段丢弃**
  （同一 `para` 的整组一起丢），并保护 ①正在播放的段落 ②本轮**第一段** ③**最新一段**。
  可丢的组都在受保护组之后时**宁可不丢**（允许暂时超过上限），绝不为了压上限丢掉最新内容。
  于是播放永远是「完整段落」的向前推进，不会从段落中间开始、也不会丢「正在读那段的剩余句子」。
- **不重复播放**：客户端按 `(turnId, index)` 去重；宿主段落补全时按已发**字符数**
  减前缀，绝不把已发句子再发一遍（旧实现用字符串 `startsWith` 且无兜底，
  一旦不匹配就把整段重发 —— 那是「读完后面又回去读前面」的来源）。
- 正常情况下流控已把队列压到几句，这条安全网只在异常（客户端卡顿 / ack 丢失）时生效。

#### 朗读高亮覆盖层：绝不能画在弹框/输入框上面

朗读时会在页面上叠一层半透明色块，圈出「正在念的那一句」。它是 `position: fixed`
的覆盖层，**z-index 不能取整型最大值**：DSH 的弹框/遮罩是 `z-index:1000` 级别的浮层，
覆盖层取 `2147483647` 就会在设置弹框打开时画到弹框上面（用户反馈）。

**规则**

- 覆盖层 `z-index: 900`：高于消息正文（正文没有 z-index），低于弹框/遮罩（1000+）；
- 第二道保险：检测到 `[aria-modal="true"]` / `[role="dialog"]` / `[role="alertdialog"]`
  时**直接隐藏覆盖层**（`data-voice-reading-hidden`），并用 `MutationObserver` 监听
  弹框挂载/卸载 —— 弹框关闭后自动恢复并重画；
- 旧样式迁移：已注入的旧 `<style>`（z-index 2147483647）会在下次 `set()` 时被覆写，
  页面不刷新也能生效。
- **裁剪到会话滚动视口**：消息滚出视口后，Range 的矩形仍然会报「原位置」
  （父级 `overflow` 只是视觉裁掉），覆盖层会把高亮画到**输入框/顶栏上面**
  （用户反馈：滚动到输入框下方时高亮显示在输入框上）。所以每个色块都与
  「滚动视口 ∩ 窗口 ∩（底部输入区以上）」求交集，完全在视口外的不画；
  底部输入区只认「下半屏、够宽」的 `[data-slot*="composer"] / textarea / contenteditable`，
  避免把顶栏搜索框当底栏；

回归：`test/highlight-overlay.test.mjs`（对构建产物 `lib/client.js` 断言 z-index/隐藏/
旧样式迁移/启动清理/视口裁剪）。

#### 朗读管道不能永久卡死

`pumpQueue` 的消费循环 `await` 每句的合成 promise。若某句挂住，`await` 永不 resolve。

**规则**

- **每句合成都要有超时兜底**：`await Promise.race([promise, sleep(...)])`。
- **播放上下文要在 try 内取**。
- **object URL 必须在 `finally` 里释放**。
- 宿主 `llm/stream` 里 `next()` **同步抛错时必须复位 busy**。

#### 状态行只放短词

**规则**

- 状态行只显示**短词**（「加载模型…」「朗读中」「已停止」）。
- 完整说明放到 `…Detail` 文案里，鼠标悬停显示。
- 状态行给一个 `minWidth`：换状态时宽度不变，界面不跳。
- **界面那句话只能由 i18n 出**：宿主跨这两条就绪路由（`asr-ready` / `asr-warmup`）回的是**原因码**，
  客户端查表翻成当前语言（`src/client/pure/asr-ready-text.js`）；词表外的值走兜底那句，
  宿主的原样一个字都不进界面，只留在 `__DSH_VOICE_DEBUG__().lastAsrReadyReason` 给排查。
  以前写的是 `data.reason || t('...')`（宿主那句排前面），于是英文界面弹中文提示 —— 见 docs §8.60。
- **系统级热键那条链路按同一件事处理**（批次 19，docs §8.61）：helper 的 `reason` 是
  `src/shared/hotkey-reasons.js` 里的原因码（或空串），面板查 `src/client/pure/hotkey-reason-text.js`
  按当前语言出句子；状态行只放短词（「失败」），原因那句在下面的说明行。带变量的原文
  （组合键名、pid、退出码、系统报错）走 `detail`，只进 `/diagnostics`，界面上不显示任何原文 ——
  词表外的值（比如老宿主那句中文）走兜底那句 `hotkeyReasonUnknown`。
- **保存设置失败那行红字是同一条链路的第三处**（批次 20，docs §8.62）：`POST /config` 的 400 回
  `{ok:false, errors:[{key, reason, detail}]}`，`reason` 是 `src/shared/config-error-codes.js` 里的原因码，
  面板显示的那一行由 `t(配置键)：configErrorText(码, 键, t)` 拼出来 —— **两半都来自字典**。
  这一路比前两批少一层：句子里的允许值、区间、长度上限由客户端自己按 `key` 去
  `src/shared/config-spec.js` 算（两端读同一份规则），所以**没有参数协议**，宿主的文本一个字都进不去；
  宿主的原始句子与「第几条出错」留在 `detail`，只在响应体、日志与 `/diagnostics` 里看得到。
- **设置面板那两行「快捷键不合法」红字是同一条链路的第四处**（批次 22，docs §8.64）：
  `src/client/pure/shortcut.js` 的 `validateShortcut` 返回的是 `{ok, reason, params}`（五个码就定义在这个文件里，
  面板查 `src/client/pure/shortcut-error-text.js` 按当前语言出句子），词表外的值走 `shortcutErrorUnknown`，
  传进来的原文一个字都不进界面。**这一族和前两批唯一的差别是词表不进 `src/shared/`**：发码和译码的都在客户端，
  没有跨进程边界，搬进 shared 只是换个目录；「产物里只许一份」由 `test/bundle-sync.test.mjs` 守。
  参数（哪个修饰键不认识、哪个字母、哪一组被占用）由校验层给、由 `t(key, params)` 填 ——
  客户端自己的兜底取词以前写成 `(key) => zh[key] ?? key`，第二个参数直接丢掉，带参数的句子会显示成字面量 `{modifier}`，
  批次 22 把它合成了 `pure/i18n.js` 的 `zhTranslate`（同一条也修好了批次 20 那句区间在兜底路上的显示）。
- **面板自己那三十来处中文是同一条链路的第五处**（批次 22-2，docs §8.65）：引擎选项那四项、空闲释放那五档、
  「说话人 N」、MP3 格式那两行、词表输入框的占位符、「（需先下载 zipformer2-zh）」、「平台：」「显卡：」
  「未检测到 NVIDIA 显卡」现在全部由 `src/client/pure/i18n.js` 出。语言名和音色名以前更隐蔽 ——
  它们**早就在这个字典文件里**，但是两张**只写中文的表**（`languageLabel` / `voiceLabel` 压根不看界面语言），
  现在改成查「契约值 → i18n 键」的三张表（`LANGUAGE_LABEL_KEYS` 6 条 / `VOICE_LABEL_KEYS` 24 条 /
  `TTS_ENGINE_OPTION_KEYS` 4 条）、按当前语言出句子。**中文侧的展示名一个字没改**（跟 HEAD 逐条对过，30 条全等），
  英文侧那 30 条是本批新写的。词表外的值**原样返回传进来的值**：未知音色继续显示上游那个短名，
  不编一句「未知音色」把它盖掉 —— 短名本身是排查时要看的信息。
  这一族**没有再开新模块、也没有跨端码表**：宿主不参与选项文案，多一个文件只是多一处以后要来查地址的地方。
  判据落在渲染出来的树上：树里那句汉字的每一段连续汉字都得能在 `zh` 的值里找到出处（契约值与标点先摘掉）——
  为什么不是「产物里不许有汉字」，见 docs §8.65（唤醒词同音表、无障碍允许/禁止词表都合法地含汉字）。
  两件明确没做，别当已做：`：` 这类全角分隔符是**排版不是话**，还留在组件里（待办）；
  环境行的 `e.label` / `e.detail`（宿主 `src/host/tts-env.js` 那句中文从这里进界面）和「保存失败」那句后面
  拼的 `error.message` 仍然会原样进界面，那是批次 22-3。
- **模型档位名是同一条链路的第六处**（批次 22-3-1，docs §8.66）：这一处的前提出自一条实测发现 ——
  宿主目录 `src/host/model-catalog.js` 里九个档位**本来就有中英两份名字**（`label` + `labelEn`），`/models` 两份都发，
  而面板四处渲染点读的全是 `m.label`：**宿主那份英文从写下来那天起就没上过界面**。
  现在档位名查 `MODEL_LABEL_KEYS`（9 条 id → i18n 键）走 `modelLabel(id, t)`，按界面语言出句子，
  宿主的 `label` 不再进界面（宿主一字未改，仍照原样发两份）。**为什么不是「宿主按语言挑一句」也不是
  「客户端按语言挑 `label` / `labelEn`」**：前者把句子还给生产者（§8.60 以来一路否掉的形状），
  后者做不到 —— 客户端不知道自己该说哪种语言，`t` 是宿主 locale 系统给的唯一通道。
  代价是同一段文字住两处（目录 + 字典），付账的方式是判据「**字典那句必须逐字等于目录那句**」：
  改任何一边当场红，不靠「记得两边都改」。词表外的 id 原样返回（不编「未知模型」）。
  判据同样落在渲染树上，另加一轮英文挂载：切英文后树里每一段汉字都得能在**英文那份字典**里找到出处
  （合法例外只有英文文案自己举的中文例子，如唤醒词「小鱼」）——见场景「面板·模型名」。
- **运行环境自检那四行是同一条链路的第七处**（批次 22-3-2，docs §8.67）：面板点「重新检查」走的
  `GET /tts/env`，改前每行显示的是 `src/host/tts-env.js` 手写的中文整句（`可用（Windows PowerShell 5.1），默认发音人：…`、
  `模型还没下载（本地中英双语 VITS），请到设置里点「下载」。`、`连不上：${error.message}`），
  英文界面上「Edge 在线 / 本地系统语音 / 本地神经模型 / GPT-SoVITS」这四行的行名与状态句**整片是宿主写的中文**。
  现在宿主回 `{available, reason, params}`（十四个码见 `src/shared/tts-env-reasons.js`），面板查
  `src/client/pure/tts-env-reason-text.js` 按当前语言出句子；行名同理查 `ENV_ENGINE_LABEL_KEYS`，
  宿主的 `label` **从响应里删掉了**（不是「留着不读」——同一个引擎有两个展示名，读错那一头就是原 bug）。
  这一族比前六族多一层**参数协议**：`TTS_ENV_REASON_PARAMS` 写明每个码必须带哪几个参数，
  判据两头核对（宿主那头：`test/tts-env-check.test.mjs` 真跑自检函数逐码比对参数名正好是这些；
  字典那头：判据 19 要求中英两句里的 `{占位符}` 集合等于那份表）。
  `{runtime}` 是唯一还要再过一次字典的参数（`native` / `wasm` → 「原生加速 / native runtime」）：**一个词也是话**，
  否则上游那个英文技术值就借「参数」这条路回到界面上。词表外的值一律走 `envReasonUnknown`，
  宿主 `detail` 那句原文一个字都不进界面 —— 它现在的读者是 `/diagnostics` 与装机排查。
- **保存请求根本没走通那行是同一条链路的第八处**（批次 22-3-3，docs §8.68）：这一支 catch 接的**不是宿主的中文**，
  而是**浏览器给的技术串** —— 改前写的是 `${saveFailed}：${error.message}`，fetch 被拒时界面上出现
  `保存失败：Error: Failed to fetch`（中文界面冒英文串，英文界面那句也读不出该做什么）。
  判据仍是「这句话会不会进界面」，不看说话的是宿主还是浏览器，所以处理方式一样：
  那句进字典（`saveFailedNetwork` 中英各一份），原始 message 只进 `console.warn`，状态行仍是短词 `saveFailed`。
  「没连通」与「拿到回执之后本地出错」两类失败现在分开走（两段 try），后者仍只说短词那句 ——
  **没有为它编新句子**：宿主已回 200 之后剩下的只有回填与共享存储，那两个订阅者都是纯赋值，
  当前代码里没有可抛出的路径（为不可达的分支写文案就是编话）。
  同一族的最后一处现在做完了：面板「下载模型」那条链路两侧各有毛病（docs §8.68 记的两种相反的病）。
  ① 请求被当场拒绝时 `setStatus(body?.error ?? …)` 把宿主路由层那句话**原样**贴上界面（`/model` 的 404 `unknown model: {id}`、
  409 那句中文的内置档位不可用，中文界面冒英文 id 或反之）；
  ② 后台下载真的失败时（`model-catalog.js` 那十几句：`该档位没有可下载的文件：…`、`分片下载失败：…（第 n 片）`、
  `拼接后大小不对：…`）宿主经 `model-error` 事件把 `error.message` 送出来，面板却**一个字都不显示**、只留「下载失败」——
  同一族的两种病：一边是原文泄漏，一边是原因丢失。
  **发端**由批次 22-4-1 治好（docs §8.70）：十个原因码住在 `src/shared/model-download-reasons.js`，
  宿主七个抛点、路由的 404/409 与后台的 `model-error` 事件都带 `reason` + `params`，原文仍留在 `error` 字段只给诊断。
  **收端**由批次 22-4-2 接上（docs §8.71）：`src/client/pure/model-download-reason-text.js` 按码查字典出句子，
  面板那两处（SSE 的 `model-error` 监听、`download()` 里非 2xx 的分支）都只读 `reason` + `params`，
  原文改走 `console.warn`。十句按「用户该做什么」分三类，**没有合并**：
  再试一次（网络类五种）、重试没用（档位本身有问题四种）、什么都不知道（`failed-unknown`）——
  把第二类说成「再试一次」就是让用户白点按钮。「完全没带码」与「码读不出来」也是两句：
  前者是旧宿主的兼容路径（`downloadFailed` 那句），后者是数据不一致（`downloadReasonUnknown`）。

#### 草稿：我们记的和用户看到的不一定一致

**规则**

- 写新内容**之前**先调 `syncUserEdit()` 检测用户是否改过。
- 「我们有没有写过」不能只看内容是否为空（首次写入会被误判）。

#### 流式识别：门限不能一刀切

**规则**

- 底噪**只在静音时**更新。
- 进入说话态后，单帧偏低不能中断；连续若干帧都低才退出。

#### 定时器：必须登记到登记表

**规则**

- 源码里**不允许**出现裸的 `window.setTimeout` / `window.setInterval`。
- 定时器按 group 登记（`mic` / `send` / `ui` / `app` / `request`），状态复位时按 group 一次清干净。
- 短时等待统一用 `sleep(ms)`。

#### 同一判据只能有一处实现

**规则**

- 能共享就共享（宿主侧无限制，可以自由拆文件）。
- 因浏览器模块不能 import 本地文件而必须写两份时，
  两份要由**同一份用例表**（`test/fixtures/`）驱动，断言两端行为一致。
- 配置清单的**唯一真源在宿主**：`GET /config` 返回生效配置。

#### 下载：数据必须是真的

**规则**

- 档位里声明的文件大小必须是**实际大小**，不能用估计值。
- 文件名要对着仓库实际的名字写。
- 进度用**绝对字节**语义，不要用增量语义。

#### 原生库：类别用错会杀进程

**规则**

- 流式 transducer 必须用 `OnlineRecognizer` + `isReady`/`decode`/`inputFinished`。
- 离线模型才用 `OfflineRecognizer`。

#### 唤醒词待机：常开麦的边界

v3 的唤醒词让全局语音可以「不操作」，代价是麦克风常开，边界必须写死：

**规则**

- 待机（默认）时**只认开头附近的唤醒词**：`matchWakeWord` 先剥语气词/标点再做开头锚定，
  不允许句中任意位置匹配。**≥3 字**才允许 1 个字容错（同音/口音）；**2 字按同音字归一后精确匹配（如「小渔」也算「小鱼」）**。别名用 `|`/中文逗号分隔 ——
  否则「小区门口」会被误唤醒成命令「门口」，还会吞掉命令首字（评审 P1-1）；单字同样不容错。
- 待机时非唤醒内容**不发送进会话**（最多每 `WAKE_HINT_MS` = 30s 提示一次「听到的文本」）。那句原文只走本地诊断通道 `POST /voice-session`，落在宿主的 `/diagnostics.wakeMiss` 环形缓冲里（最近 `window` 条 `{at,text,wake}` + 不裁剪的 `count`）—— 不发模型、不落盘，供排查「喊了为什么不醒」时看混淆分布；同一块里的 `byWake` 已经把这份窗口按当时的唤醒词分好组（批次 26，docs §8.74）。
- 唤醒后进入活跃态，每句话直接发送并顺延 `WAKE_ACTIVE_MS` = 60s；到期自动回待机。
- 唤醒词**只对全局语音浮层生效**；输入框麦克风完全不受影响。
- 语音确认条**优先于**唤醒词：确认条挂着时说「允许/拒绝」直接回答确认，不需要先喊唤醒词。
- 关麦 / 点浮层麦克风 / 快捷键关闭都会回到待机；再开麦也从待机开始（有唤醒词时）。

#### 跨平台系统级热键：平台矩阵与可选依赖

系统级热键（窗口未聚焦也能按）分两条实现；**应用内快捷键（窗口聚焦）三平台都可用**：

| 平台 | 实现 | 依赖 / 授权 | 已知限制 |
| --- | --- | --- | --- |
| Windows | PowerShell 子进程 + C# `RegisterHotKey` → `POST /hotkey`（token）→ 宿主广播 SSE | 无额外依赖 | 快捷键被占用 / 安全软件拦 PowerShell 时失败，原因码进 `/diagnostics.hotkeyHelper.reason`、原文（含退出码与 stderr）进 `.detail` |
| macOS | 宿主进程内 `uiohook-napi` 监听 keydown → 直接广播 SSE | 可选依赖 `uiohook-napi` + **辅助功能授权**（系统设置 → 隐私与安全性 → 辅助功能） | 未授权 → `failed`、`reason=native-unavailable`，到底是没装依赖还是没授权看 `detail`；native 监听按配置值（默认 Control+Option+V），窗口内才额外接受 `Cmd+Option+V` 别名 |
| Linux | 同上（uiohook-napi） | 可选依赖 `uiohook-napi`；需 **X11** 会话 | Wayland 下 libuiohook 通常拿不到全局按键，会降级，`reason=native-unavailable`、`detail` 里写明是没有 DISPLAY |

**规则**

- helper 只在 `globalVoice === true && globalHotkeyHelper === true` 时启动；关掉任一开关都会回收子进程/注销 hook。
- `uiohook-napi` 是 **optionalDependency**：装不上不报错、不影响语音主链路，只在 `/diagnostics.hotkeyHelper` 记 `failed` + `reason=native-unavailable`。
- 快捷键解析：单字母/数字主键必须搭配 `Ctrl`/`Alt`/`Meta`（`Shift+V` 非法，会吞掉全局大写输入）。
- macOS 的 `Cmd+Option+V` 只是**窗口内**默认组合的顺手别名；系统级 native 热键按配置值注册。
- **Windows 启动状态机**：spawn 后先 `starting`；脚本在 `RegisterHotKey` 成功后向 stdout 打印 `READY` → `enabled`；stderr 输出 `REGISTER_FAILED`（快捷键被占用）、或在 READY 前退出 → `failed` + 原因。含 token 的临时 `.ps1` 在退出/失败/dispose 时删除（不再依赖下次 sync）。
- 诊断里的 helper 状态形状：`{enabled, status, reason, platform, tokenReady}`；`status` 会经历 `idle/loading/starting/enabled/exited/failed/disabled`，**enabled=false 不等于没配置**，先看 `reason`。

#### 幽灵动作：`expiresAt` 截止时间

宿主 `voice_ui` 工具等待回执有超时（默认 20s）。`ui-action` 载荷带 `expiresAt`（与宿主超时同一个 deadline），客户端必须：

- 收到时已过期 → 直接回执 `{ok:false,error:'expired'}`，**不弹确认、不执行**（提示「动作已超时，未执行」）。
- 确认条计时器 = `min(30s, expiresAt-now-1s)`；用户点「允许」后、执行前**再检查一次** deadline，过期同样回 `expired`。
- 杜绝 ghost action：宿主已判失败（模型收到 `ui_timeout`）后，用户迟到的「允许」不能再真的发出消息/执行命令。
- 卸载/热重载时宿主会立刻收尾所有在途动作（`ui_timeout`）并清定时器。

#### 多窗口：单一执行者与请求去重

SSE `ui-action` 是**全量广播**：两个 DSH 窗口（或同应用两个标签页）都会收到同一个动作。不处理的话 `send_prompt` 会被执行两次。

**规则**

- 执行前必须先 `POST /ui-action-claim` 认领：`{requestId, clientId}`；第一个 client 得 `claimed:true`，其它窗口 `claimed:false`。
- 认领失败 / 404 / 网络错误一律**静默跳过**（不回执、不执行）：宁可这次不执行，也不能双执行；另一个窗口会回执，都不在则由宿主超时收尾。
- `clientId` 存 sessionStorage（同标签页稳定、多标签页不同；无痕/被禁用时回落 localStorage/内存），只用于认领，不含敏感信息。
- **请求去重**：客户端每条识别文本生成一个 `requestId`，直发 `session.prompt(parts, mode, undefined, requestId)` 与回退 `POST /voice-prompt` 共用它；宿主据此幂等（重试/回退不会把同一条语音注入两遍）。
- `/voice-prompt` 兜底只在 `sessionController` 缺失时启用；controller 抛错直接 502，不再 followup（防止主路径已入队后重复注入）。

#### 通用 a11y 操作：快照 ref 是唯一入口

v2 的 `ui_click` / `ui_type` / `ui_key` 能操作任意可见元素，等价于用户亲手操作，安全边界必须写死：

**规则**

- **只认快照下发的 ref**：ref 只能来自最近一次 `ui_snapshot` 维护的 `Map(ref → element)`；
  过期/找不到一律回 `stale_ref`，让模型重新拍快照 —— 绝不接受 CSS 选择器、DOM 路径或坐标。
- **新快照整体覆盖旧表**并清掉旧 DOM 标记：不会出现「上一页的同名 ref 点到这一页」。
- 三个原语默认**危险**（`uiConfirm` 开时弹确认）；密码框（`type=password`）永远禁止代填（`forbidden`）。
- `ui_type` 只写**文本类**目标：`text/search/email/url/tel/number` input、`textarea`、`contenteditable`（含 `plaintext-only`）；`checkbox/radio/file/range/color/date/hidden/...` → `unsupported`（避免原生 setter 被吞掉却报成功），`readonly` → `unsupported`。
- `ui_click` 拒绝**外链导航**与**文件选择器**：`http(s)/mailto/file/tel/ftp/data/javascript/blob`、协议相对 `//`、`target=_blank`、`input[type=file]` → `unsupported`；应用内锚点（`#…`）与相对路由允许 —— a11y 只操作应用内界面，点出去浮层会随页面消失而会话还在跑。
- `set_sidebar` 读不到 `[data-sidebar-collapsed]` 时回 `unknown_state`，**不盲切方向**。
- 语音确认只认**整句**「允许/拒绝」（去首尾标点）；不是确认词就照常当聊天内容发送。

## 2. 改动之后

- `npm test` 必须全绿（`test/*.test.mjs` 现在 76 个文件，除 `silence.test.mjs` 外的 **75 个**由
  `scripts/run-tests.mjs` 按文件名字符串序串跑、遇红即停；**第一步是先构建两端产物**，
  所以「改了 `src/` 忘了构建」在这条串跑里假绿不了。名字靠前的那两个仍然靠前：
  先 `bundle-sync` 校验产物与源一致，再 `client-behavior` 跑行为回归）。
- **`npm run lint` 已经含在 `npm test` 里**（`test/no-undef.test.mjs` 跑 eslint，只开 `no-undef`）。
  它管的是这一类事故：跨文件符号**没 import 就引用** —— 内联时代能跑，换成真 ESM 之后要等代码真被执行才炸，
  构建、形状断言、行为测试都不报（浮层漏 `DEFAULT_VAD_OPTIONS`、裸调 `generateId`、
  宿主 `preloadInWorker` 里的 `keyPrefix`，三处都是这么埋进去的，见 `docs` §8.32）。
  报错长这样：`'X' is not defined`。**改 `eslint.config.js` 的 globals 清单，别改源码绕它**；
  浏览器代码只该看见浏览器全局、宿主代码只该看见 Node 全局，所以清单是分作用域给的。
- 需要连活插件的集成测试单独跑：`npm run test:silence -- http://127.0.0.1:<端口>`。
- 需要跑「真加载模型」的慢集成（SenseVoice 预加载等）：`$env:DSH_VT_SLOW_TESTS=1; npm test`。
  默认套件走快速路径并显式打印 ⏭ 跳过，不会悄悄漏测。
- 客户端行为回归在 `test/client-behavior.test.mjs`：直接加载 `lib/client.js` 产物，
  用假 React/DOM/AudioContext 驱动真实播放循环，断言 ack 恰好一次 / 顺序 / 段落完整 /
  停止与换轮后不出声。**改完 `src/client/` 并重建产物后一定要跑它**（形状断言测不出时序缺陷）。
  假 AudioContext 是**按真实判据**长的：`audioWorklet` 可以没有、`addModule` 可以被拒、
  `createScriptProcessor(bufferSize)` 只收 0 与 256…16384（非法值抛 `NotSupportedError`，
  和 Chrome 一致）；假 window 也有真的 `CustomEvent` + `dispatchEvent`，
  所以「浮层开麦 → composer 让位 → 失败时收回」这类跨组件契约是跑出来的，不是扫源码扫出来的
  （场景 13；四次变异验证见 `docs/architecture-modernization.md` §8.32b）。
- 改完 `src/host/`（宿主侧）要先 **`npm run build:host`** 再**重启 DSH** —— 宿主加载的是产物 `lib/index.js`；
  改完 `lib/client.js`（浏览器侧）要**浏览器强制刷新**。
- 改完 `src/client/pure/`、`src/client/dom/` 或 `src/shared/` 要跑 **`npm run build:client`** 重新生成 `lib/client.js`
  （`src/shared` 是双端共用：两端都要经构建进产物，改一处两侧都受影响；`npm run build` 一次建两端）。
  `pnpm test` 会先自己把两端建出来（`scripts/run-tests.mjs` 的第一步），所以「改了 src 忘了构建」在串跑里不会假绿；
  **单跑某个测试文件**（`node test/xxx.test.mjs`）不经过那个第一步，产物是否过期这时由
  `bundle-sync.test.mjs` 的逐字节比对兜住。
- **`lib/` 不入库（批次 23）**：`.gitignore` 收了 `/lib/`，四个产物是本地/CI 现生成的。
  CI 因此不再有「Verify build artifacts are up to date」那一步（`check:build` 在一份没有产物的 checkout 上必然红，
  它比对的对象已经不在仓库里），发布流水线改成显式 `pnpm run build` + `prepack` 两道。
  装机那台机器同理：**pull 完必须构建**，不然 DSH 读的还是旧产物；`git clean -xfd` 会把产物一起删掉（它被忽略了），
  删完要重新 `pnpm run build`。
- **宿主侧已完全构建化**（第 6.4 + 6.5 步）：`src/host/*.js` 是原始代码，
  `lib/` 里只剩四个产物（`index.js`、`asr-worker.js`、`tts-worker.js` + 客户端的 `client.js`），
  **别手改产物**。改完 `src/host/` 要重新构建，否则 `bundle-sync` 与 `npm run check:host` 都会红。
  形状断言读 `src/host/`，起 Worker 的行为断言仍走 `lib/` 产物（和客户端侧同一分工）。
  发布包 `files` 里也已经没有 `src/` —— 运行时不需要任何源码文件（`test/packaging.test.mjs` 守）。
  一段已经翻掉的历史（批次 15）：产物头部曾经有**两行 `createRequire` 垫片**不是装饰 ——
  那时 `src/host/vendor/msedge-tts.cjs`（已打好的 CJS 包）被内联进 ESM 产物，
  它内部的动态 `require()` 只能靠那两行才走得通；删了它构建照样绿、`node -e` 探针照样过，
  跑到 edge-tts 那条链路才炸（见 `docs` §8.31）。现在 `msedge-tts` 是 `dependencies` 里的真包，
  产物里一行第三方代码都没有（`grep -c "require(" lib/index.js` = 0），垫片跟着删掉了。
  留这一句是因为**同类事故随时会再来**：只要有人再把压缩 CJS 内联进产物，
  「构建绿、运行时炸」就会重演 —— 正确做法是加依赖，不是想起这两行。
- **宿主侧的形状断言写模块名，不写路径**：`hostSource('index')` / `hostSourceEntries([...])` /
  `await hostModule('paragraph')`，都走 `test/helpers/host-source.mjs`。
  为什么：硬写 `lib/index.js` 的断言现在**不会红**——那个路径还在，只是内容变成了产物，
  于是守卫静默改成验 esbuild 的输出格式。helper 的规则只有两条：`src/host/` 优先、`lib/` 兜底，
  带「构建产物，勿手改」头的文件一律跳过（找不到手写源码就抛错，不降级）。
  四个**真入口**（`lib/index.js`、`lib/client.js`、`lib/{asr,tts}-worker.js`）的行为断言仍然直接打产物路径——
  验的才是真会被加载的那份文件。要在产物级别验「构建后仍然成立」的行为（比如在线朗读失败要回退），
  桩得打在**构建之前**：`test/tts-online-fallback.test.mjs` 造一份临时工程、改 `src/host/edge-tts.js`、
  跑真 `build-host.mjs` 造产物再 import。覆盖 `lib/` 里的文件名那条路在 6.5 之后是无效的。
- **从 `main.js` 往外拆代码的规矩**（第 4 步已完成，第 5 步起入口清单就是 import）：
  新建 `src/client/dom/xxx.js`，导出 `createXxx(win, doc)` 工厂，环境由调用方注入，
  然后在 `main.js` 顶部 `import { createXxx } from './dom/xxx.js'` —— 构建沿 import 图打包，
  不需要改构建脚本，也不需要登记任何标记。
  两类文件的分工：**碰浏览器环境**（`window` / `document` / 全局 `fetch` / `URL`）的进 `dom/`，
  环境必须由参数注入；不碰环境的进 `pure/` —— `pure/` 也可以持有状态，只要那份状态
  是普通数据（`createTimerRegistry`、`createShortcutFocusTracker` 都是这一类）。
  带 React 的组件也已经能拆出去（`dom/mic-button.js`、`dom/global-voice-overlay.js`）：
  React 由 `buildClientModule(require)` 从宿主拿到再注入工厂，源码里不出现裸 `React`。
  **忘了 import 别人导出的名字，esbuild 不会报错** —— 它把没绑定的标识符原样留成自由变量，
  产物跑到那一行才炸（若外面裹着 `try` 就静默失灵）；`test/client-imports.test.mjs` 机械守这条，
  但它只认「别的模块**导出过**的名字」（`{ ...X }` 展开曾被当成属性名漏掉，§8.32 修了）。
  导出清单之外的自由变量 —— 闭包局部（浮层曾裸调 `client-id.js` 里的 `generateId`）、
  复制粘贴带出来的死字段（宿主 `preloadInWorker` 里的 `keyPrefix`）—— 由 **`npm run lint` 的 `no-undef`** 兜。
  **注入给组件的 `browserEnv` 不是手写成员清单**，是对真实 `window` / `document` / `navigator`
  的整对象转发（`main.js` 的 `forwardEnv`，缘由见 `docs/architecture-modernization.md` §8.27）：
  清单漏一个成员，浏览器里就是 `Cannot read properties of undefined`，而 Node 测试全绿
  （测试传的是自己的 mock env）。`test/env-forwarding.test.mjs` 守这条。
  新增 `test/*.test.mjs` 会被 `scripts/run-tests.mjs` **自动发现**，不用登记；
  漏跑的那种（需要外部服务）要在运行器里显式排除。
- **拆出去的代码怎么命名**（4.2 踩过的坑）：`bundle-sync` 的「不得反向引用 main.js 顶层符号」
  是按**词元**扫的，所以 `dom/xxx.js` 里出现的任何单词，都不能是 `main.js` 的顶层 `const`/`function` 名。
  反面例子：`main.js` 里那个播放实例一度叫 `playback`，而 i18n 的英文文案里就有 "playback context state"，
  于是那条检查立刻报「dom 文件引用了 main.js 的符号」—— 改名 `playCore` 就干净了，
  **别为了一个英语词去放宽词元级检查**。同理，注入进来的前缀变量叫什么（`BASE` / `baseUrl`）
  不该被契约测试写死：`test/route-contract.test.mjs` 认的是「`${前缀}/路径`」这个形状，
  它关心客户端有没有调这条路由，不关心变量名。
- **加一个配置项改两处**：`src/shared/config-spec.js` 加一条 spec（类型 + 取值/区间/上限 + `def`），
  `src/client/main.js` 的设置面板加一行控件。宿主的 `DEFAULTS`、清洗/校验规则、客户端的默认值与输入上限
  都是从那条 spec 派生的，**不需要也不许**在 `src/host/index.js` 或 `config-normalize.js` 里再写一份数字/默认值
  （`test/config-contract.test.mjs` 有「客户端又写死了数值区间」的守卫，`src/host/index.js` 里出现
  `const DEFAULTS = {` 也会被判红）。
  **保存失败那行的字段名也来自字典**（批次 20）：`configFieldLabel(key, t)` 就是 `t(配置键)`，
  所以新增配置键时要在 `src/client/pure/i18n.js` 的 `zh` / `en` 各加一条同名标签 ——
  不加不会崩，但那行红字的前半会显示英文键名本身（面板标题也一样）。
  「35 个配置键都有中英字段名」由 `test/i18n-status-line.test.mjs` 判据 11 守着，新增键漏标签会在那里红。
- 浏览器侧构建用 **esbuild**（devDependency），静态守卫用 **eslint**（devDependency，只开 `no-undef`，版本写死）。
  拉到本仓库后要先 `pnpm install`，否则 `npm run build:client` 找不到 `esbuild`、`npm test` 里的
  `no-undef.test.mjs` 会因为找不到 `eslint` 直接判红（它不许静默跳过）。
  测试里「对客户端源码做正则」的形状断言读的是**源码**（`test/helpers/client-source.mjs`），不是产物字节；产物是否过期：串跑时 `pnpm test` 第一步就重建两端，单跑某个文件时由 `bundle-sync` 逐字节比对兜住。
- 改了可选依赖（如 `uiohook-napi`）要跑 **`pnpm install`** 同步 `pnpm-lock.yaml`；`node_modules` 不入库，CI 按 lockfile 恢复；装好后**重启一次 DSH** 才会加载新的原生模块。
- **带安装脚本的依赖要在 `pnpm-workspace.yaml` 里逐个表态**（`allowBuilds: <名字>: true|false`）。pnpm 10+ 对没表态的包不是警告，是**装完直接以 1 退出**（实测 pnpm 11.7.0：`Ignored build scripts: esbuild, msedge-tts, uiohook-napi`）。当前三个都填 `false`，理由写在文件里：esbuild 的平台二进制由它的可选依赖提供（本机是 `@esbuild/win32-x64`，已装上，构建就是它在跑）；`uiohook-napi` 用包内自带的 `prebuilds/<平台>/*.node`（现在这套 `node_modules` 就是「脚本没跑」状态下装的，`require('uiohook-napi')` 实测能加载）；`msedge-tts` 唯一的生命周期脚本是 `preinstall: npx only-allow pnpm`，那是「不许用 npm 装」的守卫，跟编译无关。**新加依赖若带 `preinstall/install/postinstall`，顺手在这里加一行** —— `test/packaging.test.mjs` 会查（没表态、值写成 pnpm 自动生成的占位串、名单里有过期名字，都会红）。
  同文件里的 `packages: ['.']` 是给**还在用 pnpm 9 的人**留的兼容行：pnpm 9 看到这个文件却没有 `packages` 字段会直接报 `packages field missing or empty` 失败（实测），pnpm 10/11 不需要它（11.7.0 实测装得动）。本仓库是单包，列表就是根包自己。**CI 已经不在「靠这一行活着」的名单里了**：批次 24 起 CI 装的 pnpm 与本机同源，见下面「CI 与自动发布」，所以 `allowBuilds` 这套开关现在流水线和本机都管——流水线那台是 linux-x64，三个名字各自的免编译兜底（`prebuilds/linux-*`、`@esbuild/linux-x64`、`only-allow` 守卫）由 `test/packaging.test.mjs` 第 8 节末尾逐个核对。
- **pnpm 的版本只写在一处**：`package.json` 的 `"packageManager": "pnpm@11.7.0"`。两个 workflow 里 `pnpm/action-setup@v4` 都不带 `version` 输入（v4 没收到就自己读 `packageManager`）。以前这里是 `version: 9` 而本机是 11.7.0，两份版本各写各的后果不是数字不同而是行为不同：pnpm 9 不读 `allowBuilds`，那份名单在流水线上一个字都不生效。`test/packaging.test.mjs` 第 9 节判三件事——`packageManager` 存在且是完整三段版本、workflow 里不许再出现自带的 pnpm 版本、`cache: pnpm` 必须排在装 pnpm 那一步之后。升级 pnpm 时只改 `packageManager` 一个字段。
- `package.json` 声明了 `engines.dsh: ">=0.2.1-rc.5"` 与 **optional peer** `@deepseek-ai/dsh-llm`（仅 `agents.followup` 兜底用，由 DSH 安装环境提供；`peerDependenciesMeta.optional=true`）。
- 本仓库 `pnpm-lock.yaml` 用默认 `autoInstallPeers=true` 生成：锁文件会记录 `dsh-llm` 的依赖图，但**本地 `node_modules` 不一定有**它（`--lockfile-only` 更新后只改锁文件；测试用 `setCreateUserMessageLoaderForTest` 注入，不 require 真模块）。
- **暂不添加 `.npmrc auto-install-peers=false`**：那会改变现有 peer（如 `@deepseek-ai/cordis`）的自动安装行为并要求重算锁文件，属于独立改动；当前状态对运行时/测试无影响。如需收紧另开改动并在 CI（`pnpm install --frozen-lockfile`）验证。
- 更新插件依赖/新增可选 peer 后跑 `pnpm install --lockfile-only`（或 `pnpm install`）保持锁文件同步。

---

## 3. CI 与自动发布（GitHub Actions）

仓库自带两个 workflow（`.github/workflows/`），都走 pnpm，pnpm 的版本来自 `package.json` 的 `packageManager`（见上一节）：

- **`ci.yml`**：每次 push / PR 到 `main`，Node 22 与 24 两个版本各跑一遍 `pnpm install --frozen-lockfile` + `pnpm test`。
  批次 23 起 `lib/` 不再进版本库，所以这里没有单独的「产物与源码同步」一步 —— `pnpm test` 自己先构建两端。
  改完代码提交后，GitHub 上的红绿状态就是最直接的回归信号。
- **`npm-publish.yml`**：GitHub 上**发布一个 Release**（`release` 事件 `published`）时，
  先跑一遍同样的测试，全绿后自动 `npm publish --access public`。

**发布到 npm 前要做的两件事：**

1. 在 GitHub 仓库设置里加一个 `NPM_TOKEN` secret（值来自 npm 官网的 Access Token，
   建议用 `publish` 权限的 token，不要用自动生成的 `npm_token`）。
2. 在 GitHub 上创建一个 Release（`vX.Y.Z`），tag 就打在要发布的提交上。

发布成功与否看 workflow 的 `publish` job；测试失败时不会发出版本，修复后重新打 Release 即可。

> 版本号以 `package.json` 的 `version` 为准，tag 只用来触发工作流。

---

## 4. 仍然成立的设计决策

这一节从原 SNAPSHOT-NOTES.md（0.0.6 那份代码快照说明）里挑出来：那份文档整体是按
「`lib/` 就是源码目录」的旧形状写的，已经过时，原文归档在
[docs/history/SNAPSHOT-NOTES-0.0.6.md](history/SNAPSHOT-NOTES-0.0.6.md)。
下面这些讲的不是文件在哪，而是**为什么这么设计**，今天照着改代码仍然要用。

**麦克风在语音模式期间不关。** 只在退出语音模式时关。识别、等回复、朗读期间都开着 ——
这是「实时对话」体验的前提。

**客户端只有三个渲染状态**：`on`（开关）、`speaking`（朗读中）、`hint`（临时提示）。
所有判断依据走 ref，不走 state，避免渲染延迟带来的读到旧值。

**草稿由三段拼接，顺序固定**：`baseDraft`（用户开麦前自己输入的内容，整轮保持）、
`committed`（已识别完成的各段，累积、互不覆盖）、`segment`（当前这一段的实时字，被下一段替换）。
只用一个变量同时表示「用户已有内容」和「本轮语音内容」，写完第一段就把它清空，
第二段会把整个草稿覆盖掉 —— 用户手打的内容和第一段的识别结果一起消失。

**但三段只是「我们以为输入框里的内容」。** 用户手动删掉一段之后那份记录就过期了，
再拼一次会把用户刚删的字原样塞回去。所以拆成两个纯函数，**顺序很重要**：
`syncUserEdit()` 在写入新内容**之前**检测用户是否改过（改过就以用户当前内容为基准），
`mergeDraft()` 只做拼接、不做判断。把编辑检测放进拼接函数里，一旦判定「用户改过」，
就会把刚识别到的新内容一起清掉 —— 用户删掉一段之后，接下来识别到的句子会凭空消失。
另外「有没有写过」不能只看内容是否为空，首次写入会被误判成「用户改过」。

**释放识别模型必须显式通知识别工作线程。** 模型住在 worker 里，宿主主线程的缓存表是空的，
只清表等于什么都没释放。worker 的 `recognizers` 里存的就是识别器本身，释放要调 `entry.free()`；
写成 `entry.recognizer.free()` 会静默失败 —— 报告「已释放」但实际没释放。

**在线朗读要预热。** 预热省掉首次合成的 TLS 握手（约 2.5 秒），没预热时第一句会明显慢一点。
开麦和勾选「朗读回复」时都会触发，也有独立接口可以单独调。

## 5. 已知限制

写在这里是为了别把它当 bug 反复查，也别顺手「顺便修」成更大的改动。

1. 本地系统语音每次合成都要起一个 PowerShell 进程（约 800 毫秒）。改成常驻进程能做，
   但复杂度明显上一个台阶，目前没有做。
2. 宿主给的会话列表只缓存插件启动时那一批，切换会话后要等宿主重新注入。
3. 识别没有重试机制。上传失败时保留已经出来的实时字，并提示用户。
4. 窗口隐藏或最小化时，渲染器里的定时器会被浏览器节流，后台识别不如前台稳定。
   已经优先改用 AudioWorklet 绕开定时器，但它不是系统级后台服务，这条限制消不掉。
