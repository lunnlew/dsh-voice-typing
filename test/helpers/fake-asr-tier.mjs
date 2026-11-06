/**
 * 测试接缝：造一个「宿主认得出、而且能在假依赖下真加载成功」的识别档位。
 *
 * 为什么需要它（批次 6l-e，docs/architecture-modernization.md §8.46）：
 *   要让 `/asr-warmup` 真的回 `ready:true`、要让已加载名单真的被记上又摘下，
 *   缺的不是替身而是**档位形状**：宿主的 `modelPaths`（src/host/model-catalog.js）
 *   按**文件名**认这条引擎要哪几个路径
 *   （`endsWith('tokens.txt')`、`includes('encoder' | 'decoder' | 'joiner')`），
 *   whisper 档位要的是 `model-encoder.onnx` + `model-decoder.onnx` + `tokens.txt` 三个文件。
 *   名字随便起（比如 `model.onnx` / `model.onnx.tokens`）的话 `tokens` 解析成 null，
 *   worker 构造识别器时就抛 —— 判据红的是夹具，不是被测代码。
 *   这份形状原来只写在 `test/worker-protocol.test.mjs` 里，
 *   现在第二个用例（`test/listening-ready.test.mjs` 的记入/摘除）也要它，于是搬到这里共用。
 *
 * 用法：
 *   const { tier, files } = makeWhisperTier('test-ledger/model', 'test/ledger')
 *   placeTierFiles(home, tier, files)                 // 「已经下载好」= 按宿主认的位置摆盘
 *   const cdn = await startFakeCdn({ files: cdnFiles(tier, files) })  // 要重下时给它喂同一份内容
 */
import fs from 'node:fs'
import path from 'node:path'
import { digest } from './fake-cdn.mjs'

/**
 * 合成一个 whisper 档位：内容 sha 由测试自己算，于是宿主的路由跑的是真判据。
 * @param {string} id - 档位 id（客户端配置的 model 就写它）。
 * @param {string} repo - 假仓库名（决定落盘目录与 CDN 键）。
 * @returns {{tier: object, files: Array<{name: string, body: Buffer}>}}
 */
export function makeWhisperTier(id, repo) {
  const files = [
    { name: 'model-encoder.onnx', body: Buffer.from('enc'.repeat(64)) },
    { name: 'model-decoder.onnx', body: Buffer.from('dec'.repeat(64)) },
    { name: 'tokens.txt', body: Buffer.from('假\n词\n表\n') },
  ]
  const tier = {
    id,
    label: `测试档位 ${id}`,
    labelEn: `Test ${id}`,
    engine: 'whisper',
    repo,
    revision: 'main',
    bytes: files.reduce((sum, f) => sum + f.body.length, 0),
    note: '',
    noteEn: '',
    languages: ['zh'],
    files: files.map((f) => ({
      name: f.name,
      bytes: f.body.length,
      sha256: digest(f.body),
    })),
  }
  return { tier, files }
}

/** 把档位文件摆进宿主认的位置（`DSH_HOME/voice-typing/models/<repo>/<name>`）。 */
export function placeTierFiles(home, tier, files) {
  const dir = path.join(home, 'voice-typing', 'models', tier.repo)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.body)
}

/** 同一份内容换成 fake-cdn 要的键（`<repo>/<name>` → { buffer }），给「真重下」用。 */
export function cdnFiles(tier, files) {
  const out = {}
  for (const f of files) out[`${tier.repo}/${f.name}`] = { buffer: f.body }
  return out
}
