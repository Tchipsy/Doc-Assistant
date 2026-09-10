import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

/**
 * 列表拖拽排序 hook（9.5 步骤10）：HTML5 原生拖拽（draggable + dragover/drop），
 * 无第三方依赖（与 GenConfigFields 插件拖拽同一技术路线）。仅支持单行拖动（多选拖动 v1 不做）。
 *
 * - 行间插入指示线：dropIndex = 插入位置（在第 dropIndex 行上缘画线；=ids.length 画在末尾）
 * - 拖到滚动容器上下边缘自动滚动（rAF 循环，dragover 持续刷新指针位置）
 * - 一次拖动 = 整列表新顺序下发 onReorder（后端按位赋 sort_order，无并发歧义）
 * - dragMime：额外写入的自定义数据类型，用于跨栏拖拽识别
 *   （文档行拖到知识库行 = 移动文档，见 DOC_DRAG_MIME / useDocDrag）
 */

/** 跨栏拖拽（文档 → 知识库行）的自定义 MIME 类型；dragover 阶段只能读 types（小写原样） */
export const DOC_DRAG_MIME = 'application/x-da-doc-move'

/** 文档拖拽跨栏状态：DocColumn 写（dragstart/end），KbColumn 读+写目标行（drop hint） */
interface DocDragState {
  docId: string | null
  sourceKbId: string | null
  targetKbId: string | null    // 悬停中的目标知识库行（null=无 drop hint）
  x: number                    // 浮层文字跟随光标
  y: number
  patch: (p: Partial<Omit<DocDragState, 'patch'>>) => void
}

export const useDocDrag = create<DocDragState>(set => ({
  docId: null,
  sourceKbId: null,
  targetKbId: null,
  x: 0,
  y: 0,
  patch: p => set(p),
}))

export interface DragSortHandle {
  dragId: string | null
  /** 插入位置（0..ids.length）；null=当前无指示线 */
  dropIndex: number | null
  /** 每行展开的属性/事件（index 为该行在当前列表中的下标） */
  rowProps: (id: string, index: number) => {
    draggable: boolean
    onDragStart: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
    onDragEnd: (e: React.DragEvent) => void
  }
  /** 挂到滚动容器上：接管最后一行下方空白区的 drop（插入到末尾） */
  containerProps: {
    onDragOver: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

export function useDragSort(opts: {
  ids: string[]
  /** 滚动容器 ref（边缘自动滚动作用对象） */
  containerRef: React.RefObject<HTMLElement | null>
  onReorder: (ids: string[]) => void
  /** 额外写入 dragstart 的自定义类型（如 DOC_DRAG_MIME，供跨栏 drop 目标识别） */
  dragMime?: string
  /** 拖拽开始/结束回调（组件用它维护 useDocDrag 等外围状态；结束含取消/放置） */
  onDragStart?: (id: string) => void
  onDragEnd?: (id: string) => void
}): DragSortHandle {
  const { ids, containerRef, onReorder, dragMime, onDragStart, onDragEnd } = opts
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const idsRef = useRef(ids)
  idsRef.current = ids
  const dragRef = useRef<string | null>(null)
  const dropRef = useRef<number | null>(null)
  const ptRef = useRef({ x: 0, y: 0 })
  const rafRef = useRef(0)

  const reset = useCallback(() => {
    const id = dragRef.current
    dragRef.current = null
    dropRef.current = null
    setDragId(null)
    setDropIndex(null)
    cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    if (id) onDragEnd?.(id)
  }, [onDragEnd])

  const scrollLoop = useCallback(() => {
    const el = containerRef.current
    if (!el) { rafRef.current = 0; return }
    const r = el.getBoundingClientRect()
    const edge = 28
    const { y } = ptRef.current
    let dy = 0
    if (y < r.top + edge) dy = -Math.ceil((r.top + edge - y) / 2)
    else if (y > r.bottom - edge) dy = Math.ceil((y - (r.bottom - edge)) / 2)
    if (dy) el.scrollTop += Math.max(-14, Math.min(14, dy))
    rafRef.current = requestAnimationFrame(scrollLoop)
  }, [containerRef])

  const start = useCallback((id: string) => {
    dragRef.current = id
    setDragId(id)
    onDragStart?.(id)
    if (!rafRef.current) rafRef.current = requestAnimationFrame(scrollLoop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onDragStart, scrollLoop])

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  /** 由指针相对行的位置计算插入下标（前半=行前，后半=行后） */
  const indexFromEvent = (index: number, e: React.DragEvent): number => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return e.clientY > rect.top + rect.height / 2 ? index + 1 : index
  }

  const commit = useCallback(() => {
    const cur = idsRef.current
    const id = dragRef.current
    const target = dropRef.current
    if (id && target != null) {
      const from = cur.indexOf(id)
      if (from !== -1) {
        let at = target
        if (from < at) at -= 1          // 原位删除后前移一格
        at = Math.max(0, Math.min(cur.length - 1, at))
        if (at !== from) {
          const next = cur.filter(x => x !== id)
          next.splice(at, 0, id)
          onReorder(next)
        }
      }
    }
    reset()
  }, [onReorder, reset])

  return {
    dragId,
    dropIndex,
    rowProps: (id, index) => ({
      draggable: true,
      onDragStart: e => {
        e.dataTransfer.setData('text/plain', id)
        if (dragMime) e.dataTransfer.setData(dragMime, id)
        e.dataTransfer.effectAllowed = 'move'
        ptRef.current = { x: e.clientX, y: e.clientY }
        start(id)
      },
      onDragOver: e => {
        if (dragRef.current && dragRef.current !== id) {
          e.preventDefault()
          e.stopPropagation()   // 不冒泡到容器（容器 handler 把插入位重置为末尾）
          e.dataTransfer.dropEffect = 'move'
          ptRef.current = { x: e.clientX, y: e.clientY }
          setDropIndex(indexFromEvent(index, e))
        }
      },
      onDrop: e => {
        if (!dragRef.current) return
        e.preventDefault()
        e.stopPropagation()
        dropRef.current = indexFromEvent(index, e)
        commit()
      },
      onDragEnd: () => reset(),
    }),
    containerProps: {
      onDragOver: e => {
        if (!dragRef.current) return
        e.preventDefault()
        ptRef.current = { x: e.clientX, y: e.clientY }
        setDropIndex(idsRef.current.length)   // 行间空白/末行下方 = 插入到末尾
      },
      onDrop: e => {
        if (!dragRef.current) return
        e.preventDefault()
        commit()
      },
    },
  }
}

/** 插入指示线（行间 2px 高亮线；absolute 定位到行的上/下缘，父行需 relative） */
export function DropIndicator({ edge = 'top' }: { edge?: 'top' | 'bottom' }) {
  return (
    <div
      className="pointer-events-none absolute left-1 right-1 z-10 h-[2px] rounded-full"
      style={{
        background: 'var(--primary)',
        boxShadow: '0 0 0 1px rgba(255,255,255,.35)',
        [edge]: -1,
      } as React.CSSProperties}
    />
  )
}
