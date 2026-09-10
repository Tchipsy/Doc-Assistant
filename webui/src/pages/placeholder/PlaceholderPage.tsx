import { Icon } from '../../lib/icons'
import type { PageId } from '../../api/types'

const TITLES: Record<string, { icon: string; title: string; desc: string }> = {
  stats: { icon: 'chart', title: '统计', desc: '知识库规模、解析用量与问答统计看板，此功能正在开发中。' },
}

export function PlaceholderPage({ page }: { page: PageId }) {
  const info = TITLES[page] ?? { icon: 'info', title: '功能开发中', desc: '' }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4" style={{ background: 'var(--bg)' }}>
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl" style={{ background: 'var(--panel-2)' }}>
        <Icon name={info.icon} size={32} className="t3" />
      </div>
      <div className="text-[17px] font-semibold t1">{info.title}</div>
      <div className="max-w-[360px] text-center text-[12.5px] leading-relaxed t3">{info.desc}</div>
      <span className="badge badge-warn">开发中</span>
    </div>
  )
}
