/**
 * 回归测试：模型列表必须带上下载状态与进度。
 *
 * 背景（2026-10-31）：
 *   /models 路由里只有 TTS 模型带 `downloading`，识别模型是直接透传：
 *       models: [...asr.map((m) => ({ ...m, category: 'asr' })), ...tts]
 *   结果是 Whisper 之类正在下载时，界面照样显示「下载模型」，
 *   用户完全看不出正在下载。
 *
 *   而且设置面板关掉再打开时，组件重新挂载、组件内的进度状态全丢，
 *   宿主那边的下载却还在跑 —— 进度必须放在宿主侧并由 /models 暴露出来，
 *   否则界面永远恢复不了。
 *
 * 这个测试直接检查 /models 路由的返回值结构。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const idx = fs.readFileSync(root + '/lib/index.js', 'utf8')
const cli = fs.readFileSync(root + '/lib/client.js', 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('宿主：/models 必须带下载状态与进度')
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

console.log("\n下载完成后必须刷新模型列表")
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

console.log("\n服务端：必须先清状态再广播")
check('activeDownloads 在广播 model-ready 之前删除',
  /activeDownloads\.delete\(model\.id\)[\s\S]{0,120}?broadcast\('model-ready'/.test(idx),
  '客户端收到 model-ready 会立刻拉 /models，那时 activeDownloads 还没清就会拉回 downloading=true')
check('activeDownloads 在广播 model-error 之前删除',
  /activeDownloads\.delete\(model\.id\)[\s\S]{0,160}?broadcast\('model-error'/.test(idx))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
