/** 步骤7 单测入口：把 router/scrollMemo/stores 打进同一个 bundle（共享同一份 store 实例） */
export * from '../src/lib/router'
export * from '../src/lib/scrollMemo'
export { useKbStore } from '../src/store/kb'
export { useChatStore } from '../src/store/chat'
export { useAppStore } from '../src/store/app'
export { useLiveStore } from '../src/store/live'
