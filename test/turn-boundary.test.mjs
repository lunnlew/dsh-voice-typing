/**
 * 回归测试：回合边界（turn-start）的判定。
 *
 * 背景（2026-10-31）：
 *   服务端用「会话里的用户消息条数变化」判断是不是新的一轮对话，
 *   判定错了会给客户端广播多余的 turn-start。客户端收到 turn-start 就
 *   `haltSpeaking(true)`（清空朗读队列 + 代次自增），于是本轮正在合成的
 *   那一句被整段丢弃 —— 表现为「等很久才朗读」且内容断断续续。
 *
 *   错在哪：DSH 里「本轮用户消息写入 session」的时机，和「LLM 开始流式输出」
 *   的时机不一致。同一回合里调用两次 llm/stream（工具调用链）时：
 *     第 1 次：本轮消息还没写入 → 看到上一轮的条数 → 广播 turn-start（对）
 *     第 2 次：本轮消息补齐了 → 条数 +1 → 若无脑当成新回合就会**多广播一次**
 *
 * 正确做法：用时间窗口区分「用户新发消息」和「本轮消息延迟写入」。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const idx = fs.readFileSync(root + '/lib/index.js', 'utf8')
// 回合判定逻辑已抽到独立模块 lib/turn-model.js（宿主 index.js 只委托）。
const tm = fs.readFileSync(root + '/lib/turn-model.js', 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('回合判定必须区分「用户新发消息」和「本轮消息延迟写入」')
check('回合判定在独立模块 lib/turn-model.js',
  /createTurnModel/.test(tm) && /function isNewUserTurn/.test(tm) && /function detectTurn/.test(tm),
  '宿主 index.js 里的回合判定应隔离出来，便于测试与避免误碰朗读/识别')
check('有回合窗口常量', /const TURN_WINDOW_MS = \d+/.test(tm))
check('记录了上次广播 turn-start 的时间', /const lastTurnAt = new Map\(\)/.test(tm))
check('判定时读取了上次广播时间',
  /const last = lastTurnAt\.get\(sessionId\)/.test(tm))
check('窗口内的条数变化不算新回合',
  /if \(now - last < TURN_WINDOW_MS\) return false/.test(tm),
  '同一回合内多次 llm/stream 会因消息延迟写入而多广播 turn-start')
check('窗口外的条数变化算新回合',
  /lastTurnAt\.set\(sessionId, now\)\s*\n\s*return true/.test(tm))
check('条数没变时不算新回合', /if \(count === prev\) return false/.test(tm))
check('首次见到会话仍按新回合处理',
  /if \(prev === undefined\) \{[\s\S]{0,120}lastTurnAt\.set\(sessionId, now\)\s*\n\s*return true/.test(tm),
  '否则新会话的第一轮不会打断旧朗读')

console.log('\n客户端：回合开始事件会清队列，必须与句子广播配对')
const cli = fs.readFileSync(root + '/lib/client.js', 'utf8')
check('客户端监听 turn-begin', /addEventListener\('turn-begin'/.test(cli))
check('客户端监听 turn-end', /addEventListener\('turn-end'/.test(cli))
check('不再监听旧的 turn-start（不兼容老协议）',
  !/addEventListener\('turn-start'/.test(cli),
  '同一事实两条通路，客户端要维护两套判断，两者的触发时机可能不一致')
check('收到回合开始会中断旧朗读', /haltSpeaking\(true\)/.test(cli))
check('句子事件不再要求语音模式开启',
  !/if \(!onRef\.current\) return/.test(cli.slice(cli.indexOf("addEventListener('sentence'") - 400, cli.indexOf("addEventListener('sentence'") + 400)),
  '要求先开语音模式会让「朗读回复」完全不起作用')

console.log('\n回合模型：turnId 与序号')
check('宿主分配 turnId', /turnIds\.set\(sessionId, turnId\)/.test(tm))
check('句子带 turnId 与序号',
  /emit\('sentence', \{ text, turnId: turn\.turnId, index \}\)/.test(idx))
check('回合开始事件带 turnId', /emit\('turn-begin', \{ sessionId, turnId: turn\.turnId \}\)/.test(idx))
check('回合结束事件带「刚结束的上一轮」turnId（真正一轮结束）',
  /emit\('turn-end', \{ sessionId, turnId: turn\.prevTurnId \}\)/.test(idx),
  'v3：turn-end 表示一轮真正结束，在下一轮开始时广播上一轮的 turnId')
check('客户端按 turnId 静音', /mutedTurnIdRef/.test(cli))
check('静音不再用布尔标记（单一真源）',
  !/mutedTurnRef/.test(cli.replace(/\/\/[^\n]*/g, '')),
  '布尔标记与 turnId 两套表达，迟早会不一致')

console.log('\n回合状态表不能无限增长')
check('turnUserCounts 有清理机制吗（至少要知道它会不会涨）',
  /turnUserCounts/.test(tm),
  '如果始终没有清理，需要在会话结束时删掉')
check('提供 prune()：按空闲时间清理会话状态',
  /function prune\(now = Date\.now\(\)\)/.test(tm)
    && /TURN_STATE_TTL_MS/.test(tm)
    && /turnUserCounts\.delete\(sessionId\)/.test(tm)
    && /turnIndexes\.delete\(sessionId\)/.test(tm),
  '宿主没有会话结束回调，用空闲超时兜底：长时间不活动的会话状态要能删')
check('宿主空闲扫描里调用 prune',
  /turnModel\.prune\(Date\.now\(\)\)/.test(idx),
  '回合状态清理要挂进现有 idleSweeper，否则没人调用它')

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
