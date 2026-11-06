/**
 * 「下载模型」这条链路上的原因码 —— 宿主与浏览器侧共用的**单源**词表（批次 22-4-1，docs §8.70）。
 *
 * 为什么需要这一份：宿主的模型下载失败时，`src/host/model-catalog.js` 抛的是**手写中文整句**
 * （`下载失败：${file.name}`、`仓库里没有这个文件：…（HTTP 404）`、`分片下载失败：…（第 3,5 片）`、
 * `拼接后大小不对：… != …`），后台任务 catch 住以后原样塞进 SSE 的 `model-error` 事件；
 * `/model` 路由自己还有两句写死的中文（404 `unknown model: {id}`、409 `宿主内置模型不可用：${label}`）
 * 直接进响应体的 `error` 字段。
 * 于是客户端那边的形状是：面板 `voice-settings-section.js` 收到 `model-error` 只有一句
 * `t('downloadFailed')`（事件里带的原因被整片丢掉），而 POST `/model` 的响应体走
 * `setStatus(body?.error ?? t('downloadFailed'))`（宿主那句中文原样上界面）。
 * **同一件事有两种相反的毛病**：一句该显示的原因显示不出来，一段不该显示的原文显示出来了。
 * 这跟批次 18（开麦就绪）、19（系统级热键）、20（配置校验）、22-3-2（环境自检）是同一个族，
 * 只是这次说话的人换成了下载流程。
 *
 * 分工照那一族的定法：**宿主只报码**（「哪一步没通」这件事实）+ 结构化参数，
 * **句子由客户端的 i18n 字典出**。宿主原来那句中文仍留在 `error` / `detail` 里，
 * 但那些字段的读者是 `/diagnostics`、console 与装机排查，**不是界面**。
 *
 * 码表放 `src/shared`：它同时被 `src/host/model-catalog.js` + `src/host/index.js`（发码）和
 * `src/client/pure/model-download-reason-text.js`（查句子）import —— 一次拼错会在两端之一红掉，
 * 而不是变成装机上一条永远走不到的分支。
 *
 * 环境约束（`src/shared/*` 的共同规矩，由 `test/bundle-sync.test.mjs` 机械守卫）：
 *   纯 ESM、零浏览器全局、零 Node API、零 React。
 *
 * **表里为什么只有十个码，而 `model-catalog.js` 里的抛出点比这多**：
 *   判据是「这句话会不会进界面」（§8.65）。下面这些抛点眼下**到不了界面**，所以不进表：
 *     - `status ${res.status}`（单连接与分片各一处）：抛出后立刻被同一个 `for (host of HOSTS)` 的
 *       catch 吞掉走重试，重试跑满才由上层抛成 `file-failed`；
 *     - `stalled`（两处）与单文件路径的 `sha mismatch`：同上，都是重试内部的噪音，
 *       最终外面看到的是 `file-failed`；
 *     - `分片大小不对：…`：也在那条重试的 try 里面，出不去。
 *   给它们建码只会让字典多几句界面上永远显示不出来的话。等哪天把它们改成非重试错误
 *   （那是要改行为的另一个批次），再往这张表里加，客户端那句会由「每个码都要有键」那条判据逼出来。
 *
 * **`chunk-incomplete` 与 `merged-size-mismatch` 为什么值得进表**：
 *   它们是合并落位前的最后一道校验，抛出去就直接终止下载（不在任何重试的 try 里），
 *   所以真会进界面。用网络行为构造不出来（要么大小对、要么被上一道的 `got !== size` 拦住），
 *   属于「防御性守卫」：判据靠「码表 ↔ 字典键一一对应」那条数据断言覆盖，不靠现场触发。
 */

/**
 * 十个码。顺序不是契约，命名才是（沿用批次 18/19/20/22-3-2 的规矩：读码就知道去哪一段代码）。
 *
 * 前七个来自 `ensureModel` 的下载流程（后台跑，经 SSE 的 `model-error` 送出），
 * 后三个来自 `POST /dsh-voice-typing/model` 这条路由本身（同步回执）。
 */
export const MODEL_DOWNLOAD_REASONS = Object.freeze({
  // —— 下载流程（`model-catalog.js`）——
  /** 档位里没有可下载的文件（既没 `repo` 也没 `files`）：这档位本身就不该显示「下载」按钮。 */
  NO_DOWNLOADABLE_FILES: 'no-downloadable-files',
  /** 单个文件重试跑满所有镜像与轮数还是没下下来（网络问题的兜底那句）。 */
  FILE_FAILED: 'file-failed',
  /** 仓库里根本没有这个文件（HTTP 404/403）：重试与换镜像都救不了，档位表写错了名字。 */
  FILE_NOT_IN_REPO: 'file-not-in-repo',
  /** 分片下载有分片失败（网络问题，不是文件不存在 —— 那种走 `file-not-in-repo`）。 */
  CHUNK_FAILED: 'chunk-failed',
  /** 合并前发现磁盘上的分片不全或大小不对。 */
  CHUNK_INCOMPLETE: 'chunk-incomplete',
  /** 分片拼完以后总大小不对。 */
  MERGED_SIZE_MISMATCH: 'merged-size-mismatch',
  /** 拼好的文件 sha256 与档位声明的不一致（内容坏了或服务端换过文件）。 */
  SHA_MISMATCH: 'sha-mismatch',
  // —— 路由本身（`index.js` 的 `POST /model`）——
  /** 请求里的档位 id 在档位表里找不到。 */
  UNKNOWN_MODEL: 'unknown-model',
  /** 内置档位（宿主 Bundle 提供的那份）本地文件不在位：这个档位没有「下载」这条路。 */
  HOSTED_UNAVAILABLE: 'hosted-unavailable',
  // —— 兜底 ——
  /** 抛出来的东西没带码（文件系统错误、宿主自己写的代码炸了……）：界面说「没下载成功，可重试」，
   *  原文只进 `/diagnostics`。有这一格，客户端就不需要读宿主那句中文当兜底了。 */
  FAILED_UNKNOWN: 'failed-unknown',
})

/** 上面那张表的值集合（判据用它比对宿主真正回出来的 `reason`）。 */
export const MODEL_DOWNLOAD_REASON_VALUES = Object.freeze(Object.values(MODEL_DOWNLOAD_REASONS))

/**
 * 这个码是不是词表里的？（宿主与客户端都用它，别各自写 `in` 判断。）
 * @param {unknown} reason - 待检查的值（允许 undefined / 非字符串，一律当「不认识」）。
 * @returns {boolean}
 */
export function isModelDownloadReason(reason) {
  return typeof reason === 'string' && MODEL_DOWNLOAD_REASON_VALUES.includes(reason)
}

/**
 * 每个码**必须**带的参数名（批次 20 的 `CONFIG_ERROR_PARAM_NAMES`、22-3-2 的
 * `TTS_ENV_REASON_PARAMS` 同一族规矩）。
 *
 * 为什么这张表值得存在：宿主少填一个参数，客户端那句子里就有一个没被填掉的 `{file}`
 * 直接显示给用户。判据拿这张表逐码核对「宿主现场收集到的参数名正好是这些」，
 * 于是「宿主加了个码忘了填参数」在测试里红，不在装机上红。
 *
 * 参数值是**机器事实或契约值**（档位 id、文件名、HTTP 状态码、分片序号、字节数），
 * 客户端按原样填进句子。`{model}` 一律用档位 **id** 而不是展示名 ——
 * 沿用 §8.66 那条裁定（展示名自己带括号，套进括号里读不通），
 * 而 409 那句原本用的是 `model.label`，这次改成 id 是有意的。
 */
export const MODEL_DOWNLOAD_REASON_PARAMS = Object.freeze({
  [MODEL_DOWNLOAD_REASONS.NO_DOWNLOADABLE_FILES]: Object.freeze(['model']),
  [MODEL_DOWNLOAD_REASONS.FILE_FAILED]: Object.freeze(['file']),
  [MODEL_DOWNLOAD_REASONS.FILE_NOT_IN_REPO]: Object.freeze(['file', 'status']),
  [MODEL_DOWNLOAD_REASONS.CHUNK_FAILED]: Object.freeze(['file', 'chunks']),
  [MODEL_DOWNLOAD_REASONS.CHUNK_INCOMPLETE]: Object.freeze(['file', 'chunk']),
  [MODEL_DOWNLOAD_REASONS.MERGED_SIZE_MISMATCH]: Object.freeze(['file', 'got', 'expected']),
  [MODEL_DOWNLOAD_REASONS.SHA_MISMATCH]: Object.freeze(['file']),
  [MODEL_DOWNLOAD_REASONS.UNKNOWN_MODEL]: Object.freeze(['model']),
  [MODEL_DOWNLOAD_REASONS.HOSTED_UNAVAILABLE]: Object.freeze(['model']),
  [MODEL_DOWNLOAD_REASONS.FAILED_UNKNOWN]: Object.freeze([]),
})

/**
 * 从「任何抛出来的东西」里取出界面能用的码与参数（广播与回执都用它）。
 *
 * 为什么要单独一个函数：`ensureModel` 抛的错误**不保证**带码 ——
 * 文件系统错误（`mkdir` 被拒、磁盘满）、宿主自己写崩的代码都会直接冒出来。
 * 那些原文是给 `/diagnostics` 看的，界面要的是一句能读懂的话。
 * 这里把「没带码 / 带的码不在表里」统一归到 `failed-unknown`，
 * 客户端因此**永远不需要**把宿主那句原文当文案来显示。
 *
 * @param {unknown} error - catch 到的任意值（Error、字符串、undefined 都收）。
 * @returns {{reason: string, params: object, message: string}} `message` 是原文，只给诊断。
 */
export function modelDownloadReasonOf(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const reason = isModelDownloadReason(error?.reason) ? error.reason : MODEL_DOWNLOAD_REASONS.FAILED_UNKNOWN
  const wanted = MODEL_DOWNLOAD_REASON_PARAMS[reason]
  const given = error?.params && typeof error.params === 'object' ? error.params : {}
  const params = {}
  for (const name of wanted) {
    if (given[name] !== undefined && given[name] !== null) params[name] = given[name]
  }
  return { reason, params, message }
}

/**
 * 给一个错误挂上原因码与参数（宿主下载流程的七个抛点用它）。
 *
 * 为什么用函数而不是各处手写 `Object.assign(error, { reason: '…' })`：
 *   手写会打错字符串，而打错的码在装机上表现为「界面显示那句兜底文案」，
 *   永远不会有人发现它对应不到任何句子。这里把「码必须在表里」与
 *   「表里要求填的参数名一个都不能少」检查放在**抛出的现场**：
 *   填错当场炸，测试里就能红（本仓库十个码有八个被 `test/model-download.test.mjs` 真跑触发）。
 *
 * @param {Error} error - 已经带好原文 message 的错误（原文只给诊断，不进界面）。
 * @param {string} reason - `MODEL_DOWNLOAD_REASONS` 里的一个码。
 * @param {Record<string, unknown>} [params] - 这个码要填的参数（多余的键会被忽略，缺的会当场报错）。
 * @returns {Error} 同一个错误对象，挂了 `reason` 与 `params`，方便继续链式抛。
 */
export function withModelDownloadReason(error, reason, params) {
  if (!isModelDownloadReason(reason)) {
    throw new TypeError(`模型下载的原因码不在词表里：${String(reason)}`)
  }
  const wanted = MODEL_DOWNLOAD_REASON_PARAMS[reason]
  const given = params && typeof params === 'object' ? params : {}
  const missing = wanted.filter((name) => given[name] === undefined || given[name] === null)
  if (missing.length) {
    throw new TypeError(`模型下载原因码 ${reason} 少了参数：${missing.join(', ')}`)
  }
  const filled = {}
  for (const name of wanted) filled[name] = given[name]
  error.reason = reason
  error.params = filled
  return error
}
