/**
 * 全局语音 + AI 界面操控：宿主侧接线测试。
 *
 * 覆盖（与实现契约 §7 对应）：
 *   - 新路由注册：/voice-prompt、/ui-action-result、/hotkey（后者显式标注 helper-only）；
 *   - 配置 schema 新增 6 键（accepts / rejects / sanitize 回退）+ v3 wakeWord（第 35 键）；
 *   - POST /config 的失败回执（2b）：非法值 / 非 JSON / 非对象 / 超 1 MB / 写盘失败
 *     一律回 `src/shared/config-error-codes.js` 里的原因码 + `detail`，句子由客户端字典出；
 *   - lib/ui-action-protocol.js 纯函数（动作枚举、参数校验、确认策略、回执校验）；
 *   - /voice-prompt：成功注入、参数 400、两条注入路径都失败 → 502、统计进 /diagnostics；
 *   - /ui-action-result：未知 requestId → 404、非法字段 → 400、回执 resolve 工具等待；
 *   - voice_ui 工具：总开关关闭、参数非法、list_sessions 直答、成功、确认拒绝、超时；
 *   - SSE ui-action 信封（v/seq/ts/sessionId）；
 *   - /diagnostics 新增 voicePrompt / uiActions / hotkeyHelper。
 *
 * 全部用假 Cordis 上下文 + 假服务：不联网、不碰真实 DSH、不写 ~/.dsh
 * （配置路径由临时 DSH_HOME 决定）。
 *
 * 运行：node test/voice-ui-host.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hostModule } from './helpers/host-source.mjs'
import { loadHostRoutes } from './helpers/host-routes.mjs'
import { isHotkeyReason } from '../src/shared/hotkey-reasons.js'
import { isConfigErrorCode } from '../src/shared/config-error-codes.js'

// 必须在 import lib/index.js 之前指好 DSH_HOME（配置路径由它决定）。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-ui-host-'))
process.env.DSH_HOME = tmpHome
// 宿主测试会构造 globalVoice/globalHotkeyHelper 都打开的配置。
// 在 Linux CI（无 DISPLAY）上，原生 uiohook 的 XRecord 会 abort 整个进程
// （0.0.5 的 GitHub Actions 就因此 exit 134）；即使有 DISPLAY，测试也不该
// 真的抓全局键盘。用环境变量让默认 native 加载器直接失败降级，
// 注入 fake loader 的 native 单测不受影响。
process.env.DSH_VOICE_TYPING_DISABLE_NATIVE_HOOK = '1'

const {
  apply,
  resolveRequestLanguage,
  setVoiceUiTimeoutForTest,
  setCreateUserMessageLoaderForTest,
} = await import('../lib/index.js')
const {
  CONFIG_SPEC_KEYS,
  VOICE_PROMPT_MODES,
  CONFIG_DEFAULTS,
  sanitizeConfig,
  validateConfigPatch,
} = await hostModule('config-schema')
const {
  UI_ACTION_NAMES,
  UI_CONFIRM_ACTIONS,
  UI_ACTION_LIMITS,
  UI_ACTION_PARAMS,
  UI_ACTION_REQUIRED,
  getUiActionSpec,
  actionNeedsConfirm,
  validateUiAction,
  describeUiAction,
  buildUiActionPayload,
  isUiActionExpired,
  validateUiActionResult,
} = await hostModule('ui-action-protocol')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

// ---------------------------------------------------------------------------
// 假宿主
// ---------------------------------------------------------------------------

/** 假 HTTP 请求（支持 async iterator 读 body）。 */
function makeReq(method, url, body, headers = {}) {
  const chunks = body == null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')]
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    on() { return req },
  }
  return req
}

/** 假 HTTP 响应（收集状态 / 头 / 字节）。 */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    chunks: [],
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
      this.headersSent = true
    },
    write(chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
      return true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
      }
      this.writableEnded = true
    },
  }
}

/**
 * 拉起一份宿主（假 Cordis 上下文）。
 * @param {object} [options] - rowConfig / agent:false / promptFailure / sessionList /
 *   sessionController:false（模拟精简部署没有 sessionController）。
 * @returns {object} 路由、工具定义、注入调用记录等。
 */
function makeHost(options = {}) {
  const routes = new Map()
  const toolDefs = []
  const systemPromptSections = []
  const promptCalls = []
  const promptFailure = options.promptFailure ?? null
  const sessionList = options.sessionList ?? {
    items: [{ sessionId: 's1', title: '会话一', lastPromptAt: 111 }],
  }
  const agent = options.agent === false
    ? null
    : {
        session: { id: 's1' },
        followupCalls: [],
        steerCalls: [],
        followup(message) { this.followupCalls.push(message); return Promise.resolve() },
        steer(message) { this.steerCalls.push(message); return Promise.resolve() },
      }
  const sessionController = {
    async prompt(request, signal) {
      promptCalls.push({ request, signal })
      if (promptFailure) throw promptFailure
      return { accepted: true }
    },
    async list(_request, _signal) { return sessionList },
  }
  // 卸载清理测试用：按真实 Cordis 语义收集 effect/inject 的清理函数。
  const disposers = []
  const scope = {
    effect(fn) {
      const result = fn()
      const dispose = typeof result === 'function' ? result : () => {}
      disposers.push(dispose)
      return dispose
    },
    webServer: {
      port: 51234,
      register(definition) { routes.set(definition.path, definition); return () => {} },
    },
    sessions: { get() { return undefined }, list() { return [] } },
    // sessionController:false = 精简部署（没有该服务）→ 只能走 agents 兜底。
    sessionController: options.sessionController === false ? undefined : sessionController,
    agents: { get(id) { return agent && id === 's1' ? agent : undefined } },
    tools: { register(definition) { toolDefs.push(definition); return () => {} } },
    systemPrompt: {
      section(definition) {
        systemPromptSections.push(definition)
        // 真实 Cordis 的 section() 返回 disposer；返回一个真的会移除的版本，
        // 这样「uiControl 动态注销」才能被测出来。
        return () => {
          const index = systemPromptSections.indexOf(definition)
          if (index >= 0) systemPromptSections.splice(index, 1)
        }
      },
    },
  }
  const ctx = {
    logger: { warn() {} },
    on() {},
    // 假 Cordis：服务“已就绪”，立即回调。inject 回调返回的清理函数按真实
    // Cordis 语义登记下来 —— 卸载清理测试要手动触发它。
    inject(_deps, fn) {
      const dispose = fn(scope)
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  apply(ctx, options.rowConfig ?? {})
  const host = { routes, toolDefs, systemPromptSections, promptCalls, agent, sessionController, disposers }
  /** 模拟插件卸载/热重载：依次执行所有 effect/inject 清理函数。 */
  host.disposeAll = () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 忽略 */ }
    }
  }
  return host
}

/**
 * 调路由 → { status, headers, body }。
 *
 * headers 省略时默认按真实客户端/helper 的行为带上 `content-type: application/json`
 * （这三个路由要求 JSON，见 CSRF 加固）。415 用例显式传 headers 覆盖：
 * `{}` = 不带 content-type，`{ 'content-type': 'text/plain' }` = 跨站简单请求。
 */
async function callRoute(host, routePath, method, body, headers) {
  const definition = host.routes.get(routePath)
  if (!definition) throw new Error('route not found: ' + routePath)
  const requestHeaders = headers === undefined
    ? (body == null ? {} : { 'content-type': 'application/json' })
    : headers
  const res = makeRes()
  await definition.handler(makeReq(method, routePath, body, requestHeaders), res)
  const raw = Buffer.concat(res.chunks)
  let parsed = null
  try { parsed = JSON.parse(raw.toString('utf8')) } catch { /* SSE / 二进制 */ }
  return { status: res.statusCode, headers: res.headers, raw, body: parsed }
}

/** 接一条假 SSE 连接（真实 handler，假 req/res）。 */
function connectSse(host) {
  const definition = host.routes.get('/dsh-voice-typing/stream')
  const res = makeRes()
  let onClose = null
  const req = { on(event, cb) { if (event === 'close') onClose = cb; return req } }
  definition.handler(req, res)
  return {
    raw: () => Buffer.concat(res.chunks).toString('utf8'),
    close() { try { onClose?.() } catch { /* 忽略 */ } },
  }
}

/** 解析 SSE 文本 → [{event, payload}]。 */
function parseSse(text) {
  const out = []
  for (const block of text.split('\n\n')) {
    let event = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length)
      else if (line.startsWith('data: ')) data = line.slice('data: '.length)
    }
    if (!event) continue
    let payload = null
    try { payload = JSON.parse(data) } catch { /* 忽略 */ }
    out.push({ event, payload })
  }
  return out
}

/** 等一个条件成立（最多 timeoutMs）；返回条件值或 null。 */
async function waitFor(predicate, timeoutMs = 800) {
  const start = Date.now()
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() - start > timeoutMs) return null
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const execOf = (sessionId = 's1') => ({ agent: { session: { id: sessionId } } })

// ---------------------------------------------------------------------------
console.log('== 1. 新路由注册与用途标注 ==')
{
  const host = makeHost()
  const expected = [
    '/dsh-voice-typing/voice-prompt',
    '/dsh-voice-typing/ui-action-result',
    '/dsh-voice-typing/hotkey',
  ]
  for (const routePath of expected) {
    const definition = host.routes.get(routePath)
    check(`${routePath} 已注册`, !!definition)
    check(`${routePath} 是 exact 路由`, definition?.kind === 'exact', definition?.kind)
    check(`${routePath} 有 handler`, typeof definition?.handler === 'function')
  }
  // 批次 6j 之前这里有两条源码判据：读 `path: '/dsh-voice-typing/hotkey'` 附近 1200 字符，
  // 判注释里有没有「保留」「唯一调用方」这几个字。删掉的理由（§8.43）：
  // 它们判的是**注释里写了什么字**，产品行为一点不跟着变；宿主注释还写着
  // 「客户端仍用 /latest-message」，而 6j 把客户端集合收成路由表之后，表里根本没有它 ——
  // 注释会和事实分叉，判据却照样绿。
  // 「保留的路由必须写清用途」现在是数据：那份清单在 `test/route-contract.test.mjs` 的
  // HOST_ONLY，值就是用途说明，说明少一条/多一条都会红（C 段与 D 段）。
  // /hotkey 归 helper 这一半也不是靠注释：route-contract 的 E 段真跑
  // `buildHelperScript()`，把它生成出来的 URL 的 pathname 对到宿主注册表上。
  // 原来这里还有两条源码正则：`/broadcast\('global-hotkey'/`、`/broadcast\('ui-action'/`。
  // 它们守的是「按了热键 / 派了界面动作之后，事件到底出不出得来」，
  // 而这件事在本文件里已经是真跑：
  //   · global-hotkey —— 见上面的 §6b（接一条 SSE，POST 一次 /hotkey，数广播出来的帧）；
  //   · ui-action     —— 本文件的 voice_ui 工具那几节每次都真开 SSE 再读事件
  //     （§7/§8 的「广播出 ui-action」「确认后才有 ui-action-result 回执」等，
  //      判的是 res 里的 event 名与载荷字段，不是源码里有没有那行 broadcast）。
  // 两条都已由真跑覆盖，正则删除（批次 6h，docs §8.41）。
}

// ---------------------------------------------------------------------------
console.log('\n== 2. 配置 schema：新增 6 键 ==')
{
  const newKeys = ['globalVoice', 'globalShortcut', 'voicePromptMode', 'uiControl', 'uiConfirm', 'globalHotkeyHelper']
  check('schema 覆盖 35 个配置键', CONFIG_SPEC_KEYS.length === 35, String(CONFIG_SPEC_KEYS.length))
  check('新 6 键全部在 schema 里', newKeys.every((key) => CONFIG_SPEC_KEYS.includes(key)),
    newKeys.filter((key) => !CONFIG_SPEC_KEYS.includes(key)).join(','))
  // v3：第 35 键 wakeWord（全局语音待机唤醒词）。
  check('v3 wakeWord 在 schema 里', CONFIG_SPEC_KEYS.includes('wakeWord'), CONFIG_SPEC_KEYS.join(','))
  // 默认值住在 src/shared/config-spec.js，宿主的 DEFAULTS 就是那份对象
  // （config-contract 里有「宿主 DEFAULTS === CONFIG_DEFAULTS」的守卫）。
  check('宿主 DEFAULTS.wakeWord 默认「小鱼」', CONFIG_DEFAULTS.wakeWord === '小鱼',
    JSON.stringify(CONFIG_DEFAULTS.wakeWord))
  check('wakeWord trim 归一', sanitizeConfig({ wakeWord: '  小助手  ' }, {}).config.wakeWord === '小助手',
    JSON.stringify(sanitizeConfig({ wakeWord: '  小助手  ' }, {}).config.wakeWord))
  check('wakeWord 空串合法（= 关闭唤醒词）',
    validateConfigPatch({ wakeWord: '' }).ok === true && validateConfigPatch({ wakeWord: '' }).value.wakeWord === '')
  check('wakeWord 超长（33 字）拒绝',
    validateConfigPatch({ wakeWord: 'x'.repeat(33) }).ok === false)
  check('VOICE_PROMPT_MODES === [queue, steer]', JSON.stringify(VOICE_PROMPT_MODES) === JSON.stringify(['queue', 'steer']))

  const good = validateConfigPatch({
    globalVoice: true,
    globalShortcut: '  Ctrl+Alt+V  ',
    voicePromptMode: ' STEER ',
    uiControl: true,
    uiConfirm: false,
    globalHotkeyHelper: true,
  })
  check('合法 patch 通过', good.ok === true, JSON.stringify(good))
  check('globalShortcut trim', good.value?.globalShortcut === 'Ctrl+Alt+V', JSON.stringify(good.value))
  check('voicePromptMode 枚举归一（STEER → steer）', good.value?.voicePromptMode === 'steer')
  check('布尔的 true/false 原样保留',
    good.value?.globalVoice === true && good.value?.uiControl === true
      && good.value?.uiConfirm === false && good.value?.globalHotkeyHelper === true)

  const rejects = [
    ['globalVoice 传字符串', { globalVoice: 'yes' }, 'globalVoice'],
    ['globalShortcut 超长', { globalShortcut: 'x'.repeat(65) }, 'globalShortcut'],
    ['voicePromptMode 非法枚举', { voicePromptMode: 'auto' }, 'voicePromptMode'],
    ['uiControl 传数字', { uiControl: 1 }, 'uiControl'],
    ['uiConfirm 传字符串', { uiConfirm: 'true' }, 'uiConfirm'],
    ['globalHotkeyHelper 传数组', { globalHotkeyHelper: [] }, 'globalHotkeyHelper'],
  ]
  for (const [name, patch, key] of rejects) {
    const result = validateConfigPatch(patch)
    check(`拒绝：${name}`, result.ok === false && result.errors.some((error) => error.key === key),
      JSON.stringify(result))
  }

  const base = {
    globalVoice: false,
    globalShortcut: 'Ctrl+Alt+V',
    voicePromptMode: 'queue',
    uiControl: false,
    uiConfirm: true,
    globalHotkeyHelper: false,
  }
  const sanitized = sanitizeConfig({
    globalVoice: 'yes',
    voicePromptMode: 'bogus',
    uiControl: 1,
    uiConfirm: 0,
    globalHotkeyHelper: null,
  }, base)
  check('sanitize：非法布尔回退默认',
    sanitized.config.globalVoice === false && sanitized.config.uiControl === false
      && sanitized.config.uiConfirm === true && sanitized.config.globalHotkeyHelper === false)
  check('sanitize：非法枚举回退默认', sanitized.config.voicePromptMode === 'queue')
  check('sanitize：非法项都记 warning',
    ['globalVoice', 'voicePromptMode', 'uiControl', 'uiConfirm', 'globalHotkeyHelper']
      .every((key) => sanitized.warnings.some((warning) => warning.key === key)))
  const missing = sanitizeConfig({}, base)
  check('sanitize：缺省时用调用方默认值', missing.config.voicePromptMode === 'queue' && missing.config.uiConfirm === true)
}

// ---------------------------------------------------------------------------
console.log('\n== 2b. POST /config 的失败回执：宿主只回原因码（批次 20）==')
{
  // 这一节判的是**路由层**那一半：`validateConfigPatch` 的码由 config-schema 判，
  // 但「读体失败 / 不是 JSON / 写盘失败」这三种是 catch 里的，只有真跑路由才看得到。
  // 界面那句由客户端字典出（`pure/config-error-text.js`），所以宿主这边唯一要保证的
  // 就是：`reason` 永远是词表内的码、永远是 ASCII、动态原文一律搬到 `detail`。
  const host = makeHost({ rowConfig: { uiControl: true } })
  const configJsonPath = path.join(tmpHome, 'voice-typing.json')
  const errorShapeOf = (body) => {
    const first = Array.isArray(body?.errors) ? body.errors[0] : null
    return {
      code: first?.reason,
      hasDetail: typeof first?.detail === 'string' && first.detail.length > 0,
      ascii: typeof first?.reason === 'string' && /^[\x00-\x7F]+$/.test(first.reason),
    }
  }
  const cases = [
    ['非法枚举值', () => callRoute(host, '/dsh-voice-typing/config', 'POST', JSON.stringify({ ttsEngine: 'bogus' })), 400, 'not-in-enum'],
    ['请求体不是 JSON', () => callRoute(host, '/dsh-voice-typing/config', 'POST', '{oops'), 400, 'body-not-json'],
    ['请求体是数组', () => callRoute(host, '/dsh-voice-typing/config', 'POST', '[]', { 'content-type': 'application/json' }), 400, 'patch-not-object'],
    ['请求体超过 1 MB', () => callRoute(host, '/dsh-voice-typing/config', 'POST', Buffer.alloc(1024 * 1024 + 64, 97)), 413, 'body-too-large'],
  ]
  for (const [name, send, expectedStatus, expectedCode] of cases) {
    const result = await send()
    const shape = errorShapeOf(result.body)
    check(`400/413：${name} → ${expectedStatus} + 码「${expectedCode}」`,
      result.status === expectedStatus && shape.code === expectedCode,
      JSON.stringify({ status: result.status, code: shape.code, body: result.body }))
    check(`回执：${name} 的码在词表内且是 ASCII，detail 非空`,
      isConfigErrorCode(shape.code) && shape.ascii && shape.hasDetail,
      JSON.stringify(shape))
  }
  // 写盘失败（配置那个位置被一个同名目录占住）：以前这里会把 `error.message`
  // 当成界面句子发出去，现在一律报 `save-failed`，原始消息只进 `detail`。
  fs.mkdirSync(configJsonPath, { recursive: true })
  try {
    const failed = await callRoute(host, '/dsh-voice-typing/config', 'POST', JSON.stringify({ uiControl: false }))
    const shape = errorShapeOf(failed.body)
    check('写盘失败 → 5xx + 码「save-failed」（不把 error.message 当界面文案）',
      failed.status >= 500 && shape.code === 'save-failed' && shape.hasDetail,
      JSON.stringify({ status: failed.status, body: failed.body }))
    check('写盘失败的回执里没有中文句子当 reason',
      shape.ascii === true, JSON.stringify(shape))
  } finally {
    fs.rmSync(configJsonPath, { recursive: true, force: true })
  }
  // 反面对照：合法 patch 仍然是 200 + 配置本身（这一批改的只是失败那一侧）。
  const ok = await callRoute(host, '/dsh-voice-typing/config', 'POST', JSON.stringify({ uiControl: true }))
  check('合法 patch 仍回 200 且不带 errors',
    ok.status === 200 && ok.body?.ok === true && !Array.isArray(ok.body?.errors),
    JSON.stringify({ status: ok.status, keys: Object.keys(ok.body ?? {}) }))
  // POST /config 会把配置写进临时 DSH_HOME；清掉，避免影响后续 makeHost。
  try { fs.unlinkSync(configJsonPath) } catch { /* 忽略 */ }
  host.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n== 3. ui-action-protocol 纯函数（宿主侧 = 客户端镜像的真源） ==')
{
  const v2Actions = ['set_sidebar', 'open_plugins', 'ui_snapshot', 'ui_click', 'ui_type', 'ui_key']
  check('动作枚举 14 个（v1 8 + v2 6）', UI_ACTION_NAMES.length === 14, JSON.stringify(UI_ACTION_NAMES))
  check('动作枚举包含 v1 全部动作',
    ['state', 'list_sessions', 'switch_session', 'new_session', 'run_command', 'send_prompt', 'stop_generation', 'toggle_sidebar']
      .every((name) => UI_ACTION_NAMES.includes(name)))
  check('动作枚举按契约顺序追加 v2 动作',
    JSON.stringify(UI_ACTION_NAMES.slice(8)) === JSON.stringify(v2Actions), JSON.stringify(UI_ACTION_NAMES.slice(8)))
  check('危险动作 8 个（v1 5 + a11y 3）', UI_CONFIRM_ACTIONS.length === 8, JSON.stringify(UI_CONFIRM_ACTIONS))
  check('危险动作含 ui_click / ui_type / ui_key',
    ['ui_click', 'ui_type', 'ui_key'].every((name) => UI_CONFIRM_ACTIONS.includes(name)))
  check('长度上限与契约一致（新增 ref/key:40）',
    UI_ACTION_LIMITS.text === 4000 && UI_ACTION_LIMITS.line === 400
      && UI_ACTION_LIMITS.sessionId === 200 && UI_ACTION_LIMITS.workspaceId === 200
      && UI_ACTION_LIMITS.ref === 40 && UI_ACTION_LIMITS.key === 40,
    JSON.stringify(UI_ACTION_LIMITS))
  check('UI_ACTION_PARAMS 覆盖 14 动作且冻结',
    Object.keys(UI_ACTION_PARAMS).length === 14 && Object.isFrozen(UI_ACTION_PARAMS)
      && JSON.stringify(UI_ACTION_PARAMS.ui_type) === JSON.stringify(['ref', 'text']),
    JSON.stringify(Object.keys(UI_ACTION_PARAMS)))
  check('UI_ACTION_REQUIRED 覆盖 14 动作且冻结',
    Object.keys(UI_ACTION_REQUIRED).length === 14 && Object.isFrozen(UI_ACTION_REQUIRED)
      && JSON.stringify(UI_ACTION_REQUIRED.set_sidebar) === JSON.stringify(['collapsed']))

  const switchSpec = getUiActionSpec(' SWITCH_SESSION ')
  check('getUiActionSpec 大小写/空白归一', switchSpec?.action === 'switch_session', JSON.stringify(switchSpec))
  check('switch_session 必填 sessionId', JSON.stringify(switchSpec?.required) === JSON.stringify(['sessionId']))
  check('未知动作 spec 为 null', getUiActionSpec('nope') === null)
  check('state 无参数', JSON.stringify(getUiActionSpec('state')?.params) === '[]')
  check('ui_click 必填 ref', JSON.stringify(getUiActionSpec('ui_click')?.required) === JSON.stringify(['ref']))
  check('ui_type 参数 ref/text 且都必填',
    JSON.stringify(getUiActionSpec('ui_type')?.params) === JSON.stringify(['ref', 'text'])
      && JSON.stringify(getUiActionSpec('ui_type')?.required) === JSON.stringify(['ref', 'text']))
  check('ui_key 必填 key', JSON.stringify(getUiActionSpec('ui_key')?.required) === JSON.stringify(['key']))
  check('set_sidebar 必填 collapsed 且不确认（语义动作）',
    JSON.stringify(getUiActionSpec('set_sidebar')?.required) === JSON.stringify(['collapsed'])
      && getUiActionSpec('set_sidebar')?.confirm === false)
  check('open_plugins / ui_snapshot 无参数',
    JSON.stringify(getUiActionSpec('open_plugins')?.params) === '[]'
      && JSON.stringify(getUiActionSpec('ui_snapshot')?.params) === '[]')

  check('确认策略：危险动作要确认（含 a11y 原语）',
    actionNeedsConfirm('switch_session') === true && actionNeedsConfirm('ui_click') === true)
  check('确认策略：只读/语义动作不要确认',
    ['state', 'toggle_sidebar', 'set_sidebar', 'open_plugins', 'ui_snapshot']
      .every((name) => actionNeedsConfirm(name) === false))
  check('确认策略：未知动作 false', actionNeedsConfirm('nope') === false)

  const cases = [
    ['state 合法', 'state', undefined, true],
    ['switch_session 缺 sessionId', 'switch_session', {}, false],
    ['switch_session 空白 sessionId', 'switch_session', { sessionId: '   ' }, false],
    ['switch_session 合法', 'switch_session', { sessionId: ' s1 ' }, true],
    ['run_command 缺 line', 'run_command', {}, false],
    ['run_command 多行非法', 'run_command', { line: 'a\nb' }, false],
    ['run_command 超长', 'run_command', { line: 'x'.repeat(401) }, false],
    ['send_prompt 合法', 'send_prompt', { text: '你好' }, true],
    ['send_prompt 超长', 'send_prompt', { text: 'x'.repeat(4001) }, false],
    ['未知动作', 'nope', {}, false],
    ['参数不是对象', 'state', 'x', true],
    // v2：boolean 参数与 a11y 原语
    ['set_sidebar collapsed=true 合法', 'set_sidebar', { collapsed: true }, true],
    ['set_sidebar collapsed=false 合法', 'set_sidebar', { collapsed: false }, true],
    ['set_sidebar 缺 collapsed', 'set_sidebar', {}, false],
    ['set_sidebar collapsed 传字符串', 'set_sidebar', { collapsed: 'true' }, false],
    ['set_sidebar collapsed 传数字', 'set_sidebar', { collapsed: 1 }, false],
    ['ui_click 缺 ref', 'ui_click', {}, false],
    ['ui_click ref 超长', 'ui_click', { ref: 'x'.repeat(41) }, false],
    ['ui_type 缺 text', 'ui_type', { ref: 'e1' }, false],
    ['ui_type 合法', 'ui_type', { ref: 'e1', text: 'hi' }, true],
    ['ui_key 缺 key', 'ui_key', {}, false],
    ['ui_key 超长', 'ui_key', { key: 'x'.repeat(41) }, false],
    ['ui_key 合法', 'ui_key', { key: 'Ctrl+K' }, true],
    ['ui_snapshot 合法', 'ui_snapshot', undefined, true],
    ['open_plugins 合法', 'open_plugins', undefined, true],
  ]
  for (const [name, action, params, expectOk] of cases) {
    const result = validateUiAction(action, params)
    check(`validateUiAction：${name}`, result.ok === expectOk, JSON.stringify(result))
  }
  {
    const trimmed = validateUiAction('send_prompt', { text: '  hi  ', sessionId: ' s9 ', extra: 'drop' })
    check('参数 trim 且丢弃未知字段',
      trimmed.ok && trimmed.params.text === 'hi' && trimmed.params.sessionId === 's9' && !('extra' in trimmed.params),
      JSON.stringify(trimmed))
    check('validateUiAction 返回规范化动作名', validateUiAction(' SEND_PROMPT ', { text: 'x' }).action === 'send_prompt')
    check('line 含 \\r 也非法', validateUiAction('run_command', { line: 'a\rb' }).error === 'invalid_param:line')
    check('缺参错误码带字段名', validateUiAction('run_command', {}).error === 'missing_param:line')
    check('超长错误码带字段名', validateUiAction('send_prompt', { text: 'x'.repeat(4001) }).error === 'param_too_long:text')
    // v2：boolean 参数要原样保留（false 不能被「空值丢弃」吃掉），未知字段仍丢弃。
    const booleanParams = validateUiAction('set_sidebar', { collapsed: false, extra: 'drop' })
    check('collapsed 布尔原样保留、未知字段丢弃',
      booleanParams.ok && booleanParams.params.collapsed === false && !('extra' in booleanParams.params),
      JSON.stringify(booleanParams))
    check('collapsed 类型错误细分到字段',
      validateUiAction('set_sidebar', { collapsed: 'true' }).error === 'invalid_param:collapsed')
    check('collapsed 缺失细分到字段',
      validateUiAction('set_sidebar', {}).error === 'missing_param:collapsed')
    const typedParams = validateUiAction('ui_type', { ref: ' e1 ', text: '  你好  ', sessionId: 'ignored' })
    check('ui_type 参数 trim 且只保留白名单字段',
      typedParams.ok && typedParams.params.ref === 'e1' && typedParams.params.text === '你好'
        && !('sessionId' in typedParams.params), JSON.stringify(typedParams))
    check('ref 超长细分到字段',
      validateUiAction('ui_click', { ref: 'x'.repeat(41) }).error === 'param_too_long:ref')
  }

  check('describeUiAction 带动作名与摘要',
    describeUiAction('switch_session', { sessionId: 'abc' }) === 'switch_session: abc')
  check('describeUiAction 未知动作', describeUiAction('nope').startsWith('unknown:'))
  check('describeUiAction 能显示 boolean 参数方向',
    describeUiAction('set_sidebar', { collapsed: true }) === 'set_sidebar: true'
      && describeUiAction('set_sidebar', { collapsed: false }) === 'set_sidebar: false')
  check('describeUiAction 显示 a11y 参数', describeUiAction('ui_click', { ref: 'e3' }) === 'ui_click: e3')

  const payload = buildUiActionPayload({
    requestId: 'r1',
    sessionId: 's1',
    action: 'switch_session',
    params: { sessionId: 's2' },
    confirm: true,
  })
  check('buildUiActionPayload 形状正确',
    payload.requestId === 'r1' && payload.sessionId === 's1'
      && payload.confirm === true && payload.actions.length === 1
      && payload.actions[0].action === 'switch_session'
      && payload.actions[0].params.sessionId === 's2',
    JSON.stringify(payload))

  const booleanPayload = buildUiActionPayload({
    requestId: 'r2',
    sessionId: 's1',
    action: 'set_sidebar',
    params: { collapsed: false },
    confirm: false,
  })
  check('buildUiActionPayload 保留 boolean 参数（false 不丢）',
    booleanPayload.actions[0].params.collapsed === false && booleanPayload.confirm === false,
    JSON.stringify(booleanPayload))

  // v3 ghost-action 修复：载荷带宿主等待 deadline（与工具超时同一时刻）。
  const deadline = Date.now() + 20_000
  const expiringPayload = buildUiActionPayload({
    requestId: 'r3', sessionId: 's1', action: 'state', params: {}, confirm: false, expiresAt: deadline,
  })
  check('buildUiActionPayload 透传有限数字 expiresAt', expiringPayload.expiresAt === deadline,
    JSON.stringify(expiringPayload))
  check('field 顺序保持 requestId/sessionId/actions/confirm/expiresAt',
    JSON.stringify(Object.keys(expiringPayload)) === JSON.stringify(['requestId', 'sessionId', 'actions', 'confirm', 'expiresAt']),
    JSON.stringify(Object.keys(expiringPayload)))
  check('非法 expiresAt（NaN/字符串）被省略',
    !Object.prototype.hasOwnProperty.call(
      buildUiActionPayload({ requestId: 'r4', action: 'state', expiresAt: Number.NaN }), 'expiresAt',
    )
      && !Object.prototype.hasOwnProperty.call(
        buildUiActionPayload({ requestId: 'r5', action: 'state', expiresAt: '123' }), 'expiresAt',
      ))
  check('isUiActionExpired：缺失/非法 → false',
    isUiActionExpired({}) === false && isUiActionExpired({ expiresAt: Number.NaN }) === false
      && isUiActionExpired({ expiresAt: '123' }) === false && isUiActionExpired(null) === false)
  check('isUiActionExpired：now < expiresAt → false',
    isUiActionExpired({ expiresAt: 1000 }, 999) === false)
  check('isUiActionExpired：now === expiresAt → false（边界仍允许）',
    isUiActionExpired({ expiresAt: 1000 }, 1000) === false)
  check('isUiActionExpired：now > expiresAt → true',
    isUiActionExpired({ expiresAt: 1000 }, 1001) === true)

  const validResult = validateUiActionResult({ requestId: 'r1', ok: false, error: 'confirm_denied', value: { cancelled: true } })
  check('validateUiActionResult：合法回执', validResult.ok === true && validResult.value.ok === false)
  check('validateUiActionResult：requestId 为空', validateUiActionResult({ requestId: '', ok: true }).ok === false)
  check('validateUiActionResult：ok 非布尔', validateUiActionResult({ requestId: 'r1', ok: 'yes' }).ok === false)
  check('validateUiActionResult：error 非字符串', validateUiActionResult({ requestId: 'r1', ok: false, error: 42 }).ok === false)
  check('validateUiActionResult：非对象', validateUiActionResult(null).ok === false)
}

// ---------------------------------------------------------------------------
console.log('\n== 4. POST /voice-prompt：注入成功 / 参数校验 / 失败回执 ==')
{
  const host = makeHost()
  const good = await callRoute(host, '/dsh-voice-typing/voice-prompt', 'POST', JSON.stringify({
    sessionId: 's1',
    text: '  你好世界  ',
    requestId: 'req-voice-1',
  }))
  check('合法请求 → 200 {ok:true}', good.status === 200 && good.body?.ok === true, JSON.stringify(good.body))
  const call = host.promptCalls[0]
  check('调用了 sessionController.prompt', !!call)
  check('sessionId 原样传入', call?.request?.sessionId === 's1')
  check('text 已 trim 且是 text part',
    call?.request?.content?.length === 1
      && call?.request?.content?.[0]?.type === 'text'
      && call?.request?.content?.[0]?.text === '你好世界', JSON.stringify(call?.request?.content))
  check('默认 mode=queue', call?.request?.mode === 'queue', String(call?.request?.mode))
  check('requestId 原样传入', call?.request?.requestId === 'req-voice-1')
  check('传了 AbortSignal', typeof call?.signal?.throwIfAborted === 'function' && call?.signal?.aborted === false)

  const diag = await callRoute(host, '/dsh-voice-typing/diagnostics', 'GET')
  check('诊断：voicePrompt.count 递增', diag.body?.voicePrompt?.count === 1, JSON.stringify(diag.body?.voicePrompt))
  check('诊断：lastVoicePromptAt > 0', diag.body?.voicePrompt?.lastAt > 0)
  check('诊断：voicePrompt.failures = 0', diag.body?.voicePrompt?.failures === 0)

  const invalid = [
    ['缺 sessionId', { text: '你好' }, 'invalid_session'],
    ['sessionId 超长', { sessionId: 'x'.repeat(201), text: '你好' }, 'invalid_session'],
    ['text 为空', { sessionId: 's1', text: '   ' }, 'invalid_text'],
    ['text 超长', { sessionId: 's1', text: 'x'.repeat(4001) }, 'invalid_text'],
    // requestId 会落进会话日志的 source.rpcId，必须有长度上限。
    ['requestId 超长', { sessionId: 's1', text: '你好', requestId: 'r'.repeat(201) }, 'invalid_requestId'],
  ]
  for (const [name, body, code] of invalid) {
    const result = await callRoute(host, '/dsh-voice-typing/voice-prompt', 'POST', JSON.stringify(body))
    check(`拒绝：${name} → 400 ${code}`,
      result.status === 400 && result.body?.error?.code === code, JSON.stringify(result.body))
  }
  const badJson = await callRoute(host, '/dsh-voice-typing/voice-prompt', 'POST', '{not json')
  check('非法 JSON → 400', badJson.status === 400 && badJson.body?.error?.code === 'invalid_json')
  const notPost = await callRoute(host, '/dsh-voice-typing/voice-prompt', 'GET')
  check('GET → 405', notPost.status === 405)

  // CSRF 加固：有副作用的路由只收 application/json。
  // 浏览器跨域发 application/json 会触发预检（被拒），text/plain 是「简单请求」——
  // 不卡 Content-Type 的话任意网页都能往会话里注入消息。
  const noContentType = await callRoute(host, '/dsh-voice-typing/voice-prompt', 'POST', JSON.stringify({
    sessionId: 's1', text: '注入',
  }), {})
  check('缺 content-type → 415 unsupported_media_type',
    noContentType.status === 415 && noContentType.body?.error?.code === 'unsupported_media_type',
    JSON.stringify(noContentType.body))
  const textPlain = await callRoute(host, '/dsh-voice-typing/voice-prompt', 'POST', JSON.stringify({
    sessionId: 's1', text: '注入',
  }), { 'content-type': 'text/plain' })
  check('text/plain（跨站简单请求）→ 415',
    textPlain.status === 415 && textPlain.body?.error?.code === 'unsupported_media_type')
  check('415 请求没有注入任何消息', host.promptCalls.length === 1, String(host.promptCalls.length))
  const charsetJson = await callRoute(host, '/dsh-voice-typing/voice-prompt', 'POST', JSON.stringify({
    sessionId: 's1', text: '大小写与参数容忍',
  }), { 'content-type': 'Application/JSON; charset=utf-8' })
  check('application/json（带 charset / 大小写）仍通过', charsetJson.status === 200 && charsetJson.body?.ok === true,
    JSON.stringify(charsetJson.body))
}
{
  // mode 从配置读默认值；请求里的 mode 大小写归一。
  const host = makeHost({ rowConfig: { voicePromptMode: 'steer' } })
  await callRoute(host, '/dsh-voice-typing/voice-prompt', 'POST', JSON.stringify({ sessionId: 's1', text: 'hi' }))
  check('配置 voicePromptMode=steer 时默认用 steer', host.promptCalls[0]?.request?.mode === 'steer',
    String(host.promptCalls[0]?.request?.mode))
  const host2 = makeHost()
  await callRoute(host2, '/dsh-voice-typing/voice-prompt', 'POST', JSON.stringify({
    sessionId: 's1', text: 'hi', mode: ' STEER ',
  }))
  check('请求 mode 大小写/空白归一', host2.promptCalls[0]?.request?.mode === 'steer')
}
{
  // 主路径失败 + 没有 agents 兜底 → 502，并记入诊断。
  const failure = Object.assign(new Error('session not found'), { code: 'session/not-found' })
  const host = makeHost({ promptFailure: failure, agent: false })
  const result = await callRoute(host, '/dsh-voice-typing/voice-prompt', 'POST', JSON.stringify({
    sessionId: 's404', text: '你好',
  }))
  check('注入失败 → 502 {ok:false}', result.status === 502 && result.body?.ok === false, JSON.stringify(result.body))
  check('失败回执带原始错误 code', result.body?.error?.code === 'session/not-found', JSON.stringify(result.body?.error))
  check('失败回执带错误信息', result.body?.error?.message === 'session not found')
  const diag = await callRoute(host, '/dsh-voice-typing/diagnostics', 'GET')
  check('诊断：voicePrompt.failures 递增', diag.body?.voicePrompt?.failures === 1,
    JSON.stringify(diag.body?.voicePrompt))
  check('诊断：lastVoicePromptError 记录原因', diag.body?.voicePrompt?.lastError === 'session not found')
}
{
  // 评审 P2-2：controller.prompt 抛错时**不得**再走 agents 兜底。
  // 主路径可能已经入队了消息（如本地超时/网络错误），再 followup 一次就是重复注入。
  const failure = Object.assign(new Error('agent busy'), { code: 'session/agent-busy' })
  const host = makeHost({ promptFailure: failure }) // agent 存在，但不应被调用
  const result = await callRoute(host, '/dsh-voice-typing/voice-prompt', 'POST', JSON.stringify({
    sessionId: 's1', text: '不要注入两次',
  }))
  check('controller 抛错 → 502（不吞错）',
    result.status === 502 && result.body?.ok === false && result.body?.error?.code === 'session/agent-busy',
    JSON.stringify(result.body))
  check('controller 抛错时不再走 agents 兜底（防重复注入）',
    host.agent.followupCalls.length === 0 && host.agent.steerCalls.length === 0,
    JSON.stringify({ followup: host.agent.followupCalls.length, steer: host.agent.steerCalls.length }))
  host.disposeAll()
}
{
  // controller 缺失（精简部署）→ 才允许 agents.followup/steer 兜底。
  // 测试环境没有 @deepseek-ai/dsh-llm，用测试钩子注入 createUserMessage。
  const host = makeHost({ sessionController: false })
  setCreateUserMessageLoaderForTest(async () => (input) => ({ ...input, mocked: true }))
  try {
    const result = await callRoute(host, '/dsh-voice-typing/voice-prompt', 'POST', JSON.stringify({
      sessionId: 's1', text: '兜底注入',
    }))
    check('controller 缺失 → agents 兜底成功 200',
      result.status === 200 && result.body?.ok === true, JSON.stringify(result.body))
    check('兜底调用 followup 一次', host.agent.followupCalls.length === 1,
      String(host.agent.followupCalls.length))
    check('兜底消息是 text part',
      host.agent.followupCalls[0]?.content?.[0]?.type === 'text'
        && host.agent.followupCalls[0]?.content?.[0]?.text === '兜底注入',
      JSON.stringify(host.agent.followupCalls[0]))
  } finally {
    setCreateUserMessageLoaderForTest(null)
    host.disposeAll()
  }
}
{
  // controller 缺失且兜底模块不可用 → 502，不谎报成功。
  //
  // 注意：**不能**依赖「本机没装 @deepseek-ai/dsh-llm」来制造不可用。
  // 它是 package.json 的 optional peer，而 pnpm 默认 autoInstallPeers=true，
  // `pnpm install --frozen-lockfile` 后它会被装进 node_modules，CI 上这条
  // 断言就会从 502 变成 200（本机/CI 行为分裂）。显式注入一个抛错的加载器，
  // 让「兜底不可用」与安装状态无关。
  const host = makeHost({ sessionController: false })
  setCreateUserMessageLoaderForTest(async () => {
    throw new Error("Cannot find module '@deepseek-ai/dsh-llm'")
  })
  try {
    const result = await callRoute(host, '/dsh-voice-typing/voice-prompt', 'POST', JSON.stringify({
      sessionId: 's1', text: '兜底不可用',
    }))
    check('兜底模块不可用 → 502',
      result.status === 502 && result.body?.ok === false && typeof result.body?.error?.code === 'string',
      JSON.stringify(result.body))
    check('兜底失败时没有 followup 调用', host.agent.followupCalls.length === 0)
  } finally {
    setCreateUserMessageLoaderForTest(null)
    host.disposeAll()
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 5. POST /ui-action-result：回执路由 ==')
{
  const host = makeHost()
  const unknown = await callRoute(host, '/dsh-voice-typing/ui-action-result', 'POST', JSON.stringify({
    requestId: 'nope', ok: true,
  }))
  check('未知 requestId → 404', unknown.status === 404 && unknown.body?.error === 'unknown requestId',
    JSON.stringify(unknown.body))
  const invalidId = await callRoute(host, '/dsh-voice-typing/ui-action-result', 'POST', JSON.stringify({
    requestId: '', ok: true,
  }))
  check('requestId 为空 → 400', invalidId.status === 400 && invalidId.body?.error?.code === 'invalid_requestId')
  const invalidOk = await callRoute(host, '/dsh-voice-typing/ui-action-result', 'POST', JSON.stringify({
    requestId: 'r1', ok: 'yes',
  }))
  check('ok 非布尔 → 400', invalidOk.status === 400 && invalidOk.body?.error?.code === 'invalid_ok')
  const badJson = await callRoute(host, '/dsh-voice-typing/ui-action-result', 'POST', '{oops')
  check('非法 JSON → 400', badJson.status === 400 && badJson.body?.error?.code === 'invalid_json')
  const notPost = await callRoute(host, '/dsh-voice-typing/ui-action-result', 'GET')
  check('GET → 405', notPost.status === 405)

  const noContentType = await callRoute(host, '/dsh-voice-typing/ui-action-result', 'POST', JSON.stringify({
    requestId: 'r1', ok: true,
  }), {})
  check('缺 content-type → 415 unsupported_media_type',
    noContentType.status === 415 && noContentType.body?.error?.code === 'unsupported_media_type',
    JSON.stringify(noContentType.body))
  const textPlain = await callRoute(host, '/dsh-voice-typing/ui-action-result', 'POST', JSON.stringify({
    requestId: 'r1', ok: true,
  }), { 'content-type': 'text/plain' })
  check('text/plain（跨站简单请求）→ 415',
    textPlain.status === 415 && textPlain.body?.error?.code === 'unsupported_media_type')
}

// ---------------------------------------------------------------------------
console.log('\n== 6. POST /hotkey：helper-only + token 鉴权 ==')
{
  const host = makeHost()
  const noToken = await callRoute(host, '/dsh-voice-typing/hotkey', 'POST', JSON.stringify({ action: 'toggle' }))
  check('没有 token → 403', noToken.status === 403, JSON.stringify(noToken.body))
  const wrongToken = await callRoute(host, '/dsh-voice-typing/hotkey', 'POST', JSON.stringify({ action: 'toggle' }), {
    'content-type': 'application/json',
    'x-dsh-voice-token': 'wrong-token',
  })
  check('token 不对 → 403', wrongToken.status === 403)
  const notPost = await callRoute(host, '/dsh-voice-typing/hotkey', 'GET')
  check('GET → 405', notPost.status === 405)

  // 与另外两条一致：先卡 Content-Type（跨站简单请求），再验证 token。
  const noContentType = await callRoute(host, '/dsh-voice-typing/hotkey', 'POST', JSON.stringify({ action: 'toggle' }), {})
  check('缺 content-type → 415 unsupported_media_type',
    noContentType.status === 415 && noContentType.body?.error?.code === 'unsupported_media_type',
    JSON.stringify(noContentType.body))
  const textPlain = await callRoute(host, '/dsh-voice-typing/hotkey', 'POST', JSON.stringify({ action: 'toggle' }), {
    'content-type': 'text/plain',
  })
  check('text/plain（跨站简单请求）→ 415',
    textPlain.status === 415 && textPlain.body?.error?.code === 'unsupported_media_type')
  const diag = await callRoute(host, '/dsh-voice-typing/diagnostics', 'GET')
  check('诊断：hotkeyHelper 状态（默认关闭）',
    diag.body?.hotkeyHelper?.enabled === false && typeof diag.body?.hotkeyHelper?.reason === 'string',
    JSON.stringify(diag.body?.hotkeyHelper))
  check('诊断：hotkeyHelper 不含 token 值', !/"token"\s*:/.test(JSON.stringify(diag.body?.hotkeyHelper)))
  // 批次 19（docs §8.61）：诊断里那句「为什么」必须是**码**（或空串），不能是中文句子 ——
  // 设置面板把它当界面文案的输入，宿主写句子 = 英文界面出中文。
  // 「真宿主」这一档只有在这里才量得到：helper 单元测试跑的是假 spawn，
  // 客户端行为测试喂的是假 /diagnostics，中间这段「宿主真报什么」两头都不管。
  {
    const reason = diag.body?.hotkeyHelper?.reason
    check('诊断：hotkeyHelper 的 reason 是词表内的码或空串（宿主不写句子）',
      (reason === '' || isHotkeyReason(reason)) && !/[^\x00-\x7F]/.test(String(reason)),
      JSON.stringify(reason))
    check('诊断：hotkeyHelper 带 detail（动态原文只进诊断）',
      typeof diag.body?.hotkeyHelper?.detail === 'string' && diag.body.hotkeyHelper.detail.length > 0,
      JSON.stringify(diag.body?.hotkeyHelper?.detail))
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 6b. helper 真打开时：/hotkey 的成功路径确实把 global-hotkey 广播出去了 ==')
{
  // 这一节替掉原来那条源码正则 `/broadcast\('global-hotkey'/`（批次 6h，docs §8.41）。
  // 它守的事是「helper 按下热键之后，客户端到底收不收得到这条事件」——
  // 这件事本来就能直接看：接一条 SSE，POST 一次 /hotkey，数事件。
  // 上面 §6 之所以看不到它：那份假宿主没开 `globalHotkeyHelper`，
  // 三道守卫第一道就挡住了（默认关），于是 §6 的 403 里**没有一条真的比过 token**。
  //
  // 三处注入全走 `loadHostRoutes` 的 transform，生产源码一个字没改：
  //   1. `createHotkeyHelper` 的选项前面展开一份测试注入：
  //      token 换成已知的（否则拿不到它就没法发合法请求），spawn 换成记一笔账的替身
  //      （否则这条用例会在开发机上真的拉起一个常驻 PowerShell 热键监听进程）；
  //   2. 路由里的 `helperSupported()` 显式传 `'win32'`：这条路由按**进程平台**开放，
  //      非 Windows 上成功路径永远走不到，判据会变成「只在 Windows 绿」的假绿；
  //      传死平台后 Linux/macOS 跑的也是同一条分支。
  //   3. helper 写 .ps1 的位置换成测试自己的临时目录，跑完一起收摊。
  const helperTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hotkey-helper-'))
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hotkey-host-'))
  const token = 'test-hotkey-token-1'
  const spawned = []
  let killedTimes = 0
  globalThis.__dshHotkeyTest = {
    inject: {
      platform: 'win32',
      tmpDir: helperTmp,
      createToken: () => token,
      spawnImpl: (command, args, opts) => {
        spawned.push({ command, args, opts })
        // 假子进程：helper 会挂 once('error'/'exit') 和 stdout/stderr 的 data，
        // 这里都不回 READY —— 状态停在 starting，路由不看它（看的是 token 与配置）。
        return {
          pid: 4242,
          once() { return this },
          on() { return this },
          kill() { killedTimes += 1 },
          stdout: { on() {} },
          stderr: { on() {} },
        }
      },
    },
  }
  let host = null
  try {
    host = await loadHostRoutes({
      dshHome: hostHome,
      rowConfig: { globalHotkeyHelper: true, globalVoice: true, globalShortcut: 'Ctrl+Alt+V' },
      transform: (code, file) => {
        if (file !== 'index.js') return code
        return code
          .replace(
            'const hotkeyHelper = createHotkeyHelper({',
            'const hotkeyHelper = createHotkeyHelper({ ...globalThis.__dshHotkeyTest.inject,',
          )
          .replace('!helperSupported()', "!helperSupported('win32')")
      },
      requireRewrite: [
        ['热键 helper 的 token / spawn / tmpDir 换成测试注入',
          'const hotkeyHelper = createHotkeyHelper({',
          'createHotkeyHelper({ ...globalThis.__dshHotkeyTest.inject,'],
        ['路由的平台判定收到测试平台（跨机器都能走成功路径）',
          '!helperSupported()',
          "!helperSupported('win32')"],
      ],
    })
    const stream = host.openStream()
    const send = (body, tok = token, headers = {}) => host.request('/dsh-voice-typing/hotkey', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-voice-token': tok, ...headers },
      body: JSON.stringify(body),
    })
    const ok = await send({ action: 'toggle' })
    check('helper 已开 + token 正确 → /hotkey 回 200（§6 那份默认关闭的宿主走不到这条）',
      ok.statusCode === 200 && ok.json?.()?.ok === true,
      `status=${ok.statusCode} ${ok.text}`)
    const frames = stream.events()
    const hotkeyFrames = frames.filter((e) => e.event === 'global-hotkey')
    check('/hotkey 成功那一次真的广播出一条 global-hotkey（不是源码里写着 broadcast）',
      hotkeyFrames.length === 1, JSON.stringify(frames.map((f) => f.event)))
    check(
      '广播出去的载荷与信封：action=toggle、sessionId 为 null（全局事件，不属于任何会话）',
      hotkeyFrames[0]?.data?.action === 'toggle' && hotkeyFrames[0]?.data?.sessionId === null,
      JSON.stringify(hotkeyFrames[0]?.data),
    )
    const afterOk = stream.events().length
    const badToken = await send({ action: 'toggle', }, token + '-not')
    check('helper 开着但 token 不对 → 403（这次是真的在做 token 比对）',
      badToken.statusCode === 403, `status=${badToken.statusCode} ${badToken.text}`)
    const wrongHelper = await host.request('/dsh-voice-typing/hotkey', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'toggle' }),
    })
    check('不带 token 头 → 403，且不广播', wrongHelper.statusCode === 403
      && stream.events().length === afterOk, `status=${wrongHelper.statusCode}`)
    check('token 不对的那次一条事件都没多发',
      stream.events().length === afterOk,
      JSON.stringify({ before: afterOk, after: stream.events().length }))
    const badAction = await send({ action: 'mute' })
    check('动作不是 toggle → 400', badAction.statusCode === 400
      && badAction.json?.()?.error?.code === 'invalid_action', `status=${badAction.statusCode} ${badAction.text}`)
    check('非法动作同样不广播', stream.events().length === afterOk,
      `事件数 ${stream.events().length}，成功那次之后是 ${afterOk}`)
    // helper 自己的状态从 /diagnostics 读：这条路由不看 helper 是否已经 REGISTER 成功，
    // 但诊断必须如实报告它卡在 starting（不能谎报 enabled）。
    const diag = await host.request('/dsh-voice-typing/diagnostics')
    const helperState = diag.json?.()?.hotkeyHelper ?? {}
    check('诊断里的 helper 状态如实报告「还没确认注册成功」',
      helperState.enabled === false && typeof helperState.status === 'string'
        && !/"token"\s*:/.test(JSON.stringify(helperState)),
      JSON.stringify(helperState))
    stream.close()
    host.restore()
    host = null
  } finally {
    if (host) host.restore()
    delete globalThis.__dshHotkeyTest
    for (const dir of [helperTmp, hostHome]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ }
    }
  }
  check('helper 确实被拉起来过，而且拉起的是替身（测试没有真起 powershell 常驻进程）',
    spawned.length === 1 && spawned[0].command === 'powershell.exe'
      && String(spawned[0].args?.at(-1) ?? '').endsWith('.ps1'),
    JSON.stringify(spawned.map((s) => ({ command: s.command, args: s.args?.slice(-1) }))))
}

// ---------------------------------------------------------------------------
console.log('\n== 7. voice_ui 工具：注册 / 总开关 / 参数校验 / list_sessions ==')
{
  const host = makeHost()
  check('注册了 1 个工具', host.toolDefs.length === 1, String(host.toolDefs.length))
  const tool = host.toolDefs[0]
  check('工具名是 voice_ui', tool?.name === 'voice_ui')
  check('工具参数 enum 与动作枚举完全一致',
    JSON.stringify(tool?.parameters?.properties?.action?.enum) === JSON.stringify(UI_ACTION_NAMES))
  check('工具 required 只有 action', JSON.stringify(tool?.parameters?.required) === JSON.stringify(['action']))
  check('工具 additionalProperties=false', tool?.parameters?.additionalProperties === false)
  // v2：工具 schema 新增 a11y 参数（ref/key/collapsed），描述用中文。
  check('工具 parameters 增加 ref/key/collapsed 字段',
    tool?.parameters?.properties?.ref?.type === 'string'
      && tool?.parameters?.properties?.key?.type === 'string'
      && tool?.parameters?.properties?.collapsed?.type === 'boolean')
  check('新字段都有中文描述',
    ['ref', 'key', 'collapsed'].every((name) => {
      const description = tool?.parameters?.properties?.[name]?.description
      return typeof description === 'string' && description.length > 4 && /[\u4e00-\u9fa5]/.test(description)
    }))
  check('工具 action enum 含全部 14 个动作', tool?.parameters?.properties?.action?.enum?.length === 14)
  // 工具 schema 是协议的第三份副本：每个动作的每个参数都必须是 properties 的键，
  // 否则以后加参数时只改协议、工具 schema 静默漏改（模型传不进来）。
  {
    const properties = tool?.parameters?.properties ?? {}
    const missing = [...new Set(Object.values(UI_ACTION_PARAMS).flat())].filter((name) => !(name in properties))
    check('工具 schema 覆盖协议里的全部参数名（防第三份副本漂移）',
      missing.length === 0, JSON.stringify(missing))
  }
  check('工具 output.schema 是 string', tool?.output?.schema?.type === 'string')
  check('工具 output.render 返回 text 块',
    JSON.stringify(tool?.output?.render?.({}, 'x')) === JSON.stringify([{ type: 'text', text: 'x' }]))

  const disabled = JSON.parse(await tool.execute({ action: 'toggle_sidebar' }, execOf()))
  check('总开关关闭 → ui_control_disabled', disabled.ok === false && disabled.error === 'ui_control_disabled',
    JSON.stringify(disabled))
  // P2-6：提示词只在 uiControl 打开时注册，否则等于白占 token 又宣传一个不可用工具。
  check('uiControl=false → 不注册 voice-ui 提示词 section',
    host.systemPromptSections.length === 0, JSON.stringify(host.systemPromptSections))
}
{
  const host = makeHost({ rowConfig: { uiControl: true } })
  const tool = host.toolDefs[0]
  check('uiControl=true → 注册 1 个 voice-ui 提示词 section',
    host.systemPromptSections.length === 1
      && host.systemPromptSections[0]?.name === 'voice-ui'
      && Number.isFinite(host.systemPromptSections[0]?.order), JSON.stringify(host.systemPromptSections.length))
  check('系统提示词说明了动作表与确认规则',
    /switch_session/.test(host.systemPromptSections[0]?.text ?? '')
      && /确认/.test(host.systemPromptSections[0]?.text ?? ''))
  check('系统提示词加入 a11y 使用规则（先 snapshot / ref 过期重拍 / 语义优先）',
    /ui_snapshot/.test(host.systemPromptSections[0]?.text ?? '')
      && /ref/.test(host.systemPromptSections[0]?.text ?? '')
      && /过期/.test(host.systemPromptSections[0]?.text ?? '')
      && /语义动作/.test(host.systemPromptSections[0]?.text ?? ''))
  check('系统提示词写明 ui_control_disabled / voice_overlay_disabled 语义',
    /ui_control_disabled/.test(host.systemPromptSections[0]?.text ?? '')
      && /voice_overlay_disabled/.test(host.systemPromptSections[0]?.text ?? ''))
  const sse = connectSse(host)
  try {
    const badAction = JSON.parse(await tool.execute({ action: 'nope' }, execOf()))
    check('未知动作 → unknown_action', badAction.ok === false && badAction.error === 'unknown_action',
      JSON.stringify(badAction))
    const badParams = JSON.parse(await tool.execute({ action: 'run_command', line: 'a\nb' }, execOf()))
    check('非法参数 → invalid_param:line', badParams.ok === false && badParams.error === 'invalid_param:line',
      JSON.stringify(badParams))
    check('参数非法时不广播 ui-action 事件', !parseSse(sse.raw()).some((frame) => frame.event === 'ui-action'))

    // 浮层没开 → 没有执行器，工具应立刻返回明确错误（而不是等到 20 秒超时）。
    const gated = JSON.parse(await tool.execute({ action: 'toggle_sidebar' }, execOf()))
    check('浮层未开启 → voice_overlay_disabled',
      gated.ok === false && gated.error === 'voice_overlay_disabled', JSON.stringify(gated))
    check('浮层未开启时不广播 ui-action 事件',
      !parseSse(sse.raw()).some((frame) => frame.event === 'ui-action'))

    const listed = JSON.parse(await tool.execute({ action: 'list_sessions' }, execOf()))
    check('list_sessions 宿主直答', listed.ok === true && Array.isArray(listed.value), JSON.stringify(listed))
    check('list_sessions 摘要含 id/title/lastPromptAt',
      listed.value?.[0]?.id === 's1' && listed.value?.[0]?.title === '会话一'
        && listed.value?.[0]?.lastPromptAt === 111, JSON.stringify(listed.value))
    check('list_sessions 不走客户端（没有 ui-action 事件）',
      !parseSse(sse.raw()).some((frame) => frame.event === 'ui-action'))
  } finally {
    sse.close()
  }
}
{
  // P1-1 回归：真实 sessionController.list() 的行**没有顶层 title/lastPromptAt**。
  // 旧 fake 顶层字段把 bug 遮住了（线上 list_sessions 永远只拿到 id + 被误标的 updatedAt）。
  const realRows = {
    items: [
      {
        sessionId: 's-real',
        updatedAt: 1700000000500,
        agentAvailable: true,
        running: true,
        blank: false,
        cwd: 'C:/work',
        projections: {
          values: {
            title: '语音插件会话',
            sessionListMetadata: { blank: false, lastPromptAt: 1700000000000 },
          },
        },
      },
      // 老 fake 形状仍要兼容（title/name/lastPromptAt 顶层）。
      { sessionId: 's-legacy', title: ' 老式标题 ', lastPromptAt: 1600000000000, name: 'fallback-name' },
    ],
  }
  const host = makeHost({ rowConfig: { uiControl: true }, sessionList: realRows })
  const tool = host.toolDefs[0]
  const listed = JSON.parse(await tool.execute({ action: 'list_sessions' }, execOf()))
  check('真实行 → title 从 projections.values.title 读取',
    listed.value?.[0]?.title === '语音插件会话', JSON.stringify(listed.value?.[0]))
  check('真实行 → lastPromptAt 从 sessionListMetadata 读取（不是 updatedAt）',
    listed.value?.[0]?.lastPromptAt === 1700000000000, JSON.stringify(listed.value?.[0]))
  check('真实行 → 带上 running/blank/cwd',
    listed.value?.[0]?.running === true && listed.value?.[0]?.blank === false && listed.value?.[0]?.cwd === 'C:/work',
    JSON.stringify(listed.value?.[0]))
  check('旧 fake 形状仍兼容（顶层 title trim + lastPromptAt）',
    listed.value?.[1]?.title === '老式标题' && listed.value?.[1]?.lastPromptAt === 1600000000000,
    JSON.stringify(listed.value?.[1]))
  host.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n== 7b. 提示词 section 随 uiControl 动态注册/注销（P2-6）==')
{
  const host = makeHost({ rowConfig: { uiControl: true } })
  // 等 apply 末尾的异步 reloadConfig 落定，避免与 POST /config 竞态。
  await new Promise((resolve) => setTimeout(resolve, 10))
  check('初始 uiControl=true → 1 个 section', host.systemPromptSections.length === 1,
    String(host.systemPromptSections.length))
  const off = await callRoute(host, '/dsh-voice-typing/config', 'POST', JSON.stringify({ uiControl: false }))
  check('保存 uiControl=false → section 被注销（0 个）',
    off.status === 200 && host.systemPromptSections.length === 0,
    JSON.stringify({ status: off.status, sections: host.systemPromptSections.length }))
  const on = await callRoute(host, '/dsh-voice-typing/config', 'POST', JSON.stringify({ uiControl: true }))
  check('保存 uiControl=true → 重新注册（1 个）',
    on.status === 200 && host.systemPromptSections.length === 1,
    JSON.stringify({ status: on.status, sections: host.systemPromptSections.length }))
  host.disposeAll()
  check('卸载后 section 释放（0 个）', host.systemPromptSections.length === 0,
    String(host.systemPromptSections.length))
  // POST /config 会把配置写进临时 DSH_HOME；清掉，避免影响后续 makeHost。
  try { fs.unlinkSync(path.join(tmpHome, 'voice-typing.json')) } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
console.log('\n== 7c. POST /ui-action-claim：多窗口防重复执行（P2-1）==')
{
  const host = makeHost({ rowConfig: { uiControl: true, globalVoice: true } })
  const tool = host.toolDefs[0]
  const sse = connectSse(host)
  try {
    const promise = tool.execute({ action: 'state' }, execOf('s1'))
    const frame = await waitFor(() => parseSse(sse.raw()).find((item) => item.event === 'ui-action'))
    const requestId = frame?.payload?.requestId
    check('有在途动作可认领', typeof requestId === 'string' && requestId.length > 0)

    const first = await callRoute(host, '/dsh-voice-typing/ui-action-claim', 'POST',
      JSON.stringify({ requestId, clientId: 'client-A' }))
    check('第一个窗口 claim → {claimed:true}',
      first.status === 200 && first.body?.claimed === true, JSON.stringify(first.body))
    const second = await callRoute(host, '/dsh-voice-typing/ui-action-claim', 'POST',
      JSON.stringify({ requestId, clientId: 'client-B' }))
    check('第二个窗口 claim → {claimed:false}（不重复执行）',
      second.status === 200 && second.body?.claimed === false, JSON.stringify(second.body))
    const sameAgain = await callRoute(host, '/dsh-voice-typing/ui-action-claim', 'POST',
      JSON.stringify({ requestId, clientId: 'client-A' }))
    check('同一窗口重试 claim 幂等 → true',
      sameAgain.status === 200 && sameAgain.body?.claimed === true, JSON.stringify(sameAgain.body))
    const unknown = await callRoute(host, '/dsh-voice-typing/ui-action-claim', 'POST',
      JSON.stringify({ requestId: 'nope', clientId: 'client-A' }))
    check('未知 requestId → 404', unknown.status === 404 && unknown.body?.error === 'unknown requestId',
      JSON.stringify(unknown.body))
    const invalidId = await callRoute(host, '/dsh-voice-typing/ui-action-claim', 'POST',
      JSON.stringify({ requestId: '', clientId: 'client-A' }))
    check('requestId 为空 → 400 invalid_requestId',
      invalidId.status === 400 && invalidId.body?.error?.code === 'invalid_requestId')
    const invalidClient = await callRoute(host, '/dsh-voice-typing/ui-action-claim', 'POST',
      JSON.stringify({ requestId, clientId: '' }))
    check('clientId 为空 → 400 invalid_clientId',
      invalidClient.status === 400 && invalidClient.body?.error?.code === 'invalid_clientId')
    const textPlain = await callRoute(host, '/dsh-voice-typing/ui-action-claim', 'POST',
      JSON.stringify({ requestId, clientId: 'client-A' }), { 'content-type': 'text/plain' })
    check('text/plain → 415（同副作用路由的 CSRF 加固）',
      textPlain.status === 415 && textPlain.body?.error?.code === 'unsupported_media_type')
    const notPost = await callRoute(host, '/dsh-voice-typing/ui-action-claim', 'GET')
    check('GET → 405', notPost.status === 405)

    // 回执后 pending 消失：认领应答 404。
    await callRoute(host, '/dsh-voice-typing/ui-action-result', 'POST',
      JSON.stringify({ requestId, ok: true, value: { claimed: true } }))
    await promise
    const lateClaim = await callRoute(host, '/dsh-voice-typing/ui-action-claim', 'POST',
      JSON.stringify({ requestId, clientId: 'client-C' }))
    check('已回执后 claim → 404', lateClaim.status === 404, JSON.stringify(lateClaim.body))
  } finally {
    sse.close()
    host.disposeAll()
  }
}
{
  // 超时后待处理项被清掉：claim → 404。
  const host = makeHost({ rowConfig: { uiControl: true, globalVoice: true } })
  const tool = host.toolDefs[0]
  const sse = connectSse(host)
  setVoiceUiTimeoutForTest(25)
  try {
    const promise = tool.execute({ action: 'toggle_sidebar' }, execOf('s1'))
    const frame = await waitFor(() => parseSse(sse.raw()).find((item) => item.event === 'ui-action'))
    const requestId = frame?.payload?.requestId
    const result = JSON.parse(await promise)
    check('无人回执 → 超时失败', result.ok === false && result.error === 'ui_timeout', JSON.stringify(result))
    const lateClaim = await callRoute(host, '/dsh-voice-typing/ui-action-claim', 'POST',
      JSON.stringify({ requestId, clientId: 'client-A' }))
    check('超时后 claim → 404', lateClaim.status === 404, JSON.stringify(lateClaim.body))
  } finally {
    setVoiceUiTimeoutForTest(20000)
    sse.close()
    host.disposeAll()
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 8. voice_ui 工具：成功回执 + SSE ui-action 信封 ==')
{
  const host = makeHost({ rowConfig: { uiControl: true, globalVoice: true } })
  const tool = host.toolDefs[0]
  const sse = connectSse(host)
  try {
    const startedAt = Date.now()
    const promise = tool.execute({ action: 'state' }, execOf('s1'))
    const frame = await waitFor(() => parseSse(sse.raw()).find((item) => item.event === 'ui-action'))
    check('执行动作时广播了 ui-action 事件', !!frame)
    const payload = frame?.payload ?? {}
    check('信封带协议版本 v=3', payload.v === 3, String(payload.v))
    check('信封带单调 seq', typeof payload.seq === 'number' && payload.seq > 0, String(payload.seq))
    check('信封带 ts', typeof payload.ts === 'number' && payload.ts > 0, String(payload.ts))
    check('信封 sessionId 来自工具调用会话', payload.sessionId === 's1', String(payload.sessionId))
    check('载荷带 requestId', typeof payload.requestId === 'string' && payload.requestId.length > 0)
    check('载荷 actions=[{action,params}]',
      Array.isArray(payload.actions) && payload.actions.length === 1
        && payload.actions[0].action === 'state'
        && JSON.stringify(payload.actions[0].params) === '{}',
      JSON.stringify(payload.actions))
    check('只读动作 confirm=false（即使 uiConfirm 默认 true）', payload.confirm === false, String(payload.confirm))
    // v3 ghost-action 修复：下发的 deadline 是有限数字且不早于调用时刻，
    // 客户端据此拒绝「宿主已超时、用户才点允许」的迟到执行。
    check('载荷带 expiresAt（有限数字，>= 调用时刻）',
      typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt) && payload.expiresAt >= startedAt,
      String(payload.expiresAt))
    check('isUiActionExpired 对刚发出的载荷为 false',
      isUiActionExpired(payload, startedAt) === false)

    const ack = await callRoute(host, '/dsh-voice-typing/ui-action-result', 'POST', JSON.stringify({
      requestId: payload.requestId,
      ok: true,
      value: { sessionId: 's1', title: '会话一' },
    }))
    check('回执路由 → 200 {ok:true}', ack.status === 200 && ack.body?.ok === true, JSON.stringify(ack.body))
    const result = JSON.parse(await promise)
    check('工具返回 {ok:true,value}',
      result.ok === true && result.value?.sessionId === 's1', JSON.stringify(result))

    const diag = await callRoute(host, '/dsh-voice-typing/diagnostics', 'GET')
    const entry = diag.body?.uiActions?.find((item) => item.requestId === payload.requestId)
    check('诊断记录本次 UI 动作', !!entry && entry.action === 'state' && entry.ok === true,
      JSON.stringify(diag.body?.uiActions))
    check('诊断记录不含参数正文', !('text' in (entry ?? {})) && !('params' in (entry ?? {})), JSON.stringify(entry))
    check('诊断 uiActions 最多 50 条', (diag.body?.uiActions ?? []).length <= 50)
  } finally {
    sse.close()
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 9. voice_ui 工具：危险动作确认 / 拒绝 / 超时 ==')
{
  const host = makeHost({ rowConfig: { uiControl: true, globalVoice: true } })
  const tool = host.toolDefs[0]
  const sse = connectSse(host)
  try {
    const promise = tool.execute({ action: 'switch_session', sessionId: 's2' }, execOf('s1'))
    const frame = await waitFor(() => parseSse(sse.raw()).find((item) => item.event === 'ui-action'))
    check('危险动作 confirm=true', frame?.payload?.confirm === true, String(frame?.payload?.confirm))
    const ack = await callRoute(host, '/dsh-voice-typing/ui-action-result', 'POST', JSON.stringify({
      requestId: frame?.payload?.requestId,
      ok: false,
      error: 'confirm_denied',
      value: { cancelled: true },
    }))
    check('拒绝回执 → 200', ack.status === 200)
    const result = JSON.parse(await promise)
    check('工具把 confirm_denied 原样回给模型',
      result.ok === false && result.error === 'confirm_denied' && result.cancelled === true,
      JSON.stringify(result))
  } finally {
    sse.close()
  }
}
{
  // uiConfirm=false：危险动作不再要求确认（但仍是危险动作）。
  const host = makeHost({ rowConfig: { uiControl: true, uiConfirm: false, globalVoice: true } })
  const tool = host.toolDefs[0]
  const sse = connectSse(host)
  try {
    const promise = tool.execute({ action: 'switch_session', sessionId: 's2' }, execOf('s1'))
    const frame = await waitFor(() => parseSse(sse.raw()).find((item) => item.event === 'ui-action'))
    check('uiConfirm=false 时 confirm=false', frame?.payload?.confirm === false, String(frame?.payload?.confirm))
    await callRoute(host, '/dsh-voice-typing/ui-action-result', 'POST', JSON.stringify({
      requestId: frame?.payload?.requestId, ok: true, value: { switched: true },
    }))
    const result = JSON.parse(await promise)
    check('成功后返回 value', result.ok === true && result.value?.switched === true, JSON.stringify(result))
  } finally {
    sse.close()
  }
}
{
  // 超时：没有渲染器回执 → ui_timeout（测试里把 20 秒缩成 30ms）。
  const host = makeHost({ rowConfig: { uiControl: true, globalVoice: true } })
  const tool = host.toolDefs[0]
  setVoiceUiTimeoutForTest(30)
  try {
    const result = JSON.parse(await tool.execute({ action: 'toggle_sidebar' }, execOf('s1')))
    check('无人回执 → ui_timeout', result.ok === false && result.error === 'ui_timeout', JSON.stringify(result))
  } finally {
    setVoiceUiTimeoutForTest(20000)
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 9b. v2 a11y / 语义动作：校验 + SSE 下发 + confirm + boolean 参数 ==')
{
  const host = makeHost({ rowConfig: { uiControl: true, globalVoice: true } })
  const tool = host.toolDefs[0]
  const sse = connectSse(host)
  // 每个动作只调一次；按动作名找对应帧，避免拿到上一动作的残留事件。
  const frameFor = (action) => waitFor(() => parseSse(sse.raw())
    .map((frame) => frame.payload)
    .filter((payload) => payload?.actions?.[0]?.action === action)
    .pop())
  const respond = (payload, body) => callRoute(host, '/dsh-voice-typing/ui-action-result', 'POST', JSON.stringify({
    requestId: payload?.requestId,
    ...body,
  }))
  try {
    // 非法参数：在广播前就被宿主拒绝。
    const noRef = JSON.parse(await tool.execute({ action: 'ui_click' }, execOf()))
    check('ui_click 缺 ref → missing_param:ref', noRef.error === 'missing_param:ref', JSON.stringify(noRef))
    const longRef = JSON.parse(await tool.execute({ action: 'ui_click', ref: 'x'.repeat(41) }, execOf()))
    check('ref 超长 → param_too_long:ref', longRef.error === 'param_too_long:ref', JSON.stringify(longRef))
    const longKey = JSON.parse(await tool.execute({ action: 'ui_key', key: 'x'.repeat(41) }, execOf()))
    check('key 超长 → param_too_long:key', longKey.error === 'param_too_long:key', JSON.stringify(longKey))
    const badBool = JSON.parse(await tool.execute({ action: 'set_sidebar', collapsed: 'yes' }, execOf()))
    check('collapsed 非布尔 → invalid_param:collapsed', badBool.error === 'invalid_param:collapsed', JSON.stringify(badBool))
    check('参数非法时不广播 ui-action 事件',
      !parseSse(sse.raw()).some((frame) => frame.event === 'ui-action'))

    // ui_snapshot：只读、无参数、不确认。
    const snapPromise = tool.execute({ action: 'ui_snapshot' }, execOf('s1'))
    const snapFrame = await frameFor('ui_snapshot')
    check('ui_snapshot 广播 confirm=false', snapFrame?.confirm === false, String(snapFrame?.confirm))
    check('ui_snapshot 参数为空', JSON.stringify(snapFrame?.actions?.[0]?.params) === '{}',
      JSON.stringify(snapFrame?.actions))
    await respond(snapFrame, { ok: true, value: { count: 2, elements: [], sidebarCollapsed: false } })
    const snapResult = JSON.parse(await snapPromise)
    check('ui_snapshot 工具返回快照 value', snapResult.ok === true && snapResult.value?.count === 2,
      JSON.stringify(snapResult))

    // set_sidebar：boolean 参数必须原样穿过 SSE（false 不能被丢掉）。
    const sidebarPromise = tool.execute({ action: 'set_sidebar', collapsed: false }, execOf('s1'))
    const sidebarFrame = await frameFor('set_sidebar')
    check('set_sidebar 广播 confirm=false（语义动作不确认）', sidebarFrame?.confirm === false, String(sidebarFrame?.confirm))
    check('set_sidebar 的 collapsed=false 原样下发且是布尔',
      sidebarFrame?.actions?.[0]?.params?.collapsed === false, JSON.stringify(sidebarFrame?.actions))
    await respond(sidebarFrame, { ok: true, value: { collapsed: false } })
    const sidebarResult = JSON.parse(await sidebarPromise)
    check('set_sidebar 工具返回 {collapsed:false}',
      sidebarResult.ok === true && sidebarResult.value?.collapsed === false, JSON.stringify(sidebarResult))

    // ui_click：危险动作默认 confirm=true，ref 原样下发。
    const clickPromise = tool.execute({ action: 'ui_click', ref: 'e3' }, execOf('s1'))
    const clickFrame = await frameFor('ui_click')
    check('ui_click 广播 confirm=true', clickFrame?.confirm === true, String(clickFrame?.confirm))
    check('ui_click 的 ref 原样下发', clickFrame?.actions?.[0]?.params?.ref === 'e3',
      JSON.stringify(clickFrame?.actions))
    await respond(clickFrame, { ok: true, value: { clicked: 'e3' } })
    const clickResult = JSON.parse(await clickPromise)
    check('ui_click 工具返回 ok', clickResult.ok === true && clickResult.value?.clicked === 'e3',
      JSON.stringify(clickResult))

    // ui_type：ref + text，trim 后下发；默认确认。
    const typePromise = tool.execute({ action: 'ui_type', ref: ' e4 ', text: '  你好  ' }, execOf('s1'))
    const typeFrame = await frameFor('ui_type')
    check('ui_type 广播 confirm=true', typeFrame?.confirm === true, String(typeFrame?.confirm))
    check('ui_type 参数 trim 后下发',
      typeFrame?.actions?.[0]?.params?.ref === 'e4' && typeFrame?.actions?.[0]?.params?.text === '你好',
      JSON.stringify(typeFrame?.actions))
    await respond(typeFrame, { ok: true, value: { typed: true } })
    const typeResult = JSON.parse(await typePromise)
    check('ui_type 工具返回 ok', typeResult.ok === true && typeResult.value?.typed === true, JSON.stringify(typeResult))

    // ui_key：组合键字符串原样下发（由客户端 parseKeySpec 解析/派发）。
    const keyPromise = tool.execute({ action: 'ui_key', key: 'Ctrl+K' }, execOf('s1'))
    const keyFrame = await frameFor('ui_key')
    check('ui_key 广播 confirm=true 且 key 原样下发',
      keyFrame?.confirm === true && keyFrame?.actions?.[0]?.params?.key === 'Ctrl+K',
      JSON.stringify(keyFrame))
    await respond(keyFrame, { ok: true, value: { pressed: 'Ctrl+K' } })
    const keyResult = JSON.parse(await keyPromise)
    check('ui_key 工具返回 ok', keyResult.ok === true && keyResult.value?.pressed === 'Ctrl+K', JSON.stringify(keyResult))

    // open_plugins：无参数、语义动作不确认。
    const pluginsPromise = tool.execute({ action: 'open_plugins' }, execOf('s1'))
    const pluginsFrame = await frameFor('open_plugins')
    check('open_plugins 广播 confirm=false', pluginsFrame?.confirm === false, String(pluginsFrame?.confirm))
    await respond(pluginsFrame, { ok: true, value: { opened: true } })
    const pluginsResult = JSON.parse(await pluginsPromise)
    check('open_plugins 工具返回 ok', pluginsResult.ok === true && pluginsResult.value?.opened === true,
      JSON.stringify(pluginsResult))
  } finally {
    sse.close()
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 9c. 卸载清理：在途工具调用立刻收尾（不留悬挂定时器/ghost 回执）==')
{
  const host = makeHost({ rowConfig: { uiControl: true, globalVoice: true } })
  const tool = host.toolDefs[0]
  const sse = connectSse(host)
  const startedAt = Date.now()
  try {
    const promise = tool.execute({ action: 'toggle_sidebar' }, execOf('s1'))
    const frame = await waitFor(() => parseSse(sse.raw()).find((item) => item.event === 'ui-action'))
    check('卸载前动作已在途（有 requestId）', typeof frame?.payload?.requestId === 'string')

    host.disposeAll()
    const result = JSON.parse(await promise)
    const elapsed = Date.now() - startedAt
    check('卸载遍历 pending：工具立刻返回 ui_timeout（不是等 20 秒）',
      result.ok === false && result.error === 'ui_timeout', JSON.stringify(result))
    check('卸载收尾是即时的（< 2s）', elapsed < 2000, String(elapsed))
    // pending 已被清掉：迟到回执应 404（不会 resolve 两次/误判成功）。
    const lateAck = await callRoute(host, '/dsh-voice-typing/ui-action-result', 'POST', JSON.stringify({
      requestId: frame?.payload?.requestId, ok: true, value: { late: true },
    }))
    check('卸载后迟到回执 → 404 unknown requestId', lateAck.status === 404, JSON.stringify(lateAck.body))
  } finally {
    sse.close()
    host.disposeAll()
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 10. /diagnostics 新增字段职责分离 ==')
{
  const host = makeHost()
  const diag = await callRoute(host, '/dsh-voice-typing/diagnostics', 'GET')
  check('诊断 200', diag.status === 200)
  check('诊断带 voicePrompt 统计（对象）',
    diag.body?.voicePrompt && typeof diag.body.voicePrompt.count === 'number'
      && typeof diag.body.voicePrompt.failures === 'number')
  check('诊断带 uiActions 数组', Array.isArray(diag.body?.uiActions))
  check('诊断带 hotkeyHelper 状态',
    typeof diag.body?.hotkeyHelper?.enabled === 'boolean' && typeof diag.body?.hotkeyHelper?.reason === 'string')
  check('诊断仍带协议版本 3', diag.body?.protocol === 3)
  check('诊断不带 config 本身（职责分离）', !('model' in (diag.body ?? {})))
}

console.log('\n== 9. /transcribe 的语言头解析（白名单 + 退回当前生效语言）==')
{
  check('合法语言头覆盖配置', resolveRequestLanguage('zh', 'en') === 'zh')
  check('带空白的合法值也能识别', resolveRequestLanguage('  JA ', 'auto') === 'ja')
  check('非法语言头退回配置（不是退回 auto）', resolveRequestLanguage('zh-CN', 'en') === 'en')
  check('auto 头退回配置', resolveRequestLanguage('auto', 'zh') === 'zh')
  check('缺失头退回配置', resolveRequestLanguage(undefined, 'zh') === 'zh')
  check('非字符串头退回配置', resolveRequestLanguage(123, 'yue') === 'yue')
  check('空串头退回配置', resolveRequestLanguage('', 'ko') === 'ko')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
