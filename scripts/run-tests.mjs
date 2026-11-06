#!/usr/bin/env node
/**
 * 测试运行器：自动发现并运行 test/ 目录下的所有 *.test.mjs 文件。
 *
 * 为什么需要这个脚本：
 *   - 旧测试文件（58 个）使用自定义 check() 函数，没有统一框架；
 *   - 新测试文件（diagnostics.test.mjs）使用 node:test；
 *   - package.json 的 test 脚本是一长串 && 连接（1600+ 字符），难以维护。
 *
 * 这个运行器兼容两种风格：
 *   - 旧式：直接 import 文件，check() 函数会打印结果，退出码由 process.exitCode 控制；
 *   - 新式：node:test 会自动运行，输出由 --test-reporter 控制。
 *
 * 用法：
 *   node scripts/run-tests.mjs           # 先构建两端产物，再运行所有测试
 *   node scripts/run-tests.mjs --quiet   # 安静模式（只输出失败）
 *   node scripts/run-tests.mjs --no-build # 跳过构建（只在明知产物是现生成的时候用，例如单文件调试）
 *
 * **为什么运行器要先构建**（批次 23，docs/architecture-modernization.md §8.69）：
 *   `lib/` 从这批起不再进版本库，磁盘上那份是谁哪一次构建留下的，git 不知道也管不着。
 *   而客户端与宿主的绝大多数判据驱动的就是 `lib/*.js` 这几份产物 ——
 *   不先构建的话，「测试通过」证明的是**旧产物**的行为，改完 `src/` 照样全绿，
 *   这正是产物入库时代 `bundle-sync` 那条逐字节比对想挡的事。现在它前移到运行器里：
 *   测的必然是当前源码现生成的那一份。构建失败直接以非 0 退出并说明原因（不静默跳过，
 *   也不让测试跑在一份根本不存在的产物上）。
 *   单跑某个测试文件（`node test/xxx.test.mjs`）不会经过这里，那种情况下「产物过期」
 *   仍由 `test/bundle-sync.test.mjs` 那条逐字节比对兜住。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const testDir = path.resolve(__dirname, '..', 'test')
const quiet = process.argv.includes('--quiet')

/**
 * 跑一次构建脚本（客户端 + 宿主两端 = `npm run build` 的那两条命令）。
 * @param {string} script - scripts/ 下的文件名。
 * @returns {boolean} 是否以 0 退出。
 */
function build(script) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    console.error(`✗ ${script} 失败（退出码 ${result.status}）`)
    if (quiet) console.error(String(result.stderr || result.stdout || '').trim())
    console.error('  常见原因是没装依赖：先跑 pnpm install（构建用的是 devDependency 里的 esbuild）')
    return false
  }
  return true
}

if (!process.argv.includes('--no-build')) {
  if (!quiet) console.log('先构建产物（lib/ 不入库，测的必须是当前源码现生成的那一份）')
  if (!build('build-client.mjs') || !build('build-host.mjs')) process.exit(1)
}

// 发现所有测试文件
const testFiles = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.mjs'))
  // 跳过需要外部服务的集成测试（silence.test.mjs 需要运行中的识别服务器）
  .filter(f => !['silence.test.mjs'].includes(f))
  .sort()

if (testFiles.length === 0) {
  console.error('没有找到任何测试文件')
  process.exit(1)
}

if (!quiet) {
  console.log(`发现 ${testFiles.length} 个测试文件\n`)
}

let totalPassed = 0
let totalFailed = 0
const failedTests = []

// 运行单个测试文件
async function runTestFile(file) {
  const filePath = path.join(testDir, file)
  const fileUrl = pathToFileURL(filePath).href

  if (!quiet) {
    console.log(`\n== ${file} ==`)
  }

  return new Promise((resolve) => {
    // 用子进程运行测试，避免 process.exit() 影响主进程
    const child = spawn(process.execPath, [filePath], {
      stdio: quiet ? 'pipe' : 'inherit',
      env: { ...process.env, FORCE_COLOR: '1' }
    })

    let stdout = ''
    let stderr = ''

    if (quiet) {
      child.stdout.on('data', (data) => { stdout += data })
      child.stderr.on('data', (data) => { stderr += data })
    }

    child.on('close', (code) => {
      if (code === 0) {
        totalPassed++
        resolve({ file, passed: true })
      } else {
        totalFailed++
        failedTests.push(file)
        if (quiet && stderr) {
          console.error(`\n== ${file} (失败) ==`)
          console.error(stderr)
        }
        resolve({ file, passed: false, code })
      }
    })
  })
}

// 主流程
async function main() {
  const startTime = Date.now()

  for (const file of testFiles) {
    await runTestFile(file)
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2)

  console.log('\n' + '='.repeat(60))
  console.log(`测试完成：${totalPassed} 通过，${totalFailed} 失败，耗时 ${duration}s`)

  if (failedTests.length > 0) {
    console.log('\n失败的测试：')
    for (const file of failedTests) {
      console.log(`  - ${file}`)
    }
    process.exit(1)
  } else {
    console.log('\n所有测试通过！')
    process.exit(0)
  }
}

main().catch((err) => {
  console.error('测试运行器出错：', err)
  process.exit(1)
})
