/**
 * 解码循环与它的步数上限 —— 宿主主线程与识别工作线程共用这一份（批次 6k，docs §8.44）。
 *
 * 为什么这件事必须收在一处：
 *   流式模型的解码是 `while (recognizer.isReady(stream)) decode(stream)`。
 *   正常情况下 `decode` 会消费掉音频、让 `isReady` 变假，循环自然结束。
 *   一旦 `decode` 因为任何原因不推进状态（原生绑定的边界情况、音频长度不是 chunk 的整数倍等），
 *   这个循环**永不退出**：
 *     - 跑在宿主主线程 → 整个应用卡住、界面无响应，被看门狗杀掉重启，
 *       表现出来就是「整个 DSH 闪退」；
 *     - 跑在识别线程 → 那一条 `/transcribe` 永远不回话（`recognizeInWorker` 的等待没有超时），
 *       而且线程从此一直是满 CPU，后面的识别请求全排队。
 *   所以必须有上限：它把「死循环」变成「少识别几个字」。
 *
 *   改之前这个上限住在 `src/host/index.js`，两处循环各自写着；`src/host/asr-worker.js`
 *   里那**第三处没有上限**。老的那道守卫（`test/decode-guard.test.mjs`）是扫 index.js
 *   源码的正则，它口中「所有解码循环」其实只有它扫得到的那两处 —— 实录见 docs §8.44。
 *   现在循环只有一处实现，三个调用点都走它；「别处不许自己写解码循环」由
 *   `eslint.config.js` 的 `HOST_DECODE_LOOP_BAN` 钉住（真树上由 `test/no-undef.test.mjs`
 *   的全树 lint 执行，边界由那里的探针守住）。
 *
 * 上限值是生产的选择，不是判据：`test/decode-guard.test.mjs` 只观测
 * 「不推进状态时有限步内返回」与「要 800 步的流不被截断」两件事，
 * 不把这里的数字抄进断言里。一段 30 秒音频按 0.1 秒的 chunk 算最多约 300 步。
 */

/** 单次解码最多走多少步（安全阀）。 */
export const MAX_DECODE_STEPS = 10000

/**
 * 把一个流式识别器解到「不够再解」为止，带步数上限。
 *
 * @param recognizer - sherpa 识别器（在线档；`isReady` 在某些包上不存在）。
 * @param stream - 识别流。
 * @param [step] - 真正解码的那一下。主线程用 `decodeStream ?? decode`、worker 用 `decode` ——
 *   两边取法历史上就不同，这里不顺手统一它（统一它是另一次行为改动，要单独判）。
 * @returns {number} 实际走了几步（只是给调用方留个可观测的量，行为不依赖它）。
 */
export function decodeOnlineStream(recognizer, stream, step = (r, s) => r.decode(s)) {
  if (!recognizer.isReady) {
    // 没有 isReady 的包：解一次就拿结果（与三个调用点改之前的 else 分支一致）。
    step(recognizer, stream)
    return 1
  }
  let steps = 0
  while (recognizer.isReady(stream) && steps++ < MAX_DECODE_STEPS) {
    step(recognizer, stream)
  }
  return steps
}
