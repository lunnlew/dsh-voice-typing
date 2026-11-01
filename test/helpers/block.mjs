/**
 * 取源码里某个函数的**完整**代码块（按大括号配平）。
 *
 * 为什么要这个：
 *   之前测试用「从某行起往后截 200 行」来取组件的代码。
 *   往组件里加几行代码（哪怕只是加注释和调试字段），
 *   就会把后面的关键代码**挤出窗口** —— 断言莫名其妙地失败，
 *   而代码其实没问题。
 *
 *   按大括号配平取完整范围，代码怎么加都不会影响。
 */

/**
 * @param {string[]} lines - 源码行数组。
 * @param {string} needle - 定位用的片段（例如 'function MicButton'）。
 * @returns {{start: number, end: number, text: string}} 行号区间与文本。
 */
export function blockOf(lines, needle) {
  const start = lines.findIndex((l) => l.includes(needle))
  if (start < 0) return { start: -1, end: -1, text: '' }
  let depth = 0
  let started = false
  let end = start
  for (let k = start; k < lines.length; k++) {
    for (const ch of lines[k]) {
      if (ch === '{') { depth++; started = true }
      if (ch === '}') depth--
    }
    if (started && depth <= 0 && k >= start) { end = k; break }
  }
  return { start, end, text: lines.slice(start, end + 1).join('\n') }
}
