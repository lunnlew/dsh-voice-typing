/**
 * UI 动作协议测试：判据行为 + 「三个入口是不是同一份实现」。
 *
 * 为什么这条判据必须只有一份：
 *   宿主在广播 `ui-action` 前校验一次，渲染器执行前再校验一次 ——
 *   任一边的规则漂移，都会让「宿主放行、客户端拒绝」或反过来，
 *   而模型/用户看到的只是莫名的 confirm_denied / unknown_action。
 *   第 3 步 3.2 之前是「宿主一份 + 客户端镜像一份」，靠本文件逐条比对两端返回值防分叉；
 *   现在实现在 `src/shared/ui-action-protocol.js`，`lib/ui-action-protocol.js` 与
 *   `src/client/pure/ui-action-protocol.js` 都只是转发入口 ——
 *   比对换成了两件事：**用例覆盖度**（每条动作/每条错误路径都得有用例）
 *   和**导出面 + 绑定同一性**（转发少写一个名字、或某侧还留一份拷贝，都会红）。
 *
 * 用法：node test/ui-action-protocol.test.mjs
 */
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as client from '../src/client/pure/ui-action-protocol.js'
import { hostSourcePath } from './helpers/host-source.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/** 按 JSON 比较两个返回值（键顺序由实现决定，比对两侧时要用它兜住顺序差异）。 */
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 两组导出名的差集（少了/多了哪些名字），空则返回「无」。 */
function diffNames(a, b) {
  const set = new Set([...a, ...b])
  const out = [...set].filter((n) => !(a.includes(n) && b.includes(n)))
  return out.length ? out.join(', ') : '无'
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
console.log('\n用例表覆盖度（每条路径都要有用例，别再靠「两份对比」发现漏项）')
{
  // 这张表原来只用来做宿主/客户端逐条比对；单源化之后比对失去意义
  // （两端本来就是同一个实现）。它剩下的价值是**覆盖度**：
  // 每个动作、每条错误路径都得有用例，否则改了实现会有路径静默没测。
  const validateCases = [
    ['state', {}], ['state', null], ['state', { extra: 'x' }],
    ['list_sessions', undefined], ['toggle_sidebar', { sessionId: 'x' }],
    ['switch_session', {}], ['switch_session', { sessionId: '  ' }],
    ['switch_session', { sessionId: ' s1 ' }], ['switch_session', { sessionId: 123 }],
    ['switch_session', { sessionId: 's'.repeat(201) }],
    ['switch_session', { sessionId: 's'.repeat(200) }],
    ['new_session', {}], ['new_session', { workspaceId: 'ws-1' }], ['new_session', { workspaceId: '' }],
    ['new_session', { workspaceId: 'w'.repeat(201) }],
    ['run_command', {}], ['run_command', { line: '/compact' }], ['run_command', { line: '  /compact  ' }],
    ['run_command', { line: '/a\n/b' }], ['run_command', { line: '/a\r/b' }],
    ['run_command', { line: 'l'.repeat(401) }], ['run_command', { line: 'l'.repeat(400) }],
    ['send_prompt', {}], ['send_prompt', { text: 'hello' }],
    ['send_prompt', { text: '  hello  ', sessionId: 's1' }], ['send_prompt', { text: '' }],
    ['send_prompt', { text: 'x'.repeat(4001) }], ['send_prompt', { text: 42 }],
    ['send_prompt', { text: 'hi', extra: 'drop' }],
    ['stop_generation', {}], ['stop_generation', { sessionId: 's1' }], ['stop_generation', { sessionId: ' ' }],
    ['bogus', {}], ['', { text: 'x' }], [' Run_Command ', { line: '/help' }],
    ['set_sidebar', {}], ['set_sidebar', { collapsed: true }], ['set_sidebar', { collapsed: false }],
    ['set_sidebar', { collapsed: null }], ['set_sidebar', { collapsed: 'true' }], ['set_sidebar', { collapsed: 1 }],
    ['set_sidebar', { collapsed: true, extra: 'drop' }],
    ['open_plugins', {}], ['open_plugins', { x: 1 }],
    ['ui_snapshot', {}], ['ui_snapshot', null], ['ui_snapshot', { ref: 'e1' }],
    ['ui_click', {}], ['ui_click', { ref: 'e12' }], ['ui_click', { ref: ' e12 ' }],
    ['ui_click', { ref: 'e'.repeat(40) }], ['ui_click', { ref: 'e'.repeat(41) }], ['ui_click', { ref: 3 }],
    ['ui_type', { ref: 'e1' }], ['ui_type', { text: '你好' }], ['ui_type', { ref: 'e1', text: '你好' }],
    ['ui_type', { ref: 'e1', text: 'x'.repeat(4001) }],
    ['ui_key', {}], ['ui_key', { key: 'Escape' }], ['ui_key', { key: 'Ctrl+K' }],
    ['ui_key', { key: 'k'.repeat(40) }], ['ui_key', { key: 'k'.repeat(41) }],
    [' SwitcH_Session ', { sessionId: 's1' }],
  ]
  const covered = new Set(validateCases.map(([action]) => String(action).trim().toLowerCase()))
  const uncovered = client.UI_ACTION_NAMES.filter((a) => !covered.has(a))
  check(`表里 ${validateCases.length} 条用例覆盖全部 ${client.UI_ACTION_NAMES.length} 个动作`,
    uncovered.length === 0, `没覆盖：${uncovered.join(', ')}`)
  for (const code of ['unknown_action', 'missing_param:', 'param_too_long:', 'invalid_param:']) {
    const hit = validateCases.some(([action, params]) =>
      String(client.validateUiAction(action, params).error ?? '').includes(code))
    check(`错误路径 ${code} 有用例`, hit, '没有用例打到这条分支，改实现时它可能静默失效')
  }
  check('合法用例都返回 ok:true 且 action 已归一化',
    validateCases.every(([action, params]) => {
      const r = client.validateUiAction(action, params)
      return r.ok === true ? typeof r.action === 'string' && r.action === String(action).trim().toLowerCase() : true
    }))
}

/* ================================================================ */
console.log('\n宿主入口 / 浏览器入口 / shared 是同一份实现（单源化的守卫）')
{
  // 「宿主入口」住在哪由 helpers/host-source.mjs 解析（6.5 搬进 src/host/ 之后照样能找到），
  // 这条要守的是「入口只是转发，实现仍然只有 shared 那一份」。
  // 原来这里第一条是 `fs.existsSync(HOST_PATH)`（批次 6i，docs §8.42）：
  // 入口文件在不在，下面那句**真的 import** 就是它的判据 —— 路径错了整个文件直接红，
  // 而且「存在」本身不是目的，「能加载并且导出的就是 shared 那一份」才是（下面那圈绑定同一性判的正是这件事）。
  const HOST_PATH = `${root}/${hostSourcePath('ui-action-protocol')}`
  const SHARED_PATH = root + '/src/shared/ui-action-protocol.js'
  check('实现 src/shared/ui-action-protocol.js 存在', fs.existsSync(SHARED_PATH))
  const host = await import(pathToFileURL(HOST_PATH).href)
  const shared = await import(pathToFileURL(SHARED_PATH).href)
  const names = Object.keys(shared).sort()
  check('shared 模块确实有导出（非空扫描）', names.length >= 12, `只有 ${names.length} 个`)
  check('宿主入口的导出面与 shared 完全一致',
    JSON.stringify(Object.keys(host).sort()) === JSON.stringify(names),
    `宿主多/少：${diffNames(names, Object.keys(host))}`)
  check('浏览器入口的导出面与 shared 完全一致',
    JSON.stringify(Object.keys(client).sort()) === JSON.stringify(names),
    `浏览器多/少：${diffNames(names, Object.keys(client))}`)
  // 逐个比**绑定本身**：转发少写一个名字、或者某一侧还留着一份拷贝，这里都会红。
  for (const name of names) {
    check(`${name}：宿主入口与浏览器入口都是 shared 的那一个`,
      Object.is(host[name], shared[name]) && Object.is(client[name], shared[name]))
  }
  // 走宿主入口真跑几条：证明转发生效的不是「空壳」，而是能判定的实现。
  check('宿主入口 validateUiAction 结果正确（trim + 归一化）',
    same(host.validateUiAction('send_prompt', { text: ' 你好 ' }),
      { ok: true, action: 'send_prompt', params: { text: '你好' } }))
  check('宿主入口 actionNeedsConfirm 对 a11y 动作是 true',
    host.actionNeedsConfirm('ui_type') === true && host.actionNeedsConfirm('ui_snapshot') === false)
  check('宿主入口 buildUiActionPayload 带上有限 expiresAt',
    host.buildUiActionPayload({ requestId: 'r', action: 'state', expiresAt: 123 }).expiresAt === 123)
  check('宿主入口 isUiActionExpired 边界（now == expiresAt 不算过期）',
    host.isUiActionExpired({ expiresAt: 1000 }, 1000) === false
    && host.isUiActionExpired({ expiresAt: 1000 }, 1001) === true)
}

/* ================================================================ */
// 这一节原来有两条扫源码的判据（批次 6i，docs §8.42）：
//   · 「浏览器入口只做转发（没有第二份 ACTION_SPECS）」—— 扫 pure/ui-action-protocol.js 里
//     有没有 `const ACTION_SPECS = {`。上面那圈**绑定同一性**（`Object.is(client[name], shared[name])`，
//     名字来自 `Object.keys(shared)`，ACTION_SPECS 也在其中）判的是同一件事而且更宽：
//     入口哪怕只有一份本地拷贝、只要导出的不是 shared 的那一个，那里就红。
//     「抄了一份但暂时一模一样」不属于本文件范围，它归 test/bundle-sync.test.mjs 的全仓反分叉扫描
//     （标记是 `hasOwnProperty.call(ACTION_SPECS`，范围是全部手写源码文件）。
//   · 「main.js 里没有自己的一份动作白名单」—— 扫 main.js 里有没有 `const UI_ACTION_NAMES =`。
//     **删**：main.js 对这个名字只做「import 进来 → 挂到导出面」（第 71 行与第 574 行），
//     客户端内部没有任何一处读它，全仓也没有一条测试读那份导出（动作全集由 voice-ui-host 判
//     工具 schema 的 enum，宿主侧由本文件判两端返回值）。所以在 main.js 里再写一份白名单
//     **行为上分不出写法** —— 没有任何一次运行会因此不同。
//     推翻条件：哪天客户端真的拿它做校验或展示（比如按钮按名单过滤动作），
//     那时要的不是这条正则，而是「客户端实际用的名单 == 协议名单」的数据比对。
console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
