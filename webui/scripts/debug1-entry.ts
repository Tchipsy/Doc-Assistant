/** debug1（步骤1 流式直达渲染）单测入口：打包真实源码——
 * live store 直通渲染（applyOp）+ httpAdapter fetch 流式事件订阅（parseSseFrame/看门狗）。
 * 共享实例：与 debug1-test.mjs 配对（参照 step8/ssefix 模式）。 */
export { httpAdapter, parseSseFrame } from '../src/api/httpAdapter'
export { useLiveStore, wireLiveEvents, scheduleResync, RESYNC_DEBOUNCE_MS } from '../src/store/live'
