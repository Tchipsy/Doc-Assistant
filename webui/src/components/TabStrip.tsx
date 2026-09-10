import { useTabsStore, type Tab } from '../store/tabs'
import { openMenu } from './ContextMenu'
import { Icon } from '../lib/icons'
import { cx } from '../lib/utils'

const EMPTY_TABS: Tab[] = []

/**
 * 顶部标签条（9.5 步骤8）：标题 + 关闭按钮 + 激活态；右键 关闭/关闭其他。
 * 点击切换 = activate = 导航到该标签当前路由（pushState，后退可回溯视图）。
 * debug5：设置/统计同为普通标签，随 tabs 列表照常显示（App 壳层不再有整页覆盖特例）。
 */
export function TabStrip() {
  // EMPTY_TABS 模块级常量兜底（zustand v5 selector 稳定引用铁律）
  const tabs = useTabsStore(s => s.tabs) ?? EMPTY_TABS
  const activeTabId = useTabsStore(s => s.activeTabId)
  const activate = useTabsStore(s => s.activate)
  const close = useTabsStore(s => s.close)
  const closeOthers = useTabsStore(s => s.closeOthers)

  const tabMenu = (e: React.MouseEvent, t: Tab) => {
    openMenu(e, [
      { label: '关闭', icon: 'x', onClick: () => close(t.id) },
      { label: '关闭其他', icon: 'x', onClick: () => closeOthers(t.id) },
    ])
  }

  return (
    <div
      className="flex h-[34px] shrink-0 items-end gap-1 border-b border-line px-2 pt-1.5"
      style={{ background: 'var(--panel-2)' }}
    >
      {tabs.map(t => {
        const active = t.id === activeTabId
        return (
          <div
            key={t.id}
            className={cx(
              'tab',
              active ? 'tab-active' : 't2 hover:t1',
            )}
            onClick={() => { if (!active) activate(t.id) }}
            onContextMenu={e => tabMenu(e, t)}
            title={t.title}
          >
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <button
              className="tab-close"
              title="关闭标签"
              onClick={e => { e.stopPropagation(); close(t.id) }}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
