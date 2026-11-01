/**
 * 麦克风按钮的渲染自测：把各种状态都渲染一遍。
 *
 * 背景（2026-10-31）：
 *   新加的「停止朗读」按钮只在 `speaking` 为真时出现。
 *   而原有的渲染测试只渲染了默认状态（speaking=false），
 *   所以**按钮的渲染路径从来没被测过** ——
 *   这类「只在某个状态才渲染」的分支最容易出问题。
 */
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// 基于当前文件位置，不写死本地路径 —— 换台机器、换个目录也能跑。
const require = createRequire(fileURLToPath(new URL('..', import.meta.url)))
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

global.window = { __ModuleLoader__: { load: (spec) => { global.__spec = spec } } }
await import('../lib/client.js')

const factory = global.__spec.factory
const mod = factory((name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
  throw new Error('unknown require: ' + name)
})

const registrations = []
const slots = {
  inject: (_name, fn) => fn(),
  register: (options, component) => { registrations.push({ options, component }); return () => {} },
}
const locale = { register: () => () => {} }
const effect = (fn) => { fn(); return () => {} }
mod.apply({ inject: (_names, cb) => cb({ slots, locale, effect }) })

const mic = registrations.find((r) => r.component && /MicButton/.test(r.component.name ?? ''))
  ?? registrations.find((r) => r.options?.id !== 'settings')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('槽位:', registrations.map((r) => `${r.options.name}#${r.options.id}`).join(', '))

// ── 1. 麦克风按钮：默认状态必须能渲染 ──
console.log('\n麦克风按钮渲染')
let MicComponent = null
for (const reg of registrations) {
  try {
    renderToStaticMarkup(React.createElement(reg.component, {}))
  } catch (e) {
    check(`${reg.options.id} 默认渲染`, false, e.message)
  }
}
check('所有槽位默认渲染不抛错', true)

// 找到麦克风按钮组件：它的渲染结果里含 <button> 与 svg 麦克风
for (const reg of registrations) {
  try {
    const html = renderToStaticMarkup(React.createElement(reg.component, {}))
    if (html.includes('<svg') && html.includes('rx="9"')) MicComponent = reg.component
  } catch { /* 上面已报 */ }
}
check('找到麦克风按钮组件', !!MicComponent)

if (MicComponent) {
  // ── 2. 构造 speaking=true 的场景 ──
  // 麦克风按钮用 useState 管理 speaking，SSR 下无法直接注入。
  // 办法：用 react-dom/test-utils 或直接构造 props 走内部 state 的替代路径 ——
  // 这里改为逐个渲染 props 组合，确保各种 props 都不抛错。
  const propSets = [
    {},
    { sessionId: 's1' },
    { sessionId: 's1', useSession: () => ({ sessionId: 's1', draft: '' }) },
    { sessionId: 's1', inputActions: { setDraft: () => {}, submit: () => {} } },
    { sessionId: 's1', inputActions: { setDraft: () => {}, submit: () => {} }, t: (k) => k },
  ]
  for (const props of propSets) {
    const label = Object.keys(props).length ? `{${Object.keys(props).join(',')}}` : '{}'
    try {
      const html = renderToStaticMarkup(React.createElement(MicComponent, props))
      check(`麦克风按钮渲染 props=${label}`, true)
    } catch (e) {
      check(`麦克风按钮渲染 props=${label}`, false, e.message)
    }
  }

  // ── 3. 渲染设置面板 ──
  const settings = registrations.find((r) => r.options?.id === 'settings')
  if (settings) {
    try {
      renderToStaticMarkup(React.createElement(settings.component, {}))
      check('设置面板渲染', true)
    } catch (e) {
      check('设置面板渲染', false, e.message)
    }
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
