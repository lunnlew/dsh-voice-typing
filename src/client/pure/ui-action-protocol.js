/**
 * UI 动作协议（浏览器侧入口）。
 *
 * 实现不在这里 —— 住在 `src/shared/ui-action-protocol.js`（**单源**，
 * 宿主 `lib/ui-action-protocol.js` 引的是同一个模块）。
 * 客户端执行器在动手前还要再校验一次（挡被伪造/重放的 SSE），
 * 用的就是这一份 —— 两端规则不可能分叉，因为只有一份。
 *
 * 本文件能被 Node 原生 import（`main.js` 与测试都直接用它），不依赖浏览器全局。
 * 导出名逐个写出来而不是 `export *`：`scripts/build-client.mjs` 靠静态导出名
 * 生成入口的 import 语句，`export *` 它读不到名字。
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
} from '../../shared/ui-action-protocol.js'
