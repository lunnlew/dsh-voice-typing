/**
 * UI 动作协议（客户端镜像，纯函数）—— 与宿主 `lib/ui-action-protocol.js` **逐条同构**。
 *
 * 为什么浏览器侧要再存一份规则：
 *   浏览器模块的 require 只能解析包名，客户端不能 import 宿主模块；
 *   而「模型想做什么动作、参数多长算太长」这条安全边界必须两端各校验一次 ——
 *   宿主在广播前校验（防止幻觉动作下发），渲染器执行前再校验（防止 SSE 被伪造/
 *   重放）。两边规则分叉过一次就会有一端形同虚设，所以测试用同一张用例表
 *   同时跑宿主与客户端两份模块（test/ui-action-protocol.test.mjs）。
 *
 * v2：动作从 8 个扩到 14 个 —— 8 个语义动作 + 6 个 v2 动作
 *   （set_sidebar / open_plugins / ui_snapshot / ui_click / ui_type / ui_key）。
 *   通用 a11y 原语（snapshot + ref）让以后新增界面功能不必再改协议；
 *   但危险边界没有放松：a11y 动作只能操作客户端自己快照并下发过 ref 的元素，
 *   不接受任意 CSS 选择器 / DOM 路径 / JS。
 *
 * 与宿主完全一致的关键约定（改这里必须同步改宿主）：
 *   - 参数默认都是字符串；唯一例外是 `set_sidebar.collapsed`（boolean）——
 *     `false` 是合法值，不能被「空值 = 没传」规则吃掉；
 *   - 不做数字强转；
 *   - 未知的额外参数丢弃，不算错误；
 *   - 空串/纯空白 = 没传，必填缺失返回 `missing_param:<name>`；
 *   - 动作名 trim + 小写归一化；
 *   - `line` 必须是单行（多行会绕开「一次一个动作」的确认/回执语义）。
 *
 * 本文件不依赖浏览器 API，也不依赖 React，Node 里可原生 import。
 */

/** 允许的界面动作（顺序与宿主一致：8 个 v1 语义动作 + 6 个 v2 动作）。 */
export const UI_ACTION_NAMES = [
  'state',
  'list_sessions',
  'switch_session',
  'new_session',
  'run_command',
  'send_prompt',
  'stop_generation',
  'toggle_sidebar',
  'set_sidebar',
  'open_plugins',
  'ui_snapshot',
  'ui_click',
  'ui_type',
  'ui_key',
]

/**
 * 危险动作：会改变用户看到的状态。
 * 是否真的弹确认由 SSE 载荷里的 `confirm` 决定（宿主已叠加 uiConfirm 开关），
 * 客户端只信这个字段 —— 再自己 AND 一次 uiConfirm 会让只读动作也弹框。
 *
 * v2 把 ui_click/ui_type/ui_key 也列为危险：它们等价于用户亲手操作，
 * 误触代价可能比切会话更大。
 */
export const UI_CONFIRM_ACTIONS = [
  'switch_session',
  'new_session',
  'run_command',
  'send_prompt',
  'stop_generation',
  'ui_click',
  'ui_type',
  'ui_key',
]

/** 各参数的长度上限（字符），与宿主完全一致。 */
export const UI_ACTION_LIMITS = {
  text: 4000,
  line: 400,
  sessionId: 200,
  workspaceId: 200,
  ref: 40,
  key: 40,
}

/**
 * 参数类型例外：这些参数是 boolean，而不是字符串。
 * 用集合而不是往 spec 里加字段，是为了让 getUiActionSpec 的返回形状与 v1
 * 保持一致（宿主/客户端镜像都按同样的形状逐条对齐）。
 */
const BOOLEAN_PARAMS = new Set(['collapsed'])

/** 每个动作的参数白名单、必填项与确认标记（与宿主 ACTION_SPECS 同构）。 */
const ACTION_SPECS = {
  state: { action: 'state', params: [], required: [], confirm: false },
  list_sessions: { action: 'list_sessions', params: [], required: [], confirm: false },
  switch_session: { action: 'switch_session', params: ['sessionId'], required: ['sessionId'], confirm: true },
  new_session: { action: 'new_session', params: ['workspaceId'], required: [], confirm: true },
  run_command: { action: 'run_command', params: ['line'], required: ['line'], confirm: true },
  send_prompt: { action: 'send_prompt', params: ['text', 'sessionId'], required: ['text'], confirm: true },
  stop_generation: { action: 'stop_generation', params: ['sessionId'], required: [], confirm: true },
  toggle_sidebar: { action: 'toggle_sidebar', params: [], required: [], confirm: false },
  set_sidebar: { action: 'set_sidebar', params: ['collapsed'], required: ['collapsed'], confirm: false },
  open_plugins: { action: 'open_plugins', params: [], required: [], confirm: false },
  ui_snapshot: { action: 'ui_snapshot', params: [], required: [], confirm: false },
  ui_click: { action: 'ui_click', params: ['ref'], required: ['ref'], confirm: true },
  ui_type: { action: 'ui_type', params: ['ref', 'text'], required: ['ref', 'text'], confirm: true },
  ui_key: { action: 'ui_key', params: ['key'], required: ['key'], confirm: true },
}

// 冻结规格：执行器可能在异步回调里读它，冻结可以防住「某处顺手改了共享规格」。
for (const spec of Object.values(ACTION_SPECS)) {
  Object.freeze(spec.params)
  Object.freeze(spec.required)
  Object.freeze(spec)
}
Object.freeze(ACTION_SPECS)

/** 动作 → 允许的参数名（只读快照，按动作名索引）。 */
export const UI_ACTION_PARAMS = Object.freeze(Object.fromEntries(
  Object.entries(ACTION_SPECS).map(([name, spec]) => [name, spec.params]),
))

/** 动作 → 必填参数名（只读快照）。 */
export const UI_ACTION_REQUIRED = Object.freeze(Object.fromEntries(
  Object.entries(ACTION_SPECS).map(([name, spec]) => [name, spec.required]),
))

/**
 * 动作名归一化：trim + 小写。
 * @param {unknown} value - 动作名。
 * @returns {string} 归一化后的动作名；非字符串返回空串。
 */
function normalizeAction(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

/**
 * 取动作规格。
 * @param {unknown} action - 动作名（大小写/空白不敏感）。
 * @returns {{action:string, params:string[], required:string[], confirm:boolean}|null}
 *   只读规格对象；未知动作返回 null。
 */
export function getUiActionSpec(action) {
  const name = normalizeAction(action)
  return Object.prototype.hasOwnProperty.call(ACTION_SPECS, name) ? ACTION_SPECS[name] : null
}

/**
 * 这个动作本身是否需要用户确认（不含 uiConfirm 开关）。
 * @param {unknown} action - 动作名。
 * @returns {boolean} 未知动作返回 false。
 */
export function actionNeedsConfirm(action) {
  const name = normalizeAction(action)
  return UI_CONFIRM_ACTIONS.includes(name)
}

/**
 * 校验并归一化动作参数。
 *
 * @param {unknown} action - 动作名。
 * @param {unknown} params - 参数对象；非对象/null 当空对象处理。
 * @returns {{ok:true, action:string, params:object} | {ok:false, error:string}}
 *   error 取值：`unknown_action` / `missing_param:<name>` /
 *   `param_too_long:<name>` / `invalid_param:<name>`。
 */
export function validateUiAction(action, params) {
  const spec = getUiActionSpec(action)
  if (!spec) return { ok: false, error: 'unknown_action' }
  const source = params && typeof params === 'object' && !Array.isArray(params) ? params : {}
  const out = {}
  for (const name of spec.params) {
    const raw = source[name]
    // boolean 参数单独处理：false 是合法值，不能走「空串 = 没传」那条路。
    if (BOOLEAN_PARAMS.has(name)) {
      if (raw === undefined || raw === null) {
        if (spec.required.includes(name)) return { ok: false, error: `missing_param:${name}` }
        continue
      }
      if (typeof raw !== 'boolean') return { ok: false, error: `invalid_param:${name}` }
      out[name] = raw
      continue
    }
    // 「没传」只认 undefined/null：空串是「传了但没内容」——
    // 必填报 missing，可选项丢弃（不往动作里塞空串）。
    if (raw === undefined || raw === null) {
      if (spec.required.includes(name)) return { ok: false, error: `missing_param:${name}` }
      continue
    }
    if (typeof raw !== 'string') {
      // 不做强转：参数全是字符串，传错类型说明模型理解错了动作。
      return { ok: false, error: `invalid_param:${name}` }
    }
    const text = raw.trim()
    if (!text) {
      if (spec.required.includes(name)) return { ok: false, error: `missing_param:${name}` }
      continue
    }
    if (name === 'line' && /[\r\n]/.test(text)) return { ok: false, error: `invalid_param:${name}` }
    const maxLen = UI_ACTION_LIMITS[name]
    if (typeof maxLen === 'number' && text.length > maxLen) {
      return { ok: false, error: `param_too_long:${name}` }
    }
    out[name] = text
  }
  return { ok: true, action: spec.action, params: out }
}

/**
 * 给人看的一句话动作描述（确认条标题/诊断用，不含完整文本）。
 * @param {unknown} action - 动作名。
 * @param {unknown} [params] - 参数对象。
 * @returns {string} 例如 `switch_session: abc123`、`set_sidebar: true`；
 *   没有可展示参数时只返回动作名；未知动作返回 `unknown:<原值>`。
 */
export function describeUiAction(action, params) {
  const spec = getUiActionSpec(action)
  if (!spec) return `unknown:${String(action ?? '')}`
  const source = params && typeof params === 'object' && !Array.isArray(params) ? params : {}
  for (const name of spec.params) {
    const value = source[name]
    // boolean 参数（set_sidebar.collapsed）也要能显示方向，否则确认条只有动作名。
    if (typeof value === 'boolean') return `${spec.action}: ${value}`
    if (typeof value === 'string' && value.trim()) {
      return `${spec.action}: ${value.trim().slice(0, 60)}`
    }
  }
  return spec.action
}

/**
 * 拼 SSE `ui-action` 载荷（客户端测试/回放用；宿主有同名实现）。
 *
 * `expiresAt` 是宿主的**动作截止时间**（epoch ms）：宿主工具大约 20 秒后就会
 * 超时失败，客户端必须在这之前决定是否执行 —— 否则用户在确认条上迟到的
 * 「允许」会执行一个宿主早已判失败的动作（ghost action，评审 P2-1）。
 * 非有限数字（缺失/NaN/字符串）时省略该字段，保持对旧宿主的兼容。
 *
 * @param {object} input - {requestId, sessionId, action, params, confirm, expiresAt}
 * @returns {{requestId:string, sessionId:string|null, actions:Array, confirm:boolean, expiresAt?:number}}
 */
export function buildUiActionPayload({ requestId, sessionId, action, params, confirm, expiresAt } = {}) {
  const spec = getUiActionSpec(action)
  return {
    requestId: typeof requestId === 'string' ? requestId : '',
    sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
    actions: [{
      action: spec ? spec.action : String(action ?? ''),
      params: params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {},
    }],
    confirm: confirm === true,
    // 与宿主同构：只在有限数字时带上（JSON.stringify 会丢掉 undefined）。
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
  }
}

/**
 * 这个 `ui-action` 载荷是否已经超过宿主的截止时间。
 *
 * 边界约定（评审要求）：`now === expiresAt` **不算**过期（用户还有最后一刻的
 * 机会）；只有严格大于才算。缺失/非法 expiresAt（旧宿主）一律返回 false ——
 * 不能因为字段缺失就拒绝所有动作。
 *
 * @param {object} payload - SSE `ui-action` 载荷（或信封）。
 * @param {number} [now] - 当前时间戳（测试注入；默认 Date.now()）。
 * @returns {boolean} 是否已过期。
 */
export function isUiActionExpired(payload, now = Date.now()) {
  const expiresAt = payload?.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false
  const current = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  return current > expiresAt
}

/**
 * 校验要发给 `POST /ui-action-result` 的回执体。
 *
 * 客户端在 POST 前跑一遍：字段写错（比如 ok 不是布尔）时立刻按 `invalid_*`
 * 回退成本地错误，而不是让宿主 400 之后把这次动作当成「成功但没结果」。
 *
 * @param {unknown} payload - {requestId, ok, value?, error?}。
 * @returns {{ok:true, value:{requestId:string, ok:boolean, value?:*, error?:string}} |
 *   {ok:false, error:string}}
 */
export function validateUiActionResult(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'invalid_payload' }
  }
  if (typeof payload.requestId !== 'string' || !payload.requestId.trim()) {
    return { ok: false, error: 'invalid_requestId' }
  }
  const requestId = payload.requestId.trim()
  if (requestId.length > UI_ACTION_LIMITS.sessionId) return { ok: false, error: 'invalid_requestId' }
  if (typeof payload.ok !== 'boolean') return { ok: false, error: 'invalid_ok' }
  const value = { requestId, ok: payload.ok }
  if (payload.value !== undefined) value.value = payload.value
  if (payload.error !== undefined) {
    if (typeof payload.error !== 'string') return { ok: false, error: 'invalid_error' }
    value.error = payload.error.trim().slice(0, 500)
  }
  return { ok: true, value }
}
