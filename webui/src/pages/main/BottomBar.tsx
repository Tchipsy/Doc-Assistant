import { useEffect, useState } from 'react'
import { useKbStore } from '../../store/kb'
import {
  GenConfigFields, IndexConfigFields,
  genConfigSummary, indexConfigSummary,
  resolveDocConfigs,
} from '../../components/GenConfig'
import { toast } from '../../components/Toast'
import { Icon } from '../../lib/icons'
import type { DocumentItem, GenConfig, IndexConfig } from '../../api/types'

/**
 * 底边栏：收缩态一行显示两段配置摘要；展开态 = 与统一"修改配置"窗口相同的
 * 完整配置（文档显示配置 + 是否入库/入库配置），「保存并开始」与窗口"开始"
 * 同语义：应用两份配置并总是执行流水线（指纹跳过未变化步骤）。
 * 步骤11 配置继承：继承中的文档回显=生效配置（知识库默认）并标注
 * 「继承自知识库」；保存后变为本文档显式配置。整理预设下拉按 docType 过滤。
 */
export function BottomBar({ doc }: { doc: DocumentItem }) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<GenConfig>(() => resolveDocConfigs(doc).gen)
  const [draftIdx, setDraftIdx] = useState<IndexConfig>(() => resolveDocConfigs(doc).idx)
  const [inherited, setInherited] = useState(() => ({
    gen: resolveDocConfigs(doc).genInherited,
    idx: resolveDocConfigs(doc).idxInherited,
  }))

  useEffect(() => {
    const r = resolveDocConfigs(doc)
    setDraft(r.gen)
    setDraftIdx(r.idx)
    setInherited({ gen: r.genInherited, idx: r.idxInherited })
  }, [doc.id, doc.genConfig, doc.indexConfig, doc.docType])

  const save = async () => {
    const store = useKbStore.getState()
    try {
      await store.applyGenConfig([doc.id], draft)
      await store.applyIndexConfig([doc.id], draftIdx)
      await store.startGeneration([doc.id])
      toast(`已保存配置并开始执行：${doc.name}`)
      setExpanded(false)
    } catch (e: any) {
      toast(`执行失败：${e?.message ?? e}`, 'error')
    }
  }

  if (!expanded) {
    const r = resolveDocConfigs(doc)
    return (
      <div
        className="flex cursor-pointer items-center gap-2.5 border-t border-line px-4 py-2 select-none"
        style={{ background: 'var(--panel)' }}
        onClick={() => setExpanded(true)}
        title="点击展开配置面板"
      >
        <Icon name="chevronUp" size={14} className="t3" />
        <span className="shrink-0 text-[12px] font-medium t2">生成配置</span>
        <span className="min-w-0 flex-1 truncate text-[12px] t3">
          {genConfigSummary(r.gen)}{r.genInherited ? '（继承自知识库）' : ''}
        </span>
        <span className="shrink-0 text-[12px] font-medium t2">入库配置</span>
        <span className="min-w-0 flex-1 truncate text-[12px] t3">
          {indexConfigSummary(r.idx)}{r.idxInherited ? '（继承自知识库）' : ''}
        </span>
        <span className="badge badge-primary shrink-0" style={{ fontSize: 10.5 }}>当前文档</span>
      </div>
    )
  }

  return (
    <div className="anim-slide border-t border-line px-4 pb-3 pt-2.5" style={{ background: 'var(--panel)' }}>
      <div className="mb-2 flex items-center gap-2">
        <button className="btn btn-ghost btn-icon" onClick={() => setExpanded(false)}>
          <Icon name="chevronDown" size={14} className="t3" />
        </button>
        <span className="text-[13px] font-semibold t1">修改配置</span>
        <span className="truncate text-[11.5px] t3">仅应用于当前文档：{doc.name}</span>
        {(inherited.gen || inherited.idx) && (
          <span className="badge badge-primary" style={{ fontSize: 10.5 }}
            title="本文档未显式保存过配置，当前显示的是知识库默认（继承）；保存后变为本文档显式配置">
            继承自知识库
          </span>
        )}
        <div className="flex-1" />
        <span
          className="badge badge-primary"
          style={{ fontSize: 10.5 }}
          onClick={e => { e.stopPropagation(); setExpanded(false) }}
        >
          收起
        </span>
      </div>
      <div className="scroll-thin max-h-[58vh] overflow-y-auto pr-1">
        <div className="label mb-2">文档显示配置</div>
        <GenConfigFields value={draft} onChange={setDraft} docType={doc.docType} />
        <div className="my-3 border-t border-line" />
        <IndexConfigFields value={draftIdx} onChange={setDraftIdx} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button className="btn btn-primary" onClick={save}>
          <Icon name="zap" size={14} /> 保存并开始
        </button>
        <div className="flex-1" />
        <span className="text-[11.5px] t3">
          总是执行流水线（pass1/pass2/入库按指纹跳过未变化步骤），与"修改配置"窗口一致
        </span>
      </div>
    </div>
  )
}
