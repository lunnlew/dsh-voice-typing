/**
 * 单元测试：文案词典本身（`src/client/pure/i18n.js`）+ 开麦原因码怎么翻成文案。
 *
 * 来源（docs/architecture-modernization.md §8.34 批次 0）：
 *   原来这六条是散在 `test/read-aloud-stop.test.mjs` / `test/listening-ready.test.mjs` 里的
 *   **形状断言** —— 对拍平的客户端源码文本做正则：
 *     check('有 stoppedSpeaking 文案', /stoppedSpeaking: '已停止'/.test(cli))
 *     check('英文文案也有', /stoppedSpeaking: 'Stopped'/.test(cli))
 *     check('「ttsFailed」是短词', new RegExp("ttsFailed: '朗读失败'").test(cli))
 *   三个毛病：
 *     1. 只抽查 2~3 个 key，其余 180+ 个键漏了没人管（中英不对称就静静掉一条英文文案）；
 *     2. 钉的是「写法」而不是「内容」：把 `stoppedSpeaking: '已停止'` 改成双引号、
 *        或把值挪进别的对象，正则就红，可用户看到的东西一个字都没变；
 *     3. 反过来也漏：改了**别的** key 的中文而英文忘了改，这几条照样绿。
 *
 *   现在直接 import 那个纯字典（`i18n.js` 头注释就写了「Node 里可原生 import」），
 *   判据落在**数据**上：键集合对称、状态行短词够短、配了长说明的短/长要成对。
 *   189 个 key 全覆盖，而不是抽查 3 个。
 *
 * 批次 5a 又并进来一批（§8.34）：`test/config-ui.test.mjs` 里那 6+1 条「设置面板文案
 *   得含住某个信息点」的正则（`/开启后自动打开麦克风/.test(CLIENT_SRC)` 那种）。
 *   它们判的内容是对的，只是钉在源码写法上 —— 见 `PANEL_COPY_RULES` 的注释。
 *
 * 批次 18（§8.60）再并一路：开麦前宿主回的那四个**原因码**（`src/shared/asr-readiness.js`）
 *   到界面文案的映射。宿主从这轮起不出句子了，那句话只有客户端字典能给，
 *   于是两张表都要判：词表里每个码在字典里有中英语句（判据 9），
 *   查表那条路认不出码时必须走兜底、不许把宿主原文显示出来（文件末尾那节）。
 *
 * 批次 19（§8.61）把同一套判据搬到系统级热键：helper 报的十三个**原因码**
 *   （`src/shared/hotkey-reasons.js`）→ 判据 10 管字典里有没有句，
 *   文件末尾「热键原因码怎么翻成文案」那节管取词会不会取错。
 *   这一族刻意有码共用一句（用户能做的事一样），所以判的是覆盖，不是字面。
 *
 * 批次 20（§8.62）把同一套判据搬到「保存设置没存进去」那行红字：宿主 400 里的
 *   二十个**校验码**（`src/shared/config-error-codes.js`）→ 判据 11 管字典里有没有句、
 *   还管 35 个配置键的中英**字段名**都在（那一行的前半截也是字典出的），
 *   文件末尾「配置校验码怎么翻成文案」那节管取词与参数：认识的码走表里的键、
 *   不认识的走兜底，句子里的允许值/区间/长度上限一律从 `src/shared/config-spec.js`
 *   现取 —— 这一族的入参里根本没有宿主原文，「宿主改不了界面那句话」是结构上断掉的。
 *
 * 批次 22（§8.64）把同一套判据搬到设置面板那两行「快捷键不合法」红字。这一族和前三族的
 *   差别是**发码的和查表的都在客户端**（`pure/shortcut.js` 改前五条句子直接写死中文），
 *   所以词表不住 `src/shared/`，参数也不用协议传 —— 判据 12 管字典覆盖，
 *   外加这一族独有的一条：句子里的 `{占位符}` 必须都能从校验层发出去的参数里取到值
 *   （占位符填不上 = 用户看到字面量 `{modifier}`；参数没人用 = 白带）。
 *   末尾「快捷键校验码怎么翻成文案」那节管查表与兜底，并顺手把**客户端自己那支兜底取词**
 *   （`zhTranslate`）怎么填参数判住 —— 它以前是 `(key) => zh[key] ?? key`，第二个参数丢掉。
 *
 * 批次 22-2（§8.65）搬的是**面板自己写死的那些字**：下拉选项的名字（引擎、格式、空闲释放档位、
 *   说话人序号）、输入框占位符、「（需先下载 …）」那半截、环境与显卡的标签，
 *   以及原先住在 `pure/i18n.js` 里的两张**纯中文展示名表**（语言六码、音色 24 个短名）。
 *   这一族和前五族的差别是它没有「原因码」：写死的就是给用户看的那句话，
 *   所以词表就是字典本身，判据落在「取词函数走到的每个键中英都在」（判据 13）
 *   和「这些句子不许有填不上值的占位符」（判据 14，参数由**跑真函数**收集，不手抄）。
 *   判据 15 是这一批独有的一条：英文侧不许夹汉字 —— 只有两个键例外，它们的中文就是内容本身
 *   （词表示例「正确=错误」、唤醒词的中文例子），白名单写死在 `EN_HAN_ALLOW_KEYS`。
 *
 * 批次 22-3-2（§8.67）搬的是「运行环境自检」那四行：宿主的 `/tts/env` 从前每行直接回一句
 *   中文（`可用（Windows PowerShell 5.1），默认发音人：…`），面板原样拼上去，于是英文界面
 *   那四行整片是宿主写的中文。现在宿主回**原因码 + 参数**（`src/shared/tts-env-reasons.js`
 *   十四个码），句子由字典出。这一族和前六族比多两件要判的事：
 *     1. 每句要填的参数名是**协议**（宿主按 `TTS_ENV_REASON_PARAMS` 收集），所以判据 19 要求
 *        中英两句里的 `{占位符}` 集合与该码的参数表**完全相等** —— 多写填不上、少写就是白收；
 *     2. 引擎行名也在这一族里（`ENV_ENGINE_LABEL_KEYS` 按 `id` 出名字，宿主的 `label` 不再进界面），
 *        加上 `{runtime}` 那个契约值还要再过一次 `envRuntimeLabel`（一个词也是话）。
 *   判据 18 管覆盖（码 / 引擎 id / 四句兜底），末尾「环境自检那几行怎么取词」那节管取错与兜底。
 *
 * 批次 22-4-2（§8.71）搬的是「下载模型失败」那一行。它和前一族同一个形状（宿主回码、字典出句子），
 *   差别在**这一族从前有两种相反的毛病**（§8.68 裁定 4）：请求被当场拒绝时面板把宿主路由层那句原文
 *   直接 `setStatus` 上界面（原文泄漏）；下载转到后台之后，`model-error` 事件里带了具体原因，
 *   面板却 `void parseEnvelope(event)` 整片丢弃、只留「下载失败」（原因丢失）。
 *   判据 20 管十个码的中英覆盖与两句兜底，判据 21 是判据 19 的翻版：
 *   `{占位符}` 集合必须与该码在 `MODEL_DOWNLOAD_REASON_PARAMS` 里的参数表**完全相等**。
 *   末尾「下载失败那一行怎么取词」那节管取错与兜底，并判住一件这一族独有的事：
 *   「没带码」分两种 —— 旧宿主根本没这个字段（走兼容那句）与码不在词表里（走读不出来那句）。
 *
 * 判据抽成纯函数 `evaluate(zh, en, hotkeyKeys, configKeys)`，于是文件末尾能用**构造出来的字典
 *   与构造出来的映射表**测它的范围：状态行名单外的 key 变长不该红，整句改写而信息点还在不该红。
 * 原来那一组「把字典改坏、确认对应判据翻红」的自证变异，批次 6c 起删了（§8.34）。
 */
import {
  zh,
  en,
  interpolate,
  zhTranslate,
  LANGUAGE_LABEL_KEYS,
  VOICE_LABEL_KEYS,
  TTS_ENGINE_OPTION_KEYS,
  MODEL_LABEL_KEYS,
  languageLabel,
  voiceLabel,
  ttsEngineOptionLabel,
  idleReleaseLabel,
  modelLabel,
  ENV_ENGINE_LABEL_KEYS,
  envEngineLabel,
  envRuntimeLabel,
} from '../src/client/pure/i18n.js'
import { MODELS, TTS_MODELS } from '../src/host/model-catalog.js'
import { ASR_READY_REASON_VALUES } from '../src/shared/asr-readiness.js'
import { ASR_READY_REASON_KEYS, asrReadyReasonText } from '../src/client/pure/asr-ready-text.js'
import { HOTKEY_REASON_VALUES } from '../src/shared/hotkey-reasons.js'
import { HOTKEY_REASON_KEYS, hotkeyReasonText } from '../src/client/pure/hotkey-reason-text.js'
import { CONFIG_ERROR_REASON_VALUES } from '../src/shared/config-error-codes.js'
import { CONFIG_SPEC_KEYS, specFor } from '../src/shared/config-spec.js'
import { ASR_LANGUAGES, TTS_ENGINES, MAX_WORDS, MAX_WORD_CHARS } from '../src/shared/config-vocab.js'
import {
  CONFIG_ERROR_KEYS,
  configErrorText,
  configFieldLabel,
} from '../src/client/pure/config-error-text.js'
import { SHORTCUT_ERROR_REASON_VALUES, validateShortcut } from '../src/client/pure/shortcut.js'
import { SHORTCUT_ERROR_KEYS, shortcutErrorText } from '../src/client/pure/shortcut-error-text.js'
import { TTS_ENV_REASON_VALUES, TTS_ENV_REASON_PARAMS } from '../src/shared/tts-env-reasons.js'
import {
  TTS_ENV_REASON_KEYS,
  ttsEnvReasonText,
} from '../src/client/pure/tts-env-reason-text.js'
import {
  MODEL_DOWNLOAD_REASON_VALUES,
  MODEL_DOWNLOAD_REASON_PARAMS,
} from '../src/shared/model-download-reasons.js'
import {
  MODEL_DOWNLOAD_REASON_KEYS,
  modelDownloadReasonText,
} from '../src/client/pure/model-download-reason-text.js'

/**
 * 每个快捷键原因码**实际**带出去的参数（批次 22，判据 12 要用）。
 *
 * 来源是跑真校验拿到的返回值，不是在这里手抄一份：手抄的话「校验层少发一个参数」
 * 这条漂移就判不出来。取五个输入把五条失败路径各触发一次（`Ctrl+ ` 与 `v` 同一个码，不用重复）。
 */
const SHORTCUT_PARAMS_BY_CODE = (() => {
  const byCode = {}
  for (const combo of ['', 'v', 'Shift+V', 'Foo+V', 'Ctrl+Shift+V']) {
    const result = validateShortcut(combo)
    if (result.ok) continue
    byCode[result.reason] = { ...(byCode[result.reason] ?? {}), ...(result.params ?? {}) }
  }
  return byCode
})()

/**
 * 面板的选项/标签类文案键（批次 22-2，§8.65）。
 *
 * 这一族不是原因码，是**面板直接找字典要的那句话**：引擎选项、输出格式、空闲释放档位、
 * 说话人序号、环境标签、输入框占位符。名单是人从 `voice-settings-section.js` 的 `t(...)` 调用点
 * 抄下来的 —— 「面板引用了哪些键」在字典里查不出来，和 `STATE_LINE_KEYS` 同一个性质。
 * 真正的引用检查在 `test/client-behavior.test.mjs` 的渲染树那节做（那里能看到树里的每个字符串）。
 */
const PANEL_OPTION_KEYS = [
  'wordsPlaceholder',
  'liveAsrStreamNeedsOption',
  'engineOptionOnline',
  'engineOptionNeural',
  'engineOptionLocal',
  'engineOptionLocalUnsupported',
  'engineOptionSovits',
  'engineOptionUnknown',
  'idleReleaseNever',
  'idleReleaseInMinutes',
  'idleReleaseInHours',
  'neuralSpeakerOption',
  'envPlatformLabel',
  'envGpuLabel',
  'envGpuNone',
  'localVoiceDefault',
]

/**
 * 四张「值 → 字典键」展示名表的默认引用（判据 13 要用可破坏的副本，所以走参数）。
 *
 * `model` 那一张的**定义域来自宿主目录本身**（`MODEL_TIERS`），不是测试里抄的名单 ——
 * 目录加一档而字典没跟上，判据 16 当场红。
 */
const PANEL_TABLES_DEFAULT = Object.freeze({
  lang: LANGUAGE_LABEL_KEYS,
  voice: VOICE_LABEL_KEYS,
  engine: TTS_ENGINE_OPTION_KEYS,
  model: MODEL_LABEL_KEYS,
})

/**
 * 环境自检的三张表（批次 22-3-2，判据 18/19 要用可破坏的副本，所以走参数）。
 *
 * `reason` 的定义域来自 `src/shared/tts-env-reasons.js`（宿主发码那一份词表），
 * `engine` 的定义域来自 `src/shared/config-vocab.js` 的 `TTS_ENGINES`：
 * 两边都不是测试里抄的名单 —— 宿主加一个码或加一个引擎而字典没跟上，判据当场红。
 * `params` 也走参数：它是「这个码该带哪些值」的协议，判据 19 拿它当尺子，
 * 而范围反例要能构造一张改坏的协议，才测得出那条判据有没有牙。
 */
const ENV_TABLES_DEFAULT = Object.freeze({
  reason: TTS_ENV_REASON_KEYS,
  engine: ENV_ENGINE_LABEL_KEYS,
  params: TTS_ENV_REASON_PARAMS,
})

/**
 * 模型下载失败的两张表（批次 22-4-2，判据 20/21 要用可破坏的副本，所以走参数）。
 *
 * 和环境自检那一族同一个规矩：`reason` 与 `params` 的定义域都来自
 * `src/shared/model-download-reasons.js`（宿主发码那一份词表与协议），
 * 不是测试里抄的名单 —— 宿主加一个码而字典没跟上，装机上就是一句生硬的兜底文案，
 * 所以必须在这里判。`params` 走参数还有一层：判据 21 拿它当尺子，
 * 范围反例要能构造一张改坏的协议，才测得出那条判据有没有牙。
 */
const DOWNLOAD_TABLES_DEFAULT = Object.freeze({
  reason: MODEL_DOWNLOAD_REASON_KEYS,
  params: MODEL_DOWNLOAD_REASON_PARAMS,
})

/**
 * 模型目录里真有的那些档位（id + 中英两份名字），批次 22-3-1（§8.66）。
 *
 * 读的是 `src/host/model-catalog.js` 的数据本身：判据 17 要比的「字典那句和目录那句
 * 是不是同一句」得有个**另一端**可比，抄字面量就变成「测试和字典一起改」。
 */
const MODEL_TIERS = [...MODELS, ...TTS_MODELS]
  .map((tier) => ({ id: tier.id, label: tier.label, labelEn: tier.labelEn }))

/**
 * 英文侧允许含汉字的键（批次 22 起的白名单，判据 15）。
 *
 * 这两句的中文**就是内容**：`wordsHint` 要演示词表的「正确=错误」写法，
 * `wakeWordHint` 要举中文唤醒词的例子。除此之外英文文案里出现汉字，
 * 基本可以断定是「往英文侧抄了中文」这个回归 —— 切到英文界面看到半句中文。
 * 判的是汉字，不是全角标点：`（）：` 是排版，中英两边都在用（见 §8.65 的裁定）。
 */
const EN_HAN_ALLOW_KEYS = ['wordsHint', 'wakeWordHint']

/**
 * 面板那几个取词函数**实际**发出去的（键 → 参数）。
 *
 * 和 `SHORTCUT_PARAMS_BY_CODE` 同一个办法：喂给它各种输入**跑真函数**，
 * 用一支记录用的 `t` 把 `(key, params)` 收下来。手抄一份的话，
 * 「函数里把参数名写错了」「某个分支根本发不出参数」这两类漂移判不出来。
 * 覆盖的分支：六个语言码 + 词表外的语言、24 个音色短名 + 词表外、四个引擎 id
 * + local 在支持/不支持两种机器上 + 脏 id、空闲释放的全部档位（含非法值）。
 */
const PANEL_PARAMS_BY_CODE = (() => {
  const byKey = {}
  const record = (key, params) => {
    if (typeof key !== 'string') throw new Error(`取词函数发出了非字符串的键：${String(key)}`)
    byKey[key] = { ...(byKey[key] ?? {}), ...(params && typeof params === 'object' ? params : {}) }
    return key
  }
  for (const code of [...ASR_LANGUAGES, 'fr', '', 'ZH']) languageLabel(code, record)
  for (const name of Object.keys(VOICE_LABEL_KEYS)) voiceLabel(name, record)
  for (const name of ['not-a-voice', '']) voiceLabel(name, record)
  for (const engine of TTS_ENGINES) {
    ttsEngineOptionLabel(engine, record)
    ttsEngineOptionLabel(engine, record, false)
  }
  ttsEngineOptionLabel('no-such-engine', record)
  for (const minutes of [0, 5, 10, 30, 60, 120, '', -1, 'abc']) idleReleaseLabel(minutes, record)
  for (const tier of MODEL_TIERS) modelLabel(tier.id, record)
  for (const id of ['no-such-model', '']) modelLabel(id, record)
  return byKey
})()

/**
 * 环境自检这一族**实际**发出去的（键 → 参数），批次 22-3-2（§8.67）。
 *
 * 和前六族同一个办法：把码喂给真的取词函数（`ttsEnvReasonText` / `envEngineLabel` /
 * `envRuntimeLabel`），用记录用的 `t` 把 `(key, params)` 收下来。
 * 这里给宿主那一份参数**装了个样子**（`SAMPLE_PARAMS`：只有名字要紧，判据看的是名字），
 * 名字取自 `TTS_ENV_REASON_PARAMS` 那份协议 —— 于是这条链判的是
 * 「函数收得下协议里的名字吗、句子用得上函数发出来的东西吗」，而不是「协议本身对不对」
 * （协议对不对由 `test/tts-env-check.test.mjs` 拿真宿主的返回值逐码核对）。
 * `{runtime}` 给 native 与 wasm 两种值各跑一次，两个契约值都得走到。
 */
const SAMPLE_PARAMS = {
  version: '5.1.19041.1',
  voice: 'Tingting',
  bin: '/usr/bin/espeak-ng',
  platform: 'freebsd',
  count: '3',
  model: 'vits-melo-zh_en',
  runtime: 'native',
}

const ENV_PARAMS_BY_CODE = (() => {
  const byKey = {}
  const record = (key, params) => {
    if (typeof key !== 'string') throw new Error(`环境自检的取词函数发出了非字符串的键：${String(key)}`)
    byKey[key] = { ...(byKey[key] ?? {}), ...(params && typeof params === 'object' ? params : {}) }
    return key
  }
  for (const code of TTS_ENV_REASON_VALUES) {
    const given = {}
    for (const name of TTS_ENV_REASON_PARAMS[code] ?? []) given[name] = SAMPLE_PARAMS[name]
    ttsEnvReasonText(code, record, given)
    if ((TTS_ENV_REASON_PARAMS[code] ?? []).includes('runtime')) {
      ttsEnvReasonText(code, record, { ...given, runtime: 'wasm' })
    }
  }
  for (const engine of TTS_ENGINES) envEngineLabel(engine, record)
  for (const id of ['no-such-engine', '']) envEngineLabel(id, record)
  for (const kind of ['native', 'wasm', 'CUDA', '']) envRuntimeLabel(kind, record)
  return byKey
})()

/**
 * 参数由**面板的 JSX**发出去的那两个键（跑不到，只能自己声明；判据 14 的另一半）。
 *
 * 这一半的 producer 是 `voice-settings-section.js` 里的 `t('neuralSpeakerOption', {index})`
 * 那种调用点，单元测试这里 import 不到组件。所以这里声明的是「面板说要发什么」，
 * 它管不住「面板真的发了什么」—— 那一半由 `test/client-behavior.test.mjs`
 * 「面板·选项文案」那节在渲染树上判（树里出现字面量 `{index}` 就会红）。
 */
const PANEL_PARAMS_BY_KEY = {
  ...PANEL_PARAMS_BY_CODE,
  ...ENV_PARAMS_BY_CODE,
  liveAsrStreamNeedsOption: { model: 'zipformer2-zh' },
  neuralSpeakerOption: { index: '1' },
}

/**
 * 状态行短词的名单：这几个出现在按钮旁边的状态行里（不是设置面板的标签）。
 * 名单是**人给的**，因为「谁住在状态行上」是布局决定，字典里查不出来；
 * 布局本身要装机才量得到（见 §8.34 的端到端档），这里守的是「别往状态行塞长句」这一半。
 */
const STATE_LINE_KEYS = [
  'listening', 'speaking', 'stoppedSpeaking', 'modelLoading', 'ttsFailed',
  'micDenied', 'micUnsupported', 'micStarting',
]

/**
 * 界面上真引用到的 key（原来散在 read-aloud-stop / listening-ready / state-reset 里
 * 用 `/stoppedSpeaking: '已停止'/.test(cli)` 这种正则逐个查的那批）。
 * 这里只要求**两边都在**，不钉死字面值 —— 字面值改了不算回归，漏了英文才算。
 */
const REQUIRED_KEYS = [
  'listening', 'speaking', 'stoppedSpeaking',
  'stopSpeaking', 'stopSpeakingHint',
  'modelLoading', 'modelLoadingDetail', 'micFailed',
  'ttsFailed', 'ttsFailedDetail',
]

/**
 * 不许出现「具体时长」的 key（批次 9，§8.50）。
 *
 * 名单是**人给的**：判的是「这句话是对用户的时长承诺」，
 * 而「承诺 vs 说明」在字典里查不出来（`silenceMs` 那种讲参数取值的数字不在名单里，
 * 它不是「要等多久」）。加新的等待类文案时把 key 添进来。
 */
const NO_DURATION_CLAIM_KEYS = ['modelLoading', 'modelLoadingDetail']

/**
 * 设置面板文案的**语义要点**（§8.34 批次 5a）。
 *
 * 来源：原来这 7 条是 `test/config-ui.test.mjs` 里对拍平源码文本做的正则，
 * 例如 `/开启后自动打开麦克风/.test(CLIENT_SRC)`。判的东西没错（文案丢了要点就是误导用户），
 * 但钉的是「这句话在源码里以这种写法出现」：i18n 搬一次目录、引号换个风格、
 * 甚至只是把整句改得更通顺，都会红，而用户看到的信息一个字都没少。
 *
 * 现在判**数据**：这条文案（`zh[key]` / `en[key]`）里必须含住这几个片段。
 * 片段选的是**信息点**而不是整句 —— 改写句子不算回归，删掉信息点才算。
 * 每条都要求中英两侧同时命中（只改一边 = 另一边界面漏信息，原来那几条正则抓不到）。
 */
const PANEL_COPY_RULES = [
  {
    key: 'wordsHint',
    what: '词表 hint 说明「热词」只有 Zipformer2 支持',
    zh: ['热词', 'Zipformer2'],
    en: ['hotword', 'Zipformer2'],
  },
  {
    key: 'globalHotkeyHelperHint',
    what: '系统级热键 helper 说清跨平台实现（Windows 子进程 / uiohook-napi + macOS 辅助功能）',
    zh: ['PowerShell', 'uiohook-napi', '辅助功能'],
    en: ['PowerShell', 'uiohook-napi', 'Accessibility'],
  },
  {
    key: 'globalShortcutHint',
    what: '全局快捷键文案给出 macOS 的 Cmd+Option+V 别名',
    zh: ['Cmd+Option+V'],
    en: ['Cmd+Option+V'],
  },
  {
    key: 'globalVoiceHint',
    what: '全局语音文案说明自动开麦待机 + 输入框麦克风会隐藏',
    zh: ['自动打开麦克风', '输入框麦克风会隐藏'],
    en: ['opens the mic automatically', 'composer mic is hidden'],
  },
  {
    key: 'wakeWordHint',
    what: '唤醒词文案说明 2 字按同音归一精确匹配 / ≥3 字容错 1 字',
    zh: ['2 个字', '3 个字以上', '同音字归一', '精确匹配', '允许 1 个字'],
    en: ['2-character', 'homophone normalization', 'recognition tolerance'],
  },
  {
    key: 'uiControlHint',
    what: 'AI 界面操控文案写清 a11y 边界（密码框禁止代填 / 多窗口只有最先响应者执行）',
    zh: ['密码框禁止代填', '多窗口时只有最先响应'],
    en: ['password fields are never filled', 'first responder'],
  },
]

/**
 * 「跨平台之后不许再声称只在 Windows」这一族文案的键（task-24 改的就是它们）。
 * 负向判据只扫这一族，不扫全字典：别处将来真要写「仅 Windows 10 以上」是合法信息，
 * 全字典禁用词会把合法文案判成回归（§8.34：判据不许把我编的约束当成项目的约束）。
 */
const CROSS_PLATFORM_KEYS = [
  'globalHotkeyHelper', 'globalHotkeyHelperHint',
  'globalShortcut', 'globalShortcutHint',
  'hotkeyStatusTitle', 'hotkeyStatusLabel', 'hotkeyStatusPlatform',
  'hotkeyStatusEnabled', 'hotkeyStatusDisabled', 'hotkeyStatusUnknown',
  'hotkeyStatusLoading', 'hotkeyStatusFailed', 'hotkeyStatusNeedsOverlay',
]

/** 平台独占的旧说法（大小写敏感：`windows only the first responder` 是另一句话）。 */
const WINDOWS_ONLY_CLAIMS = ['仅 Windows', 'Windows only']

/**
 * 全部判据。返回 [{ name, ok, detail }]，不打印 —— 打印由收尾那一轮统一做，
 * 文件末尾的范围反例也调它。
 * @param {object} dictZh 中文文案。
 * @param {object} dictEn 英文文案。
 * @param {object} [hotkeyKeys] 热键码→键的对照表（默认用真表；范围反例传一张改坏的进来）。
 * @param {object} [configKeys] 配置校验码→键的对照表（同上，范围反例用）。
 * @param {object} [shortcutKeys] 快捷键校验码→键的对照表（批次 22，同上）。
 * @param {object} [panelTables] 面板展示名的四张表 `{lang, voice, engine, model}`（批次 22-2，同上）。
 * @param {object} [envTables] 环境自检的两张表 `{reason, engine}`（批次 22-3-2，同上）。
 * @param {object} [downloadTables] 模型下载的两张表 `{reason, params}`（批次 22-4-2，同上）。
 * @returns {Array<{name: string, ok: boolean, detail: string}>}
 */
function evaluate(dictZh, dictEn, hotkeyKeys = HOTKEY_REASON_KEYS, configKeys = CONFIG_ERROR_KEYS, shortcutKeys = SHORTCUT_ERROR_KEYS, panelTables = PANEL_TABLES_DEFAULT, envTables = ENV_TABLES_DEFAULT, downloadTables = DOWNLOAD_TABLES_DEFAULT) {
  const out = []
  const add = (name, ok, detail = '') => out.push({ name, ok, detail })
  const zhKeys = Object.keys(dictZh)
  const enKeys = Object.keys(dictEn)

  // 0) 界面引用的 key 必须存在（缺一个 = 那个位置渲染出 undefined）。
  const missingZh = REQUIRED_KEYS.filter((k) => !(k in dictZh))
  const missingEn = REQUIRED_KEYS.filter((k) => !(k in dictEn))
  add(`界面引用的 ${REQUIRED_KEYS.length} 个 key 中文侧都在`, missingZh.length === 0, `缺：${missingZh.join(',')}`)
  add(`界面引用的 ${REQUIRED_KEYS.length} 个 key 英文侧都在`, missingEn.length === 0, `缺：${missingEn.join(',')}`)

  // 1) 中英对称：漏一种语言 = 切到英文界面时文案变成 undefined。
  add(`zh / en 键集合完全一致（各 ${zhKeys.length} 个）`,
    zhKeys.length === enKeys.length
    && zhKeys.every((k) => k in dictEn)
    && enKeys.every((k) => k in dictZh),
    `zh 独有：${zhKeys.filter((k) => !(k in dictEn)).join(',') || '无'}；`
    + `en 独有：${enKeys.filter((k) => !(k in dictZh)).join(',') || '无'}`)
  add('没有空文案（空串会让界面出现一块空白）',
    zhKeys.every((k) => String(dictZh[k]).trim() !== ''
      && (!(k in dictEn) || String(dictEn[k]).trim() !== '')),
    zhKeys.filter((k) => !String(dictZh[k]).trim() || (k in dictEn && !String(dictEn[k]).trim())).join(','))

  // 2) 状态行短词上限（中文按码点算，`…` 这种一个字符算一字）。
  for (const key of STATE_LINE_KEYS) {
    const short = dictZh[key]
    add(`「${key}」中文短词 ≤6 字`,
      typeof short === 'string' && [...short].length <= 6, JSON.stringify(short))
    const enShort = dictEn[key]
    add(`「${key}」英文短词 ≤3 词`,
      typeof enShort === 'string' && enShort.trim().split(/\s+/).length <= 3, JSON.stringify(enShort))
  }

  // 3) 配了长说明的短词：短/长要成对，且中英都配齐。
  //    注意**不是**每个短词都要配长说明 —— 「聆听中」「已停止」自解释，词典里就没有 Detail，
  //    硬要求会把我自己编的约束当成项目的约束（第一版就编错过这条）。
  const withDetail = STATE_LINE_KEYS.filter((k) => `${k}Detail` in dictZh)
  add(`抽查的短词里确实有配长说明的（别这条守卫空跑，当前 ${withDetail.length} 个）`,
    withDetail.length >= 3, withDetail.join(','))
  for (const key of withDetail) {
    add(`「${key}」的中英长说明都配齐`, `${key}Detail` in dictEn, '只配中文 = 英文界面悬停空白')
    add(`「${key}」的短词确实比它的长说明短`,
      [...dictZh[key]].length < [...dictZh[`${key}Detail`]].length,
      `${JSON.stringify(dictZh[key])} vs ${JSON.stringify(dictZh[`${key}Detail`])}`)
  }

  // 4) 停止朗读那次改动的专项：回执短词和按钮的长说明不能是同一句。
  add('「已停止」回执短于「停止朗读，并让这一轮不再朗读」的说明',
    [...dictZh.stoppedSpeaking].length < [...dictZh.stopSpeakingHint].length,
    `${dictZh.stoppedSpeaking} / ${dictZh.stopSpeakingHint}`)

  // 5) 短文案里不该嵌调试符号（长说明里允许：它就是要告诉用户去哪儿查）。
  {
    const suspicious = zhKeys.filter((k) => !k.endsWith('Detail') && !k.endsWith('Hint')
      && /__[A-Z_]{6,}__/.test(String(dictZh[k])))
    add('短文案里没有裸的调试符号（长说明里允许）', suspicious.length === 0, suspicious.join(','))
  }

  // 6) 设置面板文案的信息点（原来 6 条扫源码文本的正则，见 PANEL_COPY_RULES 注释）。
  for (const rule of PANEL_COPY_RULES) {
    for (const [lang, dict, fragments] of [['中文', dictZh, rule.zh], ['英文', dictEn, rule.en]]) {
      const value = dict[rule.key]
      const missing = typeof value === 'string'
        ? fragments.filter((needle) => !value.includes(needle))
        : fragments
      add(`「${rule.key}」${lang}侧：${rule.what}`, missing.length === 0,
        typeof value !== 'string' ? 'key 不存在' : `缺信息点：${missing.join(' / ')}`)
    }
  }

  // 7) 跨平台文案不许残留「只在 Windows 生效」的旧说法。
  {
    const claiming = []
    for (const key of CROSS_PLATFORM_KEYS) {
      for (const [lang, dict] of [['zh', dictZh], ['en', dictEn]]) {
        const value = dict[key]
        if (typeof value !== 'string') continue
        const hit = WINDOWS_ONLY_CLAIMS.find((claim) => value.includes(claim))
        if (hit) claiming.push(`${lang}.${key}（「${hit}」）`)
      }
    }
    add('热键这一族文案不再声称「仅 Windows」（helper 已跨平台）', claiming.length === 0, claiming.join(', '))
  }

  // 8) 「模型要加载多久」这一族文案不许写死秒数（批次 9，docs/architecture-modernization.md §8.50）。
  //    起因：原先中英文两边都写着「首次需要 20~40 秒」，而 2026-11-04 装机实测是
  //    whisper-tiny 424 ms、228 MB 的 SenseVoice 回热约 1 秒 —— 在这台机器上错了 20~40 倍。
  //    时长随档位大小与磁盘变，任何固定区间总有一天失真；失真的用户文案比没有文案更坏。
  //    所以守的是「别把时长写成数字」，不是「数字得改成另一个」。
  {
    const offending = []
    for (const key of NO_DURATION_CLAIM_KEYS) {
      for (const [lang, dict] of [['zh', dictZh], ['en', dictEn]]) {
        const value = dict[key]
        if (typeof value !== 'string') continue
        if (/\d+\s*[~–-]\s*\d+\s*(秒|s\b)|\d+\s*(秒|s\b)/.test(value)) offending.push(`${lang}.${key}`)
      }
    }
    add('加载时长的文案里没有写死秒数（改文案可以，把时长当承诺不行）',
      offending.length === 0, offending.join(', '))
  }

  // 9) 开麦就绪的原因码：词表里每个码都要有中英语句（批次 18，§8.60）。
  //    漏一个键不会崩，只会让那个码走到兜底那句 —— 用户看到「请到设置里检查该档位」，
  //    而真实原因是「这一档还没下载」。所以判**覆盖**，不判字面。
  //    反向也要判：映射表里不许留着词表已经没有的码（改了码名却不改表 = 那条码永远走兜底，
  //    表上那句文案成了没人取的死字）。
  {
    const missing = []
    for (const code of ASR_READY_REASON_VALUES) {
      const key = ASR_READY_REASON_KEYS[code]
      if (!key) { missing.push(`${code}（映射表没这个码）`); continue }
      if (!(key in dictZh)) missing.push(`${code} → ${key}（缺中文）`)
      if (!(key in dictEn)) missing.push(`${code} → ${key}（缺英文）`)
    }
    add(`开麦就绪的 ${ASR_READY_REASON_VALUES.length} 个原因码都有中英两句`,
      missing.length === 0, missing.join('；'))
    const stale = Object.keys(ASR_READY_REASON_KEYS)
      .filter((code) => !ASR_READY_REASON_VALUES.includes(code))
    add('映射表里没有词表外的旧码（留着就是永远走不到的死文案）',
      stale.length === 0, stale.join(','))
    add('原因码的兜底那句（modelFailedDetail）中英语典里都在',
      'modelFailedDetail' in dictZh && 'modelFailedDetail' in dictEn, '')
  }

  // 10) 系统级热键的原因码：同上，判**覆盖**（批次 19，§8.61）。
  //     这一族的码比开麦多，共用句子是刻意的（用户能做的事一样），
  //     所以判的是「每个码都取得到一句中英语句」，不判「一句对一码」。
  {
    const missing = []
    for (const code of HOTKEY_REASON_VALUES) {
      const key = hotkeyKeys[code]
      if (!key) { missing.push(`${code}（映射表没这个码）`); continue }
      if (!(key in dictZh)) missing.push(`${code} → ${key}（缺中文）`)
      if (!(key in dictEn)) missing.push(`${code} → ${key}（缺英文）`)
    }
    add(`系统级热键的 ${HOTKEY_REASON_VALUES.length} 个原因码都有中英两句`,
      missing.length === 0, missing.join('；'))
    const stale = Object.keys(hotkeyKeys)
      .filter((code) => !HOTKEY_REASON_VALUES.includes(code))
    add('热键映射表里没有词表外的旧码（留着就是永远走不到的死文案）',
      stale.length === 0, stale.join(','))
    add('热键原因码的兜底那句（hotkeyReasonUnknown）中英语典里都在',
      'hotkeyReasonUnknown' in dictZh && 'hotkeyReasonUnknown' in dictEn, '')
  }

  // 11) 「保存设置没存进去」那行的原因码（批次 20，§8.62）：同上面两族一个规矩，
  //     判**覆盖**不判字面。这一族还多一层：错误行的**字段名**也是字典出的
  //     （`configFieldLabel` 就是 `t(配置键)`），所以 35 个配置键的标签必须中英都在 ——
  //     少一个不会崩，只会让那一行显示成英文键名（`silenceMs：…`），用户看不懂。
  {
    const missing = []
    for (const code of CONFIG_ERROR_REASON_VALUES) {
      const key = configKeys[code]
      if (!key) { missing.push(`${code}（映射表没这个码）`); continue }
      if (!(key in dictZh)) missing.push(`${code} → ${key}（缺中文）`)
      if (!(key in dictEn)) missing.push(`${code} → ${key}（缺英文）`)
    }
    add(`配置校验的 ${CONFIG_ERROR_REASON_VALUES.length} 个原因码都有中英两句`,
      missing.length === 0, missing.join('；'))
    const stale = Object.keys(configKeys)
      .filter((code) => !CONFIG_ERROR_REASON_VALUES.includes(code))
    add('校验错误映射表里没有词表外的旧码（留着就是永远走不到的死文案）',
      stale.length === 0, stale.join(','))
    add('校验错误的两句兜底（configErrorUnknown / configSaveRejected）中英语典里都在',
      'configErrorUnknown' in dictZh && 'configErrorUnknown' in dictEn
        && 'configSaveRejected' in dictZh && 'configSaveRejected' in dictEn, '')
    const unlabeled = CONFIG_SPEC_KEYS.filter((key) => !(key in dictZh) || !(key in dictEn))
    add(`${CONFIG_SPEC_KEYS.length} 个配置键都有中英字段名（错误行的前半截由字典出）`,
      unlabeled.length === 0, `缺：${unlabeled.join(',')}`)
  }

  // 12) 快捷键校验的失败码（批次 22，§8.64）：覆盖那一半和前三族一模一样，
  //     多出来的是**占位符与参数得对上**。这一族的参数是用户自己写的那个键
  //     （哪个修饰键不认识、哪个字母不能用），只有校验层知道；
  //     句子写了 `{modifier}` 而码表不发这个参数 = 界面上出现字面量 `{modifier}`，
  //     发了参数而句子没用 = 白传一趟（下一句改文案时还容易被当成可删）。
  {
    const missing = []
    for (const code of SHORTCUT_ERROR_REASON_VALUES) {
      const key = shortcutKeys[code]
      if (!key) { missing.push(`${code}（映射表没这个码）`); continue }
      if (!(key in dictZh)) missing.push(`${code} → ${key}（缺中文）`)
      if (!(key in dictEn)) missing.push(`${code} → ${key}（缺英文）`)
    }
    add(`快捷键校验的 ${SHORTCUT_ERROR_REASON_VALUES.length} 个原因码都有中英两句`,
      missing.length === 0, missing.join('；'))
    const stale = Object.keys(shortcutKeys)
      .filter((code) => !SHORTCUT_ERROR_REASON_VALUES.includes(code))
    add('快捷键映射表里没有词表外的旧码（留着就是永远走不到的死文案）',
      stale.length === 0, stale.join(','))
    add('快捷键那句兜底（shortcutErrorUnknown）中英语典里都在',
      'shortcutErrorUnknown' in dictZh && 'shortcutErrorUnknown' in dictEn, '')
    const unfilled = []
    const unused = []
    for (const code of SHORTCUT_ERROR_REASON_VALUES) {
      const key = shortcutKeys[code]
      if (!key) continue
      const provided = Object.keys(SHORTCUT_PARAMS_BY_CODE[code] ?? {})
      for (const [lang, dict] of [['zh', dictZh], ['en', dictEn]]) {
        const text = dict[key]
        if (typeof text !== 'string') continue
        const names = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
        for (const name of names) {
          if (!provided.includes(name)) unfilled.push(`${lang}.${key} 里的 {${name}}（「${code}」不发这个参数）`)
        }
        for (const name of provided) {
          if (!names.includes(name)) unused.push(`${lang}.${key} 没用 {${name}}（「${code}」发了它）`)
        }
      }
    }
    add('快捷键那几句里没有填不到值的占位符（不许出现字面量 {modifier}）',
      unfilled.length === 0, unfilled.join('；'))
    add('校验层发出去的参数在中英两句里都被用上（不带没人用的参数）',
      unused.length === 0, unused.join('；'))
  }

  // 13) 面板的选项文案与三张展示名表：判**覆盖**（批次 22-2，§8.65）。
  //     这一族漏键不会崩，只会把键名或英文侧的 undefined 显示到界面上，
  //     和前三族一样：漏一个 = 那个选项变成读不懂的字，所以逐条判中英都在。
  {
    const missingPanel = PANEL_OPTION_KEYS.filter((key) => !(key in dictZh) || !(key in dictEn))
    add(`${PANEL_OPTION_KEYS.length} 个面板选项键都有中英两句`,
      missingPanel.length === 0, `缺：${missingPanel.join(',')}`)

    const missingLang = []
    for (const code of ASR_LANGUAGES) {
      const key = panelTables.lang[code]
      if (!key) { missingLang.push(`${code}（表里没这个码）`); continue }
      if (!(key in dictZh)) missingLang.push(`${code} → ${key}（缺中文）`)
      if (!(key in dictEn)) missingLang.push(`${code} → ${key}（缺英文）`)
    }
    add(`${ASR_LANGUAGES.length} 个语言码都有中英两个显示名`,
      missingLang.length === 0, missingLang.join('；'))
    const staleLang = Object.keys(panelTables.lang)
      .filter((code) => !ASR_LANGUAGES.includes(code))
    add('语言展示名表里没有词表外的旧码', staleLang.length === 0, staleLang.join(','))

    const missingVoice = []
    for (const [name, key] of Object.entries(panelTables.voice)) {
      if (!(key in dictZh)) missingVoice.push(`${name} → ${key}（缺中文）`)
      if (!(key in dictEn)) missingVoice.push(`${name} → ${key}（缺英文）`)
    }
    add(`${Object.keys(panelTables.voice).length} 个音色短名都有中英两个显示名`,
      missingVoice.length === 0, missingVoice.join('；'))

    const missingEngine = []
    for (const engine of TTS_ENGINES) {
      const key = panelTables.engine[engine]
      if (!key) { missingEngine.push(`${engine}（表里没这个 id）`); continue }
      if (!(key in dictZh)) missingEngine.push(`${engine} → ${key}（缺中文）`)
      if (!(key in dictEn)) missingEngine.push(`${engine} → ${key}（缺英文）`)
    }
    add(`${TTS_ENGINES.length} 个引擎 id 都有中英两个选项名（含 local 不支持那句）`,
      missingEngine.length === 0 && 'engineOptionLocalUnsupported' in dictZh
        && 'engineOptionLocalUnsupported' in dictEn,
      `${missingEngine.join('；')}`)
    const staleEngine = Object.keys(panelTables.engine)
      .filter((engine) => !TTS_ENGINES.includes(engine))
    add('引擎展示名表里没有词表外的旧 id', staleEngine.length === 0, staleEngine.join(','))
    add('引擎脏 id 的兜底那句（engineOptionUnknown）中英语典里都在',
      'engineOptionUnknown' in dictZh && 'engineOptionUnknown' in dictEn, '')

    // 跑真函数走到的键（上面那两段 PANEL_PARAMS_BY_CODE / ENV_PARAMS_BY_CODE）：这条抓的是
    // **函数自己写错键名**，表判不出 —— 表可以把 'langZh' 写对，函数里却拼成 'langz'。
    const reachedByFunctions = { ...PANEL_PARAMS_BY_CODE, ...ENV_PARAMS_BY_CODE }
    const unreachable = Object.keys(reachedByFunctions)
      .filter((key) => !(key in dictZh) || !(key in dictEn))
    add(`取词函数实际走到的 ${Object.keys(reachedByFunctions).length} 个键中英语典里都有`,
      unreachable.length === 0, `缺：${unreachable.join(',')}`)
  }

  // 14) 面板这几句里的占位符必须能填上（判据 12 同一族规矩，换了 producer）。
  //     无参数的那一堆（语言/音色/引擎名、永不释放）写了 `{x}` 就是永远填不上，
  //     界面上会出现字面量；发了参数而句子不用 = 白传，下一句改文案时容易被当可删。
  {
    const unfilled = []
    const unused = []
    for (const [key, params] of Object.entries(PANEL_PARAMS_BY_KEY)) {
      const provided = Object.keys(params ?? {})
      for (const [lang, dict] of [['zh', dictZh], ['en', dictEn]]) {
        const text = dict[key]
        if (typeof text !== 'string') continue
        const names = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
        for (const name of names) {
          if (!provided.includes(name)) unfilled.push(`${lang}.${key} 里的 {${name}}（取词方不发这个参数）`)
        }
        for (const name of provided) {
          if (!names.includes(name)) unused.push(`${lang}.${key} 没用 {${name}}`)
        }
      }
    }
    add('面板那几句里没有填不到值的占位符（不许出现字面量 {minutes}）',
      unfilled.length === 0, unfilled.join('；'))
    add('面板取词方发出去的参数在中英两句里都被用上',
      unused.length === 0, unused.join('；'))
  }

  // 15) 英文侧不许夹汉字（批次 22-2 独有的那条）。
  //     这一批把中文搬进字典时，最容易犯的错是「en 那行照抄了中文」——
  //     键集合对称（判据 1）照样绿，切英文却看到一句中文。
  //     白名单外的键命中一个汉字就红；命中全角标点不算（那是排版，两边都在用）。
  {
    const han = /[㐀-䶿一-鿿豈-﫿]/
    const offending = Object.keys(dictEn)
      .filter((key) => !EN_HAN_ALLOW_KEYS.includes(key) && han.test(String(dictEn[key])))
    add(`英文侧除 ${EN_HAN_ALLOW_KEYS.length} 个白名单键以外没有汉字（中文不许照抄进 en）`,
      offending.length === 0, offending.join(','))
  }

  // 16) 模型档位名：判**定义域来自宿主目录**（批次 22-3-1，§8.66）。
  //     这九句不是面板自己拍的文案，是「这个模型叫什么」，目录才是真源。
  //     所以定义域不抄名单：`MODEL_TIERS` 直接读 `src/host/model-catalog.js`，
  //     目录加一档而这里没跟上 → 覆盖那条红；表里留着已经删掉的档 → 反向那条红。
  {
    const missingModel = []
    for (const tier of MODEL_TIERS) {
      const key = panelTables.model[tier.id]
      if (!key) { missingModel.push(`${tier.id}（表里没这个档）`); continue }
      if (!(key in dictZh)) missingModel.push(`${tier.id} → ${key}（缺中文）`)
      if (!(key in dictEn)) missingModel.push(`${tier.id} → ${key}（缺英文）`)
    }
    add(`${MODEL_TIERS.length} 个模型档位都有中英两个显示名`,
      missingModel.length === 0, missingModel.join('；'))
    const staleModel = Object.keys(panelTables.model)
      .filter((id) => !MODEL_TIERS.some((tier) => tier.id === id))
    add('模型展示名表里没有目录外的旧档位', staleModel.length === 0, staleModel.join(','))
  }

  // 17) 字典那两句必须**逐字等于**目录（批次 22-3-1 付「同一段文字住两处」的代价用的就是这条）。
  //     没有它，「以目录为准」只是一句注释：目录改了名、字典没跟，测试照样绿，
  //     界面上显示的却是旧名字。有了它，改任何一边都会当场红，改的人必须两边一起改。
  {
    const driftZh = []
    const driftEn = []
    for (const tier of MODEL_TIERS) {
      const key = panelTables.model[tier.id]
      if (!key) continue
      if (dictZh[key] !== tier.label) driftZh.push(`${tier.id}：字典「${dictZh[key]}」≠ 目录「${tier.label}」`)
      if (dictEn[key] !== tier.labelEn) driftEn.push(`${tier.id}：字典「${dictEn[key]}」≠ 目录「${tier.labelEn}」`)
    }
    add('中文侧那九句逐字等于目录的 `label`（改目录名必须两边一起改）',
      driftZh.length === 0, driftZh.join('；'))
    add('英文侧那九句逐字等于目录的 `labelEn`（宿主那份英文本来就是这句，没另写一遍）',
      driftEn.length === 0, driftEn.join('；'))
  }

  // 18) 环境自检那四行的原因码与引擎行名（批次 22-3-2，§8.67）：覆盖那一半和前六族同一个规矩。
  //     这一族的定义域**两处都不许抄**：码来自 `src/shared/tts-env-reasons.js`（宿主发码那一份词表），
  //     引擎 id 来自 `config-vocab.js` 的 `TTS_ENGINES`。宿主加一个码 / 加一个引擎而字典没跟上，
  //     界面上就是那句生硬的兜底文案（或一个读不出名字的引擎行），装机才看得见 —— 所以在这里判。
  //     行名也算这一族：`envEngineLabel` 按 `id` 出名字，宿主的 `label` 不再进界面，
  //     字典漏一个 id 那一行就变成「另一个引擎（local）」。
  {
    const missing = []
    for (const code of TTS_ENV_REASON_VALUES) {
      const key = envTables.reason[code]
      if (!key) { missing.push(`${code}（映射表没这个码）`); continue }
      if (!(key in dictZh)) missing.push(`${code} → ${key}（缺中文）`)
      if (!(key in dictEn)) missing.push(`${code} → ${key}（缺英文）`)
    }
    add(`环境自检的 ${TTS_ENV_REASON_VALUES.length} 个原因码都有中英两句`,
      missing.length === 0, missing.join('；'))
    const stale = Object.keys(envTables.reason)
      .filter((code) => !TTS_ENV_REASON_VALUES.includes(code))
    add('环境自检映射表里没有词表外的旧码（留着就是永远走不到的死文案）',
      stale.length === 0, stale.join(','))
    const staleParamCodes = Object.keys(envTables.params)
      .filter((code) => !TTS_ENV_REASON_VALUES.includes(code))
    add('参数的码表里没有词表外的旧码（旧码没人发，句子却还照着它写占位符）',
      staleParamCodes.length === 0, staleParamCodes.join(','))
    add('环境自检的兜底那句（envReasonUnknown）中英语典里都在',
      'envReasonUnknown' in dictZh && 'envReasonUnknown' in dictEn, '')

    const missingEngine = []
    for (const engine of TTS_ENGINES) {
      const key = envTables.engine[engine]
      if (!key) { missingEngine.push(`${engine}（表里没这个 id）`); continue }
      if (!(key in dictZh)) missingEngine.push(`${engine} → ${key}（缺中文）`)
      if (!(key in dictEn)) missingEngine.push(`${engine} → ${key}（缺英文）`)
    }
    add(`${TTS_ENGINES.length} 个引擎 id 都有中英两个自检行名`,
      missingEngine.length === 0, missingEngine.join('；'))
    const staleEngine = Object.keys(envTables.engine)
      .filter((engine) => !TTS_ENGINES.includes(engine))
    add('自检行名表里没有词表外的旧 id', staleEngine.length === 0, staleEngine.join(','))
    add('脏引擎 id 的兜底那句（envEngineUnknown）中英语典里都在',
      'envEngineUnknown' in dictZh && 'envEngineUnknown' in dictEn, '')
    // `{runtime}` 是契约值，进句子前还要再翻一次 —— 「一个词也是话」，两个值各两句。
    add('运行时种类的两句（envRuntimeNative / envRuntimeWasm）中英语典里都在',
      'envRuntimeNative' in dictZh && 'envRuntimeNative' in dictEn
        && 'envRuntimeWasm' in dictZh && 'envRuntimeWasm' in dictEn, '')
  }

  // 19) 每个码的 `{占位符}` 集合必须**等于**协议那份参数表（批次 22-3-2 独有的一条）。
  //     判据 14 拿的是「函数实际发出去的名字」，而函数发什么由这张表决定，两头同源；
  //     这里直接对着 `TTS_ENV_REASON_PARAMS` 判，为的是把**协议**钉住：
  //       句子写了 `{version}` 而协议不发 → 界面上出现字面量（宿主根本没收集这个东西）；
  //       协议发了 `{count}` 而句子不用 → 宿主白收集一趟，改文案时还容易被当成可删。
  //     中英两句各自核对，所以「只有中文那句带了参数、英文那句忘了」也红 ——
  //     那正是切英文看到 `Available (` 后面空空如也的形状。
  {
    const unfilled = []
    const unused = []
    for (const code of TTS_ENV_REASON_VALUES) {
      const key = envTables.reason[code]
      if (!key) continue
      const expected = envTables.params[code] ?? []
      for (const [lang, dict] of [['zh', dictZh], ['en', dictEn]]) {
        const text = dict[key]
        if (typeof text !== 'string') continue
        const names = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
        for (const name of names) {
          if (!expected.includes(name)) unfilled.push(`${lang}.${key} 里的 {${name}}（「${code}」的协议不发这个）`)
        }
        for (const name of expected) {
          if (!names.includes(name)) unused.push(`${lang}.${key} 没用 {${name}}（「${code}」按协议收了它）`)
        }
      }
    }
    add('环境自检那几句里没有协议不发的占位符（不许出现字面量 {version}）',
      unfilled.length === 0, unfilled.join('；'))
    add('环境自检按协议收集的参数在中英两句里都被用上',
      unused.length === 0, unused.join('；'))
  }

  // 20) 模型下载失败那一行的原因码（批次 22-4-2，§8.71）：覆盖这一半和前面七族同一个规矩。
  //     定义域不许抄：码来自 `src/shared/model-download-reasons.js`（宿主发码那一份词表）。
  //     这一族值得单独判一次的原因是它的**收端**从前根本不看载荷
  //     （`model-error` 事件里 `void parseEnvelope(event)` 把原因整片丢弃），
  //     而 `POST /model` 被拒那条路又把宿主那句原文直接贴上界面。现在两边都只认码，
  //     字典里少一句就是装机上一句生硬的兜底文案 —— 只有真点下载才看得见，所以在这里判。
  //     `downloadFailed` 那句（完全没带码时用的兼容路径）本来就在状态行短词名单里判过，
  //     这里只补判这一族新加的「读不出来」那句。
  {
    const missing = []
    for (const code of MODEL_DOWNLOAD_REASON_VALUES) {
      const key = downloadTables.reason[code]
      if (!key) { missing.push(`${code}（映射表没这个码）`); continue }
      if (!(key in dictZh)) missing.push(`${code} → ${key}（缺中文）`)
      if (!(key in dictEn)) missing.push(`${code} → ${key}（缺英文）`)
    }
    add(`模型下载的 ${MODEL_DOWNLOAD_REASON_VALUES.length} 个原因码都有中英两句`,
      missing.length === 0, missing.join('；'))
    const stale = Object.keys(downloadTables.reason)
      .filter((code) => !MODEL_DOWNLOAD_REASON_VALUES.includes(code))
    add('下载映射表里没有词表外的旧码（留着就是永远走不到的死文案）',
      stale.length === 0, stale.join(','))
    const staleParamCodes = Object.keys(downloadTables.params)
      .filter((code) => !MODEL_DOWNLOAD_REASON_VALUES.includes(code))
    add('下载的参数的码表里没有词表外的旧码（那份协议永远没人发）',
      staleParamCodes.length === 0, staleParamCodes.join(','))
    add('下载那句的兜底（downloadReasonUnknown）中英语典里都在',
      'downloadReasonUnknown' in dictZh && 'downloadReasonUnknown' in dictEn, '')
    // 这一族的句子全部由字典出，所以顺手判一件更基础的事：
    // 十个码的中文句子不许和英文句子一模一样（一模一样 = 只写了一种语言就交了）。
    const copied = MODEL_DOWNLOAD_REASON_VALUES
      .map((code) => downloadTables.reason[code])
      .filter((key) => key !== undefined && dictZh[key] !== undefined && dictZh[key] === dictEn[key])
    add('下载那十句不是把中文照抄到英文侧', copied.length === 0, copied.join(','))
  }

  // 21) 每个码的 `{占位符}` 集合必须**等于**协议那份参数表（判据 19 的翻版，批次 22-4-2）。
  //     这里的尺子和宿主**抛出**那一份是同一个对象（`MODEL_DOWNLOAD_REASON_PARAMS`），两头同源：
  //     宿主那边少给一个参数会被 `withModelDownloadReason()` 当场炸（批次 22-4-1），
  //     字典这边多写一个占位符由这条拦住 —— 界面上就是字面量 `{got}`。
  //     中英各核一遍：只中文带了参数、英文漏了，切英文就成了「拼出来的大小不对（，应为）」。
  {
    const unfilled = []
    const unused = []
    for (const code of MODEL_DOWNLOAD_REASON_VALUES) {
      const key = downloadTables.reason[code]
      if (!key) continue
      const expected = downloadTables.params[code] ?? []
      for (const [lang, dict] of [['zh', dictZh], ['en', dictEn]]) {
        const text = dict[key]
        if (typeof text !== 'string') continue
        const names = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
        for (const name of names) {
          if (!expected.includes(name)) unfilled.push(`${lang}.${key} 里的 {${name}}（「${code}」的协议不发这个）`)
        }
        for (const name of expected) {
          if (!names.includes(name)) unused.push(`${lang}.${key} 没用 {${name}}（「${code}」按协议收了它）`)
        }
      }
    }
    add('下载那几句里没有协议不发的占位符（不许出现字面量 {got}）',
      unfilled.length === 0, unfilled.join('；'))
    add('下载按协议收集的参数在中英两句里都被用上',
      unused.length === 0, unused.join('；'))
  }

  return out
}

const results = evaluate(zh, en)
let passed = 0
const failures = []
for (const r of results) {
  if (r.ok) { passed++; console.log('  ok   ' + r.name) }
  else { failures.push(r.name); console.log('  FAIL ' + r.name + (r.detail ? ' :: ' + r.detail : '')) }
}

// ---------------------------------------------------------------------------
// 判据的范围：把构造出来的字典喂给纯函数 evaluate，确认它不误红。
// ---------------------------------------------------------------------------
console.log('\n判据的范围（构造字典喂纯函数）')
{
  const clone = (o) => ({ ...o })
  function check(name, ok, detail) {
    if (ok) { passed++; console.log('  ok   ' + name) }
    else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
  }

  // 反例：把**名单外**的已有 key 改长，短词上限不该跟着红（守的是状态行，不是全部文案）。
  // 用的是 `stopHint`（按钮悬停提示，本来就长，且不在状态行名单里）。
  {
    const badZh = clone(zh)
    badZh.stopHint = `${zh.stopHint} —— 再补一大段说明`
    const red = evaluate(badZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('状态行以外的 key 变长不会误红', red.length === 0, red.join(' | '))
  }

  // 反例（批次 5a）：**整句改写、信息点都还在**不该红。
  // 原来那几条扫源码文本的正判不住这个：写法一变就红，可用户读到的一模一样。
  // 这里把 wordsHint 换成一句通顺的重写（保留「热词」「Zipformer2」两个信息点），
  // 判据必须全绿 —— 它守的是内容，不是措辞。
  {
    const badZh = clone(zh)
    badZh.wordsHint = '每行一条规则。「正确=错误」会把说错的词换成正确的；'
      + '只写「正确」是热词提示，这种用法目前只有 Zipformer2 流式模型支持。'
    const red = evaluate(badZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('整句改写（信息点还在）不会误红', red.length === 0, red.join(' | '))
  }

  // 判据 8 的范围（批次 9，§8.50）：两个方向都要钉住，否则它要么空转要么误伤。
  {
    const rewordedZh = clone(zh)
    rewordedZh.modelLoadingDetail = '正在加载识别模型，第一次会比之后慢一些。'
    const rewordedEn = clone(en)
    rewordedEn.modelLoadingDetail = 'Loading the recognition model; the first time takes longer.'
    const red = evaluate(rewordedZh, rewordedEn).filter((r) => !r.ok).map((r) => r.name)
    check('时长文案改成不带数字的说法不会误红', red.length === 0, red.join(' | '))
  }
  {
    const oldCopyZh = clone(zh)
    oldCopyZh.modelLoadingDetail = '正在加载识别模型（首次需要 20~40 秒）。'
    const hit = evaluate(oldCopyZh, en).find((r) => r.name.startsWith('加载时长的文案里没有写死秒数'))
    check('旧那句「20~40 秒」喂进去必须被判红（判据不是空转）', hit && hit.ok === false,
      JSON.stringify(hit))
  }

  // 判据 9 的范围（批次 18，§8.60）：字典少一个原因码的句子必须红。
  {
    const thinZh = clone(zh)
    delete thinZh.modelNotFoundDetail
    const red = evaluate(thinZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('中文侧漏一个原因码的文案就被判红（覆盖判据不是空转）',
      red.some((name) => name.startsWith('开麦就绪的')), red.join(' | '))
  }
  {
    const thinEn = clone(en)
    delete thinEn.modelNotDownloadedDetail
    const red = evaluate(zh, thinEn).filter((r) => !r.ok).map((r) => r.name)
    check('英文侧漏一个原因码的文案也被判红（切英文不许掉回兜底那句）',
      red.some((name) => name.startsWith('开麦就绪的')), red.join(' | '))
  }

  // 判据 10 的范围（批次 19，§8.61）：热键那一族同理。
  {
    const thinZh = clone(zh)
    delete thinZh.hotkeyReasonRegister
    const red = evaluate(thinZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('中文侧漏一个热键原因码的文案就被判红', 
      red.some((name) => name.startsWith('系统级热键的')), red.join(' | '))
  }
  {
    const thinEn = clone(en)
    delete thinEn.hotkeyReasonNative
    const red = evaluate(zh, thinEn).filter((r) => !r.ok).map((r) => r.name)
    check('英文侧漏一个热键原因码的文案也被判红',
      red.some((name) => name.startsWith('系统级热键的')), red.join(' | '))
  }
  {
    // 码改名了、映射表还留着旧码：那条旧文案永远没人取。
    const drifted = { ...HOTKEY_REASON_KEYS }
    delete drifted['register-failed']
    const red = evaluate(zh, en, drifted).filter((r) => !r.ok).map((r) => r.name)
    check('映射表漏一个码时被覆盖判据抓住',
      red.some((name) => name.startsWith('系统级热键的')), red.join(' | '))
    const staleTable = { ...HOTKEY_REASON_KEYS, 'old-code-name': 'hotkeyReasonRegister' }
    const staleRed = evaluate(zh, en, staleTable).filter((r) => !r.ok).map((r) => r.name)
    check('映射表留着词表外的旧码时被反向判据抓住',
      staleRed.some((name) => name.startsWith('热键映射表里没有词表外的旧码')), staleRed.join(' | '))
  }

  // 判据 11 的范围（批次 20，§8.62）：配置校验那一族同理。
  {
    const thinZh = clone(zh)
    delete thinZh.configErrorEnum
    const red = evaluate(thinZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('中文侧漏一个校验错误码的文案就被判红',
      red.some((name) => name.startsWith('配置校验的')), red.join(' | '))
  }
  {
    const thinEn = clone(en)
    delete thinEn.configErrorWordsEntryShape
    const red = evaluate(zh, thinEn).filter((r) => !r.ok).map((r) => r.name)
    check('英文侧漏一个校验错误码的文案也被判红',
      red.some((name) => name.startsWith('配置校验的')), red.join(' | '))
  }
  {
    // 码改名了、映射表还留着旧码 / 漏了新码。
    const drifted = { ...CONFIG_ERROR_KEYS }
    delete drifted['not-in-enum']
    const red = evaluate(zh, en, HOTKEY_REASON_KEYS, drifted).filter((r) => !r.ok).map((r) => r.name)
    check('校验映射表漏一个码时被覆盖判据抓住',
      red.some((name) => name.startsWith('配置校验的')), red.join(' | '))
    const staleTable = { ...CONFIG_ERROR_KEYS, 'old-code-name': 'configErrorEnum' }
    const staleRed = evaluate(zh, en, HOTKEY_REASON_KEYS, staleTable).filter((r) => !r.ok).map((r) => r.name)
    check('校验映射表留着词表外的旧码时被反向判据抓住',
      staleRed.some((name) => name.startsWith('校验错误映射表里没有词表外的旧码')), staleRed.join(' | '))
  }
  {
    // 字段名那一半：把某个配置键的标签删掉，错误行就会显示成英文键名。
    const noLabel = clone(zh)
    delete noLabel.silenceMs
    const red = evaluate(noLabel, en).filter((r) => !r.ok).map((r) => r.name)
    check('少一个配置键的中文字段名时被标签判据抓住',
      red.some((name) => name.includes('个配置键都有中英字段名')), red.join(' | '))
  }

  // 判据 12 的范围（批次 22，§8.64）：快捷键那一族同理，外加占位符两头。
  {
    const thinZh = clone(zh)
    delete thinZh.shortcutErrorUnknownModifier
    const red = evaluate(thinZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('中文侧漏一个快捷键校验码的文案就被判红',
      red.some((name) => name.startsWith('快捷键校验的')), red.join(' | '))
  }
  {
    const thinEn = clone(en)
    delete thinEn.shortcutErrorReservedPaste
    const red = evaluate(zh, thinEn).filter((r) => !r.ok).map((r) => r.name)
    check('英文侧漏一个快捷键校验码的文案也被判红（切英文不许掉回兜底那句）',
      red.some((name) => name.startsWith('快捷键校验的')), red.join(' | '))
  }
  {
    const drifted = { ...SHORTCUT_ERROR_KEYS }
    delete drifted['single-letter']
    const red = evaluate(zh, en, HOTKEY_REASON_KEYS, CONFIG_ERROR_KEYS, drifted)
      .filter((r) => !r.ok).map((r) => r.name)
    check('快捷键映射表漏一个码时被覆盖判据抓住',
      red.some((name) => name.startsWith('快捷键校验的')), red.join(' | '))
    const staleTable = { ...SHORTCUT_ERROR_KEYS, 'old-code-name': 'shortcutErrorEmpty' }
    const staleRed = evaluate(zh, en, HOTKEY_REASON_KEYS, CONFIG_ERROR_KEYS, staleTable)
      .filter((r) => !r.ok).map((r) => r.name)
    check('快捷键映射表留着词表外的旧码时被反向判据抓住',
      staleRed.some((name) => name.startsWith('快捷键映射表里没有词表外的旧码')), staleRed.join(' | '))
  }
  {
    // 占位符那一半的两个方向：多写一个没人发的、少用一个真发出来的，都要红。
    const extraZh = clone(zh)
    extraZh.shortcutErrorEmpty = `${zh.shortcutErrorEmpty}{noSuchParam}`
    const red = evaluate(extraZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('句子里多一个校验层不发的占位符时被抓住（用户会看到字面量）',
      red.some((name) => name.startsWith('快捷键那几句里没有填不到值的占位符')), red.join(' | '))
    const thinZh = clone(zh)
    thinZh.shortcutErrorUnknownModifier = '不认识的修饰键。'
    const thinRed = evaluate(thinZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('句子里把发出来的参数不用掉时也被抓住（那句到底说是哪个键）',
      thinRed.some((name) => name.startsWith('校验层发出去的参数')), thinRed.join(' | '))
  }
  {
    // 批次 22-2 判据 13 的四个方向：面板引用漏一边、语言表漏码、表里留旧码、音色表指向不存在的键。
    const missingZh = clone(zh)
    delete missingZh.envGpuNone
    const red = evaluate(missingZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('面板选项键漏中文侧时被覆盖判据抓住',
      red.some((name) => name.includes('面板选项键都有中英两句')), red.join(' | '))

    const thinLang = { ...LANGUAGE_LABEL_KEYS }
    delete thinLang.yue
    const langRed = evaluate(zh, en, HOTKEY_REASON_KEYS, CONFIG_ERROR_KEYS, SHORTCUT_ERROR_KEYS, { ...PANEL_TABLES_DEFAULT, lang: thinLang })
      .filter((r) => !r.ok).map((r) => r.name)
    check('语言展示名表漏一个码时被抓住',
      langRed.some((name) => name.includes('语言码都有中英两个显示名')), langRed.join(' | '))

    const staleLang = { ...LANGUAGE_LABEL_KEYS, th: 'langAuto' }
    const staleRed = evaluate(zh, en, HOTKEY_REASON_KEYS, CONFIG_ERROR_KEYS, SHORTCUT_ERROR_KEYS, { ...PANEL_TABLES_DEFAULT, lang: staleLang })
      .filter((r) => !r.ok).map((r) => r.name)
    check('语言展示名表留着词表外的旧码时被反向判据抓住',
      staleRed.some((name) => name.startsWith('语言展示名表里没有词表外的旧码')), staleRed.join(' | '))

    const brokenVoice = { ...VOICE_LABEL_KEYS, 'zh-CN-NoSuchNeural': 'voiceNoSuchNeural' }
    const voiceRed = evaluate(zh, en, HOTKEY_REASON_KEYS, CONFIG_ERROR_KEYS, SHORTCUT_ERROR_KEYS, { ...PANEL_TABLES_DEFAULT, voice: brokenVoice })
      .filter((r) => !r.ok).map((r) => r.name)
    check('音色表新增一个短名却忘了配文案时被抓住',
      voiceRed.some((name) => name.includes('音色短名都有中英两个显示名')), voiceRed.join(' | '))

    const missingEngine = { ...TTS_ENGINE_OPTION_KEYS }
    delete missingEngine.sovits
    const engineRed = evaluate(zh, en, HOTKEY_REASON_KEYS, CONFIG_ERROR_KEYS, SHORTCUT_ERROR_KEYS, { ...PANEL_TABLES_DEFAULT, engine: missingEngine })
      .filter((r) => !r.ok).map((r) => r.name)
    check('引擎展示名表漏一个 id 时被抓住',
      engineRed.some((name) => name.includes('引擎 id 都有中英两个选项名')), engineRed.join(' | '))
  }
  {
    // 判据 14 的两个方向（面板这一族）：无参数的那句写了占位符、档位那句把参数丢了。
    const extraZh = clone(zh)
    extraZh.langZh = `${zh.langZh}{x}`
    const red = evaluate(extraZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('语言名那句多一个没人发的占位符时被抓住',
      red.some((name) => name.startsWith('面板那几句里没有填不到值的占位符')), red.join(' | '))
    const thinZh = clone(zh)
    thinZh.idleReleaseInMinutes = '分钟'
    const thinRed = evaluate(thinZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('释放档位那句不实用发出的参数时被抓住',
      thinRed.some((name) => name.startsWith('面板取词方发出去的参数')), thinRed.join(' | '))
  }
  {
    // 判据 15：往英文侧照抄中文必须红，白名单那两个键写中文必须绿。
    const copiedEn = clone(en)
    copiedEn.envGpuNone = '未检测到 NVIDIA 显卡'
    const red = evaluate(zh, copiedEn).filter((r) => !r.ok).map((r) => r.name)
    check('英文侧照抄中文时被抓住（切英文不许看到半句中文）',
      red.some((name) => name.startsWith('英文侧除')), red.join(' | '))
    const allowedEn = clone(en)
    // 白名单那句必须**还是英文句子**、只是引用了中文写法 —— 整句换成中文会先撞判据 6
    // （英文侧要有「hotword」「Zipformer2」两个信息点），那就不是这条反例要测的东西了。
    allowedEn.wordsHint = 'One rule per line. "正确=错误" replaces a misheard word with the right one; '
      + 'a line with only 正确 is a hotword hint, currently supported only by the Zipformer2 streaming model.'
    const allowedRed = evaluate(zh, allowedEn).filter((r) => !r.ok).map((r) => r.name)
    check('白名单键（词表 hint）的英文句里引用中文写法不算回归', allowedRed.length === 0, allowedRed.join(' | '))
  }
  {
    // 判据 16 的两个方向（批次 22-3-1）：目录里的档位表里没有、表里留着已经没了的档。
    const thinModel = { ...MODEL_LABEL_KEYS }
    delete thinModel.sensevoice
    const red = evaluate(zh, en, HOTKEY_REASON_KEYS, CONFIG_ERROR_KEYS, SHORTCUT_ERROR_KEYS,
      { ...PANEL_TABLES_DEFAULT, model: thinModel }).filter((r) => !r.ok).map((r) => r.name)
    check('模型目录里有一档没配展示名时被覆盖判据抓住',
      red.some((name) => name.includes('模型档位都有中英两个显示名')), red.join(' | '))

    const staleModel = { ...MODEL_LABEL_KEYS, 'whisper-old': 'modelWhisperBase' }
    const staleRed = evaluate(zh, en, HOTKEY_REASON_KEYS, CONFIG_ERROR_KEYS, SHORTCUT_ERROR_KEYS,
      { ...PANEL_TABLES_DEFAULT, model: staleModel }).filter((r) => !r.ok).map((r) => r.name)
    check('模型展示名表留着目录里已经不存在的档位时被反向判据抓住',
      staleRed.some((name) => name.includes('模型展示名表里没有目录外的旧档位')), staleRed.join(' | '))
  }
  {
    // 判据 17：这条是本批唯一能证明「字典没和目录各活各的」的判据，所以它的反例要真的红。
    const driftedZh = clone(zh)
    driftedZh.modelWhisperTiny = 'Whisper tiny（最轻）'
    const red = evaluate(driftedZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('目录改了档位名而字典没跟（中文侧）时等值判据红 —— 界面不许继续显示旧名字',
      red.some((name) => name.startsWith('中文侧那九句逐字等于目录')), red.join(' | '))
    const driftedEn = clone(en)
    driftedEn.modelSensevoice = 'SenseVoice (best one)'
    const enRed = evaluate(zh, driftedEn).filter((r) => !r.ok).map((r) => r.name)
    check('英文侧自己重写了一句而目录里是另一句时，等值判据也红（两边都得指同一个真源）',
      enRed.some((name) => name.startsWith('英文侧那九句逐字等于目录')), enRed.join(' | '))
    const copiedZh = clone(en)
    copiedZh.modelZipformer2Zh = zh.modelZipformer2Zh
    const hanRed = evaluate(zh, copiedZh).filter((r) => !r.ok).map((r) => r.name)
    check('英文侧照抄目录的中文那句时，判据 15 与 17 一起红（不只靠禁汉字那条兜）',
      hanRed.some((name) => name.startsWith('英文侧除'))
        && hanRed.some((name) => name.startsWith('英文侧那九句逐字等于目录')), hanRed.join(' | '))
  }

  // 判据 18 的四个方向（批次 22-3-2）：字典少一句、映射表漏码、表里留旧码、协议里留旧码。
  {
    const thinZh = clone(zh)
    delete thinZh.envReasonNeuralReady
    const red = evaluate(thinZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('中文侧漏一个环境自检码的文案就被判红',
      red.some((name) => name.startsWith('环境自检的')), red.join(' | '))

    const thinEn = clone(en)
    delete thinEn.envEngineLocal
    const enRed = evaluate(zh, thinEn).filter((r) => !r.ok).map((r) => r.name)
    check('英文侧漏一个引擎自检行名也被判红（切英文不许显示成「另一个引擎（local）」）',
      enRed.some((name) => name.includes('引擎 id 都有中英两个自检行名')), enRed.join(' | '))

    const drifted = { ...TTS_ENV_REASON_KEYS }
    delete drifted['online-unreachable']
    const tableRed = evaluate(zh, en, undefined, undefined, undefined, undefined,
      { ...ENV_TABLES_DEFAULT, reason: drifted }).filter((r) => !r.ok).map((r) => r.name)
    check('自检映射表漏一个码时被覆盖判据抓住',
      tableRed.some((name) => name.startsWith('环境自检的')), tableRed.join(' | '))

    const staleTable = { ...TTS_ENV_REASON_KEYS, 'local-ready-wsl': 'envReasonLocalReadySay' }
    const staleRed = evaluate(zh, en, undefined, undefined, undefined, undefined,
      { ...ENV_TABLES_DEFAULT, reason: staleTable }).filter((r) => !r.ok).map((r) => r.name)
    check('自检映射表留着词表外的旧码时被反向判据抓住',
      staleRed.some((name) => name.startsWith('环境自检映射表里没有词表外的旧码')), staleRed.join(' | '))

    const staleParams = { ...TTS_ENV_REASON_PARAMS, 'no-such-code': ['whatever'] }
    const paramRed = evaluate(zh, en, undefined, undefined, undefined, undefined,
      { ...ENV_TABLES_DEFAULT, params: staleParams }).filter((r) => !r.ok).map((r) => r.name)
    check('协议表留着词表外的旧码时被抓住（那份协议永远没人发）',
      paramRed.some((name) => name.startsWith('参数的码表里没有词表外的旧码')), paramRed.join(' | '))
  }

  // 判据 19 的三个方向：多写一个协议不发的、少用一个协议收了英文侧漏的、
  // 以及**整句改写而占位符照用**不该红（这条守的是协议，不是措辞）。
  {
    const extraZh = clone(zh)
    extraZh.envReasonLocalMissingSay = `${zh.envReasonLocalMissingSay}（{version}）`
    const red = evaluate(extraZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('句子里多一个宿主不会收集的占位符时被抓住（装机上是字面量 {version}）',
      red.some((name) => name.startsWith('环境自检那几句里没有协议不发的占位符')), red.join(' | '))

    const thinEn = clone(en)
    thinEn.envReasonOnlineReady = 'Available'
    const enRed = evaluate(zh, thinEn).filter((r) => !r.ok).map((r) => r.name)
    check('英文那句把收来的参数丢用时也被抓住（中文带数字、英文空着就是这句的形状）',
      enRed.some((name) => name.startsWith('环境自检按协议收集的参数')), enRed.join(' | '))

    const rewordedZh = clone(zh)
    const rewordedEn = clone(en)
    rewordedZh.envReasonNeuralReady = '已就绪：{model}（{runtime}），可离线使用。'
    rewordedEn.envReasonNeuralReady = 'Ready: {model} ({runtime}), fully offline.'
    const rewordedRed = evaluate(rewordedZh, rewordedEn).filter((r) => !r.ok).map((r) => r.name)
    check('把「已就绪」那句换成另一种说法（占位符照用）不会误红', rewordedRed.length === 0,
      rewordedRed.join(' | '))
  }

  // 判据 20/21 的反例（批次 22-4-2）：字典少一句、映射表漏码、表里留旧码、
  // 多写一个协议不发的占位符、英文那句把参数丢了，以及**整句改写而占位符照用**不该红。
  {
    const thinZh = clone(zh)
    delete thinZh.downloadReasonNotInRepo
    const red = evaluate(thinZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('中文侧漏一个下载码的文案就被判红',
      red.some((name) => name.startsWith('模型下载的')), red.join(' | '))

    const thinEn = clone(en)
    delete thinEn.downloadReasonHostedUnavailable
    const enRed = evaluate(zh, thinEn).filter((r) => !r.ok).map((r) => r.name)
    check('英文侧漏一句也被判红（切英文不许显示成 undefined）',
      enRed.some((name) => name.startsWith('模型下载的')), enRed.join(' | '))

    const copiedEn = clone(en)
    copiedEn.downloadReasonFileFailed = zh.downloadReasonFileFailed
    const copiedRed = evaluate(zh, copiedEn).filter((r) => !r.ok).map((r) => r.name)
    check('把中文那句照抄到英文侧时被这一族独有那条抓住',
      copiedRed.some((name) => name.startsWith('下载那十句不是把中文照抄')), copiedRed.join(' | '))

    const drifted = { ...MODEL_DOWNLOAD_REASON_KEYS }
    delete drifted['sha-mismatch']
    const tableRed = evaluate(zh, en, undefined, undefined, undefined, undefined, undefined,
      { ...DOWNLOAD_TABLES_DEFAULT, reason: drifted }).filter((r) => !r.ok).map((r) => r.name)
    check('下载映射表漏一个码时被覆盖判据抓住',
      tableRed.some((name) => name.startsWith('模型下载的')), tableRed.join(' | '))

    const staleTable = { ...MODEL_DOWNLOAD_REASON_KEYS, 'no-such-old-code': 'downloadReasonFileFailed' }
    const staleRed = evaluate(zh, en, undefined, undefined, undefined, undefined, undefined,
      { ...DOWNLOAD_TABLES_DEFAULT, reason: staleTable }).filter((r) => !r.ok).map((r) => r.name)
    check('下载映射表留着词表外的旧码时被反向判据抓住',
      staleRed.some((name) => name.startsWith('下载映射表里没有词表外的旧码')), staleRed.join(' | '))

    const staleParams = { ...MODEL_DOWNLOAD_REASON_PARAMS, 'no-such-old-code': ['whatever'] }
    const paramRed = evaluate(zh, en, undefined, undefined, undefined, undefined, undefined,
      { ...DOWNLOAD_TABLES_DEFAULT, params: staleParams }).filter((r) => !r.ok).map((r) => r.name)
    check('下载的协议表留着词表外的旧码时被抓住（那份协议永远没人发）',
      paramRed.some((name) => name.startsWith('下载的参数的码表里没有词表外的旧码')), paramRed.join(' | '))

    const extraZh = clone(zh)
    extraZh.downloadReasonChunkFailed = `${zh.downloadReasonChunkFailed}（第 {retry} 次）`
    const extraRed = evaluate(extraZh, en).filter((r) => !r.ok).map((r) => r.name)
    check('句子里多一个宿主不会收集的占位符时被抓住（装机上是字面量 {retry}）',
      extraRed.some((name) => name.startsWith('下载那几句里没有协议不发的占位符')), extraRed.join(' | '))

    const thinEnParams = clone(en)
    thinEnParams.downloadReasonMergedSizeMismatch = 'The merged size is wrong; the bad chunks were removed, you can try again.'
    const unusedRed = evaluate(zh, thinEnParams).filter((r) => !r.ok).map((r) => r.name)
    check('英文那句把收来的参数丢用时也被抓住（中文带两个数字、英文一个都没有就是这句的形状）',
      unusedRed.some((name) => name.startsWith('下载按协议收集的参数')), unusedRed.join(' | '))

    const rewordedZh = clone(zh)
    const rewordedEn = clone(en)
    rewordedZh.downloadReasonShaMismatch = '{file} 的内容与档位声明不一致，校验没过；可以再试一次。'
    rewordedEn.downloadReasonShaMismatch = '{file} does not match the checksum declared by the catalog; try again.'
    const rewordedRed = evaluate(rewordedZh, rewordedEn).filter((r) => !r.ok).map((r) => r.name)
    check('把校验没过那句换成另一种说法（占位符照用）不会误红', rewordedRed.length === 0,
      rewordedRed.join(' | '))
  }
}

// ---------------------------------------------------------------------------
// 原因码怎么翻成文案（`src/client/pure/asr-ready-text.js` 查表那条路）。
// 判据 9 管的是「字典里有没有这些键」，这里管「取的时候会不会取错」：
//   认识的码 → 各自那句；不认识的码 / 空值 / 非字符串 → 兜底那句，
//   绝不把宿主回的原样显示到界面上（那正是批次 18 要拆掉的东西）。
// ---------------------------------------------------------------------------
console.log('\n开麦原因码怎么翻成文案')
{
  const identityT = (key) => key
  function check(name, ok, detail) {
    if (ok) { passed++; console.log('  ok   ' + name) }
    else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
  }

  for (const code of ASR_READY_REASON_VALUES) {
    const expectKey = ASR_READY_REASON_KEYS[code]
    const got = asrReadyReasonText(code, identityT)
    check(`认识的码「${code}」翻成「${expectKey}」`, got === expectKey, JSON.stringify(got))
  }

  // 词表外的值：旧宿主直接回中文句子、宿主和产物版本不一致、脏数据、大小写不同 —— 全部走兜底。
  const unknownValues = ['旧宿主直接写的那句中文', '', undefined, null, 42, 'LOAD-FAILED', 'loading ']
  for (const value of unknownValues) {
    const got = asrReadyReasonText(value, identityT)
    check(`词表外的值 ${JSON.stringify(value)} 走兜底那句（原文不进界面）`,
      got === 'modelFailedDetail', JSON.stringify(got))
  }

  // 兜底键按调用点可换：没下载那条链路的兜底是「还没下载」，不是「加载失败」。
  check('调用点可以指定兜底键（没下载那条链路用的是「还没下载」）',
    asrReadyReasonText(undefined, identityT, 'modelNotDownloadedDetail') === 'modelNotDownloadedDetail', '')
  // 传进来的 `t` 才是文案的唯一来源：这里给一句假的，输出必须就是它给的。
  check('句子完全由取词函数出（宿主侧无法影响）',
    asrReadyReasonText('loading', () => 'OUT-OF-DICT') === 'OUT-OF-DICT', '')
}

// ---------------------------------------------------------------------------
// 热键原因码怎么翻成文案（`src/client/pure/hotkey-reason-text.js`）。
// 和开麦那一族同一个规矩：认识的码 → 表里那句；不认识的（旧宿主写来的中文句子、
// 字段缺失、拼错）→ 兜底那句，绝不把宿主给的原样显示到界面上。
// ---------------------------------------------------------------------------
console.log('\n热键原因码怎么翻成文案')
{
  const identityT = (key) => key
  function check(name, ok, detail) {
    if (ok) { passed++; console.log('  ok   ' + name) }
    else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
  }

  for (const code of HOTKEY_REASON_VALUES) {
    const expectKey = HOTKEY_REASON_KEYS[code]
    const got = hotkeyReasonText(code, identityT)
    check(`热键码「${code}」翻成「${expectKey}」`, got === expectKey, JSON.stringify(got))
  }

  // 词表外的值：旧宿主的中文句子、状态字符串被误当原因码、空值、非字符串。
  const unknownValues = [
    '热键注册失败（可能被其他程序占用），系统级热键未生效',
    '已启动（Ctrl+Alt+V, pid=1000）',
    'REGISTER-FAILED', 'register_failed', 'native-unavailable ',
    '', undefined, null, 42, true,
  ]
  for (const value of unknownValues) {
    const got = hotkeyReasonText(value, identityT)
    check(`词表外的值 ${JSON.stringify(value)} 走兜底那句（原文不进界面）`,
      got === 'hotkeyReasonUnknown', JSON.stringify(got))
  }

  check('调用点可以指定兜底键',
    hotkeyReasonText(undefined, identityT, 'hotkeyStatusUnknown') === 'hotkeyStatusUnknown', '')
  check('热键的句子完全由取词函数出（宿主侧无法影响）',
    hotkeyReasonText('register-failed', () => 'OUT-OF-DICT') === 'OUT-OF-DICT', '')
}

// ---------------------------------------------------------------------------
// 配置校验码怎么翻成文案（`src/client/pure/config-error-text.js`）。
// 前两族是「一个码一句」，这一族多一件要判的事：**句子里的动态值**（允许值、区间、
// 长度上限）必须由 shared 的规则现场算，不能由宿主传 —— 传了就把「谁写界面那句话」
// 又交回宿主手里了。所以这里用一个记录参数取法，把 `t` 收到的 params 也判住。
// ---------------------------------------------------------------------------
console.log('\n配置校验码怎么翻成文案')
{
  const identityT = (key) => key
  function check(name, ok, detail) {
    if (ok) { passed++; console.log('  ok   ' + name) }
    else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
  }

  for (const code of CONFIG_ERROR_REASON_VALUES) {
    const expectKey = CONFIG_ERROR_KEYS[code]
    const got = configErrorText(code, 'model', identityT)
    check(`校验码「${code}」翻成「${expectKey}」`, got === expectKey, JSON.stringify(got))
  }

  // 词表外的值：旧宿主的整句中文、把配置值当码传进来、空值、非字符串。
  const unknownValues = [
    '必须是 online/neural/local/sovits',
    '第 3 条超过 32 字符',
    'NOT-IN-ENUM', 'not_in_enum', 'not-in-enum ',
    '', undefined, null, 42, true,
  ]
  for (const value of unknownValues) {
    const got = configErrorText(value, 'ttsEngine', identityT)
    check(`词表外的值 ${JSON.stringify(value)} 走兜底那句（原文不进界面）`,
      got === 'configErrorUnknown', JSON.stringify(got))
  }

  check('调用点可以指定兜底键',
    configErrorText(undefined, '', identityT, 'configSaveRejected') === 'configSaveRejected', '')
  check('校验错误的句子完全由取词函数出（宿主侧无法影响）',
    configErrorText('not-in-enum', 'ttsEngine', () => 'OUT-OF-DICT') === 'OUT-OF-DICT', '')

  // 动态值来自 shared 规则，且**只来自它**（`configErrorText` 的入参里根本没有宿主原文，
  // 这一点是结构上就断掉的；这里判的是「取的是不是这一格的那份规则」）。
  // 期望值也从 spec 现取，不写死数字：改上限是正当的，写死会让正当改动误红。
  const seen = []
  const recT = (key, params) => {
    seen.push({ key, params })
    return key
  }
  configErrorText('not-in-enum', 'ttsEngine', recT, 'configErrorUnknown')
  configErrorText('out-of-range', 'silenceMs', recT)
  configErrorText('too-long', 'wakeWord', recT)
  configErrorText('words-too-many', 'words', recT)
  configErrorText('words-entry-too-long', 'words', recT)
  const params = seen.map((row) => row.params)
  check('枚举那句带的是这一格 spec 的允许值',
    JSON.stringify(params[0]) === JSON.stringify({ values: specFor('ttsEngine').values.join(' / ') }),
    JSON.stringify(params[0]))
  check('枚举那句的允许值就是 shared 词表那份（宿主改不了）',
    params[0]?.values === TTS_ENGINES.join(' / '), JSON.stringify(params[0]))
  check('区间那句带的是这一格 spec 的 min/max',
    JSON.stringify(params[1]) === JSON.stringify({ min: specFor('silenceMs').min, max: specFor('silenceMs').max }),
    JSON.stringify(params[1]))
  check('长度那句带的是这一格 spec 的 maxLen',
    JSON.stringify(params[2]) === JSON.stringify({ maxLen: specFor('wakeWord').maxLen }),
    JSON.stringify(params[2]))
  check('词表那两句带的是 shared 的条数/字数上限',
    JSON.stringify(params[3]) === JSON.stringify({ max: MAX_WORDS })
      && JSON.stringify(params[4]) === JSON.stringify({ max: MAX_WORD_CHARS }),
    JSON.stringify(params.slice(3)))
  check('没有 key（整份请求的错）时不硬凑参数',
    configErrorText('not-in-enum', '', (key, p) => `${key}:${JSON.stringify(p)}`)
      === 'configErrorEnum:undefined', '')
  check('未知键名也不会崩（specFor 给 null，句子照出）',
    configErrorText('out-of-range', 'noSuchKey', identityT) === 'configErrorRange', '')

  // 字段名那一半：配置键交给字典，空键交空串（那一行不带前缀）。
  check('字段名 = t(配置键)，字典里有就出人话', configFieldLabel('wakeWord', identityT) === 'wakeWord', '')
  check('空配置键给出空串（整份请求的错误行不带前缀）',
    configFieldLabel('', identityT) === '' && configFieldLabel(undefined, identityT) === '', '')
  check('字典里没有的旧键仍走 t（产物里退回键名本身，不显示成空白）',
    configFieldLabel('legacyKey', (key) => `⟨${key}⟩`) === '⟨legacyKey⟩', '')
}

// ---------------------------------------------------------------------------
// 快捷键校验码怎么翻成文案（`src/client/pure/shortcut-error-text.js`）。
// 前三族的句子是「客户端字典出的、码由宿主发」；这一族的码和句子**都在客户端**
// （批次 22 之前，`pure/shortcut.js` 直接把五条中文发给面板显示）。
// 所以这里除了查表与兜底，还多判一件事：**句子真的能把参数填进去** ——
// 填不上就是界面上一对花括号，而这正是这一族独有的失败形状（参数是用户自己写的那个键）。
// ---------------------------------------------------------------------------
console.log('\n快捷键校验码怎么翻成文案')
{
  const identityT = (key) => key
  function check(name, ok, detail) {
    if (ok) { passed++; console.log('  ok   ' + name) }
    else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
  }

  // 五条规则各触发一次：校验发的码 → 表里的键，两头接得上（键名从表里现取，不写死）。
  const comboToCode = {
    '': 'empty',
    'v': 'too-few-parts',
    'Shift+V': 'single-letter',
    'Foo+V': 'unknown-modifier',
    'Ctrl+Shift+V': 'reserved-paste',
  }
  for (const [combo, expectCode] of Object.entries(comboToCode)) {
    const result = validateShortcut(combo)
    check(`「${combo}」这条路径发的码就是「${expectCode}」`, result.reason === expectCode,
      JSON.stringify(result))
    check(`快捷键码「${expectCode}」翻成「${SHORTCUT_ERROR_KEYS[expectCode]}」`,
      shortcutErrorText(result, identityT) === SHORTCUT_ERROR_KEYS[expectCode],
      JSON.stringify(shortcutErrorText(result, identityT)))
  }

  // 词表外的值：改前那五句中文（万一有别处还在发整句）、大小写、带尾空格、空值、非字符串。
  const unknownValues = [
    '不能为空', '至少要两个键，例如 Ctrl+Shift+Space', '不认识的修饰键：foo',
    '别用单个字母，否则打字会误触发（单字母需要搭配 Ctrl/Alt）',
    'Ctrl+Shift+V 是浏览器的「粘贴为纯文本」',
    'EMPTY', 'single_letter', 'unknown-modifier ', '', undefined, null, 42, true,
  ]
  for (const value of unknownValues) {
    const got = shortcutErrorText({ ok: false, reason: value, params: { modifier: 'foo' } }, identityT)
    check(`词表外的值 ${JSON.stringify(value)} 走兜底那句（原文不进界面）`,
      got === 'shortcutErrorUnknown', JSON.stringify(got))
  }

  // 整份结果缺失 / 合法值被误当失败显示：都要有一句，不许是空白。
  check('结果整个缺失时走兜底那句',
    shortcutErrorText(undefined, identityT) === 'shortcutErrorUnknown', '')
  check('空对象时走兜底那句', shortcutErrorText({}, identityT) === 'shortcutErrorUnknown', '')
  check('合法值（ok:true）被误用时也是兜底那句，而不是 undefined',
    shortcutErrorText(validateShortcut('Alt+V'), identityT) === 'shortcutErrorUnknown', '')
  check('调用点可以指定兜底键',
    shortcutErrorText({ reason: 'no-such-code' }, identityT, 'shortcutErrorTooFewParts')
      === 'shortcutErrorTooFewParts', '')
  check('快捷键那句完全由取词函数出（校验层影响不了措辞）',
    shortcutErrorText(validateShortcut(''), () => 'OUT-OF-DICT') === 'OUT-OF-DICT', '')

  // 参数那一半：谁带参数、带的是不是用户写的那个东西、不该带的有没有硬凑。
  const seen = []
  const recT = (key, params) => {
    seen.push({ key, params })
    return key
  }
  shortcutErrorText(validateShortcut('Foo+V'), recT)
  shortcutErrorText(validateShortcut('Shift+K'), recT)
  shortcutErrorText(validateShortcut('Ctrl+Shift+V'), recT)
  shortcutErrorText(validateShortcut(''), recT)
  shortcutErrorText(validateShortcut('v'), recT)
  check('不认识的修饰键那句带的是用户写的那个键名（小写形式）',
    seen[0].key === 'shortcutErrorUnknownModifier'
      && JSON.stringify(seen[0].params) === JSON.stringify({ modifier: 'foo' }),
    JSON.stringify(seen[0]))
  check('单字母那句带的是那个字母',
    seen[1].key === 'shortcutErrorSingleLetter'
      && JSON.stringify(seen[1].params) === JSON.stringify({ key: 'k' }),
    JSON.stringify(seen[1]))
  check('浏览器占用那句带的是那一组（规范化后的写法）',
    seen[2].key === 'shortcutErrorReservedPaste'
      && JSON.stringify(seen[2].params) === JSON.stringify({ combo: 'Ctrl+Shift+V' }),
    JSON.stringify(seen[2]))
  check('不需要参数的两句不硬凑参数（第二个参数是 undefined）',
    seen[3].params === undefined && seen[4].params === undefined,
    JSON.stringify(seen.slice(3)))

  // 端到端：句子真填得进去（这是批次 22 顺手修的那条老毛病 —— 兜底取词以前丢掉第二个参数）。
  check('中文那句把 foo 填进去了（宿主没给 props.t 时用户看到的就是这句）',
    shortcutErrorText(validateShortcut('Foo+V'), zhTranslate) === '不认识的修饰键：foo。',
    shortcutErrorText(validateShortcut('Foo+V'), zhTranslate))
  check('英文侧同样填得进去（切英文不许掉回中文）',
    shortcutErrorText(validateShortcut('Foo+V'), (key, params) => interpolate(en[key] ?? key, params))
      === 'Unknown modifier key: foo.',
    shortcutErrorText(validateShortcut('Foo+V'), (key, params) => interpolate(en[key] ?? key, params)))
  check('五句里没有一个花括号留在成品句子中',
    Object.keys(comboToCode).every((combo) => {
      const text = shortcutErrorText(validateShortcut(combo), zhTranslate)
      return !/[{}]/.test(text)
    }),
    Object.keys(comboToCode).map((combo) => shortcutErrorText(validateShortcut(combo), zhTranslate)).join(' / '))
  check('批次 20 那句带区间的红字在兜底路上也填得进去（同一个函数修的两半）',
    configErrorText('out-of-range', 'silenceMs', zhTranslate)
      === `要在 ${specFor('silenceMs').min} 到 ${specFor('silenceMs').max} 之间。`,
    configErrorText('out-of-range', 'silenceMs', zhTranslate))

  // `interpolate` 自己的边界（它现在服务整族带参数的文案，不只是快捷键）。
  check('取不到的名字保持原样（宁可露一个 {x}，也不给一句读不通的空）',
    interpolate('a {miss} b', { other: 1 }) === 'a {miss} b', interpolate('a {miss} b', { other: 1 }))
  check('参数不是对象时原样返回（不把句子弄崩）',
    interpolate('a {x}', undefined) === 'a {x}' && interpolate('a {x}', 'str') === 'a {x}', '')
  check('数字/布尔参数转成字符串（0 与 false 不许被当成没给）',
    interpolate('{n}', { n: 0 }) === '0' && interpolate('{b}', { b: false }) === 'false', '')
  check('键查不到时兜底取词给出键名本身（照旧不显示成空白）',
    zhTranslate('noSuchKeyAtAll') === 'noSuchKeyAtAll', '')
}

// ---------------------------------------------------------------------------
// 面板的选项与展示名怎么取（批次 22-2，§8.65）。
// 判据 13 管「字典里有没有这些键」，这里管「取的时候会不会取错」。
// 这一族和前四族**不一样**的地方：词表外的值不许走兜底那句。
// 语言码与音色短名是**契约值**，宿主/上游随时可能新增一个 —— 那时把新值原样显示出来，
// 用户还知道选的是什么；换成「这个合成引擎不认识」那种兜底句就丢信息了。
// 引擎 id 反过来：脏 id 表示配置坏了，显示 id 对用户没意义，所以走兜底那句。
// ---------------------------------------------------------------------------
console.log('\n面板的选项与展示名怎么取')
{
  const identityT = (key) => key
  const recordingT = (key, params) => `${key}::${JSON.stringify(params ?? {})}`
  function check(name, ok, detail) {
    if (ok) { passed++; console.log('  ok   ' + name) }
    else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
  }

  // 1) 语言：六个契约码各查到自己那句。
  for (const code of ASR_LANGUAGES) {
    const expectKey = LANGUAGE_LABEL_KEYS[code]
    check(`语言「${code}」翻成字典键「${expectKey}」`,
      languageLabel(code, identityT) === expectKey, languageLabel(code, identityT))
  }
  // 词表外：新语言 / 脏值 / 空值 —— 一律原样，不替用户编一句话。
  for (const value of ['fr', 'de-DE', '', '  ', undefined, null, 42]) {
    const expect = String(value ?? '').trim()
    check(`词表外的语言 ${JSON.stringify(value)} 原样显示（不许走兜底句、也不许变成空白）`,
      languageLabel(value, identityT) === expect, JSON.stringify(languageLabel(value, identityT)))
  }
  check('语言名不传 t 时走中文兜底那句（宿主没给取词函数的老调用点）',
    languageLabel('yue') === zh.langYue && languageLabel('auto') === zh.langAuto,
    `${languageLabel('yue')} / ${languageLabel('auto')}`)
  check('语言名走英文界面时拿到的是英文（同一支表、两种语言）',
    languageLabel('zh', (key) => en[key]) === en.langZh, languageLabel('zh', (key) => en[key]))

  // 2) 音色：24 个上游短名各查到自己那句。
  for (const [name, expectKey] of Object.entries(VOICE_LABEL_KEYS)) {
    check(`音色「${name}」翻成字典键「${expectKey}」`,
      voiceLabel(name, identityT) === expectKey, voiceLabel(name, identityT))
  }
  for (const name of ['ja-JP-NanamiNeural', '', 'no-such-voice']) {
    check(`词表外的音色「${name}」原样显示（新音色不许变成兜底句）`,
      voiceLabel(name, identityT) === name, JSON.stringify(voiceLabel(name, identityT)))
  }
  check('音色短名带前后空格照样查到（配置里存的是不是干净值不由我们保证）',
    voiceLabel('  Tingting  ', identityT) === 'voiceTingting', voiceLabel('  Tingting  ', identityT))
  check('音色不传 t 时走中文兜底那句', voiceLabel('cmn') === zh.voiceCmn, voiceLabel('cmn'))

  // 3) 引擎：四个契约 id 各一句；`local` 在两情形下是两句不同的话；脏 id 走兜底。
  for (const engine of TTS_ENGINES) {
    check(`引擎「${engine}」翻成字典键「${TTS_ENGINE_OPTION_KEYS[engine]}」`,
      ttsEngineOptionLabel(engine, identityT) === TTS_ENGINE_OPTION_KEYS[engine],
      ttsEngineOptionLabel(engine, identityT))
  }
  check('local 在支持本地语音的机器上是「本地系统语音」那一句',
    ttsEngineOptionLabel('local', identityT, true) === 'engineOptionLocal',
    ttsEngineOptionLabel('local', identityT, true))
  check('local 在不支持的机器上是另一句（说了名字不说「这台机器没有」是骗人）',
    ttsEngineOptionLabel('local', identityT, false) === 'engineOptionLocalUnsupported',
    ttsEngineOptionLabel('local', identityT, false))
  for (const id of ['no-such-engine', '', '   ', undefined, null, 42]) {
    check(`脏引擎 id ${JSON.stringify(id)} 走兜底那句（界面上不出现裸 id）`,
      ttsEngineOptionLabel(id, identityT) === 'engineOptionUnknown',
      JSON.stringify(ttsEngineOptionLabel(id, identityT)))
  }

  // 4) 空闲释放档位：数字怎么称呼，全看这个数本身。
  const idleCases = [
    [0, 'idleReleaseNever', {}],
    ['', 'idleReleaseNever', {}],
    [-1, 'idleReleaseNever', {}],
    ['abc', 'idleReleaseNever', {}],
    [5, 'idleReleaseInMinutes', { minutes: '5' }],
    ['30', 'idleReleaseInMinutes', { minutes: '30' }],
    [90, 'idleReleaseInMinutes', { minutes: '90' }],
    [60, 'idleReleaseInHours', { hours: '1' }],
    ['120', 'idleReleaseInHours', { hours: '2' }],
  ]
  for (const [value, expectKey, expectParams] of idleCases) {
    const got = idleReleaseLabel(value, recordingT)
    check(`释放档位 ${JSON.stringify(value)} → 「${expectKey}」带 ${JSON.stringify(expectParams)}`,
      got === `${expectKey}::${JSON.stringify(expectParams)}`, got)
  }
  // 端到端：这句话真的通顺（判据 14 只保证占位符填得进去，填完是不是人话要看成品）。
  const enT = (key, params) => interpolate(en[key] ?? key, params)
  check('中文兜底：档位那句填得进去（不传 t 时用户看到的就是这几句）',
    idleReleaseLabel(5) === '5 分钟' && idleReleaseLabel(60) === '1 小时' && idleReleaseLabel(0) === '永不释放',
    `${idleReleaseLabel(5)} / ${idleReleaseLabel(60)} / ${idleReleaseLabel(0)}`)
  check('英文界面：同一支函数拿到英文那句',
    idleReleaseLabel(5, enT) === '5 min' && idleReleaseLabel(60, enT) === '1 h',
    `${idleReleaseLabel(5, enT)} / ${idleReleaseLabel(60, enT)}`)
  check('这几条档位没有一个花括号留在成品句子中',
    idleCases.every(([v]) => !/[{}]/.test(idleReleaseLabel(v, zhTranslate))),
    idleCases.map(([v]) => idleReleaseLabel(v, zhTranslate)).join(' / '))

  // 5) 说话人序号与「需先下载」那两个由**面板 JSX** 发参数的键：兜底路上也填得进去。
  //    参数名在这里是手抄的（真正的调用点判在 client-behavior 的渲染树上），
  //    这条只保证「字典句子 + 这个名字 = 一句人话」，名字对不对由那边判。
  check('「说话人 N」在兜底路上填得进去',
    zhTranslate('neuralSpeakerOption', { index: '3' }) === '说话人 3',
    zhTranslate('neuralSpeakerOption', { index: '3' }))
  check('「需先下载 …」在兜底路上填得进去',
    zhTranslate('liveAsrStreamNeedsOption', { model: 'zipformer2-zh' }) === '（需先下载 zipformer2-zh）',
    zhTranslate('liveAsrStreamNeedsOption', { model: 'zipformer2-zh' }))

  // 6) 模型档位名（批次 22-3-1，§8.66）：取词函数走的是同一张表的形状，
  //    但它的**内容判在目录上** —— 兜底那句必须逐字是目录的 `label`，
  //    英文那句必须逐字是目录的 `labelEn`（宿主那份英文第一次真上界面，不是我们另写的）。
  for (const tier of MODEL_TIERS) {
    check(`目录档位「${tier.id}」按中文界面取到的是目录自己那句`,
      modelLabel(tier.id, zhTranslate) === tier.label,
      `${JSON.stringify(modelLabel(tier.id, zhTranslate))} ≠ ${JSON.stringify(tier.label)}`)
    check(`目录档位「${tier.id}」按英文界面取到的是目录 labelEn`,
      modelLabel(tier.id, enT) === tier.labelEn,
      `${JSON.stringify(modelLabel(tier.id, enT))} ≠ ${JSON.stringify(tier.labelEn)}`)
    check(`目录档位「${tier.id}」在恒等 t 下露的是字典键（说明这句真由字典出）`,
      modelLabel(tier.id, identityT) === MODEL_LABEL_KEYS[tier.id],
      modelLabel(tier.id, identityT))
    check(`目录档位「${tier.id}」取出来的成品里没有花括号`,
      !/[{}]/.test(modelLabel(tier.id, zhTranslate)), modelLabel(tier.id, zhTranslate))
  }
  for (const id of ['no-such-model', 'some-future-tier']) {
    check(`目录里没有的档位「${id}」原样显示（不许编一句「未知模型」把身份盖掉）`,
      modelLabel(id, zhTranslate) === id, modelLabel(id, zhTranslate))
  }
  check('档位 id 带前后空格照样查到（宿主给的不是我们写的）',
    modelLabel('  sensevoice  ', identityT) === 'modelSensevoice', modelLabel('  sensevoice  ', identityT))
  check('档位 id 是空/缺失时不崩、显示空串而不是 undefined',
    modelLabel(undefined, identityT) === '' && modelLabel(null, identityT) === '',
    `${JSON.stringify(modelLabel(undefined, identityT))}/${JSON.stringify(modelLabel(null, identityT))}`)
}

// ---------------------------------------------------------------------------
// 环境自检那几行怎么取词（批次 22-3-2，§8.67）。
// 判据 18/19 管「字典里有没有这些键、句子对不对得上协议」，这里管「取的时候会不会取错」。
// 这一族和前四族同一个规矩：词表外的值（旧宿主写来的整句中文、脏数据、产物版本不一致）
// 一律走兜底那句，绝不把宿主 `detail` 里的原文显示到界面上 —— 那正是本批要拆的东西。
// 多出来的一件要判的是 `{runtime}`：它进句子前还要再过一次字典（一个词也是话）。
// ---------------------------------------------------------------------------
console.log('\n环境自检那几行怎么取词')
{
  const identityT = (key) => key
  const enT = (key, params) => interpolate(en[key] ?? key, params)
  function check(name, ok, detail) {
    if (ok) { passed++; console.log('  ok   ' + name) }
    else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
  }

  // 1) 十四个码各查到自己那句（键名从表里现取，不写死）。
  for (const code of TTS_ENV_REASON_VALUES) {
    const expectKey = TTS_ENV_REASON_KEYS[code]
    const given = {}
    for (const name of TTS_ENV_REASON_PARAMS[code] ?? []) given[name] = SAMPLE_PARAMS[name]
    check(`自检码「${code}」翻成「${expectKey}」`,
      ttsEnvReasonText(code, identityT, given) === expectKey,
      JSON.stringify(ttsEnvReasonText(code, identityT, given)))
  }

  // 2) 只收这个码要的那几个参数：宿主多带的东西不许溜进句子（带了也用不上，
  //    而「界面那句话里有什么」必须只由协议决定）。
  const seen = []
  const recT = (key, params) => {
    seen.push({ key, params })
    return key
  }
  ttsEnvReasonText('local-ready-powershell', recT, { version: '5.1.19041.1', voice: 'Tingting', note: '宿主那句中文', detail: '宿主留给 /diagnostics 的原文' })
  check('界面那句只收协议里那两个名字（宿主多带的字段进不来）',
    JSON.stringify(seen[0]) === JSON.stringify({ key: 'envReasonLocalReadyPowershell', params: { version: '5.1.19041.1', voice: 'Tingting' } }),
    JSON.stringify(seen[0]))

  // 3) `{runtime}` 进句子前先翻一次：契约值 native/wasm 各有中英两句。
  //    记录用的 `t` 会被**两次**调到（先运行时那一词、后整句），所以按顺序看这一串，
  //    而不是只看最后一句 —— 「一个词也是话」这件事就体现在这次先发生的查表上。
  const rowsFor = (code, given) => {
    const rows = []
    const t = (key, params) => {
      rows.push({ key, params })
      return key
    }
    ttsEnvReasonText(code, t, given)
    return rows
  }
  const nativeRows = rowsFor('neural-ready', { model: 'vits-melo-zh_en', runtime: 'native' })
  const wasmRows = rowsFor('neural-ready', { model: 'vits-melo-zh_en', runtime: 'wasm' })
  check('runtime 这个词先过一次字典（native 不许原样填进句子）',
    nativeRows[0]?.key === 'envRuntimeNative' && nativeRows.length === 2,
    JSON.stringify(nativeRows))
  check('整句拿到的是翻译后的那一词',
    JSON.stringify(nativeRows[1]) === JSON.stringify({ key: 'envReasonNeuralReady', params: { model: 'vits-melo-zh_en', runtime: 'envRuntimeNative' } }),
    JSON.stringify(nativeRows[1]))
  check('wasm 走另一句（英文界面不许显示成上游写法）',
    wasmRows[0]?.key === 'envRuntimeWasm'
      && JSON.stringify(wasmRows[1]?.params) === JSON.stringify({ model: 'vits-melo-zh_en', runtime: 'envRuntimeWasm' }),
    JSON.stringify(wasmRows))
  check('运行时词表外的值原样填（未知的种类仍是读得出的技术值）',
    envRuntimeLabel('CUDA', identityT) === 'CUDA' && envRuntimeLabel('', identityT) === '',
    `${JSON.stringify(envRuntimeLabel('CUDA', identityT))}/${JSON.stringify(envRuntimeLabel('', identityT))}`)
  check('运行时的两句不传 t 时给中文兜底（老调用点没有取词函数）',
    envRuntimeLabel('native') === zh.envRuntimeNative && envRuntimeLabel('wasm') === zh.envRuntimeWasm,
    `${envRuntimeLabel('native')} / ${envRuntimeLabel('wasm')}`)

  // 4) 引擎行名：四个契约 id 各一句，脏 id 走「另一个引擎（{id}）」并把 id 露出来。
  for (const engine of TTS_ENGINES) {
    check(`引擎「${engine}」的自检行名走「${ENV_ENGINE_LABEL_KEYS[engine]}」`,
      envEngineLabel(engine, identityT) === ENV_ENGINE_LABEL_KEYS[engine],
      envEngineLabel(engine, identityT))
  }
  check('词表外的引擎 id 走兜底那句、并把 id 作为参数带出去（身份不能丢）',
    envEngineLabel('future-engine', (key, params) => `${key}::${JSON.stringify(params ?? {})}`)
      === 'envEngineUnknown::{"id":"future-engine"}',
    envEngineLabel('future-engine', (key, params) => `${key}::${JSON.stringify(params ?? {})}`))
  check('id 是空/缺失时不崩、也不显示成 undefined',
    envEngineLabel(undefined, identityT) === 'envEngineUnknown'
      && envEngineLabel(null, identityT) === 'envEngineUnknown'
      && envEngineLabel('  neural  ', identityT) === 'envEngineNeural', '')

  // 5) 词表外的值：改前宿主写的那几句中文整句、把状态字符串当码、大小写、带尾空格、空值、非字符串。
  const unknownValues = [
    '可用（Windows PowerShell 5.1），默认发音人：Microsoft Tingting - 中文普通话',
    '模型还没下载（本地中英双语 VITS），请到设置里点「下载」。',
    `连不上：${'fake WebSocket error'}`,
    'ONLINE-READY', 'online_ready', 'online-ready ',
    '', undefined, null, 42, true,
  ]
  for (const value of unknownValues) {
    const got = ttsEnvReasonText(value, identityT, { version: 'x', voice: 'y' })
    check(`词表外的值 ${JSON.stringify(value)} 走兜底那句（宿主原文不进界面）`,
      got === 'envReasonUnknown', JSON.stringify(got))
  }
  check('调用点可以指定兜底键',
    ttsEnvReasonText(undefined, identityT, undefined, 'envReasonNeuralNoTier') === 'envReasonNeuralNoTier', '')
  check('自检那句完全由字典出（宿主侧无法影响措辞）',
    ttsEnvReasonText('online-ready', () => 'OUT-OF-DICT', { count: '3' }) === 'OUT-OF-DICT', '')

  // 6) 端到端：按协议给齐参数时，十四句成品里没有一句留花括号。
  const noBrace = TTS_ENV_REASON_VALUES.map((code) => {
    const given = {}
    for (const name of TTS_ENV_REASON_PARAMS[code] ?? []) given[name] = SAMPLE_PARAMS[name]
    return ttsEnvReasonText(code, zhTranslate, given)
  })
  check('中文界面这十四句都填得进去（不出现字面量 {model}）',
    noBrace.every((text) => !/[{}]/.test(text)), noBrace.filter((text) => /[{}]/.test(text)).join(' / '))
  const noBraceEn = TTS_ENV_REASON_VALUES.map((code) => {
    const given = {}
    for (const name of TTS_ENV_REASON_PARAMS[code] ?? []) given[name] = SAMPLE_PARAMS[name]
    return ttsEnvReasonText(code, enT, given)
  })
  check('英文界面同样填得进去（切英文不许掉回中文、也不许留花括号）',
    noBraceEn.every((text) => !/[{}]/.test(text)), noBraceEn.filter((text) => /[{}]/.test(text)).join(' / '))
  check('本地语音那句把版本号与音色名填进去了',
    ttsEnvReasonText('local-ready-powershell', zhTranslate, { version: '5.1.19041.1', voice: 'Tingting' })
      === '可用（Windows PowerShell 5.1.19041.1），默认发音人：Tingting',
    ttsEnvReasonText('local-ready-powershell', zhTranslate, { version: '5.1.19041.1', voice: 'Tingting' }))
  check('神经就绪那句英文侧填的是字典的运行时名（不是上游的 native）',
    ttsEnvReasonText('neural-ready', enT, { model: 'vits-melo-zh_en', runtime: 'native' })
      === 'Ready (vits-melo-zh_en, native runtime); offline neural voices, about 1.6 s per sentence.',
    ttsEnvReasonText('neural-ready', enT, { model: 'vits-melo-zh_en', runtime: 'native' }))

  // 7) 宿主少收一个参数时的形状：那一格保持花括号原样（interpolate 的既定策略），
  //    不许变成 `undefined` —— 露一个 {voice} 至少说明「这个值没拿到」，`undefined` 是假装有值。
  check('宿主少给一个参数时句子照出、缺的那格不伪装成值',
    ttsEnvReasonText('local-ready-powershell', zhTranslate, { version: '5.1' })
      === '可用（Windows PowerShell 5.1），默认发音人：{voice}',
    ttsEnvReasonText('local-ready-powershell', zhTranslate, { version: '5.1' }))
  check('参数整个缺失也不崩（走查表那条路，格子留原样）',
    ttsEnvReasonText('online-ready', zhTranslate) === '可用（服务端返回 {count} 个音色）',
    ttsEnvReasonText('online-ready', zhTranslate))
}

// ---------------------------------------------------------------------------
// 下载失败那一行怎么取词（批次 22-4-2，§8.71）。
// 判据 20/21 管「字典里有没有这些键、句子对不对得上协议」，这里管「取的时候会不会取错」。
// 这一族的收端从前有两种相反的毛病（§8.68 裁定 4）：一边把宿主原文直接贴上界面，
// 一边把事件载荷整片丢弃只留一句「下载失败」。接上码表之后这里判的就是两件事都不许回来：
// 词表外的值（旧宿主写来的整句中文、脏数据、大小写）一律走兜底那句；
// 而「完全没带码」和「码读不出来」是两条不同的路 —— 前者是兼容（旧宿主没这个字段），
// 后者是数据坏了，两句诚实的说法不一样。
// ---------------------------------------------------------------------------
console.log('\n下载失败那一行怎么取词')
{
  const identityT = (key) => key
  const enT = (key, params) => interpolate(en[key] ?? key, params)
  const SAMPLE = {
    model: 'whisper-tiny',
    file: 'model.onnx',
    status: '404',
    chunks: '2, 5',
    chunk: '3',
    got: '1048576',
    expected: '2097152',
  }
  function check(name, ok, detail) {
    if (ok) { passed++; console.log('  ok   ' + name) }
    else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
  }

  // 1) 十个码各查到自己那句（键名从表里现取，不写死）。
  for (const code of MODEL_DOWNLOAD_REASON_VALUES) {
    const expectKey = MODEL_DOWNLOAD_REASON_KEYS[code]
    const given = {}
    for (const name of MODEL_DOWNLOAD_REASON_PARAMS[code] ?? []) given[name] = SAMPLE[name]
    check(`下载码「${code}」翻成「${expectKey}」`,
      modelDownloadReasonText(code, identityT, given) === expectKey,
      JSON.stringify(modelDownloadReasonText(code, identityT, given)))
  }

  // 2) 十个码十句，不许两个码共用一句（这一族的裁定是按「用户该做什么」分句，
  //    合并就会把「重试没用」说成「再试一次」，那是让用户白点按钮）。
  {
    const keys = MODEL_DOWNLOAD_REASON_VALUES.map((code) => MODEL_DOWNLOAD_REASON_KEYS[code])
    const dup = keys.filter((key, index) => keys.indexOf(key) !== index)
    check('十个码各走各的那句（没有两个码挤进同一句文案）', dup.length === 0, dup.join(','))
  }

  // 3) 只收这个码协议点名的参数：宿主多带的东西不许溜进句子。
  //    `model-error` 事件的载荷里就有 `error`（那句原文），它必须到不了界面。
  const seen = []
  const recT = (key, params) => {
    seen.push({ key, params })
    return key
  }
  modelDownloadReasonText('sha-mismatch', recT, {
    file: 'model.onnx',
    model: 'whisper-tiny',
    error: '拼接后大小不对：model.onnx',
    hint: '宿主留给 /diagnostics 的字段',
  })
  check('界面那句只收协议里那一个名字（宿主多带的 error/model 进不来）',
    JSON.stringify(seen[0]) === JSON.stringify({ key: 'downloadReasonShaMismatch', params: { file: 'model.onnx' } }),
    JSON.stringify(seen[0]))

  // 4) 「没带码」的两条路分开走。
  for (const value of ['', undefined, null]) {
    check(`空码 ${JSON.stringify(value)} 走兼容那句（旧宿主没有这个字段）`,
      modelDownloadReasonText(value, identityT, { file: 'x' }) === 'downloadFailed',
      JSON.stringify(modelDownloadReasonText(value, identityT, { file: 'x' })))
  }
  const badCodeValues = [
    '该档位没有可下载的文件：whisper-tiny',
    '分片下载失败：model.onnx（第 3 片）',
    'unknown model: whisper-tiny',
    '宿主内置模型不可用：本地中英双语',
    'file_failed', 'SHA-MISMATCH', 'sha-mismatch ', '  chunk-failed',
    42, true, {}, [],
  ]
  for (const value of badCodeValues) {
    check(`词表外的值 ${JSON.stringify(value)} 走「读不出来」那句（宿主原文不进界面）`,
      modelDownloadReasonText(value, identityT, { file: 'x', status: '404' }) === 'downloadReasonUnknown',
      JSON.stringify(modelDownloadReasonText(value, identityT, { file: 'x' })))
  }
  check('调用点可以指定兜底键',
    modelDownloadReasonText(undefined, identityT, undefined, 'downloadReasonFailedUnknown')
      === 'downloadReasonFailedUnknown', '')
  check('那句完全由字典出（宿主侧无法影响措辞）',
    modelDownloadReasonText('file-failed', () => 'OUT-OF-DICT', { file: 'x' }) === 'OUT-OF-DICT', '')

  // 5) 端到端：按协议给齐参数时，十句成品里没有一句留花括号。
  const zhFilled = MODEL_DOWNLOAD_REASON_VALUES.map((code) => {
    const given = {}
    for (const name of MODEL_DOWNLOAD_REASON_PARAMS[code] ?? []) given[name] = SAMPLE[name]
    return modelDownloadReasonText(code, zhTranslate, given)
  })
  check('中文界面这十句都填得进去（不出现字面量 {file}）',
    zhFilled.every((text) => !/[{}]/.test(text)), zhFilled.filter((text) => /[{}]/.test(text)).join(' / '))
  const enFilled = MODEL_DOWNLOAD_REASON_VALUES.map((code) => {
    const given = {}
    for (const name of MODEL_DOWNLOAD_REASON_PARAMS[code] ?? []) given[name] = SAMPLE[name]
    return modelDownloadReasonText(code, enT, given)
  })
  check('英文界面同样填得进去（切英文不许掉回中文、也不许留花括号）',
    enFilled.every((text) => !/[{}]/.test(text)), enFilled.filter((text) => /[{}]/.test(text)).join(' / '))
  check('中文界面这十句都是中文句子（没把宿主路由层那句英文照抄进来）',
    zhFilled.every((text) => /[一-鿿]/.test(text)), zhFilled.filter((text) => !/[一-鿿]/.test(text)).join(' / '))
  check('英文界面这十句都不含汉字（判据 15 扫全字典，这里扫的是填完参数的成品）',
    !enFilled.some((text) => /[㐀-䶿一-鿿豈-﫿]/.test(text)),
    enFilled.filter((text) => /[㐀-䶿一-鿿豈-﫿]/.test(text)).join(' / '))

  // 6) 两句成品逐字核对：文件与状态号确实填进去了，档位名用的是 id。
  check('仓库里没这个文件那句填的是文件名与状态号',
    modelDownloadReasonText('file-not-in-repo', zhTranslate, { file: 'decoder_model.onnx', status: 404 })
      === '模型仓库里没有 decoder_model.onnx（HTTP 404），这个档位下载不了，需要更新档位表。',
    modelDownloadReasonText('file-not-in-repo', zhTranslate, { file: 'decoder_model.onnx', status: 404 }))
  check('内置档位不可用那句英文侧填的是 id（不是宿主那份带括号的展示名）',
    modelDownloadReasonText('hosted-unavailable', enT, { model: 'sensevoice' })
      === 'Files for the built-in tier sensevoice are missing. It is not downloaded - install the DSH speech input component instead.',
    modelDownloadReasonText('hosted-unavailable', enT, { model: 'sensevoice' }))

  // 7) 宿主少给一个参数时的形状：那一格保持花括号原样（interpolate 的既定策略），
  //    不许伪装成值 —— 露一个 {expected} 至少说明「这个数没拿到」。
  check('宿主少给一个参数时句子照出、缺的那格不伪装成值',
    modelDownloadReasonText('merged-size-mismatch', zhTranslate, { file: 'x.bin', got: '12' })
      === 'x.bin 拼出来的大小不对（12 字节，应为 {expected}），坏的分片已经清掉，可以再试一次。',
    modelDownloadReasonText('merged-size-mismatch', zhTranslate, { file: 'x.bin', got: '12' }))
  check('参数整个缺失也不崩（走查表那条路，格子留原样）',
    modelDownloadReasonText('file-failed', zhTranslate) === '{file} 没下载下来，网络或镜像可能一时不通，可以稍后再试一次。',
    modelDownloadReasonText('file-failed', zhTranslate))
}

console.log(`\n通过 ${passed}，失败 ${failures.length}`)
if (failures.length) process.exitCode = 1
