/** debug2（步骤2 预览渲染与交互修复）单测入口：打包真实源码——
 * markdown 渲染快照（图片居中的 DOM 前提）/ firstVisible+attachCiteFlip（utils）/
 * hoverPreviewPos（HoverPreview 定位翻转）/ boxState（折叠记忆读写节流）/
 * live store（boxOpen 回填/toggleBox 写入/setExpandAll 写穿）/ findAnchorNode（#12
 * 用户实例锚点）。共享实例：与 debug2-test.mjs 配对（参照 debug1 模式）。 */
export { renderMarkdown, RENDERER_VERSION } from '../src/lib/markdown'
export { firstVisible, attachCiteFlip, clamp } from '../src/lib/utils'
export { hoverPreviewPos } from '../src/components/HoverPreview'
export { getBoxState, setBox, flushBoxState, BOXSTATE_PREFIX, BOXSTATE_THROTTLE_MS } from '../src/lib/boxState'
export { useLiveStore } from '../src/store/live'
export { findAnchorNode } from '../src/components/LiveView'
export { parseHashFull } from '../src/lib/router'
