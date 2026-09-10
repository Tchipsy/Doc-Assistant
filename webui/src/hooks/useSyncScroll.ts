/**
 * 双窗口同步滚动（9.5 步骤6）：实时渲染窗口 ↔ 原文档预览（PdfViewer）。
 * 参考 VSCode Markdown Preview Enhanced。锚点 = 实时窗口 DOM 里的
 * `.page-anchor[data-page]`（后端 liveview/build.py 由 `<!-- page:N -->` 页标记转换，
 * 升序 = 阅读顺序）。
 *
 * 算法（设锚点 i 的页码 p[i]、内容坐标 t[i]；PDF 页顶偏移 P[n]）：
 * - 实时窗口 → PDF：视口中心 c = scrollTop + viewportH/2；取最后一个 t[i] <= c 的锚点，
 *   frac = (c − t[i]) / (t[i+1] − t[i])（末锚点 frac=0），PDF 目标 =
 *   P[p[i]] + frac × (P[p[i]+1] − P[p[i]])，instant 跟随（用户滚实时窗口，PDF 1:1 跟随）。
 * - PDF → 实时窗口：getPos() 的 {page, frac} → 锚点插值 t（pdfPosToLiveTop）→
 *   目标 scrollTop = t − viewportH/2，animateScroll 自绘动画（450ms）。
 * - 防回环：程序滚动前打"程序滚动标记"（带方向与有效期，instant=250ms /
 *   动画=750ms，动画 onDone 提前解除；被未打标动画打断时残留到超期自愈）；
 *   window 捕获阶段的 scroll 监听按事件目标分辨来源窗口，带标记方向的滚动事件
 *   一律忽略——程序滚动绝不回馈，无振荡。标记超时自愈，不会死锁。
 *   位置记忆恢复期间（scrollMemoIsRestoring）整体跳过，避免与位置恢复互相打断。
 * - 滚动根实例化（9.6 修复）：实时窗口滚动根由 PreviewMain 上报、MainPage 经
 *   props 传链（PreviewMain→MainPage→RightPanel）显式传入，只用本实例元素、
 *   不再全局 querySelector（keep-alive 多标签下会拿到最老 kb 标签的
 *   [data-scroll-root]——第二标签 live→pdf 永不触发、pdf→live 滚隐藏标签窗口
 *   的错根根因）。
 * - 降级：锚点 <1 个（模型丢标记/md 文档/树未加载/旧产物 0 标记）→ 两个方向
 *   自动跳过，UI 不报错（RightPanel 据此渲染禁用态开关）；锚点 ≥1 个才启用。
 *   锚点来源：真标记转换 + 旧文档标题页码标注动态补（后端 liveview/build.py）。
 *
 * 几何映射为纯函数导出（liveCenterToPdf / pdfPosToLiveTop / pdfOffsetToPos /
 * resolveLiveRoot），可对"frac 映射与反向映射互逆"做确定性单测。
 */
import { useEffect, useRef } from 'react'
import { animateScroll, clamp } from '../lib/utils'
import { scrollMemoIsRestoring } from '../lib/scrollMemo'
import type { PdfPos, PdfViewerHandle } from '../components/PdfViewer'

/** 页码锚点：page=1 基页码，top=在实时窗口滚动内容坐标系里的纵偏移 */
export interface PageAnchor { page: number; top: number }

// ---------- 纯函数（可单测） ----------

const pageIndexOf = (tops: number[], page: number) =>
  clamp(Math.round(page), 1, tops.length - 1) - 1

/** PDF 绝对偏移 → {page, frac}（tops 末元素 = 总高哨兵，末页 frac 有定义） */
export function pdfOffsetToPos(tops: number[], offset: number): PdfPos {
  let k = 0
  for (let i = 0; i < tops.length - 1; i++) {
    if (tops[i] <= offset) k = i
    else break
  }
  const span = tops[k + 1] - tops[k]
  const frac = span > 0 ? clamp((offset - tops[k]) / span, 0, 1) : 0
  return { page: k + 1, frac }
}

/**
 * 锚点 → PDF 地标位置 Q[i]（与 anchors 等长，单调不减，Q[i] 落在第 p_i 页内）。
 * 每个页码连续段（run）的首锚点取页顶 P[p]；段内其余锚点把
 * [P[p], P[终点]] 按锚点序数均分——终点 = 下一不同页锚点的页顶 P[q]
 * （段后无锚点时 = 本页底 P[p]+span）。
 *
 * 这是计划 §4 公式 P[p[i]] + frac×(P[p[i]+1]−P[p[i]]) 的推广：相邻锚点异页
 * （q = p_i + k）时即 P[p_{i+1}]−P[p_i] 跨页插值；同页多锚点（§5）时不再各自
 * 从页顶重来（那会非单调），而是按 DOM 距离均分页内跨度——前向映射单调，
 * 且与反向映射（pdfPosToLiveTop）精确互逆。
 */
export function buildPdfLandmarks(anchors: PageAnchor[], tops: number[]): number[] {
  const P = (page: number) => tops[pageIndexOf(tops, page)]
  const q: number[] = new Array(anchors.length)
  let s = 0
  while (s < anchors.length) {
    let e = s
    while (e + 1 < anchors.length && anchors[e + 1].page === anchors[s].page) e++
    const p = anchors[s].page
    const terminal = e === anchors.length - 1
    // 段终点：下一不同页锚点的页顶；末段无下一锚点 → 本页底
    const endPage = terminal ? p + 1 : anchors[e + 1].page
    const start = P(p)
    const end = Math.max(P(endPage), start)
    const div = terminal ? e - s : e + 1 - s   // 末段把终点分配给最后一个锚点
    for (let j = s; j <= e; j++) {
      q[j] = start + (end - start) * ((j - s) / (div > 0 ? div : 1))
    }
    s = e + 1
  }
  // 防御：页码异常回退（模型输出乱序）时钳制保证全局单调不减
  for (let j = 1; j < q.length; j++) {
    if (q[j] < q[j - 1]) q[j] = q[j - 1]
  }
  return q
}

/**
 * 实时窗口视口中心 c（内容坐标）→ PDF 目标 {page, frac}。
 * 取最后一个 t[i] <= c 的锚点，段内分数映射到 Q[i]→Q[i+1]（末锚点 frac=0），
 * 再折算为 {page, frac}。无锚点/中心在首锚点上方 → null（不动）。
 */
export function liveCenterToPdf(anchors: PageAnchor[], tops: number[], c: number): PdfPos | null {
  if (anchors.length === 0 || tops.length < 2) return null
  const Q = buildPdfLandmarks(anchors, tops)
  let i = -1
  for (let k = 0; k < anchors.length; k++) {
    if (anchors[k].top <= c) i = k
    else break
  }
  if (i < 0) return null
  let frac = 0
  if (i + 1 < anchors.length) {
    const span = anchors[i + 1].top - anchors[i].top
    if (span > 0) frac = clamp((c - anchors[i].top) / span, 0, 1)
  }
  const next = Q[i + 1] ?? Q[i]
  return pdfOffsetToPos(tops, Q[i] + frac * (next - Q[i]))
}

/**
 * PDF {page, frac} → 实时窗口内容坐标 t（调用方再减 viewportH/2 得 scrollTop）。
 * 偏移 x = P[page] + frac×页高，在 (Q[i], t[i]) 分段线性对应关系上反插值——
 * 与 liveCenterToPdf 精确互逆；x 在首/末地标之外时钳制到首/末锚点。
 * {page, frac:0} 精确落在该页首个锚点（计划 §4「找锚点 p[i]==page」语义）。
 * 无锚点 → null。
 */
export function pdfPosToLiveTop(
  anchors: PageAnchor[], tops: number[], page: number, frac: number,
): number | null {
  if (anchors.length === 0 || tops.length < 2) return null
  const Q = buildPdfLandmarks(anchors, tops)
  const pi = pageIndexOf(tops, page)
  const span = Math.max(0, tops[pi + 1] - tops[pi])
  const x = tops[pi] + clamp(frac, 0, 1) * span
  const last = anchors.length - 1
  if (x <= Q[0]) return anchors[0].top
  if (x >= Q[last]) return anchors[last].top
  let i = 0
  for (let k = 0; k < anchors.length; k++) {
    if (Q[k] <= x) i = k
    else break
  }
  const dq = Q[i + 1] - Q[i]
  if (dq <= 0) return anchors[i].top
  const dt = anchors[i + 1].top - anchors[i].top
  return anchors[i].top + (dt > 0 ? ((x - Q[i]) / dq) * dt : 0)
}

// ---------- Hook ----------

const INSTANT_MARK_MS = 250    // instant 程序滚动的标记有效期（滚动事件 1~2 帧内到齐）
const ANIM_MARK_MS = 750       // 动画程序滚动（450ms）的标记有效期（onDone 提前解除）

/**
 * 实例化滚动根解析（9.6 修复）：只认显式传入的本实例滚动根，断连 → null
 * （同步静默禁用）。旧实现全局 `document.querySelector('[data-scroll-root]')`
 * 并缓存到 disconnect——keep-alive 多标签下永远拿到最老 kb 标签的根。
 * 纯函数导出供 step6-test 单测（构造两个 root 断言各自绑定）。
 */
export function resolveLiveRoot(el: HTMLElement | null | undefined): HTMLElement | null {
  return el && el.isConnected ? el : null
}

export interface SyncScrollController {
  /** 主动重建锚点索引并上报数量（文档/树就绪后调用，用于开关显隐与降级） */
  probe: () => void
  /** PdfViewer 程序滚动（恢复/深链/重排）前的标记回调，透传给 onProgramScroll */
  markPdfProgram: (ms?: number) => void
}

export function useSyncScroll(opts: {
  docId: string | undefined
  /** 总开关（右栏同步按钮）；false 时两个方向都不动 */
  enabled: boolean
  pdfRef: React.RefObject<PdfViewerHandle | null>
  /** 本实例的实时窗口滚动根（PreviewMain 的 div[data-scroll-root]，props 传链）；
   *  缺省/断连 = 同步静默禁用（不回退全局查询） */
  liveEl?: HTMLElement | null
  /** 锚点数量变化上报（0 = 无锚点文档，RightPanel 据此渲染禁用态开关） */
  onAnchorsChange?: (count: number) => void
}): SyncScrollController {
  const { docId, enabled, pdfRef, liveEl, onAnchorsChange } = opts

  const anchorsRef = useRef<{ list: PageAnchor[]; height: number } | null>(null)
  const progRef = useRef<{ side: 'live' | 'pdf'; until: number } | null>(null)
  const liveElRef = useRef<HTMLElement | null>(null)
  liveElRef.current = liveEl ?? null
  const rafRef = useRef(0)
  const pendingDirRef = useRef<'live' | 'pdf' | null>(null)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const cbRef = useRef(onAnchorsChange)
  cbRef.current = onAnchorsChange

  /** 实时窗口滚动根：只用本实例传入元素（resolveLiveRoot），不再缓存全局查询 */
  const getLiveEl = (): HTMLElement | null => resolveLiveRoot(liveElRef.current)

  const markProgram = (side: 'live' | 'pdf', ms: number) => {
    progRef.current = { side, until: performance.now() + ms }
  }
  const isProgram = (side: 'live' | 'pdf'): boolean => {
    const p = progRef.current
    if (!p) return false
    if (performance.now() > p.until) { progRef.current = null; return false }
    return p.side === side
  }

  /** 重建锚点索引（实时窗口无虚拟化，DOM 位置随时可查；rect 批量读取） */
  const ensureAnchors = (): PageAnchor[] | null => {
    const root = getLiveEl()
    if (!root) return null
    const h = root.scrollHeight
    const cache = anchorsRef.current
    if (cache && cache.height === h) return cache.list
    const list: PageAnchor[] = []
    const spans = root.querySelectorAll<HTMLElement>('.page-anchor')
    if (spans.length > 0) {
      const rr = root.getBoundingClientRect()
      const st = root.scrollTop
      spans.forEach(sp => {
        const page = Number(sp.dataset.page)
        if (!Number.isFinite(page) || page < 1) return
        list.push({ page, top: sp.getBoundingClientRect().top - rr.top + st })
      })
      list.sort((a, b) => a.top - b.top)
    }
    anchorsRef.current = { list, height: h }
    if (list.length !== (cache?.list.length ?? -1)) cbRef.current?.(list.length)
    return list
  }

  // 实时窗口 → PDF：instant 1:1 跟随
  const syncLiveToPdf = () => {
    if (!enabledRef.current || scrollMemoIsRestoring()) return
    const handle = pdfRef.current
    const root = getLiveEl()
    if (!handle || !root || !root.isConnected) return
    const anchors = ensureAnchors()
    const tops = handle.getPageTops()
    if (!anchors || anchors.length === 0 || !tops) return
    const c = root.scrollTop + root.clientHeight / 2
    const pos = liveCenterToPdf(anchors, tops, c)
    if (!pos) return
    markProgram('pdf', INSTANT_MARK_MS)
    handle.scrollToPos(pos, { instant: true })
  }

  // PDF → 实时窗口：锚点插值 + 自绘动画
  const syncPdfToLive = () => {
    if (!enabledRef.current || scrollMemoIsRestoring()) return
    const handle = pdfRef.current
    const root = getLiveEl()
    if (!handle || !root || !root.isConnected) return
    const pos = handle.getPos()
    const anchors = ensureAnchors()
    const tops = handle.getPageTops()
    if (!pos || !anchors || anchors.length === 0 || !tops) return
    const top = pdfPosToLiveTop(anchors, tops, pos.page, pos.frac)
    if (top == null) return
    const max = Math.max(0, root.scrollHeight - root.clientHeight)
    const to = clamp(top - root.clientHeight / 2, 0, max)
    // onDone 提前解除防回环标记。注意：动画被未打标动画（目录跳转/引用跳转的
    // scrollToWithin 等 animateScroll 会 cancel 前一个 rAF）打断时 onDone 不会
    // 触发——标记残留到 ANIM_MARK_MS 过期，由 isProgram 的超时清理自愈（不会
    // 死锁；期间 live 方向的用户滚动最多被吞 750ms）。
    markProgram('live', ANIM_MARK_MS)
    animateScroll(root, to, 450, () => { progRef.current = null })
  }

  // 双窗口 scroll 事件汇聚：window 捕获阶段识别来源（scroll 不冒泡但可捕获）
  useEffect(() => {
    const onScroll = (ev: Event) => {
      const target = ev.target
      if (!(target instanceof HTMLElement)) return
      const live = getLiveEl()
      const pdfEl = pdfRef.current?.getScrollEl() ?? null
      const dir = live && target === live ? 'live'
        : pdfEl && target === pdfEl ? 'pdf' : null
      if (!dir || isProgram(dir)) return   // 程序滚动：防回环
      pendingDirRef.current = dir
      if (rafRef.current) return           // rAF 节流（保留最新方向）
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        const d = pendingDirRef.current
        pendingDirRef.current = null
        if (d === 'live') syncLiveToPdf()
        else if (d === 'pdf') syncPdfToLive()
      })
    }
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 文档切换：锚点索引作废并上报 0（重新探测前开关禁用）
  useEffect(() => {
    anchorsRef.current = null
    cbRef.current?.(0)
  }, [docId])

  // 滚动根实例切换（配置中心切换/预览主体重挂载）：锚点索引按元素作废，防旧元素
  // 的高度缓存串到新元素（RightPanel 的 probe 效应依赖 liveEl 会随后立即重建）
  useEffect(() => {
    anchorsRef.current = null
    cbRef.current?.(0)
  }, [liveEl])

  // 重新开启同步：立即以实时窗口为基准同步一次（首次挂载不强制同步，位置记忆优先）
  const everRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (everRef.current === null) { everRef.current = enabled; return }
    if (enabled && !everRef.current) syncLiveToPdf()
    everRef.current = enabled
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  return {
    probe: () => { ensureAnchors() },
    markPdfProgram: (ms = INSTANT_MARK_MS) => { markProgram('pdf', ms) },
  }
}
