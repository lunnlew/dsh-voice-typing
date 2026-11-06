/**
 * 识别文本的文本规则（词表 + 语气词 + 输出规范化）。
 *
 * 四块能力：
 *   - parseWordEntries：把词表条目解析成「替换规则」与「热词提示」两类。
 *   - applyCustomWordsWithMeta：按替换规则改写识别结果。
 *   - removeFillerWords：按语言清理语气词（"嗯""呃"…），默认关闭。
 *   - normalizeOutput：去掉首尾空白、合并多余空格、去掉中文字符之间的空格。
 *   - postProcessWithMeta：把上面几步串成完整的后处理链。
 *
 * 词表写法（两种都真正生效）：
 *   - "正确=错误"：识别出「错误」就替换成「正确」。
 *       · 中文走精确子串替换（中文没有大小写与词边界，模糊匹配容易误伤）。
 *       · 英文/数字忽略大小写匹配；替换结果保持「正确」一词在词表里原有的大小写形态
 *         （词表写 "DeepSeek"，识别成 "deepseek" 也会被改回 "DeepSeek"）。
 *   - "正确"（纯字符串）：**热词提示**。不改变文本，只作为热词交给识别器做上下文偏置。
 *
 * 也兼容对象写法 {correct, replace}：带 replace 等价于 "正确=错误"，
 * 不带 replace 等价于纯字符串热词。
 *
 * @module dsh-voice-typing/text-rules
 */

/** 中文常见语气词。 */
const ZH_FILLERS = ['嗯', '呃', '啊', '哦', '唔', '诶', '唉', '那个', '这个就是', '就是说']

/** 英文常见语气词。 */
const EN_FILLERS = ['uh', 'um', 'er', 'ah', 'eh', 'hmm', 'mm', 'like', 'you know']

/**
 * 判断一个词是否含 CJK 字符（中文不做模糊匹配）。
 * @param word - 待判断的词。
 * @returns 是否含 CJK。
 */
function hasCjk(word) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(word)
}

/**
 * 转义正则元字符。
 * @param text - 原文。
 * @returns 可安全放进正则的字面量。
 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 解析词表条目。
 *
 * 支持两种写法，并都真正生效：
 *   - "正确=错误"：替换规则——识别出「错误」就替换成「正确」；
 *   - "正确"（纯字符串）：热词提示——不改变文本，只作为热词交给识别器。
 *
 * 兼容对象写法 {correct, replace}：带 replace 等价于 "正确=错误"，
 * 不带 replace 等价于纯字符串热词。
 *
 * @param words - 词表（字符串数组，或 {correct, replace} 对象数组）。
 * @returns {{rules: {correct: string, wrong: string}[], hotwords: string[]}}。
 */
export function parseWordEntries(words) {
  /** @type {{correct: string, wrong: string}[]} */
  const rules = []
  /** @type {string[]} */
  const hotwords = []
  if (!Array.isArray(words)) return { rules, hotwords }
  for (const entry of words) {
    let correct = ''
    let wrong = ''
    /** 显式写了 '=' 就是替换规则（两侧都得有内容，否则整条作废）。 */
    let isRule = false
    if (typeof entry === 'string') {
      const raw = entry.trim()
      if (!raw) continue
      const eq = raw.indexOf('=')
      if (eq >= 0) {
        // "正确=错误"：以第一个 '=' 分隔。
        isRule = true
        correct = raw.slice(0, eq).trim()
        wrong = raw.slice(eq + 1).trim()
      } else {
        // 纯字符串：热词提示。
        correct = raw
      }
    } else if (entry && typeof entry === 'object') {
      isRule = typeof entry.replace === 'string' && entry.replace.trim() !== ''
      correct = String(entry.correct ?? '').trim()
      wrong = String(entry.replace ?? '').trim()
    } else {
      continue
    }
    if (!correct) continue
    if (isRule) {
      if (!wrong) continue
      rules.push({ correct, wrong })
    } else {
      hotwords.push(correct)
    }
  }
  return { rules, hotwords }
}

/**
 * 应用一条替换规则。
 * @param text - 当前文本。
 * @param rule - {correct, wrong}。
 * @returns 替换后的文本。
 */
function applyRule(text, rule) {
  const { correct, wrong } = rule
  if (!correct || !wrong) return text
  if (hasCjk(wrong)) {
    // 中文：精确子串替换，不做编辑距离模糊匹配（中文没有大小写与词边界）。
    return text.split(wrong).join(correct)
  }
  // 英文/数字：忽略大小写匹配；输出保持「正确」一词在词表里原有的大小写形态。
  const escaped = escapeRegExp(wrong)
  const left = /^\w/.test(wrong) ? '\\b' : ''
  const right = /\w$/.test(wrong) ? '\\b' : ''
  const re = new RegExp(`${left}${escaped}${right}`, 'gi')
  // 用回调返回替换值，避免正确写法里的 $ 被当成替换模式。
  return text.replace(re, () => correct)
}

/**
 * 用自定义词表替换识别结果中的错误写法，并带回热词列表。
 *
 * 纯字符串条目不会改变文本，只作为热词返回，供调用方交给识别器做上下文偏置。
 * @param text - 识别文本。
 * @param words - 词表条目。
 * @returns {{text: string, hotwords: string[], rules: {correct: string, wrong: string}[]}}。
 */
export function applyCustomWordsWithMeta(text, words) {
  const { rules, hotwords } = parseWordEntries(words)
  if (typeof text !== 'string' || !text || rules.length === 0) {
    return { text, hotwords, rules }
  }
  let out = text
  for (const rule of rules) out = applyRule(out, rule)
  return { text: out, hotwords, rules }
}

/**
 * 清理语气词。
 * @param text - 识别文本。
 * @param language - 语言提示（zh / en / auto）。
 * @param enabled - 是否启用。
 * @returns 清理后的文本。
 */
export function removeFillerWords(text, language, enabled) {
  if (!enabled || typeof text !== 'string' || !text) return text
  const lang = String(language ?? 'auto').toLowerCase()
  const fillers = lang.startsWith('en') ? EN_FILLERS : lang.startsWith('zh') ? ZH_FILLERS : [...ZH_FILLERS, ...EN_FILLERS]
  let out = text
  for (const filler of fillers) {
    if (!filler) continue
    const re = new RegExp(`(^|[\\s，,。.!！?？])${escapeRegExp(filler)}([\\s，,。.!！?？]|$)`, 'g')
    out = out.replace(re, '$1$2')
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * 输出规范化：去掉中文字符之间的空格（识别引擎偶尔在中文间插空格），
 * 合并多余空行，去掉首尾空白。
 * @param text - 识别文本。
 * @returns 规范化后的文本。
 */
export function normalizeOutput(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    // 开头的标点是识别引擎把起头的停顿当成句号留下的痕迹，正文里不会出现，去掉。
    .replace(/^[\s\u3000]*[。，、；：！？,.;:!?]+[\s\u3000]*/, '')
    .trim()
}

/**
 * 串起完整的后处理链，并带回热词列表。
 *
 * 顺序：先清语气词（此时文本里的空格还在，语气词的边界才认得出），
 * 再规范化输出（去中文字符之间的空格），最后套自定义词表。
 *
 * 热词来自词表里的纯字符串条目——它们不改变文本，只作为识别偏置交给调用方。
 * @param text - 识别文本。
 * @param options - words / language / removeFillers。
 * @returns {{text: string, hotwords: string[]}}。
 */
export function postProcessWithMeta(text, options = {}) {
  const { words = [], language = 'auto', removeFillers = false } = options
  let out = removeFillerWords(text, language, removeFillers)
  out = normalizeOutput(out)
  const applied = applyCustomWordsWithMeta(out, words)
  return { text: applied.text.trim(), hotwords: applied.hotwords }
}
