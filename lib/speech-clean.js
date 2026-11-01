/**
 * 文本清洗与分句 —— 从宿主 `lib/index.js` 里抽出来的独立单元。
 *
 * 负责把「要朗读的回复」从 Markdown 清理成适合合成的纯文本，
 * 以及按句界把一段文本切成可逐句朗读的小段。
 *
 * 为什么值得独立成一个模块：
 *   宿主 `lib/index.js` 里塞了七件事（HTTP 服务、SSE、TTS 路由、识别、
 *   回合判定、配置、诊断），3000+ 行。文本清洗/分句是一块**纯函数**
 *   逻辑（输入字符串 → 输出字符串/切点），隔离出来便于测试，
 *   也避免「改清洗规则」误碰宿主的流式循环。
 *
 * 与旧实现逐行等价，只是搬进独立文件。
 */

/**
 * 把 Markdown 回复清洗成适合朗读的纯文本。
 *
 * 逐条替换（顺序敏感，SSML 转义必须放最后）：
 *   - 去掉代码块（``` / ~~~）、去掉表格行、去链接只留文字、
 *     去掉列表/标题/引用前缀、去掉加粗/斜体/删除线符号；
 *   - 压缩空白与空行；
 *   - 最后做 SSML 转义（& → &amp;，< → &lt;），保证 Edge TTS 的 SSML 模板
 *     不会因为回复里的 '<' 或 '&' 变成非法 XML —— 那会让服务端直接拒绝，
 *     表现为「整段无声」而且报错只在服务端，界面看不出原因。
 *
 * @param {string} text - 原始回复。
 * @returns {string} 适合合成的纯文本（trim 后）。
 */
export function stripForSpeech(text) {
  let s = String(text ?? '')
  s = s.replace(/```[\s\S]*?```/g, '\n')
  s = s.replace(/~~~[\s\S]*?~~~/g, '\n')
  s = s.replace(/`([^`]*)`/g, '$1')
  // 表格整行删除（含分隔线），不念
  s = s.replace(/^[ \t]*\|.*\|[ \t]*$/gm, '\n')
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '\n')
  s = s.replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
  s = s.replace(/^[ \t]*>[ \t]?/gm, '')
  s = s.replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]*/gm, '')
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  // 有序列表编号：阿拉伯数字（1. / 1) / 1、）与中文数字（一、 / 十二.）。
  // 不去掉的话，编号会被当成一句话念出来（「一。」「二。」），
  // 用户反馈过这一点。
  //
  // 阿拉伯数字要求后面有空白：避免误删「1.5 倍」这类正文。
  // 中文数字**不要求**空白：中文排版里「一、第一项」后面通常是直接跟文字的。
  s = s.replace(/^[ \t]*\d{1,3}[.)、][ \t]+/gm, '')
  s = s.replace(/^[ \t]*[一二三四五六七八九十]{1,3}、[ \t]*/gm, '')
  s = s.replace(/^[ \t]*[一二三四五六七八九十]{1,3}[.)](?=[ \t])/gm, '')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/~~([^~]+)~~/g, '$1')
  s = s.replace(/[|*~`#>]/g, ' ')
  s = s.replace(/\u00a0/g, ' ')
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/\n\s*\n+/g, '\n')
  // SSML 转义：**必须放在最后**。
  //
  // Edge TTS 的 SSML 模板把文本原样插进 XML，
  // 一句含 '<' 或 '&' 的回复（比如 'a < b'、'<div>'）就会让 XML 非法，
  // 服务端直接拒绝 → **整段无声**，而且报错只在服务端，
  // 界面上看不出任何原因。
  //
  // 放最后是为了避免 '&' 被前面的替换重复转义（'&amp;' 里的 '&' 会被再转一次）。
  // '>' 在上面已经被替换成空格了。
  s = s.replace(/&/g, '&amp;')
  s = s.replace(/</g, '&lt;')
  return s.trim()
}

/** 句末标点：中文。 */
const CN_END = '。！？；\n'

/**
 * Markdown 列表标记（有序/无序）—— 这些**不是句子**，不能当作句界。
 *
 * 典型错误：`1. 第一步是安装依赖。` 里的 `1. ` 会被
 * 「英文句号后跟空白」这条规则判成句子结束，
 * 于是 `"1."` 单独成为一个片段、被当成一句话朗读出来
 * （用户反馈：「有序列表或者无序列表，还会把编号作为一个简短的句子」）。
 *
 * 覆盖形式见 isListMarkerDot（有序 `1.`）与 stripForSpeech 的前缀清理
 * （`1.` `1)` `1、` `一、` `-` `*` `+` `- [ ]`）。
 */

/** 句末标点：英文句号后跟空白才算。 */
const SENTENCE_SPLIT = new RegExp(`(?<=[${CN_END}])|(?<=\\.)(?=\\s)`)

/**
 * 判断某个位置是不是「列表标记里的点」，不该在这里断句。
 *
 * @param {string} text - 完整文本。
 * @param {number} at - 句号之后的位置（即切点）。
 * @returns {boolean} true = 这里是列表编号，不能断。
 */
function isListMarkerDot(text, at) {
  if (at < 2 || text[at - 1] !== '.') return false
  // 往回找到行首，看看这一行开头是不是列表标记
  let lineStart = at
  while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart--
  const lineHead = text.slice(lineStart, at)
  // 形如 "1." 或 "  2." —— 纯数字加一个点，就是有序列表编号
  return /^[ \t]*\d{1,3}\.$/.test(lineHead)
}

/**
 * 在句末标点处把一段文本切开。
 *
 * **列表编号不能当句界**：`1. 第一步…` 的 `1.` 若被切开，
 * 就会变成一句「一」，读出来莫名其妙（详见 LIST_MARKER 的说明）。
 *
 * @param {string} buffer - 待切文本。
 * @returns {{parts: string[], rest: string}} 已切好的片段，以及「未完成」的尾部
 *   （最后一段可能还没到句末标点，保留给下一次拼接）。
 */
export function splitSentenceParts(buffer) {
  const raw = String(buffer ?? '')
  const parts = []
  let last = 0
  // 手动扫描切点：命中 SENTENCE_SPLIT 的位置还要排除列表编号。
  const marks = []
  for (const m of raw.matchAll(new RegExp(SENTENCE_SPLIT.source, 'g'))) {
    const at = m.index
    if (at <= 0) continue
    if (isListMarkerDot(raw, at)) continue   // 列表编号：不断句
    marks.push(at)
  }
  for (const at of marks) {
    parts.push(raw.slice(last, at))
    last = at
  }
  const rest = raw.slice(last)
  return { parts, rest }
}

/**
 * 用于激进切分的**句末标点** —— 在这里切，读出来是完整的句子。
 * （修复前这里没有句末标点，导致「有句号却在逗号/空格处切、句子中间断开」。）
 *
 * 注意：英文句号 `.` 单独特殊处理（必须后跟空白/行尾，避免误切 `1.5`、`3.14`、
 * `example.com`），见 findSentenceBreak 里的 lastOf。
 */
const SENTENCE_END_MARKS = ['。', '！', '？', '!', '?', '；', ';', '\n', '.']

/** 用于激进切分的**句内标点**（逗号等）—— 只在不得已时才用。 */
const CLAUSE_MARKS = ['，', '、', '：', ',']

/**
 * 找一个安全的切分点。
 *
 * 切分优先级（从「听起来是完整句子」到「不得不切」）：
 *   1. **句末标点**（。！？!?；;换行 + 英文句号）—— 切在完整句子边界；
 *   2. **句内标点**（，、：,）与**空格**（英文单词边界）；
 *   3. **硬切回退到最近空格** —— 即使硬切也绝不劈开英文单词/标识符；
 *   4. 无空格（纯中文长串）→ 只能硬切到 `fallbackLen`。
 *
 * 修复原因（用户反馈「在词汇中间断开、也在句子中间断开」）：
 *   旧实现只认逗号/顿号/分号/冒号/空格（**没有句末标点**），
 *   于是「This is a normal sentence.」这种有句号的句子，
 *   会优先在**空格**处切成半句；而 `preferSpace:false` 的首句切分
 *   更是**直接 15 字硬切**，把英文单词（如 `transformData`）从中间劈开。
 *   现在句末标点优先、硬切**始终**回退到最近空格。
 *
 * @param {string} buffer - 待切文本。
 * @param {{windowLen: number, minBreak: number, fallbackLen: number, preferSpace?: boolean}} opts
 *   - `preferSpace`：保留以便兼容（旧调用方可能传）；新实现**无论真假**都会在
 *     硬切时回退到最近空格，因为「劈开英文单词」永远不可接受。
 * @returns {number} 切分索引；返回 0 表示不该切（缓冲区还不够长）。
 */
export function findSentenceBreak(buffer, { windowLen, minBreak, fallbackLen, preferSpace = false } = {}) {
  const window = buffer.slice(0, windowLen)

  /**
   * 在 `window` 里找一组标点中「离切点最近」的那个（贪心：取最大下标），
   * 返回切点（= 标点下标 + 1）；找不到返回 -1。
   *
   * 英文句号 `.`：必须后跟空白/行尾才算句末，否则往前找上一个 `.`。
   * 避免把 `1.5`、`3.14`、`example.com` 误当句界。
   */
  const lastOf = (marks) => {
    let at = -1
    for (const mark of marks) {
      let idx = window.lastIndexOf(mark)
      if (mark === '.') {
        while (idx >= 0) {
          const next = window[idx + 1]
          if (next === undefined || next === ' ' || next === '\n') break
          idx = window.lastIndexOf('.', idx - 1)
        }
        if (idx < 0) continue
      }
      if (idx + 1 > at) at = idx + 1
    }
    return at
  }

  // 1) 句末标点优先 —— 切在完整句子边界。
  const endAt = lastOf(SENTENCE_END_MARKS)
  if (endAt > minBreak) return endAt
  // 2) 句内标点 + 空格（英文单词边界）。
  const clauseAt = lastOf([...CLAUSE_MARKS, ' '])
  if (clauseAt > minBreak) return clauseAt
  // 3) 硬切：回退到最近空格，绝不劈开英文单词/标识符。
  const fallbackSpace = buffer.lastIndexOf(' ', fallbackLen)
  if (fallbackSpace >= Math.floor(fallbackLen * 0.5)) return fallbackSpace + 1
  // 4) 无空格（纯中文/无空格长串）→ 只能硬切，否则单句无限长。
  return fallbackLen
}
