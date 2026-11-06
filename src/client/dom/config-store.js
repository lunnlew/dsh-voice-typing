/**
 * 配置共享存储：组件间同步配置状态的	pub/sub 机制。
 *
 * 为什么单独成文件（docs/architecture-modernization.md §5 第 4 步 · 组件提取前置）：
 *   main.js 里的 `configStore` 是一个模块级单例，被 MicButton、GlobalVoiceOverlay、
 *   VoiceSettingsSection 三个组件共享。它持有可变状态（value、loaded、listeners），
 *   组件通过 subscribe/set 方法同步配置变化。
 *   拆出去之后它能被 Node 单测直接驱动（test/config-store.test.mjs），
 *   也为后续 React 组件提取扫清依赖障碍。
 *
 * 和 `pure/` 的分工：`pure/` 是无状态的纯函数；这里**持有状态**（配置值、订阅者列表、
 * 加载标志），所以住 `dom/`。环境注入方面，本模块不依赖浏览器 API，Node 可直接 import。
 *
 * @module dom/config-store
 */

/** 默认配置（空对象，真实默认值由宿主 /config 接口填充）。 */
const DEFAULT_CONFIG = {}

/**
 * 创建配置存储实例（整个客户端共用一个）。
 *
 * @param {object} [initialValue] - 初始配置值；缺省用 DEFAULT_CONFIG 的拷贝。
 * @returns {{ value: object, loaded: boolean, listeners: Set,
 *   set: Function, subscribe: Function }}
 */
export function createConfigStore(initialValue) {
  const store = {
    value: { ...(initialValue ?? DEFAULT_CONFIG) },
    listeners: new Set(),
    /**
     * 是否已经被**真实配置**填充过。
     *
     * 用来区分「共享存储里还是默认值」和「设置面板已经加载/保存过」。
     * 没有这个标志的话，麦克风按钮的那份「挂载时发出的 fetch」
     * 会在稍后回来时把用户刚保存的配置覆盖掉 ——
     * 症状是「明明取消了朗读，过一会儿朗读又回来了」。
     */
    loaded: false,
    /**
     * 更新配置并通知所有订阅者。
     * @param {object} next - 要合并的配置片段。
     */
    set(next) {
      this.value = { ...this.value, ...next }
      for (const listener of this.listeners) listener(this.value)
    },
    /**
     * 订阅配置变化。
     * @param {Function} listener - 配置变化时的回调，接收新配置值。
     * @returns {Function} 取消订阅的函数。
     */
    subscribe(listener) {
      this.listeners.add(listener)
      listener(this.value)
      return () => this.listeners.delete(listener)
    },
  }
  return store
}

/**
 * 全局配置存储单例（浏览器侧共用）。
 *
 * 为什么导出单例而不是让调用方各自 create：
 *   三个组件（MicButton / GlobalVoiceOverlay / VoiceSettingsSection）必须共享
 *   **同一个**存储实例，配置变化才能同步。单例在模块级创建，所有 import 方
 *   拿到的是同一份引用。
 */
export const configStore = createConfigStore()
