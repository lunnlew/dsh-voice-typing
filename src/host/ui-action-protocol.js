/**
 * UI 动作协议（宿主侧入口）。
 *
 * 实现不在这里 —— 住在 `src/shared/ui-action-protocol.js`（**单源**，
 * 浏览器侧 `src/client/pure/ui-action-protocol.js` 引的是同一个模块）。
 * 这条判据两端**常数为零**（动作白名单、参数上限、确认策略必须一模一样），
 * 所以这里连 `createXxx(defaults)` 式的注入都没有，纯转发。
 *
 * 为什么这个文件还留着（而不是让 `lib/index.js` 直接 import shared）：
 *   1. 它是既有公共面 —— `lib/index.js`、`test/ui-action-protocol.test.mjs`、
 *      README 与 docs 都按 `lib/ui-action-protocol.js` 这个路径引用它；
 *   2. 「宿主侧入口」这个名字回答了「宿主用的是哪一份」，
 *      等第 4 步按职责拆文件时再和其它 `lib/*` 一起收敛。
 *
 * 导出名**逐个写出来**而不是 `export *`：构建脚本靠静态导出名生成
 * 浏览器侧的 import（`scripts/build-client.mjs` 的 `exportsOf()`），
 * 少写一个名字会在产物里变成「未定义」而不是构建期报错。
 */
export {
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
} from '../shared/ui-action-protocol.js'
