/**
 * 快捷键判据的行为回归（第 4 步 4.3：从 main.js 的闭包里搬出快捷键簇）。
 *
 * 这个文件直接 import `src/client/pure/shortcut.js`（Node 里跑，不需要假 DOM）：
 * 校验、匹配、平台别名、「正在录键」状态都只是判据和一份普通集合。
 *
 * 为什么值得单独测：这条链路是「用户按下去，到底有没有开始听」。
 *   - `validateShortcut` 决定设置面板能不能保存（非法值会让热键静默失效）；
 *   - `matchesShortcut` 的**修饰键精确一致**是两个语音入口不互相误触的唯一保证
 *     （配 Alt+V 时按下 Ctrl+Alt+V 必须不算命中）；
 *   - `shortcutMatches` 的 macOS 别名只给那一条默认组合，配置值本身不变；
 *   - `createShortcutFocusTracker` 决定「正在录键时别触发录音」，
 *     而它必须在面板卸载时复位，否则快捷键永久失效（审计 F14）。
 *     卸载复位这件事在本文件里只能测集合语义，**真产物**那一层在
 *     `test/client-behavior.test.mjs` 的场景「窗口内快捷键」里测。
 *
 * 标注为「现状」的断言是在记录已知缺陷，不是说它是对的。
 *   第 4 步 4.3 时发现三条（别名写法静默失效 / Space 匹配不上 / 一条不可达分支），
 *   前两条在 4.3b 修掉了（修饰键词表收进 `src/shared/key-modifiers.js`，
 *   校验、匹配、a11y 派发三条链路查同一张表），第三条留着 —— 见
 *   docs/architecture-modernization.md §8.14（发现与钉住）与 §8.15（修与验收）。
 *
 * 批次 22（§8.64）改的是**校验失败时它回什么**：改前五条中文句子从这里出，
 * 设置面板原样显示，切英文那两行红字仍然是中文。现在只回原因码 + 填句子要的参数，
 * 于是这个文件判三件事：不合哪条规则给的是哪个码、码要点名的东西点没点着（哪个修饰键、
 * 哪个字母）、返回里一个用户看的字都没有。「码怎么变成句子」不在这儿判 ——
 * 那是查表那条路的事，在 `test/i18n-status-line.test.mjs`（与批次 18/19/20 同一处分法）。
 */
import {
  validateShortcut,
  matchesShortcut,
  shortcutMatches,
  createShortcutFocusTracker,
  SHORTCUT_ERROR_REASONS,
  SHORTCUT_ERROR_REASON_VALUES,
  isShortcutErrorCode,
} from '../src/client/pure/shortcut.js'
import { SHORTCUT_ERROR_KEYS } from '../src/client/pure/shortcut-error-text.js'
import { parseKeySpec } from '../src/client/pure/a11y.js'
import { KEY_MODIFIER_ALIASES } from '../src/shared/key-modifiers.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/** 造一个够用的 KeyboardEvent。 */
function key(eventInit = {}) {
  return {
    key: eventInit.key ?? '',
    ctrlKey: eventInit.ctrl === true,
    altKey: eventInit.alt === true,
    shiftKey: eventInit.shift === true,
    metaKey: eventInit.meta === true,
    repeat: eventInit.repeat === true,
  }
}

console.log('validateShortcut：哪些组合键允许保存')
{
  check('默认快捷键 Alt+V 必须合法（否则保存按钮被永久禁用）',
    validateShortcut('Alt+V').ok === true)
  check('默认全局快捷键 Ctrl+Alt+V 合法', validateShortcut('Ctrl+Alt+V').ok === true)
  check('Meta+Alt+V（macOS 写法）合法', validateShortcut('Meta+Alt+V').ok === true)
  check('大小写与空格无所谓', validateShortcut('  alt + v ').ok === true)
  check('Ctrl+Space 合法', validateShortcut('Ctrl+Space').ok === true)
  check('Shift+F5 合法（功能键不是字母，不会误触发打字）',
    validateShortcut('Shift+F5').ok === true)

  // 批次 22：这五条不再回句子，回**原因码 + 要填进句子的那个东西**。
  // 判的是「不合哪条规则」分得开、该点名的点着名；句子本身在 `pure/shortcut-error-text.js`，
  // 它的查表判据在 `test/i18n-status-line.test.mjs`。
  const empty = validateShortcut('')
  check('空值 → empty', empty.ok === false && empty.reason === 'empty', JSON.stringify(empty))
  check('null 非法而不是抛错', validateShortcut(null).ok === false)
  const single = validateShortcut('v')
  check('单独一个键 → too-few-parts（没有修饰键）',
    single.ok === false && single.reason === 'too-few-parts', JSON.stringify(single))
  const shiftLetter = validateShortcut('Shift+V')
  check('Shift+字母 → single-letter（就是打大写）',
    shiftLetter.ok === false && shiftLetter.reason === 'single-letter', JSON.stringify(shiftLetter))
  const unknown = validateShortcut('Foo+V')
  check('不认识的修饰键 → unknown-modifier，并把那个键名带出去（回显小写形式）',
    unknown.ok === false && unknown.reason === 'unknown-modifier'
      && unknown.params?.modifier === 'foo', JSON.stringify(unknown))
  const paste = validateShortcut('Ctrl+Shift+V')
  check('Ctrl+Shift+V → reserved-paste，并把那一组带出去',
    paste.ok === false && paste.reason === 'reserved-paste'
      && paste.params?.combo === 'Ctrl+Shift+V', JSON.stringify(paste))
  check('single-letter 把用户写的那个字母带出去（句子要点名它）',
    validateShortcut('Shift+K').params?.key === 'k', JSON.stringify(validateShortcut('Shift+K')))
  // 现状（缺陷）：解析时每项都先 trim 再 filter(Boolean)，所以数组里永远不会出现空格字符串 ——
  // `key === ' '` 那条「空格键写成 Space」的提示不可达，写 `Ctrl+空格` 拿到的是「至少要两个键」。
  const spaceChar = validateShortcut('Ctrl+ ')
  check('现状：写 Ctrl+空格 得到的是 too-few-parts 而不是 Space 提示（docs §8.14 遗留三）',
    spaceChar.ok === false && spaceChar.reason === 'too-few-parts', JSON.stringify(spaceChar))
  // 4.3b：那条不可达分支已经删掉（`parts.length < 2` 在前面就拦住了），
  // 这里改成断言它想保护的东西没被删坏 —— 数字主键照旧合法。
  check('数字主键照旧合法', validateShortcut('Ctrl+1').ok === true)
  // 4.3b：修饰键名单不再由校验层自己列，改成查 shared 那张表 —— 表里的写法一律放行。
  // 这条不是「放宽」：helper（系统级热键）本来就认这些写法，窗口内以前只认四个词。
  check('4.3b：别名写法现在放行（Control/Cmd/Option/Win/Super/Windows）',
    ['Control+Alt+V', 'Cmd+V', 'Command+Alt+V', 'Win+V', 'Super+V', 'Windows+V', 'Option+V']
      .every((combo) => validateShortcut(combo).ok === true))
  check('4.3b：别名写法照样拦得住非法主键（Shift+V 就是打大写）',
    validateShortcut('Option+V').ok === true && validateShortcut('Shift+V').ok === false)
}

console.log('\n批次 22：校验层不出句子（码表完备 + 返回里没有中文）')
{
  // 这一节判的是「改前那五条中文真的从这里消失了」，而不是「那五条句子还在别处」。
  // 判据写法：拿**返回值本身**做检查 —— 不复述源码文本，也不靠「我记得改成码了」。
  const failing = ['', 'v', 'Shift+V', 'Foo+V', 'Ctrl+Shift+V', 'Ctrl+ ']
  const results = failing.map((combo) => validateShortcut(combo))
  const serialized = JSON.stringify(results)
  check('六条失败路径的返回里没有汉字/中文标点（句子全交给文案层）',
    !/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(serialized), serialized)
  check('失败返回只有 ok/reason/params 三个成员（message 这个字段整个没了）',
    results.every((r) => Object.keys(r).sort().join(',') === 'ok,params,reason'), serialized)
  check('每条失败返回的 reason 都在词表里（拼错的码到不了查表那一步）',
    results.every((r) => isShortcutErrorCode(r.reason)), serialized)
  // 双向都判：码表里有、却没有一条路径发出来 = 那句文案是死字；
  // 路径发出了码表里没有的码 = 界面掉进兜底那句，用户看不出违了哪条规则。
  const emitted = [...new Set(results.map((r) => r.reason))].sort()
  const vocabulary = [...SHORTCUT_ERROR_REASON_VALUES].sort()
  check(`词表里 ${vocabulary.length} 个码都被某条校验路径发出来过`,
    JSON.stringify(emitted) === JSON.stringify(vocabulary),
    `实际发出：${emitted.join(',')} vs 词表：${vocabulary.join(',')}`)
  check('词表与文案映射表一一对应（少一个码=掉兜底，多一个码=死文案）',
    vocabulary.every((code) => typeof SHORTCUT_ERROR_KEYS[code] === 'string')
      && Object.keys(SHORTCUT_ERROR_KEYS).every((code) => isShortcutErrorCode(code)),
    JSON.stringify(SHORTCUT_ERROR_KEYS))
  check('合法值只说 ok，不附带 reason', (() => {
    const ok = validateShortcut('Alt+V')
    return ok.ok === true && ok.reason === undefined
  })(), JSON.stringify(validateShortcut('Alt+V')))
  check('SHORTCUT_ERROR_REASONS 的名字与值都对得上（表里写错一个字就被这条抓住）',
    SHORTCUT_ERROR_REASONS.EMPTY === 'empty'
      && SHORTCUT_ERROR_REASONS.TOO_FEW_PARTS === 'too-few-parts'
      && SHORTCUT_ERROR_REASONS.UNKNOWN_MODIFIER === 'unknown-modifier'
      && SHORTCUT_ERROR_REASONS.SINGLE_LETTER === 'single-letter'
      && SHORTCUT_ERROR_REASONS.RESERVED_PASTE === 'reserved-paste', '')
}

console.log('\nmatchesShortcut：修饰键必须精确一致')
{
  check('Alt+V 命中', matchesShortcut(key({ key: 'v', alt: true }), 'Alt+V') === true)
  check('主键大小写不敏感（Alt 按下时可能给 V）',
    matchesShortcut(key({ key: 'V', alt: true }), 'Alt+V') === true)
  check('多按 Ctrl 不算命中 Alt+V（否则两个语音入口一起触发）',
    matchesShortcut(key({ key: 'v', ctrl: true, alt: true }), 'Alt+V') === false)
  check('少按 Ctrl 不算命中 Ctrl+Alt+V',
    matchesShortcut(key({ key: 'v', alt: true }), 'Ctrl+Alt+V') === false)
  check('主键不同不算命中',
    matchesShortcut(key({ key: 'b', alt: true }), 'Alt+V') === false)
  check('Shift 也参与精确比较',
    matchesShortcut(key({ key: 'F5', shift: true }), 'Shift+F5') === true
    && matchesShortcut(key({ key: 'F5' }), 'Shift+F5') === false
    && matchesShortcut(key({ key: 'F5', ctrl: true }), 'Shift+F5') === false)
  check('Meta 也参与精确比较',
    matchesShortcut(key({ key: 'v', meta: true, alt: true }), 'Meta+Alt+V') === true)
  check('没有事件不命中（不抛错）', matchesShortcut(null, 'Alt+V') === false)
  check('事件没有 key 字段不命中', matchesShortcut({}, 'Alt+V') === false)
  check('空组合键不命中', matchesShortcut(key({ key: 'v', alt: true }), '') === false)
  check('配置值是 null 不命中', matchesShortcut(key({ key: 'v' }), null) === false)
  // 4.3b 修掉的三条（以前都钉成「现状」，现在按正向期望断言）：
  check('4.3b：写成 Control+Alt+V 校验通过、按下也命中（docs §8.14 遗留一）',
    validateShortcut('Control+Alt+V').ok === true
    && matchesShortcut(key({ key: 'v', ctrl: true, alt: true }), 'Control+Alt+V') === true)
  check('4.3b：写成 Cmd+V 按下 Meta+V 命中',
    validateShortcut('Cmd+V').ok === true
    && matchesShortcut(key({ key: 'v', meta: true }), 'Cmd+V') === true)
  check('4.3b：别名不放松精确性 —— 配 Cmd+V 时只按 V 不算命中',
    matchesShortcut(key({ key: 'v' }), 'Cmd+V') === false)
  check('4.3b：Alt+Space 能通过校验、按空格也能命中（docs §8.14 遗留二）',
    validateShortcut('Alt+Space').ok === true
    && matchesShortcut(key({ key: ' ', alt: true }), 'Alt+Space') === true)
  check('4.3b：Space 仍然只认空格字符（主键写成 v 不算命中）',
    matchesShortcut(key({ key: 'v', alt: true }), 'Alt+Space') === false)
  // 「把修饰键本身当主键」的冷门配置：主键位置上写着 ctrl/shift/alt/meta 时，
  // 旧实现把它也算进修饰要求（parts.includes 整串扫描）。4.3b 保持原样，
  // 这条断言就是为了让「保持原样」这件事有据可查。
  check('现状保留：Ctrl+Shift 仍然要求同时按下 Ctrl 和 Shift',
    matchesShortcut(key({ key: 'Shift', ctrl: true, shift: true }), 'Ctrl+Shift') === true
    && matchesShortcut(key({ key: 'Shift', ctrl: true }), 'Ctrl+Shift') === false)
  check('现状保留：Ctrl+Control（把 Ctrl 当主键）照旧按 Ctrl 键位匹配',
    matchesShortcut(key({ key: 'Control', ctrl: true }), 'Ctrl+Control') === true)
}

console.log('\n「校验放行的写法，匹配层必须认」—— 逐条过 shared 词表（4.3b 的根判据）')
{
  // 名单来自 shared 那张表本身，测试里不再抄一份写法清单：
  // 以后往表里加一个别名，这里的用例自动跟着长，四条链路一起受检。
  for (const [spelling, canonical] of Object.entries(KEY_MODIFIER_ALIASES)) {
    // Shift+单字母 是校验层故意拦的（那就是打大写字母），所以 shift 用功能键做主键。
    const mainKey = canonical === 'shift' ? 'F5' : 'V'
    const combo = `${spelling}+${mainKey}`
    check(`${combo}：校验放行 + 按下 ${canonical} 命中 + 没按下不命中 + a11y 解析同义`,
      validateShortcut(combo).ok === true
      && matchesShortcut(key({ key: mainKey, [canonical]: true }), combo) === true
      && matchesShortcut(key({ key: mainKey }), combo) === false
      && parseKeySpec(`${spelling}+${mainKey}`).ok === true
      && parseKeySpec(`${spelling}+${mainKey}`)?.[canonical] === true)
  }
}

console.log('\nshortcutMatches：macOS 别名只加在那条默认组合上')
{
  const cmdAltV = key({ key: 'v', meta: true, alt: true })
  check('Mac 上 Ctrl+Alt+V 额外接受 Cmd+Alt+V',
    shortcutMatches(cmdAltV, 'Ctrl+Alt+V', 'MacIntel') === true)
  check('Windows 上同样的按键不命中 Ctrl+Alt+V',
    shortcutMatches(cmdAltV, 'Ctrl+Alt+V', 'Win32') === false)
  check('没有 navigator 时（平台空串）按原组合判定',
    shortcutMatches(cmdAltV, 'Ctrl+Alt+V', '') === false)
  check('Mac 上原组合照样命中',
    shortcutMatches(key({ key: 'v', ctrl: true, alt: true }), 'Ctrl+Alt+V', 'MacIntel') === true)
  check('别名不推广到其它组合（Ctrl+Alt+K 在 Mac 也不认 Cmd 版）',
    shortcutMatches(key({ key: 'k', meta: true, alt: true }), 'Ctrl+Alt+K', 'MacIntel') === false)
  check('用户自己配的 Alt+V 在 Mac 上不会多认 Cmd+Alt+V',
    shortcutMatches(cmdAltV, 'Alt+V', 'MacIntel') === false)
  check('空组合键一条候选都没有 → 不命中', shortcutMatches(cmdAltV, '', 'MacIntel') === false)
}

console.log('\ncreateShortcutFocusTracker：正在录键的那份状态')
{
  const focus = createShortcutFocusTracker()
  check('新建时没有任何输入框聚焦', focus.anyFocused() === false && focus.fields().length === 0)
  focus.focus('composer')
  check('composer 聚焦后自己认', focus.isFocused('composer') === true)
  check('global 不受影响（两个快捷键是两套设置）', focus.isFocused('global') === false)
  check('anyFocused 为真（全局那条监听要停）', focus.anyFocused() === true)
  focus.focus('global')
  check('两个框都聚焦时清单有两项', focus.fields().length === 2)
  focus.focus('composer')
  check('重复聚焦不会把清单变成两项（集合语义）', focus.fields().length === 2)
  focus.blur('composer')
  check('composer 交出焦点后 global 仍在聚焦',
    focus.isFocused('composer') === false && focus.anyFocused() === true)
  focus.blur('global')
  check('全部交出焦点后 anyFocused 归假', focus.anyFocused() === false)
  focus.focus('composer')
  focus.releaseAll()
  check('releaseAll 一次清空（面板卸载走的就是这条）',
    focus.anyFocused() === false && focus.fields().length === 0)
  check('releaseAll 在空集合上可重复调用', (() => {
    focus.releaseAll()
    return focus.anyFocused() === false
  })())
  const other = createShortcutFocusTracker()
  focus.focus('global')
  check('两个实例互不干扰（状态在闭包里，不是模块级单例）',
    other.anyFocused() === false && focus.anyFocused() === true)
  focus.releaseAll()
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
