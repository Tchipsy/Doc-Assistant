import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { animateScroll, clamp } from '../lib/utils'
import { scrollMemoRecall, scrollMemoRestore, scrollMemoRestoreWhenReady, scrollMemoSave } from '../lib/scrollMemo'

/**
 * PDF 查看器（9.5 步骤6）——pdf.js 自建连续滚动查看器，替换浏览器 iframe
 * （iframe 无法程序化读写滚动位置，双向同步滚动需要完全的滚动控制权）。
 *
 * - 加载：getDocument(src)；onProgress → 进度 spinner；
 * - 连续滚动布局：pageHeights 预计算（每页视口高宽比 × 容器宽）→ 占位 div 列表，
 *   页顶偏移 pageTops（含页间距）即同步算法的 P[n]；
 * - 虚拟化：IntersectionObserver（rootMargin 上下各 0.25 屏，配合可见±2 页扩展，
 *   典型 A4 全程 canvas ≤5，满足大 PDF 内存目标）只渲染附近页，离屏卸载回收；
 * - 缩放：适宽（scale = 容器宽 / 页视宽，devicePixelRatio 参与背衬分辨率，上限 2）；
 *   容器 resize 重排并按 {page, frac} 保值恢复滚动位置（右栏可拖宽）；
 * - 位置记忆：onScroll → scrollMemoSave(memoKey)（rAF 节流）；就绪后
 *   scrollMemoRestoreWhenReady 恢复；getInitialPos 提供深链定位（?p=&f=）时优先。
 * - 不做文本选择层（首版）。
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfPos { page: number; frac: number }

export interface PdfViewerHandle {
  /** 总页数 */
  pageCount: () => number
  /** 第 page 页（1 基）顶部的容器内容偏移（同步算法的 P[n]） */
  getPageTop: (page: number) => number | null
  /** 页顶偏移表：pageTops[n] = 第 n+1 页顶，末元素 = 总高哨兵（P[p+1] 对末页有效） */
  getPageTops: () => number[] | null
  /** 当前视口中心所在位置 {page, frac}（frac = 页内分数 0~1） */
  getPos: () => PdfPos | null
  /** 定位到 {page, frac}（内容点置于视口中心）；instant=true 直接跳转否则动画 */
  scrollToPos: (pos: PdfPos, opts?: { instant?: boolean }) => void
  /** 滚动容器元素（同步模块的事件识别用） */
  getScrollEl: () => HTMLDivElement | null
}

interface Props {
  src: string
  /** 位置记忆 key（`src:{docId}`） */
  memoKey: string
  /** 所在标签是否激活（9.5 步骤8）：display:none 隐藏期间 IO 自动卸载全部页 canvas、
   *  RO 0×0 由宽度护栏跳过；再激活时从位置记忆回填 scrollTop（容器 scrollTop 被清零） */
  active?: boolean
  /** 深链定位（?p=&f=）：文档就绪后取用一次，返回 null 时走位置记忆恢复 */
  getInitialPos?: () => PdfPos | null
  /** 程序滚动标记（防同步回环）：恢复/深链/重排等程序化滚动前回调 */
  onProgramScroll?: (ms: number) => void
}

const GAP = 8                 // 页间距 px
const ROOT_MARGIN = '25% 0px' // IO 提前量；渲染集合 = 可见 ±2 页（见 updateActive）
const PAGE_REACH = 2          // 可见页前后各渲染 2 页

export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { src, memoKey, active = true, getInitialPos, onProgramScroll },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const wrapsRef = useRef<Array<HTMLDivElement | null>>([])
  const canvasMapRef = useRef(new Map<number, HTMLCanvasElement>())
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const ratiosRef = useRef<number[]>([])     // 每页 高/宽 比（scale=1 视口）
  const topsRef = useRef<number[]>([])       // pageTops：tops[n]=第 n+1 页顶，末位=总高
  const widthRef = useRef(0)
  const tasksRef = useRef(new Map<number, RenderTask>())
  const visibleRef = useRef(new Set<number>())   // IO 判定可见的页（1 基）
  const memoRaf = useRef(0)
  const pendingPosRef = useRef<PdfPos | null>(null)
  const initTakenRef = useRef(false)

  const [pageCount, setPageCount] = useState(0)
  const [heights, setHeights] = useState<number[]>([])
  const [renderSet, setRenderSet] = useState<Set<number>>(new Set())   // 挂载 canvas 的页（1 基）
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [progress, setProgress] = useState(0)

  const layoutTops = (width: number): { tops: number[]; heights: number[] } => {
    const ratios = ratiosRef.current
    const hs = ratios.map(r => Math.max(1, Math.round(r * width)))
    const tops = [0]
    for (let i = 0; i < hs.length; i++) {
      tops.push(tops[i] + hs[i] + (i + 1 < hs.length ? GAP : 0))
    }
    return { tops, heights: hs }
  }

  // ---------- 文档加载 ----------
  useEffect(() => {
    let disposed = false
    setState('loading')
    setProgress(0)
    const task = pdfjsLib.getDocument({ url: src })
    taskRef.current = task
    task.onProgress = (data: { loaded: number; total: number }) => {
      if (!disposed && data.total > 0) {
        setProgress(Math.min(100, Math.round((data.loaded / data.total) * 100)))
      }
    }
    task.promise.then(async doc => {
      if (disposed) { void task.destroy(); return }
      try {
        const ratios: number[] = []
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i)
          if (disposed) break
          const vp = page.getViewport({ scale: 1 })
          ratios.push(vp.height / vp.width)
        }
        if (disposed) { void task.destroy(); return }
        docRef.current = doc
        ratiosRef.current = ratios
        widthRef.current = scrollRef.current?.clientWidth ?? 0
        const { tops, heights: hs } = layoutTops(widthRef.current)
        topsRef.current = tops
        setPageCount(ratios.length)
        setHeights(hs)
        setState('ready')
      } catch (e) {
        console.error('[PdfViewer] 页面信息读取失败', e)
        if (!disposed) setState('error')
      }
    }).catch(err => {
      if (!disposed) {
        console.error('[PdfViewer] PDF 加载失败', err)
        setState('error')
      }
    })
    return () => {
      disposed = true
      void task.destroy()   // v6：文档销毁统一走 loading task
      taskRef.current = null
    }
  }, [src])

  // ---------- 卸载清理：取消渲染任务、销毁文档（防内存泄漏） ----------
  useEffect(() => () => {
    for (const t of tasksRef.current.values()) { try { t.cancel() } catch { /* 已结束 */ } }
    tasksRef.current.clear()
    void taskRef.current?.destroy()   // v6：destroy 在 loading task 上，连带销毁文档
  }, [])

  // ---------- 就绪后：深链定位优先，否则位置记忆恢复 ----------
  useEffect(() => {
    if (state !== 'ready' || pageCount === 0 || initTakenRef.current) return
    initTakenRef.current = true
    const el = scrollRef.current
    if (!el) return
    const initial = getInitialPos?.() ?? null
    if (initial && initial.page >= 1) {
      onProgramScroll?.(300)
      scrollToPos(initial, { instant: true })
    } else {
      // 瞬态抑制收敛（9.6）：仅在确实发生位置恢复时打短标记（300ms 级）——
      // 恢复轮询（≤2s）期间由 scrollMemoIsRestoring 整体让位，onDone 后 300ms
      // 兜住收尾的尾随 scroll 事件。此前的无条件 2400ms 标记会把挂载后 2.4s
      // 内的用户滚动整个吞掉；无位置记忆/初次加载不打标。
      const restored = scrollMemoRestoreWhenReady(memoKey, el, {
        onDone: () => onProgramScroll?.(300),
      })
      if (restored) onProgramScroll?.(300)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, pageCount, memoKey])

  // ---------- 标签再激活：从位置记忆回填 scrollTop（步骤8） ----------
  // display:none 期间容器 scrollTop 被清零；首次激活由上方 init 恢复路径负责，
  // 这里只处理"失活→再激活"的翻转（width 未变、pageTops 仍有效，直接恢复即可）
  const wasActiveRef = useRef(true)
  useEffect(() => {
    const before = wasActiveRef.current
    wasActiveRef.current = active
    if (before || !active || state !== 'ready' || pageCount === 0) return
    const el = scrollRef.current
    if (!el) return
    const pos = scrollMemoRecall(memoKey)
    if (pos != null) {
      onProgramScroll?.(300)
      scrollMemoRestore(el, pos)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, state, pageCount])

  // ---------- 虚拟化：IntersectionObserver → 可见±2 页 ----------
  useEffect(() => {
    const root = scrollRef.current
    if (!root || pageCount === 0) return
    const updateActive = () => {
      const want = new Set<number>()
      for (const p of visibleRef.current) {
        for (let d = -PAGE_REACH; d <= PAGE_REACH; d++) {
          const q = p + d
          if (q >= 1 && q <= pageCount) want.add(q)
        }
      }
      setRenderSet(prev => {
        if (prev.size === want.size && [...want].every(x => prev.has(x))) return prev
        return want
      })
    }
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const p = Number((e.target as HTMLElement).dataset.page)
        if (e.isIntersecting) visibleRef.current.add(p)
        else visibleRef.current.delete(p)
      }
      updateActive()
    }, { root, rootMargin: ROOT_MARGIN, threshold: 0 })
    wrapsRef.current.forEach(w => w && io.observe(w))
    return () => io.disconnect()
  }, [pageCount, heights])

  // ---------- canvas 渲染（适宽 × devicePixelRatio；离屏取消并回收） ----------
  useEffect(() => {
    const doc = docRef.current
    const width = widthRef.current
    if (!doc || state !== 'ready' || width <= 0) return
    let disposed = false
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    for (const p of renderSet) {
      const canvas = canvasMapRef.current.get(p)
      if (!canvas || canvas.dataset.done === String(width)) continue
      const old = tasksRef.current.get(p)
      if (old) { try { old.cancel() } catch { /* 已结束 */ } tasksRef.current.delete(p) }
      void (async () => {
        try {
          const page = await doc.getPage(p)
          if (disposed || canvas.dataset.done === String(widthRef.current)) return
          const vp1 = page.getViewport({ scale: 1 })
          const vp = page.getViewport({ scale: width / vp1.width })
          canvas.width = Math.floor(width * dpr)
          canvas.height = Math.floor((heights[p - 1] ?? vp.height) * dpr)
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          const task = page.render({
            canvas,
            viewport: vp,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          })
          tasksRef.current.set(p, task)
          await task.promise
          if (tasksRef.current.get(p) === task) tasksRef.current.delete(p)
          if (!disposed) canvas.dataset.done = String(widthRef.current)
        } catch { /* RenderingCancelledException：离屏回收/重渲中断，忽略 */ }
      })()
    }
    return () => { disposed = true }
  }, [renderSet, heights, state])

  // 离屏页：卸载 canvas（React 移除元素）前取消在途渲染任务
  useEffect(() => {
    for (const [p, task] of tasksRef.current) {
      if (!renderSet.has(p)) {
        try { task.cancel() } catch { /* 已结束 */ }
        tasksRef.current.delete(p)
      }
    }
  }, [renderSet])

  // ---------- 容器 resize 重排（右栏拖宽）：{page, frac} 保值恢复 ----------
  useEffect(() => {
    const el = scrollRef.current
    if (!el || state !== 'ready') return
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      if (!w || Math.abs(w - widthRef.current) < 2) return
      const pos = getPos()
      widthRef.current = w
      const { tops, heights: hs } = layoutTops(w)
      topsRef.current = tops
      pendingPosRef.current = pos
      setHeights(hs)
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, pageCount])

  // 重排后的滚动位置校正（DOM 高度已按新 heights 提交后执行）
  useEffect(() => {
    const pos = pendingPosRef.current
    if (!pos || !scrollRef.current) return
    pendingPosRef.current = null
    onProgramScroll?.(300)
    scrollToPos(pos, { instant: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heights])

  // ---------- 命令式 API ----------
  function getPos(): PdfPos | null {
    const el = scrollRef.current
    const tops = topsRef.current
    if (!el || tops.length < 2) return null
    const c = el.scrollTop + el.clientHeight / 2
    let k = 0
    for (let i = 0; i < tops.length - 1; i++) {
      if (tops[i] <= c) k = i
      else break
    }
    const span = tops[k + 1] - tops[k]
    const frac = span > 0 ? clamp((c - tops[k]) / span, 0, 1) : 0
    return { page: k + 1, frac }
  }

  function scrollToPos(pos: PdfPos, opts?: { instant?: boolean }) {
    const el = scrollRef.current
    const tops = topsRef.current
    if (!el || tops.length < 2) return
    const page = clamp(Math.round(pos.page), 1, tops.length - 1)
    const i = page - 1
    const span = tops[i + 1] - tops[i]
    const point = tops[i] + clamp(pos.frac, 0, 1) * span
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const to = clamp(point - el.clientHeight / 2, 0, max)
    if (opts?.instant) el.scrollTop = to
    else animateScroll(el, to)
  }

  useImperativeHandle(ref, () => ({
    pageCount: () => pageCount,
    getPageTop: page => topsRef.current[clamp(Math.round(page), 1, topsRef.current.length) - 1] ?? null,
    getPageTops: () => (topsRef.current.length >= 2 ? topsRef.current : null),
    getPos,
    scrollToPos,
    getScrollEl: () => scrollRef.current,
  }), [pageCount, state])

  // ---------- 滚动 → 位置记忆（rAF 节流） ----------
  const handleScroll = (ev: React.UIEvent<HTMLDivElement>) => {
    if (memoRaf.current) return
    const el = ev.currentTarget
    memoRaf.current = requestAnimationFrame(() => {
      memoRaf.current = 0
      scrollMemoSave(memoKey, el)
    })
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="relative h-full overflow-y-auto scroll-thin bg-[#e9ecf2]"
    >
      <div className="mx-auto w-full">
        {heights.map((h, i) => (
          <div
            key={i}
            data-page={i + 1}
            ref={el => { wrapsRef.current[i] = el }}
            className="relative w-full bg-white shadow-sm"
            style={{ height: h, marginTop: i === 0 ? 0 : GAP }}
          >
            {renderSet.has(i + 1) && (
              <canvas
                ref={el => {
                  if (el) canvasMapRef.current.set(i + 1, el)
                  else canvasMapRef.current.delete(i + 1)
                }}
                className="absolute inset-0 h-full w-full"
              />
            )}
          </div>
        ))}
      </div>
      {state !== 'ready' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          {state === 'loading' ? (
            <div className="flex flex-col items-center gap-2 rounded-lg bg-white/85 px-6 py-4 shadow-sm">
              <span className="spin inline-block h-5 w-5 rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-[11.5px] t3">
                加载 PDF…{progress > 0 ? ` ${progress}%` : ''}
              </span>
            </div>
          ) : (
            <div className="rounded-lg bg-white/85 px-6 py-4 text-[12px] t3 shadow-sm">
              PDF 加载失败
            </div>
          )}
        </div>
      )}
    </div>
  )
})
