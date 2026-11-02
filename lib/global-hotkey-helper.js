/**
 * 系统级全局热键 helper（跨平台）。
 *
 * 为什么需要它：
 *   DSH 桌面端的渲染器拿不到 Electron API，插件宿主又是独立的
 *   ELECTRON_RUN_AS_NODE 进程 —— 插件里没有任何 `globalShortcut`
 *   可用（全 asar 0 命中）。所以「窗口没聚焦也能按快捷键说话」
 *   只能由插件自己实现，分两条路：
 *
 *   - **Windows**：拉起一个 PowerShell 子进程，用 C# 的
 *     `RegisterHotKey`/`GetMessage` 注册系统热键，按下时 POST 到插件宿主
 *     自己的 `/hotkey` 路由（token 鉴权），宿主再经 SSE 通知渲染器。
 *   - **macOS / Linux**：动态加载可选依赖 `uiohook-napi`（libuiohook 的
 *     Node 绑定），在本进程内监听 `keydown`；命中后**直接调用**宿主传入的
 *     `onTrigger('toggle')`（宿主内部广播 SSE），不经过 HTTP、不需要 token/端口。
 *     模块缺失、没有辅助功能权限（macOS）、Wayland 不支持等情况只记录
 *     reason 并安静降级 —— 热键失效不能影响语音主链路。
 *
 * 设计约束：
 *   - 不改 DSH、不碰系统配置/注册表；默认关闭，只在用户显式打开且
 *     `globalVoice=true`（浮层确实存在）时启用；
 *   - 脚本/加载参数全部由本模块生成，不读用户目录；
 *   - 子进程/原生模块失败只记录状态，不影响插件其余功能；
 *   - 纯函数（加速键解析、脚本生成）与生命周期分开，方便 Node 测试注入
 *     假 spawn / 假 native loader，**测试不会真的注册系统热键**。
 *
 * 调用方：lib/index.js（宿主入口）。Windows 路由 `/dsh-voice-typing/hotkey`
 * 的 token 必须与本模块生成的 token 一致，否则 helper 的请求会被 403 拒绝。
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** helper 回调的宿主路由（与 lib/index.js 注册的路径一致；native 路径不用它）。 */
export const HELPER_ROUTE = '/dsh-voice-typing/hotkey'

/** Win32 修饰键位（与 user32 RegisterHotKey 的 fsModifiers 一致）。 */
const MOD_ALT = 0x0001
const MOD_CONTROL = 0x0002
const MOD_SHIFT = 0x0004
const MOD_WIN = 0x0008
/** 按住不放时不重复触发。 */
const MOD_NOREPEAT = 0x4000
/** 真正的修饰键位（native 匹配时要忽略 MOD_NOREPEAT）。 */
const MOD_REAL_MASK = MOD_ALT | MOD_CONTROL | MOD_SHIFT | MOD_WIN

/** 键名 → 虚拟键码（Windows RegisterHotKey；未列出的直接判非法）。 */
const VK_BY_KEY = {
  space: 0x20,
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  ins: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  arrowup: 0x26,
  arrowdown: 0x28,
  arrowleft: 0x25,
  arrowright: 0x27,
}

/**
 * 键名 → uiohook-napi `UiohookKey` 的属性名（native 路径用）。
 * 必须覆盖 VK_BY_KEY 的全部键 + 字母/数字/F1-F24（见 nativeKeyNameOf）。
 */
const NATIVE_KEY_NAMES = {
  space: 'Space',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
}

/** 修饰键别名 → 位。 */
const MODIFIER_ALIASES = {
  ctrl: MOD_CONTROL,
  control: MOD_CONTROL,
  alt: MOD_ALT,
  option: MOD_ALT,
  shift: MOD_SHIFT,
  meta: MOD_WIN,
  win: MOD_WIN,
  windows: MOD_WIN,
  super: MOD_WIN,
  cmd: MOD_WIN,
  command: MOD_WIN,
}

/**
 * 当前平台是否有「额外进程 helper」（PowerShell + HTTP 路由）。
 *
 * 注意：这只是 **Windows 路径**。macOS/Linux 走 native（uiohook-napi）路径，
 * 是否需要 /hotkey 路由与此无关；宿主仍只在 win32 上开放该路由。
 *
 * @param {string} [platform] - 进程平台（测试可注入）。
 * @returns {boolean} Windows 为 true，其余 false。
 */
export function helperSupported(platform = process.platform) {
  return platform === 'win32'
}

/**
 * 把配置里的加速键字符串（如 `Ctrl+Alt+V`）解析成注册热键需要的信息。
 *
 * 规则与设置面板的 `validateShortcut` 保持一致（宿主侧再严格一点）：
 *   - 必须**恰好一个**非修饰键，且必须至少带一个修饰键
 *     （没有修饰键的全局热键会吞掉普通输入）；
 *   - **单字母/数字主键必须搭配 Ctrl/Alt/Win**：`Shift+V` 会在任何应用里
 *     吞掉大写 V（等于吃掉用户输入），设置面板已禁止，宿主这里也必须拒绝；
 *   - 不认识的键名直接判非法，不做模糊匹配 —— 悄悄换成别的键比报错更糟。
 *
 * @param {unknown} accelerator - 用户配置值。
 * @returns {{ok:true, modifiers:number, vk:number, key:string, keyName:string, label:string} |
 *   {ok:false, reason:string}} 解析结果（`keyName` 是 uiohook 的键名）或人类可读的失败原因。
 */
export function parseAccelerator(accelerator) {
  if (typeof accelerator !== 'string' || accelerator.trim() === '') {
    return { ok: false, reason: '快捷键为空' }
  }
  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length < 2) return { ok: false, reason: '至少需要一个修饰键 + 一个按键' }

  let modifiers = 0
  let keyPart = ''
  for (const part of parts) {
    const lower = part.toLowerCase()
    const bit = MODIFIER_ALIASES[lower]
    if (bit !== undefined) {
      if (modifiers & bit) return { ok: false, reason: `修饰键 ${part} 重复` }
      modifiers |= bit
      continue
    }
    if (keyPart !== '') return { ok: false, reason: `只能有一个主键，收到 ${keyPart} 和 ${part}` }
    keyPart = part
  }
  if (modifiers === 0) return { ok: false, reason: '至少需要一个修饰键（Ctrl/Alt/Shift/Win）' }
  if (keyPart === '') return { ok: false, reason: '缺少主键' }

  const lowerKey = keyPart.toLowerCase()
  const isLetterOrDigit = /^[a-z0-9]$/.test(lowerKey)
  if (isLetterOrDigit && (modifiers & (MOD_CONTROL | MOD_ALT | MOD_WIN)) === 0) {
    return { ok: false, reason: '单字母/数字主键必须搭配 Ctrl/Alt/Win（Shift+字母会吞掉全局输入）' }
  }

  const vk = virtualKeyOf(keyPart)
  if (vk === undefined) return { ok: false, reason: `不支持的按键：${keyPart}` }
  const keyName = nativeKeyNameOf(keyPart)
  if (keyName === undefined) return { ok: false, reason: `不支持的按键：${keyPart}` }
  return {
    ok: true,
    modifiers: modifiers | MOD_NOREPEAT,
    vk,
    // key 保留旧字段（大写展示用），keyName 是 uiohook 的键名（native 路径用）。
    key: keyPart.toUpperCase(),
    keyName,
    label: parts.join('+'),
  }
}

/**
 * 单个主键 → Windows 虚拟键码。
 * @param {string} key - 大小写不敏感的键名。
 * @returns {number|undefined} 虚拟键码；不支持时 undefined。
 */
function virtualKeyOf(key) {
  const lower = key.toLowerCase()
  if (Object.prototype.hasOwnProperty.call(VK_BY_KEY, lower)) return VK_BY_KEY[lower]
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(lower)) return lower.charCodeAt(0)
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
    return 0x70 + (Number(lower.slice(1)) - 1)
  }
  return undefined
}

/**
 * 单个主键 → uiohook-napi `UiohookKey` 的属性名。
 * 支持范围与 virtualKeyOf 一致（字母/数字/F1-F24/常用命名键）。
 * @param {string} key - 大小写不敏感的键名。
 * @returns {string|undefined} 键名；不支持时 undefined。
 */
function nativeKeyNameOf(key) {
  const lower = key.toLowerCase()
  if (Object.prototype.hasOwnProperty.call(NATIVE_KEY_NAMES, lower)) return NATIVE_KEY_NAMES[lower]
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase()
  if (/^[0-9]$/.test(lower)) return lower
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return 'F' + lower.slice(1)
  return undefined
}

/**
 * 计算 helper 回调地址。
 *
 * 优先用宿主 webServer 的真实 origin（可能是 https / 非 127.0.0.1 绑定）；
 * origin 非法（不是 http(s) 或解析失败）时退回 `http://127.0.0.1:<port>`。
 * 两者都不可用 → 返回失败原因，调用方不拉起 helper（绝不用错地址静默启动）。
 *
 * @param {{origin?:string, port?:number, host?:string, route?:string}} input
 * @returns {{ok:true, value:string} | {ok:false, reason:string}} 完整 URL 或失败原因。
 */
function resolveHelperUrl({ origin, port, host = '127.0.0.1', route = HELPER_ROUTE } = {}) {
  const normalizedRoute = typeof route === 'string' && route.startsWith('/') ? route : '/' + String(route ?? '')
  if (typeof origin === 'string' && origin.trim()) {
    try {
      const parsed = new URL(origin.trim())
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return { ok: true, value: parsed.origin + normalizedRoute }
      }
    } catch {
      /* 非法 origin → 走端口兜底 */
    }
  }
  const portNumber = Number(port)
  if (!Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65535) {
    return { ok: false, reason: `宿主地址未知（origin 非法、port=${port}）` }
  }
  return { ok: true, value: `http://${host}:${portNumber}${normalizedRoute}` }
}

/**
 * 生成 PowerShell helper 脚本（Windows 路径）。
 *
 * 脚本用 Add-Type 内嵌一段 C#：注册热键后阻塞在 GetMessage，
 * 收到 WM_HOTKEY 就 POST 一次宿主路由；进程被杀即退出（finally 反注册）。
 * 不写文件日志、不读环境变量，token/地址/键位全部由参数注入。
 * 脚本正文**不含 BOM**（方便测试逐字断言）；落盘时由 sync 加 UTF-8 BOM。
 *
 * @param {{port?:number, token:string, accelerator:string, route?:string, host?:string, origin?:string}} options
 *   token 路由鉴权 token；accelerator 加速键；origin 宿主 origin（优先）；
 *   port/host/route 供 origin 不可用时兜底（测试可覆盖）。
 * @returns {string} PowerShell 脚本全文。
 * @throws {Error} 参数非法（地址/加速键/token）时抛错 —— 调用方据此不拉起 helper。
 */
export function buildHelperScript({ port, token, accelerator, route = HELPER_ROUTE, host = '127.0.0.1', origin } = {}) {
  const parsed = parseAccelerator(accelerator)
  if (!parsed.ok) throw new Error(`helper 加速键非法：${parsed.reason}`)
  if (typeof token !== 'string' || token.length < 16) throw new Error('helper token 非法')
  const resolved = resolveHelperUrl({ origin, port, host, route })
  if (!resolved.ok) throw new Error(`helper 地址非法：${resolved.reason}`)
  // 单引号字符串里只需转义单引号；token 是十六进制、url 由固定片段拼成，不会含引号。
  const safeUrl = resolved.value.replace(/'/g, "''")
  const safeToken = token.replace(/'/g, "''")

  return `# 由 dsh-voice-typing 生成的系统热键 helper；进程退出即失效。
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;

public static class DshVoiceHotkey {
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x;
        public int y;
    }

    private const uint WM_HOTKEY = 0x0312;

    public static int Run(uint modifiers, uint vk, string url, string token) {
        if (!RegisterHotKey(IntPtr.Zero, 1, modifiers, vk)) {
            Console.Error.WriteLine("REGISTER_FAILED");
            Console.Error.Flush();
            return 2;
        }
        Console.WriteLine("READY");
        Console.Out.Flush();
        try {
            MSG msg;
            while (true) {
                int r = GetMessage(out msg, IntPtr.Zero, 0, 0);
                if (r <= 0) break;
                if (msg.message != WM_HOTKEY) continue;
                Post(url, token);
            }
        } finally {
            UnregisterHotKey(IntPtr.Zero, 1);
        }
        return 0;
    }

    private static void Post(string url, string token) {
        try {
            var request = (HttpWebRequest)WebRequest.Create(url);
            // 企业代理/PAC 可能把回环请求也吞掉：显式禁用代理，避免热键静默失效。
            request.Proxy = null;
            request.ServicePoint.Expect100Continue = false;
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Headers["x-dsh-voice-token"] = token;
            request.Timeout = 5000;
            byte[] body = Encoding.UTF8.GetBytes("{\\"action\\":\\"toggle\\"}");
            request.ContentLength = body.Length;
            using (var stream = request.GetRequestStream()) { stream.Write(body, 0, body.Length); }
            using (var response = (HttpWebResponse)request.GetResponse()) { }
        } catch {
            // 宿主可能已退出：静默失败，热键继续等下一次。
        }
    }
}
'@
$code = [DshVoiceHotkey]::Run(${parsed.modifiers}, ${parsed.vk}, '${safeUrl}', '${safeToken}')
exit $code
`
}

/** 默认 token：每次进程启动随机生成，不落盘（native 路径用不上，保留给 Windows 路由）。 */
function defaultToken() {
  return randomBytes(24).toString('hex')
}

/**
 * 默认 native 热键模块加载器（可注入替身用于测试）。
 * 动态 import：模块是 optionalDependency，缺失时这里 reject，由调用方降级。
 * @returns {Promise<object>} uiohook-napi 模块。
 */
function defaultLoadNative() {
  return import('uiohook-napi')
}

/**
 * 热键 helper 生命周期管理器（每个宿主实例一个）。
 *
 * 宿主在配置加载/保存后调用 `sync(config, port, origin)`：
 *   - `globalHotkeyHelper !== true` 或 `globalVoice !== true` → 停掉并记录原因；
 *   - 加速键非法 → 停掉并记录原因；
 *   - Windows → 写临时脚本、拉起 `powershell.exe`（同地址+同键不重启）；
 *   - 其它平台 → 异步加载 uiohook-napi 并在本进程注册 keydown。
 *
 * `token` 由本对象生成并暴露给宿主：Windows 路径下宿主注册 `/hotkey`
 * 路由时用它鉴权，与脚本里写死的 token 必须一致。native 路径不使用它。
 *
 * @param {object} [options] - 注入项（测试用）。
 * @param {Function} [options.spawnImpl] - child_process.spawn 替身（Windows 路径）。
 * @param {Function} [options.loadNative] - native 模块加载器替身（非 Windows 路径）。
 * @param {Function} [options.onTrigger] - native 命中时的回调，参数 'toggle'。
 * @param {string} [options.platform] - 平台标识。
 * @param {Function} [options.log] - 失败日志（宿主传 logger，默认丢弃）。
 * @param {Function} [options.createToken] - token 生成器。
 * @param {string} [options.tmpDir] - 临时目录（默认 os.tmpdir()）。
 * @returns {{token:string, sync:Function, state:Function, dispose:Function}}
 *   token；sync(config, port, origin)；state() 当前状态（不含 token）；dispose() 清理。
 */
export function createHotkeyHelper(options = {}) {
  const {
    spawnImpl = nodeSpawn,
    platform = process.platform,
    log = () => {},
    createToken = defaultToken,
    tmpDir = os.tmpdir(),
    onTrigger = () => {},
    loadNative = defaultLoadNative,
  } = options

  const token = createToken()
  /** 最近一次 sync 的结果（诊断用；绝不谎报 enabled）。 */
  let current = { enabled: false, status: 'idle', reason: '尚未启动' }

  // ---- Windows（PowerShell 子进程）状态 ----
  let child = null
  let scriptPath = ''
  let runningKey = ''

  // ---- native（macOS/Linux，进程内 uiohook）状态 ----
  /** 已注册的 native 适配器：{api, handler, keyName, modifiers, label}。 */
  let native = null
  /** 正在加载的配置（避免同一配置重复触发加载）。 */
  let nativeLoading = null
  /** 最新一次 sync 是否希望 native 处于启用态（异步加载完成后要复查）。 */
  let nativeWant = false
  /** 加载序号：dispose/改配置会让旧加载结果作废。 */
  let nativeLoadSeq = 0
  let disposed = false

  /** 设置统一状态（enabled 只在真正生效时为 true）。 */
  function setState(status, enabled, reason) {
    current = { enabled, status, reason }
  }

  /** Windows：杀子进程 + 删临时脚本。 */
  function stopPowershell() {
    if (child) {
      const dying = child
      child = null
      try { dying.kill() } catch { /* 进程可能已经退出 */ }
    }
    if (scriptPath) {
      try { fs.rmSync(scriptPath, { force: true }) } catch { /* 忽略 */ }
      scriptPath = ''
    }
    runningKey = ''
  }

  /** native：注销 keydown 监听并停止 hook。 */
  function stopNative() {
    nativeWant = false
    nativeLoadSeq += 1
    nativeLoading = null
    if (native) {
      const { api, handler } = native
      native = null
      try { api.off?.('keydown', handler) } catch { /* 忽略 */ }
      try { api.stop?.() } catch { /* 忽略 */ }
    }
  }

  /** 停掉当前平台对应的后端（另一个后端理论上不存在，但一起清更安全）。 */
  function stop(reason) {
    stopPowershell()
    stopNative()
    if (reason !== undefined) setState('disabled', false, reason)
  }

  /**
   * 启动/注册失败：停掉后端后如实标 `failed`。
   * 与用户主动关闭（disabled）区分开，诊断里一眼能看出「配置开了但没起来」。
   * @param {string} reason - 人类可读失败原因。
   */
  function fail(reason) {
    stop()
    setState('failed', false, reason)
  }

  // ---------------------------------------------------------------------
  // Windows 路径：PowerShell + RegisterHotKey + POST /hotkey
  // ---------------------------------------------------------------------

  /**
   * 按配置同步 Windows helper。
   * @param {object} parsed - parseAccelerator 的成功结果。
   * @param {string} accelerator - 原始加速键（写进脚本）。
   * @param {number} port - 宿主 webServer 端口（origin 不可用时兜底）。
   * @param {string} origin - 宿主 webServer origin（优先）。
   * @returns {{enabled:boolean, status:string, reason:string}} 当前状态。
   */
  function syncPowershell(parsed, accelerator, port, origin) {
    const url = resolveHelperUrl({ origin, port })
    if (!url.ok) {
      stop(url.reason)
      return current
    }
    const key = `${url.value}|${parsed.modifiers}|${parsed.vk}`
    if (child && runningKey === key) return current

    stopPowershell()
    let script = ''
    try {
      script = buildHelperScript({ port, token, accelerator, origin })
    } catch (error) {
      stop(error instanceof Error ? error.message : String(error))
      return current
    }

    try {
      scriptPath = path.join(tmpDir, `dsh-voice-typing-hotkey-${process.pid}-${Date.now()}.ps1`)
      // PowerShell 5.1 会按系统 ANSI 编码读「无 BOM」脚本，脚本里的中文注释
      // 会变乱码；写 UTF-8 BOM 让 5.1 也按 UTF-8 解析（PowerShell 7 同样兼容）。
      fs.writeFileSync(scriptPath, '\uFEFF' + script, { encoding: 'utf8' })
    } catch (error) {
      scriptPath = ''
      stop(`写临时脚本失败：${error instanceof Error ? error.message : String(error)}`)
      return current
    }

    let next
    try {
      next = spawnImpl('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        scriptPath,
      ], {
        windowsHide: true,
        // stdout 用来等脚本输出 READY（RegisterHotKey 真的注册成功），
        // stderr 用来捕获 REGISTER_FAILED。stdin 不需要。
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      stop(`拉起 helper 失败：${error instanceof Error ? error.message : String(error)}`)
      return current
    }

    child = next
    runningKey = key
    // 先报 starting：spawn 返回只代表进程起来了，RegisterHotKey 可能失败
    //（快捷键被别的程序占用）。收到 READY 之前绝不能谎报 enabled。
    setState('starting', false, `等待热键注册确认（${parsed.label}）`)
    /** 本次 spawn 是否已确认 RegisterHotKey 成功。 */
    let ready = false
    // 子进程退出（用户关掉 / 注册失败 / 被杀）时清掉状态，下次 sync 会重启。
    if (next && typeof next.once === 'function') {
      /** stdout：脚本在 RegisterHotKey 成功后打印 READY。 */
      if (next.stdout && typeof next.stdout.on === 'function') {
        let stdoutBuffer = ''
        next.stdout.on('data', (chunk) => {
          if (child !== next || ready) return
          stdoutBuffer += String(chunk)
          if (stdoutBuffer.length > 4096) stdoutBuffer = stdoutBuffer.slice(-2048)
          if (!stdoutBuffer.includes('READY')) return
          ready = true
          setState('enabled', true, `已启动（${parsed.label}, pid=${next.pid ?? '?'}）`)
        })
      }
      /** stderr：C# 注册失败时打印 REGISTER_FAILED 并退出。 */
      if (next.stderr && typeof next.stderr.on === 'function') {
        next.stderr.on('data', (chunk) => {
          if (child !== next || ready) return
          if (!String(chunk).includes('REGISTER_FAILED')) return
          // 注册失败：热键被占用/无权限。停掉进程、删脚本，reason 说清楚。
          fail('热键注册失败（可能被其他程序占用），系统级热键未生效')
          log('[dsh-voice-typing] 全局热键注册失败（RegisterHotKey 返回 false，快捷键可能被占用）')
        })
      }
      /**
       * spawn 失败（powershell.exe 不存在、被安全策略拦截、EACCES…）不是抛错，
       * 而是异步发一个 `error` 事件；EventEmitter 没有 error 监听会**抛未捕获异常**，
       * 直接打死整个 DSH 宿主。以前只挂了 exit，所以这里必须补 error。
       */
      next.once('error', (error) => {
        if (child !== next) return
        const message = error instanceof Error ? error.message : String(error)
        fail(`helper 启动失败：${message}`)
        log(`[dsh-voice-typing] 全局热键 helper 启动失败：${message}`)
      })
      next.once('exit', (code) => {
        if (child !== next) return
        child = null
        runningKey = ''
        // 正常退出也要删掉含 token 的临时脚本（否则 %TEMP% 会残留，
        // 直到下一次 sync/dispose 才清；崩溃重启后可能一直留着）。
        if (scriptPath) {
          try { fs.rmSync(scriptPath, { force: true }) } catch { /* 忽略 */ }
          scriptPath = ''
        }
        if (!ready) {
          setState('failed', false, `helper 启动失败（未确认注册就退出，code=${code ?? '?'}）`)
        } else {
          setState('exited', false, `helper 已退出（code=${code ?? '?'}）`)
        }
        ready = false
        log(`[dsh-voice-typing] 全局热键 helper 退出：code=${code ?? '?'}`)
      })
    }
    return current
  }

  // ---------------------------------------------------------------------
  // native 路径：uiohook-napi（进程内，命中后直接回调 onTrigger）
  // ---------------------------------------------------------------------

  /**
   * 按配置同步 native helper（异步加载；同步/加载中状态如实写进 current）。
   * @param {object} parsed - parseAccelerator 的成功结果。
   * @returns {{enabled:boolean, status:string, reason:string}} 当前状态（加载中时 enabled=false）。
   */
  function syncNative(parsed) {
    const wanted = { keyName: parsed.keyName, modifiers: parsed.modifiers, label: parsed.label }
    // 已经用同一键位在跑 → 不动（避免每次改配置都重启 hook）。
    if (native && native.keyName === wanted.keyName && native.modifiers === wanted.modifiers) return current
    // 同一键位正在加载 → 不动（否则每次 /config 都会叠加加载）。
    if (nativeLoading && nativeLoading.keyName === wanted.keyName && nativeLoading.modifiers === wanted.modifiers) {
      return current
    }

    stopNative()
    nativeWant = true
    nativeLoading = wanted
    const seq = nativeLoadSeq
    setState('loading', false, `正在加载原生热键模块（${wanted.label}）`)

    Promise.resolve()
      .then(() => loadNative())
      .then((module) => {
        if (disposed || seq !== nativeLoadSeq || !nativeWant) return
        const api = module?.uIOhook ?? module?.default?.uIOhook
        const keyMap = module?.UiohookKey ?? module?.default?.UiohookKey
        if (!api || typeof api.on !== 'function' || typeof api.start !== 'function') {
          throw new Error('uiohook-napi 接口不完整（缺 uIOhook.on/start）')
        }
        const keycode = keyMap?.[wanted.keyName]
        if (typeof keycode !== 'number') throw new Error(`原生热键不支持按键：${wanted.keyName}`)
        const required = wanted.modifiers & MOD_REAL_MASK
        // 只认「恰好按下这些修饰键」的 keydown：多按一个 Shift 就不算命中，
        // 与 Windows RegisterHotKey 的语义一致，避免误触发。
        const handler = (event) => {
          if (!event || event.keycode !== keycode) return
          if (Boolean(event.altKey) !== Boolean(required & MOD_ALT)) return
          if (Boolean(event.ctrlKey) !== Boolean(required & MOD_CONTROL)) return
          if (Boolean(event.shiftKey) !== Boolean(required & MOD_SHIFT)) return
          if (Boolean(event.metaKey) !== Boolean(required & MOD_WIN)) return
          try {
            onTrigger('toggle')
          } catch (error) {
            log(`[dsh-voice-typing] 全局热键回调失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        try {
          api.on('keydown', handler)
          api.start()
        } catch (error) {
          try { api.off?.('keydown', handler) } catch { /* 忽略 */ }
          throw error
        }
        native = { api, handler, keyName: wanted.keyName, modifiers: wanted.modifiers, label: wanted.label }
        nativeLoading = null
        setState('enabled', true, `已启动（native ${wanted.label}）`)
      })
      .catch((error) => {
        if (disposed || seq !== nativeLoadSeq) return
        nativeLoading = null
        nativeWant = false
        const message = error instanceof Error ? error.message : String(error)
        setState('failed', false, `原生热键不可用：${message}`)
        log(`[dsh-voice-typing] 原生全局热键不可用：${message}`)
      })
    return current
  }

  /**
   * 按配置同步 helper（幂等；同配置重复调用不会重启后端）。
   *
   * @param {object} config - 生效配置（读 globalHotkeyHelper / globalVoice / globalShortcut）。
   * @param {number} [port] - 宿主 webServer 端口（Windows 路径兜底地址）。
   * @param {string} [origin] - 宿主 webServer origin（Windows 路径优先地址）。
   * @returns {{enabled:boolean, status:string, reason:string}} 当前状态。
   */
  function sync(config, port, origin) {
    if (!config || config.globalHotkeyHelper !== true) {
      stop('已关闭（globalHotkeyHelper=false）')
      return current
    }
    // 只有浮层真的开着（globalVoice=true），热键按下去才有人消费 SSE 事件；
    // 否则等于注册一个「按了没反应」的系统热键 + 常驻进程，必须一并停掉。
    if (config.globalVoice !== true) {
      stop('全局语音浮层未开启（globalVoice=false），系统热键不会生效')
      return current
    }
    const accelerator = String(config.globalShortcut ?? '')
    const parsed = parseAccelerator(accelerator)
    if (!parsed.ok) {
      stop(`快捷键非法：${parsed.reason}`)
      return current
    }
    if (platform === 'win32') return syncPowershell(parsed, accelerator, port, origin)
    return syncNative(parsed)
  }

  /** 诊断快照（/diagnostics 用；不含 token）。 */
  function state() {
    return {
      ...current,
      platform,
      tokenReady: typeof token === 'string' && token.length >= 16,
    }
  }

  /** 卸载：停子进程 / 注销 native hook，删临时脚本。 */
  function dispose() {
    disposed = true
    stopPowershell()
    stopNative()
    setState('disabled', false, '已卸载')
  }

  return { token, sync, state, dispose }
}
