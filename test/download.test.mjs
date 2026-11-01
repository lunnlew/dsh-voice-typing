/**
 * 模型下载：正确性 + 状态/进度（合并自原 download-correctness / download-state 两个文件）。
 *
 * 背景（2026-10-31）：
 *   下载功能**从来没成功过**，有三个叠在一起的原因：
 *     1. 档位里写的文件大小是**估计值**（whisper-tiny 声明 12.3MB，真实 12.94MB）：
 *        拿估计值切分片 → 文件尾部永远下不到 → sha256 必然不匹配 → 永远下不下来；
 *     2. tokens 文件名全错（仓库里是 tiny-tokens.txt / base-tokens.txt / …，
 *        档位里一律写 tokens.txt → 404 → 重试 80 次后失败）；
 *     3. 进度用了「增量」语义（分片重试时已下好的分片又被累加一遍，12MB 显示成 61MB）。
 *
 *   以及下载状态展示链路：/models 只给 TTS 模型带 downloading，
 *   面板关掉重开时组件内进度状态全丢、宿主还在下 → 界面永远恢复不了进度。
 *
 * 真下载要联网、几分钟跑一次，不适合放进单元测试；这里用**静态不变量**锁住
 * 上述结构性错误（每一条都对应一个真实发生过的 P0/P1）。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cat = fs.readFileSync(root + '/lib/model-catalog.js', 'utf8')
const idx = fs.readFileSync(root + '/lib/index.js', 'utf8')
const cli = fs.readFileSync(root + '/lib/client.js', 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

// ---------------------------------------------------------------------------
// A. 下载正确性（原 download-correctness.test.mjs）
// ---------------------------------------------------------------------------
console.log('下载必须用服务端返回的真实大小')
check('有 probeFileSize（探测真实大小）', /async function probeFileSize/.test(cat))
check('探测失败时退回声明值', /probed \?\? file\.bytes/.test(cat))
check('分片划分用真实大小', /const total = size/.test(cat),
  '用声明值切分片会漏掉文件尾部，sha256 必然不匹配')
check('progress 总量用真实大小之和', /const total = sizes\.reduce/.test(cat))
check('单连接路径也用真实大小', /if \(from >= size\)/.test(cat))

console.log('\n进度语义：必须是绝对值，不是增量')
check('ensureModel 里 doneBytes 与 fileReceived 分开算',
  /doneBytes \+ fileReceived/.test(cat),
  '用增量语义时，重试一轮就把同一份字节再加一次')
check('分片续传跳过后报绝对值', /onProgress\?\.\(received\)/.test(cat))
check('单连接路径报 from + got（绝对值）', /onProgress\?\.\(from \+ got\)/.test(cat))
check('没有残留的增量式回调', !/onDelta/.test(cat))

console.log('\ntokens 文件名必须与仓库一致')
// 各 Whisper 仓库里的 tokens 文件名带档位前缀
const tokensNames = {
  'whisper-tiny': 'tiny-tokens.txt',
  'whisper-base': 'base-tokens.txt',
  'whisper-small': 'small-tokens.txt',
  'whisper-medium': 'medium-tokens.txt',
  'whisper-turbo': 'turbo-tokens.txt',
  'whisper-large-v3': 'large-v3-tokens.txt',
}
for (const [id, name] of Object.entries(tokensNames)) {
  check(`${id} 用的是 ${name}`, cat.includes(`whisperTokens('${name.replace('-tokens.txt', '')}')`))
}
// 原断言 `!/name: 'tokens\.txt',\s*\n\s*bytes: 816_730/` 是**无效负断言**：
// 只匹配「裸 tokens.txt + 某个特定字节数」的精确排版，回归换个大小就绿。
// 改成真正的不变量：文件名必须由 whisperTokens(prefix) 拼成带前缀的形式，
// 且每个 whisper 档位都调用它（不直接写裸 tokens.txt）。
check('whisperTokens 拼的是「前缀-tokens.txt」而不是裸 tokens.txt',
  cat.includes('name: `${prefix}-tokens.txt`'))
check('每个 whisper 档位都通过 whisperTokens() 生成文件名',
  (cat.match(/whisperTokens\('/g) || []).length === 6,
  `whisperTokens 调用 ${(cat.match(/whisperTokens\('/g) || []).length} 处（应为 6）`)

console.log('\n404 要立刻失败，不能重试 40 轮')
check('单连接路径 404 立即抛错', /仓库里没有这个文件/.test(cat))
check('分片路径 404 立即抛错', (cat.match(/仓库里没有这个文件/g) || []).length >= 2)

// ---------------------------------------------------------------------------
// B. 下载状态与进度（原 download-state.test.mjs）
// ---------------------------------------------------------------------------
console.log('\n宿主：/models 必须带下载状态与进度')
check('维护了下载进度表', /const downloadProgress = new Map\(\)/.test(idx))
check('ASR 模型也带 downloading', /category: 'asr',\s*\n\s*downloading: activeDownloads\.has\(m\.id\)/.test(idx),
  '识别模型之前是直接透传的，没有 downloading 字段')
check('模型项带 received / total', /\.\.\.\(downloadProgress\.get\(m\.id\) \?\? \{\}\)/.test(idx))
check('下载中会更新进度表', /downloadProgress\.set\(model\.id, \{ received, total \}\)/.test(idx))
check('下载结束会清掉进度表', /downloadProgress\.delete\(model\.id\)/.test(idx))

console.log('\n客户端：面板重开要能恢复进度')
check('拉取模型列表时恢复下载中状态',
  /data\?\.models\?\.find\(\(m\) => m\.downloading\)/.test(cli),
  '否则关掉面板再打开，进度条就没了')
check('恢复逻辑不在 setState 更新函数里（React 反模式）',
  !/setModels\(\(prev\) => \{\s*\n\s*const downloading/.test(cli),
  '在状态更新函数里调 setState 会导致重复更新')
check('恢复时设置 progress', /setProgress\(\{\s*\n\s*id: downloading\.id/.test(cli))
check('模型行显示下载百分比',
  /m\.received \?\? 0\) \/ m\.total\) \* 100\)\}%/.test(cli),
  '模型行应该显示「下载中 xx%」')
check('点击后立刻标记下载中',
  /m\.id === id \? \{ \.\.\.m, downloading: true \}/.test(cli),
  '否则要等 SSE 第一条事件才变，用户以为点了没反应')
check('请求失败会撤销下载中标记',
  /m\.id === id \? \{ \.\.\.m, downloading: false \}/.test(cli))

console.log('\n下载完成后必须刷新模型列表')
check('model-ready 会重新拉模型列表',
  /addEventListener\('model-ready'[\s\S]{0,400}?void loadModels\(\)/.test(cli),
  '不刷的话列表里的 ready 还是 false，按钮一直显示「下载模型」')
check('model-error 也会刷列表',
  /addEventListener\('model-error'[\s\S]{0,400}?void loadModels\(\)/.test(cli),
  '失败后不刷的话「下载中」标记去不掉，按钮一直是禁用的')
check('存在 loadModels（专门拉 /models 的函数）',
  /const loadModels = useCallback/.test(cli))
check('reload 只刷 /config，不负责模型列表',
  /const reload = useCallback\(async \(\) => \{[\s\S]{0,300}?\/config/.test(cli) &&
  !/const reload = useCallback\(async \(\) => \{[\s\S]{0,300}?\/models/.test(cli),
  'reload 刷的是配置，模型列表要单独拉')

console.log('\n服务端：必须先清状态再广播')
check('activeDownloads 在广播 model-ready 之前删除',
  /activeDownloads\.delete\(model\.id\)[\s\S]{0,120}?broadcast\('model-ready'/.test(idx),
  '客户端收到 model-ready 会立刻拉 /models，那时 activeDownloads 还没清就会拉回 downloading=true')
check('activeDownloads 在广播 model-error 之前删除',
  /activeDownloads\.delete\(model\.id\)[\s\S]{0,160}?broadcast\('model-error'/.test(idx))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
