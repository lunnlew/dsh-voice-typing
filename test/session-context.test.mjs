/**
 * session-context.js 的单元测。
 *
 * 测的是「浏览器半侧」的会话上下文管理：插件 ctx 的模块级引用、
 * 上次会话 id 的持久化、clientService 的多路降级。
 *
 * 为什么这些测：
 *   - readLastSessionId / persistLastSessionId 以前住在 main.js 顶层，
 *     直接吃 window.localStorage；搬到 session-context.js 之后存储变成注入参数，
 *     测的时候可以用假存储验行为，不用碰真浏览器 API。
 *   - clientService 有三条降级路径（capturedSessionsService → ctx.get → ctx[name]），
 *     每条路径失败都要能退回下一条，不能抛错。
 *   - setPluginCtx / setCapturedSessionsService 是 apply(ctx) 时调用的，
 *     测的是「没调过的时候 clientService 返回 null」这种默认态。
 */

import { createSessionContext } from '../src/client/dom/session-context.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✓ ' + name)
  } catch (error) {
    failed++
    console.log('  ✗ ' + name + '：' + (error.message || error))
  }
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function deepEqual(actual, expected, message) {
  const actualStr = JSON.stringify(actual)
  const expectedStr = JSON.stringify(expected)
  if (actualStr !== expectedStr) {
    throw new Error(message || `期望 ${expectedStr}，实际 ${actualStr}`)
  }
}

/* ==================== 默认态（什么都没注入） ==================== */

test('createSessionContext: 默认态 clientService 返回 null', () => {
  const ctx = createSessionContext()
  equal(ctx.clientService('sessions'), null)
  equal(ctx.clientService('uiWorkspace'), null)
  equal(ctx.clientService('layout'), null)
})

test('createSessionContext: 默认态 readLastSessionId 返回空串', () => {
  const ctx = createSessionContext()
  equal(ctx.readLastSessionId(), '')
})

test('createSessionContext: 默认态 persistLastSessionId 不抛错', () => {
  const ctx = createSessionContext()
  ctx.persistLastSessionId('test-session')
  // 没存储可用，静默返回，不抛错
})

/* ==================== 存储注入 ==================== */

test('createSessionContext: 注入假存储后 readLastSessionId 能读到', () => {
  const storage = {
    getItem: (key) => (key === 'dsh-voice-typing:last-session' ? 'session-123' : null),
  }
  const ctx = createSessionContext({ readStorage: () => storage })
  equal(ctx.readLastSessionId(), 'session-123')
})

test('createSessionContext: 注入假存储后 persistLastSessionId 能写入', () => {
  const written = {}
  const storage = {
    getItem: (key) => written[key] ?? null,
    setItem: (key, value) => {
      written[key] = value
    },
  }
  const ctx = createSessionContext({
    readStorage: () => storage,
    writeStorage: () => storage,
  })
  ctx.persistLastSessionId('new-session')
  equal(written['dsh-voice-typing:last-session'], 'new-session')
  equal(ctx.readLastSessionId(), 'new-session')
})

test('createSessionContext: persistLastSessionId 相同 id 不重复写入', () => {
  let writeCount = 0
  const storage = {
    getItem: () => null,
    setItem: () => {
      writeCount++
    },
  }
  const ctx = createSessionContext({ writeStorage: () => storage })
  ctx.persistLastSessionId('existing')
  equal(writeCount, 1, '第一次写入')
  ctx.persistLastSessionId('existing')
  equal(writeCount, 1, '相同 id 不触发第二次写入')
})

test('createSessionContext: 存储读取失败时 readLastSessionId 返回空串', () => {
  const ctx = createSessionContext({
    readStorage: () => {
      throw new Error('storage unavailable')
    },
  })
  equal(ctx.readLastSessionId(), '')
})

test('createSessionContext: 存储写入失败时 persistLastSessionId 不抛错', () => {
  const ctx = createSessionContext({
    writeStorage: () => {
      throw new Error('storage unavailable')
    },
  })
  ctx.persistLastSessionId('test')
  // 静默吞错，不抛
})

/* ==================== setPluginCtx / clientService 降级 ==================== */

test('createSessionContext: setPluginCtx 后 clientService 从 ctx 取服务', () => {
  const mockCtx = {
    get: (name) => (name === 'sessions' ? { type: 'sessions-service' } : null),
  }
  const ctx = createSessionContext()
  ctx.setPluginCtx(mockCtx)
  const sessions = ctx.clientService('sessions')
  equal(sessions?.type, 'sessions-service')
})

test('createSessionContext: clientService 优先用 ctx.get()', () => {
  const mockCtx = {
    get: (name) => ({ source: 'get', name }),
    sessions: { source: 'property', name: 'sessions' },
  }
  const ctx = createSessionContext()
  ctx.setPluginCtx(mockCtx)
  const result = ctx.clientService('sessions')
  equal(result.source, 'get', '优先走 ctx.get()')
})

test('createSessionContext: ctx.get() 抛错时退回 ctx[name]', () => {
  const mockCtx = {
    get: () => {
      throw new Error('cannot get property without inject')
    },
    layout: { type: 'layout-service' },
  }
  const ctx = createSessionContext()
  ctx.setPluginCtx(mockCtx)
  const layout = ctx.clientService('layout')
  equal(layout?.type, 'layout-service')
})

test('createSessionContext: ctx.get() 和 ctx[name] 都没有时返回 null', () => {
  const mockCtx = {
    get: () => null,
  }
  const ctx = createSessionContext()
  ctx.setPluginCtx(mockCtx)
  equal(ctx.clientService('nonexistent'), null)
})

/* ==================== setCapturedSessionsService ==================== */

test('createSessionContext: setCapturedSessionsService 后 clientService("sessions") 优先用它', () => {
  const capturedService = { type: 'captured-sessions' }
  const mockCtx = {
    get: () => ({ type: 'ctx-sessions' }),
  }
  const ctx = createSessionContext()
  ctx.setPluginCtx(mockCtx)
  ctx.setCapturedSessionsService(capturedService)
  const sessions = ctx.clientService('sessions')
  equal(sessions?.type, 'captured-sessions', 'captured 优先于 ctx.get()')
})

test('createSessionContext: setCapturedSessionsService(null) 清除捕获', () => {
  const mockCtx = {
    get: () => ({ type: 'ctx-sessions' }),
  }
  const ctx = createSessionContext()
  ctx.setPluginCtx(mockCtx)
  ctx.setCapturedSessionsService({ type: 'captured' })
  ctx.setCapturedSessionsService(null)
  const sessions = ctx.clientService('sessions')
  equal(sessions?.type, 'ctx-sessions', '清除后退回 ctx.get()')
})

/* ==================== 边界情况 ==================== */

test('createSessionContext: persistLastSessionId 过滤空串和空白', () => {
  const written = {}
  const storage = {
    setItem: (key, value) => {
      written[key] = value
    },
  }
  const ctx = createSessionContext({ writeStorage: () => storage })
  ctx.persistLastSessionId('')
  ctx.persistLastSessionId('   ')
  deepEqual(written, {}, '空串和空白不写入')
})

test('createSessionContext: readLastSessionId 读到非字符串时转字符串', () => {
  const storage = {
    getItem: () => 12345,
  }
  const ctx = createSessionContext({ readStorage: () => storage })
  equal(ctx.readLastSessionId(), '12345')
})

console.log(`\n会话上下文：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
