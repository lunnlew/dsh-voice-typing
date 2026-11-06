/**
 * 通用 a11y 界面操作原语（纯函数，不依赖浏览器全局，Node 可原生 import）。
 *
 * 为什么要有这一层：
 *   v1 的界面动作是「一个功能一个动作」，每加一个页面/按钮都得改协议 + 宿主 +
 *   客户端三处。v2 改成通用原语：拍一张「当前页面有哪些可交互元素」的快照
 *   （ref/role/name），模型再按 ref 点击/输入/按键 —— 以后新增界面功能不需要
 *   再动动作协议。
 *
 *   但通用原语的风险比语义动作大得多（点错按钮就是破坏性操作），所以判定逻辑
 *   全部放在这个纯函数模块里：什么样的元素算可交互、ref 怎么生成、输入名字怎么
 *   截断、按键字符串怎么解析、用户说「允许/拒绝」怎么识别，都能在 Node 里逐条
 *   测试，不靠浏览器手工验证。
 *
 * 浏览器侧只做「取元素、打 ref 属性、派发事件」这些必须碰 DOM 的事
 * （见 src/client/main.js 的 executeUiAction）。
 */

// 修饰键别名 → 规范名：来自 src/shared/key-modifiers.js（4.3b 单源）。
// 这条链路是「主动派发按键给 DOM」，快捷键匹配是「被动比较用户按下的键」，
// 两边问的是同一个问题 ——「Control 该不该按下 ctrlKey」。以前各写一张表，
// 于是同一句 `Control+Alt+V` 在两处可以给出不同答案；差异只该留在**主键**那半
// （这里要把键名规范成 KeyboardEvent.key 的真值，匹配层不需要）。
// 主键那半现在也单源了（4.3d：src/shared/key-names.js），本文件只剩一条策略：
// 「模型可以把哪些键打进当前页面」。
import { KEY_MODIFIER_ALIASES } from '../../shared/key-modifiers.js'
import { domKeyOf, keyNameOf } from '../../shared/key-names.js'

/** 快照 ref 前缀：最终形态是 `e1`、`e2`…（由调用方传入的序号拼上前缀）。 */
export const A11Y_REF_PREFIX = 'e'

/**
 * 单次快照最多返回多少个元素。
 *
 * 上限的作用：页面元素可能上千个，全塞给模型既贵又容易让模型迷路；
 * 80 个足够覆盖当前可见的按钮/输入框，超出的不展示（按 DOM 顺序取前 80）。
 */
export const MAX_SNAPSHOT_ELEMENTS = 80

/** 元素可读名称的最大长度（字符）：快照要短，避免把整段正文塞给模型。 */
const NAME_MAX = 80

/** 视为「可交互」的 ARIA role（与契约一致）。 */
const INTERACTIVE_ROLES = ['button', 'tab', 'link', 'checkbox', 'switch', 'menuitem']

/** 这些 input type 不算可交互（不可见、不可点，拍进快照只会让模型误点）。 */
const HIDDEN_INPUT_TYPES = ['hidden']

/** 具名键（大小写不敏感）→ KeyboardEvent.key 规范值。 */
/**
 * `ui_key` 允许派发给页面的具名键**写法**（小写）。
 *
 * 这是一条**策略**，不是词表：哪些写法算哪个键由 `src/shared/key-names.js` 回答，
 * 这里只决定「模型能不能把这个键打进当前页面」。
 *
 * 为什么按写法判而不是按规范名判：`Return` 和 `Enter` 是同一个键（规范名都是 `Enter`），
 * 但历史上 a11y 只认 `Enter` 这一种写法。按规范名过滤会把「多认一种别名」这件事
 * 混进策略里 —— 策略要动的应该是名单本身，而不是被词表带着动。
 * 4.3d 归并词表时这条名单一条没扩大、一条没缩小（20 条写法 = 原来那张 `NAMED_KEYS` 的键）。
 *
 * 单字母、数字、F1-F12 由 `isDispatchableKey` 按形状放行，不在这里逐条列。
 */
const DISPATCHABLE_KEY_SPELLINGS = [
  'enter',
  'escape',
  'esc',
  'tab',
  'space',
  'arrowup',
  'up',
  'arrowdown',
  'down',
  'arrowleft',
  'left',
  'arrowright',
  'right',
  'pageup',
  'pagedown',
  'home',
  'end',
  'delete',
  'del',
  'backspace',
]

/** 用户说这些词 = 允许（整句匹配）。 */
const ALLOW_WORDS = ['允许', '确认', '可以', '好', '行', '同意', 'ok', 'okay', 'yes', 'allow', 'approve', 'accept']

/** 用户说这些词 = 拒绝（整句匹配）。 */
const DENY_WORDS = ['拒绝', '取消', '不要', '不', 'no', 'nope', 'cancel', 'deny', 'reject']

/**
 * 安全读属性：元素可能是残缺的 DOM 桩/已卸载节点，绝不能因为读属性抛错。
 * @param {object} el - 元素。
 * @param {string} name - 属性名。
 * @returns {string} 属性值（缺失/异常 → 空串）。
 */
function readAttr(el, name) {
  try {
    const value = el?.getAttribute?.(name)
    return value === undefined || value === null ? '' : String(value)
  } catch {
    return ''
  }
}

/**
 * 安全读属性字段（tagName/type/value/textContent 这些是 DOM 属性而不是 attribute）。
 * @param {object} el - 元素。
 * @param {string} name - 字段名。
 * @returns {string} 字段值（缺失/异常 → 空串）。
 */
function readProp(el, name) {
  try {
    const value = el?.[name]
    return value === undefined || value === null ? '' : String(value)
  } catch {
    return ''
  }
}

/**
 * 把名称压成一行并截断：快照是给模型看的，换行/连续空白没有信息量。
 * @param {unknown} value - 原始文本。
 * @returns {string} 归一化后的名称（可能为空串）。
 */
function normalizeName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
}

/**
 * 判断标签（+ input type）本身是不是可交互元素。
 *
 * 只按标签判定；`role=button` 这类「非语义标签 + ARIA role」由
 * describeInteractiveElement 额外识别。
 *
 * @param {string} tag - 标签名（大小写不敏感）。
 * @param {string} [type] - input 的 type。
 * @returns {boolean} 是否可交互。
 */
export function isInteractiveTag(tag, type) {
  const tagName = String(tag ?? '').trim().toUpperCase()
  const inputType = String(type ?? '').trim().toLowerCase()
  if (tagName === 'BUTTON' || tagName === 'A' || tagName === 'SELECT' || tagName === 'TEXTAREA') return true
  if (tagName === 'INPUT') return !HIDDEN_INPUT_TYPES.includes(inputType)
  return false
}

/* ================= ui_type / ui_click 的安全边界（纯函数，可单测） ================= */

/**
 * ui_type 允许写入的 input type 白名单（文本类）。
 *
 * 为什么只放文本类：checkbox/radio/file/range/color/date 等要么没有文本值、
 * 要么会触发文件选择器/日期面板；对它们调用原生 value setter 会被吞掉却
 * 返回 ok（评审 P3「ui_type 假成功」）。password 也不在白名单里，但执行器
 * 会先返回 forbidden（语义更明确，不是「不支持」）。
 */
const WRITABLE_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'number']

/**
 * 这个 input type 是否允许被 ui_type 写入。
 * @param {string} type - input 的 type（大小写/空白不敏感）。
 * @returns {boolean} 是否可写。
 */
export function isWritableInputType(type) {
  return WRITABLE_INPUT_TYPES.includes(String(type ?? '').trim().toLowerCase())
}

/**
 * 判定 ui_type 目标属于哪种可写类型。
 *
 * @param {string} tag - 标签名（大小写不敏感）。
 * @param {string} type - input 的 type。
 * @param {boolean|string} contentEditable - contenteditable 属性或 isContentEditable。
 * @returns {'input'|'textarea'|'contenteditable'|''} 可写类型；不可写返回空串。
 */
export function classifyWritableTarget(tag, type, contentEditable) {
  const tagName = String(tag ?? '').trim().toUpperCase()
  const inputType = String(type ?? '').trim().toLowerCase()
  const rawEditable = contentEditable === true ? 'true' : String(contentEditable ?? '').trim().toLowerCase()
  const editable = rawEditable === 'true' || rawEditable === 'plaintext-only'
  if (tagName === 'TEXTAREA') return 'textarea'
  if (tagName === 'INPUT') return isWritableInputType(inputType) ? 'input' : ''
  if (tagName && editable) return 'contenteditable'
  return ''
}

/** 点击后会离开应用 / 打开系统程序的链接协议。 */
const UNSAFE_LINK_SCHEMES = ['http', 'https', 'mailto', 'file', 'tel', 'ftp', 'data', 'javascript', 'blob']

/**
 * ui_click 是否应拒绝该目标（外链导航 / 文件选择器）。
 *
 * 为什么拒绝：a11y 原语只能操作**应用内**界面。点外链会把用户导航出 DSH
 *（浮层随之消失、会话还在跑）；点 file input 会弹系统文件框（语音/模型无法
 * 继续操作）。内部锚点（`#...`）与相对路径交给应用自身路由，仍然允许。
 *
 * @param {{tag?:string, type?:string, href?:string, target?:string}} input - 元素属性。
 * @returns {boolean} 是否应拒绝（unsupported）。
 */
export function isUnsafeClickTarget(input = {}) {
  // null/非对象也当空对象处理：快照元素属性可能缺失，绝不能因此抛错。
  const source = input && typeof input === 'object' ? input : {}
  const tag = source.tag
  const type = source.type
  const href = source.href
  const target = source.target
  const tagName = String(tag ?? '').trim().toUpperCase()
  const inputType = String(type ?? '').trim().toLowerCase()
  if (tagName === 'INPUT' && inputType === 'file') return true
  if (tagName !== 'A') return false
  // target=_blank：一定新开窗口（即使用相对路径也离开当前应用上下文）。
  if (String(target ?? '').trim().toLowerCase() === '_blank') return true
  const url = String(href ?? '').trim()
  // 没有 href / 纯页内锚点：不会导航。
  if (!url || url.startsWith('#')) return false
  // 协议相对 URL（//example.com）等价于外链。
  if (url.startsWith('//')) return true
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)
  // 无协议头的相对路径（/settings、settings、../x）：应用内路由，允许。
  if (!match) return false
  return UNSAFE_LINK_SCHEMES.includes(match[1].toLowerCase())
}

/**
 * 推断元素的 role（用于快照展示，不参与可交互判定）。
 * @param {string} tag - 大写标签名。
 * @param {string} type - input type（小写）。
 * @param {string} roleAttr - 显式 role 属性（小写）。
 * @returns {string} role；推断不出返回空串。
 */
function roleOf(tag, type, roleAttr) {
  if (roleAttr) return roleAttr
  if (tag === 'BUTTON') return 'button'
  if (tag === 'A') return 'link'
  if (tag === 'TEXTAREA') return 'textbox'
  if (tag === 'SELECT') return 'combobox'
  if (tag === 'INPUT') {
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    return 'textbox'
  }
  return ''
}

/**
 * 把一个 DOM 元素描述成快照条目。
 *
 * @param {object} el - 元素（只需要 tagName/type/getAttribute/textContent/value/disabled）。
 * @param {number} index - 快照序号（调用方给；ref = A11Y_REF_PREFIX + index）。
 * @returns {{ref:string, role:string, name:string, tag:string, disabled:boolean, value?:string}|null}
 *   不可交互/元素残缺返回 null。
 */
export function describeInteractiveElement(el, index) {
  if (!el || typeof el !== 'object') return null
  const tag = readProp(el, 'tagName').trim().toUpperCase()
  const type = (readProp(el, 'type') || readAttr(el, 'type')).trim().toLowerCase()
  const roleAttr = readAttr(el, 'role').trim().toLowerCase()
  const interactive = isInteractiveTag(tag, type) || INTERACTIVE_ROLES.includes(roleAttr)
  if (!interactive) return null

  // 密码框的 value 绝不出现在快照里（名称回退、value 字段都不行）：
  // 模型读到它等于把用户密码/密钥写进了对话上下文。
  const isSecret = tag === 'INPUT' && type === 'password'

  // 名称优先级：aria-label（最明确）→ title → 可见文字 → placeholder → value。
  const name = normalizeName(
    readAttr(el, 'aria-label')
    || readAttr(el, 'title')
    || readProp(el, 'textContent')
    || readAttr(el, 'placeholder')
    || (isSecret ? '' : readProp(el, 'value')),
  )
  const seq = Number.isFinite(Number(index)) ? Math.max(0, Math.floor(Number(index))) : 0
  const entry = {
    ref: A11Y_REF_PREFIX + seq,
    role: roleOf(tag, type, roleAttr),
    name,
    tag: tag.toLowerCase(),
    disabled: readProp(el, 'disabled') === 'true' || readAttr(el, 'aria-disabled') === 'true',
  }
  // value 只对输入类元素有意义；空值不返回（模型看到 value:"" 会误以为要覆盖）；
  // 密码框连编码值都不返回。
  if (!isSecret && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
    const value = normalizeName(readProp(el, 'value'))
    if (value) entry.value = value
  }
  return entry
}

/**
 * 解析按键字符串（`Escape`、`Ctrl+K`、`Shift+Alt+F5`…）。
 *
 * 支持：单个字母 A-Z / 数字 0-9 / 具名键（Enter、Escape、Tab、Space、方向键、
 * PageUp/PageDown、Home、End、Delete、Backspace、F1-F12），前缀修饰键
 * Ctrl/Alt/Shift/Meta（别名表见 src/shared/key-modifiers.js：Control/Option/Cmd/
 * Command/Win/Windows/Super 都认）。
 *
 * @param {string} spec - 按键字符串。
 * @returns {{ok:true, key:string, ctrl?:boolean, alt?:boolean, shift?:boolean, meta?:boolean} |
 *   {ok:false, reason:string}} 解析结果。
 */
export function parseKeySpec(spec) {
  const text = String(spec ?? '').trim()
  if (!text) return { ok: false, reason: 'empty' }
  if (text.length > 40) return { ok: false, reason: 'too_long' }
  const parts = text.split('+').map((part) => part.trim())
  if (parts.some((part) => !part)) return { ok: false, reason: 'empty_part' }
  const keyRaw = parts.pop()
  const modifiers = { ctrl: false, alt: false, shift: false, meta: false }
  for (const part of parts) {
    const modifier = KEY_MODIFIER_ALIASES[part.toLowerCase()]
    if (!modifier) return { ok: false, reason: 'unknown_modifier:' + part }
    if (modifiers[modifier]) return { ok: false, reason: 'duplicate_modifier:' + part }
    modifiers[modifier] = true
  }
  const key = canonicalKey(keyRaw)
  if (!key) return { ok: false, reason: 'unsupported_key:' + keyRaw }
  const result = { ok: true, key }
  if (modifiers.ctrl) result.ctrl = true
  if (modifiers.alt) result.alt = true
  if (modifiers.shift) result.shift = true
  if (modifiers.meta) result.meta = true
  return result
}

/**
 * 单个主键规范化成 `KeyboardEvent.key` 的真值。
 *
 * 两步分开是有原因的：词表（`src/shared/key-names.js`）回答「这串字是哪个键、
 * 在三个环境里各是什么值」，这里回答「这个键允不允许打进页面」。
 * 合并成一步的话，将来谁给词表加一个键就顺手把它派发了出去。
 *
 * @param {string} raw - 用户或模型写的键名。
 * @returns {string} `KeyboardEvent.key` 的真值；不允许或不认识时返回空串。
 */
function canonicalKey(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const name = keyNameOf(text)
  if (!name || !isDispatchableKey(text, name)) return ''
  // 空格键在这里就变成 `' '` 了：词表给的是 DOM 的真值，不是给人看的名。
  return domKeyOf(text)
}

/**
 * 这个键允不允许派发给页面（策略，见 `DISPATCHABLE_KEY_SPELLINGS`）。
 * @param {string} spelling - 用户或模型写的原文（已 trim）。
 * @param {string} name - 它对应的规范键名。
 * @returns {boolean} 允许与否。
 */
function isDispatchableKey(spelling, name) {
  // 单字母与数字：派发出去就是打一个字符，页面本来也收这种事件。
  if (/^[A-Z0-9]$/.test(name)) return true
  // 功能键只到 F12：词表管到 F24（宿主注册热键用得到），派发这一侧历来不放开。
  if (/^F\d+$/.test(name)) return /^F([1-9]|1[0-2])$/.test(name)
  return DISPATCHABLE_KEY_SPELLINGS.includes(spelling.toLowerCase())
}

/**
 * 识别「用户这句话是不是在回答确认条」。
 *
 * 只认**整句**匹配（去掉首尾标点后）：否则「不要删掉会话」这种正常指令里
 * 含「不要」会被误判成拒绝，反而把确认条关掉。
 *
 * @param {string} text - 识别出来的整句文本。
 * @returns {'allow'|'deny'|''} allow=允许，deny=拒绝，''=不是确认词。
 */
export function normalizeConfirmSpeech(text) {
  const normalized = String(text ?? '')
    .trim()
    // 容忍首尾标点/引号（「允许。」「”允许“」「OK!」），但不动句子中间的内容 ——
    // 「不要删掉这个会话」这类正常指令必须原样比较，不能被拆成「不要」。
    .replace(/^[\s"'“”‘’，。！？、,.!?;；:：]+/g, '')
    .replace(/[\s"'“”‘’，。！？、,.!?;；:：]+$/g, '')
    .trim()
    .toLowerCase()
  if (!normalized) return ''
  if (ALLOW_WORDS.includes(normalized)) return 'allow'
  if (DENY_WORDS.includes(normalized)) return 'deny'
  return ''
}

/**
 * 确认条的目标描述：把 ref 翻译成「点击「插件」（e12）」这类人能判断的文案。
 *
 * 为什么不能只显示 `describeUiAction` 的结果：协议层只知道动作名和第一个参数，
 * `ui_click` 只能显示 `ui_click: e12` —— 用户看不到自己要批准的是哪个按钮
 *（尤其 ui_snapshot 也会拍到设置面板里的危险开关），二次确认就退化成橡皮图章。
 * 有快照信息时用可读名；没有（快照被新动作覆盖/元素没名字）时退回原描述。
 *
 * @param {object} request - {action, params}。
 * @param {Function} t - 翻译函数。
 * @param {Function} describeUiAction - UI 动作描述函数（回退用）。
 * @param {Function} infoFor - a11yBridge.infoFor，查 ref 的可读信息。
 * @returns {string} 确认条描述文本。
 */
export function describeConfirmTarget(request, t, describeUiAction, infoFor) {
  const action = String(request?.action ?? '')
  const params = request?.params && typeof request.params === 'object' ? request.params : {}
  const fallback = () => describeUiAction(action, params)
  try {
    if (action === 'ui_key') return t('globalConfirmKey', { key: String(params.key ?? '') })
    if (action === 'ui_click' || action === 'ui_type') {
      const info = typeof infoFor === 'function' ? infoFor(params.ref) : null
      const name = typeof info?.name === 'string' && info.name ? info.name : ''
      if (action === 'ui_type') {
        const raw = String(params.text ?? '')
        // 输入内容预览截断：确认条不是正文展示区（协议上限 4000 字）。
        const preview = raw.length > 40 ? raw.slice(0, 40) + '…' : raw
        if (name) return t('globalConfirmType', { name, ref: params.ref, text: preview })
        if (info) return t('globalConfirmTypeFallback', { ref: params.ref, text: preview })
        return fallback()
      }
      if (name) return t('globalConfirmClick', { name, ref: params.ref })
      return fallback()
    }
    return fallback()
  } catch {
    return fallback()
  }
}
