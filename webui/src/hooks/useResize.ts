import { useCallback, useRef, useState } from 'react'

/**
 * 栏宽拖拽 hook：pointer capture 版，修复旧实现两个 bug——
 * ① 拖过 iframe（如 PDF 预览）时 mousemove 被 iframe 吞掉（按住拖不动）；
 * ② 在 iframe/窗口外松开时收不到 mouseup（不按键也跟着动）。
 * setPointerCapture 让后续指针事件始终派发给手柄元素，配合
 * ev.buttons 兜底（按键已松开立即结束）。
 */
export function useColumnWidth(opts: {
  initial: number
  min?: number
  max?: number
  storageKey?: string
  /** 手柄贴在栏的哪一侧：left = 栏右缘拖动向右变宽；right = 栏左缘拖动向左变宽 */
  side: 'left' | 'right'
}) {
  const min = opts.min ?? 160
  const max = opts.max ?? 1200
  const [width, setWidth] = useState(() => {
    if (opts.storageKey) {
      const v = Number(localStorage.getItem(opts.storageKey))
      if (Number.isFinite(v) && v >= min && v <= max) return v
    }
    return opts.initial
  })
  const widthRef = useRef(width)
  widthRef.current = width

  const onHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    const startX = e.clientX
    const startW = widthRef.current
    const mult = opts.side === 'right' ? 1 : -1   // side=left（手柄在栏左缘）：向左拖变宽
    let last = startW
    let raf = 0
    const clamp = (w: number) => Math.min(max, Math.max(min, w))
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      if (opts.storageKey) localStorage.setItem(opts.storageKey, String(last))
    }
    const onMove = (ev: PointerEvent) => {
      if (!(ev.buttons & 1)) { finish(); return }
      const w = clamp(startW + (ev.clientX - startX) * mult)
      if (w !== last) {
        last = w
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => setWidth(w))
      }
    }
    try { el.setPointerCapture(e.pointerId) } catch { /* 合成指针/已释放指针会抛错，capture 只是增强 */ }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, opts.side, opts.storageKey])

  const handleProps = {
    onPointerDown: onHandleDown,
    draggable: false,
    style: { touchAction: 'none' as const },
  }
  return { width, setWidth, onHandleDown, handleProps }
}

/** 竖向分隔手柄的公共 className */
export const resizeHandleCls = 'relative z-10 h-full w-[5px] shrink-0 cursor-col-resize select-none hover:bg-[var(--primary-soft)]'
