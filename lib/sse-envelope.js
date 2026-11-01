/**
 * SSE 事件信封 —— 协议层，从宿主 `lib/index.js` 里抽出来的独立单元。
 *
 * 负责给 SSE 事件套统一信封、维护全局事件序号。
 *
 * 为什么值得独立成一个模块：
 *   宿主 `lib/index.js` 里塞了七件事（HTTP 服务、SSE、TTS 路由、识别、
 *   回合判定、配置、诊断），3000+ 行。信封协议是一块**自洽且有状态**
 *   的逻辑（版本常量 + 全局序号计数器），隔离出来既方便测试，
 *   也避免「改协议」误碰宿主的路由/朗读。
 *
 * 与旧实现逐行等价，只是搬进独立文件：
 *   - `EVENT_PROTOCOL_VERSION`、`eventSeq`、`ENVELOPE_KEYS`、`buildEventEnvelope`
 *     原样迁出；
 *   - 宿主 `lib/index.js` 从这里 re-export，对外接口不变。
 */

/**
 * SSE 事件协议版本。
 *
 * v2：所有事件的 data 都改成统一信封（见 buildEventEnvelope）。
 * 客户端只要认一种信封形状，不用每种事件各写一套解析。
 *
 * v3：事件命名对齐语义 ——
 *   - `turn-end` 现在指**真正的一轮结束**（下一轮开始时确认上一轮已结束）；
 *   - 原来的「一次 llm/stream 调用结束」改名为 `call-end`。
 * 宿主与客户端同包、同版本一起加载，无需跨版本兼容。
 */
export const EVENT_PROTOCOL_VERSION = 3

/**
 * 全局事件序号。
 *
 * 模块级计数器：每次广播 +1（与有多少个订阅者无关）。
 * 客户端可以用它判断有没有漏事件（seq 跳号 = 中间少了一条）。
 */
let eventSeq = 0

/** 信封里的保留字段：事件载荷不能覆盖它们。 */
const ENVELOPE_KEYS = ['v', 'seq', 'ts', 'sessionId']

/**
 * 给事件载荷套上统一信封（协议 v3）。
 *
 * 信封形状（事件自己的字段平铺在信封字段之后）：
 *   { v: 3, seq: 12, ts: 1735000000000, sessionId: 's1', ...事件字段 }
 *
 * 例：
 *   event: sentence
 *   data: {"v":3,"seq":12,"ts":1735000000000,"sessionId":"s1","text":"你好","turnId":"turn-x","index":0}
 *
 * sessionId 为 null 表示全局事件（例如模型下载进度）。
 *
 * @param {object} payload - 事件载荷。
 * @returns {object} 信封。
 */
export function buildEventEnvelope(payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : null
  const rest = {}
  for (const key of Object.keys(p)) {
    if (ENVELOPE_KEYS.includes(key)) continue
    rest[key] = p[key]
  }
  return {
    v: EVENT_PROTOCOL_VERSION,
    seq: ++eventSeq,
    ts: Date.now(),
    sessionId,
    ...rest,
  }
}

/** 仅供测试：把全局事件序号清零（让 seq 断言可预测）。 */
export function resetEventSeqForTest() {
  eventSeq = 0
}
