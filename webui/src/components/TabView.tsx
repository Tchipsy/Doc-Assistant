import { useEffect, useMemo } from 'react'
import { buildRoute, onRouteChange as subRouteChange, parseHash } from '../lib/router'
import { MainPage } from '../pages/main/MainPage'
import { AssistantPage } from '../pages/assistant/AssistantPage'
import { SettingsPage } from '../pages/settings/SettingsPage'
import { PlaceholderPage } from '../pages/placeholder/PlaceholderPage'

/**
 * 标签视图分发器（9.5 步骤8；debug5 起设置/统计同为普通标签视图）：
 *
 * - #/kb/{库id}[/{文档id}] → MainPage（知识库视图，"文档标签"就是选中文档的 kb 视图）
 * - #/chat/{会话id} → AssistantPage（会话视图）
 * - #/settings[/{分区}] → SettingsPage（分区由路由驱动：初始读 parseHash、切换 navigate、
 *   后退经 onRouteChange 回同步——SettingsPage 自带该机制，此处零 props）
 * - #/stats → PlaceholderPage（统计占位页，开发中）
 *
 * 页面组件仍以 store 的 active* 派生状态渲染（路由 syncStores 回写，单标签零回归），
 * 隐藏标签不触碰全局单例数据（live store load 门控等）由 active prop 保证。
 * 组件内部导航（点文档/切会话/切分区）= store action → router.navigate（步骤7 pushState 语义
 * 不变）→ applyRoute emit；本组件在激活态下订阅路由，把新路由经 onRouteChange 回写
 * tabs store（adoptRoute：精确激活/同类回写/新建），App 层另有兜底监听覆盖无标签场景。
 */
export function TabView({ route, active, onRouteChange }: {
  route: string
  /** 所在标签是否激活（透传给页面组件：隐藏标签不得触碰全局单例数据） */
  active: boolean
  onRouteChange?: (route: string) => void
}) {
  const parsed = useMemo(() => parseHash(route), [route])

  // 激活态下路由变化 → 回写 tabs store（计划 §3 的 onRouteChange 语义）
  useEffect(() => subRouteChange(r => {
    if (active && r) onRouteChange?.(buildRoute(r))
  }), [active, onRouteChange])

  if (!parsed) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] t3">
        无效的视图地址
      </div>
    )
  }
  if (parsed.view === 'chat') return <AssistantPage active={active} />
  if (parsed.view === 'kb') return <MainPage active={active} />
  if (parsed.view === 'settings') return <SettingsPage />
  if (parsed.view === 'stats') return <PlaceholderPage page="stats" />
  return null
}
