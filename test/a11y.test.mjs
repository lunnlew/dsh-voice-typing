/**
 * v2 a11y 原语纯函数测试：元素判定/描述、按键解析、语音确认词、快照上限。
 *
 * 为什么这些必须单测：
 *   通用 a11y 操作比语义动作危险得多（点错按钮 = 破坏性操作），而判定逻辑
 *   （哪些元素算可交互、ref 怎么生成、输入名称怎么截断、按键串怎么解析、
 *   用户说「允许/拒绝」怎么识别）全部在这几个纯函数里。
 *   在 Node 里用假元素逐条锁住，比在真实界面上手点可靠得多。
 *
 * 用法：node test/a11y.test.mjs
 */
import {
  A11Y_REF_PREFIX,
  MAX_SNAPSHOT_ELEMENTS,
  describeInteractiveElement,
  isInteractiveTag,
  parseKeySpec,
  normalizeConfirmSpeech,
  isWritableInputType,
  classifyWritableTarget,
  isUnsafeClickTarget,
} from '../src/client/pure/a11y.js'


let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/**
 * 造一个只实现 a11y 模块用到的那几个读法的假元素（不依赖 jsdom）。
 * @param {object} [props] - {tag,type,attrs,text,value,disabled}。
 * @returns {object} 假元素。
 */
function makeElement(props = {}) {
  const attrs = new Map(Object.entries(props.attrs ?? {}))
  return {
    tagName: props.tag ?? 'BUTTON',
    type: props.type,
    textContent: props.text ?? '',
    value: props.value,
    disabled: props.disabled === true ? true : undefined,
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null
    },
  }
}

/* ================================================================ */
// 「a11y.js 不碰浏览器全局 / 不依赖 React」这两条形状断言删了（§8.34 批次 0）：
// `test/bundle-sync.test.mjs` 对**构建真正合并的每个文件**跑同一条正则，
// 名单来自 esbuild 的 import 图，不在名单里的文件另有「孤儿文件」判据兜住 ——
// 比这里硬编码一个路径更不遗漏。这里只剩真行为的单元测试。

/* ================================================================ */
console.log('\n常量与上限')
{
  check("A11Y_REF_PREFIX 是 'e'", A11Y_REF_PREFIX === 'e')
  check('MAX_SNAPSHOT_ELEMENTS 是 80', MAX_SNAPSHOT_ELEMENTS === 80, String(MAX_SNAPSHOT_ELEMENTS))
}

/* ================================================================ */
console.log('\nisInteractiveTag')
{
  for (const tag of ['BUTTON', 'A', 'SELECT', 'TEXTAREA']) {
    check(`${tag} 可交互`, isInteractiveTag(tag) === true)
  }
  check('小写标签也认', isInteractiveTag('button') === true)
  check('INPUT text 可交互', isInteractiveTag('INPUT', 'text') === true)
  check('INPUT checkbox 可交互', isInteractiveTag('INPUT', 'checkbox') === true)
  check('INPUT password 可交互（快照能拍到；输入时才禁）', isInteractiveTag('INPUT', 'password') === true)
  check('INPUT hidden 不算可交互', isInteractiveTag('INPUT', 'hidden') === false)
  check('INPUT HIDDEN 大小写不敏感', isInteractiveTag('input', 'HIDDEN') === false)
  check('DIV 不算可交互', isInteractiveTag('DIV') === false)
  check('空标签不算可交互', isInteractiveTag('') === false)
  check('null 标签不算可交互', isInteractiveTag(null) === false)
}

/* ================================================================ */
console.log('\ndescribeInteractiveElement：ref/role/name/tag/disabled/value')
{
  const btn = makeElement({ tag: 'BUTTON', attrs: { 'aria-label': '收起侧栏' } })
  const info = describeInteractiveElement(btn, 1)
  check('button 生成条目', Boolean(info))
  check('ref = 前缀 + 序号', info?.ref === 'e1', info?.ref)
  check('role 推断为 button', info?.role === 'button', info?.role)
  check('tag 小写', info?.tag === 'button', info?.tag)
  check('name 取 aria-label', info?.name === '收起侧栏', info?.name)
  check('未禁用 disabled=false', info?.disabled === false)
  check('button 不返回 value', info?.value === undefined)

  check('ref 跟随传入序号', describeInteractiveElement(btn, 12)?.ref === 'e12')
  check('序号非数字时按 0', describeInteractiveElement(btn, 'x')?.ref === 'e0')

  // 名称回退链：aria-label > title > 可见文字 > placeholder > value
  check('name 回退到 title',
    describeInteractiveElement(makeElement({ attrs: { title: 'Title 名' } }), 1)?.name === 'Title 名')
  check('name 回退到可见文字',
    describeInteractiveElement(makeElement({ text: ' 发送 \n 消息 ' }), 1)?.name === '发送 消息')
  check('name 回退到 placeholder',
    describeInteractiveElement(makeElement({ tag: 'INPUT', type: 'text', attrs: { placeholder: '搜索…' } }), 1)?.name === '搜索…')
  check('name 回退到 value',
    describeInteractiveElement(makeElement({ tag: 'INPUT', type: 'text', value: '草稿' }), 1)?.name === '草稿')
  check('aria-label 优先于文字',
    describeInteractiveElement(makeElement({ attrs: { 'aria-label': 'A' }, text: 'B' }), 1)?.name === 'A')

  // 截断：名称最多 80 字符
  const longName = '名'.repeat(120)
  const truncated = describeInteractiveElement(makeElement({ attrs: { 'aria-label': longName } }), 1)
  check('name 截断到 80 字符', truncated?.name.length === 80, String(truncated?.name.length))

  // 输入类元素的 role 与 value
  const input = makeElement({ tag: 'INPUT', type: 'text', value: 'abc', attrs: { 'aria-label': '输入' } })
  const inputInfo = describeInteractiveElement(input, 2)
  check('text input role=textbox', inputInfo?.role === 'textbox', inputInfo?.role)
  check('input 返回当前 value', inputInfo?.value === 'abc', inputInfo?.value)
  check('空 value 不返回 value 字段',
    describeInteractiveElement(makeElement({ tag: 'INPUT', type: 'text', value: '' }), 2)?.value === undefined)

  // 密码框：value 是秘密，绝不能进快照（名称回退也不能用它）。
  const pw = describeInteractiveElement(
    makeElement({ tag: 'INPUT', type: 'password', value: 'sk-secret-123' }), 6)
  check('password input 不返回 value', pw?.value === undefined, JSON.stringify(pw))
  check('password input 的 name 不泄漏 value', !String(pw?.name ?? '').includes('sk-secret'), pw?.name)
  check('password input 仍可被拍到且 role=textbox', Boolean(pw) && pw.role === 'textbox', JSON.stringify(pw))
  const pwWithLabel = describeInteractiveElement(
    makeElement({ tag: 'INPUT', type: 'password', value: 'sk-secret-123', attrs: { 'aria-label': 'API Key' } }), 7)
  check('password input 用 aria-label 作 name', pwWithLabel?.name === 'API Key', pwWithLabel?.name)
  check('password input 有 label 时也不返回 value', pwWithLabel?.value === undefined)
  check('checkbox role=checkbox',
    describeInteractiveElement(makeElement({ tag: 'INPUT', type: 'checkbox' }), 3)?.role === 'checkbox')
  check('select role=combobox',
    describeInteractiveElement(makeElement({ tag: 'SELECT' }), 4)?.role === 'combobox')
  check('textarea role=textbox',
    describeInteractiveElement(makeElement({ tag: 'TEXTAREA' }), 5)?.role === 'textbox')

  // 禁用
  check('disabled 属性 → disabled=true',
    describeInteractiveElement(makeElement({ tag: 'BUTTON', disabled: true }), 1)?.disabled === true)
  check('aria-disabled=true → disabled=true',
    describeInteractiveElement(makeElement({ tag: 'BUTTON', attrs: { 'aria-disabled': 'true' } }), 1)?.disabled === true)

  // 非语义标签 + ARIA role
  check('div[role=button] 算可交互',
    describeInteractiveElement(makeElement({ tag: 'DIV', attrs: { role: 'button' }, text: '自绘按钮' }), 1)?.role === 'button')
  for (const role of ['tab', 'link', 'checkbox', 'switch', 'menuitem']) {
    check(`div[role=${role}] 算可交互`,
      Boolean(describeInteractiveElement(makeElement({ tag: 'DIV', attrs: { role } }), 1)))
  }
  check('div[role=toolbar] 不算可交互',
    describeInteractiveElement(makeElement({ tag: 'DIV', attrs: { role: 'toolbar' } }), 1) === null)

  // 不拍照的情况
  check('普通 DIV 返回 null', describeInteractiveElement(makeElement({ tag: 'DIV', text: '文本' }), 1) === null)
  check('hidden input 返回 null',
    describeInteractiveElement(makeElement({ tag: 'INPUT', type: 'hidden' }), 1) === null)
  check('null 元素返回 null', describeInteractiveElement(null, 1) === null)
  check('残缺元素不抛错', (() => {
    try { describeInteractiveElement({}, 1); return true } catch { return false }
  })())
}

/* ================================================================ */
console.log('\nparseKeySpec：合法按键')
{
  const expectKey = (spec, key) => {
    const r = parseKeySpec(spec)
    check(`${spec} → ${key}`, r.ok === true && r.key === key, JSON.stringify(r))
  }
  expectKey('Escape', 'Escape')
  expectKey('enter', 'Enter')
  expectKey('TAB', 'Tab')
  // 空格键的 `KeyboardEvent.key` 是一个空格字符，不是 `'Space'`（DOM 规范定的）。
  // 4.3d 之前这里返回 `'Space'`，靠调用方（main.js 的 ui_key 分支）现场换成 `' '` ——
  // 换的地方写错或漏换，派出去的就是一个页面认不出来的键。现在词表直接给真值。
  expectKey('Space', ' ')
  expectKey('space', ' ')
  expectKey('ArrowUp', 'ArrowUp')
  expectKey('pagedown', 'PageDown')
  expectKey('Home', 'Home')
  expectKey('End', 'End')
  expectKey('Delete', 'Delete')
  expectKey('Backspace', 'Backspace')
  expectKey('A', 'A')
  expectKey('z', 'Z')
  expectKey('7', '7')
  expectKey('F1', 'F1')
  expectKey('f12', 'F12')

  const combo = parseKeySpec('Ctrl+K')
  check('Ctrl+K → key=K, ctrl=true', combo.ok === true && combo.key === 'K' && combo.ctrl === true
    && combo.alt === undefined && combo.shift === undefined && combo.meta === undefined, JSON.stringify(combo))
  const multi = parseKeySpec('Ctrl+Alt+Shift+Meta+Delete')
  check('四个修饰键都解析', multi.ok === true && multi.ctrl && multi.alt && multi.shift && multi.meta,
    JSON.stringify(multi))
  check('Control 别名 → ctrl', parseKeySpec('Control+A')?.ctrl === true)
  check('Cmd 别名 → meta', parseKeySpec('Cmd+Z')?.meta === true)
  check('Option 别名 → alt', parseKeySpec('Option+Enter')?.alt === true)
  check('Windows 别名 → meta（4.3b：修饰键词表已和快捷键链路共用）',
    parseKeySpec('Windows+K')?.meta === true)
  check('修饰键大小写/空白不敏感', parseKeySpec(' ctrl + shift + p ')?.shift === true)
}

console.log('\nparseKeySpec：非法输入')
{
  const expectFail = (spec, label) => {
    const r = parseKeySpec(spec)
    check(`${label} → 失败`, r.ok === false && typeof r.reason === 'string', JSON.stringify(r))
  }
  expectFail('', '空串')
  expectFail('   ', '纯空白')
  expectFail('Ctrl', '只有修饰键')
  expectFail('Ctrl+', '修饰键后无主键')
  expectFail('Ctrl++K', '空段')
  expectFail('Hyper+K', '未知修饰键')
  expectFail('Ctrl+Ctrl+K', '重复修饰键')
  expectFail('Foo', '未知键名')
  expectFail('F13', '超出 F1-F12')
  expectFail('Escape+', '尾随 +')
  expectFail('k'.repeat(41), '超长（>40）')
}

/* ================================================================ */
console.log('\nnormalizeConfirmSpeech：整句识别允许/拒绝')
{
  for (const word of ['允许', '确认', '可以', '好', '行', '同意', 'ok', 'OK', 'okay', 'yes', 'Yes',
    // 评审 P2-6：英文确认提示说的是 "allow"/"deny"，匹配器必须真的认识这些词
    'allow', 'Allow', 'approve', 'accept']) {
    check(`「${word}」= allow`, normalizeConfirmSpeech(word) === 'allow', normalizeConfirmSpeech(word))
  }
  for (const word of ['拒绝', '取消', '不要', '不', 'no', 'NO', 'nope', 'cancel', 'Cancel',
    'deny', 'Deny', 'reject']) {
    check(`「${word}」= deny`, normalizeConfirmSpeech(word) === 'deny', normalizeConfirmSpeech(word))
  }
  check('容忍尾标点：允许。', normalizeConfirmSpeech('允许。') === 'allow')
  check('容忍尾标点：OK!', normalizeConfirmSpeech('OK!') === 'allow')
  check('容忍尾标点与空白： 拒绝！', normalizeConfirmSpeech(' 拒绝！ ') === 'deny')
  check('容忍中文引号包裹：”允许“', normalizeConfirmSpeech('“允许”') === 'allow')
  check('英文确认词容忍标点：Approve.', normalizeConfirmSpeech('Approve.') === 'allow')

  for (const [text, why] of [
    ['你好', '普通内容'],
    ['好的', '列表外（好 不等于 好的）'],
    ['allowed', '列表外'],
    ['不允许', '只是包含允许，不是整句'],
    ['不要删掉这个会话', '整句不是确认词（整句匹配防误判）'],
    ['确认一下天气', '包含确认但不是确认回答'],
    ['', '空串'],
    ['   ', '纯空白'],
  ]) {
    check(`「${text || '(空)'}」不识别（${why}）`, normalizeConfirmSpeech(text) === '')
  }
  check('null → 空串', normalizeConfirmSpeech(null) === '')
  check('非字符串 → 空串', normalizeConfirmSpeech(123) === '')
}

/* ================================================================ */
console.log('\nui_type 可写目标白名单（task-21）')
{
  for (const type of ['text', 'search', 'email', 'url', 'tel', 'number']) {
    check(`input[type=${type}] 可写`, isWritableInputType(type) === true)
  }
  check('type 大小写/空白不敏感', isWritableInputType('  EMAIL ') === true)
  for (const type of ['password', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'datetime-local', 'hidden', 'submit', 'button']) {
    check(`input[type=${type}] 不可写`, isWritableInputType(type) === false)
  }
  check('缺省 type 不可写（保守）', isWritableInputType(undefined) === false && isWritableInputType('') === false)

  check('textarea → textarea', classifyWritableTarget('TEXTAREA', '', null) === 'textarea')
  check('input text → input', classifyWritableTarget('INPUT', 'text', null) === 'input')
  check('input number → input', classifyWritableTarget('input', 'NUMBER ', null) === 'input')
  check('input checkbox → 不可写', classifyWritableTarget('INPUT', 'checkbox', null) === '')
  check('input password → 不可写（执行器另行返回 forbidden）', classifyWritableTarget('INPUT', 'password', null) === '')
  check('div contenteditable=true → contenteditable',
    classifyWritableTarget('DIV', '', 'true') === 'contenteditable')
  check('contenteditable=plaintext-only 也支持',
    classifyWritableTarget('DIV', '', 'plaintext-only') === 'contenteditable')
  check('isContentEditable 布尔 true → contenteditable',
    classifyWritableTarget('SPAN', '', true) === 'contenteditable')
  check('普通 div → 不可写', classifyWritableTarget('DIV', '', null) === '')
  check('contenteditable=false → 不可写', classifyWritableTarget('DIV', '', 'false') === '')
  check('button → 不可写', classifyWritableTarget('BUTTON', '', null) === '')
}

/* ================================================================ */
console.log('\nui_click 危险目标判定（task-21）')
{
  const unsafe = (input, why) => check(`拒绝点击：${why}`, isUnsafeClickTarget(input) === true)
  const safe = (input, why) => check(`允许点击：${why}`, isUnsafeClickTarget(input) === false)

  unsafe({ tag: 'A', href: 'https://example.com' }, 'https 外链')
  unsafe({ tag: 'A', href: 'http://example.com/x' }, 'http 外链')
  unsafe({ tag: 'A', href: 'mailto:a@b.com' }, 'mailto')
  unsafe({ tag: 'A', href: 'file:///etc/passwd' }, 'file 协议')
  unsafe({ tag: 'A', href: 'tel:123' }, 'tel')
  unsafe({ tag: 'A', href: 'javascript:alert(1)' }, 'javascript:')
  unsafe({ tag: 'A', href: 'data:text/html,x' }, 'data:')
  unsafe({ tag: 'A', href: '//evil.com/x' }, '协议相对外链')
  unsafe({ tag: 'A', href: '/settings', target: '_blank' }, 'target=_blank（相对路径也离开上下文）')
  unsafe({ tag: 'A', href: '#', target: ' _BLANK ' }, 'target=_blank 大小写/空白')
  unsafe({ tag: 'INPUT', type: 'file' }, 'file input')
  unsafe({ tag: 'input', type: ' FILE ' }, 'file input 大小写/空白')

  safe({ tag: 'A', href: '#' }, '页内锚点 #')
  safe({ tag: 'A', href: '#section' }, '页内锚点 #section')
  safe({ tag: 'A', href: '/settings' }, '应用内绝对路径')
  safe({ tag: 'A', href: 'settings/general' }, '应用内相对路径')
  safe({ tag: 'A', href: '' }, '空 href')
  safe({ tag: 'A' }, '没有 href')
  safe({ tag: 'A', href: '/x', target: '_self' }, 'target=_self')
  safe({ tag: 'BUTTON', href: 'https://example.com' }, '按钮不看 href')
  safe({ tag: 'INPUT', type: 'text' }, 'text input 可点')
  safe({ tag: 'INPUT', type: 'checkbox' }, 'checkbox 可点（由 ui_click 单独处理状态）')
  safe({}, '空输入')
  safe(null, 'null 输入')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
