/**
 * 「开麦前问一句模型就绪没有」这条链路上的原因码 —— 宿主与浏览器侧共用的**单源**词表。
 *
 * 为什么需要这一份（批次 18，docs/architecture-modernization.md §8.60）：
 *   宿主的 `/asr-ready` 与 `/asr-warmup` 以前直接在响应里写中文句子
 *   （`'识别模型还没下载，请先在设置里下载该档位'` 这些），而客户端拿到之后
 *   `data.reason || t('...')` —— **宿主给的那句优先**。
 *   界面是中英双语的（`src/client/main.js` 往宿主 locale 注册了 `{ zh, en }`），
 *   于是英文界面上开麦失败弹出的提示是中文。这句话该由谁出不该这么分：
 *   宿主不该管界面说什么语言，客户端又没法覆盖宿主已经给出的句子。
 *
 * 分工就定成这样：**宿主只报码**（说的是「哪一步没通」这件事实），
 * **文案由客户端的 i18n 决定**（`src/client/pure/i18n.js` 的键）。
 * 码表放 `src/shared`，因为它同时被 `src/host/index.js` 和
 * `src/client/dom/mic-button.js` import —— 一次拼错就会在两端之一红掉，
 * 而不是变成装机上一个对不上的分支。
 *
 * 环境约束（`src/shared/*` 的共同规矩，由 `test/bundle-sync.test.mjs` 机械守卫）：
 *   纯 ESM、零浏览器全局、零 Node API、零 React。
 *
 * **不在这里的东西**：
 *   - 每个码对应的中文/英文句子 —— 那是表现层，住在 i18n 字典里；
 *   - `/tts/warmup` 的 `reason` —— 客户端调它但**不看响应体**（`mic-button.js` 里那句
 *     `fetch(ROUTES.ttsWarmup).catch(() => {})`），那两个字面量是诊断文本，不进界面，
 *     所以没进这份词表（§8.60 把这个边界写明了）。
 */

/**
 * 四个码，按「开麦前检查的先后」排列（顺序只是给读代码的人看的，不是契约）。
 *
 * - `model-not-found`：配置里的识别档位在这套档位表中不存在（改坏了配置、或档位表变了）。
 * - `not-downloaded`：档位存在，但模型文件还没下到位。
 * - `loading`：模型已经下好，此刻还没加载进内存（首次比之后慢）。
 * - `load-failed`：加载这一步做了，但没成功。
 */
export const ASR_READY_REASONS = Object.freeze({
  MODEL_NOT_FOUND: 'model-not-found',
  NOT_DOWNLOADED: 'not-downloaded',
  LOADING: 'loading',
  LOAD_FAILED: 'load-failed',
})

/** 上面那张表的值集合（判据用它比对宿主真正回出来的 `reason`）。 */
export const ASR_READY_REASON_VALUES = Object.freeze(Object.values(ASR_READY_REASONS))

/**
 * 这个码是不是词表里的？（宿主与客户端都用它，别各自写 `in` 判断。）
 * @param {unknown} reason - 待检查的值（允许是 undefined / 非字符串，一律当「不认识」）。
 * @returns {boolean}
 */
export function isAsrReadyReason(reason) {
  return typeof reason === 'string' && ASR_READY_REASON_VALUES.includes(reason)
}
