/**
 * 回归测试：模型下载必须能成功，且进度要按实际算。
 *
 * 背景（2026-10-31）：
 *   下载功能**从来没成功过**，有三个叠在一起的原因：
 *
 *   1. **档位里写的文件大小是估计值，不是真实值。**
 *      whisper-tiny 的 tiny-encoder.int8.onnx 声明 12,300,000，
 *      真实 12,937,772（差 637KB）。拿估计值切分片，
 *      就只下到前 12.3MB，文件尾部永远下不到 →
 *      合并出来的文件不完整 → sha256 必然不匹配 → 永远下不下来。
 *
 *   2. **tokens 文件名全错。**
 *      仓库里是 tiny-tokens.txt / base-tokens.txt / …，
 *      档位里一律写 tokens.txt → 404 → 重试 40 轮 × 2 镜像 → 失败。
 *
 *   3. **进度用了「增量」语义。**
 *      分片下载失败重试时，已下好的分片又被累加一遍，
 *      12.3MB 的文件显示成 61MB（5 轮重试 × 8 分片）。
 *
 * 这个测试用静态断言锁住这些不变量 —— 真下载要联网、几分钟跑一次，
 * 不适合放进单元测试；但这些结构性错误必须挡住。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cat = fs.readFileSync(root + '/lib/model-catalog.js', 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

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
check('没有把 tokens 一律叫 tokens.txt', !/name: 'tokens\.txt',\s*\n\s*bytes: 816_730/.test(cat))

console.log('\n404 要立刻失败，不能重试 40 轮')
check('单连接路径 404 立即抛错', /仓库里没有这个文件/.test(cat))
check('分片路径 404 立即抛错', (cat.match(/仓库里没有这个文件/g) || []).length >= 2)

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
