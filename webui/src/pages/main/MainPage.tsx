import { useState } from 'react'
import { useKbStore } from '../../store/kb'
import type { DocumentItem } from '../../api/types'
import { KbColumn } from './KbColumn'
import { DocColumn } from './DocColumn'
import { PreviewMain } from './PreviewMain'
import { BottomBar } from './BottomBar'
import { RightPanel } from './RightPanel'
import { ConfigModal, KbConfigModal } from './ConfigModal'
import { ExportModal } from './ExportModal'

export function MainPage({ active = true }: { active?: boolean }) {
  const activeKbId = useKbStore(s => s.activeKbId)
  const activeDocId = useKbStore(s => s.activeDocId)
  const kbs = useKbStore(s => s.kbs)
  const docs = useKbStore(s => (activeKbId ? s.docsByKb[activeKbId] : undefined)) ?? []
  const activeDoc: DocumentItem | undefined = docs.find(d => d.id === activeDocId)

  const [configTargets, setConfigTargets] = useState<{ ids: string[] } | null>(null)
  const [exportTargets, setExportTargets] = useState<{ ids: string[]; kind: 'md' | 'pdf' } | null>(null)
  /** 知识库默认配置窗口（步骤11：右键知识库「修改配置」） */
  const [kbConfigTarget, setKbConfigTarget] = useState<string | null>(null)
  /** 本标签 PreviewMain 的滚动根实例（9.6）：经 props 传给 RightPanel，
   *  useSyncScroll 绑定实例而非全局 querySelector（多标签错根修复） */
  const [liveScrollRoot, setLiveScrollRoot] = useState<HTMLElement | null>(null)

  return (
    <div className="flex h-full">
      <KbColumn openKbConfig={id => setKbConfigTarget(id)} />
      <DocColumn
        openConfig={(ids) => setConfigTargets({ ids })}
        openExport={(ids, kind) => setExportTargets({ ids, kind })}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PreviewMain
          active={active}
          openConfig={(ids) => setConfigTargets({ ids })}
          openExport={(ids, kind) => setExportTargets({ ids, kind })}
          onScrollRootChange={setLiveScrollRoot}
        />
        {/* debug4 #3：fetching（链接导入抓取中）无产物，与 pending/parsing 同样隐藏底边栏 */}
        {activeDoc && activeDoc.status !== 'pending' && activeDoc.status !== 'parsing'
          && activeDoc.status !== 'fetching' && (
          <BottomBar doc={activeDoc} />
        )}
      </div>

      <RightPanel doc={activeDoc} active={active} liveScrollRoot={liveScrollRoot} />

      {configTargets && (
        <ConfigModal
          ids={configTargets.ids}
          onClose={() => setConfigTargets(null)}
        />
      )}
      {exportTargets && (
        <ExportModal
          ids={exportTargets.ids}
          kind={exportTargets.kind}
          onClose={() => setExportTargets(null)}
        />
      )}
      {kbConfigTarget && (
        <KbConfigModal
          kbId={kbConfigTarget}
          kbName={kbs.find(k => k.id === kbConfigTarget)?.name ?? ''}
          onClose={() => setKbConfigTarget(null)}
        />
      )}
    </div>
  )
}
