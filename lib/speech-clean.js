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

/** 用于激进切分的分句标点（优先选离切点最近的那个）。 */
const BREAK_MARKS = ['，', '、', '；', '：', ',', ' ']

/**
 * 找一个安全的切分点。
 *
 * 从 buffer 开头最多看 `windowLen` 个字符，从后往前找**离切点最近**的分句标点
 * （逗号/顿号/分号/冒号/空格），切点要在 `minBreak` 之后（避免把短词从中间劈开）。
 * 找不到就在 `fallbackLen` 处硬切。
 *
 * @param {string} buffer - 待切文本。
 * @param {{windowLen: number, minBreak: number, fallbackLen: number, preferSpace?: boolean}} opts
 *   - `preferSpace`：硬切时尽量回退到最近的一个空格，避免把英文单词从中间劈开。
 *     首句切分不启用（原逻辑直接 15 字硬切），长句切分启用。
 * @returns {number} 切分索引；返回 0 表示不该切（缓冲区还不够长）。
 */
export function findSentenceBreak(buffer, { windowLen, minBreak, fallbackLen, preferSpace = false }) {
  const window = buffer.slice(0, windowLen)
  let at = -1
  for (const mark of BREAK_MARKS) {
    const idx = window.lastIndexOf(mark)
    if (idx >= minBreak && idx + 1 > at) at = idx + 1
  }
  if (at <= 0) {
    at = fallbackLen
    if (preferSpace) {
      const spaceAt = buffer.lastIndexOf(' ', fallbackLen + 20)
      if (spaceAt >= fallbackLen - 20) at = spaceAt + 1
    }
  }
  return at
}
