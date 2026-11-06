/**
 * 系统级热键 helper 的「哪一步没通」原因码 —— 宿主与浏览器侧共用的**单源**词表。
 *
 * 为什么需要这一份（批次 19，docs/architecture-modernization.md §8.61）：
 *   helper 的 `state().reason` 以前直接写中文句子
 *   （`'快捷键为空'`、`'热键注册失败（可能被其他程序占用）'`、`'已关闭（globalHotkeyHelper=false）'` 这些），
 *   设置面板把它插进自己的文案里（`voice-settings-section.js` 的
 *   `t('hotkeyStatusFailed', { reason: hotkeyStatus.reason })` 和「说明」那一行）——
 *   **宿主给的那句优先**。界面是中英双语的，于是英文界面上「系统级热键状态」
 *   那一段是中文。这跟批次 18 修的是同一个毛病（§8.60 把它记为「同一族缺陷的第二处」）：
 *   宿主不该管界面说什么语言，客户端又没法覆盖宿主已经给出的句子。
 *
 * 分工照批次 18 定：**宿主只报码**（说的是「哪一步没通」这件事实），
 * **文案由客户端的 i18n 决定**（`src/client/pure/hotkey-reason-text.js` 的键）。
 * 动态的原始信息（组合键写法、进程 pid、退出码、操作系统那句报错）搬到
 * **另一个字段 `detail`**：它只进 `/diagnostics`，永远不进界面 ——
 * 换成「句子由自己出」不等于把排查要用的东西丢掉。
 *
 * 码表放 `src/shared`，因为它同时被 `src/host/global-hotkey-helper.js` 和
 * `src/client/pure/hotkey-reason-text.js` import —— 一次拼错就会在两端之一红掉，
 * 而不是变成装机上一个对不上的分支。
 *
 * 环境约束（`src/shared/*` 的共同规矩，由 `test/bundle-sync.test.mjs` 机械守卫）：
 *   纯 ESM、零浏览器全局、零 Node API、零 React。
 *
 * **不在这里的东西**：
 *   - 每个码对应的中文/英文句子 —— 那是表现层，住在 i18n 字典里；
 *   - `status`（`idle` / `starting` / `loading` / `enabled` / `failed` / `exited` / `disabled`）
 *     —— 那是「现在处于哪个阶段」，不是「为什么没通」，两端一直是按英文字面量比的；
 *   - 「快捷键本身合不合法」的判据 —— 住在 `parseAccelerator` 与
 *     `src/client/pure/shortcut.js`，这里的 `invalid-shortcut` 只说「因为不合法所以没注册」。
 */

/**
 * 十三个码，按「helper 启动的先后」排列（顺序只是给读代码的人看的，不是契约）。
 *
 * Windows 的 PowerShell 子进程这条路上会依次碰到：
 * - `host-address-unknown`：连往哪个地址回调都没定下来（origin 非法、端口也不可用）。
 * - `script-build-failed`：脚本没生成出来（生成器自己判定参数不对）。
 * - `script-write-failed`：脚本没能写到磁盘上。
 * - `spawn-failed`：`spawn` 当场就抛了（连进程都没起来）。
 * - `start-failed`：进程起来了但立刻报错（`powershell.exe` 不存在、被安全策略拦、权限不足）。
 * - `exited-before-ready`：进程没打印「注册成功」就退出了（脚本崩了或被拦下）。
 * - `register-failed`：脚本跑到了，`RegisterHotKey` 返回 false —— 组合键被别的程序占用。
 * - `exited`：先前注册成功过，之后进程退出了（用户关掉、被杀、系统重启该进程）。
 *
 * macOS / Linux 的原生（uiohook）这条路：
 * - `native-unavailable`：原生模块加载不上或注册不起来（缺依赖、没辅助功能权限、
 *   Linux 没有显示服务器、被环境变量禁用 —— 具体哪一条看 `detail`）。
 *
 * 根本没打算启动的情况：
 * - `invalid-shortcut`：配置里的快捷键没法注册成系统热键（不合法、或被宿主拒绝）。
 * - `disabled-by-switch`：设置里「系统级热键」是关的。
 * - `no-global-voice`：浮层没开，热键按下去没人接，所以宿主跳过了注册。
 * - `unloaded`：插件被卸载/宿主退出，注册已释放。
 *
 * 成功和「正在做」没有码：那时 `reason` 是空串，界面按 `status` 出文案。
 */
export const HOTKEY_REASONS = Object.freeze({
  HOST_ADDRESS_UNKNOWN: 'host-address-unknown',
  SCRIPT_BUILD_FAILED: 'script-build-failed',
  SCRIPT_WRITE_FAILED: 'script-write-failed',
  SPAWN_FAILED: 'spawn-failed',
  START_FAILED: 'start-failed',
  EXITED_BEFORE_READY: 'exited-before-ready',
  REGISTER_FAILED: 'register-failed',
  EXITED: 'exited',
  NATIVE_UNAVAILABLE: 'native-unavailable',
  INVALID_SHORTCUT: 'invalid-shortcut',
  DISABLED_BY_SWITCH: 'disabled-by-switch',
  NO_GLOBAL_VOICE: 'no-global-voice',
  UNLOADED: 'unloaded',
})

/** 上面那张表的值集合（判据用它比对 helper 真正报出来的 `reason`）。 */
export const HOTKEY_REASON_VALUES = Object.freeze(Object.values(HOTKEY_REASONS))

/**
 * 这个码是不是词表里的？（宿主与客户端都用它，别各自写 `in` 判断。）
 * @param {unknown} reason - 待检查的值（允许是 undefined / 非字符串，一律当「不认识」）。
 * @returns {boolean}
 */
export function isHotkeyReason(reason) {
  return typeof reason === 'string' && HOTKEY_REASON_VALUES.includes(reason)
}
