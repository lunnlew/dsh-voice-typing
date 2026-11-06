/**
 * client-id.js 的单元测。
 *
 * 测的是「浏览器半侧」的客户端 id 管理与多窗口去重认领：
 * generateId / resolveClientId / claimUiAction。
 *
 * 为什么这些测：
 *   - generateId 优先用 crypto.randomUUID，失败时退化到时间+随机。
 *   - resolveClientId 优先 sessionStorage，退回 localStorage，再失败用内存 id。
 *   - claimUiAction 向宿主 POST 认领，网络失败/404/claimed:false 都返回 false。
 *   - 环境从参数进来，Node 里用假 window/crypto/fetch 就能驱动真代码。
 */

import { createClientId } from '../src/client/dom/client-id.js'

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

/* ==================== 默认态（什么都没注入） ==================== */

test('createClientId: 默认态 getClientId 返回非空串', () => {
  const ctx = createClientId()
  const id = ctx.getClientId()
  equal(typeof id, 'string')
  if (id.length === 0) throw new Error('id 不应为空')
})

test('createClientId: 默认态 claimUiAction 返回 false（无 window/fetch）', async () => {
  const ctx = createClientId()
  const result = await ctx.claimUiAction('test-request')
  equal(result, false)
})

/* ==================== crypto 注入 ==================== */

test('createClientId: 注入 crypto.randomUUID 时使用它', () => {
  let called = false
  const crypto = {
    randomUUID: () => {
      called = true
      return 'test-uuid-123'
    },
  }
  const ctx = createClientId({ getCrypto: () => crypto })
  const id = ctx.getClientId()
  if (!called) throw new Error('crypto.randomUUID 未被调用')
  equal(id, 'test-uuid-123')
})

test('createClientId: crypto.randomUUID 抛错时退化到时间+随机', () => {
  const crypto = {
    randomUUID: () => {
      throw new Error('not available')
    },
  }
  const ctx = createClientId({ getCrypto: () => crypto })
  const id = ctx.getClientId()
  equal(typeof id, 'string')
  if (!id.startsWith('client-')) throw new Error('退化 id 应以 client- 开头')
})

/* ==================== 存储注入 ==================== */

test('createClientId: 注入 sessionStorage 时优先使用它', () => {
  const stored = {}
  const sessionStorage = {
    getItem: (key) => stored[key] ?? null,
    setItem: (key, value) => {
      stored[key] = value
    },
  }
  const window = { sessionStorage }
  const ctx = createClientId({ getWindow: () => window })
  const id = ctx.getClientId()
  equal(stored['dsh-voice-typing:client-id'], id)
})

test('createClientId: sessionStorage 没有时创建新的', () => {
  const stored = {}
  const sessionStorage = {
    getItem: () => null,
    setItem: (key, value) => {
      stored[key] = value
    },
  }
  const window = { sessionStorage }
  const ctx = createClientId({ getWindow: () => window })
  const id = ctx.getClientId()
  if (!stored['dsh-voice-typing:client-id']) throw new Error('应写入 sessionStorage')
  equal(typeof id, 'string')
})

test('createClientId: sessionStorage 有值时直接返回', () => {
  const sessionStorage = {
    getItem: () => 'existing-id',
    setItem: () => {
      throw new Error('不应写入')
    },
  }
  const window = { sessionStorage }
  const ctx = createClientId({ getWindow: () => window })
  const id = ctx.getClientId()
  equal(id, 'existing-id')
})

test('createClientId: sessionStorage 抛错时退回 localStorage', () => {
  const localStorageStored = {}
  const localStorage = {
    getItem: (key) => localStorageStored[key] ?? null,
    setItem: (key, value) => {
      localStorageStored[key] = value
    },
  }
  const sessionStorage = {
    getItem: () => {
      throw new Error('disabled')
    },
    setItem: () => {
      throw new Error('disabled')
    },
  }
  const window = { sessionStorage, localStorage }
  const ctx = createClientId({ getWindow: () => window })
  const id = ctx.getClientId()
  if (!localStorageStored['dsh-voice-typing:client-id']) throw new Error('应写入 localStorage')
  equal(typeof id, 'string')
})

/* ==================== claimUiAction ==================== */

test('createClientId: claimUiAction 成功时返回 true', async () => {
  const fetch = async () => ({
    ok: true,
    json: async () => ({ claimed: true }),
  })
  const window = { fetch }
  const ctx = createClientId({ getWindow: () => window, baseUrl: '/test' })
  const result = await ctx.claimUiAction('req-1')
  equal(result, true)
})

test('createClientId: claimUiAction claimed:false 时返回 false', async () => {
  const fetch = async () => ({
    ok: true,
    json: async () => ({ claimed: false }),
  })
  const window = { fetch }
  const ctx = createClientId({ getWindow: () => window })
  const result = await ctx.claimUiAction('req-2')
  equal(result, false)
})

test('createClientId: claimUiAction HTTP 错误时返回 false', async () => {
  const fetch = async () => ({
    ok: false,
    status: 404,
  })
  const window = { fetch }
  const ctx = createClientId({ getWindow: () => window })
  const result = await ctx.claimUiAction('req-3')
  equal(result, false)
})

test('createClientId: claimUiAction 网络异常时返回 false', async () => {
  const fetch = async () => {
    throw new Error('network error')
  }
  const window = { fetch }
  const ctx = createClientId({ getWindow: () => window })
  const result = await ctx.claimUiAction('req-4')
  equal(result, false)
})

test('createClientId: claimUiAction 发送正确的请求体', async () => {
  let capturedBody = null
  const fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body)
    return {
      ok: true,
      json: async () => ({ claimed: true }),
    }
  }
  const window = { fetch }
  const ctx = createClientId({ getWindow: () => window, baseUrl: '/api' })
  await ctx.claimUiAction('req-5')
  if (!capturedBody) throw new Error('未发送请求体')
  equal(capturedBody.requestId, 'req-5')
  equal(typeof capturedBody.clientId, 'string')
})

console.log(`\n客户端 id 管理：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
