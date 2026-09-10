import { useEffect, useMemo, useState } from 'react'
import { useKbStore } from '../../store/kb'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { api } from '../../api/client'
import {
  GenConfigFields, IndexConfigFields, defaultGenConfig, defaultIndexConfig,
  resolveDocConfigs,
} from '../../components/GenConfig'
import { Icon } from '../../lib/icons'
import { apiErr } from '../../lib/utils'
import type { DocType, GenConfig, IndexConfig } from '../../api/types'

const DOC_TYPE_LABELS: Record<DocType, string> = { doc: '文档类', web: '网页类' }

/** 单页签配置体：显示配置 + 入库配置（与 BottomBar 展开态同字段） */
function ConfigFields({ gen, idx, onGen, onIdx, docType }: {
  gen: GenConfig
  idx: IndexConfig
  onGen: (v: GenConfig) => void
  onIdx: (v: IndexConfig) => void
  docType: DocType
}) {
  return (
    <>
      <div className="label mb-2">文档显示配置</div>
      <GenConfigFields value={gen} onChange={onGen} docType={docType} />
      <div className="my-3 border-t border-line" />
      <IndexConfigFields value={idx} onChange={onIdx} />
    </>
  )
}

/**
 * 统一"修改配置"窗口（步骤11）：显示配置（上）+ 是否入库/入库配置（下）。
 * 开始 = 应用两份配置并总是执行流水线（pass1/pass2/入库按指纹跳过未变化步骤）。
 * - ids.length === 1：应用到当前文档；整理预设下拉按该文档 docType 过滤分组
 * - ids.length > 1 且所选文档类型单一：同上（按该类型过滤）
 * - ids.length > 1 且混合类型：自动切换为「文档类/网页类」双页签——保存时按各文档
 *   的 docType 写入对应页签的配置
 * 继承中的文档（genConfig={}）：回显=生效配置并标注"继承自知识库"；保存后变为显式。
 */
export function ConfigModal({ ids, onClose }: {
  ids: string[]
  onClose: () => void
}) {
  const docsByKb = useKbStore(s => s.docsByKb)
  const allDocs = useMemo(
    () => Object.values(docsByKb).flat(),
    [docsByKb],
  )
  const batch = ids.length > 1
  const targets = allDocs.filter(d => ids.includes(d.id))
  const title = batch ? `批量修改配置（${ids.length} 个文档）` : '修改配置'

  // 步骤11：所选文档的 docType 集合——单一类型=现状 UI；混合=双页签
  const docTypes = useMemo(
    () => [...new Set(targets.map(d => (d.docType ?? 'doc') as DocType))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const mixed = batch && docTypes.length > 1
  const singleType: DocType = docTypes[0] ?? 'doc'
  const first = allDocs.find(d => d.id === ids[0])

  // 初始草稿：显式文档用自身配置；继承中的文档用生效配置（库默认）并标注继承
  const initial = useMemo(() => {
    const r = first ? resolveDocConfigs(first) : null
    return {
      gen: r?.gen ?? defaultGenConfig(singleType),
      idx: r?.idx ?? defaultIndexConfig(),
      genInherited: r?.genInherited ?? false,
      idxInherited: r?.idxInherited ?? false,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 混合类型：每个类型一份草稿（初始值取该类型第一个文档的生效配置，无文档用默认）
  const initialByType = useMemo(() => {
    const gen = {} as Record<DocType, GenConfig>
    const idx = {} as Record<DocType, IndexConfig>
    for (const t of docTypes) {
      const d0 = targets.find(d => (d.docType ?? 'doc') === t)
      const r = d0 ? resolveDocConfigs(d0) : null
      gen[t] = r?.gen ?? defaultGenConfig(t)
      idx[t] = r?.idx ?? defaultIndexConfig()
    }
    return { gen, idx }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [tab, setTab] = useState<DocType>(singleType)
  const [draftGen, setDraftGen] = useState<GenConfig>(initial.gen)
  const [draftIdx, setDraftIdx] = useState<IndexConfig>(initial.idx)
  const [genByType, setGenByType] = useState<Record<DocType, GenConfig>>(initialByType.gen)
  const [idxByType, setIdxByType] = useState<Record<DocType, IndexConfig>>(initialByType.idx)
  const [running, setRunning] = useState(false)

  const typeOf = (d: { docType?: DocType }): DocType => d.docType ?? 'doc'
  const idsOfType = (t: DocType) => targets.filter(d => typeOf(d) === t).map(d => d.id)

  const start = async () => {
    const store = useKbStore.getState()
    setRunning(true)
    try {
      if (mixed) {
        // 混合类型：按各文档的 docType 写对应页签配置
        for (const t of docTypes) {
          const group = idsOfType(t)
          if (!group.length) continue
          await store.applyGenConfig(group, genByType[t])
          await store.applyIndexConfig(group, idxByType[t])
        }
      } else {
        await store.applyGenConfig(ids, draftGen)
        await store.applyIndexConfig(ids, draftIdx)
      }
      await store.startGeneration(ids)
      toast(batch ? `已应用配置并开始执行（${ids.length} 个文档）` : `已应用配置并开始执行：${targets[0]?.name ?? ''}`)
      onClose()
    } catch (e: any) {
      toast(`执行失败：${e?.message ?? e}`, 'error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Modal
      title={title}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={running} onClick={start}>
            <Icon name="zap" size={14} />
            {running ? '执行中…' : '开始'}
          </button>
        </>
      }
    >
      <div className="mb-3 rounded-[9px] border border-line px-3 py-2 text-[12.5px]" style={{ background: 'var(--panel-2)' }}>
        {batch ? (
          <span className="t2">
            将应用到选中的 <b style={{ color: 'var(--primary)' }}>{ids.length}</b> 个文档：
            <span className="t3"> {targets.slice(0, 3).map(d => d.name).join('、')}{targets.length > 3 ? ' 等' : ''}</span>
          </span>
        ) : (
          <span className="t2">当前文档：<b style={{ color: 'var(--primary)' }}>{targets[0]?.name ?? '未知'}</b></span>
        )}
        {!mixed && (initial.genInherited || initial.idxInherited) && (
          <span className="badge badge-primary" style={{ fontSize: 10.5, marginLeft: 8 }}>
            继承自知识库
          </span>
        )}
        {!mixed && (initial.genInherited || initial.idxInherited) && (
          <span className="t3" style={{ marginLeft: 6 }}>保存后变为本文档显式配置</span>
        )}
      </div>

      {mixed ? (
        <>
          <div className="mb-3 rounded-[9px] border border-line px-3 py-2 text-[12.5px] t2" style={{ background: 'var(--panel-2)' }}>
            所选文档包含两类：<b>{DOC_TYPE_LABELS.doc} {idsOfType('doc').length}</b> 个、
            <b>{DOC_TYPE_LABELS.web} {idsOfType('web').length}</b> 个——
            保存时按各文档类型应用对应页签的配置。
          </div>
          <div className="mb-3 flex gap-1">
            {docTypes.map(t => (
              <button
                key={t}
                className={`btn btn-sm ${tab === t ? 'btn-primary' : ''}`}
                onClick={() => setTab(t)}
              >
                {DOC_TYPE_LABELS[t]}（{idsOfType(t).length}）
              </button>
            ))}
          </div>
          <ConfigFields
            docType={tab}
            gen={genByType[tab]}
            idx={idxByType[tab]}
            onGen={v => setGenByType(s => ({ ...s, [tab]: v }))}
            onIdx={v => setIdxByType(s => ({ ...s, [tab]: v }))}
          />
        </>
      ) : (
        <ConfigFields
          docType={singleType}
          gen={draftGen}
          idx={draftIdx}
          onGen={setDraftGen}
          onIdx={setDraftIdx}
        />
      )}
    </Modal>
  )
}

/**
 * 知识库默认配置窗口（步骤11 mode='kb'）：双页签「文档类/网页类」各自一套
 * 显示配置 + 入库配置（整理预设下拉分别只列 group='doc'/'web' 的预设）。
 * 「保存」= PUT /api/knowledge-bases/{id}/config，**只保存不触发生成**——
 * 新建/继承中的文档在下次生成时按类型继承此默认（指纹判定照常生效）。
 */
export function KbConfigModal({ kbId, kbName, onClose }: {
  kbId: string
  kbName: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<DocType>('doc')
  const [loading, setLoading] = useState(true)
  const [genByType, setGenByType] = useState<Record<DocType, GenConfig>>({
    doc: defaultGenConfig('doc'), web: defaultGenConfig('web'),
  })
  const [idxByType, setIdxByType] = useState<Record<DocType, IndexConfig>>({
    doc: defaultIndexConfig(), web: defaultIndexConfig(),
  })
  const [running, setRunning] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const cfg = await api.getKbConfig(kbId)
      setGenByType({
        doc: { ...defaultGenConfig('doc'), ...(cfg.genConfig?.doc ?? {}) },
        web: { ...defaultGenConfig('web'), ...(cfg.genConfig?.web ?? {}) },
      })
      setIdxByType({
        doc: { ...defaultIndexConfig(), ...(cfg.indexConfig?.doc ?? {}) },
        web: { ...defaultIndexConfig(), ...(cfg.indexConfig?.web ?? {}) },
      })
    } catch (e: any) {
      toast(`读取配置失败：${apiErr(e)}`, 'error')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [kbId])   // 打开时拉一次（弹窗随挂载/卸载）

  const save = async () => {
    setRunning(true)
    try {
      await useKbStore.getState().saveKbConfig(kbId, {
        genConfig: genByType, indexConfig: idxByType,
      })
      toast('知识库默认配置已保存（不触发生成，继承中的文档下次生成时生效）')
      onClose()
    } catch (e: any) {
      toast(`保存失败：${apiErr(e)}`, 'error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Modal
      title={`知识库默认配置：${kbName}`}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={loading || running} onClick={save}>
            <Icon name="check" size={14} />
            {running ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="mb-3 rounded-[9px] border border-line px-3 py-2 text-[12.5px] t2" style={{ background: 'var(--panel-2)' }}>
        本库<strong>{DOC_TYPE_LABELS[tab]}</strong>文档的默认配置：文档未显式保存过配置时按
        其类型继承这里的设置（显示配置回显处会标注「继承自知识库」）；保存不触发生成。
      </div>
      <div className="mb-3 flex gap-1">
        {(['doc', 'web'] as DocType[]).map(t => (
          <button
            key={t}
            className={`btn btn-sm ${tab === t ? 'btn-primary' : ''}`}
            onClick={() => setTab(t)}
          >
            {DOC_TYPE_LABELS[t]}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="py-10 text-center text-[13px] t3">加载配置…</div>
      ) : (
        <ConfigFields
          docType={tab}
          gen={genByType[tab]}
          idx={idxByType[tab]}
          onGen={v => setGenByType(s => ({ ...s, [tab]: v }))}
          onIdx={v => setIdxByType(s => ({ ...s, [tab]: v }))}
        />
      )}
    </Modal>
  )
}
