/**
 * 浏览器侧的渲染自测：用 React 服务端渲染跑一遍设置面板与麦克风按钮，
 * 捕获「渲染即抛错」这类问题（比如把 element 当类型传给 createElement）。
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

console.log('注册的槽位:', registrations.map((r) => `${r.options.name}#${r.options.id}`).join(', '))

for (const reg of registrations) {
  try {
    const html = renderToStaticMarkup(React.createElement(reg.component, {}))
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    console.log(`\n✓ ${reg.options.name} 渲染成功（${html.length} 字节）`)
    console.log('  内容:', text.slice(0, 220))
  } catch (error) {
    console.log(`\n✗ ${reg.options.name} 渲染失败: ${error && error.message}`)
    process.exitCode = 1
  }
}

// 槽位的 label / 其它回调是**惰性**的：SSR 渲染不会调用它们，
// 宿主真正渲染 slot 时才调用。所以必须主动调一遍，
// 否则「引用了组件内部局部变量」这类错误会漏过全部测试，
// 到用户界面上才炸成白屏。
for (const reg of registrations) {
  const opts = reg.options ?? {}
  for (const key of ['label', 'description', 'hint']) {
    const fn = opts[key]
    if (typeof fn !== 'function') continue
    try {
      const value = fn()
      if (value === undefined || value === null || value === '') {
        console.log(`\n✗ ${reg.options.name} 的 ${key}() 返回了空值`)
        process.exitCode = 1
      } else {
        console.log(`✓ ${reg.options.name} 的 ${key}() → ${String(value).slice(0, 60)}`)
      }
    } catch (error) {
      console.log(`\n✗ ${reg.options.name} 的 ${key}() 抛错: ${error && error.message}`)
      console.log('   （这是白屏类故障的常见来源：回调里引用了组件内部才有的局部变量）')
      process.exitCode = 1
    }
  }
}
