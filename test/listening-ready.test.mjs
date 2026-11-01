/**
 * 回归测试：进入「聆听中」之前，模型与麦克风都必须真的就绪。
 *
 * 背景（2026-10-31，用户反馈）：
 *   「聆听中」状态转换的时候，识别的时候能不能确保模型已经加载了？」
 *
 * 两个真实问题：
 *
 * 1. **模型没加载就开麦**
 *    首次加载 SenseVoice 要 20~40 秒。以前是**先**把界面切成「聆听中」
 *    **再**去开麦，于是用户说的话会**全部丢掉** ——
 *    识别请求在模型就绪前就失败了，而失败的音频已经被切走。
 *
 * 2. **麦克风没打开也算「聆听中」**
 *    `getUserMedia` 可能被拒绝、可能一直挂着等授权、
 *    也可能拿到一个已经结束（ended）的轨道 ——
 *    这时候照样能建出音频图、能跑 VAD，只是永远采不到声音，
 *    而界面显示「聆听中」，用户完全看不出来。
 *
 * 规则（可执行）：
 *   - 模型没就绪 → 不能进入聆听态（先 warmup，必要时显示「正在加载模型…」）
 *   - 没有可用的音频轨道 → 不能进入聆听态
 *   - 「聆听中」的标志只能由「一切就绪」那一步设置
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8')
const idx = fs.readFileSync(path.join(root, 'lib/index.js'), 'utf8')
const lines = cli.split('\n')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('宿主：提供「模型就绪」与「预热」接口')
check('有 /asr-ready 路由', /path: '\/dsh-voice-typing\/asr-ready'/.test(idx))
check('有 /asr-warmup 路由', /path: '\/dsh-voice-typing\/asr-warmup'/.test(idx))
check('记录了已加载的模型', /const asrLoadedModels = new Set\(\)/.test(idx))
check('预加载成功后记入名单', /asrLoadedModels\.add\(spec\.modelId\)/.test(idx))
check('释放模型时移出名单',
  /asrLoadedModels\.delete\(modelId\)/.test(idx) && /asrLoadedModels\.delete\(spec\.modelId\)/.test(idx),
  '释放了就不算就绪 —— 否则客户端会以为模型还在，其实每次识别都要重新加载')

console.log('\n客户端：先确认模型，再开麦')
{
  const startMic = cli.slice(cli.indexOf('const startMic = useCallback'),
    cli.indexOf('const startMic = useCallback') + 4000)
  // 按**行号**比较，不用字符窗口 —— 窗口一刀切会漏掉后面的代码。
  const startLine = cli.split('\n').findIndex((l) => l.includes('const startMic = useCallback'))
  const warmupLine = lines.findIndex((l, i) => i > startLine && l.includes('await ensureModelReady()'))
  // 注意：能力检测那行是 `navigator.mediaDevices?.getUserMedia`，
  // 真正调用是 `await navigator.mediaDevices.getUserMedia(` —— 只认后者。
  const gumLine = lines.findIndex((l, i) => i > startLine && l.includes('await navigator.mediaDevices.getUserMedia('))
  check('startMic 里会确认模型', warmupLine >= 0)
  check('确认模型在 getUserMedia **之前**',
    warmupLine >= 0 && gumLine >= 0 && warmupLine < gumLine,
    `确认模型在第 ${warmupLine + 1} 行，getUserMedia 在第 ${gumLine + 1} 行`)
  check('模型没就绪就不开麦',
    /if \(!modelReady\.ok\)[\s\S]{0,400}?return/.test(startMic))
  check('模型没就绪时会提示',
    /setHint\(t\('modelFailed'\), reason \|\| t\('modelFailedDetail'\)\)/.test(startMic),
    '状态行只放短词，完整原因走悬停提示')
}

console.log('\n客户端：麦克风轨道必须真的可用')
{
  const startMic = cli.slice(cli.indexOf('const startMic = useCallback'),
    cli.indexOf('const startMic = useCallback') + 4000)
  check('检查了音频轨道', /getAudioTracks\(\)\[0\]/.test(startMic))
  check('轨道不存在就退出', /if \(!audioTrack \|\| audioTrack\.readyState === 'ended'\)[\s\S]{0,600}?return/.test(startMic))
  check('轨道不可用时会释放', /getTracks\(\)\.forEach\(\(tr\) => tr\.stop\(\)\)/.test(startMic))
}

console.log('\n「聆听中」只能由「一切就绪」那一步设置')
{
  // 只统计真代码 —— 注释里写着「不要在这里 setOn(true)」不该算进来。
  const codeOnly = cli
    .split('\n')
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => !/^\s*(\/\/|\*)/.test(l))
    .map(({ l, i }) => ({ text: l, line: i + 1 }))
  const setOnTrue = codeOnly.filter(({ text }) => /setOn\(true\)/.test(text))
  check('setOn(true) 只出现一次（真代码里）', setOnTrue.length === 1,
    `${setOnTrue.length} 处，行 ${setOnTrue.map((x) => x.line).join(',')}`)
  if (setOnTrue.length === 1) {
    const at = cli.indexOf(setOnTrue[0].text, cli.indexOf('const startMic = useCallback'))
    const around = cli.slice(Math.max(0, at - 700), at + 200)
    check('它紧跟在 recorderActiveRef.current = true 之后',
      around.includes('recorderActiveRef.current = true'),
      '只有麦克风与模型都就绪了才允许进入聆听态')
    check('它前面有「一切就绪」的说明注释',
      /一切就绪/.test(around))
  }
  {
    const toggleStart = cli.split('\n').findIndex((l) => l.includes('const toggleVoice = useCallback'))
    // 排除注释行 —— 注释里写着「不要在这里 setOn(true)」不算真代码。
    const toggleCode = lines.slice(toggleStart, toggleStart + 40)
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n')
    check('toggleVoice 里没有 setOn(true)', !/setOn\(true\)/.test(toggleCode),
      '点了按钮就显示「聆听中」是错的 —— 那时模型可能还在加载')
  }
  check('toggleVoice 会设置「正在开麦」',
    /startingRef\.current = true/.test(cli.slice(cli.indexOf('const toggleVoice = useCallback'), cli.indexOf('const toggleVoice = useCallback') + 1600)))
}

console.log('\n状态文案与文案')
// 状态行是内联在麦克风按钮旁边的：只放短词，
// 完整说明放到「…Detail」里（悬停可见）。
check('有「加载模型」短文案', /modelLoading: '加载模型…'/.test(cli))
check('有「加载模型」的长说明', /modelLoadingDetail: '正在加载识别模型/.test(cli))
check('有「麦克风打不开」文案', /micFailed: '麦克风打不开'/.test(cli))
check('有英文文案', /modelLoading: 'Loading model…'/.test(cli))
check('准备中显示加载提示',
  /const statusText = starting[\s\S]{0,120}?t\('modelLoading'\)/.test(cli))

console.log('\n发送通路：同一段话不能发两遍')
{
  // 两条发送通路（助手闲 / 助手忙完）必须共用同一个定时器 id
  const ids = [...cli.matchAll(/timers\.timeout\('(pending-[a-z-]+)'/g)].map((m) => m[1])
  const unique = [...new Set(ids)]
  check('发送定时器只有一个 id', unique.length === 1, `实际: ${unique.join(', ')}`)
  {
    // 锚点用「助手忙时挂起自动发送」那一行 —— 它与 clear 必然在同一分支里。
    const busyLine = lines.findIndex((l) => /pendingAutoSendRef\.current = true/.test(l))
    const nearby = lines.slice(busyLine, busyLine + 20).join('\n')
    check('助手忙的分支会清掉发送定时器',
      busyLine >= 0 && /timers\.clear\('pending-send'\)/.test(nearby),
      '助手从闲变忙时，旧的发送定时器必须清掉 —— 否则先发一次、忙完又发一次')
  }
  check('助手闲的分支会清掉另一条通路的定时器',
    /timers\.clear\('pending-auto-send'\)/.test(cli))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
