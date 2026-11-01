/**
 * 路由契约：客户端调用的路由必须存在，宿主暴露的路由不能是死链。
 *
 * 背景（2026-10-31）：
 *   这个插件长出过好几条**死链** —— 宿主提供了路由、还有测试在测，
 *   但客户端从来不调。`/latest-message`（约 100 行）、`/session` 全套、
 *   `/asr-stream` + `/asr-stream/reset` 都是这样。
 *
 *   死链的代价：有人以为它在用就去改它，改坏了也不知道；
 *   或者反过来，客户端需要某个能力时以为「宿主已经有了」，
 *   结果那个能力其实没人调过。
 *
 * 规则（可执行）：
 *   - 客户端调用的每个路由，宿主必须注册；
 *   - 宿主注册的每个路由，要么客户端在用，要么**显式标注为未使用**。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = fs.readFileSync(root + '/lib/client.js', 'utf8')
const idx = fs.readFileSync(root + '/lib/index.js', 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/** 客户端调用的路由。 */
const clientRoutes = [...new Set((cli.match(/\$\{BASE\}([a-zA-Z0-9\/\-]+)/g) || [])
  .map((s) => s.replace('${BASE}', '')))]
/** 宿主注册的路由。 */
const hostRoutes = [...new Set(
  [...idx.matchAll(/path: '\/dsh-voice-typing([a-zA-Z0-9\/\-]*)'/g)].map((m) => m[1]),
)]

console.log(`客户端调用 ${clientRoutes.length} 个路由，宿主注册 ${hostRoutes.length} 个`)

// 防御：正则失配时两个集合会变成空 → 下面所有循环断言都「空过」，
// 测试全绿但什么也没检查（审计发现的假绿风险）。这里给出非空下限。
check('能解析出客户端路由（防止正则失配导致 0 断言空过）',
  clientRoutes.length >= 3, `只解析出 ${clientRoutes.length} 个：${clientRoutes.join(',') || '（空）'}`)
check('能解析出宿主路由（防止正则失配导致 0 断言空过）',
  hostRoutes.length >= 3, `只解析出 ${hostRoutes.length} 个：${hostRoutes.join(',') || '（空）'}`)

console.log('\n客户端调用的路由宿主必须都有')
for (const r of clientRoutes) {
  const base = r.split('?')[0]
  check(`${base}`, hostRoutes.includes(base),
    `宿主没注册这个路由 —— 客户端调它会 404`)
}

console.log('\n宿主注册但客户端不用的路由必须显式标注')
for (const r of hostRoutes) {
  if (!r) continue
  if (clientRoutes.some((c) => c.split('?')[0] === r)) continue
  // 在路由附近 30 行内找「未使用 / 保留 / 降级」之类的标注
  const idx2 = idx.indexOf(`path: '/dsh-voice-typing${r}'`)
  const around = idx.slice(Math.max(0, idx2 - 1200), idx2 + 400)
  const marked = /未使用|保留|降级|备用|deprecated|不拆/.test(around)
  check(`${r || '/'} 标注了用途`, marked,
    '既没人调也没标注 —— 要么删掉，要么写清楚它是干什么的')
}

console.log('\n已删除的死路由不该复活')
check('客户端不再调用 /session', !/\/session`/.test(cli))
check('客户端不再调用 /latest-message', !/\/latest-message/.test(cli))
check('宿主不再注册 /session 路由', !/path: '\/dsh-voice-typing\/session'/.test(idx))
check('不再有 session 事件', !/broadcast\('session'/.test(idx))
check('不再有 turn-start 事件（回合事件只有 turn-begin）', !/broadcast\('turn-start'/.test(idx))
check('客户端不再监听 turn-start', !/addEventListener\('turn-start'/.test(cli))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
