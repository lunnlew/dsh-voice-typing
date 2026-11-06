/**
 * UI 动作协议 —— **单源**实现（宿主工具/SSE 与客户端执行器共用这一份规则）。
 *
 * 这条判据回答三个问题：**允许哪些动作**、**每个动作要哪些参数/多长算太长**、
 * **要不要用户确认**。宿主在广播 `ui-action` **之前**校验一次（挡住模型幻觉动作），
 * 渲染器执行**之前**再校验一次（挡住被伪造/重放的 SSE）—— 两端各校验是设计，
 * 但「校验规则」必须只有一份。
 *
 * 为什么只有一份（第 3 步 3.2 之前是两份）：
 *   旧状态是 `lib/ui-action-protocol.js` + `src/client/pure/ui-action-protocol.js`
 *   两份逐条同构的镜像，靠 `test/ui-action-protocol.test.mjs` 的一张用例表同时跑两端来防分叉。
 *   那种测试只能**事后**报警；而这条判据本来就不需要两份 —— 浏览器侧不能 `require` 宿主模块
 *   是宿主对**产物**的要求（require 只认包名），不是对**源码**的要求，
 *   构建期由 esbuild 把这里合进单文件产物即可。现在两个入口
 *   （`lib/ui-action-protocol.js`、`src/client/pure/ui-action-protocol.js`）都只做转发。
 *
 * 环境约束（`src/shared/*` 的共同规矩，由 `test/bundle-sync.test.mjs` 机械守卫）：
 *   纯 ESM、零浏览器全局、零 Node API、零 React。宿主直接 `import`，
 *   浏览器侧经 `src/client/pure/ui-action-protocol.js` 引入后在构建期合并。
 *   与门限（`src/shared/gate.js`）不同，这条判据**两侧常数为零** ——
 *   动作白名单、参数上限、确认策略在两端必须一模一样，所以没有 `createXxx(defaults)` 注入。
 *
 * 约定（两端必须一致，改这里等于同时改两端）：
 *   - 参数默认都是字符串；**唯一例外**是 `set_sidebar.collapsed`（boolean）——
 *     布尔必须原样保留 `false`，不能被「空值丢弃」逻辑吃掉；
 *   - 不做数字强转：界面动作没有数字参数，悄悄强转只会让「传错类型」
 *     变成「看起来能跑」；
 *   - 未知的额外参数**丢弃**（模型多传字段不应让整个动作失败）；
 *   - 空串/纯空白 = 没传；必填缺失返回 `missing_param:<name>`；
 *   - `line` 必须是单行（多行会绕开「一次一个动作」的确认/回执语义）；
 *   - 动作名 trim + 小写归一化（模型偶尔会写 `Switch_Session`）。
 *
 * v2 为什么扩到 14 个动作：
 *   v1 的「一个界面功能一个动作」不可扩展 —— 以后每加一个界面就要改协议、
 *   宿主、客户端三处。v2 增加通用 a11y 原语（ui_snapshot / ui_click /
 *   ui_type / ui_key）后，新界面功能**不需要再改协议**；同时把「侧栏」
 *   「插件页」这类高频语义补成独立动作，避免模型靠猜 toggle。
 *   安全边界没有放松：a11y 动作只能操作**宿主自己快照出来并下发过 ref**
 *   的元素，不接受任意 CSS 选择器/DOM 路径/JS。
 */

/**
 * 允许的界面动作（顺序即提示词里的动作表顺序）。
 *
 * v1 的 8 个语义动作 + v2 的 6 个通用/语义动作（见 v2 契约）。
 * 为什么保留语义动作：模型说「收起侧栏/打开插件页」时，直接调
 * `set_sidebar`/`open_plugins` 比「遍历快照找按钮再点」稳定得多；
 * a11y 原语只用于语义动作覆盖不到的界面。
 */
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
 * 开启 `uiConfirm`（默认开）时必须由浮层弹确认，用户拒绝则回执 `confirm_denied`。
 *
 * v2 把三个 a11y 动作（ui_click/ui_type/ui_key）也列为危险：
 * 它们能点到任意按钮、往输入框里打字、发送组合键 —— 效果上等价于
 * 用户亲手操作，误触代价可能比「切会话」更大。
 * 只读动作（state/list_sessions/toggle_sidebar/ui_snapshot）与语义导航
 * （set_sidebar/open_plugins）不在此列：它们不改数据，多一步确认只会让
 * 语音操控变得不可用。
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

/** 各参数的长度上限（字符）。超长直接拒绝，不做截断 —— 静默截断会发出半句话。 */
export const UI_ACTION_LIMITS = {
  text: 4000,
  line: 400,
  sessionId: 200,
  workspaceId: 200,
  // v2：a11y 快照下发的元素句柄（形如 e12）与按键描述（如 Ctrl+K）都很短，
  // 给 40 足够，同时挡住「把 CSS 选择器/HTML 当 ref 传」这类误用。
  ref: 40,
  key: 40,
}

/**
 * 参数类型例外：这些参数是 boolean，而不是字符串。
 *
 * 只放 `collapsed`：布尔 false 是合法值，不能被「空值 = 没传」规则吃掉；
 * 用集合而不是往 spec 里加字段，是为了让 getUiActionSpec 的返回形状
 * 与 v1 保持一致（`getUiActionSpec` 的返回形状两端都在读，别为一个个参数加字段）。
 */
const BOOLEAN_PARAMS = new Set(['collapsed'])

/**
 * 每个动作的参数白名单与必填项。
 *
 * `params` 允许出现；`required` 里没有默认值的必须由模型给出。
 * 动作表同时是系统提示词与客户端执行器的依据（两端读的是这一份）。
 * `confirm` 与 UI_CONFIRM_ACTIONS 保持一致（冗余存一份方便直接读 spec）。
 */
const ACTION_SPECS = {
  state: { action: 'state', params: [], required: [], confirm: false },
  list_sessions: { action: 'list_sessions', params: [], required: [], confirm: false },
  switch_session: { action: 'switch_session', params: ['sessionId'], required: ['sessionId'], confirm: true },
  new_session: { action: 'new_session', params: ['workspaceId'], required: [], confirm: true },
  // run_command 的 line 由客户端交给会话命令执行（如 /compact）；
  // 单行限制：多行命令行不是合法命令，且会绕开「一次一个动作」的确认语义。
  run_command: { action: 'run_command', params: ['line'], required: ['line'], confirm: true },
  send_prompt: { action: 'send_prompt', params: ['text', 'sessionId'], required: ['text'], confirm: true },
  stop_generation: { action: 'stop_generation', params: ['sessionId'], required: [], confirm: true },
  toggle_sidebar: { action: 'toggle_sidebar', params: [], required: [], confirm: false },
  // v2 新增：语义动作（不靠 toggle 猜方向，也不靠遍历快照点按钮）。
  set_sidebar: { action: 'set_sidebar', params: ['collapsed'], required: ['collapsed'], confirm: false },
  open_plugins: { action: 'open_plugins', params: [], required: [], confirm: false },
  // v2 新增：通用 a11y 原语（ref 只能来自最近一次 ui_snapshot）。
  ui_snapshot: { action: 'ui_snapshot', params: [], required: [], confirm: false },
  ui_click: { action: 'ui_click', params: ['ref'], required: ['ref'], confirm: true },
  ui_type: { action: 'ui_type', params: ['ref', 'text'], required: ['ref', 'text'], confirm: true },
  ui_key: { action: 'ui_key', params: ['key'], required: ['key'], confirm: true },
}

/** 冻结规格，防止调用方改到共享对象上（诊断/兜底逻辑会读它）。 */
for (const spec of Object.values(ACTION_SPECS)) {
  Object.freeze(spec.params)
  Object.freeze(spec.required)
  Object.freeze(spec)
}
Object.freeze(ACTION_SPECS)

/**
 * 动作 → 允许的参数名（只读快照，按动作名索引）。
 * 客户端执行器与提示词生成都用它，避免各处再维护一份「哪些参数合法」。
 */
export const UI_ACTION_PARAMS = Object.freeze(Object.fromEntries(
  Object.entries(ACTION_SPECS).map(([name, spec]) => [name, spec.params]),
))

/** 动作 → 必填参数名（只读快照）。 */
export const UI_ACTION_REQUIRED = Object.freeze(Object.fromEntries(
  Object.entries(ACTION_SPECS).map(([name, spec]) => [name, spec.required]),
))

/**
 * 动作名归一化：trim + 小写。
 * @param {unknown} value - 模型/客户端给的动作名。
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
 * 这个动作是否需要用户确认（只回答「这个动作本身危不危险」）。
 *
 * 是否**真的**弹确认还要叠加用户的 `uiConfirm` 开关：
 *   `actionNeedsConfirm(action) && config.uiConfirm !== false`
 *
 * @param {unknown} action - 动作名。
 * @returns {boolean} 未知动作返回 false（未知动作本来就会被校验拒绝）。
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
 * @returns {{ok:true, action:string, params:object} |
 *   {ok:false, error:string}} 校验结果。
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
    // 「没传」只认 undefined/null：空串与纯空白是「传了但没内容」，
    // 必填项要报 missing，可选项直接丢弃（不要往 SSE 里塞空串）。
    if (raw === undefined || raw === null) {
      if (spec.required.includes(name)) return { ok: false, error: `missing_param:${name}` }
      continue
    }
    if (typeof raw !== 'string') {
      // 不做数字/布尔强转：字符串参数传错类型说明模型理解错了动作，
      // 静默强转会让错误看起来像成功。
      return { ok: false, error: `invalid_param:${name}` }
    }
    const text = raw.trim()
    if (!text) {
      if (spec.required.includes(name)) return { ok: false, error: `missing_param:${name}` }
      continue
    }
    // 命令行必须是单行：多行会绕开「一次一个动作」的确认/回执语义。
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
 * 给人看的一句话动作描述（确认条标题/诊断/日志用，不含完整文本）。
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
      // 截断只影响展示，不改变实际参数。
      return `${spec.action}: ${value.trim().slice(0, 60)}`
    }
  }
  return spec.action
}

/**
 * 拼 SSE `ui-action` 载荷（宿主工具发出前调用；参数应先经 validateUiAction）。
 *
 * confirm 是**生效值**而不是用户开关原值：
 *   只读动作永远 false，危险动作才由 `uiConfirm` 决定 ——
 *   渲染器直接信这个字段即可，不必再自己叠加开关（否则 state 也会弹确认）。
 *
 * `expiresAt`（v3 修复 ghost action）：
 *   宿主等待回执的截止时间（epoch ms），与工具超时**同一个 deadline**。
 *   客户端据此拒绝「宿主已经超时、用户 20 秒后才点允许」的迟到执行 ——
 *   否则模型已经收到失败，界面却真的发了一条消息/执行了命令。
 *   字段顺序固定为 requestId/sessionId/actions/confirm/expiresAt（双端同构），
 *   非法/缺失时省略该字段（JSON 序列化后老客户端完全看不到差异）。
 *
 * @param {object} input - {requestId, sessionId, action, params, confirm, expiresAt}
 * @returns {{requestId:string, sessionId:string|null, actions:Array, confirm:boolean, expiresAt?:number}}
 *   SSE 载荷（信封由宿主 broadcast 统一加）。
 */
export function buildUiActionPayload({ requestId, sessionId, action, params, confirm, expiresAt } = {}) {
  const spec = getUiActionSpec(action)
  const payload = {
    requestId: typeof requestId === 'string' ? requestId : '',
    sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
    actions: [{
      action: spec ? spec.action : String(action ?? ''),
      params: params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {},
    }],
    confirm: confirm === true,
  }
  // 只在是有限数字时带上：NaN/字符串/缺失都不写 —— 老客户端看不到这个字段也不该出错。
  if (Number.isFinite(expiresAt)) payload.expiresAt = expiresAt
  return payload
}

/**
 * 载荷是否已经过期（宿主下发的 `expiresAt` 已过）。
 *
 * 语义（宿主与客户端共用这一份实现）：
 *   - 缺失/非有限数字（老宿主/非法值）→ false（不能因为没字段就拒绝执行）；
 *   - now === expiresAt → false（边界时刻仍允许）；
 *   - now > expiresAt → true。
 *
 * @param {unknown} payload - ui-action 载荷（或任意带 expiresAt 的对象）。
 * @param {number} [now] - 当前时间（epoch ms；测试可注入）。
 * @returns {boolean} 是否已过期。
 */
export function isUiActionExpired(payload, now = Date.now()) {
  const expiresAt = payload && typeof payload === 'object' ? payload.expiresAt : undefined
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false
  const current = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  return current > expiresAt
}

/**
 * 校验 `POST /ui-action-result` 的请求体。
 *
 * 客户端执行完动作必须回执；回执字段错了要 400（不要把它当成一次
 * 「成功但没结果」—— 那会让工具以为动作做完了）。
 *
 * @param {unknown} payload - 解析后的 JSON 请求体。
 * @returns {{ok:true, value:{requestId:string, ok:boolean, value?:*, error?:string}} |
 *   {ok:false, error:string}} 校验结果；error 取值 `invalid_payload` /
 *   `invalid_requestId` / `invalid_ok` / `invalid_error`。
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
    // 错误信息只用于展示/回传模型，限长防止回执把整段 DOM/堆栈塞进来。
    value.error = payload.error.trim().slice(0, 500)
  }
  return { ok: true, value }
}
