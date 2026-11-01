/**
 * 浏览器侧渲染自测（SSR 冒烟）：用 React 服务端渲染跑一遍设置面板与麦克风按钮，
 * 捕获「渲染即抛错」这类问题（比如把 element 当类型传给 createElement）。
 *
 * 本文件已并入原 test/mic-render.test.mjs：
 *   - 所有槽位默认渲染；
 *   - 麦克风按钮在多组 props 下的渲染（含 inputActions / useSession / t）；
 *   - 惰性槽位回调 label()/description()/hint() 必须能调用（白屏类故障来源）。
 *
 * 注意（原 mic-render 的注释曾声称测了 speaking=true 分支）：SSR **无法注入
 * useState 内部状态**，所以「只有朗读中才出现的停止按钮」这条路这里测不到；
 * 本文件只覆盖默认状态与 props 组合。真有状态相关的回归，需要能跑 effect 的
 * 测试环境（例如 review/client-harness.mjs 那种最小 hooks 运行时，不进仓库）。
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
  register: (options, component) => {
    registrations.push({ options, component })
    return () => {}
  },
}
const locale = { register: () => () => {} }
const effect = (fn) => { fn(); return () => {} }
mod.apply({ inject: (_names, cb) => cb({ slots, locale, effect }) })

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('注册的槽位:', registrations.map((r) => `${r.options.name}#${r.options.id}`).join(', '))
check('至少注册了一个槽位', registrations.length > 0, String(registrations.length))

// ── 1. 所有槽位默认渲染不抛错 ──
console.log('\n所有槽位默认渲染')
{
  let renderFailures = 0
  for (const reg of registrations) {
    try {
      const html = renderToStaticMarkup(React.createElement(reg.component, {}))
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      check(`${reg.options.name} 默认渲染成功`, html.length > 0, '空 HTML')
      console.log('  内容:', text.slice(0, 160))
    } catch (error) {
      renderFailures += 1
      check(`${reg.options.name} 默认渲染成功`, false, error && error.message)
    }
  }
  check('所有槽位默认渲染不抛错', renderFailures === 0, `失败 ${renderFailures} 个`)
}

// ── 2. 找麦克风按钮组件：组件名优先，其次「按钮 + svg 图标」兜底 ──
// 不要写死 SVG 造型（以前断言 rx="9"，图标一改就假红）。
const micRegistration = registrations.find((r) => r.component && /MicButton/.test(r.component.name ?? ''))
  ?? registrations.find((r) => r.options?.id !== 'settings')
let MicComponent = micRegistration?.component ?? null
if (!MicComponent) {
  for (const reg of registrations) {
    try {
      const html = renderToStaticMarkup(React.createElement(reg.component, {}))
      if (html.includes('<button') && html.includes('<svg')) MicComponent = reg.component
    } catch { /* 上面已报 */ }
  }
}
check('找到麦克风按钮组件', !!MicComponent,
  '优先用导出的组件名 MicButton，其次按「按钮 + svg 图标」识别，不依赖图标细节')

// ── 3. 麦克风按钮在多组 props 下都必须能渲染（宿主可能传/不传这些 props） ──
if (MicComponent) {
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
      check(`麦克风按钮渲染 props=${label}`, html.length > 0, '空 HTML')
    } catch (error) {
      check(`麦克风按钮渲染 props=${label}`, false, error && error.message)
    }
  }
}

// ── 3b. 设置面板默认态（readAloud 默认关闭）仍渲染合成区并带提示 ──
// task-18：朗读关闭时也要允许预配语音引擎/SoVITS，不再整块隐藏。
{
  const settingsReg = registrations.find((r) => r.options?.name === 'settings.section')
  if (settingsReg) {
    try {
      const html = renderToStaticMarkup(React.createElement(settingsReg.component, {
        __initialConfig: { readAloud: false, shortcut: 'Alt+V' },
        __initialModels: [],
        t: (k) => k,
      }))
      check('设置面板默认态渲染成功', html.length > 0, '空 HTML')
      check('readAloud=false 时仍显示语音引擎（可预配 TTS）', html.includes('>ttsEngine<'))
      check('readAloud=false 时显示「仅保存、不生效」提示', html.includes('readAloudOffNotice'))
    } catch (error) {
      check('设置面板默认态渲染成功', false, error && error.message)
    }
  }
}

// ── 4. 槽位的惰性回调（label / description / hint）必须能调用 ──
// SSR 渲染不会调用它们，宿主真正渲染 slot 时才调用；不主动调一遍的话，
// 「引用了组件内部局部变量」这类错误会漏过全部测试，到界面上才炸成白屏。
console.log('\n槽位惰性回调')
for (const reg of registrations) {
  const opts = reg.options ?? {}
  for (const key of ['label', 'description', 'hint']) {
    const fn = opts[key]
    if (typeof fn !== 'function') continue
    try {
      const value = fn()
      check(`${reg.options.name}.${key}() 返回非空值`, value !== undefined && value !== null && value !== '',
        String(value))
      console.log(`  ${reg.options.name}.${key}() → ${String(value).slice(0, 60)}`)
    } catch (error) {
      check(`${reg.options.name}.${key}() 返回非空值`, false,
        `${error && error.message}（白屏类故障：回调里引用了组件内部才有的局部变量）`)
    }
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
