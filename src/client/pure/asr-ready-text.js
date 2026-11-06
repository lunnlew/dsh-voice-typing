/**
 * 开麦就绪原因码 → 界面文案（纯函数，不碰浏览器全局）。
 *
 * 为什么要单独一个模块（批次 18，docs/architecture-modernization.md §8.60）：
 *   宿主的 `/asr-ready` 与 `/asr-warmup` 现在只回**原因码**
 *   （`src/shared/asr-readiness.js`），界面那句话由这里的映射给出。
 *   以前这条链路上是 `data.reason || t('...')` —— 宿主那句中文优先，
 *   英文界面上开麦失败就弹中文提示。这句「谁出界面文案」现在定下来了：只有这里出，
 *   「宿主说什么语言」这件事不再影响界面。
 *
 * 映射表住在这里而不是 `mic-button.js`，是因为它需要被单测直接驱动：
 *   词表里每个码都要有对应键（漏一个就是装机上一句生硬的兜底文案），
 *   而词表外的值（宿主版本不一致、脏数据、旧产物）必须走兜底而不是显示出来。
 *
 * 环境约束（`src/client/pure/*` 的共同规矩）：不依赖浏览器全局、不依赖 React，Node 里可原生 import。
 */
import { isAsrReadyReason } from '../../shared/asr-readiness.js'

/**
 * 原因码 → i18n 键。
 *
 * 键的选择有讲究：`loading` 与 `load-failed` 复用界面本来就在用的那两个键
 * （加载中 / 加载失败各自已有中英说法），只有这条链路独有的两种情形才新增键。
 * 新增的两个跟着 `*Detail` 的命名走 —— 它们填的是悬停长说明那一格，
 * 状态行的短词始终是「模型加载失败」（`modelFailed`），不随码变。
 */
export const ASR_READY_REASON_KEYS = Object.freeze({
  'model-not-found': 'modelNotFoundDetail',
  'not-downloaded': 'modelNotDownloadedDetail',
  loading: 'modelLoadingDetail',
  'load-failed': 'modelFailedDetail',
})

/**
 * 把宿主回的原因码翻成当前语言的句子。
 *
 * @param {unknown} reason - 宿主回的 `reason`（词表外的值、空值、非字符串都算「不认识」）。
 * @param {(key: string) => string} t - i18n 取词函数（宿主 locale 提供，测试里传恒等函数）。
 * @param {string} fallbackKey - 认不出这个码时用的键（默认「加载失败」那条兜底说明）。
 * @returns {string} 界面要显示的句子（取不到词时是 `t` 自己给的键名）。
 */
export function asrReadyReasonText(reason, t, fallbackKey = 'modelFailedDetail') {
  const key = isAsrReadyReason(reason) ? ASR_READY_REASON_KEYS[reason] : undefined
  return t(key ?? fallbackKey)
}
