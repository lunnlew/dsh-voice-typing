# React 组件环境注入方案设计（2026-11-02）

> 目标：为 MicButton（2188 行）和 GlobalVoiceOverlay（1526 行）的环境注入改造提供设计方案，
> 使这两个组件能够提取到 `src/client/dom/` 目录，遵守"dom/ 文件不直接访问浏览器全局"的约束。

> ## 落地实况与本文的差别（2026-11-06 复核）
>
> 方案 A 已经执行完，两个组件都在 `src/client/dom/` 里了，`main.js` 从当时的 4152 行降到
> **627 行**。但**注入接口这一层跟本文写的不一样**，而且差别是有原因的 ——
> 照本文的 §3.1 / §5.1 / §6 动手会重演一次线上崩溃。逐条如下，正文里对应位置都加了回指。
>
> **1. 浏览器环境不是手写成员清单，是整对象转发。**
> 本文 §3.1 那份「列出十几个成员 + `.bind(window)` + getter」的 `browserEnv` 真写过，
> 也真崩过：清单漏一个成员，浏览器里就是 `Cannot read properties of undefined` ——
> reading-highlight 的 dispose 读 `win.document` 崩掉整个 `main.conversation` 槽位
> （2026-11-03 装机实测），而 Node 侧测试全绿，因为测试传的是自己的 mock，压根不走这份清单。
> 现在它是 `main.js` 的 `forwardEnv(real)`：一个 Proxy，`get` 时从真实对象取、
> 函数**绑回真身并按名字缓存**、`__DSH_` 前缀的读写删直接落真实 window、
> 其余赋值留在包装对象自己身上。要什么给什么，不再需要有人记得列全。
> 见 §3.1、§5.1、§8.1；判据在 `test/env-forwarding.test.mjs`。
>
> **2. 键名换了。** 注入对象的键是 `{ win, doc, nav }`，不是 `{ window, document, navigator }`；
> 组件里解构成 `const { win, doc, nav } = browserEnv`。本文示例中的解构写法要按这个改。
>
> **3. `timers` 不在注入清单里。** §3.2 的 `ServiceEnv` 列了 `timers`，
> 实际按 §4.3 走的是「组件内部自己 `createTimerRegistry(win)`」。
> 今天真实的注入内容：
> `createMicButton(React, browserEnv, { sessionContext, micDevice, playCore, configStore })`、
> `createGlobalVoiceOverlay(React, browserEnv, { sessionContext, micDevice, a11yBridge, clientIdentity, configStore })`、
> `createVoiceSettingsSection(React)`（只要 React）、
> `createA11yDomBridge(win, doc)`（位置参数，不接 browserEnv）。
>
> **4. 没有 `test/helpers/browser-env-stub.js`，这条测试路线被换掉了。**
> 本文 §6 设想的「给组件喂一份桩 env、在 Node 里单测组件」没有建成独立 helper；
> 实际做法是**加载真产物** `lib/client.js`，配假 React/假 DOM/假 AudioContext 驱动真实流程
> （`test/client-behavior.test.mjs`），单模块级测试各自就地造最小 env。
> 为什么这样更好：桩 env 与生产 env 的形状可以各说各话（第 1 条那次崩溃正是这么漏掉的），
> 而产物级测试没有这个缝。代价是"组件级单测"变重了 —— 要跑就得连着构建跑，
> 这也是 `pnpm test` 现在先构建再测的原因之一。见 §6。
>
> **5. 「更新 bundle-sync 添加新文件的检查」这一步作废。** 本文 §7.3 与 §9 说的那个手工登记
> 环节已经不存在：`@bundle` 标记随 esbuild 一起退役，待校验清单取自构建**真正合并的文件**，
> 新增 `dom/xxx.js` 只要被入口 import 到就自动进清单。见 §7.3。
>
> **6. §8.1 那个「bind 只是性能问题」的判断低估了它。** 绑定本身是正确性问题：
> `doc.createElement` 拿到手再当普通函数调用是 `Illegal invocation`；
> 而每次读都新建 bound 函数的话，`addEventListener` 与 `removeEventListener`
> 拿到的不是同一个引用，监听器**永远解绑不掉**。
> `forwardEnv` 里那张 `bound` Map 就是为了同时解决这两条。
>
> **没变的部分**：§2 的四条设计目标、§4.1「组件内只用 `win/doc/nav`」、
> §4.2 调试通道可选、§4.3 定时器内部建、§4.4 事件派发加保护、
> §9.1「不建议放弃提取」的评估，全部照原样成立，今天的代码就是这么写的。
> §1.1 / §1.3 的统计（27 处、29 处、5/6 个服务）是**改造前**的快照，只作立项依据。

---

## 1. 现状分析

### 1.1 浏览器全局对象使用统计

| 组件 | window | document | navigator | 合计 |
|---|---|---|---|---|
| MicButton | 27 处 | 0 处 | 0 处 | 27 处 |
| GlobalVoiceOverlay | 14 处 | 13 处 | 2 处 | 29 处 |

### 1.2 具体使用模式

**MicButton**：
- `window.clearTimeout` / `window.clearInterval` —— 定时器清理
- `window.__DSH_VOICE_DEBUG__` —— 调试对象注册
- `window.speechSynthesis` —— 语音合成 API
- `window.dispatchEvent` / `window.addEventListener` / `window.removeEventListener` —— 自定义事件

**GlobalVoiceOverlay**：
- `window.__DSH_VOICE_GLOBAL_DEBUG__` —— 调试对象注册
- `window.dispatchEvent` / `window.addEventListener` / `window.removeEventListener` —— 自定义事件
- `document.querySelector` / `document.querySelectorAll` —— DOM 查询（侧边栏状态、全局元素）
- `document.activeElement` / `document.body` —— 活动元素查询
- `navigator.language` —— 语言检测

### 1.3 服务依赖

**MicButton**：sessionContext, timers, configStore, playCore, micDevice（5 个）

**GlobalVoiceOverlay**：timers, configStore, sessionContext, micDevice, a11yBridge, clientIdentity（6 个）

### 1.4 常量依赖

两个组件使用的常量已经提取到 `pure/voice-constants.js`，可以直接 import，不需要通过工厂参数传递。

---

## 2. 设计目标

1. **最小侵入**：改造应尽量不改变组件内部逻辑，只改变浏览器全局的访问方式
2. **向后兼容**：改造后的组件在真实浏览器环境中行为与改造前完全一致
3. **可测试性**：改造后的组件能在 Node.js 桩环境中被单独驱动（不需要真实浏览器）
4. **类型安全**：注入接口应有明确的形状定义，方便后续加 TypeScript

---

## 3. 注入接口设计

### 3.1 浏览器环境对象（BrowserEnv）

> ⚠️ 这一节与 §5.1 的**手写成员清单方案已被推翻**，现在是对真实对象的整对象转发
> （`forwardEnv`），键名也换成 `{ win, doc, nav }`。
> 理由与真实事故见文首「落地实况与本文的差别」第 1、2 条。
> 下面的 interface 片段保留是为了说明「当初为什么觉得列清单就够」。

```javascript
/**
 * 浏览器环境注入接口。
 * 
 * 组件不再直接访问 window/document/navigator，而是通过这个对象
 * 获取浏览器 API。桩环境可以传入 mock 实现。
 */
interface BrowserEnv {
  // Window API
  window: {
    // 定时器
    setTimeout: (fn: () => void, ms: number) => number
    clearTimeout: (id: number) => void
    setInterval: (fn: () => void, ms: number) => number
    clearInterval: (id: number) => void
    
    // 事件系统
    dispatchEvent: (event: Event) => boolean
    addEventListener: (type: string, listener: EventListener, options?: any) => void
    removeEventListener: (type: string, listener: EventListener, options?: any) => void
    
    // 语音合成
    speechSynthesis?: {
      speak: (utterance: any) => void
      cancel: () => void
      pause: () => void
      resume: () => void
      getVoices: () => any[]
      onvoiceschanged?: () => void
    }
    
    // 调试对象（可选，桩环境可以不注册）
    __DSH_VOICE_DEBUG__?: () => any
    __DSH_VOICE_GLOBAL_DEBUG__?: () => any
  }
  
  // Document API
  document: {
    querySelector: (selector: string) => Element | null
    querySelectorAll: (selector: string) => NodeList
    activeElement?: Element | null
    body?: Element | null
  }
  
  // Navigator API
  navigator: {
    language: string
  }
}
```

### 3.2 服务依赖对象（ServiceEnv）

> ⚠️ 落地时 **`timers` 没有进注入清单**：按 §4.3 由组件内部自己
> `createTimerRegistry(win)` 建，依赖更少。今天真实的注入内容写在文首第 3 条。

```javascript
/**
 * 服务实例注入接口。
 * 
 * 这些服务在 main.js 顶层创建，通过工厂参数传递给组件。
 */
interface ServiceEnv {
  sessionContext: SessionContext
  micDevice: MicDevice
  playCore?: PlayCore  // MicButton 需要，GlobalVoiceOverlay 不需要
  a11yBridge?: A11yBridge  // GlobalVoiceOverlay 需要，MicButton 不需要
  clientIdentity?: ClientIdentity  // GlobalVoiceOverlay 需要，MicButton 不需要
  configStore: ConfigStore
  timers: TimerRegistry
}
```

### 3.3 工厂签名

> ✅ 三参数形状 `create(React, browserEnv, serviceEnv)` 原样落地了。
> 只有函数体里那一行解构不同：今天写 `const { win, doc, nav } = browserEnv`。

```javascript
// MicButton
export function createMicButton(R, browserEnv, serviceEnv) {
  const { useState, useCallback, useEffect, useRef, createElement: h } = R
  const { window: win, document: doc, navigator: nav } = browserEnv
  const { sessionContext, micDevice, playCore, configStore, timers } = serviceEnv
  
  function MicButton(props) {
    // 组件内部使用 win/document/nav 而不是 window/document/navigator
    // ...
  }
  
  return MicButton
}

// GlobalVoiceOverlay
export function createGlobalVoiceOverlay(R, browserEnv, serviceEnv) {
  const { useState, useCallback, useEffect, useRef, createElement: h } = R
  const { window: win, document: doc, navigator: nav } = browserEnv
  const { sessionContext, micDevice, a11yBridge, clientIdentity, configStore, timers } = serviceEnv
  
  function GlobalVoiceOverlay(props) {
    // ...
  }
  
  return GlobalVoiceOverlay
}
```

---

## 4. 改造策略

> ✅ 这四条原则**全部照做**，今天的 `dom/` 代码就是这么写的（定时器那条见文首第 3 条：
> 它赢了 §3.2 里的 `timers` 注入方案）。

### 4.1 浏览器全局访问替换

**原则**：将组件内所有 `window.xxx` / `document.xxx` / `navigator.xxx` 替换为 `win.xxx` / `doc.xxx` / `nav.xxx`，其中 `win/document/nav` 是从 `browserEnv` 解构出来的局部变量。

**示例**：

```javascript
// 改造前
window.clearTimeout(timerId)
document.querySelector('[data-sidebar-collapsed]')
navigator.language

// 改造后
win.clearTimeout(timerId)
doc.querySelector('[data-sidebar-collapsed]')
nav.language
```

### 4.2 调试对象注册

**原则**：调试对象注册应该是可选的。如果 `win.__DSH_VOICE_DEBUG__` 不存在（桩环境），跳过注册。

**示例**：

```javascript
// 改造前
window.__DSH_VOICE_DEBUG__ = () => ({ ... })

// 改造后
if (win.__DSH_VOICE_DEBUG__ !== undefined) {
  win.__DSH_VOICE_DEBUG__ = () => ({ ... })
}
```

### 4.3 定时器创建

**原则**：timers 实例由组件内部创建（使用 `createTimerRegistry(win)`），而不是从外部传入。这样组件对外部依赖更少。

**示例**：

```javascript
// 组件内部
const timersRef = useRef(null)
if (!timersRef.current) {
  timersRef.current = createTimerRegistry(win)
}
const timers = timersRef.current
```

### 4.4 事件派发

**原则**：`dispatchEvent` 调用应该包在 try-catch 里，桩环境可能没有完整的事件系统。

**示例**：

```javascript
// 改造前
window.dispatchEvent(new CustomEvent(GLOBAL_MIC_OFF_EVENT))

// 改造后
try {
  win.dispatchEvent(new CustomEvent(GLOBAL_MIC_OFF_EVENT))
} catch {
  // 测试桩环境可能不支持 CustomEvent，忽略
}
```

---

## 5. main.js 调用侧改造

### 5.1 创建浏览器环境对象

> ⚠️ **这段代码已经不是现在的写法**（手写清单 + `.bind()` + 逐条 getter）。
> 现在 `main.js` 里只有三行：
>
> ```javascript
> const browserEnv = {
>   win: forwardEnv(typeof window !== 'undefined' ? window : null),
>   doc: forwardEnv(typeof document !== 'undefined' ? document : null),
>   nav: forwardEnv(typeof navigator !== 'undefined' ? navigator : null),
> }
> ```
>
> `forwardEnv` 用 Proxy 整对象转发，函数绑回真身且按名字缓存绑定结果，
> `__DSH_` 前缀的读写删落真实 window。为什么必须这么改，见文首第 1、2、6 条。

```javascript
// main.js 顶层（factory 内部）
const browserEnv = {
  window: {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    speechSynthesis: window.speechSynthesis,
  },
  document: {
    querySelector: document.querySelector.bind(document),
    querySelectorAll: document.querySelectorAll.bind(document),
    get activeElement() { return document.activeElement },
    get body() { return document.body },
  },
  navigator: {
    get language() { return navigator.language },
  },
}
```

### 5.2 创建服务实例

```javascript
// 服务实例已经在 main.js 顶层创建，直接引用
const serviceEnv = {
  sessionContext,
  micDevice,
  playCore,
  a11yBridge,
  clientIdentity,
  configStore,
  timers,
}
```

### 5.3 调用工厂

```javascript
// main.js 顶部（第 5 步起入口清单就是 import，不再有 @bundle 标记）
import { createMicButton } from './dom/mic-button.js'
import { createGlobalVoiceOverlay } from './dom/global-voice-overlay.js'

// buildClientModule(require) 体内
const MicButton = createMicButton(React, browserEnv, serviceEnv)
const GlobalVoiceOverlay = createGlobalVoiceOverlay(React, browserEnv, serviceEnv)
```

---

## 6. 测试桩环境

> ⚠️ **这一节没照做**：`test/helpers/browser-env-stub.js` 这个文件不存在，也不该再建。
> 实际路线是**加载真产物** `lib/client.js`，配假 React / 假 DOM / 假 AudioContext
> 驱动真实流程（`test/client-behavior.test.mjs`），单模块级测试各自就地造最小 env。
> 换掉的原因就是本节这份桩：它「恰好带 document」，所以清单漏 `document` 的那次崩溃
> 在 59 个测试全绿的情况下发生了 —— 桩 env 与生产 env 之间有条谁都不看的缝，
> 产物级测试没有这条缝。完整说明在文首第 4 条。
>
> 仍然有效的部分：下面这段桩里「定时器要能自己记录并取消」的思路，
> 今天由 `pure/envelope.js` 的 `createTimerRegistry(win)` 承担，
> 并由 `test/timer-registry.test.mjs` 判（登记表之外不许裸起定时器）。

### 6.1 桩环境对象

```javascript
// test/helpers/browser-env-stub.js
export function createBrowserEnvStub() {
  const timers = new Map()
  let timerId = 0
  
  return {
    window: {
      setTimeout: (fn, ms) => {
        const id = ++timerId
        timers.set(id, setTimeout(fn, ms))
        return id
      },
      clearTimeout: (id) => {
        clearTimeout(timers.get(id))
        timers.delete(id)
      },
      setInterval: (fn, ms) => {
        const id = ++timerId
        timers.set(id, setInterval(fn, ms))
        return id
      },
      clearInterval: (id) => {
        clearInterval(timers.get(id))
        timers.delete(id)
      },
      dispatchEvent: () => true,
      addEventListener: () => {},
      removeEventListener: () => {},
      speechSynthesis: undefined,
    },
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      activeElement: null,
      body: null,
    },
    navigator: {
      language: 'en-US',
    },
  }
}
```

### 6.2 使用示例

```javascript
import { createBrowserEnvStub } from './helpers/browser-env-stub.js'

const browserEnv = createBrowserEnvStub()
const serviceEnv = { /* mock services */ }

const MicButton = createMicButton(React, browserEnv, serviceEnv)
// 现在可以在 Node.js 里测试 MicButton 组件
```

---

## 7. 改造步骤

> ✅ 三个阶段都做完了（2026-11-02 之后那几轮）。今天 `src/client/dom/` 有 **9 个**文件，
> 比这里规划的两个多：`a11y-bridge.js`、`client-id.js`、`config-store.js`、
> `global-voice-overlay.js`、`mic-button.js`、`mic-device.js`、`playback-core.js`、
> `session-context.js`、`voice-settings-section.js`。
> 各步里与现状不符的两处：第 1/2 阶段第 5、8 步的「桩环境测试」见 §6 的更正，
> 第 3 阶段第 3 步见下面。

### 7.1 第一阶段：MicButton（较小，27 处 window 访问）

1. 创建 `src/client/dom/mic-button.js` 骨架（工厂函数 + 导入）
2. 复制组件代码，替换所有 `window/document/navigator` 为 `win/doc/nav`
3. 处理调试对象注册（加 if 判断）
4. 处理事件派发（加 try-catch）
5. 在 main.js 创建 `browserEnv` 对象
6. 更新工厂调用
7. 构建并测试
8. 创建桩环境测试

### 7.2 第二阶段：GlobalVoiceOverlay（较大，29 处浏览器全局访问）

1. 创建 `src/client/dom/global-voice-overlay.js` 骨架
2. 复制组件代码，替换所有浏览器全局访问
3. 处理 DOM 查询（侧边栏状态检测）
4. 处理调试对象注册
5. 更新 main.js 工厂调用
6. 构建并测试
7. 创建桩环境测试

### 7.3 第三阶段：清理与文档

> ⚠️ 第 1、3 步的口径已变：`browserEnv` 不但没删，反而成了唯一的注入通道（它现在只有三行，
> 见 §5.1 的更正）；`test/bundle-sync.test.mjs` 也**不再需要为新文件加检查** ——
> 待校验清单取自构建真正合并的那些文件，`@bundle` 标记随 esbuild 一起退役了。
> 第 2 步照做，记录在 `docs/architecture-modernization.md`。

1. 删除 main.js 中的 `browserEnv` 定义（如果组件都提取完了）
2. 更新 `docs/architecture-modernization.md` 记录改造过程
3. 更新 `test/bundle-sync.test.mjs` 添加新文件的检查

---

## 8. 风险与缓解

> ⚠️ 这三条的评估**都偏轻了**，逐条更正如下。

### 8.1 风险：`bind(this)` 性能

> **更正**：绑定不是性能问题，是**正确性**问题，而且原方案还漏了另一半。
> `doc.createElement` 拿到手再当普通函数调用，浏览器里是 `Illegal invocation` —— 这半条原方案猜到了；
> 没想到的是**每次读都新建 bound 函数**会让 `addEventListener` 与 `removeEventListener`
> 拿到两个不同引用，监听器永远解绑不掉。`forwardEnv` 里那张 `bound` Map
> 就是按名字缓存绑定结果，一次解决这两条。
> 至于开销：Proxy 的 `get` 比属性直读贵一点，这是这套方案换来的固定成本；
> 换掉的是「谁漏列一个成员，线上崩一次」这种查不出来的代价。
> 逐帧的音频处理本身走 `pure/`（门限判定、重采样都是纯函数），不经过注入环境。

**问题**：`browserEnv` 对象中的方法都用了 `.bind(window)`，每次调用会有额外的函数创建开销。

**缓解**：`browserEnv` 只在 main.js 顶层创建一次，组件内部通过解构获取方法引用，不会有重复创建。实测性能影响可忽略。

### 8.2 风险：getter 属性丢失

**问题**：`document.activeElement` 和 `navigator.language` 是 getter，直接赋值会丢失动态性。

**缓解**：在 `browserEnv` 中使用 `get activeElement() { return document.activeElement }` 这样的 getter 定义，保持动态性。

### 8.3 风险：桩环境不完整

**问题**：桩环境可能无法完全模拟真实浏览器的所有行为（如事件冒泡、DOM 查询等）。

**缓解**：桩环境只用于单元测试，验证组件逻辑。集成测试仍然在真实浏览器环境跑。桩环境应该明确标注哪些 API 是 mock 的，哪些是真实实现的。

---

## 9. 替代方案

> 这一节当时用来否掉「不提取」和「只提取一部分」两个退路。结论被后面十几轮验证是对的：
> 组件全部提取完成，`main.js` 现在 627 行。留着是因为它记录了**当时的规模判断**
> （MicButton 2188 行、GlobalVoiceOverlay 1526 行、VoiceSettingsSection 已提走）——
> 这两个数字今天分别是 2344 与 1704，因为提取之后又在原职责上长过几轮。

### 9.1 方案 B：不提取大型组件

**理由**：MicButton 和 GlobalVoiceOverlay 与浏览器环境深度耦合，强行提取会增加复杂度。

**代价**：main.js 保持 4000+ 行，"可导航性"差。

**评估**：当前已经提取了 VoiceSettingsSection（1500 行），证明工厂模式可行。剩下两个组件虽然耦合深，但通过环境注入改造仍然可以提取。不建议放弃。

### 9.2 方案 C：部分提取

**理由**：只提取组件中与浏览器全局无关的部分（如纯逻辑 hooks），保留 UI 渲染部分在 main.js。

**代价**：提取不彻底，main.js 仍然较大。

**评估**：增加了代码分裂，维护成本更高。不建议。

---

## 10. 结论

**推荐方案 A**（完整环境注入改造），理由：

1. **改造范围明确**：浏览器全局访问点已经全部统计出来（MicButton 27 处，GlobalVoiceOverlay 29 处）
2. **改造策略清晰**：替换访问方式 + 加保护判断 + 桩环境支持
3. **收益显著**：main.js 可以从 4152 行降到 ~438 行（只剩 factory 入口和 apply 函数）
4. **风险可控**：通过桩环境和集成测试双重保障

**下一步**：按 §7 的三阶段步骤执行改造。

> **执行结果（2026-11-06）**：三阶段全部完成，还往外多提了 7 个文件（`dom/` 现在 9 个）。
> §10 第 3 条预测的「`main.js` 降到 ~438 行」实际落在 **627 行** ——
> 多出来的是 `forwardEnv` 与几个服务的建实例代码，不是没提干净。
> 唯一偏离本方案的地方就是文首那六条：**注入接口的形状换了**（清单 → 整对象转发），
> **测试路线换了**（桩 env → 跑真产物）。
