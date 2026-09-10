import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clamp } from '../lib/utils'

/**
 * 悬停浮卡（debug2 #13）：createPortal(document.body) + position:fixed 定位——
 * 不再受 Collapsible 根 overflow-hidden / 嵌套滚动容器裁剪（旧 .citation-preview
 * 绝对定位浮卡被裁掉的根因）。定位 = 目标元素 getBoundingClientRect：
 * 默认上方（距 rect.top 6px）；顶部空间不足（rect.top < 卡高+16）翻下方；
 * 横向 clamp 视口内；z-index 1300（高于 ContextMenu 1000 / Toast 1200——高于一切浮层）。
 * 纯定位函数 hoverPreviewPos 导出供单测（fake rect）。
 */

export interface HoverPos { left: number; top: number; below: boolean }

/** 由目标矩形计算浮卡位置：顶部空间不足（top < 卡高+16）翻下方，横向/纵向 clamp 视口内 */
export function hoverPreviewPos(
  r: { left: number; top: number; bottom: number },
  vw: number, vh: number, width: number, cardH: number,
): HoverPos {
  const below = r.top < cardH + 16
  const rawTop = below ? r.bottom + 6 : r.top - cardH - 6
  return {
    below,
    top: clamp(rawTop, 8, Math.max(8, vh - cardH - 8)),
    left: clamp(r.left, 8, Math.max(8, vw - width - 8)),
  }
}

/**
 * 悬停浮卡：hover 期间由使用方挂载（{hover && <HoverPreview target={el}>…</HoverPreview>}）。
 * 首帧先离屏渲染（visibility:hidden）——layout effect 里能量得真实卡高后一次定位，
 * paint 前完成，无闪烁。
 */
export function HoverPreview({ target, width = 380, children }: {
  /** 触发浮卡的目标元素（定位锚点） */
  target: HTMLElement | null
  /** 卡宽（默认与旧 citation-preview 一致） */
  width?: number
  children: React.ReactNode
}) {
  const [pos, setPos] = useState<HoverPos | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!target) { setPos(null); return }
    const r = target.getBoundingClientRect()
    const cardH = cardRef.current?.offsetHeight ?? 180
    const p = hoverPreviewPos(r, window.innerWidth, window.innerHeight, width, cardH)
    // 值未变时保持旧引用（children 身份每次渲染都变，避免无谓的重渲染）
    setPos(prev => (prev && prev.left === p.left && prev.top === p.top && prev.below === p.below) ? prev : p)
  }, [target, width, children])

  if (!target) return null
  return createPortal(
    <div
      ref={cardRef}
      className="hover-preview anim-pop"
      style={{
        position: 'fixed',
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width,
        visibility: pos ? 'visible' : 'hidden',
        zIndex: 1300,
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
