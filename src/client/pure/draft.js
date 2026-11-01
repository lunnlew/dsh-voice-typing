/**
 * 草稿归属与合并（纯函数）。
 *
 * 草稿由三段组成：
 *   base      —— 用户开麦前自己输入的内容
 *   committed —— 已经识别完成的各段语音
 *   segment   —— 当前这一段的实时字
 *
 * 但这三段只是「我们以为输入框里的内容」。
 * 用户手动删掉一段之后，那份记录就过期了 ——
 * 再拼一次就会把用户刚删掉的字原样塞回去。
 */

/**
 * 检测用户是否手动改过草稿，并据此重设基准。
 *
 * **必须在写入新内容之前调用**：
 * 放进合并逻辑里的话，一旦判定为「用户改过」，
 * 就会把刚识别到的新内容也清掉 ——
 * 用户删掉一段之后，接下来识别到的句子会凭空消失。
 *
 * @param {object} parts - {base, committed, current, ours}。
 * @returns {{base: string, committed: string, edited: boolean}} 同步结果。
 */
export function syncUserEdit(parts) {
  const current = String(parts?.current ?? '').trim()
  const ours = String(parts?.ours ?? '').trim()
  // ours 为空说明我们还没写过任何东西，此时不该判定为「用户改过」
  // （输入框里本来就只有用户自己输入的内容）。
  const edited = ours !== '' && current !== ours
  if (!edited) {
    return {
      base: String(parts?.base ?? '').trim(),
      committed: String(parts?.committed ?? '').trim(),
      edited: false,
    }
  }
  // 用户改过时，current 里已经包含他们想保留的一切（含之前各段），
  // 所以把基准换成它、旧记录清空是等价的，不会丢内容。
  return { base: current, committed: '', edited: true }
}

/**
 * 合并草稿的三个部分。
 *
 * 只做拼接，不做任何判断 —— 判断在 syncUserEdit() 里，
 * 且必须在写入新内容之前完成。
 *
 * @param {object} parts - {base, committed, segment}。
 * @returns {{base: string, committed: string, segment: string, out: string}} 合并结果。
 */
export function mergeDraft(parts) {
  const base = String(parts?.base ?? '').trim()
  const committed = String(parts?.committed ?? '').trim()
  const segment = String(parts?.segment ?? '').trim()
  const out = [base, committed, segment].filter(Boolean).join(' ')
  return { base, committed, segment, out }
}
