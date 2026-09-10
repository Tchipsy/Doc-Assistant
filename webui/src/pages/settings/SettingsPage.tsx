import { useEffect, useState } from 'react'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/utils'
import { navigate, onRouteChange, parseHashFull } from '../../lib/router'
import { useColumnWidth } from '../../hooks/useResize'
import { ProvidersSection } from './ProvidersSection'
import { DefaultsSection } from './DefaultsSection'
import { ParsingSection } from './ParsingSection'
import { WebSearchSection } from './WebSearchSection'
import { TextItemList } from './TextItemList'
import { ContentGenList } from './ContentGenList'
import { isSettingsSection, type SectionId } from './sections'

const NAV: Array<{ id: SectionId; icon: string; label: string }> = [
  { id: 'providers', icon: 'server', label: '模型服务' },
  { id: 'defaults', icon: 'cpu', label: '默认模型' },
  { id: 'parsing', icon: 'fileText', label: '文档解析' },
  { id: 'websearch', icon: 'globe', label: '网络搜索' },
  { id: 'presets', icon: 'sliders', label: '文档整理' },
  { id: 'plugins', icon: 'plug', label: '内容生成' },
]

const isSection = isSettingsSection

export function SettingsPage() {
  // 分区路由化（9.5 步骤7）：#/settings/{section}；初始取 URL，切换写 URL（pushState）
  const [section, setSection] = useState<SectionId>(() => {
    const { route } = parseHashFull()
    return route?.view === 'settings' && isSection(route.section) ? route.section : 'providers'
  })
  // 浏览器后退/前进回同步分区
  useEffect(() => onRouteChange(r => {
    if (r?.view === 'settings' && isSection(r.section)) setSection(r.section)
  }), [])
  const switchSection = (s: SectionId) => {
    setSection(s)
    navigate({ view: 'settings', section: s })
  }
  const { width, onHandleDown } = useColumnWidth({
    initial: 212, min: 160, max: 340, storageKey: 'col-settings', side: 'right',
  })

  return (
    <div className="flex h-full" style={{ background: 'var(--bg)' }}>
      <div
        className="relative shrink-0 border-r border-line px-2 py-3"
        style={{ background: 'var(--panel)', width }}
      >
        <div
          className="absolute right-[-2.5px] top-0 z-10 h-full w-[5px] cursor-col-resize hover:bg-[var(--primary-soft)]"
          style={{ touchAction: 'none' }}
          onPointerDown={onHandleDown}
        />
        <div className="mb-2 px-3 pt-1 text-[15px] font-semibold t1">设置</div>
        {NAV.map(n => (
          <button
            key={n.id}
            className={cx(
              'mb-0.5 flex w-full items-center gap-2.5 rounded-[9px] px-3 py-2.5 text-left text-[13px] transition-colors',
              section === n.id ? 'row-selected font-medium' : 't2 hover:bg-[var(--hover)]',
            )}
            style={section === n.id ? { color: 'var(--primary)' } : undefined}
            onClick={() => switchSection(n.id)}
          >
            <Icon name={n.icon} size={16} />
            {n.label}
          </button>
        ))}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[780px] px-7 py-6">
          {section === 'providers' && <ProvidersSection />}
          {section === 'defaults' && <DefaultsSection />}
          {section === 'parsing' && <ParsingSection />}
          {section === 'websearch' && <WebSearchSection />}
          {section === 'presets' && <TextItemList />}
          {section === 'plugins' && <ContentGenList />}
        </div>
      </div>
    </div>
  )
}
