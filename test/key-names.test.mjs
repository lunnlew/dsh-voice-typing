/**
 * 具名键词表（`src/shared/key-names.js`）与三条链路的一致性检查。
 *
 * 这里问的是一个具体问题：**同一串键名写法，在三个环境里拿到的值对不对、
 * 三条链路拿到的答案是不是同一个**。
 *   - `pure/a11y.js` 的 `parseKeySpec` —— 把键名派发给页面（要 `KeyboardEvent.key` 的真值）；
 *   - `pure/shortcut.js` 的 `matchesShortcut` —— 比较用户按下的键和配置里那串（也要真值）；
 *   - `lib/global-hotkey-helper.js` 的 `parseAccelerator` —— 注册系统热键
 *     （要 Win32 虚拟键码 **和** uiohook 键名，两个值）。
 * 4.3d 之前这三处各有自己的表（a11y 一份 `NAMED_KEYS`、helper 两份 `VK_BY_KEY` +
 * `NATIVE_KEY_NAMES`），外加两处「空格键的真值是 `' '`」的现场特判。
 * 表各自漂的时候，表现是「窗口里按得出、切到别的应用按不动」，
 * 而三处代码看起来都没错 —— 所以这里逐字比的是**取值**，不是「有没有这张表」。
 *
 * 用法：node test/key-names.test.mjs
 */
import { domKeyOf, keyNameOf, uiohookKeyOf, windowsVirtualKeyOf } from '../src/shared/key-names.js'
import { parseKeySpec } from '../src/client/pure/a11y.js'
import { matchesShortcut } from '../src/client/pure/shortcut.js'
import { parseAccelerator } from '../src/host/global-hotkey-helper.js'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log('  ✓ ' + name)
  } else {
    failures.push(name)
    console.log('  ✗ ' + name + (detail ? ' :: ' + detail : ''))
  }
}

/** 词表里每一条具名键：写法 → 三个环境各自该拿到的值。 */
const NAMED = [
  ['Enter', 'Enter', 'Enter', 0x0d],
  ['Return', 'Enter', 'Enter', 0x0d],
  ['Tab', 'Tab', 'Tab', 0x09],
  ['Space', ' ', 'Space', 0x20],
  ['Escape', 'Escape', 'Escape', 0x1b],
  ['Esc', 'Escape', 'Escape', 0x1b],
  ['Backspace', 'Backspace', 'Backspace', 0x08],
  ['Delete', 'Delete', 'Delete', 0x2e],
  ['Del', 'Delete', 'Delete', 0x2e],
  ['Insert', 'Insert', 'Insert', 0x2d],
  ['Ins', 'Insert', 'Insert', 0x2d],
  ['Home', 'Home', 'Home', 0x24],
  ['End', 'End', 'End', 0x23],
  ['PageUp', 'PageUp', 'PageUp', 0x21],
  ['PageDown', 'PageDown', 'PageDown', 0x22],
  ['Up', 'ArrowUp', 'ArrowUp', 0x26],
  ['ArrowUp', 'ArrowUp', 'ArrowUp', 0x26],
  ['Down', 'ArrowDown', 'ArrowDown', 0x28],
  ['ArrowDown', 'ArrowDown', 'ArrowDown', 0x28],
  ['Left', 'ArrowLeft', 'ArrowLeft', 0x25],
  ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 0x25],
  ['Right', 'ArrowRight', 'ArrowRight', 0x27],
  ['ArrowRight', 'ArrowRight', 'ArrowRight', 0x27],
]

console.log('\n词表本身：一条写法三个值')
for (const [spelling, dom, native, win] of NAMED) {
  check(`${spelling} → dom=${JSON.stringify(dom)} / native=${native} / vk=0x${win.toString(16)}`,
    domKeyOf(spelling) === dom && uiohookKeyOf(spelling) === native && windowsVirtualKeyOf(spelling) === win,
    `实际 dom=${JSON.stringify(domKeyOf(spelling))} native=${uiohookKeyOf(spelling)} vk=${windowsVirtualKeyOf(spelling)}`)
}
check('规范名是给人看的那个名字（空格除外：规范名是 Space，DOM 真值是空格字符）',
    keyNameOf('Space') === 'Space' && keyNameOf('Up') === 'ArrowUp' && domKeyOf('Space') === ' ')

console.log('\n形状规则：字母 / 数字 / 功能键')
check('单字母给大写（KeyboardEvent.key 按 Shift 状态给 a/A，比较方自己转小写）',
  domKeyOf('v') === 'V' && domKeyOf('V') === 'V')
check('字母的虚拟键码就是字符码（A=0x41）', windowsVirtualKeyOf('a') === 0x41)
check('数字：dom 与规范名都是它自己，vk 是字符码（1=0x31、7=0x37）',
  domKeyOf('7') === '7' && keyNameOf('7') === '7'
  && windowsVirtualKeyOf('1') === 0x31 && windowsVirtualKeyOf('7') === 0x37)
check('F1-F12 三条链路都认',
  [1, 5, 12].every((n) => domKeyOf(`F${n}`) === `F${n}` && uiohookKeyOf(`f${n}`) === `F${n}`
    && windowsVirtualKeyOf(`f${n}`) === 0x70 + n - 1))
check('F13-F24：词表认（宿主注册热键用得到），大小写都行',
  windowsVirtualKeyOf('f24') === 0x87 && uiohookKeyOf('F24') === 'F24' && domKeyOf('f13') === 'F13')
check('F25 与 F0 都不认', windowsVirtualKeyOf('F25') === undefined && domKeyOf('F0') === '')
check('不认识的写法一律拿空值（而不是 0 或原样返回）',
  domKeyOf('Hyper') === '' && keyNameOf('Foo') === '' && uiohookKeyOf('') === ''
  && windowsVirtualKeyOf(' ') === undefined)

console.log('\n三条链路对同一批写法的取值必须一致')
{
  // a11y：派发给页面的 key 必须是词表给的 DOM 真值。
  for (const [spelling, dom] of NAMED) {
    if (spelling === 'Return' || spelling === 'Ins' || spelling === 'Insert') continue // a11y 的派发名单不含它们，见下一段
    const parsed = parseKeySpec(`Ctrl+${spelling}`)
    check(`a11y 派发 ${spelling} → key=${JSON.stringify(dom)}`,
      parsed.ok === true && parsed.key === dom, JSON.stringify(parsed))
  }
  // 窗口内匹配：按下的键是 DOM 真值，配置里写的是各种写法。
  for (const [spelling, dom] of NAMED) {
    const hit = matchesShortcut({ key: dom, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
      `Ctrl+${spelling}`)
    check(`窗口内 Ctrl+${spelling} 能命中（按下的是 ${JSON.stringify(dom)}）`, hit === true)
  }
  // 系统级热键：一次注册要同时拿到虚拟键码和 uiohook 键名。
  for (const [spelling, , native, win] of NAMED) {
    const parsed = parseAccelerator(`Ctrl+Alt+${spelling}`)
    check(`系统热键 ${spelling} → vk=0x${win.toString(16)} / keyName=${native}`,
      parsed.ok === true && parsed.vk === win && parsed.keyName === native, JSON.stringify(parsed))
  }
}

console.log('\n回归：4.3d 之前按不动的那些写法')
{
  // 以前 matchesShortcut 只特判了空格一个键，配置里的 `up/down/left/right` 存得下去、
  // 按下去永远不命中（`event.key` 是 ArrowUp，比较用的还是 up）。
  const arrowCases = [['Up', 'ArrowUp'], ['Down', 'ArrowDown'], ['Left', 'ArrowLeft'], ['Right', 'ArrowRight']]
  for (const [spelling, dom] of arrowCases) {
    check(`Ctrl+${spelling} 现在命中按下 ${dom}（以前存得下、按不动）`,
      matchesShortcut({ key: dom, ctrlKey: true }, `Ctrl+${spelling}`) === true)
  }
  check('Ctrl+Return 命中按下 Enter（以前比较的是字面 return）',
    matchesShortcut({ key: 'Enter', ctrlKey: true }, 'Ctrl+Return') === true)
  check('Alt+Space 仍然命中按下空格（4.3b 修的那条没退化）',
    matchesShortcut({ key: ' ', altKey: true }, 'Alt+Space') === true)
  check('主键对大小写与修饰键的其它组合不放松：只按 Ctrl 不算 Ctrl+Alt+V',
    matchesShortcut({ key: 'v', ctrlKey: true }, 'Ctrl+Alt+V') === false)
}

console.log('\na11y 的派发策略：词表认识 ≠ 允许打进页面')
{
  // 词表回答「这串字是哪个键」，a11y 还有一层自己的取舍：模型能把哪些键派发给当前页面。
  // 4.3d 归并词表时这条名单一条没扩大（`Insert` / `Ins` / `Return` 在词表里，
  // 但历史上 a11y 不派发它们），F13-F24 同理 —— 宿主注册热键用得到，派发这一侧不放开。
  for (const spec of ['Insert', 'ins', 'Return', 'F13', 'F24', 'Home+End']) {
    const parsed = parseKeySpec(spec)
    check(`${spec} 仍然被 a11y 拒掉`, parsed.ok === false, JSON.stringify(parsed))
  }
  for (const spec of ['Enter', 'Escape', 'Tab', 'Space', 'ArrowUp', 'PageDown', 'Home', 'End', 'Delete', 'Backspace']) {
    const parsed = parseKeySpec(spec)
    check(`${spec} 仍在派发名单里`, parsed.ok === true, JSON.stringify(parsed))
  }
  check('F1-F12 派发侧照旧放行', parseKeySpec('F12').ok === true && parseKeySpec('F1').ok === true)
}

console.log('\n系统级热键：非法主键不落在 0 上')
{
  // windowsVirtualKeyOf 认不出来时给 undefined（不是 0）：helper 据此判非法、干脆不注册。
  const bad = parseAccelerator('Ctrl+Alt+Foo')
  check('不认识的键名 → 判非法并给原因', bad.ok === false && /不支持的按键/.test(bad.reason), JSON.stringify(bad))
  // 关键在「不是 0」：拿 0 去 RegisterHotKey 会注册出一个谁也不会按的键，
  // 用户看到的热键开关是「已启用」，实际永远不触发。
  check('Ctrl+Space 合法且 vk=0x20（空格键在 Windows 里有自己的码）',
    parseAccelerator('Ctrl+Space').ok === true && parseAccelerator('Ctrl+Space').vk === 0x20,
    JSON.stringify(parseAccelerator('Ctrl+Space')))
  check('不认识的写法不会落到 vk=0',
    ['Foo', 'Hyper', 'Insert2'].every((spelling) => {
      const r = parseAccelerator(`Ctrl+Alt+${spelling}`)
      return r.ok === false
    }))
  check('修饰键非法时不会去查主键（顺序：先修饰后主键）',
    parseAccelerator('Foo+Bar').ok === false)
}

console.log(`\n${failures.length === 0 ? '✓' : '✗'} 通过 ${passed}，失败 ${failures.length}`)
if (failures.length) {
  for (const name of failures) console.log('  失败：' + name)
  process.exitCode = 1
}
