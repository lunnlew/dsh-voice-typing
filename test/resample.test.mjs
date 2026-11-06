/**
 * 采集侧重采样判据的行为回归（第 4 步 4.4a：从 main.js 搬出 pure/resample.js）。
 *
 * 为什么值得单独测：这是「麦克风给的音频到底变成了什么」的唯一出口。
 *   - 上传给宿主的每一段 PCM 都过这里，而宿主那边按 16k 解释（`acceptWaveform` 全写 16000）；
 *   - 搬之前实现只有一份，但**取采样率那一步手写了三遍**、**拼 chunks 手写了三遍**，
 *     三处兜底还不是一回事（两处 `?? 16000` 挡不住 0 / NaN）；
 *   - 识别质量出问题（声音发闷、语速变了、半速回放）第一时间就该怀疑这里，
 *     所以这里的数值要能被逐条钉住，而不是靠装机听。
 *
 * 用法：node test/resample.test.mjs
 */
import {
  TARGET_SAMPLE_RATE,
  normalizeSourceRate,
  mergeChunks,
  resampleTo16k,
} from '../src/client/pure/resample.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/** 造一段 Float32 采样。 */
const f32 = (values) => Float32Array.from(values)

console.log('TARGET_SAMPLE_RATE：和宿主的契约')
{
  check('目标采样率是 16000（宿主 acceptWaveform 按这个数解释）', TARGET_SAMPLE_RATE === 16000)
}

console.log('\nnormalizeSourceRate：什么样的采样率能用')
{
  check('正常值原样用（48000）', normalizeSourceRate(48000) === 48000)
  check('已经是 16k 原样用', normalizeSourceRate(16000) === 16000)
  check('数字字符串会被 Number 接受', normalizeSourceRate('44100') === 44100)
  check('undefined → 目标采样率（等价于不重采样）', normalizeSourceRate(undefined) === 16000)
  check('null → 目标采样率', normalizeSourceRate(null) === 16000)
  check('0 → 目标采样率（旧的两处 `?? 16000` 挡不住 0，会算出 Infinity 个采样）',
    normalizeSourceRate(0) === 16000)
  check('负数 → 目标采样率', normalizeSourceRate(-48000) === 16000)
  check('NaN → 目标采样率', normalizeSourceRate(0 / 0) === 16000)
  check('Infinity → 目标采样率（不是有限数就不能用来定长度）',
    normalizeSourceRate(Infinity) === 16000)
  check('空串 → 目标采样率（Number("") 是 0，被同一条规则接住）',
    normalizeSourceRate('') === 16000)
  // 这条是本轮补的兜底：0 采样的旧路径会 `new Float32Array(Infinity)` 抛 RangeError。
  check('兜底真的挡住了抛错：采样率为 0 时整条链路照常出数',
    resampleTo16k(f32([1, 2, 3]), normalizeSourceRate(0)).length === 3)
}

console.log('\nmergeChunks：把分块拼成一段')
{
  check('顺序即时间顺序', (() => {
    const merged = mergeChunks([f32([1, 2]), f32([3]), f32([4, 5, 6])])
    return merged.length === 6 && [...merged].join(',') === '1,2,3,4,5,6'
  })())
  check('空数组给长度 0（不抛错）', mergeChunks([]).length === 0)
  check('单块也返回**新**数组（调用方随后会清掉源数组）', (() => {
    const chunk = f32([1, 2, 3])
    const merged = mergeChunks([chunk])
    return merged !== chunk && [...merged].join(',') === '1,2,3'
  })())
  check('零长度块不占位置', (() => {
    const merged = mergeChunks([f32([]), f32([7]), f32([])])
    return merged.length === 1 && merged[0] === 7
  })())
  check('小数值得到保留（这是 PCM，不是整数序列）', (() => {
    const merged = mergeChunks([f32([-0.25, 0.5])])
    return merged[0] === -0.25 && merged[1] === 0.5
  })())
}

console.log('\nresampleTo16k：数值形状')
{
  const source = f32([0, 1, 2, 3, 4, 5, 6, 7, 8])
  check('16k 输入返回**同一个数组**（直通不拷贝，调用方直接上传）', (() => {
    const out = resampleTo16k(source, 16000)
    return out === source
  })())
  check('48k → 16k：长度变成 1/3，取到的就是整倍位置', (() => {
    const out = resampleTo16k(source, 48000)
    return out.length === 3 && [...out].join(',') === '0,3,6'
  })())
  check('24k → 16k：非整数倍位置走线性插值（9 个采样出 6 个）', (() => {
    const out = resampleTo16k(source, 24000)
    return out.length === 6 && [...out].join(',') === '0,1.5,3,4.5,6,7.5'
  })())
  check('44.1k → 16k：长度按 floor(len / ratio)，至少 1', (() => {
    const fortyfour = new Float32Array(4410)
    const out = resampleTo16k(fortyfour, 44100)
    return out.length === 1600 && out.every((v) => v === 0)
  })())
  check('低于 16k 也照常算（8k 设备：插值放大，不是报错）', (() => {
    const out = resampleTo16k(f32([10, 20, 30]), 8000)
    return out.length === 6 && out[1] === 15 && out[3] === 25
  })())
  check('插值取到末尾时右侧越界 → 沿用当前值（不出现 NaN）', (() => {
    const out = resampleTo16k(f32([10, 20, 30]), 8000)
    return out[out.length - 1] === 30 && [...out].every((v) => Number.isFinite(v))
  })())
  check('单点输入 → 长度至少 1', resampleTo16k(f32([0.5]), 48000).length === 1)
  // 现状：空输入会被撑成 1 个 0 采样（`Math.max(1, ...)` 那一条）。
  // 调用点都在前面拦了「没内容就不发」，所以真实链路走不到；记下来别当成设计。
  check('现状：空输入给 1 个 0 采样而不是空数组', (() => {
    const out = resampleTo16k(f32([]), 48000)
    return out.length === 1 && out[0] === 0
  })())
  check('重采样不改动输入（上传用的还是原缓冲时不会被人动过）', (() => {
    const input = f32([1, 2, 3, 4, 5, 6])
    resampleTo16k(input, 48000)
    return [...input].join(',') === '1,2,3,4,5,6'
  })())
  check('返回的是 Float32Array（宿主收的是 f32 PCM，不是普通数组）',
    resampleTo16k(f32([1, 2, 3, 4]), 48000) instanceof Float32Array)
}

console.log('\n三段连起来：一次真实的「拼块 + 归一 + 重采样」')
{
  // 设备给 48k、采了 6 个采样、分两块到达 —— 落到 16k 该是 2 个采样，值都对得上。
  const chunks = [f32([0, 1, 2]), f32([3, 4, 5])]
  const pcm = resampleTo16k(mergeChunks(chunks), normalizeSourceRate(48000))
  check('两块 48k → 2 个 16k 采样，取值 0 与 3',
    pcm.length === 2 && pcm[0] === 0 && pcm[1] === 3)
  const unknownCtx = resampleTo16k(mergeChunks(chunks), normalizeSourceRate(undefined))
  check('拿不到采样率时不猜：按 16k 直通，长度等于原长', unknownCtx.length === 6)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
