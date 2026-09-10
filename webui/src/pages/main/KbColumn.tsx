import { useRef, useState } from 'react'
import { useKbStore } from '../../store/kb'
import { openInNewTab } from '../../store/tabs'
import { buildRoute } from '../../lib/router'
import { openMenu } from '../../components/ContextMenu'
import { Modal } from '../../components/Modal'
import { ConfirmModal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { Icon } from '../../lib/icons'
import { apiErr, cx } from '../../lib/utils'
import { useColumnWidth } from '../../hooks/useResize'
import { useDragSort, DropIndicator, useDocDrag, DOC_DRAG_MIME } from '../../hooks/useDragSort'

export function KbColumn({ openKbConfig }: {
  /** 打开知识库默认配置窗口（步骤11：右键「修改配置」） */
  openKbConfig?: (kbId: string) => void
}) {
  const kbs = useKbStore(s => s.kbs)
  const docsByKb = useKbStore(s => s.docsByKb)
  const activeKbId = useKbStore(s => s.activeKbId)
  const kbSel = useKbStore(s => s.kbSel)
  const store = useKbStore
  const { width, onHandleDown } = useColumnWidth({
    initial: 228, min: 170, max: 380, storageKey: 'col-kbs', side: 'right',
  })

  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null)
  const [delIds, setDelIds] = useState<string[] | null>(null)
  /** 文档拖到知识库行松开后的确认（步骤10）：{docId, kbId} */
  const [moveConfirm, setMoveConfirm] = useState<{ docId: string; kbId: string } | null>(null)

  // 步骤10：知识库手动排序（与文档栏同套 useDragSort 逻辑）
  const listRef = useRef<HTMLDivElement>(null)
  const dragSort = useDragSort({
    ids: kbs.map(k => k.id),
    containerRef: listRef,
    onReorder: ids => void store.getState().reorderKbs(ids),
  })
  const { dragId, dropIndex } = dragSort
  const dragIndex = dragId ? kbs.findIndex(k => k.id === dragId) : -1
  const noopDrop = dropIndex != null && dragIndex >= 0
    && (dropIndex === dragIndex || dropIndex === dragIndex + 1)

  // 跨栏 drop hint（文档行拖入）：useDocDrag 由 DocColumn dragstart 写入
  const docDragTarget = useDocDrag(s => s.targetKbId)
  const docDragX = useDocDrag(s => s.x)
  const docDragY = useDocDrag(s => s.y)
  const hintKb = docDragTarget ? kbs.find(k => k.id === docDragTarget) : null

  /** 文档行悬停本行 → drop hint「移动到xxx」（返回 true=事件已按移动目标处理） */
  const docOver = (e: React.DragEvent, kbId: string): boolean => {
    const dd = useDocDrag.getState()
    if (!dd.docId || kbId === dd.sourceKbId) return false
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (dd.targetKbId !== kbId || dd.x !== e.clientX || dd.y !== e.clientY) {
      dd.patch({ targetKbId: kbId, x: e.clientX, y: e.clientY })
    }
    return true
  }

  /** 文档行松开 → 确认弹窗「是否确认把xxx移动到xxx」 */
  const docDrop = (e: React.DragEvent, kbId: string): boolean => {
    const dd = useDocDrag.getState()
    if (!dd.docId || kbId === dd.sourceKbId) return false
    e.preventDefault()
    e.stopPropagation()
    setMoveConfirm({ docId: dd.docId, kbId })
    dd.patch({ docId: null, sourceKbId: null, targetKbId: null })
    return true
  }

  const submitNew = () => {
    const name = newName.trim()
    if (!name) return
    store.getState().createKb(name).then(() => toast(`知识库「${name}」已创建`))
    setNewName('')
    setNewOpen(false)
  }

  /** 右键菜单。步骤8：选中同步不走 clickKb——右键不是导航（不写 URL/pushState），
   *  否则当前标签路由被顶成该库，随后的「在新标签页打开」会被去重到当前标签。 */
  const menuFor = (e: React.MouseEvent, id: string) => {
    const s = store.getState()
    if (!s.kbSel.includes(id)) {
      useKbStore.setState({ kbSel: [id], kbAnchor: id, activeKbId: id, activeDocId: null, docSel: [] })
    }
    const sel = store.getState().kbSel
    const multi = sel.length > 1
    openMenu(e, [
      ...(multi ? [] : [{
        label: '重命名', icon: 'pencil',
        onClick: () => setRename({ id, name: kbs.find(k => k.id === id)?.name ?? '' }),
      }]),
      ...(multi ? [] : [{
        label: '在新标签页打开', icon: 'layout',
        onClick: () => openInNewTab(buildRoute({ view: 'kb', kbId: id })),
      } as any]),
      ...(multi ? [] : openKbConfig ? [{
        label: '修改配置', icon: 'sliders',
        onClick: () => openKbConfig(id),
      } as any] : []),
      {
        label: multi ? `删除选中知识库（${sel.length}）` : '删除',
        icon: 'trash', danger: true,
        onClick: () => setDelIds([...sel]),
      },
    ])
  }

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-r border-line"
      style={{ background: 'var(--panel)', width }}
    >
      <div
        className="absolute right-[-2.5px] top-0 z-10 h-full w-[5px] cursor-col-resize hover:bg-[var(--primary-soft)]"
        style={{ touchAction: 'none' }}
        onPointerDown={onHandleDown}
      />
      <div className="px-3 pb-2 pt-3">
        <button className="btn btn-soft w-full" onClick={() => setNewOpen(true)}>
          <Icon name="plus" size={15} />
          新建知识库
        </button>
      </div>

      <div ref={listRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        {...dragSort.containerProps}>
        {kbs.length === 0 && (
          <div className="flex flex-col items-center gap-2 pt-16 text-center">
            <Icon name="folderPlus" size={34} className="t3" />
            <div className="text-[13px] t3">还没有知识库</div>
            <button className="btn btn-sm" onClick={() => setNewOpen(true)}>新建知识库</button>
          </div>
        )}
        {kbs.map((kb, i) => {
          const count = docsByKb[kb.id]?.length ?? 0
          const selected = kbSel.includes(kb.id)
          const active = activeKbId === kb.id
          const rp = dragSort.rowProps(kb.id, i)
          const dragging = dragId === kb.id
          const isDocTarget = docDragTarget === kb.id
          return (
            <div
              key={kb.id}
              {...rp}
              className={cx(
                'group relative mb-0.5 flex cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 py-2 transition-colors',
                selected ? 'row-selected' : 'hover:bg-[var(--hover)]',
                dragging && 'opacity-40',
              )}
              style={isDocTarget ? { background: 'var(--primary-soft)', outline: '1.5px solid var(--primary)' } : undefined}
              onClick={e => store.getState().clickKb(kb.id, e)}
              onContextMenu={e => menuFor(e, kb.id)}
              title={kb.name}
              onDragOver={e => { if (!docOver(e, kb.id)) rp.onDragOver(e) }}
              onDrop={e => { if (!docDrop(e, kb.id)) rp.onDrop(e) }}
              onDragLeave={e => {
                // 拖出本行（relatedTarget 检查排除子元素误报）→ 清除 drop hint
                const dd = useDocDrag.getState()
                if (dd.targetKbId === kb.id
                  && !(e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node))) {
                  dd.patch({ targetKbId: null })
                }
              }}
            >
              {/* 行间插入指示线（知识库排序）；文档拖入本库的 drop hint 是高亮框，不画线 */}
              {!noopDrop && !isDocTarget && dropIndex === i && <DropIndicator edge="top" />}
              {!noopDrop && !isDocTarget && dropIndex === kbs.length && i === kbs.length - 1 && (
                <DropIndicator edge="bottom" />
              )}
              <Icon
                name="database"
                size={16}
                className="shrink-0"
                style={{ color: active ? 'var(--primary)' : 'var(--text-3)' }}
              />
              <span className={cx('min-w-0 flex-1 truncate text-[13px]', active ? 'font-medium' : '')}
                style={{ color: active ? 'var(--primary)' : 'var(--text-1)' }}>
                {kb.name}
              </span>
              <span className="badge shrink-0" style={{ fontSize: 10.5, padding: '0 6px' }}>{count}</span>
            </div>
          )
        })}
      </div>

      <div className="border-t border-line px-3 py-2.5 text-[11px] leading-relaxed t3">
        Ctrl/Shift + 点击可多选 · 右键更多操作
      </div>

      {/* drop hint 浮层文字（跟随光标；目标行已高亮） */}
      {hintKb && (
        <div
          className="pointer-events-none fixed z-[850] flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12px] text-white shadow-lg"
          style={{ left: docDragX + 14, top: docDragY + 16, background: 'var(--primary)' }}
        >
          <Icon name="doc" size={12} />
          移动到「{hintKb.name}」
        </div>
      )}

      {/* 新建知识库 */}
      {newOpen && (
        <Modal title="新建知识库" width={400} onClose={() => setNewOpen(false)} footer={
          <>
            <button className="btn" onClick={() => setNewOpen(false)}>取消</button>
            <button className="btn btn-primary" disabled={!newName.trim()} onClick={submitNew}>创建</button>
          </>
        }>
          <input
            className="input" autoFocus placeholder="知识库名称"
            value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitNew() }}
          />
        </Modal>
      )}

      {/* 重命名 */}
      {rename && (
        <Modal title="重命名知识库" width={400} onClose={() => setRename(null)} footer={
          <>
            <button className="btn" onClick={() => setRename(null)}>取消</button>
            <button className="btn btn-primary" disabled={!rename.name.trim()}
              onClick={() => {
                store.getState().renameKb(rename.id, rename.name.trim()).then(() => toast('已重命名'))
                setRename(null)
              }}>确认</button>
          </>
        }>
          <input className="input" autoFocus value={rename.name}
            onChange={e => setRename({ ...rename, name: e.target.value })} />
        </Modal>
      )}

      {/* 删除确认 */}
      {delIds && (
        <ConfirmModal
          title="删除知识库"
          message={delIds.length > 1
            ? <>确定删除选中的 <b>{delIds.length}</b> 个知识库？其下所有文档及生成产物将一并删除。</>
            : <>确定删除知识库「<b>{kbs.find(k => k.id === delIds[0])?.name}</b>」？其下所有文档及生成产物将一并删除。</>}
          onConfirm={() => { store.getState().deleteKbs(delIds); toast('已删除知识库') }}
          onClose={() => setDelIds(null)}
        />
      )}

      {/* 拖拽移动文档确认（步骤10：drop hint 松开 → 确认弹窗） */}
      {moveConfirm && (() => {
        const docName = Object.values(docsByKb).flatMap(list => list ?? [])
          .find(d => d.id === moveConfirm.docId)?.name ?? moveConfirm.docId
        const kbName = kbs.find(k => k.id === moveConfirm.kbId)?.name ?? moveConfirm.kbId
        return (
          <ConfirmModal
            title="移动文档"
            danger={false}
            confirmText="移动"
            message={<>是否确认把「<b>{docName}</b>」移动到「<b>{kbName}</b>」？</>}
            onConfirm={() => {
              store.getState().moveDocs([moveConfirm.docId], moveConfirm.kbId)
                .then(() => toast(`已移动到「${kbName}」`))
                .catch((e: any) => toast(`移动失败：${apiErr(e)}`, 'error'))
            }}
            onClose={() => setMoveConfirm(null)}
          />
        )
      })()}
    </div>
  )
}
