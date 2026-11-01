/**
 * 回归测试：跨平台文件操作。
 *
 * 背景（2026-10-31）：
 *   下载模型时用 `rename(part, dest)` 把临时文件改名成最终文件。
 *   但 **Windows 上 rename 不能覆盖已存在的目标文件** ——
 *   目标已存在时（之前下过、或上次没删干净）会抛 EPERM / EEXIST，
 *   下载直接失败。POSIX 上 rename 静默覆盖，所以这个 bug 只在 Windows 出现，
 *   偏偏开发与测试都在 Windows 上 —— 换个平台就复现不出来。
 *
 *   修法：先 rm 再 rename（replaceFile），三个平台行为一致。
 *
 * 这里用真实文件系统验证这个行为，不只是看源码。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('replaceFile：覆盖已有目标必须成功')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vt-'))
  try {
    const dest = path.join(tmp, 'model.onnx')
    const part = path.join(tmp, 'model.onnx.part')
    fs.writeFileSync(dest, '旧内容')
    fs.writeFileSync(part, '新内容')

    // fs.rename 在三个平台上都会覆盖已有目标
    // （Windows 走 MoveFileEx + MOVEFILE_REPLACE_EXISTING）
    fs.renameSync(part, dest)
    check('rename 覆盖已有目标成功（Node 在所有平台都覆盖）',
      fs.readFileSync(dest, 'utf8') === '新内容')
    check('临时文件已消失', !fs.existsSync(part))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\n源码里所有「改名成最终文件」都要走 replaceFile')
{
  // replaceFile 现在住在共用的 lib/atomic-file.js 里
  // （model-catalog 与 index.js 都用它）。
  const atomic = fs.readFileSync(path.join(root, 'lib/atomic-file.js'), 'utf8')
  const cat = fs.readFileSync(path.join(root, 'lib/model-catalog.js'), 'utf8')
  const idx = fs.readFileSync(path.join(root, 'lib/index.js'), 'utf8')

  check('共用模块 lib/atomic-file.js 存在', fs.existsSync(path.join(root, 'lib/atomic-file.js')))
  check('replaceFile 已定义', /export async function replaceFile\(from, to/.test(atomic))
  check('helper 内部是「先试 rename，失败再退避重试」',
    /await rename\(from, to\)/.test(atomic)
    && /EPERM/.test(atomic) && /EBUSY/.test(atomic),
    'Windows 上目标被杀毒软件/索引器瞬时占用时 rename 会 EPERM/EBUSY，需要重试')
  check('重试有退避间隔', /setTimeout\(resolve, 200 \* i\)/.test(atomic))
  check('非瞬时错误不重试（直接抛出）', /if \(!transient \|\| i === attempts\) throw error/.test(atomic))

  // helper 之外不能有裸的 await rename（改名成最终文件都要走重试）
  const helperBody = /export async function replaceFile\([\s\S]*?\n\}/.exec(atomic)?.[0] ?? ''
  const outside = atomic.replace(helperBody, '')
  for (const [name, src] of [['model-catalog.js', cat], ['index.js', idx]]) {
    const bare = [...src.matchAll(/await rename\(/g)]
    check(`${name} 里没有裸的 await rename`, bare.length === 0, `${bare.length} 处`)
    check(`${name} 用的是共用模块的 replaceFile`, /from '\.\/atomic-file\.js'/.test(src))
  }
}

console.log('\n原生模块必须声明为 optionalDependencies')
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const idx = fs.readFileSync(path.join(root, 'lib/index.js'), 'utf8')
  // 代码里有 WASM 兜底，说明设计上支持「原生装不上」
  const hasFallback = /for \(const name of \['sherpa-onnx-node', 'sherpa-onnx'\]\)/.test(idx)
  check('代码里有原生 → WASM 的兜底', hasFallback)
  check('原生模块不在 dependencies 里（否则装不上就 install 失败）',
    !pkg.dependencies?.['sherpa-onnx-node'],
    '有 WASM 兜底却把它写死在 dependencies 里，装不上就是硬失败')
  check('原生模块在 optionalDependencies 里',
    !!pkg.optionalDependencies?.['sherpa-onnx-node'])
  check('WASM 版 sherpa-onnx 在 dependencies 里',
    !!pkg.dependencies?.['sherpa-onnx'])
}

console.log('\n路径处理必须用 path.join，不能手写分隔符')
{
  const files = ['lib/index.js', 'lib/model-catalog.js', 'lib/local-tts.js',
    'lib/neural-tts.js', 'lib/edge-tts.js', 'lib/asr-worker.js', 'lib/tts-worker.js']
  const hits = []
  for (const f of files) {
    const txt = fs.readFileSync(path.join(root, f), 'utf8')
    txt.split('\n').forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      // 手写分隔符拼接路径
      if (/['"]\/['"]\s*\+|['"]\\\\['"]\s*\+/.test(code)) {
        hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 70)}`)
      }
    })
  }
  check('没有手写分隔符拼路径', hits.length === 0, hits.slice(0, 3).join(' | '))
}

console.log('\nESM 里不能用 __dirname / __filename')
{
  const files = ['lib/index.js', 'lib/model-catalog.js', 'lib/local-tts.js',
    'lib/neural-tts.js', 'lib/edge-tts.js', 'lib/asr-worker.js', 'lib/tts-worker.js',
    'lib/tts-env.js', 'lib/text-rules.js', 'scripts/bundle-client.mjs']
  const hits = []
  for (const f of files) {
    const txt = fs.readFileSync(path.join(root, f), 'utf8')
    txt.split('\n').forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (/(?<![a-zA-Z_$])__(dirname|filename)\b/.test(code)) {
        hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 70)}`)
      }
    })
  }
  check('没有 __dirname / __filename（ESM 里不存在）', hits.length === 0, hits.slice(0, 3).join(' | '))
}

console.log('\n宿主目录要同时支持 DSH_HOME 覆盖与默认路径')
{
  const files = ['lib/index.js', 'lib/model-catalog.js']
  for (const f of files) {
    const txt = fs.readFileSync(path.join(root, f), 'utf8')
    check(`${f} 支持 DSH_HOME 覆盖`, /process\.env\.DSH_HOME/.test(txt))
    check(`${f} 默认用 homedir()`, /homedir\(\)/.test(txt))
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
