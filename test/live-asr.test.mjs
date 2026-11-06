/**
 * 回归测试：流式实时字（阶段 5b）——**数据一致性**那一半。
 *
 * 背景（2026-10-31）：
 *   「边说边出字」原先是**每 900ms 把当前整段音频重新识别一遍** ——
 *   一段 5 秒的语音会重复识别 5 次，累计处理的音频量是段长的平方倍，
 *   段越长越慢。
 *
 *   宿主侧其实早就有真正的流式解码（/asr-stream，zipformer2 在线识别器），
 *   但客户端从来不调它 —— 一条**死链**，约 100 行代码加测试在维护，却没人用。
 *
 * 现在接上了：实时字可以走流式（只喂新增音频，解码器保留上下文）。
 *
 * 关键不变量（批次 5c 之后分成两处判）：
 *   1. **流式模型清单两端一致**（本文件，判数据）：客户端的 `STREAM_MODEL_IDS` 与
 *      宿主目录里的流式档位必须是同一批 id，两边不能各写一份又分叉；
 *   2. **流式会话有始有终、只喂增量、不可用时退回整段**（不在本文件）——
 *      搬进 `test/client-behavior.test.mjs` 的 场景 29「流式实时字」：
 *      那边挂**真产物**、真开麦、真喂增量音频，从 `/asr-stream` 的请求序列里数得出来。
 *
 * 原来这个文件里有十几条扫客户端源码文本的断言（`streamSessionIdRef` 那两行 `useRef`、
 * `samples.subarray(already)`、`void resetStream()\n void transcribeSegment()` 的相邻次序、
 * 模式判定的表达式、`t('liveAsr')` 与两条中/英文案字面量……）。它们守的事实和行号、
 * 变量名无关，所以清点器记在「源码文本」那一栏的 18 条去向是三处：
 *   - **3 条模型 id 一致性**（含 `客户端有 STREAM_MODEL_IDS` 那条）→ 本文件上面的数据比对
 *     （宿主目录 + 两边的导出值，双向都判，外加「清单不是整个目录」的反面对照）；
 *   - **14 条时序/行为**（13 条会话与增量 + 1 条「面板里有没有这一项」）→ `client-behavior` 的
 *     场景 29：会话新建、断句与关麦各自 reset、喂的是增量不是累计、流式与整段互斥、
 *     unavailable 当场退回、三档模式各开一次麦、面板里三个档位都渲染出来；
 *   - **2 条文案字面量** → 本文件下面的字典判据（`zh` / `en` 两份一起判，原来只判中文那一份）。
 * 逐条对照表见 `docs/architecture-modernization.md` §8.34 批次 5c 实录。
 */
import { MODELS, findModel, STREAM_MODEL_ID } from '../src/host/model-catalog.js'
import { STREAM_MODEL_IDS } from '../src/client/pure/config-normalize.js'
import { zh, en } from '../src/client/pure/i18n.js'
// 取值表与默认值读**数据**（src/shared/config-spec.js 经宿主入口再导出）。
// 以前这两条是拿正则刮 lib/index.js 的 `liveAsr: 'full'` 字面量 ——
// 默认值单源化之后那行字面量不在了，而「支持三种取值」本来要断言的是枚举，不是源码写法。
import { CONFIG_SPECS, CONFIG_DEFAULTS } from '../src/host/config-schema.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('流式模型档位：宿主目录 ↔ 客户端清单（判数据，不扫源码）')
const onlineIds = MODELS.filter((m) => m.engine === 'online').map((m) => m.id)
check('宿主目录里确实有流式（engine: online）档位', onlineIds.length > 0, JSON.stringify(onlineIds))
check('宿主用来解码流式实时字的档位能在目录里找到（findModel 不返回空）',
  !!findModel(STREAM_MODEL_ID), STREAM_MODEL_ID)
check('那个档位在目录里确实标成流式引擎',
  findModel(STREAM_MODEL_ID)?.engine === 'online',
  String(findModel(STREAM_MODEL_ID)?.engine))
check('客户端的流式清单非空', STREAM_MODEL_IDS.length > 0, JSON.stringify(STREAM_MODEL_IDS))
check('客户端清单包含宿主实际用来解码的那个档位',
  STREAM_MODEL_IDS.includes(STREAM_MODEL_ID),
  `客户端=${STREAM_MODEL_IDS.join(',')} 宿主=${STREAM_MODEL_ID}`)
check('目录里所有流式档位都在客户端清单里（宿主加了档，客户端不能不认识）',
  onlineIds.every((id) => STREAM_MODEL_IDS.includes(id)),
  `目录=${onlineIds.join(',')} 客户端=${STREAM_MODEL_IDS.join(',')}`)
check('客户端清单里的档位都在宿主目录里、且确实是流式引擎（不能列一个宿主没有或不是流式的）',
  STREAM_MODEL_IDS.every((id) => findModel(id)?.engine === 'online'),
  STREAM_MODEL_IDS.map((id) => `${id}:${findModel(id)?.engine ?? '不在目录'}`).join(','))
// 反面对照：清单不是「整个目录」——否则上面两条会被一份全量清单假满足。
check('客户端的流式清单不是整个目录（全量清单会把上面两条假满足）',
  STREAM_MODEL_IDS.length < MODELS.length,
  `清单=${STREAM_MODEL_IDS.length} 目录=${MODELS.length}`)

console.log('\n配置：liveAsr 的枚举与默认值')
check('支持三种取值', CONFIG_SPECS.liveAsr.values.join('|') === 'full|stream|auto',
  CONFIG_SPECS.liveAsr.values.join('|'))
check('默认是 full（对现有用户零影响）', CONFIG_DEFAULTS.liveAsr === 'full',
  String(CONFIG_DEFAULTS.liveAsr))

console.log('\n文案：中英两侧都在，且信息点没丢')
// 原来这两条是对客户端源码文本做 `/liveAsr: '实时字方式'/` 之类的正则：
// 只判得到中文那一份，英文词典里把「streaming」写丢了它看不见。
const COPY_KEYS = ['liveAsr', 'liveAsrHint', 'liveAsrFull', 'liveAsrStream', 'liveAsrAuto',
  'liveAsrStreamNeedsModel']
for (const [lang, dict] of [['中文', zh], ['英文', en]]) {
  const missing = COPY_KEYS.filter((key) => typeof dict[key] !== 'string' || !dict[key].trim())
  check(`「实时字方式」这一族的 ${lang}文案六个键齐全且非空`,
    missing.length === 0, `缺：${missing.join(',')}`)
}
// 三个信息点各判各的，第三点必须判到「流式那一半的精度取舍」：
// 说明里两处都提到精度（整段「精度最好」、流式「精度略低」），
// 只查「有没有『精度』两个字」的话，把后半句整条删掉它还是绿的。
// 所以取舍那一点用模式判，既容得下改写，也不会被前半句顶替。
const hasPoint = (text, point) => (point instanceof RegExp ? point.test(text) : text.includes(point))
const infoPoints = [
  ['中文', zh.liveAsrHint ?? '', ['整段', '流式', /精度[^，。]{0,6}(低|差)/]],
  ['英文', en.liveAsrHint ?? '', ['Full re-recognition', 'streaming', /less\s+accurate|worse\s+accuracy|lower\s+accuracy/]],
]
for (const [lang, text, points] of infoPoints) {
  const absent = points.filter((p) => !hasPoint(text, p))
  check(`「实时字方式」的${lang}说明含住三个信息点（整段 / 流式 / 流式有精度代价）`,
    absent.length === 0, `缺：${absent.map(String).join('、')}；原文：${text.slice(0, 60)}`)
}
check('「要先下载模型」那句里带的就是目录里那个档位 id（不另抄一份字面量）',
  zh.liveAsrStreamNeedsModel.includes(STREAM_MODEL_ID) && en.liveAsrStreamNeedsModel.includes(STREAM_MODEL_ID),
  JSON.stringify({ zh: zh.liveAsrStreamNeedsModel, en: en.liveAsrStreamNeedsModel }))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
