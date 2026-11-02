/**
 * 系统级全局热键 helper 的单元测试。
 *
 * 这里**不真的拉起 PowerShell**：helper 的职责被拆成
 *   - 纯函数：加速键解析、脚本生成（可逐字断言）；
 *   - 生命周期：sync/dispose 用假 spawn 驱动（记录参数、假子进程）。
 * 真机行为（热键是否被系统接受、POST 是否到达）只能在有桌面的 Windows
 * 上人工验证 —— 这里不假装覆盖它。
 *
 * 用法：node test/global-hotkey-helper.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
  buildHelperScript,
  createHotkeyHelper,
  helperSupported,
  parseAccelerator,
} from '../lib/global-hotkey-helper.js'

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
 * 假 PowerShell 子进程：EventEmitter + stdout/stderr（宿主靠它们等 READY）。
 * @param {number} pid - 假 pid。
 * @returns {EventEmitter & {pid:number, killed:boolean, kill:Function, stdout:EventEmitter, stderr:EventEmitter}}
 */
function makeFakeChild(pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.killed = false
  child.kill = () => { child.killed = true }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

/** 模拟脚本 RegisterHotKey 成功后打印 READY。 */
function emitReady(child) {
  child.stdout.emit('data', Buffer.from('READY\n'))
}

/** 等异步 native 加载落地（加载器是真 Promise 链，一个 macrotask 足够）。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 假 uiohook-napi 模块：只实现 native 适配器用到的那部分接口。
 * 测试**绝不** import 真模块 / 真注册系统热键。
 */
function makeFakeNative() {
  const handlers = new Map()
  const uIOhook = {
    starts: 0,
    stops: 0,
    offCalls: 0,
    on(event, fn) { handlers.set(event, fn); return this },
    off(event, fn) {
      uIOhook.offCalls += 1
      if (handlers.get(event) === fn) handlers.delete(event)
      return this
    },
    start() { uIOhook.starts += 1 },
    stop() { uIOhook.stops += 1 },
  }
  return {
    uIOhook,
    UiohookKey: { V: 47, Space: 57, F5: 63, A: 30, '1': 2 },
    handlers,
    /** 模拟一次 keydown（只有匹配的监听会被调用）。 */
    emitKeydown(event) {
      const listener = handlers.get('keydown')
      if (listener) listener(event)
    },
  }
}

console.log('\n== 1. 平台判定 ==')
check('Windows 支持 PowerShell helper', helperSupported('win32') === true)
check('macOS 无 PowerShell helper（走 native）', helperSupported('darwin') === false)
check('Linux 无 PowerShell helper（走 native）', helperSupported('linux') === false)

console.log('\n== 2. 加速键解析 ==')
{
  const ok = parseAccelerator('Ctrl+Alt+V')
  check('Ctrl+Alt+V 合法', ok.ok === true, JSON.stringify(ok))
  check('Ctrl+Alt+V 虚拟键码 = 0x56', ok.ok && ok.vk === 0x56, String(ok.vk))
  check('Ctrl+Alt+V 带 MOD_ALT|MOD_CONTROL|MOD_NOREPEAT',
    ok.ok && (ok.modifiers & 0x0001) !== 0 && (ok.modifiers & 0x0002) !== 0 && (ok.modifiers & 0x4000) !== 0,
    String(ok.modifiers))
  const f5 = parseAccelerator('Shift+Alt+F5')
  check('Shift+Alt+F5 合法且 vk=0x74', f5.ok && f5.vk === 0x74, JSON.stringify(f5))
  const space = parseAccelerator('Ctrl+Shift+Space')
  check('Ctrl+Shift+Space 合法', space.ok && space.vk === 0x20, JSON.stringify(space))
  const digit = parseAccelerator('Alt+1')
  check('Alt+1 合法且 vk=0x31', digit.ok && digit.vk === 0x31, JSON.stringify(digit))

  const noKey = parseAccelerator('Ctrl+Alt')
  check('只有修饰键 → 非法', noKey.ok === false && /主键/.test(noKey.reason), JSON.stringify(noKey))
  const twoKeys = parseAccelerator('Ctrl+Alt+V+W')
  check('两个主键 → 非法', twoKeys.ok === false, JSON.stringify(twoKeys))
  const noModifier = parseAccelerator('V')
  check('没有修饰键 → 非法', noModifier.ok === false, JSON.stringify(noModifier))
  const repeated = parseAccelerator('Ctrl+Ctrl+V')
  check('修饰键重复 → 非法', repeated.ok === false, JSON.stringify(repeated))
  const unknown = parseAccelerator('Ctrl+Alt+F25')
  check('不认识的键 → 非法', unknown.ok === false, JSON.stringify(unknown))
  const empty = parseAccelerator('')
  check('空串 → 非法', empty.ok === false, JSON.stringify(empty))
  const notString = parseAccelerator(42)
  check('非字符串 → 非法', notString.ok === false, JSON.stringify(notString))

  // 单字母/数字主键必须搭配 Ctrl/Alt/Win：Shift+V 会在任何应用里吞掉大写 V。
  const shiftV = parseAccelerator('Shift+V')
  check('Shift+V → 非法（单字母缺强修饰键）', shiftV.ok === false && /Shift|Ctrl/.test(shiftV.reason), JSON.stringify(shiftV))
  const shiftDigit = parseAccelerator('Shift+1')
  check('Shift+1 → 非法', shiftDigit.ok === false, JSON.stringify(shiftDigit))
  check('Ctrl+V 合法', parseAccelerator('Ctrl+V').ok === true)
  check('Alt+V 合法', parseAccelerator('Alt+V').ok === true)
  check('Meta+V 合法', parseAccelerator('Meta+V').ok === true)
  check('Shift+Alt+F5 合法（功能键允许 Shift）', parseAccelerator('Shift+Alt+F5').ok === true)

  // keyName 是 native 路径用的 uiohook 键名（与 Windows 虚拟键码并存）。
  check('keyName：Ctrl+Alt+V → V', parseAccelerator('Ctrl+Alt+V').keyName === 'V')
  check('keyName：Ctrl+Shift+Space → Space', parseAccelerator('Ctrl+Shift+Space').keyName === 'Space')
  check('keyName：Alt+1 → 1', parseAccelerator('Alt+1').keyName === '1')
  check('keyName：Shift+Alt+F5 → F5', parseAccelerator('Shift+Alt+F5').keyName === 'F5')
  check('keyName：Ctrl+ArrowUp → ArrowUp', parseAccelerator('Ctrl+ArrowUp').keyName === 'ArrowUp')
}

console.log('\n== 3. 脚本生成 ==')
{
  const script = buildHelperScript({ port: 45678, token: 'a'.repeat(32), accelerator: 'Ctrl+Alt+V' })
  check('脚本包含 token', script.includes('a'.repeat(32)))
  check('脚本包含端口与路由', script.includes('http://127.0.0.1:45678/dsh-voice-typing/hotkey'))
  check('脚本包含 RegisterHotKey 的修饰键与虚拟键码', script.includes('Run(16387') || /Run\(\s*\d/.test(script))
  check('脚本含 Add-Type 与 GetMessage', script.includes('Add-Type') && script.includes('GetMessage'))
  check('脚本含请求头 x-dsh-voice-token', script.includes('x-dsh-voice-token'))
  check('脚本没有硬编码用户目录', !/[A-Za-z]:[\\/][A-Za-z0-9_.-]+[\\/]/.test(script))
  // 企业代理/PAC 可能吞掉回环请求 → C# 必须显式禁用代理。
  check('C# POST 禁用了系统代理（Proxy = null）', script.includes('request.Proxy = null'))
  check('C# 关闭了 Expect100Continue', script.includes('Expect100Continue = false'))
  // 宿主靠这两行判断「注册成功/失败」，不能只凭 spawn 成功就报 enabled。
  check('脚本在 RegisterHotKey 成功后打印 READY', script.includes('Console.WriteLine("READY")'))
  check('脚本在注册失败时打印 REGISTER_FAILED', script.includes('Console.Error.WriteLine("REGISTER_FAILED")'))

  // 宿主 origin 优先（TLS/非 loopback 绑定时 127.0.0.1 拼出来的 URL 会打不通）。
  const originScript = buildHelperScript({
    token: 'a'.repeat(32), accelerator: 'Ctrl+Alt+V', origin: 'https://192.168.1.9:8443',
  })
  check('origin 优先于 127.0.0.1 兜底',
    originScript.includes('https://192.168.1.9:8443/dsh-voice-typing/hotkey'),
    originScript.slice(-160))
  check('有 origin 时不需要 port',
    (() => { try { buildHelperScript({ token: 'a'.repeat(32), accelerator: 'Ctrl+Alt+V', origin: 'https://x.example:9443' }); return true } catch { return false } })())
  const badOriginScript = buildHelperScript({
    port: 45678, token: 'a'.repeat(32), accelerator: 'Ctrl+Alt+V', origin: 'ftp://nope',
  })
  check('非法 origin 回退到 127.0.0.1:port',
    badOriginScript.includes('http://127.0.0.1:45678/dsh-voice-typing/hotkey'))

  let threw = false
  try { buildHelperScript({ port: 45678, token: 'a'.repeat(32), accelerator: 'V' }) } catch { threw = true }
  check('非法加速键生成脚本时抛错', threw === true)

  threw = false
  try { buildHelperScript({ port: 0, token: 'a'.repeat(32), accelerator: 'Ctrl+Alt+V' }) } catch { threw = true }
  check('非法端口生成脚本时抛错', threw === true)

  threw = false
  try { buildHelperScript({ port: 45678, token: 'short', accelerator: 'Ctrl+Alt+V' }) } catch { threw = true }
  check('过短 token 生成脚本时抛错', threw === true)
}

console.log('\n== 4. 生命周期（假 spawn）：starting → READY → enabled ==')
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-hotkey-test-'))
  const spawned = []
  const children = []
  let tokenSeq = 0
  const helper = createHotkeyHelper({
    platform: 'win32',
    tmpDir,
    log: () => {},
    createToken: () => 'f'.repeat(24) + String(++tokenSeq),
    spawnImpl: (command, args, options) => {
      const child = makeFakeChild(1000 + children.length)
      spawned.push({ command, args, options })
      children.push(child)
      return child
    },
  })
  check('token 暴露且足够长', typeof helper.token === 'string' && helper.token.length >= 16)

  const off = helper.sync({ globalHotkeyHelper: false, globalVoice: true }, 45678)
  check('开关关闭 → 不拉起', off.enabled === false && spawned.length === 0, JSON.stringify(off))

  // 浮层没开（globalVoice=false）时注册系统热键没有消费者，必须一起停掉。
  const overlayOff = helper.sync({ globalHotkeyHelper: true, globalVoice: false, globalShortcut: 'Ctrl+Alt+V' }, 45678)
  check('浮层关闭 → 不拉起并说明原因',
    overlayOff.enabled === false && /浮层|globalVoice/.test(overlayOff.reason) && spawned.length === 0,
    JSON.stringify(overlayOff))

  const bad = helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'V' }, 45678)
  check('快捷键非法 → 不拉起并给出原因', bad.enabled === false && /非法/.test(bad.reason) && spawned.length === 0, JSON.stringify(bad))

  const starting = helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 45678)
  check('合法配置 → 拉起一次，但先进入 starting（不谎报 enabled）',
    starting.enabled === false && starting.status === 'starting' && spawned.length === 1
      && /等待/.test(starting.reason), JSON.stringify(starting))
  check('spawn 以 stdout/stderr 管道接 READY / REGISTER_FAILED',
    JSON.stringify(spawned[0].options?.stdio) === JSON.stringify(['ignore', 'pipe', 'pipe']),
    JSON.stringify(spawned[0].options?.stdio))
  check('启动命令是 powershell.exe', spawned[0].command === 'powershell.exe' || /powershell/i.test(spawned[0].command))
  check('启动参数含 -File 与脚本路径', spawned[0].args.includes('-File') && typeof spawned[0].args[spawned[0].args.length - 1] === 'string')
  const scriptFile = spawned[0].args[spawned[0].args.length - 1]
  check('脚本文件已写出', fs.existsSync(scriptFile), scriptFile)
  check('脚本文件内容含 token', fs.readFileSync(scriptFile, 'utf8').includes(helper.token))
  // PowerShell 5.1 按 ANSI 读无 BOM 脚本 → 中文注释乱码；落盘必须是 UTF-8 BOM。
  const scriptBytes = fs.readFileSync(scriptFile)
  check('脚本文件带 UTF-8 BOM',
    scriptBytes[0] === 0xEF && scriptBytes[1] === 0xBB && scriptBytes[2] === 0xBF,
    [...scriptBytes.slice(0, 3)].join(','))
  check('windowsHide=true', spawned[0].options && spawned[0].options.windowsHide === true)

  emitReady(children[0])
  const on = helper.state()
  check('收到 READY → enabled=true（RegisterHotKey 确认成功）',
    on.enabled === true && on.status === 'enabled' && /已启动/.test(on.reason), JSON.stringify(on))

  const again = helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 45678)
  check('同配置重复 sync 不重启', again.enabled === true && spawned.length === 1, JSON.stringify(again))

  const changed = helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+F5' }, 45678)
  check('换快捷键 → 重启一次（新进程先 starting）',
    changed.enabled === false && changed.status === 'starting' && spawned.length === 2, JSON.stringify(changed))
  emitReady(children[1])
  check('新进程 READY 后 enabled', helper.state().enabled === true)

  // 浮层关掉要回收已启动的 helper（不能留一个按了没反应的常驻进程/热键）。
  const overlayClosed = helper.sync({ globalHotkeyHelper: true, globalVoice: false, globalShortcut: 'Ctrl+Alt+F5' }, 45678)
  check('运行中关浮层 → 回收子进程', overlayClosed.enabled === false && children[1].killed === true, JSON.stringify(overlayClosed))
  check('旧子进程被 kill', children[0].killed === true)
  const firstScript = spawned[0].args[spawned[0].args.length - 1]
  check('旧脚本被清理', !fs.existsSync(firstScript), firstScript)

  // 重新打开浮层应能重启（同配置 sync 是幂等的、停掉后能再起）。
  const reopened = helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+F5' }, 45678)
  check('重新打开浮层 → 重新拉起（starting）',
    reopened.enabled === false && reopened.status === 'starting' && spawned.length === 3, JSON.stringify(reopened))
  emitReady(children[2])
  const reopenedReady = helper.state()
  check('重新拉起后 READY → enabled', reopenedReady.enabled === true)

  const liveScript = spawned[2].args[spawned[2].args.length - 1]
  children[2].emit('exit', 0)
  const afterExit = helper.state()
  check('子进程退出后状态回到未启用', afterExit.enabled === false && /退出/.test(afterExit.reason), JSON.stringify(afterExit))
  // 正常退出也要删临时脚本（含 token 的 .ps1 不能留在 %TEMP%）。
  check('子进程正常退出时删除临时脚本', !fs.existsSync(liveScript), liveScript)

  const diag = helper.state()
  check('诊断快照不含 token', JSON.stringify(diag).includes(helper.token) === false)
  check('诊断快照带平台/状态位', diag.platform === 'win32' && typeof diag.status === 'string')

  helper.dispose()
  check('dispose 是幂等的', (() => { helper.dispose(); return true })())

  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 清理失败不影响断言 */ }
}

console.log('\n== 4b. spawn 异步失败（error 事件）不能打死进程 ==')
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-hotkey-err-'))
  const children = []
  const helper = createHotkeyHelper({
    platform: 'win32',
    tmpDir,
    createToken: () => 'e'.repeat(32),
    spawnImpl: () => {
      const child = makeFakeChild(9001)
      children.push(child)
      return child
    },
  })
  const starting = helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 45678)
  check('error 场景先进入 starting（不谎报 enabled）',
    starting.enabled === false && starting.status === 'starting', JSON.stringify(starting))
  const scriptBefore = fs.readdirSync(tmpDir).filter((name) => name.endsWith('.ps1'))
  check('启动时写出了临时脚本', scriptBefore.length === 1, JSON.stringify(scriptBefore))

  let threw = false
  try {
    // 没有 error 监听时，这个 emit 会抛未捕获异常直接打死进程。
    children[0].emit('error', new Error('spawn powershell.exe ENOENT'))
  } catch {
    threw = true
  }
  check('spawn error 不会抛未捕获异常', threw === false)
  const after = helper.state()
  check('spawn error 后状态回未启用且带原因',
    after.enabled === false && /启动失败/.test(after.reason), JSON.stringify(after))
  check('spawn error 后临时脚本被清理',
    fs.readdirSync(tmpDir).filter((name) => name.endsWith('.ps1')).length === 0)
  helper.dispose()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log('\n== 4c. 注册失败 / 提前退出 → failed，且清临时脚本 ==')
{
  // C# RegisterHotKey 失败：stderr 打 REGISTER_FAILED。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-hotkey-regfail-'))
  const children = []
  const helper = createHotkeyHelper({
    platform: 'win32',
    tmpDir,
    createToken: () => 'r'.repeat(32),
    spawnImpl: () => {
      const child = makeFakeChild(7001)
      children.push(child)
      return child
    },
  })
  helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 45678)
  check('注册阶段不谎报 enabled', helper.state().enabled === false)
  children[0].stderr.emit('data', Buffer.from('REGISTER_FAILED\n'))
  const failed = helper.state()
  check('REGISTER_FAILED → failed 且 reason 说明注册失败',
    failed.enabled === false && failed.status === 'failed' && /注册失败/.test(failed.reason), JSON.stringify(failed))
  check('REGISTER_FAILED 后子进程被回收', children[0].killed === true)
  check('REGISTER_FAILED 后临时脚本被清理',
    fs.readdirSync(tmpDir).filter((name) => name.endsWith('.ps1')).length === 0)
  helper.dispose()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}
{
  // 进程在 READY 之前退出（powershell 语法错误 / 被安全软件秒杀）。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-hotkey-earlyexit-'))
  const children = []
  const helper = createHotkeyHelper({
    platform: 'win32',
    tmpDir,
    createToken: () => 'x'.repeat(32),
    spawnImpl: () => {
      const child = makeFakeChild(7002)
      children.push(child)
      return child
    },
  })
  helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 45678)
  children[0].emit('exit', 1)
  const failed = helper.state()
  check('未 READY 就退出 → failed（reason 带 code）',
    failed.enabled === false && failed.status === 'failed' && /启动失败/.test(failed.reason) && /code=1/.test(failed.reason),
    JSON.stringify(failed))
  check('提前退出后临时脚本被清理',
    fs.readdirSync(tmpDir).filter((name) => name.endsWith('.ps1')).length === 0)
  helper.dispose()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log('\n== 5. 非 Windows：native 模块缺失/加载失败 → 安静降级（不 spawn）==')
{
  const spawned = []
  const helper = createHotkeyHelper({
    platform: 'linux',
    loadNative: async () => {
      const error = new Error("Cannot find module 'uiohook-napi'")
      error.code = 'ERR_MODULE_NOT_FOUND'
      throw error
    },
    spawnImpl: () => { spawned.push(1); throw new Error('should not spawn') },
  })
  const loading = helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 45678)
  check('native 加载中不谎报 enabled', loading.enabled === false && /加载/.test(loading.reason), JSON.stringify(loading))
  await tick()
  const failed = helper.state()
  check('模块缺失 → 降级为 failed 并给出原因',
    failed.enabled === false && /原生热键不可用|uiohook/.test(failed.reason), JSON.stringify(failed))
  check('native 路径不拉起 PowerShell', spawned.length === 0)
  helper.dispose()
}

console.log('\n== 6. 非 Windows：uiohook-napi native 适配器（假模块）==')
{
  const fake = makeFakeNative()
  let loadCalls = 0
  const triggered = []
  const helper = createHotkeyHelper({
    platform: 'darwin',
    createToken: () => 'x'.repeat(32),
    onTrigger: (action) => triggered.push(action),
    loadNative: async () => { loadCalls += 1; return { uIOhook: fake.uIOhook, UiohookKey: fake.UiohookKey } },
  })

  const loading = helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 0)
  check('加载完成前 enabled=false（不谎报）', loading.enabled === false && /加载/.test(loading.reason), JSON.stringify(loading))
  await tick()
  const on = helper.state()
  check('加载完成 → enabled=true 且 reason 标 native',
    on.enabled === true && /native/.test(on.reason) && loadCalls === 1, JSON.stringify(on))
  check('注册了 keydown 并 start 一次', fake.handlers.has('keydown') && fake.uIOhook.starts === 1)

  fake.emitKeydown({ keycode: fake.UiohookKey.V, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })
  check('命中 → onTrigger("toggle")', triggered.length === 1 && triggered[0] === 'toggle', JSON.stringify(triggered))

  fake.emitKeydown({ keycode: fake.UiohookKey.V, ctrlKey: true, altKey: false })
  check('修饰键不匹配 → 不触发', triggered.length === 1)

  fake.emitKeydown({ keycode: fake.UiohookKey.V, ctrlKey: true, altKey: true, shiftKey: true })
  check('多按 Shift → 不触发（精确修饰键，符合 RegisterHotKey 语义）', triggered.length === 1)

  fake.emitKeydown({ keycode: fake.UiohookKey.Space, ctrlKey: true, altKey: true })
  check('按键不对 → 不触发', triggered.length === 1)

  fake.emitKeydown({ keycode: fake.UiohookKey.V, ctrlKey: true, altKey: true })
  helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 0)
  await tick()
  check('同配置重复 sync 不重复加载/重启', loadCalls === 1 && fake.uIOhook.starts === 1)

  // 换键位 → 重新加载并换键名
  const changed = helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Shift+Space' }, 0)
  check('换键位 → 先停后重载（加载中）', changed.enabled === false, JSON.stringify(changed))
  await tick()
  const changedState = helper.state()
  check('换键位后 enabled 且旧监听已注销',
    changedState.enabled === true && fake.uIOhook.offCalls >= 1 && fake.uIOhook.starts === 2, JSON.stringify(changedState))
  triggered.length = 0
  fake.emitKeydown({ keycode: fake.UiohookKey.Space, ctrlKey: true, shiftKey: true })
  check('新键位命中', triggered.length === 1)

  helper.dispose()
  check('dispose 注销 keydown 并 stop',
    !fake.handlers.has('keydown') && fake.uIOhook.stops >= 1 && fake.uIOhook.offCalls >= 2)
  triggered.length = 0
  fake.emitKeydown({ keycode: fake.UiohookKey.V, ctrlKey: true, altKey: true })
  check('dispose 后按键不再触发', triggered.length === 0)
  check('dispose 后状态未启用', helper.state().enabled === false)
}

console.log('\n== 7. native 加载失败可重试 & 配置闸门 ==')
{
  // 第一次加载失败（例如用户没给辅助功能权限），修好后再次 sync 应能重试成功。
  const fake = makeFakeNative()
  let attempts = 0
  const helper = createHotkeyHelper({
    platform: 'linux',
    onTrigger: () => {},
    loadNative: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('permission denied')
      return { uIOhook: fake.uIOhook, UiohookKey: fake.UiohookKey }
    },
  })
  helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 0)
  await tick()
  check('第一次失败 → failed 原因可见', helper.state().enabled === false && /permission denied/.test(helper.state().reason))
  helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 0)
  await tick()
  check('再次 sync 可重试成功', helper.state().enabled === true && attempts === 2, JSON.stringify(helper.state()))
  helper.dispose()
}
{
  // 闸门：helper 关 / 浮层关 / 快捷键非法 → 一次都不加载。
  let loads = 0
  const fake = makeFakeNative()
  const helper = createHotkeyHelper({
    platform: 'linux',
    loadNative: async () => { loads += 1; return { uIOhook: fake.uIOhook, UiohookKey: fake.UiohookKey } },
  })
  const offByHelper = helper.sync({ globalHotkeyHelper: false, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 0)
  const offByVoice = helper.sync({ globalHotkeyHelper: true, globalVoice: false, globalShortcut: 'Ctrl+Alt+V' }, 0)
  const badShortcut = helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Shift+V' }, 0)
  check('helper 关 / 浮层关 / Shift+V → 都不加载',
    loads === 0 && offByHelper.enabled === false && offByVoice.enabled === false && badShortcut.enabled === false)
  check('浮层关闭的 reason 说明原因', /浮层|globalVoice/.test(offByVoice.reason), offByVoice.reason)
  check('Shift+V 被拒（单字母需 Ctrl/Alt/Win）', /Shift|Ctrl/.test(badShortcut.reason), badShortcut.reason)
  helper.dispose()
  check('闸门场景没有注册任何 hook', !fake.handlers.has('keydown'))
}
{
  // 模块导出不完整（有 uIOhook 缺 UiohookKey / 缺 start）→ failed，不抛异常。
  const fake = makeFakeNative()
  const helper = createHotkeyHelper({
    platform: 'linux',
    loadNative: async () => ({ uIOhook: fake.uIOhook }), // 没有 UiohookKey
  })
  helper.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 0)
  await tick()
  const state = helper.state()
  check('模块接口不完整 → failed 且不抛异常',
    state.enabled === false && /原生热键不可用/.test(state.reason), JSON.stringify(state))
  helper.dispose()
}

console.log('\n== 8. 默认 native 加载器闸门：无显示/显式禁用时不 import、不 abort ==')
{
  const oldDisplay = process.env.DISPLAY
  const oldDisable = process.env.DSH_VOICE_TYPING_DISABLE_NATIVE_HOOK
  try {
    // Linux 无 DISPLAY：libuiohook 的 XRecord 会 abort（不可捕获），必须提前拒绝。
    delete process.env.DISPLAY
    delete process.env.DSH_VOICE_TYPING_DISABLE_NATIVE_HOOK
    const headless = createHotkeyHelper({ platform: 'linux', onTrigger: () => {} })
    headless.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 0)
    await tick()
    const headlessState = headless.state()
    check('Linux 无 DISPLAY → failed 且原因说明没有显示服务器',
      headlessState.enabled === false && /DISPLAY|显示/.test(headlessState.reason), JSON.stringify(headlessState))
    headless.dispose()

    // 显式禁用：任何平台都不 import。
    process.env.DSH_VOICE_TYPING_DISABLE_NATIVE_HOOK = '1'
    const disabled = createHotkeyHelper({ platform: 'darwin', onTrigger: () => {} })
    disabled.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 0)
    await tick()
    const disabledState = disabled.state()
    check('显式禁用 → failed 且原因说明被禁用',
      disabledState.enabled === false && /禁用/.test(disabledState.reason), JSON.stringify(disabledState))
    disabled.dispose()

    // 注入的 fake loader 不受闸门影响：仍能走完整 native 流程。
    const fake = makeFakeNative()
    const injected = createHotkeyHelper({
      platform: 'linux',
      onTrigger: () => {},
      loadNative: async () => ({ uIOhook: fake.uIOhook, UiohookKey: fake.UiohookKey }),
    })
    injected.sync({ globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' }, 0)
    await tick()
    check('注入 fake loader 时闸门不生效（enabled=true）', injected.state().enabled === true, JSON.stringify(injected.state()))
    injected.dispose()
  } finally {
    if (oldDisplay === undefined) delete process.env.DISPLAY
    else process.env.DISPLAY = oldDisplay
    if (oldDisable === undefined) delete process.env.DSH_VOICE_TYPING_DISABLE_NATIVE_HOOK
    else process.env.DSH_VOICE_TYPING_DISABLE_NATIVE_HOOK = oldDisable
  }
}

if (failures.length > 0) {
  console.log(`\n✗ ${failures.length} 条失败：`)
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exitCode = 1
} else {
  console.log(`\n✓ 全部通过（${passed} 条断言）`)
}
