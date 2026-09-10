/** debug4（步骤4 导入与分支）单测入口：打包真实源码——
 * StatusBadge（fetching 抓取中徽章映射，SSR 渲染断言）/ chat store（branch 两态
 * includeCurrent + draftContent 草稿写入）。与 debug4-test.mjs 配对（参照 debug1/2/3 模式）。 */
export { StatusBadge } from '../src/pages/main/DocColumn'
export { useChatStore } from '../src/store/chat'
