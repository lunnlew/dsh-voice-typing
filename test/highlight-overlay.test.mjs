/**
 * 朗读高亮覆盖层 —— 不能被画到「宿主弹框/遮罩」上面（用户反馈回归）。
 *
 * 用户反馈（2026-11-01）：「高亮条似乎会显示到弹框的上面？比如设置弹框出现，
 * 高亮条也会显示出在这上面」。
 *
 * 根因：覆盖层样式写的是 `z-index:2147483647`（整型最大值），而 DSH 的弹框/遮罩
 * 是 `z-index:1000` 级别的浮层 —— 于是弹框打开时，高亮色块仍然盖在弹框上。
 *
 * 修复（两道路）：
 *   1. 覆盖层 `z-index:900`：高于消息正文、低于弹框/遮罩；
 *   2. 弹框打开时**直接隐藏覆盖层**（`[aria-modal="true"] / [role="dialog"]` +
 *      MutationObserver 监听挂载/卸载，关闭后自动恢复并重画）。
 *
 * 这里对**真实构建产物** `lib/client.js` 做契约断言（同样能挡住「源码改了但没重建
 * bundle」的情况 —— 那正是线上不生效的常见原因）。
 *
 * 运行：node test/highlight-overlay.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cli = readFileSync(path.join(root, 'lib/client.js'), 'utf8')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

console.log('\n== 1. 覆盖层 z-index 必须低于弹框遮罩 ==')
check('不再使用整型最大值 z-index（会盖住弹框）',
  !/z-index:2147483647;/.test(cli),
  '仍是 max z-index：设置弹框打开时高亮会画在弹框上面')
check('覆盖层 z-index = 900（高于正文、低于 DSH 的 1000 级浮层）',
  /const OVERLAY_Z_INDEX = 900/.test(cli)
  && /z-index:\$\{OVERLAY_Z_INDEX\};/.test(cli))

console.log('\n== 2. 弹框打开时隐藏覆盖层（第二道保险）==')
check('样式里有「隐藏态」：data-voice-reading-hidden → display:none',
  /\[data-voice-reading-overlay\]\[data-voice-reading-hidden\]\{display:none;\}/.test(cli))
check('检测宿主弹框（aria-modal / role=dialog / role=alertdialog）',
  /\[aria-modal="true"\]/.test(cli)
  && /\[role="dialog"\]/.test(cli)
  && /\[role="alertdialog"\]/.test(cli))
check('用 MutationObserver 监听弹框挂载/卸载（打开就隐藏、关闭就重画）',
  /new win\.MutationObserver/.test(cli)
  && /attributeFilter:\s*\['role', 'aria-modal', 'hidden', 'style'\]/.test(cli))
check('打开时渲染直接返回（不画色块）',
  /if \(modalOpen\) \{\s*clear\(\)/.test(cli),
  '弹框打开期间不能继续画高亮')

console.log('\n== 3. 旧样式迁移 / 清理 ==')
check('已存在的旧 style 标签会被更新（页面没刷新也能生效）',
  /if \(existing\.textContent !== css\) existing\.textContent = css/.test(cli))
check('dispose 会断开弹框监听并移除覆盖层',
  /modalObserver[\s\S]{0,120}disconnect\(\)/.test(cli)
  && /if \(modalObserver\) \{/.test(cli)
  && /layer\.remove\(\)/.test(cli))

console.log('\n== 4. 裁剪到会话滚动视口（不能画到输入框/顶栏上面）==')
check('找「会话滚动视口」：向上找 overflow-y:auto/scroll 的祖先',
  /findScrollViewport/.test(cli)
  && /\/auto\|scroll\|overlay\/\.test\(style\.overflowY\)/.test(cli),
  '消息滚出视口后 Range 仍会报原位置，不裁剪就会画到输入框/顶栏上')
check('找底部输入区（composer）顶部作为下边界',
  /findBottomChromeTop/.test(cli)
  && /data-slot\*="composer"/.test(cli)
  && /textarea, \[contenteditable="true"\]/.test(cli)
  && /r\.top < vh \* 0\.5/.test(cli),
  '只认下半屏、够宽的输入区，避免把顶栏搜索框当成底栏')
check('每个色块按裁剪区收敛（left/top/right/bottom 取交集）',
  /const x0 = Math\.max\(left, clip\.left\)/.test(cli)
  && /const x1 = Math\.min\(right, clip\.right\)/.test(cli)
  && /const y0 = Math\.max\(top, clip\.top\)/.test(cli)
  && /const y1 = Math\.min\(bottom, clip\.bottom\)/.test(cli))
check('完全在视口外的矩形不画（并记 skippedRects 诊断）',
  /if \(x1 - x0 <= 0 \|\| y1 - y0 <= 0\)/.test(cli)
  && /diag\.skippedRects \+= 1/.test(cli))
check('render 使用 computeClipRect 的裁剪结果',
  /const clip = computeClipRect\(container\)/.test(cli)
  && /drawRects\(range\.getClientRects\(\), clip\)/.test(cli))

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exitCode = fail ? 1 : 0
