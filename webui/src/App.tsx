import { useCallback, useEffect } from 'react'
import { useAppStore } from './store/app'
import { useChatStore } from './store/chat'
import { useKbStore } from './store/kb'
import { useSettingsStore } from './store/settings'
import { useTabsStore, markHistoryNav, consumeHistoryNav } from './store/tabs'
import { wireLiveEvents } from './store/live'
import { initRouter, onRouteChange } from './lib/router'
import { Sidebar } from './components/Sidebar'
import { TabStrip } from './components/TabStrip'
import { TabView } from './components/TabView'
import { ContextMenuHost } from './components/ContextMenu'
import { ToastHost } from './components/Toast'
import { MainPage } from './pages/main/MainPage'
import { Icon } from './lib/icons'
import type { Tab } from './store/tabs'

const EMPTY_TABS: Tab[] = []

export default function App() {
  const appReady = useAppStore(s => s.appReady)
  const setAppReady = useAppStore(s => s.setAppReady)
  // 标签列表（EMPTY_TABS 模块级常量，selector 稳定引用）
  const tabs = useTabsStore(s => s.tabs) ?? EMPTY_TABS
  const activeTabId = useTabsStore(s => s.activeTabId)

  useEffect(() => {
    const unsubLive = wireLiveEvents()   // 全局 SSE -> 实时渲染 / 文档状态
    // 9.5 步骤8：路由 → 标签同步。路由是视图状态唯一真相；此处把每次路由变化落实到
    // 标签（精确命中激活 / 历史回溯重建 / 组件内导航同类回写 / 跨类新建）。
    // debug5：设置/统计同为普通标签路由，不再整页覆盖特例——所有可解析路由均采纳。
    // 无论路由是否可采纳都要消费历史标记，防标记滞留污染下一次组件内导航。
    const unsubTabs = onRouteChange(route => {
      const fromHistory = consumeHistoryNav()
      if (route) useTabsStore.getState().adoptRoute(route, { fromHistory })
    })
    let teardownRouter: (() => void) | undefined
    Promise.all([
      useKbStore.getState().init(),
      useChatStore.getState().init(),
      useSettingsStore.getState().init(),
    ]).finally(() => {
      // 9.5 步骤8 §5 刷新恢复三件套（按序）：
      // ① localStorage 重建标签列表（标题从 store 数据回填）；
      // ② initRouter 消费 URL：hash 匹配某标签 → 激活，无匹配 → 按路由重建新标签（深链），
      //    无 hash → 记忆路由（= 上次活跃标签）；③ 各视图滚动位置由 scrollMemo 恢复
      //    （各视图挂载/激活时自行 restoreWhenReady）。
      useTabsStore.getState().hydrate()
      markHistoryNav()   // 启动首个路由按历史回溯语义处理（深链重建标签而非回写活跃标签）
      teardownRouter = initRouter()
      setAppReady(true)
    })
    return () => { unsubLive(); unsubTabs(); teardownRouter?.() }
  }, [setAppReady])

  // TabView 路由回写入口（稳定引用，防重复订阅）；组件内导航非历史回溯
  const onTabRouteChange = useCallback((hash: string) => {
    useTabsStore.getState().adoptRoute(hash, { fromHistory: false })
  }, [])

  if (!appReady) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3" style={{ background: 'var(--bg)' }}>
        <div className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: 'var(--primary)' }}>
          <Icon name="doc" size={26} className="text-white" />
        </div>
        <div className="flex items-center gap-2 text-[13px] t2">
          <Icon name="loader" size={14} className="spin" />
          正在加载…
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden" style={{ background: 'var(--bg)' }}>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 标签壳层（标签条 + keep-alive 标签内容区；设置/统计同为普通标签视图，debug5） */}
        <div className="flex min-h-0 flex-1 flex-col">
          <TabStrip />
          {/* flex 列容器：唯一可见的标签容器经 flex-1 撑满（display:none 的不占位） */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {tabs.map(t => (
              <div
                key={t.id}
                className="min-h-0 flex-1 flex-col"
                style={{ display: t.id === activeTabId ? 'flex' : 'none' }}
              >
                <TabView route={t.route} active={t.id === activeTabId} onRouteChange={onTabRouteChange} />
              </div>
            ))}
            {/* 无标签兜底（全新环境/标签全部关闭后尚未重建路由）：按 store 激活态直渲主页 */}
            {tabs.length === 0 && <MainPage />}
          </div>
        </div>
      </div>
      <ContextMenuHost />
      <ToastHost />
    </div>
  )
}
