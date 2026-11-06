/**
 * 客户端「真实行为」测试：直接加载构建产物 `lib/client.js` 并驱动它。
 *
 * 为什么需要它：
 *   仓库里大多数客户端测试是「对 lib/client.js 做源码正则形状断言」——
 *   它们能发现「代码里有/没有这句话」，但**发现不了时序类缺陷**：
 *   每条 sentence 是否恰好 ack 一次、播放顺序、段落是否从中间开始、
 *   停止/换轮后旧句是否还会出声。这类缺陷曾经真实发生过（burst 单段 12 句
 *   只播 1 句、停止后旧句仍 start）。
 *
 * 做法：
 *   用 `node:vm` + 最小 React hooks 运行时 + 假 DOM / EventSource /
 *   AudioContext / fetch 加载**真实产物**，驱动真实的 sentence 处理器与
 *   `pumpQueue`，记录「播放了哪些文本 / 发了哪些 reading-ack / 调了哪些 /tts」。
 *
 * 覆盖（接进 `main()` 的 36 段 / 440 条 `check`，编号到「场景 32」，其中 2b/6b/7b/7c/10b 是细分段
 * —— 这两个数是数出来的：段数看下面 `scenarios` 那张表，条数是本文件里 `check(` 的出现次数，加段落时要一起改）：
 *   - 正常播放：顺序 + 每条恰好 ack 一次；
 *   - 合成失败 / 引擎静默回退的提示与诊断 / 去重 / 迟到旧轮 / turn-begin 漏收自愈；
 *   - 合成成功但解码失败（场景 10b）：那一句被跳过、前后照播、三句各 ack 一次、
 *     建出来的音频 Blob 全部释放（数「建了几个 / 还剩几个没撤」）；
 *     同场景第二段是老宿主不给 `index`：7 句全部播出（本地补号让去重键不撞车，
 *     不补号就退回「一轮只念第一句」（当时实测只播了 1 句，记在 §8.34）；
 *   - 停止朗读（静音）后本轮不再播，被拦下的句子也 ack；
 *   - 换轮：旧轮清队列也 ack，不会倒回去念旧轮；
 *   - burst 单段 12 句全部播出（安全网不能裁掉正在读的段落剩余）；
 *   - burst 多段：不允许从段落中间开始播；
 *   - 无 AudioContext：队列丢弃但全部 ack、不卡死、后续能恢复；
 *   - suspended + halt：halt 之后旧句不得再开始播放（gen 复查回归）；
 *   - 停止朗读（场景 18，2026-10-31 报障的原样复现）：正在响的那个源真被 `stop()`、
 *     排在后面的不再开播、在册源全部摘干净、两条句子各 ack 一次、状态行弹短回执
 *     （宽度上下限落在渲染出来的 style 上）；随后四种「解除尝试」（同轮 turn-begin /
 *     没带 turnId 的句子 / call-end / turn-end 后的迟到句）全部被拦下，只有真正的
 *     新轮恢复朗读；合成失败改判 `ttsFailures` 与短词提示；调试快照的五个朗读诊断
 *     计数按类型判在（装机上「没声音」全靠它们）。
 *   - 窗口内快捷键（场景 11，三段）：composer 的监听装着 / 修饰键精确 / 正在录键时挡住；
 *     面板那两个输入框的 onFocus·onBlur 真接到状态上、卸载后复位（审计 F14）；
 *     浮层那条监听认的是「任一框聚焦」而不是「自己那个框」。
 *   - 开麦的时序与就绪判据（场景 12，假录音设备）：先确认模型再取流 / 模型没就绪根本不取流 /
 *     空轨道与 ended 轨道都不进聆听态并且释放流 / 每条失败分支都复位「正在开麦」/
 *     拿不到 AudioContext 时不再卡死、恢复后同一只按钮还能开麦。
 *   - 浮层的两条采集路径（场景 13，第 6.6 步装机回归补的）：AudioWorklet 首选路径搭对
 *     （processorOptions 里那串数是主线程换算的、0 增益接住输出、不回退）/ addModule 被拒
 *     与老内核没有 AudioWorkletNode 时回退真的顶上 / 两条都失败时**不进**聆听态并且
 *     释放轨道、关掉上下文、把 composer 的让位信号收回 / 再按一次关麦把图拆干净。
 *   - 自动发送只发一遍（场景 14，真录音设备 + 真忙闲事件）：空闲句按「静音 + 余量」发一次 /
 *     忙时挂起的句子在忙完时补发一次 / 两句交界共用一个定时器 id，任一时刻至多一个待发定时器、
 *     忙完只发一次，并且过了前一句那个定时器的时刻也不会补发（取消真的生效）。
 *   - 关麦 / 卸载的状态复位（场景 19，A-F 六段）：关麦把 mic / send 两组的定时器从登记表
 *     摘干净、等过到点也不自动发送 / 卸载 clearAll 兜底 / 再开麦说的第二句草稿里不残留第一句 /
 *     关麦不碰朗读轴（正在响的源不被 stop、「朗读中」不消失、其余句子照样播完）/
 *     手动静音开关麦都不解除、只有真新轮恢复、点停止当场掐源并且队列里剩下的不再播 /
 *     once 只关聆听不动朗读 / 卸载把两轴一起收摊。
 *     **这一场景跑出了一条真缺陷**：`clearGroup('send')` 那行字一直在，但两个发送定时器
 *     登记时没带组名，按组清一句都清不到 —— 2026-10-31 修过的「关麦后草稿自己发出去」回来了。
 *   - 识别请求当场失败（场景 20）：/transcribe 直接 reject 时，已经听到的实时字留在输入框、
 *     提示落在 recognizeFailed、不自动发送、recognizing 复位、定时器不残留，下一段恢复正常。
 *
 *   - 播放上下文「挂多久」的三档 + 首次手势预热（场景 21，A-D 四段）：上下文永不恢复 →
 *     等满 8 秒兜底、这一句不播但 playSkipped 涨、回执照发、恢复后下一句照播（管道不死锁）/
 *     挂起等待期间换轮 → halt 后 1 秒内就放弃（轮询里每次都复查代次，不傻等满 8 秒）/
 *     3 秒才 running → 这一句仍然念得出来，而且确实等了 ≥2 秒 /
 *     关掉所有上下文后一次 pointerdown、一次 keydown 各把常驻上下文建起来并 resume，
 *     预热本身不出声、不 ack。**这一段给全套多付约 12 秒（8 秒 + 3 秒都是真等），是故意的**：
 *     它防的就是时长，把时间压掉等于没判。
 *   - 回执账目的字段（场景 22）：真播出音频的那条带 durationMs、合成失败的那条不带；
 *     句子没带 sessionId 时回执落回本地这一份会话，turnId 用当轮的。
 *   - 配置同步（场景 23，①②③④）：共享存储里有值的键优先 / 存储 loaded 时这次 fetch 照样合并 /
 *     GET /config 第一次失败会重试且重试结果真生效 / 开麦时再对一次配置（刚关掉的朗读当场不再念）。
 *   - 高亮抛错（场景 24）：假 document 的 querySelector 当场炸 → 两句照播照 ack、
 *     异常不从朗读管道冲出去（本 harness 把 unhandledRejection 记进 env.warnings，
 *     以前它会直接把进程掀了）、speaking 不卡住。
 *   - 合成挂住（场景 25，替掉原来没接进 main 的 `scenarioTimeoutAck`）：/tts 永不 resolve →
 *     超时兜底顶上，两句各 ack、都不播，恢复后下一句照播。传给假 window 的长定时器由
 *     `env.winSleepCapMs` 压短，判的是「兜底会顶上」，不是生产里那 25 秒这个数字。
 *
 *   - 设置面板·词表与保存（场景 26，批次 5b）：挂的是产物里的 `SettingsSection`。
 *     敲进输入框的空格/换行原样留着（不逐键归一化）、打字期间一次 POST 都不发、
 *     失焦后保存发出去的词表是归一化后的、非法引擎/档位在发出去前被收敛、
 *     保存成功清脏标记、宿主 400 的校验错误渲染成**字典给的那几行**（宿主只报码，
 *     码名与 `detail` 原文不进界面；批次 20 起 8 个码各跑一遍）、改动不被冲回、
 *     快捷键非法时保存按钮 disabled 变 true（对照组：合法时 false）。
 *   - 设置面板·模型下载（场景 27）：重开面板从 `/models` 恢复「下载中 + 百分比」、
 *     SSE 的 model-progress 真进进度行、model-ready/model-error 各真刷一次列表、
 *     点「下载模型」当场标记 + 禁用、被拒后撤销标记，失败那行的句子由**客户端字典**按
 *     宿主回的原因码出（宿主原文只进 console.warn，批次 22-4-2 把它从「显示宿主给的原因」换掉）、
 *     三处状态更新函数里都没有再调别的 setState（React 反模式，由 harness 的
 *     `updaterDepth` 探针判）。
 *   - 设置面板·热键状态行与结构（场景 28）：/diagnostics 只在挂载/刷新/保存后各拉一次
 *     （挂着 0.8 秒增量为 0 = 不轮询）、诊断失败降级「未知」不谎报、
 *     只读状态绝不进保存的 payload（键集合 ⊆ `CONFIG_DEFAULTS`）、
 *     两次渲染之间组件类型不换身份（取代「Row 定义在源码第几行」那条位置正则）。
 *   - 流式实时字（场景 29，批次 5c）：真开麦、真喂音频，从 `/asr-stream` 的**请求序列**里判
 *     `live-asr` 原来用正则守着的那五件事 —— 每次开麦是新会话（`voice-` 前缀且与上次不同）、
 *     断句和关麦各发一次 reset 且断句那次 reset 排在 `/transcribe` 之前、
 *     喂进去的是增量不是整段（这一轮各次之和落在我推给它的数据长度里）、
 *     宿主回 `unavailable` 当场退回整段并且不再往没人解码的会话喂、
 *     stream/auto/full 三档各开一次麦（auto 才看当前模型），外加面板里三个档位都渲染出来。
 *   - SSE 连接生命周期（场景 30，批次 6l-c）：产物里三处建连点（麦克风按钮 / 设置面板 / 全局浮层）
 *     各真挂一遍。面板那段**故意不给 props.t**（走当年那支每次渲染都换引用的三元兜底），
 *     连着换 5 个新 props 对象重渲染 → 数 EventSource 的条数不涨、原来那条也没被这几次渲染关掉；
 *     `unmount()` 之后三处的每一条 `closed` 都为真。替掉 `effect-stability` 里那两条扫源码的判据
 *     （扫 `const t = typeof props`、在 effect 体里正则找 `close(`）。
 *     配套：假 React 的渲染加了熔断（`RENDER_LOOP_LIMIT`，400 次），引用不稳时它本来就是无限重连，
 *     没有这道闸 node 会直接把堆撑爆（实测 exit 134）；收尾账本再判整趟峰值没碰上限。
 *   - 浮层待机唤醒（场景 31，批次 13）：真开麦、真从 AudioWorklet 端口投一段切好的语音、
 *     真走唤醒判定。判两件事 —— 待机时没匹配上唤醒词的那句闲聊**不进会话但要上报原文**，
 *     而这条上报的请求体里**不许有 `sessionId` 自有属性**（宿主见键就改 `voiceSession`，
 *     空串等于清空；而读它的只有 `/diagnostics` 那一项 —— 写这条判据时还有第二个读处
 *     `/latest-message` 的回退，那条死链已由批次 17 退役（§8.59），
 *     当时的实际损害是诊断面失真 + 给那条兼容路由埋雷，不是「朗读没声音」，见 §8.54 的边界）；
 *     反过来「客户端真有会话 id」时（发送尝试的上报）这个键**必须在**。
 *     为此 harness 新增一份可喂/可收的假会话服务（`makeSessionsService` + `feedSessions`）：
 *     以前 `ctx.inject(['sessions'])` 永远被喂一份没有 sessions 的 scope，浮层只能走
 *     「没有当前会话」那一支，后半句判不了。默认仍然不给，`resetEnv` 会把它收回 null。
 *   - 心跳的会话键（场景 32，批次 13b）：composer 那只按钮每 1500 毫秒报一次状态，
 *     同一条通道、同一个键，而它读的 sessionId 在没拿到会话时就是空串 ——
 *     「有 id 必带 / 没 id 整个不发」两头各一段，外加「补回 id 键又出现」的对照
 *     和「关麦后心跳真的停」那段（顺带钉住 `3bfe012` 修掉的 interval 泄漏）。
 *
 * 四处判不动的，记在这里而不是假装覆盖（批次 4d 逐条试过 15 种改法，抓到 13，
 * 逐条名单与两条存活的裁定记在 `docs/architecture-modernization.md` §8.34 的「批次 4d 实录」）：
 *   - 「回执优先用 payload 的 sessionId」：`belongsToSession` 会先把会话 id 对不上的 payload
 *     整条丢掉，换个 sessionId 根本没有回执可比 —— 只能判「没带时回落本地」那一半。
 *   - 生产里有两处 `|| sessionIdRef.current` 兜底互为备份：单删任何一处都是绿的（另一处顶上），
 *     两处一起删才红。判据没问题，是代码冗余，故不作「必须各自判住」的声称。
 *   - 假 window 的 removeEventListener 只按函数引用撤，不实现 `{ once: true }`，
 *     所以手势预热「只响一次」判不动；这里只判两条监听都装着、都会顶上。
 *   - 批次 5c 加的一条同类：`feedStream` 自己就写着 `if (!sid || !samples.length) return`，
 *     所以「增量 ≤ 已喂量就跳过」那道闸（`samples.length <= already`）拿掉也不红 ——
 *     空增轮到不了 fetch。场景 29 那条「音频没有新增就不再喂」判得住的是**行为**
 *     （静置期间不发请求），判不住的是「两道闸各不各自必要」（见 §8.34 批次 5c 实录）。
 *
 * 坑（单例跨场景残留，本批踩过两轮，见 `resetEnv` 与 `mountPanel` 注释）：
 *   `configStore` 是模块级单例，`resetEnv` 直接改它的 value 而不调 `set()`，订阅方手里的
 *   configRef 不会跟着变 → 改过配置的场景必须重新挂载（面板同理：表单值来自挂载后那次
 *   GET /config，改 `env.config` 不重挂就是上一段那份）；`playback-core` 的 `playCtxCache`
 *   同样是模块级，`resetEnv` 只关 `env.audio.ctx`（那可能是某个麦克风上下文）→
 *   一个残留的 running 上下文会让「起手 suspended」的场景照样播出来。
 *
 * 批次 5b 新学到的两条（都改的是 harness 自己，不是生产代码）：
 *   - **`findByProp` 原来看不见 `.map()` 生成的那一层**：`h('div', null, list.map(render))`
 *     里那个数组本身是一个子节点，旧实现只摊一层 children，于是数组分支直接返回 null ——
 *     「模型下载列表」整块是盲区，手写栈遍历能列出按钮、`findByProp` 却找不到。
 *     现在走 `flattenChildren()` 递归摊平。**这条会影响全部 28 段**（以前被跳过的节点
 *     现在会被搜到），所以 5b 跑的是全文件而不是子集。
 *   - **假 DOM 不模拟 `disabled` 的事件抑制**：`onClick` 是我们直接调的，所以
 *     「按钮禁用了 → 点了也不发 POST」在这套沙箱里判不了（生产 `save()` 里确实没有
 *     第二道校验，唯一防线就是那个 disabled 属性）。只判 `disabled` 本身变 true/false，
 *     并写清另一半为什么判不动 —— 硬造一条「点了不发」的判据得先让 helper 尊重 disabled，
 *     那它就成了 disabled 那条的复读。
 *   - 数请求次数一律用**增量**：`resetEnv()` 不清 `env.fetchLog`（25 段共用的账本），
 *     麦克风那一段自己也会拉 /diagnostics，绝对数从一开始就不是 0。
 *
 * 批次 5c 学到的三条（前两条各红过一轮，不是纸上推理）：
 *   - **改完 `liveAsr` / `model` 必须重挂一次**（`remountFresh()`）才算数：配置只在挂载时和
 *     `on` 翻转时拉，而 `on` 翻转那次 refetch 发生在 `startMic` **之后** —— 开麦里
 *     「走流式还是走整段」用的还是上一份配置。第一版没重挂，跑出来是「stream 档一个
 *     /asr-stream 都没发、auto + 非流式模型反而发了两个」，判的全是上一个 case 的配置。
 *     `silenceMs` 那种每 100ms 现读的键不需要重挂，跟着 `on` 翻转那次 refetch 就够。
 *   - **别用「最后一次 / 累计」这类比例判据**判增量喂音频：整段重发时各次是等差前缀和，
 *     n 次时最后一次只占总和的 2/(n+1)（三次 = 0.5），比阈值还小 —— 当年两处改法就是这么溜过去的。
 *     改成有物理上界的绝对量：推给它 N 帧 ×4096@48k，重采样后最多 `N×4096/3×4` 字节，
 *     各次之和超过它就说明同一段音频被重发过。
 *   - **假 fetch 的分支顺序按前缀包含排**：`/asr-stream/reset` 是 `/asr-stream` 的前缀延伸，
 *     reset 那条必须先判，否则每次清状态都会被记成一次「喂音频」，
 *     「静置不喂」「关麦后不喂」两条会假红。
 *
 * 用法：node test/client-behavior.test.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
// 事件名/处理器名从**源码**取（这两个 pure 模块不碰浏览器环境，可以直接 import）。
// 不在测试里抄一份字符串：抄的那份和产物里那份一旦分叉，「composer 让位」这类
// 断言就成了自说自话（浮层发的名字和测试等的是各自硬编码的同一串字面量）。
import { GLOBAL_VAD_PROCESSOR, GLOBAL_CAPTURE_PATHS } from '../src/client/pure/global-voice.js'
import { GLOBAL_MIC_ON_EVENT, GLOBAL_MIC_OFF_EVENT } from '../src/client/pure/voice-constants.js'
// 场景 28 要判「面板发出去的配置里没有只读诊断字段」—— 判据是**数据**（合法键集合），
// 不是源码里有没有写 `hotkeyStatus`。宿主与 UI 从 3.3b 起共用同一份默认值，
// 所以直接 import 那份表（`src/host/config-schema.js` 再导出 shared）。
import { CONFIG_DEFAULTS } from '../src/host/config-schema.js'
// 批次 6j：客户端路由表。收尾那段「这趟跑出来的请求与监听都对得上表」判的就是它。
import { ROUTES } from '../src/client/pure/routes.js'
// 面板的选项文案（批次 22-2）：判据要拿字典的**值**当出处，所以这里直接 import 那份纯数据。
import { zh, en, interpolate, MODEL_LABEL_KEYS } from '../src/client/pure/i18n.js'
import { ASR_READY_REASONS } from '../src/shared/asr-readiness.js'
import { HOTKEY_REASONS } from '../src/shared/hotkey-reasons.js'
import { TTS_ENV_REASONS } from '../src/shared/tts-env-reasons.js'

/**
 * 客户端允许订阅的 SSE 事件名（收尾账本用它核对**真订阅**）。
 *
 * 这份清单不是从源码抄的字符串表：它的另一半判据在
 * `test/route-contract.test.mjs` 的 H 段 —— 那边驱动真宿主，看它**真的广播出哪些名字**，
 * 要求全在这里。两边都得对上一条才绿，所以「名字写错」不会只绿一边：
 * 少一个这里的名字 → 宿主广播它时 H 段红；多一个这里的名字 → 没人广播它，
 * 那是「留着一条空订阅」，本清单不判（判了就是把写法当契约）。
 */
const CLIENT_LISTENED_EVENTS = new Set([
  'assistant-busy', 'turn-begin', 'turn-end', 'call-end', 'sentence',
  'global-hotkey', 'ui-action',
  'model-progress', 'model-ready', 'model-error',
])

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const clientSrc = fs.readFileSync(ROOT + '/lib/client.js', 'utf8')

/* ------------------------------------------------------------------ */
/* 日志 / 断言                                                         */
/* ------------------------------------------------------------------ */
let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failures.push({ name, detail }); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeoutMs, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(stepMs)
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 环境：DOM / AudioContext / fetch / EventSource                      */
/* ------------------------------------------------------------------ */
const env = {
  /** 现在正在播放的文本（FakeSource.start 时记录）。 */
  playedTexts: [],
  /**
   * 建出来的每一个播放源（FakeAudioContext.createBufferSource 的返回对象）。
   * 「停止朗读要切断**所有在响的源**」这条只能从源身上看：
   * `stopRequested` = 客户端对它调过 `stop()`，`_started` / `_finished` = 它响没响、响完没。
   */
  playSources: [],
  /**
   * 建过的每一个 Blob URL（`URL.createObjectURL` 的返回）。
   * 「合成出来的音频用完要释放」这条只能数得出来：`objectUrls` 里还剩几个 = 泄漏几个。
   */
  objectUrlsCreated: [],
  /** 收到的 reading-ack：{ sessionId, turnId, count, durationMs }。 */
  acks: [],
  /** /tts 调用过的文本。 */
  ttsTexts: [],
  /**
   * AudioContext 行为：'running' | 'unavailable' | 自定义对象。
   * `suspendUntil` = 什么时候才允许恢复（绝对时刻）；
   * `neverResume` = 怎么 resume 都不恢复（批次 4d 的子场景 A/B，用来走那条 8 秒兜底）；
   * `resumeCalls` = 客户端真调了几次 resume（首次手势预热那条判据数它）。
   */
  audio: { mode: 'running', playMs: 25, suspendUntil: 0, neverResume: false, resumeCalls: 0 },
  /** tts 行为：返回 {ok, status}、抛错，或 {hang: true}（请求永不返回，演「宿主挂住」）。 */
  ttsBehavior: () => ({ ok: true, status: 200 }),
  config: { readAloud: true, autoSend: false, readAloudLag: 15, silenceMs: 1500, ttsEngine: 'online', localVoice: '', mode: 'toggle', preloadModels: false },
  /** GET /config 前 N 次直接失败（「拉取失败会重试」那条判据用它）。 */
  configFailTimes: 0,
  eventSources: [],
  /**
   * 假运行时里「同一波里连续自动重渲染」的次数与熔断记录（批次 6l-c）。
   *
   * 为什么要有：真 React 在开发模式下遇到 `setState ↔ effect` 自激会抛
   * 「Too many re-renders」并停下，这个假运行时原先没有这一层 —— 于是组件里
   * 一旦引用不稳（就是 2026-10-31 那次 `t` 写成裸三元），场景不是变红而是**把堆吃光**
   * （实测 4GB OOM，整个测试文件连一行结果都印不出来）。熔断器把它变回一条能读的 ✗。
   * streak 由 `render()` 自己维护：外部 `mount()` 归零，内部 schedule 触发就 +1。
   */
  renderLoop: { streak: 0, maxStreak: 0, runMaxStreak: 0, blown: false },
  fetchLog: [],
  warnings: [],
  /** 假 document 的 querySelectorAll 结果（高亮用）。 */
  domQueryResult: [],
  /**
   * true = 假 document 的 querySelector / querySelectorAll 当场抛错。
   * 高亮的 `set()` 第一步就是 `ensureStyle()` → `doc.querySelector(...)`，
   * 所以这一个开关能让「朗读高亮」在**同步路径上**炸掉 ——
   * 判的是 mic-button 里那句 `try { readingHighlightRef.current?.set(...) } catch`：
   * 高亮炸了，这一句必须照样播、照样回执，异常不许从 pumpQueue 冲出去。
   */
  domQueryThrows: false,
  /**
   * 假 win 的 setTimeout 上限（毫秒）：把「25 秒的合成超时」压成几十毫秒用。
   * 只在需要等长定时器的场景里设它，`resetEnv()` 清回 0 = 不封顶。
   */
  winSleepCapMs: 0,
  /**
   * 注入的假 win 上发生过的每一次定时器操作：`{op:'set'|'clear', kind, id, ms}`。
   *
   * 为什么记它：`test/timer-registry.test.mjs` 原来有一条源码正则钉
   * 「登记表按注入的 win 创建（不是自己抓全局 window）」。负半边（不许写 `window`）
   * 本来就有更强的守卫 —— eslint 把 `window` 从 src/client/** 的 globals 清单里删了，
   * 写了就是 no-undef，由 test/no-undef.test.mjs 全树跑；正半边（句柄真的出自**这个** win）
   * 只能数得出来：登记表把 set/clear 都打在注入的 win 上，这份记录才长得出条数。
   * 登记表改成抓全局或抓别的对象，interval 那几笔计数就是 0，场景「关麦复位」A 段当场红。
   * 只数 interval 的理由写在那两条判据的注释里（win.setTimeout 到处在用，拿总数归不到登记表头上）。
   */
  winTimerOps: [],
  /**
   * 识别模型的就绪状态（GET /asr-ready、POST /asr-warmup 的返回）。
   * `delayMs` 把「确认模型」这一步拖慢 —— 「准备中」那一档状态只在等待期间存在，
   * 不注入延迟就永远采不到它（test/listening-ready 的「准备中显示加载提示」靠它）。
   * `reason` 是宿主回的那条**原因码**（`src/shared/asr-readiness.js`）；
   * `downloaded: false` 演「文件压根没下好」，客户端在这一步就该收场、不去预热。
   */
  model: { ready: true, delayMs: 0 },
  /**
   * `/tts/env` 的响应体（点「重新检查」后面板拉的那一条，批次 22-3-2，§8.67）。
   *
   * 默认 `null` = 不改老场景（走替身末尾的通用 `{ok:true}`）。要判引擎行那四行的场景
   * 自己构造一份 `{platform, arch, gpu, configured, engines:[{id, available, reason, params}]}`，
   * `reason` 只从 `src/shared/tts-env-reasons.js` 取 —— 这里写宿主的中文句子就等于
   * 判据在替身里复活了那个已经删掉的形状。
   */
  ttsEnv: null,
  /**
   * composer 的「发送」被调了几次（按调用顺序记文本）。
   * 「同一段话不能发两遍」这条老判据原来钉的是**两条发送通路共用一个定时器 id**
   * 的写法；现在判的是 submit 真被调了几次。
   */
  submits: [],
  /**
   * composer 的「填草稿」被调了几次（按顺序记写进去的整份文本）。
   *
   * 为什么要有它：`dbg().draft` 是组件对输入框的**读回**，
   * harness 里的 composer 是个空壳（不会把写进去的内容再报回来），所以它一直是空串；
   * 「说的话不凭空消失」这种判据只能看组件真正写出去的那一份 = 这里记的。
   */
  draftWrites: [],
  /** 发给 /transcribe 时回给客户端的识别文本（空串 = 什么都没认出来）。 */
  transcript: '',
  /**
   * true = /transcribe 请求**当场失败**（fetch 直接 reject，不是返回错误码）。
   * 场景 20 用它演「识别中途宿主挂了」：客户端要把已经听到的半句留在草稿里，
   * 不能把异常甩出去，也不能把整条链路卡死。
   */
  transcribeFail: false,
  /**
   * 流式实时字（批次 5c，场景 29）的注入面 + 记账。
   *
   * `text` —— `/asr-stream` 每次回给客户端的实时字；`texts` 给了就按调用次序取
   *   （超出长度用最后一项），用来演「字在一点点变长」；
   * `unavailable` —— 第一次 `/asr-stream` 就回 `{ unavailable: true }`，
   *   演「这台机器上没有流式模型」：客户端必须关掉流式、退回整段重识别；
   * `feeds` —— 客户端真的发出去的流式喂音频请求（sessionId + 体长），
   *   「每次开麦新会话」「只喂增量」判的是这份数据，不是源码里有没有 `subarray(already)`；
   * `resets` —— `/asr-stream/reset` 的 sessionId，「断句丢弃状态」「关麦丢弃状态」判它。
   */
  stream: { text: '', texts: null, unavailable: false, feeds: [], resets: [] },
  /**
   * 麦克风设备层。`mode` 决定 getUserMedia 给什么：
   *   'no-device'    —— 没有 mediaDevices（默认：所有旧场景的行为和搬动前一模一样）
   *   'ok'           —— 给一条活轨道
   *   'denied'       —— getUserMedia 拒绝
   *   'empty-track'  —— 给一个空轨道列表（有流、采不到声音）
   *   'ended-track'  —— 给的轨道已经是 ended
   *   'no-ctx-ctor'  —— 设备正常，但 window 上没有 AudioContext 构造器（由场景自己摘掉）
   * `order` 记录开麦链路上的调用次序（模型确认 vs 取流），用来证「先确认模型再开麦」。
   * `level` 是 analyser 报给 VAD 的幅值（0 = 静音）：VAD 听 analyser 而不是采集帧，
   * 所以「说一句 → 断句 → 识别」这条链路要靠它，不靠喂 `onaudioprocess`。
   */
  mic: { mode: 'no-device', gumCalls: 0, order: [], streams: [], lastConstraints: null, sources: [], processors: [], analysers: [], level: 0 },
  /**
   * AudioWorklet 采集面（浮层的首选路径）。默认 `available: false` ——
   * harness 原本的形状就是「没有 audioWorklet」，composer 那条链路走 ScriptProcessor，
   * 老场景的行为一字不变。要验浮层的首选路径就把它打开。
   *   modules —— addModule 收到过的 Blob URL（含当场读回来的源码文本）；
   *   nodes   —— 建出来的 AudioWorkletNode（含 processorOptions，断言展开进来的 VAD 参数）；
   *   addModuleThrows —— 让 addModule 直接拒绝（真实场景是 CSP 拦掉 blob: / 内核不支持）。
   */
  worklet: { available: false, addModuleThrows: false, modules: [], nodes: [] },
  /** 组件在 window 上派发过的事件名（按顺序）。互斥信号「composer 让位 / 收回」靠它验。 */
  winEvents: [],
  /** 本场景里建出来的所有音频上下文（播放核心与麦克风都用它，靠 closed 标志区分）。 */
  audioContexts: [],
  /**
   * **从测试开始以来**建过的全部上下文 —— `resetEnv()` 不清它。
   * 常驻播放上下文是模块级单例（`playback-core` 的 `playCtxCache`），外面点不到名：
   * 想判「手势把上下文重新建起来」，只能把它可能持有的那些对象全部关掉，
   * 于是 `getPlayCtx()` 只剩「新建」这一条路可走（场景 21 D）。
   */
  allContexts: [],
  /* ---------------- 设置面板那三段（批次 5b）用的注入面 ---------------- */
  /**
   * GET /models 返回的档位清单（原样塞进 `{ models: [...] }`）。
   * 面板的「重开恢复进度 / 点一下立刻标记下载中 / model-ready 刷列表」判的都是这份数据。
   */
  models: [],
  /**
   * 非 null = `POST /model`（点「下载模型」）返回这个形状：`{ status, error, reason?, params? }`。
   * `reason` 留空就是演「旧宿主」：非 2xx 但没带码，面板走那句通用的。
   */
  modelDownloadFail: null,
  /** `POST /model` 收过的 id（按顺序）—— 「点了下载到底发没发请求」数它。 */
  modelDownloads: [],
  /**
   * `POST /config` 收过的**整份 payload**（已 JSON.parse）。
   * 面板原来那两条「保存 POST 归一化后的 payload」「状态行不参与保存」是扫源码文本的
   * （`/normalizeForSave\(/`、`/JSON\.stringify\(payload\)/`）—— 只能证明「写了那一行」，
   * 证明不了发出去的键值真是归一化后的。这里直接读发出去的东西。
   */
  configPosts: [],
  /**
   * `POST /voice-session` 收过的**整份 payload**（已 JSON.parse）。
   *
   * 这条通道是客户端→宿主的诊断上报（语音发送尝试 / wake-miss / 采集路径）。
   * 判据要能看见「到底报了什么」——尤其是采集路径那一条：
   * 它的形状（有没有 sessionId 键、kind/path/reason）直接决定宿主会不会误清会话、
   * 会不会把 stats.client 冲掉，光看界面看不出来。批次 10，任务 #38。
   */
  clientReports: [],
  /** 非 null = 保存请求返回这个形状（演宿主 400 校验失败）：{ status, body }。 */
  configSaveResponse: null,
  /**
   * 非空串 = POST /config 的 fetch **当场抛**这个 message（演请求根本没走通：
   * 宿主没在监听、页面被关掉、网络抖一下）。批次 22-3-3，docs §8.68 ——
   * 判的是「浏览器给的那句技术串（`Failed to fetch`）不许上界面，红字由字典出」。
   */
  configSaveReject: '',
  /** GET /diagnostics 的返回（null = 只给 `{ ok: true }`，即宿主没报热键 helper 状态）。 */
  diagnostics: null,
  /** true = GET /diagnostics 当场 reject（诊断接口不可用 → 面板要显示「未知」而不是谎报）。 */
  diagnosticsFail: false,
  /**
   * 假 React 记下的「在 setState 的更新函数里又调了 setState」。
   * 真实 React 会警告并可能重复更新；`loadModels` 的「恢复下载进度」那段
   * 历史上就写过这种形状（源码注释里专门留了一句「不要塞进 setModels 的更新函数」）。
   */
  updaterSideEffects: [],
  /**
   * 假宿主给的「会话服务」（批次 13，场景 浮层待机唤醒）。
   *
   * 默认 null —— 和搬动前一模一样：客户端拿不到 sessions 服务，浮层的会话解析
   * 永远为空、发送只能落到「没有当前会话」。要判「有真会话 id 时上报必须带
   * sessionId 键」这一半，就得让客户端真的握有一个 id，所以这里开一个注入口。
   * 设成一份假服务后必须**重新挂载**才生效（`setCapturedSessionsService` 只在
   * apply 的那次 inject 回调里执行，见 `capturedSessionsInject`）。
   */
  sessionsService: null,
  /** apply 时记下来的「sessions 注入回调」，场景用它把假服务喂进客户端。 */
  capturedSessionsInject: null,
  /** 客户端经 `session.prompt` 真发出去的每一条（会话 id / 文本 / 模式 / requestId）。 */
  prompts: [],
}

const objectUrls = new Map()

/**
 * 异步链路上的异常也要留痕。
 *
 * 朗读管道（`pumpQueue`）是在 SSE handler 里 `void` 出去的：handler 那层 `try/catch`
 * 只包得住**同步**抛错，await 之后炸的（比如高亮渲染那句 `set()`）会变成
 * unhandled rejection —— 以前它会直接把进程掀了（Node 15+ 默认行为），
 * 于是「异常不许从管道冲出去」这种判据没法写。这里收到 env.warnings 里：
 * 场景照常断言 `env.warnings.length === 0`，红得下来、进程也还在。
 */
process.on('unhandledRejection', (reason) => {
  env.warnings.push('unhandledRejection: ' + (reason instanceof Error ? reason.stack : String(reason)))
})

function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    textContent: '',
    isConnected: true,
    setAttribute() {},
    getAttribute() { return null },
    appendChild(child) { this.children.push(child); return child },
    removeChild() {},
    remove() { this.isConnected = false },
    querySelector() { return null },
    querySelectorAll() { return [] },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 } },
  }
}

const fakeDocument = {
  head: makeElement('head'),
  body: makeElement('body'),
  createElement: (tag) => makeElement(tag),
  querySelector: () => {
    if (env.domQueryThrows) throw new Error('fake: 高亮样式检查就炸（querySelector 抛错）')
    return null
  },
  querySelectorAll: () => {
    if (env.domQueryThrows) throw new Error('fake: 高亮渲染找不到容器（querySelectorAll 抛错）')
    return env.domQueryResult
  },
  addEventListener() {},
  removeEventListener() {},
  createTreeWalker() { return { nextNode: () => null } },
  createRange() {
    return { setStart() {}, setEnd() {}, getClientRects: () => [] }
  },
}

class FakeAudioContext {
  constructor(options) {
    if (env.audio.mode === 'unavailable') throw new Error('NotSupportedError: fake no audio device')
    this.sampleRate = Number(options?.sampleRate) || 48000
    this.state = env.audio.mode === 'starts-suspended' ? 'suspended' : 'running'
    this.destination = { name: 'destination' }
    this.closed = false
    this._currentText = ''
    env.audio.ctx = this
    env.audioContexts.push(this)
    env.allContexts.push(this)
    if (env.audio.debug) console.log('[audio] new ctx state=', this.state)
  }
  /* ---- 采集侧要用的那几个节点（composer / 浮层建音频图） ---- */
  createMediaStreamSource(stream) {
    const node = { stream, connected: [], connect(target) { this.connected.push(target) }, disconnect() { this.disconnected = true } }
    env.mic.sources.push(node)
    return node
  }
  /**
   * AudioWorklet 接口。只有 `env.worklet.available` 为真时才挂上 ——
   * 浮层的 `startWorkletVad` 第一句就 `if (!ctx.audioWorklet …) return false`，
   * 挂不挂得上决定它走首选路径还是回退 ScriptProcessor。
   * `addModule` 要把源码取回来：浮层传的是 Blob URL，真实浏览器会去读那个 blob，
   * 这里照它的字面判据（`typeof addModule === 'function'`）之外多读一次内容 ——
   * URL 已经被 `finally` 里的 revokeObjectURL 抹掉了，所以**在 addModule 当场**抓文本。
   */
  get audioWorklet() {
    if (!env.worklet.available) return undefined
    const ctx = this
    return {
      async addModule(url) {
        if (env.worklet.addModuleThrows) throw new Error('fake: addModule rejected（CSP / 不支持）')
        const blob = objectUrls.get(url)
        const text = blob && typeof blob.text === 'function' ? await blob.text() : ''
        env.worklet.modules.push({ url, text, sampleRate: ctx.sampleRate })
      },
    }
  }
  createScriptProcessor(bufferSize, numberOfInputChannels, numberOfOutputChannels) {
    // 真实浏览器：bufferSize 省略/0 时是合法的，显式传非法值直接抛 NotSupportedError。
    // 这里按同一条判据走 —— 之前无脑建节点，「量子传错」这条缺陷在桩里根本撞不出来。
    if (bufferSize !== undefined && bufferSize !== 0
      && ![256, 512, 1024, 2048, 4096, 8192, 16384].includes(Number(bufferSize))) {
      throw new Error(`NotSupportedError: fake bufferSize=${bufferSize}`)
    }
    const node = {
      bufferSize: Number(bufferSize) || 0,
      inputChannels: Number(numberOfInputChannels) || 0,
      outputChannels: Number(numberOfOutputChannels) || 0,
      onaudioprocess: null,
      connected: [],
      connect(target) { this.connected.push(target) },
      disconnect() { this.disconnected = true },
    }
    env.mic.processors.push(node)
    return node
  }
  createAnalyser() {
    const node = {
      fftSize: 2048,
      connect() {},
      disconnect() {},
      /**
       * VAD 读的是这里，不是 `onaudioprocess` 的帧。
       * 默认一律给静音（老场景因此不会被识别链路拖住）；
       * 需要「真的说一句」的场景把 `env.mic.level` 设成幅值（0.05 就够开门限）。
       */
      getFloatTimeDomainData(target) {
        const level = env.mic.level ?? 0
        if (!level) { target.fill(0); return }
        for (let i = 0; i < target.length; i++) target[i] = level * (i % 2 ? -1 : 1)
      },
    }
    env.mic.analysers.push(node)
    return node
  }
  createGain() {
    // gain 节点也要记 connected：采集路径那条「0 增益接到 destination」的契约，
    // 只能从节点身上倒推（`sink.gain.value === 0 && sink.connected 里有 destination`）。
    const node = { gain: { value: 1 }, connected: [], connect(target) { this.connected.push(target) }, disconnect() { this.disconnected = true } }
    return node
  }
  resume() {
    return Promise.resolve().then(() => {
      env.audio.resumeCalls = (env.audio.resumeCalls ?? 0) + 1
      // neverResume：浏览器一直不给播放权限那种时刻 —— resume 调了也不恢复。
      if (env.audio.neverResume) return undefined
      if (env.audio.mode === 'starts-suspended' && env.audio.suspendUntil && Date.now() >= env.audio.suspendUntil) {
        this.state = 'running'
        if (env.audio.debug) console.log('[audio] resume -> running at', Date.now() - env.audio.t0)
      }
      return undefined
    })
  }
  decodeAudioData(bytes) {
    const text = Buffer.from(bytes).toString('utf8')
    // 「合成成功、解码失败」这一类无声（蓝牙耳机、格式不支持、空音频都会走到这里）：
    // 场景指定哪一句解码抛错，判客户端接得住、Blob 不泄漏、后面的句子照播。
    if (env.audio.decodeThrowsText && text.includes(env.audio.decodeThrowsText)) {
      return Promise.reject(new Error('NotSupportedError: fake decode'))
    }
    return Promise.resolve({ duration: env.audio.playMs / 1000, text })
  }
  createBufferSource() {
    const ctx = this
    const node = {
      buffer: null,
      onended: null,
      /** 客户端有没有对它调过 `stop()` —— 「停止朗读切断在响的源」判的就是这个。 */
      stopRequested: false,
      connect() {},
      start() {
        const text = this.buffer?.text ?? ctx._currentText
        env.playedTexts.push(text)
        this._started = true
        if (env.audio.debug) console.log('[audio] start at', Date.now() - (env.audio.t0 ?? 0), 'state=', ctx.state, 'text=', String(text).slice(0, 10))
        this._timer = setTimeout(() => this._finish(), env.audio.playMs)
      },
      stop() {
        // 先记「被要求停止」，再看它当时在不在响：
        // 判据要的是「客户端确实对所有在册的源下手了」，不是「源有没有真响完」。
        this.stopRequested = true
        if (!this._started || this._finished) return
        clearTimeout(this._timer)
        this._finish()
      },
      _finish() {
        if (this._finished) return
        this._finished = true
        try { this.onended?.() } catch { /* ignore */ }
      },
    }
    env.playSources.push(node)
    return node
  }
  close() { if (env.audio.debug) console.log('[audio] close at', Date.now() - (env.audio.t0 ?? 0)); this.closed = true; this.state = 'closed'; return Promise.resolve() }
}

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
    blob: async () => new Blob([]),
  }
}

async function fakeFetch(url, options = {}) {
  const body = options?.body
  env.fetchLog.push({
    url,
    method: options?.method ?? 'GET',
    // 音频上传的体长（字节）：断言「这一段到底装了多少音频」用的就是它。
    bodyBytes: body?.byteLength ?? body?.length ?? null,
  })
  const u = String(url)
  if (u.includes('/dsh-voice-typing/tts?text=')) {
    const text = decodeURIComponent(u.split('text=')[1] ?? '')
    env.ttsTexts.push(text)
    const behavior = env.ttsBehavior(text)
    if (behavior.throw) throw new Error('network down')
    // hang：请求永不返回（宿主进程挂住 / 代理吞了连接）。客户端那条超时兜底只有在这里才承重。
    if (behavior.hang) await new Promise(() => {})
    if (!behavior.ok) {
      return {
        ok: false,
        status: behavior.status ?? 500,
        text: async () => JSON.stringify({ error: 'fake tts failure' }),
        json: async () => ({ error: 'fake tts failure' }),
        blob: async () => new Blob([]),
      }
    }
    return {
      ok: true,
      status: 200,
      blob: async () => ({ __text: text, size: 16 }),
      text: async () => '',
      json: async () => ({}),
      // 引擎回退只体现在响应头里（宿主是静默回退的），场景要能造出这个形状。
      // `extractTtsMeta` 同时认 Headers（有 get）和普通对象，这里给普通对象。
      headers: behavior.headers ?? {},
    }
  }
  if (u.startsWith('blob:')) {
    const item = objectUrls.get(u)
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        const bytes = Buffer.from(item?.__text ?? '', 'utf8')
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      },
      json: async () => ({}),
      text: async () => '',
      blob: async () => new Blob([]),
    }
  }
  if (u.includes('/asr-ready')) {
    env.mic.order.push('asr-ready')
    // 延迟模拟「模型还在加载」那段等待：状态行在这段等待里显示的是「准备中」。
    if (env.model.delayMs) await sleep(env.model.delayMs)
    const ready = env.model.ready === true
    const downloaded = env.model.downloaded !== false
    // 形状对齐真宿主（`src/host/index.js` 的 /asr-ready）：**没就绪时带的是原因码**，不是句子
    // （批次 18，docs §8.60）。界面那句由客户端按码查 i18n 出，所以这里的默认值也只能从
    // `src/shared/asr-readiness.js` 取 —— 替身写一句中文，测的就是个早该消失的形状。
    return jsonResponse(ready
      ? { ok: true, ready: true, downloaded: true, loaded: true }
      : {
        ok: true,
        ready: false,
        downloaded,
        loaded: false,
        reason: env.model.reason
          ?? (downloaded ? ASR_READY_REASONS.LOADING : ASR_READY_REASONS.NOT_DOWNLOADED),
      })
  }
  if (u.includes('/asr-warmup')) {
    env.mic.order.push('asr-warmup')
    return jsonResponse({
      ok: true,
      ready: env.model.ready === true,
      ...(env.model.ready === true ? {} : { reason: env.model.reason ?? ASR_READY_REASONS.LOAD_FAILED }),
    })
  }
  if (u.includes('/reading-ack')) {
    const body = JSON.parse(options?.body ?? '{}')
    // durationMs 也要记：宿主靠它算「追赶」，客户端只在**真播出音频**的那条回执上带它，
    // 被跳过 / 被丢弃的句子不带 —— 这是「入队时带上段落/轮次/会话信息」那批写法的行为对应物。
    env.acks.push({
      sessionId: body.sessionId,
      turnId: body.turnId,
      count: body.count ?? 1,
      durationMs: body.durationMs,
    })
    return jsonResponse({ ok: true })
  }
  if (u.includes('/transcribe')) {
    // 识别中途失败（场景 20）：直接 reject，演「宿主重启 / 网络断」。
    if (env.transcribeFail) throw new Error('fake: /transcribe 当场失败')
    // 识别结果。默认空文本（= 什么都没认出来），需要「认出一句话」的场景自己设
    // `env.transcript`；「自动发送」那条链路只有拿到非空文本才会往下走。
    return jsonResponse({ text: env.transcript ?? '' })
  }
  // 流式解码的会话收尾（断句 / 关麦都走这里）。放在 `/asr-stream` 之前：
  // 两条 URL 是前缀包含关系，先判长的这条，否则 reset 会被当成一次普通喂音频。
  if (u.includes('/asr-stream/reset')) {
    env.stream.resets.push(/sessionId=([^&]*)/.exec(u)?.[1] ?? '')
    return jsonResponse({ ok: true })
  }
  if (u.includes('/asr-stream')) {
    const sid = decodeURIComponent(/sessionId=([^&]*)/.exec(u)?.[1] ?? '')
    env.stream.feeds.push({ sid, bodyBytes: body?.byteLength ?? 0 })
    if (env.stream.unavailable) return jsonResponse({ unavailable: true, reason: 'fake: 这台机器没有流式模型' })
    const list = env.stream.texts
    const text = Array.isArray(list) && list.length
      ? list[Math.min(env.stream.feeds.length - 1, list.length - 1)]
      : (env.stream.text ?? '')
    return jsonResponse({ text })
  }
  if (u.includes('/config')) {
    if (options?.method === 'POST') {
      // 记下**真发出去的 payload**：面板那两条「保存前归一化」「只读状态不参与保存」
      // 判的就是这份数据，不是源码里有没有写 `normalizeForSave(`。
      let parsed = null
      try { parsed = JSON.parse(String(body ?? 'null')) } catch { parsed = { __unparsable: String(body) } }
      env.configPosts.push(parsed)
      // 请求根本没走通：真抛一个 Error 出去（生产那侧走的正是 catch）。
      if (env.configSaveReject) throw new Error(env.configSaveReject)
      if (env.configSaveResponse) {
        const r = env.configSaveResponse
        return {
          ok: r.ok !== undefined ? r.ok : false,
          status: r.status ?? 400,
          json: async () => r.body,
          text: async () => JSON.stringify(r.body ?? {}),
          blob: async () => new Blob([]),
        }
      }
      return jsonResponse({ ok: true, config: env.config })
    }
    // 「拉取失败会重试」：前 N 次让 GET 当场炸（宿主刚重启、网络抖一下那种）。
    if (env.configFailTimes > 0) {
      env.configFailTimes -= 1
      throw new Error('fake: GET /config 失败')
    }
    return jsonResponse({ ...env.config })
  }
  if (u.includes('/busy')) return jsonResponse({ busy: false })
  if (u.includes('/voices')) return jsonResponse({ voices: [], supported: true })
  // 模型档位清单（设置面板拉的那份）。默认空数组 = 老场景看到的和以前一模一样。
  if (u.includes('/models')) return jsonResponse({ models: env.models })
  // 运行环境自检（点「重新检查」发的那一条，批次 22-3-2，§8.67）。
  // `env.ttsEnv` 为 null 时保持改前那条通用形状（`{ok:true}`：没有 `engines`，
  // 面板只渲染「平台：」「显卡：」两行）—— 老场景一个字没变。
  // 要判那四行引擎行的场景自己喂一份，且**只能喂 `src/shared/tts-env-reasons.js` 里的码**：
  // 替身写一句中文，测的就是一个早该消失的形状（同 /asr-ready 那条注释）。
  if (u.includes('/tts/env')) return jsonResponse(env.ttsEnv ?? { ok: true })
  // 点「下载模型」发的那一条：`env.modelDownloadFail` 演宿主拒绝。
  // 形状只能是批次 22-4-1 之后宿主真回的那一份：`reason` + `params` + 那句原文（只给诊断）。
  // 替身只写一句中文当原因 = 判一个早该消失的形状（同上面 /tts/env 那条注释）。
  if (u.includes('/model') && options?.method === 'POST') {
    let id = ''
    try { id = String(JSON.parse(String(body ?? '{}')).id) } catch { /* 保持空串 */ }
    env.modelDownloads.push(id)
    if (env.modelDownloadFail) {
      const f = env.modelDownloadFail
      const payload = { error: f.error, ...(f.reason ? { reason: f.reason, params: f.params } : {}) }
      return {
        ok: false,
        status: f.status ?? 500,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
        blob: async () => new Blob([]),
      }
    }
    return jsonResponse({ ok: true })
  }
  // 系统级热键的只读诊断（设置面板那条状态行）。`diagnosticsFail` 演接口不可用。
  if (u.includes('/diagnostics')) {
    if (env.diagnosticsFail) throw new Error('fake: GET /diagnostics 失败')
    return jsonResponse(env.diagnostics ?? { ok: true })
  }
  // 客户端→宿主的诊断上报通道：把 payload 记下来，判据直接读上报内容而不是猜有没有报。
  if (u.includes('/voice-session')) {
    let parsed = null
    try { parsed = JSON.parse(String(body ?? 'null')) } catch { parsed = { __unparsable: String(body) } }
    env.clientReports.push(parsed)
    return jsonResponse({ ok: true, voiceSession: parsed?.sessionId || null })
  }
  return jsonResponse({ ok: true })
}

class FakeEventSource {
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    env.eventSources.push(this)
    setTimeout(() => { try { this.onopen?.() } catch { /* ignore */ } }, 0)
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  removeEventListener() {}
  close() { this.closed = true }
  emit(type, payload) {
    const open = this.listeners.get(type) ?? []
    const data = JSON.stringify({ v: 3, seq: 1, ts: Date.now(), ...payload })
    for (const fn of open) {
      try { fn({ data }) } catch (error) { env.warnings.push('handler ' + type + ': ' + error?.stack) }
    }
  }
}

const windowAddListeners = new Map()

/**
 * 假 CustomEvent。
 *
 * 之前沙箱里没有 `CustomEvent`：组件里那句 `win.dispatchEvent(new CustomEvent(事件名))`
 * 会抛 ReferenceError，再被外面那层 `try/catch` 吃掉（catch 里的注释就写着「测试桩环境」）——
 * 于是「浮层开麦时 composer 让位」「失败时把让位信号收回」这两条互斥契约
 * 在测试里根本不存在（写法错了也测不出来）。现在它是真的。
 */
class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = String(type ?? '')
    this.detail = init?.detail
    this.bubbles = init?.bubbles === true
    this.prevented = false
  }
  preventDefault() { this.prevented = true }
}

const fakeWindow = {
  document: fakeDocument,
  console,
  // `winSleepCapMs` 只在一个场景里设：把「25 秒的合成超时兜底」压成几十毫秒，
  // 判的是「兜底真的会顶上、管道不永久挂住」这件事，不是那 25 秒这个数字
  //（数字本身由 `TTS_TIMEOUT_MS` 常量决定，本 harness 不判它）。
  setTimeout: (fn, ms, ...rest) => {
    const id = setTimeout(fn, env.winSleepCapMs && ms > env.winSleepCapMs ? env.winSleepCapMs : ms, ...rest)
    env.winTimerOps.push({ op: 'set', kind: 'timeout', id, ms })
    return id
  },
  clearTimeout: (id) => {
    env.winTimerOps.push({ op: 'clear', kind: 'timeout', id })
    clearTimeout(id)
  },
  setInterval: (...args) => {
    const id = setInterval(...args)
    env.winTimerOps.push({ op: 'set', kind: 'interval', id, ms: args[1] })
    return id
  },
  clearInterval: (id) => {
    env.winTimerOps.push({ op: 'clear', kind: 'interval', id })
    clearInterval(id)
  },
  addEventListener(type, fn) {
    if (!windowAddListeners.has(type)) windowAddListeners.set(type, new Set())
    windowAddListeners.get(type).add(fn)
  },
  removeEventListener(type, fn) { windowAddListeners.get(type)?.delete(fn) },
  /**
   * 派发事件：记下事件名，再依次交给该类型上的监听者。
   *
   * 监听者抛错不往回收信方传（真实浏览器也是报给 window.onerror，
   * 不会让 dispatchEvent 本身失败），这里把它记进 warnings ——
   * 组件里那句 `try { dispatchEvent } catch {}` 就再也遮不住「接收方炸了」。
   */
  dispatchEvent(event) {
    const type = event?.type
    if (!type) return false
    env.winEvents.push(type)
    for (const fn of [...(windowAddListeners.get(type) ?? [])]) {
      try { fn(event) } catch (error) { env.warnings.push('listener ' + type + ': ' + error?.stack) }
    }
    return true
  },
  requestAnimationFrame(fn) { return setTimeout(fn, 0) },
  cancelAnimationFrame(id) { clearTimeout(id) },
  CustomEvent: FakeCustomEvent,
  NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  AudioContext: FakeAudioContext,
  webkitAudioContext: FakeAudioContext,
  isSecureContext: true,
  speechSynthesis: { cancel() {} },
}
fakeWindow.window = fakeWindow

/**
 * 假录音设备。`env.mic.mode` 决定它给什么 —— 默认 'no-device'（连 mediaDevices 都没有），
 * 因为除「开麦就绪判据」那一场景外，其余场景都不该真去开麦。
 */
const fakeNavigator = { mediaDevices: undefined }

function makeMicTrack(readyState) {
  return { kind: 'audio', label: 'fake-mic', readyState, stops: 0, stop() { this.stops += 1 } }
}

async function fakeGetUserMedia(constraints) {
  env.mic.gumCalls += 1
  env.mic.order.push('getUserMedia')
  env.mic.lastConstraints = constraints
  if (env.mic.mode === 'denied') throw new Error('NotAllowedError: 用户拒绝了麦克风权限')
  const tracks = env.mic.mode === 'empty-track'
    ? []
    : [makeMicTrack(env.mic.mode === 'ended-track' ? 'ended' : 'live')]
  const stream = { getAudioTracks: () => tracks.slice(), getTracks: () => tracks.slice(), tracks }
  env.mic.streams.push(stream)
  return stream
}

function setMicMode(mode) {
  env.mic.mode = mode
  fakeNavigator.mediaDevices = mode === 'no-device'
    ? undefined
    : { getUserMedia: fakeGetUserMedia }
}

/**
 * 一份能用的假「会话服务」（批次 13，场景 浮层待机唤醒）。
 *
 * 客户端只用得到它三件事（都从真代码的调用点倒推，不是照抄宿主形状）：
 *   - `list`：浮层靠它解析「这句话发进哪个会话」（`readSessionSnapshot` → `pickSessionId`），
 *     并会 `subscribe` 一份快照订阅；
 *   - `binding(id).session.prompt(parts, mode, signal, requestId)`：浮层的首选发送通路
 *     （和用户手打完全同一条路），这里把**真发出去的内容**记进 `env.prompts`；
 *   - `create()`：一个会话都没有时的自动新建（默认给不出 id，等于「新建失败」）。
 *
 * 每行都带自己的 `updatedAt`：`pickSessionId` 的第 3 档按「最近活跃」挑，
 * 多会话场景要判「选中了哪一个」，靠的就是这份可比的数值（不给就会并列成只看顺序）。
 *
 * @param {object} [options] - {
 *   sessions: 列表内容（[{id,title,updatedAt}]），默认一个会话；
 *   promptResult: `session.prompt` 的返回（默认 `{ok:true}`；给 `{ok:false,error:{code:'x'}}` 演直发被拒）,
 *   createId: 「新建会话」成功的 id，默认空串 = 新建失败,
 * }
 * @returns {object} 可以直接交给 `feedSessions()` 的服务对象。
 */
function makeSessionsService({ sessions = [{ id: 'sess-9', title: '会话九', updatedAt: 1 }], promptResult = { ok: true }, createId = '' } = {}) {
  const byId = {}
  const ids = []
  for (const row of sessions) {
    ids.push(row.id)
    byId[row.id] = { id: row.id, title: row.title ?? '', updatedAt: row.updatedAt ?? 0 }
  }
  const list = {
    snapshot: { ids, byId, retainedBy: {} },
    subs: new Set(),
    getSnapshot() { return list.snapshot },
    subscribe(fn) {
      list.subs.add(fn)
      return () => list.subs.delete(fn)
    },
  }
  return {
    list,
    binding(id) {
      return {
        session: {
          async prompt(parts, mode, _signal, requestId) {
            env.prompts.push({
              sessionId: id,
              text: String(parts?.[0]?.text ?? ''),
              mode: String(mode ?? ''),
              requestId: String(requestId ?? ''),
            })
            return promptResult
          },
        },
      }
    },
    async create() { return createId },
  }
}

/**
 * 把假会话服务喂进客户端（并让「没有服务」也能原样撤回）。
 *
 * 为什么要有这一步而不是直接改 env：客户端是在 `apply` 的那一次
 * `ctx.inject(['sessions'], cb)` 里把服务**存成模块级引用**的（见 main.js 455 行），
 * 之后只读那一份。所以「给服务」= 重放一次回调，「收回服务」也一样。
 *
 * @param {object|null} service - 假服务；null/undefined = 回到「客户端拿不到会话」。
 */
function feedSessions(service) {
  if (typeof env.capturedSessionsInject !== 'function') {
    throw new Error('宿主没有给 sessions 注入回调（客户端 inject 的形状变了，本场景前提不成立）')
  }
  env.sessionsService = service ?? null
  env.capturedSessionsInject(service ? { sessions: service } : {})
}

/**
 * 假 AudioWorkletNode。
 *
 * 只实现浮层真会用到的那几件事：`port.onmessage` 可赋值、`connect/disconnect`、
 * 构造参数原样记下（`processorOptions` 是断言的主体 —— 那串数就是主线程
 * 从 `DEFAULT_VAD_OPTIONS` 展开 + 帧数换算算出来的，浮层漏 import 时它压根到不了这儿）。
 */
class FakeAudioWorkletNode {
  constructor(ctx, name, options) {
    this.ctx = ctx
    this.name = name
    this.options = options ?? {}
    this.port = {
      onmessage: null,
      postMessage() {},
      start() {},
    }
    this.connected = []
    this.processorOptions = this.options.processorOptions ?? {}
    env.worklet.nodes.push(this)
  }
  connect(target) { this.connected.push(target) }
  disconnect() { this.disconnected = true }
}

const urlShim = {
  createObjectURL(blob) {
    const id = 'blob:fake-' + Math.random().toString(36).slice(2)
    objectUrls.set(id, blob)
    env.objectUrlsCreated.push(id)
    return id
  },
  revokeObjectURL(id) { objectUrls.delete(id) },
}

/* ------------------------------------------------------------------ */
/* 最小 React hooks 运行时                                             */
/* ------------------------------------------------------------------ */
/**
 * 一波「组件自己把自己叫醒」的重渲染上限（批次 6l-c）。
 *
 * 为什么是 400 而不是真 React 的 25：真 React 数的是**一次渲染函数里**的 setState 次数，
 * 这里数的是「挂载之后由 schedule 排队的渲染」—— 正常场景里播放、流式、面板联动
 * 各自都会排几十次，25 会误伤。而真正的自激循环一秒就能冲到上万次，400 足够把它掐住。
 * 收尾账本那条判据在盯 `maxStreak`：它要是逼近这个数，说明上限定低了，得改上限而不是改场景。
 */
const RENDER_LOOP_LIMIT = 400

function createHookRuntime() {
  const slots = []
  let index = 0
  let rendering = false
  let scheduled = false
  let tree = null
  let mounted = false
  let component = null
  let props = null
  const pendingEffects = []
  /**
   * 现在正处在第几层「setState 的更新函数」里。
   *
   * 真实 React 要求更新函数是纯的：在里面调别的 setState 会当场警告、并可能重复更新。
   * 以前这条只写在源码注释里（`loadModels` 那句「不要塞进 setModels 的更新函数」），
   * 判据只能扫文本；现在假运行时自己盯着 —— 更新函数执行期间任何一次 `set()` 都记进
   * `env.updaterSideEffects`，场景 27 判它必须是空的。
   */
  let updaterDepth = 0

  /**
   * 跑一个 setState 的更新函数：期间 `updaterDepth > 0`，
   * 任何一次 `set()` 都会被 `useState` 里那句记进 `env.updaterSideEffects`。
   */
  function runUpdater(fn, slot) {
    updaterDepth += 1
    try {
      return fn(slot.value)
    } finally {
      updaterDepth -= 1
    }
  }

  const sameDeps = (a, b) => {
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
    return true
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, config, ...children) {
      const propsObj = { ...(config ?? {}) }
      if (children.length === 1) propsObj.children = children[0]
      else if (children.length > 1) propsObj.children = children
      return { type, props: propsObj, key: propsObj.key ?? null }
    },
    useState(initial) {
      const i = index++
      if (!slots[i]) slots[i] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      const set = (next) => {
        if (updaterDepth > 0) env.updaterSideEffects.push(`slot #${i}`)
        const value = typeof next === 'function' ? runUpdater(next, slot) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        schedule()
      }
      return [slot.value, set]
    },
    useRef(initial) {
      const i = index++
      if (!slots[i]) slots[i] = { kind: 'ref', ref: { current: initial } }
      return slots[i].ref
    },
    useCallback(fn, deps) {
      const i = index++
      const slot = slots[i]
      if (slot && sameDeps(slot.deps, deps)) return slot.fn
      slots[i] = { kind: 'cb', fn, deps }
      return fn
    },
    useEffect(fn, deps) {
      const i = index++
      const slot = slots[i]
      const changed = !slot || !sameDeps(slot.deps, deps)
      if (!slot) slots[i] = { kind: 'effect', deps, fn, cleanup: null }
      else {
        if (changed) slot.fn = fn
        slot.deps = deps
      }
      if (changed) pendingEffects.push(i)
    },
  }

  function runEffects() {
    while (pendingEffects.length) {
      const i = pendingEffects.shift()
      const slot = slots[i]
      if (!slot || slot.kind !== 'effect') continue
      if (typeof slot.cleanup === 'function') {
        try { slot.cleanup() } catch (error) { env.warnings.push('effect cleanup: ' + error?.stack) }
        slot.cleanup = null
      }
      try {
        const ret = slot.fn()
        if (typeof ret === 'function') slot.cleanup = ret
      } catch (error) {
        env.warnings.push('effect: ' + error?.stack)
      }
    }
  }

  function render() {
    if (rendering) return
    // 熔断（批次 6l-c）：一波「自己把自己叫醒」的重渲染超过上限就停手。
    // 真 React 的开发模式在这种形状上抛「Too many re-renders」；这里不抛，
    // 记进 `env.renderLoop` 让场景判 —— 没有它，引用不稳的 effect 会让整个测试文件 OOM。
    if (env.renderLoop.streak >= RENDER_LOOP_LIMIT) {
      env.renderLoop.blown = true
      return
    }
    env.renderLoop.streak += 1
    if (env.renderLoop.streak > env.renderLoop.maxStreak) env.renderLoop.maxStreak = env.renderLoop.streak
    // 这一格不按场景清：收尾账本要知道**整趟**最高冲到过多少次。
    if (env.renderLoop.streak > env.renderLoop.runMaxStreak) env.renderLoop.runMaxStreak = env.renderLoop.streak
    rendering = true
    index = 0
    try {
      tree = component(props)
    } catch (error) {
      env.warnings.push('render: ' + error?.stack)
      rendering = false
      return
    }
    rendering = false
    mounted = true
    runEffects()
  }

  function schedule() {
    if (scheduled || !mounted) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!mounted) return
      render()
    })
  }

  function mount(comp, compProps) {
    // 换组件 = 重新挂载：这个假运行时没有「fiber ↔ slots」的对应关系，
    // 不清空的话新组件会拿到上一个组件的 hook 状态（useState 的初值直接被忽略）。
    if (comp !== component) slots.length = 0
    component = comp
    props = compProps
    // 外部调用 = 新的一波：重渲染计数归零，熔断只针对「组件自己转圈」。
    env.renderLoop.streak = 0
    render()
  }

  /**
   * 卸载：跑掉每个 effect 的 cleanup（真实 React 在组件销毁时做的事）。
   *
   * 为什么要有它：「面板卸载时复位某个模块级状态」这类代码，
   * 用正则扫源码只能证明**写了那一行**，证明不了那一行真被调用。
   * 第 4 步 4.3 的快捷键聚焦状态就靠这个函数变成可测的行为。
   */
  function unmount() {
    mounted = false
    for (const slot of slots) {
      if (slot?.kind === 'effect' && typeof slot.cleanup === 'function') {
        try { slot.cleanup() } catch (error) { env.warnings.push('unmount cleanup: ' + error?.stack) }
        slot.cleanup = null
      }
    }
    // 清空 slots 并重置 component，这样下次 mount 时会重新执行组件函数，
    // 创建新的 ref 对象。不清 component 的话，组件函数的闭包会保留对旧 ref 的引用，
    // 即使 slots 被清空，新 mount 时创建的 ref 对象也不会被旧闭包看到。
    slots.length = 0
    index = 0
    component = null  // 强制下次 mount 重新执行组件函数
  }

  return {
    React, mount, unmount,
    getTree: () => tree,
    setState: (slotIndex, value) => { slots[slotIndex].value = value; schedule() },
  }
}

/**
 * 把 `props.children` 摊平成一维。
 *
 * 必须递归：`h('div', null, list.length ? list.map(render) : null)` 里那个
 * `.map(...)` 返回的**数组本身**就是一个子节点，不是元素。
 * 原来这里只摊一层（`Array.isArray(children) ? children : [children]`），
 * 于是嵌套数组那一支直接交给 `findByProp(数组, …)` → 数组没有 `props` → 返回 null，
 * 结果「模型下载列表」那一整块（就是用 `.map()` 生成的）在 findByProp 里是盲区，
 * 按钮找得到却点不着。批次 5b 挂面板时才撞上（手写栈遍历能列出来、findByProp 找不到）。
 * @param {unknown} children
 * @param {Array} out 收集结果
 * @returns {Array}
 */
function flattenChildren(children, out = []) {
  if (children === null || children === undefined || children === false) return out
  if (Array.isArray(children)) {
    for (const child of children) flattenChildren(child, out)
    return out
  }
  out.push(children)
  return out
}

function findByProp(node, predicate) {
  if (!node || typeof node !== 'object') return null
  // 函数组件（Label / Section / Row / Toggle）：调一下拿到它返回的子树，
  // 否则 findByProp 在 `{type: Label, props: {children: ...}}` 这一层就停了，
  // 看不到 Label 内部的 input。
  if (typeof node.type === 'function' && node.type.prototype?.isReactComponent !== true) {
    try {
      const rendered = node.type(node.props ?? {})
      if (rendered) {
        if (rendered.props && predicate(rendered)) return rendered
        const found = findByProp(rendered, predicate)
        if (found) return found
      }
    } catch { /* 渲染失败就跳过，让调用方报「找不到」 */ }
  }
  if (node.props && predicate(node)) return node
  for (const child of flattenChildren(node.props?.children)) {
    const found = findByProp(child, predicate)
    if (found) return found
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 加载 client.js                                                      */
/* ------------------------------------------------------------------ */
const registrations = []
let moduleDef = null
const sandbox = {
  window: fakeWindow,
  globalThis: null,
  document: fakeDocument,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  Buffer,
  URL: urlShim,
  Blob: globalThis.Blob,
  AudioWorkletNode: FakeAudioWorkletNode,
  CustomEvent: FakeCustomEvent,
  fetch: fakeFetch,
  EventSource: FakeEventSource,
  AbortController,
  TextEncoder,
  TextDecoder,
  process,
  navigator: fakeNavigator,
}
sandbox.globalThis = sandbox
fakeWindow.__ModuleLoader__ = { load(def) { moduleDef = def } }
vm.createContext(sandbox)
vm.runInContext(clientSrc, sandbox, { filename: 'lib/client.js' })

const runtime = createHookRuntime()
const requireStub = (name) => {
  if (name === 'react') return runtime.React
  throw new Error('unexpected require: ' + name)
}
const exportsObj = moduleDef.factory(requireStub)
exportsObj.apply({
  inject(_deps, cb) {
    const scope = {
      effect(fn) { const d = fn(); return d ?? (() => {}) },
      locale: { register() { return () => {} } },
      slots: {
        inject(_name, cb2) { cb2() },
        register(options, component) {
          registrations.push({ options, component })
          return () => {}
        },
      },
    }
    // `ctx.inject(['sessions'], ...)`：客户端用它捕获会话服务（浮层要拿它解析
    // 「这句话发进哪个会话」）。以前这里直接 `cb(scope)`，scope 上没有 sessions，
    // 于是所有场景里浮层都只能走「没有会话」那条分支 —— 「上报必须带 sessionId 键」
    // 的那一半（有真 id 时）根本没被驱动过（批次 13）。
    // 现在把回调留一手：默认仍然喂一份没有 sessions 的 scope（旧场景行为一字不变），
    // 需要的场景先设 `env.sessionsService` 再调 `feedSessions()` 重放一次。
    if (Array.isArray(_deps) && _deps.includes('sessions')) {
      env.capturedSessionsInject = cb
      env.sessionsService = null
    }
    cb(scope)
  },
})

const MicButton = registrations.find((r) => r.component && /MicButton/.test(r.component.name ?? ''))?.component
if (!MicButton) {
  console.error('找不到 MicButton 组件，registrations=', registrations.map((r) => r.options))
  process.exit(2)
}

// 设置面板：快捷键输入框的 onFocus/onBlur 与「卸载时复位」都住在这个组件里，
// 场景「窗口内快捷键」的后半段要挂它（MicButton 里没有那两个 handler）。
const SettingsSection = registrations.find((r) => r.options?.name === 'settings.section')?.component

/* ------------------------------------------------------------------ */
/* 驱动                                                               */
/* ------------------------------------------------------------------ */
function currentSource() {
  const sources = env.eventSources.filter((s) => !s.closed)
  return sources[sources.length - 1]
}

function emit(type, payload) {
  const sse = currentSource()
  if (!sse) throw new Error('no live EventSource')
  sse.emit(type, payload)
}

/**
 * 直接投一份**原始 data**（不套信封、不做 JSON.stringify）。
 *
 * 批次 6i-b（docs §8.42）加它是为了判「客户端的消费点是不是都走 `parseEnvelope`」：
 * 那个解析器的全部作用就是把坏输入变成 `null`（不抛）。哪一处消费点自己写
 * `JSON.parse(event.data)`，坏 data 就会从事件回调里抛出来 —— 假 EventSource 的
 * `emit` 会把抛出的东西记进 `env.warnings`，所以「有没有裸解析」是**能跑出来看**的，
 * 不用扫源码。
 */
function emitRaw(type, data) {
  const sse = currentSource()
  if (!sse) throw new Error('no live EventSource')
  const open = sse.listeners.get(type) ?? []
  for (const fn of open) {
    try { fn({ data }) } catch (error) { env.warnings.push('raw handler ' + type + ': ' + error?.stack) }
  }
}

function emitSentence({ text, turnId = 'turn-1', index, para, paraStart, sessionId = 'sess-1', omitSessionId = false }) {
  emit('sentence', {
    // omitSessionId 演「老宿主 / 信封里没带会话 id」：客户端要回落到自己那一份会话。
    ...(omitSessionId ? {} : { sessionId }),
    turnId,
    index,
    text,
    para,
    paraStart,
  })
}

function ackTotal() {
  return env.acks.reduce((n, a) => n + (Number(a.count) || 0), 0)
}

/** 等朗读管道彻底空闲（pumpQueue 已退出、队列为空），避免场景之间互相污染。 */
async function settle(timeoutMs = 6000) {
  const idle = await waitFor(() => {
    const dbg = fakeWindow.__DSH_VOICE_DEBUG__?.()
    return Boolean(dbg) && dbg.speaking === false && dbg.queue === 0
  }, timeoutMs)
  await sleep(150)
  if (!idle && process.env.HARNESS_DEBUG) console.log('DEBUG settle timeout', fakeWindow.__DSH_VOICE_DEBUG__?.())
}

function resetEnv() {
  try { env.audio.ctx?.close() } catch { /* ignore */ }
  env.playedTexts.length = 0
  env.playSources.length = 0
  env.objectUrlsCreated.length = 0
  env.acks.length = 0
  env.ttsTexts.length = 0
  env.audio = { mode: 'running', playMs: 25, suspendUntil: 0, neverResume: false, resumeCalls: 0 }
  env.ttsBehavior = () => ({ ok: true, status: 200 })
  env.domQueryResult = []
  env.domQueryThrows = false
  env.winSleepCapMs = 0
  env.winTimerOps.length = 0
  env.configFailTimes = 0
  env.warnings.length = 0
  // 重渲染熔断的账：每个场景自己算，别拿上一个场景的余数把这一场景掐死。
  env.renderLoop.streak = 0
  env.renderLoop.maxStreak = 0
  env.renderLoop.blown = false
  // 开麦相关的默认值：设备不可用 + 模型就绪。
  // 「设备不可用」是搬动前 harness 的形状（sandbox 里 navigator.mediaDevices 是 undefined），
  // 除「开麦就绪判据」场景外都保持它，别的场景不会误开真麦克风。
  env.audioContexts.length = 0
  // 配置共享存储是**模块级单例**，跨挂载存活。生产里「刚保存的值优先」是对的
  // （`configRef.current = {...data, ...configStore.value}`），但设置面板那个场景存过一份
  // `autoSend: false` 之后，它会盖住后面每个场景拉到的宿主配置 ——
  // 「自动发送」整条链路就被上一个场景掐掉了。清它，但不调 set()（不通知现役订阅者，
  // 免得把还没卸载的组件的配置读成空值）。
  const store = exportsObj.__test.configStore
  store.value = {}
  store.loaded = false
  env.model = { ready: true, delayMs: 0 }
  env.submits.length = 0
  env.draftWrites.length = 0
  env.transcript = ''
  env.transcribeFail = false
  // 流式那一段（场景 29）的注入面与记账：默认全关，别的场景看不到 /asr-stream。
  env.stream = { text: '', texts: null, unavailable: false, feeds: [], resets: [] }
  env.mic = { mode: 'no-device', gumCalls: 0, order: [], streams: [], lastConstraints: null, sources: [], processors: [], analysers: [], level: 0 }
  // 采集首选路径默认关（harness 搬动前就没有 audioWorklet），由需要的场景自己打开。
  env.worklet = { available: false, addModuleThrows: false, modules: [], nodes: [] }
  env.clientReports.length = 0
  // 会话服务（批次 13）：客户端把它存成模块级引用，跨挂载存活。
  // 上一个场景喂过假服务不清掉的话，后面每个挂浮层的场景都会突然「有会话」，
  // 发送走真通路而不是「没有当前会话」—— 判据就分不出谁是谁了。
  env.prompts.length = 0
  if (typeof env.capturedSessionsInject === 'function') {
    env.capturedSessionsInject({})
    env.sessionsService = null
  }
  env.winEvents.length = 0
  // 设置面板那三段的注入面（批次 5b）：每段自己给，默认全空。
  env.models = []
  env.ttsEnv = null
  env.modelDownloadFail = null
  env.modelDownloads.length = 0
  env.configPosts.length = 0
  env.configSaveResponse = null
  env.configSaveReject = ''
  env.diagnostics = null
  env.diagnosticsFail = false
  env.updaterSideEffects.length = 0
  setMicMode('no-device')
}

function bootMic(overrides = {}) {
  runtime.mount(MicButton, {
    sessionId: 'sess-1',
    t: (k) => k,
    // composer 的动作面：客户端只会通过它「填草稿 / 发送」。
    // 记下 submit 被调了几次 —— 「同一段话发两遍」的判据就是它。
    inputActions: {
      submit: () => env.submits.push({ at: Date.now() }),
      // 写进来的整份文本按顺序记下来 —— 「说的话有没有留在输入框」只能这么数
      // （`dbg().draft` 是对输入框的读回，harness 的 composer 不会回读，永远是空串）。
      setDraft: (text) => { env.draftWrites.push(String(text ?? '')) },
    },
    // 场景要换 sessionId（批次 13b：心跳那条键得演「有 id」与「没 id」两种挂载）。
    ...overrides,
  })
}

/**
 * 重挂一次组件。
 *
 * 为什么需要：配置只在**挂载**和 `on` 翻转时拉（没有轮询），而 `resetEnv()` 是
 * 直接改共享存储单例的 `value`（不调 `set()`，免得把还没卸载的现役订阅者读成空值）。
 * 于是「上一个场景存过的配置」会一直留在这个已挂载实例的 configRef 里 ——
 * 新场景不改配置就读不到，改了的也读不到。批次 4 记的坑 1/2 就是这个，
 * 本批 4d 第一次跑 场景 21 又踩了一遍（句子全被上一场景残留的 `readAloud:false` 拦掉）。
 */
async function remountFresh() {
  runtime.unmount()
  bootMic()
  await sleep(300)
}

/**
 * 把「这个测试以来建过的每一个音频上下文」都关掉，并清空本场景的记录。
 *
 * 为什么需要：常驻播放上下文是模块级单例（`playback-core` 的 `playCtxCache`），
 * 测试从外面点不到它的名字。`resetEnv()` 只会关掉**最后建的那个**（`env.audio.ctx`），
 * 上一个场景留下的如果是「麦克风上下文」，播放那一份就还是活的、而且是 running ——
 * 于是「起手挂起」的三档场景（21 的 A/B/C）根本没进轮询，句子 33 毫秒就播完了
 * （本轮第一次跑就是这样，playSkipped 永远是 0）。
 * 全关掉之后 `getPlayCtx()` 只剩「按当前 `env.audio.mode` 新建」这一条路，
 * 「挂起 → 轮询 → 跳过」这条链才真的被走到。
 */
function closeAllAudioContexts() {
  for (const ctx of env.allContexts) { try { ctx.close() } catch { /* ignore */ } }
  env.audioContexts.length = 0
}

/**
 * 把一条 keydown 依次交给 window 上所有 keydown 监听。
 *
 * 假 window 不区分捕获/冒泡阶段（addEventListener 只按类型收），
 * 这里要的是「用户按下这串键，真实组件到底认不认」。
 * 返回值上的 `prevented` 就是判据：命中组合键才会 preventDefault。
 *
 * @param {object} eventInit - { key, altKey, ctrlKey, shiftKey, metaKey, repeat }。
 * @returns {object} 带 `prevented` 的事件对象。
 */
function dispatchKey(eventInit = {}) {
  const event = {
    key: eventInit.key ?? '',
    altKey: eventInit.altKey === true,
    ctrlKey: eventInit.ctrlKey === true,
    shiftKey: eventInit.shiftKey === true,
    metaKey: eventInit.metaKey === true,
    repeat: eventInit.repeat === true,
    prevented: false,
    preventDefault() { this.prevented = true },
  }
  for (const fn of [...(windowAddListeners.get('keydown') ?? [])]) {
    try { fn(event) } catch (error) { env.warnings.push('keydown: ' + error?.stack) }
  }
  return event
}

function makeSentences(paras) {
  // paras: [[text,...], ...] -> [{text,index,para,paraStart}]
  let index = 0
  const out = []
  paras.forEach((texts, para) => {
    texts.forEach((text, i) => {
      out.push({ text, index: index++, para, paraStart: i === 0 })
    })
  })
  return out
}

function emitAll(sentences, turnId = 'turn-1') {
  for (const s of sentences) emitSentence({ ...s, turnId })
}

/* ------------------------------------------------------------------ */
/* 场景 1：正常顺序播放 + ack 恰好一次                                  */
/* ------------------------------------------------------------------ */
async function scenarioNormal() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'n1' })
  const list = makeSentences([
    ['这是第一段第一句。', '这是第一段第二句。'],
    ['这是第二段第一句。', '这是第二段第二句。'],
    ['这是第三段第一句。'],
  ])
  emitAll(list, 'n1')
  const done = await waitFor(() => env.playedTexts.length >= list.length, 8000)
  await sleep(200)
  check('[正常] 全部句子按顺序播放', done && env.playedTexts.join('|') === list.map((s) => s.text).join('|'),
    JSON.stringify(env.playedTexts))
  check('[正常] 每条 sentence 恰好 ack 一次', ackTotal() === list.length, `acks=${ackTotal()} expect=${list.length}`)
  check('[正常] 没有 JS 异常', env.warnings.length === 0, env.warnings.join('\n'))
}

/* ------------------------------------------------------------------ */
/* 场景 2：合成失败 / 跳过的句子也必须 ack 一次                          */
/* ------------------------------------------------------------------ */
async function scenarioTtsFailure() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'f1' })
  env.ttsBehavior = (text) => (text.includes('FAIL') ? { ok: false, status: 500 } : { ok: true, status: 200 })
  const list = makeSentences([['正常一句。', 'FAIL 这句会失败。', '正常两句。', 'FAIL 又失败。']])
  emitAll(list, 'f1')
  const done = await waitFor(() => ackTotal() >= list.length, 8000)
  await sleep(200)
  check('[合成失败] 失败的句子被跳过、其余照播',
    done && env.playedTexts.join('|') === '正常一句。|正常两句。', JSON.stringify(env.playedTexts))
  check('[合成失败] 每条 sentence 恰好 ack 一次', ackTotal() === list.length, `acks=${ackTotal()}`)
}

/* ------------------------------------------------------------------ */
/* 场景 2b：引擎静默回退（本地失败 → 在线）必须被用户和诊断看到            */
/* ------------------------------------------------------------------ */

/**
 * 在假渲染树里找一段文本。
 * 用在「用户看得见什么」这类断言上：文案来自 i18n，比扫源码里的 key 名可靠得多。
 */
function treeHasText(node, needle, budget = 4000) {
  if (node == null || budget <= 0) return false
  if (typeof node === 'string' || typeof node === 'number') return String(node).includes(needle)
  if (Array.isArray(node)) return node.some((child) => treeHasText(child, needle, budget - 1))
  const children = node?.props?.children
  if (children === undefined) return false
  return treeHasText(children, needle, budget - 1)
}

async function scenarioTtsFallbackMeta() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'fb1' })
  // 宿主的回退是**静默**的：/tts 照常 200，只在响应头里说明实际用了在线引擎
  //（文本发到了微软）。客户端必须把这个事实透出来，否则用户以为还在离线跑。
  env.ttsBehavior = () => ({
    ok: true,
    headers: { 'x-tts-engine': 'edge', 'x-tts-engine-fallback': 'online' },
  })
  emitSentence({ text: '被回退念出的一句。', turnId: 'fb1', index: 0, para: 0, paraStart: true })
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  const played = await waitFor(() => env.playedTexts.length >= 1, 8000)
  check('[引擎回退] 回退的那句照常播出（回退只换来源，不影响出声）',
    played && env.playedTexts.includes('被回退念出的一句。'), JSON.stringify(env.playedTexts))
  // 这两条取代了原来在 config-ui 里正则扫 `ttsFallbacks: ttsFallbackCount` 的形状断言：
  // 4.2 之后这些状态住在 src/client/dom/playback-core.js，扫变量名的断言既抓不到搬迁、
  // 也证明不了「宿主真能读到」—— 直接读一次运行时快照才是证据。
  check('[引擎回退] 回退次数进诊断快照（ttsFallbacks）', (dbg().ttsFallbacks ?? 0) >= 1,
    `ttsFallbacks=${dbg().ttsFallbacks}`)
  check('[引擎回退] 最近一次回退目标与实际引擎都进诊断',
    dbg().lastTtsFallback === 'online' && dbg().lastTtsEngine === 'edge',
    JSON.stringify({ f: dbg().lastTtsFallback, e: dbg().lastTtsEngine }))
  // 假 React 环境里的 `t()` 直接把 key 当文案返回（harness 没有词典），
  // 所以在渲染树里认的是 key —— 这仍然比扫源码强：它要求「这一刻界面上真渲染了这条提示」。
  const hinted = await waitFor(() => treeHasText(runtime.getTree(), 'ttsFallbackOnline'), 1200)
  check('[引擎回退] 界面提示了「已回退在线」（不是悄悄换引擎）', hinted,
    '渲染树里没找到回退提示（ttsFallbackOnline）')
  await sleep(50)
}

/* ------------------------------------------------------------------ */
/* 场景 3：重复广播去重（收到 2 条 → ack 2 条，播放 1 次）                */
/* ------------------------------------------------------------------ */
async function scenarioDuplicate() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'd1' })
  emitSentence({ text: '只该念一次。', turnId: 'd1', index: 0, para: 0, paraStart: true })
  await waitFor(() => env.playedTexts.length >= 1, 5000)
  emitSentence({ text: '只该念一次。', turnId: 'd1', index: 0, para: 0, paraStart: true })
  await waitFor(() => ackTotal() >= 2, 2000)
  await sleep(100)
  check('[去重] 重复的 sentence 不重播', env.playedTexts.length === 1, JSON.stringify(env.playedTexts))
  check('[去重] 两条收到的 sentence 各 ack 一次（传给宿主的是 2）', ackTotal() === 2, `acks=${ackTotal()}`)
}

/* ------------------------------------------------------------------ */
/* 场景 4：手动静音（点「停止朗读」）→ 后续句子 ack 但不播               */
/* ------------------------------------------------------------------ */
async function scenarioMute() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'm1' })
  emitSentence({ text: '停止前的一句。', turnId: 'm1', index: 0, para: 0, paraStart: true })
  await waitFor(() => env.playedTexts.length >= 1, 5000)
  // 等一次重渲染，让「停止朗读」按钮出现
  await sleep(50)
  const tree = runtime.getTree()
  const stopBtn = findByProp(tree, (node) => node?.type === 'button' && node?.props?.['aria-label'] === 'stopSpeaking')
  if (!stopBtn) {
    check('[静音] 找到「停止朗读」按钮', false, '渲染树里没有 stopSpeaking 按钮（speaking 状态没更新？）')
    return
  }
  check('[静音] 找到「停止朗读」按钮', true)
  stopBtn.props.onClick()
  await sleep(100)
  const emittedAfter = 3
  for (let i = 1; i <= emittedAfter; i++) {
    emitSentence({ text: '停止后的第' + i + '句。', turnId: 'm1', index: i, para: 0, paraStart: false })
  }
  await waitFor(() => ackTotal() >= 1 + emittedAfter, 2000)
  await sleep(100)
  check('[静音] 停止后这一轮的句子不再播放', env.playedTexts.length === 1, JSON.stringify(env.playedTexts))
  check('[静音] 被静音拦下的句子也各 ack 一次', ackTotal() === 1 + emittedAfter, `acks=${ackTotal()}`)
}

/* ------------------------------------------------------------------ */
/* 场景 5：turn-begin 清空旧队列 → 清掉的句也要 ack 一次                 */
/* ------------------------------------------------------------------ */
async function scenarioTurnReset() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'r1' })
  const oldList = makeSentences([['旧轮第一句。', '旧轮第二句。', '旧轮第三句。', '旧轮第四句。', '旧轮第五句。', '旧轮第六句。']])
  emitAll(oldList, 'r1')
  // 立刻换轮（趁旧队列还在）
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'r2' })
  const newList = makeSentences([['新轮唯一一句。']])
  emitAll(newList, 'r2')
  await waitFor(() => ackTotal() >= oldList.length + newList.length, 8000)
  await sleep(100)
  check('[换轮] 旧轮被清掉的句子也 ack（总数 = 6 + 1）',
    ackTotal() === oldList.length + newList.length, `acks=${ackTotal()}`)
  check('[换轮] 新轮的句子会播', env.playedTexts.includes('新轮唯一一句。'), JSON.stringify(env.playedTexts))
  const playedOld = env.playedTexts.filter((t) => t.startsWith('旧轮'))
  check('[换轮] 旧轮播放发生在换轮之前（不会倒回去念旧内容）',
    env.playedTexts.lastIndexOf(playedOld[playedOld.length - 1] ?? '') <
    env.playedTexts.indexOf('新轮唯一一句。'), JSON.stringify(env.playedTexts))
  // 批次 4d：账要记在**句子自己那一轮**上。入队项不带 turnId 的话，
  // turn-begin 会先换成新轮再清队列（haltSpeaking 里 ackDroppedItems 读的是 currentTurnIdRef，
  // 那时它已经是 r2）→ 旧轮 6 句的账全记到新轮，宿主的按轮计数就永远对不上。
  const byTurn = {}
  for (const a of env.acks) byTurn[a.turnId] = (byTurn[a.turnId] ?? 0) + (Number(a.count) || 0)
  check('[换轮] 清掉的 6 句记在旧轮 r1、播出的 1 句记在新轮 r2（回执按轮分得开）',
    byTurn.r1 === 6 && byTurn.r2 === 1, JSON.stringify({ byTurn, acks: env.acks }))
}

/* ------------------------------------------------------------------ */
/* 场景 6：长单段回复 + 一次性 burst → 安全网是否把整段剩余裁掉？          */
/* ------------------------------------------------------------------ */
async function scenarioLongSingleParaBurst() {
  await settle()
  resetEnv()
  // 模拟「宿主 pending 模式 endCall 一次性把整段剩余句子喷出来」：
  // 第一句先发（客户端开始合成），其余 11 句随即一起到达。
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'b1' })
  const texts = []
  for (let i = 0; i < 12; i++) texts.push('这是同一个自然段里的第' + i + '句，用来验证安全网。')
  emitSentence({ text: texts[0], turnId: 'b1', index: 0, para: 0, paraStart: true })
  await sleep(0)
  for (let i = 1; i < texts.length; i++) {
    emitSentence({ text: texts[i], turnId: 'b1', index: i, para: 0, paraStart: false })
  }
  // 批次 6f：「正在播的段落」这个裁剪保护值现在是**看得见的**（调试快照里的 playingPara）。
  // 原来它由 read-aloud-stop 里一条「`playingParaRef.current = -1` 至少出现三次」的
  // 源码计数判据守着 —— 数写法守不住「复位点漏了一个」，也守不住「复位错了值」。
  const guardOn = await waitFor(() => (fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}).playingPara === 0, 3000)
  check('[burst 单段] 开始消耗这一句时把裁剪保护值钉成它的段落（快照 playingPara=0）',
    guardOn, JSON.stringify({ playingPara: (fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}).playingPara }))
  const done = await waitFor(() => env.playedTexts.length >= texts.length, 9000)
  await waitFor(() => ackTotal() >= texts.length, 2000)
  await sleep(50)
  const dbg = fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  check('[burst 单段] 12 句全部播出（安全网不该把正在读的这段剩余全裁掉）',
    done && env.playedTexts.length === texts.length,
    `播放了 ${env.playedTexts.length}/12；trimmed=${dbg.trimmed}；播出的：${JSON.stringify(env.playedTexts.map((t) => t.slice(8, 11)))}`)
  check('[burst 单段] 收到 12 句就要 ack 12 次（播的 + 裁掉的）', ackTotal() === texts.length, `acks=${ackTotal()}`)
  check('[burst 单段] 管道结束后裁剪保护值回到 -1（留着旧段号会让下一轮裁剪保护错段落）',
    dbg.playingPara === -1, JSON.stringify({ playingPara: dbg.playingPara }))
}

/* ------------------------------------------------------------------ */
/* 场景 6b：同场景的时序证据 —— 裁剪发生在「正在读这一段」的时候还是之后？ */
/* ------------------------------------------------------------------ */
async function scenarioTrimTimingEvidence() {
  await settle()
  resetEnv()
  const trace = []
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  const trimmedBase = dbg().trimmed ?? 0
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'b1t' })
  const texts = []
  for (let i = 0; i < 12; i++) texts.push('时序证据段第' + i + '句。')
  const t0 = Date.now()
  const sample = () => {
    const d = dbg()
    trace.push({ t: Date.now() - t0, played: env.playedTexts.length, trimmed: (d.trimmed ?? 0) - trimmedBase, speaking: d.speaking, queue: d.queue })
  }
  emitSentence({ text: texts[0], turnId: 'b1t', index: 0, para: 0, paraStart: true })
  await sleep(0)
  for (let i = 1; i < texts.length; i++) emitSentence({ text: texts[i], turnId: 'b1t', index: i, para: 0, paraStart: false })
  while (Date.now() - t0 < 1200) {
    sample()
    if (env.playedTexts.length >= texts.length) break
    await sleep(20)
  }
  // 修复后的正确行为：单段 burst 里每一句都属于「当前段 / 最新段」，安全网
  // **根本不该裁**；即使发生了裁剪，也必须发生在第一句开播之前（丢更旧的段），
  // 绝不能在开播之后把当前段的剩余句子裁掉。
  const firstTrim = trace.find((x) => x.trimmed > 0)
  const trimmedAfterPlay = Boolean(firstTrim) && firstTrim.played > 0
  check('[burst 时序] 单段 burst 不会在开播后裁剪当前段剩余（修复后应完全不裁）',
    !trimmedAfterPlay,
    'trim 首次出现时 played=' + (firstTrim ? firstTrim.played : 'never（完全没裁，符合预期）') +
      '；trace=' + JSON.stringify(trace.filter((x, i, a) => i === 0 || x.trimmed !== a[i - 1].trimmed)))
}

/* ------------------------------------------------------------------ */
/* 场景 7：多段 burst → 不允许「从段落中间开始播」                       */
/* ------------------------------------------------------------------ */
async function scenarioMultiParaBurst() {
  await settle()
  resetEnv()
  // 批次 6f：这一句要慢到「宿主流控兜不住」的程度，安全网才真的会裁 ——
  // 只有真裁过，才判得出「裁掉的句数记进哪一格」。默认 25ms 播得太快，两边都是 0。
  env.audio.playMs = 400
  // 组件不重挂，计数是 ref 上的累计值 —— 判据一律按**增量**算。
  const baseDbg = fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  const baseTrimmed = Number(baseDbg.trimmed) || 0
  const baseDropped = Number(baseDbg.dropped) || 0
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'b2' })
  const list = makeSentences([
    ['段零第一句。', '段零第二句。'],
    ['段一第一句。', '段一第二句。', '段一第三句。'],
    ['段二第一句。', '段二第二句。', '段二第三句。'],
    ['段三第一句。', '段三第二句。', '段三第三句。'],
    ['段四第一句。', '段四第二句。', '段四第三句。'],
  ])
  // 先发第一句启动 pump，再 burst 其余
  emitSentence({ ...list[0], turnId: 'b2' })
  await sleep(0)
  for (const s of list.slice(1)) emitSentence({ ...s, turnId: 'b2' })
  await waitFor(() => ackTotal() >= list.length, 9000)
  await sleep(400)
  const played = env.playedTexts
  const playedParas = played.map((t) => Number((t.match(/段([零一二三四])/) ?? [])[1] ?? NaN))
  const paraName = { 0: '零', 1: '一', 2: '二', 3: '三', 4: '四' }
  const playedParaIdx = played.map((t) => Object.keys(paraName).find((k) => t.startsWith('段' + paraName[k])))
  // 不变量：某段只要播了，就必须从该段第一句开始播
  const violations = []
  const grouped = new Map()
  for (const text of played) {
    const m = /^段([零一二三四])第(.)句/.exec(text)
    if (!m) continue
    const paraLabel = m[1]
    const sentenceNo = m[2]
    if (!grouped.has(paraLabel)) grouped.set(paraLabel, [])
    grouped.get(paraLabel).push(sentenceNo)
  }
  for (const [paraLabel, numbers] of grouped) {
    if (numbers[0] !== '一') violations.push(`段${paraLabel}从「第${numbers[0]}句」开始播`)
  }
  check('[burst 多段] 不允许从段落中间开始播', violations.length === 0, violations.join('；') + ' played=' + JSON.stringify(played))
  check('[burst 多段] 收到 14 句就 ack 14 次', ackTotal() === list.length, `acks=${ackTotal()}`)
  // 批次 6f：替掉 read-aloud-stop 里那条「trimmed 只统计安全网裁剪，另加 dropped 计数」的
  // 源码判据（五条 `xxxRef.current += ...` 正则）。现在两边都能**分别**跑出来：
  // 这里是安全网真的裁了句 —— 数必须进 trimmed，一格都不许进 dropped。
  const dbgBurst = fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  const trimmedDelta = (Number(dbgBurst.trimmed) || 0) - baseTrimmed
  const droppedDelta = (Number(dbgBurst.dropped) || 0) - baseDropped
  check('[burst 多段] 前置：这一轮安全网确实裁过（否则下一条是空判）',
    trimmedDelta > 0, JSON.stringify({ trimmedDelta, droppedDelta }))
  check('[burst 多段] 安全网裁掉的句数只进 trimmed，不进 dropped（两个数是两回事）',
    trimmedDelta > 0 && droppedDelta === 0, JSON.stringify({ trimmedDelta, droppedDelta }))
  env.audio.playMs = 25
}

/* ------------------------------------------------------------------ */
/* 场景 7b：上一轮的迟到句子（换轮之后才到）→ 不播，但 ack 一次           */
/* ------------------------------------------------------------------ */
async function scenarioLateOldTurn() {
  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'o1' })
  emitSentence({ text: '旧轮第一句。', turnId: 'o1', index: 0, para: 0, paraStart: true })
  await waitFor(() => env.playedTexts.length >= 1, 5000)
  // 换轮
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'o2' })
  emitSentence({ text: '新轮第一句。', turnId: 'o2', index: 0, para: 0, paraStart: true })
  await waitFor(() => env.playedTexts.includes('新轮第一句。'), 5000)
  // 旧轮的迟到句子（index 1，不是首句 → 必须被丢掉）
  emitSentence({ text: '旧轮迟到的一句。', turnId: 'o1', index: 1, para: 0, paraStart: false })
  await sleep(600)
  check('[迟到旧轮] 旧轮迟到句子不播', !env.playedTexts.includes('旧轮迟到的一句。'), JSON.stringify(env.playedTexts))
  check('[迟到旧轮] 旧轮迟到句子也 ack 一次（收到 3 条 → 3 次）', ackTotal() === 3, `acks=${ackTotal()}`)
  // 批次 4d：这一条被丢弃时**本地 ref 已经是新轮**（o2），回执却必须挂在句子自己的 o1 上 ——
  // 记错轮次 = 宿主那一轮的已发未确认数永远减不掉（写法判据钉的就是那两行赋值，
  // 现在数得出账落在哪一轮）。
  const lateByTurn = {}
  for (const a of env.acks) lateByTurn[a.turnId] = (lateByTurn[a.turnId] ?? 0) + (Number(a.count) || 0)
  check('[迟到旧轮] 三条回执按 payload 的轮次记账：旧轮 2 条、新轮 1 条',
    lateByTurn.o1 === 2 && lateByTurn.o2 === 1, JSON.stringify({ lateByTurn, acks: env.acks }))
}

/* ------------------------------------------------------------------ */
/* 场景 7c：漏收 turn-begin（index===0 自愈）→ 整轮仍能播 + ack 恰好一次  */
/* ------------------------------------------------------------------ */
async function scenarioSelfHeal() {
  await settle()
  resetEnv()
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'h1' })
  emitSentence({ text: '自愈前的旧轮。', turnId: 'h1', index: 0, para: 0, paraStart: true })
  await waitFor(() => env.playedTexts.length >= 1, 5000)
  // 宿主漏发/本连接漏收 turn-begin：直接来新轮 index 0
  emitSentence({ text: '新轮无 turn-begin 的第一句。', turnId: 'h2', index: 0, para: 0, paraStart: true })
  emitSentence({ text: '新轮无 turn-begin 的第二句。', turnId: 'h2', index: 1, para: 0, paraStart: false })
  await sleep(1200)
  check('[自愈] 漏收 turn-begin 时新轮仍能播（index===0 自愈）',
    env.playedTexts.includes('新轮无 turn-begin 的第一句。') && env.playedTexts.includes('新轮无 turn-begin 的第二句。'),
    JSON.stringify(env.playedTexts))
  check('[自愈] 收到 3 条 sentence 就 ack 3 次', ackTotal() === 3, `acks=${ackTotal()}`)

  /* ------------------------------------------------------------------
   * 批次 6f 新增：上一轮**还在响**的时候自愈。
   * 替掉的是 read-aloud-stop 里那条扫源码的
   * `currentTurnIdRef.current = turnId … haltSpeaking(true)` 顺序判据。
   * 原来留着的理由是「harness 里自愈发生在两句之间、上一句早已播完，行为上分不出」——
   * 那是当时没构造这个形状：把每句的响时长调长（`playMs`），
   * 自愈的入口在 SSE handler 里、不受播放循环阻塞，
   * 于是完全可以让「上一轮的源还挂着」和「新轮 index 0 到来了」同时成立。
   * 现在判的是三件真能观察到的事：快照里的轮次换成新的、
   * 上一轮那个还在响的源被当场 stop、新轮第一句照旧播得出来。
   * ------------------------------------------------------------------ */
  env.audio.playMs = 1200
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'h3' })
  emitSentence({ text: '自愈前还在响的那句。', turnId: 'h3', index: 0, para: 0, paraStart: true })
  const startedLive = await waitFor(() => env.playSources.some((s) => s._started && !s._finished), 4000)
  const liveOld = env.playSources.filter((s) => s._started && !s._finished)
  const playedBefore = env.playedTexts.length
  check('[自愈] 前置：上一轮这一句真的还在响（否则下面两条是空判）',
    startedLive && liveOld.length === 1,
    JSON.stringify({ startedLive, live: liveOld.length, playSources: dbg().playSources }))
  // 没有 turn-begin，直接来新轮的 index 0 → 走自愈分支
  emitSentence({ text: '自愈时新轮的第一句。', turnId: 'h4', index: 0, para: 0, paraStart: true })
  const adopted = await waitFor(() => dbg().turnId === 'h4', 3000)
  check('[自愈] 采纳新轮次（快照里的 turnId 换成新的）', adopted, JSON.stringify({ turnId: dbg().turnId }))
  check('[自愈] 上一轮还在响的那个源被当场掐掉（少了 haltSpeaking 就是两句同时响）',
    liveOld.length === 1 && liveOld[0].stopRequested === true,
    JSON.stringify({ stopRequested: liveOld[0]?.stopRequested }))
  const newPlayed = await waitFor(() => env.playedTexts.includes('自愈时新轮的第一句。'), 4000)
  check('[自愈] 新轮第一句照常播得出来（自愈没把这一轮卡死）', newPlayed, JSON.stringify(env.playedTexts.slice(playedBefore)))
  await sleep(env.audio.playMs + 400)
  check('[自愈] 这一轮只多出这一句（旧轮的句子没有回来重播）',
    env.playedTexts.length === playedBefore + 1, JSON.stringify(env.playedTexts.slice(playedBefore)))
  env.audio.playMs = 25
}

/* ------------------------------------------------------------------ */
/* 场景 8：拿不到播放上下文 → 清队列 + ack + 不自递归死锁                */
/* ------------------------------------------------------------------ */
async function scenarioNoAudioContext() {
  await settle()
  resetEnv()
  const dbgNa = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  const baseDropped = Number(dbgNa().dropped) || 0
  const baseTrimmed = Number(dbgNa().trimmed) || 0
  env.audio = { mode: 'unavailable', playMs: 25 }
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'na1' })
  const list = makeSentences([['没有音频上下文第一句。', '没有音频上下文第二句。', '没有音频上下文第三句。']])
  emitAll(list, 'na1')
  const acked = await waitFor(() => ackTotal() >= list.length, 5000)
  await sleep(300)
  check('[无 AudioContext] 队列被丢弃且每句 ack 一次（不会卡死）',
    acked && ackTotal() === list.length, `acks=${ackTotal()}`)
  check('[无 AudioContext] 不会无限递归/栈溢出', env.warnings.filter((w) => /Recursion|stack/i.test(w)).length === 0,
    env.warnings.join('\n'))
  // 批次 6f：这是「其它原因丢掉」的那一格 —— 与上面「安全网裁剪」的 trimmed 必须分开。
  // 两条合起来才等价于 read-aloud-stop 里那条五条正则的记账判据，而且各判一边、能分别红。
  check('[无 AudioContext] 清掉的三句记进 dropped，一格都不进 trimmed（那不是宿主流控失效）',
    ((Number(dbgNa().dropped) || 0) - baseDropped) === list.length
      && ((Number(dbgNa().trimmed) || 0) - baseTrimmed) === 0,
    JSON.stringify({
      droppedDelta: (Number(dbgNa().dropped) || 0) - baseDropped,
      trimmedDelta: (Number(dbgNa().trimmed) || 0) - baseTrimmed,
    }))
  // 播放上下文恢复后，后续句子还能播
  env.audio = { mode: 'running', playMs: 25 }
  emitSentence({ text: '恢复后的句子。', turnId: 'na1', index: 3, para: 0, paraStart: false })
  const played = await waitFor(() => env.playedTexts.includes('恢复后的句子。'), 5000)
  check('[无 AudioContext] 后续句子能恢复播放', played, JSON.stringify(env.playedTexts))
}

/* ------------------------------------------------------------------ */
/* 场景 9：播放上下文 suspended 时 halt（换轮）→ 旧句是否仍开始播放       */
/* ------------------------------------------------------------------ */
async function scenarioSuspendedHalt() {
  await settle()
  resetEnv()
  env.audio = { mode: 'starts-suspended', playMs: 25, suspendUntil: Date.now() + 600, debug: !!process.env.HARNESS_DEBUG, t0: Date.now() }
  emit('turn-begin', { sessionId: 'sess-1', turnId: 's1' })
  emitSentence({ text: '等待播放上下文恢复的这一句。', turnId: 's1', index: 0, para: 0, paraStart: true })
  // 让它进入 play() 的 resume 轮询
  await sleep(150)
  const beforeHalt = env.playedTexts.length
  // 用户发新消息 / 打断 → turn-begin → haltSpeaking（gen++）
  emit('turn-begin', { sessionId: 'sess-1', turnId: 's2' })
  await sleep(1200) // 等 resume 轮询结束
  if (process.env.HARNESS_DEBUG) {
    console.log('DEBUG suspendedHalt played=', env.playedTexts, 'beforeHalt=', beforeHalt, 'audioState=', env.audio.ctx?.state)
    console.log('DEBUG suspendedHalt dbg=', fakeWindow.__DSH_VOICE_DEBUG__?.())
    console.log('DEBUG suspendedHalt warnings=', env.warnings)
  }
  check('[suspended+halt] 被 halt 的旧句不应再开始播放',
    env.playedTexts.length === beforeHalt,
    `halt 后又播放了：${JSON.stringify(env.playedTexts.slice(beforeHalt))}`)
}

/* ------------------------------------------------------------------ */
/* 场景 10b：合成成功但解码失败 / 老宿主不给 index                       */
/* ------------------------------------------------------------------ */
/**
 * 替掉的是 read-aloud-stop 里两条扫源码的判据：
 *   - `finally { ... URL.revokeObjectURL(url) }`（「object URL 在 finally 里释放」）；
 *   - `turnSentenceSeqRef.current += 1` + `Number.isInteger(payload?.index)`
 *     （「宿主不给 index 时本地补序号」）。
 *
 * 第一段走的是真机上很常见的一种「没声音」：`/tts` 返回 200 + 正常音频，
 * 但 `decodeAudioData` 抛错（蓝牙耳机、采样率协商不上、格式不支持）。
 * 这里同时数得出来「建了几个 Blob、撤了几个 Blob」——泄漏一个就红。
 *
 * 第二段走的是老宿主：`sentence` 事件里没有 `index`。客户端自己补号，
 * 补不上就会全部撞在同一个去重键 `turnId:undefined` 上，
 * 表现是「一轮只念第一句」——正好是这条缺陷的原始症状。
 */
async function scenarioDecodeFailureAndLegacyIndex() {
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}

  await settle()
  resetEnv()
  const failuresBefore = dbg().ttsFailures ?? 0
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'df1' })
  // 「解不开」那一句：合成照常成功（会建一个 Blob URL），解码抛 NotSupportedError。
  env.audio = { mode: 'running', playMs: 25, decodeThrowsText: '解不开' }
  emitSentence({ text: '正常的前一句。', turnId: 'df1', index: 0, para: 0, paraStart: true })
  emitSentence({ text: '解不开的这一句。', turnId: 'df1', index: 1, para: 0, paraStart: false })
  emitSentence({ text: '正常的后一句。', turnId: 'df1', index: 2, para: 0, paraStart: false })
  const ackedThree = await waitFor(() => ackTotal() >= 3, 8000)
  await sleep(150)
  check('[解码失败] 三句各 ack 一次（失败句也不能让宿主等 watchdog）',
    ackedThree && ackTotal() === 3, `acks=${ackTotal()}`)
  check('[解码失败] 解不开的那句被跳过、前后照播（管道没被它卡死）',
    env.playedTexts.join('|') === '正常的前一句。|正常的后一句。', JSON.stringify(env.playedTexts))
  check('[解码失败] 计入 ttsFailures（只记「跳过」查不到原因）',
    (dbg().ttsFailures ?? 0) > failuresBefore, `${failuresBefore} → ${dbg().ttsFailures}`)
  const leaked = env.objectUrlsCreated.filter((id) => objectUrls.has(id))
  check('[解码失败] 建过的音频 Blob 全部释放（失败句不泄漏）',
    env.objectUrlsCreated.length >= 3 && leaked.length === 0,
    `建了 ${env.objectUrlsCreated.length} 个，还剩 ${leaked.length} 个没撤`)
  check('[解码失败] 异常没有甩进 effect / handler', env.warnings.length === 0, env.warnings.join('\n'))

  await settle()
  resetEnv()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'lg1' })
  // 7 句 = 待在待播上限（8）以内：安全网不该插手，这样「漏播」只能是被当成重复丢掉的。
  // （试跑时先给 10 句，第 2 句被安全网裁掉了 —— 老宿主连 para 都不给，
  // 每句各成一段，只有含首句那段和最新那段受保护。那是另一件事，记在 §8.34。）
  const legacy = []
  for (let i = 0; i < 7; i++) legacy.push(`老宿主第${i + 1}句，没有 index。`)
  // 一个 index / para 都不给 = 协议 v2 之前的宿主。
  for (const text of legacy) emitSentence({ text, turnId: 'lg1' })
  const ackedAll = await waitFor(() => ackTotal() >= legacy.length, 8000)
  await sleep(150)
  check('[老宿主无 index] 收到 7 句就 ack 7 句',
    ackedAll && ackTotal() === legacy.length, `acks=${ackTotal()}`)
  check('[老宿主无 index] 7 句全部播出（补号让去重键不撞车）',
    env.playedTexts.length === legacy.length && new Set(env.playedTexts).size === legacy.length,
    `播了 ${env.playedTexts.length} 句：${JSON.stringify(env.playedTexts.slice(0, 3))}`)
  check('[老宿主无 index] 播出顺序就是到达顺序，首句没丢',
    env.playedTexts[0] === legacy[0], JSON.stringify(env.playedTexts.slice(0, 2)))
}

/* ------------------------------------------------------------------ */
/* 场景 11：窗口内快捷键（第 4 步 4.3）                                  */
/* ------------------------------------------------------------------ */
/**
 * 判据本身住在 `src/client/pure/shortcut.js`（test/shortcut.test.mjs 直测），
 * 这里要证明的是**那条链路真的接在产物上**：
 *   组件挂载 → window keydown 监听装着 → 「正在录键」状态能挡住它 →
 *   命中时 preventDefault → 卸载后状态复位、重新挂载还能用。
 *
 * 这一场景替掉的是 config-ui 里那条
 * `/shortcutFieldFocused = false }, []/` 的源码正则 —— 它只能证明「代码写了」，
 * 证明不了「卸载时真被调用」，也证明不了监听确实装了。
 */
async function scenarioComposerShortcut() {
  await settle()
  resetEnv()
  const focus = exportsObj.__test.shortcutFocus
  focus.releaseAll()
  // 从一次干净的挂载开始：先卸载（跑掉历史场景留下的监听）再重新挂。
  runtime.unmount()
  bootMic()
  await sleep(300) // 等挂载后的配置拉取，configRef 里要有 shortcut
  check('[快捷键] 挂载后 window 上确实有 keydown 监听',
    (windowAddListeners.get('keydown') ?? new Set()).size > 0)

  const hit = dispatchKey({ key: 'v', altKey: true })
  check('[快捷键] Alt+V 命中并拦下默认行为', hit.prevented === true)
  check('[快捷键] 命中后没有把异常甩进 handler',
    env.warnings.filter((w) => /keydown/.test(w)).length === 0, env.warnings.join('\n'))
  check('[快捷键] 主键不对时不拦',
    dispatchKey({ key: 'x', altKey: true }).prevented === false)
  check('[快捷键] 多按一个 Ctrl 不算命中 Alt+V（两个语音入口不许一起触发）',
    dispatchKey({ key: 'v', ctrlKey: true, altKey: true }).prevented === false)

  focus.focus('composer')
  check('[快捷键] 正在录 composer 快捷键时不触发录音',
    dispatchKey({ key: 'v', altKey: true }).prevented === false)
  focus.blur('composer')
  check('[快捷键] 交出焦点后同一串键恢复触发（监听一直没拆）',
    dispatchKey({ key: 'v', altKey: true }).prevented === true)
  focus.focus('global')
  check('[快捷键] 正在录「全局语音快捷键」时 composer 的 Alt+V 照旧（两套设置互不牵扯）',
    dispatchKey({ key: 'v', altKey: true }).prevented === true)
  focus.releaseAll()

  runtime.unmount()
  bootMic()
  await sleep(300)
  check('[快捷键] 重新挂载后快捷键仍然可用（面板开关一次不会弄死热键）',
    dispatchKey({ key: 'v', altKey: true }).prevented === true)
  focus.releaseAll()

  /* ---- 后半段：设置面板那两个输入框与卸载复位（审计 F14） ---- */
  // 聚焦标志的写入方是**面板**，MicButton 里没有这两个 handler，
  // 所以「卸载时复位」只能在真挂起面板的场景里证明。
  check('[快捷键] 设置面板组件注册可得（后半段的前提）', Boolean(SettingsSection),
    'settings.section 没注册 —— 后半段的断言就没有对象了')
  if (!SettingsSection) { focus.releaseAll(); return }
  runtime.mount(SettingsSection, { t: (k) => k })
  await sleep(300)
  const tree = runtime.getTree()
  const composerField = findByProp(tree, (node) => node.props?.placeholder === 'Alt+V'
    && typeof node.props?.onFocus === 'function')
  const globalField = findByProp(tree, (node) => node.props?.placeholder === 'Ctrl+Alt+V'
    && typeof node.props?.onFocus === 'function')
  check('[快捷键] 面板里挂得出那两个快捷键输入框', Boolean(composerField && globalField),
    '找不到 placeholder 为 Alt+V / Ctrl+Alt+V 且带 onFocus 的元素 —— 面板结构变了')
  if (composerField && globalField) {
    composerField.props.onFocus()
    check('[快捷键] 输入框拿到焦点 → 状态记的是 composer',
      focus.isFocused('composer') === true && focus.isFocused('global') === false)
    globalField.props.onFocus()
    check('[快捷键] 两个框都在录 → anyFocused 为真（两条监听都该停）',
      focus.anyFocused() === true && focus.fields().length === 2)
    composerField.props.onBlur()
    check('[快捷键] 交出焦点只清自己那一项',
      focus.isFocused('composer') === false && focus.isFocused('global') === true)
    globalField.props.onBlur()
    check('[快捷键] 两个框都交出焦点后回到空闲', focus.anyFocused() === false)
    // 关键一条：卸载时不触发 blur（真实 React 就是这个顺序），标志必须被 cleanup 清掉。
    focus.focus('composer')
    focus.focus('global')
    runtime.unmount()
    check('[快捷键] 面板卸载后「正在录键」状态被复位（不靠 blur 兜底，审计 F14）',
      focus.anyFocused() === false, JSON.stringify(focus.fields()))
  }
  focus.releaseAll()

  /* ---- 第三段：全局浮层那条监听看的是 anyFocused()，不是 isFocused() ---- */
  // composer 的监听只挡自己那个输入框，浮层的监听两个框都挡 ——
  // 这个区别全靠 `anyFocused()`，所以必须有一条断言真的经过浮层那条链路。
  const Overlay = registrations.find((r) => r.options?.id === 'dsh-voice-typing-global')?.component
  check('[快捷键] 全局浮层组件注册可得（第三段的前提）', Boolean(Overlay),
    'shell.overlay 没注册上 —— 后半段的断言没有对象')
  if (Overlay) {
    const before = (windowAddListeners.get('keydown') ?? new Set()).size
    env.config.globalVoice = true
    env.config.globalShortcut = 'Ctrl+Alt+V'
    runtime.mount(Overlay, { t: (k) => k })
    // 浮层要先把 GET /config 的结果落进 configRef（globalVoice 不为真时它压根不认这条热键），
    // 所以这里重试到「命中」为止：先证明它认，后面的「被挡住」才有意义。
    const combo = { key: 'v', ctrlKey: true, altKey: true }
    const hitOverlay = await waitFor(() => dispatchKey(combo).prevented === true, 4000, 100)
    check('[快捷键] 浮层挂载后多出一条 keydown 监听',
      (windowAddListeners.get('keydown') ?? new Set()).size > before)
    check('[快捷键] Ctrl+Alt+V 命中浮层的开麦键', hitOverlay)
    focus.focus('composer')
    check('[快捷键] 只聚焦 composer 也挡得住浮层（用的是 anyFocused 而不是 isFocused）',
      dispatchKey(combo).prevented === false)
    focus.blur('composer')
    check('[快捷键] 焦点交回去之后浮层照旧命中', dispatchKey(combo).prevented === true)
    runtime.unmount()
    env.config.globalVoice = false
    delete env.config.globalShortcut
  }
  focus.releaseAll()
}

/* ------------------------------------------------------------------ */
/* 场景 12：开麦的时序与就绪判据（第 4 步 4.4b）                         */
/* ------------------------------------------------------------------ */
/** 输入框旁边那只麦克风按钮 = composer 的唯一开麦入口。 */
function micButton() {
  return findByProp(runtime.getTree(), (node) => node.props?.type === 'button'
    && typeof node.props?.onContextMenu === 'function')
}

/**
 * 状态行那只 span（短词 + 悬停长说明）。
 *
 * 认它的依据是「带 minWidth 的 span」——那正是「换状态时宽度不变」这条装机契约的
 * 渲染产物；`props.children` 是用户看到的文本，`props.title` 是悬停才出现的长说明。
 * 「状态行不要跳出长文案」的老判据原来钉 `setHint(t('...'))` 的写法，现在判这两个字段。
 */
function statusSpan() {
  return findByProp(runtime.getTree(), (node) => node?.type === 'span'
    && typeof node?.props?.style?.minWidth === 'number')
}

/**
 * 这一场景替掉的是 `test/listening-ready.test.mjs` 里四条「扫源码形状」的断言
 * （「startMic 里有没有 `getAudioTracks()[0]` 那一行」之类）。
 * 它们要守的事实本来就和行号、变量名无关：
 *   1. 确认模型必须排在取流之前 —— 先开麦会把你说的话整句丢掉；
 *   2. 轨道不可用（空 / ended）不得进聆听态，且要把流释放掉；
 *   3. 任何一条失败分支都得复位「正在开麦」，否则界面卡在准备中。
 * 现在这些由真产物在假设备上跑出来。
 */
async function scenarioMicReady() {
  await settle()
  resetEnv()
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  runtime.unmount()
  bootMic()
  await sleep(300)

  check('[开麦] 找得到那只麦克风按钮（本场景的入口）', typeof micButton()?.props?.onClick === 'function')
  if (typeof micButton()?.props?.onClick !== 'function') return

  /* ---- 一、一切正常：先确认模型，再取流，就绪后才进聆听态 ---- */
  setMicMode('ok')
  micButton().props.onClick()
  const opened = await waitFor(() => dbg().on === true, 4000)
  check('[开麦] 模型就绪 + 轨道可用 → 进入聆听态', opened, JSON.stringify(dbg()))
  const order = env.mic.order
  check('[开麦] 确认模型排在取流**之前**（先开麦会把你说的话整句丢掉）',
    order.indexOf('asr-ready') >= 0 && order.indexOf('getUserMedia') > order.indexOf('asr-ready'),
    JSON.stringify(order))
  check('[开麦] 取流用的就是设备层那一份约束对象（两个入口不再各写一遍）',
    env.mic.lastConstraints === exportsObj.__test.micDevice.captureConstraints())
  check('[开麦] 约束是单声道 + 16k（和服务端契约一致）',
    env.mic.lastConstraints?.audio?.channelCount === 1 && env.mic.lastConstraints?.audio?.sampleRate === 16000,
    JSON.stringify(env.mic.lastConstraints))
  check('[开麦] 进聆听态时轨道还没被释放', env.mic.streams[0]?.tracks[0]?.stops === 0)
  check('[开麦] 音频图确实搭起来了（source / processor / analyser 各一个）',
    env.mic.sources.length === 1 && env.mic.processors.length === 1 && env.mic.analysers.length === 1,
    JSON.stringify({ s: env.mic.sources.length, p: env.mic.processors.length, a: env.mic.analysers.length }))
  micButton().props.onClick()
  const closed = await waitFor(() => dbg().on === false, 2000)
  check('[开麦] 再点一次退出聆听态', closed)
  check('[开麦] 关麦把轨道停了（不停就是麦克风一直亮着）', (env.mic.streams[0]?.tracks[0]?.stops ?? 0) >= 1)

  /* ---- 二·补、模型还在加载的那几百毫秒：状态行显示「准备中」 ---- */
  resetEnv()
  env.model = { ready: false, delayMs: 400 }
  setMicMode('ok')
  micButton().props.onClick()
  const preparing = await waitFor(() => dbg().starting === true, 1000)
  check('[开麦·等模型] 点下按钮立刻置「正在开麦」（老判据钉的是 `startingRef.current = true` 那行写法）',
    preparing, JSON.stringify(dbg()))
  check('[开麦·等模型] 这段时间状态行是「准备中」短词，不是「聆听中」',
    statusSpan()?.props?.children === 'modelLoading',
    JSON.stringify({ text: statusSpan()?.props?.children, on: dbg().on }))
  check('[开麦·等模型] 等待期间没进聆听态', dbg().on === false)
  // 这一句**必须等**：延迟期间如果改走下一个子场景，resetEnv 会把 model.ready 翻回 true，
  // 上一条还没跑完的 startMic 就会带着「就绪」的答复继续开麦、留下一个没人知道的音频图，
  // 把后面的场景全污染掉（本轮第一次踩到就是这个原因，浮层那条场景平白多出一个 ScriptProcessor）。
  const waitedOut = await waitFor(() => dbg().starting === false, 3000)
  check('[开麦·等模型] 确认回来是「没就绪」才收场：没卡准备中、也没偷偷去取流',
    waitedOut && dbg().on === false && env.mic.gumCalls === 0,
    JSON.stringify({ starting: dbg().starting, on: dbg().on, gum: env.mic.gumCalls }))

  /* ---- 二、模型没就绪：一个采样都不该去取 ---- */
  // 这里故意让替身回一句**词表外的中文**（旧宿主 / 版本不一致的形状）：
  // 客户端拿到不认识的码就当「没就绪且说不清」，界面那句必须走兜底，宿主的原文一个字都不许进界面。
  // 批次 18（docs §8.60）之前这条判据是反的 —— 它钉的是「悬停用的就是宿主给的那句话」，
  // 于是英文界面开麦失败会弹中文提示。
  resetEnv()
  env.model = { ready: false, reason: '测试原因：模型没在这台机器上加载好' }
  setMicMode('ok')
  micButton().props.onClick()
  const modelSettled = await waitFor(() => dbg().starting === false, 3000)
  check('[开麦·模型没就绪] 不进聆听态', dbg().on === false, JSON.stringify(dbg()))
  check('[开麦·模型没就绪] 根本没去取麦克风流（第一条判据的反面）', env.mic.gumCalls === 0, `gum=${env.mic.gumCalls}`)
  check('[开麦·模型没就绪] 「正在开麦」被复位（不卡在准备中）', modelSettled && dbg().starting === false)
  check('[开麦·模型没就绪] 状态行只剩短词「模型加载失败」（长说明会把整行挤开）',
    statusSpan()?.props?.children === 'modelFailed',
    JSON.stringify(statusSpan()?.props))
  // 挂载时 `t` 是恒等函数（见本文件的挂载处），所以「那句文案」就是它的 i18n **键名**：
  // 键名出现在悬停上，说明界面显示的是客户端字典里的东西。
  check('[开麦·模型没就绪] 悬停那句是客户端的兜底文案（宿主回的句子不进界面）',
    statusSpan()?.props?.title === 'modelFailedDetail',
    JSON.stringify(statusSpan()?.props?.title))
  check('[开麦·模型没就绪] 宿主那句原文确实被挡在界面外（悬停里不含它）',
    !String(statusSpan()?.props?.title ?? '').includes('测试原因'),
    JSON.stringify(statusSpan()?.props?.title))
  check('[开麦·模型没就绪] 原始原因仍留在调试快照里（界面不显示，排查读得到）',
    dbg().lastAsrReadyReason === '测试原因：模型没在这台机器上加载好',
    JSON.stringify(dbg().lastAsrReadyReason))

  /* ---- 二·补、四个原因码逐个真跑：每个码该翻成哪句 ---- */
  // 走 /asr-warmup 那条路（替身把 `env.model.reason` 原样回出来），
  // 把 `src/shared/asr-readiness.js` 的四个码都驱动一遍：
  // 词表里漏一个码 = 装机上那句变成生硬的兜底文案，这条判据现在看得见。
  for (const [code, expectKey] of [
    [ASR_READY_REASONS.MODEL_NOT_FOUND, 'modelNotFoundDetail'],
    [ASR_READY_REASONS.NOT_DOWNLOADED, 'modelNotDownloadedDetail'],
    [ASR_READY_REASONS.LOADING, 'modelLoadingDetail'],
    [ASR_READY_REASONS.LOAD_FAILED, 'modelFailedDetail'],
  ]) {
    resetEnv()
    env.model = { ready: false, reason: code }
    setMicMode('ok')
    micButton().props.onClick()
    const settled = await waitFor(() => dbg().starting === false, 3000)
    check(`[开麦·原因码 ${code}] 没就绪就是没就绪：不进聆听态、标志复位`,
      settled && dbg().on === false, JSON.stringify(dbg()))
    check(`[开麦·原因码 ${code}] 悬停那句翻成 i18n 的「${expectKey}」`,
      statusSpan()?.props?.title === expectKey,
      JSON.stringify({ title: statusSpan()?.props?.title, 快照: dbg().lastAsrReadyReason }))
  }

  /* ---- 二·补·二、压根没下载：这一步就该收场，别去预热 ---- */
  resetEnv()
  env.model = { ready: false, downloaded: false }
  setMicMode('ok')
  micButton().props.onClick()
  const notDownloaded = await waitFor(() => dbg().starting === false, 3000)
  check('[开麦·没下载] 不进聆听态、没取流',
    notDownloaded && dbg().on === false && env.mic.gumCalls === 0,
    JSON.stringify({ on: dbg().on, gum: env.mic.gumCalls }))
  check('[开麦·没下载] 没调 /asr-warmup（文件都没下好，预热带不动，白等一轮）',
    !env.mic.order.includes('asr-warmup'), JSON.stringify(env.mic.order))
  check('[开麦·没下载] 悬停是「还没下载」那句，不是「加载失败」那句',
    statusSpan()?.props?.title === 'modelNotDownloadedDetail',
    JSON.stringify(statusSpan()?.props?.title))

  /* ---- 三、权限被拒 ---- */
  resetEnv()
  setMicMode('denied')
  micButton().props.onClick()
  const deniedSettled = await waitFor(() => dbg().starting === false, 3000)
  check('[开麦·被拒绝] 不进聆听态', dbg().on === false)
  check('[开麦·被拒绝] 标志复位（按钮不该显示「语音对话中」）', deniedSettled && dbg().starting === false)

  /* ---- 四、空轨道：有流 ≠ 有声音 ---- */
  resetEnv()
  setMicMode('empty-track')
  micButton().props.onClick()
  const emptySettled = await waitFor(() => dbg().starting === false, 3000)
  check('[开麦·空轨道] 不进聆听态（搬动前靠扫源码那一行守着，现在是真的跑出来的）',
    dbg().on === false, JSON.stringify(dbg()))
  check('[开麦·空轨道] 标志复位', emptySettled && dbg().starting === false)

  /* ---- 五、ended 轨道：还要把流释放掉 ---- */
  resetEnv()
  setMicMode('ended-track')
  micButton().props.onClick()
  const endedSettled = await waitFor(() => dbg().starting === false, 3000)
  check('[开麦·轨道已结束] 不进聆听态', dbg().on === false)
  check('[开麦·轨道已结束] 拿到的流被释放（不释放就是麦克风一直亮）',
    endedSettled && (env.mic.streams[0]?.tracks[0]?.stops ?? 0) >= 1)

  /* ---- 六、没有录音设备：这条分支搬动前漏了复位「正在开麦」 ---- */
  resetEnv()
  setMicMode('no-device')
  micButton().props.onClick()
  const noDeviceSettled = await waitFor(() => dbg().starting === false, 3000)
  check('[开麦·没有设备] 不进聆听态', dbg().on === false)
  check('[开麦·没有设备] 「正在开麦」被复位（旧写法卡在准备中，再点变成「取消」）',
    noDeviceSettled && dbg().starting === false)

  /* ---- 七、拿不到 AudioContext：本轮补的守卫 ---- */
  resetEnv()
  setMicMode('ok')
  const savedCtor = { ac: fakeWindow.AudioContext, wk: fakeWindow.webkitAudioContext }
  fakeWindow.AudioContext = undefined
  fakeWindow.webkitAudioContext = undefined
  micButton().props.onClick()
  const ctxSettled = await waitFor(() => dbg().starting === false, 3000)
  check('[开麦·无 AudioContext] 不进聆听态（旧写法在这里 new undefined() 抛 TypeError，整条链路从 try 外逃出去）',
    dbg().on === false, JSON.stringify(dbg()))
  check('[开麦·无 AudioContext] 「正在开麦」被复位（浮层那条一直有这道守卫，composer 没有）',
    ctxSettled && dbg().starting === false)
  check('[开麦·无 AudioContext] 已经拿到的轨道被释放',
    (env.mic.streams[0]?.tracks[0]?.stops ?? 0) >= 1)
  fakeWindow.AudioContext = savedCtor.ac
  fakeWindow.webkitAudioContext = savedCtor.wk
  micButton().props.onClick()
  const recovered = await waitFor(() => dbg().on === true, 4000)
  check('[开麦·无 AudioContext] 恢复之后同一只按钮还能开麦（不是只能刷新界面）', recovered, JSON.stringify(dbg()))
  micButton().props.onClick()
  await waitFor(() => dbg().on === false, 2000)

  check('[开麦] 整个过程没有异常甩进 effect / handler',
    env.warnings.length === 0, env.warnings.join('\n'))
  setMicMode('no-device')
}

/* ------------------------------------------------------------------ */
/* 场景 13：浮层的两条采集路径（第 6.6 步装机回归补的行为化，任务 #36）   */
/* ------------------------------------------------------------------ */
/**
 * 浮层开麦有两条路：首选 AudioWorklet VAD（窗口在后台也不被定时器节流），
 * 回退 ScriptProcessor。§8.32 装机那一轮挖出的三个洞正好都住在这一带：
 *   1. 漏 import `DEFAULT_VAD_OPTIONS` → 两条路各自在自己的 `try` 里抛、各自 return false，
 *      而旧写法写完 `if (!workletOk) startScriptProcessorVad(...)` 就不看返回值了，
 *      于是照样进「聆听中」—— 麦克风亮着、一个采样都不进；
 *   2. 失败分支没把 `GLOBAL_MIC_ON_EVENT` 收回 → composer 那只按钮卡在「让位」状态；
 *   3. 这一带当时**没有一条执行侧断言**（只有源码正则），所以那三个洞三道防线全绿。
 *
 * 这里把它变成执行断言：假 AudioContext 按真实判据长（`audioWorklet` 可有可无、
 * `addModule` 可拒、`createScriptProcessor` 的 bufferSize 非法就抛 NotSupportedError），
 * 再按四档环境各驱动一次，断言「进没进聆听态 / 图上挂了哪些节点 /
 * processorOptions 里那些数是不是主线程换算对的 / 失败时提示·释放·收回齐不齐」。
 *
 * 不在这里验的：VAD 的分段判据本身（`advanceVad` 的 start/end/forced）由
 * test/global-voice.test.mjs 直测纯函数；这里喂的每一帧都是静音，
 * 只求「回调真被装上、喂一帧不炸、不误触发识别」。
 *
 * 这些断言不是「恰好为真」：把四个缺陷逐个塞回源码验过 ——
 * 删 `DEFAULT_VAD_OPTIONS` 的 import → 19 条红；回退写成不看返回值 → 「双失败」8 条红；
 * 量子写成 128 → 8 条红；关麦不发 `GLOBAL_MIC_OFF_EVENT` → 2 条红。
 * 过程与还原校验记在 docs/architecture-modernization.md §8.32b。
 */
async function scenarioOverlayCapture() {
  await settle()
  resetEnv()
  const Overlay = registrations.find((r) => r.options?.id === 'dsh-voice-typing-global')?.component
  const gdbg = () => fakeWindow.__DSH_VOICE_GLOBAL_DEBUG__?.() ?? {}

  /**
   * 最近一次「采集路径」上报的核对结果。
   *
   * 三件事必须同时成立（批次 10，任务 #38）：
   *   ① kind 是 capture-path（这条通道也走语音发送尝试的上报，不能混着算）；
   * ② path/reason 说的是**这次真的用上**的那条路，reason 由 `reasonOk` 判；
   *   ③ 请求体里**没有** sessionId 键 —— 宿主只要看到这个自有属性就会改 `voiceSession`，
   *      带空串等于把用户当前会话清掉，纯诊断上报绝不能碰它。
   *
   * @param {string} path - 期望的采集路径（`GLOBAL_CAPTURE_PATHS` 的成员）。
   * @param {(reason: string) => boolean} [reasonOk] - 回退原因的判法，默认不要求内容。
   */
  const captureReportedAs = (path, reasonOk = () => true) => {
    const row = lastCaptureRow()
    const client = row?.client ?? null
    return {
      ok: Boolean(client)
        && client.path === path
        && reasonOk(String(client.reason ?? ''))
        && !Object.prototype.hasOwnProperty.call(row, 'sessionId'),
      detail: JSON.stringify(row),
    }
  }

  /** 最近一条采集路径上报的原始体（判 `at` 之类附加字段用）。 */
  const lastCaptureRow = () => env.clientReports.filter((r) => r?.client?.kind === 'capture-path').pop() ?? null
  const combo = { key: 'v', ctrlKey: true, altKey: true }
  check('[浮层采集] 全局浮层组件注册可得（本场景的前提）', Boolean(Overlay), 'shell.overlay 没注册上')
  if (!Overlay) return
  env.config.globalVoice = true
  env.config.globalShortcut = 'Ctrl+Alt+V'

  /** 挂一个全新的浮层实例并按一次快捷键 —— 返回「这串键有没有被认下来」。 */
  const mountAndPress = async () => {
    runtime.unmount()
    runtime.mount(Overlay, { t: (k) => k })
    return waitFor(() => dispatchKey(combo).prevented === true, 4000, 100)
  }

  /* ---- 一、首选路径：AudioWorklet VAD 搭起来，且不偷偷回退 ---- */
  resetEnv()
  setMicMode('ok')
  env.worklet.available = true
  check('[浮层采集·Worklet] Ctrl+Alt+V 被浮层认下来（本场景的入口）', await mountAndPress())
  const workletListening = await waitFor(() => gdbg().listening === true, 4000, 50)
  check('[浮层采集·Worklet] 进入聆听态', workletListening, JSON.stringify(gdbg()))
  check('[浮层采集·Worklet] 注入了一次 worklet 模块', env.worklet.modules.length === 1,
    `modules=${env.worklet.modules.length}`)
  const injected = env.worklet.modules[0]?.text ?? ''
  check('[浮层采集·Worklet] 注入的是真 VAD 状态机源码（按处理器名 registerProcessor + 同一套 advanceVad）',
    injected.includes(`registerProcessor("${GLOBAL_VAD_PROCESSOR}"`) && injected.includes('advanceVad'),
    `len=${injected.length}`)
  check('[浮层采集·Worklet] Blob URL 用完就撤（finally 里那句 revokeObjectURL）',
    env.worklet.modules[0] ? objectUrls.has(env.worklet.modules[0].url) === false : false)
  const vadNode = env.worklet.nodes[0]
  check('[浮层采集·Worklet] 恰好一个 AudioWorkletNode，**没有**悄悄退回 ScriptProcessor（洞 1 的界面表现）',
    env.worklet.nodes.length === 1 && env.mic.processors.length === 0,
    JSON.stringify({ nodes: env.worklet.nodes.length, sp: env.mic.processors.length }))
  check('[浮层采集·Worklet] 处理器名 / 单声道 / 一进一出',
    vadNode?.name === GLOBAL_VAD_PROCESSOR && vadNode?.options?.channelCount === 1
    && vadNode?.options?.numberOfInputs === 1 && vadNode?.options?.numberOfOutputs === 1,
    JSON.stringify({ n: vadNode?.name, o: vadNode?.options }))
  const po = vadNode?.processorOptions ?? {}
  check('[浮层采集·Worklet] DEFAULT_VAD_OPTIONS 整组展开到位（漏 import 时这一串全是 undefined）',
    po.threshold === 0.012 && po.minGate === 0.008 && po.maxGate === 0.035
    && po.multiplier === 2.5 && po.offset === 0.003 && po.startFrames === 3, JSON.stringify(po))
  check('[浮层采集·Worklet] 毫秒→帧是在主线程换算过的（1500ms@48k/128 → 563，不是那份默认的 40）',
    po.silenceFrames === 563 && po.maxFrames === 11250,
    JSON.stringify({ silenceFrames: po.silenceFrames, maxFrames: po.maxFrames }))
  // 预录环同样必须按**当前上下文的采样率**在主线程换算：Worklet 每帧只有 128 采样，
  // 直接把 startFrames(3) 当环长 = 8ms，开口判定滞后半秒级，轻声的第一个字整段丢掉
  //（docs §8.33 那条 wake-miss）。
  check('[浮层采集·Worklet] 预录环按毫秒换算（600ms@48k/128 → 225 帧），不是 startFrames 那 3 帧',
    po.preRollFrames === 225, JSON.stringify({ preRollFrames: po.preRollFrames, startFrames: po.startFrames }))
  check('[浮层采集·Worklet] 麦克风源接进了处理器，分段回调装着',
    (env.mic.sources[0]?.connected ?? []).includes(vadNode) && typeof vadNode?.port?.onmessage === 'function',
    JSON.stringify(env.mic.sources[0]?.connected ?? []))
  const vadSink = vadNode?.connected?.[0]
  check('[浮层采集·Worklet] 输出经 0 增益落到 destination（不接住输出，部分内核就不再调度 process()）',
    vadSink?.gain?.value === 0 && (vadSink?.connected ?? []).some((t) => t?.name === 'destination'),
    JSON.stringify({ gain: vadSink?.gain?.value, to: (vadSink?.connected ?? []).map((t) => t?.name ?? 'node') }))
  check('[浮层采集·Worklet] 界面显示的是聆听态文案', treeHasText(runtime.getTree(), 'globalListening'),
    '树上找不到 globalListening')
  check('[浮层采集·Worklet] composer 的让位信号发出去了', env.winEvents.includes(GLOBAL_MIC_ON_EVENT),
    JSON.stringify(env.winEvents))
  const workletCapture = gdbg().capture ?? {}
  check('[浮层采集·Worklet] 快照里记的是首选路径，回退原因为空（没用上回退就不该有原因）',
    workletCapture.path === GLOBAL_CAPTURE_PATHS.worklet && workletCapture.reason === '',
    JSON.stringify(workletCapture))
  const workletReported = captureReportedAs(GLOBAL_CAPTURE_PATHS.worklet, (r) => r === '')
  check('[浮层采集·Worklet] 首选路径也上报到宿主通道，且不带 sessionId 键（纯诊断，不改会话）',
    workletReported.ok, workletReported.detail)
  check('[浮层采集·Worklet] 上报的时刻带得上（宿主能排时序）',
    Number(lastCaptureRow()?.client?.at) > 0, JSON.stringify(lastCaptureRow()))
  check('[浮层采集·Worklet] 没有异常甩进 effect / handler', env.warnings.length === 0, env.warnings.join('\n'))

  /* ---- 二、addModule 被拒（CSP / 内核不支持 blob）：回退必须真的顶上 ---- */
  resetEnv()
  setMicMode('ok')
  env.worklet.available = true
  env.worklet.addModuleThrows = true
  check('[浮层采集·回退] Ctrl+Alt+V 被认下来', await mountAndPress())
  const fbListening = await waitFor(() => gdbg().listening === true, 4000, 50)
  check('[浮层采集·回退] 首选路径失败后仍进聆听态（回退确实接上了）', fbListening, JSON.stringify(gdbg()))
  check('[浮层采集·回退] 一个 worklet 节点都没建（addModule 之前就断了）', env.worklet.nodes.length === 0)
  const sp = env.mic.processors[0]
  check('[浮层采集·回退] 恰好一个 ScriptProcessor，量子 4096 / 单进单出（帧数换算要带上这个量子）',
    env.mic.processors.length === 1 && sp?.bufferSize === 4096
    && sp?.inputChannels === 1 && sp?.outputChannels === 1,
    JSON.stringify({ n: env.mic.processors.length, sp: sp && { b: sp.bufferSize, i: sp.inputChannels, o: sp.outputChannels } }))
  check('[浮层采集·回退] 源接进 ScriptProcessor，输出同样经 0 增益落地',
    (env.mic.sources[0]?.connected ?? []).includes(sp) && sp?.connected?.[0]?.gain?.value === 0
    && (sp?.connected?.[0]?.connected ?? []).some((t) => t?.name === 'destination'),
    JSON.stringify(env.mic.sources[0]?.connected ?? []))
  let frameError = null
  const fetchBefore = env.fetchLog.length
  try {
    sp?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } })
  } catch (error) {
    frameError = error
  }
  check('[浮层采集·回退] 喂一帧静音不抛（装上去的是真回调，不是空函数）',
    typeof sp?.onaudioprocess === 'function' && frameError === null, frameError?.stack)
  check('[浮层采集·回退] 静音不会被误切成一段送去识别',
    env.fetchLog.slice(fetchBefore).every((f) => !String(f.url).includes('/transcribe')),
    JSON.stringify(env.fetchLog.slice(fetchBefore)))
  // 回退路径的预录环同样得按毫秒算。这里一帧 4096 采样（85.3ms）：
  // 600ms → 7 帧；要是沿用 startFrames(3) 当环长，段首就只有 256ms，
  // 而「开口」判定实际滞后半秒级（docs §8.33）—— 轻声的第一个字照样丢。
  // 喂法：30 帧静音（环只留最后 7 帧）→ 3 帧响（startFrames=3 才报 start，头两帧响
  // 同样落在环里，被 7 帧上界截住）→ 20 帧静音（第 18 帧 end）。
  // 期望发给 /transcribe 的那一段 = (7 + 1 + 18) 帧 @48k，重采样到 16k 后 ×4 字节。
  const beforePreRoll = env.fetchLog.length
  const silentFrame = () => new Float32Array(4096).fill(0.0001)
  const loudFrame = () => new Float32Array(4096).fill(0.4)
  let preRollError = null
  try {
    for (let i = 0; i < 30; i++) sp?.onaudioprocess?.({ inputBuffer: { getChannelData: () => silentFrame() } })
    for (let i = 0; i < 3; i++) sp?.onaudioprocess?.({ inputBuffer: { getChannelData: () => loudFrame() } })
    for (let i = 0; i < 20; i++) sp?.onaudioprocess?.({ inputBuffer: { getChannelData: () => silentFrame() } })
  } catch (error) {
    preRollError = error
  }
  const preRollPosts = env.fetchLog.slice(beforePreRoll).filter((f) => String(f.url).includes('/transcribe'))
  const expectedFrames = 7 + 1 + 18
  const expectedBytes = Math.floor((expectedFrames * 4096) / 3) * 4
  check('[浮层采集·回退] 响过之后确实切出一段并送去识别',
    preRollError === null && preRollPosts.length === 1,
    preRollError?.message ?? JSON.stringify({ posts: preRollPosts.length }))
  check('[浮层采集·回退] 那一段带了开口前 600ms 的预录（7 帧 @4096），不是 startFrames 的 3 帧',
    preRollPosts[0]?.bodyBytes === expectedBytes,
    JSON.stringify({ got: preRollPosts[0]?.bodyBytes, want: expectedBytes }))
  // 回退不能是「悄悄退了、没人知道为什么」。这两条就是任务 #38 的正题：
  // 原先两处 `catch { return false }` 把原因吞了，装机上只能看见「在听」，看不见走的是哪条、为什么退。
  const fbCapture = gdbg().capture ?? {}
  check('[浮层采集·回退] 快照里记的是回退路径，并带上首选路径为什么退',
    fbCapture.path === GLOBAL_CAPTURE_PATHS.scriptProcessor
    && String(fbCapture.reason).includes('worklet 启动失败')
    && String(fbCapture.reason).includes('addModule rejected'),
    JSON.stringify(fbCapture))
  const fbReported = captureReportedAs(GLOBAL_CAPTURE_PATHS.scriptProcessor,
    (r) => r.includes('worklet 启动失败') && r.includes('addModule rejected'))
  check('[浮层采集·回退] 回退原因随采集路径一起上报到宿主（/diagnostics 看得见）',
    fbReported.ok, fbReported.detail)
  check('[浮层采集·回退] 没有异常甩进 effect / handler', env.warnings.length === 0, env.warnings.join('\n'))

  /* ---- 三、两条路都搭不起来：必须明确失败，不能假装在听（洞 1 + 洞 2） ---- */
  resetEnv()
  setMicMode('ok')
  env.worklet.available = true
  env.worklet.addModuleThrows = true
  const savedScriptProcessor = FakeAudioContext.prototype.createScriptProcessor
  FakeAudioContext.prototype.createScriptProcessor = undefined
  check('[浮层采集·双失败] Ctrl+Alt+V 被认下来', await mountAndPress())
  const showedFailure = await waitFor(() => treeHasText(runtime.getTree(), 'micFailed'), 4000, 50)
  check('[浮层采集·双失败] 提示落在「开麦失败」上', showedFailure, JSON.stringify(gdbg()))
  check('[浮层采集·双失败] **不进**聆听态（旧写法在这里照样点「聆听中」：麦克风亮着、一个采样都不进）',
    gdbg().listening === false, JSON.stringify(gdbg()))
  check('[浮层采集·双失败] 界面没显示聆听中', treeHasText(runtime.getTree(), 'globalListening') === false)
  check('[浮层采集·双失败] 音频图一个节点都没留下',
    env.worklet.nodes.length === 0 && env.mic.processors.length === 0)
  check('[浮层采集·双失败] 拿到的轨道全释放了（不释放就是麦克风一直亮）',
    env.mic.streams.length >= 1 && env.mic.streams.every((s) => (s.tracks[0]?.stops ?? 0) >= 1),
    JSON.stringify(env.mic.streams.map((s) => s.tracks[0]?.stops)))
  check('[浮层采集·双失败] 建出来的 AudioContext 全关掉',
    env.audioContexts.length >= 1 && env.audioContexts.every((c) => c.closed === true),
    JSON.stringify(env.audioContexts.map((c) => c.closed)))
  check('[浮层采集·双失败] 让位信号发出去又收回（composer 不该卡在「让位」）',
    env.winEvents.indexOf(GLOBAL_MIC_ON_EVENT) >= 0
    && env.winEvents.lastIndexOf(GLOBAL_MIC_OFF_EVENT) > env.winEvents.indexOf(GLOBAL_MIC_ON_EVENT),
    JSON.stringify(env.winEvents))
  // 双失败也要留得下原因：这一档用户只看到一句「开麦失败」，
  // 现场必须能查出是两条路各自卡在哪儿，而不是只剩一个 'no capture graph'。
  const noneCapture = gdbg().capture ?? {}
  check('[浮层采集·双失败] 快照记的是 none，两条路的原因都带上',
    noneCapture.path === GLOBAL_CAPTURE_PATHS.none
    && String(noneCapture.reason).includes('worklet 启动失败')
    && String(noneCapture.reason).includes('createScriptProcessor 不可用'),
    JSON.stringify(noneCapture))
  const noneReported = captureReportedAs(GLOBAL_CAPTURE_PATHS.none,
    (r) => r.includes('worklet 启动失败') && r.includes('createScriptProcessor 不可用'))
  check('[浮层采集·双失败] 失败同样上报到宿主，且上报先于抛错（抛错会走 stopListening，别让原因丢在半路）',
    noneReported.ok, noneReported.detail)
  check('[浮层采集·双失败] 没有异常甩出 effect / handler（失败是走提示出来的，不是走崩溃）',
    env.warnings.length === 0, env.warnings.join('\n'))
  // 把两条路都修好：同一份浮层不刷新也要能再开起来（用户会再按一次快捷键）。
  FakeAudioContext.prototype.createScriptProcessor = savedScriptProcessor
  env.worklet.addModuleThrows = false
  dispatchKey(combo)
  const recovered = await waitFor(() => gdbg().listening === true, 4000, 50)
  check('[浮层采集·双失败] 恢复后同一份浮层还能开麦（不是只能重启界面）', recovered, JSON.stringify(gdbg()))
  check('[浮层采集·双失败] 恢复走的是首选路径（worklet 节点建起来了）', env.worklet.nodes.length === 1)
  // 采集路径是**每次开麦**重新记的，不是挂上一次就再也不改：
  // 留着旧原因的话，排查时会把上一次失败当成这一次的。
  check('[浮层采集·双失败] 恢复后快照与上报都改回首选路径、原因清空（不是留着上一次的）',
    gdbg().capture?.path === GLOBAL_CAPTURE_PATHS.worklet && gdbg().capture?.reason === ''
    && captureReportedAs(GLOBAL_CAPTURE_PATHS.worklet, (r) => r === '').ok,
    JSON.stringify({ snap: gdbg().capture, report: lastCaptureRow() }))

  /* ---- 四、老内核：全局上根本没有 AudioWorkletNode ---- */
  resetEnv()
  setMicMode('ok')
  env.worklet.available = true
  const savedWorkletCtor = sandbox.AudioWorkletNode
  sandbox.AudioWorkletNode = undefined
  check('[浮层采集·无 AudioWorkletNode] Ctrl+Alt+V 被认下来', await mountAndPress())
  const legacyListening = await waitFor(() => gdbg().listening === true, 4000, 50)
  check('[浮层采集·无 AudioWorkletNode] 仍进聆听态（能力探测在建 Blob 之前就早退）',
    legacyListening, JSON.stringify(gdbg()))
  check('[浮层采集·无 AudioWorkletNode] 一个 Blob 模块都没注入（早退干净，没留待撤的 URL）',
    env.worklet.modules.length === 0 && env.worklet.nodes.length === 0)
  check('[浮层采集·无 AudioWorkletNode] 回退图搭起来了（量子 4096）',
    env.mic.processors.length === 1 && env.mic.processors[0]?.bufferSize === 4096,
    JSON.stringify(env.mic.processors.map((p) => p.bufferSize)))
  check('[浮层采集·无 AudioWorkletNode] 原因写的是「这个全局根本没有」，不是启动报错那种',
    gdbg().capture?.path === GLOBAL_CAPTURE_PATHS.scriptProcessor
    && String(gdbg().capture?.reason).includes('AudioWorkletNode 全局不存在')
    && captureReportedAs(GLOBAL_CAPTURE_PATHS.scriptProcessor, (r) => r.includes('AudioWorkletNode 全局不存在')).ok,
    JSON.stringify({ snap: gdbg().capture, report: lastCaptureRow() }))
  sandbox.AudioWorkletNode = savedWorkletCtor

  /* ---- 五、再按一次关麦：图、轨道、信号都要收干净 ---- */
  dispatchKey(combo)
  const stopped = await waitFor(() => gdbg().listening === false, 3000, 50)
  check('[浮层采集·关麦] 再按一次退出聆听态', stopped, JSON.stringify(gdbg()))
  const closedProcessor = env.mic.processors[0]
  // 这里刻意不断言 `processor.disconnect()`：stopListening 没调它（只摘回调、断 source 和 sink、
  // 再 close 上下文）。这是对的 —— close() 会把整张图拆掉，单独断一个节点没有意义。
  // 真正必须成立的是「回调不再被驱动」+「上下文关掉」，缺一样就是每次开关都攒一份。
  check('[浮层采集·关麦] 处理器回调摘掉、source 与 0 增益 sink 断开、上下文关闭',
    closedProcessor?.onaudioprocess === null && env.mic.sources[0]?.disconnected === true
    && (closedProcessor?.connected?.[0]?.disconnected ?? false) === true
    && env.audioContexts.length >= 1 && env.audioContexts.every((c) => c.closed === true),
    JSON.stringify({
      cb: closedProcessor?.onaudioprocess,
      src: env.mic.sources[0]?.disconnected,
      sink: closedProcessor?.connected?.[0]?.disconnected,
      ctxs: env.audioContexts.map((c) => c.closed),
    }))
  check('[浮层采集·关麦] 轨道停了、让位信号收回',
    (env.mic.streams[0]?.tracks[0]?.stops ?? 0) >= 1
    && env.winEvents.lastIndexOf(GLOBAL_MIC_OFF_EVENT) > env.winEvents.lastIndexOf(GLOBAL_MIC_ON_EVENT),
    JSON.stringify({ stops: env.mic.streams[0]?.tracks[0]?.stops, events: env.winEvents }))
  check('[浮层采集·关麦] 没有异常甩进 effect / handler', env.warnings.length === 0, env.warnings.join('\n'))

  runtime.unmount()
  env.config.globalVoice = false
  delete env.config.globalShortcut
  setMicMode('no-device')
}

/* ------------------------------------------------------------------ */
/* 场景 31：浮层待机唤醒 —— 唤醒这条链路的「说出去的话」与「不该说出去的话」 */
/* ------------------------------------------------------------------ */
/**
 * 这一场要守的是两件事，都是**跑出来的**，不是源码里有没有写某个表达式：
 *
 * ① 待机时听到但没匹配上唤醒词（同音错字，如「小鱼」被识成「小于等于」），
 *    这句环境闲聊**不能进会话**（隐私边界），但要能在宿主 /diagnostics 里看见原文 ——
 *    用户反馈「喊了不醒」时，这是唯一能看到 ASR 到底给了什么的东西。
 * ② 这条诊断上报的请求体里**不许有 `sessionId` 这个自有属性**（批次 13，docs §8.54）。
 *    宿主看见这个键就会改 `voiceSession`，空串等于清空。以前 `reportVoiceAttempt` 无条件写
 *    `sessionId: info?.sessionId ?? ''`，于是**待机时每句闲聊都把那个指针抹掉了**。
 *    当时它有两个读处：`/diagnostics` 顶层那一项（答不出「语音对着哪个会话」），
 *    以及 `/latest-message` 不带 sessionId 时的回退目标（会话不唯一直接 400，表现就是
 *    「朗读没声音」）。批次 17 把那条没人调的死链退役了（§8.59），所以现在这条判据
 *    防的实际损害只剩诊断面失真 —— 键本身该不该发跟以前一样：
 *    修复的另一半同样要判：客户端**真拿着会话 id** 时（发送成功/失败的上报）
 *    这个键必须还在 —— 没键宿主就登记不上语音正在对着哪个会话。
 *
 * 为什么要一份假会话服务：客户端原先在 harness 里**永远拿不到 sessions**
 * （`ctx.inject(['sessions'])` 的回调被喂了一份没有 sessions 的 scope），
 * 于是浮层只能走「没有当前会话」那一支，②的后半句无法驱动。现在按场景喂/收
 * （见 `makeSessionsService` / `feedSessions`），默认仍然不给，旧场景一字不变。
 *
 * 驱动方式：真挂浮层 → 真按全局快捷键进聆听态 → 从 AudioWorklet 的
 * `port.onmessage` 投一段「VAD 已经切好的音频」→ 假 `/transcribe` 按 `env.transcript`
 * 回一句识别文本。也就是说唤醒判定、待机/活跃切换、发送通路全是真代码在跑。
 */
async function scenarioWakeStandby() {
  await settle()
  resetEnv()
  const Overlay = registrations.find((r) => r.options?.id === 'dsh-voice-typing-global')?.component
  const gdbg = () => fakeWindow.__DSH_VOICE_GLOBAL_DEBUG__?.() ?? {}
  /** 本场景改过的配置结尾原样还回去（后面的场景共用同一个 env.config）。 */
  const savedConfig = { ...env.config }
  const combo = { key: 'v', ctrlKey: true, altKey: true }

  /** 到目前为止的 wake-miss 上报（按通道里的 `via` 认，不按条数猜）。 */
  const wakeMissRows = () => env.clientReports.filter((r) => r?.client?.via === 'wake-miss')
  /** 到目前为止的「语音→会话」发送尝试上报（带真会话 id 的那几条）。 */
  const sendRows = () => env.clientReports.filter((r) => r?.client?.kind === 'global-voice'
    && ['session.prompt', 'host', 'none'].includes(r?.client?.via))
  /** 发给过 /voice-prompt 的次数（宿主回退通路；待机时必须是 0）。 */
  const voicePromptCount = () => env.fetchLog.filter((f) => String(f.url).includes('/voice-prompt')).length
  /** 请求体里有没有 `sessionId` 这个**自有属性**（本批的正题，判形状不判值）。 */
  const hasSessionKey = (row) => Object.prototype.hasOwnProperty.call(row ?? {}, 'sessionId')

  check('[待机唤醒] 全局浮层组件注册可得（本场景的前提）', Boolean(Overlay), 'shell.overlay 没注册上')
  if (!Overlay) return

  /** 挂一份全新的浮层并按一次快捷键开麦 —— 返回「有没有进聆听态」。 */
  const mountAndListen = async () => {
    runtime.unmount()
    runtime.mount(Overlay, { t: (k) => k })
    if (!await waitFor(() => dispatchKey(combo).prevented === true, 4000, 100)) return false
    return waitFor(() => gdbg().listening === true, 4000, 50)
  }

  /** 从 AudioWorklet 的回投端口投一段「已经切好的语音」，等识别文本被处理完。 */
  const say = async (text) => {
    env.transcript = text
    const node = env.worklet.nodes[env.worklet.nodes.length - 1]
    const before = env.fetchLog.filter((f) => String(f.url).includes('/transcribe')).length
    // Float32Array 必须从**沙箱那一侧**造：产品代码的门是 `data.samples instanceof Float32Array`，
    // 而客户端跑在 `vm.runInContext` 的独立 realm 里 —— 测试这边 new 出来的实例在那边
    // instanceof 为 false，这条消息会被当成坏消息直接丢掉（实测：投了但不发 /transcribe，
    // 整段链路一条判据都跑不到）。ScriptProcessor 那条路不受影响，因为它读的是 getChannelData()。
    const samples = vm.runInContext('new Float32Array(4800).fill(0.05)', sandbox)
    node?.port?.onmessage?.({ data: { type: 'segment', samples } })
    return waitFor(() => env.fetchLog.filter((f) => String(f.url).includes('/transcribe')).length > before, 3000, 40)
  }

  /* ---- 前置：进聆听态、认的是配置的唤醒词、处在待机 ---- */
  // 客户端握有一个真会话：待机闲聊有没有被发出去、唤醒后的命令发给了谁，
  // 都从 `env.prompts` 里数得出来；「有 id 时必须带键」那半句也只有这时才驱动得了。
  resetEnv()
  env.config.globalVoice = true
  env.config.globalShortcut = 'Ctrl+Alt+V'
  env.config.wakeWord = '小鱼'
  feedSessions(makeSessionsService())
  setMicMode('ok')
  env.worklet.available = true
  const listening = await mountAndListen()
  check('[待机唤醒] Ctrl+Alt+V 开麦并进聆听态（下面全在这条链路上跑）', listening, JSON.stringify(gdbg()))
  if (!listening) {
    env.config = savedConfig
    setMicMode('no-device')
    return
  }
  check('[待机唤醒] 客户端真的解析到了一个会话（②的后半句「有 id 时必须带键」的前提）',
    gdbg().sessionId === 'sess-9', JSON.stringify(gdbg()))
  check('[待机唤醒] 唤醒词与待机态进诊断快照（现场能看出「现在要不要先喊唤醒词」）',
    gdbg().wakeWord === '小鱼' && gdbg().awake === false && gdbg().awakeUntil === 0,
    JSON.stringify({ wakeWord: gdbg().wakeWord, awake: gdbg().awake, awakeUntil: gdbg().awakeUntil }))
  // 采集路径那条上报也在这儿（开麦必发），下面按 via 分桶，不会被它混进来。
  check('[待机唤醒] 开麦时只有采集路径上报，没有 wake-miss / 发送尝试（计数基线）',
    wakeMissRows().length === 0 && sendRows().length === 0,
    JSON.stringify(env.clientReports.map((r) => ({ key: hasSessionKey(r), client: r?.client?.kind ?? r?.client?.via }))))

  /* ---- ① 待机 + 同音错字：不上报会话指针，原文要留下，话不许进会话 ---- */
  // 「小鱼」被识成「小于等于」是 2026-11-03 装机实测到的真失败（于/等 不在同音表里）。
  const saidMiss = await say('小于等于')
  const missed = await waitFor(() => wakeMissRows().length >= 1, 3000, 40)
  check('[待机唤醒·wake-miss] 一句没匹配的闲聊被切出来、送去识别、认出来了', saidMiss && missed,
    JSON.stringify({ saidMiss, missed, dbg: gdbg() }))
  const missRow = wakeMissRows()[0] ?? null
  check('[待机唤醒·wake-miss] 上报带上识别原文与失败原因（「喊了不醒」的唯一现场证据，修复不许把它一起砍掉）',
    missRow?.client?.error === 'wake_miss' && String(missRow?.client?.text ?? '').includes('小于等于'),
    JSON.stringify(missRow))
  check('[待机唤醒·wake-miss] **请求体里没有 sessionId 这个键**（本批的正题：空串会清空宿主的 voiceSession，'
    + '诊断面就答不出语音对着哪个会话）',
    hasSessionKey(missRow) === false, JSON.stringify(missRow))
  check('[待机唤醒·wake-miss] 这句闲聊没进会话（隐私边界：待机只认唤醒词）',
    env.prompts.length === 0 && voicePromptCount() === 0,
    JSON.stringify({ prompts: env.prompts, voicePrompt: voicePromptCount() }))
  check('[待机唤醒·wake-miss] 仍在待机，没被没匹配的闲聊唤成活跃态',
    gdbg().awake === false && gdbg().awakeUntil === 0, JSON.stringify(gdbg()))
  check('[待机唤醒·wake-miss] 没有异常甩出 effect / handler', env.warnings.length === 0, env.warnings.join('\n'))

  /* ---- ② 唤醒词 + 命令：进活跃态、只发命令部分、上报必须带那个真会话 id ---- */
  const saidWake = await say('小鱼 帮我看看这个')
  const woke = await waitFor(() => env.prompts.length >= 1, 3000, 40)
  check('[待机唤醒·唤醒] 「小鱼 帮我看看这个」走完识别并真的发出去了', saidWake && woke,
    JSON.stringify({ saidWake, woke, prompts: env.prompts }))
  check('[待机唤醒·唤醒] 进活跃态（后面几句不用再喊唤醒词），到期时间也顺延了',
    gdbg().awake === true && Number(gdbg().awakeUntil) > 0, JSON.stringify(gdbg()))
  check('[待机唤醒·唤醒] 唤醒词不进会话消息，只发命令那半句',
    env.prompts.length === 1 && String(env.prompts[0].text).includes('帮我看看这个')
    && String(env.prompts[0].text).includes('小鱼') === false, JSON.stringify(env.prompts))
  const wakeRow = (sendRows().slice(-1)[0]) ?? null
  check('[待机唤醒·唤醒] 发送尝试的走的是直发通路并报告成功',
    wakeRow?.client?.via === 'session.prompt' && wakeRow?.client?.ok === true, JSON.stringify(wakeRow))
  check('[待机唤醒·唤醒] **这条上报带 sessionId 键，且值就是那个会话**'
    + '（修复的另一半：宿主靠它登记「语音在对着哪个会话」，无条件省键就把它也弄没了）',
    hasSessionKey(wakeRow) === true && wakeRow?.sessionId === 'sess-9', JSON.stringify(wakeRow))
  check('[待机唤醒·唤醒] 没有把上一句 wake-miss 的现场算进来（计数仍只有一条）',
    wakeMissRows().length === 1, JSON.stringify(wakeMissRows()))

  /* ---- ③ 活跃态内：不用再喊唤醒词，普通对话直发 ---- */
  const saidActive = await say('再说一句')
  const sentTwo = await waitFor(() => env.prompts.length >= 2, 3000, 40)
  check('[待机唤醒·活跃态] 不含唤醒词的一句照样发出去（唤醒只负责进门，不是每句都要喊）',
    saidActive && sentTwo, JSON.stringify({ saidActive, sentTwo, prompts: env.prompts }))
  check('[待机唤醒·活跃态] 发的是整句原文，且会话还是那一个',
    env.prompts[1]?.text === '再说一句' && env.prompts[1]?.sessionId === 'sess-9', JSON.stringify(env.prompts[1]))
  check('[待机唤醒·活跃态] 活跃态里不再有 wake-miss 上报，发送上报仍带会话 id',
    wakeMissRows().length === 1 && hasSessionKey(sendRows().slice(-1)[0]) === true,
    JSON.stringify({ wakeMiss: wakeMissRows().length, last: sendRows().slice(-1)[0] }))

  /* ---- ④ 活跃态里只喊一声唤醒词：不算命令，不发 ---- */
  const promptsBeforeOnly = env.prompts.length
  await say('小鱼')
  await sleep(250)
  check('[待机唤醒·只喊一声] 不发出内容、也不产生 wake-miss（活跃态里它是「我在听」，不是闲聊）',
    env.prompts.length === promptsBeforeOnly && wakeMissRows().length === 1,
    JSON.stringify({ prompts: env.prompts.length, wakeMiss: wakeMissRows().length }))

  /* ---- ⑤ 一个会话都没有：no_session 上报同样不许带键（它也是空串那种） ---- */
  // 收回假服务并重挂：已挂载实例的 sessionIdRef 里还留着上一句的会话，
  // 只有重新挂载才会重新解析成「没有会话」。
  resetEnv()
  env.config.globalVoice = true
  env.config.globalShortcut = 'Ctrl+Alt+V'
  env.config.wakeWord = '小鱼'
  feedSessions(makeSessionsService({ sessions: [], createId: '' }))
  setMicMode('ok')
  env.worklet.available = true
  const listeningAgain = await mountAndListen()
  const saidNoSession = await say('小鱼 帮我看看这个')
  const noSessionRow = await waitFor(() => sendRows().some((r) => r?.client?.error === 'no_session'), 3000, 40)
  check('[待机唤醒·没有会话] 重新开麦成功（本段的前提）', listeningAgain && saidNoSession,
    JSON.stringify({ listeningAgain, saidNoSession }))
  check('[待机唤醒·没有会话] 确实落到「没有当前会话」这一支（新建也没建出来）',
    noSessionRow && env.prompts.length === 0, JSON.stringify({ row: sendRows().slice(-1)[0], prompts: env.prompts }))
  const noRow = sendRows().slice(-1)[0] ?? null
  check('[待机唤醒·没有会话] 这条上报**也没有 sessionId 键**（没有 id 就没有可登记的，'
    + '写空串等于替用户把朗读目标清掉）',
    noRow?.client?.via === 'none' && hasSessionKey(noRow) === false, JSON.stringify(noRow))
  check('[待机唤醒·没有会话] 没有异常甩出 effect / handler', env.warnings.length === 0, env.warnings.join('\n'))

  /* ---- 收尾：关麦、卸载、把改过的配置与服务还回去 ---- */
  dispatchKey(combo)
  runtime.unmount()
  feedSessions(null)
  env.config = savedConfig
  setMicMode('no-device')
}

/* ------------------------------------------------------------------ */
/* 场景 32：心跳的 sessionId 键（批次 13b，docs §8.55）                  */
/* ------------------------------------------------------------------ */
/**
 * composer 那只按钮每 1500 毫秒往 `/voice-session` 报一次状态（心跳）。
 * 宿主的契约是「请求体里有自有属性 `sessionId` 就把 `voiceSession` 改成它」，空串等于清空；
 * 而这里读的 sessionId 在「还没拿到会话 id」时**就是空串** ——
 * 于是这个只想报状态的组件，每 1.5 秒替用户清一次会话指针
 * （批次 13 §8.54 那条缺陷的同类第二处，间隔短到每次都会踩）。
 *
 * 两头都要钉住：
 *   - 有 id 时**必须带**——心跳是 `voiceSession` 唯一的正常登记来源，
 *     「不收窄就误清」的反面是「收窄过头把登记通道也收掉」；
 *   - 没 id 时**整个键都不发**，但心跳本身照发（不然诊断面整个瞎掉）。
 * 再加一段「把 id 补回去」的对照：同一处代码在两种挂载下给出不同形状，
 * 才说明②那条「没带键」是 id 空造成的，而不是我数不出带键的样子。
 *
 * 最后一段判关麦后心跳停不停：effect 的 cleanup 以前写的是
 * `win.clearInterval(timer)`，那个变量在本 effect 里从来不存在，每次翻转态都多一个 interval
 * （外提 MicButton 那一刀 `3bfe012` 修的，当时只留了注释、没有判据）
 * —— 这条判据保证我前面数的那些心跳不是漏出来的多个 interval 叠出来的。
 *
 * 成本：心跳间隔 1500 毫秒，四段各等一个周期，本场景约 6 秒。
 */
async function scenarioHeartbeatSessionKey() {
  await settle()
  resetEnv()
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  /** 只数心跳：`client.on` 是心跳负载里那个常量 true，别处的上报不放这个键。 */
  const beats = () => env.clientReports.filter((r) => r?.client?.on === true)
  /** 请求体里有没有 `sessionId` 这个**自有属性**（判形状不判值，同批次 13）。 */
  const hasSessionKey = (row) => Object.prototype.hasOwnProperty.call(row ?? {}, 'sessionId')
  /** 开麦并等到第一条心跳落地，返回两个前提各自成不成立。 */
  const listen = async () => {
    setMicMode('ok')
    micButton()?.props?.onClick?.()
    const on = await waitFor(() => dbg().on === true, 4000, 40)
    const beat = await waitFor(() => beats().length >= 1, 4000, 40)
    return { on, beat }
  }
  /** 换一次挂载的 sessionId 并重新开麦（心跳的 id 只在挂载时解析一次）。 */
  const remountWith = async (sessionId) => {
    runtime.unmount()
    resetEnv()
    bootMic({ sessionId })
    await sleep(300)
    return listen()
  }

  /* ---- ① 有会话 id：心跳必须带着它 ---- */
  runtime.unmount()
  bootMic()
  await sleep(300)
  const first = await listen()
  check('[心跳] 挂载 + 开麦 + 第一条心跳发出（本场景的前提）',
    first.on === true && first.beat === true, JSON.stringify({ ...first, beats: beats().length }))
  check('[心跳·有 id] 每条心跳都带 sessionId 键，值就是挂载时那个（登记通道没被收窄掉）',
    beats().length >= 1 && beats().every((r) => hasSessionKey(r) && r.sessionId === 'sess-1'),
    JSON.stringify(beats().map((r) => ({ key: hasSessionKey(r), sid: r.sessionId }))))
  check('[心跳·有 id] 负载本身照常齐全（几个布尔状态都在，不是整条被砍）',
    beats().every((r) => typeof r.client?.speaking === 'boolean'
      && typeof r.client?.recognizing === 'boolean' && typeof r.client?.hearing === 'boolean'),
    JSON.stringify(beats()[0]?.client ?? null))

  /* ---- ② 没有会话 id：键整个不发，心跳照发 ---- */
  const second = await remountWith('')
  check('[心跳·没 id] 没 id 也照样开麦、照样发心跳（本段的前提，也是「不是整条不发」的证据）',
    second.on === true && second.beat === true, JSON.stringify({ ...second, beats: beats().length }))
  check('[心跳·没 id] 没有一条心跳带 sessionId 键（带空串等于每 1.5 秒清一次用户的会话指针）',
    beats().every((r) => !hasSessionKey(r)),
    JSON.stringify(beats().map((r) => ({ key: hasSessionKey(r), sid: r.sessionId }))))
  check('[心跳·没 id] 负载照样齐全（清掉的只有那个键，诊断面没跟着瞎）',
    beats().every((r) => typeof r.client?.speaking === 'boolean'
      && typeof r.client?.recognizing === 'boolean' && typeof r.client?.hearing === 'boolean'),
    JSON.stringify(beats()[0]?.client ?? null))

  /* ---- ③ 对照：把 id 补回去，键又回来 ---- */
  const third = await remountWith('sess-3')
  check('[心跳·对照] 补回 id 之后每条心跳又带 sessionId（同一处代码给出两种形状，②那条不是空判）',
    third.beat === true && beats().length >= 1
      && beats().every((r) => hasSessionKey(r) && r.sessionId === 'sess-3'),
    JSON.stringify({ ...third, rows: beats().map((r) => ({ key: hasSessionKey(r), sid: r.sessionId })) }))

  /* ---- ④ 关麦之后心跳要停 ---- */
  const countAtOff = beats().length
  micButton()?.props?.onClick?.()
  await waitFor(() => dbg().on === false, 2000, 40)
  await sleep(1800)
  check('[心跳·关麦] 关麦后 1.8 秒内没有新心跳（cleanup 真的清掉了 interval，不是每翻一次态多一个）',
    beats().length === countAtOff, JSON.stringify({ before: countAtOff, after: beats().length }))
  check('[心跳] 整个过程没有异常甩进 effect / handler', env.warnings.length === 0, env.warnings.join('\n'))

  runtime.unmount()
  setMicMode('no-device')
}

/* ------------------------------------------------------------------ */
/* 场景 14：自动发送只发一遍（listening-ready「发送通路」的行为化）      */
/* ------------------------------------------------------------------ */
/**
 * 「同一段话不能发两遍」的老判据钉的是写法：两条发送通路共用一个定时器 id、
 * 并且各自把对方那个 id 也清一遍。写法已经改过了（以前真是两个 id、谁也不取消谁），
 * 继续钉写法就等于逼下一个改写法的人再来改测试。这里判结果：
 * 说一句话，composer 的 `submit` 到底响几次。
 *
 * 两条通路：
 *   助手闲 —— 识别完成的那一步挂 `autoSendExtraMs`（默认 1200ms）定时器后 submit；
 *   助手忙 —— 先把话留在草稿，busy→idle 的 effect 挂 400ms 定时器后 submit。
 * 危险点在交界：闲时挂了定时器 → 助手开始生成 → 忙完的 effect 又挂一次
 * → 同一段话被 submit 两遍（用户看到「已经发出去的消息又出现」）。
 *
 * 驱动方式：VAD 听的是 analyser（`env.mic.level`），音频块走 `onaudioprocess`，
 * 两边一起推才会「开口 → 停顿 → 断句 → 识别」。
 *
 * @param {object} options - { loudTicks, quietTicks } 开口/停顿的 tick 数（每 tick 110ms）。
 * @returns {Promise<boolean>} 这一段是否真的走到「识别完成」（`pendingAutoSend` 或已在识别中）。
 */
async function speakOnce({ loudTicks = 4, quietTicks = 4 } = {}) {
  const processor = env.mic.processors[env.mic.processors.length - 1]
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  const transcribesBefore = env.fetchLog.filter((f) => String(f.url).includes('/transcribe')).length
  for (let i = 0; i < loudTicks; i++) {
    env.mic.level = 0.05
    processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.05) } })
    await sleep(110)
  }
  for (let i = 0; i < quietTicks; i++) {
    env.mic.level = 0
    processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } })
    await sleep(110)
  }
  return waitFor(() => env.fetchLog.filter((f) => String(f.url).includes('/transcribe')).length > transcribesBefore
    || dbg().recognizing === true, 3000, 50)
}

async function scenarioAutoSend() {
  await settle()
  resetEnv()
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  /** 记下本场景改过的配置，结尾原样还回去（后面的场景共用同一个 env.config）。 */
  const savedConfig = { ...env.config }
  // autoSend 开；朗读关（本场景只管「说 → 填 → 发」，不掺 TTS）；
  // silenceMs 压到 200ms，否则每次断句要真等 1.5 秒；
  // autoSendExtraMs 拉到 2500ms：配置只在挂载时和开麦时拉（没有轮询），
  // 所以这个值必须一次定死 —— 留出的窗口同时是「忙完补发」那条路的取消判据。
  env.config.autoSend = true
  env.config.readAloud = false
  env.config.silenceMs = 200
  env.config.autoSendExtraMs = 2500
  env.transcript = '测试识别出的这句话。'
  runtime.unmount()
  bootMic()
  await sleep(300) // 让 GET /config 落进 configRef（这几项都是识别之后才读的）
  setMicMode('ok')
  micButton().props.onClick()
  const listening = await waitFor(() => dbg().on === true, 4000)
  check('[自动发送] 前置：开麦进聆听态（后面全在这条链路上跑）', listening, JSON.stringify(dbg()))
  if (!listening) {
    env.config = savedConfig
    setMicMode('no-device')
    return
  }

  /* ---- 一、助手闲：说完一句恰好发一遍 ---- */
  const saidIdle = await speakOnce()
  check('[自动发送·闲] 说一句 → 真的切出一段送去识别（前置）', saidIdle)
  check('[自动发送·闲] 发送定时器没到点之前不 submit（不是识别完就立刻发）',
    env.submits.length === 0, `submits=${env.submits.length}`)
  const sent = await waitFor(() => env.submits.length >= 1, 6000)
  check('[自动发送·闲] 等了一会儿确实发出去了（恰好一次）', sent && env.submits.length === 1,
    `submits=${env.submits.length}`)
  await sleep(3000)
  check('[自动发送·闲] 再多等两轮也不补发（老判据钉的两个 id 互不取消 = 这里会多一次）',
    env.submits.length === 1, `submits=${env.submits.length}`)

  /* ---- 二、助手忙：先留草稿，忙完恰好发一遍 ---- */
  emit('assistant-busy', { sessionId: 'sess-1', busy: true })
  await sleep(80)
  check('[自动发送·忙] 前置：dbg 里助手在生成', dbg().assistantRunning === true, JSON.stringify(dbg()))
  const submitsBeforeBusy = env.submits.length
  const saidBusy = await speakOnce()
  const held = await waitFor(() => dbg().pendingAutoSend === true, 3000, 50)
  check('[自动发送·忙] 这一段挂在「忙完再发」上，没在助手生成中途抢发',
    saidBusy && held && env.submits.length === submitsBeforeBusy,
    JSON.stringify({ saidBusy, pending: dbg().pendingAutoSend, submits: env.submits.length - submitsBeforeBusy }))
  emit('assistant-busy', { sessionId: 'sess-1', busy: false })
  const sentAfterBusy = await waitFor(() => env.submits.length === submitsBeforeBusy + 1, 3000)
  check('[自动发送·忙] 助手空闲后补发，恰好一次',
    sentAfterBusy && env.submits.length === submitsBeforeBusy + 1, `submits=${env.submits.length}`)

  /* ---- 三、交界：闲时挂了定时器 → 助手转忙 → 忙完又挂一次 ---- */
  // 这是老判据真正守着的那条路。时间这样排（autoSendExtraMs = 2500ms）：
  //   说 A 句（闲）→ 发送定时器挂上（2500ms 后才 submit，故意留出窗口）
  //   → 助手开始生成 → 说 B 句（忙）→ 忙完 effect 400ms 后 submit
  //   → 再等过 2500ms：A 的那个定时器必须已经被取消。
  // 少了那句取消，这里会数到 2 次 submit。
  emit('assistant-busy', { sessionId: 'sess-1', busy: false })
  await sleep(600)
  const submitsBeforeRace = env.submits.length
  const saidA = await speakOnce({ loudTicks: 3, quietTicks: 3 })
  check('[自动发送·交界] A 句切出来了（前置）', saidA)
  emit('assistant-busy', { sessionId: 'sess-1', busy: true })
  await sleep(50)
  const saidB = await speakOnce({ loudTicks: 3, quietTicks: 3 })
  const heldB = await waitFor(() => dbg().pendingAutoSend === true, 3000, 50)
  check('[自动发送·交界] B 句挂上「忙完再发」（前置）', saidB && heldB,
    JSON.stringify({ saidB, pending: dbg().pendingAutoSend }))
  const pendingIds = (dbg().timers ?? []).filter((id) => String(id).startsWith('pending-'))
  check('[自动发送·交界] 任一时刻挂着的发送定时器至多一个（共用 id 的行为表现）',
    pendingIds.length <= 1, JSON.stringify(pendingIds))
  emit('assistant-busy', { sessionId: 'sess-1', busy: false })
  const sentRace = await waitFor(() => env.submits.length === submitsBeforeRace + 1, 3000)
  check('[自动发送·交界] 忙完只发一次', sentRace, `submits=${env.submits.length - submitsBeforeRace}`)
  await sleep(2600)
  check('[自动发送·交界] 等过 A 句那个定时器的点也不补发（取消真的生效）',
    env.submits.length === submitsBeforeRace + 1,
    `多发 ${env.submits.length - submitsBeforeRace - 1} 次`
    + `（A 句的定时器还在 = 同一段话发两遍，用户看到「已发出的消息又出现」）`)

  /* ---- 收尾：把麦克风关掉，异常必须一条都没有 ---- */
  check('[自动发送] 整个过程没有异常甩进 effect / handler',
    env.warnings.length === 0, env.warnings.join('\n'))
  micButton().props.onClick()
  await waitFor(() => dbg().on === false, 2000)
  env.config = savedConfig
  setMicMode('no-device')
}

/* ------------------------------------------------------------------ */
/* 场景 18：停止朗读 —— 切断在响的源、静音不被同轮广播撤销、状态行不跳长文案 */
/* ------------------------------------------------------------------ */
/**
 * 这一场景替掉的是 `test/read-aloud-stop.test.mjs` 里那组「扫源码句子」的断言
 * （`speakSourcesRef = useRef(new Set())`、`for (const source of [...sources])`、
 * `setHint(t('stoppedSpeaking'))`、`minWidth: 48`、`isNewTurn` 那几行）。
 * 它们要守的都是能直接跑出来的事：
 *   1. 点停止时**正在响的那个源**真的被 stop 了（老写法只掐一个句柄，空隙里就停不掉）；
 *   2. 停止之后这一轮保持静音：同轮重复广播的 turn-begin、没有轮次 id 的句子、
 *      call-end、turn-end 之后迟到的本轮句子，都不该把它解除；
 *   3. 状态行点停止后显示的是短回执，宽度上下限也在渲染产物上（不是源码里的数字）。
 * 判据看的是源对象上的 `stopRequested`、`env.playedTexts`、调试快照与渲染树，
 * 与生产代码怎么写那句话无关。
 */
async function scenarioStopAndMute() {
  await settle()
  resetEnv()
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  // 配置只在挂载与「开麦状态翻转」时重新拉取（没有轮询），上一个场景（自动发送）
  // 把 readAloud 关掉了，所以这里要显式设好本场景依赖的两项，再重挂一次让它真读到。
  env.config = { ...env.config, readAloud: true, autoSend: false }
  runtime.unmount()
  bootMic()
  await sleep(300)
  if (dbg().config?.readAloud !== true) {
    check('[停止·切断] 前置：朗读配置是开的', false, JSON.stringify(dbg().config))
    return
  }
  // 让「正在响」这段时间足够长，点得到停止（默认 25ms 一句话瞬间就播完了）。
  env.audio.playMs = 1200
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'sm1' })
  emitSentence({ text: '正在响的那句。', turnId: 'sm1', index: 0, para: 0, paraStart: true })
  emitSentence({ text: '排在后面的那句。', turnId: 'sm1', index: 1, para: 0, paraStart: false })
  const started = await waitFor(() => env.playSources.some((s) => s._started), 4000)
  const live = env.playSources.filter((s) => s._started && !s._finished)
  check('[停止·切断] 前置：第一句已经在响（源 start 了、还没 end）',
    started && live.length === 1, JSON.stringify({ started, n: env.playSources.length, live: live.length }))
  if (!started) { env.audio.playMs = 25; return }

  const stopBtn = findByProp(runtime.getTree(),
    (node) => node?.type === 'button' && node?.props?.['aria-label'] === 'stopSpeaking')
  check('[停止·切断] 找得到「停止朗读」按钮', Boolean(stopBtn?.props?.onClick))
  if (!stopBtn?.props?.onClick) { env.audio.playMs = 25; return }

  // 下面两条接手 `test/state-reset.test.mjs` 的第 3 条源码判据
  // （「haltSpeaking 在 clearQueue 成立时清空待播队列」）。那条只认 `if (clearQueue) {` 那几行字，
  // 把守卫改成永不成立 —— 字还在、行还在，判据照样绿；这里改判「点停止当场队列长度归零」。
  const queueBeforeStop = dbg().queue
  stopBtn.props.onClick()
  check('[停止·切断] 前置：点停止之前待播队列里确实排着句子',
    queueBeforeStop > 0, JSON.stringify({ queue: queueBeforeStop }))
  check('[停止·切断] 点停止当场把待播队列清空（漏清的那一半只能靠队列长度判）',
    dbg().queue === 0, JSON.stringify({ queue: dbg().queue }))
  check('[停止·切断] 在响的那个源被 stop 了（「已有的朗读不会立即中断」就是这个）',
    live[0].stopRequested === true, JSON.stringify({ stopRequested: live[0].stopRequested }))
  // 等一次重渲染：`onClick` 里的 setHint 只登记了状态，渲染树是异步更新的，
  // 立刻读会拿到点停止**之前**那一帧（上一句的回退提示还挂在上面）。
  await sleep(80)
  const span = statusSpan()
  check('[停止·切断] 点停止弹的是短回执（长文案会把整行挤走）',
    span?.props?.children === 'stoppedSpeaking', JSON.stringify(span?.props?.children))
  check('[停止·切断] 状态行宽度下限在渲染产物上（换文案不挪位置）',
    span?.props?.style?.minWidth === 48, JSON.stringify(span?.props?.style?.minWidth))
  check('[停止·切断] 状态行最大宽度收窄（长提示也挤不宽它）',
    span?.props?.style?.maxWidth === 120, JSON.stringify(span?.props?.style?.maxWidth))

  await sleep(env.audio.playMs + 400)
  check('[停止·切断] 排在后面的那句不再开播（这一轮保持静音）',
    env.playedTexts.length === 1, JSON.stringify(env.playedTexts))
  check('[停止·切断] 两条收到的句子都各回执一次（不回执宿主只能等 watchdog）',
    ackTotal() === 2, `acks=${ackTotal()}`)
  check('[停止·切断] 播完/停掉的源都从在册名单里摘干净（不留早就结束的源）',
    dbg().playSources === 0, JSON.stringify({ playSources: dbg().playSources, total: env.playSources.length }))

  /* ---- 静音只由「真正的新轮」解除 ---- */
  check('[停止·静音] 静音记的是这一轮的 turnId', dbg().muted === 'sm1', JSON.stringify(dbg().muted))
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'sm1' })
  emitSentence({ text: '同轮又广播一次之后的句子。', turnId: 'sm1', index: 2, para: 0, paraStart: false })
  await sleep(300)
  check('[停止·静音] 同一轮的 turn-begin 不解除静音（宿主重复广播会把用户的停止撤销）',
    env.playedTexts.length === 1, JSON.stringify(env.playedTexts))
  check('[停止·静音] 被同轮广播拦下的句子也回执', ackTotal() === 3, `acks=${ackTotal()}`)

  emitSentence({ text: '没有轮次 id 的句子。', turnId: '', index: 3, para: 0, paraStart: false })
  await sleep(300)
  check('[停止·静音] 静音期间没带 turnId 的句子同样拦下',
    env.playedTexts.length === 1, JSON.stringify(env.playedTexts))

  emit('call-end', { sessionId: 'sess-1', turnId: 'sm1' })
  await sleep(200)
  check('[停止·静音] call-end 不被当成一轮结束（静音与轮次 id 都没被动过）',
    dbg().muted === 'sm1' && dbg().turnId === 'sm1' && env.playedTexts.length === 1,
    JSON.stringify({ muted: dbg().muted, turnId: dbg().turnId, played: env.playedTexts.length }))

  emit('turn-end', { sessionId: 'sess-1', turnId: 'sm1' })
  await sleep(200)
  check('[停止·静音] turn-end 不清掉当前轮次 id（清了就会放行迟到的本轮句子）',
    dbg().turnId === 'sm1', JSON.stringify(dbg().turnId))
  emitSentence({ text: 'turn-end 之后才到的本轮句子。', turnId: 'sm1', index: 4, para: 0, paraStart: false })
  await sleep(300)
  check('[停止·静音] turn-end 之后迟到的本轮句子仍然不播',
    env.playedTexts.length === 1, JSON.stringify(env.playedTexts))

  emit('turn-begin', { sessionId: 'sess-1', turnId: 'sm2' })
  emitSentence({ text: '新一轮的第一句。', turnId: 'sm2', index: 0, para: 0, paraStart: true })
  const resumed = await waitFor(() => env.playedTexts.includes('新一轮的第一句。'), 4000)
  check('[停止·静音] 真正的新轮 turn-begin 才恢复朗读（停止只影响这一轮）',
    resumed, JSON.stringify(env.playedTexts))

  /* ---- 合成失败要留痕，提示走短词 ---- */
  env.audio.playMs = 25
  env.ttsBehavior = () => ({ ok: false, status: 500 })
  const failuresBefore = dbg().ttsFailures ?? 0
  emitSentence({ text: '合成失败的一句。', turnId: 'sm2', index: 1, para: 0, paraStart: false })
  const counted = await waitFor(() => (dbg().ttsFailures ?? 0) > failuresBefore, 4000)
  check('[合成失败] 失败次数进调试快照（「朗读没声」先看这一项）',
    counted, JSON.stringify({ before: failuresBefore, after: dbg().ttsFailures }))
  check('[合成失败] 提示用的是短词（长说明会把状态行挤宽）',
    statusSpan()?.props?.children === 'ttsFailed', JSON.stringify(statusSpan()?.props?.children))

  /* ---- 调试快照把朗读的诊断计数都露出来 ---- */
  // 替掉的是原来扫源码正则的两条（`acks: acksSentRef.current`、
  // `playSkipped: playSkippedRef.current`）：字段名写没写对不重要，
  // 「装机上按一次停止朗读之后读得到这几个数」才是判据。
  const snapshot = dbg()
  const missingCounters = ['acks', 'trimmed', 'dropped', 'playSkipped', 'playSources', 'ttsFailures']
    .filter((key) => typeof snapshot[key] !== 'number')
  check('[调试快照] 朗读的五个诊断计数都在（缺一个，装机上「没声音」就查不到原因）',
    missingCounters.length === 0, `缺或不是数：${missingCounters.join(',')}`)

  check('[停止·静音] 整个过程没有异常甩进 effect / handler',
    env.warnings.length === 0, env.warnings.join('\n'))
  await settle()
  env.ttsBehavior = () => ({ ok: true, status: 200 })
}

/* ------------------------------------------------------------------ */
/* 场景 19：关麦 / 卸载的状态复位（两轴分工 + 定时器真的被摘掉）          */
/* ------------------------------------------------------------------ */
/**
 * 这一场景替掉的是 `test/state-reset.test.mjs` 里那一组「按大括号取函数体再正则」的判据
 * （`timers.clearGroup('send')` 在不在 stopListening 里、`closeMic()` 调没调、
 * 九个 ref 有没有归位、once 模式只关麦、麦克风按钮不碰朗读、静音不被开麦撤销…）。
 *
 * 它值回票价的原因就一条，而且是写这个场景时**跑出来的真缺陷**：
 *   `stopListening` 里那句 `timers.clearGroup('send')` 一直都在（写法判据一直绿），
 *   但两个发送定时器登记时**没带组名** —— 登记表按组清，清的是「组名相等的条目」，
 *   于是一句都清不到。2026-10-31 修过的「关掉麦克风后草稿自己发出去」这个故障，
 *   在把逐个 ref 清改造成按 group 清的时候**悄悄回来了**。
 *   同一形状的还有 vad / flush：`clearGroup('mic')` 当时也是空转。
 *   写法判据看不见（那行字还在），行为判据一条就抓住（本场景 A 段第 5 条）。
 *
 * 六段各判一件事：
 *   A 关麦 → mic 组与 send 组的定时器从登记表里摘干净，等过到点也不 submit；
 *   B 再开麦说第二段 → 草稿里不残留第一段的字，卸载 → clearAll 生效（挂着的发送定时器不再发）；
 *   C 关麦 → 不碰朗读轴（正在响的源不被 stop、这一轮其余句子照样播完、
 *     「朗读中」不消失）—— 两轴正交；
 *   D 手动静音 → 开关麦都不解除（那是用户意图），只有真新轮恢复；
 *   E once 模式 → 说完一句退出聆听态，但这一刻在响的句子照样念完
 *     （踩过的坑：必须**先说完再让回复进来**。一边大声说话一边朗读会命中
 *      vad 里的「插话停朗读」，那是另一条正确行为，会把这一段顶成假红）；
 *   F 卸载 → 两轴一起收摊：正在响的那句被掐掉，排在后面的不再播。
 *
 * 批次 6i-c 把 `state-reset` 最后剩下的 3 条源码判据也处理掉了，本文件因此多两处判点：
 *   - 「haltSpeaking 在 clearQueue 成立时清空待播队列」→ 场景「停止朗读」里点停止**当场**读
 *     `dbg().queue`（那条只认 `if (clearQueue) {` 那几行字，守卫改成永不成立字还在、判据照样绿；
 *     实测：把守卫改成永不成立再重新构建产物，这里红在 `{"queue":1}`）。
 *   - 「登记表按注入的 win 创建」→ A 段那两条 interval 计数判点（见下面的注释）。
 *   另外两条（提示定时器、噪音基准）行为上分不出写法，直接删，理由记在 §8.42。
 */
async function scenarioStateReset() {
  await settle()
  resetEnv()
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  const savedConfig = { ...env.config }
  const pendingIds = () => (dbg().timers ?? []).filter((id) => String(id).startsWith('pending-'))
  const liveSources = () => env.playSources.filter((s) => s._started && !s._finished)
  const stopBtn = () => findByProp(runtime.getTree(),
    (node) => node?.type === 'button' && node?.props?.['aria-label'] === 'stopSpeaking')
  /**
   * 等上一段的朗读彻底播完（在册源全结束）。
   *
   * 为什么不能只靠 `settle()`：它判的是 `speaking === false && queue === 0`，
   * 而队列排空之后**最后那一句还可能在响**（speaking 已经关了）。
   * 上一段的尾巴会同时骗过「有源在响」和「没源在响」两类判据，各段之间必须排干净。
   */
  const drain = async () => { await waitFor(() => liveSources().length === 0, 12000, 50) }
  const bail = () => { env.config = savedConfig; setMicMode('no-device') }

  /* ============ A. 关麦把聆听侧与发送侧的定时器真的摘掉 ============ */
  env.config = { ...env.config, autoSend: true, readAloud: false, silenceMs: 200, autoSendExtraMs: 2500 }
  runtime.unmount()
  bootMic()
  await sleep(300)
  check('[复位A] 前置：这份配置真的读到了（autoSend 开、朗读关）',
    dbg().config?.autoSend === true && dbg().config?.readAloud === false, JSON.stringify(dbg().config))
  env.transcript = '关麦前先说完的一句。'
  setMicMode('ok')
  micButton().props.onClick()
  const listeningA = await waitFor(() => dbg().on === true, 4000)
  check('[复位A] 前置：开麦进聆听态', listeningA, JSON.stringify(dbg()))
  if (!listeningA) { bail(); return }
  const timersOn = dbg().timers ?? []
  check('[复位A] 开麦时聆听定时器在表里（vad / flush 都登记着）',
    timersOn.includes('vad') && timersOn.includes('flush'), JSON.stringify(timersOn))
  // 批次 6i-c 从 `test/timer-registry.test.mjs` 接过来的一条：那条写的是源码正则
  // 「createTimerRegistry(win) 出现，且 createTimerRegistry(window) 没出现」。
  // 负半边（写 `window` 就违规）归 eslint 的 globals 清单 + test/no-undef.test.mjs（全树跑，比这条正则强）；
  // 这里补的是**正半边**：登记表拿到的句柄确实出自注入的那个 win。
  //
  // 只数 interval，不数 timeout：整个客户端里只有登记表碰 `win.setInterval`
  // （vad / flush / shortcut / busy-poll 都是 interval），而 `win.setTimeout` 到处在用
  // （rAF 的替身、各种重试、合成兜底），拿 timeout 计数会把「登记表抓了全局」这件事洗掉。
  // 实测：把 `createTimerRegistry(win)` 改成 `createTimerRegistry(globalThis)` 再重新构建产物，
  // 数 timeout 的写法照样绿，数 interval 的这两条当场红（产物没重新构建时两条都察觉不到 ——
  // 本 harness 跑的是 lib/client.js，改 src 之后必须 build）。
  const intervalsOnWin = env.winTimerOps.filter((o) => o.op === 'set' && o.kind === 'interval').length
  check('[复位A] 登记表排 interval 用的是**注入的 win**（win 上数得到 interval 登记，改成抓全局就是 0 条）',
    intervalsOnWin >= 2, JSON.stringify({ intervalsOnWin, inTable: timersOn }))
  const saidA = await speakOnce({ loudTicks: 5, quietTicks: 3 })
  const pendingA = await waitFor(() => pendingIds().length > 0, 2000, 50)
  const submitsAfterSay = env.submits.length
  check('[复位A] 前置：这一句切出来并挂上了发送定时器（还没到点所以没发）',
    saidA && pendingA && env.submits.length === submitsAfterSay,
    JSON.stringify({ saidA, pending: pendingIds(), submits: env.submits.length }))
  micButton().props.onClick()
  const offA = await waitFor(() => dbg().on === false, 2000)
  check('[复位A] 关麦后聆听定时器从表里摘干净（不是只靠回调里那句早退）',
    offA && !(dbg().timers ?? []).some((id) => id === 'vad' || id === 'flush'),
    JSON.stringify(dbg().timers))
  // 名字从表里划掉还不够：句柄必须在**注入的 win** 上被清掉（只删自己那份 Map、
  // 真定时器照跑，是这张表要防的那类事）。整条链路上只有登记表会调 win.setInterval，
  // 所以「win 上 interval 的 clear 次数」能归到它头上。
  const intervalClears = env.winTimerOps.filter((o) => o.op === 'clear' && o.kind === 'interval').length
  check('[复位A] 关麦把聆听组的 interval 在**注入的 win** 上清掉了（清的是句柄，不只是划掉表里的名字）',
    intervalClears >= 2, JSON.stringify({ intervalClears }))
  check('[复位A] 关麦后发送定时器也从表里摘干净（clearGroup 真的清得到 = 登记时带了组名）',
    pendingIds().length === 0, JSON.stringify(pendingIds()))
  await sleep(2800)
  check('[复位A] 等过发送定时器的到点也不 submit（2026-10-31 那条故障：草稿自己跑掉了）',
    env.submits.length === submitsAfterSay,
    `多发 ${env.submits.length - submitsAfterSay} 次（用户已经停了对话，草稿却自己发出去）`)
  check('[复位A] 关麦后聆听轴归位（在听 / 在识别都是 false）',
    dbg().hearing === false && dbg().recognizing === false,
    JSON.stringify({ hearing: dbg().hearing, recognizing: dbg().recognizing }))

  /* ============ B. 卸载兜底：clearAll 真的跑到了 ============ */
  micButton().props.onClick()
  const listeningB = await waitFor(() => dbg().on === true, 4000)
  check('[复位B] 前置：再开麦进聆听态（on 翻转顺带重拉配置）', listeningB, JSON.stringify(dbg()))
  if (listeningB) {
    // 第二段换一个完全不同的文本：它写进草稿时**不该**带上第一段一个字。
    // 照实记一条实测结果：把 stopListening 里那六行 ref 清零全删掉，这条**照样绿** ——
    // 因为开麦路径（mic-button.js 的 1795-1803）把同一批 ref 又清了一遍。
    // 也就是说「关麦侧漏清」在行为上不可观测（两处任留一处都对），
    // 那六条正则按「纯写法的直接删」处理，不是被这条顶掉的。
    env.transcript = '关麦后再说的一句。'
    const saidB = await speakOnce({ loudTicks: 5, quietTicks: 3 })
    const pendingB = await waitFor(() => pendingIds().length > 0, 2000, 50)
    const writesBeforeUnmount = env.draftWrites.length
    const lastWriteB = env.draftWrites.at(-1) ?? ''
    check('[复位B] 再开麦说的第二句，草稿里只有这一句（旧段的字不残留）',
      saidB && pendingB && writesBeforeUnmount > 0 &&
        lastWriteB.includes('关麦后再说的一句。') && !lastWriteB.includes('关麦前先说完的一句。'),
      JSON.stringify({ lastWriteB, writes: writesBeforeUnmount }))
    const submitsBeforeUnmount = env.submits.length
    runtime.unmount()
    await sleep(2800)
    check('[复位B] 卸载时挂着的发送定时器到点也不发（卸载清全部）',
      saidB && pendingB && env.submits.length === submitsBeforeUnmount,
      JSON.stringify({ saidB, pendingB, extra: env.submits.length - submitsBeforeUnmount }))
  }

  /* ============ C. 关麦不碰朗读轴（两轴正交） ============ */
  env.config = { ...env.config, autoSend: false, readAloud: true, mode: 'toggle', silenceMs: 1500 }
  runtime.unmount()
  bootMic()
  await sleep(300)
  if (dbg().config?.readAloud !== true) {
    check('[复位C] 前置：朗读配置是开的', false, JSON.stringify(dbg().config))
    bail()
    return
  }
  env.audio.playMs = 1600
  const playedBeforeC = env.playedTexts.length
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'sr1' })
  emitSentence({ text: '关麦时正在响的那句。', turnId: 'sr1', index: 0, para: 0, paraStart: true })
  emitSentence({ text: '关麦时排在后面的那句。', turnId: 'sr1', index: 1, para: 0, paraStart: false })
  const startedC = await waitFor(() => liveSources().length >= 1, 4000)
  setMicMode('ok')
  micButton().props.onClick()
  const listeningC = await waitFor(() => dbg().on === true, 4000)
  check('[复位C] 前置：有一句正在响、麦也开着', startedC && listeningC,
    JSON.stringify({ startedC, listeningC, live: liveSources().length }))
  if (!startedC || !listeningC) { bail(); env.audio.playMs = 25; return }
  const playingC = liveSources()[0]
  micButton().props.onClick()
  await sleep(80)
  check('[复位C] 关麦没掐正在响的那个源（麦克风按钮只管聆听）',
    playingC.stopRequested !== true, JSON.stringify({ stopRequested: playingC.stopRequested }))
  check('[复位C] 关麦那一刻界面还显示「朗读中」（朗读轴不归 stopListening 管）',
    dbg().speaking === true, JSON.stringify({ speaking: dbg().speaking }))
  await sleep(env.audio.playMs + 900)
  check('[复位C] 这一轮两句照常播完（关麦没清掉朗读队列 / 朗读组定时器）',
    env.playedTexts.length === playedBeforeC + 2,
    JSON.stringify({ played: env.playedTexts.length - playedBeforeC, texts: env.playedTexts }))

  /* ============ D. 手动静音：开关麦都不解除 ============ */
  await drain()
  // drain 只管「源都播完了」；朗读状态要它自己落回 false，按钮才会消失。
  await waitFor(() => dbg().speaking === false, 4000)
  env.audio.playMs = 2000
  check('[复位D] 没在朗读时树里找不到「停止朗读」按钮（它只在朗读中出现）',
    !stopBtn(), JSON.stringify({ speaking: dbg().speaking, found: Boolean(stopBtn()) }))
  const playedBeforeD = env.playedTexts.length
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'sr2' })
  emitSentence({ text: '静音前正在响的那句。', turnId: 'sr2', index: 0, para: 0, paraStart: true })
  emitSentence({ text: '静音前排在后面的那句。', turnId: 'sr2', index: 1, para: 0, paraStart: false })
  const startedD = await waitFor(() => liveSources().length >= 1, 4000)
  await sleep(80)
  const btnD = stopBtn()
  check('[复位D] 前置：这一轮真的在响，朗读中也找得到「停止朗读」按钮',
    startedD && Boolean(btnD?.props?.onClick),
    JSON.stringify({ startedD, live: liveSources().length, speaking: dbg().speaking,
      queue: dbg().queue, muted: dbg().muted, played: env.playedTexts.length - playedBeforeD }))
  if (!btnD?.props?.onClick) { bail(); env.audio.playMs = 25; return }
  const playingD = liveSources()[0]
  check('[复位D] 前置：这一句的段落号已钉进裁剪保护值（快照 playingPara=0）',
    dbg().playingPara === 0, JSON.stringify({ playingPara: dbg().playingPara }))
  btnD.props.onClick()
  await sleep(80)
  check('[复位D] 前置：这一轮被标成静音', dbg().muted === 'sr2', JSON.stringify({ muted: dbg().muted }))
  check('[复位D] 点停止把正在响的那句当场掐掉（不是等它自己念完）',
    Boolean(playingD) && playingD.stopRequested === true,
    JSON.stringify({ has: Boolean(playingD), stopRequested: playingD?.stopRequested }))
  check('[复位D] 点停止同时把裁剪保护值复位成 -1（halt 这条路径 —— 批次 6f 用真跑替掉「复位点至少三处」那条源码计数）',
    dbg().playingPara === -1, JSON.stringify({ playingPara: dbg().playingPara }))
  check('[复位D] 点停止那一刻「朗读中」标记就消失', dbg().speaking === false,
    JSON.stringify({ speaking: dbg().speaking }))
  await sleep(900)
  check('[复位D] 停止时排在队列里的那句不再播（队列真被清了，不靠代次慢慢失效）',
    !env.playedTexts.includes('静音前排在后面的那句。'),
    JSON.stringify(env.playedTexts.slice(-3)))
  const playedAfterStop = env.playedTexts.length
  micButton().props.onClick()
  const listeningD = await waitFor(() => dbg().on === true, 4000)
  emitSentence({ text: '开麦之后的同轮句子。', turnId: 'sr2', index: 2, para: 0, paraStart: false })
  await sleep(500)
  check('[复位D] 开麦不解除手动静音（那是用户的意图，不是故障）',
    listeningD && env.playedTexts.length === playedAfterStop,
    JSON.stringify({ listeningD, played: env.playedTexts.length - playedAfterStop }))
  micButton().props.onClick()
  await waitFor(() => dbg().on === false, 2000)
  emitSentence({ text: '关麦之后的同轮句子。', turnId: 'sr2', index: 3, para: 0, paraStart: false })
  await sleep(500)
  check('[复位D] 关麦同样不解除静音', env.playedTexts.length === playedAfterStop,
    JSON.stringify({ played: env.playedTexts.length - playedAfterStop }))
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'sr3' })
  emitSentence({ text: '新一轮的第一句。', turnId: 'sr3', index: 0, para: 0, paraStart: true })
  const resumed = await waitFor(() => env.playedTexts.length === playedAfterStop + 1, 4000)
  check('[复位D] 只有真正的新轮才解除静音（这一句念得出来）', resumed,
    JSON.stringify({ muted: dbg().muted, played: env.playedTexts.length - playedAfterStop }))

  /* ============ E. once 模式：只关聆听，不动朗读 ============ */
  await drain()
  env.config = { ...env.config, autoSend: true, readAloud: true, mode: 'once', silenceMs: 200, autoSendExtraMs: 1200 }
  runtime.unmount()
  bootMic()
  await sleep(300)
  check('[复位E] 前置：once 配置读到（快照里的 mode）', dbg().config?.mode === 'once',
    JSON.stringify(dbg().config))
  env.audio.playMs = 3000
  setMicMode('ok')
  micButton().props.onClick()
  const listeningE = await waitFor(() => dbg().on === true, 4000)
  check('[复位E] 前置：开麦进聆听态', listeningE, JSON.stringify(dbg()))
  if (!listeningE) { bail(); env.audio.playMs = 25; return }
  // 先把这一句说完，**再**让回复进来 —— 这个顺序是被打脸打出来的：
  // 一边大声说话一边朗读会命中 vad 里的「插话停朗读」（rms > 0.012 连续 4 次
  // → haltSpeaking(true)），那是另一条正确行为，会把本段真正要判的
  // 「once 退出动没动朗读轴」顶成假红（实测：第一句被中途掐掉、第二句整条消失）。
  const saidE = await speakOnce({ loudTicks: 6, quietTicks: 3 })
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'oc1' })
  emitSentence({ text: 'once 退出时正在响的那句。', turnId: 'oc1', index: 0, para: 0, paraStart: true })
  emitSentence({ text: 'once 退出时排在后面的那句。', turnId: 'oc1', index: 1, para: 0, paraStart: false })
  const autoOff = await waitFor(() => dbg().on === false, 4000)
  const liveAtOff = liveSources()
  check('[复位E] once：说完一句自动退出聆听态', saidE && autoOff,
    JSON.stringify({ saidE, autoOff, on: dbg().on }))
  check('[复位E] 前置：自动关麦这一刻真有一句在响（否则下一条是空判）',
    liveAtOff.length >= 1, JSON.stringify({ live: liveAtOff.length, speaking: dbg().speaking, queue: dbg().queue }))
  check('[复位E] once 退出没掐正在响的源（以前这里调 stopAll，一轮一句都读不出来）',
    liveAtOff.every((s) => s.stopRequested !== true),
    JSON.stringify(liveAtOff.map((s) => s.stopRequested)))
  await sleep(env.audio.playMs * 2 + 1200)
  check('[复位E] once 这一轮的两句照样播完（队列没被退出清掉）',
    env.playedTexts.includes('once 退出时正在响的那句。') &&
      env.playedTexts.includes('once 退出时排在后面的那句。'),
    JSON.stringify({ skipped: dbg().playSkipped, dropped: dbg().dropped, trimmed: dbg().trimmed }))

  /* ============ F. 卸载把两轴一起收（stopAll 的行为面） ============ */
  // E 段结束时麦已经自动关了，这里只验朗读轴的卸载兜底。
  await drain()
  env.audio.playMs = 3000
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'uf1' })
  emitSentence({ text: '卸载时正在响的那句。', turnId: 'uf1', index: 0, para: 0, paraStart: true })
  emitSentence({ text: '卸载时排在后面的那句。', turnId: 'uf1', index: 1, para: 0, paraStart: false })
  const startedF = await waitFor(() => liveSources().length >= 1, 4000)
  const liveF = liveSources()
  runtime.unmount()
  await sleep(150)
  check('[复位F] 前置：卸载前真的有一句在响（否则下一条是空判）',
    startedF && liveF.length >= 1, JSON.stringify({ startedF, live: liveF.length }))
  check('[复位F] 卸载把正在响的那句掐掉（组件没了不该留下一段没人管的声音）',
    liveF.length >= 1 && liveF.every((s) => s.stopRequested === true),
    JSON.stringify(liveF.map((s) => s.stopRequested)))
  await sleep(env.audio.playMs + 600)
  check('[复位F] 卸载后排队的句子不再播（朗读队列跟着清，不靠代次自增慢慢失效）',
    !env.playedTexts.includes('卸载时排在后面的那句。'),
    JSON.stringify(env.playedTexts.slice(-3)))
  // 后面的场景与文件收尾的 settle() 都要有一个活着的组件。
  bootMic()
  await sleep(300)

  check('[状态复位] 整个过程没有异常甩进 effect / handler',
    env.warnings.length === 0, env.warnings.join('\n'))
  await settle()
  env.audio.playMs = 25
  bail()
}

/* ------------------------------------------------------------------ */
/* 场景 20：识别请求当场失败 —— 实时字不丢、链路不卡死                   */
/* ------------------------------------------------------------------ */
/**
 * 这一场景替掉的是 `test/timer-registry.test.mjs` 里三条写法判据：
 *   「keptPartial 在 try 之前取」「catch 分支能拿到 keptPartial」
 *   「自动发送的判断在 catch 之前（异常时也能走）」。
 * 它们守的是同一件用户能感觉到的事：**话说到一半宿主重启 / 网络断了，
 * 我说过的字不该凭空消失，麦克风也不该从此变成瞎子。**
 * 写法判据的实际代价是反过来的：`transcribeSegment` 一改结构（比如把 try 拆成 helper）
 * 这三条就红，而行为一模一样 —— 于是它逼着下一个改代码的人「别动结构」，
 * 而不是「别丢用户的字」。
 *
 * 驱动方式：先正常说完第一段（证明这条链路本来跑得通），再为第二段
 * **手动推 10 拍有声帧**让 900ms 的实时字通路先把半句写进草稿，
 * 然后把 `/transcribe` 改成**当场失败**（fetch 直接 reject，不是返回错误码），
 * 再推静音让 VAD 断句 —— 失败就落在那个 catch 上。
 * 顺序不能反：实时字必须在失败之前落地，否则 catch 里根本没有「已经听到的部分」可留。
 */
async function scenarioRecognizeFailure() {
  await settle()
  resetEnv()
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  const savedConfig = { ...env.config }
  const transcribeCount = () => env.fetchLog.filter((f) => String(f.url).includes('/transcribe')).length
  /** 组件最近一次写进 composer 的整份文本（判「说的话在不在输入框里」看这个）。 */
  const lastDraft = () => env.draftWrites[env.draftWrites.length - 1] ?? ''
  const processor = () => env.mic.processors[env.mic.processors.length - 1]
  const pushFrames = async (ticks, loud) => {
    for (let i = 0; i < ticks; i++) {
      env.mic.level = loud ? 0.05 : 0
      processor()?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(loud ? 0.05 : 0) },
      })
      await sleep(110)
    }
  }
  env.config = { ...env.config, autoSend: true, readAloud: false, silenceMs: 200, autoSendExtraMs: 400 }
  runtime.unmount()
  bootMic()
  await sleep(300)
  setMicMode('ok')
  micButton().props.onClick()
  const listening = await waitFor(() => dbg().on === true, 4000)
  check('[识别失败] 前置：开麦进聆听态', listening, JSON.stringify(dbg()))
  if (!listening) {
    env.config = savedConfig
    env.transcript = ''
    setMicMode('no-device')
    return
  }

  /* ---- 一、第一段先正常走通（否则后面的「失败」根本算不上回归）---- */
  env.transcript = '第一段说完了。'
  const said1 = await speakOnce({ loudTicks: 6, quietTicks: 4 })
  const wrote1 = await waitFor(() => lastDraft().includes('第一段说完了。'), 4000)
  check('[识别失败] 前置：第一段识别成功、字进了草稿（后面要保住的就是这一类字）',
    said1 && wrote1, JSON.stringify({ said1, last: lastDraft() }))

  /* ---- 二、第二段：实时字先落地，再让断句那一次当场失败 ---- */
  env.transcript = '第二段只听到一半。'
  await pushFrames(10, true)
  const wrotePartial = await waitFor(() => lastDraft().includes('第二段只听到一半。'), 3000, 50)
  check('[识别失败] 前置：第二段的实时字进了草稿（后面判的就是它别凭空消失）',
    wrotePartial, JSON.stringify({ last: lastDraft() }))
  env.transcribeFail = true
  const writesAtFail = env.draftWrites.length
  const submitsBeforeFail = env.submits.length
  await pushFrames(6, false)
  const hinted = await waitFor(() => treeHasText(runtime.getTree(), 'recognizeFailed'), 3000)
  const rewrote = env.draftWrites.length > writesAtFail
  check('[识别失败] 前置：断句那一次真的失败了，并且状态行提示了原因',
    hinted && transcribeCount() > 0,
    JSON.stringify({ hinted, transcribes: transcribeCount() }))
  check('[识别失败] 失败那一次把已经听到的字写回草稿（catch 里真的重拼了一次，不是只提示）',
    rewrote && lastDraft().includes('第二段只听到一半。'),
    JSON.stringify({ rewrote, last: lastDraft() }))
  await sleep(700)
  check('[识别失败] 失败那一次不抢发（没拿到最终稿就不该把半句发出去）',
    env.submits.length === submitsBeforeFail, `多发 ${env.submits.length - submitsBeforeFail} 次`)
  check('[识别失败] 异常没甩出 effect / handler（catch 里再抛会吞掉后面整段逻辑）',
    env.warnings.length === 0, env.warnings.join('\n'))
  const released = await waitFor(() => dbg().recognizing === false, 3000)
  check('[识别失败] 「识别中」标志复位（卡在 true = 之后每段都被跳过，麦克风变瞎子）',
    released, JSON.stringify({ recognizing: dbg().recognizing }))
  check('[识别失败] 超时定时器用完就摘（失败路径也要清 transcribe-abort）',
    !(dbg().timers ?? []).includes('transcribe-abort'), JSON.stringify(dbg().timers))

  /* ---- 三、宿主恢复：链路还活着，该识别的识别、该发的发 ---- */
  env.transcribeFail = false
  env.transcript = '第三段恢复正常。'
  const submitsBeforeRecover = env.submits.length
  const said3 = await speakOnce({ loudTicks: 6, quietTicks: 4 })
  const wrote3 = await waitFor(() => lastDraft().includes('第三段恢复正常。'), 4000)
  check('[识别失败] 一次失败之后还能识别（不永久失聪）',
    said3 && wrote3, JSON.stringify({ said3, last: lastDraft() }))
  const sentAgain = await waitFor(() => env.submits.length === submitsBeforeRecover + 1, 3000)
  check('[识别失败] 恢复后的这一句照常自动发送（失败没把发送通路一起打死）',
    sentAgain, `submits 增加 ${env.submits.length - submitsBeforeRecover}`)

  check('[识别失败] 整个过程没有异常甩出组件', env.warnings.length === 0, env.warnings.join('\n'))
  micButton().props.onClick()
  await waitFor(() => dbg().on === false, 2000)
  await settle()
  env.config = savedConfig
  env.transcript = ''
  env.transcribeFail = false
  setMicMode('no-device')
}

/* ------------------------------------------------------------------ */
/* 场景 21（批次 4d）：播放上下文「挂多久」的三档 + 首次手势预热          */
/* ------------------------------------------------------------------ */
/**
 * 替掉 read-aloud-stop 里五条只看写法的判据（play 在 start 前 await resume /
 * 轮询到 8 秒 / 仍挂起就跳过并计数 / 轮询中代次失效早退 / 首次手势预热）。
 *
 * 它们防的症状是同一个：「/tts 一直在调、界面显示朗读中、却一句都不出声」。
 * 这个症状**只有真实等待时长能区分**：假上下文原来一被 resume 就立刻 running，
 * 「挂很久」这一档在 harness 里根本不存在（批次 3 把原因写死在那文件头）。
 * 现在 `env.audio.neverResume` 能演「浏览器始终不给播放权限」，四档都跑得起：
 *   A 永不恢复 → 等满 8 秒兜底、这一句不播、playSkipped 涨、它照样 ack、
 *     上下文后来能恢复时下一句照播（管道没被这一次死锁）；
 *   B A 的半途换轮 → halt 之后 1 秒内 playSkipped 就涨（轮询里那次代次复查顶上，
 *     少了它用户点「停止朗读」后还要再白等 7 秒）；
 *   C 3 秒才恢复 → 这一句仍然播得出来（证明不是「等 1 秒就静默丢句」——
 *     那正是改成轮询之前的缺陷）；
 *   D 首次手势 → 一次 pointerdown / keydown 就把常驻上下文建起来并 resume
 *     （朗读跟语音模式无关，没开麦克风时只有这条路径会去恢复它）。
 *
 * 这一场景给全套多付约 12 秒（A 的 8 秒 + C 的 3 秒），是**故意**的：
 * 这几条判据防的就是时长，把时间压掉就等于没判。
 */
async function scenarioCtxResumeWaits() {
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}

  /* ---- A：怎么 resume 都不恢复 ---- */
  await settle()
  resetEnv()
  env.audio = { mode: 'starts-suspended', playMs: 25, suspendUntil: 0, neverResume: true }
  closeAllAudioContexts()
  await remountFresh()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'rs-a' })
  const skippedA = dbg().playSkipped ?? 0
  const tA = Date.now()
  emitSentence({ text: '播放上下文永远不恢复的这一句。', turnId: 'rs-a', index: 0, para: 0, paraStart: true })
  const skipped = await waitFor(() => (dbg().playSkipped ?? 0) > skippedA, 15000, 100)
  const waitedA = Date.now() - tA
  check('[挂起·永不恢复] 这一句被跳过并在诊断里留下 playSkipped（不是静默消失）',
    skipped, JSON.stringify({ skipped: dbg().playSkipped, base: skippedA }))
  check('[挂起·永不恢复] 这一句确实没播', !env.playedTexts.includes('播放上下文永远不恢复的这一句。'),
    JSON.stringify(env.playedTexts))
  check('[挂起·永不恢复] 被跳过的一句照样 ack（宿主不等 watchdog）', ackTotal() === 1, `acks=${ackTotal()}`)
  // 兜底上限是 8 秒：等得明显短说明上限被改小了（8000 改成 1000 会在这里红，
  // 那正是「resume 稍慢就每句都被静默丢弃」的原症状）。
  check('[挂起·永不恢复] 放弃之前等满了 8 秒兜底（不是 1 秒就丢句）', waitedA >= 6000, `等了 ${waitedA}ms`)
  // 死锁判据：上下文恢复之后，下一句必须还能播出去。
  env.audio.neverResume = false
  env.audio.suspendUntil = 1 // 已经过去的时刻：下一次 resume 就真恢复
  emitSentence({ text: '上下文恢复后的这一句。', turnId: 'rs-a', index: 1, para: 0, paraStart: false })
  const recovered = await waitFor(() => env.playedTexts.includes('上下文恢复后的这一句。'), 6000)
  check('[挂起·永不恢复] 跳过一句之后管道没死锁：上下文一恢复下一句照播', recovered, JSON.stringify(env.playedTexts))
  check('[挂起·永不恢复] 两句各 ack 一次', ackTotal() === 2, `acks=${ackTotal()}`)

  /* ---- B：挂起等待期间换轮 ---- */
  await settle()
  resetEnv()
  env.audio = { mode: 'starts-suspended', playMs: 25, suspendUntil: 0, neverResume: true }
  closeAllAudioContexts()
  await remountFresh()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'rs-b1' })
  const skippedB = dbg().playSkipped ?? 0
  emitSentence({ text: '挂起期间被换轮丢掉的那一句。', turnId: 'rs-b1', index: 0, para: 0, paraStart: true })
  await sleep(600) // 让它进到 resume 轮询里
  const tHalt = Date.now()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'rs-b2' })
  const early = await waitFor(() => (dbg().playSkipped ?? 0) > skippedB, 3000, 50)
  const sinceHalt = Date.now() - tHalt
  check('[挂起·半途换轮] halt 之后 1 秒内 playSkipped 就涨（轮询里每次都复查代次）',
    early && sinceHalt <= 1000, `halt 后 ${sinceHalt}ms，playSkipped=${dbg().playSkipped}/${skippedB}`)
  check('[挂起·半途换轮] 被 halt 的那一句没有出声', !env.playedTexts.includes('挂起期间被换轮丢掉的那一句。'),
    JSON.stringify(env.playedTexts))

  /* ---- C：3 秒才恢复 ---- */
  await settle()
  resetEnv()
  env.audio = { mode: 'starts-suspended', playMs: 25, suspendUntil: 0, neverResume: false }
  closeAllAudioContexts()
  await remountFresh()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'rs-c' })
  const tC = Date.now()
  // 恢复时刻从「句子真开始等」那一刻起算（挂载那 300 毫秒不该算进 3 秒里）。
  env.audio.suspendUntil = Date.now() + 3000
  emitSentence({ text: '慢恢复也应当念出来的这一句。', turnId: 'rs-c', index: 0, para: 0, paraStart: true })
  const playedC = await waitFor(() => env.playedTexts.includes('慢恢复也应当念出来的这一句。'), 8000)
  check('[挂起·慢恢复] 等 3 秒才 running 的上下文，这一句仍然播得出来（不是超 1 秒就丢）',
    playedC, JSON.stringify({ played: env.playedTexts.length, ms: Date.now() - tC }))
  check('[挂起·慢恢复] 等待是真的等了（>=2 秒；秒内就播出说明它没等 resume）',
    Date.now() - tC >= 2000, `播出用了 ${Date.now() - tC}ms`)
  check('[挂起·慢恢复] 这一句 ack 一次', ackTotal() === 1, `acks=${ackTotal()}`)

  /* ---- D：首次用户手势预热 ---- */
  await settle()
  resetEnv()
  await remountFresh()
  env.audio = { mode: 'starts-suspended', playMs: 25, suspendUntil: 0, neverResume: true }
  // 常驻上下文是模块级单例，外面点不到名 —— 把「建过的每一个」都关掉，
  // `getPlayCtx()` 才只剩「新建」这一条路，「手势把上下文建起来」才判得动。
  closeAllAudioContexts()
  check('[手势预热] 前置：window 上装着 pointerdown / keydown 两条预热监听（模块初始化时挂的，不是扫源码）',
    (windowAddListeners.get('pointerdown') ?? new Set()).size > 0
    && (windowAddListeners.get('keydown') ?? new Set()).size > 0,
    JSON.stringify({ pointer: (windowAddListeners.get('pointerdown') ?? new Set()).size, key: (windowAddListeners.get('keydown') ?? new Set()).size }))
  const beforePointer = env.audio.resumeCalls ?? 0
  fakeWindow.dispatchEvent({ type: 'pointerdown' })
  await sleep(50)
  check('[手势预热] 一次 pointerdown 就把常驻播放上下文建起来（没开麦克风也有路径恢复它）',
    env.audioContexts.length === 1, JSON.stringify(env.audioContexts.map((c) => c.state)))
  check('[手势预热] 建起来当场 resume（自动播放策略下不 resume 会一直 suspended、句子全被跳过）',
    (env.audio.resumeCalls ?? 0) > beforePointer, `resumeCalls=${beforePointer} → ${env.audio.resumeCalls}`)
  const beforeKey = env.audio.resumeCalls ?? 0
  dispatchKey({ key: 'x' })
  await sleep(50)
  // 假 window 不实现 `once: true`（撤监听只按函数引用），所以这里判的是
  // 「keydown 那一路也装着」，判不出「只响一次」—— 记在这儿，别当成已覆盖。
  check('[手势预热] keydown 那一路同样会预热',
    (env.audio.resumeCalls ?? 0) > beforeKey, `resumeCalls=${beforeKey} → ${env.audio.resumeCalls}`)
  check('[手势预热] 预热只是把上下文弄好，不会自己开始念',
    env.playedTexts.length === 0 && ackTotal() === 0, JSON.stringify({ played: env.playedTexts.length, acks: ackTotal() }))
}

/* ------------------------------------------------------------------ */
/* 场景 22（批次 4d）：回执账目的字段都从外部数得出来                     */
/* ------------------------------------------------------------------ */
/**
 * 替掉 read-aloud-stop 里两条写法判据：
 *   - 「回执可带真实音频时长（durationMs）」：原来只正则到代码里出现过这个字；
 *   - 「回执用 payload 里的 sessionId/turnId（不是本地 ref）」里**判得动的那一半**。
 *
 * 「payload.sessionId 优先」这一半判不出来，写在这儿而不是假装覆盖：
 * `belongsToSession` 会先把「会话 id 不是本地这一份」的 payload 整条丢掉，
 * 换个 sessionId 就根本没有回执可比（场景 22 第三段判的是回落那半）。
 */
async function scenarioAckAttribution() {
  await settle()
  resetEnv()
  await remountFresh()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'at1' })
  env.ttsBehavior = (text) => (text.includes('合不成') ? { ok: false, status: 500 } : { ok: true, status: 200 })
  emitSentence({ text: '播得出来的这一句。', turnId: 'at1', index: 0, para: 0, paraStart: true })
  emitSentence({ text: '合不成的这一句。', turnId: 'at1', index: 1, para: 0, paraStart: false })
  const acked2 = await waitFor(() => ackTotal() >= 2, 6000)
  await sleep(150)
  check('[回执账目] 前置：两句各回执一次', acked2 && ackTotal() === 2, `acks=${ackTotal()}`)
  check('[回执账目] 真播出音频的那条带真实时长（宿主拿它算追赶预算，写死 0 就白等）',
    env.acks.some((a) => a.durationMs === env.audio.playMs), JSON.stringify(env.acks))
  check('[回执账目] 没播成的那条不带时长（宿主不该为没念出的内容预留播放时间）',
    env.acks.some((a) => a.durationMs === undefined), JSON.stringify(env.acks))

  await settle()
  resetEnv()
  await remountFresh()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'at2' })
  // 信封里没带 sessionId（老宿主 / 内部转发丢了这一项）：回执要落回组件自己这一份会话。
  emitSentence({ text: '没带会话 id 的这一句。', turnId: 'at2', index: 0, para: 0, paraStart: true, omitSessionId: true })
  const ackedOne = await waitFor(() => ackTotal() >= 1, 5000)
  await sleep(100)
  check('[回执账目] 句子没带 sessionId 时回执落到本地会话（不是空串，否则宿主记不上账）',
    ackedOne && env.acks.length === 1 && env.acks[0].sessionId === 'sess-1', JSON.stringify(env.acks))
  check('[回执账目] 同一条回执带的是这一轮的 turnId',
    env.acks[0]?.turnId === 'at2', JSON.stringify(env.acks[0]))
  check('[回执账目] 这一句照播（缺 sessionId 不影响出声）',
    env.playedTexts.includes('没带会话 id 的这一句。'), JSON.stringify(env.playedTexts))
}

/* ------------------------------------------------------------------ */
/* 场景 23（批次 4d）：配置同步必须真的拿到「朗读回复」那一份             */
/* ------------------------------------------------------------------ */
/**
 * 替掉 read-aloud-stop 里四条写法判据（配置与存储合并 / 不再用 loaded 整份丢弃 /
 * 拉取失败会重试 / 开麦时再对一次配置）。
 *
 * 四条防的是同一类装机故障：「设置里勾了朗读却不出声，而且全程没有报错」——
 * configRef 停在默认值（readAloud:false）时就是这个样子。
 * 配置只在**挂载**和 **`on` 翻转**时拉（没有轮询），所以每段都要 `unmount + bootMic` 重挂一次，
 * 改 `env.config` 才可能被读到（批次 4 记的坑 3）。
 */
async function scenarioConfigSync() {
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  const store = exportsObj.__test.configStore
  const savedConfig = { ...env.config }
  const configGets = () => env.fetchLog.filter((f) => String(f.url).includes('/config') && f.method === 'GET').length
  const remount = remountFresh

  /* ---- ① 存储里有值的键优先（刚保存的那一份不被 fetch 盖掉） ---- */
  await settle()
  resetEnv()
  store.value = { readAloud: false }
  store.loaded = true
  env.config.readAloud = true
  await remount()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'cf1' })
  emitSentence({ text: '存储说别念的这一句。', turnId: 'cf1', index: 0, para: 0, paraStart: true })
  await sleep(600)
  check('[配置同步] 共享存储里有值的键优先（刚取消的朗读不被挂载那次 fetch 请回来）',
    !env.playedTexts.includes('存储说别念的这一句。'), JSON.stringify(env.playedTexts))
  check('[配置同步] 不念的那句照样 ack', ackTotal() === 1, `acks=${ackTotal()}`)

  /* ---- ② 拉到的配置照样合并：loaded 不能再整份丢掉这次 fetch ---- */
  await settle()
  resetEnv()
  // 面板只存过一个无关键，但 loaded=true。旧写法是「loaded 就直接 return」，
  // 于是 configRef 停在这份只有无关键的存储上 → readAloud 永远不是 true → 永远不出声。
  store.value = { someOtherKey: 'x' }
  store.loaded = true
  env.config.readAloud = true
  await remount()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'cf2' })
  emitSentence({ text: '勾了朗读就该念的这一句。', turnId: 'cf2', index: 0, para: 0, paraStart: true })
  const played2 = await waitFor(() => env.playedTexts.includes('勾了朗读就该念的这一句。'), 5000)
  check('[配置同步] 存储 loaded 时这次 fetch 照样合并进来（旧缺陷：configRef 永远停在默认值 → 勾了不出声）',
    played2, JSON.stringify({ played: env.playedTexts, fetches: configGets() }))

  /* ---- ③ 首次拉取失败要重试 ---- */
  await settle()
  resetEnv()
  env.configFailTimes = 1
  env.config.readAloud = true
  const getsBefore = configGets()
  await remount()
  const retried = await waitFor(() => configGets() - getsBefore >= 2, 4000, 50)
  check('[配置同步] GET /config 第一次失败会重试（一次静默失败就永远停在默认值）',
    retried, `重试期间共 ${configGets() - getsBefore} 次 GET`)
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'cf3' })
  emitSentence({ text: '重试之后念出的这一句。', turnId: 'cf3', index: 0, para: 0, paraStart: true })
  const played3 = await waitFor(() => env.playedTexts.includes('重试之后念出的这一句。'), 5000)
  check('[配置同步] 重试拿到的配置真的生效（这一句念出来了）', played3, JSON.stringify(env.playedTexts))

  /* ---- ④ 开麦时再对一次配置 ---- */
  await settle()
  resetEnv()
  env.config.readAloud = true
  await remount()
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'cf4' })
  emitSentence({ text: '开麦前念得出的这一句。', turnId: 'cf4', index: 0, para: 0, paraStart: true })
  const played4 = await waitFor(() => env.playedTexts.includes('开麦前念得出的这一句。'), 5000)
  check('[配置同步·开麦] 前置：挂载拉到的配置让这一句念得出来', played4, JSON.stringify(env.playedTexts))
  // 用户在设置里把朗读关了（宿主那份变了；组件只在挂载/开麦时拉）。
  env.config.readAloud = false
  setMicMode('ok')
  micButton().props.onClick()
  const opened = await waitFor(() => dbg().on === true, 4000)
  check('[配置同步·开麦] 前置：开麦进聆听态', opened, JSON.stringify(dbg()))
  emitSentence({ text: '关掉朗读后又说的这一句。', turnId: 'cf4', index: 1, para: 0, paraStart: false })
  await sleep(700)
  check('[配置同步·开麦] 开麦时再对一次配置：刚关掉的朗读当场不再念',
    !env.playedTexts.includes('关掉朗读后又说的这一句。'), JSON.stringify(env.playedTexts))
  check('[配置同步·开麦] 不念的这句照样 ack（配额得还给宿主）', ackTotal() === 2, `acks=${ackTotal()}`)
  if (opened) {
    micButton().props.onClick()
    await waitFor(() => dbg().on === false, 2000)
  }
  setMicMode('no-device')

  /* ---- ⑤ 按钮不许把「拉到的快照」写回共享存储（批次 6h，docs §8.41）---- */
  // 这一段替掉 `test/config-writeback.test.mjs` 的四条源码正则
  // （「MicButton 函数体内没有 configStore.set( 」「有 configRef.current = next」
  //  「有 configStore.subscribe」「写入点不落在按钮行号区间内」）。
  // 症状写在 config-writeback 的文件头：取消朗读后，早先发出的那次 GET /config
  // 晚一步回来，把 readAloud=true 写回共享存储，朗读又自己回来了。
  // 现在判的是同一件事的可观测面：**存储里的值有没有被按钮改掉**。
  // 办法是给存储的 set 挂一个计数探针（真函数照常跑，只是顺手记一笔账），
  // 于是「按钮回写了几次」是数出来的，不是从源码行号区间里读出来的。
  await settle()
  resetEnv()
  env.config = { ...savedConfig, readAloud: true }
  store.value = { readAloud: false }
  store.loaded = true
  let writebacks = 0
  const realSet = store.set
  store.set = function countedSet(next) { writebacks += 1; return realSet.call(this, next) }
  await remount()                       // 挂载 → GET /config 回来的是 readAloud:true 那份过期快照
  await sleep(400)
  check('[配置同步·回写] 挂载那次 fetch 没往共享存储写任何东西（探针数到 0 次）',
    writebacks === 0, `configStore.set 被调了 ${writebacks} 次`)
  check('[配置同步·回写] 存储里仍是用户刚保存的那一份（readAloud 还是 false，过期快照没混进去）',
    JSON.stringify(store.value) === JSON.stringify({ readAloud: false }), JSON.stringify(store.value))
  check('[配置同步·回写] 按钮自己读到的是「存储优先」的合并值',
    dbg().config?.readAloud === false, JSON.stringify(dbg().config))
  store.set = realSet
  // 设置面板才是共享存储的权威写入方：它存一份，按钮要当场跟上（订阅 → configRef）。
  store.set({ readAloud: true, mode: 'hold' })
  const followed = await waitFor(
    () => dbg().config?.mode === 'hold' && dbg().config?.readAloud === true,
    2000,
  )
  check('[配置同步·回写] 面板保存后按钮订阅到新值，configRef 当场跟上（存储写满一次也没回写）',
    followed, JSON.stringify(dbg().config))
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'cf5' })
  emitSentence({ text: '面板刚开启朗读就该念的这句。', turnId: 'cf5', index: 0, para: 0, paraStart: true })
  const played5 = await waitFor(() => env.playedTexts.includes('面板刚开启朗读就该念的这句。'), 5000)
  check('[配置同步·回写] 订阅回来的 readAloud 是真的在用（这一句念出来了）',
    played5, JSON.stringify(env.playedTexts))
  // 再把朗读关掉，走**开麦重拉**那条路径（挂载之后 configRef 只在这两个地方被 fetch 覆盖）。
  store.set({ readAloud: false })
  const storeBeforeSecondPull = JSON.stringify(store.value)
  let writebacks2 = 0
  store.set = function countedSet2(next) { writebacks2 += 1; return realSet.call(this, next) }
  setMicMode('ok')
  micButton().props.onClick()
  const opened5 = await waitFor(() => dbg().on === true, 4000)
  await sleep(400)                      // 开麦那次 syncConfig 的 fetch 回来
  check('[配置同步·回写] 开麦重拉的那一次同样不回写（探针再数到 0 次）',
    writebacks2 === 0, `configStore.set 被调了 ${writebacks2} 次`)
  check('[配置同步·回写] 重拉之后存储没变，按钮读到的还是刚保存的 readAloud:false',
    JSON.stringify(store.value) === storeBeforeSecondPull && dbg().config?.readAloud === false,
    JSON.stringify({ store: store.value, config: dbg().config }))
  store.set = realSet
  if (opened5) {
    micButton().props.onClick()
    await waitFor(() => dbg().on === false, 2000)
  }
  setMicMode('no-device')
  check('[配置同步·回写] 这一整段跑下来没有异常甩进事件回调',
    env.warnings.length === 0, env.warnings.join('\n'))

  env.config = savedConfig
  await remount()
}

/* ------------------------------------------------------------------ */
/* 场景 24（批次 4d）：朗读高亮炸了，句子照样播、照样回执                 */
/* ------------------------------------------------------------------ */
/**
 * 替掉 read-aloud-stop 里 P3 那条「高亮 set 用 try/catch 包住」。
 *
 * 原来只能扫那三行写法，原因写在它上面：harness 里的高亮 ref 是「别人装上的正常对象」，
 * 不会抛错。现在假 document 的 `querySelector` 能当场炸（`set()` 第一步就是
 * `ensureStyle()` → `doc.querySelector(...)`，所以异常从 `set()` **同步**冲出来），
 * 判的是冲出去之后会发生什么：
 *   - 这一句照播、这条照 ack（高亮不是关键路径）；
 *   - 异常不许从 pumpQueue 甩出去（甩出去 = 顶层 unhandled rejection，
 *     本 harness 现在把它记进 env.warnings —— 以前它会直接把进程掀了）。
 */
async function scenarioHighlightThrows() {
  await settle()
  resetEnv()
  await remountFresh()
  // 抛错开关要**在重挂之后**才打开：高亮的 `dispose()` 也走 `doc.querySelector`，
  // 挂载前打开会把「上一个实例正常卸载」变成一条假异常（本轮踩过）。
  env.domQueryThrows = true
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'hl1' })
  emitSentence({ text: '高亮炸了也要念的第一句。', turnId: 'hl1', index: 0, para: 0, paraStart: true })
  emitSentence({ text: '高亮炸了也要念的第二句。', turnId: 'hl1', index: 1, para: 0, paraStart: false })
  const played2 = await waitFor(() => env.playedTexts.length >= 2, 6000)
  await sleep(200)
  check('[高亮抛错] 两句都播出来（样式/容器查不到不影响出声）',
    played2 && env.playedTexts.length === 2, JSON.stringify(env.playedTexts))
  check('[高亮抛错] 两句各 ack 一次（宿主不等 watchdog）', ackTotal() === 2, `acks=${ackTotal()}`)
  check('[高亮抛错] 异常没从朗读管道冲出去（try/catch 兜住 = 没有 unhandled rejection / handler 报错）',
    env.warnings.length === 0, env.warnings.join('\n'))
  check('[高亮抛错] 抛错之后朗读态正常收尾（speaking 复位，不卡「朗读中」）',
    (fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}).speaking === false,
    JSON.stringify(fakeWindow.__DSH_VOICE_DEBUG__?.()))
  env.domQueryThrows = false
}

/* ------------------------------------------------------------------ */
/* 场景 25（批次 6i-b）：SSE 消费点全部按信封解析                       */
/* ------------------------------------------------------------------ */
/**
 * 替掉 `event-envelope` 里那条「除 parseEnvelope 内部外没有裸的 JSON.parse(event.data)」
 * 的源码计数（docs §8.42）。
 *
 * 那条正则守的到底是什么？裸解析与走解析器的**唯一**行为差别是坏输入：
 * `parseEnvelope` 把「不是 JSON / 不是对象」压成 `null`，调用点判 `!payload` 就返回；
 * 自己写 `JSON.parse(event.data)` 的那一处会抛，抛出会打断这一个事件回调，
 * 而宿主那边坏 data 是真会出现的（代理/插件写坏一帧、旧版本残留）。
 * 「信封里的 sessionId 有没有被用来过滤」也是同一件事的另一半：绕过信封的那一处
 * 拿不到（或不去看）sessionId，于是别的会话的句子会被念出来。
 *
 * 所以这里判三样：① 别的会话的句子不念也不 ack；② 缺 sessionId 的全局事件照样处理；
 * ③ 五种事件的 data 全喂坏 JSON，SSE 消费不会因此崩，之后本会话的句子照样念。
 */
async function scenarioEnvelopeConsume() {
  await settle()
  resetEnv()
  await remountFresh()
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  // 前置：当前会话的句子念得出来（不然后面「别的会话不念」是空判）。
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'ev1' })
  emitSentence({ text: '本会话的第一句。', turnId: 'ev1', index: 0, para: 0, paraStart: true })
  const played1 = await waitFor(() => env.playedTexts.includes('本会话的第一句。'), 6000)
  check('[信封消费] 前置：当前会话的句子念得出来', played1, JSON.stringify(env.playedTexts))
  const acksAfter1 = ackTotal()
  check('[信封消费] 前置：那一句回执了一次', acksAfter1 === 1, `acks=${acksAfter1}`)

  // ① 信封里 sessionId 是别的会话：不念、不 ack（配额不该由本会话还）。
  emitSentence({ text: '别的会话的那一句。', sessionId: 'sess-OTHER', turnId: 'ev1', index: 1, para: 0, paraStart: false })
  await sleep(700)
  check('[信封消费] 别的会话的句子不念（消费点真的在用信封里的 sessionId 过滤）',
    !env.playedTexts.includes('别的会话的那一句。'), JSON.stringify(env.playedTexts))
  check('[信封消费] 别的会话的句子不 ack（不是"念完才发现不该念"）',
    ackTotal() === acksAfter1, `acks=${ackTotal()}`)
  // ② 全局事件（没有 sessionId）照样处理：过滤器不能把所有事件都挡掉。
  emit('assistant-busy', { busy: true })
  const busyOn = await waitFor(() => dbg().assistantRunning === true, 4000)
  check('[信封消费] 缺 sessionId 的全局事件照样生效（助手忙碌态置起来了）', busyOn, JSON.stringify(dbg()))
  emit('assistant-busy', { busy: false })
  await waitFor(() => dbg().assistantRunning === false, 4000)

  // ③ 五种事件的 data 全部喂坏 JSON —— 消费点不能把它变成一次崩溃。
  //    注意这条**不是**「有没有裸 JSON.parse」的替身：每个 handler 外面都包着
  //    `try { … } catch { /* 忽略 */ }`，裸解析抛出来的东西也会被那层 catch 吞掉，
  //    所以「走 parseEnvelope」与「自己 parse 再抛」在这里跑得出**同一个结果**。
  //    那条源码计数因此按「行为上分不出写法」删掉（推翻条件见 §8.42）。
  //    这里要守的是另一件事：坏 data 不能把 SSE 消费整条打死（后面还得能念）。
  const warningsBefore = env.warnings.length
  for (const type of ['assistant-busy', 'turn-begin', 'turn-end', 'call-end', 'sentence']) {
    emitRaw(type, '{这不是 JSON')
    emitRaw(type, 'null')
    emitRaw(type, '"一句纯文本"')
  }
  await sleep(200)
  check('[信封消费] 十五次坏 data（五种事件各三种）没有抛出这条测试的账',
    env.warnings.length === warningsBefore, env.warnings.slice(warningsBefore).join('\n'))
  // ④ 坏 data 之后本会话的句子照念、照 ack（证明不是"整条 SSE 被搞死了"）。
  emitSentence({ text: '坏输入之后的这一句。', turnId: 'ev1', index: 2, para: 0, paraStart: false })
  const played2 = await waitFor(() => env.playedTexts.includes('坏输入之后的这一句。'), 6000)
  check('[信封消费] 坏输入之后本会话的句子照样念出来（管道没死）', played2, JSON.stringify(env.playedTexts))
  check('[信封消费] 坏 data 一次都不回执（配额只由念出来的那两句归还）',
    ackTotal() === 2, `acks=${ackTotal()}`)
  check('[信封消费] 整段跑完没有异常留在账上', env.warnings.length === 0, env.warnings.join('\n'))
}

/* ------------------------------------------------------------------ */
/* 场景 25（批次 4d 改写）：宿主 /tts 挂住 → 超时兜底顶上，管道不死       */
/* ------------------------------------------------------------------ */
/**
 * 替掉 read-aloud-stop 里那条「合成有超时兜底（Promise.race + sleep）」。
 *
 * 原来这条只能扫写法，因为它要**真等 25 秒**（`TTS_TIMEOUT_MS`），
 * 写好的场景一直没接进 `main()`（批次 3 记的）。现在 `env.winSleepCapMs`
 * 能把传给假 window 的长定时器压短：判的是「兜底会顶上、两句都回执、管道继续转」，
 * 不是那 25 秒这个数字本身（数字由常量决定，本 harness 不判它，写在判据注释里）。
 */
async function scenarioTtsHangs() {
  await settle()
  resetEnv()
  await remountFresh()
  env.winSleepCapMs = 60 // 25 秒的合成超时 → 60ms 就当作到点
  env.ttsBehavior = () => ({ hang: true })
  emit('turn-begin', { sessionId: 'sess-1', turnId: 'hg1' })
  emitSentence({ text: '宿主挂住的第一句。', turnId: 'hg1', index: 0, para: 0, paraStart: true })
  emitSentence({ text: '宿主挂住的第二句。', turnId: 'hg1', index: 1, para: 0, paraStart: false })
  const t0 = Date.now()
  const acked2 = await waitFor(() => ackTotal() >= 2, 8000, 50)
  const took = Date.now() - t0
  check('[合成挂住] 两句都超时兜底并各 ack 一次（不这样宿主要一直等）',
    acked2 && ackTotal() === 2, `acks=${ackTotal()}，耗时 ${took}ms`)
  check('[合成挂住] 都没播（没有音频可播）', env.playedTexts.length === 0, JSON.stringify(env.playedTexts))
  check('[合成挂住] 兜底在几十毫秒内顶上（压短的是注入的定时器上限，不是生产常量）',
    took < 5000, `耗时 ${took}ms`)
  // 管道还活着：把 /tts 恢复正常，下一句要能照常播出来。
  env.ttsBehavior = () => ({ ok: true, status: 200 })
  emitSentence({ text: '宿主恢复后的这一句。', turnId: 'hg1', index: 2, para: 0, paraStart: false })
  const recovered = await waitFor(() => env.playedTexts.includes('宿主恢复后的这一句。'), 6000)
  check('[合成挂住] 挂住过一轮之后管道没卡死：恢复的下一句照播', recovered, JSON.stringify(env.playedTexts))
  check('[合成挂住] 没有异常甩出管道', env.warnings.length === 0, env.warnings.join('\n'))
  env.winSleepCapMs = 0
}

/* ------------------------------------------------------------------ */
/* 场景 26 / 27 / 28：设置面板（批次 5b，替掉 config-ui 与 model-panel-shape 的源码形状判据） */
/* ------------------------------------------------------------------ */
/**
 * 面板的挂载入口。
 *
 * 为什么单独写一个函数：面板的表单值来自**挂载后那次 GET /config**（没有轮询），
 * 所以「改 env.config → 必须重挂」这条和 `remountFresh()` 是同一个坑（批次 4 坑 1 的续集）：
 * 直接改 `env.config` 而不重挂，正在显示的表单还是上一段那份。
 */
async function mountPanel() {
  runtime.unmount()
  runtime.mount(SettingsSection, { t: (k) => k })
  await sleep(300)
}

/** 按 URL 片段数某个方法真发过几次（「不轮询」那类判据就数它）。 */
function fetchCount(part, method = 'GET') {
  return env.fetchLog.filter((f) => String(f.url).includes(part) && f.method === method).length
}

/** 面板里那只词表输入框（textarea）。 */
function panelWordsBox() {
  return findByProp(runtime.getTree(), (n) => n.type === 'textarea' && typeof n.props?.onChange === 'function')
}

/** 按渲染出来的文案（t 是恒等函数，所以就是 key）找按钮。 */
function panelButton(label) {
  return findByProp(runtime.getTree(), (n) => n.type === 'button'
    && n.props?.children === label && typeof n.props?.onClick === 'function')
}

/**
 * 模型列表里某一行的各格文本（按**档位 id** 找那一行）。
 *
 * 档位名那一格在恒等 `t` 的挂载里显示的是它的字典键（`MODEL_LABEL_KEYS[id] ?? id`）——
 * 批次 22-3-1 之前这里传的是宿主 `/models` 那句 `label`（「SenseVoice」），
 * 现在宿主那句本来就不该出现在界面上，所以判据改按 id 找：
 * 判的还是「那一行自己那格」，只是不再替宿主的文案背书。
 *
 * 为什么要到**格子**而不是 `treeHasText`：底部还有一条全局进度行，
 * 它写的也是「neuralDownloading xx%」。用整棵树包含来判断，行算错了、
 * 底部那条对的，也会照样绿（批次 5c 第一轮就是这么漏的：
 * 把行里的 ×100 改成 ×50，一条都没红 —— 底部那条替它把字面量兜住了）。
 */
function panelModelRowCells(modelId) {
  const displayName = MODEL_LABEL_KEYS[modelId] ?? String(modelId)
  const row = findByProp(runtime.getTree(), (n) => n.type === 'div'
    && flattenChildren(n.props?.children).some((c) => c && typeof c === 'object'
      && c.props?.children === displayName))
  if (!row) return null
  return flattenChildren(row.props?.children)
    .map((cell) => (cell && typeof cell === 'object' ? String(cell.props?.children ?? '') : String(cell)))
}

/**
 * 收集「渲染树里出现过的函数型元素类型」（按身份，不按名字）。
 *
 * 用途：`Row` / `Section` / `Label` / `Toggle` 必须定义在**渲染函数之外的稳定作用域**里。
 * 一旦有人把它们搬回渲染体内，每次渲染就是一个新函数 → 真实 React 视作新组件类型 →
 * 整棵子树卸载重建 → 用户正在打的输入框当场失焦。
 * 这条取代了原来那个「扫源码里 `const Row = (props)` 出现在 `function VoiceSettingsSection`
 * 之前」的形状判据：那个只认旧写法（工厂闭包里的位置一挪就误报），
 * 这个判的是它真正担心的事 —— 组件类型在两次渲染之间换了身份。
 */
function functionTypesIn(root) {
  const out = new Set()
  const stack = [root]
  let guard = 0
  while (stack.length && guard++ < 40000) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) { stack.push(...node); continue }
    if (typeof node.type === 'function') out.add(node.type)
    const children = node.props?.children
    if (children !== undefined) stack.push(children)
  }
  return out
}

/**
 * 场景 26：词表输入不逐键归一化 + 失焦/保存才归一化 + 保存 payload 是归一化后的 +
 * 宿主 400 的可读错误 + 快捷键非法时按钮真禁用。
 *
 * 取代的判据（原来在 `test/config-ui.test.mjs`「B. 源码形状」，全是扫客户端源码文本）：
 *   「词表输入框绑定原始文本 state」「词表失焦/保存时才归一化」「旧的逐键归一化已移除」
 *   「保存 POST 归一化后的 payload」「保存错误可读展示（saveErrors 渲染）」
 *   「快捷键非法时保存按钮禁用」——这 6 条在本场景里一条条对着判；
 *   另外两条「/tts 响应头读取回退标记」「回退提示接到现有 hint 机制」不在这里，
 *   它们由场景 2b（引擎回退提示）判：那一段注入真的回退响应头、走真的合成链路、
 *   等树里真的出现 `ttsFallbackOnline`，比正则盯字面量强（处置规则 1，已有更强判据 → 删）。
 */
async function scenarioSettingsWordsAndSave() {
  await settle()
  resetEnv()
  if (!SettingsSection) {
    check('[面板] 设置面板组件注册可得（26/27/28 三段的前提）', false, 'settings.section 没注册')
    return
  }
  const savedConfig = { ...env.config }
  env.config.words = ['正确=错误']
  env.config.shortcut = 'Alt+V'
  env.config.globalShortcut = 'Ctrl+Alt+V'
  // 故意留两个非法值：保存时应当被 normalizeForSave 收敛（不是被 UI 悄悄改掉再发出去）。
  env.config.ttsEngine = 'bogus'
  env.config.rate = 'nope'

  await mountPanel()
  check('[面板] 词表输入框挂得出来（textarea + onChange）', Boolean(panelWordsBox()))
  if (!panelWordsBox()) { Object.assign(env.config, savedConfig); return }

  /* ---- ① 逐键不许归一化：空格和换行是用户正在打的东西 ---- */
  const raw = '你好 世界\n\n  第二行  '
  panelWordsBox().props.onChange({ target: { value: raw } })
  await sleep(60)
  check('[面板·词表] 敲进去的原样留在输入框（空格/换行没被逐键吞掉，审计 F1）',
    panelWordsBox()?.props?.value === raw, JSON.stringify(panelWordsBox()?.props?.value))
  check('[面板·词表] 打字过程中一次配置都不发（归一化只发生在失焦/保存）',
    env.configPosts.length === 0, `已发 ${env.configPosts.length} 次`)

  /* ---- ② 失焦 → 保存：发出去的是归一化后的词表 ---- */
  panelWordsBox().props.onBlur()
  await sleep(60)
  const saveButton = panelButton('save')
  check('[面板·保存] 保存按钮找得到', Boolean(saveButton))
  if (!saveButton) { Object.assign(env.config, savedConfig); return }
  check('[面板·保存] 配置加载完 + 有改动 + 快捷键合法 → 按钮可点',
    saveButton.props.disabled === false, `disabled=${saveButton.props.disabled}`)
  saveButton.props.onClick()
  await sleep(120)
  const post = env.configPosts[0] ?? null
  check('[面板·保存] 点一下真发出 POST /config', Boolean(post), `configPosts=${env.configPosts.length}`)
  check('[面板·词表] 发出去的词表是归一化后的（去空行、逐条 trim、保留词内空格）',
    JSON.stringify(post?.words) === JSON.stringify(['你好 世界', '第二行']), JSON.stringify(post?.words))
  check('[面板·保存] 非法引擎/档位发出去前被归一化（不是原样发给宿主）',
    post?.ttsEngine === 'online' && post?.rate === '+10%',
    JSON.stringify({ ttsEngine: post?.ttsEngine, rate: post?.rate }))
  check('[面板·保存] 保存成功后脏标记清掉（按钮重新禁用，不会重复提交）',
    panelButton('save')?.props?.disabled === true)

  /* ---- ③ 宿主 400：错误行由字典出，宿主那句原文一个字都不进界面（批次 20，docs §8.62） ---- */
  env.configSaveResponse = {
    ok: false, status: 400,
    body: {
      ok: false,
      errors: [
        { key: 'ttsEngine', reason: 'not-in-enum', detail: '应为 online / local / neural / sovits 之一' },
        { key: 'wakeWord', reason: 'too-long', detail: '不能超过 32 个字' },
      ],
    },
  }
  panelWordsBox().props.onChange({ target: { value: '再改一点' } })
  await sleep(60)
  panelWordsBox().props.onBlur()
  await sleep(60)
  panelButton('save')?.props.onClick()
  await sleep(120)
  const treeText = () => runtime.getTree()
  check('[面板·保存] 400 的每一行是「字段名 + 字典键」（宿主只给码）',
    treeHasText(treeText(), 'ttsEngine：configErrorEnum')
      && treeHasText(treeText(), 'wakeWord：configErrorTooLong'),
    '渲染树里没有那两条错误 —— 用户只会看到「保存失败」')
  check('[面板·保存] 码名与宿主 detail 都不进界面',
    !treeHasText(treeText(), 'not-in-enum') && !treeHasText(treeText(), '应为 online')
      && !treeHasText(treeText(), '不能超过 32 个字'),
    '界面上出现了码名或宿主原文')
  check('[面板·保存] 保存失败时改动还在（不把表单冲回服务端值）',
    panelWordsBox()?.props?.value?.includes('再改一点') === true,
    JSON.stringify(panelWordsBox()?.props?.value))

  /* ---- 每个码都真跑一遍：这条错误行确实是「按码查字典」，不是碰巧拼出来的一句 ---- */
  // 挂载用的 `t` 是恒等函数（`t: (k) => k`），所以树里出现的就是**键名**；
  // 键名对上 = 那句由字典出，码名/原文不出现在树里 = 宿主的字没进界面。
  const saveErrorCases = [
    ['not-in-enum', 'silenceMs', 'configErrorEnum'],
    ['out-of-range', 'silenceMs', 'configErrorRange'],
    ['not-integer', 'neuralSpeaker', 'configErrorInteger'],
    ['url-not-http', 'sovitsUrl', 'configErrorUrlScheme'],
    ['words-too-many', 'words', 'configErrorWordsTooMany'],
    ['words-entry-shape', 'words', 'configErrorWordsEntryShape'],
    ['not-boolean', 'readAloud', 'configErrorBoolean'],
    // 整份请求的错没有字段键：那一行不该带「字段名：」前缀。
    ['body-not-json', '', 'configErrorBodyNotJson'],
  ]
  for (const [code, key, expectKey] of saveErrorCases) {
    env.configSaveResponse = {
      ok: false, status: 400,
      body: { ok: false, errors: [{ key, reason: code, detail: `假原文-${code}` }] },
    }
    panelButton('save')?.props.onClick()
    await sleep(120)
    check(`[面板·保存] 码「${code}」渲染成「${expectKey}」这句（不是码本身）`,
      treeHasText(treeText(), expectKey), '错误行没按码出文案')
    check(`[面板·保存] 码「${code}」不把码名或宿主 detail 显示给用户`,
      !treeHasText(treeText(), code) && !treeHasText(treeText(), `假原文-${code}`),
      '界面上出现了码名或 detail')
  }
  // 整份被拒、一条错误都没给 → 那句「没通过校验」；空 key 的行不带前缀。
  env.configSaveResponse = { ok: false, status: 400, body: { ok: false } }
  panelButton('save')?.props.onClick()
  await sleep(120)
  check('[面板·保存] 只说「没通过」、没有 errors 时用整份被拒那句',
    treeHasText(treeText(), 'configSaveRejected'), '没找到兜底文案')
  // 旧宿主（还没改成报码）把中文句子塞进 reason：走兜底那句，原文一个字都不显示。
  env.configSaveResponse = {
    ok: false, status: 400,
    body: { ok: false, errors: [{ key: 'ttsEngine', reason: '必须是 online/neural/local/sovits' }] },
  }
  panelButton('save')?.props.onClick()
  await sleep(120)
  check('[面板·保存] 旧宿主写来的句子走兜底那句、原样不进界面',
    treeHasText(treeText(), 'configErrorUnknown') && !treeHasText(treeText(), '必须是 online'),
    '界面上出现了宿主原文或没走兜底')
  env.configSaveResponse = null

  /* ---- ④ 快捷键非法 → 按钮禁用（旧实现只显红字、照样能保存） ---- */
  env.config.shortcut = 'v'
  await mountPanel()
  panelWordsBox().props.onChange({ target: { value: '非法快捷键时也拦' } })
  await sleep(60)
  // 快捷键非法 + 有改动 → 按钮禁用，这一半是真判据（把 `saveDisabled` 里的
  // `!shortcutCheck.ok` 删掉它就红）。
  //
  // **原来这里还想判「非法时点保存一次都不发 POST」，判不动，删掉了**：
  // 这套假 DOM 的 `onClick` 是我们直接调的，不模拟浏览器对 `disabled` 控件
  // 「不派发 click」的抑制；而生产的 `save()` 里确实没有第二道快捷键校验
  // （`src/client/dom/voice-settings-section.js:596` 的 `saveDisabled` 是唯一防线）。
  // 要在沙箱里判「不发」，只能先让 `panelButton().props.onClick()` 学会尊重 disabled ——
  // 那样这条就退化成上面那条 disabled 的复读，没有新信息。留着反而误导。
  check('[面板·保存] 快捷键非法 + 有改动 → 保存按钮禁用',
    panelButton('save')?.props?.disabled === true,
    `disabled=${panelButton('save')?.props?.disabled}`)
  // 对照组：同一份「有改动」状态，只把快捷键改回合法 → 按钮必须可点。
  // 没有这半边，上面那条可能只是「没 dirty / 没 loaded」的另一种表现。
  env.config.shortcut = 'Alt+V'
  await mountPanel()
  panelWordsBox().props.onChange({ target: { value: '合法快捷键时放行' } })
  await sleep(60)
  check('[面板·保存] 对照组：同样的改动，快捷键合法 → 按钮可点',
    panelButton('save')?.props?.disabled === false,
    `disabled=${panelButton('save')?.props?.disabled}`)
  check('[面板·保存] 没有异常甩出渲染/事件回调', env.warnings.length === 0, env.warnings.join('\n'))

  Object.assign(env.config, savedConfig)
  delete env.config.words
  delete env.config.globalShortcut
  runtime.unmount()
}

/**
 * 场景 26a：快捷键那两行红字（批次 22，docs §8.64）。
 *
 * 改前的形状：`pure/shortcut.js` 的 `validateShortcut` 直接返回五条中文句子，
 * 面板把那支句子原样渲染进红字里 —— 于是切到英文界面，快捷键那两行仍然是中文
 * （和批次 18/19/20 修的是同一件事，只是这条链路的「写句子的人」本来就在客户端）。
 *
 * 这里判两层，缺一不可：
 *   ① 挂载给的是**恒等 `t`**（`t: (k) => k`），所以树里出现的就是字典键名 ——
 *      键名对上证明那句是「按码查字典」得来的，五句旧中文不出现在树里证明校验层
 *      确实一个字都不再往外发。五个码 + 全局快捷键那一行都各跑一遍。
 *   ② 挂载**不给 `props.t`**（宿主没给取词函数时走组件自己的兜底）。这一档是本轮顺手修的
 *      一条老毛病：兜底那支以前写成 `(key) => zh[key] ?? key`，**第二个参数直接丢掉**，
 *      所以带参数的句子会显示成字面量「不认识的修饰键：{modifier}。」。
 *      现在兜底换成 `pure/i18n.js` 的 `zhTranslate`，这里判「foo 真被填进句子里」
 *      和「树里没有没被填掉的 {占位符}」。
 */
async function scenarioShortcutErrorText() {
  await settle()
  resetEnv()
  if (!SettingsSection) { check('[面板·快捷键] 设置面板组件注册可得', false, 'settings.section 没注册'); return }
  const savedConfig = { ...env.config }
  const treeText = () => runtime.getTree()
  // 改前那五句（现在只住在字典里）。它们出现在树上就说明校验层还在往外发句子。
  const oldSentences = ['不能为空', '至少要两个键', '不认识的修饰键', '别用单个字母', '粘贴为纯文本']

  /**
   * 换一份配置并重挂面板。
   *
   * **必须先清 `configStore`**：它是模块级单例、跨挂载存活，而 `set()` 是**按键合并**
   * （`{ ...this.value, ...next }`），所以上一轮塞进去的非法快捷键会盖掉这一轮 GET /config
   * 给的值 —— 不清的话对照组判的是「上一次挂载留下的表单」，不是「这份配置下红字该不该出现」
   * （本轮实测踩过：对照组树里同时挂着上一轮那两个码）。清法与 `resetEnv` 里那两行一致。
   */
  const injectConfig = async (patch) => {
    const store = exportsObj.__test.configStore
    store.value = {}
    store.loaded = false
    env.config = { ...savedConfig, ...patch }
    await mountPanel()
  }

  /* ---- ① 恒等 t：红字那行是字典键，不是中文句子 ---- */
  const cases = [
    ['shortcut', '', 'shortcutErrorEmpty'],
    ['shortcut', 'v', 'shortcutErrorTooFewParts'],
    ['shortcut', 'Shift+V', 'shortcutErrorSingleLetter'],
    ['shortcut', 'Foo+V', 'shortcutErrorUnknownModifier'],
    ['shortcut', 'Ctrl+Shift+V', 'shortcutErrorReservedPaste'],
    // 全局那一行是另一处调用点（同一个函数、两个输入框），单独跑一遍防止只修了一半。
    ['globalShortcut', 'Foo+V', 'shortcutErrorUnknownModifier'],
  ]
  for (const [field, value, expectKey] of cases) {
    await injectConfig({ [field]: value })
    check(`[面板·快捷键] ${field}=「${value}」的红字是字典键「${expectKey}」（那句由字典出）`,
      treeHasText(treeText(), expectKey), '红字没按码查字典')
    check(`[面板·快捷键] ${field}=「${value}」时改前那五句中文一句都不出现在界面上`,
      !oldSentences.some((line) => treeHasText(treeText(), line)),
      '界面上还有校验层写死的中文')
  }
  // 对照组：两份都用默认值（合法）时那两行红字根本不该存在（键名也不许露出来）。
  await injectConfig({})
  check('[面板·快捷键] 快捷键合法时两行红字都不出现（键名也不许露）',
    !treeHasText(treeText(), 'shortcutError')
      && !oldSentences.some((line) => treeHasText(treeText(), line)),
    '合法值旁边还挂着错误行')

  /* ---- ② 不给 props.t：兜底取词要把参数真填进句子 ---- */
  runtime.unmount()
  {
    const store = exportsObj.__test.configStore
    store.value = {}
    store.loaded = false
  }
  env.config = { ...savedConfig, shortcut: 'Foo+V' }
  runtime.mount(SettingsSection, {})
  await sleep(300)
  check('[面板·快捷键·兜底] 没有 props.t 时红字是那句中文，并把 foo 填了进去',
    treeHasText(treeText(), '不认识的修饰键：foo。'), '兜底那句没填参数或键没查到')
  check('[面板·快捷键·兜底] 界面上不留没被填掉的 {占位符}',
    !treeHasText(treeText(), '{modifier}'), '句子里还挂着字面量占位符')
  runtime.unmount()

  env.config = savedConfig
  check('[面板·快捷键] 没有异常甩出渲染/事件回调', env.warnings.length === 0, env.warnings.join('\n'))
}

/**
 * 「这句话有没有走字典」的两件共用工具（批次 22-2 立在场景 26c 内部，
 * 批次 22-3-1 的「面板·模型名」也要用，提到模块作用域）。
 *
 * 「汉字必须能在 `zh` 里找到出处」这条按**汉字段**判：一句树里的文本先摘掉标点、
 * 空格与契约值（`win32` / `zipformer2-zh` 这些拉丁串），剩下的每一段连续汉字都得能在
 * 某条中文文案里找到。放过的是排版与契约值，抓住的是「这句话根本没进字典」。
 */
const HAN = '[㐀-䶿一-鿿豈-﫿]'
const hanRe = new RegExp(HAN)
const hanRuns = (value) => String(value).match(new RegExp(`${HAN}+`, 'g')) ?? []
const ZH_RUN_BANK = Object.values(zh)
  .map((value) => String(value).replace(new RegExp(`[^${HAN}]`, 'g'), ''))
  .filter(Boolean)
/** 这句里的每一段连续汉字是否都能在字典的汉字里找到（契约值与标点被摘掉了）。 */
const hasDictionarySource = (value) => hanRuns(value).every((run) => ZH_RUN_BANK.some((bank) => bank.includes(run)))

/**
 * 收集**用户看得见**的字符串：文本子节点 + 输入框的 `placeholder` + 悬停说明 `title`。
 *
 * 为什么不收 `value`：那是用户自己填的数据（词表里他写的中文、唤醒词），
 * 把它当界面文案判会把用户数据判成回归。`class`/`style` 同理是样式 token。
 */
function visibleStrings(node, out = [], budget = 60000) {
  if (node == null || budget <= 0) return out
  if (typeof node === 'string' || typeof node === 'number') {
    const value = String(node)
    if (value.trim()) out.push(value)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) visibleStrings(child, out, budget - 1)
    return out
  }
  const props = node.props ?? {}
  for (const prop of ['placeholder', 'title', 'alt']) {
    if (typeof props[prop] === 'string' && props[prop].trim()) out.push(props[prop])
  }
  if (props.children !== undefined) visibleStrings(props.children, out, budget - 1)
  return out
}

/**
 * 场景 26c：面板的选项与标签文案只能由字典出（批次 22-2，§8.65）。
 *
 * 前面几族判的是「宿主回的原因码不许进界面」，这一族判的是**面板自己写死的那些字**：
 * 引擎选项名、语言名、音色名、空闲释放档位、「说话人 N」、MP3 格式那两行、
 * 词表输入框的占位符、「（需先下载 …）」那半截、「平台：」「显卡：」「未检测到 NVIDIA 显卡」。
 * 判据是「这句话会不会进界面」，不是「这句话是不是中文」，所以两轮挂载各判一半：
 *
 *   ① **恒等 `t`**：树里显示的是**字典键**。这时候界面上任何汉字都不该是句子 ——
 *      出现一句完整中文 = 那一处没走字典（改前正是这个样子）。
 *      「改前那十八句硬编码一个字都不许再出现」也只在第一轮判：
 *      第二轮本来就该显示这些中文，在它那儿判这条就是自己打自己。
 *   ② **不给 `props.t`**：走客户端自己的中文兜底（`zhTranslate`）。这一轮判的是成品 ——
 *      那句话真的出来了，而且参数（分钟数、小时数、说话人序号、模型名）真被填了进去。
 */
async function scenarioPanelOptionCopy() {
  await settle()
  resetEnv()
  if (!SettingsSection) {
    check('[面板·选项] 设置面板组件注册可得', false, 'settings.section 没注册')
    return
  }
  const savedConfig = { ...env.config }
  const store = exportsObj.__test.configStore
  const clearStore = () => { store.value = {}; store.loaded = false }

  // 改前那十八句（`git show HEAD:src/client/dom/voice-settings-section.js` 里逐条摘的）。
  // 恒等 `t` 那一轮里它们任何一句都不该再出现 —— 出现就是那处还写着死中文。
  const OLD_HARDCODED = [
    '（需先下载 zipformer2-zh）', '正确=错误', '专业术语',
    'Edge 在线（音质好，需联网）', '本地神经模型（离线 · 音质接近在线）',
    '本地系统语音（离线可用，速度快）', '本地系统语音（当前平台不支持）',
    'GPT-SoVITS 外部服务（用你自己配置好的服务）', '说话人 ',
    'MP3 24kHz/48kbps（推荐，体积小）', 'MP3 24kHz/96kbps（音质更好）',
    '永不释放', '5 分钟', '10 分钟', '30 分钟', '1 小时', '分钟',
    '平台：', '显卡：',
  ]

  /**
   * 点「重新检测环境」那只按钮。
   *
   * 平台和显卡那两行**挂载时不渲染**（`envInfo` 是点出来才拉的），不点这一下，
   * `envPlatformLabel` / `envGpuLabel` / `envGpuNone` 三个键就没被问过，
   * 上面那两条判据会假红（本轮实测：12 个键里就这两个「没问过」）。
   * 按钮上的字在两轮挂载里不一样（① 是键名、② 是中文句子），所以按传进来的标签找。
   */
  const clickEnvCheck = async (label) => {
    const button = findByProp(runtime.getTree(), (n) => n.type === 'button'
      && n.props?.children === label && typeof n.props?.onClick === 'function')
    if (!button) return false
    button.props.onClick()
    await settle()
    await sleep(200)
    return true
  }

  /* ---- ① 恒等 t：树上只该见字典键，不该见句子 ---- */
  clearStore()
  runtime.unmount()
  const askedKeys = new Set()
  const recordingT = (key) => {
    askedKeys.add(String(key))
    return String(key)
  }
  runtime.mount(SettingsSection, { t: recordingT })
  await sleep(400)
  const clickedEnv = await clickEnvCheck('envRecheck')
  {
    check('[面板·选项] 「重新检测环境」按钮找得到（环境那两行的判据靠它）',
      clickedEnv, `树上没有 children 为「envRecheck」的按钮`)
    const strings = visibleStrings(runtime.getTree())
    const withHan = strings.filter((value) => hanRe.test(value))
    const noSource = withHan.filter((value) => !hasDictionarySource(value))
    check(`[面板·选项] 恒等 t 下树里 ${withHan.length} 个含汉字的串每一个都能在字典里找到出处（没出处 = 那句话没走字典）`,
      noSource.length === 0, noSource.slice(0, 8).map((value) => JSON.stringify(value)).join(' | '))
    const leftover = OLD_HARDCODED.filter((line) => withHan.some((value) => value.includes(line)))
    check('[面板·选项] 改前那十八句硬编码在恒等 t 的树里一句都不出现',
      leftover.length === 0, leftover.join(' / '))
    // 这批新用的键真被面板问过（问过 = 那句话是字典出的，不是组件里抄的）。
    const EXPECTED_KEYS = [
      'engineOptionOnline', 'engineOptionNeural', 'engineOptionLocal', 'engineOptionSovits',
      'idleReleaseNever', 'idleReleaseInMinutes', 'idleReleaseInHours',
      'wordsPlaceholder', 'ttsFormatMp3Small', 'ttsFormatMp3Quality',
      'envPlatformLabel', 'envGpuLabel',
    ]
    const neverAsked = EXPECTED_KEYS.filter((key) => !askedKeys.has(key))
    check(`${EXPECTED_KEYS.length} 个新搬进字典的选项键真被面板问过`,
      neverAsked.length === 0, `没问过：${neverAsked.join(',')}`)
    check('[面板·选项] 面板问过字典的键里没有一个带汉字（中文不许当键名传）',
      [...askedKeys].every((key) => !hanRe.test(key)),
      [...askedKeys].filter((key) => hanRe.test(key)).join(' / '))
  }

  /* ---- ② 没有 props.t：中文兜底那一句要真的通顺、参数要真填进去 ---- */
  runtime.unmount()
  clearStore()
  env.config = { ...savedConfig, idleReleaseMinutes: 5, ttsEngine: 'neural' }
  runtime.mount(SettingsSection, {})
  await sleep(400)
  const clickedEnvFallback = await clickEnvCheck(zh.envRecheck)
  {
    check('[面板·选项·兜底] 兜底挂载里也点得到「重新检查」（环境那两行要点了才渲染）',
      clickedEnvFallback, `树上没有 children 为「${zh.envRecheck}」的按钮`)
    const tree = runtime.getTree()
    const strings = visibleStrings(tree)
    const withHan = strings.filter((value) => hanRe.test(value))
    const noSource = withHan.filter((value) => !hasDictionarySource(value))
    check('[面板·选项·兜底] 兜底挂载里含汉字的串同样每个都有字典出处（宿主原文与硬编码都不许进界面）',
      noSource.length === 0, noSource.slice(0, 8).map((value) => JSON.stringify(value)).join(' | '))
    //  needle 全部从字典取（抄一句中文进判据就等于判据自己也是一处硬编码）。
    // 本地那项有两个变体（支持/不支持），取决于自检回来的 `supported`，所以两个都算过。
    check('[面板·选项·兜底] 引擎那几项显示的是字典里的中文句子',
      treeHasText(tree, zh.engineOptionOnline) && treeHasText(tree, zh.engineOptionNeural)
        && (treeHasText(tree, zh.engineOptionLocal) || treeHasText(tree, zh.engineOptionLocalUnsupported)),
      strings.filter((value) => value.includes('引擎') || value.includes('模型')).slice(0, 6).join(' / '))
    check('[面板·选项·兜底] 释放档位那句里的数字真被填了进去（不是字面量 {minutes}）',
      treeHasText(tree, interpolate(zh.idleReleaseInMinutes, { minutes: '5' }))
        && !treeHasText(tree, '{minutes}'),
      strings.filter((value) => value.includes('分钟') || value.includes('释放')).slice(0, 6).join(' / '))
    check('[面板·选项·兜底] 词表输入框的占位符是字典那句（改前它手写在组件里）',
      strings.some((value) => value === zh.wordsPlaceholder),
      strings.filter((value) => value.includes('正确')).slice(0, 4).join(' / '))
    check('[面板·选项·兜底] 平台与显卡那两行的标签由字典出、值仍是契约值',
      treeHasText(tree, `${zh.envPlatformLabel}：`) && treeHasText(tree, `${zh.envGpuLabel}：`)
        || treeHasText(tree, zh.envGpuNone),
      strings.filter((value) => value.includes('平台') || value.includes('显卡')).slice(0, 4).join(' / '))
    check('[面板·选项·兜底] 界面上不留没被填掉的 {占位符}',
      !strings.some((value) => /\{\w+\}/.test(value)),
      strings.filter((value) => /\{\w+\}/.test(value)).slice(0, 5).join(' / '))
  }
  runtime.unmount()

  env.config = savedConfig
  check('[面板·选项] 没有异常甩出渲染/事件回调', env.warnings.length === 0, env.warnings.join('\n'))
}

/**
 * 场景 26d：模型档位名只能由字典出（批次 22-3-1，§8.66）。
 *
 * 起因是一条实测发现：宿主 `/models` 每条档位都带 `label`（中文）与 `labelEn`（英文），
 * 而面板四处渲染点只读 `label` —— 宿主那份英文**从来没有上过界面**。
 * 这一族判的就是「换掉了没有」：喂进去的档位带几句一眼认得出的假宿主中文，
 * 界面上任何一处都不许出现它们 —— 出现就说明还有一处在直接渲染宿主文案。
 *
 * 三轮挂载各判一件事：
 *   ① **恒等 `t`**：档位名问的是 `modelWhisperTiny` 这类**字典键**；
 *      树里含汉字的串每个都得有字典出处（宿主的 `label` 没有出处，出现即红）。
 *   ② **不给 `props.t`**：走客户端中文兜底，显示的是字典那句（与目录 `label` 逐字相同，
 *      等值由 `test/i18n-status-line.test.mjs` 判据 17 锁，这里不重复抄那句中文）。
 *   ③ **换成英文 `t`**：界面里的每一段汉字都得能在**英文那份字典**里找到出处。
 *      切英文后档位名跟着变是这批的目的；宿主的中文 `label` 在英文字典里没有出处，
 *      漏一处就是漏一处没走字典。放过的是英文文案自己举的中文例子（唤醒词「小鱼」、
 *      词表「深度求索=深度球搜」那两句说明里就有），抓住的才是没翻译的整句。
 *
 * 目录里没有的档位（宿主装了新模型）走「原样返回 id」：它没有字典条目，但 id 本身就是
 * 用户要的信息 —— 不许编一句假名字，也不许留成空白。
 */
async function scenarioPanelModelNames() {
  await settle()
  resetEnv()
  if (!SettingsSection) {
    check('[面板·模型名] 设置面板组件注册可得', false, 'settings.section 没注册')
    return
  }
  const savedConfig = { ...env.config }
  const savedModels = env.models
  const store = exportsObj.__test.configStore
  const clearStore = () => { store.value = {}; store.loaded = false }
  // 假宿主文案：故意写成「不许上界面」这种一望即知的句子，红的时候一眼看得出是哪条漏了。
  const HOST_LABELS = ['宿主写的识别档位名不许上界面', '另一句宿主的中文标签', '宿主的合成档位名', '目录里没有的新档位']
  env.models = [
    { id: 'whisper-tiny', label: HOST_LABELS[0], category: 'asr', ready: true, bytes: 99 * 1048576 },
    { id: 'sensevoice', label: HOST_LABELS[1], category: 'asr', ready: false, bytes: 220 * 1048576 },
    { id: 'brand-new-tier', label: HOST_LABELS[3], category: 'asr', ready: false, bytes: 1048576 },
    { id: 'vits-melo-zh_en', label: HOST_LABELS[2], category: 'tts', ready: true, speakers: 1, bytes: 300 * 1048576 },
  ]
  env.config = { ...savedConfig, model: 'whisper-tiny', neuralModel: 'vits-melo-zh_en', ttsEngine: 'neural' }

  /** 这几句宿主中文出现在树上就是回归；每轮都判一次。 */
  const leakedHostLabels = (strings) => HOST_LABELS.filter((label) => strings.some((value) => value.includes(label)))

  /** 这句里的每一段连续汉字是否都能在**给定那份字典**的汉字里找到（ bank 只摘一次）。 */
  const hasSourceIn = (dictionary) => {
    const bank = Object.values(dictionary)
      .map((value) => String(value).replace(new RegExp(`[^${HAN}]`, 'g'), ''))
      .filter(Boolean)
    return (value) => hanRuns(value).every((run) => bank.some((entry) => entry.includes(run)))
  }
  const inEnglishDictionary = hasSourceIn(en)

  /* ---- ① 恒等 t：档位名得是字典键，宿主的 label 不许进树 ---- */
  runtime.unmount()
  clearStore()
  const askedKeys = new Set()
  runtime.mount(SettingsSection, { t: (key) => { askedKeys.add(String(key)); return String(key) } })
  await sleep(400)
  {
    const strings = visibleStrings(runtime.getTree())
    const leaked = leakedHostLabels(strings)
    check('[面板·模型名] 宿主那几句 `label` 在树里一句都不出现（出现 = 那一处还在直接渲染宿主文案）',
      leaked.length === 0, leaked.join(' / '))
    const withHan = strings.filter((value) => hanRe.test(value))
    const noSource = withHan.filter((value) => !hasDictionarySource(value))
    check('[面板·模型名] 恒等 t 下含汉字的串每一个都能在字典里找到出处',
      noSource.length === 0, noSource.slice(0, 8).map((value) => JSON.stringify(value)).join(' | '))
    const EXPECTED_KEYS = ['modelWhisperTiny', 'modelSensevoice', 'modelVitsMeloZhEn']
    const neverAsked = EXPECTED_KEYS.filter((key) => !askedKeys.has(key))
    check(`${EXPECTED_KEYS.length} 个档位名键真被面板问过（问过 = 那句话由字典出，不是组件抄的）`,
      neverAsked.length === 0, `没问过：${neverAsked.join(',')}`)
    check('[面板·模型名] 面板问字典的键里没有一个带汉字',
      [...askedKeys].every((key) => !hanRe.test(key)),
      [...askedKeys].filter((key) => hanRe.test(key)).slice(0, 6).join(' / '))
    check('[面板·模型名] 目录外的档位原样显示 id（不编名字、也不留空）',
      strings.includes('brand-new-tier'),
      strings.filter((value) => /brand|tier/i.test(value)).slice(0, 4).join(' / '))
  }

  /* ---- ② 没有 props.t：中文兜底显示字典那句 ---- */
  runtime.unmount()
  clearStore()
  runtime.mount(SettingsSection, {})
  await sleep(400)
  {
    const tree = runtime.getTree()
    const strings = visibleStrings(tree)
    const leaked = leakedHostLabels(strings)
    check('[面板·模型名·兜底] 兜底挂载里宿主的 `label` 同样不进界面',
      leaked.length === 0, leaked.join(' / '))
    // needle 从字典取：判据里抄一句中文，等于判据自己也成了一处硬编码。
    check('[面板·模型名·兜底] 三个档位显示的是字典里那三句中文',
      treeHasText(tree, zh.modelWhisperTiny) && treeHasText(tree, zh.modelSensevoice)
        && treeHasText(tree, zh.modelVitsMeloZhEn),
      strings.filter((value) => /Whisper|SenseVoice|MeloTTS/.test(value)).slice(0, 6).join(' / '))
    const withHan = strings.filter((value) => hanRe.test(value))
    const noSource = withHan.filter((value) => !hasDictionarySource(value))
    check('[面板·模型名·兜底] 含汉字的串每一个都有字典出处',
      noSource.length === 0, noSource.slice(0, 8).map((value) => JSON.stringify(value)).join(' | '))
    check('[面板·模型名·兜底] 目录外的档位仍原样显示 id',
      strings.includes('brand-new-tier'),
      strings.filter((value) => /brand|tier/i.test(value)).slice(0, 4).join(' / '))
  }
  runtime.unmount()

  /* ---- ③ 换成英文 t：界面里一段汉字都不该剩 ---- */
  clearStore()
  runtime.mount(SettingsSection, { t: (key) => String(en[key] ?? key) })
  await sleep(400)
  {
    const tree = runtime.getTree()
    const strings = visibleStrings(tree)
    const leaked = leakedHostLabels(strings)
    check('[面板·模型名·英文] 切英文后宿主的中文 `label` 更不许进界面',
      leaked.length === 0, leaked.join(' / '))
    check('[面板·模型名·英文] 档位名显示的是目录那份 `labelEn`（这批的动机：它第一次上界面）',
      treeHasText(tree, en.modelWhisperTiny) && treeHasText(tree, en.modelSensevoice)
        && treeHasText(tree, en.modelVitsMeloZhEn),
      strings.filter((value) => /Whisper|SenseVoice|MeloTTS/.test(value)).slice(0, 6).join(' / '))
    const withHan = strings.filter((value) => hanRe.test(value))
    const noEnSource = withHan.filter((value) => !inEnglishDictionary(value))
    check('[面板·模型名·英文] 英文界面里的每一段汉字都是英文文案自己举的例子（有别的出处 = 那一处没跟着翻译）',
      noEnSource.length === 0, noEnSource.slice(0, 6).map((value) => JSON.stringify(value)).join(' | '))
    // 反向确认这条判据不是空转：宿主的中文标签确实落不进英文字典的出处里。
    check('[面板·模型名·英文] 判据自己有牙：宿主那句中文放进英文树里会被抓住',
      HOST_LABELS.every((label) => !inEnglishDictionary(label)),
      HOST_LABELS.filter((label) => inEnglishDictionary(label)).join(' / '))
  }

  runtime.unmount()
  clearStore()
  env.models = savedModels
  env.config = savedConfig
  check('[面板·模型名] 没有异常甩出渲染/事件回调', env.warnings.length === 0, env.warnings.join('\n'))
}

/**
 * 场景 26e：「运行环境自检」那几行的行名与状态句只能由字典出（批次 22-3-2，§8.67）。
 *
 * 这一族的说话人是 `src/host/tts-env.js`：它探测完 powershell / say / espeak-ng、
 * Edge 音色列表、sherpa-onnx 运行时与模型文件，把结果写成一句中文放进 `detail`，
 * 面板 `${e.label}：${e.detail}` 原样上界面。英文界面里这一整块是宿主的中文。
 * 现在宿主回 `{available, reason, params, detail}`，界面按 `id` 查行名、按 `reason` 查句子，
 * `detail` 那句原文只归 `/diagnostics` 读。
 *
 * 前置条件（这批开工时先补的）：替身得**真的走到** `/tts/env`。改前 `fakeFetch` 没这一条分支，
 * 落到末尾的通用 `{ok:true}`，面板那四行根本不渲染 —— 在它上面写文案判据就是空转。
 * 现在 `env.ttsEnv` 提供响应体（默认 null 保持老形状，别的场景一个字没变）。
 *
 * 三轮挂载各判一件事，和「面板·模型名」同一族：
 *   ① **恒等 `t`**：行名与状态句问的都是字典键；宿主写来的整句中文（`label` 与 `detail`）
 *      一句都不许进树 —— 那几行本来就是靠宿主的中文才坏的。
 *   ② **不给 `props.t`**：走客户端中文兜底，句子真出来了、参数真填进去了
 *      （`{count}`、`{model}`、`{runtime}` 一个都不许留成字面量）。
 *   ③ **换成英文 `t`**：这一块的英文是这批的目的；树里剩下的每一段汉字都得是
 *      英文文案自己举的例子。
 *
 * 词表外的值各判一次：`id: 'future-engine'` + 一个不在码表里的 `reason` ——
 * 行名走「另一个引擎（future-engine）」（id 是用户认得出来的东西），
 * 状态句走兜底那句，宿主原文照样不许出现。sovits 那行的 `url` 是**数据**（用户自己填的地址），
 * 原样显示，这是「不许渲染宿主文案」唯一的例外。
 */
async function scenarioPanelEnvCheck() {
  await settle()
  resetEnv()
  if (!SettingsSection) {
    check('[面板·环境自检] 设置面板组件注册可得', false, 'settings.section 没注册')
    return
  }
  const savedConfig = { ...env.config }
  const store = exportsObj.__test.configStore
  const clearStore = () => { store.value = {}; store.loaded = false }

  // 假宿主文案：`label`（改前的行名）与每行 `detail`（改前的状态句）都写成一望即知的句子。
  const HOST_TEXT = [
    '宿主写的引擎名不许上界面',
    '宿主写的在线状态原文不许上界面',
    '宿主写的本地状态原文不许上界面',
    '宿主写的神经状态原文不许上界面',
    '宿主将来新写的一句中文也不许上界面',
  ]
  const SOVITS_URL = 'http://127.0.0.1:9880'
  env.ttsEnv = {
    platform: 'win32',
    arch: 'x64',
    node: 'v22.11.0',
    gpu: { available: false, name: '', memoryMB: 0 },
    configured: 'online',
    engines: [
      {
        id: 'online',
        label: HOST_TEXT[0],
        available: true,
        reason: TTS_ENV_REASONS.ONLINE_READY,
        params: { count: '32' },
        detail: HOST_TEXT[1],
      },
      {
        id: 'local',
        available: false,
        reason: TTS_ENV_REASONS.LOCAL_MISSING_ESPEAK,
        params: {},
        detail: HOST_TEXT[2],
      },
      {
        id: 'neural',
        available: true,
        reason: TTS_ENV_REASONS.NEURAL_READY,
        params: { model: 'vits-melo-zh_en', runtime: 'native' },
        detail: HOST_TEXT[3],
      },
      // 外部服务：不探测（所以状态是中性 `·`），只报「是不是当前引擎 + 地址」。
      { id: 'sovits', supported: true, configured: false, url: SOVITS_URL },
      // 词表外的行：新 id + 不认识的码，两处都该走兜底。
      {
        id: 'future-engine',
        available: false,
        reason: 'a-code-not-in-the-table',
        params: {},
        detail: HOST_TEXT[4],
      },
    ],
  }

  /** 点「重新检查」把 envInfo 拉下来（那几行挂载时不渲染）。按钮上的字每轮不一样。 */
  const clickEnvCheck = async (label) => {
    const button = findByProp(runtime.getTree(), (n) => n.type === 'button'
      && n.props?.children === label && typeof n.props?.onClick === 'function')
    if (!button) return false
    button.props.onClick()
    await settle()
    await sleep(200)
    return true
  }

  const leakedHostText = (strings) => HOST_TEXT.filter((line) => strings.some((value) => value.includes(line)))
  const hasSourceIn = (dictionary) => {
    const bank = Object.values(dictionary)
      .map((value) => String(value).replace(new RegExp(`[^${HAN}]`, 'g'), ''))
      .filter(Boolean)
    return (value) => hanRuns(value).every((run) => bank.some((entry) => entry.includes(run)))
  }
  const inEnglishDictionary = hasSourceIn(en)

  /* ---- ① 恒等 t：行名与句子都得是字典键，宿主的整句中文不进树 ---- */
  clearStore()
  runtime.unmount()
  const askedKeys = new Set()
  runtime.mount(SettingsSection, { t: (key) => { askedKeys.add(String(key)); return String(key) } })
  await sleep(400)
  {
    const clicked = await clickEnvCheck('envRecheck')
    check('[面板·环境自检] 「重新检查」按钮找得到（那几行要点了才渲染）',
      clicked, '树上没有 children 为「envRecheck」的按钮')
    const strings = visibleStrings(runtime.getTree())
    const leaked = leakedHostText(strings)
    check('[面板·环境自检] 宿主写的 5 句中文（`label` 与每行 `detail`）在树里一句都不出现',
      leaked.length === 0, leaked.join(' / '))
    const withHan = strings.filter((value) => hanRe.test(value))
    const noSource = withHan.filter((value) => !hasDictionarySource(value))
    check('[面板·环境自检] 恒等 t 下含汉字的串每一个都能在字典里找到出处',
      noSource.length === 0, noSource.slice(0, 8).map((value) => JSON.stringify(value)).join(' | '))
    const EXPECTED_KEYS = [
      'envEngineOnline', 'envEngineLocal', 'envEngineNeural', 'envEngineSovits',
      'envReasonOnlineReady', 'envReasonLocalMissingEspeak', 'envReasonNeuralReady',
      'envEngineUnknown', 'envReasonUnknown',
    ]
    const neverAsked = EXPECTED_KEYS.filter((key) => !askedKeys.has(key))
    check(`${EXPECTED_KEYS.length} 个行名/状态句键真被面板问过（问过 = 那句话由字典出，不是抄宿主的）`,
      neverAsked.length === 0, `没问过：${neverAsked.join(',')}`)
    check('[面板·环境自检] 面板问字典的键里没有一个带汉字',
      [...askedKeys].every((key) => !hanRe.test(key)),
      [...askedKeys].filter((key) => hanRe.test(key)).slice(0, 6).join(' / '))
    check('[面板·环境自检] sovits 那行显示的是用户自己填的地址（数据不是文案，原样上界面）',
      // 面板把整行拼成一个字符串（`· 行名：url`），所以按「哪一段里有这个地址」找，
      // 再把同一行里的行名一起判住 —— 只判 URL 在不在，会漏掉「行名被宿主那句顶掉」这种回归。
      strings.some((value) => value.includes(SOVITS_URL) && value.includes('envEngineSovits')),
      strings.filter((value) => value.includes('127.0.0.1')).slice(0, 3).join(' / '))
  }

  /* ---- ② 没有 props.t：中文兜底，句子真出来、参数真填进去 ---- */
  runtime.unmount()
  clearStore()
  runtime.mount(SettingsSection, {})
  await sleep(400)
  {
    const clicked = await clickEnvCheck(zh.envRecheck)
    check('[面板·环境自检·兜底] 兜底挂载里也点得到「重新检查」',
      clicked, `树上没有 children 为「${zh.envRecheck}」的按钮`)
    const tree = runtime.getTree()
    const strings = visibleStrings(tree)
    const leaked = leakedHostText(strings)
    check('[面板·环境自检·兜底] 兜底挂载里宿主的整句中文同样不进界面',
      leaked.length === 0, leaked.join(' / '))
    // needle 全部从字典取（判据里抄一句中文，等于判据自己也成了一处硬编码）。
    check('[面板·环境自检·兜底] 四行的行名是字典里那四句',
      treeHasText(tree, zh.envEngineOnline) && treeHasText(tree, zh.envEngineLocal)
        && treeHasText(tree, zh.envEngineNeural) && treeHasText(tree, zh.envEngineSovits),
      strings.filter((value) => value.includes('引擎') || value.includes('模型')).slice(0, 6).join(' / '))
    check('[面板·环境自检·兜底] 状态句是字典那句，且 {count} / {model} / {runtime} 真被填进去',
      treeHasText(tree, interpolate(zh.envReasonOnlineReady, { count: '32' }))
        && treeHasText(tree, interpolate(zh.envReasonNeuralReady, { model: 'vits-melo-zh_en', runtime: zh.envRuntimeNative }))
        && treeHasText(tree, zh.envReasonLocalMissingEspeak),
      strings.filter((value) => value.includes('音色') || value.includes('运行时')).slice(0, 6).join(' / '))
    check('[面板·环境自检·兜底] 词表外的行：行名带出 id、状态句走兜底那句',
      treeHasText(tree, interpolate(zh.envEngineUnknown, { id: 'future-engine' }))
        && treeHasText(tree, zh.envReasonUnknown),
      strings.filter((value) => value.includes('future') || value.includes('读不出来')).slice(0, 4).join(' / '))
    check('[面板·环境自检·兜底] 界面上不留没被填掉的 {占位符}',
      !strings.some((value) => /\{\w+\}/.test(value)),
      strings.filter((value) => /\{\w+\}/.test(value)).slice(0, 5).join(' / '))
    const withHan = strings.filter((value) => hanRe.test(value))
    const noSource = withHan.filter((value) => !hasDictionarySource(value))
    check('[面板·环境自检·兜底] 含汉字的串每一个都有字典出处',
      noSource.length === 0, noSource.slice(0, 8).map((value) => JSON.stringify(value)).join(' | '))
  }
  runtime.unmount()

  /* ---- ③ 换成英文 t：这一块跟着界面语言走 ---- */
  clearStore()
  runtime.mount(SettingsSection, { t: (key, params) => interpolate(String(en[key] ?? key), params) })
  await sleep(400)
  {
    const clicked = await clickEnvCheck(en.envRecheck)
    check('[面板·环境自检·英文] 英文挂载里点得到 "Re-check"',
      clicked, `树上没有 children 为「${en.envRecheck}」的按钮`)
    const tree = runtime.getTree()
    const strings = visibleStrings(tree)
    const leaked = leakedHostText(strings)
    check('[面板·环境自检·英文] 切英文后宿主的中文更不许进界面',
      leaked.length === 0, leaked.join(' / '))
    check('[面板·环境自检·英文] 行名与状态句显示的是英文字典那几句（参数同样填好）',
      treeHasText(tree, en.envEngineOnline) && treeHasText(tree, en.envEngineSovits)
        && treeHasText(tree, interpolate(en.envReasonOnlineReady, { count: '32' }))
        && treeHasText(tree, interpolate(en.envReasonNeuralReady, { model: 'vits-melo-zh_en', runtime: en.envRuntimeNative }))
        && treeHasText(tree, en.envReasonUnknown),
      strings.filter((value) => /voice|runtime|engine/i.test(value)).slice(0, 6).join(' / '))
    const withHan = strings.filter((value) => hanRe.test(value))
    const noEnSource = withHan.filter((value) => !inEnglishDictionary(value))
    check('[面板·环境自检·英文] 英文界面里的每一段汉字都是英文文案自己举的例子（有别的出处 = 那一处没跟着翻译）',
      noEnSource.length === 0, noEnSource.slice(0, 6).map((value) => JSON.stringify(value)).join(' | '))
    check('[面板·环境自检·英文] 判据自己有牙：宿主那几句中文放进英文树里会被抓住',
      HOST_TEXT.every((line) => !inEnglishDictionary(line)),
      HOST_TEXT.filter((line) => inEnglishDictionary(line)).join(' / '))
  }

  runtime.unmount()
  clearStore()
  env.config = savedConfig
  env.ttsEnv = null
  check('[面板·环境自检] 没有异常甩出渲染/事件回调', env.warnings.length === 0, env.warnings.join('\n'))
}

/**
 * 场景 26f：保存请求**根本没走通**时，那行红字也只能由字典出（批次 22-3-3，docs §8.68）。
 *
 * 改前的形状：`setSaveErrors([`${t('saveFailed')}：${error.message}`])`。
 * 这一支 catch 接的是 fetch 被拒（宿主没在监听、页面被关、网络抖一下），
 * 所以拼进界面的是**浏览器给的技术串**（Chrome 是 `Failed to fetch`）：
 * 中文界面冒一句英文串，英文界面那句也读不出「该做什么」。
 * 这一族和批次 18/19/20/22 判的是同一件事 —— 只看「这句话会不会进界面」，
 * 不看它是宿主的中文还是浏览器的英文。原始 message 现在只进 `console.warn`。
 *
 * 三轮挂载各判一次：① 恒等 `t`（红字是字典键，且请求真发出去过一次 —— 不然判据是空转）、
 * ② 中文兜底（显示 `zh` 那句，期望值从字典取，判据里不抄中文）、③ 英文 `t`（显示 `en` 那句）。
 * 状态行另判一条：那里仍是短词（§8.34 那条「状态行只放短词」的约定没被本批破掉）。
 */
async function scenarioSaveRejectSentence() {
  await settle()
  resetEnv()
  if (!SettingsSection) {
    check('[面板·保存·没连通] 设置面板组件注册可得', false, 'settings.section 没注册')
    return
  }
  const savedConfig = { ...env.config }
  env.config.shortcut = 'Alt+V'
  const RAW = 'Failed to fetch'
  const store = exportsObj.__test.configStore
  const clearStore = () => { store.value = {}; store.loaded = false }

  // 生产把那串原文交给 console.warn（装机排查从那儿读），这里把它收起来判。
  const realWarn = console.warn
  let warned = []
  console.warn = (...args) => {
    warned.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  }

  /** 改一下词表让按钮可点，再点保存；返回按钮找不找得到。每轮按钮上的字不一样。 */
  const driveSave = async (label) => {
    warned = []
    env.configSaveReject = RAW
    const box = panelWordsBox()
    if (!box) return false
    box.props.onChange({ target: { value: `改一点 ${env.configPosts.length}` } })
    await sleep(60)
    box.props.onBlur()
    await sleep(60)
    const button = panelButton(label)
    if (!button) return false
    button.props.onClick()
    await sleep(150)
    return true
  }

  try {
    /* ---- ① 恒等 t：红字是字典键，浏览器那串原文不进树 ---- */
    runtime.unmount()
    clearStore()
    runtime.mount(SettingsSection, { t: (key, params) => interpolate(String(key), params) })
    await sleep(400)
    const postsBefore = env.configPosts.length
    const clicked = await driveSave('save')
    check('[面板·保存·没连通] 恒等 t 挂载里点得到保存', clicked, '树上没有 children 为「save」的按钮')
    const tree = runtime.getTree()
    const strings = visibleStrings(tree)
    check('[面板·保存·没连通] 请求真发出去过一次（判据不是空转：catch 真的被执行了）',
      env.configPosts.length === postsBefore + 1,
      `发出 ${env.configPosts.length - postsBefore} 次`)
    check('[面板·保存·没连通] 红字是字典那句（恒等 t 下就是那个键）',
      treeHasText(tree, 'saveFailedNetwork'),
      strings.filter((value) => value.includes('save')).slice(0, 4).join(' / '))
    check('[面板·保存·没连通] 浏览器那句原始 message 不上界面',
      !strings.some((value) => value.includes(RAW)),
      strings.filter((value) => value.includes(RAW)).slice(0, 3).join(' / '))
    check('[面板·保存·没连通] 那串原文仍然看得见（进 console.warn，装机排查读得到）',
      warned.some((line) => line.includes(RAW)), warned.slice(0, 3).join(' / '))
    check('[面板·保存·没连通] 状态行是短词那一格，长句子只进红字那一行（§8.34 的约定没被破）',
      strings.some((value) => value === 'saveFailed')
        && strings.some((value) => value === 'saveFailedNetwork')
        && !strings.some((value) => value.includes('saveFailed') && value.includes('：')),
      strings.filter((value) => /save/i.test(value)).slice(0, 6).join(' / '))

    /* ---- ② 中文兜底：显示的是字典那句 ---- */
    runtime.unmount()
    clearStore()
    runtime.mount(SettingsSection, {})
    await sleep(400)
    const clickedZh = await driveSave(zh.save)
    check('[面板·保存·没连通·兜底] 兜底挂载里也点得到保存',
      clickedZh, `树上没有 children 为「${zh.save}」的按钮`)
    const treeZh = runtime.getTree()
    const stringsZh = visibleStrings(treeZh)
    check('[面板·保存·没连通·兜底] 红字是字典中文那句（期望值从 zh 取，判据不抄中文）',
      treeHasText(treeZh, zh.saveFailedNetwork),
      stringsZh.filter((value) => value.includes(zh.saveFailed)).slice(0, 3).join(' / '))
    check('[面板·保存·没连通·兜底] 浏览器那串英文技术串没混进中文界面',
      !stringsZh.some((value) => value.includes(RAW)),
      stringsZh.filter((value) => value.includes(RAW)).slice(0, 3).join(' / '))

    /* ---- ③ 英文 t：同一件事，跟着界面语言走 ---- */
    runtime.unmount()
    clearStore()
    runtime.mount(SettingsSection, { t: (key, params) => interpolate(String(en[key] ?? key), params) })
    await sleep(400)
    const clickedEn = await driveSave(en.save)
    check('[面板·保存·没连通·英文] 英文挂载里点得到 "Save"',
      clickedEn, `树上没有 children 为「${en.save}」的按钮`)
    const treeEn = runtime.getTree()
    const stringsEn = visibleStrings(treeEn)
    check('[面板·保存·没连通·英文] 红字显示的是英文那句',
      treeHasText(treeEn, en.saveFailedNetwork),
      stringsEn.filter((value) => /save/i.test(value)).slice(0, 3).join(' / '))
    check('[面板·保存·没连通·英文] 那串技术串同样不进界面',
      !stringsEn.some((value) => value.includes(RAW)),
      stringsEn.filter((value) => value.includes(RAW)).slice(0, 3).join(' / '))
  } finally {
    console.warn = realWarn
    env.configSaveReject = ''
    runtime.unmount()
    clearStore()
    Object.assign(env.config, savedConfig)
  }
  check('[面板·保存·没连通] 没有异常甩出渲染/事件回调', env.warnings.length === 0, env.warnings.join('\n'))
}

/**
 * 场景 26b：「追赶最新」那只秒数输入框（批次 6f 补）。
 *
 * 替掉的是 `test/read-aloud-stop.test.mjs` 里那条扫源码的判据
 * （`const raw = String(...)` / `raw === '' || !Number.isFinite(n)` /
 *   `? 7.5 : Math.max(0, Math.min(120, Math.round(n * 2) / 2))` 三连正则）。
 * 它原来留着的理由写的是「这是设置面板的输入框行为，归批次 5 与 config-ui 一起换成组件级判据」，
 * 这一批真的把它换成组件级：挂真面板、往真输入框里敲、看真发出去的 POST /config 值。
 *   空串与非法值 → 回退默认 7.5（不是 0！`Number('')` 是 0，落到 0 等于悄悄关掉追赶）；
 *   越界 → clamp 到 0..120；
 *   合法小数 → 按 0.5 步进取整。
 * 判的是配置里的 `readAloudLag` 与输入框当场显示的值，跟代码怎么写无关。
 */
async function scenarioSettingsLagClamp() {
  await settle()
  resetEnv()
  if (!SettingsSection) {
    check('[面板·追赶] 设置面板组件注册可得', false, 'settings.section 没注册')
    return
  }
  const savedLag = env.config.readAloudLag
  env.config = { ...env.config, readAloudLag: 7.5 }
  await mountPanel()
  const lagBox = () => findByProp(runtime.getTree(),
    (n) => n.type === 'input' && n.props?.type === 'number' && Number(n.props?.step) === 0.5)
  check('[面板·追赶] 输入框挂得出来（number + 0.5 步进，全树只有这一只）',
    Boolean(lagBox()?.props?.onChange), JSON.stringify(lagBox()?.props?.value))
  if (!lagBox()?.props?.onChange) { env.config.readAloudLag = savedLag; return }
  const drive = async (rawValue) => {
    env.configPosts.length = 0
    lagBox().props.onChange({ target: { value: rawValue } })
    await sleep(60)
    const shown = lagBox()?.props?.value
    const saveButton = panelButton('save')
    if (typeof saveButton?.props?.onClick === 'function') saveButton.props.onClick()
    await sleep(150)
    return { shown, posted: env.configPosts[0]?.readAloudLag, posts: env.configPosts.length }
  }
  const cases = [
    ['', 7.5, '清空输入框回退默认 7.5（不是 0 = 关掉追赶）'],
    ['abc', 7.5, '非法值同样回退 7.5'],
    ['300', 120, '超过上限 clamp 到 120'],
    ['-5', 0, '低于下限 clamp 到 0'],
    ['7.7', 7.5, '按 0.5 步进取整（7.7 → 7.5）'],
    ['7.8', 8, '按 0.5 步进取整（7.8 → 8）'],
    ['0', 0, '0 是合法值，原样保留（0 = 全部朗读、不跳段）'],
  ]
  for (const [raw, want, why] of cases) {
    const r = await drive(raw)
    check(`[面板·追赶] 敲进「${raw}」→ ${why}`, r.posts === 1 && r.posted === want, JSON.stringify(r))
  }
  check('[面板·追赶] 没有异常甩出渲染/事件回调', env.warnings.length === 0, env.warnings.join('\n'))
  env.config = { ...env.config, readAloudLag: savedLag }
  runtime.unmount()
}

/**
 * 场景 26c：面板里的 GPT-SoVITS 引擎（批次 6g）。
 *
 * 取代 `test/sovits-tts.test.mjs` 里那条客户端判据：
 *   「客户端有引擎选项与设置项（构建产物）」= /GPT-SoVITS 外部服务/ && /sovitsUrl/ && /sovitsRefAudio/
 * 它只要源码里出现过这三个词就绿 —— 选项没进下拉框、输入框在选 sovits 时压根不渲染、
 * 敲进去的值没进保存 payload，它全都照样绿。这里对着判四件事：
 *   ① 下拉框里真有这四个引擎、当前值来自配置；
 *   ② 引擎是在线时 sovits 那两格**不**渲染（条件渲染真的存在）；
 *   ③ 真把引擎选成 sovits 之后地址/参考音频输入框出现，并带着配置里的值；
 *   ④ 敲进去再保存，POST /config 里就是这三键（宿主 `/tts` 读的就是它们）。
 */
async function scenarioSovitsEngine() {
  await settle()
  resetEnv()
  if (!SettingsSection) {
    check('[面板·sovits] 设置面板组件注册可得', false, 'settings.section 没注册')
    return
  }
  const savedConfig = { ...env.config }
  env.config = {
    ...env.config,
    ttsEngine: 'online',
    sovitsUrl: 'http://127.0.0.1:9880',
    sovitsRefAudio: '/ref/voice.wav',
    shortcut: 'Alt+V',
    globalShortcut: 'Ctrl+Alt+V',
  }
  await mountPanel()

  const engineSelect = () => findByProp(runtime.getTree(), (n) => n.type === 'select'
    && flattenChildren(n.props?.children).some((c) => c && typeof c === 'object' && c.props?.value === 'sovits'))
  const boxWithValue = (want) => findByProp(runtime.getTree(), (n) => n.type === 'input'
    && n.props?.value === want && typeof n.props?.onChange === 'function')
  const refBox = () => findByProp(runtime.getTree(), (n) => n.type === 'input'
    && n.props?.placeholder === '/path/to/reference.wav')

  check('[面板·sovits] 引擎下拉框里真有 GPT-SoVITS 这一项（旧判据只要源码里出现过这个词）',
    Boolean(engineSelect()), '下拉框里没有 sovits 这一项')
  if (!engineSelect()) {
    env.config = savedConfig
    runtime.unmount()
    return
  }
  const options = flattenChildren(engineSelect().props.children).map((c) => c?.props?.value)
  check('[面板·sovits] 四个引擎都在、顺序与词表一致',
    JSON.stringify(options) === JSON.stringify(['online', 'neural', 'local', 'sovits']), options.join(','))
  check('[面板·sovits] 当前选中的就是配置里的引擎',
    engineSelect().props.value === 'online', String(engineSelect().props.value))

  /* ---- ① 在线档：sovits 的两格不该出现 ---- */
  check('[面板·sovits] 引擎是在线时不渲染 GPT-SoVITS 的地址/参考音频输入框',
    !treeHasText(runtime.getTree(), 'sovitsUrl') && !boxWithValue(env.config.sovitsUrl) && !refBox(),
    '没选 sovits 也把外部服务的设置格画出来了')
  // 顶部那条「现在用什么在念」也得不认账：`ttsCurrent` 在非 sovits 档不许写 GPT-SoVITS。
  check('[面板·sovits] 在线档时顶部状态行不写 GPT-SoVITS',
    !treeHasText(runtime.getTree(), 'GPT-SoVITS ('), '状态行认错了引擎')

  /* ---- ② 真把引擎选成 sovits ---- */
  engineSelect().props.onChange({ target: { value: 'sovits' } })
  await sleep(120)
  check('[面板·sovits] 选成 sovits 后下拉框的值跟着变',
    engineSelect()?.props?.value === 'sovits', String(engineSelect()?.props?.value))
  check('[面板·sovits] 选成 sovits 后地址输入框出现，带着配置里那份地址',
    boxWithValue('http://127.0.0.1:9880') !== null && treeHasText(runtime.getTree(), 'sovitsUrl'),
    'sovitsUrl 输入框没渲染出来')
  check('[面板·sovits] 选成 sovits 后参考音频输入框出现，带着配置里那份路径',
    refBox()?.props?.value === '/ref/voice.wav', JSON.stringify(refBox()?.props?.value))
  check('[面板·sovits] 顶部状态行改成「现在用 GPT-SoVITS（地址）」',
    treeHasText(runtime.getTree(), 'GPT-SoVITS (http://127.0.0.1:9880'),
    '状态行还写着别的引擎')

  /* ---- ③ 改地址 + 保存：POST 的就是宿主 /tts 要读的那三键 ---- */
  env.configPosts.length = 0
  boxWithValue('http://127.0.0.1:9880').props.onChange({ target: { value: 'http://127.0.0.1:9999' } })
  await sleep(80)
  const urlBoxAfter = boxWithValue('http://127.0.0.1:9999')
  check('[面板·sovits] 敲进去的地址原样留在输入框', Boolean(urlBoxAfter), '改完就丢了')
  check('[面板·sovits] 顶部状态行跟着草稿走（改地址立刻看得见）',
    treeHasText(runtime.getTree(), 'GPT-SoVITS (http://127.0.0.1:9999'),
    '改了地址状态行还写着旧的')
  const saveButton = panelButton('save')
  check('[面板·sovits] 有改动 → 保存按钮可点', saveButton?.props?.disabled === false,
    `disabled=${saveButton?.props?.disabled}`)
  saveButton?.props?.onClick()
  await sleep(150)
  const post = env.configPosts[0] ?? null
  check('[面板·sovits] 保存真发出 ttsEngine=sovits + 新地址 + 参考音频路径',
    post?.ttsEngine === 'sovits' && post?.sovitsUrl === 'http://127.0.0.1:9999'
    && post?.sovitsRefAudio === '/ref/voice.wav',
    JSON.stringify({ ttsEngine: post?.ttsEngine, sovitsUrl: post?.sovitsUrl, sovitsRefAudio: post?.sovitsRefAudio }))
  check('[面板·sovits] 没有异常甩出渲染/事件回调', env.warnings.length === 0, env.warnings.join('\n'))

  env.config = savedConfig
  runtime.unmount()
}

/**
 * 场景 27：模型下载状态（面板重开恢复进度 / 点一下立刻标记 / 失败撤销 / 事件后刷列表
 * / 失败那行的原因由字典出 —— 批次 22-4-2，§8.71）。
 *
 * 取代 `test/model-panel-shape.test.mjs` 那 10 条源码形状判据（该文件整批搬空）。
 */
async function scenarioSettingsModelDownload() {
  await settle()
  resetEnv()
  if (!SettingsSection) { check('[面板] 设置面板组件注册可得', false, 'settings.section 没注册'); return }
  const MB = 1024 * 1024
  // 面板把宿主那两句原文交给 console.warn（不进界面，装机排查从那儿读），
  // 这里把它收起来判 —— 「原文去哪儿了」是这一批的另一半判据：
  // 丢掉原因（改前 `model-error` 那条路）和泄漏原文（改前 `POST /model` 那条路）
  // 都不是解，解是「句子由字典出、原文由 console 出」。
  const realWarn = console.warn
  const warned = []
  console.warn = (...args) => {
    warned.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  }

  /* ---- ① 面板重开要能恢复「下载中」 ---- */
  env.models = [
    { id: 'sensevoice', label: 'SenseVoice', category: 'asr', ready: false, bytes: 100 * MB, downloading: true, received: 30 * MB, total: 100 * MB },
  ]
  await mountPanel()
  check('[面板·下载] 重开面板后状态行显示「下载中」（进度从 /models 的数据恢复）',
    treeHasText(runtime.getTree(), 'downloading'), '关掉再打开进度就没了')
  check('[面板·下载] 模型行显示下载百分比（30/100 → 30%，判的是那一行自己那格）',
    panelModelRowCells('sensevoice')?.[1] === 'neuralDownloading 30%',
    JSON.stringify(panelModelRowCells('sensevoice')))
  check('[面板·下载] 恢复进度没把 setState 塞进更新函数（React 反模式）',
    env.updaterSideEffects.length === 0, JSON.stringify(env.updaterSideEffects))

  /* ---- ② SSE 的进度真的接进进度条：用一个列表里不存在的 id ---- */
  const sse = env.eventSources[env.eventSources.length - 1]
  check('[面板·下载] 面板挂载建起了事件流（进度/完成/失败都从它来）', Boolean(sse) && sse.closed !== true)
  sse?.emit('model-progress', { id: 'zipformer2-zh', received: 40 * MB, total: 100 * MB, percent: 40 })
  await sleep(80)
  check('[面板·下载] model-progress 的百分比进了进度行（那个 id 不在列表里 → 只能来自 progress）',
    treeHasText(runtime.getTree(), 'neuralDownloading 40%'), 'SSE 的进度没被采纳')
  check('[面板·下载] 进度事件里也没把 setState 塞进更新函数（上面那条只管挂载，这段是事件路径）',
    env.updaterSideEffects.length === 0, JSON.stringify(env.updaterSideEffects))

  /* ---- ③ 下载完成 / 失败都必须重新拉模型列表 ---- */
  // 先让宿主侧「下载完成」：/models 下一次返回的就是就绪、不再下载中。
  // （不这么做的话刷新回来的还是 downloading:true，「完成后进度行消失」那条判的是
  //  一个宿主本来就不会再给的状态 —— 假红。）
  env.models = [
    { id: 'sensevoice', label: 'SenseVoice', category: 'asr', ready: true, bytes: 100 * MB, downloading: false },
  ]
  const modelsBefore = fetchCount('/models')
  sse?.emit('model-ready', { id: 'sensevoice' })
  await sleep(300)
  check('[面板·下载] model-ready 之后重新拉 /models（否则 ready 一直是 false、按钮一直禁着）',
    fetchCount('/models') === modelsBefore + 1, `${modelsBefore} → ${fetchCount('/models')}`)
  check('[面板·下载] 完成后进度行消失、状态显示已就绪',
    !treeHasText(runtime.getTree(), 'neuralDownloading') && treeHasText(runtime.getTree(), 'ready2'),
    '还挂着旧进度')

  env.models = [] // 宿主那边下载标记已清（失败后不刷的话「下载中」去不掉 → 按钮一直禁用）
  const modelsBeforeError = fetchCount('/models')
  // 事件载荷是批次 22-4-1 之后宿主真回的那一份：`reason` + `params` + 原文 `error`。
  // 改前面板写的是 `void parseEnvelope(event)` —— 载荷接过来又丢地上，
  // 用户只看到「下载失败」，分不清是分片没下全还是档位表写错了。
  sse?.emit('model-error', {
    id: 'sensevoice',
    kind: 'asr',
    reason: 'chunk-failed',
    params: { file: 'model.onnx', chunks: '2, 5' },
    error: '分片下载失败：model.onnx（第 2, 5 片）',
  })
  await sleep(300)
  check('[面板·下载] model-error 之后也重新拉 /models',
    fetchCount('/models') === modelsBeforeError + 1, `${modelsBeforeError} → ${fetchCount('/models')}`)
  check('[面板·下载] 失败那行显示**具体原因**（码查到的那个键，不是通用的「下载失败」）',
    treeHasText(runtime.getTree(), 'downloadReasonChunkFailed'),
    visibleStrings(runtime.getTree()).filter((value) => /download/i.test(value)).join(' / '))
  check('[面板·下载] 宿主那句原文不进界面（原文只给 console 与 /diagnostics）',
    !treeHasText(runtime.getTree(), '分片下载失败'),
    visibleStrings(runtime.getTree()).filter((value) => value.includes('失败')).join(' / '))
  check('[面板·下载] 原文确实落进了 console.warn（丢弃原因和泄漏原文是两种毛病，正确去处是这儿）',
    warned.some((line) => line.includes('model download failed')
      && line.includes('分片下载失败：model.onnx（第 2, 5 片）')),
    warned.slice(-3).join(' | '))

  /* ---- ④ 点「下载模型」：当场就要标成下载中，不能等 SSE 第一条事件 ---- */
  env.models = [{ id: 'whisper-tiny', label: 'Whisper tiny', category: 'asr', ready: false, bytes: 75 * MB }]
  await mountPanel()
  const downloadButton = panelButton('neuralDownload')
  check('[面板·下载] 未就绪的模型行有「下载模型」按钮', Boolean(downloadButton),
    '列表或按钮形状变了，这一段的对象就没了')
  if (downloadButton) {
    downloadButton.props.onClick()
    await sleep(60)
    check('[面板·下载] 点一下立刻发出 POST /model（带那个 id）',
      env.modelDownloads.length === 1 && env.modelDownloads[0] === 'whisper-tiny',
      JSON.stringify(env.modelDownloads))
    check('[面板·下载] 点下去当场变「下载中」（不等 SSE，用户才知道按到了）',
      panelButton('neuralDownloading') !== null, '没找到「下载中」那只按钮')
    check('[面板·下载] 下载中的按钮禁用（不能重复点）',
      panelButton('neuralDownloading')?.props?.disabled === true,
      `disabled=${panelButton('neuralDownloading')?.props?.disabled}`)
    check('[面板·下载] 点击路径同样没在更新函数里调别的 setState',
      env.updaterSideEffects.length === 0, JSON.stringify(env.updaterSideEffects))

    /* ---- ⑤ 请求被拒 → 撤销「下载中」标记，原因由字典出 ---- */
    env.modelDownloadFail = {
      status: 404,
      reason: 'unknown-model',
      params: { model: 'ghost-tier' },
      error: 'unknown model: ghost-tier',
    }
    await mountPanel()
    panelButton('neuralDownload')?.props.onClick()
    await sleep(300)
    check('[面板·下载] 被拒后撤销下载中标记（按钮回到「下载模型」，能再点）',
      panelButton('neuralDownload') !== null, '标记没撤 → 按钮永远禁用')
    check('[面板·下载] 被拒那行显示的是码查到的那句（改前这里是把宿主原文直接 setStatus）',
      treeHasText(runtime.getTree(), 'downloadReasonUnknownModel'),
      visibleStrings(runtime.getTree()).filter((value) => /download/i.test(value)).join(' / '))
    check('[面板·下载] 宿主路由层那句英文原文不在界面上（中文界面不许冒 `unknown model:`）',
      !treeHasText(runtime.getTree(), 'unknown model'),
      visibleStrings(runtime.getTree()).filter((value) => value.includes('unknown')).join(' / '))
    check('[面板·下载] 被拒那句原文同样只进 console.warn',
      warned.some((line) => line.includes('download rejected') && line.includes('unknown model: ghost-tier')),
      warned.slice(-3).join(' | '))

    /* ---- ⑤b 旧宿主：非 2xx 但没有码 → 走那句通用的，不显示原文也不崩 ---- */
    env.modelDownloadFail = { status: 503, error: '磁盘空间不足' }
    await mountPanel()
    panelButton('neuralDownload')?.props.onClick()
    await sleep(300)
    check('[面板·下载] 没带码的拒绝走兼容那句（downloadFailed），而不是把宿主的话贴上来',
      treeHasText(runtime.getTree(), 'downloadFailed') && !treeHasText(runtime.getTree(), '磁盘空间不足'),
      visibleStrings(runtime.getTree()).filter((value) => /download|磁盘/i.test(value)).join(' / '))
    env.modelDownloadFail = null
  }
  check('[面板·下载] 没有异常甩出事件回调', env.warnings.length === 0, env.warnings.join('\n'))
  env.models = []
  runtime.unmount()

  /* ---- ⑥ 真字典挂载（没有 props.t = 中文兜底）：那句真的填好了参数 ---- */
  // 前面几段都用恒等 t，判的是「面板问的是哪个键」；键名对了不等于句子填得进去。
  // 这一段按真中文跑：`{file}` 与 `{status}` 必须被宿主带来的参数填掉。
  env.models = [{ id: 'whisper-tiny', label: 'Whisper tiny', category: 'asr', ready: false, bytes: 75 * MB }]
  env.modelDownloadFail = {
    status: 404,
    reason: 'file-not-in-repo',
    params: { file: 'decoder_model.onnx', status: 404 },
    error: '分片下载失败前先探到仓库里没有：404',
  }
  runtime.mount(SettingsSection, {})
  await sleep(300)
  {
    panelButton(zh.neuralDownload)?.props.onClick()
    await sleep(300)
    const tree = runtime.getTree()
    check('[面板·下载·中文] 状态行是字典那句中文，参数真填进去了（文件名 + 状态号）',
      treeHasText(tree, interpolate(zh.downloadReasonNotInRepo, { file: 'decoder_model.onnx', status: '404' })),
      visibleStrings(tree).filter((value) => value.includes('仓库')).join(' / '))
    check('[面板·下载·中文] 界面上不留没被填掉的 {占位符}',
      !visibleStrings(tree).some((value) => /\{\w+\}/.test(value)),
      visibleStrings(tree).filter((value) => /\{\w+\}/.test(value)).slice(0, 5).join(' / '))
    check('[面板·下载·中文] 宿主那句原文一个字都没上界面',
      !treeHasText(tree, '分片下载失败前先探到'), '')
  }
  runtime.unmount()
  env.modelDownloadFail = null

  /* ---- ⑦ 换成英文 t：那一行跟着界面语言走 ---- */
  env.models = [{ id: 'whisper-tiny', label: 'Whisper tiny', category: 'asr', ready: false, bytes: 75 * MB }]
  env.modelDownloadFail = {
    status: 404,
    reason: 'file-not-in-repo',
    params: { file: 'decoder_model.onnx', status: 404 },
    error: '分片下载失败前先探到仓库里没有：404',
  }
  runtime.mount(SettingsSection, { t: (key, params) => interpolate(String(en[key] ?? key), params) })
  await sleep(300)
  {
    panelButton(en.neuralDownload)?.props.onClick()
    await sleep(300)
    const tree = runtime.getTree()
    check('[面板·下载·英文] 那一行是英文字典那句（切英文不许掉回中文）',
      treeHasText(tree, interpolate(en.downloadReasonNotInRepo, { file: 'decoder_model.onnx', status: '404' })),
      visibleStrings(tree).filter((value) => /repository|download/i.test(value)).join(' / '))
    // 只看那一行自己（按参数里的文件名定位）：整棵树扫汉字会误红 ——
    // 英文文案本来就举中文例子（唤醒词、词表写法），那是判据 15 的白名单管的事。
    const lines = visibleStrings(tree).filter((value) => value.includes('decoder_model.onnx'))
    check('[面板·下载·英文] 那一行只有英文字典那句（同一处文字里不夹中文）',
      lines.length === 1 && !/[一-鿿]/.test(lines[0]),
      lines.slice(0, 3).map((value) => JSON.stringify(value)).join(' | '))
    check('[面板·下载·英文] 宿主那句中文更没上界面',
      !treeHasText(tree, '分片下载失败前先探到'), '')
    runtime.unmount()
  }
  env.modelDownloadFail = null
  env.models = []
  console.warn = realWarn
}

/**
 * 场景 28：系统级热键的只读状态行（拉取时机、不轮询、失败降级、不参与保存）
 * + 「组件类型定义在稳定作用域」的行为等价物。
 *
 * 取代 `test/config-ui.test.mjs` 的 B2 四条 + `Row` 那条位置判据。
 */
async function scenarioSettingsHotkeyStatusLine() {
  await settle()
  resetEnv()
  if (!SettingsSection) { check('[面板] 设置面板组件注册可得', false, 'settings.section 没注册'); return }
  const savedConfig = { ...env.config }
  env.config.globalHotkeyHelper = true
  env.config.globalVoice = true
  env.config.shortcut = 'Alt+V'
  env.diagnostics = {
    ok: true,
    hotkeyHelper: { platform: 'win32', status: 'enabled', enabled: true, accelerator: 'Ctrl+Alt+V', reason: '' },
  }

  // 全部按**增量**判：`resetEnv()` 不清 `env.fetchLog`（25 段场景共用的账本），
  // 麦克风那一段挂载时自己也会拉 /diagnostics，绝对数从一开始就不是 0。
  const diagAtMount = fetchCount('/diagnostics')
  await mountPanel()
  check('[热键状态] 面板挂载时拉一次 GET /diagnostics', fetchCount('/diagnostics') === diagAtMount + 1,
    `挂载这一段拉了 ${fetchCount('/diagnostics') - diagAtMount} 次`)
  await sleep(800)
  check('[热键状态] 不轮询：挂着 0.8 秒也只拉过一次', fetchCount('/diagnostics') === diagAtMount + 1,
    `挂载后又拉了 ${fetchCount('/diagnostics') - diagAtMount - 1} 次`)
  check('[热键状态] 渲染的是宿主给的状态（已启用），不是「未开启」',
    treeHasText(runtime.getTree(), 'hotkeyStatusEnabled'), '状态行没采纳诊断结果')

  const refresh = panelButton('hotkeyStatusRefresh')
  check('[热键状态] 手动刷新按钮存在', Boolean(refresh))
  const diagBeforeRefresh = fetchCount('/diagnostics')
  refresh?.props.onClick()
  await sleep(200)
  check('[热键状态] 点一次刷新只多拉一次', fetchCount('/diagnostics') === diagBeforeRefresh + 1,
    `点了刷新拉了 ${fetchCount('/diagnostics') - diagBeforeRefresh} 次`)

  /* ---- 保存后自动再拉一次；而且只读状态绝不进配置 ---- */
  panelWordsBox().props.onChange({ target: { value: '改点别的' } })
  await sleep(60)
  panelWordsBox().props.onBlur()
  await sleep(60)
  const diagBeforeSave = fetchCount('/diagnostics')
  const postsBeforeSave = env.configPosts.length
  panelButton('save')?.props.onClick()
  await sleep(200)
  check('[热键状态] 保存之后自己再拉一次状态（宿主按新配置重新 sync helper）',
    fetchCount('/diagnostics') === diagBeforeSave + 1 && env.configPosts.length === postsBeforeSave + 1,
    `保存确实发了 ${env.configPosts.length - postsBeforeSave} 次、状态拉了 ${fetchCount('/diagnostics') - diagBeforeSave} 次`)
  const post = env.configPosts[env.configPosts.length - 1] ?? {}
  const extraKeys = Object.keys(post).filter((k) => !(k in CONFIG_DEFAULTS))
  check('[热键状态] 发出去的配置里没有只读诊断字段（键集合 ⊆ 配置项键集合）',
    extraKeys.length === 0, `多出这些键：${extraKeys.join(',')}`)
  check('[热键状态] 诊断状态本身也不会被顺手发出去',
    !('hotkeyStatus' in post) && !('accelerator' in post) && !('platform' in post),
    JSON.stringify(Object.keys(post).filter((k) => /hotkey|platform|accelerator/i.test(k))))

  /* ---- 诊断接口不可用 → 「未知」，不谎报已启用 ---- */
  env.diagnosticsFail = true
  const diagBeforeFail = fetchCount('/diagnostics')
  await mountPanel()
  check('[热键状态] 诊断失败降级为「未知」而不是猜一个',
    treeHasText(runtime.getTree(), 'hotkeyStatusUnknown'), '没找到降级文案')
  check('[热键状态] 诊断失败不抛异常、不重试成轮询',
    env.warnings.length === 0 && fetchCount('/diagnostics') === diagBeforeFail + 1,
    `${env.warnings.join(' | ')} / 挂载后又拉了 ${fetchCount('/diagnostics') - diagBeforeFail} 次`)
  env.diagnosticsFail = false

  /* ---- 批次 19：宿主只报码，界面那句话由 i18n 出（docs §8.61） ---- */
  // 挂载用的 `t` 是恒等函数（`t: (k) => k`），所以树里出现的就是**键名**：
  // 键名对上 = 那句确实由字典出；宿主原文/码名不出现在树里 = 它确实没进界面。
  const hotkeyReasonCases = [
    [HOTKEY_REASONS.REGISTER_FAILED, 'failed', 'hotkeyReasonRegister'],
    [HOTKEY_REASONS.NATIVE_UNAVAILABLE, 'failed', 'hotkeyReasonNative'],
    [HOTKEY_REASONS.INVALID_SHORTCUT, 'disabled', 'hotkeyReasonShortcut'],
    [HOTKEY_REASONS.NO_GLOBAL_VOICE, 'disabled', 'hotkeyReasonOverlayOff'],
    [HOTKEY_REASONS.EXITED, 'exited', 'hotkeyReasonExited'],
  ]
  for (const [code, status, expectKey] of hotkeyReasonCases) {
    env.diagnostics = {
      ok: true,
      hotkeyHelper: { platform: 'win32', status, enabled: false, reason: code, detail: `假原文-${code}` },
    }
    await mountPanel()
    await sleep(60)
    check(`[热键状态] 码「${code}」渲染成「${expectKey}」这句（不是码本身）`,
      treeHasText(runtime.getTree(), expectKey), '说明行没按码出文案')
    check(`[热键状态] 码「${code}」不把码名或宿主 detail 显示给用户`,
      !treeHasText(runtime.getTree(), code) && !treeHasText(runtime.getTree(), `假原文-${code}`),
      '界面上出现了码名或 detail')
    check(`[热键状态] 「${status}」的状态行仍是短词`,
      treeHasText(runtime.getTree(), status === 'disabled' ? 'hotkeyStatusDisabled' : 'hotkeyStatusFailed'),
      '状态行文案丢了')
  }

  // 旧宿主（还没改成报码）把中文句子塞进 reason：走兜底那句，原文一个字都不显示。
  env.diagnostics = {
    ok: true,
    hotkeyHelper: {
      platform: 'win32',
      status: 'failed',
      enabled: false,
      reason: '热键注册失败（可能被其他程序占用），系统级热键未生效',
      detail: 'RegisterHotKey 返回 false',
    },
  }
  await mountPanel()
  await sleep(60)
  check('[热键状态] 旧宿主的中文句子走兜底那句',
    treeHasText(runtime.getTree(), 'hotkeyReasonUnknown'), '没找到兜底文案')
  check('[热键状态] 宿主写来的句子不进界面',
    !treeHasText(runtime.getTree(), '热键注册失败'), '界面上出现了宿主原文')
  env.diagnostics = {
    ok: true,
    hotkeyHelper: { platform: 'win32', status: 'enabled', enabled: true, accelerator: 'Ctrl+Alt+V', reason: '' },
  }

  /* ---- 组件类型在两次渲染之间不换身份（Row/Section/Label/Toggle 必须定义在稳定作用域） ---- */
  await mountPanel()
  const before = functionTypesIn(runtime.getTree())
  panelWordsBox().props.onChange({ target: { value: '再渲染一次' } })
  await sleep(80)
  const after = functionTypesIn(runtime.getTree())
  const fresh = [...after].filter((fn) => !before.has(fn))
  check('[面板结构] 重新渲染后没有新出现的组件类型（组件不定义在渲染体内 → 输入框不会失焦）',
    fresh.length === 0, `${fresh.length} 个新身份：${fresh.map((f) => f.name || '匿名').join(',')}`)
  check('[面板结构] 渲染树里确实有自定义组件（否则上面那条是空跑）',
    before.size >= 3, `只找到 ${before.size} 个函数型组件`)

  Object.assign(env.config, savedConfig)
  delete env.config.globalHotkeyHelper
  delete env.config.globalVoice
  runtime.unmount()
}

/* ------------------------------------------------------------------ */
/* 场景 29：流式实时字（批次 5c，替掉 `test/live-asr.test.mjs` 的 15 条写法判据） */
/* ------------------------------------------------------------------ */
/**
 * 这一场景判的是「边说边出字」走流式那条路的**时序与账目**，不是源码写法。
 *
 * 搬走前那批正则钉的是 `const streamSessionIdRef = useRef('')`、
 * `samples.subarray(already)`、`void resetStream()\n void transcribeSegment()` 这些
 * **行**存在不存在。它们守的事实其实和行号、变量名无关：
 *   1. 流式解码器有状态 → 每次开麦必须新会话，断句和关麦必须丢弃；
 *   2. 只喂**新增**音频（这是流式的全部意义：整段重发的话延迟随段长增长）；
 *   3. 流式和整段互斥，同一段时间里不能两边都在写实时字；
 *   4. 宿主说「流式模型不可用」要当场退回整段，不能一直喂一个没人解码的会话；
 *   5. 走哪种模式由 `liveAsr` + 当前模型决定，三档各有一次真开麦验证。
 * 现在这些从 `env.stream.feeds / .resets` 和 `env.fetchLog` 里数得出来。
 *
 * 注意 `silenceMs`：断句 timer 每 100ms 读一次最新配置，而配置只在**挂载和开麦翻转**时拉，
 * 所以要改它就得先关麦再开麦（第一段故意把它拉到 5000ms，免得喂音频的过程中被断句掐掉）。
 */
async function scenarioStreamingAsr() {
  await settle()
  resetEnv()
  const dbg = () => fakeWindow.__DSH_VOICE_DEBUG__?.() ?? {}
  const savedConfig = { ...env.config }
  const feeds = () => env.stream.feeds
  const resets = () => env.stream.resets
  const feedCount = () => env.stream.feeds.length
  const resetCount = () => env.stream.resets.length
  const lastSid = () => feeds()[feeds().length - 1]?.sid ?? ''
  const transcribes = () => env.fetchLog.filter((f) => String(f.url).includes('/transcribe')).length
  const lastDraft = () => env.draftWrites[env.draftWrites.length - 1] ?? ''
  const processor = () => env.mic.processors[env.mic.processors.length - 1]
  const pushFrames = async (ticks, loud) => {
    for (let i = 0; i < ticks; i++) {
      env.mic.level = loud ? 0.05 : 0
      processor()?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(loud ? 0.05 : 0) },
      })
      await sleep(110)
    }
  }
  const openMic = async () => {
    micButton().props.onClick()
    return waitFor(() => dbg().on === true, 4000)
  }
  const closeMic = async () => {
    micButton().props.onClick()
    return waitFor(() => dbg().on === false, 2000)
  }
  /**
   * `fetchLog` 里**本场景这一段**的下标（从 `from` 开始找）。
   * `resetEnv()` 不清 `fetchLog`，全套跑下来前面十几个场景的请求都在里面：
   * 绝对下标和绝对计数只有在子集运行时才成立（5b 就为这个红过一轮）。
   */
  const idxOfLastFrom = (from, pred) => {
    const urls = env.fetchLog.map((f) => String(f.url))
    for (let i = urls.length - 1; i >= from; i--) if (pred(urls[i])) return i
    return -1
  }
  const idxOfFirstFrom = (from, pred) => {
    const urls = env.fetchLog.map((f) => String(f.url))
    for (let i = Math.max(0, from); i < urls.length; i++) if (pred(urls[i])) return i
    return -1
  }

  const finish = () => {
    env.config = savedConfig
    env.stream.unavailable = false
    setMicMode('no-device')
    runtime.unmount()
    bootMic()
  }

  setMicMode('ok')

  /* ===== 一、stream 档：新会话 + 只喂增量 + 与整段互斥 ===== */
  // 改完 `liveAsr` / `model` 必须 `remountFresh()`：配置只在挂载和 `on` 翻转时拉，
  // 而 `on` 翻转那一次 refetch 发生在 `startMic` **之后** —— 开麦里「走流式还是走整段」
  // 的判定用的还是上一份配置。（第一版没重挂，跑出来是「stream 档一个 /asr-stream 都没发、
  // auto + 非流式模型反而发了两个」，判的全是上一个 case 的配置。）
  env.config = { ...env.config, liveAsr: 'stream', model: 'iic/speech_paraformer', readAloud: false, autoSend: false, silenceMs: 5000 }
  await remountFresh()
  env.stream.texts = ['你', '你好', '你好世界']
  const opened1 = await openMic()
  check('[流式] 前置：stream 档开麦进聆听态', opened1, JSON.stringify(dbg()))
  if (!opened1) { finish(); return }
  const feedsBefore1 = feedCount()
  const transcribesAtOpen = transcribes()
  await pushFrames(10, true)
  const fed1 = await waitFor(() => feedCount() > feedsBefore1, 3000, 50)
  check('[流式] stream 档：当前模型不是流式模型也照样喂 /asr-stream（强制档生效）',
    fed1 && feedCount() > feedsBefore1, `feeds=${feedCount()}`)
  check('[流式] 会话 id 长在 URL 上（voice- 前缀；解码器有状态，复用旧 id 会串上下文）',
    /^voice-/.test(feeds()[feedsBefore1]?.sid ?? ''), JSON.stringify(feeds()[feedsBefore1]))
  const partialLanded = await waitFor(() => lastDraft().includes('你好'), 3000, 50)
  check('[流式] 实时字来自 /asr-stream 的返回，并且写进了草稿',
    partialLanded, JSON.stringify({ last: lastDraft() }))
  check('[流式] 流式和整段互斥：走流式的这段时间一次 /transcribe 都没发',
    transcribes() === transcribesAtOpen, `多发了 ${transcribes() - transcribesAtOpen} 次`)
  // 至少要凑到三次喂音频才判得出「增量 vs 累计」：两次的比例受 flush 落点抖动影响。
  const pushedTicks = 10 + 12
  await pushFrames(12, true)
  const enoughFeeds = await waitFor(() => feedCount() >= feedsBefore1 + 3, 3000, 50)
  const bytes = feeds().slice(feedsBefore1).map((f) => f.bodyBytes)
  const total = bytes.reduce((a, b) => a + b, 0)
  /**
   * 「只喂增量」判的是**总量对得上音频长度**，不是「最后一次小不小」。
   *
   * 假录音链路是确定的：一帧 4096 采样 @48k，重采样到 16k 就是 4096/3 个采样，
   * 每个采样上线时发 4 字节（`samples.buffer` 的 Float32）。所以推了 N 帧，
   * 客户端最多只有 `N×4096/3×4` 字节可以喂 —— 增量喂的时候「各次之和 = 这一段的总长」，
   * 整段重发的时候各次是前缀和（x、x+y、x+y+z…），总和会**超过**总长。
   * 末帧未 flush，所以真实比值只会低于 1，不会高于。
   *
   * 第一版写的是「最后一次 < 累计的 0.7」，两处改法（`delta = samples`、
   *  `streamFedRef` 不前进）**都判不住**：整段重发时各次是等差的前缀和，
   * 最后一次 / 各次之和 = n / (1+2+…+n) = 2/(n+1)，三次就是 0.5 —— 比阈值还小。
   * 换成对总量以后，同一处改动跑出来是 1.6 倍，直接红。
   */
  const accBoundBytes = Math.floor((pushedTicks * 4096) / 3) * 4
  check('[流式] 只喂新增音频：这一轮喂进去的总量落在「我推给它的音频长度」里（整段重发是前缀和，会超上限）',
    enoughFeeds && total > 0 && total <= accBoundBytes && total >= accBoundBytes * 0.2,
    JSON.stringify({ bytes, total, accBoundBytes }))
  // 静置判据要**先让在跑的那一次 flush 落定**再开始数：最后一帧是 1760ms 推进去的，
  // 1900ms 那一次 flush 会把它的增量正常喂出去 —— 直接把它算进「静置期间」就成假红了。
  await sleep(1100)
  const feedsBeforeIdle = feedCount()
  await sleep(1500)
  check('[流式] 音频没有新增就不再喂（增量 ≤ 已喂量时这一轮直接跳过）',
    feedCount() === feedsBeforeIdle, `静置 1.5 秒里多喂了 ${feedCount() - feedsBeforeIdle} 次`)

  /* ===== 二、断句 / 关麦都丢弃流式状态，且断句的 reset 排在整段识别之前 ===== */
  const closed1 = await closeMic()
  const sid1 = lastSid()
  const resetAfterClose = await waitFor(() => resetCount() > 0, 2000)
  check('[流式] 关麦时发 /asr-stream/reset 丢弃解码状态',
    closed1 && resetAfterClose && resets().includes(sid1), JSON.stringify({ closed1, resets: resets() }))
  const feedsAfterClose = feedCount()
  await sleep(1300)
  check('[流式] 关麦之后不再往旧会话喂音频（recorder 真停了）',
    feedCount() === feedsAfterClose, `又多喂 ${feedCount() - feedsAfterClose} 次`)

  env.config = { ...env.config, silenceMs: 200 }
  env.stream.texts = ['第二段']
  const opened2 = await openMic()
  check('[流式] 前置：带着新的 silenceMs 重开麦', opened2, JSON.stringify(dbg()))
  if (!opened2) { finish(); return }
  await pushFrames(10, true)
  const fed3 = await waitFor(() => feedCount() > feedsAfterClose, 3000, 50)
  check('[流式] 每次开麦都是新会话（sessionId 与上一次不同）',
    fed3 && lastSid() !== sid1 && /^voice-/.test(lastSid()), JSON.stringify({ sid1, sid2: lastSid() }))
  const resetsBeforeBreak = resetCount()
  const transcribesBeforeBreak = transcribes()
  // 断句这一次请求序列的起点：`fetchLog` 是跨场景累加的，绝对下标只在子集运行时成立。
  const logBase = env.fetchLog.length
  await pushFrames(6, false)
  const broke = await waitFor(() => resetCount() > resetsBeforeBreak, 3000, 50)
  check('[流式] 说话停下（断句）时丢弃流式状态', broke, `resets=${resetCount()}`)
  const segmented = await waitFor(() => transcribes() > transcribesBeforeBreak, 3000, 50)
  const resetIdx = idxOfLastFrom(logBase, (u) => u.includes('/asr-stream/reset'))
  const transcribeIdx = idxOfFirstFrom(logBase, (u) => u.includes('/transcribe'))
  check('[流式] 断句那一次：先丢弃流式状态，再把整段交给 /transcribe',
    segmented && resetIdx >= 0 && transcribeIdx >= 0 && resetIdx < transcribeIdx,
    JSON.stringify({ resetIdx, transcribeIdx, logBase, transcribes: transcribes() - transcribesBeforeBreak }))
  await closeMic()
  await waitFor(() => resetCount() > resetsBeforeBreak + 1, 2000)
  check('[流式] 断句之后关麦还会再 reset 一次（两个时机都要清，不是清过就完事）',
    resetCount() >= 2, JSON.stringify(resets()))

  /* ===== 三、宿主说流式不可用 → 当场退回整段 ===== */
  env.config = { ...env.config, silenceMs: 5000 }
  env.stream.unavailable = true
  const opened3 = await openMic()
  check('[流式] 前置：不可用那段也开到了麦', opened3, JSON.stringify(dbg()))
  if (!opened3) { finish(); return }
  const feedsBeforeUnavailable = feedCount()
  const transcribesBeforeUnavailable = transcribes()
  await pushFrames(10, true)
  const triedOnce = await waitFor(() => feedCount() > feedsBeforeUnavailable, 3000, 50)
  const fellBack = await waitFor(() => transcribes() > transcribesBeforeUnavailable, 3000, 50)
  check('[流式] 宿主回 unavailable 后退回整段重识别（后续实时字走 /transcribe）',
    triedOnce && fellBack,
    JSON.stringify({ feeds: feedCount() - feedsBeforeUnavailable, transcribes: transcribes() - transcribesBeforeUnavailable }))
  const feedsAfterFallback = feedCount()
  await pushFrames(10, true)
  await sleep(1200)
  check('[流式] 退回之后不再往一个没人解码的会话喂音频',
    feedCount() === feedsAfterFallback, `又喂了 ${feedCount() - feedsAfterFallback} 次`)
  await closeMic()
  env.stream.unavailable = false

  /* ===== 四、三档模式各开一次麦：判定住在 liveAsr + 当前模型 ===== */
  const modeCase = async ({ liveAsr, model, expectStream, label }) => {
    env.config = { ...env.config, liveAsr, model, silenceMs: 5000 }
    env.stream.texts = ['实时字']
    await remountFresh()
    const opened = await openMic()
    if (!opened) {
      check(`[流式·模式] ${label}：开麦成功（前置）`, false, JSON.stringify(dbg()))
      return
    }
    const before = feedCount()
    const transcribeBefore = transcribes()
    await pushFrames(10, true)
    if (expectStream) {
      const fed = await waitFor(() => feedCount() > before, 3000, 50)
      check(`[流式·模式] ${label}`, fed, `feeds=${feedCount() - before}`)
    } else {
      // 反向判据要等满一个 flush 周期才说明问题：没发流式请求 ≠ 还没来得及发。
      await sleep(1200)
      check(`[流式·模式] ${label}`, feedCount() === before && transcribes() > transcribeBefore,
        JSON.stringify({ feeds: feedCount() - before, transcribes: transcribes() - transcribeBefore }))
    }
    await closeMic()
    await sleep(150)
  }
  await modeCase({
    liveAsr: 'auto', model: 'zipformer2-zh', expectStream: true,
    label: 'auto + 流式模型 → 走流式',
  })
  await modeCase({
    liveAsr: 'auto', model: 'iic/speech_paraformer', expectStream: false,
    label: 'auto + 非流式模型 → 整段重识别，不发 /asr-stream',
  })
  await modeCase({
    liveAsr: 'full', model: 'zipformer2-zh', expectStream: false,
    label: 'full + 流式模型 → 仍走整段（档位在模型之前说了算）',
  })

  /* ===== 五、设置面板里这一项在、三个档位都在（替掉 `t('liveAsr')` 那条扫源码） ===== */
  await mountPanel()
  const tree = () => runtime.getTree()
  check('[流式·面板] 设置面板渲染出「实时字方式」这一项', treeHasText(tree(), 'liveAsr'), '树里没有 liveAsr 这一行')
  const optionKeys = ['liveAsrFull', 'liveAsrStream', 'liveAsrAuto']
  const missing = optionKeys.filter((key) => !treeHasText(tree(), key))
  check('[流式·面板] 三个档位（整段 / 流式 / 自动）都渲染出来了',
    missing.length === 0, `缺：${missing.join(',')}`)
  check('[流式·面板] 说明文字跟着一起出（用户要看得见「流式更快、整段更准」）',
    treeHasText(tree(), 'liveAsrHint'), '树里没有 liveAsrHint')

  finish()
}

/* ------------------------------------------------------------------ */
/**
 * 场景 30：SSE 连接的「不重连」与「卸载必关」（批次 6l-c，见 §8.46）。
 *
 * 取代 `test/effect-stability.test.mjs` 的两条源码文本判据：
 *   1. `!/const t = typeof props/.test(src)`「没有裸箭头函数形式的 t」。
 *      它守的事故是 2026-10-31 那次无限重连：宿主没传 `props.t` 时组件里那句
 *      三元兜底**每次渲染都产出一个新函数**，而监听 SSE 的 effect 依赖 `[reload, t, loadModels]`，
 *      于是每渲染一次就重跑一次 effect → 关掉旧连接、再 `new EventSource` 一条，
 *      表现是「点下载看不到任何进度」。老判据只看源码里有没有那行写法。
 *   2. `行 N 的 EventSource 在所属 effect 的 cleanup 里被 close()` ——
 *      按括号配平切出 effect 体，再在体里正则找 `return () => …close(`。
 *      它证明「那一行写着」，证明不了「卸载时那一行真被调用」。
 *
 * 两条都变成真跑：挂的是产物里的 `SettingsSection`，**故意不给 props.t**（就走当年那支兜底），
 * 每次渲染换一个新的 props 对象，数 `env.eventSources` 的条数；再 `unmount()`（假运行时会把
 * 每个 effect 的 cleanup 都跑一遍），数还剩几条没关。
 *
 * 覆盖面按老判据看齐：老的那条是 `for (const at of sseAt)` **每个建连点都扫**，
 * 所以 ④⑤ 两段把另外两处也真挂一遍（麦克风按钮、全局浮层）。浮层那处带「自己重连」，
 * 且只在总开关打开时建连 —— 「关着不建连」也顺手判掉（它原来靠源码里那句 early return 守着）。
 */
async function scenarioSseConnectionLifecycle() {
  await settle()
  resetEnv()
  if (!SettingsSection) { check('[面板] 设置面板组件注册可得', false, 'settings.section 没注册'); return }

  /* ---- ① 挂载：连接建起来了（后两条判据的对象存在，不然是空转） ---- */
  runtime.unmount()
  const mark = env.eventSources.length
  runtime.mount(SettingsSection, {})
  await sleep(300)
  const mounted = env.eventSources.slice(mark)
  check('[SSE] 面板挂载建起事件流（这一段判据的对象存在）', mounted.length >= 1,
    `建了 ${mounted.length} 条`)

  /* ---- ② 重复渲染：新的 props 对象 ×5，连接数不许动 ---- */
  // 宿主每次更新都是新 props，这里照那个形状传。引用不稳的 `t` 会在这一步现形：
  // effect 每跑一次就多连一条，count 直接涨。
  for (let i = 0; i < 5; i++) {
    runtime.mount(SettingsSection, { __renderSeq: i })
    await sleep(80)
  }
  const afterRerender = env.eventSources.slice(mark)
  check('[SSE] 连着换 5 个新 props 对象重渲染，不再新增连接（旧判据扫的是那句 const t）',
    afterRerender.length === mounted.length,
    `挂载时 ${mounted.length} 条 → 重渲染后 ${afterRerender.length} 条`)
  check('[SSE] 原来那条连接没有被这几次渲染关掉（重连的可见后果就是进度一直不出现）',
    afterRerender.every((s) => s.closed !== true),
    // detail 只给汇总：这条一旦红，数组本身能有几百项（探针实测红过），
    // 全打出来会把日志挤满，看不见真正要说的那句「旧的那批已经关了」。
    JSON.stringify({
      总条数: afterRerender.length,
      已关: afterRerender.filter((s) => s.closed === true).length,
    }))
  check('[SSE] 这一段没触发重渲染熔断（引用不稳时它是「无限重连」，真 React 开发模式在这抛 Too many re-renders）',
    env.renderLoop.blown === false, `同一波里渲染了 ${env.renderLoop.maxStreak} 次，上限 ${RENDER_LOOP_LIMIT}`)

  /* ---- ③ 卸载：每条连接都必须被 cleanup 关掉 ---- */
  runtime.unmount()
  await sleep(80)
  const stillOpen = env.eventSources.slice(mark).filter((s) => s.closed !== true)
  check('[SSE] 面板卸载后一条连接都不留（旧判据在 effect 体里正则找 close()，那是写法不是行为）',
    stillOpen.length === 0,
    `还剩 ${stillOpen.length} 条没关：${JSON.stringify(stillOpen.map((s) => String(s.url)))}`)
  /* ---- ④ 麦克风按钮：它自己那条连接也要随卸载关掉 ---- */
  // 产物里一共三处建连（麦克风按钮 / 设置面板 / 全局浮层），
  // 老判据是 `for (const at of sseAt)` **三处都扫**的，所以替它的行为测试也得三处都真跑，
  // 只补一处就是覆盖面缩水（这一条在 §8.46 的诚实边界里被自己抓到过一次）。
  const micMark = env.eventSources.length
  runtime.unmount()
  bootMic()
  await sleep(300)
  const micSources = env.eventSources.slice(micMark)
  check('[SSE] 麦克风按钮挂载建起事件流', micSources.length >= 1, `建了 ${micSources.length} 条`)
  runtime.unmount()
  await sleep(80)
  check('[SSE] 麦克风按钮卸载后一条连接都不留',
    micSources.every((s) => s.closed === true),
    `还剩 ${micSources.filter((s) => s.closed !== true).length} 条没关`)

  /* ---- ⑤ 全局浮层：总开关打开才建连，卸载必须关掉 ---- */
  const Overlay = registrations.find((r) => r.options?.id === 'dsh-voice-typing-global')?.component
  check('[SSE] 全局浮层组件注册可得（这一段的前提）', Boolean(Overlay), 'shell.overlay 没注册上')
  if (Overlay) {
    // 「总开关关闭时不建连」本身是行为，顺手在这里判掉：
    // 它原来的守法是源码里那句 `if (config.globalVoice !== true) return undefined`。
    const offMark = env.eventSources.length
    runtime.mount(Overlay, { t: (k) => k })
    await sleep(300)
    check('[SSE] 全局语音总开关关着时浮层不建连', env.eventSources.length === offMark,
      `多出 ${env.eventSources.length - offMark} 条`)
    runtime.unmount()

    env.config.globalVoice = true
    const onMark = env.eventSources.length
    runtime.mount(Overlay, { t: (k) => k })
    await sleep(300)
    const overlaySources = env.eventSources.slice(onMark)
    check('[SSE] 总开关打开后浮层建起事件流', overlaySources.length >= 1,
      `建了 ${overlaySources.length} 条`)
    runtime.unmount()
    await sleep(80)
    // 浮层那条带「自己重连」：cleanup 先置 disposed 再 close()。
    // 老判据为了放过这种写法，正则放宽成 `return () => …close(` 五百字符窗口 ——
    // 这里不认写法，只看卸载完还剩几条活着。
    check('[SSE] 浮层卸载后一条连接都不留（它带重连，卸载后不许再复连）',
      overlaySources.every((s) => s.closed === true),
      `还剩 ${overlaySources.filter((s) => s.closed !== true).length} 条没关`)
    delete env.config.globalVoice
  }

  check('[SSE] 这一段没有异常甩出渲染 / effect / cleanup', env.warnings.length === 0,
    env.warnings.join('\n'))
}

/* ------------------------------------------------------------------ */
async function main() {
  bootMic()
  await sleep(300) // 等挂载后的配置拉取 / SSE 建连
  if (process.env.HARNESS_DEBUG) {
    console.log('DEBUG registrations=', registrations.map((r) => r.options?.name))
    console.log('DEBUG eventSources=', env.eventSources.length)
    console.log('DEBUG tree=', runtime.getTree() ? 'ok' : 'null')
    console.log('DEBUG warnings=', env.warnings)
    console.log('DEBUG fetchLog=', env.fetchLog.map((f) => f.url).slice(0, 20))
  }

  // 场景隔离：每个场景重新拿一个 SSE（客户端只有一个组件/一个 EventSource，
  // 这里不复用组件，但每个场景都用同一个实例；通过 turn-begin 隔离状态）。
  //
  // 写成表是为了调试时能只跑相关场景（`ONLY_SCENARIOS=挂起,配置同步`）。
  // 本文件全套要跑三分钟，而批次 4d 新加的这几段里有 8 秒/3 秒的真等待；
  // 子集跑只为省时间；绿的证据仍然是全跑那一次。
  // **子集运行不作为绿的证据** —— 结尾那行会把它标出来，绿的证据只有全跑那一次。
  const scenarios = [
    ['正常播放', scenarioNormal],
    ['合成失败', scenarioTtsFailure],
    ['解码失败/老宿主', scenarioDecodeFailureAndLegacyIndex],
    ['引擎回退提示', scenarioTtsFallbackMeta],
    ['去重', scenarioDuplicate],
    ['静音', scenarioMute],
    ['换轮', scenarioTurnReset],
    ['burst 单段', scenarioLongSingleParaBurst],
    ['burst 时序', scenarioTrimTimingEvidence],
    ['burst 多段', scenarioMultiParaBurst],
    ['迟到旧轮', scenarioLateOldTurn],
    ['自愈', scenarioSelfHeal],
    ['无 AudioContext', scenarioNoAudioContext],
    ['suspended+halt', scenarioSuspendedHalt],
    ['快捷键', scenarioComposerShortcut],
    ['开麦就绪', scenarioMicReady],
    ['浮层采集', scenarioOverlayCapture],
    // 批次 13 补的一段：唤醒待机这条链路以前**没有任何行为判据**（只有源码正则），
    // 于是「诊断上报把 voiceSession 清空」这类事跑不出来也看不见。去向写在 §8.54。
    ['浮层待机唤醒', scenarioWakeStandby],
    // 批次 13b 补的一段：心跳是 voiceSession 的唯一正常登记来源，
    // 「有 id 必须带 / 没 id 整个不发」两头以前都没判据。去向写在 §8.55。
    ['心跳会话键', scenarioHeartbeatSessionKey],
    ['自动发送', scenarioAutoSend],
    ['停止朗读', scenarioStopAndMute],
    ['关麦复位', scenarioStateReset],
    ['识别中途失败', scenarioRecognizeFailure],
    // 批次 4d 补的五段（替掉 read-aloud-stop 交下来的 14 条写法判据）。
    // 放在最后：第一段要给全套多付约 12 秒（8 秒兜底 + 3 秒慢恢复都是真等），
    // 前面的场景不因为它改顺序。
    ['挂起三档+手势', scenarioCtxResumeWaits],
    ['回执账目', scenarioAckAttribution],
    ['配置同步', scenarioConfigSync],
    ['高亮抛错', scenarioHighlightThrows],
    // 批次 6i-b 补的一段：接住 `event-envelope` 交下来的「信封在消费端真的被用」这一半
    // （别的会话的句子被过滤 / 全局事件不被过滤 / 坏 data 不打断 SSE），去向写在 §8.42。
    ['信封消费', scenarioEnvelopeConsume],
    ['合成挂住', scenarioTtsHangs],
    // 批次 5b 补的三段：替掉 `config-ui` 的 13 条 + `model-panel-shape` 的 10 条源码形状判据
    // （`config-ui` 那 13 条 = 词表/保存 8 条 + 热键状态行 4 条 + `Row` 的位置判据 1 条；
    //  `model-panel-shape` 整个文件搬空后删除，10 条的去向逐条写在文件头与 §8.34）。
    ['面板·词表与保存', scenarioSettingsWordsAndSave],
    // 批次 6f 补的一段：替掉 read-aloud-stop 里「追赶秒数空/非法回退 7.5、clamp 0..120、0.5 步进」
    // 那条源码三连正则（它自己就写着「归批次 5 与 config-ui 一起换组件级判据」）。
    ['面板·追赶秒数', scenarioSettingsLagClamp],
    // 批次 6g 补的一段：替掉 sovits-tts 里那条「客户端有引擎选项与设置项」的产物文本判据
    // （它只要源码里出现过 sovitsUrl/sovitsRefAudio 这几个词就绿）。
    ['面板·GPT-SoVITS 引擎', scenarioSovitsEngine],
    ['面板·模型下载', scenarioSettingsModelDownload],
    ['面板·热键状态行', scenarioSettingsHotkeyStatusLine],
    // 批次 22 补的一段：快捷键那两行红字改成「按码查字典」，并判宿主没给 props.t 时
    // 兜底取词有没有把参数填进句子（去向写在 §8.64）。
    ['面板·快捷键红字', scenarioShortcutErrorText],
    // 批次 22-2 补的一段：面板自己的选项文案（引擎名 / 语言名 / 音色名 / 释放档位 /
    // 说话人序号 / 占位符 / 平台与显卡标签）搬进字典，判据是「树里的汉字要有字典出处」。
    // 去向写在 §8.65。
    ['面板·选项文案', scenarioPanelOptionCopy],
    // 批次 22-3-1 补的一段：模型档位名也从字典出（改前面板读的是宿主 `/models` 的 `label`，
    // 宿主那份 `labelEn` 从来没上过界面）。判据喂的是「一眼认得出的假宿主中文」。
    // 去向写在 §8.66。
    ['面板·模型名', scenarioPanelModelNames],
    // 批次 22-3-2 补的一段：环境自检那四行的行名与状态句也从字典出（改前面板抄宿主的
    // `label` 与 `detail`，英文界面这一整块是中文）。替身先补上 `/tts/env` 分支，
    // 否则这几行根本不渲染。去向写在 §8.67。
    ['面板·环境自检', scenarioPanelEnvCheck],
    // 批次 22-3-3 补的一段：保存请求根本没走通时，红字那行拼的是浏览器给的
    // `Failed to fetch`（中文界面冒英文串）。现在那句也由字典出，原文只进 console.warn。
    // 去向写在 §8.68。
    ['面板·保存·没连通', scenarioSaveRejectSentence],
    // 批次 5c 补的一段：接住 `live-asr` 交下来的 13 条流式写法判据（会话生命周期 /
    // 只喂增量 / 断句与关麦各自 reset / 不可用退回 / 三档模式），另加 10 条它原本没有的判点。
    // 18 条的完整去向（3 条留本文件改数据比对、2 条改字典判据）写在 §8.34 批次 5c 实录。
    ['流式实时字', scenarioStreamingAsr],
    // 批次 6l-c 补的一段：替掉 `effect-stability` 的两条源码文本判据
    // （「没有裸箭头形式的 t」 + 「EventSource 在 cleanup 里被 close()」），去向写在 §8.46。
    ['SSE 不重连与卸载关闭', scenarioSseConnectionLifecycle],
  ]
  const only = String(process.env.ONLY_SCENARIOS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  for (const [name, fn] of scenarios) {
    if (only.length && !only.some((key) => name.includes(key))) continue
    await fn()
  }

  /* ------------------------------------------------------------------ *
   * 收尾账本（批次 6j）：这**一整趟**跑出来的请求与 SSE 订阅，
   * 必须都对得上 `src/client/pure/routes.js` 那张表。
   *
   * 为什么放这里而不是 route-contract 里：这两本账是 `env.fetchLog` /
   * `env.eventSources` —— 只有真挂过组件才有内容，而全套场景都在这个文件里跑。
   * 它补的是路由表管不到的那一半：表说「客户端会调这些」，这里说
   * 「客户端**实际**调的就是表里那些」。有人绕过表手写一条路径，
   * eslint 的前缀禁令管得住字面量，管不住「用变量拼出来」的写法 —— 这一条管得住。
   * ------------------------------------------------------------------ */
  {
    const table = new Set(Object.values(ROUTES))
    const requested = [...new Set(env.fetchLog.map((f) => String(f.url).split('?')[0].split('#')[0]))]
    // 只算**同源路径**那一类：假 AudioContext 解码时会去 fetch 自己造出来的
    // `blob:fake-…`（朗读音频的字节），那是一条本地资源、不是路由，别混进这本账。
    const sameOrigin = requested.filter((p) => p.startsWith('/')).sort()
    const offTable = sameOrigin.filter((p) => !table.has(p))
    check('[路由账本] 这趟真发出去的每个同源请求都在路由表里（表外没有第二套路径）',
      sameOrigin.length >= 15 && offTable.length === 0,
      JSON.stringify({ 表外: offTable, 条数: sameOrigin.length, 全簿: requested.length }))
    const sseUrls = [...new Set(env.eventSources.map((s) => String(s.url).split('?')[0]))].sort()
    check('[路由账本] SSE 连的也是表里那条 /stream',
      sseUrls.length > 0 && sseUrls.every((u) => u === ROUTES.stream),
      JSON.stringify({ sseUrls, 连接数: env.eventSources.length }))
    const listened = [...new Set(env.eventSources.flatMap((s) => [...s.listeners.keys()]))].sort()
    check('[路由账本] 客户端在 SSE 上只订阅契约里那组事件名（旧的「源码里不许出现 turn-start 的订阅」换成这里的真订阅记录）',
      listened.length >= 5 && listened.every((n) => CLIENT_LISTENED_EVENTS.has(n)), JSON.stringify(listened))
    // 熔断器自己的账（批次 6l-c）：上面那条 SSE 场景判的是「这一段没有自激」，
    // 这条判的是「这一族上限没被别处碰到」—— 有场景真跑到接近上限，就该把上限定高，
    // 而不是等哪天它把合法场景掐死、留下一个看不懂的失败。
    check('[熔断账本] 整趟跑下来没有场景触发过重渲染熔断，且峰值远在上限内',
      env.renderLoop.runMaxStreak < RENDER_LOOP_LIMIT,
      `峰值 ${env.renderLoop.runMaxStreak} / 上限 ${RENDER_LOOP_LIMIT}`)
  }

  console.log(`\n通过 ${passed}，失败 ${failures.length}${only.length ? `（只跑子集：${only.join('/') || '空'} —— 不作绿证据）` : ''}`)
  if (failures.length) {
    console.log('失败项：')
    for (const f of failures) console.log(' - ' + f.name + (f.detail ? ' :: ' + f.detail : ''))
    process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}

main().catch((error) => {
  console.error('harness crash:', error)
  process.exit(3)
})
