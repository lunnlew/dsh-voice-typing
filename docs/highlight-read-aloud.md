# 如何高亮「正在朗读的文本」

> 探索报告 —— 目标：在助手的回复里，把**当前正在被朗读的那一句**高亮出来。
>
> 调研范围：`dsh-voice-typing` 插件源码 + DSH 桌面应用（`app.asar`）的
> 对话渲染实现。结论基于只读探索。
>
> ✅ **已实现**（见文末「实现落地」）：采用方案 A（逐句高亮）+ 方案 C
> 兜底（跨块时整段高亮），用**覆盖层**实现，不碰消息 DOM、不影响消息流。

---

## 1. 现状：朗读是怎么发生的

### 1.1 数据流（宿主 → 客户端 → 扬声器）

```
助手流式输出
  → 宿主 lib/index.js 的 llm/stream 钩子
      ├─ stripForSpeech(): Markdown → 纯文本（去掉代码块/加粗/链接/列表编号…）
      ├─ splitLongText():   按句界切成一句一句
      └─ 时间窗口节流（EMIT_WINDOW_MS，默认 400ms），每批广播 1 句
  → SSE GET /dsh-voice-typing/stream，事件 { event: 'sentence', data: { text, turnId, index } }
  → 客户端 src/client/main.js 的 source.addEventListener('sentence', …)
      ├─ 按 turnId 过滤（只读当前这一轮）
      ├─ 入 speakQueueRef
      └─ pumpQueue(): 3 路并行合成 /tts → 顺序播放（AudioBufferSource）
```

### 1.2 关键事实：事件里带什么

| 字段 | 含义 | 与显示文本的关系 |
|---|---|---|
| `text` | 这一句的**纯文本**（markdown 已剥离） | **不等同于**屏幕上渲染的 markdown 内容 |
| `turnId` | 插件本地的轮次 id（`turn-1`, `turn-2`…），由 `createTurnModel` 递增分配 | **不是** DSH 会话的 turn id，两者命名空间不同 |
| `index` | 本轮内第几句 | 可用于去重/识别首句 |

**所以：事件里的 `text` 是「要念的字」，屏幕上显示的是「带格式的 markdown」，
两者不逐字相等。** 这是高亮实现最核心的难点。

---

## 2. DSH 是怎么渲染助手的回复的

（结论来自反编译 `dsh-client-ui-chat/lib/client.js` 与
`dsh-client-ui-conversation/lib/client.js`，均在 `app.asar` 内。）

### 2.1 槽位链

```
conversation.content  (root 容器)
  └─ conversation.session
      └─ conversation.view  (消息列表，注册于 dsh-client-ui-chat)
          └─ conversation.chat.node   (keyed，按消息类型分派)
              ├─ key: "assistant-step" → AssistantNodeView   ← 助手回复
              ├─ key: "user"           → UserMessageNodeView
              └─ …
```

### 2.2 助手内容渲染

`AssistantNodeView` → `AssistantMarkdown`：

- 它遍历 `blocks`，对 `kind === "text"` 的块渲染
  `<MarkdownText text={block.text} streaming labels … />`。
- `MarkdownText` 来自 `@deepseek-ai/dsh-client-ui-primitives`，真正把 markdown
  变成 DOM。
- **没有**一个「逐文本块内容」的插槽可以直接替换/包裹 —— 文本渲染是
  原语组件内部完成的。

### 2.3 稳定的 DOM 锚点（关键发现）

消息分组的容器带了稳定的 data 属性（`dsh-client-ui-chat` 的
`ChatGroupSeat`）：

```html
<div data-chat-group-key="…"
     data-chat-flow-key="…"
     data-chat-anchor-key="group:…"
     data-chat-turn="…"
     data-step-process="true">
  …
  <div data-step-process-body="true">
    <div data-step-process-content="true" data-chat-flow="">
      … 消息本体（含 AssistantMarkdown）…
    </div>
  </div>
</div>
```

这些属性是**稳定、可查询**的，且 `data-step-process-content` 正好包裹着
助手回复的 markdown DOM —— 是「按 DOM 文本高亮」的理想作用域。

---

## 3. 高亮的核心矛盾

要「高亮正在朗读的一句」，就必须回答：

> 事件里的 `{text, turnId, index}`，对应屏幕上**哪一段 DOM 文本**？

三个不匹配：

1. **纯文本 vs markdown**：`text` 是 `stripForSpeech()` 的产物（`**a**`→`a`、
   `[x](url)`→`x`、列表编号删除、代码块整体删除），屏幕上却是原始 markdown。
   两者只在「无任何格式」的纯文本段落里才逐字一致。

2. **turnId 不同源**：事件的 `turnId` 是插件计数器，`data-chat-turn` 是 DSH
   会话的 turn 标识。**不能**拿事件 `turnId` 去查 `[data-chat-turn]`。

3. **切句粒度**：宿主按 `stripForSpeech` 后的句界切句，可能把一个
   `**加粗**` 块切成两半，也可能一句横跨多个段落/块。

---

## 4. 可行方案（按稳健性排序）

### 方案 A ——「按纯文本子串匹配 + DOM 高亮」（推荐）

**思路**：客户端维护「当前正在朗读的那一句」，用一个**独立于 React 的
DOM 高亮层**去扫描助手回复容器，把匹配的文本包一层高亮。

**步骤**：

1. 在 `pumpQueue` 里，**播放开始前**（`await play(decoded, gen)` 之前，
   即 `inflight.shift()` 取出 `{ promise, gen, index }` 处）拿到当前句的
   `text` 与它所属的 `turnId`。这就是「正在朗读」的准确时刻。
   - `index` 只认本轮第几句；`gen` 用于「朗读被打断/关闭时立即取消高亮」。
2. 维护一个状态（ref，不进 React 渲染）：
   `{ text, turnId, gen, startedAt }`，以及一个 `clearHighlight()`。
   - `haltSpeaking()`（停止朗读 / 打断 / 新一轮）时调用 `clearHighlight()`。
3. 每次句子开始播放时，**在 DOM 里找匹配并高亮**：
   - 定位容器：`document.querySelector('[data-step-process-content]')` 中，
     属于「当前这轮」的那个。由于 `turnId` 与 `data-chat-turn` 不同源，
     更稳的做法是定位**最后一个**含助手内容的 `[data-step-process-content]`
     （正在流式生成的回复总是在最后），或按 `data-chat-flow` 过滤。
   - 文本匹配：对容器的 `innerText`（或递归遍历 text node）做
     `indexOf(currentText)`，找到后把该文本节点包进 `<mark>`/高亮 span。
   - **纯文本段落**里 `text` 会精确命中；**带格式段落**里 `text`（无 markdown）
     在 DOM 文本里通常也能命中（因为 DOM 文本节点已是渲染后的纯文本）。
     例外：跨节点/跨块的句子（见 3.3）会匹配不到 —— 方案 B 处理。
4. 高亮样式：注入一段 `<style>`（与现有 CSS-in-JS 风格一致），用
   `background`/`box-shadow` 或者 `text-decoration` 圈出当前句；
   也可以给容器加 `data-voice-highlight` 属性，交由 CSS 选择器处理。
5. 句与句之间清掉上一句的高亮、打上这一句的高亮。朗读结束/打断时全部清除。

**优点**：不改 DSH 渲染、不依赖任何私有槽位；纯 DOM，天然兼容流式更新
（每次句子开始都重新扫描，覆盖最新渲染）。实现完全在 `dsh-voice-typing`
插件内。

**缺点**：
- 匹配失败（跨块句子、DOM 文本与 `text` 因空白/标点不一致）时该句不高亮
  —— 需要**降级策略**：至少高亮「能命中的前缀」，或者整段容器轻量高亮。
- 频繁 DOM 扫描 + 包节点需要小心 React 重渲染（React 可能重建 DOM）。
  建议在 `requestAnimationFrame`/短延时里做，且用 `MutationObserver` 监听
  回复仍在流式增长的情况。
- 匹配到的文本节点可能被打断（`\u00a0`、软换行、`</p>` 边界）。

**这是唯一不碰 DSH 内部、又能覆盖绝大多数场景的方案。**

### 方案 B ——「按词/按块增量高亮」（更精细，成本更高）

在方案 A 基础上，把「正在朗读的句子」拆成**更小的增量**（比如按字符数
或按 DOM 块），随着朗读推进逐步扩展高亮范围，像「卡拉 OK」一样。

- 需要把一句话再细分成 N 份，播放时按 `AudioBuffer.duration` 的比例定时
  推进高亮边界。
- 更贴近「字随声走」，但复杂度明显上升，且对 `text`（纯文本）与 DOM 的
  对齐要求更高。

### 方案 C ——「整段回复背景高亮」（最简，最稳）

在朗读期间给**当前这一轮助手回复的整个容器**加一个浅色背景/左边框。
不逐句匹配，只表示「这轮正在被朗读」。

- 实现最简单：只需 `turn-begin` 时定位容器加 class，`turn-end`/停止时移除。
- 用户仍能一眼看到「在念哪段」，但**看不到具体哪一句**。

### 方案 D ——「劫持 MarkdownText 渲染」（不推荐）

通过 `conversation.chat.node`（`key: "assistant-step"`）注册一个更高优先级的
渲染器来包一层自己的 `AssistantMarkdown`，从而拿到 `blocks` 并在 `text` 块里
注入高亮 `<mark>`。

- **不推荐**：会替换 DSH 自带的 `AssistantNodeView`，需要完整复刻其 props
  与行为；且 `AssistantNodeView` 未导出为可复用组件，极易在 DSH 升级时
  断裂。这与插件「不侵入宿主」的定位冲突。

---

## 5. 推荐落地路径（方案 A）

1. **在 `src/client/pure/` 里加一个纯函数模块 `highlight.js`**：
   - `locateTextInDom(root, targetText) → { node, start, end } | null`：
     深度遍历 text node，用 `normalize`（折叠空白/`\u00a0`→空格）做匹配。
   - `wrapRange(node, start, end, markerClass)`：把一个 text node 的一段
     包进高亮 span（`splitText` 后插入 `<mark data-voice-reading>`）。
   - `clearHighlight(root)`：移除 `[data-voice-reading]` 并合并回文本节点。
   这些都能像 `draft-merge.js` 一样被 `npm test` 独立覆盖。
2. **在 `pumpQueue` 的播放点接高亮**：
   - 播放前 `setHighlight({ text: item.sentence, gen, turnId: currentTurnIdRef.current })`；
   - 播放后清掉上一句。
   - `haltSpeaking` / `stopPlayback` / `turn-begin` 里 `clearHighlight()`。
3. **定位当前回复容器**：
   - 优先 `document.querySelector('[data-step-process-content]:last-of-type')`
     或包含「正在流式内容」的那个；找不到就退回
     `[data-step-process-content]` 里 `data-chat-flow` 非空、且含文本的最后一个。
   - 由于 turnId 与 `data-chat-turn` 不同源，**不要**用事件 `turnId` 直接查
     `data-chat-turn`。可以改用「句子文本匹配 + 从后往前找」。
4. **样式**：注入 `.dsh-voice-reading` 的 CSS（如
   `background: rgba(255,220,0,.35)`），并给高亮 span 设 `border-radius`，
   避免打断换行。
5. **测试**：新增 `test/highlight.test.mjs`，用 jsdom 或纯字符串场景覆盖
   `locateTextInDom` / `wrapRange` / `clearHighlight`，并接入 `npm test`。

---

## 6. 需要你拍板的取舍

| 维度 | 方案 A（逐句高亮） | 方案 C（整段高亮） |
|---|---|---|
| 实现成本 | 中 | 低 |
| 视觉反馈粒度 | 一句一句 | 一段一段 |
| 纯文本段落命中率 | 高 | 高（不依赖匹配） |
| 带格式段落命中率 | 中（跨块句子可能漏） | 高 |
| 与 React/DOM 重渲染的耦合 | 需小心 | 很轻 |
| 侵入宿主程度 | 无 | 无 |

**我的建议**：先做 **方案 A + 降级到方案 C** —— 逐句能高亮就高亮那一句，
匹配不到就整段浅高亮，保证「永远有反馈、且尽量精确」。

---

## 7. 附：关键源码位置速查

| 位置 | 内容 |
|---|---|
| `lib/index.js` ~1680-1736 | 宿主广播 `sentence {text, turnId, index}` |
| `lib/speech-clean.js` `stripForSpeech` | markdown → 纯文本（高亮匹配不对齐的根源） |
| `lib/turn-model.js` | 插件本地 `turnId` 分配（与 DSH turn id 不同源） |
| `src/client/main.js` ~1519-1529 | `pumpQueue` 播放点（高亮的最佳挂点） |
| `src/client/main.js` ~1634-1719 | 客户端 SSE `turn-begin` / `sentence` 处理 |
| `src/client/main.js` ~1137-1148 | `stopPlayback` / `haltSpeaking`（清高亮） |
| `app.asar` `dsh-client-ui-chat` `ChatGroupSeat` | `data-step-process-content` 稳定锚点 |
| `app.asar` `dsh-client-ui-chat` `AssistantMarkdown` | 助手 markdown 渲染（无文本块插槽） |

---

## 8. 实现落地

> 结论：**方案 A + 方案 C 兜底**，用**覆盖层**实现，不碰消息 DOM、不影响消息流。

### 为什么用覆盖层而不是给文本节点包 `<mark>`

消息是 React 渲染的。若对 React 管理的文本节点 `splitText()` 再插入我们自己的
元素，会在流式重渲染时留下 React 不知道的孤儿节点 —— 表现为文字重复、消息流被
弄乱。所以这里**完全不碰消息 DOM**：

1. 纯函数 `matchInNodes`（`src/client/pure/highlight.js`）把「若干文本节点的原文」
   拼成归一化字符串，找到目标句的位置，映射回各节点里的原始区间。
2. 用 `Range.setStart / setEnd` 圈住命中区间，`range.getClientRects()` 拿到**视口矩形**。
3. 在一个 `position:fixed`、`pointer-events:none` 的覆盖层里画半透明色块垫在文字下。

色块只是装饰层，文字节点一个都不动，React 完全不受影响 —— 即「不影响消息流」。
滚动/缩放时用 rAF 节流重算矩形，避免错位。

### 关键决策

- **容器定位**：`turnId`（插件本地）与 DSH 的 `data-chat-turn` 命名空间不同，不能
  直接映射。改为从最新（最后）的 `[data-step-process-content]` **倒序**找第一个
  `textContent` 归一化后包含目标句的容器 —— 朗读总发生在最新一轮，倒序能避开
  「旧消息里恰好也有同样文字」的误判。
- **SSML 还原**：宿主广播的 `sentence.text` 经过 `stripForSpeech`，`&`→`&amp;`、
  `<`→`&lt;`。匹配前必须 `unescapeSpeechText` 还原，否则永远匹配不上。
- **空白归一化**：DOM 里可能有 `\u00a0`、软换行、折叠空白；宿主侧已把空白串折叠成
  单个空格。两侧都归一化后再比对。
- **降级**：整句匹配不上（跨块/软换行错位）→ 整段浅高亮（方案 C），保证「永远有反馈」。
- **生命周期**：在 `pumpQueue` 里、`await play(decoded, gen)` **之前** `set(sentence)`
  高亮；队列空、`haltSpeaking`、`stopPlayback`、`turn-begin`、卸载时 `clear()` /
  `dispose()`。合成失败那句不 `set`（没在念就不高亮）。

### 改动文件

| 文件 | 内容 |
|---|---|
| `src/client/pure/highlight.js` | 纯匹配逻辑（`unescapeSpeechText` / `normalizeRun` / `collapseWhitespace` / `matchInNodes`），可被 Node 测试原生 import |
| `src/client/main.js` | `createReadingHighlight` 覆盖层控制器；`readingHighlightRef`；`pumpQueue` 播放点 `set`；`haltSpeaking`/队列空/卸载清理 |
| `test/highlight.test.mjs` | 纯函数测试（32 例） |
| `package.json` | `npm test` 接入 `highlight.test.mjs` |

### 验证

- `node scripts/bundle-client.mjs` 成功内联 5 个纯文件（含 `highlight.js`）。
- `node --check lib/client.js` 通过。
- `npm test` 全部通过（含新增 `highlight.test.mjs` 32/32）。

### 运行期实测修正（关键）

> ⚠️ **第 8 节此前对容器结构的假设是错的**，导致「插件已加载、也在朗读，但界面上
> 一直不高亮」。已按真实 DOM 修正并确认生效。

**症状**：`__DSH_VOICE_DEBUG__().readingHighlight` 显示
`active:true, speaking:true, foundContainer:false, error:"no-container"` —— 高亮在跑，
但 `findContainer` 找不到容器。

**根因（用 DevTools 在真实 DOM 上验证）**：**正在流式输出的助手回复并不在
`[data-step-process-content]` 里**。该属性只包裹**已归档**的完整 turn；而当前正在
朗读/流式的回复位于：

```
div[data-chat-flow-key][data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]
  └ div[data-slot="conversation.chat.node"]
      └ … <p>/<strong>/<code>/<ul> …   ← 目标句在这
```

实测 `target.closest('[data-step-process-content]') === null`，而
`target.closest('[data-chat-flow-kind]')` 为 `assistant-step`。只搜
`[data-step-process-content]` 会**永远漏掉正在读的那一句** → 什么都不高亮。

**修正**：`findContainer` 不再只搜 `[data-step-process-content]`，而是同时搜
`[data-chat-flow-key][data-chat-flow-kind="assistant-step"]`、`[data-chat-flow]`、
`[data-slot="conversation.chat.flow"]`；凡是归一化后包含目标句的都作为候选，取
**textContent 最短（最深层、最精确）** 的那个容器：
- 正在流式的回复 → 命中 `assistant-step` 节点（精确到当前回复）；
- 已归档回复 → 命中 `[data-step-process-content]`（整 turn）。

**验证**：重启后朗读，界面上出现逐句高亮，用户确认「有高亮了」。全量 `npm test`
通过（26 bundle-sync + 32 highlight）。

**配套诊断**：`__DSH_VOICE_DEBUG__().readingHighlight` 暴露
`{active,target,containerCount,foundContainer,matchCount,rectCount,layerChildren,error}`，
并在心跳 `voice-session` 里带上该字段，便于从宿主 `/diagnostics` 直接排查。
