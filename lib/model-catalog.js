/**
 * 模型档位目录与本地模型管理（识别档位 + 本地神经 TTS 档位）。
 *
 * 设计原则：
 *   - 默认档零下载：直接复用 DSH 内置的 SenseVoice 模型文件（已在
 *     ~/.dsh/speech-to-text/sensevoice，本机无需联网、无需密钥）；
 *   - 其它档位按需下载到插件自己的缓存目录，带 SHA256 校验与断点续传，
 *     大文件走分片并行下载；
 *   - 识别后端统一是 sherpa-onnx 本地推理，sensevoice / whisper /
 *     zipformer2 只是模型家族不同；合成侧另有一批 sherpa-onnx VITS 档位，
 *     与识别档位共用同一套下载与缓存机制。
 *
 * @module dsh-voice-typing/model-catalog
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { replaceFile } from './atomic-file.js'

/** 插件缓存根目录。 */
export function cacheRoot() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'voice-typing', 'models')
}

/** 模型下载源（国内优先走镜像）。 */
const HOSTS = ['https://hf-mirror.com', 'https://huggingface.co']

/**
 * Whisper 各档的 tokens 文件描述。
 *
 * 六个档位用的是**同一份词表**（大小与 sha256 完全一致），
 * 但**文件名带档位前缀**，各仓库里分别是：
 *   tiny-tokens.txt / base-tokens.txt / small-tokens.txt /
 *   medium-tokens.txt / turbo-tokens.txt / large-v3-tokens.txt
 * 之前一律叫 tokens.txt → 全部 404 → 重试 80 次后失败，
 * **所有 Whisper 档位都永远下不下来**。
 *
 * @param {string} prefix - 档位前缀（tiny / base / …）。
 * @returns {object} 文件描述。
 */
function whisperTokens(prefix) {
  return {
    name: `${prefix}-tokens.txt`,
    bytes: 816_730,
    sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126',
  }
}

/**
 * 模型档位清单。
 *
 * 关于 files[].bytes：
 *   它只是给界面显示用的**近似值**（比如「99MB」）。
 *   下载时一律以服务端返回的真实大小为准（probeFileSize）——
 *   之前拿这里的值去切分片，Whisper 那一组差了几百 KB 到 4 MB，
 *   导致文件尾部永远下不到、sha256 必然不匹配、模型永远下不下来。
 *
 * engine（sherpa-onnx 的模型家族，决定用哪套配置）：
 *   - `sensevoice` 离线 SenseVoice（中文强，带标点与数字规范化）；
 *   - `whisper`    sherpa-onnx 离线 Whisper（int8 ONNX）；
 *   - `online`     sherpa-onnx 流式 zipformer2。
 *
 * host（是否宿主内置模型）：为 true 表示复用 DSH 已装好的本地模型，零下载。
 * 判断「内置模型 / 不需要下载」时一律用 isHostedModel()，不要比较 engine 字符串。
 */
export const MODELS = [
  {
    id: 'sensevoice',
    label: 'SenseVoice（推荐 · 中文强 · 带标点与数字规范化）',
    labelEn: 'SenseVoice (recommended · strong Mandarin, punctuation + ITN)',
    engine: 'sensevoice',
    // 宿主内置优先：装了 DSH 语音输入 Bundle 的话直接复用，零下载。
    host: true,
    // 但**不能**只依赖宿主 —— 用户没装那个 Bundle 时，
    // 这个默认档位就永久不可用，用户只能去下几百 MB 的 Whisper。
    // 所以这里同时给出下载源：宿主没有就由本插件自己下一份。
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    // 钉死上游版本：main 分支会变，变了以后 sha256 对不上、
    // 已经下好的文件也会被判成损坏。不可变 revision 才稳。
    revision: '2365baeacb507f821a0c8120fcee3d484dba7a07',
    bytes: 239_233_841 + 315_894,
    languages: ['zh', 'en', 'yue', 'ja', 'ko'],
    files: [
      { name: 'model.int8.onnx', bytes: 239_233_841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
      { name: 'tokens.txt', bytes: 315_894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
    ],
    note: '优先复用 DSH 内置的本地模型（~/.dsh/speech-to-text），零下载；没装语音输入 Bundle 时由本插件自动下载一份（约 230MB）。',
    noteEn: 'Prefers the built-in DSH model (~/.dsh/speech-to-text, no download); downloads its own copy (~230MB) when that bundle is missing.',
  },
  {
    id: 'zipformer2-zh',
    label: 'Zipformer2 中文（流式 · 精度一般 · 较慢）',
    labelEn: 'Zipformer2 Mandarin (streaming · lower accuracy · slower)',
    engine: 'online',
    host: false,
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
    bytes: 161_141_793 + 4_930_000 + 1_040_000 + 20_000,
    languages: ['zh'],
    files: [
      { name: 'encoder.int8.onnx', bytes: 161_141_793, sha256: '5ac51e27981bb4dab01bb9be4958453ba50c3b61c063ddda0eab23fd3671aa4f' },
      { name: 'decoder.onnx', bytes: 4_930_000, sha256: '06522ad63cec0fdf6809f4e1db9bb4f7d710c34582e3b35db62ac60eccafac7e' },
      { name: 'joiner.int8.onnx', bytes: 1_040_000, sha256: 'b34584dc6f561089e1d747fedebb3765f2caa72c927ef54d7ca55e5ae40a814b' },
      { name: 'tokens.txt', bytes: 20_000, sha256: '6193c7ea1c96d0d9a1e9652789b40d13a8a913b434a5451e93158f5a09fd6652' },
    ],
    note: '流式引擎，精度一般。在工作线程里跑（界面不卡），但首次识别要加载 160MB 模型、约 40 秒，之后每次约 2 秒。热词提示只在这一档有效。',
    noteEn: 'Streaming engine, lowest latency; weaker punctuation/ITN than SenseVoice.',
  },
  {
    id: 'whisper-tiny',
    label: 'Whisper tiny（最轻 · 99MB）',
    labelEn: 'Whisper tiny (lightest · 99MB)',
    engine: 'whisper',
    host: false,
    repo: 'csukuangfj/sherpa-onnx-whisper-tiny',
    bytes: 12_300_000 + 85_700_000 + 816_730,
    languages: ['zh', 'en'],
    files: [
      { name: 'tiny-encoder.int8.onnx', bytes: 12_937_772, sha256: 'd24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434' },
      { name: 'tiny-decoder.int8.onnx', bytes: 89_855_401, sha256: 'd2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925' },
      whisperTokens('tiny'),
    ],
    note: '体积最小，适合先跑通；中文精度有限。',
    noteEn: 'Smallest download; Mandarin accuracy is limited.',
  },
  {
    id: 'whisper-base',
    label: 'Whisper base（轻量 · 153MB）',
    labelEn: 'Whisper base (light · 153MB)',
    engine: 'whisper',
    host: false,
    repo: 'csukuangfj/sherpa-onnx-whisper-base',
    bytes: 27_800_000 + 124_600_000 + 816_730,
    languages: ['zh', 'en'],
    files: [
      { name: 'base-encoder.int8.onnx', bytes: 27_800_000, sha256: '0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11' },
      { name: 'base-decoder.int8.onnx', bytes: 124_600_000, sha256: '9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d' },
      whisperTokens('base'),
    ],
    note: '速度与体积折中；中文可用。',
    noteEn: 'Speed/size trade-off; usable for Mandarin.',
  },
  {
    id: 'whisper-small',
    label: 'Whisper small（均衡 · 358MB）',
    labelEn: 'Whisper small (balanced · 358MB)',
    engine: 'whisper',
    host: false,
    repo: 'csukuangfj/sherpa-onnx-whisper-small',
    bytes: 107_200_000 + 250_100_000 + 816_730,
    languages: ['zh', 'en'],
    files: [
      { name: 'small-encoder.int8.onnx', bytes: 107_200_000, sha256: '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9' },
      { name: 'small-decoder.int8.onnx', bytes: 250_100_000, sha256: 'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee' },
      whisperTokens('small'),
    ],
    note: '精度明显优于 base；速度仍可接受。',
    noteEn: 'Clearly more accurate than base; still fast enough.',
  },
  {
    id: 'whisper-medium',
    label: 'Whisper medium（较准 · 902MB）',
    labelEn: 'Whisper medium (accurate · 902MB)',
    engine: 'whisper',
    host: false,
    repo: 'csukuangfj/sherpa-onnx-whisper-medium',
    bytes: 356_900_000 + 544_600_000 + 816_730,
    languages: ['zh', 'en'],
    files: [
      { name: 'medium-encoder.int8.onnx', bytes: 356_900_000, sha256: '1c54582b4d829de0089f6cb63bbbdb3bf7555398bacaf855fbecf1a84dfd193e' },
      { name: 'medium-decoder.int8.onnx', bytes: 544_600_000, sha256: '595d00a338a365a7bfa0ca7f296cabc639583bef770ab6130df90f49a6412747' },
      whisperTokens('medium'),
    ],
    note: '精度再上一档，体积与耗时都上升。',
    noteEn: 'Another accuracy step up, with more size and time.',
  },
  {
    id: 'whisper-turbo',
    label: 'Whisper large-v3-turbo（很准 · 989MB）',
    labelEn: 'Whisper large-v3-turbo (very accurate · 989MB)',
    engine: 'whisper',
    host: false,
    repo: 'csukuangfj/sherpa-onnx-whisper-turbo',
    bytes: 643_500_000 + 344_400_000 + 816_730,
    languages: ['zh', 'en'],
    files: [
      { name: 'turbo-encoder.int8.onnx', bytes: 643_500_000, sha256: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b' },
      { name: 'turbo-decoder.int8.onnx', bytes: 344_400_000, sha256: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547' },
      whisperTokens('turbo'),
    ],
    note: '综合最优：接近 large-v3 的精度，体积小一半。',
    noteEn: 'Best overall: near large-v3 accuracy at half the size.',
  },
  {
    id: 'whisper-large-v3',
    label: 'Whisper large-v3（最准 · 1.7GB）',
    labelEn: 'Whisper large-v3 (most accurate · 1.7GB)',
    engine: 'whisper',
    host: false,
    repo: 'csukuangfj/sherpa-onnx-whisper-large-v3',
    bytes: 731_200_000 + 961_600_000 + 816_730,
    languages: ['zh', 'en'],
    files: [
      { name: 'large-v3-encoder.int8.onnx', bytes: 731_200_000, sha256: 'd531cf17248acc43e8c09b472a0877055e770877857a5332fc1304b36534ec85' },
      { name: 'large-v3-decoder.int8.onnx', bytes: 961_600_000, sha256: 'ebc6bfd88e162a46cb3edee8a7e727e1dcbc65cabecb19e2573695e4d495e1af' },
      whisperTokens('large-v3'),
    ],
    note: '精度天花板，体积与推理耗时最大。',
    noteEn: 'Accuracy ceiling; largest download and slowest inference.',
  },
]

/**
 * 本地 TTS 模型档位（sherpa-onnx VITS）。
 * 与识别模型共用同一套下载/缓存机制（~/.dsh/voice-typing/models）。
 */
export const TTS_MODELS = [
  {
    id: 'vits-melo-zh_en',
    label: 'MeloTTS 中英（多说话人 · 本地离线 · 音质好）',
    labelEn: 'MeloTTS Chinese+English (multi-speaker, local, good quality)',
    engine: 'vits',
    host: false,
    repo: 'csukuangfj/vits-melo-tts-zh_en',
    bytes: 170429550 + 6837671 + 655 + 59154 + 21974 + 64482 + 88630,
    speakers: 1,
    languages: ['zh', 'en'],
    // 用浮点模型（model.onnx）而不是 int8：
    // int8 量化的 VITS 在部分平台上会退化到 0.03 倍实时（每字 6 秒），
    // 浮点模型虽然大 3 倍，但推理速度是数量级的差别。
    files: [
      { name: 'model.onnx', bytes: 170429550, sha256: 'bf30582eb1b012250a35b1a4a80e7dfbcf8485e7bb9de0d95efbbeef0e4ad86d' },
      { name: 'lexicon.txt', bytes: 6837671 },
      { name: 'tokens.txt', bytes: 655 },
      // 数字/日期/多音字的 FST 规则
      { name: 'date.fst', bytes: 59154 },
      { name: 'new_heteronym.fst', bytes: 21974 },
      { name: 'number.fst', bytes: 64482 },
      { name: 'phone.fst', bytes: 88630 },
    ],
    note: '完全离线的神经网络音色，比系统语音自然得多；首次使用需下载约 170MB。',
    noteEn: 'Fully offline neural voices, much more natural than system voices; ~170MB download on first use.',
  },
]

/**
 * 按 id 找 TTS 档位。
 * @param {string} id - 档位 id。
 * @returns {object|undefined} 档位。
 */
export function findTtsModel(id) {
  return TTS_MODELS.find((m) => m.id === id)
}

/**
 * 解析 TTS 模型的本地路径。
 * @param {object} model - TTS 档位。
 * @returns {{model: string, lexicon: string, tokens: string, dataDir: string}} 本地路径。
 */
export function ttsModelPaths(model) {
  const dir = join(cacheRoot(), model.repo)
  return {
    model: join(dir, model.files.find((f) => f.name.endsWith('.onnx'))?.name ?? 'model.int8.onnx'),
    lexicon: join(dir, 'lexicon.txt'),
    tokens: join(dir, 'tokens.txt'),
    // jieba 分词词典目录。当前合成线程只用 model/lexicon/tokens，
    // 这个路径先留着，等真要用 jieba 分词时再传进 worker。
    dataDir: join(dir, 'dict'),
  }
}

/**
 * 判断某个档位是不是「宿主内置模型」（复用 DSH 已装好的本地模型，零下载）。
 *
 * 这是**唯一权威判定**：所有需要判断「这是内置模型、不需要下载」的地方都用它，
 * 不要再去比较 engine 字符串（engine 描述的是 sherpa-onnx 的模型家族，
 * 与「是否要下载」是两件事）。
 *
 * @param model - 档位。
 * @returns 是否为宿主内置模型。
 */
export function isHostedModel(model) {
  return Boolean(model && model.host === true)
}

/** 按 id 取档位。 */
export function findModel(id) {
  return MODELS.find((m) => m.id === id)
}

/**
 * 宿主已下载好的 SenseVoice 模型位置（官方语音输入 Bundle 装好的那份）。
 * 复用它意味着本插件零下载即可用上本地中文识别。
 * @returns 模型文件路径，或 null（宿主未安装该 Bundle）。
 */
export function hostSenseVoicePaths() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const root = join(home, 'speech-to-text', 'sensevoice', 'models')
  const model = join(root, 'sensevoice-onnx', 'model.int8.onnx')
  const tokens = join(root, 'sensevoice-onnx', 'tokens.txt')
  const vad = join(root, 'silero', 'silero_vad.onnx')
  if (!existsSync(model) || !existsSync(tokens)) return null
  return { model, tokens, vad: existsSync(vad) ? vad : null }
}

/**
 * 本插件自己下载的那份 SenseVoice 的路径。
 * @returns {model, tokens, vad} 路径组合；文件不齐时返回 null。
 */
export function localSenseVoicePaths(model) {
  if (!model?.repo) return null
  const dir = join(cacheRoot(), model.repo)
  const onnx = join(dir, 'model.int8.onnx')
  const tokens = join(dir, 'tokens.txt')
  if (!existsSync(onnx) || !existsSync(tokens)) return null
  return { model: onnx, tokens, vad: null }
}

/**
 * 某档位的模型文件实际路径。
 *
 * SenseVoice 有两个来源，宿主优先：
 *   1. DSH 语音输入 Bundle 装好的那份（~/.dsh/speech-to-text）→ 零下载；
 *   2. 本插件自己下载的一份（~/.dsh/voice-typing/models）→ 用户没装那个 Bundle 时的兜底。
 *
 * @param model - 档位。
 * @returns {model, tokens, vad} 路径组合。
 */
export function modelPaths(model) {
  if (isHostedModel(model)) {
    const hosted = hostSenseVoicePaths()
    if (hosted) return hosted
    const local = localSenseVoicePaths(model)
    if (local) return local
    throw new Error(
      'SenseVoice 模型不可用：宿主未安装语音输入 Bundle，且本插件尚未下载。请在设置里下载该档位。',
    )
  }
  const dir = join(cacheRoot(), model.repo)
  const tokensFile = model.files.find((f) => f.name.endsWith('tokens.txt'))
  const encoderFile = model.files.find((f) => f.name.includes('encoder'))
  const decoderFile = model.files.find((f) => f.name.includes('decoder'))
  const joinerFile = model.files.find((f) => f.name.includes('joiner'))
  return {
    model: null,
    tokens: tokensFile ? join(dir, tokensFile.name) : null,
    encoder: encoderFile ? join(dir, encoderFile.name) : null,
    decoder: decoderFile ? join(dir, decoderFile.name) : null,
    joiner: joinerFile ? join(dir, joinerFile.name) : null,
  }
}

/** 计算文件 sha256。 */
export async function sha256Of(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', (d) => h.update(d))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

/**
 * 已校验过的文件（path → {size, mtimeMs, ok}）。
 *
 * 校验大文件（whisper-large 编码器约 731MB）要好几秒，
 * 而「是否就绪」会被设置面板、预加载、下载路由反复问 ——
 * 每个文件每次都重新算哈希的话，光是打开设置面板就要读一遍几个 GB。
 *
 * 所以缓存校验结论：文件的大小和修改时间都没变，就说明内容没变，
 * 直接用上次的结论；变了才重新算。
 */
const verifiedFiles = new Map()

/**
 * 某个文件是否与清单里的 sha256 一致。
 *
 * 没有 sha256 的文件（HF 上非 LFS 的小文件，如 .fst、jieba 词典）
 * 一律当作通过 —— 强制校验会让这些文件永远校验失败、反复重下。
 * @param {string} path - 文件路径。
 * @param {object} file - 文件描述（含 sha256）。
 * @returns {Promise<boolean>} 是否通过。
 */
async function fileMatchesHash(path, file) {
  if (!file?.sha256) return true
  let info
  try {
    info = await stat(path)
  } catch {
    return false
  }
  const cached = verifiedFiles.get(path)
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.ok
  let ok = false
  try {
    ok = (await sha256Of(path)) === file.sha256
  } catch {
    ok = false
  }
  verifiedFiles.set(path, { size: info.size, mtimeMs: info.mtimeMs, ok })
  return ok
}

/**
 * 记住「这个文件刚校验过且通过」（下载完立刻调用，省掉一次重新哈希）。
 * @param {string} path - 文件路径。
 */
async function markVerified(path) {
  try {
    const info = await stat(path)
    verifiedFiles.set(path, { size: info.size, mtimeMs: info.mtimeMs, ok: true })
  } catch {
    /* 文件不在就没什么好记的 */
  }
}

/**
 * 某档位在本地是否已就绪（文件齐全且校验通过）。
 *
 * 有 sha256 的文件要**校验内容**：只看「文件存在且非空」的话，
 * 一个被截断/损坏的模型文件会被判成「已就绪」，
 * 于是下载路由直接回 alreadyReady、永远不再重下，
 * 用户卡在一个「界面显示已就绪、模型却加载不了」的状态上，只能手动删文件。
 * @param model - 档位。
 * @returns 是否就绪。
 */
export async function isModelReady(model) {
  if (!model) return false
  // 宿主那份在 → 就绪（零下载）。宿主自己管的文件不去哈希。
  if (isHostedModel(model) && hostSenseVoicePaths() !== null) return true
  // 否则看本插件自己下的那份齐不齐
  if (!model.files?.length) return false
  const dir = join(cacheRoot(), model.repo)
  for (const file of model.files) {
    const path = join(dir, file.name)
    if (!existsSync(path)) return false
    if ((await stat(path)).size === 0) return false
    if (!(await fileMatchesHash(path, file))) return false
  }
  return true
}

/**
 * 列出所有档位及本地状态。
 * @returns 档位数组，带 ready 标记与实际占用。
 */
export async function listModels() {
  const out = []
  for (const model of MODELS) {
    const ready = await isModelReady(model)
    let present = 0
    if (isHostedModel(model)) {
      const paths = hostSenseVoicePaths()
      if (paths) {
        for (const path of [paths.model, paths.tokens, paths.vad]) {
          if (path && existsSync(path)) present += (await stat(path)).size
        }
      }
    } else {
      const dir = join(cacheRoot(), model.repo)
      for (const file of model.files) {
        const path = join(dir, file.name)
        if (existsSync(path)) present += (await stat(path)).size
      }
    }
    out.push({
      id: model.id,
      label: model.label,
      labelEn: model.labelEn,
      engine: model.engine,
      /** 是否为宿主内置模型（内置模型不需要下载）。 */
      host: isHostedModel(model),
      bytes: model.bytes,
      languages: model.languages,
      note: model.note,
      noteEn: model.noteEn,
      ready,
      presentBytes: present,
    })
  }
  return out
}

/**
 * 下载某档位缺失的文件（断点续传 + SHA256 校验）。
 * @param model - 档位。
 * @param onProgress - 进度回调 (receivedBytes, totalBytes)。
 * @returns 完成后返回 true。
 */
export async function ensureModel(model, onProgress) {
  if (!model) return true
  // 宿主那份在 → 什么都不用做（零下载）。
  // 宿主没有 → 继续往下走，由本插件自己下一份。
  // 之前这里对 hosted 模型直接 return true，
  // 于是「用户没装语音输入 Bundle」时 SenseVoice 永远下不下来、
  // 也就永远不可用 —— 默认档位直接废了。
  if (isHostedModel(model) && hostSenseVoicePaths() !== null) return true
  if (!model.repo || !model.files?.length) {
    throw new Error(`该档位没有可下载的文件：${model.id}`)
  }
  const dir = join(cacheRoot(), model.repo)
  await mkdir(dir, { recursive: true })

  // 先探测每个文件的真实大小。
  // 档位里的 bytes 是估计值，拿它切分片会漏掉文件尾部的字节，
  // 合并出来的文件不完整、sha256 必然不匹配，模型就永远下不下来。
  const sizes = []
  for (const file of model.files) {
    const probed = await probeFileSize(model.repo, file, model.revision)
    sizes.push(probed ?? file.bytes)
  }
  const total = sizes.reduce((sum, n) => sum + n, 0)

  // 进度语义：
  //   doneBytes  = 已经完整下好的文件字节数
  //   fileReceived = 当前文件已下载的字节数（下载层给的**绝对值**，不是增量）
  // 分开算，重试轮次才不会把同一份字节重复累加
  // （之前用「增量」语义，重试 5 轮就把进度加了 5 倍，显示 61MB 而实际只有 12MB）。
  let doneBytes = 0
  for (let i = 0; i < model.files.length; i++) {
    const file = model.files[i]
    const size = sizes[i]
    const dest = join(dir, file.name)
    // 有些模型的文件在子目录里（如中文 VITS 的 jieba 词典 dict/…），
    // 必须单独建父目录，否则写文件会 ENOENT。
    await mkdir(dirname(dest), { recursive: true })
    // sha256 可选：HF 上非 LFS 的小文件（如 .fst、jieba 词典）拿不到哈希，
    // 强制校验会导致这些文件永远校验失败、反复重下。
    // fileMatchesHash 顺手把校验结论记进缓存，后面 isModelReady 不用再算一遍。
    if (existsSync(dest) && (await fileMatchesHash(dest, file))) {
      doneBytes += size
      onProgress?.(doneBytes, total)
      continue
    }
    const ok = await downloadFile(model.repo, file, dest, size, (fileReceived) => {
      onProgress?.(doneBytes + fileReceived, total)
    }, model.revision)
    if (!ok) throw new Error(`下载失败：${file.name}`)
    // 下载过程已经校验过 sha256 了，记进缓存：
    // 别让之后的 isModelReady 再把几个 GB 读一遍。
    await markVerified(dest)
    doneBytes += size
    onProgress?.(doneBytes, total)
  }
  return true
}

/**
 * 下载单个文件：Range 断点续传 + 停滞看门狗 + 校验。
 *
 * @param repo - HF 仓库名。
 * @param file - 文件描述（含 name / sha256 / bytes）。
 * @param dest - 落盘路径。
 * @param size - 文件的**真实**大小（探测来的，不能用档位里的估计值）。
 * @param onProgress - 进度回调，参数是「当前文件已下载的字节数」（绝对值，不是增量）。
 * @returns 是否成功。
 */
async function downloadFile(repo, file, dest, size, onProgress, revision) {
  // 大文件走分片并行：单连接打不满带宽，多连接能显著提速，
  // 而且某一块失败只需重下那一块。
  if (size >= PARALLEL_THRESHOLD) {
    for (let round = 1; round <= 5; round++) {
      try {
        if (await downloadFileParallel(repo, file, dest, size, onProgress, revision)) return true
      } catch (error) {
        // 分片文件保留在磁盘上，下一轮接着下
        if (round >= 5) throw error
      }
      await new Promise((r) => setTimeout(r, Math.min(5000, 1000 * round)))
    }
    return false
  }
  const part = `${dest}.part`
  for (let round = 1; round <= 40; round++) {
    const from = existsSync(part) ? statSync(part).size : 0
    if (from >= size) {
      if (!file.sha256 || (await sha256Of(part)) === file.sha256) {
        await replaceFile(part, dest)
        onProgress?.(size)
        return true
      }
      await rm(part, { force: true })
    }
    for (const host of HOSTS) {
      try {
        const headers = { 'user-agent': 'dsh-voice-typing/0.1' }
        if (from > 0) headers.range = `bytes=${from}-`
        const res = await fetch(`${host}/${repo}/resolve/${revision ?? 'main'}/${file.name}`, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(120000),
        })
        // 404/403 = 仓库里没有这个文件，重试多少次都没用。
        // 之前会白等 40 轮 × 2 个镜像（好几分钟）才失败，
        // 期间界面一直卡在「下载中」，看不出到底出了什么事。
        if (res.status === 404 || res.status === 403) {
          await res.body?.cancel?.()
          throw new Error(`仓库里没有这个文件：${file.name}（HTTP ${res.status}）`)
        }
        if (res.status !== 200 && res.status !== 206) throw new Error(`status ${res.status}`)
        const resume = res.status === 206 ? from : 0
        if (resume === 0) await rm(part, { force: true })
        const sink = createWriteStream(part, resume > 0 ? { flags: 'a' } : {})
        sink.on('error', () => { /* 由下面的 catch 统一处理 */ })
        const reader = res.body.getReader()
        let got = 0
        let last = Date.now()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (Date.now() - last > 15000) throw new Error('stalled')
            last = Date.now()
            if (done) break
            got += value.byteLength
            if (!sink.write(value)) await new Promise((r) => sink.once('drain', r))
          }
          await new Promise((resolve, reject) => {
            sink.end(resolve)
            sink.on('error', reject)
          })
        } catch (e) {
          sink.destroy()
          throw e
        }
        // 报「当前文件已下载的字节数」（绝对值）：
        // 续传时 from 已经是之前下好的部分，所以是 from + got。
        // 之前用增量语义，续传会让进度重复累加；而且出错时不回调，
        // 小文件的进度条就永远不动。
        onProgress?.(from + got)
        const digest = await sha256Of(part)
        if (file.sha256 && digest !== file.sha256) {
          await rm(part, { force: true })
          throw new Error('sha mismatch')
        }
        await replaceFile(part, dest)
        return true
      } catch {
        /* 换镜像重试 */
      }
    }
    await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * round)))
  }
  return false
}

/**
 * 探测文件的真实大小（字节）。
 *
 * 为什么必须探测、不能信档位里写的 bytes：
 *   档位里的 bytes 是**估计值**，Whisper 那一组差得离谱 ——
 *   tiny-encoder.int8.onnx 声明 12,300,000，真实 12,937,772（差 637KB）。
 *   拿估计值去切分片，就会只下到前 12.3MB，
 *   剩下的 637KB 永远下不到 → 合并出的文件不完整 → sha256 必然不匹配，
 *   于是这个模型**永远下不下来**。
 *
 * 探测方式：发一个只取 1 字节的 Range 请求，
 * 从 Content-Range 的 "bytes 0-0/TOTAL" 里读真实总长。
 *
 * @param repo - HF 仓库名。
 * @param file - 文件描述。
 * @returns {Promise<number|null>} 真实大小；探测不到返回 null（此时退回声明值）。
 */
async function probeFileSize(repo, file, revision) {
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}/${repo}/resolve/${revision ?? 'main'}/${file.name}`, {
        headers: {
          'user-agent': 'dsh-voice-typing/0.1',
          range: 'bytes=0-0',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      })
      const contentRange = res.headers.get('content-range')
      await res.body?.cancel?.()
      if (contentRange) {
        const total = Number(contentRange.split('/')[1])
        if (Number.isFinite(total) && total > 0) return total
      }
      // 服务端不支持 Range 时会返回 200，Content-Length 就是整个文件的大小
      const len = Number(res.headers.get('content-length'))
      if (res.status === 200 && Number.isFinite(len) && len > 0) return len
    } catch {
      /* 换镜像重试 */
    }
  }
  return null
}

// 启用分片并行下载的文件大小门槛（字节）。低于此值用单连接，没必要并行。
const PARALLEL_THRESHOLD = 8 * 1024 * 1024

/** 分片并行下载的并发数。 */
const PARALLEL_CONCURRENCY = 8

/**
 * 分片并行下载一个大文件。
 *
 * 做法：把文件切成若干块，每块用独立的 Range 请求并行下载，
 * 全部完成后按顺序拼接。好处：
 *   - 单连接带宽往往打不满，多连接能显著提速；
 *   - 单块失败只需重下那一块，不用从头再来；
 *   - 分块文件保留在磁盘上，重启后可以接着下。
 *
 * @param repo - HF 仓库名。
 * @param file - 文件描述（含 name / bytes / sha256）。
 * @param dest - 最终落盘路径。
 * @param size - 文件的**真实**大小（探测来的）。
 * @param onProgress - 进度回调，参数是「当前文件已下载的字节数」（绝对值）。
 * @returns 是否成功。
 */
async function downloadFileParallel(repo, file, dest, size, onProgress, revision) {
  // 必须用真实大小切分片（见 probeFileSize 的说明）：
  // 用估计值会漏掉文件尾部的字节，合并出的文件不完整、sha256 必然不匹配。
  const total = size
  const chunkSize = Math.ceil(total / PARALLEL_CONCURRENCY)
  const chunks = []
  for (let start = 0; start < total; start += chunkSize) {
    const end = Math.min(total - 1, start + chunkSize - 1)
    chunks.push({ index: chunks.length, start, end, path: `${dest}.chunk${chunks.length}` })
  }

  let received = 0
  const queue = [...chunks]
  const workers = []
  const failed = []
  const workerCount = Math.min(PARALLEL_CONCURRENCY, chunks.length)
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      for (;;) {
        const chunk = queue.shift()
        if (!chunk) return
        const chunkSize2 = chunk.end - chunk.start + 1
        // 已经下完的分片直接跳过（断点续传）
        if (existsSync(chunk.path) && (await stat(chunk.path)).size === chunkSize2) {
          received += chunkSize2
          // 报**绝对值**（当前文件已下载多少），不是增量。
          // 用增量的话，重试一轮就把同一份字节再加一次，
          // 进度会涨到实际的几倍（12.3MB 的文件显示成 61MB）。
          onProgress?.(received)
          continue
        }
        await rm(chunk.path, { force: true })
        const ok = await downloadChunk(repo, file, chunk, revision)
        // 单个分片失败不能直接抛：那样 Promise.all 会立刻 reject，
        // 剩下的 worker 还在后台写文件，下一轮重试就和它们撞车，
        // 结果是分片互相覆盖、永远合并不出正确文件。
        // 这里只记录失败，等所有 worker 都结束后再统一报错。
        if (!ok) {
          failed.push(chunk.index)
          continue
        }
        received += chunkSize2
        onProgress?.(received)
      }
    })())
  }
  // 等所有 worker 结束（不会因为单个失败而提前 reject）
  await Promise.all(workers)
  if (failed.length) {
    // 保留已下好的分片，下次可以接着下
    throw new Error(`分片下载失败：${file.name}（第 ${failed.join(',')} 片）`)
  }

  // 合并前再确认所有分片都在位且大小正确
  for (const chunk of chunks) {
    const expect = chunk.end - chunk.start + 1
    if (!existsSync(chunk.path) || (await stat(chunk.path)).size !== expect) {
      throw new Error(`分片不完整：${file.name} #${chunk.index}`)
    }
  }

  // 合并到临时文件，校验通过后再原子替换到最终路径。
  // 直接写最终路径的话，中途挂掉会留下一个截断的模型文件，
  // 而「是否就绪」只看文件在不在 → 判定「已就绪」→ 永远不再重下。
  await mergeChunksAtomic(dest, chunks.map((c) => c.path), total, file.sha256)

  // 清理分片
  for (const chunk of chunks) await rm(chunk.path, { force: true })
  return true
}

/**
 * 把分片按顺序合并成一个文件（**原子落位**）。
 *
 * 为什么不能直接写最终路径：
 *   合并中途崩溃/被杀/被杀软锁 → 最终路径上留下一个**截断文件**；
 *   而「是否就绪」只看文件存在且非空 → 判定「已就绪」→ 永远不再重下 →
 *   用户卡在一个「界面显示已就绪、sherpa 却报 Please check your config」的状态上，
 *   只能手动删文件。
 *
 *   Windows 上还多一层：最终路径若正被 sherpa-onnx 的 mmap 占用，
 *   直接 createWriteStream(最终路径) 会直接 EBUSY/EPERM
 *   （POSIX 允许覆盖已打开的文件，这是真正的平台差异）。
 *
 * 做法：先写 `${dest}.merge` 临时文件 → 校验大小与 sha256 →
 *       再用 replaceFile 原子替换到最终路径。
 * 中断只会留下临时文件，最终路径上的旧内容完好无损。
 *
 * @param {string} dest - 最终落盘路径。
 * @param {string[]} chunkPaths - 分片路径（按顺序）。
 * @param {number} total - 合并后的总字节数。
 * @param {string} [sha256] - 期望的 sha256（没有就只校验大小）。
 * @returns {Promise<void>} 完成；校验不过会抛错且**不动**最终路径。
 */
export async function mergeChunksAtomic(dest, chunkPaths, total, sha256) {
  const mergePath = `${dest}.merge`
  let sinkError = null
  const sink = createWriteStream(mergePath)
  // 必须常驻监听 error：流的 error 事件没人接会变成未捕获异常，
  // 足以让宿主进程崩溃。这里先把错误记下来，下面统一处理。
  sink.on('error', (error) => { sinkError = error })
  try {
    for (const chunkPath of chunkPaths) {
      await new Promise((resolve, reject) => {
        const rs = createReadStream(chunkPath)
        rs.on('error', reject)
        rs.on('end', resolve)
        rs.pipe(sink, { end: false })
      })
      // 写流出错（比如目标盘满了）时，'end' 照样会来，
      // 不检查的话就会把一个坏掉的合并当成成功的。
      if (sinkError) throw sinkError
    }
    await new Promise((resolve, reject) => {
      if (sinkError) {
        reject(sinkError)
        return
      }
      sink.once('error', reject)
      sink.end(resolve)
    })
  } catch (error) {
    sink.destroy()
    // 只清临时文件：最终路径上的东西（哪怕是上一轮下好的）不能碰。
    await rm(mergePath, { force: true })
    throw error
  }

  const finalSize = (await stat(mergePath)).size
  if (finalSize !== total) {
    await rm(mergePath, { force: true })
    throw new Error(`拼接后大小不对：${finalSize} != ${total}`)
  }
  if (sha256) {
    const digest = await sha256Of(mergePath)
    if (digest !== sha256) {
      await rm(mergePath, { force: true })
      throw new Error('sha mismatch')
    }
  }
  // 校验通过才落位：这一次 rename 之外，最终路径从头到尾都是完整的。
  try {
    await replaceFile(mergePath, dest)
  } catch (error) {
    // 落位失败（比如 Windows 上的瞬时锁重试到底）：临时文件也别留着。
    // 分片还在，重试一轮会重新合并。
    await rm(mergePath, { force: true })
    throw error
  }
}

/**
 * 下载单个分片（Range 请求）。
 * @param repo - HF 仓库名。
 * @param file - 文件描述。
 * @param chunk - 分片描述 {index, start, end, path}。
 * @param revision - 钉死的上游 revision（不传则用 main）。
 * @returns 是否成功。
 */
async function downloadChunk(repo, file, chunk, revision) {
  const size = chunk.end - chunk.start + 1
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}/${repo}/resolve/${revision ?? 'main'}/${file.name}`, {
        headers: {
          'user-agent': 'dsh-voice-typing/0.1',
          range: `bytes=${chunk.start}-${chunk.end}`,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(180000),
      })
      // 服务端不支持 Range 时会返回 200（整文件），此时不能当作分片处理
      if (res.status !== 206) {
        await res.body?.cancel?.()
        if (res.status === 200) return false
        // 404/403 = 仓库里没这个文件，换镜像也没用
        if (res.status === 404 || res.status === 403) {
          throw new Error(`仓库里没有这个文件：${file.name}（HTTP ${res.status}）`)
        }
        throw new Error(`status ${res.status}`)
      }
      const tmp = `${chunk.path}.tmp`
      const sink = createWriteStream(tmp)
      // 必须常驻监听 error：流的 error 事件没人接会变成未捕获异常，
      // 足以让宿主进程崩溃。
      sink.on('error', () => { /* 由下面的 catch 统一处理 */ })
      const reader = res.body.getReader()
      let got = 0
      let last = Date.now()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (Date.now() - last > 20000) throw new Error('stalled')
          last = Date.now()
          if (done) break
          got += value.byteLength
          if (!sink.write(value)) await new Promise((r) => sink.once('drain', r))
        }
        await new Promise((resolve, reject) => {
          sink.end(resolve)
          sink.on('error', reject)
        })
      } catch (error) {
        sink.destroy()
        await rm(tmp, { force: true })
        throw error
      }
      if (got !== size) {
        await rm(tmp, { force: true })
        throw new Error(`分片大小不对：${got} != ${size}`)
      }
      await replaceFile(tmp, chunk.path)
      return true
    } catch {
      /* 换镜像重试 */
    }
  }
  return false
}
