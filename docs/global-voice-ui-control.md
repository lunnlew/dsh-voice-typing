# 全局后台语音交互 + AI 界面操控：可行性设计与落地计划

调研时间：2026-11-01　｜　基准：本机 DSH 桌面端 44.7.0（runtime `0.2.1-rc.5`）
证据来源：`app.asar` 只读分析 + 本机已装第三方插件的实测行为。
完整证据见本次调研的四份原始报告（仅本机留存，不随仓库发布）。

---

## 0. 一句话结论

**可以做，但要分成三层，别混在一起谈。**

| 层 | 能力 | 结论 | 代价 |
| --- | --- | --- | --- |
| **L1** | 全局语音 → 当前 AI 会话（任意页面可说话，不依赖输入框） | ✅ 纯插件可做，生态里已有人跑通 | 低（1~2 天） |
| **L2** | 当前 AI 反过来操控界面（切会话/开面板/改设置/点按钮…） | ✅ 纯插件可做，但 DSH 没有现成"UI 动作总线"，要自建 tool→SSE→渲染器执行器 | 中（2~3 天） |
| **L3** | 真正的 OS 级全局热键 / 常驻后台听（DSH 未聚焦、最小化、其他 App 前台） | ⚠️ **不改 DSH 也能做到**：Windows 全局热键用**插件自己拉起的 PowerShell 额外进程**（C# `RegisterHotKey`），macOS/Linux 用可选依赖 **`uiohook-napi`** 在宿主进程内监听（见 `lib/global-hotkey-helper.js`）；后台收音用 **AudioWorklet VAD** 绕过隐藏页定时器节流；托盘/独立悬浮窗需另起 helper，成本高 | 中（helper + worklet） |

建议节奏：**先 L1 + L2（纯插件，可回滚），L3 的 OS 热键用额外 helper 进程补；全程不改 DSH。**

---

## 1. 现状与差距（本插件）

| 现状 | 位置 | 对目标的限制 |
| --- | --- | --- |
| 麦克风按钮挂在 `conversation.input.right` | `lib/client.js` 的 `scope.slots.inject('conversation.input.right', …)` | 会话作用域：设置页/插件页/无会话时**没有按钮**，语音不可用 |
| 识别文本 → 草稿 → `inputActions.setDraft()` / `submit()` | `src/client/main.js`（`inputActions` 调用点） | 必须有 composer 挂载；只能作用于当前输入框所在会话 |
| 快捷键 `Alt+V` = 渲染器 `window.addEventListener('keydown', down, true)` | `src/client/main.js:3326`（产物 `lib/client.js:3836`） | **窗口级**，不是 OS 全局；窗口没聚焦就收不到 |
| VAD = `ScriptProcessor` + `setInterval` | `src/client/main.js:3032` / `:3115` | 窗口隐藏后 timer 被 Chromium 节流到 **1 次/秒**，VAD/实时字基本失效；`chunksRef` 还会持续增长 |
| 朗读链路 `llm/stream` 钩子 + SSE `/stream` | `lib/index.js` | 可复用：语音对话的"说→听"闭环已有 |
| 宿主路由无鉴权 | `lib/index.js` 全部 `webServer.register` | 任何本机进程可 POST；新增有副作用的语音/UI 路由必须补 token + Origin |

---

## 2. 可行性结论矩阵（逐项，含依据）

| 需求 | 结论 | 关键 API / 依据 |
| --- | --- | --- |
| 任意页面可见的全局浮层 | ✅ | `shell.overlay`（root/list、常驻、点击穿透、opt-in pointer-events）：`@deepseek-ai/dsh-client-ui-layout/lib/client.js:643`,`:313`；三方插件已有占用先例 |
| 知道"当前是哪个会话" | ✅（渲染器） | `ctx.sessions.list.getSnapshot().byId` 里 `retainedBy.mainView > 0`：`dsh-client-ui-layout/lib/client.js:59-60`。宿主侧**没有** active session 概念 |
| 不经 composer 给会话发消息 | ✅ | 客户端 `ISession.prompt(parts,'queue'\|'steer')` → 认证 RPC：`@deepseek-ai/dsh-api-session-controller/lib/client.js:2341-2392`；宿主 `ctx.sessionController.prompt(req,signal)`：`.../lib/index.js:3218`→`:925`→`agent.followup :949` |
| 冷会话也能发 | ✅ | `sessionController.prompt` 内部会 `resolveAgent` 恢复冷会话（`.../lib/index.js:210`） |
| 应用内"全局"快捷键 | ✅（窗口聚焦内） | `ctx.shortcuts.register(...)`：`@deepseek-ai/dsh-client-shortcuts/lib/client.js:1210-1234`；Desktop 走主进程 `before-input-event`（`app.asar/lib/main.js:11499`, `:11452`） |
| 模型能调用新工具 | ✅ | `ctx.tools.register(defineTool({...}))`：`@deepseek-ai/dsh-tools`（`ctx.tools` 服务，register 在 0.2.1-rc.5 的 index.js:2974）；注册即进系统提示词；`exec.agent` 可取调用会话（`:1266`,`:1482`） |
| 工具/模型驱动 UI | ⚠️ 自建 | DSH **没有**通用 host→client UI 总线；官方模式是"一个操作两个调用方"（host 服务方法，UI 走 `ctx.remote.commands.execute()`，模型走 tool）。需要：tool → 插件 SSE → 渲染器执行 → HTTP 回执 |
| host→client 自定义事件 | ❌ 无扩展点 | `@deepseek-ai/dsh-api-remotes/lib/types/remote-events.js:16-45` 是固定白名单；用插件自己的 `webServer` + SSE（本插件已有） |
| 窗口可见但未聚焦：麦克风 | ✅ | `getUserMedia` 轨道保持 live |
| 窗口隐藏/最小化：麦克风采集 | ✅（轨道不会被主动停） | 实测某已装语音插件是主动停麦，而非浏览器能力限制 |
| 窗口隐藏/最小化：基于 timer 的 VAD | ❌ | Electron 默认 `backgroundThrottling:true`，主窗口未覆盖（`app.asar/lib/main.js:11960-11968`），隐藏页 `setInterval` 实测 **正好 1 次/秒** |
| 窗口隐藏：AudioWorklet | ✅ | 实测隐藏 7 分钟 worklet 仍 375 quanta/s（48kHz/128）→ **把 VAD 移进 AudioWorklet 是纯插件可行的后台方案** |
| OS 全局热键（其他 App 前台） | ⚠️ 插件 + 额外进程 | 宿主没有 Electron API、没有 `globalShortcut`（全 asar 0 命中，宿主是 `ELECTRON_RUN_AS_NODE` 子进程）；但插件可以**自己拉起 helper 进程**注册系统热键，按下后 POST 回插件路由（本仓库 `lib/global-hotkey-helper.js` 即此方案） |
| 托盘 / 独立悬浮窗 / 开机自启 | ❌ 纯插件 | 托盘是 DSH 私有实现（`app.asar/lib/main.js:11692-11736`），无扩展点；要托盘/独立窗只能再拉一个自带 UI 的 helper 进程（成本高，v1 不做） |
| 唤醒词 / 常开听写 | ⚠️ 可做但要设计 | 本机已装语音插件有类似实现（流式文本匹配唤醒词）；功耗/误触/回声需自行验证 |

---

## 3. 推荐架构

### 3.1 组件

- **渲染器（client）**
  - `GlobalVoiceOverlay`：注册到 `shell.overlay`，任意页面常驻的麦克风/状态条/字幕小窗（"聆听中 / 识别结果 / 执行中"），点击穿透、只有自己的容器 `pointer-events:auto`。
  - 复用现有录音 + 宿主 ASR（`/transcribe`、`/asr-stream`）；P3 把 VAD 从 `setInterval` 换成 `AudioWorklet`。
  - `UiActionExecutor`：接收 host 下发的 UI 动作并执行，回执结果。
  - 会话定位：`sessions.list` → `retainedBy.mainView>0`；找不到时用上次看到/最近活跃的会话。
- **宿主（host）**
  - 现有 `webServer` 路由 + SSE `/stream`（已具备）；新增 `POST /voice-prompt`（回退注入路径）、`POST /ui-action-result`（执行回执）、`POST /hotkey`（helper 进程专用，token 鉴权）、SSE `ui-action` / `global-hotkey` 事件。
  - `ctx.tools.register` 注册 `voice_ui` 工具（P2）。
  - `ctx.systemPrompt.section` 注册一段使用说明（P2）。实现为**注册一次**（引用稳定，避免 KV cache 抖动）；`uiControl` 关闭时由工具返回 `ui_control_disabled` 表达，而不是卸载 section。
  - 新增配置项（6 个，宿主 `DEFAULTS` 与客户端 `UI_DEFAULTS` 同名同默认）：`globalVoice`、`globalShortcut`、`voicePromptMode`、`uiControl`、`uiConfirm`、`globalHotkeyHelper`（`lib/config-schema.js`）。

### 3.2 数据流 A：语音 → 当前 AI（L1）

```
浮层麦克风（任意页面）
  → VAD 断句 → POST /transcribe（宿主 worker）
  → 定稿文本
  → ① 优先：ctx.sessions.binding(current).session.prompt([{type:'text',text}], mode)
        （认证 RPC；与会话里手打消息完全同路径，正常落库/渲染）
  → ② 回退：POST /voice-prompt {sessionId,text,mode,requestId?} → 宿主 sessionController.prompt(...)
        （宿主再回退 agents.get(id).followup/steer；冷会话可恢复）
  → ③ 都失败：浮层提示（不伪造 composer 注入，也不静默丢话）
  → 朗读回复（现有 llm/stream + SSE 链路，不需要改）
```

要点：**不伪造 session 事件**（`session.append('user/message')` 不会触发模型，必须走 inbox/followup 路径）。

### 3.3 数据流 B：AI → 界面（L2）

```
用户说："把侧栏收起来，然后打开设置里的语音输入"
  → 文本进入当前会话（流程 A）
  → 模型决定调用 voice_ui 工具
  → 宿主 tool.execute：校验动作/参数白名单
  → 插件 SSE 广播 ui-action {requestId, sessionId, actions:[...]}
  → 浮层/UiActionExecutor 执行：
       ctx.layout.toggleSidebar()
       ctx.layout.selectPanel(...) / 打开设置（DOM 兜底）
  → POST /ui-action-result {requestId, ok, value?, error?}
  → tool 返回结构化结果 → 模型继续/总结 → 朗读
```

关键约束：
- 工具是**全局可见**的（DSH 没有内置 restrict），所有会话都能看到；注册一次放在 `apply` 里（避免 KV cache 抖动）。
- 单用户桌面：SSE 广播带 `sessionId`；v1 渲染器不按 sessionId 过滤，收到 `ui-action` 就执行（目标由动作参数给出），并保证一次只处理一个动作（避免回执串号）。
- 工具拿不到麦克风：启停聆听只能由渲染器/浮层做，工具最多"请求开始/停止"（通过同一条 SSE 通道）。

### 3.4 界面动作目录（P2 首批，全部有据可查）

| 动作 | 实现 | 风险 |
| --- | --- | --- |
| `ui_state`（只读） | 汇总 `sessions.list`、当前会话状态、面板、侧栏、模型 | 无 |
| `list_sessions` | `sessions.list` | 无 |
| `switch_session` | `ctx.uiWorkspace.openSession(target)` | 低 |
| `new_session` | `ctx.uiWorkspace.startSession(...)`（可带 prompt） | 中（新建） |
| `run_command` | `ISession.command('/…')` | 中（依赖命令语义） |
| `send_prompt` | `ISession.prompt(...)` | 中（会发消息） |
| `set_draft` | `inputActions.setDraft()`（composer 挂载时） | 低 |
| `stop_generation` | `ISession.cancel()` | 低 |
| `toggle_sidebar` / `open_rightbar` / `select_panel` | `ctx.layout.*` | 低 |
| `open_settings`（兜底） | 无公开 API；只能 DOM 找入口点击，或用 `select_panel` 到插件面板 | 中（脆弱） |
| `click_element`（兜底，默认关） | DOM 按 `role`/可见文本匹配**白名单元素** | 高（默认禁止，需确认） |

> 注：v1 实际首批动作见 §8：只读动作叫 `state`（不叫 `ui_state`）；不含 `set_draft` / `open_settings` / `click_element`（后两者本就不在 v1 范围）。
> v2 已把「通用点击/输入/按键」做成 `ui_click` / `ui_type` / `ui_key`（只认快照 ref，不做任意 DOM 选择器），并补 `set_sidebar` / `open_plugins` / `ui_snapshot`，见 §8、§9。

**明确不做**：审批/授权类动作（同意工具调用、回答 agent 提问、放宽权限）保持 user-only —— 官方硬规则（`.../skills/cordis-plugin-development/references/user-actions.md`：*"An action that grants or confirms authority … stays user-only"*）。纯视图交互（切 tab、展开详情）官方认为**不需要**工具，语音操控时也只作为便利项。

### 3.5 提示词

`ctx.systemPrompt.section({ name:'voice-ui', order:…, text:… })` 注册一段：说明 `voice_ui` 的用途、动作表、必须二次确认的动作、失败如何回退。实现为**注册一次**（引用稳定，避免 KV cache 抖动）；开关关闭时由工具返回 `ui_control_disabled` 表达，而不是卸载 section。

v2 追加规则：通用界面操作先 `ui_snapshot`、`ref` 只对最近一次快照有效（过期重拍）、`ui_click`/`ui_type`/`ui_key` 默认需确认、语义动作优先。

---

## 4. 安全与体验（必须一起做，不是可选项）

1. **插件路由补鉴权**：现有路由在认证 `/api` 桥之外，任何本机进程可达。v1 只给 `POST /hotkey` 加了 per-launch token（helper 进程是唯一调用方）；`/voice-prompt` 与 `/ui-action-result` 只监听本机 loopback，未加 Origin/渲染器 token（v1 取舍，见 §8）。
2. **动作双重白名单**：宿主校验动作名/字段 schema；渲染器执行前再校验一次，绝不执行任意 JS/DOM 选择器。
3. **危险动作二次确认**：`switch_session`、`new_session`、`run_command`、`send_prompt`、`stop_generation` 默认确认（浮层弹「要执行吗？」）；`uiConfirm=false` 可关，只读动作永远不弹。
4. **审计**：`/diagnostics` 增加 `uiActions[]`（最近 50 条：`{at,requestId,action,ok,error}`；**不记录参数正文**）。
5. **总开关默认关**：`uiControl` 默认 false；打开时设置页给出明确说明（"AI 可以操作你的界面"）。
6. **回声与误唤醒**：朗读期间 VAD 需回声门控（现有 barge-in 思路可复用）；常开麦要有"监听中"常驻指示 + 空闲自动释放（参考已装语音插件的空闲自动释放）。
7. **降级**：浏览器里跑（`dsh web`）没有 `window.dshDesktop`，L3 相关能力隐藏；`shell.overlay` 与 `session.prompt` 仍可用。
8. **通用 a11y 的安全边界（v2）**：`ui_click` / `ui_type` / `ui_key` 只能操作 `ui_snapshot` 下发过 ref 的元素（快照表是唯一入口，过期即 `stale_ref`）；不接受 CSS 选择器 / DOM 路径 / 坐标；密码框永不代填（`forbidden`）；三个原语默认危险（需确认）；语音确认只认整句「允许/拒绝」。

---

## 5. 分阶段落地

| 阶段 | 内容 | 主要改动 | 工作量 |
| --- | --- | --- | --- |
| **P1** 全局语音→当前会话 | 浮层常驻麦克风/状态；会话定位；`ISession.prompt` 优先 + `/voice-prompt` 回退；`ctx.shortcuts` 接热键（保留 window keydown 兼容） | `src/client/main.js`（新浮层组件 + 发送路径）、`lib/index.js`（`/voice-prompt`）、`lib/config-schema.js`、`test/*` | 1~2 天 |
| **P2** AI 界面操控 | `voice_ui` tool；SSE 动作通道 + 回执路由；执行器 + 动作目录；确认/审计；prompt section；设置项 | `lib/index.js`、`src/client/main.js`、`lib/config-schema.js`、新增测试（tool/协议/执行器纯函数） | 2~3 天 |
| **P3** 后台常听 | AudioWorklet 替代 `setInterval` VAD；`visibilitychange` 处理；隐藏时缓冲上限；可选唤醒词/空闲释放 | `src/client/main.js`（音频链路）、宿主 ASR 流式、测试 | 2~3 天 |
| **P4** OS 级全局热键 | **不改 DSH**：Windows 用插件自带 PowerShell 子进程（`RegisterHotKey` → POST `/hotkey` → SSE）；macOS/Linux 用可选依赖 `uiohook-napi` 在宿主进程内监听（native，不走 HTTP）。默认关、需浮层开启、退出回收 | 新增 `lib/global-hotkey-helper.js` + 宿主接线 + 测试 + `optionalDependencies.uiohook-napi` | 本仓库已实现（跨平台） |
| **P5** 通用 a11y 原语（v2） | 14 动作：新增 `set_sidebar` / `open_plugins` / `ui_snapshot` / `ui_click` / `ui_type` / `ui_key`；快照 ref 驱动、语义动作优先；语音说「允许/拒绝」回答确认条 | `lib/ui-action-protocol.js`、`lib/index.js`（tool schema / prompt）、`src/client/main.js`、`src/client/pure/a11y.js`、`lib/client.js`（生成）、新 `test/a11y.test.mjs` | 本仓库已实现（v2） |
| **P6** 跨平台热键 + 评审修复（v4） | Windows PowerShell / macOS+Linux native（可选 `uiohook-napi`）；`expiresAt` 幽灵动作防护；`list_sessions` 真实 `projections` 字段；POST 路由 JSON-only（CSRF 415）；卸载收尾在途工具调用 | `lib/global-hotkey-helper.js`、`lib/index.js`、`lib/ui-action-protocol.js`、客户端执行器、`package.json` + `pnpm-lock.yaml`、测试 | 本仓库已实现（v4） |

验收（可直接在本机做）：
- P1：打开设置页按热键说话 → 会话列表里出现新的用户消息，不需要切回会话页；无会话时给出明确提示。
- P2：说"把侧栏收起来" → 侧栏收起，`/diagnostics.uiActions` 有记录；说"删掉这个会话" → 走确认，拒绝则不动。
- P3：最小化后说一句 → 恢复可见时识别成功；长时间隐藏内存不涨（AudioWorklet 路径）。
- P4：窗口最小化、焦点在记事本 → 按系统热键，DSH 里的语音浮层状态切换（Windows 需 helper 已拉起；macOS 需辅助功能授权；Linux 需 X11 且已装 uiohook-napi）。
- P5：说「看看当前页面有什么」→ 返回页面可交互元素快照；说「点第 3 个按钮」→ 浮层弹确认，说「允许」后点击；说「打开插件页」→ 打开插件界面。
- P6：macOS 授权辅助功能 / Linux X11 + 装好 `uiohook-napi` → 窗口失焦按系统热键能切换浮层；确认条挂 30s 后点允许 → 回执 `expired`、不执行（幽灵动作防护）。

---

## 6. 风险与限制（写清楚，避免承诺过头）

- **OS 全局热键与"在任何 App 里喊一声"**：不改 DSH 的前提下，Windows 靠插件自己拉起的 PowerShell 额外进程（`RegisterHotKey`），macOS/Linux 靠可选依赖 `uiohook-napi` 进程内监听。代价：Windows 首次可能弹权限/防火墙提示、部分安全软件拦截脚本；macOS 需辅助功能授权；Linux 需 X11（Wayland 通常不可用）；加速键冲突/模块缺失时安静降级并把原因写进 `/diagnostics.hotkeyHelper`。
- **隐藏窗口的 timer**：现状 VAD 会退化成 1Hz；不换 AudioWorklet，后台听写就是坏的。
- **UI 操控没有官方总线**：自建通道意味着只能操控"本插件渲染器 + 公开客户端 API + 白名单 DOM"，不是通用自动化；`open_settings` 之类无公开 API 的入口最脆弱。
- **工具全局可见**：所有会话说 `voice_ui` 都在，提示词/上下文有成本；不建议按会话动态注册（KV cache）。
- **模型误操作**：语音识别错一个词就可能触发动作 → 危险动作必须确认；只读动作可以放开。
- **兼容性**：所有 API 基于 `0.2.1-rc.5` 静态代码，未做端到端注入验证；DSH 升级可能变。必须 feature-detect + 回退（工具用 raw definition，注入优先 `sessionController` 再回退 `agents.followup`）。
- **隐私/功耗**：常开麦有系统麦克风指示、耗电、回声风险；后台听写默认关，开启时明确告知。

---

## 7. 关键证据索引

| 事实 | 证据 |
| --- | --- |
| 插件宿主无 Electron API | `app.asar/lib/main.js:3649-3657,3791-3811` |
| 主窗口节流未关 | `app.asar/lib/main.js:11960-11968`（webPreferences 无 `backgroundThrottling`） |
| 全 asar 无 `globalShortcut` | 对 app.asar 全库检索 `globalShortcut`：0 命中 |
| 全局浮层槽位 | `@deepseek-ai/dsh-client-ui-layout/lib/client.js:643,313` |
| 客户端直发消息 | `@deepseek-ai/dsh-api-session-controller/lib/client.js:2341-2392` |
| 宿主注入回合 | `@deepseek-ai/dsh-api-session-controller/lib/index.js:3218→925→949` |
| 工具注册 | `@deepseek-ai/dsh-tools`（服务 `ctx.tools`、`register`、`defineTool`、`exec.agent`，0.2.1-rc.5） |
| 无通用 host→client 事件 | `@deepseek-ai/dsh-api-remotes/lib/types/remote-events.js:16-45` |
| 官方插件开发规范 | `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/{host-plugin,ui-plugin,user-actions}.md` |
| 本机先例 | 已装全双工语音插件（`shell.overlay` + `session.prompt('steer')`）、桌面宠物插件（`shell.overlay` + 自拉 Electron sidecar） |
| 插件自拉 helper 进程可行 | 桌面宠物插件已在本机验证（下载 Electron helper、stdio 桥、独立托盘）；本仓库 v1 用更轻的 PowerShell helper 只做 Windows 系统热键，v4 起 macOS/Linux 改用可选依赖 `uiohook-napi` 进程内监听 |

---

## 8. 实现状态（v1 + v2 + v3 + v4 + v5 + v6，本仓库）

- **L1 全局语音浮层**：`shell.overlay` 常驻浮层；`sessions.list` 定位当前会话；`ISession.prompt(queue/steer)` 直发，失败回退 `POST /voice-prompt`；窗口内快捷键 + 可选系统级 helper；**浮层开启时输入框麦克风隐藏、`Alt+V` 改为切换浮层麦克风**（只保留一个语音入口，避免两套麦克风/快捷键混淆）；两个引擎运行期互斥。
- **L2 AI 界面操控**：宿主 `voice_ui` 工具 + `ui-action` SSE + 渲染器执行器 + `/ui-action-result` 回执；首批动作 `state/list_sessions/switch_session/new_session/run_command/send_prompt/stop_generation/toggle_sidebar`；`uiConfirm` 默认二次确认；`/diagnostics.uiActions` 审计；`uiControl` 默认关。
- **L2 的前置依赖**：执行器与确认条住在全局语音浮层里，所以除了 `uiControl=true` 还需要 `globalVoice=true`（`list_sessions` 例外，宿主直接回答）；只开 `uiControl` 时工具返回 `voice_overlay_disabled`。
- **v2 通用 a11y（已实现）**：动作协议扩到 14 个（新增 `set_sidebar` / `open_plugins` / `ui_snapshot` / `ui_click` / `ui_type` / `ui_key`）；`ui_snapshot` 返回当前页面可见可交互元素的 ref 快照（上限 80），`ui_click` / `ui_type` / `ui_key` 只按快照 ref 操作；三个原语默认危险（`uiConfirm` 时确认）；确认条支持语音说「允许/拒绝」（整句匹配，该句不发送）；工具 schema 新增 `ref` / `key` / `collapsed` 参数。
- **v3 唤醒词待机（已实现）**：第 35 个配置键 `wakeWord`（默认「小D」，空串 = 关闭）；全局语音浮层常开麦待机，`matchWakeWord` 开头锚定 + 语气词/标点容错（**≥3 字才允许 1 字容错；2 字必须精确匹配**）；待机时非唤醒内容丢弃不发送（隐私）；唤醒后 60 秒无语音回待机；确认条语音「允许/拒绝」优先于唤醒词；唤醒词只对浮层生效。
- **L3**：系统级热键由 `lib/global-hotkey-helper.js`（默认关，仅 `globalVoice && globalHotkeyHelper` 时启动）提供：Windows 走 PowerShell 子进程 POST `/hotkey`（token 鉴权）；macOS/Linux 走可选依赖 `uiohook-napi` 进程内监听后直接广播 SSE `global-hotkey`；后台 VAD 用 AudioWorklet。
- **评审修复（v4，已实现）**：`list_sessions` 读真实 `projections` 字段（title / sessionListMetadata.lastPromptAt + running/blank/cwd）；`ui-action` 带 `expiresAt` 双端同构并在客户端拒绝过期执行（ghost action）；`/voice-prompt` requestId ≤200；POST 路由要求 `application/json`（CSRF 简单请求 415）；卸载时收尾在途工具调用；helper 增加 `globalVoice` 闸门 / `Shift+V` 拒绝 / UTF-8 BOM / 禁用代理 / origin 优先 / native 适配器。
- **P2/P3 强化（v5，已实现）**：新增 `POST /ui-action-claim` 多窗口认领（JSON-only 415；先到先得/同 client 幂等/404 未知或过期）；客户端执行链路 expires→busy→claim→confirm→execute（认领失败静默跳过）；`/voice-prompt` 只在 sessionController 缺失时走 agents 兜底（controller 抛错直接 502，不再二次注入）；客户端每条识别文本透传 `requestId` 供去重；voice-ui 提示词 section 随 `uiControl` 动态注册/注销；Windows helper 改为 starting→READY→enabled（REGISTER_FAILED/提前退出→failed）并清理临时 .ps1；`ui_type` 文本类白名单、`ui_click` 拒绝外链/file input；`package.json` 增加 `engines.dsh` 与 optional peer `@deepseek-ai/dsh-llm`。
- **设置界面刷新（v6，已实现）**：zh/en 文案重写（跨平台热键 + macOS 辅助功能/Cmd 别名、自动开麦待机、2 字精确唤醒词、uiControl a11y 边界/多窗口）；「高级与诊断」新增只读「系统级热键状态」行（`/diagnostics` 挂载+保存后+手动刷新，不轮询、不参与保存）；详见 §13。
- **不做**：任何 DSH 安装/核心改动；任意 DOM 选择器 / 坐标点击 / 任意 JS；审批/授权类动作。
- **需要重启一次 DSH**：v2 改了 `voice_ui` 的工具 schema（新增 `ref` / `key` / `collapsed`）与系统提示词；v3 新增配置键 `wakeWord`（第 35 个）。宿主工具/配置在插件加载时注册，不会热更新 —— 升级后**重启一次 DSH**（v2/v3 可合并成一次）；客户端刷新一次即可。
- 未验证：真机 UI 行为与系统热键需要在**重启 DSH 后**人工验收（本机测试只覆盖 Node 侧逻辑与协议）。

---

## 9. v2 增量：通用 a11y 界面操作（已实现）

### 9.1 为什么需要 v2

v1 是「一个界面功能一个动作」：切会话、侧栏、命令各一个。每加一个界面就得改协议/宿主/客户端三处，
模型还会因为语义动作覆盖不到而猜 toggle。v2 改成**通用原语 + 语义优先**：
先拍当前页面的可交互元素快照（a11y），模型按 ref 点击/输入/按键 —— 以后新增界面功能不用再改协议。

### 9.2 动作协议（14 = 8 语义 + 6 v2）

| 动作 | 参数 | 必填 | 危险（需确认） | 执行 |
| --- | --- | --- | --- | --- |
| `set_sidebar` | `collapsed`(boolean) | `collapsed` | 否 | 读 `[data-sidebar-collapsed]` 后按方向 toggle；读不到 `unknown_state`（不盲切） |
| `open_plugins` | — | — | 否 | `pluginNavigation.openList()` |
| `ui_snapshot` | — | — | 否 | 遍历可见可交互元素（上限 80），返回 `{elements,count,sidebarCollapsed}`，同时打 `data-dsh-voice-ref` 并存 ref→元素表 |
| `ui_click` | `ref` | `ref` | **是** | 按快照 ref 点击；无效/过期 `stale_ref`；禁用 `disabled` |
| `ui_type` | `ref`,`text`(≤4000) | 两者 | **是** | input/textarea 用原生 setter + `input`/`change`；contenteditable 设 textContent；密码框 `forbidden` |
| `ui_key` | `key`(≤40) | `key` | **是** | `parseKeySpec` 后在 activeElement 派发 keydown/keyup（如 `Escape`、`Ctrl+K`） |

- `UI_CONFIRM_ACTIONS`（8）：v1 的 5 个 + `ui_click` / `ui_type` / `ui_key`。
- `UI_ACTION_LIMITS`：`text:4000`、`line:400`、`sessionId:200`、`workspaceId:200`、`ref:40`、`key:40`（磁盘上的协议模块是唯一真源）。
- 错误码风格保持 v1：`unknown_action` / `missing_param:<name>` / `param_too_long:<name>` / `invalid_param:<name>`。

### 9.3 安全边界（为什么通用点击没有放松安全）

- ref 只能来自**最近一次** `ui_snapshot` 的 `Map(ref → element)`；新快照整体覆盖旧表并清掉旧 DOM 标记。
- 不接受任意 CSS 选择器 / DOM 路径 / 坐标 / JS —— 模型拿不到「随便点哪里」的能力。
- 三个原语默认危险动作：`uiConfirm`（默认开）时浮层弹确认；密码框（`type=password`）永不代填。
- 语音确认只认**整句**「允许/拒绝」（允许/确认/可以/好/行/同意/ok/yes；拒绝/取消/不要/不/no/cancel，容忍首尾标点）；命中后该句**不再发送**进会话。

### 9.4 提示词规则（宿主 `voice-ui` section）

- 通用界面操作先 `ui_snapshot`，再按返回的 ref 操作；ref 过期/找不到就重新拍，不要猜。
- `ui_click` / `ui_type` / `ui_key` 可能改变状态，默认需用户确认；用户说「允许/拒绝」或点确认条都算。
- 优先用语义动作（切/建会话、`set_sidebar`、`open_plugins`、`run_command`、`send_prompt`）；语义动作覆盖不到的才用 a11y 原语。

### 9.5 为什么需要重启一次 DSH

v2 改了 `voice_ui` 的 **tools.register 参数 schema**（新增 `ref` / `key` / `collapsed`）与系统提示词。
DSH 在插件加载时注册工具、模型侧的工具表不会热更新 —— 只刷新渲染器时，模型看到的仍是 v1 的 8 个动作。
所以升级 v2 后要**重启一次 DSH**；之后刷新页面即可，不需要再重启。

### 9.6 验收

- 说「看看当前页面有什么」→ `ui_snapshot` 返回元素列表（含 ref/role/name）。
- 说「点第 3 个按钮」→ 浮层弹确认；说「允许」→ 点击并回执成功；说「拒绝」→ `confirm_denied`。
- 说「打开插件页」→ 打开插件界面；说「把侧栏收起来」→ 侧栏方向正确（不会反向）。

---

## 10. v3 增量：唤醒词待机（已实现）

### 10.1 为什么

用户诉求是「我就想不操作」。全局语音浮层虽然常驻，但仍要手点/按快捷键开麦。v3 让麦克风**常开待机**：
只有说出唤醒词才开始接收命令，命令发完回待机 —— 真正 hands-free；同时待机时不把环境闲聊送进会话。

### 10.2 配置（第 35 个键）

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `wakeWord` | string，trim，≤32 | `'小D'` | 唤醒词；**空串 = 关闭**（回到 v2：说话直接发送） |

- 宿主 `DEFAULTS` + `config-schema.js` SPECS；客户端 `UI_DEFAULTS` / `STRING_LIMITS(32)` / normalizeForSave / 设置面板「语音交互」输入框（zh/en，留空关闭提示）。
- **只对全局语音浮层生效**；输入框麦克风完全不受影响。

### 10.3 纯函数 `matchWakeWord(text, wakeWord)`

返回 `{matched, rest, via:'head'|'fuzzy'|''}`：
- 空唤醒词 → 不匹配，`rest` 原样返回（关闭）；
- 开头锚定：先剥开头语气词（呃/喂/嗯/我说）与标点，再比较；不允许句中任意位置匹配；
- 支持「唤醒词 + 命令连说」：`rest` 是去掉唤醒词后的命令（trim、去前导标点）；
- **≥3 字**时允许 1 个字容错（同音/口音；等长替换 / 多一字 / 少一字）；**2 字（默认「小D」）必须精确匹配**（否则「小区门口」会误唤醒成命令「门口」、吞命令首字）；
- 大小写不敏感（英文）。

放 `src/client/pure/global-voice.js`，`test/global-voice.test.mjs` 覆盖（含唤醒词与快捷键平台别名用例）。

### 10.4 浮层状态机

- 待机（默认）：麦克风开着，只认唤醒词；非唤醒内容**丢弃不发送**（隐私），最多每 30 秒提示一次「待机中」。
- 活跃：唤醒后每句话直接发送并顺延 60 秒；60 秒无语音**自动回待机**。
- 处理顺序：确认条 pending → 先走语音「允许/拒绝」拦截（v2）；再走唤醒词逻辑；无唤醒词走 v2 原逻辑。
- 「唤醒词 + 命令连说」只发送 `rest`（命令部分），**不把唤醒词送进会话**；只喊唤醒词则提示「在听，请说命令」。
- 点浮层麦克风 / 快捷键关麦 = 关麦 + 回待机；再开麦从待机开始。
- 保留「`globalVoice` 开启后自动开麦一次」的 `gv-autostart` effect —— 唤醒词依赖麦克风常开。

### 10.5 安全 / 体验边界

- 常开麦待机：系统持续显示录音中、耗电、可能误唤醒；`wakeWord` 留空即可完全关闭（回到 v2）。
- 待机时环境闲聊不发送（隐私边界）；活跃 60 秒自动回待机，避免误当常开录音。
- 唤醒 / 回待机都会更新浮层状态文字（不静默）。
- 唤醒词只对浮层生效，不影响输入框麦克风。

### 10.6 需要重启一次 DSH

v3 新增配置键 `wakeWord`（第 35 个），宿主配置 schema 在插件加载时生效 —— 升级后需要**重启一次 DSH**；
用户此前若尚未为 v2 重启，可合并成一次重启（客户端刷新一次即可）。

---

## 11. v4 增量：跨平台系统级热键 + 幽灵动作防护（已实现）

### 11.1 跨平台热键

| 平台 | 实现 | 依赖 / 授权 | 已知限制 |
| --- | --- | --- | --- |
| Windows | PowerShell 子进程 + C# `RegisterHotKey` → `POST /hotkey`（token）→ 宿主广播 SSE `global-hotkey` | 无 | 快捷键被占用 / 安全软件拦 PowerShell → 安静降级，`/diagnostics.hotkeyHelper.reason` 可查 |
| macOS | 宿主进程内 `uiohook-napi` 监听 keydown → 直接广播 SSE（同进程，不走 HTTP/token） | optionalDependency `uiohook-napi` + **辅助功能授权** | 未授权 → failed；native 按配置组合键注册（默认 Control+Option+V），窗口内才额外接受 `Cmd+Option+V` 别名 |
| Linux | 同上 | optionalDependency `uiohook-napi`；需 X11 | Wayland 下 libuiohook 通常拿不到全局按键，降级并写 reason |

- helper 只在 `globalVoice && globalHotkeyHelper` 时启动；关掉任一开关即回收（Windows kill 子进程 / native off+stop）。
- **Windows 启动状态机**：spawn 后 `starting`；脚本在 `RegisterHotKey` 成功后向 stdout 打印 `READY` 才置 `enabled`；stderr `REGISTER_FAILED`（快捷键被占用）或 READY 前退出 → `failed` + reason。含 token 的临时 `.ps1` 在退出/失败/dispose 时删除（不再依赖下次 sync）。诊断形状：`{enabled,status,reason,platform,tokenReady}`（`status` ∈ idle/loading/starting/enabled/exited/failed/disabled）。
- `uiohook-napi` 缺失时动态 import 失败 → `enabled:false, status:'failed', reason:...`，不影响语音主链路；`state()` 如实报告（加载中不谎报 enabled）。装上后重启一次 DSH 让宿主进程解析新模块。
- 单字母/数字主键必须搭配 Ctrl/Alt/Meta（`Shift+V` 非法）；脚本落盘 UTF-8 BOM（PowerShell 5.1 中文不乱码）、C# 禁用代理、回调地址优先 `webServer.getOrigin()`。
- 应用内快捷键三平台都可用；macOS 上默认 Ctrl+Alt+V 之外还接受 `Cmd+Option+V`（`effectiveShortcut` 平台别名）。

### 11.2 幽灵动作防护（expiresAt）

- 宿主 `buildUiActionPayload` 增加 `expiresAt = Date.now() + voiceUiTimeoutMs`，与工具等待超时**同一个 deadline**；`isUiActionExpired(payload, now)` 双端同构（缺失/非法 = false；`now === expiresAt` = false；`now > expiresAt` = true）。
- 客户端：收到即已过期 → 回执 `{ok:false,error:'expired'}`，不弹确认、不执行；确认条计时器 `min(30s, expiresAt-now-1s)`；点「允许」后执行前**再查一次** deadline。杜绝「宿主已判 ui_timeout、用户迟到的允许却真的执行」的 ghost action。
- 卸载/热重载：宿主遍历 `pendingUiActions` 清理 timer 并 resolve `ui_timeout`；迟到的 `/ui-action-result` 得到 404。

### 11.3 其它评审修复

- `list_sessions` 读真实行：`projections.values.title`、`projections.values.sessionListMetadata.lastPromptAt`，并带 `running/blank/cwd`（旧测试替身只有顶层 title，曾遮住线上 bug）。
- `/voice-prompt` 的 `requestId` ≤200 字符（会进 `source.rpcId` 并被去重扫描）。
- POST `/voice-prompt`、`/ui-action-result`、`/hotkey` 要求 `content-type: application/json`，否则 415（阻止跨站简单请求；`/hotkey` 先校验 content-type 再验 token）。
- 可选依赖安装：更新插件后 `pnpm install`（或重装插件）以安装 `uiohook-napi`；`node_modules` 不入库，CI 按 `pnpm-lock.yaml` 恢复。

---

## 12. v5 增量：多窗口单一执行者 + 评审 P2/P3 修复（已实现）

### 12.1 新增路由 `POST /ui-action-claim`（多窗口防重复执行）

- SSE `ui-action` 是**全量广播**：两个窗口都会收到同一个动作；执行前先认领：`{requestId, clientId}`。
- 第一条认领 → 200 `{claimed:true}`；同一 client 重试 → 幂等 true；其它窗口 → 200 `{claimed:false}`，**静默跳过**（不回执、不执行）。
- 未知/已超时/已回执 → 404；`requestId`/`clientId` 缺失或超长（>200）→ 400；`GET` → 405；非 JSON → 415。
- `clientId` 存 sessionStorage（多标签页不同、同页刷新稳定；无痕/禁用回落 localStorage/内存）。
- 客户端顺序：`expiresAt` 检查 → busy 检查 → 认领 → 确认条 → 执行 → 回执；认领失败/404/网络错误一律保守跳过。

### 12.2 `/voice-prompt` 不再二次注入

- 只有 `sessionController` **缺失**（精简部署）时才回退 `agents.followup/steer`；`sessionController.prompt` 抛错 → 直接 502，不再 followup。
- 原因：主路径可能已入队（本地超时/网络错误），二次注入会让同一条语音出现两遍。
- 兜底分支用 `@deepseek-ai/dsh-llm` 的 `createUserMessage`；测试用 `setCreateUserMessageLoaderForTest` 注入，**不依赖该包是否安装**（CI 装 optional peer 后测试仍需稳定）。

### 12.3 请求去重：`requestId` 透传

- 客户端每条识别文本生成一个 `requestId`，直发 `session.prompt(parts, mode, undefined, requestId)` 与回退 `POST /voice-prompt {requestId}` 共用；宿主据此幂等（重试/回退不会重复注入）。
- `/voice-prompt` 的 `requestId` ≤200 字符（落进 `source.rpcId`，去重逻辑会扫描）。

### 12.4 提示词 section 随 `uiControl` 动态注册

- `systemPrompt.section({name:'voice-ui'})` 只在 `uiControl===true` 时注册；配置保存切到 false 立即 dispose 释放 token，再打开重新注册；插件卸载/服务失效也会释放。
- 文案新增：收到 `ui_control_disabled`/`voice_overlay_disabled` 说明开关没开，提示用户去设置打开，不要重试。

### 12.5 a11y 原语的安全边界（P3）

- `ui_type` 只写**文本类**目标：`text/search/email/url/tel/number` input、`textarea`、`contenteditable`（含 `plaintext-only`）。`checkbox/radio/file/range/color/date/hidden/...` → `unsupported`（避免原生 setter 被吞掉却报成功）；`readonly` → `unsupported`；`password` → `forbidden`。
- `ui_click` 拒绝**外链导航**与**文件选择器**：`http(s)/mailto/file/tel/ftp/data/javascript/blob`、协议相对 `//`、`target=_blank`、`input[type=file]` → `unsupported`；应用内锚点（`#…`）与相对路由允许。理由：a11y 只操作应用内界面，点出去后浮层消失而会话还在跑。

### 12.6 宿主依赖声明 + 锁文件

- `package.json` 增加 `engines.dsh: ">=0.2.1-rc.5"` 与 optional peer `@deepseek-ai/dsh-llm`（`peerDependenciesMeta.optional=true`；只有 `agents.followup` 兜底用，DSH 安装环境提供）。
- `pnpm-lock.yaml` 由默认 `autoInstallPeers=true` 生成：锁文件记录 `dsh-llm` 依赖图，但本地 `node_modules` 不一定存在（`--lockfile-only` 更新后只有锁文件）。测试不 require 真模块（用测试注入钩子）。
- **暂不添加 `.npmrc auto-install-peers=false`**：这会让 pnpm 不再自动安装现有 peer（如 `@deepseek-ai/cordis`）、锁文件需要重算，属于独立改动；当前状态对运行时与测试都无影响。
- 更新插件依赖后跑 `pnpm install --lockfile-only`（或 `pnpm install`）保持锁文件同步；CI 用 `--frozen-lockfile` 是最终校验。

### 12.7 验收

- 开两个 DSH 窗口 → 模型触发 `send_prompt` → 只有一个窗口弹确认并执行，另一个静默跳过。
- 控制器抛错时 `/diagnostics.voicePrompt.failures` +1、`lastVoicePromptError` 有原因，且没有重复用户消息。
- `uiControl` 关闭 → voice-ui 提示词 section 数 0；打开 → 1。
- Windows helper：快捷键被占用时 `/diagnostics.hotkeyHelper` 为 `failed`（reason=热键注册失败），不再谎报 enabled；退出后 `%TEMP%` 无残留 `.ps1`。

---

## 13. v6 增量：设置界面刷新 + 系统级热键状态行（已实现）

### 13.1 文案刷新（zh/en，设置面板与浮层共用词典）

- `globalHotkeyHelper` 标签改为「系统级全局热键」：说明 Windows PowerShell / macOS+Linux 可选 `uiohook-napi`、macOS 需辅助功能授权、必须同时开浮层、失败静默降级并引导看状态行与 `/diagnostics`。
- `globalShortcutHint`：跨平台 + macOS `Cmd+Option+V` 别名 + 指向「系统级全局热键」开关。
- `globalVoiceHint`：开启后**自动开麦进入待机/聆听**（有唤醒词先说唤醒词；留空则直接聆听）、输入框麦克风隐藏、`Alt+V` 切换浮层、后台节流限制。
- `wakeWordHint`：2 字必须精确匹配 / ≥3 字允许 1 字识别误差 / 留空=关闭 / 只对浮层生效 / 常开麦耗电与隐私提示。
- `uiControlHint`：14 动作概述 + 浮层前提 + a11y 边界（密码框禁填、外链/文件选择器拒绝、多窗口只第一个响应、危险动作确认）+ 关闭时工具不存在。
- `uiConfirmHint`：列出全部危险动作（含 a11y 点击/输入）+ 语音允许/拒绝 + 拒绝或超时都不执行。

### 13.2 只读「系统级热键状态」行（高级与诊断）

- 位置：三个开关之后；纯展示，**不新增配置键**（仍 35 键 / 6 个折叠分区 / 高级组 3 个 checkbox），不参与 `normalizeForSave`/保存。
- 数据源：`GET /diagnostics` 的 `hotkeyHelper`；拉取时机：面板挂载一次、保存成功后一次、点「刷新状态」一次 —— **不轮询、不循环重试**；失败显示「未知（诊断不可用）」，不抛错。
- 状态映射：本地开关关 → `未开启`；首次未拉到 → `读取中…`；宿主 `enabled===true` / `status==='enabled'` → `已启用（组合键）`；`starting`/`loading` → `等待注册…`；`failed`/`exited` → `失败（原因）`；其余 → `未开启`。
- 组合键优先用宿主 `hotkeyHelper.accelerator`，缺失时回退当前配置的 `globalShortcut`（enabled 时两者等价）；平台优先宿主 `hotkeyHelper.platform`，缺失时按渲染器平台推断（宿主当前已返回 `platform`）。
- helper 开但 `globalVoice` 关 → 额外黄色提示「需要同时开启全局语音浮层才会生效」。
- 状态只读：不把诊断数据写进共享 configStore（避免旧快照覆盖配置），也不进入保存 payload。

### 13.3 宿主 `hotkeyHelper.state()` 字段核对 / 决定

- 现状：`{enabled, status, reason, platform, tokenReady}` —— **`platform` 已经在**（v4 加入；Lead 笔记里「只有 enabled/status/reason」并不准确），客户端平台回退只是防御，真实展示用宿主值。
- 缺 `accelerator`：客户端回退到配置值；`enabled` 时配置值就是注册值，展示无偏差（失败时展示的是 reason 而非组合键）。因此**本批次不建议为展示去改宿主**；若将来要显示「实际注册值/降级后的组合键」，再让 host-impl 在 `state()` 加 `accelerator` 即可。
- 本批次不改 `lib/**`。

### 13.4 验收

- 「高级与诊断」默认收起，展开可见状态行：默认「未开启」+ 平台 + 「刷新状态」按钮。
- 打开 helper + 浮层并保存 → 状态行自动刷新为「已启用（Ctrl+Alt+V）」或失败原因；点「刷新状态」可手动更新。
- helper 开、浮层关 → 状态行出现「需要同时开启浮层」提示；宿主 `/diagnostics.hotkeyHelper.reason` 也说明跳过原因。
- 诊断接口不可用（宿主未重启/网络异常）→ 状态行显示「未知（诊断不可用）」，设置面板其余功能不受影响。
