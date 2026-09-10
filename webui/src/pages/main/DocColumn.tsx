import { useMemo, useRef, useState } from 'react'
import { useKbStore, docsOf } from '../../store/kb'
import { openInNewTab } from '../../store/tabs'
import { buildRoute } from '../../lib/router'
import { openMenu } from '../../components/ContextMenu'
import { ConfirmModal, Modal } from '../../components/Modal'
import { Dropdown } from '../../components/Dropdown'
import { toast } from '../../components/Toast'
import { Icon } from '../../lib/icons'
import { apiErr, cx, formatBytes } from '../../lib/utils'
import { useColumnWidth } from '../../hooks/useResize'
import { useDragSort, DropIndicator, useDocDrag, DOC_DRAG_MIME } from '../../hooks/useDragSort'
import { useSettingsStore } from '../../store/settings'
import { api } from '../../api/client'
import type { DocumentItem, DocStatus } from '../../api/types'

/** 生成状态徽章：解析中 → 排队中(queued) → 生成中 → 已生成（+待生成/失败/抓取中）。
 *  debug3 3.1：queued 为后端持久状态（start_generation 置态并广播 doc.status），
 *  取代原 genQueued 前端内存标记。debug4 #3：fetching=链接导入后台抓取中（占位名
 *  文档，抓完自动改名+ready）。导出供单测渲染断言（debug3/debug4-test.mjs）。 */
export function StatusBadge({ doc }: { doc: DocumentItem }) {
  switch (doc.status) {
    case 'pending':
      return <span className="badge" style={{ fontSize: 10.5 }}>排队中</span>
    case 'parsing':
      return (
        <span className="badge badge-primary" style={{ fontSize: 10.5, gap: 5 }}>
          <Icon name="loader" size={10} className="spin" />
          解析中
        </span>
      )
    case 'fetching':
      return (
        <span className="badge badge-primary" style={{ fontSize: 10.5, gap: 5 }}>
          <Icon name="loader" size={10} className="spin" />
          抓取中
        </span>
      )
    case 'queued':
      return (
        <span className="badge badge-warn" style={{ fontSize: 10.5, gap: 5 }}>
          <Icon name="loader" size={10} className="spin" />
          排队中
        </span>
      )
    case 'ready':
      return <span className="badge" style={{ fontSize: 10.5 }}>待生成</span>
    case 'generating':
      if (doc.paused) {
        return <span className="badge badge-warn" style={{ fontSize: 10.5 }}>已暂停</span>
      }
      return (
        <span className="badge badge-warn" style={{ fontSize: 10.5, gap: 5 }}>
          <Icon name="loader" size={10} className="spin" />
          生成中
        </span>
      )
    case 'done':
      return <span className="badge badge-ok" style={{ fontSize: 10.5 }}>已生成</span>
    case 'failed':
      return <span className="badge badge-danger" style={{ fontSize: 10.5 }}>失败</span>
  }
}

/** 入库状态徽章：待入库 → 入库中 → 已入库（+入库失败）；未启用入库不显示 */
function IndexBadge({ doc }: { doc: DocumentItem }) {
  const indexProgress = useKbStore(s => s.indexProgress)
  const indexError = useKbStore(s => s.indexError)
  if (!doc.indexConfig?.enabled) return null
  if (doc.status === 'pending' || doc.status === 'parsing' || doc.status === 'fetching') return null
  if (doc.paused) {
    return <span className="badge badge-warn" style={{ fontSize: 10.5 }}>已暂停</span>
  }
  const pct = indexProgress[doc.id]
  const err = indexError[doc.id]
  if (pct !== undefined) {
    return (
      <span className="badge badge-primary" style={{ fontSize: 10.5, gap: 5 }} title={`入库进度 ${pct}%`}>
        <Icon name="loader" size={10} className="spin" />
        入库中
      </span>
    )
  }
  if (err) {
    return <span className="badge badge-danger" style={{ fontSize: 10.5 }} title={err}>入库失败</span>
  }
  if (doc.indexedAt && !doc.indexStale) {
    return <span className="badge badge-ok" style={{ fontSize: 10.5 }}>已入库</span>
  }
  return <span className="badge" style={{ fontSize: 10.5 }} title={doc.indexStale ? '内容已变化，待重新入库' : undefined}>待入库</span>
}

export function DocColumn({ openConfig, openExport }: {
  openConfig: (ids: string[]) => void
  openExport: (ids: string[], kind: 'md' | 'pdf') => void
}) {
  const activeKbId = useKbStore(s => s.activeKbId)
  const kbs = useKbStore(s => s.kbs)
  const docsByKb = useKbStore(s => s.docsByKb)
  const activeDocId = useKbStore(s => s.activeDocId)
  const docSel = useKbStore(s => s.docSel)
  const store = useKbStore
  const { width, onHandleDown } = useColumnWidth({
    initial: 268, min: 200, max: 440, storageKey: 'col-docs', side: 'right',
  })

  const listRef = useRef<HTMLDivElement>(null)
  const [delIds, setDelIds] = useState<string[] | null>(null)
  const [importing, setImporting] = useState(false)
  /** 导入弹窗（步骤11）：本地上传 / 输入链接 两页签 */
  const [importOpen, setImportOpen] = useState(false)
  /** 「移动到/复制到」弹窗（步骤10）：copy=false 移动（支持多选批量），true 复制（单选） */
  const [moveTarget, setMoveTarget] = useState<{ ids: string[]; copy: boolean } | null>(null)

  const activeKb = kbs.find(k => k.id === activeKbId)
  const docs = docsOf(docsByKb, activeKbId)
  // 步骤10：手动顺序完全优先——顺序来自后端 sort_order（store 顺序=接口顺序），
  // 移除旧 statusSortKey 自动排序（状态只作徽章，不再决定顺序）
  const dragSort = useDragSort({
    ids: docs.map(d => d.id),
    containerRef: listRef,
    dragMime: DOC_DRAG_MIME,   // 拖到知识库行 = 移动文档（KbColumn 侧 drop hint/确认）
    onReorder: ids => {
      if (activeKbId) void store.getState().reorderDocs(activeKbId, ids)
    },
    onDragStart: id => useDocDrag.getState().patch({ docId: id, sourceKbId: activeKbId, targetKbId: null }),
    onDragEnd: () => useDocDrag.getState().patch({ docId: null, sourceKbId: null, targetKbId: null }),
  })
  const { dragId, dropIndex } = dragSort
  const dragIndex = dragId ? docs.findIndex(d => d.id === dragId) : -1
  // 插入点在原位（前/后）= 无变化，不画指示线
  const noopDrop = dropIndex != null && dragIndex >= 0
    && (dropIndex === dragIndex || dropIndex === dragIndex + 1)

  /** 导入弹窗-本地上传（步骤11）：解析后返回新建文档列表；失败 toast 后返回 []。
   *  文件选择框由 ImportModal 持有（onDone 清空 input）。 */
  const onPick = async (files: FileList | null, presetId: string | null) => {
    if (!files?.length || !activeKbId) return []
    setImporting(true)
    try {
      const list = Array.from(files).filter(f => {
        const ok = /\.(pdf|md)$/i.test(f.name)
        if (!ok) toast(`跳过不支持的文件：${f.name}`, 'error')
        return ok
      })
      if (!list.length) return []
      const created = await store.getState().importFiles(list)
      // 步骤11：导入弹窗选中整理预设 → 写入新文档 gen_config.presetId（显式，覆盖继承）
      if (presetId && created.length) {
        await store.getState().applyGenConfig(created.map(d => d.id), { presetId })
      }
      toast(`已导入 ${list.length} 个文档，开始解析`)
      return created
    } catch (e: any) {
      toast(`导入失败：${apiErr(e)}`, 'error')
      return []
    } finally {
      setImporting(false)
    }
  }

  /** 右键菜单。需求9：菜单打开时异步取一次 pass1 生成标题（本地文件读，毫秒级），
   *  有标题且与当前文档名不同才显示「生成文档名」；onContextMenu 已同步 preventDefault，
   *  fetch 后再 openMenu 不会闪出浏览器默认菜单。
   *  步骤8：选中同步不走 clickDoc——右键不是导航（不写 URL/pushState），否则当前标签
   *  的路由会被顶成该文档，随后的「在新标签页打开」会被 openTab 去重到当前标签。
   *  步骤10：新增「移动到」（单选/多选批量）与「复制到」（单选）。 */
  const menuFor = async (e: React.MouseEvent, id: string) => {
    const s = store.getState()
    if (!s.docSel.includes(id)) {
      useKbStore.setState({ docSel: [id], docAnchor: id, activeDocId: id })
    }
    const sel = [...store.getState().docSel]
    const multi = sel.length > 1
    const doc = docs.find(d => d.id === id)
    let genTitle: string | null = null
    if (!multi && doc) {
      try {
        genTitle = (await api.getGeneratedTitle(id)).title ?? null
      } catch { /* 读不到按无标题处理 */ }
    }
    const canMove = kbs.length > 1
    // debug4 #3：fetching 文档无产物——禁用 修改配置/导出（生成入口在配置内），允许删除
    const hasFetching = sel.some(x => docs.find(d => d.id === x)?.status === 'fetching')
    openMenu(e, [
      ...(multi ? [] : [{
        label: '重命名', icon: 'pencil',
        onClick: () => {
          const st = store.getState()
          if (st.activeDocId !== id) st.setActiveDoc(id)   // 顶栏行内改名要求文档处于激活位
          st.startRename(id)
        },
      }]),
      ...(multi || !doc ? [] : [{
        label: '在新标签页打开', icon: 'layout',
        onClick: () => openInNewTab(buildRoute({ view: 'kb', kbId: doc.kbId, docId: id })),
      } as any]),
      ...(multi || !genTitle || genTitle === doc?.name ? [] : [{
        label: '生成文档名', icon: 'sparkles',
        onClick: () => {
          store.getState().renameDoc(id, genTitle!)
            .then(() => toast('已应用生成的文档名'))
            .catch((err: any) => toast(`改名失败：${apiErr(err)}`, 'error'))
        },
      } as any]),
      {
        label: multi ? `修改配置（${sel.length} 个文档）` : '修改配置',
        icon: 'sliders',
        disabled: hasFetching,
        onClick: () => openConfig(sel),
      },
      { separator: true, label: '', icon: '' },
      ...(canMove ? [{
        label: multi ? `移动到…（${sel.length} 个文档）` : '移动到…',
        icon: 'doc',
        onClick: () => setMoveTarget({ ids: sel, copy: false }),
      } as any] : []),
      ...(!multi ? [{
        label: '复制到…', icon: 'copy',
        onClick: () => setMoveTarget({ ids: [id], copy: true }),
      } as any] : []),
      { separator: true, label: '', icon: '' },
      {
        label: '导出为 Markdown',
        icon: 'fileText',
        disabled: hasFetching,
        onClick: () => openExport(sel, 'md'),
      },
      {
        label: '导出为 PDF',
        icon: 'download',
        disabled: hasFetching,
        onClick: () => openExport(sel, 'pdf'),
      },
      { separator: true, label: '', icon: '' },
      ...(multi ? [] : (doc?.status === 'failed') ? [{
        label: '重新解析', icon: 'refresh',
        onClick: () => { store.getState().reparseDoc(id); toast('已重新提交解析') },
      } as any] : []),
      ...(multi ? [] : (doc?.status === 'done' || doc?.status === 'failed') ? [{
        label: doc.status === 'failed' ? '重试生成' : '重新生成',
        icon: 'refresh',
        onClick: () => { store.getState().retryDoc(id); toast('已重新提交生成') },
      } as any] : []),
      ...(multi ? [] : (doc?.status === 'done') ? [{
        label: '重新入库', icon: 'database',
        onClick: () => { store.getState().reindexDoc(id); toast('已重新提交入库') },
      } as any] : []),
      ...(multi || (doc?.status === 'done' || doc?.status === 'failed') ? [{ separator: true, label: '', icon: '' } as any] : []),
      {
        label: multi ? `删除选中文档（${sel.length}）` : '删除',
        icon: 'trash', danger: true,
        onClick: () => setDelIds(sel),
      },
    ])
  }

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-r border-line"
      style={{ background: 'var(--panel)', width }}
    >
      <div className="min-w-0 px-3 pb-2 pt-3">
        <div className="mb-2 flex min-w-0 items-center gap-1.5 px-0.5">
          <Icon name="database" size={13} className="shrink-0 t3" />
          <span className="truncate text-[12.5px] font-medium t2">{activeKb?.name ?? '未选择知识库'}</span>
        </div>
        <button className="btn btn-primary w-full" disabled={!activeKbId}
          onClick={() => setImportOpen(true)}>
          <Icon name="upload" size={15} />
          导入文档
        </button>
      </div>

      <div ref={listRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        {...dragSort.containerProps}>
        {!activeKbId && (
          <div className="pt-16 text-center text-[13px] t3">请先选择左侧知识库</div>
        )}
        {activeKbId && docs.length === 0 && (
          <div className="flex flex-col items-center gap-2 pt-14 text-center">
            <Icon name="fileText" size={32} className="t3" />
            <div className="text-[13px] t3">暂无文档<br />导入 PDF / MD 开始使用</div>
          </div>
        )}
        {docs.map((doc, i) => {
          const selected = docSel.includes(doc.id)
          const active = activeDocId === doc.id
          const rp = dragSort.rowProps(doc.id, i)
          const dragging = dragId === doc.id
          return (
            <div
              key={doc.id}
              {...rp}
              className={cx(
                'group relative mb-0.5 cursor-pointer rounded-[9px] px-2 py-2 transition-colors',
                selected ? 'row-selected' : 'hover:bg-[var(--hover)]',
                active && !selected && 'bg-[var(--hover)]',
                dragging && 'opacity-40',
              )}
              onClick={e => store.getState().clickDoc(doc.id, e)}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); void menuFor(e, doc.id) }}
              title={`${doc.name}（${formatBytes(doc.size)}）`}
            >
              {/* 行间插入指示线（步骤10 拖拽排序）：dropIndex=i → 本行上缘；末尾 → 末行下缘 */}
              {!noopDrop && dropIndex === i && <DropIndicator edge="top" />}
              {!noopDrop && dropIndex === docs.length && i === docs.length - 1 && (
                <DropIndicator edge="bottom" />
              )}
              <div className="flex items-center gap-2">
                <span
                  className={cx(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-opacity',
                    selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                  )}
                  style={{
                    borderColor: selected ? 'var(--primary)' : 'var(--border-strong)',
                    background: selected ? 'var(--primary)' : 'transparent',
                  }}
                  onClick={e => {
                    e.stopPropagation()
                    store.getState().clickDoc(doc.id, { ctrlKey: true })
                  }}
                >
                  {selected && <Icon name="check" size={11} className="text-white" />}
                </span>
                {/* 网页类文档：文件图标右下角 globe 小角标（步骤11） */}
                <span className="relative shrink-0">
                  <Icon
                    name="fileText" size={15}
                    style={{ color: doc.sourceKind === 'pdf' ? '#e5636b' : '#5b9cf5' }}
                  />
                  {doc.docType === 'web' && (
                    <span
                      className="absolute -bottom-1 -right-1 flex h-[11px] w-[11px] items-center justify-center rounded-full"
                      style={{ background: 'var(--panel)', border: '1px solid var(--border-strong)' }}
                      title="网页类文档（链接导入）"
                    >
                      <Icon name="globe" size={7} style={{ color: '#5b9cf5' }} />
                    </span>
                  )}
                </span>
                <span className={cx('min-w-0 flex-1 truncate text-[13px]', active && 'font-medium')}>{doc.name}</span>
                {/* 生成/入库中：悬停显示暂停按钮；暂停后常显为"继续" */}
                {(doc.status === 'generating' || doc.paused) && (
                  <button
                    className={cx(
                      'shrink-0 inline-flex h-5 w-5 items-center justify-center rounded-md transition-opacity hover:bg-[var(--hover)]',
                      doc.paused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                    )}
                    title={doc.paused ? '继续' : '暂停'}
                    onClick={e => {
                      e.stopPropagation()
                      const s = store.getState()
                      const toPause = !doc.paused
                      ;(toPause ? s.pauseDoc(doc.id) : s.resumeDoc(doc.id))
                        .catch(() => toast(toPause ? '暂停失败' : '继续失败', 'error'))
                    }}
                  >
                    <Icon name={doc.paused ? 'play' : 'pause'} size={12} />
                  </button>
                )}
              </div>
              {/* 双状态框：生成（上/前）+ 入库（未启用入库时不显示） */}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
                <StatusBadge doc={doc} />
                <IndexBadge doc={doc} />
              </div>
            </div>
          )
        })}
      </div>

      <div
        className="absolute right-[-2.5px] top-0 z-10 h-full w-[5px] cursor-col-resize hover:bg-[var(--primary-soft)]"
        style={{ touchAction: 'none' }}
        onPointerDown={onHandleDown}
      />

      <div className="border-t border-line px-3 py-2.5 text-[11px] leading-relaxed t3">
        本地上传（PDF 自动解析）或粘贴链接导入网页
      </div>

      {delIds && (
        <ConfirmModal
          title="删除文档"
          message={delIds.length > 1
            ? <>确定删除选中的 <b>{delIds.length}</b> 个文档？生成产物与索引将一并删除。</>
            : <>确定删除文档「<b>{docs.find(d => d.id === delIds[0])?.name}</b>」？生成产物与索引将一并删除。</>}
          onConfirm={() => { store.getState().deleteDocs(delIds); toast('已删除文档') }}
          onClose={() => setDelIds(null)}
        />
      )}

      {moveTarget && (
        <MoveCopyModal
          docs={moveTarget.ids.map(id => docs.find(d => d.id === id)).filter((d): d is DocumentItem => !!d)}
          copy={moveTarget.copy}
          targetKbs={kbs.filter(k => k.id !== activeKbId)}
          onClose={() => setMoveTarget(null)}
        />
      )}

      {importOpen && (
        <ImportModal
          uploading={importing}
          onUpload={onPick}
          onClose={() => setImportOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * 导入弹窗（步骤11）：本地上传 / 输入链接 两页签。
 * - 本地上传：现状流程（.pdf/.md，md 跳过 OCR）；整理预设下拉只列 group='doc'
 *   预设，选中 → 写入新文档 gen_config.presetId（显式），不选=继承知识库默认；
 * - 输入链接（debug4 #3 异步化）：URL → 后端立即建 fetching 占位文档（占位名=域名）
 *   并后台抓取（trafilatura 抽正文），完成自动改名（页面标题）+ready，失败 failed；
 *   整理预设下拉只列 group='web' 预设。提交后关闭弹窗 + toast「已开始抓取」。
 */
function ImportModal({ uploading, onUpload, onClose }: {
  uploading: boolean
  onUpload: (files: FileList | null, presetId: string | null) => Promise<unknown>
  onClose: () => void
}) {
  const presets = useSettingsStore(s => s.presets)
  const docPresets = useMemo(
    () => presets.filter(p => p.kind === 'organization' && (p.group ?? 'doc') === 'doc'),
    [presets],
  )
  const webPresets = useMemo(
    () => presets.filter(p => p.kind === 'organization' && (p.group ?? 'doc') === 'web'),
    [presets],
  )
  const [tab, setTab] = useState<'upload' | 'link'>('upload')
  const [uploadPreset, setUploadPreset] = useState('')
  const [linkPreset, setLinkPreset] = useState('')
  const [url, setUrl] = useState('')
  const [importingLink, setImportingLink] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const pickFiles = async (files: FileList | null) => {
    const done = await onUpload(files, uploadPreset || null)
    if (fileRef.current) fileRef.current.value = ''
    if ((done as unknown[])?.length) onClose()
  }

  const importLink = async () => {
    const u = url.trim()
    if (!u) return
    setImportingLink(true)
    try {
      // debug4 #3：后端同步段立即建 fetching 占位文档并开始后台抓取——
      // 提交后关闭弹窗 + toast 提示；抓取完成自动改名（doc.parsed → refreshDoc）
      await useKbStore.getState().importLink(u, linkPreset || null)
      toast('已开始抓取')
      onClose()
    } catch (e: any) {
      toast(`导入失败：${apiErr(e)}`, 'error')
    } finally {
      setImportingLink(false)
    }
  }

  const presetOptions = (list: typeof docPresets) =>
    [{ value: '', label: '（继承知识库默认）' },
      ...list.map(p => ({ value: p.id, label: p.displayName }))]

  return (
    <Modal
      title="导入文档"
      width={480}
      onClose={onClose}
      footer={
        tab === 'link' ? (
          <>
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn btn-primary" disabled={!url.trim() || importingLink} onClick={() => void importLink()}>
              <Icon name="link" size={14} />
              {importingLink ? '提交中…' : '导入'}
            </button>
          </>
        ) : undefined
      }
    >
      <div className="mb-3 flex gap-1">
        <button className={`btn btn-sm ${tab === 'upload' ? 'btn-primary' : ''}`} onClick={() => setTab('upload')}>
          <Icon name="upload" size={13} /> 本地上传
        </button>
        <button className={`btn btn-sm ${tab === 'link' ? 'btn-primary' : ''}`} onClick={() => setTab('link')}>
          <Icon name="link" size={13} /> 输入链接
        </button>
      </div>

      {tab === 'upload' ? (
        <div className="space-y-3">
          <div>
            <div className="label mb-1.5">文档整理预设（文档类）</div>
            <Dropdown
              options={presetOptions(docPresets)}
              value={uploadPreset}
              onChange={setUploadPreset}
              emptyText="暂无文档类预设，可在设置中新增"
            />
          </div>
          <button
            className="btn btn-soft w-full" disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="fileText" size={14} />
            {uploading ? '导入中…' : '选择 PDF / MD 文件'}
          </button>
          <input
            ref={fileRef} type="file" accept=".pdf,.md" multiple className="hidden"
            onChange={e => void pickFiles(e.target.files)}
          />
          <div className="t3 text-[11.5px] leading-relaxed">
            上传后自动解析（PDF→OCR，MD 直接摄取）；预设不选=按知识库默认配置继承。
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="label mb-1.5">网页链接</div>
            <input
              className="input" autoFocus placeholder="https://example.com/article"
              value={url} onChange={e => setUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && url.trim()) void importLink() }}
            />
          </div>
          <div>
            <div className="label mb-1.5">文档整理预设（网页类）</div>
            <Dropdown
              options={presetOptions(webPresets)}
              value={linkPreset}
              onChange={setLinkPreset}
              emptyText="暂无网页类预设，可在设置中新增"
            />
          </div>
          <div className="t3 text-[11.5px] leading-relaxed">
            提交后立即创建「抓取中」文档并后台抓取网页正文（转为 Markdown，保留图片远程
            链接与表格），完成后自动改名为网页标题并进入待生成；失败会标记为「失败」，可
            删除后重新提交。仅支持静态 HTML 页面，JS 渲染/强反爬页面可能无法导入。
          </div>
        </div>
      )}
    </Modal>
  )
}

/** 「移动到/复制到」弹窗（步骤10）：列出除本库外的知识库，单选后确认。
 *  语义区别：移动=从本库移除；复制=保留本库，目标库出现"（副本）"。 */
function MoveCopyModal({ docs, copy, targetKbs, onClose }: {
  docs: DocumentItem[]
  copy: boolean
  targetKbs: { id: string; name: string }[]
  onClose: () => void
}) {
  const [target, setTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const store = useKbStore.getState()
  const run = async () => {
    if (!target || busy) return
    setBusy(true)
    try {
      if (copy) {
        for (const d of docs) await store.copyDoc(d.id, target)
        toast(`已复制 ${docs.length} 个文档`)
      } else {
        await store.moveDocs(docs.map(d => d.id), target)
        toast(`已移动 ${docs.length} 个文档`)
      }
      onClose()
    } catch (e) {
      toast(`${copy ? '复制' : '移动'}失败：${apiErr(e)}`, 'error')
      setBusy(false)
    }
  }
  return (
    <Modal
      title={copy ? '复制文档到…' : '移动文档到…'}
      width={420} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={!target || busy} onClick={run}>
            {busy ? '执行中…' : copy ? '复制' : '移动'}
          </button>
        </>
      }
    >
      <div className="mb-2 text-[12.5px] t2">
        {copy ? '复制' : '移动'}{' '}
        {docs.length > 1 ? <><b>{docs.length}</b> 个文档</> : <>「<b>{docs[0]?.name}</b>」</>}
        {!copy && <span className="t3">（原文档从当前知识库移除）</span>}
        {copy && <span className="t3">（新文档名=原名+"（副本）"，不重新嵌入）</span>}
      </div>
      <div className="flex flex-col gap-1">
        {targetKbs.map(kb => (
          <label
            key={kb.id}
            className={cx(
              'flex cursor-pointer items-center gap-2 rounded-[9px] border px-3 py-2 text-[13px] transition-colors',
              target === kb.id ? 'border-[var(--primary)]' : 'border-line hover:bg-[var(--hover)]',
            )}
          >
            <input
              type="radio" name="move-target" className="accent-[var(--primary)]"
              checked={target === kb.id} onChange={() => setTarget(kb.id)}
            />
            <Icon name="database" size={14} className="t3" />
            <span className="min-w-0 flex-1 truncate">{kb.name}</span>
          </label>
        ))}
      </div>
    </Modal>
  )
}
