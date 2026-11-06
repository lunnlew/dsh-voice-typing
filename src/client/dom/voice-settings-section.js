/**
 * 设置面板组件。
 *
 * 为什么单独成文件（docs/architecture-modernization.md §5 第 4 步 · 组件提取）：
 *   设置面板组件需要与 main.js 的工厂闭包解耦，才能独立测试和维护。
 *
 * 为什么用工厂函数而不是直接导出组件（dom/ 模块的机械约束）：
 *   dom/ 下的文件**不允许顶层 import 宿主 external 的 UI 库**
 *   （bundle-sync 测试会拦），因为浏览器模块的 require 只认包名，
 *   UI 库由宿主 external 提供。所以 UI 库实例必须从参数进来 ——
 *   工厂接收它，返回组件。测试时传假的实例对象就能驱动，
 *   Node 侧不依赖真 UI 库。
 *
 * @module dom/voice-settings-section
 */
import { configStore } from './config-store.js'
import { zhTranslate, languageLabel, voiceLabel, ttsEngineOptionLabel, idleReleaseLabel, modelLabel, envEngineLabel } from '../pure/i18n.js'
import { ttsEnvReasonText } from '../pure/tts-env-reason-text.js'
import {
  UI_DEFAULTS,
  LANGUAGE_CODES,
  RATE_OPTIONS,
  PITCH_OPTIONS,
  VOLUME_OPTIONS,
  RATE_PATTERN,
  PITCH_PATTERN,
  VOLUME_PATTERN,
  IDLE_RELEASE_OPTIONS,
  SOVITS_LANGS,
  TTS_FORMATS,
  STREAM_MODEL_IDS,
  VOICE_PROMPT_MODES,
  STRING_LIMITS,
  formatWordsText,
  parseWordsText,
  normalizeEngine,
  normalizeForSave,
  collectSaveErrors,
  formatEnvEngines,
  limitChoiceString,
  normalizeIdleReleaseMinutes,
  clampAutoSendExtraMs,
  normalizeSovitsLang,
  withCurrentOption,
} from '../pure/config-normalize.js'
import { validateShortcut, shortcutFocus } from '../pure/shortcut.js'
import { shortcutErrorText } from '../pure/shortcut-error-text.js'
import { parseEnvelope } from '../pure/envelope.js'
import { hotkeyReasonText } from '../pure/hotkey-reason-text.js'
import { modelDownloadReasonText } from '../pure/model-download-reason-text.js'
import { clientPlatform, describePlatformName } from '../pure/platform.js'
import { ROUTES } from '../pure/routes.js'

/**
 * 建设置面板组件（工厂函数）。
 *
 * @param {object} R - 宿主提供的 UI 库实例（external，浏览器侧由 <script> 注入，
 *   Node 测试传 `{ useState, useCallback, useEffect, useRef, createElement }` 桩即可）。
 * @returns {Function} VoiceSettingsSection 组件函数。
 */
export function createVoiceSettingsSection(R) {
  const { useState, useCallback, useEffect, useRef, createElement: h, Fragment } = R

  /**
   * 设置面板：模型、词表、朗读与交互开关。
   * @param props - slot 注入的属性。
   * @returns 设置表单。
   */
  /**
   * 设置面板用的三个小组件。
   *
   * **必须在模块级定义。**
   * 定义在组件体内的话，每次渲染它们都是新的函数 →
   * React 认为组件类型变了 → 卸载并重建 →
   * 设置面板里的输入框**每敲一个字符就失焦**
   *（词表、快捷键、两个毫秒数全中招）。
   */
  const labelStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginBottom: 14,
    fontSize: 13,
  }
  const Label = (props) => h('label', { style: labelStyle }, props.children)

  /**
   * 分组标题（可带说明，可折叠）。
   *
   * 用原生 `<details>/<summary>` 做折叠：SSR 友好、不依赖 hooks/state，
   * 浏览器里默认就是「点标题展开/收起」。高级与诊断区默认收起。
   * @param {{title: string, subtitle?: string, collapsible?: boolean, defaultOpen?: boolean, children?: any}} props
   */
  const Section = (props) => {
    const titleRow = h(
      'div',
      {
        style: {
          fontSize: 12,
          fontWeight: 600,
          opacity: 0.65,
          letterSpacing: '0.04em',
          marginBottom: props.subtitle ? 4 : 10,
          paddingBottom: 5,
          borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08))',
        },
      },
      props.title,
    )
    const subtitle = props.subtitle
      ? h(
          'div',
          { style: { fontSize: 12, opacity: 0.6, marginBottom: 10, lineHeight: 1.5 } },
          props.subtitle,
        )
      : null
    const body = h('div', null, props.children)
    if (!props.collapsible) {
      return h(
        'div',
        { style: { marginBottom: 18 } },
        titleRow,
        subtitle,
        body,
      )
    }
    // 折叠态：原生 <details>/<summary>（浏览器自带可更新的展开箭头，SSR 直接输出）。
    // `defaultOpen=false` 时不写 open 属性 → 默认收起。
    const detailsProps = { style: { marginBottom: 18 } }
    if (props.defaultOpen !== false) detailsProps.open = true
    return h(
      'details',
      detailsProps,
      h(
        'summary',
        { style: { cursor: 'pointer', outline: 'none' } },
        titleRow,
        subtitle,
      ),
      body,
    )
  }

  /**
   * 短字段并排（紧凑布局）。
   *
   * 窄面板自动换列（auto-fit + minmax）；**模块级组件**（不能有 hooks，
   * 否则每次渲染类型都变、输入框会失焦）。
   */
  const Row = (props) => h(
    'div',
    {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        columnGap: 14,
        alignItems: 'start',
      },
    },
    props.children,
  )

  /**
   * 开关行（带说明）。
   * @param {object} props - {label, hint, checked, onChange}。
   */
  const Toggle = (props) => h(
    'label',
    { style: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, marginBottom: 10, cursor: 'pointer' } },
    h('input', {
      type: 'checkbox',
      checked: props.checked === true,
      onChange: (event) => props.onChange(event.target.checked),
      style: { marginTop: 2 },
    }),
    h(
      'span',
      null,
      h('span', null, props.label),
      props.hint
        ? h('span', { style: { display: 'block', fontSize: 12, opacity: 0.65, marginTop: 2 } }, props.hint)
        : null,
    ),
  )

  /** 设置面板主组件。 */
  function SettingsPanel(props) {
  // 必须用 useCallback 稳住引用。
  // 直接写箭头函数的话，每次渲染都是新函数，
  // 而下面监听 SSE 的 effect 依赖 [reload, t] ——
  // 于是 effect 反复重跑：EventSource 刚连上就被 close() 关掉，
  // 永远收不到 model-progress（下载看不到进度），
  // 同时 void reload() → setConfig → 渲染 → 又触发 effect，陷入死循环。
  const t = useCallback(
    typeof props?.t === 'function' ? props.t : zhTranslate,
    [props?.t],
  )
  // 初始配置：默认取共享的 configStore。
  // __initialConfig 是给测试用的专用入口（宿主不会传这个名字），
  // 避免和宿主可能存在的 props.config 撞车。
  const [config, setConfig] = useState(props?.__initialConfig ?? configStore.value)
  // 词表输入框显示**用户原始输入**（空格/换行不能逐键归一化，否则键盘打不了）。
  // config.words 只在失焦/保存时归一化写入（审计 F1）。
  const [wordsText, setWordsText] = useState(() => formatWordsText((props?.__initialConfig ?? configStore.value)?.words))
  const [models, setModels] = useState(props?.__initialModels ?? [])
  const [voices, setVoices] = useState([])
  /** 本地引擎在当前平台是否可用（Windows/macOS/Linux）。 */
  const [localSupported, setLocalSupported] = useState(true)
  /** 运行环境自检结果。 */
  const [envInfo, setEnvInfo] = useState(null)
  /** 是否正在做环境自检。 */
  const [checkingEnv, setCheckingEnv] = useState(false)
  const [dirty, setDirty] = useState(false)
  /** 初始配置是否已从宿主加载完成。未完成时禁止保存，
   *  否则会用默认值覆盖用户已有的设置（比如把「朗读回复」关掉）。 */
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState('')
  /** 配置加载失败的提示（加载失败时保持 loaded=false、保存按钮禁用）。 */
  const [loadError, setLoadError] = useState('')
  /** POST /config 的 400 校验错误（可读文案列表）。 */
  const [saveErrors, setSaveErrors] = useState([])
  const [progress, setProgress] = useState(null)
  /**
   * 系统级热键 helper 的实时状态（只读展示）。
   *
   * null = 还没拉过（SSR/首次渲染）；{ok:false} = 诊断接口不可用；
   * {ok:true, platform,status,enabled,reason,accelerator} = 宿主状态。
   * 单独一份 state，绝不参与配置加载/保存（避免把只读诊断写进配置）。
   */
  const [hotkeyStatus, setHotkeyStatus] = useState(null)

  const set = (key, value) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  /**
   * 按引擎加载音色列表。
   * 必须跟随当前引擎：之前写死 engine=online，
   * 导致选了本地引擎后，下拉里还是 Edge 的音色列表。
   * @param {string} engine - online / local / neural / sovits。
   */
  const loadVoices = useCallback(async (engine) => {
    const normalized = normalizeEngine(engine) || 'online'
    // 神经模型 / GPT-SoVITS 没有可枚举的「音色列表」：
    // 前者用模型+说话人，后者由用户自己的服务端管理。
    if (normalized === 'neural' || normalized === 'sovits') {
      setVoices([])
      return
    }
    const target = normalized === 'local' ? 'local' : 'online'
    try {
      const resp = await fetch(`${ROUTES.voices}?engine=${target}${target === 'online' ? '&lang=zh' : ''}`)
      if (!resp.ok) return
      const data = await resp.json().catch(() => null)
      if (!data) return
      if (data.voices) setVoices(data.voices)
      if (target === 'local' && data.supported === false) setLocalSupported(false)
    } catch {
      /* 忽略 */
    }
  }, [])

  // 未保存改动标志的 ref 版：reload 是 useCallback，
  // 直接依赖 dirty 会在每次改动后重建它（依赖不稳定）。
  const dirtyRef = useRef(false)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  // 面板卸载时复位「正在录键」的状态：标志若卡在 true，
  // 全局快捷键会永久失效（卸载不保证触发 blur，审计 F14）。
  // 两个输入框共用一份 tracker，所以一次 releaseAll() 就够。
  useEffect(() => () => { shortcutFocus.releaseAll() }, [])

  const reload = useCallback(async () => {
    try {
      const resp = await fetch(ROUTES.config)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      if (!data || typeof data !== 'object') throw new Error('bad config payload')
      // **有未保存改动时绝不覆盖表单，也绝不把 dirty 清掉。**
      //
      // reload() 会在多个时机被调用：挂载、模型下载完成（model-ready）、
      // 换引擎换音色……用户正在改设置时它一跑，旧实现会 setConfig +
      // setDirty(false)：界面显示「没有未保存的改动」、保存按钮变灰，
      // 用户刚改的东西既没保存也不会被重置（审计 F2）。
      //
      // 共享存储照常更新（那是服务端的权威值），但表单只在没有本地改动时刷新。
      if (!dirtyRef.current) {
        setConfig((prev) => ({ ...prev, ...data }))
        setWordsText(formatWordsText(data.words))
        setDirty(false)
      }
      configStore.set(data)
      configStore.loaded = true
      setLoaded(true)
      setLoadError('')
      // 音色列表跟随（服务端生效的）引擎加载。
      void loadVoices(data.ttsEngine)
    } catch (error) {
      // 加载失败时保持 loaded=false（保存按钮禁用），并给出可重试提示。
      // 旧实现这里 setLoaded(true)：用户会拿默认/旧快照去保存，覆盖服务端配置。
      setLoaded(false)
      setStatus('')
      setLoadError(t('configLoadFailed'))
      try {
        // 浏览器里没有 process，这条只在「产物被 Node 直接跑起来」时生效
        //（测试桩就是把 client 源码在 Node 里执行的）。写成 globalThis.process
        // 而不是裸 process：后者会让「客户端伸手进 Node 全局」藏在 no-undef 里
        //（见 eslint.config.js），而且语义上这本来就是「问环境要东西」。
        if (globalThis.process?.env?.DSH_VT_DEBUG) {
          console.warn('[dsh-voice-typing] config load failed:', error)
        }
      } catch { /* 忽略 */ }
    }
  }, [loadVoices, t])

  /**
   * 拉取模型档位清单（识别 + 合成）。
   *
   * 下载完成后模型列表必须重新拉：
   * 之前只在组件挂载时拉一次，model-ready 事件只调 reload()，
   * 而 reload() 刷的是 /config 不是 /models ——
   * 结果下载完成了，列表里的 ready 还是 false，按钮还是「下载模型」。
   */
  const loadModels = useCallback(async () => {
    try {
      const resp = await fetch(ROUTES.models)
      if (!resp.ok) return null
      const data = await resp.json()
      if (data?.models) setModels(data.models)
      return data
    } catch {
      return null
    }
  }, [])

  /**
   * 拉一次系统级热键的实时状态（GET /diagnostics）。
   *
   * 只读展示：失败就显示「未知（诊断不可用）」，不重试、不抛错、不进配置。
   * 宿主 state() 当前返回 {enabled, status, reason, detail}；platform/accelerator
   * 属于可选字段（不同版本/未来扩展），取值时都要防御。
   * `reason` 是**原因码**（`src/shared/hotkey-reasons.js`），界面那句由
   * `pure/hotkey-reason-text.js` 按它出；`detail`（pid / 退出码 / 操作系统报错）
   * 这里**不取** —— 它只在 /diagnostics 原文里给排查的人看（批次 19，§8.61）。
   */
  const loadHotkeyStatus = useCallback(async () => {
    try {
      const resp = await fetch(ROUTES.diagnostics)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json().catch(() => null)
      if (!data || typeof data !== 'object') throw new Error('bad diagnostics payload')
      const hh = data.hotkeyHelper && typeof data.hotkeyHelper === 'object' ? data.hotkeyHelper : {}
      setHotkeyStatus({
        ok: true,
        platform: typeof hh.platform === 'string' ? hh.platform : '',
        status: typeof hh.status === 'string' ? hh.status : '',
        enabled: hh.enabled === true,
        reason: typeof hh.reason === 'string' ? hh.reason : '',
        accelerator: typeof hh.accelerator === 'string' ? hh.accelerator : '',
      })
    } catch {
      setHotkeyStatus({ ok: false })
    }
  }, [])

  // 热键状态只读：面板挂载时拉一次（失败显示未知，不循环重试）。
  useEffect(() => {
    void loadHotkeyStatus()
  }, [loadHotkeyStatus])

  useEffect(() => {
    void reload()
    // 先问宿主当前平台支不支持本地合成，不支持就把该选项禁用。
    fetch(`${ROUTES.voices}?engine=local`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data && data.supported === false) setLocalSupported(false) })
      .catch(() => {})
    void loadModels().then((data) => {
      // 恢复下载中的状态：
      // 设置面板关掉再打开时，组件重新挂载、组件内的状态全丢。
      // 宿主那边下载还在跑（activeDownloads），进度也在宿主侧，
      // 这里从 /models 的 downloading / received / total 恢复，
      // 否则用户看到的永远是「刚点了下载」却没有任何进度。
      //
      // 注意：不要把这段塞进 setModels 的更新函数里 ——
      // 在状态更新函数里调别的 setState 是 UI 库反模式，
      // 更新函数必须是纯的。
      const downloading = data?.models?.find((m) => m.downloading)
      if (!downloading) return
      setProgress({
        id: downloading.id,
        received: downloading.received ?? 0,
        total: downloading.total ?? 0,
      })
      setStatus(t('downloading'))
    })
    const source = new EventSource(ROUTES.stream)
    source.addEventListener('model-progress', (event) => {
      try {
        const payload = parseEnvelope(event)
        if (!payload) return
        // percent 由宿主算好 —— 两端各算一次会分叉
        // （宿主知道 total 的真实值，客户端只知道最近一次拿到的）。
        setProgress({
          id: payload.id,
          received: payload.received,
          total: payload.total,
          percent: payload.percent,
        })
        // 同步模型列表里的「下载中」状态
        setModels((prev) => prev.map((m) => (
          m.id === payload.id
            ? { ...m, downloading: true, received: payload.received, total: payload.total }
            : m
        )))
      } catch {
        /* 忽略 */
      }
    })
    source.addEventListener('model-ready', (event) => {
      void parseEnvelope(event)
      setProgress(null)
      setStatus(t('ready2'))
      // 模型刚下载好，刷新模型列表：
      // 不刷的话列表里的 ready 还是 false，按钮一直显示「下载模型」。
      void loadModels()
      void reload()
    })
    source.addEventListener('model-error', (event) => {
      let payload = null
      try {
        payload = parseEnvelope(event)
      } catch {
        /* 载荷坏掉就当没带码，下面走那句兜底 */
      }
      setProgress(null)
      // 原因由字典出（批次 22-4-2，§8.68 裁定 4 的收端）。
      // 改前这里 `void parseEnvelope(event)` 把事件里的载荷整片丢掉，
      // 界面只留一句「下载失败」—— 用户分不清是网络一时不通、
      // 档位表写错了，还是下载到的内容坏了，而这三件事该做的动作并不一样。
      // 宿主那句原文（`payload.error`）现在只进 console.warn，装机排查从那儿读。
      if (payload?.error) console.warn('[dsh-voice-typing] model download failed:', payload.error)
      setStatus(modelDownloadReasonText(payload?.reason, t, payload?.params))
      // 失败也要刷：把「下载中」的标记去掉，否则按钮一直禁用
      void loadModels()
    })
    return () => source.close()
  }, [reload, t, loadModels])

  /** 识别模型（不含合成模型）。 */
  const asrModels = models.filter((m) => m.category !== 'tts')
  /** 合成模型（从统一列表里取）。 */
  const ttsModels = models.filter((m) => m.category === 'tts')
  /** 已下载可用的合成模型（只有这些能被选中）。 */
  const readyNeural = ttsModels.filter((m) => m.ready)
  /** 已下载可用的识别模型（只有这些能被选中）。 */
  // host 模型不再无条件当作可用：
// 用户没装 DSH 语音输入 Bundle 时，SenseVoice 既没有宿主那份、
// 也没下载过 —— 它其实不可用，必须显示成「需要下载」。
// 之前用 `m.ready || m.host`，界面显示「已就绪」，
// 一用就报错（模型文件找不到）。
const readyAsr = asrModels.filter((m) => m.ready)

  const save = useCallback(async () => {
    // 保存前先做一次 UI 侧归一化（枚举/数值/模型残留），然后交给宿主 schema 校验。
    // 宿主非法时返回 400 {ok:false, errors:[{key,reason}]} → 可读展示、保持 dirty。
    const asrModel = asrModels.find((m) => m.id === config.model)
    const readyNeuralIds = readyNeural.map((m) => m.id)
    const selectedNeural = readyNeural.find((m) => m.id === config.neuralModel) ?? readyNeural[0]
    const neuralSpeakers = Number(selectedNeural?.speakers)
    const payload = normalizeForSave(
      { ...config, words: parseWordsText(wordsText) },
      { readyNeuralIds, asrModel, neuralSpeakers },
    )
    // 两段各自的失败，句子都由字典出（批次 22-3-3，docs §8.68）：
    //   ① 请求本身没走通（宿主没在监听 / 页面被关掉 / 网络抖）→ `saveFailedNetwork` 那句；
    //   ② 拿到回执之后的本地步骤出错（回填、共享存储、校验错误归一化）→ 短词 `saveFailed`。
    // 改前这两类共用一行 `${saveFailed}：${error.message}`，界面上拼的是浏览器给的技术串
    // （`Failed to fetch` 这类）：中文界面冒英文串、英文界面也不告诉用户该做什么。
    // 原始 message 只进 console.warn，装机排查从那儿读。
    let resp
    let data
    try {
      resp = await fetch(ROUTES.config, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      data = await resp.json().catch(() => null)
    } catch (error) {
      console.warn('[dsh-voice-typing] config request failed:', error instanceof Error ? error.message : String(error))
      setSaveErrors([t('saveFailedNetwork')])
      setStatus(t('saveFailed'))
      return
    }
    try {
      if (!resp.ok) {
        const errors = collectSaveErrors(data, t)
        setSaveErrors(errors.length ? errors : [t('saveFailed')])
        setStatus(t('saveFailed'))
        return
      }
      setDirty(false)
      setSaveErrors([])
      setStatus(t('saved'))
      // 同步到共享配置：麦克风按钮立刻用新参数，不用刷新页面。
      configStore.set(payload)
      configStore.loaded = true
      // 以服务端返回的生效配置为准回填，避免界面与实际不一致
      const effective = data?.config && typeof data.config === 'object' ? data.config : payload
      setConfig((prev) => ({ ...prev, ...effective }))
      setWordsText(formatWordsText(effective.words))
      configStore.set(effective)
      // 保存后宿主会按新配置重新 sync helper：再拉一次只读状态，
      // 让用户立刻看到「已启用/失败原因」，而不用重新打开面板。
      void loadHotkeyStatus()
    } catch (error) {
      console.warn('[dsh-voice-typing] config apply failed:', error instanceof Error ? error.message : String(error))
      setSaveErrors([t('saveFailed')])
      setStatus(t('saveFailed'))
    }
  }, [config, wordsText, asrModels, readyNeural, t, loadHotkeyStatus])

  /**
   * 运行环境自检：看哪个朗读引擎能用、机器上有没有 NVIDIA 显卡。
   *
   * 注意：显卡信息只是**展示**用的。插件的推理一律走 CPU ——
   * 实测 CUDA 只比 CPU 快 20%，却要额外装 2GB 的 NVIDIA 运行时，
   * 不划算，所以没有做 GPU 加速。
   */
  const runEnvCheck = useCallback(async () => {
    setCheckingEnv(true)
    try {
      const resp = await fetch(ROUTES.ttsEnv)
      const data = resp.ok ? await resp.json() : null
      if (data) setEnvInfo(data)
    } catch {
      /* 忽略 */
    } finally {
      setCheckingEnv(false)
    }
  }, [])

  const download = useCallback(
    async (id) => {
      setStatus(t('downloading'))
      setProgress({ id, received: 0, total: 0 })
      // 立刻把这一行标成「下载中」：
      // 否则要等 SSE 的第一条 model-progress 回来才变，
      // 用户会以为「点了没反应」。
      setModels((prev) => prev.map((m) => (m.id === id ? { ...m, downloading: true } : m)))
      try {
        const resp = await fetch(ROUTES.model, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        })
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}))
          // 宿主路由层那句原文不再原样上界面（批次 22-4-2）：
          // `unknown model: sensevoice` 与 `宿主内置模型不可用：xxx` 都是写给开发者看的话，
          // 中文界面冒英文 id、英文界面冒中文，而且没有一个字告诉用户该做什么。
          // 现在读 22-4-1 带出来的 `reason` + `params`，原文只进 console.warn。
          if (body?.error) console.warn('[dsh-voice-typing] download rejected:', body.error)
          setStatus(modelDownloadReasonText(body?.reason, t, body?.params))
          setModels((prev) => prev.map((m) => (m.id === id ? { ...m, downloading: false } : m)))
        }
      } catch (error) {
        // 请求根本没走到宿主（没在监听 / 页面被关掉 / 网络断），拿不到原因码，
        // 只能给那句通用的「下载失败」—— 没有为它编新句子（§8.68 的口径）。
        console.warn('[dsh-voice-typing] download request failed:', error instanceof Error ? error.message : String(error))
        setStatus(t('downloadFailed'))
        setModels((prev) => prev.map((m) => (m.id === id ? { ...m, downloading: false } : m)))
      }
    },
    [t],
  )


  const inputStyle = {
    padding: '6px 8px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
    background: 'transparent',
    color: 'inherit',
    fontSize: 13,
  }

  // 当前引擎：决定哪些参数有意义。非法值按 online 处理并提示（保存时会修正）。
  const engineRaw = String(config.ttsEngine ?? '').trim().toLowerCase()
  const engine = normalizeEngine(engineRaw) || UI_DEFAULTS.ttsEngine
  const engineInvalid = Boolean(engineRaw) && engineRaw !== engine
  const isOnline = engine === 'online'
  const isNeural = engine === 'neural'
  const isLocal = engine === 'local'
  const isSovits = engine === 'sovits'
  const readAloudOn = config.readAloud === true

  // ---- 识别侧联动 ----
  const selectedAsrModel = asrModels.find((m) => m.id === config.model) ?? null
  const asrModelLanguages = Array.isArray(selectedAsrModel?.languages) && selectedAsrModel.languages.length
    ? selectedAsrModel.languages
    : null
  /** 只有 SenseVoice 真正消费 language（其它模型的 worker 配置里没有 language）。 */
  const languageSupported = selectedAsrModel ? selectedAsrModel.engine === 'sensevoice' : true
  const languageValue = String(config.language ?? UI_DEFAULTS.language)
  const languageOptions = LANGUAGE_CODES.filter(
    (code) => code === 'auto' || !asrModelLanguages || asrModelLanguages.includes(code),
  )
  const languageWarn = languageSupported
    ? (Boolean(asrModelLanguages) && languageValue !== 'auto' && !asrModelLanguages.includes(languageValue))
    : true
  const streamModel = models.find((m) => m.id === STREAM_MODEL_IDS[0]) ?? null
  const streamReady = Boolean(streamModel?.ready)
  const liveAsrValue = String(config.liveAsr ?? UI_DEFAULTS.liveAsr)
  const autoSendOff = config.autoSend === false
  const modeValue = String(config.mode ?? UI_DEFAULTS.mode)
  const onceUnavailable = modeValue === 'once' && autoSendOff
  // ---- 合成侧联动 ----
  const neuralModelMissing = isNeural && readyNeural.length > 0
    && !readyNeural.some((m) => m.id === config.neuralModel)
  const selectedNeural = readyNeural.find((m) => m.id === config.neuralModel) ?? readyNeural[0]
  const speakerCount = Number(selectedNeural?.speakers)
  // 快捷键非法时阻止保存（旧实现只显示红字但仍允许保存 → 保存后热键静默失效）。
  const shortcutCheck = validateShortcut(config.shortcut ?? UI_DEFAULTS.shortcut)
  // 全局语音快捷键是**另一套**配置：同样复用 validateShortcut 规则，
  // 非法时也要阻止保存（否则保存成功但窗口内快捷键永久不触发）。
  const globalShortcutValue = String(config.globalShortcut ?? UI_DEFAULTS.globalShortcut)
  const globalShortcutCheck = validateShortcut(globalShortcutValue)
  const voicePromptModeValue = VOICE_PROMPT_MODES.includes(String(config.voicePromptMode))
    ? String(config.voicePromptMode)
    : UI_DEFAULTS.voicePromptMode
  // 唤醒词：显示原样（trim 后），空串合法 = 关闭唤醒词。
  const wakeWordValue = String(config.wakeWord ?? UI_DEFAULTS.wakeWord).trim()
  const saveDisabled = !dirty || !loaded || !shortcutCheck.ok || !globalShortcutCheck.ok
  const envEngines = formatEnvEngines(envInfo, engine)
  // 下拉显示用：把存量值收敛到 UI 认识的形状，并把列表外的合法值补成额外选项
  // （避免「保存在即悄悄改成第一项」）。
  const rateValue = limitChoiceString(config.rate, RATE_PATTERN, UI_DEFAULTS.rate)
  const pitchValue = limitChoiceString(config.pitch, PITCH_PATTERN, UI_DEFAULTS.pitch)
  const volumeValue = limitChoiceString(config.volume, VOLUME_PATTERN, UI_DEFAULTS.volume)
  const ttsFormatValue = TTS_FORMATS.includes(config.ttsFormat) ? config.ttsFormat : UI_DEFAULTS.ttsFormat
  const idleValue = normalizeIdleReleaseMinutes(config.idleReleaseMinutes)

  // ---- 系统级热键只读状态（纯展示，不参与 normalizeForSave / 保存）----
  const helperOn = config.globalHotkeyHelper === true
  const overlayOn = config.globalVoice === true
  // 平台优先用宿主 state() 给的（未来版本可能有），否则从渲染器平台推断。
  const hotkeyPlatformText = describePlatformName(
    hotkeyStatus?.ok === true && hotkeyStatus.platform ? hotkeyStatus.platform : clientPlatform(),
  )
  let hotkeyStatusText = ''
  let hotkeyStatusReasonText = ''
  if (!helperOn) {
    // 本地开关关着：宿主可能还没来得及 sync，直接显示关了，比旧状态更可信。
    hotkeyStatusText = t('hotkeyStatusDisabled')
  } else if (!hotkeyStatus) {
    hotkeyStatusText = t('hotkeyStatusLoading')
  } else if (hotkeyStatus.ok !== true) {
    hotkeyStatusText = t('hotkeyStatusUnknown')
  } else {
    const helperState = hotkeyStatus.status
    // 已启用时显示组合键：宿主 state() 没带 accelerator，就用当前配置值。
    const accelerator = hotkeyStatus.accelerator || String(config.globalShortcut ?? UI_DEFAULTS.globalShortcut)
    if (hotkeyStatus.enabled === true || helperState === 'enabled') {
      hotkeyStatusText = t('hotkeyStatusEnabled', { accelerator })
    } else if (helperState === 'starting' || helperState === 'loading') {
      hotkeyStatusText = t('hotkeyStatusStarting')
    } else if (helperState === 'failed' || helperState === 'exited') {
      hotkeyStatusText = t('hotkeyStatusFailed')
    } else {
      hotkeyStatusText = t('hotkeyStatusDisabled')
    }
    // 「为什么没成、能怎么办」由宿主报的**原因码**换成界面语言的那句
    //（批次 19，docs/architecture-modernization.md §8.61）：宿主不再写句子，
    // 旧宿主写来的句子也不认（走兜底那句）；动态原文（pid / 退出码 / 操作系统报错）
    // 留在 /diagnostics 的 detail 里，界面一个字都不取。
    // 成功与「正在做」没有码（空串），说明那一行就不显示。
    if (hotkeyStatus.reason) hotkeyStatusReasonText = hotkeyReasonText(hotkeyStatus.reason, t)
  }
  const hotkeyNeedsOverlay = helperOn && !overlayOn

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 2px' } },

    /* ============ 一、语音识别 ============ */
    h(
      Section,
      { title: t('secRecognition'), subtitle: t('secRecognitionHint'), collapsible: true },
      h(
        Label,
        null,
        h('span', null, t('model')),
        h(
          'select',
          {
            value: config.model ?? UI_DEFAULTS.model,
            onChange: (event) => set('model', event.target.value),
            style: inputStyle,
          },
          // 只列出「已下载可用」的识别模型。
          // 没下好的模型不允许被选中 —— 只能去模型管理区下载。
          // 名字按 id 查字典（批次 22-3-1）：宿主 `label` 那句中文不进界面，
          // 它新写的 `labelEn` 以前更是从来没被读过。
          (readyAsr.length
            ? readyAsr.map((model) => h(
                'option',
                { key: model.id, value: model.id },
                modelLabel(model.id, t),
              ))
            : [h('option', { key: '__none', value: '' }, t('modelNoReady'))]),
          readyAsr.length
            ? h(
                'span',
                { style: { fontSize: 12, opacity: 0.7 } },
                t('modelHint'),
              )
            : null,
        ),
      ),
      h(
        Label,
        null,
        h('span', null, t('language')),
        h(
          'select',
          {
            value: languageValue,
            disabled: !languageSupported,
            onChange: (event) => set('language', event.target.value),
            style: { ...inputStyle, opacity: languageSupported ? 1 : 0.55 },
          },
          // 只有 SenseVoice 真正消费 language；其它模型把选项过滤到模型自己支持的语言，
          // 模型完全不支持语言提示时就禁用（审计 F4）。
          LANGUAGE_CODES.map((lang) => h(
            'option',
            {
              key: lang,
              value: lang,
              disabled: !languageOptions.includes(lang),
            },
            languageLabel(lang, t),
          )),
        ),
        !languageSupported
          ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } }, t('languageModelUnsupported'))
          : languageWarn
            ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } }, t('languageNotInModel'))
            : null,
      ),

      /* 实时字方式：整段重识别 vs 流式解码 */
      h(
        Label,
        null,
        h('span', null, t('liveAsr')),
        h(
          'select',
          {
            value: liveAsrValue,
            onChange: (event) => set('liveAsr', event.target.value),
            style: inputStyle,
          },
          [
            ['full', t('liveAsrFull')],
            // 流式解码依赖 zipformer2-zh；没下载时禁用并说明（审计：隐藏依赖）。
            // 那句「需先下载什么」由字典出（批次 22-2），模型 id 是契约值，作为参数填进去。
            ['stream', streamReady ? t('liveAsrStream') : `${t('liveAsrStream')}${t('liveAsrStreamNeedsOption', { model: 'zipformer2-zh' })}`],
            ['auto', t('liveAsrAuto')],
          ].map(([v, label]) => h(
            'option',
            { key: v, value: v, disabled: v === 'stream' && !streamReady },
            label,
          )),
        ),
        h(
          'span',
          { style: { fontSize: 12, opacity: 0.7 } },
          t('liveAsrHint'),
        ),
        !streamReady
          ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } }, t('liveAsrStreamNeedsModel'))
          : null,
      ),
    ),

    /* ============ 二、语音交互 ============ */
    h(
      Section,
      { title: t('secInteraction'), subtitle: t('secInteractionHint'), collapsible: true },
      h(
        Label,
        null,
        h('span', null, t('mode')),
        h(
          'select',
          {
            value: modeValue,
            onChange: (event) => set('mode', event.target.value),
            style: inputStyle,
          },
          [
            { value: 'toggle', label: t('modeToggle'), disabled: false },
            // 「说完就关」的退出发生在自动发送分支里：autoSend 关闭时它不会生效。
            { value: 'once', label: t('modeOnce'), disabled: autoSendOff },
          ].map((item) => h(
            'option',
            { key: item.value, value: item.value, disabled: item.disabled },
            item.label,
          )),
        ),
        h(
          'span',
          { style: { fontSize: 12, opacity: 0.7 } },
          t('modeHint'),
        ),
        onceUnavailable
          ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } }, t('modeOnceNeedsAutoSend'))
          : null,
      ),
      h(
        Toggle,
        {
          label: t('autoSend'),
          hint: t('autoSendHint'),
          checked: config.autoSend !== false,
          onChange: (v) => set('autoSend', v),
        },
      ),
      // 短字段并排：断句时长 + 发送前等待（后者只在自动发送打开时有意义）
      h(
        Row,
        null,
        // 断句时长：直接决定「说完一句」判定，影响体验最明显
        h(
          Label,
          null,
          h('span', null, t('silenceMs')),
          h(
            'input',
            {
              type: 'number',
              min: 500,
              max: 5000,
              step: 100,
              value: config.silenceMs ?? 1500,
              onChange: (event) => set('silenceMs', Math.max(500, Math.min(5000, Number(event.target.value) || 1500))),
              style: { ...inputStyle, width: 120 },
            },
          ),
          h(
            'span',
            { style: { fontSize: 12, opacity: 0.7 } },
            t('silenceMsHint'),
          ),
        ),
        config.autoSend !== false
          ? h(
              Label,
              null,
              h('span', null, t('autoSendExtraMs')),
              h(
                'input',
                {
                  type: 'number',
                  min: 0,
                  max: 5000,
                  step: 100,
                  value: config.autoSendExtraMs ?? UI_DEFAULTS.autoSendExtraMs,
                  onChange: (event) => set('autoSendExtraMs', clampAutoSendExtraMs(event.target.value)),
                  style: { ...inputStyle, width: 120 },
                },
              ),
              h(
                'span',
                { style: { fontSize: 12, opacity: 0.7 } },
                t('autoSendExtraMsHint'),
              ),
            )
          : null,
      ),
      // 快捷键单独一行（输入框需要完整宽度）
      h(
        Label,
        null,
        h('span', null, t('shortcut')),
        h('input', {
          value: config.shortcut ?? UI_DEFAULTS.shortcut,
          onChange: (event) => set('shortcut', event.target.value),
          placeholder: UI_DEFAULTS.shortcut,
          // 聚焦这个输入框时，快捷键不应该触发录音。
          onFocus: () => { shortcutFocus.focus('composer') },
          onBlur: () => { shortcutFocus.blur('composer') },
          style: inputStyle,
        }),
        h('span', { style: { fontSize: 12, opacity: 0.7 } }, t('shortcutHint')),
        !shortcutCheck.ok
          ? h(
              'span',
              { style: { fontSize: 12, color: 'var(--dsw-alias-state-danger, #d13438)' } },
              shortcutErrorText(shortcutCheck, t),
            )
          : null,
      ),

      /* ---- 全局语音浮层（任意页面常驻，与上面的 composer 语音两条链路） ---- */
      h(
        Toggle,
        {
          label: t('globalVoice'),
          hint: t('globalVoiceHint'),
          checked: config.globalVoice === true,
          onChange: (v) => set('globalVoice', v),
        },
      ),
      // 全局快捷键单独一行（输入框需要完整宽度）。
      // 聚焦期间把模块级标志置真：两套快捷键（composer/全局）都不触发，
      // 否则用户想改键，反而先把自己的语音打开。
      h(
        Label,
        null,
        h('span', null, t('globalShortcut')),
        h('input', {
          value: globalShortcutValue,
          onChange: (event) => set('globalShortcut', event.target.value),
          placeholder: UI_DEFAULTS.globalShortcut,
          onFocus: () => { shortcutFocus.focus('global') },
          onBlur: () => { shortcutFocus.blur('global') },
          style: inputStyle,
        }),
        h('span', { style: { fontSize: 12, opacity: 0.7 } }, t('globalShortcutHint')),
        !globalShortcutCheck.ok
          ? h(
              'span',
              { style: { fontSize: 12, color: 'var(--dsw-alias-state-danger, #d13438)' } },
              shortcutErrorText(globalShortcutCheck, t),
            )
          : null,
      ),
      h(
        Label,
        null,
        h('span', null, t('voicePromptMode')),
        h(
          'select',
          {
            value: voicePromptModeValue,
            onChange: (event) => set('voicePromptMode', event.target.value),
            style: inputStyle,
          },
          [
            { value: 'queue', label: t('voicePromptModeQueue') },
            { value: 'steer', label: t('voicePromptModeSteer') },
          ].map((item) => h('option', { key: item.value, value: item.value }, item.label)),
        ),
        h('span', { style: { fontSize: 12, opacity: 0.7 } }, t('voicePromptModeHint')),
      ),
      // v3 唤醒词：留空 = 关闭唤醒词（回到「说话直接发送」）。
      // 输入框保留用户原始输入（不逐键 trim），保存时由 normalizeForSave 收敛。
      h(
        Label,
        null,
        h('span', null, t('wakeWord')),
        h('input', {
          value: config.wakeWord ?? UI_DEFAULTS.wakeWord,
          maxLength: STRING_LIMITS.wakeWord,
          onChange: (event) => set('wakeWord', event.target.value),
          placeholder: UI_DEFAULTS.wakeWord,
          style: inputStyle,
        }),
        h('span', { style: { fontSize: 12, opacity: 0.7 } }, t('wakeWordHint')),
        // 当前生效值便于排查（例如留空时明确告诉用户「唤醒词已关闭」）。
        !wakeWordValue
          ? h(
              'span',
              { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } },
              t('wakeWordOffNotice'),
            )
          : null,
      ),
    ),

    /* ============ 三、文本处理 ============ */
    h(
      Section,
      { title: t('secText'), subtitle: t('secTextHint'), collapsible: true },
      h(
        Toggle,
        {
          label: t('removeFillers'),
          hint: t('removeFillersHint'),
          checked: config.removeFillers === true,
          onChange: (v) => set('removeFillers', v),
        },
      ),
      h(
        Label,
        null,
        h('span', null, t('words')),
        h('textarea', {
          // 显示用户原始输入；空格/换行在失焦或保存时才归一化（审计 F1：
          // 旧实现每键 split/trim/filter，键盘根本打不出空格和换行）。
          value: wordsText,
          onChange: (event) => {
            setWordsText(event.target.value)
            setDirty(true)
          },
          onBlur: () => set('words', parseWordsText(wordsText)),
          placeholder: t('wordsPlaceholder'),
          rows: 5,
          style: { ...inputStyle, resize: 'vertical' },
        }),
        h('span', { style: { fontSize: 12, opacity: 0.7 } }, t('wordsHint')),
      ),
    ),

    /* ============ 四、语音合成 ============ */
    h(
      Section,
      { title: t('secSynthesis'), subtitle: t('secSynthesisHint'), collapsible: true },
      // 当前合成方式放在本区顶部（原在模型管理区）：先看到「现在用什么在念」。
      h(
        'div',
        {
          style: {
            fontSize: 12,
            marginBottom: 10,
            padding: '8px 10px',
            border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
            borderRadius: 8,
            opacity: 0.9,
          },
        },
        `${t('ttsCurrent')}: ${engine === 'sovits'
          ? `GPT-SoVITS (${config.sovitsUrl ?? 'http://127.0.0.1:9880'})`
          : engine === 'neural'
            ? (readyNeural.some((x) => x.id === config.neuralModel)
              ? modelLabel(config.neuralModel, t)
              : t('neuralNoModel'))
            : engine === 'local'
              ? (voiceLabel(config.localVoice ?? '', t) || t('localVoiceDefault'))
              : (voiceLabel(config.voice ?? '', t) || (config.voice ?? ''))}`,
      ),
      // 总开关放最前：关掉时整个合成区无意义
      h(
        Toggle,
        {
          label: t('readAloud'),
          hint: t('readAloudHint'),
          checked: readAloudOn,
          onChange: (v) => set('readAloud', v),
        },
      ),
      readAloudOn
        ? null
        : h(
            'span',
            { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } },
            t('readAloudOffNotice'),
          ),
      // 非法引擎值（旧配置/手改文件）按 online 处理并明确提示；保存时会被修正。
      engineInvalid
        ? h(
            'span',
            { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } },
            t('ttsEngineInvalid'),
          )
        : null,
      // 即使朗读关闭也渲染全部合成设置：允许用户预先配置引擎/SoVITS
      // （审计 F17：旧实现整块隐藏，必须先开朗读保存后才能配置）。
      h(
            Fragment,
            null,
            // 「追赶最新」：生成远快于朗读时，最多允许落后屏幕多少秒。
            // 超过就按整段跳到最新内容（宿主 lib/read-aloud-scheduler.js 实现）。
            // 0 = 关闭追赶（全部朗读，长回复会越读越滞后）。
            h(
              Label,
              null,
              h('span', null, t('readAloudLag')),
              h('input', {
                type: 'number',
                min: 0,
                max: 120,
                step: 0.5,
                value: config.readAloudLag ?? UI_DEFAULTS.readAloudLag,
                onChange: (event) => {
                  // <input type="number"> 在空串/非法内容时给的是 ''，而
                  // `Number('')` 是 0（**不是** NaN）—— 清空输入框或粘贴非法内容
                  // 会把追赶关掉（0 = 全部朗读、越读越滞后）。
                  // 空/非法 → 回退默认 7.5；合法值 clamp 0..120 后按 0.5 秒取整。
                  const raw = String(event.target.value ?? '').trim()
                  const n = Number(raw)
                  const next = raw === '' || !Number.isFinite(n)
                    ? 7.5
                    : Math.max(0, Math.min(120, Math.round(n * 2) / 2))
                  set('readAloudLag', next)
                },
                style: inputStyle,
              }),
              h(
                'span',
                { style: { fontSize: 12, opacity: 0.7 } },
                t('readAloudLagHint'),
              ),
            ),
            h(
              Label,
              null,
              h('span', null, t('ttsEngine')),
              h(
                'select',
                {
                  value: engine,
                  onChange: (event) => {
                    const next = event.target.value
                    set('ttsEngine', next)
                    // 切换引擎后立刻换成对应引擎的音色列表
                    void loadVoices(next)
                  },
                  style: inputStyle,
                },
                [
                  ['online', ttsEngineOptionLabel('online', t)],
                  ['neural', ttsEngineOptionLabel('neural', t)],
                  ['local', ttsEngineOptionLabel('local', t, localSupported)],
                  ['sovits', ttsEngineOptionLabel('sovits', t)],
                ].map(([v, label]) => h('option', { key: v, value: v, disabled: v === 'local' && !localSupported }, label)),
              ),
              h(
                'span',
                { style: { fontSize: 12, opacity: 0.7 } },
                t('ttsEngineHint'),
              ),
            ),

            /* GPT-SoVITS 外部服务：插件只转发文本，不做克隆/模型管理 */
            isSovits
              ? h(
                  Fragment,
                  null,
                  h(
                    Label,
                    null,
                    h('span', null, t('sovitsUrl')),
                    h('input', {
                      type: 'text',
                      value: config.sovitsUrl ?? UI_DEFAULTS.sovitsUrl,
                      onChange: (event) => set('sovitsUrl', event.target.value),
                      style: inputStyle,
                    }),
                    h(
                      'span',
                      { style: { fontSize: 12, opacity: 0.7 } },
                      t('sovitsUrlHint'),
                    ),
                  ),
                  h(
                    Label,
                    null,
                    h('span', null, t('sovitsRefAudio')),
                    h('input', {
                      type: 'text',
                      value: config.sovitsRefAudio ?? '',
                      placeholder: '/path/to/reference.wav',
                      onChange: (event) => set('sovitsRefAudio', event.target.value),
                      style: inputStyle,
                    }),
                    h(
                      'span',
                      { style: { fontSize: 12, opacity: 0.7 } },
                      t('sovitsRefAudioHint'),
                    ),
                  ),
                  h(
                    Label,
                    null,
                    h('span', null, t('sovitsPromptText')),
                    h('input', {
                      type: 'text',
                      value: config.sovitsPromptText ?? '',
                      onChange: (event) => set('sovitsPromptText', event.target.value),
                      style: inputStyle,
                    }),
                    h(
                      'span',
                      { style: { fontSize: 12, opacity: 0.7 } },
                      t('sovitsPromptTextHint'),
                    ),
                  ),
                  h(
                    Label,
                    null,
                    h('span', null, t('sovitsTextLang')),
                    h(
                      'select',
                      {
                        value: normalizeSovitsLang(config.sovitsTextLang),
                        onChange: (event) => set('sovitsTextLang', event.target.value),
                        style: inputStyle,
                      },
                      SOVITS_LANGS.map((v) => h('option', { key: v, value: v }, v)),
                    ),
                  ),
                  h(
                    Label,
                    null,
                    h('span', null, t('sovitsPromptLang')),
                    h(
                      'select',
                      {
                        value: normalizeSovitsLang(config.sovitsPromptLang),
                        onChange: (event) => set('sovitsPromptLang', event.target.value),
                        style: inputStyle,
                      },
                      SOVITS_LANGS.map((v) => h('option', { key: v, value: v }, v)),
                    ),
                  ),
                  h(
                    'span',
                    { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.5 } },
                    t('sovitsHint'),
                  ),
                )
              : null,

            /* 音色：在线用 Edge 音色，神经用模型+说话人，本地用系统语音 */
            isNeural
              ? h(
                  Fragment,
                  null,
                  h(
                    Label,
                    null,
                    h('span', null, t('neuralModel')),
                    h(
                      'select',
                      {
                        value: readyNeural.length
                          ? (readyNeural.some((m) => m.id === config.neuralModel) ? config.neuralModel : readyNeural[0].id)
                          : '',
                        onChange: (event) => set('neuralModel', event.target.value),
                        style: inputStyle,
                      },
                      readyNeural.length
                        ? readyNeural.map((m) => h('option', { key: m.id, value: m.id }, modelLabel(m.id, t)))
                        : [h('option', { key: '__none', value: '' }, t('neuralNoModel'))],
                    ),
                    h(
                      'span',
                      { style: { fontSize: 12, opacity: 0.7 } },
                      readyNeural.length ? t('neuralReadyModels', { count: readyNeural.length }) : t('neuralNoModelHint'),
                    ),
                    neuralModelMissing
                      ? h(
                          'span',
                          { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning, #9a6700)' } },
                          t('neuralModelMissingWarning'),
                        )
                      : null,
                  ),
                  (() => {
                    const tier = readyNeural.find((m) => m.id === config.neuralModel) ?? readyNeural[0]
                    // 单说话人模型没有「选说话人」的意义，隐藏（审计 F18）。
                    if (!tier?.speakers || Number(tier.speakers) <= 1) return null
                    return h(
                      Label,
                      null,
                      h('span', null, t('neuralSpeaker')),
                      h(
                        'select',
                        {
                          value: String(Math.min(
                            Math.max(0, Number(config.neuralSpeaker) || 0),
                            Math.max(0, Number(tier.speakers) - 1),
                          )),
                          onChange: (event) => set('neuralSpeaker', Number(event.target.value)),
                          style: inputStyle,
                        },
                        Array.from({ length: tier.speakers }, (_, i) =>
                          h('option', { key: i, value: String(i) }, t('neuralSpeakerOption', { index: String(i) })),
                        ),
                      ),
                    )
                  })(),
                )
              : isSovits
                ? null
                : h(
                  Label,
                  null,
                  h('span', null, t('voice')),
                  h(
                    'select',
                    {
                      value: isLocal ? (config.localVoice ?? '') : (config.voice ?? UI_DEFAULTS.voice),
                      onChange: (event) => set(isLocal ? 'localVoice' : 'voice', event.target.value),
                      style: inputStyle,
                    },
                    (voices.length
                      ? voices
                      : [{
                          name: (isLocal ? config.localVoice : config.voice)
                            ?? (isLocal ? '' : UI_DEFAULTS.voice),
                          locale: '',
                          gender: '',
                        }]
                    ).map((v) => h(
                      'option',
                      { key: v.name, value: v.name },
                      voiceLabel(v.name, t),
                    )),
                  ),
                  h(
                    'span',
                    { style: { fontSize: 12, opacity: 0.7 } },
                    t('voiceHint'),
                  ),
                ),

            /* 短字段并排：语速 + 音调（+音量/格式按引擎条件） */
            h(
              Row,
              null,
              // 语速：四种引擎都支持
              h(
                Label,
                null,
                h('span', null, t('rate')),
                h(
                  'select',
                  {
                    value: rateValue,
                    onChange: (event) => set('rate', event.target.value),
                    style: inputStyle,
                  },
                  withCurrentOption(RATE_OPTIONS, rateValue)
                    .map((v) => h('option', { key: v, value: v }, v)),
                ),
              ),
              // 音调：只有在线 Edge 支持
              isOnline
                ? h(
                    Label,
                    null,
                    h('span', null, t('pitch')),
                    h(
                      'select',
                      {
                        value: pitchValue,
                        onChange: (event) => set('pitch', event.target.value),
                        style: inputStyle,
                      },
                      withCurrentOption(PITCH_OPTIONS, pitchValue)
                        .map((v) => h('option', { key: v, value: v }, v)),
                    ),
                  )
                : null,
              // 音量：神经模型与 GPT-SoVITS 外部服务不支持
              !isNeural && !isSovits
                ? h(
                    Label,
                    null,
                    h('span', null, t('volume')),
                    h(
                      'select',
                      {
                        value: volumeValue,
                        onChange: (event) => set('volume', event.target.value),
                        style: inputStyle,
                      },
                      withCurrentOption(VOLUME_OPTIONS, volumeValue)
                        .map((v) => h('option', { key: v, value: v }, v)),
                    ),
                  )
                : null,
              // 音频格式：只有在线 Edge 支持
              isOnline
                ? h(
                    Label,
                    null,
                    h('span', null, t('ttsFormat')),
                    h(
                      'select',
                      {
                        value: ttsFormatValue,
                        onChange: (event) => set('ttsFormat', event.target.value),
                        style: inputStyle,
                      },
                      [
                        ['AUDIO_24KHZ_48KBITRATE_MONO_MP3', t('ttsFormatMp3Small')],
                        ['AUDIO_24KHZ_96KBITRATE_MONO_MP3', t('ttsFormatMp3Quality')],
                        // 上游 msedge-tts 的 OUTPUT_FORMAT 有三个键（两个 MP3 加一个 WEBM/Opus），
                        // 面板只给 MP3 的两个。
                        // 之前还有个「48kHz/192kbps」的选项，上游从来没有这个键，
                        // 选它会被静默回落到 24kHz/48kbps —— 用户以为换了格式，其实没换。
                        // 现在「词表里的键上游认不认」有真判据钉着（`test/edge-tts.test.mjs`
                        // 的「真装的 msedge-tts」那一段逐个对），不再只靠这行注释。
                        // 真要更高音质得改用本地神经引擎。
                      ].map(([v, label]) => h('option', { key: v, value: v }, label)),
                    ),
                  )
                : null,
            ),
        ),
    ),

    /* ============ 五、模型与下载 ============ */
    h(
      Section,
      { title: t('secModels'), subtitle: t('secModelsHint'), collapsible: true },
      // 预加载
      h(
        Toggle,
        {
          label: t('preloadModels'),
          hint: t('preloadModelsHint'),
          checked: config.preloadModels !== false,
          onChange: (v) => set('preloadModels', v),
        },
      ),
      // 短字段并排：空闲释放 + 环境自检
      h(
        Row,
        null,
        h(
          Label,
          null,
          h('span', null, t('idleReleaseMinutes')),
          h(
            'select',
            {
              value: String(idleValue),
              onChange: (event) => set('idleReleaseMinutes', Number(event.target.value)),
              style: inputStyle,
            },
            withCurrentOption(
              IDLE_RELEASE_OPTIONS.map((v) => String(v)),
              String(idleValue),
            ).map((v) => h(
              'option',
              { key: v, value: v },
              // 那句「怎么称呼这个数字」由字典出（批次 22-2）；档位本身是 `IDLE_RELEASE_OPTIONS` 的契约值。
              idleReleaseLabel(v, t),
            )),
          ),
          h(
            'span',
            { style: { fontSize: 12, opacity: 0.7 } },
            t('idleReleaseMinutesHint'),
          ),
        ),
        h(
          Label,
          null,
          h('span', null, t('envCheck')),
          h(
            'button',
            {
              type: 'button',
              onClick: () => void runEnvCheck(),
              style: {
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
                background: 'transparent',
                color: 'inherit',
                fontSize: 12,
                cursor: 'pointer',
              },
            },
            checkingEnv ? t('envChecking') : t('envRecheck'),
          ),
        ),
      ),
      envInfo
        ? h(
            'div',
            { style: { fontSize: 12, opacity: 0.85, marginBottom: 12, lineHeight: 1.7 } },
            h('div', null, `${t('envPlatformLabel')}：${envInfo.platform} ${envInfo.arch}`),
            h('div', null, `${t('envGpuLabel')}：${envInfo.gpu?.available ? envInfo.gpu.name + ' (' + envInfo.gpu.memoryMB + 'MB)' : t('envGpuNone')}`),
            // 引擎行：兼容宿主的两种行形状（{available,reason,params} / 新 sovits 行
            // {supported, url, configured}），字段缺失不崩（审计 F10）。
            // 行名按 `id` 查字典、状态句按 `reason` 查字典（批次 22-3-2，§8.67）：
            // 宿主 `detail` 里那句中文原文不上界面，只有 sovits 的服务地址（数据）原样显示。
            ...envEngines.map((e) => h(
              'div',
              { key: e.id, style: { opacity: e.current ? 1 : 0.85 } },
              `${e.status === 'ok' ? '✓' : e.status === 'bad' ? '✗' : '·'} ${envEngineLabel(e.id, t)}${e.current ? `（${t('envCurrent')}）` : ''}${e.reason ? '：' + ttsEnvReasonText(e.reason, t, e.params) : e.detail ? '：' + e.detail : ''}`,
            )),
          )
        : null,
      // 模型下载列表（ASR + TTS）
      h(
        'div',
        { style: { padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))', borderRadius: 8 } },
        ...[
          { key: 'asr', title: t('modelGroupAsr'), list: asrModels },
          { key: 'tts', title: t('modelGroupTts'), list: ttsModels },
        ].map((group) => h(
          'div',
          { key: group.key, style: { marginBottom: 8 } },
          h('div', { style: { fontSize: 12, opacity: 0.65, marginBottom: 4 } }, group.title),
          group.list.length
            ? group.list.map((m) => h(
                'div',
                { key: m.id, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 5 } },
                h('span', { style: { flex: '1 1 auto' } }, modelLabel(m.id, t)),
                h(
                  'span',
                  { style: { opacity: 0.7, minWidth: 62, textAlign: 'right' } },
                  m.ready ? t('neuralReady')
                    : m.downloading
                      ? m.total
                        ? `${t('neuralDownloading')} ${Math.round(((m.received ?? 0) / m.total) * 100)}%`
                        : t('neuralDownloading')
                      : m.ready && m.host ? t('modelBuiltIn')
                        : `${Math.round((m.bytes ?? 0) / 1048576)}MB`,
                ),
                // 当前正在用的模型：一眼看出在用哪个。
                // 合成模型只有在「引擎=神经模型」时才算在用 ——
                // 用在线/系统语音时，神经模型根本没被调用，不能标成当前使用。
                (m.category === 'asr' && m.id === config.model)
                  || (m.category === 'tts'
                    && engine === 'neural'
                    && m.id === (readyNeural.some((x) => x.id === config.neuralModel)
                      ? config.neuralModel
                      : readyNeural[0]?.id))
                  ? h(
                      'span',
                      { style: { fontSize: 11, opacity: 0.75, minWidth: 46, textAlign: 'right' } },
                      t('modelInUse'),
                    )
                  : null,
                m.ready
                  ? h('span', { style: { color: 'var(--dsw-alias-state-success, #107c10)', minWidth: 16, textAlign: 'center' } }, '✓')
                  : h(
                      'button',
                      {
                        type: 'button',
                        disabled: m.downloading,
                        onClick: () => void download(m.id),
                        style: {
                          padding: '3px 9px',
                          borderRadius: 6,
                          border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
                          background: 'transparent',
                          color: 'inherit',
                          fontSize: 12,
                          cursor: m.downloading ? 'default' : 'pointer',
                          opacity: m.downloading ? 0.5 : 1,
                        },
                      },
                      m.downloading ? t('neuralDownloading') : t('neuralDownload'),
                    ),
              ))
            : h('span', { style: { fontSize: 12, opacity: 0.7 } }, '—'),
        )),
        progress
          ? h(
              'div',
              { style: { fontSize: 12, opacity: 0.8, marginTop: 6 } },
              `${t('neuralDownloading')} ${Math.round(((progress.received ?? 0) / Math.max(1, progress.total ?? 1)) * 100)}%`,
            )
          : null,
      ),
    ),

    /* ============ 六、高级与诊断（默认收起） ============ */
    h(
      Section,
      { title: t('secAdvanced'), subtitle: t('secAdvancedHint'), collapsible: true, defaultOpen: false },
      /* ---- AI 界面操控与系统级热键（默认都关，属于高级能力） ---- */
      h(
        Toggle,
        {
          label: t('uiControl'),
          hint: t('uiControlHint'),
          checked: config.uiControl === true,
          onChange: (v) => set('uiControl', v),
        },
      ),
      h(
        Toggle,
        {
          label: t('uiConfirm'),
          hint: t('uiConfirmHint'),
          checked: config.uiConfirm !== false,
          onChange: (v) => set('uiConfirm', v),
        },
      ),
      h(
        Toggle,
        {
          label: t('globalHotkeyHelper'),
          hint: t('globalHotkeyHelperHint'),
          checked: config.globalHotkeyHelper === true,
          onChange: (v) => set('globalHotkeyHelper', v),
        },
      ),
      /* ---- 系统级热键只读状态（不提交、不参与保存）---- */
      h(
        'div',
        {
          style: {
            fontSize: 12,
            opacity: 0.85,
            lineHeight: 1.7,
            marginTop: 10,
            marginBottom: 12,
            padding: '8px 10px',
            border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
            borderRadius: 8,
          },
        },
        h('div', { style: { fontWeight: 600, marginBottom: 2 } }, t('hotkeyStatusTitle')),
        h('div', null, `${t('hotkeyStatusLabel')}：${hotkeyStatusText}`),
        h('div', null, `${t('hotkeyStatusPlatform')}：${hotkeyPlatformText}`),
        hotkeyStatusReasonText
          ? h('div', { style: { opacity: 0.8 } }, `${t('hotkeyStatusReason')}：${hotkeyStatusReasonText}`)
          : null,
        hotkeyNeedsOverlay
          ? h(
              'div',
              { style: { color: 'var(--dsw-alias-state-warning, #9a6700)', marginTop: 2 } },
              t('hotkeyStatusNeedsOverlay'),
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            onClick: () => void loadHotkeyStatus(),
            style: {
              marginTop: 4,
              padding: '3px 10px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
              background: 'transparent',
              color: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
            },
          },
          t('hotkeyStatusRefresh'),
        ),
      ),
      h(
        'div',
        { style: { fontSize: 12, opacity: 0.8, lineHeight: 1.7 } },
        h('div', { style: { fontWeight: 600, marginBottom: 2 } }, t('advancedDiagnostics')),
        h('div', null, t('advancedDiagnosticsHint')),
      ),
      h(
        'div',
        { style: { fontSize: 12, opacity: 0.8, lineHeight: 1.7, marginTop: 8 } },
        h('div', { style: { fontWeight: 600, marginBottom: 2 } }, t('advancedDebug')),
        h('div', null, t('advancedDebugHint')),
      ),
    ),

    /* ============ 保存栏 ============ */
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        h(
          'button',
          {
            type: 'button',
            onClick: () => void save(),
            // 加载完成前禁止保存：此时表单里还是默认值，
            // 一点保存就会把用户已有的设置（比如「朗读回复」）覆盖掉。
            // 快捷键非法时也禁止保存（旧实现只显示红字，保存后热键静默失效）。
            disabled: saveDisabled,
            style: {
              padding: '7px 16px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
              background: 'transparent',
              color: 'inherit',
              fontSize: 13,
              cursor: saveDisabled ? 'default' : 'pointer',
              opacity: saveDisabled ? 0.5 : 1,
            },
          },
          t('save'),
        ),
        // 加载失败：不放开保存（否则旧快照会覆盖服务端配置），给重试按钮。
        loadError
          ? h(
              'button',
              {
                type: 'button',
                onClick: () => { setLoadError(''); void reload() },
                style: {
                  padding: '5px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                },
              },
              t('retry'),
            )
          : null,
        !loaded
          ? h('span', { style: { fontSize: 12, opacity: 0.75 } }, loadError || t('loadingConfig'))
          : dirty
            ? h('span', { style: { fontSize: 12, opacity: 0.75 } }, t('unsaved'))
            : null,
        status ? h('span', { style: { fontSize: 12, opacity: 0.75 } }, status) : null,
      ),
      // POST /config 校验失败的可读错误（宿主返回 400 {errors:[{key,reason}]}）。
      saveErrors.length
        ? h(
            'div',
            { style: { fontSize: 12, color: 'var(--dsw-alias-state-danger, #d13438)', lineHeight: 1.6 } },
            ...saveErrors.map((message, index) => h('div', { key: index }, message)),
          )
        : null,
    ),
  )
  }

  return SettingsPanel
}
