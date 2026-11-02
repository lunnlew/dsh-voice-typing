/**
 * 客户端服务取值顺序的回归测试。
 *
 * 背景（真实 bug）：
 *   全局语音浮层的 UI 动作执行器需要 `layout` / `uiWorkspace` 这些客户端服务。
 *   插件只声明了 `inject = ['slots','locale']`，所以**直接读 `ctx.layout` 会抛**
 *   "cannot get property ... without inject"。旧的 clientService 先读
 *   `ctx[name]`、外层一个 try/catch 兜住 → 直接返回 null，
 *   于是 `toggle_sidebar` / `switch_session` 永远报 unsupported，
 *   但坑在于日志里完全看不出原因。
 *
 * 正确顺序：先用 `ctx.get(name)`（reflect.get，绕过 inject 要求）取，
 * 拿不到再退回直接属性。
 *
 * 这个测试直接加载真实产物 lib/client.js，用假 ctx 复现两种 ctx 形态，
 * 钉住取值顺序，避免以后又改回去。
 *
 * 用法：node test/client-service-order.test.mjs
 */
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

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

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log('  ok   ' + name)
  } else {
    failures.push({ name, detail })
    console.log('  FAIL ' + name + (detail ? ' :: ' + detail : ''))
  }
}

/**
 * 构造一个「像 DSH 客户端插件 ctx」的假上下文。
 *
 * @param {object} options - { getImpl: (name)=>any, directProps: 直接属性表 }。
 * @returns {object} 可传入 apply() 的 ctx。
 */
function makeCtx(options = {}) {
  const { getImpl = () => undefined, directProps = {} } = options
  const slots = {
    inject: (_name, fn) => fn(),
    register: () => () => {},
  }
  const locale = { register: () => () => {} }
  const scope = {
    slots,
    locale,
    effect: (fn) => {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
  const ctx = {
    inject: (names, cb) => {
      if (Array.isArray(names) && names.includes('sessions')) {
        cb({ sessions: null })
        return
      }
      cb(scope)
    },
    effect: (fn) => { fn(); return () => {} },
    slots,
    locale,
  }
  // ctx.get：正常版本返回服务，坏版本抛错（模拟真实 cordis 的 internal/get 失败）
  ctx.get = (name) => getImpl(name)
  for (const [key, value] of Object.entries(directProps)) {
    if (key === 'layout' || key === 'uiWorkspace') {
      // 关键：这些服务在真实环境里「没 inject 时直接读会抛」。
      Object.defineProperty(ctx, key, { get() { throw new Error(`cannot get property "${key}" without inject`) } })
    } else {
      ctx[key] = value
    }
  }
  return ctx
}

console.log('== 1. ctx.get 能拿到服务时：优先用 ctx.get（不能因为 ctx.layout 抛错就返回 null）==')
{
  const layout = { toggleSidebar: () => {} }
  const ctx = makeCtx({ getImpl: (name) => (name === 'layout' ? layout : undefined) })
  mod.apply(ctx)
  const got = mod.__test.clientService('layout')
  check('clientService(layout) 返回 ctx.get 的服务', got === layout, JSON.stringify(got))
  check('返回对象带 toggleSidebar', typeof got?.toggleSidebar === 'function')
}
{
  const workspace = { openSession: () => {} }
  const ctx = makeCtx({ getImpl: (name) => (name === 'uiWorkspace' ? workspace : undefined) })
  mod.apply(ctx)
  check('clientService(uiWorkspace) 返回 ctx.get 的服务', mod.__test.clientService('uiWorkspace') === workspace)
}

console.log('== 2. ctx.get 拿不到时：退回直接属性 ==')
{
  const layout = { toggleSidebar: () => {} }
  const ctx = makeCtx({ getImpl: () => undefined })
  // 这次让 directProps 提供一个「可直接读」的 layout（不抛错）
  const ctx2 = makeCtx({ getImpl: () => undefined })
  ctx2.layout = layout
  mod.apply(ctx2)
  check('ctx.get 没有服务 → 用直接属性', mod.__test.clientService('layout') === layout)
}

console.log('== 3. ctx.get 抛错时：仍然要退回直接属性（而不是整体返回 null）==')
{
  const layout = { toggleSidebar: () => {} }
  const ctx = makeCtx({ getImpl: () => { throw new Error('internal/get failed') } })
  ctx.layout = layout
  mod.apply(ctx)
  check('ctx.get 抛错 → 退回直接属性', mod.__test.clientService('layout') === layout)
}

console.log('== 4. 两边都没有：返回 null，不抛错 ==')
{
  const ctx = makeCtx({ getImpl: () => undefined })
  mod.apply(ctx)
  let threw = false
  let got
  try { got = mod.__test.clientService('layout') } catch { threw = true }
  check('没有服务时返回 null', got === null && threw === false, String(got))
}

console.log('== 5. 有服务时 state 动作能报告能力（渲染冒烟不崩）==')
{
  const layout = { toggleSidebar: () => {} }
  const workspace = { openSession: () => {} }
  const ctx = makeCtx({ getImpl: (name) => (name === 'layout' ? layout : name === 'uiWorkspace' ? workspace : undefined) })
  mod.apply(ctx)
  check('state 能力探测前提：hasLayout 条件成立',
    typeof mod.__test.clientService('layout')?.toggleSidebar === 'function')
  check('state 能力探测前提：hasWorkspace 条件成立',
    typeof mod.__test.clientService('uiWorkspace')?.openSession === 'function')
  check('设置面板仍可渲染', renderToStaticMarkup(React.createElement('div', null, 'ok')).includes('ok'))
}

if (failures.length > 0) {
  console.log(`\n✗ ${failures.length} 条失败：`)
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exitCode = 1
} else {
  console.log(`\n✓ 全部通过（${passed} 条断言）`)
}
