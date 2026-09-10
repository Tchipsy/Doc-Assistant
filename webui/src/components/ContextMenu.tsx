import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { Icon } from '../lib/icons'
import { cx } from '../lib/utils'

export interface MenuItem {
  label?: string
  icon?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onClick?: () => void
}

interface MenuState {
  open: boolean
  x: number
  y: number
  items: MenuItem[]
  show: (x: number, y: number, items: MenuItem[]) => void
  close: () => void
}

export const useMenu = create<MenuState>(set => ({
  open: false, x: 0, y: 0, items: [],
  show: (x, y, items) => set({ open: true, x, y, items }),
  close: () => set({ open: false }),
}))

export function ContextMenuHost() {
  const { open, x, y, items, close } = useMenu()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    if (!open) return
    const el = ref.current
    let nx = x, ny = y
    if (el) {
      const r = el.getBoundingClientRect()
      nx = Math.min(x, window.innerWidth - r.width - 8)
      ny = Math.min(y, window.innerHeight - r.height - 8)
    }
    setPos({ x: nx, y: ny })
  }, [open, x, y, items])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [open, close])

  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      className="menu anim-pop fixed"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={e => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={cx('menu-item', it.danger && 'danger')}
            disabled={it.disabled}
            onClick={() => { close(); it.onClick?.() }}
          >
            {it.icon && <Icon name={it.icon} size={15} className="shrink-0 opacity-80" />}
            <span>{it.label}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}

export function openMenu(e: React.MouseEvent, items: MenuItem[]) {
  e.preventDefault()
  e.stopPropagation()
  useMenu.getState().show(e.clientX, e.clientY, items)
}
