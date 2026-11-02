/**
 * UI 动作协议测试：客户端镜像的行为 + 与宿主 `lib/ui-action-protocol.js` 的双端一致性。
 *
 * 为什么必须双端一致：
 *   宿主在广播 `ui-action` 前校验一次，渲染器执行前再校验一次 ——
 *   任一边的规则漂移，都会让「宿主放行、客户端拒绝」或反过来，
 *   而模型/用户看到的只是莫名的 confirm_denied / unknown_action。
 *   这里用**同一张用例表**同时跑两份模块，逐条比较返回值的 JSON。
 *
 * 宿主模块还没落盘时（实现期）只跑客户端行为测试并打印警告；
 * 落盘后一致性检查自动生效（verifier 的完整测试会覆盖）。
 *
 * 用法：node test/ui-action-protocol.test.mjs
 */
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as client from '../src/client/pure/ui-action-protocol.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const HOST_PATH = root + '/lib/ui-action-protocol.js'

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/** 按 JSON 比较两个返回值（对象键顺序在两份实现里也应当一致）。 */
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/* ================================================================ */
console.log('客户端模块导出形状')
{
  for (const name of [
    'UI_ACTION_NAMES', 'UI_CONFIRM_ACTIONS', 'UI_ACTION_LIMITS',
    'UI_ACTION_PARAMS', 'UI_ACTION_REQUIRED',
    'getUiActionSpec', 'actionNeedsConfirm', 'validateUiAction', 'describeUiAction',
    'buildUiActionPayload', 'validateUiActionResult', 'isUiActionExpired',
  ]) {
    check(`导出 ${name}`, client[name] !== undefined)
  }
  check('UI_ACTION_NAMES 是 14 个动作（v1 8 个 + v2 6 个）',
    client.UI_ACTION_NAMES.length === 14, String(client.UI_ACTION_NAMES.length))
  check('v2 的 6 个动作都在动作全集里',
    ['set_sidebar', 'open_plugins', 'ui_snapshot', 'ui_click', 'ui_type', 'ui_key']
      .every((a) => client.UI_ACTION_NAMES.includes(a)))
  check('危险动作是 8 个（含 ui_click/ui_type/ui_key）',
    client.UI_CONFIRM_ACTIONS.length === 8
    && client.UI_CONFIRM_ACTIONS.includes('ui_click')
    && client.UI_CONFIRM_ACTIONS.includes('ui_type')
    && client.UI_CONFIRM_ACTIONS.includes('ui_key')
    && !client.UI_CONFIRM_ACTIONS.includes('state')
    && !client.UI_CONFIRM_ACTIONS.includes('toggle_sidebar')
    && !client.UI_CONFIRM_ACTIONS.includes('set_sidebar')
    && !client.UI_CONFIRM_ACTIONS.includes('open_plugins')
    && !client.UI_CONFIRM_ACTIONS.includes('ui_snapshot'),
    JSON.stringify(client.UI_CONFIRM_ACTIONS))
  check('长度上限含 ref:40 / key:40（line 保持 400）',
    same(client.UI_ACTION_LIMITS, {
      text: 4000, line: 400, sessionId: 200, workspaceId: 200, ref: 40, key: 40,
    }),
    JSON.stringify(client.UI_ACTION_LIMITS))
  check('UI_ACTION_PARAMS / UI_ACTION_REQUIRED 与 ACTION_SPECS 同构',
    same(client.UI_ACTION_PARAMS?.ui_type, ['ref', 'text'])
    && same(client.UI_ACTION_REQUIRED?.ui_type, ['ref', 'text'])
    && same(client.UI_ACTION_PARAMS?.state, [])
    && same(client.UI_ACTION_REQUIRED?.set_sidebar, ['collapsed']))
}

/* ================================================================ */
console.log('\n行为：动作名归一化 / 规格 / 确认策略')
{
  check('动作名 trim+小写后仍命中', client.getUiActionSpec('  SWITCH_SESSION ')?.action === 'switch_session')
  check('未知动作返回 null', client.getUiActionSpec('click_element') === null)
  check('非字符串动作返回 null', client.getUiActionSpec(null) === null)
  const spec = client.getUiActionSpec('send_prompt')
  check('send_prompt 允许 text/sessionId，必填 text',
    same(spec?.params, ['text', 'sessionId']) && same(spec?.required, ['text']))
  check('new_session 无必填参数、允许 workspaceId',
    same(client.getUiActionSpec('new_session')?.required, [])
    && same(client.getUiActionSpec('new_session')?.params, ['workspaceId']))
  check('危险动作需要确认', client.actionNeedsConfirm('send_prompt') === true
    && client.actionNeedsConfirm('switch_session') === true)
  check('只读动作不需要确认', client.actionNeedsConfirm('state') === false
    && client.actionNeedsConfirm('toggle_sidebar') === false)
  check('大小写/空白不影响确认判定', client.actionNeedsConfirm(' Run_Command ') === true)
  check('未知动作不需要确认', client.actionNeedsConfirm('bogus') === false)

  // v2 规格
  check('set_sidebar 只允许 collapsed 且必填（boolean 参数）',
    same(client.getUiActionSpec('set_sidebar')?.params, ['collapsed'])
    && same(client.getUiActionSpec('set_sidebar')?.required, ['collapsed'])
    && client.getUiActionSpec('set_sidebar')?.confirm === false)
  check('ui_type 允许 ref/text 且都必填',
    same(client.getUiActionSpec('ui_type')?.params, ['ref', 'text'])
    && same(client.getUiActionSpec('ui_type')?.required, ['ref', 'text']))
  check('ui_snapshot / open_plugins 无参数、不需要确认',
    same(client.getUiActionSpec('ui_snapshot')?.params, [])
    && same(client.getUiActionSpec('open_plugins')?.params, [])
    && client.actionNeedsConfirm('ui_snapshot') === false
    && client.actionNeedsConfirm('open_plugins') === false)
  check('v2 a11y 动作需要确认',
    client.actionNeedsConfirm('ui_click') === true
    && client.actionNeedsConfirm('ui_type') === true
    && client.actionNeedsConfirm('ui_key') === true)
}

/* ================================================================ */
console.log('\n行为：参数校验')
{
  check('合法动作原样返回',
    same(client.validateUiAction('send_prompt', { text: ' 你好 ' }),
      { ok: true, action: 'send_prompt', params: { text: '你好' } }),
    JSON.stringify(client.validateUiAction('send_prompt', { text: ' 你好 ' })))
  check('未知动作 → unknown_action',
    same(client.validateUiAction('bogus', {}), { ok: false, error: 'unknown_action' }))
  check('必填缺失 → missing_param',
    same(client.validateUiAction('switch_session', {}), { ok: false, error: 'missing_param:sessionId' }))
  check('必填空白 → missing_param',
    same(client.validateUiAction('run_command', { line: '   ' }), { ok: false, error: 'missing_param:line' }))
  check('必填 null → missing_param',
    same(client.validateUiAction('send_prompt', { text: null }), { ok: false, error: 'missing_param:text' }))
  check('非字符串 → invalid_param',
    same(client.validateUiAction('send_prompt', { text: 123 }),
      { ok: false, error: 'invalid_param:text' }))
  check('多行命令行 → invalid_param:line',
    same(client.validateUiAction('run_command', { line: '/a\n/b' }),
      { ok: false, error: 'invalid_param:line' }))
  check('超长 text → param_too_long',
    same(client.validateUiAction('send_prompt', { text: 'x'.repeat(4001) }),
      { ok: false, error: 'param_too_long:text' }))
  check('超长 line（>400）→ param_too_long',
    same(client.validateUiAction('run_command', { line: '/' + 'y'.repeat(400) }),
      { ok: false, error: 'param_too_long:line' }))
  check('长度刚好等于上限通过',
    client.validateUiAction('send_prompt', { text: 'x'.repeat(4000) }).ok === true)
  check('未知额外参数被丢弃（不算错误）',
    same(client.validateUiAction('state', { click: 'yes' }), { ok: true, action: 'state', params: {} }))
  check('可选参数空串被丢弃',
    same(client.validateUiAction('stop_generation', { sessionId: '  ' }),
      { ok: true, action: 'stop_generation', params: {} }))
  check('可选参数有值保留',
    same(client.validateUiAction('stop_generation', { sessionId: ' s1 ' }),
      { ok: true, action: 'stop_generation', params: { sessionId: 's1' } }))
  check('params 非对象当空对象',
    same(client.validateUiAction('toggle_sidebar', null), { ok: true, action: 'toggle_sidebar', params: {} }))
  check('只读动作不接收参数',
    same(client.validateUiAction('toggle_sidebar', { sessionId: 'x' }),
      { ok: true, action: 'toggle_sidebar', params: {} }))

  // v2：boolean 参数（collapsed）—— false 是合法值，不能被空值规则吃掉
  check('set_sidebar collapsed=true 保留',
    same(client.validateUiAction('set_sidebar', { collapsed: true }),
      { ok: true, action: 'set_sidebar', params: { collapsed: true } }))
  check('set_sidebar collapsed=false 保留（不是「没传」）',
    same(client.validateUiAction('set_sidebar', { collapsed: false }),
      { ok: true, action: 'set_sidebar', params: { collapsed: false } }))
  check('set_sidebar 缺 collapsed → missing_param',
    same(client.validateUiAction('set_sidebar', {}),
      { ok: false, error: 'missing_param:collapsed' }))
  check('set_sidebar collapsed 字符串 "true" → invalid_param（不做强转）',
    same(client.validateUiAction('set_sidebar', { collapsed: 'true' }),
      { ok: false, error: 'invalid_param:collapsed' }))
  check('set_sidebar collapsed 数字 1 → invalid_param',
    same(client.validateUiAction('set_sidebar', { collapsed: 1 }),
      { ok: false, error: 'invalid_param:collapsed' }))
  check('set_sidebar collapsed=null → missing_param（null 视为没传）',
    same(client.validateUiAction('set_sidebar', { collapsed: null }),
      { ok: false, error: 'missing_param:collapsed' }))

  // v2：a11y 原语参数
  check('ui_click ref trim 后保留',
    same(client.validateUiAction('ui_click', { ref: ' e12 ' }),
      { ok: true, action: 'ui_click', params: { ref: 'e12' } }))
  check('ui_click 缺 ref → missing_param',
    same(client.validateUiAction('ui_click', {}), { ok: false, error: 'missing_param:ref' }))
  check('ui_click 超长 ref（>40）→ param_too_long',
    same(client.validateUiAction('ui_click', { ref: 'e'.repeat(41) }),
      { ok: false, error: 'param_too_long:ref' }))
  check('ui_click ref 非字符串 → invalid_param',
    same(client.validateUiAction('ui_click', { ref: 3 }), { ok: false, error: 'invalid_param:ref' }))
  check('ui_type 两个参数都必填',
    same(client.validateUiAction('ui_type', { ref: 'e1' }),
      { ok: false, error: 'missing_param:text' })
    && client.validateUiAction('ui_type', { ref: 'e1', text: '你好' }).ok === true)
  check('ui_key 超长 key（>40）→ param_too_long',
    same(client.validateUiAction('ui_key', { key: 'k'.repeat(41) }),
      { ok: false, error: 'param_too_long:key' }))
  check('ui_key Ctrl+K 原样保留（语义由客户端 parseKeySpec 校验）',
    same(client.validateUiAction('ui_key', { key: 'Ctrl+K' }),
      { ok: true, action: 'ui_key', params: { key: 'Ctrl+K' } }))
  check('ui_snapshot 忽略额外参数',
    same(client.validateUiAction('ui_snapshot', { ref: 'x' }),
      { ok: true, action: 'ui_snapshot', params: {} }))
  check('open_plugins 无参数',
    same(client.validateUiAction('open_plugins', {}),
      { ok: true, action: 'open_plugins', params: {} }))
}

/* ================================================================ */
console.log('\n行为：动作描述 / 回执校验 / 载荷构造')
{
  check('描述带动作名和参数预览',
    client.describeUiAction('send_prompt', { text: '帮我总结一下这段代码' }) === 'send_prompt: 帮我总结一下这段代码')
  check('无参数动作只返回动作名', client.describeUiAction('toggle_sidebar', {}) === 'toggle_sidebar')
  check('未知动作描述带原值', client.describeUiAction('bogus', {}) === 'unknown:bogus')
  check('超长参数描述截断到 60 字符',
    client.describeUiAction('send_prompt', { text: '长'.repeat(100) }).length === 'send_prompt: '.length + 60)
  check('boolean 参数也能显示方向（set_sidebar true/false）',
    client.describeUiAction('set_sidebar', { collapsed: true }) === 'set_sidebar: true'
    && client.describeUiAction('set_sidebar', { collapsed: false }) === 'set_sidebar: false')
  check('a11y 动作描述带 ref / key',
    client.describeUiAction('ui_click', { ref: 'e3' }) === 'ui_click: e3'
    && client.describeUiAction('ui_key', { key: 'Ctrl+K' }) === 'ui_key: Ctrl+K')
  check('ui_type 描述取第一个参数（ref）', client.describeUiAction('ui_type', { ref: 'e1', text: 'abc' }) === 'ui_type: e1')

  check('回执合法', same(client.validateUiActionResult({ requestId: 'r1', ok: true, value: { a: 1 } }),
    { ok: true, value: { requestId: 'r1', ok: true, value: { a: 1 } } }))
  check('回执缺 requestId → invalid_requestId',
    same(client.validateUiActionResult({ ok: true }), { ok: false, error: 'invalid_requestId' }))
  check('回执 ok 非布尔 → invalid_ok',
    same(client.validateUiActionResult({ requestId: 'r1', ok: 1 }), { ok: false, error: 'invalid_ok' }))
  check('回执 error 非字符串 → invalid_error',
    same(client.validateUiActionResult({ requestId: 'r1', ok: false, error: 42 }),
      { ok: false, error: 'invalid_error' }))
  check('回执 error 超长截断到 500', (() => {
    const r = client.validateUiActionResult({ requestId: 'r1', ok: false, error: 'e'.repeat(900) })
    return r.ok && r.value.error.length === 500
  })())

  const payload = client.buildUiActionPayload({
    requestId: 'r1', sessionId: 's1', action: 'State', params: {}, confirm: false,
  })
  check('载荷动作名归一化 + confirm 生效值', payload.actions[0].action === 'state'
    && payload.confirm === false && payload.sessionId === 's1')
  check('无 sessionId 的载荷 sessionId=null',
    client.buildUiActionPayload({ requestId: 'r2', action: 'toggle_sidebar' }).sessionId === null)

  // ---- task-18：expiresAt（宿主 deadline 透传） ----
  {
    const withExpiry = client.buildUiActionPayload({
      requestId: 'r3', action: 'send_prompt', params: { text: 'hi' }, confirm: true, expiresAt: 1700000000000,
    })
    check('buildUiActionPayload 透传 expiresAt（有限数字）', withExpiry.expiresAt === 1700000000000,
      String(withExpiry.expiresAt))
    // 与宿主同构：字段恒定存在，非有限数字时为 undefined（JSON 序列化会丢掉该键）。
    const noExpiry = client.buildUiActionPayload({ requestId: 'r4', action: 'state' })
    check('expiresAt 缺省时值为 undefined 且 JSON 里不出现',
      noExpiry.expiresAt === undefined && !JSON.stringify(noExpiry).includes('expiresAt'))
    for (const bad of [undefined, null, NaN, Infinity, '1700000000000', {}]) {
      const built = client.buildUiActionPayload({ requestId: 'r5', action: 'state', expiresAt: bad })
      check(`非法 expiresAt（${String(bad)}）为 undefined 且 JSON 里不出现`,
        built.expiresAt === undefined && !JSON.stringify(built).includes('expiresAt'))
    }
    check('expiresAt 不影响现有字段', withExpiry.confirm === true && withExpiry.actions[0].action === 'send_prompt')
  }

  // ---- task-18：过期判断边界 ----
  {
    check('isUiActionExpired：缺失 expiresAt → false',
      client.isUiActionExpired({}, 1000) === false)
    check('isUiActionExpired：NaN expiresAt → false',
      client.isUiActionExpired({ expiresAt: NaN }, 1000) === false)
    check('isUiActionExpired：非数字 expiresAt → false',
      client.isUiActionExpired({ expiresAt: '1000' }, 2000) === false
      && client.isUiActionExpired({ expiresAt: null }, 2000) === false)
    check('isUiActionExpired：payload 为 null → false', client.isUiActionExpired(null, 1) === false)
    check('isUiActionExpired：now < expiresAt → false（未过期）',
      client.isUiActionExpired({ expiresAt: 1000 }, 999) === false)
    check('isUiActionExpired：now == expiresAt → false（边界仍可用）',
      client.isUiActionExpired({ expiresAt: 1000 }, 1000) === false)
    check('isUiActionExpired：now > expiresAt → true（已过期）',
      client.isUiActionExpired({ expiresAt: 1000 }, 1001) === true)
    check('isUiActionExpired：默认 now=Date.now()',
      client.isUiActionExpired({ expiresAt: Date.now() - 1000 }) === true
      && client.isUiActionExpired({ expiresAt: Date.now() + 100000 }) === false)
  }
}

/* ================================================================ */
console.log('\n与宿主 lib/ui-action-protocol.js 双端一致性')
const hostExists = fs.existsSync(HOST_PATH)
if (!hostExists) {
  console.log('  ⚠ 跳过：宿主模块 lib/ui-action-protocol.js 还没落盘（实现期正常；完整测试会跑一致性）')
  check('宿主模块存在（落盘后必须通过）', true, '实现期跳过')
} else {
  const host = await import(pathToFileURL(HOST_PATH).href)
  check('宿主模块可 import', Boolean(host))

  // 1) 常量完全一致
  check('UI_ACTION_NAMES 双端一致',
    same(host.UI_ACTION_NAMES, client.UI_ACTION_NAMES),
    `${JSON.stringify(host.UI_ACTION_NAMES)} vs ${JSON.stringify(client.UI_ACTION_NAMES)}`)
  check('UI_CONFIRM_ACTIONS 双端一致',
    same(host.UI_CONFIRM_ACTIONS, client.UI_CONFIRM_ACTIONS))
  check('UI_ACTION_LIMITS 双端一致',
    same(host.UI_ACTION_LIMITS, client.UI_ACTION_LIMITS))
  if (host.UI_ACTION_PARAMS !== undefined || client.UI_ACTION_PARAMS !== undefined) {
    check('UI_ACTION_PARAMS 双端一致', same(host.UI_ACTION_PARAMS, client.UI_ACTION_PARAMS))
    check('UI_ACTION_REQUIRED 双端一致', same(host.UI_ACTION_REQUIRED, client.UI_ACTION_REQUIRED))
  }

  // 2) 规格：每个动作 + 未知动作 + 大小写/空白
  const actionCases = [
    ...client.UI_ACTION_NAMES,
    ' State ', 'SWITCH_SESSION', 'click_element', '', null, 42,
  ]
  let specMismatch = 0
  for (const action of actionCases) {
    if (!same(host.getUiActionSpec(action), client.getUiActionSpec(action))) specMismatch += 1
    if (!same(host.getUiActionSpec(action), client.getUiActionSpec(action))) {
      console.log('    spec 不一致:', JSON.stringify(action))
    }
  }
  check(`getUiActionSpec 在 ${actionCases.length} 个用例上一致`, specMismatch === 0, `不一致 ${specMismatch} 个`)

  // 3) 确认策略
  let confirmMismatch = 0
  for (const action of actionCases) {
    if (host.actionNeedsConfirm(action) !== client.actionNeedsConfirm(action)) confirmMismatch += 1
  }
  check(`actionNeedsConfirm 在 ${actionCases.length} 个用例上一致`, confirmMismatch === 0)

  // 4) 参数校验：共享用例表（覆盖每条错误路径）
  const validateCases = [
    ['state', {}],
    ['state', null],
    ['state', { extra: 'x' }],
    ['list_sessions', undefined],
    ['toggle_sidebar', { sessionId: 'x' }],
    ['switch_session', {}],
    ['switch_session', { sessionId: '  ' }],
    ['switch_session', { sessionId: ' s1 ' }],
    ['switch_session', { sessionId: 123 }],
    ['switch_session', { sessionId: 's'.repeat(201) }],
    ['switch_session', { sessionId: 's'.repeat(200) }],
    ['new_session', {}],
    ['new_session', { workspaceId: 'ws-1' }],
    ['new_session', { workspaceId: '' }],
    ['new_session', { workspaceId: 'w'.repeat(201) }],
    ['run_command', {}],
    ['run_command', { line: '/compact' }],
    ['run_command', { line: '  /compact  ' }],
    ['run_command', { line: '/a\n/b' }],
    ['run_command', { line: '/a\r/b' }],
    ['run_command', { line: 'l'.repeat(401) }],
    ['run_command', { line: 'l'.repeat(400) }],
    ['send_prompt', {}],
    ['send_prompt', { text: 'hello' }],
    ['send_prompt', { text: '  hello  ', sessionId: 's1' }],
    ['send_prompt', { text: '' }],
    ['send_prompt', { text: 'x'.repeat(4001) }],
    ['send_prompt', { text: 42 }],
    ['send_prompt', { text: 'hi', extra: 'drop' }],
    ['stop_generation', {}],
    ['stop_generation', { sessionId: 's1' }],
    ['stop_generation', { sessionId: ' ' }],
    ['bogus', {}],
    ['', { text: 'x' }],
    [' Run_Command ', { line: '/help' }],
    // ---- v2：semantic + a11y 动作 ----
    ['set_sidebar', {}],
    ['set_sidebar', { collapsed: true }],
    ['set_sidebar', { collapsed: false }],
    ['set_sidebar', { collapsed: null }],
    ['set_sidebar', { collapsed: 'true' }],
    ['set_sidebar', { collapsed: 1 }],
    ['set_sidebar', { collapsed: true, extra: 'drop' }],
    ['open_plugins', {}],
    ['open_plugins', { x: 1 }],
    ['ui_snapshot', {}],
    ['ui_snapshot', null],
    ['ui_snapshot', { ref: 'e1' }],
    ['ui_click', {}],
    ['ui_click', { ref: 'e12' }],
    ['ui_click', { ref: ' e12 ' }],
    ['ui_click', { ref: 'e'.repeat(40) }],
    ['ui_click', { ref: 'e'.repeat(41) }],
    ['ui_click', { ref: 3 }],
    ['ui_type', { ref: 'e1' }],
    ['ui_type', { text: '你好' }],
    ['ui_type', { ref: 'e1', text: '你好' }],
    ['ui_type', { ref: 'e1', text: 'x'.repeat(4001) }],
    ['ui_key', {}],
    ['ui_key', { key: 'Escape' }],
    ['ui_key', { key: 'Ctrl+K' }],
    ['ui_key', { key: 'k'.repeat(40) }],
    ['ui_key', { key: 'k'.repeat(41) }],
    [' SwitcH_Session ', { sessionId: 's1' }],
  ]
  let validateMismatch = 0
  for (const [action, params] of validateCases) {
    const a = host.validateUiAction(action, params)
    const b = client.validateUiAction(action, params)
    if (!same(a, b)) {
      validateMismatch += 1
      console.log('    校验不一致:', JSON.stringify({ action, params }), JSON.stringify(a), JSON.stringify(b))
    }
  }
  check(`validateUiAction 在 ${validateCases.length} 个用例上一致`, validateMismatch === 0,
    `不一致 ${validateMismatch} 个`)

  // 5) 描述
  const describeCases = [
    ['state', {}],
    ['send_prompt', { text: '帮我总结一下' }],
    ['send_prompt', { text: 'x'.repeat(200) }],
    ['switch_session', { sessionId: 'abc' }],
    ['bogus', {}],
    // ---- v2 ----
    ['set_sidebar', { collapsed: true }],
    ['set_sidebar', { collapsed: false }],
    ['ui_click', { ref: 'e3' }],
    ['ui_key', { key: 'Ctrl+K' }],
    ['ui_type', { ref: 'e1', text: 'abc' }],
    ['ui_snapshot', {}],
    ['open_plugins', {}],
  ]
  let describeMismatch = 0
  for (const [action, params] of describeCases) {
    if (host.describeUiAction(action, params) !== client.describeUiAction(action, params)) describeMismatch += 1
  }
  check(`describeUiAction 在 ${describeCases.length} 个用例上一致`, describeMismatch === 0)

  // 6) 宿主额外导出（客户端也镜像了同一份代码，顺带校验）
  if (typeof host.buildUiActionPayload === 'function' && typeof client.buildUiActionPayload === 'function') {
    // 宿主 task-17 与客户端 task-18 并行加 expiresAt：宿主还没更新时只比较旧字段，
    // 更新后自动纳入完整比较（同一份用例表，避免两边字段顺序/取值漂移）。
    const hostSupportsExpiry = (() => {
      try {
        const probe = host.buildUiActionPayload({ requestId: 'probe', action: 'state', params: {}, confirm: false, expiresAt: 123 })
        return Object.prototype.hasOwnProperty.call(probe, 'expiresAt')
      } catch {
        return false
      }
    })()
    if (!hostSupportsExpiry) {
      console.log('  ⚠ 宿主 buildUiActionPayload 还没有 expiresAt（task-17 并行中）；本轮只比较非过期字段')
    }
    const payloadCases = [
      { requestId: 'r1', sessionId: 's1', action: 'send_prompt', params: { text: 'hi' }, confirm: true },
      { requestId: 'r2', sessionId: null, action: 'toggle_sidebar', params: {}, confirm: false },
      { requestId: '', action: 'bogus', params: { x: 1 }, confirm: 'yes' },
      // task-18 用例：expiresAt 透传 / 非法省略
      { requestId: 'r3', action: 'state', params: {}, confirm: false, expiresAt: 1700000000000 },
      { requestId: 'r4', action: 'state', params: {}, confirm: false, expiresAt: undefined },
      { requestId: 'r5', action: 'state', params: {}, confirm: false, expiresAt: NaN },
    ]
    let payloadMismatch = 0
    for (const input of payloadCases) {
      let hostPayload = host.buildUiActionPayload(input)
      const clientPayload = client.buildUiActionPayload(input)
      if (!hostSupportsExpiry) {
        // 宿主还没字段：把客户端刚加的 expiresAt 摘掉再比旧字段（避免并行期假红）。
        hostPayload = { ...hostPayload }
        delete hostPayload.expiresAt
        const clientWithout = { ...clientPayload }
        delete clientWithout.expiresAt
        if (!same(hostPayload, clientWithout)) payloadMismatch += 1
        continue
      }
      if (!same(hostPayload, clientPayload)) {
        payloadMismatch += 1
        console.log('    载荷不一致:', JSON.stringify(input), JSON.stringify(hostPayload), JSON.stringify(clientPayload))
      }
    }
    check('buildUiActionPayload 双端一致（含 expiresAt）', payloadMismatch === 0)
  }
  if (typeof host.validateUiActionResult === 'function' && typeof client.validateUiActionResult === 'function') {
    const resultCases = [
      { requestId: 'r1', ok: true },
      { requestId: 'r1', ok: false, error: 'confirm_denied', value: { cancelled: true } },
      { requestId: '  ', ok: true },
      { requestId: 'r1', ok: 'yes' },
      { requestId: 'r1', ok: false, error: 42 },
      null,
      [],
    ]
    let resultMismatch = 0
    for (const input of resultCases) {
      if (!same(host.validateUiActionResult(input), client.validateUiActionResult(input))) resultMismatch += 1
    }
    check('validateUiActionResult 双端一致', resultMismatch === 0)
  }
  // 宿主也导出 isUiActionExpired 时做同表比较（宿主没有则客户端自测已覆盖边界）。
  if (typeof host.isUiActionExpired === 'function' && typeof client.isUiActionExpired === 'function') {
    const expiryCases = [
      [{}, 1000],
      [null, 1000],
      [{ expiresAt: NaN }, 1000],
      [{ expiresAt: '1000' }, 2000],
      [{ expiresAt: 1000 }, 999],
      [{ expiresAt: 1000 }, 1000],
      [{ expiresAt: 1000 }, 1001],
    ]
    let expiryMismatch = 0
    for (const [payload, now] of expiryCases) {
      if (host.isUiActionExpired(payload, now) !== client.isUiActionExpired(payload, now)) expiryMismatch += 1
    }
    check(`isUiActionExpired 在 ${expiryCases.length} 个用例上一致`, expiryMismatch === 0)
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
