import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const idx = fs.readFileSync(root + '/lib/index.js', 'utf8')
const lines = idx.split('\n')

let passed = 0, failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('解码循环必须有步数上限（防止把宿主线程卡死）')
check('定义了上限常量', /const MAX_DECODE_STEPS = \d+/.test(idx))
check('上限足够宽松（正常路径不可能触及）',
  Number(/const MAX_DECODE_STEPS = (\d+)/.exec(idx)?.[1] ?? 0) >= 1000,
  '太小会截断正常识别')

// 找出所有「while (…isReady(…)) decode」的真实代码行（排除注释）
const codeLines = lines
  .map((l, k) => ({ l, k }))
  .filter(({ l }) => !/^\s*(\*|\/\/)/.test(l))
  .filter(({ l }) => /while\s*\(.*isReady\(.*\)/.test(l))

check('至少找到两处解码循环', codeLines.length >= 2, `实际 ${codeLines.length} 处`)
let unguarded = 0
for (const { l, k } of codeLines) {
  const guarded = /steps\s*\+\+\s*<\s*MAX_DECODE_STEPS/.test(l)
  if (!guarded) { unguarded++; console.log(`    未加保护：行 ${k + 1}: ${l.trim().slice(0, 80)}`) }
}
check('所有解码循环都加了步数上限', unguarded === 0,
  '无上限的 while 一旦 decode 不推进状态就会把宿主主线程卡死，界面无响应、应用被看门狗杀掉重启')

console.log('\n原生识别的类别不能搞错（用错会让原生代码 exit(1)，整个应用退出）')
const cat = fs.readFileSync(root + '/lib/model-catalog.js', 'utf8')
const m = /id:\s*'zipformer2-zh'[\s\S]{0,600}?engine:\s*'online'/.test(cat)
check("zipformer2-zh 的 engine 是 'online'（→ OnlineRecognizer）", m)
check("宿主侧按 engine 选 OnlineRecognizer",
  /model\.engine === 'online' \? api\.OnlineRecognizer : api\.OfflineRecognizer/.test(idx))
check('流式用 isReady/decode/inputFinished 的方式',
  /stream\.inputFinished/.test(idx) && /isReady/.test(idx))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
