/**
 * 配置词表 —— **单源**常量（宿主校验与浏览器侧 UI 共用同一份）。
 *
 * 为什么只有一份：
 *   这组枚举在 2026-11-02 之前是「宿主 `lib/config-schema.js` 一份 +
 *   浏览器 `src/client/pure/config-normalize.js` 一份」，靠
 *   `test/config-contract.test.mjs` 逐项横断言防漂移。那份副本的理由写的是
 *   「浏览器模块的 require 只能解析包名，不能 import 宿主文件」——
 *   但被锁死的是**产物**，不是**源码**：构建期由 esbuild 把这里合进单文件产物即可。
 *   漂移过一次的真实代价：客户端没跟着加 `sovitsUrl` 的长度上限，
 *   粘贴超长地址被宿主 400 打回，界面只显示「保存失败」。
 *
 * 环境约束（`src/shared/*` 的共同规矩，由 `test/bundle-sync.test.mjs` 机械守卫）：
 *   纯 ESM、零浏览器全局、零 Node API、零 React。
 *
 * **不在这里的东西**：
 *   - 两侧的门限常数、UI 档位（RATE/PITCH/VOLUME_OPTIONS、IDLE_RELEASE_OPTIONS）、
 *     UI 兜底默认值 —— 那些是**各侧的表现层**，不是「同一判据」；
 *   - 每个配置键的字段规则（`SPECS`）仍住在 `lib/config-schema.js`，
 *     见 docs/architecture-modernization.md §5 第 3 步的 3.3b。
 *
 * 数组全部 `Object.freeze`：这是两端共用的**合法取值集合**，谁都不该在运行中改它
 * （改一处会同时影响两端）。要展示顺序请复制一份（`withCurrentOption` 就是这么做的）。
 * 数组顺序不是契约：宿主只用它拼错误文案（`join(' / ')`）；
 * 浏览器侧的下拉顺序来自 `main.js` 里那份带中文标签的列表（表现层，不在本文件），
 * 而引擎自检面板的顺序来自运行环境上报（`formatEnvEngines`）。两端都不依赖这里的先后。
 */

/** 支持的 TTS 引擎。 */
export const TTS_ENGINES = Object.freeze(['online', 'local', 'neural', 'sovits'])

/** 识别语言提示（`auto` = 由模型判断）。 */
export const ASR_LANGUAGES = Object.freeze(['auto', 'zh', 'en', 'yue', 'ja', 'ko'])

/** GPT-SoVITS 官方 api_v2 支持的语言（没有 `auto`）。 */
export const SOVITS_LANGUAGES = Object.freeze(['zh', 'en', 'ja', 'ko', 'yue'])

/** 实时字方式。 */
export const LIVE_ASR_MODES = Object.freeze(['full', 'stream', 'auto'])

/** 交互模式：按住说话 / 点一下说一句。 */
export const INTERACTION_MODES = Object.freeze(['toggle', 'once'])

/**
 * 全局语音文本的注入方式（与宿主注入回合的 mode 一一对应）。
 *   - `queue`：排到下一轮（默认；助手空闲时就是发一条新消息）；
 *   - `steer`：插到当前这一步（助手正在生成时用，避免打断整轮）。
 * 写入配置时大小写不敏感归一化。
 */
export const VOICE_PROMPT_MODES = Object.freeze(['queue', 'steer'])

/** Edge TTS 输出格式（与设置面板的两个选项一致）。 */
export const TTS_FORMATS = Object.freeze([
  'AUDIO_24KHZ_48KBITRATE_MONO_MP3',
  'AUDIO_24KHZ_96KBITRATE_MONO_MP3',
])

/** 词表条数上限（超出的条目宿主会丢弃并记一条 notes）。 */
export const MAX_WORDS = 200

/** 词表单条字符上限（`correct` 与 `replace` 各自受限）。 */
export const MAX_WORD_CHARS = 100
