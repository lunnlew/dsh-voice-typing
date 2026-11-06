/**
 * 模拟「用户没装 DSH 语音输入 Bundle」的场景，验证 SenseVoice 的兜底逻辑。
 *
 * 做法：把 DSH_HOME 指到一个空目录（这样 hostSenseVoicePaths() 必然返回 null），
 * 然后检查 model-catalog 的各个函数的行为。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hostModule } from './helpers/host-source.mjs'

// 造一个空的 DSH_HOME
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'))
process.env.DSH_HOME = fakeHome
console.log('模拟的 DSH_HOME:', fakeHome, '（里面没有 speech-to-text）')

const cat = await hostModule('model-catalog', { nocache: true })

let failed = 0
function check(name, ok, detail) {
  if (ok) console.log('  ✓ ' + name)
  else { console.log('  ✗ ' + name + (detail ? '：' + detail : '')); failed++ }
}

const sv = cat.findModel('sensevoice')
console.log('\n档位定义')
check('sensevoice 档位存在', !!sv)
check('标记为宿主内置（优先复用）', cat.isHostedModel(sv) === true)
check('有下载源 repo', !!sv.repo, sv.repo)
check('钉死了 revision', !!sv.revision, sv.revision)
check('有文件清单（含 sha256）', sv.files?.length === 2 && sv.files.every((f) => f.sha256))
check('文件大小是真实值', sv.files.find((f) => f.name === 'model.int8.onnx')?.bytes === 239_233_841)

console.log('\n宿主那份不存在时')
check('hostSenseVoicePaths() 返回 null', cat.hostSenseVoicePaths() === null)
check('isModelReady() 为 false（需要下载）', (await cat.isModelReady(sv)) === false)

console.log('\nmodelPaths() 的报错要说清怎么办')
try {
  cat.modelPaths(sv)
  check('modelPaths() 抛出并提示下载', false, '没抛错 —— 会用不存在的路径去识别')
} catch (e) {
  const msg = String(e.message)
  check('modelPaths() 抛出并提示下载', /下载/.test(msg), msg)
  console.log('    错误信息:', msg)
}

console.log('\nlistModels() 要如实报告')
const list = await cat.listModels()
const item = list.find((m) => m.id === 'sensevoice')
check('sensevoice 在清单里', !!item)
check('ready=false（如实反映没模型）', item.ready === false)
check('host=true（仍标记宿主优先）', item.host === true)
check('presentBytes=0（本地确实没有）', item.presentBytes === 0, String(item.presentBytes))

console.log('\n其它档位不受影响')
for (const id of ['whisper-tiny', 'zipformer2-zh']) {
  const m = cat.findModel(id)
  check(`${id} 仍是普通可下载档位`, cat.isHostedModel(m) === false && !!m.repo && !!m.files?.length)
}

fs.rmSync(fakeHome, { recursive: true, force: true })
console.log(`\n${failed ? '✗ ' + failed + ' 项失败' : '✓ 全部通过'}`)
process.exitCode = failed ? 1 : 0
