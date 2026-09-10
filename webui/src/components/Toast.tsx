import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { Icon } from '../lib/icons'
import { cx } from '../lib/utils'

interface ToastItem { id: number; text: string; type: 'ok' | 'error' | 'info' }

interface ToastState {
  toasts: ToastItem[]
  push: (text: string, type?: ToastItem['type']) => void
  remove: (id: number) => void
}

let nextId = 1

export const useToast = create<ToastState>(set => ({
  toasts: [],
  push: (text, type = 'ok') => {
    const id = nextId++
    set(s => ({ toasts: [...s.toasts, { id, text, type }] }))
    window.setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), 2600)
  },
  remove: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}))

export const toast = (text: string, type?: ToastItem['type']) => useToast.getState().push(text, type)

export function ToastHost() {
  const toasts = useToast(s => s.toasts)
  return createPortal(
    <div className="pointer-events-none fixed left-1/2 top-5 z-[1200] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map(t => (
        <div
          key={t.id}
          className={cx(
            'anim-slide flex items-center gap-2 rounded-[10px] px-4 py-2.5 text-[13px] shadow-lg',
            'border border-line',
          )}
          style={{ background: 'var(--panel)' }}
        >
          <Icon
            name={t.type === 'error' ? 'alert' : 'check'}
            size={15}
            style={{ color: t.type === 'error' ? 'var(--danger)' : 'var(--ok)' }}
          />
          <span className="t1">{t.text}</span>
        </div>
      ))}
    </div>,
    document.body,
  )
}
