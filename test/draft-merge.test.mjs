/**
 * 草稿合并逻辑的真实测试。
 *
 * 背景（2026-10-31）：
 *   用户反馈「对话自动输入的文本，我手动删除后，再对话会把已经删除的也出来了」。
 *
 *   根因：草稿由三段拼接（base / committed / segment），
 *   而这三段只是「我们以为输入框里的内容」。用户手动删掉一段后，
 *   那份记录就过期了 —— 下一次拼装就把用户刚删掉的字原样塞回去。
 *
 * 测试方式：
 *   纯函数现在住在 src/client/pure/draft.js，
 *   **原生 import** 即可（它们不依赖任何浏览器 API）——
 *   不再需要「从 2000 行的大文件里提取源码再求值」那种 hack。
 *   产物 lib/client.js 由 scripts/bundle-client.mjs 从同一份源码内联生成。
 */
import { mergeDraft, syncUserEdit } from '../src/client/pure/draft.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/**
 * 模拟一次完整的草稿状态机。
 */
function makeDraft(initial) {
  const st = {
    base: initial.base ?? '',
    committed: initial.committed ?? '',
    segment: initial.segment ?? '',
    lastWritten: initial.lastWritten ?? '',
    draft: initial.draft ?? '',
  }
  return {
    st,
    /** 实时字更新（当前段的临时文本）。 */
    setSegment(text) {
      st.segment = text
      const m = mergeDraft({ base: st.base, committed: st.committed, segment: st.segment })
      st.base = m.base; st.committed = m.committed; st.segment = m.segment
      st.draft = m.out; st.lastWritten = m.out
      return st.draft
    },
    /** 一段识别完成（最终稿）。 */
    commit(text) {
      const synced = syncUserEdit({
        base: st.base, committed: st.committed,
        current: st.draft, ours: st.lastWritten,
      })
      st.base = synced.base
      st.committed = synced.committed
      st.committed = st.committed ? (st.committed + ' ' + text).trim() : text
      st.segment = ''
      const m = mergeDraft({ base: st.base, committed: st.committed, segment: st.segment })
      st.base = m.base; st.committed = m.committed; st.segment = m.segment
      st.draft = m.out; st.lastWritten = m.out
      return st.draft
    },
    /** 用户手动编辑输入框。 */
    userEdit(text) {
      st.draft = text
      return st.draft
    },
  }
}

console.log('场景 1：用户没改过草稿，各段正常累积')
{
  const d = makeDraft({ base: '你好', draft: '你好', lastWritten: '' })
  d.commit('世界')
  check('第一段语音写进去', d.st.draft === '你好 世界', d.st.draft)
  d.commit('再见')
  check('第二段语音累积而不是覆盖', d.st.draft === '你好 世界 再见', d.st.draft)
}

console.log('\n场景 2：用户手动删掉了已识别的内容')
{
  const d = makeDraft({ base: '你好', draft: '你好', lastWritten: '' })
  d.commit('世界')
  check('先写出「你好 世界」', d.st.draft === '你好 世界', d.st.draft)
  d.userEdit('你好')
  d.commit('再见')
  check('删除的内容没有回来', !d.st.draft.includes('世界'), d.st.draft)
  check('新识别到的内容追加上了', d.st.draft.includes('再见'), d.st.draft)
}

console.log('\n场景 3：用户手动追加了内容')
{
  const d = makeDraft({ base: '', draft: '', lastWritten: '' })
  d.commit('世界')
  check('先写出「世界」', d.st.draft === '世界', d.st.draft)
  d.userEdit('世界啊')
  d.commit('再见')
  check('用户追加的内容保留', d.st.draft.includes('啊'), d.st.draft)
  check('新识别的内容也追加上', d.st.draft.includes('再见'), d.st.draft)
  check('没有重复', (d.st.draft.match(/世界/g) || []).length === 1, d.st.draft)
}

console.log('\n场景 4：实时字逐步增长')
{
  const d = makeDraft({ base: '', draft: '', lastWritten: '' })
  d.setSegment('你')
  d.setSegment('你好')
  d.setSegment('你好吗')
  check('实时字逐步增长', d.st.draft === '你好吗', d.st.draft)
  d.commit('你好吗')
  check('段结束后内容不变', d.st.draft === '你好吗', d.st.draft)
}

console.log('\n场景 5：用户删掉实时字的一部分')
{
  const d = makeDraft({ base: '', draft: '', lastWritten: '' })
  d.setSegment('你好吗')
  check('先写出实时字', d.st.draft === '你好吗', d.st.draft)
  d.userEdit('你好')
  d.commit('你好')
  check('用户删掉的部分没有回来', !d.st.draft.includes('吗'), d.st.draft)
}

console.log('\n场景 6：首次写入不该被误判为「用户改过」')
{
  const d = makeDraft({ base: '你好', draft: '你好', lastWritten: '' })
  d.commit('世界')
  check('首次写入保留了用户原有内容', d.st.draft === '你好 世界', d.st.draft)
}

console.log('\n纯函数性质')
{
  const s0 = { base: 'a', committed: 'b', current: 'x', ours: 'y' }
  const r = syncUserEdit(s0)
  check('syncUserEdit 不修改传入的对象',
    s0.base === 'a' && s0.committed === 'b' && s0.current === 'x' && s0.ours === 'y')
  check('检测到用户改动时返回 edited=true', r.edited === true && r.base === 'x' && r.committed === '')
  const m0 = { base: ' a ', committed: ' b ', segment: ' c ' }
  const m = mergeDraft(m0)
  check('mergeDraft 不修改传入的对象',
    m0.base === ' a ' && m0.committed === ' b ' && m0.segment === ' c ')
  check('mergeDraft 拼接顺序固定', m.out === 'a b c', m.out)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
