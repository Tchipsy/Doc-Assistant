import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../lib/icons'

export function Modal({ title, width = 460, onClose, children, footer }: {
  title: string
  width?: number
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="anim-fade fixed inset-0 z-[900] flex items-center justify-center bg-black/40 p-6"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="card anim-pop flex max-h-[86vh] w-full flex-col shadow-xl" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="text-[15px] font-semibold t1">{title}</div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/** 确认对话框 */
export function ConfirmModal({ title, message, confirmText = '删除', danger = true, onConfirm, onClose }: {
  title: string
  message: React.ReactNode
  confirmText?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal title={title} width={400} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          style={danger ? { background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' } : undefined}
          onClick={() => { onConfirm(); onClose() }}
        >
          {confirmText}
        </button>
      </>
    }>
      <div className="flex items-start gap-3 text-[13.5px] t2 leading-relaxed">
        <Icon name="alert" size={20} style={{ color: danger ? 'var(--danger)' : 'var(--warn)' }} className="mt-0.5 shrink-0" />
        <div>{message}</div>
      </div>
    </Modal>
  )
}
