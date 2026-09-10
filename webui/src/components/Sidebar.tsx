import { useAppStore } from '../store/app'
import { useTabsStore } from '../store/tabs'
import { Icon } from '../lib/icons'
import { cx } from '../lib/utils'
import type { PageId } from '../api/types'

const NAV: Array<{ id: PageId; icon: string; label: string; placeholder?: boolean }> = [
  { id: 'main', icon: 'layout', label: '主界面' },
  { id: 'assistant', icon: 'message', label: '助手' },
  { id: 'settings', icon: 'settings', label: '设置' },
  // 「网络搜索」占位项已移除（9.5 步骤4：功能落地为设置页分区 + 助手/生成工具联网）
  { id: 'stats', icon: 'chart', label: '统计', placeholder: true },
]

export function Sidebar() {
  const page = useAppStore(s => s.page)
  const setPage = useAppStore(s => s.setPage)
  const theme = useAppStore(s => s.theme)
  const toggleTheme = useAppStore(s => s.toggleTheme)

  // 9.5 步骤8：主界面/助手 = 激活最近的知识库/会话类标签；debug5：设置/统计同为标签
  // 路由，同语义（激活最近同类标签；没有同类标签才走默认导航 → navigate 新建）
  const nav = (id: PageId) => {
    if (id === 'main' && useTabsStore.getState().activateRecent('kb')) return
    if (id === 'assistant' && useTabsStore.getState().activateRecent('chat')) return
    if (id === 'settings' && useTabsStore.getState().activateRecent('settings')) return
    if (id === 'stats' && useTabsStore.getState().activateRecent('stats')) return
    setPage(id)
  }

  return (
    <aside
      className="flex h-full w-[68px] shrink-0 flex-col items-center border-r border-line py-3"
      style={{ background: 'var(--panel)' }}
    >
      <div
        className="mb-4 flex h-10 w-10 items-center justify-center rounded-[12px] shadow-sm"
        style={{ background: 'var(--primary)' }}
        title="文档助手"
      >
        <Icon name="doc" size={22} className="text-white" />
      </div>

      <nav className="flex flex-1 flex-col items-center gap-1.5">
        {NAV.map(item => {
          const active = page === item.id
          return (
            <button
              key={item.id}
              className={cx(
                'group relative flex w-[56px] flex-col items-center gap-1 rounded-[10px] py-2 text-[11px] transition-colors',
                active ? 'font-medium' : 't2 hover:t1',
              )}
              style={{
                background: active ? 'var(--active-soft)' : 'transparent',
                color: active ? 'var(--primary)' : undefined,
              }}
              onClick={() => nav(item.id)}
              title={item.placeholder ? `${item.label}（开发中）` : item.label}
            >
              <Icon name={item.icon} size={19} />
              <span>{item.label}</span>
              {item.placeholder && (
                <span
                  className="absolute right-2.5 top-2 h-1.5 w-1.5 rounded-full"
                  style={{ background: 'var(--warn)' }}
                />
              )}
            </button>
          )
        })}
      </nav>

      <button
        className="btn btn-ghost btn-icon mt-2"
        onClick={toggleTheme}
        title={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'}
      >
        <Icon name={theme === 'light' ? 'moon' : 'sun'} size={18} />
      </button>
    </aside>
  )
}
