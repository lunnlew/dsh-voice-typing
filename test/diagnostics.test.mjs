/**
 * 诊断事件记录器测试。
 *
 * 覆盖：
 *   - 基本记录与读取（record/events）
 *   - 环形缓冲（超过上限丢弃最旧的）
 *   - 分组隔离（不同组的事件互不干扰）
 *   - 快照输出（snapshot 返回所有分组）
 *   - 多实例隔离（每次 apply() 独立队列）
 *   - 防御性编程（null/undefined/非对象参数不抛错）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDiagnostics, DIAGNOSTICS_GROUPS } from '../src/host/diagnostics.js'

describe('诊断事件记录器', () => {
  it('基本记录与读取', () => {
    const diag = createDiagnostics()
    diag.record('localTts', { error: 'test error', engine: 'local' })
    
    const events = diag.events('localTts')
    assert.equal(events.length, 1)
    assert.equal(events[0].error, 'test error')
    assert.equal(events[0].engine, 'local')
    assert.ok(events[0].at > 0) // 自动添加的时间戳
  })

  it('未记录的分组返回空数组', () => {
    const diag = createDiagnostics()
    assert.deepEqual(diag.events('nonexistent'), [])
  })

  it('环形缓冲：超过 20 条丢弃最旧的', () => {
    const diag = createDiagnostics()
    for (let i = 0; i < 25; i++) {
      diag.record('test', { index: i })
    }
    
    const events = diag.events('test')
    assert.equal(events.length, 20) // 上限 20
    assert.equal(events[0].index, 5) // 最旧的 0-4 被丢弃
    assert.equal(events[19].index, 24) // 最新的保留
  })

  it('分组隔离：不同组的事件互不干扰', () => {
    const diag = createDiagnostics()
    diag.record('localTts', { error: 'local error' })
    diag.record('onlineTts', { error: 'online error' })
    diag.record('localTts', { error: 'second local' })
    
    assert.equal(diag.events('localTts').length, 2)
    assert.equal(diag.events('onlineTts').length, 1)
    assert.equal(diag.events('localTts')[0].error, 'local error')
    assert.equal(diag.events('onlineTts')[0].error, 'online error')
  })

  it('快照输出所有分组', () => {
    const diag = createDiagnostics()
    diag.record('localTts', { error: 'err1' })
    diag.record('onlineTts', { error: 'err2' })
    
    const snapshot = diag.snapshot()
    assert.ok('localTts' in snapshot)
    assert.ok('onlineTts' in snapshot)
    assert.equal(snapshot.localTts.events.length, 1)
    assert.equal(snapshot.onlineTts.events.length, 1)
  })

  it('多实例隔离：每次 createDiagnostics() 独立队列', () => {
    const diag1 = createDiagnostics()
    const diag2 = createDiagnostics()
    
    diag1.record('test', { from: 'diag1' })
    
    assert.equal(diag1.events('test').length, 1)
    assert.equal(diag2.events('test').length, 0) // 互不影响
  })

  it('防御性编程：null/undefined 参数不抛错', () => {
    const diag = createDiagnostics()
    
    // 这些调用不应该抛错
    diag.record(null)
    diag.record(undefined)
    diag.record('test', null)
    diag.record('test', undefined)
    
    // 空对象应该被记录（至少有时间戳）
    diag.record('test', {})
    assert.equal(diag.events('test').length, 1)
    assert.ok(diag.events('test')[0].at > 0)
  })

  it('事件对象可以包含任意字段', () => {
    const diag = createDiagnostics()
    diag.record('test', {
      error: 'msg',
      customField: 'value',
      nested: { a: 1, b: 2 },
      array: [1, 2, 3],
    })
    
    const events = diag.events('test')
    assert.equal(events[0].error, 'msg')
    assert.equal(events[0].customField, 'value')
    assert.deepEqual(events[0].nested, { a: 1, b: 2 })
    assert.deepEqual(events[0].array, [1, 2, 3])
  })

  it('DIAGNOSTICS_GROUPS 常量提供标准分组名', () => {
    assert.equal(DIAGNOSTICS_GROUPS.LOCAL_TTS, 'localTts')
    assert.equal(DIAGNOSTICS_GROUPS.ONLINE_TTS, 'onlineTts')
    assert.equal(DIAGNOSTICS_GROUPS.NEURAL_TTS, 'neuralTts')
    assert.equal(DIAGNOSTICS_GROUPS.SOVITS_TTS, 'sovitsTts')
    assert.equal(DIAGNOSTICS_GROUPS.VOICE_PROMPT, 'voicePrompt')
    
    // 常量对象应该被冻结
    assert.throws(() => {
      DIAGNOSTICS_GROUPS.NEW_FIELD = 'test'
    }, /Cannot add property/i)
  })

  it('events() 返回的是快照而不是引用', () => {
    const diag = createDiagnostics()
    diag.record('test', { value: 1 })
    
    const snapshot1 = diag.events('test')
    snapshot1.push({ value: 999 }) // 修改返回的数组
    
    const snapshot2 = diag.events('test')
    assert.equal(snapshot2.length, 1) // 原队列不受影响
    assert.equal(snapshot2[0].value, 1)
  })

  it('真实场景：TTS 失败序列', () => {
    const diag = createDiagnostics()
    
    // 模拟一次典型的 TTS 失败场景
    diag.record(DIAGNOSTICS_GROUPS.LOCAL_TTS, {
      error: 'Platform not supported',
      engine: 'local',
      fallback: 'online',
    })
    
    diag.record(DIAGNOSTICS_GROUPS.ONLINE_TTS, {
      error: 'WebSocket timeout',
      engine: 'online',
      fallback: 'local',
    })
    
    diag.record(DIAGNOSTICS_GROUPS.LOCAL_TTS, {
      error: 'Voice not found',
      engine: 'local',
      fallback: 'failed',
      originalError: 'WebSocket timeout',
    })
    
    const localEvents = diag.events(DIAGNOSTICS_GROUPS.LOCAL_TTS)
    const onlineEvents = diag.events(DIAGNOSTICS_GROUPS.ONLINE_TTS)
    
    assert.equal(localEvents.length, 2)
    assert.equal(onlineEvents.length, 1)
    assert.equal(localEvents[1].fallback, 'failed')
    assert.equal(localEvents[1].originalError, 'WebSocket timeout')
  })
})
