/**
 * 客户端调用的宿主路由（纯数据，零环境依赖）。
 *
 * 为什么单独成文件（批次 6j，docs/architecture-modernization.md §8.43）：
 *   原先这 20 条路径以**字面量**散在 6 个文件里，前缀还写了三种花样
 *   （`` `/dsh-voice-typing/busy` ``、`` `${BASE}/config` ``、`` `${baseUrl}/tts` ``）。
 *   于是「客户端到底调了哪些路由」这件事只有一个问法：**把源码文本扫一遍**。
 *   `test/route-contract.test.mjs` 就是这么问的，两条正则（`${VAR}/path` 与
 *   `'/dsh-voice-typing/path'`）配不上就是 0 条断言空过 —— 那个文件里
 *   「能解析出客户端路由（防止正则失配导致 0 断言空过）」那条判据就是给它自己打的补丁，
 *   一条判据在守另一条判据别失配，这已经是判据坏掉的形状。
 *
 *   收成一张表之后，契约两边都是**跑出来的数据**：
 *     客户端集合 = `Object.values(ROUTES)`（import 一个模块读它的导出），
 *     宿主集合   = 宿主 `apply()` 真跑一遍之后注册表里的路径。
 *
 * 表怎么才能一直是唯一来源（这件事不归测试管，归 linter 管）：
 *   `eslint.config.js` 里 `ROUTE_PREFIX_BAN` 禁止 `src/client/**` 出现以
 *   `/dsh-voice-typing/` 开头的字符串字面量或模板片段 —— 只豁免本文件。
 *   于是「有人又手写一条字面量」在 `test/no-undef.test.mjs` 的全树 lint 里就红，
 *   不需要测试再去扫文本。提示文案里的 `/dsh-voice-typing/diagnostics`
 *   （`pure/i18n.js` 那句给设置页看的话）不在禁令范围内：禁令锚在**字面量的开头**，
 *   那种句子开头是中文。
 *
 * 三种写法各自的去处：
 *   - 直接写字面量的地方（mic-button / global-voice-overlay）用 `ROUTES.xxx`；
 *   - 前缀由注入而来的地方（playback-core / client-id）用 `${baseUrl}${ROUTE_PATHS.xxx}` ——
 *     环境仍然从参数进来（§8.27 那条约束不因这张表松动），只是路径名不再各写各的；
 *   - `main.js` 往外传的 `baseUrl` 用 `ROUTE_BASE`。
 *
 * @module client/pure/routes
 */

/** 宿主路由前缀。 */
export const ROUTE_BASE = '/dsh-voice-typing'

/**
 * 路径段（不含前缀）—— 前缀由注入而来时用这一张。
 *
 * 键名 = 路径的驼峰读法（`asr-stream/reset` → `asrStreamReset`）。
 */
export const ROUTE_PATHS = {
  asrReady: '/asr-ready',
  asrStream: '/asr-stream',
  asrStreamReset: '/asr-stream/reset',
  asrWarmup: '/asr-warmup',
  busy: '/busy',
  config: '/config',
  diagnostics: '/diagnostics',
  model: '/model',
  models: '/models',
  readingAck: '/reading-ack',
  stream: '/stream',
  transcribe: '/transcribe',
  tts: '/tts',
  ttsEnv: '/tts/env',
  ttsWarmup: '/tts/warmup',
  uiActionClaim: '/ui-action-claim',
  uiActionResult: '/ui-action-result',
  voicePrompt: '/voice-prompt',
  voiceSession: '/voice-session',
  voices: '/voices',
}

/**
 * 完整路径（前缀 + 路径段）—— 客户端集合就是这张表的值。
 *
 * 派生而不是手写第二遍：漏一条就会在这里显出来（`Object.entries` 一对一）。
 */
export const ROUTES = Object.fromEntries(
  Object.entries(ROUTE_PATHS).map(([key, segment]) => [key, `${ROUTE_BASE}${segment}`]),
)
