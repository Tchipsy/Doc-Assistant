/** 步骤8 单测入口：把 tabs store 与 router/scrollMemo/其他 store 打进同一 bundle（共享实例） */
export * from '../src/lib/router'
export * from '../src/lib/scrollMemo'
export { useKbStore } from '../src/store/kb'
export { useChatStore } from '../src/store/chat'
export { useAppStore } from '../src/store/app'
export { useLiveStore } from '../src/store/live'
export { useTabsStore, routeKind, markHistoryNav, consumeHistoryNav } from '../src/store/tabs'
export { useToast } from '../src/components/Toast'
