/**
 * 路由契约：客户端调用的路由必须存在，宿主暴露的路由不能是死链。
 *
 * 背景（2026-10-31）：
 *   这个插件长出过好几条**死链** —— 宿主提供了路由、还有测试在测，
 *   但客户端从来不调。`/latest-message`（约 100 行，批次 17 已删）、`/session` 全套、
 *   `/asr-stream` + `/asr-stream/reset` 都是这样。
 *
 *   死链的代价：有人以为它在用就去改它，改坏了也不知道；
 *   或者反过来，客户端需要某个能力时以为「宿主已经有了」，
 *   结果那个能力其实没人调过。
 *
 * 规则（可执行）：
 *   - 客户端调用的每个路由，宿主必须注册；
 *   - 宿主注册的每个路由，要么客户端在用，要么在 `HOST_ONLY` 这份清单里写清它是干什么的。
 *
 * 批次 6j 改的是**问问题的方式**（docs/architecture-modernization.md §8.43）。
 * 原来这 12 条判据全部读手写源码：两条正则从 `src/client/**` 里抠「客户端调了哪些路由」，
 * 另一条正则从 `src/host/index.js` 里抠 `path: '…'`，还有两条判「注册处 1200 字符内
 * 有没有一句注释写着『保留 / 未使用 / 唯一调用方』」。那一版里最别扭的是这两条：
 *   - 「能解析出客户端路由（防止正则失配导致 0 断言空过）」—— 一条判据在守另一条判据别失配；
 *   - 「宿主注册但客户端不用的路由必须显式标注」—— 判的是**注释里写了什么字**，
 *     注释说「客户端仍要用它」而客户端早就不调了，它照样绿（本批就撞见一条，见下面 D 段）。
 * 现在三个集合都是跑出来的数据：
 *   客户端集合 = `import` `src/client/pure/routes.js` 读它的导出；
 *   宿主集合   = `loadHostRoutes()` 把真宿主装进临时目录跑完 `apply()` 之后的注册表；
 *   helper 那条 = `buildHelperScript()` 生成出来的脚本里那个 URL 的 pathname。
 * 「那张表还是不是客户端路由的唯一来源」不再由本文件扫源码判，
 * 归 eslint 的 `ROUTE_PREFIX_BAN`（由 test/no-undef.test.mjs 全树执行 + 五条探针钉边界）。
 *
 * 用法：node test/route-contract.test.mjs
 */
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ROUTE_BASE, ROUTE_PATHS, ROUTES } from '../src/client/pure/routes.js'
import { buildHelperScript } from '../src/host/global-hotkey-helper.js'

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/**
 * 宿主注册了但客户端不调的路由，以及**它凭什么还留着**。
 *
 * 这份清单就是原来的「注释里必须写着用途」—— 用途从注释变成数据之后，
 * 它得跟着注册表变动走：删了一条路由还留在清单里 → D 段红。
 */
const HOST_ONLY = {
  '/dsh-voice-typing/hotkey':
    '系统级全局热键 helper 的回调入口，唯一调用方是 helper 进程（PowerShell POST）。E 段用真跑核对这一条：helper 脚本生成出来的 URL 必须正好命中它。',
}

/**
 * 客户端在 SSE 上监听的事件名。
 *
 * 这里写死一份是**有主的**：同一组名字由 test/client-behavior.test.mjs 从跑出来的
 * EventSource 上读走（那里的 `addEventListener` 是真调用记录），名字写错那边就红。
 * 本文件用它判的是宿主那一侧：广播出来的名字不许掉出这份清单。
 */
const CLIENT_STREAM_EVENTS = new Set([
  'assistant-busy', 'turn-begin', 'turn-end', 'call-end', 'sentence',
  'global-hotkey', 'ui-action',
])

const clientRoutes = Object.values(ROUTES).sort()

// ---------------------------------------------------------------------------
console.log('== A. 两个集合都取得到（防空转的下限判在这里，但读的是数据不是文本）==')
{
  check('客户端路由表非空（import 到的对象里真有路径）',
    clientRoutes.length >= 15, `只取到 ${clientRoutes.length} 条：${clientRoutes.join(',') || '（空）'}`)
  check('表里每条都是「前缀 + 路径段」拼出来的（ROUTES 与 ROUTE_PATHS 同一套键）',
    Object.keys(ROUTES).length === Object.keys(ROUTE_PATHS).length
    && Object.entries(ROUTES).every(([key, full]) => full === `${ROUTE_BASE}${ROUTE_PATHS[key]}`),
    Object.entries(ROUTES).map(([key, full]) => `${key}=${full}`).join(','))
}

// ---------------------------------------------------------------------------
console.log('\n装真宿主：读它 apply() 跑完之后注册表里的路径')
const home = path.join(os.tmpdir(), 'dsh-voice-typing-route-contract')
await mkdir(home, { recursive: true })
const { loadHostRoutes } = await import('./helpers/host-routes.mjs')
const env = await loadHostRoutes({
  dshHome: home,
  rowConfig: { readAloud: true, preloadModels: false },
})
const hostRoutes = [...new Set(env.routes.map((r) => r.path))].sort()

try {
  check('宿主路由表非空（真装出来的注册表里有路径）',
    hostRoutes.length >= 15, `只取到 ${hostRoutes.length} 条`)

  // -----------------------------------------------------------------------
  console.log(`\n客户端调用 ${clientRoutes.length} 个路由，宿主注册 ${hostRoutes.length} 个`)
  console.log('\n== B. 客户端调用的路由宿主必须都有 ==')
  for (const r of clientRoutes) {
    const base = r.split('?')[0]
    check(base, hostRoutes.includes(base), '宿主没注册这个路由 —— 客户端调它会 404')
  }

  // -----------------------------------------------------------------------
  console.log('\n== C. 宿主注册但客户端不用的路由必须写清用途 ==')
  for (const r of hostRoutes) {
    if (!r) continue
    if (clientRoutes.includes(r)) continue
    const note = HOST_ONLY[r]
    check(`${r} 写清了留着的原因`, typeof note === 'string' && note.length >= 20,
      '既没人调也没进 HOST_ONLY —— 要么删掉，要么把它是干什么的写进这份清单')
  }

  // -----------------------------------------------------------------------
  console.log('\n== D. HOST_ONLY 不能过期：清单里的每条路由宿主都还得注册着 ==')
  for (const r of Object.keys(HOST_ONLY)) {
    check(`${r} 确实还注册着`, hostRoutes.includes(r),
      '清单里留着一条宿主已经不注册的路由 —— 用途说明就成了假账')
  }

  // -----------------------------------------------------------------------
  console.log('\n== E. /hotkey 只归 helper 进程调（客户端不调，helper 那边是真跑）==')
  {
    check('/hotkey 不在客户端路由表里（渲染器不调它）',
      !clientRoutes.includes('/dsh-voice-typing/hotkey'),
      '客户端一旦直接 POST /hotkey，helper 专用的鉴权入口就暴露给渲染器了')
    const script = buildHelperScript({
      port: 45678, token: 'a'.repeat(32), accelerator: 'Ctrl+Alt+V',
    })
    const helperUrl = (script.match(/http:\/\/127\.0\.0\.1:45678[^\s"'`)]+/) ?? [''])[0]
    const helperPath = helperUrl ? new URL(helperUrl).pathname : ''
    check('helper 生成出来的脚本确实打向 /dsh-voice-typing/hotkey',
      helperPath === '/dsh-voice-typing/hotkey', helperUrl || '脚本里没找到那个 URL')
    check('helper 打的这条路由宿主注册着（跨进程的通路不是各写各的）',
      hostRoutes.includes(helperPath), helperUrl)
  }

  // -----------------------------------------------------------------------
  console.log('\n== F. 全局语音 / AI 界面操控的数据通路（v1）==')
  {
    // 这两条是语音回退注入与 UI 动作回执的通路。少一条就是浮层那一侧静默失效，
    // 而浮层的这两条路径由 client-behavior / voice-ui-* 那几组真跑跑通，本文件判的是「在表里」。
    check('客户端表里有 /voice-prompt（语音回退注入）',
      clientRoutes.includes('/dsh-voice-typing/voice-prompt'))
    check('客户端表里有 /ui-action-result（UI 动作回执）',
      clientRoutes.includes('/dsh-voice-typing/ui-action-result'))
    check('客户端表里有 /ui-action-claim（多窗口认领动作）',
      clientRoutes.includes('/dsh-voice-typing/ui-action-claim'))
  }

  // -----------------------------------------------------------------------
  console.log('\n== G. 已删除的死路由不该复活 ==')
  {
    // 判的是**数据**：客户端表里没有、宿主注册表里也没有。
    // 想加回来必须同时改两处（客户端那边还得先把 eslint 的路由前缀禁令绕过去 —— 绕不动，
    // 只能往表里加，一加就会被 B 段要求宿主注册）。
    check('客户端表里没有 /session', !clientRoutes.includes(`${ROUTE_BASE}/session`))
    check('客户端表里没有 /latest-message', !clientRoutes.includes(`${ROUTE_BASE}/latest-message`))
    check('宿主注册表里没有 /session 路由', !hostRoutes.includes(`${ROUTE_BASE}/session`))
    // `/latest-message` 原来挂在 `HOST_ONLY` 里当「没人调但留着」的一条（批次 6j 查实的），
    // 批次 17 把它退役了：约 100 行 + 一份和 `turn-model` 重复的轮次键口径。
    // 现在它和 `/session` 同一待遇 —— 复活要同时改两处（客户端表 + 宿主注册）。
    check('宿主注册表里没有 /latest-message 路由（批次 17 退役的死链不许复活）',
      !hostRoutes.includes(`${ROUTE_BASE}/latest-message`))
  }

  // -----------------------------------------------------------------------
  console.log('\n== H. SSE 事件名（真跑：驱动真宿主的 llm/stream，看广播出来的帧）==')
  {
    // 原来这里有三条源码正则：宿主不许写 broadcast('session') / broadcast('turn-start')、
    // 客户端不许 addEventListener('turn-start')。三条判的都是「字符串没出现」，
    // 在产品里没有任何行为后果跟着 —— 少一条字符串的 absence 换不来任何用户可见的差别。
    // 现在改成有后果的形状：**宿主真的广播，广播出来的名字必须有人在听**。
    // 谁真的在听这件事由 client-behavior 从跑出来的 EventSource 上取（见那里的收尾账本），
    // 本文件用同一组名字核对宿主这一侧。
    const handler = env.hooks.get('llm/stream')
    check('接缝里装上了真宿主的 llm/stream 钩子', typeof handler === 'function')
    const sse = env.openStream()
    const sess = 'route-contract-events'
    const runOnce = async () => {
      const stream = handler(
        { sessionId: sess, messages: [{ role: 'user', id: 'u1' }] },
        () => (async function* () { yield { type: 'text-delta', text: '契约用的这一句话。' } })(),
      )
      for await (const _chunk of stream) { /* 消费到底，走到广播那一段 */ }
    }
    await runOnce()
    const names = [...new Set(sse.events().map((e) => e.event))]
    check('驱动一次真钩子确实广播出了事件（不是数源码里的 broadcast）',
      names.length > 0, JSON.stringify(names))
    check('广播出来的每个事件名客户端都在听（掉出清单的名字没人消费 = 死通道，turn-start/session 复活也会在这里红）',
      names.every((n) => CLIENT_STREAM_EVENTS.has(n)), JSON.stringify(names))
    check('回合事件只有 turn-begin（当年那条 turn-start 没在这一轮里冒出来）',
      names.includes('turn-begin'), JSON.stringify(names))
    sse.close()
  }

  // -----------------------------------------------------------------------
  console.log('\n== I. 给人看的那两份路由清单，与真注册表逐项对得上（批次 25）==')
  {
    /**
     * 判的是**集合相等**，不是「注释里写了什么字」：清单少一条、多一条、名字写歪，都直接给名字。
     *
     * 这条路以前只走了一半 —— `test/repo-hygiene.test.mjs` 查的是正向
     * （文档里出现过的完整路由必须在注册表里），从来没人查反向（注册表里的路由文档都提没提）。
     * 于是 `/reading-ack`、`/asr-ready`、`/asr-warmup`、`/ui-action-claim` 四条先后漏出
     * `cordis.patch.yml` 那份对外清单（§8.59 末尾记的就是这个缺口）。
     *
     * 同批把 `src/host/index.js` 文件头那份**第三抄本**删了：它和注册代码住在同一个文件里，
     * 要判它就得扫源码文本（本仓库的「源码文本判据 = 0」那条账就是为这种形状设的）。
     * 现在留下的是两份**各有读者**的清单 —— `docs/reference.md` 第 1 节（维护者）与
     * cordis.patch.yml（装机的人）—— 两份都在这条判据里，注册表仍是唯一真身。
     * （原 README §9.1：文档清理那轮把技术参考整体搬出 README，README 只留使用说明，
     * 判据跟着改读新位置 —— 表格形状没变，所以这里只换文件与小节标题。）
     */
    // 两份写法的前缀不一样：注册表是 `/dsh-voice-typing/xxx`（真路径），
    // cordis.patch.yml 也带前缀（它是给宿主看的完整路径），`docs/reference.md` 只写 `/xxx`
    // （它上一行已经声明「全部路由带 /dsh-voice-typing 前缀」）。统一成裸名字再比。
    const strip = (raw) => {
      const p = raw.split('?')[0]
      if (p.startsWith(`${ROUTE_BASE}/`)) return p.slice(ROUTE_BASE.length + 1)
      return p.replace(/^\//, '')
    }
    const registry = [...new Set(hostRoutes.map(strip))].sort()

    const patchList = []
    for (const line of readFileSync(path.join(repoRoot, 'cordis.patch.yml'), 'utf8').split('\n')) {
      const m = /^\s*#\s*(?:GET|POST|PUT|DELETE)\s+(\/\S+)/.exec(line)
      if (m) patchList.push(strip(m[1]))
    }

    const docList = []
    {
      const lines = readFileSync(path.join(repoRoot, 'docs/reference.md'), 'utf8').split('\n')
      const start = lines.findIndex((l) => /^## 1\. 宿主接口/.test(l))
      const rest = start < 0 ? [] : lines.slice(start + 1)
      const stop = rest.findIndex((l) => /^## /.test(l))
      for (const line of (stop < 0 ? rest : rest.slice(0, stop))) {
        const m = /^\|\s*`(?:GET|POST)(?:\/(?:GET|POST))? (\/[^\s`]+)`/.exec(line)
        if (m) docList.push(strip(m[1]))
      }
    }

    check('注册表本身取得到（下面四组的分母）', registry.length >= 20,
      `只取到 ${registry.length} 条：${registry.join(', ')}`)
    for (const [name, list] of [['cordis.patch.yml', patchList], ['docs/reference.md 第 1 节', docList]]) {
      const uniq = [...new Set(list)].sort()
      check(`${name}：清单解析得到（正则没失配、判据不空转）`, uniq.length >= 20,
        `只取到 ${uniq.length} 条：${uniq.join(', ')}`)
      const missing = registry.filter((r) => !uniq.includes(r))
      check(`${name}：注册表里的每条路由清单上都有（反方向，批次 25 补的那一半）`,
        missing.length === 0, `少了：${missing.join(', ')}`)
      const extra = uniq.filter((r) => !registry.includes(r))
      check(`${name}：清单上没有注册表里不存在的路由（正方向，与 repo-hygiene 同源不同查法）`,
        extra.length === 0, `多了：${extra.join(', ')}`)
    }
  }
} finally {
  env.restore()
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
