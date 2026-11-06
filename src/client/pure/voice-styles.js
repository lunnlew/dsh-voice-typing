/**
 * 全局语音浮层样式常量（纯数据，零环境依赖）。
 *
 * 为什么单独成文件：
 *   - 样式对象被 GlobalVoiceOverlay 组件多处引用
 *   - 提取组件时需要通过工厂参数传递，签名会很大
 *   - 收成独立文件后，组件可以直接 import，工厂签名简化
 *
 * 分类：
 *   - GLOBAL_OVERLAY_WRAPPER_STYLE: 浮层容器（fixed 定位，右下角，pointer-events 穿透）
 *   - GLOBAL_OVERLAY_CARD_STYLE: 卡片本身（可点击，主题色背景，圆角胶囊）
 *   - GLOBAL_OVERLAY_ACTION_STYLE: 操作按钮（透明背景，边框，hover 效果）
 */

// 浮层容器：底部右侧常驻，只有卡片本身接收鼠标事件
export const GLOBAL_OVERLAY_WRAPPER_STYLE = {
  position: 'fixed',
  right: 16,
  bottom: 16,
  zIndex: 900,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 8,
  // shell.overlay 是挂在 AppFrame 上的独立层，不一定继承正文字色；
  // 这里显式给一个主题文字色，避免浅色主题下继承到黑色（黑底黑字看不见）。
  color: 'var(--dsw-alias-label-primary, currentColor)',
  // 外层穿透：浮层覆盖在任意页面上，不能挡住底下的按钮/输入框。
  pointerEvents: 'none',
}

// 卡片样式：可点击，主题色背景，圆角胶囊
export const GLOBAL_OVERLAY_CARD_STYLE = {
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  maxWidth: 360,
  padding: '7px 10px',
  borderRadius: 999,
  border: '1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.14))',
  // 用真实存在的主题表面色（bg-base 深浅主题都有定义）。
  // 以前用的 bg-l2 在 0.2.1-rc.5 的 token 里不存在，回退成了深色底，
  // 而浅色主题的 label-primary 是黑色 → 黑底黑字，识别文本完全看不见。
  background: 'var(--dsw-alias-bg-base, #1c1c20)',
  color: 'var(--dsw-alias-label-primary, currentColor)',
  boxShadow: '0 4px 18px rgba(0, 0, 0, 0.22)',
  fontSize: 12,
  lineHeight: 1.4,
}

// 操作按钮样式：透明背景，边框，继承文字色
export const GLOBAL_OVERLAY_ACTION_STYLE = {
  padding: '4px 12px',
  borderRadius: 999,
  border: '1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.18))',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}
