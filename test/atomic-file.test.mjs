/**
 * 原子写文件 + 模型就绪校验的回归测试。
 *
 * 背景（2026-10-31 跨平台审查）：
 *   P0 —— 分片并行下载把分片**直接拼进最终路径**：
 *     合并中途崩溃 → 最终路径上留下截断文件 → isModelReady 只看
 *     「文件存在且非空」→ 判定「已就绪」→ 下载路由回 alreadyReady →
 *     **永远不再重下** → 用户卡在「界面显示已就绪、模型却加载不了」的状态。
 *     Windows 上还多一层：最终路径若被 sherpa-onnx 的 mmap 占着，
 *     直接写会 EBUSY/EPERM（POSIX 允许覆盖已打开的文件）。
 *
 *   P1 —— 配置文件直接覆盖写：
 *     写到一半被中断 → JSON 截断 → readOverrides 的 catch 把 parse 错误吞掉 →
 *     用户配置**静默回到默认值**，界面上一点提示都没有。
 *
 *   P3 —— 旧的文本内联脚本对 CRLF 静默失配 →
 *     产出一个没有纯函数的 client.js，而 --check 还报「已是最新」。
 *     （第 2 步换成 esbuild 构建后，这条改成「真跑一遍构建脚本」来证明，见下）
 *
 * 这里主要做功能验证：真的写文件、真的合并分片、真的校验哈希、真的把宿主路由装上再 POST。
 *
 * 批次 2c（docs §8.34）把原来十五条「拿正则读源码」的判据换成了跑出来的事实，
 * 接缝是 `test/helpers/fake-fs.mjs`（把临时树里的 `node:fs` / `node:fs/promises`
 * 换成一层记录 + 可注入失败的包装）。逐条去向：
 *   「index.js 用的是 writeFileAtomic / 不再直接 writeFile 配置文件 /
 *     从共用模块引入 / 不再从 fs/promises 引入 writeFile」
 *     → 「保存配置的落盘动作可观察」一节：真 POST /config，判「最终配置文件上有没有一次
 *       直接写、只有一次改名落位、写盘失败时旧值还在不在、GET 读回的是不是原来那份」。
 *   「合并写到 .merge 临时文件 / 合并不再直接写最终路径 / 合并校验通过后才落位 /
 *     合并失败不会删掉最终路径上的文件」
 *     → 「合并分片的落盘动作可观察」一节：判「写字节的打开目标全在 .merge 上、
 *       落位那一刻最终路径还不存在且临时文件已拼完整、sha 不匹配时一次改名和一次
 *       rm 都没打到最终路径」。
 *   「isModelReady 会校验 sha256」→ 本来就被「isModelReady 必须校验内容」那一节用真文件判掉了，删（重复）。
 *   「replaceFile 从共用模块引入」→ 由「落位遇到瞬时锁会重试，合并结果照样完整」判掉，删（重复）。
 *   「replaceFile 已定义 / helper 内部是先试再退避重试 / 重试有退避间隔 / 非瞬时错误不重试」
 *     → 「瞬时锁下的改名」一节：判「EPERM 两次共发起三次改名、两次重试分别等了
 *       ≥200ms/≥400ms、ENOENT 只试一次、attempts=3 就只试三次然后抛」。
 *
 * 故意留下的静态档（写清楚为什么留）：
 *   - 「model-catalog.js / index.js 里没有裸的 await rename」：跨文件不变量，
 *     行为测试只能证明眼下这两条路径走了 helper，证明不了以后新增的路径也走；
 *     和「没有手写分隔符拼路径」「没有 __dirname」「默认用 homedir()」同一档。
 *   - 「代码里有原生 → WASM 的兜底」：它配的是 package.json 的 optionalDependencies 声明，
 *     要判它得让原生模块装不上，那是装机环境的事，不是一轮单测能造出来的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileAtomic, writeJsonAtomic, replaceFile } from '../src/host/atomic-file.js'
import { mergeChunksAtomic, isModelReady, sha256Of } from '../src/host/model-catalog.js'
import { hostSource, hostSourcePath, hostSourceEntries } from './helpers/host-source.mjs'
import { loadHostWithFakeFs, makeFsFake } from './helpers/fake-fs.mjs'
import { loadHostRoutes } from './helpers/host-routes.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

/** 装载过 fs 接缝的临时树（收尾统一删；Windows 上删不干净也不许盖掉测试结果）。 */
const trees = []
function removeTrees() {
  for (const t of trees.splice(0)) {
    try { t.remove() } catch { /* 锁着就算了，留在系统临时目录里 */ }
  }
}

/** 造一个临时目录（测试结束会清掉）。 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-atomic-'))
function tmpDir(name) {
  const dir = path.join(tmpRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 跑一段「按道理不该抛错」的生产调用：抛了就把错误对象交回判据，让它在报告里
 * 以「某一条 ✗」出声，而不是把整个文件崩掉 —— 崩了之后后面的判据一条都跑不到，
 * 红也就定位不到具体哪一行（这一节要替的就是那批源码正则，红得可定位才有意义）。
 * @param {() => Promise<unknown>} fn - 要跑的生产调用。
 * @returns {Promise<Error | null>} 抛出的错误；没抛就是 null。
 */
async function attempt(fn) {
  try { await fn(); return null } catch (e) { return e }
}

/**
 * 读一个 JSON 文件，坏掉就返回 null（而不是把整轮崩掉）。
 * 「落盘内容必须还是合法 JSON」本身就是判据，parse 失败要让它红在那一条上。
 * @param {string} file - 文件路径。
 * @returns {object | null} parse 出来的值；读不到/parse 不了就是 null。
 */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * 在**仓库内**搭一个与真实工程同构的最小浏览器构建工程（用于真跑 scripts/build-client.mjs）。
 * 必须放在仓库里：脚本要 require('esbuild')，Node 只能沿目录树往上找 node_modules。
 * 目录名以 `.tmp` 开头，已在 .gitignore 里，收尾会删掉。
 * @param name - 子目录名
 * @param files - `src/client/` 下的相对路径 → 内容（`main` 表示 main.js）
 */
const bundleTmpRoot = path.join(root, '.tmp-bundle-test')
fs.rmSync(bundleTmpRoot, { recursive: true, force: true })
function bundleProject(name, files) {
  const dir = path.join(bundleTmpRoot, name)
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src', 'host'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src', 'client', 'pure'), { recursive: true })
  fs.copyFileSync(path.join(root, 'scripts', 'build-client.mjs'), path.join(dir, 'scripts', 'build-client.mjs'))
  // 复制的是**手写源码**那份，临时工程里按它现在的真位置摆（src/host/）——
  // 6.5 之后 build-client.mjs 就是从这里 import writeFileAtomic 的。
  fs.copyFileSync(path.join(root, hostSourcePath('atomic-file')), path.join(dir, 'src', 'host', 'atomic-file.js'))
  // 临时工程也要声明 ESM，否则 Node 会报「模块类型未指定」。
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n', 'utf8')
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'src', 'client', rel === 'main' ? 'main.js' : rel), content, 'utf8')
  }
  return dir
}

console.log('原子写文件：writeFileAtomic')
{
  const dir = tmpDir('atomic')
  const dest = path.join(dir, 'a.json')
  await writeFileAtomic(dest, '{"x":1}\n')
  check('内容写进去了', fs.readFileSync(dest, 'utf8') === '{"x":1}\n')
  check(
    '目录里没有留下临时文件',
    fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length === 0,
    fs.readdirSync(dir).join(', '),
  )

  await writeFileAtomic(dest, '{"x":2}\n')
  check('能覆盖已有文件', fs.readFileSync(dest, 'utf8') === '{"x":2}\n')

  await writeJsonAtomic(dest, { x: 3 })
  const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'))
  check('writeJsonAtomic 写出合法 JSON', parsed.x === 3)
  check('JSON 结尾有换行', fs.readFileSync(dest, 'utf8').endsWith('}\n'))
}

console.log('\n原子写文件：失败时不能破坏原有内容')
{
  const dir = tmpDir('atomic-fail')
  const dest = path.join(dir, 'b.json')
  fs.writeFileSync(dest, '原有内容', 'utf8')
  // 让写入失败：目标是一个**目录**，rename 必然失败。
  const blocked = path.join(dir, 'blocked')
  fs.mkdirSync(blocked, { recursive: true })
  let threw = false
  try {
    await writeFileAtomic(blocked, '新内容')
  } catch {
    threw = true
  }
  check('写不进去时会抛错', threw)
  check(
    '失败后没有留下临时文件',
    fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length === 0,
    fs.readdirSync(dir).join(', '),
  )
  check('别的文件内容没被影响', fs.readFileSync(dest, 'utf8') === '原有内容')
}

console.log('\nreplaceFile 能覆盖已有目标')
{
  const dir = tmpDir('replace')
  const from = path.join(dir, 'x.tmp')
  const to = path.join(dir, 'x.txt')
  fs.writeFileSync(from, '新的', 'utf8')
  fs.writeFileSync(to, '旧的', 'utf8')
  await replaceFile(from, to)
  check('目标被覆盖成新内容', fs.readFileSync(to, 'utf8') === '新的')
  check('源文件已经不在了', !fs.existsSync(from))
}

console.log('\nP0：分片合并必须是原子的')
{
  const dir = tmpDir('merge')
  const c1 = path.join(dir, 'c1')
  const c2 = path.join(dir, 'c2')
  fs.writeFileSync(c1, 'AAA', 'utf8')
  fs.writeFileSync(c2, 'BBB', 'utf8')
  const dest = path.join(dir, 'model.onnx')
  const total = 6
  await mergeChunksAtomic(dest, [c1, c2], total, sha256('AAABBB'))
  check('合并结果按顺序拼接', fs.readFileSync(dest, 'utf8') === 'AAABBB')
  check('没有留下 .merge 临时文件', !fs.existsSync(`${dest}.merge`))
}

console.log('\nP0：合并中途失败不能留下截断的最终文件')
{
  const dir = tmpDir('merge-fail')
  const c1 = path.join(dir, 'c1')
  fs.writeFileSync(c1, 'AAA', 'utf8')
  const missing = path.join(dir, 'missing')
  const dest = path.join(dir, 'model.onnx')
  let threw = false
  try {
    await mergeChunksAtomic(dest, [c1, missing], 6, sha256('AAABBB'))
  } catch {
    threw = true
  }
  check('合并失败会抛错', threw)
  check(
    '最终路径上没有留下截断文件',
    !fs.existsSync(dest),
    fs.existsSync(dest) ? `留下了 ${fs.statSync(dest).size} 字节` : '')
  check('没有留下 .merge 临时文件', !fs.existsSync(`${dest}.merge`))
}

console.log('\nP0：sha256 不匹配时最终文件必须保持原样')
{
  const dir = tmpDir('merge-sha')
  const c1 = path.join(dir, 'c1')
  fs.writeFileSync(c1, 'AAA', 'utf8')
  const dest = path.join(dir, 'model.onnx')
  fs.writeFileSync(dest, '上一轮下好的完整文件', 'utf8')
  let threw = false
  try {
    await mergeChunksAtomic(dest, [c1], 3, sha256('完全不同的内容'))
  } catch {
    threw = true
  }
  check('sha 不匹配会抛错', threw)
  check(
    '最终路径上的旧内容没被破坏',
    fs.readFileSync(dest, 'utf8') === '上一轮下好的完整文件',
    fs.readFileSync(dest, 'utf8'),
  )
  check('没有留下 .merge 临时文件', !fs.existsSync(`${dest}.merge`))
}

console.log('\nP0：大小不对时也不能落位')
{
  const dir = tmpDir('merge-size')
  const c1 = path.join(dir, 'c1')
  fs.writeFileSync(c1, 'AAA', 'utf8')
  const dest = path.join(dir, 'model.onnx')
  let threw = false
  try {
    await mergeChunksAtomic(dest, [c1], 999, null)
  } catch {
    threw = true
  }
  check('大小不对会抛错', threw)
  check('最终路径上没有文件', !fs.existsSync(dest))
}

console.log('\nP0：isModelReady 必须校验内容，光看「存在且非空」不够')
{
  const home = tmpDir('home')
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const repo = 'fake/repo'
  const dir = path.join(home, 'voice-typing', 'models', repo)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'model.onnx')
  fs.writeFileSync(file, 'abc', 'utf8')
  const model = { id: 'fake', repo, files: [{ name: 'model.onnx', bytes: 3, sha256: sha256('abc') }] }

  check('内容正确时是就绪的', (await isModelReady(model)) === true)

  // 同样的长度、内容不同 —— 就是「合并中断留下的截断/损坏文件」那种情况。
  fs.writeFileSync(file, 'xyz', 'utf8')
  // 显式改一下修改时间，避免同一毫秒内写入导致缓存命中。
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(file, future, future)
  check(
    '内容被改坏后**不能**再说就绪',
    (await isModelReady(model)) === false,
    '判成就绪的话，下载路由会回 alreadyReady，永远不再重下',
  )

  // 清单里没有 sha256 的文件（HF 上非 LFS 的小文件）不能被误判。
  const modelNoHash = { id: 'fake2', repo, files: [{ name: 'model.onnx', bytes: 3 }] }
  check('清单里没有 sha256 时按就绪处理', (await isModelReady(modelNoHash)) === true)

  process.env.DSH_HOME = prevHome
}

console.log('\nP0：合并后的文件 sha256 校验能通过')
{
  const dir = tmpDir('merge-verify')
  const c1 = path.join(dir, 'c1')
  fs.writeFileSync(c1, 'hello', 'utf8')
  const dest = path.join(dir, 'm.bin')
  await mergeChunksAtomic(dest, [c1], 5, sha256('hello'))
  check('落位后的文件 sha256 正确', (await sha256Of(dest)) === sha256('hello'))
}

console.log('\nP0：瞬时锁下的改名 —— 重试次数与间隔是跑出来的，不是读源码读出来的')
{
  // 这一节替代原来四条 `/EPERM/.test(atomic)`、`/setTimeout\(resolve, 200 \* i\)/.test(atomic)` 那类判据：
  // 它们只保证「源码里写过这些字」，把 `200 * i` 写成 `200`、把 `!transient` 判据写反，
  // 只要那几个字符串还在就照样绿。现在问的是同一件事的行为形式：
  // **锁住目标时试了几次、每次之间真等了多久、非瞬时错误是不是立即出声**。
  const loaded = await loadHostWithFakeFs('atomic-file', { label: 'atomic' })
  trees.push(loaded)
  try {
    const { replaceFile, writeFileAtomic } = loaded.mod
    const fake = loaded.fake
    const dir = tmpDir('locked')
    const mkPair = (name) => {
      const from = path.join(dir, `${name}.from`)
      const to = path.join(dir, `${name}.to`)
      fs.writeFileSync(from, '新内容', 'utf8')
      fs.writeFileSync(to, '旧内容', 'utf8')
      return { from, to }
    }
    const lockErr = (code) => Object.assign(new Error(`${code}（模拟 Windows 瞬时文件锁）`), { code })
    /** 前 N 次改名抛给定错误码，之后放行真实现。 */
    const failThenPass = (codes) => {
      let i = 0
      return (args, real) => {
        const code = codes[i++]
        if (code !== undefined) return Promise.reject(lockErr(code))
        return real.rename(...args)
      }
    }
    const alwaysFail = (code) => () => Promise.reject(lockErr(code))

    fake.reset()
    let pair = mkPair('eperm')
    fake.overrides.rename = failThenPass(['EPERM', 'EPERM'])
    const epermError = await attempt(() => replaceFile(pair.from, pair.to, 3))
    delete fake.overrides.rename
    const renames = fake.of('rename')
    check('目标被 EPERM 锁住时改名重试到成功（最终内容是新写入的）',
      !epermError && fs.readFileSync(pair.to, 'utf8') === '新内容',
      epermError ? String(epermError.code) : fs.readFileSync(pair.to, 'utf8'))
    check('EPERM 两次 → 一共发起三次改名', renames.length === 3,
      `${renames.length} 次：${renames.map((c) => c.at).join(' / ')}`)
    const gaps = renames.slice(1).map((c, i) => c.at - renames[i].at)
    check('重试之间真的退避过（第一次 ≥200ms、第二次 ≥400ms 递增）',
      gaps.length === 2 && gaps[0] >= 195 && gaps[1] >= 395, gaps.join(' → ') + ' ms')

    for (const code of ['EBUSY', 'EACCES']) {
      fake.reset()
      pair = mkPair(code.toLowerCase())
      fake.overrides.rename = failThenPass([code])
      const loopError = await attempt(() => replaceFile(pair.from, pair.to, 3))
      delete fake.overrides.rename
      check(`${code} 同样按瞬时锁处理（失败一次后重试到成功）`,
        !loopError && fake.of('rename').length === 2 && fs.readFileSync(pair.to, 'utf8') === '新内容',
        loopError ? `抛错 ${loopError.code}` : `${fake.of('rename').length} 次`)
    }

    fake.reset()
    pair = mkPair('enoent')
    fake.overrides.rename = alwaysFail('ENOENT')
    let enoentError = null
    try { await replaceFile(pair.from, pair.to, 5) } catch (e) { enoentError = e }
    delete fake.overrides.rename
    check('非瞬时错误（ENOENT）只试一次就抛出原错误',
      fake.of('rename').length === 1 && enoentError?.code === 'ENOENT',
      `${fake.of('rename').length} 次 / ${enoentError?.code}`)
    check('ENOENT 不会把调用方当成成功（目标保持原样、源文件还在）',
      fs.readFileSync(pair.to, 'utf8') === '旧内容' && fs.existsSync(pair.from))

    fake.reset()
    pair = mkPair('上限')
    fake.overrides.rename = alwaysFail('EPERM')
    let capped = null
    try { await replaceFile(pair.from, pair.to, 3) } catch (e) { capped = e }
    delete fake.overrides.rename
    check('重试有上限：attempts=3 就只发起 3 次，然后抛错',
      fake.of('rename').length === 3 && capped?.code === 'EPERM',
      `${fake.of('rename').length} 次 / ${capped?.code}`)
    check('重试耗尽后旧文件完好（不会留下半个最终文件）',
      fs.readFileSync(pair.to, 'utf8') === '旧内容' && fs.existsSync(pair.from))

    console.log('\nP0/P1：原子写是「先写临时文件、校验式改名落位」—— 看的是真发生过的系统调用')
    {
      const dir = tmpDir('atomic-shape')
      const dest = path.join(dir, 'conf.json')
      fake.reset()
      const firstError = await attempt(() => writeFileAtomic(dest, '{"a":1}\n'))
      const lands = fake.of('rename', { argIndex: 1, pathEq: dest })
      check('最终路径从没被直接写过（没有任何一次 writeFile 打在它上面）',
        !firstError && fake.of('writeFile', { pathEq: dest }).length === 0,
        firstError ? `原子写抛了 ${firstError.code}` : fake.paths('writeFile').join(' | '))
      check('最终路径只被一次改名命中', lands.length === 1, `${lands.length} 次`)
      check('改名之前的字节写在一个 .tmp 临时文件里，而且就是被改名过来的那一个',
        lands.length === 1 && String(lands[0].args[0]).endsWith('.tmp')
        && fake.of('writeFile', { pathEq: lands[0].args[0] }).length === 1,
        lands.length === 1 ? String(lands[0].args[0]) : '没有落位改名')

      // 写到一半被打断：旧内容不许变，临时文件不许留。
      fs.writeFileSync(dest, '上一轮保存的完整配置', 'utf8')
      fake.reset()
      fake.overrides.writeFile = () => { throw Object.assign(new Error('ENOSPC（模拟写满）'), { code: 'ENOSPC' }) }
      let broke = null
      try { await writeFileAtomic(dest, '新的一半') } catch (e) { broke = e }
      delete fake.overrides.writeFile
      check('写临时文件失败会抛给调用方', broke?.code === 'ENOSPC', String(broke?.code))
      check('失败后最终路径上的旧内容一个字没变',
        fs.readFileSync(dest, 'utf8') === '上一轮保存的完整配置')
      check('失败把临时文件清掉了（rm 打的就是那个 .tmp，目录里也没有残留）',
        fake.of('rm').some((c) => String(c.args[0]).endsWith('.tmp'))
        && fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length === 0,
        `${fake.paths('rm').join(' | ')} // ${fs.readdirSync(dir).join(', ')}`)

      // 并发保存同一目标：两份内容不许挤进同一个临时文件。
      fake.reset()
      fake.overrides.writeFile = (args, real) => new Promise((resolve, reject) => {
        setTimeout(() => { real.writeFile(...args).then(resolve, reject) }, 25)
      })
      const concurrentError = await attempt(() => Promise.all([
        writeFileAtomic(dest, '{"who":"A"}\n'),
        writeFileAtomic(dest, '{"who":"B"}\n'),
      ]))
      delete fake.overrides.writeFile
      const tmps = fake.paths('writeFile')
      check('两次并发写用的是两个不同的临时文件（不会互相搅进同一份内容）',
        !concurrentError && tmps.length === 2 && new Set(tmps).size === 2,
        concurrentError ? `并发写抛了 ${concurrentError.code ?? concurrentError.message}` : tmps.join(' | '))
      // 落盘内容自己 parse 一次：判「是不是其中一份完整内容」，坏 JSON 不许在这里崩掉整轮。
      const landedJson = readJson(dest)
      check('并发写完之后落盘的仍是合法 JSON，且是其中一份完整内容',
        landedJson !== null && ['A', 'B'].includes(landedJson.who),
        fs.readFileSync(dest, 'utf8').replace(/\s+/g, ' ').slice(0, 60))
      // 落位改名可以**多于**两次：Windows 上后一次改名可能撞上前一次的瞬时锁而走重试
      // —— 那是上面「瞬时锁下的改名」那一节要的行为，不是缺陷。
      // 所以要判的是「两个临时文件各自都成功落位过」。
      const landings = fake.of('rename', { argIndex: 1, pathEq: dest })
      check('两个临时文件各自都完成了一次落位改名',
        landings.length >= 2 && new Set(landings.map((c) => c.args[0])).size === 2,
        landings.map((c) => path.basename(String(c.args[0]))).join(' / '))
    }
  } finally {
    loaded.fake.dispose()
  }
}

console.log('\nP0：合并分片的落盘动作可观察 —— 写字节的只有 .merge，落位只有一次改名')
{
  // 这一节替代原来六条「model-catalog 的结构性约束」：
  //   /const mergePath = `\$\{dest\}\.merge`/ 、 !/createWriteStream\(dest\)/ 、
  //   !/rm\(dest, \{ force: true \}\)/ 、 /await replaceFile\(mergePath, dest\)/ 、
  //   /import \{ replaceFile \} from/ 、 /await fileMatchesHash\(path, file\)/
  // 前四条改成本节的行为判据（谁往哪个路径写字节、什么时刻发生改名、失败时动没动最终路径）；
  // 「isModelReady 会校验 sha256」早已被上面「isModelReady 必须校验内容」那一节用真文件判掉了，
  // 「replaceFile 从共用模块引入」由最后一条（落位遇锁仍能成）判掉 —— 两条都是重复，直接删。
  const loaded = await loadHostWithFakeFs('model-catalog', {
    label: 'merge',
    transform: null,
    requireRewrite: [],
  })
  trees.push(loaded)
  try {
    const { mergeChunksAtomic } = loaded.mod
    const fake = loaded.fake
    const dir = tmpDir('merge-seam')
    const c1 = path.join(dir, 'c1')
    const c2 = path.join(dir, 'c2')
    fs.writeFileSync(c1, 'AAA', 'utf8')
    fs.writeFileSync(c2, 'BBB', 'utf8')
    const dest = path.join(dir, 'model.onnx')
    fake.reset()
    const atLanding = []
    fake.overrides.rename = (args, real) => {
      // 落位那一刻抓现场：最终路径此前不该存在，临时文件必须已经拼完整。
      if (args[1] === dest) {
        atLanding.push({
          destExisted: fs.existsSync(dest),
          mergeBytes: fs.existsSync(args[0]) ? fs.readFileSync(args[0], 'utf8') : null,
        })
      }
      return real.rename(...args)
    }
    const mergeError = await attempt(() => mergeChunksAtomic(dest, [c1, c2], 6, sha256('AAABBB')))
    const streams = fake.of('createWriteStream')
    check('合并期间所有写字节的打开目标都是 .merge（最终路径一次都没被打开）',
      !mergeError && streams.length > 0 && streams.every((c) => String(c.args[0]).endsWith('.merge')),
      mergeError ? `合并抛了 ${mergeError.message}` : fake.paths('createWriteStream').join(' | '))
    check('最终文件只被一次改名命中（落位只有一次）',
      fake.of('rename', { argIndex: 1, pathEq: dest }).length === 1,
      `${fake.of('rename', { argIndex: 1, pathEq: dest }).length} 次`)
    check('落位那一刻：最终路径还不存在，临时文件里已经是完整内容',
      atLanding.length === 1 && atLanding[0].destExisted === false && atLanding[0].mergeBytes === 'AAABBB',
      JSON.stringify(atLanding[0] ?? null))

    // 校验不过：一次落位、一次删除最终路径都不许发生。
    delete fake.overrides.rename
    fake.reset()
    let threw = false
    try {
      await mergeChunksAtomic(dest, [c1], 3, sha256('跟期望不一样的内容'))
    } catch {
      threw = true
    }
    check('sha 不匹配时没有任何改名打到最终路径，也没有 rm 动过它',
      threw && fake.of('rename', { argIndex: 1, pathEq: dest }).length === 0
      && fake.of('rm', { pathEq: dest }).length === 0,
      `rename ${fake.of('rename', { argIndex: 1, pathEq: dest }).length} 次 / rm ${fake.paths('rm').join(', ')}`)

    // 落位时被 Windows 锁住：合并照样成功 —— 这就是「合并走的是带重试的 helper」的行为形式。
    // 上一段那次失败合并会把分片删掉（批次 2a 的修复：坏分片留着只会让下一轮再拼出同一个坏文件），
    // 所以这里重新铺一份干净分片。
    fs.writeFileSync(c1, 'AAA', 'utf8')
    fs.writeFileSync(c2, 'BBB', 'utf8')
    const dest2 = path.join(dir, 'model2.onnx')
    fake.reset()
    let locks = 0
    fake.overrides.rename = (args, real) => {
      if (args[1] === dest2 && locks++ === 0) return Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
      return real.rename(...args)
    }
    const lockedMergeError = await attempt(() => mergeChunksAtomic(dest2, [c1, c2], 6, sha256('AAABBB')))
    delete fake.overrides.rename
    check('落位遇到瞬时锁会重试，合并结果照样完整',
      !lockedMergeError && fs.readFileSync(dest2, 'utf8') === 'AAABBB'
      && fake.of('rename', { argIndex: 1, pathEq: dest2 }).length === 2,
      lockedMergeError ? `抛了 ${lockedMergeError.code ?? lockedMergeError.message}`
        : `${fake.of('rename', { argIndex: 1, pathEq: dest2 }).length} 次改名`)
  } finally {
    loaded.fake.dispose()
  }
}

console.log('\nP1：保存配置的落盘动作可观察（真路由 + fs 接缝，替代「index.js 用的是 writeFileAtomic」那一类）')
{
  // 原来四条判据全是拿正则读 index.js 的写法（用的是哪个函数、有没有 import writeFile）。
  // 这里跑的是真路由：POST /config → 真处理函数 → 真临时文件 → 真改名落位，
  // 判据落在**发生过哪些系统调用**和**磁盘上到底是什么**上。
  const home = tmpDir('home-config')
  const conf = path.join(home, 'voice-typing.json')
  fs.writeFileSync(conf, JSON.stringify({ preloadModels: false, wakeWord: '小D' }) + '\n', 'utf8')
  const fake = makeFsFake({ label: 'config' })
  const env = await loadHostRoutes({
    dshHome: home,
    // HOSTS 指向一个必然连不上的本地端口：万一有意外触发的下载，它只会立刻 ECONNREFUSED，
    // 测试绝不会去打真 HuggingFace；preloadModels=false 才是主闸。
    cdnOrigin: 'http://127.0.0.1:1',
    scaffoldRounds: true,
    rowConfig: { preloadModels: false },
    transform: fake.transform,
    extraTreeFiles: fake.wrappers,
    requireRewrite: fake.requireRewrite,
  })
  try {
    const url = '/dsh-voice-typing/config'
    fake.reset()
    const saved = await env.request(url, { method: 'POST', body: JSON.stringify({ wakeWord: '小Z' }) })
    check('保存配置返回 200', saved.statusCode === 200, `${saved.statusCode} ${saved.text.slice(0, 80)}`)
    check('配置文件落在 DSH_HOME 指定的目录里（不是写死真实用户目录）', fs.existsSync(conf), conf)
    const lands = fake.of('rename', { argIndex: 1, pathEq: conf })
    check('最终配置文件从没被直接写过（没有一次 writeFile 打在它上面）',
      fake.of('writeFile', { pathEq: conf }).length === 0, fake.paths('writeFile').join(' | '))
    check('最终配置文件只被一次改名命中', lands.length === 1, `${lands.length} 次`)
    check('改名之前的字节写在 .tmp 临时文件里，且就是被改名过来的那一个',
      lands.length === 1 && String(lands[0].args[0]).endsWith('.tmp')
      && fake.of('writeFile', { pathEq: lands[0].args[0] }).length === 1,
      lands.length === 1 ? String(lands[0].args[0]) : '没有落位改名')
    check('磁盘上的配置是新值、且仍是合法 JSON',
      readJson(conf)?.wakeWord === '小Z', `读回 ${String(readJson(conf)?.wakeWord)}`)

    // 写到一半被打断：用户那份配置不许静默变成默认值。
    fake.reset()
    fake.overrides.writeFile = () => { throw Object.assign(new Error('ENOSPC（模拟写盘失败）'), { code: 'ENOSPC' }) }
    const failedSave = await env.request(url, { method: 'POST', body: JSON.stringify({ wakeWord: '小W' }) })
    delete fake.overrides.writeFile
    check('写盘失败会给客户端非 200，而不是假装保存成功', failedSave.statusCode === 500,
      `${failedSave.statusCode} ${failedSave.text.slice(0, 80)}`)
    check('失败后磁盘上的旧值一个字没变',
      readJson(conf)?.wakeWord === '小Z', `读回 ${String(readJson(conf)?.wakeWord)}`)
    const readBack = await env.request(url)
    check('失败后 GET /config 读回的还是用户原来那份（不会静默回默认值）',
      readBack.json().wakeWord === '小Z', `${readBack.statusCode} ${readBack.text.slice(0, 60)}`)
    check('失败把临时文件清掉了（rm 打的是那个 .tmp，目录里没有残留）',
      fake.of('rm').some((c) => String(c.args[0]).endsWith('.tmp'))
      && fs.readdirSync(home).filter((f) => f.includes('.tmp')).length === 0,
      `${fake.paths('rm').join(' | ')} // ${fs.readdirSync(home).join(', ')}`)

    // 连点两次保存：两份内容不许挤进同一个临时文件。
    fake.reset()
    fake.overrides.writeFile = (args, real) => new Promise((resolve, reject) => {
      setTimeout(() => { real.writeFile(...args).then(resolve, reject) }, 25)
    })
    await Promise.all([
      env.request(url, { method: 'POST', body: JSON.stringify({ wakeWord: '小A' }) }),
      env.request(url, { method: 'POST', body: JSON.stringify({ wakeWord: '小B' }) }),
    ])
    delete fake.overrides.writeFile
    const tmps = fake.paths('writeFile')
    check('两次并发保存各写各的临时文件（名字不同）',
      tmps.length === 2 && new Set(tmps).size === 2, tmps.join(' | '))
    check('并发保存后落盘的仍是合法 JSON，且是其中一份完整内容',
      ['小A', '小B'].includes(readJson(conf)?.wakeWord), `读回 ${String(readJson(conf)?.wakeWord)}`)
    // 落位改名可以多于两次（后一次撞上前一次的 Windows 瞬时锁会走重试，那是上面验过的行为），
    // 要判的是「两个临时文件各自都成功落位」。
    const landed = fake.of('rename', { argIndex: 1, pathEq: conf })
    check('两个临时文件各自都落位到最终配置路径',
      landed.length >= 2 && new Set(landed.map((c) => c.args[0])).size === 2,
      landed.map((c) => path.basename(String(c.args[0]))).join(' / '))
  } finally {
    env.restore()
    fake.dispose()
  }
}


console.log('\nP3：CRLF 的源文件照样能构建（真跑一遍构建脚本）')
{
  // 背景（2026-10-31 跨平台审查）：旧的「正则文本内联」脚本对行尾的 \r 静默失配 →
  // 产出一个**没有纯函数**的 client.js，而 --check 还报「已是最新」。
  // 现在构建换成 esbuild，标记失配这一类问题由构建工具接管，
  // 但「Windows 上检出的 CRLF 源码 → 产物对不对」仍然是要真跑一遍才能证明的事，
  // 所以这里在仓库内的临时目录搭一个同构最小工程（`.tmp*` 已 gitignore，
  // 放在仓库内是因为脚本要 require('esbuild')，得能沿目录树找到 node_modules）。
  const fake = bundleProject('crlf', {
    // 与真实 main.js 同构：顶层 import，模块体住在 buildClientModule(require) 里。
    main: [
      "import { hello } from './pure/x.js';",
      '',
      'export function buildClientModule(require) {',
      '  const module = { exports: {} }',
      '  const exports = module.exports',
      '  exports.hello = hello',
      '  return module.exports',
      '}',
    ].join('\r\n') + '\r\n',
    'pure/x.js': 'export function hello() {\r\n  return 1\r\n}\r\n',
  })
  let out = ''
  let failedRun = false
  try {
    out = execFileSync('node', [path.join(fake, 'scripts', 'build-client.mjs')], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    failedRun = true
    out = String(e.stderr ?? e.message)
  }
  check('构建脚本跑通了', !failedRun, out)
  const product = fs.readFileSync(path.join(fake, 'lib', 'client.js'), 'utf8')
  check('CRLF 源文件里的函数进了产物', /function hello\(\)/.test(product), out)
  check('产物里不再有 @bundle 标记', !product.includes('@bundle'))
  check('产物里没有混进 \\r（行尾统一成 LF）', !product.includes('\r'))
  check('产物是宿主契约形态', product.startsWith('/* 构建产物，勿手改')
    && /window\.__ModuleLoader__\.load\(/.test(product)
    && /factory: \(require\) => \{/.test(product))
  const libFiles = fs.readdirSync(path.join(fake, 'lib')).sort().join(',')
  // 6.5 之后临时工程的 lib/ 里只剩产物本身（atomic-file.js 回到 src/host/ 了），
  // 这条顺带就是「lib 只放构建结果」的最小样本。
  check('产物目录没有残留临时文件（原子写）', libFiles === 'client.js', libFiles)

  // 行为验证：不只看文本，真的按宿主方式执行一遍 factory。
  const sandbox = { console, setTimeout, clearTimeout }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  let def = null
  sandbox.__ModuleLoader__ = { load: (d) => { def = d } }
  let ran = ''
  try {
    vm.runInContext(product, sandbox, { filename: 'client.js' })
    const exp = def.factory(() => { throw new Error('不该 require') })
    ran = String(exp.hello())
  } catch (e) {
    ran = '抛错：' + e.message
  }
  check('factory(require) 执行后能调到源文件里的函数', ran === '1', ran)
}

console.log('\nP3：入口形状不对时会出声（不会静默产出坏产物）')
{
  // 过去这个洞叫「一个 @bundle 标记都没匹配到」，产物里没有纯函数却照样落盘。
  // 标记摘掉之后同一职责变成「包装层那一句要调 module.exports.buildClientModule」：
  // 入口没导出它，构建就必须报错、必须非 0 退出、坏产物必须不落盘。
  const fake = bundleProject('bad-entry', {
    // 带一个 import：先越过「import 图为空」那道闸，才能验到入口形状这道闸。
    main: [
      "import { hello } from './pure/x.js';",
      'export const unrelated = hello',
    ].join('\n') + '\n',
    'pure/x.js': 'export function hello() {\n  return 1\n}\n',
  })
  let code = 0
  let msg = ''
  try {
    execFileSync('node', [path.join(fake, 'scripts', 'build-client.mjs')], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    code = e.status ?? -1
    msg = String(e.stderr ?? e.message)
  }
  check('构建失败并以非 0 退出', code !== 0, `exit=${code}`)
  check('错误消息说明是入口没导出 buildClientModule', /buildClientModule/.test(msg), msg.trim().split('\n')[0])
  check('坏产物没有落盘', !fs.existsSync(path.join(fake, 'lib', 'client.js')))
}

console.log('\n跨平台：落盘改名的重试语义（行为判据见上面两节）；这里只留「全仓不变量」那一条')
{
  // 「helper 内部是先把 rename 再退避重试」「重试有退避间隔」「非瞬时错误不重试」
  // 这四条原来都是 /EPERM/.test(atomic) 一类的源码正则，已经换成上面
  // 「瞬时锁下的改名」那一节的调用次数 + 时间间隔判据（那节红了就说明重试真的坏了）。
  //
  // 剩下的这条**故意留在静态档**：它要判的是「整个仓库里不许出现绕过重试的裸改名」，
  // 是一条跨文件不变量 —— 行为测试只能证明「眼下这两条路径走了 helper」，
  // 证明不了「以后新增的路径也走 helper」。这类「将来的人不许怎么写」的守卫
  // 本来就该是静态的（跟下面路径分隔符、__dirname 那两条同一档）。
  const cat = hostSource('model-catalog')
  const idx = hostSource('index')
  for (const [name, src] of [['model-catalog.js', cat], ['index.js', idx]]) {
    const bare = [...src.matchAll(/await rename\(/g)]
    check(`${name} 里没有裸的 await rename（改名成最终文件都要走重试）`, bare.length === 0, `${bare.length} 处`)
    check(`${name} 用的是共用模块的 replaceFile`, /from '\.\/atomic-file\.js'/.test(src))
  }
}

console.log('\n跨平台：原生模块必须声明为 optionalDependencies')
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  // 「代码里到底有没有原生 → WASM 的兜底」不再由这里扫源码正则证明（批次 6l，docs §8.46）：
  // 那一句循环在不在，判的是**行为** —— 由 test/worker-fallback.test.mjs 把宿主与两个 worker
  // 装进一棵只装有假包的临时树里真跑，看走的是工厂函数还是类构造、能不能真识别出文本。
  // 这里只留依赖归类：兜底设计上存在，所以原生件装不上不该让 npm install 硬失败。
  check('原生模块不在 dependencies 里（否则装不上就 install 失败）',
    !pkg.dependencies?.['sherpa-onnx-node'],
    '有 WASM 兜底却把它写死在 dependencies 里，装不上就是硬失败')
  check('原生模块在 optionalDependencies 里',
    !!pkg.optionalDependencies?.['sherpa-onnx-node'])
  check('WASM 版 sherpa-onnx 在 dependencies 里',
    !!pkg.dependencies?.['sherpa-onnx'])
}

console.log('\n跨平台：路径分隔符 / ESM 限制 / DSH_HOME 覆盖')
{
  // 按**模块名**列（位置由 helpers/host-source.mjs 解析）：第 6.5 步把它们搬进 src/host/
  // 之后这份名单不用动，报告里显示的仍是实际读到的那份路径。
  const files = hostSourceEntries(['index', 'model-catalog', 'local-tts',
    'neural-tts', 'edge-tts', 'asr-worker', 'tts-worker'])
  const hits = []
  for (const [f, txt] of files) {
    txt.split('\n').forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      // 手写分隔符拼接路径
      if (/['"]\/['"]\s*\+|['"]\\\\['"]\s*\+/.test(code)) {
        hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 70)}`)
      }
    })
  }
  check('没有手写分隔符拼路径', hits.length === 0, hits.slice(0, 3).join(' | '))

  const esmFiles = hostSourceEntries(['index', 'model-catalog', 'local-tts',
    'neural-tts', 'edge-tts', 'asr-worker', 'tts-worker', 'tts-env', 'text-rules'])
    // 构建脚本不是宿主模块，按路径读它自己。
    .concat([['scripts/build-client.mjs',
      fs.readFileSync(path.join(root, 'scripts', 'build-client.mjs'), 'utf8')]])
  const esmHits = []
  for (const [f, txt] of esmFiles) {
    txt.split('\n').forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (/(?<![a-zA-Z_$])__(dirname|filename)\b/.test(code)) {
        esmHits.push(`${f}:${i + 1}: ${l.trim().slice(0, 70)}`)
      }
    })
  }
  check('没有 __dirname / __filename（ESM 里不存在）',
    esmHits.length === 0, esmHits.slice(0, 3).join(' | '))

  for (const [f, txt] of hostSourceEntries(['index', 'model-catalog'])) {
    check(`${f} 支持 DSH_HOME 覆盖`, /process\.env\.DSH_HOME/.test(txt))
    check(`${f} 默认用 homedir()`, /homedir\(\)/.test(txt))
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
removeTrees()
fs.rmSync(tmpRoot, { recursive: true, force: true })
fs.rmSync(bundleTmpRoot, { recursive: true, force: true })
process.exitCode = failed ? 1 : 0
