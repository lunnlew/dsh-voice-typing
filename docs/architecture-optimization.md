# 架构设计优化探索

> 探索日期：2026-11-02　最后复核：2026-11-06
> 基线：`main` @ `23b3d56`（`fix(hotkey): never start native uiohook without a display`）
> 范围：本文件是**探索性分析**，不是改动清单。结论按「能带来什么收益」排序，
> 每条都标了**现状证据**、**问题**、**可选优化**与**建议优先级**。
> 改动前请先读 [`docs/maintainer-notes.md` 第 1 节](./maintainer-notes.md) —— 那里记录了本插件
> 反复踩过的坑和对应的硬规则，任何重构都不得破坏它们。
>
> **怎么读这份文件**：正文里的行数、文件位置、「某某未动」都是**下笔当时的快照**，
> 后面十几轮改动把不少结论往前推了一大截。看某条结论时请连着它下面的「状态」引用块一起看；
> 想知道仓库现在到底什么样，直接看 §0.5。逐批的改动记录住在
> [`architecture-modernization.md`](./architecture-modernization.md)，不在这里。

---

## 0. 一句话结论

架构**已经很好**：宿主/客户端边界清晰、纯逻辑已抽成可单测模块、配置有 schema、
朗读调度有流控、构建产物有同步校验。真正值得优化的不是「再拆几个文件」，而是
**消除两处已经存在的、被文档承认的重复实现**（宿主侧门限、UI 动作协议），
以及**让两个大文件（当时 `lib/index.js` 3.3k 行、`src/client/main.js` 6.4k 行）的
内部结构更容易被导航**。这三件事能直接降低「改 A 处漏 B 处」的风险。

> **这句话现在还剩多少成立**：重复实现那两条已经**彻底消除**（收进 `src/shared/`，
> 两端共用一份）；大文件只解决了一半 —— 浏览器侧那个 6.4k 行的 `main.js` 如今是
> **627 行**，剩下的按职责拆进了 `src/client/dom/` 与 `src/client/pure/`；
> 宿主侧的 `index.js` 仍然是单文件（手写 4176 行），§6.3 与 §6.4 那两条**至今没做**。
> 详见 §0.5。

### 0.5 仓库现在的样子（2026-11-06 实测）

本文之后所有轮次改动的落点都在这里。复核命令：`wc -l`、`ls`、`git ls-files lib`。

| | 2026-11-02（本文下笔时） | 2026-11-06 |
|---|---|---|
| 宿主手写源码 | `lib/*.js`（既是源码又是产物，23 个文件） | `src/host/*.js` **26 个文件**，`index.js` 4176 行 |
| 宿主产物 | —— | `lib/index.js` 6815 行（esbuild 合成） |
| 浏览器集成 | `src/client/main.js` 6389 行 | `src/client/main.js` **627 行** |
| 浏览器 DOM 胶水 | 无 | `src/client/dom/*.js` **9 个** |
| 浏览器纯逻辑 | `src/client/pure/*.js` 若干 | **24 个**（客户端源码合计 12131 行） |
| 双端单源判据 | 无 | `src/shared/*.js` **11 个** |
| 浏览器产物 | `lib/client.js`（正则内联生成） | `lib/client.js` 8015 行（esbuild 按 import 图生成） |
| 版本库里的 `lib/` | 手写 + 产物混在一起 | **不入库**，只有 4 份构建产物 |
| 测试 | 56 个文件 | **76 个文件**，其中 `silence.test.mjs` 需要真识别服务器，其余 75 个串行跑 |

配套的三处口径变化，正文里凡是提到旧写法的段落都按这里读：

- **构建**：`scripts/build-client.mjs` + `scripts/build-host.mjs`（esbuild）取代了
  `scripts/bundle-client.mjs`。`@bundle` 注释标记**已退役**，产物内容现在由
  import 图决定，不再由「主文件里有没有写那行标记」决定。
- **`lib/` 的身份**：批次 23 起 `lib/` 整体移出版本库，只放 `build` 生成的
  `index.js` / `client.js` / `asr-worker.js` / `tts-worker.js`。
  所以正文里「`lib/gate.js`」「`lib/config-schema.js`」这类路径今天对应的是
  `src/host/` 下的同名手写文件。
- **跑测试**：`pnpm test`（= `node scripts/run-tests.mjs`）**先构建两端产物再跑**，
  判据驱动的必然是当前源码现生成的那一份；单跑一个测试文件才需要自己先 `pnpm run build`。

六条发现的最终归属：

| 发现 | 现在 |
|---|---|
| §2.1 宿主侧门限是第二份实现 | ✅ 重复已消除：`src/shared/gate.js` 一份，两端各自注入常数 |
| §2.2 UI 动作协议两份代码 | ✅ 重复已消除：`src/shared/ui-action-protocol.js` 一份 |
| §2.3 两个大文件难导航 | 🔶 客户端拆完（627 行）；宿主 `index.js` 未动 |
| §2.4 模型目录 / 热键 helper 内聚 | ⏭ 仍未拆（`model-catalog.js` 1013 行、`global-hotkey-helper.js` 725 行） |
| §2.5 高亮 / 段落切分 | ✅ 维持「本来就对，无需动作」 |
| §2.6 `turn-model.js` 耦合宿主 | ✅ 维持「边界合理，无需动作」（271 行） |

此外本文 §3 与 §6 里那些「验收：`node scripts/bundle-client.mjs --check` 通过」
「`bundle-sync` 的纯文件名单从 `@bundle` 标记派生」之类的口径**已作废**，
现在的等价命令是 `pnpm run check:build`。

> **进度（2026-11-02，渐进性收敛）**：
> - ✅ **P0-1 已落地**：宿主侧门限状态机抽到 `lib/gate.js`（不再内联在 `index.js`）。
> - 🔶 **P0-2 已收敛到约束上限**：UI 动作协议双端行为差异已消除；单源合并被
>   「`lib/` 自包含 + 浏览器单文件」两条硬约束挡住，维持「宿主一份 + 浏览器一份 +
>   共享用例表锁行为」。
> - ⏭ **P1 / P2 待续**：客户端纯数据抽取、model-catalog / global-hotkey-helper 内聚拆分。
>
> **进度（2026-11-02 第二轮，见 §6）**：
> - ✅ 原 **P1 已落地**：`src/client/pure/i18n.js`（408 行 `zh`/`en`）+ `main.js:211` 的
>   `@bundle pure/i18n.js` 标记。
> - 🔧 本文的**行号基线已过期**：`main.js` 6389 → **7225**、`lib/index.js` 3293 → **4026**、
>   `model-catalog.js` 755 → 934、`global-hotkey-helper.js` 632 → 744。
> - ❗ §2.3 的前提被实测推翻：客户端「胶水难拆」不适用于 `main.js:535–1363`，
>   那 830 行已是零浏览器全局的纯代码（见 §6.1）。
> - ⏭ 新增四条：配置词表横断校验缺失（§6.2，建议优先）、宿主识别引擎未抽（§6.3）、
>   `apply()` 内 22 条路由内联（§6.4）、`SOVITS_LANGUAGES` 同包内两处定义（§6.5）。
>
> **进度（2026-11-02 第三轮，开工落地）**：
> - ✅ **§6.1 已落地**：`main.js` 7225 → **6452 行**。抽出
>   `src/client/pure/config-normalize.js`（444 行）与
>   `src/client/pure/reading-highlight.js`（411 行）。
>   `createReadingHighlight` 对 `pure/highlight.js` 的三处引用**改成显式注入参数**，
>   按「引用只能从 `main.js` 指向 `pure/`，不能反向」执行。
> - ✅ **§6.2 已落地**：`test/config-contract.test.mjs`（231 行，50 绿），已登记进 `npm test`（49 个测试）。
> - ✅ **§6.5 已落地**：`lib/sovits-tts.js` 复用 `config-schema.js` 的 `SOVITS_LANGUAGES`。
> - ➕ **超出原计划的一条**：`bundle-sync` 的纯文件名单**从 `@bundle` 标记派生**（不再硬编码，
>   漏登记不再静默跳过），并新增「纯文件不得反向引用 `main.js` 顶层符号」守卫（变异验证过能拦）。
> - 🐞 **横断言当场抓到一个真实缺陷**：客户端不收敛 `sovitsUrl` 长度，超长地址会原样
>   `POST /config` 被宿主 400 打回（用户只看到「保存失败」）。已按宿主 maxLen 2048 截断
>   （新增 `truncateTo`：只截长度、不校验格式、不把空串变成默认值）。
> - 📌 **记为有意差异**：`ttsEngine` 枚举两端**顺序**不同（宿主 `online/local/neural/sovits`
>   vs 客户端 `online/neural/local/sovits`）。宿主顺序只进错误文案 `join(' / ')`，
>   客户端顺序是下拉展示顺序（注释自述「顺序与设置面板一致」），所以不断言相等、只提示。
> - ⏭ §6.3（`lib/asr-engine.js`）/ §6.4（路由工厂）**未动**。
>
> **进度（2026-11-02 第四轮，结论让位给新文档）**：见
> [`docs/architecture-modernization.md`](./architecture-modernization.md)。
> 那一轮把宿主 asar 拆开核对了模块系统的真实实现，本文 §4 的两条「不做」被证据改写：
> ① **「不引入打包器」不是宿主约束，是本文的自我豁免** —— 宿主只锁「产物一个文件 +
> factory 的 require 只认包名」，官方插件文档反而写着「编译型源码请用你们的 Client 构建工具」；
> ② §2.2 / §3 P0-2 里「单源合并被两条硬约束挡住」的说法**只对了一半** ——
> 挡住它的是 `scripts/bundle-client.mjs` 的正则内联，不是文件位置。
> 所以 §6.7 的路线（继续外提文件）不再是主线，主线换成「先换打包器，再判据单源化」。
>
> **进度（2026-11-02 第五轮，换打包器已落地）**：`scripts/build-client.mjs`（esbuild）
> 取代了 `scripts/bundle-client.mjs`，本文里所有提到旧脚本的段落**只作历史记录**，
> 命令请用 `npm run build:client` / `npm run check:client`。落地细节与实测数字见
> [`architecture-modernization.md` §8.7](./architecture-modernization.md)。
>
> **进度（2026-11-02 第六轮，门限、UI 动作协议、配置全部单源化）**：本文 §1.2 / §2.1 / §2.2 / §6.2 里
> 「宿主一份 + 客户端镜像一份」「两端由同一张用例表锁行为」的描述**只作历史记录** ——
> 门限与 UI 动作协议的实现已收进 `src/shared/`，配置枚举词表住在 `src/shared/config-vocab.js`，
> 配置字段规则住在 `src/shared/config-spec.js`（宿主的 `DEFAULTS`、客户端的
> `UI_DEFAULTS`/`STRING_LIMITS`/夹取区间都由它派生），`lib/*.js` 与 `src/client/pure/*.js`
> 这些入口只做转发/常数注入。M4 的三处双实现至此清零。
> 落地细节见 [`architecture-modernization.md` §8.8–§8.11](./architecture-modernization.md) 与其 §5 第 3 步。
>
> **进度（2026-11-02 第七轮，`main.js` 开始按职责拆文件）**：本文里所有「浏览器巨石多少行」的取证
> 是**拆分前**的快照，只作历史记录。现状是：`src/client/main.js` 6334 行，
> a11y 的 DOM 执行层已外提成 `src/client/dom/a11y-bridge.js`（有状态、环境注入、可 Node 直测）。
> 新目录的分工规矩见 [`docs/maintainer-notes.md` 第 2 节](./maintainer-notes.md)「从 `main.js` 往外拆代码的规矩」；
> 落地记录见 [`architecture-modernization.md` §8.12](./architecture-modernization.md)。
>
> **进度（2026-11-02 第八轮，播放核心也出去了）**：`src/client/dom/playback-core.js`（196 行）
> 接管了「文本 → 音频 URL、常驻播放上下文、首次手势预热，以及那 7 个给诊断看的状态」，
> `main.js` 6334 → **6230 行**。这一轮顺带把三条**扫源码**的断言换成了运行时断言
> （调试快照字段、播放上下文取用位置、客户端路由识别），并在
> `test/client-behavior.test.mjs` 加了「引擎静默回退」场景 —— 契约关心的是界面真报给了用户，
> 不是变量叫什么名字。落地记录见 [`architecture-modernization.md` §8.13](./architecture-modernization.md)。
>
> **进度（2026-11-02 第九轮，快捷键整套判据出去了）**：`src/client/pure/shortcut.js`（141 行）
> 接管了「格式校验、按键匹配、macOS 别名，以及『面板正在录键』那份状态（工厂 + 注入）」，
> `main.js` 6230 → **6171 行**，顶层 `let` 从 5 个降到 3 个。这一轮把第四条扫源码断言
> （`/shortcutFieldFocused = false }, []/`）换成了真产物场景：`client-behavior` 现在能
> **卸载组件**（跑掉 effect cleanup）并**派发 keydown**，三段断言分别证明「监听确实装着」
> 「onFocus 确实接在状态上」「卸载确实复位」，另加浮层那条监听用的是 `anyFocused()` 而不是
> `isFocused()` —— 这个区别此前**没有任何测试能区分**。搬家还查出三条快捷键遗留缺陷
> （别名写法静默失效、`Space` 永不匹配、两条不可达分支），本轮只钉现状、未改行为。
> 落地记录见 [`architecture-modernization.md` §8.14](./architecture-modernization.md)。
>
> **进度（2026-11-02 第十轮，第一次改浏览器侧行为：修饰键词表单源化）**：第九轮钉住的那三条
> 缺陷在这一轮处理掉了。新增 `src/shared/key-modifiers.js`（53 行：11 个别名 → 四个规范名），
> 快捷键校验、快捷键匹配、a11y 主动派发三条链路从此查同一张表 —— 判据是
> **「校验放行的写法，匹配层必须认」**，以前它靠「记得同步改两处」维持，现在由构造保证。
> 于是 `Control+Alt+V`、`Cmd+V`、`Win+V` 这些写得进设置、按下去没反应的写法真的能用了，
> `Alt+Space` 也是；顺带删掉两条不可达的校验分支。`main.js` 行数没动（改的是判据不是搬家），
> 产物 6681 行 / 268 KB。宿主原生 helper 那张「别名 → 位掩码」表本轮**没并进来**（值的形状不同），
> 分歧与剩下的主键词表问题写在 §8.15 末尾。落地记录见
> [`architecture-modernization.md` §8.15](./architecture-modernization.md)。
>
> **进度（2026-11-02 第十一轮，采集侧的数值判据出去了）**：`src/client/pure/resample.js`（86 行）
> 接管了「拼 chunks、拿不到采样率怎么办、线性重采样到 16k」，`main.js` 6171 → **6149 行**。
> 这一刀切出来的东西很直白：实现原本只有一份，但**取采样率那一步手写了三遍、拼 chunks 手写了三遍**，
> 而三遍兜底互不相同 —— 两处 `?? 16000` 只挡 `undefined`，拿到 0 或 `NaN` 会算出
> `Infinity` 个采样并抛 `RangeError`（变异检查真跑出了那行报错）。现在 16k 这个数字在
> `main.js` 里从出现 7 次降到 0 次，全部问同一个契约常量。新增 `test/resample.test.mjs`（29 条）。
> 落地记录见 [`architecture-modernization.md` §8.16](./architecture-modernization.md)。
>
> **进度（2026-11-02 第十二轮，开麦的设备层出去了）**：`src/client/dom/mic-device.js`（140 行）
> 接管了「这台机器能不能录、开麦约束、拿到流不等于有声音、取 AudioContext、释放轨道、关上下文」。
> 普查数字：`main.js` 里 `await navigator.mediaDevices.getUserMedia(` 2 处、逐字相同的约束字面量 2 处、
> `window.AudioContext || webkitAudioContext` 2 处、手写 `getTracks().forEach(stop)` 5 处 —— 全降到 0。
> 两份抄本**不等价**，缺的那两条各是一个真缺陷，所以这一轮带了 2 处行为变更（都在 composer：
> 拿不到 `AudioContext` 时以前抛 `TypeError` 卡死在「准备中」，现在提示失败并释放麦克风；
> 「没有录音设备」那条分支以前漏复位「正在开麦」）。`main.js` 6149 → **6182 行**：
> 这是 campaign 里第一次行数往回走，因为换掉五处手抄的同时补了两条失败分支 ——
> 衡量它的应该是「同一个判据只剩一份」而不是行数。
> 测试这一轮补得最多：`getUserMedia` 此前**零运行时覆盖**，现在 `test/client-behavior.test.mjs`
> 有了假录音设备（六种模式）与假音频图，开麦场景 25 条；`test/listening-ready.test.mjs` 那四条
> 按行号和变量名扫源码的断言换成了它们（25 → 21 条）。新增 `test/mic-device.test.mjs`（38 条）。
> 落地记录见 [`architecture-modernization.md` §8.17](./architecture-modernization.md)。
>
> **进度（2026-11-02 第十三轮，快捷键的第三条链路也归并了）**：
> `lib/global-hotkey-helper.js` 那张 11 条的「写法 → Win32 位」手抄表改成从
> `src/shared/key-modifiers.js` 现取派生，helper 只留「规范名 → 位」这一层宿主知识
> （`MOD_*` 是 `RegisterHotKey` 的知识，写法名单不是）。
> **这一轮没修任何用户现在遇到的问题**：动手前我认定那张手抄表漏了 `control` 写法，
> 实测（`git show HEAD:lib/global-hotkey-helper.js`）发现它 11 条一字不差、`control` 本来就在。
> 所以它的价值是构造性的 —— 以后往 shared 加一种写法而忘了动 helper，表现会是
> 「窗口里按得出、切到别的应用按不动」，而三处代码看起来都没错；现在
> `test/global-hotkey-helper.test.mjs` 逐字比两端的写法集合，加上「位挪了 / 位撞了」两条，
> 五条变异全部当场变红。`bundle-sync` 新增一条标记，把「位掩码表被抄去别处」也堵上。
> **行为变更：0 处**。落地记录见 [`architecture-modernization.md` §8.18](./architecture-modernization.md)。
>
> **进度（2026-11-02 第十四轮，主键词表也只剩一份了）**：`src/shared/key-names.js`（125 行）
> 接管了「这一串字是哪个键」——一条写法并排给三个环境的值（`KeyboardEvent.key` 真值 /
> uiohook 键名 / Win32 虚拟键码）。搬掉的是三张手抄表共 **66 条**：a11y 的 `NAMED_KEYS` 20 条、
> 宿主 helper 的 `VK_BY_KEY` 23 条 + `NATIVE_KEY_NAMES` 23 条，外加两处现场特判
> （`main.js` 的 `parsed.key === 'Space' ? ' '`、`shortcut.js` 的 `key === 'space' ? ' '`）。
> 逐字比过 HEAD 那三份：取值只有 **1 条**不同（a11y 把空格写成 `'Space'`，DOM 规范里它是个空格字符），
> 覆盖范围倒有一处真分叉（helper 认 `return`/`insert`/`ins`，a11y 不认）。
> **这一轮查出一条真缺陷，方向和我上一轮的预想相反**：`matchesShortcut` 以前只特判空格，
> 于是配置里凡「写法 ≠ DOM 真值」的主键都**窗口内永远按不动、系统级却按得动** ——
> `Ctrl+Up` 存得下、按下去 `event.key` 是 `ArrowUp` 而比较用的还是 `up`。
> 完整名单 8 种（`return`/`esc`/`del`/`ins`/`up`/`down`/`left`/`right`），现在全部命中；
> 顺带 a11y 派发空格改用规范真值 `' '`（页面代码本来就不认 `'Space'`）。
> 「哪些键允许打进页面」这条**策略**留在 a11y 自己手里，名单一条没扩大：`Insert`/`Return`
> 在词表里但照旧被拒（测试四条专门钉这个）。`main.js` 6182 → **6184 行**（+2 是注释），
> helper 781 → **705 行**（−76）。新增 `test/key-names.test.mjs`（125 条，含三条链路的取值互比）；
> 变异六条里最小说明的一条：M3（认不出返回 0）只让 `key-names` 红、helper 测试仍绿，
> 因为 helper 还有 `uiohookKeyOf` 空串那道独立闸。落地记录见
> [`architecture-modernization.md` §8.19](./architecture-modernization.md)。

---

## 1. 现状概览（证据）

### 1.1 职责分层

> 这张表原来写的是 2026-11-02 的位置（宿主代码还住在 `lib/`、`main.js` 6184 行）。
> 下面按 2026-11-06 的仓库重画，职责一栏基本没变，变的全是**位置**与**个数**。

| 层 | 位置 | 职责 |
|---|---|---|
| 宿主集成（Node） | `src/host/index.js`（手写 4176 行 → 产物 `lib/index.js` 6815 行） | HTTP 路由、配置读写、模型管理、朗读调度挂载、`llm/stream` 钩子 |
| 宿主子模块 | `src/host/*.js`（26 个文件，除 `index.js` 外 25 个） | 各 TTS 引擎、识别 worker、调度器、段落/围栏、协议入口、热键 helper、诊断 |
| 浏览器集成 | `src/client/main.js`（**627 行**） | 只剩「拿 React、注入环境、把各工厂接起来、声明路由与设置面板结构」 |
| 浏览器 DOM 胶水 | `src/client/dom/*.js`（**9 个**） | 碰浏览器环境、有状态的胶水：麦克风按钮、全局语音浮层、设置面板分区、a11y 执行层、播放核心、开麦设备层、配置读写、会话上下文、客户端 id。环境一律由参数注入，所以能原生 import 单测 |
| 浏览器纯逻辑 | `src/client/pure/*.js`（**24 个**） | 门限/草稿/信封/积压/高亮/全局语音/UI 协议/a11y/i18n/配置归一化/快捷键/重采样/路由表 + 各份「原因码 → 界面那句话」字典 |
| **双端单源判据** | `src/shared/*.js`（**11 个**：门限状态机、UI 动作协议、配置枚举词表、配置字段规则、配置错误码、修饰键词表、具名键词表、就绪原因码、热键原因码、下载原因码、合成环境原因码） | 两端共用同一份实现：宿主直接 `import`，浏览器侧经 `pure/*` 由构建合进产物。常数需要不同的用 `createXxx(defaults)` 注入；两端必须一样的（配置规则、动作白名单、修饰键别名、主键写法、原因码）就直接放 shared，入口只做转发或派生。**码在 shared，句子在客户端字典** —— 宿主只回码 |
| 构建 | `scripts/build-client.mjs` + `scripts/build-host.mjs` | esbuild 沿 import 图把两端各自合成**单文件产物**（`lib/client.js`、`lib/index.js`），客户端那份再包成 `__ModuleLoader__.load` 形态（浏览器模块只能 require 包名）。产物不入库 |
| 测试 | `test/*.test.mjs`（**76 个**，`pnpm test` 先构建再串跑其中 75 个，`silence.test.mjs` 走 `pnpm run test:silence`） | 纯函数原生 import、行为回归用真实产物、宿主接线、文档与路由清单核对 |

### 1.2 关键设计（已被验证是对的）

- **纯函数与 DOM/React 分离**：`pure/*` 不依赖浏览器 API、不依赖 React，
  Node 测试可原生 `import`，不需要「从大文件里提取源码再求值」。
  这一条后来被推广到了 `dom/*`：有状态也没关系，环境从参数进来就能测。
- **宿主/客户端协议单源**：`ui-action-protocol` 的真源在 `src/shared/`，两端入口只做转发。
  第六轮之前是「宿主一份 + 客户端镜像一份 + 同一张用例表逐条比对两端返回值」；
  今天那张表还在，但比对换成了**用例覆盖度**与**导出面 + 绑定同一性**
  （转发少写一个名字、或某侧还留一份拷贝，都会红）。
- **构建产物同步校验**：`bundle-sync.test.mjs` 断言产物与 `src/` 一致，
  且校验幂等、每个判据在产物里恰好定义一次、纯模块在裸 Node 里 import 得动。
  两端产物都查（`check:build`），且 `pnpm test` 会先构建再跑。
- **流控式朗读**：`read-aloud-scheduler` 按客户端 ack 播放进度补发，而非固定窗口。
- **配置 schema**：规则单源在 `src/shared/config-spec.js`（35 个键），
  宿主侧 POST 严格校验、GET 尽力清洗，客户端的默认值/长度上限/夹取区间由同一份派生。
- **状态复位单一职责**：定时器登记表按 group 清理，`stopListening`/`stopPlayback` 各管一摊。

基线健康（当天数值以运行输出为准）：`node test/bundle-sync.test.mjs` 全绿。

---

## 2. 发现的问题（按收益排序）

### 2.1 【高】宿主侧门限状态机是 `pure/gate.js` 的**第二份实现**，且内联在大文件里

> **状态**：✅ 重复已**消除**（不只是「锁住」）。第一轮先把宿主的内联实现抽成独立文件
> （当时叫 `lib/gate.js`，今天的路径是 `src/host/gate.js`），第六轮再把真源收进
> `src/shared/gate.js`：`createGate(defaults)` 工厂，两端各自注入自己的门限常数。
> 现在两端共用同一份算法，下面「可选优化」里那句「更彻底的方案」就是它最终走的路。

**现状证据**

- 宿主侧 `lib/index.js:498 export function advanceGate(...)` —— 一份**完整独立的实现**，
  还带一个内部 `stepGate`（`index.js:516`）。
- 浏览器侧 `src/client/pure/gate.js:29 export function advanceGate(...)` —— 另一份独立实现。
- 两份由 `test/fixtures/gate-cases.mjs` 驱动，确保行为一致（当时的维护者须知允许这种「两份」，
  见 [`docs/maintainer-notes.md` 第 1 节](./maintainer-notes.md)）。

**问题**

- 这是「同一判据两处实现」，只是被用例表**约束住**了，不是被**消除**了。
  维护者须知里写的后果很具体：分叉过的那一次，宿主把低音量帧挡在解码器外，
  流式只认出「你好明天天怎」，整段却能认出「你好，今天天气怎么样？」。
- 宿主这份**内联在 3.3k 行的 `index.js` 里**，与 20 多个子模块的边界被打破——
  它是纯函数，本该进 `lib/` 的独立文件，方便单测与复用。

**可选优化**

- 把 `lib/index.js` 的 `advanceGate` / `stepGate` / `DEFAULT_GATE_OPTS` 抽到
  `lib/gate.js`（纯函数，无 dsh 依赖），`index.js` 只 `import`。
- 更进一步：既然 `pure/gate.js` 已经是无浏览器依赖的纯函数，宿主侧**直接复用同一份**
  会更彻底——但要注意 `pure/` 的导出走 ESM `export`，宿主是 ESM，理论上可以
  `import { advanceGate } from '../src/client/pure/gate.js'`。
  这需要确认 `lib/client.js` 的构建产物**不依赖**宿主 import 源文件（它内联的是
  源文本，不是 require），且 `bundle-sync` 的「纯函数无浏览器全局」检查依然成立。
  **如果引入会破坏「产物与源码分离」的约束，就退回到「独立 `lib/gate.js`」方案。**
  无论如何，`test/fixtures/gate-cases.mjs` 这张用例表保留，作为两处（或一处）的回归。

**建议优先级**：**高**。它直接命中维护者须知反复强调的「同一判据只能有一处实现」
（[`docs/maintainer-notes.md` 第 1 节](./maintainer-notes.md)），
且让宿主侧纯函数回到它该在的层。

### 2.2 【高】UI 动作协议双端镜像，本质是「一份协议、两份代码」

> **状态**：✅ 重复已**消除**（2026-11-02 第六轮）。第一轮那一次只做到「双端行为差异为零、
> 实现仍是两份」，当时判断单源被两条硬约束挡住；第四轮拆开宿主 asar 核对后确认
> 挡路的其实是旧构建脚本的正则内联，不是文件位置。换成 esbuild 之后真源收进
> `src/shared/ui-action-protocol.js`，`src/host/ui-action-protocol.js` 与
> `src/client/pure/ui-action-protocol.js` 都只做转发。下面这段「无法合并」的论证**只作历史记录**。

**现状证据**

- 宿主 `lib/ui-action-protocol.js`（257 行）与客户端 `src/client/pure/ui-action-protocol.js`（294 行）
  是**逐条同构**的两份代码，靠同一张用例表（`test/ui-action-protocol.test.mjs`）锁行为。
- 当时的代码结构一节承认这是不得已（浏览器侧的模块只能 require 包名），
  见 [`docs/reference.md` 第 6 节](./reference.md)。

**问题**

- 协议会随 `voice_ui` 工具演进（v1 8 个动作 → v2 14 个）。每次加动作/改参数，
  **两处都要同步改**。用例表只能防「改完分叉」，防不了「忘了同步改其中一处导致
  编译期不同步、运行期才暴露」。
- 这份协议是**纯数据/纯函数**，理论上可以被构建脚本**生成**，而不是手抄。

**可选优化**

- 把协议**定义**收敛到一份（例如 `src/client/pure/ui-action-protocol.js` 为真源），
  宿主侧 `lib/ui-action-protocol.js` 改为**从同一份源生成或 import**。
  由于宿主是 ESM、`pure/` 也是 ESM 且无浏览器依赖，宿主可以 `import` 它；
  构建脚本再把同一份源内联进 `lib/client.js`。
  **约束**：不能破坏 `bundle-sync` 的「纯函数无浏览器全局」检查，也不能让
  `lib/client.js` 出现对宿主文件的 `require`。
- 更轻的方案：把「动作枚举 + 参数白名单 + 长度上限 + 确认策略」从两份代码里
  抽成一份**共享的纯数据**，宿主与客户端各自只留「读取这份数据」的薄封装。
  这样数据真源只有一份，行为差异被压缩到最小。

**建议优先级**：**高**。与 2.1 同源：都是「文档承认的重复，靠测试锁住而不是消除」。

### 2.3 【中】两个大文件内部导航成本高

> **状态**：🔶 客户端这一半**做完了**，宿主这一半没动。
> `src/client/main.js` 6389 → **627 行**（第七～十四轮按职责外提成 `src/client/dom/` 9 个 +
> `src/client/pure/` 24 个）；宿主侧 `src/host/index.js` 仍是手写 4176 行的单文件，
> 对应的两条待办就是 §6.3（识别引擎外提）与 §6.4（路由按组做工厂），**至今未做**。
>
> **本节那条「胶水拆不动」的前提已作废**：挡住拆分的是旧脚本的 `@bundle` 正则内联，
> 不是浏览器模块系统。换成 esbuild 之后产物按 import 图合成，跨文件 import 就是拆分手段本身
> （`dom/` 引 `pure/`，两边都引 `src/shared/`；反向仍然禁止 —— `pure/` 不引 `dom/`）。
> 仍然成立的只有一条：
> **产物必须是单文件 `lib/client.js`**，因为宿主是按一个文件路径加载浏览器模块的。

**现状证据**

- `src/client/main.js` 6389 行、约 103 个顶层 `function/const`，平均约 62 行/个。
- `lib/index.js` 3293 行、约 54 个顶层声明，平均约 61 行/个。
- 相比之下 `read-aloud-scheduler.js`（744 行，28 个）平均 26.6 行/个，结构更细。

**问题**

- 不是「文件太大」本身，而是**单个文件内职责过密**、没有子章节边界。
  例如 `main.js` 里麦克风按钮、VAD 采集、播放队列、设置面板 React 组件、
  全局语音浮层、a11y 执行器**全在一个文件**，改一处要滚动几千行才能看清全局。
- 已抽出的 `pure/*` 证明「可拆」；但**胶水层（DOM/React 依赖的部分）仍是巨石**。

**可选优化**

- 按**职责**把 `main.js` 拆成几个模块级文件，通过构建脚本**内联**（复用现有
  `bundle-client.mjs` 的 `@bundle` 机制，只是源文件从「纯函数」扩展到「胶水片段」）。
  这是**无运行期成本**的拆分：产物 `lib/client.js` 仍是一个文件，行为不变，
  只是源码可导航。
  - 候选拆分：`mic.js`（麦克风/VAD/草稿）、`playback.js`（播放队列/高亮）、
    `settings.js`（设置面板 React）、`global-voice-ui.js`（浮层 + a11y 执行器）、
    `i18n.js`（`zh`/`en` 文案，`main.js:212` 与 `main.js:411` 起，纯数据）。
  - **约束**：这些片段同样不能 import 本地文件（浏览器 require 只能解析包名），
    所以拆出来必须能**整体内联**且不产生跨片段 import —— 要么各自自包含，
    要么把共享符号也内联。**这正是当前 `pure/*` 能拆、而 `main.js` 胶水难拆的原因**：
    `pure/*` 之间不互相 import（靠主文件传参），胶水片段之间**有**依赖。
  - 所以**务实的做法**是：先只拆**无依赖的纯数据**（`zh`/`en` 文案、`DEFAULT_CONFIG`、
    常量表），这些可以像 `pure/*` 一样无副作用内联；React 组件与有状态胶水保持
    在原文件，等真正需要时再做「提取接口」级的重构。

**建议优先级**：**中**。收益是「可导航性/可维护性」，不是运行性能；且胶水层拆分
受浏览器模块限制，**必须保留单文件产物**，否则 `bundle-sync` 与产物注入都会破。

### 2.4 【中】模型目录与热键 helper 也有内聚问题

> **状态**：⏭ **仍未拆**（2026-11-06 复核）。两个文件只是搬家和瘦身：
> `src/host/model-catalog.js` 1013 行、`src/host/global-hotkey-helper.js` 725 行
> （第十四轮从两张手抄键名表里删掉了 46 条，744 → 725）。
> 判据沿用 §6.6：不阻塞当前迭代就不做。

**现状证据**

- `lib/model-catalog.js` 755 行 / 8 个顶层声明，平均约 94 行/个（最粗粒度）。
- `lib/global-hotkey-helper.js` 632 行 / 16 个，平均约 39.5 行/个。

**问题**

- `model-catalog.js` 的「档位定义 + 分片下载 + 缓存 + SHA256 校验」混在一个文件，
  平均 94 行/个说明有超大函数。它不是 dsh 耦合（TouchesDsh=False），
  抽「档位数据」与「下载器」两个模块会很顺。
- `global-hotkey-helper.js` 里 Windows PowerShell 子进程路径与 macOS/Linux native
  路径在同一文件，平台分支混在一起；维护者须知的「平台矩阵与可选依赖」一条已经写得很清楚
  （[`docs/maintainer-notes.md` 第 1 节](./maintainer-notes.md)），
  但实现仍是单文件多分支。

**可选优化**

- `model-catalog.js` → `model-catalog-data.js`（纯档位定义 + 下载 URL）+
  `model-downloader.js`（进度/校验/缓存）。纯数据部分可直接单测。
- `global-hotkey-helper.js` → `hotkey-windows.js` / `hotkey-native.js`（工厂注入），
  主文件只做开关决策与状态机。

**建议优先级**：**中**。纯属内聚拆分，无行为变化，风险低。

### 2.5 【低】宿主与客户端「共享判据」的第三处：高亮/段落切分已各归其位

**现状证据**

- `lib/paragraph.js`（76 行，纯函数）、`lib/fence-filter.js`（176 行，纯函数）、
  `lib/speech-clean.js`（97 行，纯函数）在宿主侧。
  2026-11-06 复核：这三份现在是 `src/host/` 下的 95 / 219 / 137 行，结论不变。
- `src/client/pure/highlight.js` 在浏览器侧，做的是**不同**的事（把纯文本对齐到 DOM），
  不重复宿主逻辑。

**结论**

- 这一块**没有**重复实现问题：宿主负责「切句/围栏/清洗」，客户端负责「高亮定位」，
  边界清晰。**不需要**优化，列出来只是说明「哪些已经是对的」。

**建议优先级**：**低（无需动作）**。

### 2.6 【低】`turn-model.js` 是唯一 TouchesDsh=True 的子模块

**现状证据**

- `lib/turn-model.js`（196 行，现在 `src/host/turn-model.js` 271 行）是唯一带 dsh/cordis 耦合的
  子模块（`createTurnModel` 拿 `getSessionsService`），当时其余 19 个、现在其余 25 个
  子模块都是纯/独立（`grep -l "scope\.webServer" src/host/*.js` 只命中 `index.js`）。
- 它是**有意**的：回合判定要读 `llm/stream` 请求里的 `options.messages`，且必须容忍
  消息延迟写入（见 [`docs/maintainer-notes.md` 第 1 节](./maintainer-notes.md)）。
  这种耦合合理，不需要拆。

**结论**

- **不需要**优化。它是正确的边界：回合模型依赖会话服务，但**不**依赖 HTTP 路由、
  配置或 TTS。

**建议优先级**：**低（无需动作）**。

---

## 3. 建议路线（按优先级）

### P0 —— 消除宿主侧门限重复实现（2.1）✅ 已落地（2026-11-02）

> **2026-11-06 补充**：这一条只做到「宿主那份从 `index.js` 里搬出来」，两处实现还在。
> 第六轮才真正消除：算法住在 `src/shared/gate.js`，`src/host/gate.js` 与
> `src/client/pure/gate.js` 各自只注入自己的常数。
> 下面那段「宿主/浏览器两份、由用例表锁住」的描述**是当时的状态**。

已把 `lib/index.js` 的 `advanceGate`/`stepGate`/`DEFAULT_GATE_OPTS`/`STREAM_SILENT_FRAMES_TO_END`
抽到 **`lib/gate.js`**（宿主纯函数），`lib/index.js` 改为 `import` + re-export。
宿主侧与浏览器侧仍是**同一套算法、不同的门限常数**，由 `test/fixtures/gate-cases.mjs`
同一张用例表驱动（这是**有意**的设计：宿主 clamp 0.01/0.045，浏览器 clamp 0.008/0.035）。

**验证**：`test/gate-host.test.mjs` 41 绿、`test/gate-client.test.mjs` 25 绿、
`test/bundle-sync.test.mjs` 48 绿、`npm test` 全绿。

### P0 —— 收敛 UI 动作协议真源（2.2）✅ 已单源化（第六轮，2026-11-02）

> **这一节的论证已被推翻**。下面「受两条硬约束限制，无法合并成一份文件」是当时的判断，
> 判断依据错了：第二条（浏览器 require 只能解析包名）挡住的是**旧构建脚本**，
> 换成 esbuild 之后按 import 图合成，单源不再有障碍；
> 第一条（`lib/` 自包含）本来就不成立 —— `lib/` 现在只是产物目录，手写代码全在 `src/`。
> 真源今天住在 `src/shared/ui-action-protocol.js`。这段论证留着，是因为它记录了
> 「为什么当时会误判」，这正是这个仓库反复付学费的那类教训。

**真源收敛受两条硬约束限制，无法合并成一份文件**：
1. `lib/` 必须**自包含**（只依赖 `lib/*.js`）—— `test/tts-online-fallback.test.mjs`
   会把 `lib/` 整体复制到临时目录再跑，`lib/` 若引用 `src/` 会 `ERR_MODULE_NOT_FOUND`；
2. 浏览器 bundle 必须是**单文件** `lib/client.js`，由 `scripts/bundle-client.mjs`
   内联 `src/client/pure/*` 源码（浏览器 require 只能解析包名，不能 import 本地文件）。

所以「宿主一份 + 浏览器一份 + 共享用例表锁行为」是给定约束下的**务实最优**，
强行单源（把真源放 `lib/` 再让 bundler 内联）会改动 bundler、删除纯函数文件、
改动 3 个测试 —— 超出「渐进」范围。

**本次已做的收敛**（无行为变化的风险增量）：
- 修正了双端唯一行为差异：`buildUiActionPayload` 对非有限 `expiresAt` 统一改为
  **省略键**。原来客户端留 `expiresAt: undefined` 作自有属性（`'expiresAt' in payload`
  为 true），宿主是条件赋值（省略键，`in` 为 false），`voice-ui-host.test.mjs` 断言的是
  宿主行为。现在客户端与宿主行为**完全一致**。
- 双端由 `test/ui-action-protocol.test.mjs` 的同一张用例表锁行为（104 绿）。

**验证**：`test/ui-action-protocol.test.mjs` 104 绿、`test/voice-ui-host.test.mjs` 254 绿、
`test/bundle-sync.test.mjs` 48 绿、`test/tts-online-fallback.test.mjs` 10 绿。

### P1 —— 拆纯数据胶水（2.3 的务实子集）

> **2026-11-06 补充**：这一条做完了，而且**远超当时的边界**。文案确实进了
> `src/client/pure/i18n.js`（现在 1019 行）；但「不拆 React 组件与有状态胶水」这句
> 在第七～十四轮被逐条推翻 —— `src/client/dom/` 那 9 个文件就是有状态胶水
> （`mic-button.js` 2344 行、`global-voice-overlay.js` 1704 行、`a11y-bridge.js` 等），
> 拦着它们的 `@bundle` 机制本身也已退役。
> 现在 `main.js` 只剩 627 行。验收命令是 `pnpm run check:build`。

把 `main.js` 里的 `zh`/`en` 文案（`main.js:212` 与 `main.js:411` 起的对象字面量）、
`DEFAULT_CONFIG`、常量表抽成 `src/client/pure/i18n.js` / `src/client/pure/constants.js`，
用现有 `@bundle` 机制内联。
**不拆 React 组件与有状态胶水**（受浏览器模块限制，需单文件产物）。

**验收**：`node scripts/bundle-client.mjs --check` 通过；`bundle-sync.test.mjs` 绿。

### P2 —— 内聚拆分（2.4）

`model-catalog.js` 拆数据/下载器；`global-hotkey-helper.js` 拆 Windows/native 工厂。
纯行为拆分，风险低，可在有空时做。

> **2026-11-06**：⏭ 仍未做，与 §2.4 的状态一致。

---

## 4. 明确不做的（避免过度设计）

- **不引入构建框架/打包器**：现状是零依赖的 `scripts/bundle-client.mjs`，够用且可测。
  换成 Rollup/Vite 会引入对 `bundle-sync`（`--check` 只算不写盘）的破坏。
  > **2026-11-02 第四轮撤回这条豁免**：拆过宿主 asar 后确认「单文件产物」才是宿主约束，
  > 「用正则内联」是我们自己的选择；官方插件文档写的是「compiled sources 请用 Client 构建工具」。
  > 详见 [`docs/architecture-modernization.md`](./architecture-modernization.md) §2。
  > **第五轮已按新判断执行**：构建脚本换成 `scripts/build-client.mjs` + `scripts/build-host.mjs`
  > （esbuild），这条「不做」作废。
- **不把 `lib/client.js` 产物拆成多文件**：浏览器模块不能 require 本地相对路径，
  单文件产物是**有意设计**（见 [`docs/reference.md` 第 6 节](./reference.md)），拆开会导致注入失败。
  ✅ 这一条**仍然成立**，而且和上一条不冲突：拆的是**源码**，产物照旧一个文件。
- **不重写 `main.js` 为「每个组件一个文件」**：React 组件在 `main.js` 内是模块级定义
  （[`docs/maintainer-notes.md` 第 1 节](./maintainer-notes.md)的硬规则），
  强行拆分跨文件会触发「组件类型变化 → 卸载重建 → 输入框失焦」。
  > **这条要说清楚边界**（当时那句话容易被读成「组件不能出 `main.js`」，那是误读）：
  > 真正的禁令是**别让组件类型在两次渲染之间变掉** —— 组件定义写在另一个组件的函数体里、
  > 或者每次渲染都调一次工厂，都会导致卸载重建、输入框失焦。
  > 把组件工厂放到别的文件、在 `main.js` 的 `buildClientModule()` 里**调用一次**，
  > 身份照样稳定 —— 第七～十四轮把 `main.js` 从 6389 行降到 627 行走的就是这条路
  > （`createMicButton` / `createGlobalVoiceOverlay` / `createVoiceSettingsSection`）。
- **不引入 DI 容器**：宿主侧已经用「工厂 + 注入 emit/nextIndex」做依赖注入，
  足够；再加容器是过度设计。 ✅ 仍然成立（`createGate` / `createTurnModel` /
  `createReadingHighlight` 这些都是工厂 + 显式注入，没有容器）。
- **不增加可选依赖**：`uiohook-napi` 已经是 optional，维护者须知明确「缺失不影响主功能」
  （见 [`docs/maintainer-notes.md` 第 1 节](./maintainer-notes.md)）。任何优化都不得新增原生/可选依赖。
  ✅ 仍然成立（至今只有那一个可选依赖）。

---

## 5. 风险与回归注意

> **2026-11-06 复核**：这一节是「改了要怎么办」的操作约定，过时就有害，所以按现状重写；
> 完整的口径在 [`docs/maintainer-notes.md` 第 2 节](./maintainer-notes.md)。

- **`lib/` 现在全是构建产物**（批次 23 起不入库），别手改。改动一律发生在 `src/`：
  改 `src/host/` → `pnpm run build:host` 再**重启 DSH**；
  改 `src/client/` 或 `src/shared/` → `pnpm run build:client` 再**浏览器强制刷新**。
  `src/shared/` 是双端共用，改一处两侧都受影响，最省事的是 `pnpm run build`。
- **`pnpm test` 会先自己构建两端**，所以「改了 src 忘了构建」在串跑里不会假绿；
  单跑某个测试文件（`node test/xxx.test.mjs`）不经过那一步，产物是否过期这时由
  `bundle-sync.test.mjs` 的逐字节比对兜住。
- **`pure/*` 保持无浏览器全局、无 React** —— 这是它能被 Node 原生 import 直接测的前提。
  「无跨文件 import」这条**已经放宽**：`dom/` 引 `pure/`、两者都引 `src/shared/`，
  沿 import 图打包就是拆分手段本身。真正还在守的是三条：
  `pure/`、`dom/`、`shared/` 里不许裸用浏览器/Node 全局，也不许 `import react` 或 `node:*`
  （禁令本体在 `eslint.config.js` 的 globals 收窄 + `no-restricted-imports`，
  判据是「在裸 Node 里真 import 一次」），以及**纯文件不许反向引用 `main.js` 的顶层符号**
  （由构建器的 import 图判）。
- **不要动 `test/client-behavior.test.mjs` 的「真实产物」约定**：它直接加载
  `lib/client.js` 跑真实播放循环，是行为回归的底线。
- **`test/repo-hygiene.test.mjs`** 会检查仓库整洁（含文档里提到的路由是否真的存在），
  新增文档/文件后跑一遍。

---

## 6. 第二轮探索（2026-11-02，基线仍为 `main` @ `23b3d56`，工作树已含 P0/P1 落地）

> 这一节把本文对齐到当前树，并补上第一轮没发现的问题。所有数字是当场 grep/统计得来的，
> 复核命令附在每条后面。

### 6.1 【高】客户端还有一整段「已经是纯代码」的部分没迁进 `pure/`

> **状态**：✅ 已落地（2026-11-02 第三轮）。`main.js` 7225 → 6452 行，
> 新增 `pure/config-normalize.js` + `pure/reading-highlight.js`；高亮工厂的对齐函数改为显式注入。
> 「`bundle-sync` 名单改为从 `@bundle` 标记派生」这一句**已过期**：标记本身随 esbuild 一起退役，
> 现在待校验的文件清单取自构建**真正合并的那些文件**，漏登记同样静默不了
> （`src/client/pure/config-normalize.js` 今天 474 行）。

**现状证据**

- `main.js:535–974`：配置枚举（`TTS_ENGINES`/`LANGUAGE_CODES`/`LIVE_ASR_MODES`/
  `INTERACTION_MODES`/`VOICE_PROMPT_MODES`/`RATE_OPTIONS`/`PITCH_OPTIONS`/
  `VOLUME_OPTIONS`/`TTS_FORMATS`/`SOVITS_LANGS`/`IDLE_RELEASE_OPTIONS`/`STRING_LIMITS`/
  `UI_DEFAULTS`）+ 归一化函数（`normalizeEngine`/`normalizeEnum`/`normalizeNumber`/
  `clampSilenceMs`/`clampAutoSendExtraMs`/`clampReadAloudLag`/`parseWordsText`/
  `formatWordsText`/`normalizeWakeWord`/`limitString`/`withCurrentOption`/
  `normalizeForSave`/`collectSaveErrors`）。
- `main.js:975–1363`：`createReadingHighlight(win)` —— 高亮覆盖层工厂。
- 实测这两段对 `document.` / `window.` / `navigator.` 的命中数**均为 0**：
  `awk -v a=535 -v b=974 'NR>=a&&NR<=b' src/client/main.js | grep -cE 'document\.|window\.|navigator\.'`
- `createReadingHighlight` 已经是 `win` 注入的工厂（`main.js:976 const doc = win.document`），
  形状上已经符合 `pure/*` 的约定，只是文件还留在 `main.js` 里。

**问题**

§2.3 的结论「胶水层（DOM/React 依赖的部分）仍是巨石，所以难拆」在这 830 行上**不成立**：
它们没有 DOM 依赖，缺的只是搬家。留在原处的代价是可核对的 —— 想确认一个配置项的
客户端合法取值，必须在一个 7225 行文件里滚动定位；而同一判据的宿主版本在
`lib/config-schema.js`（449 行）里一眼就能看完。

**可选优化**

- `src/client/pure/config-normalize.js`（枚举 + 归一化 + `normalizeForSave`）与
  `src/client/pure/reading-highlight.js`（`createReadingHighlight`），
  按 i18n 已经验证过的路子加 `@bundle` 标记内联。
- **代价与前置**：`test/bundle-sync.test.mjs:97` 的 `PURE_FILES` 是**硬编码名单**，
  新增纯文件必须同步改这个数组和 `PURE_DEFINITIONS`，否则新文件不被校验，
  「产物与源一致」会出现一个静默的缺口。这一步是本次改动唯一的真实风险点。

**建议优先级**：**高**（风险最低、收益直接）。它是 §3 P1 的延续，不需要新机制。

### 6.2 【高·新发现】配置词表是第三处「两份实现」，且**没有任何机械校验**

> **状态**：✅ 已落地（2026-11-02 第三轮）。`test/config-contract.test.mjs` 50 绿并已进 `npm test`；
> 它第一次运行就抓到了 §6.2 说的「漏改表现」实例：`sovitsUrl` 长度不收敛 → 宿主 400。
> 断言分档：**集合/边界/上限必须相等**（硬失败），**枚举顺序只提示**（有意差异）。
>
> **第六轮补充**：本节「加一个配置项要同步改 4 处」的问题到 3.3b 结束 ——
> 枚举词表住在 `src/shared/config-vocab.js`、字段规则（含默认值与长度上限）住在
> `src/shared/config-spec.js`，宿主的 `DEFAULTS`/`SPECS` 与客户端的 `UI_DEFAULTS`/`STRING_LIMITS`/
> 夹取区间都由它派生。加一项 = shared 一条 spec + 设置面板一行；
> 「两份锁成等价」的机械断言相应改成了「同一引用 + 产物里只有一份定义」。
> 见 [`architecture-modernization.md` §8.10–§8.11](./architecture-modernization.md)。

**现状证据**

- 宿主一份：`lib/config-schema.js:24`–`:52` 的 `TTS_ENGINES` / `ASR_LANGUAGES` /
  `SOVITS_LANGUAGES` / `LIVE_ASR_MODES` / `INTERACTION_MODES` / `VOICE_PROMPT_MODES` /
  `TTS_FORMATS`。
- 客户端另一份：`main.js:541`–`:557` 的 `TTS_ENGINES` / `LANGUAGE_CODES` /
  `LIVE_ASR_MODES` / `INTERACTION_MODES` / `VOICE_PROMPT_MODES` / `TTS_FORMATS` /
  `SOVITS_LANGS`。
- 48 个测试里**没有一个横切这两份**：`config-schema.test.mjs` 只 import 宿主模块，
  `config-link.test.mjs` 只渲染面板检查联动，`bundle-sync.test.mjs` 只管产物与源一致。
  复核：`grep -rl config-schema test/` → 只有 `config-schema.test.mjs`、`voice-ui-host.test.mjs`。
- 已经出现的漂移：宿主注释写「顺序与设置面板一致」，实际宿主
  `['online','local','neural','sovits']`、客户端 `['online','neural','local','sovits']`。
  顺序目前无行为影响，所以这个不一致**没人发现也没被测出来**。

**问题**

这正是 §2.1 / §2.2 那个模式的第三次出现，而且比前两次更弱：门限和 UI 协议至少各有
一张共享用例表（`gate-cases.mjs`、`ui-action-protocol.test.mjs`）锁行为，配置词表
**连用例表都没有**。加一个配置项现在要同步改 4 处（宿主 `SPECS`、客户端枚举表、
客户端 `UI_DEFAULTS`、客户端 `normalizeForSave`），漏改的表现是「宿主校验放行但面板不显示」
或「面板能选但宿主回退默认」，都在运行期才暴露。

**可选优化（不破 P0-2 那两条硬约束）**

单源 import 依然被「`lib/` 自包含」+「浏览器单文件产物」挡住，所以**沿用已被验证的
第 3 种解法：真源写两份，用机械断言锁成等价**。

- 新增 `test/config-contract.test.mjs`：同时 import `lib/config-schema.js` 与
  `src/client/pure/config-normalize.js`（后者依赖 §6.1），逐项断言
  「集合相等」（顺序不一致时只 warn，或把顺序纳入断言并一次性对齐），
  并对 `SPECS` 的每个键断言客户端存在对应的枚举/默认值/归一化入口。
- 更进一步（可选）：`scripts/bundle-client.mjs` 生成产物时，顺带从宿主 `SPECS`
  导出 `src/client/pure/config-contract.json`，客户端文件带「此文件由脚本生成，勿手改」头部。
  这一步会引入「生成物」这一新类别，**收益与上一条相同但多一个维护面**，
  除非词表继续膨胀，否则建议先只做断言。

**建议优先级**：**高**。它防的是「改 A 漏 B」，与前两轮的立项标准一致。

### 6.3 【中·新发现】宿主 `index.js` 里已经有一块可直接外提成模块的 1020 行

> **状态**：⏭ **仍未做**（2026-11-06 复核：`src/host/` 下没有 `asr-engine.js`）。
> 这一条与 §6.4 是本文留给下一轮的两笔结构性欠账。位置跟着批次 23 搬了家：
> 下面写的 `lib/index.js` 现在是 `src/host/index.js`，手写 4176 行（产物 6815 行），
> `apply()` 从 `:1671` 到 `:4169` —— 闭包比当时还长了 100 行。

**现状证据**

- `lib/index.js` 现在 4026 行、43 个顶层函数；`apply()` 从 `:1629` 起到 `:4019`
  结束（**2391 行闭包**）。
- `:608`–`:1628` 这 1020 行是**独立函数的连续带**：`loadSherpa` / `getRecognizer` /
  `getVad` / `segmentByVad` / `createRecognizerStream` / `recognizeWithSherpa` /
  流式会话清理（`startStreamSweeper` / `discardStreamingState`）/ 预加载
  （`schedulePreload` / `preloadConfiguredModels`）/ 空闲释放（`releaseIdleModels`）/
  worker 桥（`getAsrWorker` / `recognizeInWorker` / `releaseInWorker`）。

**可选优化**

抽 `lib/asr-engine.js`（识别器与 VAD 的池、流式会话生命周期、预加载/空闲释放、worker 桥）。
`gate.js` 已经证明这套抽法可行：纯外提 + `index.js` re-export，行为不变。

**建议优先级**：**中**。顺序上排在 §6.1/§6.2 之后、路由拆分之前 —— 它不需要新机制，
是本文里除 §6.1 外风险最低的结构性收益。

### 6.4 【中】`apply()` 闭包内 22 条路由全部内联

> **状态**：⏭ **仍未做**（2026-11-06 复核：`grep -c "webServer.register" src/host/index.js`
> 还是 **22**，一条没外提）。路由的**清单**这一批已经单源化了
> （`src/client/pure/routes.js` + 宿主注册表 + `test/route-contract.test.mjs` 双向核对），
> 但 handler 的**实现**仍然全在 `apply()` 那个闭包里 —— 这两件事别混着读。

**现状证据**

- `grep -c "scope.webServer.register" lib/index.js` = **22**，路径覆盖
  `config / tts / tts/env / tts/warmup / transcribe / asr-stream / asr-stream/reset /
  asr-ready / asr-warmup / stream / models / model / voices / voice-session /
  voice-prompt / ui-action-claim / ui-action-result / reading-ack / latest-message /
  hotkey / diagnostics / busy`。
- 它们与 `stats`（约 30 个字段）、`listeners`、`settings`、`pendingUiActions`、
  `broadcast` 共享闭包状态。

**可选优化**

按路由组做 handler 工厂（`createConfigRoutes(deps)` / `createTtsRoutes(deps)` /
`createUiActionRoutes(deps)`），`settings`、`stats`、`broadcast` 等仍由 `apply()`
**注入**进去。

**明确不提议**：把这些可变状态挪到模块级，或在工厂里各自持有一份 —— 那会破坏
「同一进程多次 `apply()` 各自独立」这条既有约束（`index.js:1738` 附近注释记录了它），
是回归风险的净增。这一条的工作量与风险都明显高于 §6.1/§6.3，**建议放在最后做**。

### 6.5 【低但近乎零成本】`SOVITS_LANGUAGES` 在同一个包内定义两次

> **状态**：✅ 已落地（2026-11-02 第三轮）。`lib/sovits-tts.js` 改为 import + 转出，
> 文件内仍要用到这个变量，所以是 `import` 后再 `export {}`，不是裸的 re-export。
> 今天的样子：`src/host/sovits-tts.js` 从 `./config-schema.js` 拿 `SOVITS_LANGUAGES`，
> 而那张表本身住在 `src/shared/config-vocab.js`（第六轮）；同文件还从
> `src/shared/config-spec.js` 拿 `DEFAULT_SOVITS_URL`，连默认地址也不再抄第二遍。

**现状证据**

- `lib/config-schema.js:30` 与 `lib/sovits-tts.js:35` 各有一份
  `['zh','en','ja','ko','yue']`。这是本文唯一一处**同包内**、没有跨包障碍的重复。

**可选优化**

`lib/sovits-tts.js` 改为 `import { SOVITS_LANGUAGES } from './config-schema.js'`。
方向要选对：让 sovits-tts 引用 config-schema，反过来会形成循环引用。

**建议优先级**：**低**，但应当顺手做掉 —— 它不需要 §4 里任何「不做」的豁免。

### 6.6 原 P2（模型目录 / 热键 helper）的取舍判据

现状实测：`model-catalog.js` 934 行 / 8 个顶层声明（平均 117 行/个，仍是全仓最粗），
内部「档位数据（`HOSTS`/`whisperTokens`/`findModel`/`modelPaths`）」与「下载器
（`downloadFile`/`downloadFileParallel`/`downloadChunk`/`mergeChunksAtomic`/校验缓存）」
两簇清晰可分；`global-hotkey-helper.js` 744 行里 `buildHelperScript`（PowerShell 脚本生成）
与 `createHotkeyHelper` 的状态机同处一文件。

判据用「是否阻塞当前迭代」，而不是行数：

- 只有在**新增模型档位**或**新增平台分支**确实需要跨几千行定位时才值得做；
- 若近期没有这两类需求，它们保持 P2 不动，避免为可导航性支付无行为收益的风险。

### 6.7 本轮汇总路线

> 下表是**第三轮当天**的账，只作历史记录。其中「`@bundle` 标记派生」「`--check`」
> 两项口径已随 esbuild 一起作废（见 §0.5 与 §5），§6.3 / §6.4 / §6.6 三条当时标「未动」，
> 2026-11-06 复核**仍未动**。

| 轮次 | 项 | 动作 | 风险 | 验收 |
|---|---|---|---|---|
| P1-a | §6.1 | ✅ 已做：客户端纯代码迁 `pure/`；名单不再手工登记，改由 `@bundle` 标记派生 | 低 | `--check` + `bundle-sync` 71 绿 + `npm test` 全绿 |
| P1-b | §6.2 | ✅ 已做：`test/config-contract.test.mjs` 横断言（50 绿，已进 `npm test`） | 低（纯新增） | 自身绿；首轮就抓到 `sovitsUrl` 漂移 |
| P2-a | §6.5 | ✅ 已做：`sovits-tts.js` 复用 `config-schema.js` 的语言表 | 极低 | `sovits-tts` 34 绿 |
| P2-b | §6.3 | ⏭ 未动：抽 `lib/asr-engine.js` | 中 | `live-asr`、`worker-*`、`sensevoice-fallback`、`silence` 全绿 |
| P3 | §6.4 | ⏭ 未动：`apply()` 内路由按组做 handler 工厂 | 中高 | 全部宿主路由测试 + 重启 DSH 手测 |
| 观察 | §6.6 | ⏭ 未动：模型目录 / 热键 helper，按「是否阻塞迭代」决定 | — | — |

**本轮实际结果**：`main.js` 7225 → **6452 行**（-773），新增 3 个文件
（`pure/config-normalize.js` 444、`pure/reading-highlight.js` 411、`test/config-contract.test.mjs` 231），
`npm test` 49 个测试全绿。**改 `lib/` 需重启 DSH，改 `src/client/` 需重建并刷新浏览器**（§5）。

**约束不变**（沿用 §4/§5）：不引入打包器、产物保持单文件、React 组件不跨文件、
不新增依赖；改 `lib/` 需重启 DSH，改 `src/client/` 需 `npm run build:client` 并刷新浏览器。

> **2026-11-06 更正**：这句「约束不变」里只有三条今天还成立 ——
> 产物保持单文件、不新增依赖、`src/shared/` 与 `pure/` 不碰环境。
> 「不引入打包器」「React 组件不跨文件」「改 `lib/`」三条已经作废，
> 口径以 §0.5 与 §5 为准。

---

## 7. 收口（2026-11-06）

这份文件从「探索」变成了「一份探索记录 + 一张欠账表」。收口如下：

**已经兑现的**：§2.1、§2.2、§2.3（客户端那一半）、§6.1、§6.2、§6.5，
以及 §4 里那条豁免被撤回之后换上的 esbuild 构建。
本文最初问的那句「真正值得优化的是什么」—— 消除被文档承认的重复实现 ——
现在答案是**已经消除了**：门限、UI 动作协议、配置词表与字段规则、修饰键与主键词表
全在 `src/shared/` 里只有一份，两端各自注入自己的常数。

**还欠的**，按当时排的顺序原样留着：

1. §6.3 宿主识别引擎外提（`src/host/index.js` 里那 1000 行独立函数带）。
2. §6.4 `apply()` 闭包内 22 条路由按组做 handler 工厂。
3. §2.4 / §6.6 `model-catalog.js`（1013 行）与 `global-hotkey-helper.js`（725 行）的内聚拆分，
   判据是「是否阻塞当前迭代」，不是行数。

**别再照本文下笔时的数字行动**：所有行数、路径与命令以 §0.5 为准；
逐批的改动过程在 [`architecture-modernization.md`](./architecture-modernization.md)，
操作规矩在 [`docs/maintainer-notes.md`](./maintainer-notes.md)，
接口与技术参考在 [`docs/reference.md`](./reference.md)。
