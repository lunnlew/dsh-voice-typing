/**
 * 构建产物一致性检查。
 *
 * lib/client.js 是**构建产物**（由 scripts/build-client.mjs 用 esbuild 从 src/client/ 生成）。
 * 浏览器模块的 require 只认包名，所以源码要在构建期合成单文件。
 *
 * 这个测试保证：
 *   1. 产物与源同步（批次 23 起 `lib/` 不入库：跑整套测试时 `scripts/run-tests.mjs` 会先构建，
 *      这条判的是「那次构建写下来的 == 现在再生成一遍」；**单跑某个测试文件**不走构建，
 *      这时它就是「产物过期」的唯一去处 —— 宿主按 mtime/size 算 rev，忘构建装机不会报警，
 *      所以这条留在测试里而不是只留在 CI 里）；
 *   2. 生成**幂等**且**没有写副作用**（renderClient() 只计算）；
 *   3. 产物的**宿主契约形态**：`window.__ModuleLoader__.load({ id, factory })`、
 *      require 只出现 'react'、没有 ESM 残留 —— 这些在构建脚本里也拦一遍，
 *      这里是第二道闸（脚本被改坏时要能发现）；
 *   4. 每个纯函数在产物里**恰好定义一次**（打包器改名/重复注入的回归信号）；
 *   5. src/client/pure/ 下的文件仍然是**可原生 import 的纯模块**，
 *      且仍然不反向引用 main.js 的顶层符号；
 *   5b. src/client/dom/ 下从 main.js 拆出来的 DOM 胶水：有状态，但环境只能从参数进来
 *      （源码里连裸的 window/document/navigator 字样都不许出现），同样可原生 import；
 *   6. src/shared/ 下的模块是**双端单源**：零浏览器全局 + 零 Node API，
 *      并且同一判据不许有第二份实现（扫描范围 = 全仓手写源码，构建产物按 banner 豁免）；
 *   7. 宿主侧产物（第 6.4 步起，6.5 把 `lib/index.js` 也接进来）：`src/host/` →
 *      `lib/{index,asr-worker,tts-worker}.js` 同步、幂等、
 *      自包含（产物里不许残留相对 import，否则又变成「发布物得带上 src/」），
 *      并且 src/host 下每个文件都必须真的被某个入口打进产物
 *      —— 最后这一条由 `node scripts/build-host.mjs --check` 判，这里跑那条真命令看退出码。
 *
 * 变更记录：第 2 步把「正则文本内联」换成 esbuild 之后，
 * 原来那批「防内联出错」的断言（标记失配、CRLF、混排缩进）失去对象，已删；
 * 拍平后的产物字节变紧凑（`{ ... }` → `{...}`），所以文案类断言改读**源文件**而不是产物。
 * 第 6.5 步前置 A：反分叉那批判据不再各自带一份「可疑文件名单」，改成全仓扫手写源码 ——
 * 名单在 6.5 把内部模块内联进 lib/index.js 之后会把合法内联判成分叉（§8.29 末尾那颗雷），
 * 而产物豁免按 banner 认，将来 lib/ 里多几个产物都不用回来改这里。
 * 第 6.5 步本体：内部模块全部内联之后 `lib/` 只剩 4 个产物，判据的 `home` 也跟着指到 src/；
 * 孤儿守卫从「顶层 .js」改成递归扫 src/host/（当时是因为 vendor/ 也在里面；批次 15 把 vendor 换成
 * 真依赖之后递归仍然留着 —— 它挡的是「以后有人在 src/host 下开个子目录但没人 import」，不只为一个目录服务）。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { renderClient } from '../scripts/build-client.mjs'
import { renderHost, HOST_ENTRIES } from '../scripts/build-host.mjs'
import { buildModuleGraph, reachable } from './helpers/module-graph.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundled = fs.readFileSync(root + '/lib/client.js', 'utf8')
const SHARED_DIR = `${root}/src/shared`
// 名单从目录读，不硬编码：新加一个 shared 模块就自动受同一套约束管。
const SHARED_FILES = fs.existsSync(SHARED_DIR)
  ? fs.readdirSync(SHARED_DIR).filter((f) => f.endsWith('.js')).sort()
  : []

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/** 注释里讲「这里用了 window.xxx」是正常文档，不该被判成依赖环境。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/**
 * 构建产物怎么认：**看文件头的 banner**，不看路径名单。
 * banner 由构建脚本写（build-client.mjs / build-host.mjs 的 BANNER）。
 * 为什么不写成 `['lib/client.js', 'lib/asr-worker.js', ...]` 这种名单：
 * 第 6.5 步会把内部模块内联进 `lib/index.js`，产物当场从 3 个变成 4 个，
 * 名单漏改的那一条不是报错而是**静默按手写源码处理** —— 合法内联被扫成分叉。
 */
const ARTIFACT_BANNER = '构建产物，勿手改'
function readRepo(rel) {
  return fs.readFileSync(`${root}/${rel}`, 'utf8')
}
function isBuildArtifact(rel) {
  try {
    return readRepo(rel).slice(0, 400).includes(ARTIFACT_BANNER)
  } catch {
    return false
  }
}

/** 递归列 src/ 与 lib/ 下的 js/cjs/mjs，返回相对路径（正斜杠）。 */
function walkCode(dir, out = []) {
  for (const ent of fs.readdirSync(`${root}/${dir}`, { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`
    if (ent.isDirectory()) walkCode(rel, out)
    else if (/\.(?:js|cjs|mjs)$/.test(ent.name)) out.push(rel)
  }
  return out
}

// 反分叉扫描的范围 = 全仓**手写源码**（src/ + lib/ 里没 banner 的那些）。
// 每条判据不再自带一份文件名单：名单会过期，过期后的表现是「少扫一个文件」这种看不见的漏。
const HANDWRITTEN_SOURCES = [...walkCode('src'), ...walkCode('lib')]
  .filter((f) => !isBuildArtifact(f))
  .sort()
const ARTIFACT_FILES = [...walkCode('src'), ...walkCode('lib')]
  .filter((f) => isBuildArtifact(f))
  .sort()

console.log('产物与源文件同步')
const rendered = await renderClient()
{
  check('lib/client.js 与 src/client/ 一致（等价于 --check，但不写盘）',
    rendered.content === bundled,
    '改了 src/client/ 之后要跑 node scripts/build-client.mjs')
  const again = await renderClient()
  check('生成逻辑幂等（两次计算字节一致）', again.content === rendered.content)
  check('入口的 import 图非空（产物不是只有一句壳）', rendered.used.length > 0,
    'esbuild 只沿 import 图拉模块 —— 入口没引到任何 src/client 模块')
}

console.log('\n宿主契约形态')
check('产物是构建产物（头部有生成说明）', bundled.startsWith('/* 构建产物，勿手改'))
check('注册进 window.__ModuleLoader__.load', /window\.__ModuleLoader__\.load\(/.test(bundled))
check('模块 id 是包名', /id: 'dsh-voice-typing'/.test(bundled))
check('factory 是 (require) => {} 形式', /factory: \(require\) => \{/.test(bundled))
check('factory 把宿主的 require 交给入口', /\n {4}return module\.exports\.buildClientModule\(require\)\n {2}\},/.test(bundled),
  '产物形态变了：宿主要的是 factory 返回导出面，React 只能从这个 require 拿')
// esbuild 会把入口的形参 `require` 改名成 `require2`，所以后缀数字要一起吃下，
// 否则这条断言只会匹配到 0 个，永远「通过」或者像本轮这样误报。
const requires = [...new Set([...bundled.matchAll(/\brequire\d*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]))]
check(`require 只出现 'react'（实际：${requires.join(',') || 'none'}）`,
  requires.length === 1 && requires[0] === 'react',
  '宿主解析不了的 require 会在运行期抛错')
check('没有残留 ESM import 语句', !/^\s*import[\s{]/m.test(bundled))
check('没有残留 ESM export 语句', !/^\s*export[\s{]/m.test(bundled))
check('没有残留的 @bundle 标记', !/\/\* @bundle /.test(bundled))

console.log('\n入口的 import 图 = 产物内容（@bundle 摘掉后的替代防线）')
{
  // 这一节只剩「磁盘上的模块都要真的被打包进来」这一条。
  // 原来同处还有四条扫 main.js 文本的判据（源码存在、顶层有 import、没有 @bundle、
  // 导出 buildClientModule）—— 前两条是 @bundle 退役留下的写法残迹，后两条要保的
  // 「入口能被宿主调用」已经由下面两件事真跑证明了：
  //   · 「产物能按宿主的方式执行（load → factory(require)」那节真的把产物跑了一遍，
  //     factory 里就是 buildClientModule(require)；
  //   · test/client-behavior.test.mjs 拿真产物驱动界面。
  // 批次 6d，见 docs §8.37。
  // 过去「漏写一条标记」= 那个文件不进产物；现在「没人 import 它」= 不进产物，同一个洞。
  const onDisk = []
  for (const dir of ['pure', 'dom']) {
    for (const f of fs.readdirSync(`${root}/src/client/${dir}`)) {
      if (f.endsWith('.js')) onDisk.push(`${dir}/${f}`)
    }
  }
  const used = new Set(rendered.used)
  const orphans = onDisk.filter((f) => !used.has(f))
  check(`src/client 下 ${onDisk.length} 个模块全都真的进了产物`,
    orphans.length === 0, `没人 import 它，产物里没有：${orphans.join(', ')}`)
}

/** 纯函数模块 → 该模块里必须恰好定义一次的函数。 */
const PURE_DEFINITIONS = [
  // 门限：算法住在 src/shared/gate.js，产物里合并的是 createGate/stepGate。
  // （`advanceGate` 现在是 createGate 的返回值，esbuild 会把内层函数改名成
  //  advanceGate2 以免和外层 const 撞名 —— 所以不能按这个名字断言。）
  ['createGate', 'shared/gate.js（经 pure/gate.js 合并）'],
  ['stepGate', 'shared/gate.js'],
  ['mergeDraft', 'pure/draft.js'],
  ['syncUserEdit', 'pure/draft.js'],
  ['parseEnvelope', 'pure/envelope.js'],
  ['belongsToSession', 'pure/envelope.js'],
  ['createTimerRegistry', 'pure/envelope.js'],
  ['sleep', 'pure/envelope.js'],
  ['trimBacklog', 'pure/backlog.js'],
  // 批次 6f：朗读回执的拆批算术从组件里抽进 pure/reading-ack.js（判据见 reading-ack-contract 第 6 节）。
  ['normalizeAckCount', 'pure/reading-ack.js'],
  ['ackBatches', 'pure/reading-ack.js'],
  ['unescapeSpeechText', 'pure/highlight.js'],
  ['normalizeRun', 'pure/highlight.js'],
  ['collapseWhitespace', 'pure/highlight.js'],
  ['matchInNodes', 'pure/highlight.js'],
  ['createVadState', 'pure/global-voice.js'],
  ['advanceVad', 'pure/global-voice.js'],
  ['prepareVoiceText', 'pure/global-voice.js'],
  ['normalizeVoicePromptMode', 'pure/global-voice.js'],
  ['validateUiAction', 'shared/ui-action-protocol.js（经 pure/ui-action-protocol.js 合并）'],
  ['actionNeedsConfirm', 'shared/ui-action-protocol.js'],
  ['describeUiAction', 'shared/ui-action-protocol.js'],
  ['buildUiActionPayload', 'shared/ui-action-protocol.js'],
  ['validateUiActionResult', 'shared/ui-action-protocol.js'],
  ['isInteractiveTag', 'pure/a11y.js'],
  ['describeInteractiveElement', 'pure/a11y.js'],
  ['parseKeySpec', 'pure/a11y.js'],
  ['normalizeConfirmSpeech', 'pure/a11y.js'],
  ['describeConfirmTarget', 'pure/a11y.js'],
  ['normalizeForSave', 'pure/config-normalize.js'],
  ['normalizeEngine', 'pure/config-normalize.js'],
  ['collectSaveErrors', 'pure/config-normalize.js'],
  ['formatEnvEngines', 'pure/config-normalize.js'],
  ['createReadingHighlight', 'pure/reading-highlight.js'],
  // 第 4 步 4.3：快捷键簇（校验 / 匹配 / 平台别名 / 「正在录键」状态）整搬进 pure/shortcut.js。
  // 四条都登记：它们现在同属一个判据家族，产物里出现第二份就是「有人又把规则抄了一遍」。
  ['validateShortcut', 'pure/shortcut.js'],
  ['matchesShortcut', 'pure/shortcut.js'],
  ['shortcutMatches', 'pure/shortcut.js'],
  ['createShortcutFocusTracker', 'pure/shortcut.js'],
  // 第 4 步 4.4a：采集侧的音频算式（拼 chunks / 归一采样率 / 重采样）整族进 pure/resample.js。
  // 三个名字都登记：这一族以前是「一份实现 + 三处手写兜底」，登记后谁也抄不走。
  ['resampleTo16k', 'pure/resample.js'],
  ['normalizeSourceRate', 'pure/resample.js'],
  ['mergeChunks', 'pure/resample.js'],
  // 第 4 步 4.3b：修饰键词表归并到 src/shared/key-modifiers.js，三条链路共用一个函数。
  // 产物里出现第二份 = 有人又抄了一张别名表，那正是「校验放行、匹配不认」这类静默失效的源头。
  ['canonicalModifier', 'shared/key-modifiers.js（经 pure/shortcut.js 与 pure/a11y.js 合并）'],
  // 第 4 步 4.1：DOM 胶水第一次从 main.js 的闭包里搬出来（工厂本身在产物里只能有一份）。
  ['createA11yDomBridge', 'dom/a11y-bridge.js（DOM 胶水，环境注入）'],
  // 第 4 步 4.2：播放核心（取音频 + 常驻 AudioContext + 诊断态）搬进同一家族的第二个文件。
  ['createPlaybackCore', 'dom/playback-core.js（DOM 胶水，环境注入）'],
  // 第 4 步 4.4b：开麦设备层（能力探测 / 约束 / 轨道判据 / AudioContext 守卫 / 释放）——
  // 两个录音入口以前各写一份且不等价，工厂只许有一份。
  ['createMicDevice', 'dom/mic-device.js（DOM 胶水，环境注入）'],
  // 第 4 步 4.5：会话上下文（插件 ctx 引用 + 上次会话 id 持久化 + clientService 多路降级）。
  // 三个顶层 let 和三个相关函数从 main.js 拆出来，工厂只许有一份。
  ['createSessionContext', 'dom/session-context.js（DOM 胶水，环境注入）'],
  // 第 4 步附：多窗口去重 / 请求 id（clientId + claimUiAction）。
  // 依赖浏览器 API（window / sessionStorage / localStorage / crypto / fetch），工厂只许有一份。
  ['createClientId', 'dom/client-id.js（DOM 胶水，环境注入）'],
  // 第 4 步附：配置共享存储（pub/sub 单例，组件间同步配置状态）。
  // 工厂只许有一份，单例在模块级创建。
  ['createConfigStore', 'dom/config-store.js（DOM 胶水，环境注入）'],
  // 第 4 步 4.3d：具名键词表。浏览器侧只用得到两个取值（规范名、KeyboardEvent.key 真值），
  // uiohook 键名与 Windows 虚拟键码是宿主注册热键要的东西，不该出现在产物里。
  ['keyNameOf', 'shared/key-names.js（经 pure/a11y.js 与 pure/shortcut.js 合并）'],
  ['domKeyOf', 'shared/key-names.js'],
  // 第 4 步附：平台检测纯函数（navigator 读取 + 展示名映射）。
  // 两个函数都住进 pure/platform.js，产物里出现第二份就是有人又抄了一遍。
  ['clientPlatform', 'pure/platform.js'],
  ['describePlatformName', 'pure/platform.js'],
  // 批次 18（docs §8.60）：开麦就绪的原因码 → 界面那句。
  // 查表这件事只能有一份：出现第二份 = 有人又在组件里手写了一遍「码 → 文案」，
  // 那正是「宿主说什么语言、界面就跟着说什么语言」的源头。
  ['asrReadyReasonText', 'pure/asr-ready-text.js'],
  ['isAsrReadyReason', 'shared/asr-readiness.js（经 pure/asr-ready-text.js 合并）'],
  // 批次 19（docs §8.61）：系统级热键的原因码 → 界面那句，同一族规矩。
  ['hotkeyReasonText', 'pure/hotkey-reason-text.js'],
  ['isHotkeyReason', 'shared/hotkey-reasons.js（经 pure/hotkey-reason-text.js 合并）'],
  // 批次 20（docs §8.62）：保存校验错误那一族。查表与「字段名 = t(配置键)」各只许有一份，
  // 出现第二份 = 有人又在组件里手写了一遍「码 → 文案」或那份手写的中文键名表
  // （被删掉的 `UI_SAVE_ERROR_LABELS` 就是它，抄一次就漂移一次）。
  ['configErrorText', 'pure/config-error-text.js'],
  ['configFieldLabel', 'pure/config-error-text.js'],
  ['isConfigErrorCode', 'shared/config-error-codes.js（经 pure/config-error-text.js 合并）'],
  // 批次 22（docs §8.64）：快捷键那两行红字。这一族的**码表住在校验层**（`pure/shortcut.js`），
  // 因为只有客户端发这个码 —— 但「查表出句子」仍只许有一份，出现第二份就是有人在组件里
  // 又手写了一遍「码 → 中文」，回到「切英文那两行还是中文」那个形状。
  ['shortcutErrorText', 'pure/shortcut-error-text.js'],
  ['isShortcutErrorCode', 'pure/shortcut.js（码表就住在校验层）'],
  // 批次 22 顺手修的那条：兜底取词以前在三个组件里各写一遍 `(key) => zh[key] ?? key`，
  // 第二个参数直接丢掉。现在三份合成一个函数，产物里出现两份就是又有人各写各的兜底。
  ['interpolate', 'pure/i18n.js（句子里 {名字} 怎么填）'],
  ['zhTranslate', 'pure/i18n.js（三个组件共用的兜底取词）'],
  // 批次 22-2（docs §8.65）：面板的选项与展示名取词。这四条以前是组件里手写的中文
  // （或者一份「码/短名 → 中文」的局部表），现在都变成「查这张字典」。查表只许有一份：
  // 出现第二份就是有人在另一个组件里又抄了一遍显示名，切英文时那半截又会留中文。
  ['languageLabel', 'pure/i18n.js（语言码 → 显示名）'],
  ['voiceLabel', 'pure/i18n.js（音色短名 → 显示名）'],
  ['ttsEngineOptionLabel', 'pure/i18n.js（引擎 id → 选项名，带本地不支持的变体）'],
  ['idleReleaseLabel', 'pure/i18n.js（分钟数 → 档位那句，含永不释放）'],
  // 批次 22-3-1（docs §8.66）：模型档位名。改前面板四处渲染点读的是宿主 `/models` 的
  // `label`（宿主的 `labelEn` 从没上过界面），现在统一走这一条查表。
  // 产物里出现第二份 = 有人在另一个组件里又把档位名抄成了中文，或又直接渲染了宿主的 `label`。
  ['modelLabel', 'pure/i18n.js（档位 id → 展示名，词表外原样返回 id）'],
  // 批次 22-3-2（docs §8.67）：环境自检那四行的句子。改前面板拼的是宿主 `detail` 里的中文整句，
  // 现在宿主只回码，查表出句子只许这一份；行名与 `{runtime}` 那一个词也各一份。
  // 产物里出现第二份 = 有人又在组件里写了一遍「码 → 中文」或又直接渲染了宿主的 `label`。
  ['ttsEnvReasonText', 'pure/tts-env-reason-text.js'],
  ['isTtsEnvReason', 'shared/tts-env-reasons.js（经 pure/tts-env-reason-text.js 合并）'],
  ['envEngineLabel', 'pure/i18n.js（引擎 id → 自检行名，脏 id 露出 id）'],
  ['envRuntimeLabel', 'pure/i18n.js（native / wasm → 那一个词）'],
]
for (const [fn, file] of PURE_DEFINITIONS) {
  const count = (bundled.match(new RegExp(`function ${fn}\\b`, 'g')) || []).length
  check(`${fn} 在产物里恰好定义一次（来自 ${file}）`, count === 1, `实际 ${count} 处`)
}

console.log('\nshared 词表在产物里只有一份定义')
{
  // 客户端历史上用自己的名字（LANGUAGE_CODES / SOVITS_LANGS / WORDS_MAX_ENTRIES /
  // WORDS_MAX_CHARS），单源后它们只能是指向 shared 的别名。
  // 这条检查抓的是「有人在客户端入口又写了一遍字面量」——
  // 那种做法在 config-contract 的引用级断言里也会红，但在产物层面红得更直白。
  const VOCAB_NAMES = [
    ['TTS_ENGINES', 'shared 真名'],
    ['ASR_LANGUAGES', 'shared 真名'],
    ['SOVITS_LANGUAGES', 'shared 真名'],
    ['LIVE_ASR_MODES', 'shared 真名'],
    ['INTERACTION_MODES', 'shared 真名'],
    ['VOICE_PROMPT_MODES', 'shared 真名'],
    ['TTS_FORMATS', 'shared 真名'],
    ['MAX_WORDS', 'shared 真名'],
    ['MAX_WORD_CHARS', 'shared 真名'],
    ['LANGUAGE_CODES', 'pure/config-normalize.js 里的别名'],
    ['SOVITS_LANGS', 'pure/config-normalize.js 里的别名'],
    ['WORDS_MAX_ENTRIES', 'pure/config-normalize.js 里的别名'],
    ['WORDS_MAX_CHARS', 'pure/config-normalize.js 里的别名'],
    ['CONFIG_SPECS', 'shared/config-spec.js（字段规则 + 默认值）'],
    ['CONFIG_DEFAULTS', 'shared/config-spec.js'],
    ['CONFIG_MAX_LENS', 'shared/config-spec.js'],
    ['DEFAULT_SOVITS_URL', 'shared/config-spec.js'],
    // 第 4 步 4.3b：修饰键词表（4.3b）也是双端单源 —— 浏览器侧经 pure/* 合并进来。
    ['KEY_MODIFIER_ALIASES', 'shared/key-modifiers.js（别名 → 规范名）'],
    ['KEY_MODIFIER_NAMES', 'shared/key-modifiers.js（四个规范名）'],
    ['STRONG_KEY_MODIFIER_NAMES', 'shared/key-modifiers.js（强修饰键）'],
    // 第 4 步 4.4a：客户端上传的采样率也是契约值（宿主按 16k 解释），只许定义一次。
    ['TARGET_SAMPLE_RATE', 'pure/resample.js（与宿主的采样率契约）'],
    // 第 4 步 4.4b：开麦约束对象（单声道 + 16k + 三项音频处理）只许有一份字面量。
    ['CAPTURE_CONSTRAINTS', 'dom/mic-device.js（两个录音入口共用）'],
    // 第 4 步 4.3d：具名键词表（写法 → DOM / uiohook / Win32 三种取值）。
    ['KEY_NAME_FORMATS', 'shared/key-names.js（三条链路共用同一批写法）'],
    // 第 4 步附：语音输入常量（超时/队列/事件名/DOM ID）从 main.js 顶层搬到 pure/voice-constants.js。
    // 13 个常量只许定义一次，组件直接 import，不再通过工厂参数传递。
    ['TRANSCRIBE_TIMEOUT_MS', 'pure/voice-constants.js'],
    ['TTS_TIMEOUT_MS', 'pure/voice-constants.js'],
    ['MAX_RECORD_MS', 'pure/voice-constants.js'],
    ['MAX_PENDING', 'pure/voice-constants.js'],
    ['MAX_SEEN_SENTENCE_KEYS', 'pure/voice-constants.js'],
    ['GLOBAL_MIC_ON_EVENT', 'pure/voice-constants.js'],
    ['GLOBAL_MIC_OFF_EVENT', 'pure/voice-constants.js'],
    ['GLOBAL_TOGGLE_EVENT', 'pure/voice-constants.js'],
    ['GLOBAL_OVERLAY_ID', 'pure/voice-constants.js'],
    ['WAKE_ACTIVE_MS', 'pure/voice-constants.js'],
    ['WAKE_HINT_MS', 'pure/voice-constants.js'],
    ['CONFIRM_TIMEOUT_MS', 'pure/voice-constants.js'],
    // 第 4 步附：全局语音浮层样式对象从 main.js 搬到 pure/voice-styles.js。
    // 3 个样式常量只许定义一次，组件直接 import。
    ['GLOBAL_OVERLAY_WRAPPER_STYLE', 'pure/voice-styles.js'],
    ['GLOBAL_OVERLAY_CARD_STYLE', 'pure/voice-styles.js'],
    ['GLOBAL_OVERLAY_ACTION_STYLE', 'pure/voice-styles.js'],
    // 批次 18（docs §8.60）：开麦就绪的原因码词表。宿主回码、客户端查表读的是同一份，
    // 产物里出现第二份 = 有人在客户端又抄了一遍码名，两边就会各改各的（抄一次就是漂移一次）。
    ['ASR_READY_REASONS', 'shared/asr-readiness.js（双端同一份码）'],
    ['ASR_READY_REASON_VALUES', 'shared/asr-readiness.js'],
    ['ASR_READY_REASON_KEYS', 'pure/asr-ready-text.js（码 → i18n 键）'],
    // 批次 19（docs §8.61）：系统级热键那一族。
    ['HOTKEY_REASONS', 'shared/hotkey-reasons.js（双端同一份码）'],
    ['HOTKEY_REASON_VALUES', 'shared/hotkey-reasons.js'],
    ['HOTKEY_REASON_KEYS', 'pure/hotkey-reason-text.js（码 → i18n 键）'],
    // 批次 20（docs §8.62）：保存校验错误的原因码 + 码→键的表。
    ['CONFIG_ERROR_REASONS', 'shared/config-error-codes.js（双端同一份码）'],
    ['CONFIG_ERROR_REASON_VALUES', 'shared/config-error-codes.js'],
    ['CONFIG_ERROR_KEYS', 'pure/config-error-text.js（码 → i18n 键）'],
    // 批次 22（docs §8.64）：快捷键校验那一族。前三族的码表在 `src/shared/`（宿主也发），
    // 这一族在 `pure/shortcut.js`（只有客户端发）—— 位置不同，「只许一份」这条一样。
    ['SHORTCUT_ERROR_REASONS', 'pure/shortcut.js（这一族的码只有客户端发）'],
    ['SHORTCUT_ERROR_REASON_VALUES', 'pure/shortcut.js'],
    ['SHORTCUT_ERROR_KEYS', 'pure/shortcut-error-text.js（码 → i18n 键）'],
    // 批次 22-2（docs §8.65）：面板那三族「契约值 → i18n 键」的表。它们不是双端共用的码表
    // （宿主不发语言码/音色短名/引擎 id 的显示名），但「产物里只许有一份」这条一样：
    // 再写一份就是「组件自己那张中文名表」，正是这批要消灭的东西。
    ['LANGUAGE_LABEL_KEYS', 'pure/i18n.js（6 个语言码 → 显示名键）'],
    ['VOICE_LABEL_KEYS', 'pure/i18n.js（24 个音色短名 → 显示名键）'],
    ['TTS_ENGINE_OPTION_KEYS', 'pure/i18n.js（4 个引擎 id → 选项名键）'],
    // 批次 22-3-1（docs §8.66）：模型档位 id → 展示名键。这张表是**目录文字的副本**
    // （宿主按目录发 `label`，客户端按字典发界面句子），等值由 i18n 判据 17 锁；
    // 「只许一份」判的是别再有一份档位名表住在组件里。
    ['MODEL_LABEL_KEYS', 'pure/i18n.js（9 个档位 id → 展示名键）'],
    // 批次 22-3-2（docs §8.67）：环境自检那一族。码表在 `src/shared/`（宿主发码、客户端查表
    // 读同一份），参数协议表也在 shared（少一个名字界面就露一个 {version}）；
    // 行名表在 pure/i18n.js（宿主那份 `label` 客户端不再读）。四样都只许一份。
    ['TTS_ENV_REASONS', 'shared/tts-env-reasons.js（双端同一份码）'],
    ['TTS_ENV_REASON_VALUES', 'shared/tts-env-reasons.js'],
    ['TTS_ENV_REASON_PARAMS', 'shared/tts-env-reasons.js（每个码要带的参数名）'],
    ['TTS_ENV_REASON_KEYS', 'pure/tts-env-reason-text.js（码 → i18n 键）'],
    ['ENV_ENGINE_LABEL_KEYS', 'pure/i18n.js（4 个引擎 id → 自检行名键）'],
  ]
  for (const [name, note] of VOCAB_NAMES) {
    const count = (bundled.match(new RegExp(`^\\s*(?:var|const|let) ${name} =`, 'gm')) || []).length
    check(`${name} 在产物里恰好定义一次（${note}）`, count === 1, `实际 ${count} 处`)
  }
  // 别名必须只是转发：带字面量的赋值说明有人又把词表抄了一遍。
  for (const [alias, sharedName] of [['LANGUAGE_CODES', 'ASR_LANGUAGES'],
    ['SOVITS_LANGS', 'SOVITS_LANGUAGES'], ['WORDS_MAX_ENTRIES', 'MAX_WORDS'],
    ['WORDS_MAX_CHARS', 'MAX_WORD_CHARS'],
    // 3.3b：客户端的默认表与长度上限表同样是 shared 的别名（以前是两份手写字面量）。
    ['UI_DEFAULTS', 'CONFIG_DEFAULTS'], ['STRING_LIMITS', 'CONFIG_MAX_LENS']]) {
    // esbuild 可能给别名加数字后缀（UI_DEFAULTS2）以避免与同名局部变量冲突，
    // 这不影响语义：只要赋值右侧是 shared 名即可。
    check(`${alias} 是 ${sharedName} 的别名（不是重新声明）`,
      new RegExp(`^\\s*(?:var|const|let) ${alias}\\d* = ${sharedName};`, 'm').test(bundled),
      '产物里这一行不是 `别名 = shared 名`')
  }
}

console.log('\n这些模块在 Node 里原生 import 得动（环境全靠注入）')
{
  // 这一节替代的是原来三条「扫源码文本找环境引用」的判据族（pure/ 的浏览器全局与 React、
  // dom/ 的裸 window/document/navigator 与 Node API 与 React、shared/ 的同款四条）。
  // 批次 6d 把它们分成了两半（docs §8.37）：
  //   · **禁令本体**搬进 `eslint.config.js`：这几个目录的 globals 清单里没有
  //     window/document/navigator/process/require/__dirname… 这些名字，裸用就是
  //     「没绑定的标识符」，`no-undef` 当场报（和漏 import 走的是同一套机制）；
  //     外加 `no-restricted-imports` 挡 `node:*` 与 `react`。
  //     为什么不是再叠一条限制规则：`no-restricted-globals` 连
  //     `typeof document !== 'undefined'` 一起报（旧判据明确放过），AST 选择器又会把
  //     `win.document` 这种**属性位置**误伤（属性值本来就从注入对象上取）。
  //   · **判据本身**改判结果：这些文件在没有任何浏览器环境的 Node 里真 import 一次。
  //     旧判据保的从来就是「Node 侧 import 这个文件不会 ReferenceError」—— 那就直接 import。
  // 名单取自构建**真正合并的文件** + shared 目录，不是硬编码数组：漏登记不会被静默跳过。
  const importable = [
    ...rendered.used.map((f) => `src/client/${f}`),
    ...SHARED_FILES.map((f) => `src/shared/${f}`),
  ].sort()
  check(`待 import 的模块清单非空（${importable.length} 个）`, importable.length > 0,
    '构建没合并任何模块，或目录结构变了 —— 这一节会跟着变成永久绿灯')
  const blew = []
  const emptyExports = []
  for (const rel of importable) {
    try {
      const mod = await import(new URL(`../${rel}`, import.meta.url).href)
      if (Object.keys(mod).length === 0) emptyExports.push(rel)
    } catch (e) {
      blew.push(`${rel}: ${e.message}`)
    }
  }
  check(`${importable.length} 个模块在裸 Node 里 import 全部成功`, blew.length === 0, blew.join(' | '))
  check('每个模块都有可用导出（不是 import 得到一个空壳）', emptyExports.length === 0,
    emptyExports.join(', '))
}

console.log('\nsrc/client/dom/* 导出的是建实例的工厂（状态留在闭包内）')
{
  // 拆分 main.js 时新开的这一类：它**不是**纯函数（持有最近一次快照的 ref 表、真的派发 DOM 事件），
  // 但和 pure/ 一样必须能在 Node 里被 import 并单测 —— 差别只在于环境是构造函数参数。
  // 环境那一半由上一节的 linter + 原生 import 管；这一节只管**导出面**：
  // 读到的模块对象里确实有 `createXxx` 工厂，而不是一个模块级单例。
  // 诚实边界：旧判据是 `/^export function create[A-Z]/` 扫文本，它同样证明不了
  // 「状态真的留在闭包里」—— 真要证那件事得按文件写两次实例化的对照（各工厂语义不同，
  // 不在这一节里做）。
  const domFiles = rendered.used.filter((f) => f.startsWith('dom/'))
  check('dom/ 目录里有文件被合并（第 4 步拆分确实在推进）', domFiles.length > 0,
    '一个 dom/*.js 都没进产物 —— 新拆出去的目录得被入口 import 到')
  const noFactory = []
  for (const f of domFiles) {
    const mod = await import(new URL(`../src/client/${f}`, import.meta.url).href)
    const creators = Object.entries(mod)
      .filter(([name, v]) => /^create[A-Z]/.test(name) && typeof v === 'function')
    if (creators.length === 0) {
      noFactory.push(`${f}（导出：${Object.keys(mod).join(',') || '无'}）`)
    }
  }
  check(`${domFiles.length} 个 dom/ 模块都导出 createXxx 工厂`, noFactory.length === 0,
    noFactory.join(' | '))
}

console.log('\nsrc/shared/* 是双端单源（零环境依赖 + 不许有第二份实现）')
{
  // `src/shared` 里的东西**两侧都要用**：宿主 `src/host/*.js` 直接 import（Node），
  // 浏览器侧经 `src/client/pure/*` import 后由构建合并进单文件产物。
  // 所以它的约束比 pure/ 更紧：既不能碰浏览器全局，也不能碰 Node API，
  // 否则一边能跑一边炸，而报错点在产物里看不出来。
  check('shared 目录存在且有内容', SHARED_FILES.length > 0, 'src/shared/*.js')
  // shared/ 的「零环境依赖」四条文本判据删掉了：禁令本体在 `eslint.config.js`
  // （globals 收窄 + `no-restricted-imports`），能不能加载由上面那节「在裸 Node 里原生
  // import」判（shared/*.js 全在那份清单里），「不反向引用 main.js」由下面那节
  // 用构建器的 import 图判。批次 6d，docs §8.37。
  // 单源的真正意义：**判据和词表本身只能有一处**。
  // 这里按算法的关键行 / 词表的字面量找第二份实现 —— 抄一份过去一定会带上这行。
  // 只看去注释后的代码：文档里复述算法是应该的，不该被判成「有第二份」。
  //
  // 扫描范围是**全仓手写源码**（上面的 HANDWRITTEN_SOURCES），不再给每条判据配一份文件名单。
  // 名单有两个毛病：① 漏改不报错，只是那一条静默少扫一个文件（永久绿灯）；
  // ② 6.4 搬 worker、6.5 内联内部模块都得回来改它。§8.29 末尾记的那颗雷就是②：
  //   内部模块进 `lib/index.js` 之后，产物里**必然**有真源的副本，那是合法内联不是分叉，
  //   名单里写着 lib/index.js 就会一片红。现在产物按 banner 豁免，判据只有一条，
  //   而且「哪些算产物」由构建脚本决定（见下面那两条完整性检查），这里不重复维护。
  // 覆盖面反而变大：从每条 2–5 个文件变成 56 个手写源码文件全扫。
  const ALGORITHM_MARKERS = [
    ['门限状态机', 'noiseFloor * 0.95', 'src/shared/gate.js'],
    // UI 动作协议：`getUiActionSpec` 里那次 hasOwnProperty 查表。
    // 抄一份镜像一定会带上它 —— 而这条判据是安全边界，分叉一次就有一端形同虚设。
    ['UI 动作协议', 'hasOwnProperty.call(ACTION_SPECS', 'src/shared/ui-action-protocol.js'],
    // 配置枚举词表：一份词表就是「哪些值合法」这件事本身。
    // 抄的那一瞬间一定是一致的，之后加一个取值只改一端 —— sovitsUrl 那次漂移就是这么来的。
    // 用字面量而不是变量名做标记：换了名字重新抄一份也照样能抓到。
    ['配置词表（TTS 引擎）', "'online', 'local', 'neural', 'sovits'", 'src/shared/config-vocab.js'],
    ['配置词表（识别语言）', "'auto', 'zh', 'en', 'yue', 'ja', 'ko'", 'src/shared/config-vocab.js'],
    // 配置字段规则（3.3b）：默认值与长度上限也各自只许有一处字面量。
    // 这两条抓的是「搬家搬回去」——默认值一旦重新出现在宿主入口或客户端，
    // 就等于恢复了「加一个配置项要改四处」的老局面。
    ['配置默认值', "def: 'sensevoice'", 'src/shared/config-spec.js'],
    ['配置字符串上限', 'maxLen: 1024', 'src/shared/config-spec.js'],
    // a11y 可见性判据（第 4 步 4.1）：「什么算看得见的元素」只能有一份答案。
    // 拍快照和执行动作（resolve）共用这个判据，分叉一次就会出现
    // 「模型点到了快照里根本看不见的元素」这种只能在真机上发现的问题。
    ['a11y 可见性判据', 'el.offsetParent === null', 'src/client/dom/a11y-bridge.js'],
    // 播放上下文的采样率阶梯（第 4 步 4.2）：「先不带参数建，再逐级退化」这件事只能有一处。
    // 谁在别处又写一个 `sampleRate: 48000`，就等于把「蓝牙耳机上一句都不出声」那个坑重新挖回来，
    // 而且是从**另一个调用点**挖的 —— 出问题更难找。
    ['播放上下文采样率阶梯', 'new Ctx({ sampleRate: 48000 })', 'src/client/dom/playback-core.js'],
    // 快捷键的「修饰键必须精确一致」（第 4 步 4.3）：这条是两个语音入口不互相误触的唯一保证。
    // 抄一份到别处（比如以后给浮层再加一条监听）就会出现「同一个按键开了两次麦」。
    // 注：宿主原生 helper（lib/global-hotkey-helper.js）比较的是 uiohook 的修饰键位掩码，
    // 事件来源和取值方式都不是 KeyboardEvent，本条标记不参与那条链路的归并。
    // 4.3b 改了写法（别名先归一再比），标记跟着换成新的关键行。
    ['快捷键修饰键精确匹配', 'pressed[name] !== wanted.has(name)', 'src/client/pure/shortcut.js'],
    // 修饰键词表（第 4 步 4.3b）：「Control 该不该按下 ctrlKey」这个问题只有三条链路要答
    // （窗口内匹配、a11y 主动派发、宿主系统级 helper），前两条现在查同一张表。
    // 用字面量而不是变量名做标记：换名字重抄一份也照样抓得到。
    // helper 那张表的值是位掩码（`option: MOD_ALT`），这条字面量抓不到它 ——
    // 归并 helper 是单独一轮（§8.15 末尾），不是这条标记漏了。
    ['修饰键词表', "option: 'alt',", 'src/shared/key-modifiers.js'],
    // 修饰键位掩码表（第 4 步 4.3c）：「这个修饰键在 Win32 里占哪一位」是宿主 helper
    // 独有的知识，只许它一处知道。「哪些写法算这个键」不在这条判据里 —— 那批字
    // 由 shared 的写法名单现取，抄一份位掩码表就等于把写法名单也抄了一份回去。
    ['修饰键位掩码表', 'ctrl: MOD_CONTROL', 'src/host/global-hotkey-helper.js'],
    // 具名键词表（第 4 步 4.3d）：「这串字是哪个键、三个环境各填什么值」只许有一份。
    // 标记取表里最不可能被顺带写出来的那一条：空格的 DOM 真值是一个空格字符，
    // 而 uiohook 键名和 Win32 虚拟键码并排在同一条目里 —— 谁另抄一张表就一定带上它。
    // 为什么盯这一条：分叉的表现是「窗口里按得出、切到别的应用按不动」（与 4.3b 同类），
    // 而且三条链路各自看起来都没错，只有真机能复现。
    ['具名键词表', "space: { dom: ' ', native: 'Space', win: 0x20 }", 'src/shared/key-names.js'],
    // 线性重采样的核心那一步（第 4 步 4.4a）：客户端是「把音频变成 16k」的唯一出口，
    // 抄一份到采集点旁边就会出现「两处采样率不一致、识别时快时慢」这种只能真机发现的问题。
    // 标记取算法本身（比例怎么算）而不是函数名：改名重抄也抓得到。
    ['线性重采样到 16k', 'const ratio = from / TARGET_SAMPLE_RATE', 'src/client/pure/resample.js'],
    // 开麦约束（第 4 步 4.4b）：「向设备要什么样的音频」是采集契约的一部分。
    // 搬动前 composer 与浮层各抄一份字面量 —— 抄的那一瞬间一致，之后改一端就分叉：
    // 一个入口要 16k 直通、另一个靠重采样，表现为「同一个设备，两个入口识别质量不一样」。
    // 标记取三项音频处理里最不会被顺带写出来的那一项。
    ['开麦约束（单声道 16k + 回声消除）', 'echoCancellation: true', 'src/client/dom/mic-device.js'],
    // 「拿到流 ≠ 拿得到声音」这条判据（第 4 步 4.4b）：只许有一处。
    // 浮层那条链路本来就没有它，是靠这轮的单源化才有补上的入口（补不补是行为决策，见 §8.17）；
    // 标记的作用是让「在某个调用点手写一遍 readyState 判断」重新变成可见动作。
    ['音频轨道就绪判据', "track.readyState === 'ended'", 'src/client/dom/mic-device.js'],
  ]

  // 「产物豁免」本身要能被审计，否则这条规则会变成后门：
  // 谁往手写文件顶上补一行「构建产物，勿手改」就能让抄出去的那份躲过扫描。
  // 判据用构建脚本的声明当权威：banner 与「脚本宣布的产物」必须互相吻合。
  // lib/client.js 归 build-client.mjs 管（它只产这一个文件，路径写在脚本里），
  // 宿主侧产物由 HOST_ENTRIES 决定 —— 6.5 往里加入口，这里不用改。
  const DECLARED_ARTIFACTS = ['lib/client.js', ...HOST_ENTRIES.map((e) => e.out)].sort()
  for (const f of ARTIFACT_FILES) {
    check(`带 banner 的 ${f} 确实在构建脚本的产物名单里`,
      DECLARED_ARTIFACTS.includes(f),
      '手写源码想逃过反分叉扫描，只要往头部加一行 banner —— 这条拦住它')
  }
  for (const f of DECLARED_ARTIFACTS) {
    check(`产物 ${f} 头部有 banner（豁免判据成立的前提）`, isBuildArtifact(f),
      '构建脚本没写 banner，或产物被手改过头部')
  }
  check('反分叉扫描真的扫到了手写源码', HANDWRITTEN_SOURCES.length >= 40,
    `实际 ${HANDWRITTEN_SOURCES.length} 个文件 —— 目录结构变了，这条检查要跟着改`)

  for (const [what, marker, home] of ALGORITHM_MARKERS) {
    // 先确认标记**确实**在真源里：真源被改名或重构后这条判据会一起消失，
    // 那时 holders 恒为空，检查就变成一颗永久绿的假绿灯。
    check(`${what}的关键行确实在 ${home}`,
      stripComments(readRepo(home)).includes(marker),
      '真源里找不到这条判据 —— 标记或路径要跟着改')
    // 真源若本身成了产物，这条判据就只剩「产物里有这行」——那是构建的结果，
    // 守住它的是产物同步检查而不是这里。6.5 把 helper 搬进 src/host 时 home 要跟着改。
    check(`${what}的真源 ${home} 是手写源码`, !isBuildArtifact(home),
      '真源被内联进产物了 —— 把 home 指向 src/ 里那份原始文件')
    const holders = HANDWRITTEN_SOURCES
      .filter((f) => f !== home && stripComments(readRepo(f)).includes(marker))
    check(`${what}的实现只有 ${home} 一处`, holders.length === 0,
      holders.length ? `另有一份在：${holders.join(', ')}` : '其余位置只做转发/注入')
  }
}

console.log('\n引用方向单向（pure/、dom/、shared/ 都不许反过来 import main.js）')
{
  // 「单向」这件事不该由我自己正则解析 import 语句来判 —— 构建器已经把这些边解析出来了。
  // 于是这一节改读 esbuild 的 metafile（test/helpers/module-graph.mjs）：三个目录里每个模块，
  // 沿**真解析出来的** import 边走一遍，闭包里出现 main.js 就是反向引用。
  //
  // 删掉的是原来那一整段「扫 main.js 的顶层符号名 + 扫每个文件的标识符再比字符串」：
  // 它防的是 @bundle 内联时代「代码挨在同一个作用域里，随手引用照样能跑」。第 5 步换成真 ESM
  // 之后，那种引用要么是**没绑定的标识符**（`no-undef` 当场报，见 test/no-undef.test.mjs），
  // 要么必须写成 import 语句（就是本节这条）。两种都有更强的判据，
  // 留着文本比对只会带来误报（本轮它已经因为函数内部的局部名红过一次）。
  const candidates = [
    ...rendered.used.map((x) => `src/client/${x}`),
    ...SHARED_FILES.map((x) => `src/shared/${x}`),
  ].sort()
  const { edges, external, error } = await buildModuleGraph([...candidates, 'src/client/main.js'])
  check('构建器解析得到 import 图（这一节的判据有真边可比）',
    error === null && edges.size > 0, error ?? `只解析到 ${edges.size} 个模块`)
  const backwards = candidates.filter((rel) => reachable(rel, edges).has('src/client/main.js'))
  check(`${candidates.length} 个模块的 import 闭包里没有 main.js`, backwards.length === 0,
    backwards.join(', '))
  // 这三类目录带外部包依赖 = 总有一侧装不上（浏览器产物里没有 node:*，宿主侧不认裸 react）。
  // 边由构建器给，不是扫文本：动态 import、别名、换行写法都算得进去。
  const externals = []
  for (const rel of candidates) {
    for (const name of external.get(rel) ?? []) externals.push(`${rel} → ${name}`)
  }
  check('这三类目录没有外部包依赖（react / node:* 都不许）', externals.length === 0,
    externals.join(' | ') || '一个外部依赖都没有')
}

console.log('\n产物能按宿主的方式执行（load → factory(require)）')
{
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    Buffer, URL, TextEncoder, TextDecoder, process, AbortController,
    EventSource: function () {},
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' }),
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  let def = null
  sandbox.__ModuleLoader__ = { load: (d) => { def = d } }
  let ok = true
  let reason = ''
  try {
    vm.runInContext(bundled, sandbox, { filename: 'lib/client.js' })
    if (!def) { ok = false; reason = '没有调用 __ModuleLoader__.load' }
    else if (def.id !== 'dsh-voice-typing') { ok = false; reason = 'id = ' + def.id }
    else {
      const react = new Proxy({ createElement: () => null, Fragment: 'F' }, {
        get: (t, p) => (p in t ? t[p] : () => undefined),
      })
      const exp = def.factory((n) => {
        if (n === 'react') return react
        throw new Error('unexpected require: ' + n)
      })
      const keys = Object.keys(exp)
      ok = keys.includes('apply') && keys.includes('inject') && typeof exp.__test === 'object'
      reason = ok ? '' : `导出面异常：${keys.join(',')}`
    }
  } catch (e) {
    ok = false
    reason = e.message
  }
  check('factory(require) 能执行并返回 apply/inject/__test', ok, reason)
}

console.log('\n宿主侧产物（src/host/ → lib/index.js + lib/*-worker.js，第 6.4 / 6.5 步）')
{
  const host = await renderHost()
  for (const b of host.built) {
    const current = fs.readFileSync(path.join(root, b.out), 'utf8')
    check(`${b.out} 与 src/host/ 一致（等价于 check:host，不写盘）`, current === b.content,
      '改了 src/host/ 之后要跑 npm run build:host')
    check(`${b.out} 有生成说明头`, b.content.startsWith('/* 构建产物，勿手改'))
    // 产物里残留相对 import = 它还得靠包外的文件才能跑，
    // 正是 M8 / §8.28 要消掉的那件事（发布物必须自包含）。
    const leftover = [...b.content.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)].map((m) => m[1])
    check(`${b.out} 自包含（没有残留相对 import）`, leftover.length === 0, leftover.join(', '))
  }
  const again = await renderHost()
  check('宿主侧生成逻辑幂等（两次计算字节一致）',
    again.built.map((b) => b.content).join('|') === host.built.map((b) => b.content).join('|'))

  // 孤儿文件守卫（src/host 下没进任何入口 import 图的文件 = 写了但永远不会被执行）
  // 现在由构建工具自己判：`scripts/build-host.mjs --check` 会把它算出来的 import 图
  // 和 src/host 的文件清单比，对不上就非 0 退出（批次 6l，docs §8.46）。
  // 这里因此不再自己扫目录 —— 判的是**真命令的真退出码**。
  // 为什么搬过去更好：算 import 图的人本来就知道谁没进图；测试再扫一遍只是复刻同一件事，
  // 还得为「扫描本身有没有扫到东西」多养一条防空转的判据（这两条就是这么从源码文本清零的）。
  let checkExit = 0
  let checkText = ''
  try {
    checkText = execFileSync('node', ['scripts/build-host.mjs', '--check'],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    checkExit = error.status ?? -1
    checkText = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}${error.message}`
  }
  const checkLines = checkText.trim().split('\n')
  check('npm run check:host 那条真命令以 0 退出（产物同步 + 无孤儿模块一起判）',
    checkExit === 0, `exit=${checkExit} ${(checkLines[checkLines.length - 1] ?? '').trim()}`)
  // 那条命令必须真的报出了孤儿检查（只报「已是最新」就说明检查被删了而这里不会红）。
  check('check:host 的输出里有「无孤儿」那一行', /无孤儿/.test(checkText), checkLines.join(' | '))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
