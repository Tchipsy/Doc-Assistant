import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Markdown } from '../../components/Markdown'
import type { PdfViewerHandle } from '../../components/PdfViewer'
import { Icon } from '../../lib/icons'
import { scrollMemoRestoreWhenReady, scrollMemoSave } from '../../lib/scrollMemo'
import { takePendingPdfLoc } from '../../lib/router'
import { useColumnWidth } from '../../hooks/useResize'
import { useSyncScroll } from '../../hooks/useSyncScroll'
import { useLiveStore } from '../../store/live'
import type { DocumentItem } from '../../api/types'

// pdf.js 体积大（~700KB min），动态分包：仅在打开 PDF 文档时加载
const PdfViewer = lazy(() =>
  import('../../components/PdfViewer').then(m => ({ default: m.PdfViewer })))

const SYNC_KEY = 'sync-scroll'   // 同步开关记忆（缺省开）

/**
 * 右边栏：原文档预览，可拖拽调宽、收起展开。
 * - md：pdf2md.md 渲染 + 位置记忆（9.5 步骤7，`src:{docId}`）。
 * - pdf（9.5 步骤6）：PdfViewer（pdf.js 连续滚动查看器）替换 iframe——双向同步滚动
 *   需要程序化读写滚动位置；位置记忆同 key 接入（存绝对 scrollTop）。
 * - 双窗口同步滚动：useSyncScroll（锚点 = 实时窗口 .page-anchor，含旧文档动态补的
 *   锚点）；开关在头部，默认开、localStorage `sync-scroll` 记忆；md 文档或无页码
 *   锚点的 PDF（锚点 0 个）渲染禁用态开关并禁用同步（降级不报错）。
 * - 滚动根实例化（9.6）：liveScrollRoot 由 MainPage 传链（PreviewMain 上报本标签
 *   的 div[data-scroll-root]），useSyncScroll 只绑本实例元素——keep-alive 多标签
 *   下全局 querySelector 会拿到最老 kb 标签的根（错根）。
 */
export function RightPanel({ doc, active = true, liveScrollRoot }: {
  doc: DocumentItem | undefined
  active?: boolean
  /** 本标签实时窗口的滚动根实例（PreviewMain 经 MainPage 传入） */
  liveScrollRoot?: HTMLElement | null
}) {
  const { width, onHandleDown } = useColumnWidth({
    initial: 420, min: 300, max: 780, storageKey: 'col-preview', side: 'left',
  })
  const [collapsed, setCollapsed] = useState(false)
  const [mdText, setMdText] = useState<string | null>(null)
  const mdScrollRef = useRef<HTMLDivElement>(null)
  const restoredDocRef = useRef<string | null>(null)
  const scrollRaf = useRef(0)

  const isPdf = doc?.sourceKind === 'pdf'
  const pdfRef = useRef<PdfViewerHandle | null>(null)
  const [anchorCount, setAnchorCount] = useState(0)
  const [syncOn, setSyncOn] = useState(() => {
    try { return localStorage.getItem(SYNC_KEY) !== '0' } catch { return true }
  })
  const { probe, markPdfProgram } = useSyncScroll({
    docId: doc?.id,
    enabled: !!isPdf && syncOn,
    pdfRef,
    liveEl: liveScrollRoot ?? null,
    onAnchorsChange: setAnchorCount,
  })
  // 实时树就绪探测（boolean 稳定引用，流式 append 不重渲）：锚点索引在其后才有意义
  const liveReady = useLiveStore(s => s.docId === doc?.id && !!s.nodes['root'])
  // debug2 #1：live 完成态信号——生成中流式树的页锚点随解析逐个出现（页标记
  // 已转 span 行），done→reload 整树替换为产物树后本信号翻转，探测 effect
  // 自动重跑补齐最终锚点集（700/2000ms 补探覆盖 reload 完成前的窗口）
  const liveDone = useLiveStore(s => s.docId === doc?.id && s.status !== null && s.status !== 'generating')

  const fileBase = doc ? `/api/files/work/${doc.kbId}/${doc.id}` : ''
  const pdfUrl = isPdf ? `${fileBase}/原文档.pdf` : null

  useEffect(() => {
    setMdText(null)
    if (doc?.sourceKind === 'md') {
      takePendingPdfLoc(doc.id)   // md 文档无 PDF 深链：立即丢弃 p/f 参数（防 pending 滞留）
      fetch(`${fileBase}/pdf2md.md`)
        .then(r => (r.ok ? r.text() : Promise.reject()))
        .then(setMdText)
        .catch(() => setMdText('（无法加载原文）'))
    }
  }, [doc?.id, doc?.sourceKind, fileBase])

  // 离开文档：丢弃未消费的 PDF 深链参数（PdfViewer 加载失败时 pending 不滞留）
  useEffect(() => {
    const id = doc?.id
    return () => { if (id) takePendingPdfLoc(id) }
  }, [doc?.id])

  // 锚点探测：文档/实时树/滚动根实例就绪后重建索引（重试几次覆盖图片加载等布局
  // 变化），anchorCount>0 才启用同步（无锚点 PDF / md 文档渲染禁用态开关降级）。
  // 步骤8：标签再激活时重新探测——display:none 期间 rect 全 0，地标索引已失效；
  // 9.6：liveScrollRoot 入依赖——滚动根实例就绪/切换后立即重探（动态锚点随之可见）
  // debug2 #1：liveDone 入依赖——done→reload 产物树替换后自动重探
  useEffect(() => {
    if (!isPdf || !active) return
    probe()
    const t1 = setTimeout(probe, 700)
    const t2 = setTimeout(probe, 2000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [isPdf, liveReady, liveDone, doc?.id, active, liveScrollRoot])   // eslint-disable-line react-hooks/exhaustive-deps

  // md 分支位置记忆：mdText 就绪后恢复上次滚动位置（每个文档一次；
  // 步骤8：标签失活即重置恢复标记，再激活时重新恢复——display:none 容器 scrollTop 清零）
  // debug2 #10：恢复标记随文档切换重置——跨库往返同实例二次进入不再被跳过
  useEffect(() => {
    restoredDocRef.current = null
  }, [doc?.id])
  useEffect(() => {
    if (!active) { restoredDocRef.current = null; return }
    if (doc?.sourceKind !== 'md' || mdText == null) return
    if (restoredDocRef.current === doc.id) return
    const el = mdScrollRef.current
    if (!el) return
    restoredDocRef.current = doc.id
    scrollMemoRestoreWhenReady(`src:${doc.id}`, el)
  }, [active, doc?.id, doc?.sourceKind, mdText])

  const handleMdScroll = (ev: React.UIEvent<HTMLDivElement>) => {
    if (scrollRaf.current || !doc) return
    const el = ev.currentTarget
    const docId = doc.id
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0
      scrollMemoSave(`src:${docId}`, el)
    })
  }

  const toggleSync = () => {
    const next = !syncOn
    setSyncOn(next)
    try { localStorage.setItem(SYNC_KEY, next ? '1' : '0') } catch { /* 隐私模式：忽略 */ }
  }

  if (!doc) return null

  if (collapsed) {
    return (
      <div
        className="flex h-full w-[34px] shrink-0 cursor-pointer flex-col items-center gap-3 border-l border-line py-3 hover:bg-[var(--hover)]"
        style={{ background: 'var(--panel)' }}
        onClick={() => setCollapsed(false)}
        title="展开原文档预览"
      >
        <Icon name="chevronsLeft" size={15} className="t3" />
        <span
          className="text-[11px] t3"
          style={{ writingMode: 'vertical-rl', letterSpacing: 2 }}
        >
          原文档预览
        </span>
      </div>
    )
  }

  return (
    <div className="relative flex h-full shrink-0" style={{ width }}>
      <div
        className="absolute left-[-2.5px] top-0 z-10 h-full w-[5px] cursor-col-resize hover:bg-[var(--primary-soft)]"
        style={{ touchAction: 'none' }}
        onPointerDown={onHandleDown}
      />
      <div className="flex h-full w-full flex-col border-l border-line" style={{ background: 'var(--panel)' }}>
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <Icon name="eye" size={14} className="t3" />
          <span className="text-[12.5px] font-medium t2">原文档预览</span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] t3">{doc.name}.{doc.sourceKind}</span>
          {isPdf && anchorCount > 0 && (
            <button
              className="btn btn-ghost btn-icon shrink-0"
              onClick={toggleSync}
              title={syncOn ? '关闭双窗口同步滚动' : '开启双窗口同步滚动'}
            >
              <Icon
                name="link"
                size={14}
                className={syncOn ? '' : 't3 opacity-45'}
                style={syncOn ? { color: 'var(--primary)' } : undefined}
              />
            </button>
          )}
          {isPdf && anchorCount === 0 && (
            <button
              className="btn btn-ghost btn-icon shrink-0 opacity-45"
              disabled
              title="本文档没有页码锚点，无法同步滚动"
            >
              <Icon name="link" size={14} className="t3" />
            </button>
          )}
          <button className="btn btn-ghost btn-icon shrink-0" onClick={() => setCollapsed(true)} title="收起">
            <Icon name="chevronsRight" size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {doc.sourceKind === 'md' && (
            <div ref={mdScrollRef} onScroll={handleMdScroll} className="scroll-thin h-full overflow-y-auto px-5 py-4">
              <Markdown text={mdText ?? '加载中…'} className="text-[13px] opacity-90" />
            </div>
          )}
          {isPdf && pdfUrl && (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <span className="spin inline-block h-5 w-5 rounded-full border-2 border-primary border-t-transparent" />
                </div>
              }
            >
              <PdfViewer
                key={doc.id}
                ref={pdfRef}
                src={pdfUrl}
                memoKey={`src:${doc.id}`}
                active={active}
                getInitialPos={() => {
                  const loc = takePendingPdfLoc(doc.id)
                  return loc ? { page: loc.p, frac: loc.f } : null
                }}
                onProgramScroll={markPdfProgram}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  )
}
