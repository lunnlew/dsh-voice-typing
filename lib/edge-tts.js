/**
 * Edge 朗读（TTS）客户端：走微软 Edge 免费朗读服务，零 API 成本、零密钥。
 *
 * 协议细节（Sec-MS-GEC 令牌、请求头、消息分帧）由内置的 msedge-tts 实现，
 * 见 lib/vendor/msedge-tts.cjs（MIT，内联以避免额外依赖），
 * 本文件只负责把它的流式输出拼成完整 MP3，并抹平它的 API 差异。
 *
 * @module dsh-voice-typing/edge-tts
 */
import msedgeTts from './vendor/msedge-tts.cjs';

const { MsEdgeTTS, OUTPUT_FORMAT } = msedgeTts;

/**
 * 合成超时（毫秒）。
 *
 * **必须显著小于客户端的单句超时**（客户端 `TTS_TIMEOUT_MS = 15000`）。
 * 之前这里是 30000：客户端 15 秒就放弃并跳过这一句，而服务端还要再跑 15 秒，
 * 这段时间里它**一直占着串行锁**，后面排队的句子只能干等 ——
 * 浏览器里就是「/tts 请求一直 pending」。
 * 现在 12 秒，保证服务端总比客户端先返回，让出锁。
 */
const DEFAULT_TIMEOUT_MS = 12000;

/**
 * 复用的合成器实例。
 * 每次新建都会重连 WebSocket，单句要 3~5 秒；复用同一条连接后只做合成，
 * 单句延迟能压到 1 秒以内——逐句朗读必须先有这个。
 */
let sharedTts = null;

/**
 * 合成互斥锁。
 * MsEdgeTTS 实例内部只有一条接收通道，setMetadata / toStream 都是「先设置状态再读」，
 * 并发调用会互相覆盖，导致串音或拿错音频。
 * 客户端逐句朗读用 3 路并行预取，所以这里必须串行化。
 */
let synthChain = Promise.resolve();

/**
 * 排队中的合成任务数（诊断用）。
 * 界面上「tts 一直 pending」时，先看这个：一直涨说明前面的任务卡住了。
 */
let synthQueueDepth = 0;

/**
 * 把任务排到合成队列末尾，保证同一时刻只有一个合成在用共享实例。
 *
 * **队列不能无限增长**：客户端一次预取 3 句、逐句朗读时还会继续入队。
 * 若某一句卡住（连接半死、服务端不回包），后面的请求会全部排队，
 * 表现为浏览器里 `/tts` 请求**一直 pending**、一句都不出声。
 *
 * 两道保险：
 *   1. 排队上限：超过 `MAX_SYNTH_QUEUE` 立刻快速失败；
 *   2. **锁本身的硬超时**：`task` 无论因为什么原因不 settle，
 *      到 `hardTimeoutMs` 都强制放行下一句。
 *      这一条是必须的 —— MsEdgeTTS 内部的流、`iterator.return()`、
 *      甚至它自己的 promise 链都可能永远不 settle，
 *      只靠 task 内部各自超时是**兜不住的**（实测就是卡在这里）。
 *
 * @param {Function} task - 返回 Promise 的任务。
 * @param {number} hardTimeoutMs - 锁的硬超时：超过它强制放行下一个任务。
 * @returns {Promise<any>} 任务结果。
 */
function withSynthLock(task, hardTimeoutMs = DEFAULT_TIMEOUT_MS + 3000) {
	if (synthQueueDepth >= MAX_SYNTH_QUEUE) {
		return Promise.reject(new Error('语音合成排队过多（前面的请求卡住了），已跳过这一句。'));
	}
	synthQueueDepth += 1;
	// 关键：链在「逻辑完成」时就前进，而不是等 task 真的 settle。
	// 这样即使底层永远不 settle，后面的句子也不会被它拖住。
	const gate = synthChain.then(task, task);
	let timer = null;
	const hardStop = new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			// 硬超时说明底层已经不可信（setMetadata / toStream / WebSocket 挂住）。
			// **必须同时丢弃实例**：否则下一个任务还是拿到同一个坏实例，
			// 一个一个跟着超时，等于永远出不了声。
			disposeTts();
			reject(new Error('语音合成超时（' + hardTimeoutMs + ' 毫秒无结果），已丢弃连接。'));
		}, hardTimeoutMs);
	});
	const run = Promise.race([gate, hardStop])
		.finally(() => { if (timer) clearTimeout(timer) });
	// 队列指针只等 run（含硬超时），绝不等 gate —— 否则底层卡死就全线卡死。
	synthChain = run.then(
		() => undefined,
		() => undefined,
	).finally(() => { synthQueueDepth = Math.max(0, synthQueueDepth - 1) });
	return run;
}

/**
 * 排队上限。
 *
 * 客户端 3 路并行预取 + 播放期间持续补充，正常深度不会超过 5。
 * 给到 8 是留余量；超过它说明前面有请求卡死了，再排下去只会让整条朗读链
 * 永远 pending。
 */
const MAX_SYNTH_QUEUE = 8;

/**
 * 当前合成队列深度（诊断用，经 /diagnostics 暴露）。
 * @returns {number} 排队中的任务数。
 */
export function synthQueueDepthNow() {
	return synthQueueDepth;
}


/** 预热是否进行中，避免重复预热。 */
let warming = null;

/**
 * 预热专用超时（毫秒）。
 *
 * 预热的目的是「把连接建好」，它本身不产出有用的音频。
 * 所以它比正式合成更早放弃（8 秒）：卡住的预热不该挡住真正的朗读请求。
 */
const WARMUP_TIMEOUT_MS = 8000;

/**
 * 预热共享连接。
 *
 * 第一次合成要付 TLS 握手的代价（实测 4~5 秒），后续复用连接只要 0.6~1 秒。
 * 在用户点开麦克风时后台先合成一句短的，把连接建好，
 * 这样等真正要朗读时，第一句就不用干等握手。
 *
 * @param {object} [options] - 合成参数（voice/rate 等，需与正式使用一致）。
 * @returns {Promise<void>} 预热完成。
 */
export function warmUpTts(options = {}) {
	if (warming) return warming;
	// 预热也必须走超时：它占着**同一条串行锁**。
	// 预热卡住（网络抖动、服务端不回包）而它又无限等的话，
	// 真正要朗读的那一句会排在预热后面 —— 浏览器里就是「/tts 一直 pending」。
	warming = synthesizeSpeech({
		text: '。',
		voice: options?.voice,
		rate: options?.rate,
		pitch: options?.pitch,
		volume: options?.volume,
		format: options?.format,
	}, WARMUP_TIMEOUT_MS)
		.then(() => undefined)
		.catch(() => undefined)
		.finally(() => { warming = null });
	return warming;
}

/**
 * 取得（必要时创建）复用的合成器。
 * @returns MsEdgeTTS 实例。
 */
function getSharedTts() {
  if (!sharedTts) sharedTts = new MsEdgeTTS();
  return sharedTts;
}

/**
 * 丢弃复用的合成器（出错时用，下次会重建）。
 */
export function disposeTts() {
  const instance = sharedTts;
  sharedTts = null;
  try { instance?.close?.(); } catch { /* 忽略 */ }
}

/**
 * 判断一个错误是不是「连接坏了」。
 *
 * 关键：**「合成结束但没有收到音频数据」也算连接坏了**。
 * 它的成因是服务端在这条 WebSocket 上没给音频（连接已废、被限流、
 * 或上一次超时把接收通道读脏了）。这类错误与「文本过长 / SSML 被拒」不同：
 * 连接本身已经不可用，**不丢掉它，后面每一句都会照样失败**。
 *
 * 这个 bug 真实发生过：只丢弃 WebSocket/ECONN 类错误，于是连接坏了以后
 * `onlineTtsFailures` 一路上涨（实测 7 次），界面显示「朗读中」却
 * **一点声音都没有**，只能重启整个 DSH 才恢复。
 *
 * @param {string} message - 错误文案。
 * @returns {boolean} 是否应丢弃共享连接。
 */
function isBrokenConnection(message) {
	return /WebSocket|ECONN|ENOTFOUND|ETIMEDOUT|EPIPE|socket|connect|未收到音频|没有收到音频数据|NO_AUDIO|超时/i.test(String(message ?? ''));
}

/**
 * 合成语音，返回 MP3 字节（Buffer）。
 * @param {object} options - 合成参数。
 * @param {string} options.text - 要朗读的文本。
 * @param {string} [options.voice] - 音色名。
 * @param {string} [options.rate] - 语速。
 * @param {string} [options.pitch] - 音调。
 * @param {string} [options.volume] - 音量。
 * @param {string} [options.format] - 输出格式键（OUTPUT_FORMAT 的键名）。
 * @param {number} [timeoutMs] - 超时。
 * @returns {Promise<Buffer>} MP3 字节。
 */
export async function synthesizeSpeech(options, timeoutMs = DEFAULT_TIMEOUT_MS) {
	const text = String(options?.text ?? '').trim();
	if (!text)
		throw new Error('要合成的文本为空。');
	if (text.length > 5000)
		throw new Error('文本过长（超过 5000 字符），请分段合成。');
	const voice = options?.voice || 'zh-CN-XiaoxiaoNeural';
	const locale = /^[a-z]{2,3}-[A-Z]{2}/.exec(voice)?.[0] || 'zh-CN';
	// 共享实例必须串行使用：并发 setMetadata/toStream 会互相覆盖，
	// 表现为串音（读到别的句子的音频）或合成失败。
	return withSynthLock(async () => {
	const tts = getSharedTts();
	try {
		// 输出格式可配置：默认 24kHz/48kbps 单声道 MP3（体积小、兼容性好）。
		const formatKey = String(options?.format ?? 'AUDIO_24KHZ_48KBITRATE_MONO_MP3');
		const outputFormat = OUTPUT_FORMAT[formatKey] ?? OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
		await tts.setMetadata(voice, outputFormat, {
			voiceLocale: locale,
			wordBoundaryEnabled: false,
			sentenceBoundaryEnabled: false,
		});
		// 只传真正有值的韵律参数：undefined 会被拼进 SSML，服务端会直接拒绝。
		const prosody = {};
		if (options?.rate) prosody.rate = options.rate;
		if (options?.pitch) prosody.pitch = options.pitch;
		if (options?.volume) prosody.volume = options.volume;
		const { audioStream } = tts.toStream(text, prosody);
		const chunks = [];
		// 保存异步迭代器的引用：超时/失败时要主动把它停掉。
		//
		// 这里曾经是整个「tts 一直 pending」的元凶：
		//   超时后只是 reject 了 Promise.race，`collect` 那个 for-await **还在跑**，
		//   继续占着 MsEdgeTTS 的那一条接收通道。下一次合成 setMetadata/toStream
		//   又去覆盖同一个实例的状态，两者互相踩 —— 新的也永远收不到音频，
		//   于是浏览器里的 /tts 请求**一直 pending**，一句都不出声。
		let iterator = null
		const collect = (async () => {
			iterator = audioStream[Symbol.asyncIterator]?.() ?? null
			if (!iterator) {
				for await (const chunk of audioStream) chunks.push(Buffer.from(chunk));
				return
			}
			while (true) {
				const { done, value } = await iterator.next()
				if (done) break
				if (value) chunks.push(Buffer.from(value))
			}
		})();
		/**
		 * 主动放弃这条流（超时/失败时用），避免它一直占着接收通道。
		 *
		 * **绝不能 await 它**：async generator 卡在内部的 `await` 上时，
		 * `iterator.return()` 自己也会永远不返回 —— 一 await，超时处理本身就被挂住，
		 * 整个合成永远不 reject（这正是「/tts 一直 pending」的最后一环）。
		 * 所以这里只「发出去、不等待」，加个短超时兜底防泄漏。
		 */
		const abandonStream = () => {
			try { Promise.resolve(iterator?.return?.()).catch(() => {}) } catch { /* 忽略 */ }
		}
		// 超时后必须丢弃共享连接：
		// collect 那个异步迭代还在后台读同一条 audioStream，
		// 而锁已经释放、下一次合成会覆盖实例状态 → 串音（读到别的句子的音频）。
		let timer = null
		try {
			await Promise.race([
				collect,
				new Promise((_resolve, reject) => {
					timer = setTimeout(() => {
						reject(new Error('语音合成超时（' + timeoutMs + ' 毫秒无完整音频），请重试或检查网络。'));
					}, timeoutMs)
				}),
			]);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			// 超时 / 连接类错误：这条连接已经不可信，必须丢弃，
			// 否则下一次合成会读到同一条读脏了的 audioStream（串音或永远没音频）。
			if (isBrokenConnection(msg)) {
				abandonStream();
				disposeTts();
			}
			throw error instanceof Error ? error : new Error(msg);
		} finally {
			if (timer) clearTimeout(timer);
		}
		// 「合成结束但没有音频」= 服务端在这条连接上没给我们音频。
		// **必须丢掉共享连接**：不丢的话后面每一句都会照样没音频
		// （实测连接坏掉后 onlineTtsFailures 一路上涨、界面「朗读中」却无声，
		// 只能重启 DSH 才好）。丢连接后下一次会重建，通常立刻恢复。
		if (!chunks.length) {
			disposeTts();
			throw new Error('合成结束但没有收到音频数据（服务端可能拒绝了请求）。');
		}
		return Buffer.concat(chunks);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// 只有「连接类」错误才丢弃共享连接。
		// 文本过长、SSML 被拒这类错误与连接无关，连接是好的，不该丢
		//（以前任何错误都销毁，导致下一次合成要重新握手，首句慢 4~5 秒）。
		const broken = isBrokenConnection(message);
		if (broken) disposeTts();
		if (/WebSocket|ECONN|ENOTFOUND|ETIMEDOUT|EPIPE|socket|connect/i.test(message)) {
			throw new Error('edge-tts WebSocket 连接失败。若网络需要特殊代理（梯子），请提醒用户配置代理后重启。');
		}
		throw error instanceof Error ? error : new Error(message);
	}
	});
}

/**
 * 列出服务端的可用音色（用于设置面板校验音色名）。
 * @returns {Promise<Array<object>>} 音色列表。
 */
export async function listVoices() {
	const tts = new MsEdgeTTS();
	try {
		return await tts.getVoices();
	} finally {
		try { await tts.close(); } catch { /* 忽略 */ }
	}
}
