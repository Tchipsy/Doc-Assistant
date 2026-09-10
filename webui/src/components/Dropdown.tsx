import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../lib/icons'
import { cx } from '../lib/utils'

export interface DropdownOption {
  value: string
  label: string
  hint?: string
  group?: string
  checked?: boolean
}

export function Dropdown({ options, value, onChange, placeholder = '请选择', width, buttonClass, align = 'left', disabled, emptyText = '暂无可选项' }: {
  options: DropdownOption[]
  value: string
  onChange: (v: string) => void
  placeholder?: string
  width?: number
  buttonClass?: string
  align?: 'left' | 'right'
  disabled?: boolean
  emptyText?: string
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [popStyle, setPopStyle] = useState<React.CSSProperties>({})

  const selected = useMemo(() => options.find(o => o.value === value), [options, value])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const maxH = 320
    const style: React.CSSProperties = {
      position: 'fixed',
      width: Math.max(r.width, 200),
      maxHeight: maxH,
      left: align === 'right' ? Math.max(8, r.right - Math.max(r.width, 200)) : r.left,
      top: r.bottom + 6,
      zIndex: 1100,
    }
    setPopStyle(style)
  }, [open, align])

  // 分组渲染
  const groups = useMemo(() => {
    const map = new Map<string, DropdownOption[]>()
    options.forEach(o => {
      const g = o.group ?? ''
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(o)
    })
    return [...map.entries()]
  }, [options])

  return (
    <>
      <button
        ref={btnRef}
        disabled={disabled}
        className={cx('input flex items-center justify-between gap-2 text-left', buttonClass)}
        style={width ? { width } : undefined}
        onClick={() => setOpen(o => !o)}
      >
        <span className={cx('truncate', !selected && 't3')}>{selected ? selected.label : placeholder}</span>
        <Icon name="chevronDown" size={14} className="shrink-0 opacity-60" />
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          className="menu anim-pop scroll-thin overflow-y-auto"
          style={popStyle}
        >
          {groups.length === 0 && <div className="px-3 py-4 text-center text-[12.5px] t3">{emptyText}</div>}
          {groups.map(([g, opts]) => (
            <div key={g}>
              {g && <div className="px-3 pb-1 pt-2 text-[11.5px] font-medium t3">{g}</div>}
              {opts.map(o => (
                <button
                  key={o.value}
                  className="menu-item justify-between"
                  onClick={() => { onChange(o.value); setOpen(false) }}
                >
                  <span className={cx('truncate', o.checked && 'font-medium')} style={{ color: o.value === value ? 'var(--primary)' : undefined }}>
                    {o.label}
                    {o.hint && <span className="ml-1.5 text-[11.5px] t3">{o.hint}</span>}
                  </span>
                  {o.value === value && <Icon name="check" size={14} className="shrink-0" style={{ color: 'var(--primary)' }} />}
                </button>
              ))}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
