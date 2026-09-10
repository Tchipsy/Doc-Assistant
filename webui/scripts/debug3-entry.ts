/** debug3（步骤3 后端状态与导出）单测入口：打包真实源码——
 * StatusBadge（queued 徽章映射，SSR 渲染断言）/ kb store（genQueued 退役后的
 * store 形态）/ live store（title 节点 insert/update 流式接线）。与
 * debug3-test.mjs 配对（参照 debug1/debug2 模式）。 */
export { StatusBadge } from '../src/pages/main/DocColumn'
export { useKbStore } from '../src/store/kb'
export { useLiveStore } from '../src/store/live'
