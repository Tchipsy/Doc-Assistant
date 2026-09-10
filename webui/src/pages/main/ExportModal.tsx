import { useEffect, useRef, useState } from 'react'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { Icon } from '../../lib/icons'
import { api } from '../../api/client'
import { useKbStore } from '../../store/kb'
import { Markdown } from '../../components/Markdown'
import type { AppEvent, ExportMdDoc, PdfExportOptions, PdfPreviewData } from '../../api/types'

/**
 * 导出弹窗：
 * - markdown：按生成配置拼装 + 预览 + 下载
 * - pdf：设置（纸张/边距/栏数/字号缩放/方向）+ HTML 实时预览（防抖请求）
 *   保存后关闭弹窗、后台转换不中断、完成后浏览器下载
 */
const DEFAULT_PDF_OPTS: PdfExportOptions = {
  paper: 'a4', orientation: 'portrait', columns: 2, margin: 4, fontScale: 1,
}

export function ExportModal({ ids, kind, onClose }: {
  ids: string[]
  kind: 'md' | 'pdf'
  onClose: () => void
}) {
  return kind === 'md'
    ? <ExportMdModal ids={ids} onClose={onClose} />
    : <ExportPdfModal ids={ids} onClose={onClose} />
}

function ExportMdModal({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [docs, setDocs] = useState<ExportMdDoc[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.exportMarkdown(ids)
      .then(setDocs)
      .catch((e: any) => setError(String(e?.message ?? e)))
  }, [ids])

  const download = (d: ExportMdDoc) => {
    const blob = new Blob([d.md], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${d.name}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <Modal
      title={ids.length > 1 ? `导出 Markdown（${ids.length} 个文档）` : '导出为 Markdown'}
      width={760}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>关闭</button>
          <button
            className="btn btn-primary"
            disabled={!docs?.length}
            onClick={() => { if (docs) { docs.forEach(download); toast(`已下载 ${docs.length} 个 Markdown 文件`) } }}
          >
            <Icon name="download" size={14} /> 保存并下载{docs && docs.length > 1 ? '全部' : ''}
          </button>
        </>
      }
    >
      {error && <div className="text-[13px]" style={{ color: 'var(--danger)' }}>导出失败：{error}</div>}
      {!docs && !error && <div className="py-10 text-center t3 text-[13px]">正在按生成配置拼装…</div>}
      {docs?.length === 0 && <div className="py-10 text-center t3 text-[13px]">没有可导出的文档（需先生成）</div>}
      {docs?.map(d => (
        <div key={d.docId} className="mb-3">
          <div className="flex items-center gap-2 mb-1.5">
            <Icon name="fileText" size={13} className="t3" />
            <span className="text-[13px] font-medium">{d.name}.md</span>
            {d.warnings?.length > 0 && (
              <span className="badge badge-warn" style={{ fontSize: 10 }} title={d.warnings.join('\n')}>
                {d.warnings.length} 条告警
              </span>
            )}
            <div className="flex-1" />
            <button className="btn btn-sm" onClick={() => download(d)}>
              <Icon name="download" size={12} /> 下载
            </button>
          </div>
          <div className="max-h-[300px] overflow-auto scroll-thin rounded-[9px] border border-line p-3" style={{ background: 'var(--panel-2)' }}>
            <Markdown text={d.md} className="text-[12px]" />
          </div>
        </div>
      ))}
    </Modal>
  )
}

function ExportPdfModal({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [opts, setOpts] = useState<PdfExportOptions>(DEFAULT_PDF_OPTS)
  const [preview, setPreview] = useState<PdfPreviewData | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<number | null>(null)
  const [completed, setCompleted] = useState<{ name: string; url: string } | null>(null)

  // 设置变更 -> 防抖请求 HTML 预览
  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(async () => {
      setPreviewing(true)
      setError(null)
      try {
        const p = await api.pdfPreview(ids[0], opts)
        setPreview(p)
      } catch (e: any) {
        setError(String(e?.message ?? e))
      } finally {
        setPreviewing(false)
      }
    }, 500)
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current) }
  }, [ids, opts])

  // 后台转换完成 -> 自动下载
  useEffect(() => {
    const un = api.subscribeEvents(ev => {
      if (ev.channel === 'export.done') setCompleted({ name: ev.name, url: ev.url })
      if (ev.channel === 'export.error') setError(ev.detail)
    })
    return un
  }, [])

  useEffect(() => {
    if (completed) {
      const a = document.createElement('a')
      a.href = completed.url
      a.download = `${completed.name}.pdf`
      a.click()
      toast(`PDF 转换完成：${completed.name}.pdf 已开始下载`)
      setCompleted(null)
    }
  }, [completed])

  const save = async () => {
    try {
      await api.exportPdf(ids, opts)
      toast(`已提交 PDF 转换（${ids.length} 个文档），转换将在后台进行，完成后自动下载`)
      onClose()
    } catch (e: any) {
      toast(`提交失败：${e?.message ?? e}`, 'error')
    }
  }

  const set = (patch: Partial<PdfExportOptions>) => setOpts(o => ({ ...o, ...patch }))

  return (
    <Modal
      title={ids.length > 1 ? `导出 PDF（${ids.length} 个文档）` : '导出为 PDF'}
      width={900}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={save}>
            <Icon name="download" size={14} /> 保存
          </button>
        </>
      }
    >
      <div className="flex gap-4" style={{ minHeight: 420 }}>
        {/* 左：设置 */}
        <div className="w-[240px] shrink-0 space-y-3">
          <div>
            <div className="label mb-1.5">纸张大小</div>
            <select className="select w-full" value={opts.paper} onChange={e => set({ paper: e.target.value })}>
              <option value="a4">A4</option>
              <option value="a5">A5</option>
              <option value="letter">Letter</option>
            </select>
          </div>
          <div>
            <div className="label mb-1.5">页面方向</div>
            <select className="select w-full" value={opts.orientation} onChange={e => set({ orientation: e.target.value as any })}>
              <option value="portrait">纵向</option>
              <option value="landscape">横向</option>
            </select>
          </div>
          <div>
            <div className="label mb-1.5">栏数</div>
            <select className="select w-full" value={opts.columns} onChange={e => set({ columns: Number(e.target.value) })}>
              <option value={1}>单栏</option>
              <option value={2}>双栏</option>
              <option value={3}>三栏</option>
            </select>
          </div>
          <div>
            <div className="label mb-1.5">页边距（mm）</div>
            <input className="input w-full" type="number" min={0} max={40} step={0.5}
              value={opts.margin} onChange={e => set({ margin: Number(e.target.value) })} />
          </div>
          <div>
            <div className="label mb-1.5">字号缩放（×）</div>
            <input className="input w-full" type="number" min={0.5} max={2} step={0.1}
              value={opts.fontScale} onChange={e => set({ fontScale: Number(e.target.value) })} />
          </div>
          <div className="rounded-[9px] border border-line p-2.5 text-[11.5px] t3 leading-relaxed" style={{ background: 'var(--panel-2)' }}>
            点击「保存」后弹窗关闭，转换在后台进行，完成后浏览器自动下载 PDF。
          </div>
        </div>

        {/* 右：HTML 实时预览 */}
        <div className="min-w-0 flex-1 rounded-[9px] border border-line overflow-hidden relative" style={{ background: '#fff' }}>
          {previewing && (
            <div className="absolute inset-0 z-10 flex items-center justify-center t3 text-[12.5px]" style={{ background: 'rgba(255,255,255,.6)' }}>
              <span className="spin inline-block w-4 h-4 rounded-full border-2 border-primary border-t-transparent mr-2" />
              转换 HTML 预览…
            </div>
          )}
          {error
            ? <div className="p-4 text-[12.5px]" style={{ color: 'var(--danger)' }}>预览失败：{error}</div>
            : preview
              ? <iframe key={JSON.stringify(opts)} srcDoc={preview.html} title="PDF 预览" className="w-full h-full border-0" />
              : <div className="p-4 t3 text-[12.5px]">加载预览…</div>}
        </div>
      </div>
    </Modal>
  )
}
