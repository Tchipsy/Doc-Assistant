import { useCallback, useEffect, useRef, useState } from 'react'
import { useKbStore } from '../../store/kb'
import { useLiveStore } from '../../store/live'
import { LiveView } from '../../components/LiveView'
import { genConfigSummary, resolveDocConfigs } from '../../components/GenConfig'
import { openMenu } from '../../components/ContextMenu'
import { toast } from '../../components/Toast'
import { hasPendingLoc } from '../../lib/router'
import { scrollMemoRestoreWhenReady, scrollMemoSave } from '../../lib/scrollMemo'
import { Icon } from '../../lib/icons'
import type { DocumentItem } from '../../api/types'

/**
 * 主面板：实时预览。
 * - 无产物：居中显示生成配置
 * - 生成中：实时渲染（live tree，流式）
 * - 已完成：产物渲染（artifact tree）
 * 滚动容器是 [data-scroll-root]；跳转一律在其内部滚动，不动整页。
 * 顶栏：文档名双击行内改名 + 全部展开/收缩 + 导出（修改配置只在 CenterConfig 卡片，
 * 有 BottomBar/右键菜单两个入口）。
 * 位置记忆（9.5 步骤7）：onScroll → scrollMemoSave(`live:{docId}`)；切换文档由路由
 * flush 旧，快照加载完成后 restore 新；引用跳转的等待/展开/高亮已收编进路由模块。
 * 步骤8：active = 所在标签是否激活——隐藏标签不得触碰 live store（全局单例，防止
 * 多标签互相顶掉快照），重新激活时重放加载判定并重新恢复滚动位置。
 */
export function PreviewMain({ openConfig, openExport, active = true, onScrollRootChange }: {
  openConfig: (ids: string[]) => void
  openExport: (ids: string[], kind: 'md' | 'pdf') => void
  active?: boolean
  /** 向 MainPage 上报本实例的滚动根（div[data-scroll-root]）→ RightPanel →
   *  useSyncScroll 实例化绑定。不全局 querySelector：keep-alive 多标签下会拿到
   *  最老 kb 标签的根（第二标签同步错根/不触发的根因，9.6 修复） */
  onScrollRootChange?: (el: HTMLElement | null) => void
}) {
  const activeKbId = useKbStore(s => s.activeKbId)
  const activeDocId = useKbStore(s => s.activeDocId)
  const docs = useKbStore(s => (activeKbId ? s.docsByKb[activeKbId] : undefined)) ?? []
  const activeDoc: DocumentItem | undefined = docs.find(d => d.id === activeDocId)

  const liveDocId = useLiveStore(s => s.docId)
  const loading = useLiveStore(s => s.loading)
  const status = useLiveStore(s => s.status)
  const nodes = useLiveStore(s => s.nodes)
  const renamingDocId = useKbStore(s => s.renamingDocId)
  const expandAll = useLiveStore(s => s.expandAll)
  const setExpandAll = useLiveStore(s => s.setExpandAll)
  const scrollRootRef = useRef<HTMLDivElement | null>(null)
  const restoredDocRef = useRef<string | null>(null)
  const scrollRaf = useRef(0)

  // 滚动根元素上报（9.6）：ref 回调保持稳定标识（仅挂载/卸载时触发），
  // 经 state → effect 通知父级（避免渲染期间 setState 或每次重渲 detach/attach）
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const attachScrollRoot = useCallback((el: HTMLDivElement | null) => {
    scrollRootRef.current = el
    setScrollEl(el)
  }, [])
  useEffect(() => {
    onScrollRootChange?.(scrollEl)
  }, [scrollEl, onScrollRootChange])

  const hasTree = Object.keys(nodes).length > 0

  useEffect(() => {
    if (!active) return   // 隐藏标签：不触碰 live store（防多标签 load 互顶）
    if (activeDoc && liveDocId !== activeDoc.id) {
      useLiveStore.getState().load(activeDoc)
    } else if (!activeDoc && liveDocId) {
      useLiveStore.getState().load(null)
    }
  }, [active, activeDoc, liveDocId])

  // 位置记忆：快照加载完成后恢复上次位置（每个文档只恢复一次；
  // 路由定位参数消费进行中则跳过——定位优先，其滚动会自然覆盖记忆。
  // 步骤8：标签失活即重置恢复标记，再激活时重新恢复——display:none 容器的
  // scrollTop 会被清零，靠记忆回填；已恢复场景重复恢复为幂等空操作）
  // debug2 #10：恢复标记随文档切换重置——跨知识库往返同实例二次进入不再被跳过
  useEffect(() => {
    restoredDocRef.current = null
  }, [activeDocId])
  useEffect(() => {
    if (!active) { restoredDocRef.current = null; return }
    if (!activeDocId || liveDocId !== activeDocId || loading || !hasTree) return
    if (restoredDocRef.current === activeDocId) return
    restoredDocRef.current = activeDocId
    if (hasPendingLoc(activeDocId)) return
    const el = scrollRootRef.current
    if (el) scrollMemoRestoreWhenReady(`live:${activeDocId}`, el)
  }, [active, activeDocId, liveDocId, loading, hasTree])

  // 滚动保存：rAF 节流；切换过渡期（live.docId 与 activeDocId 不一致）不保存防串键
  const handleScrollRootScroll = (ev: React.UIEvent<HTMLDivElement>) => {
    if (scrollRaf.current) return
    const el = ev.currentTarget
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0
      const st = useKbStore.getState()
      const live = useLiveStore.getState()
      if (!st.activeDocId || live.docId !== st.activeDocId) return
      scrollMemoSave(`live:${st.activeDocId}`, el)
    })
  }

  // 行内改名联动清理：改名目标文档不再是当前文档时退出编辑态
  //（文档栏右键 = setActiveDoc + startRename 同批更新，不会误清）
  useEffect(() => {
    if (renamingDocId && renamingDocId !== activeDocId) {
      useKbStore.getState().stopRename()
    }
  }, [renamingDocId, activeDocId])

  // 步骤11：居中配置卡展示生效配置（继承中的文档=知识库默认）
  const genCfg = activeDoc ? resolveDocConfigs(activeDoc).gen : null

  if (!activeDoc) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center t3">
          <Icon name="doc" size={40} className="mx-auto mb-3 opacity-40" />
          <div className="text-[13.5px]">选择左侧文档查看实时预览</div>
        </div>
      </div>
    )
  }

  const showConfigCenter = !hasTree && !loading && status !== 'generating'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 border-b border-line px-4 py-2" style={{ background: 'var(--panel)' }}>
        <Icon name="fileText" size={14} className="t3" />
        {renamingDocId === activeDoc.id ? (
          <DocRenameInput doc={activeDoc} />
        ) : (
          <span
            className="text-[13px] font-medium t1 truncate cursor-text"
            title="双击重命名"
            onDoubleClick={() => useKbStore.getState().startRename(activeDoc.id)}
          >
            {activeDoc.name}
          </span>
        )}
        {status === 'generating' && (
          <span className="badge badge-primary flex items-center gap-1" style={{ fontSize: 10.5 }}>
            <span className="spin inline-block w-3 h-3 rounded-full border-[1.5px] border-current border-t-transparent" />
            生成中
          </span>
        )}
        {activeDoc.status === 'queued' && (
          <span className="badge badge-warn flex items-center gap-1" style={{ fontSize: 10.5 }}>
            <span className="spin inline-block w-3 h-3 rounded-full border-[1.5px] border-current border-t-transparent" />
            排队中
          </span>
        )}
        {activeDoc.status === 'parsing' && (
          <span className="badge badge-warn" style={{ fontSize: 10.5 }}>
            解析中
          </span>
        )}
        {/* debug4 #3：链接导入后台抓取中（占位名，完成后自动改名） */}
        {activeDoc.status === 'fetching' && (
          <span className="badge badge-primary flex items-center gap-1" style={{ fontSize: 10.5 }}>
            <span className="spin inline-block w-3 h-3 rounded-full border-[1.5px] border-current border-t-transparent" />
            抓取中
          </span>
        )}
        {activeDoc.status === 'failed' && (
          <span className="badge badge-danger" style={{ fontSize: 10.5 }}>失败</span>
        )}
        <div className="flex-1" />
        {hasTree && (
          <button
            className="btn btn-sm"
            onClick={() => setExpandAll(expandAll !== true)}
            title={expandAll === true ? '全部收缩内容框' : '全部展开内容框'}
          >
            <Icon name={expandAll === true ? 'chevronsUp' : 'chevronsDown'} size={12} />
            {expandAll === true ? '全部收缩' : '全部展开'}
          </button>
        )}
        <button
          className="btn btn-sm"
          disabled={activeDoc.status === 'fetching'}
          title={activeDoc.status === 'fetching' ? '网页内容抓取中，暂无可导出内容' : undefined}
          onClick={e => openMenu(e, [
            { label: '导出为 Markdown', icon: 'fileText', onClick: () => openExport([activeDoc.id], 'md') },
            { label: '导出为 PDF', icon: 'download', onClick: () => openExport([activeDoc.id], 'pdf') },
          ])}
        >
          <Icon name="download" size={12} /> 导出
        </button>
      </div>

      {/* 预览主体（内部滚动）；抓取中的链接导入文档无产物，显示占位而非配置卡 */}
      {activeDoc.status === 'fetching' ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="text-center t3 py-16 text-[13px]">
            <span className="spin inline-block w-5 h-5 rounded-full border-2 border-primary border-t-transparent mb-3" />
            <div>网页内容抓取中，完成后自动改名为网页标题并进入待生成…</div>
          </div>
        </div>
      ) : showConfigCenter ? (
        <CenterConfig
          doc={activeDoc}
          openConfig={openConfig}
          genCfg={genCfg!}
          genInherited={resolveDocConfigs(activeDoc).genInherited}
        />
      ) : (
        <div ref={attachScrollRoot} onScroll={handleScrollRootScroll} data-scroll-root className="min-h-0 flex-1 overflow-auto scroll-thin p-6">
          <div className="mx-auto max-w-[820px] card p-8" style={{ background: 'var(--card, #fff)' }}>
            {loading && !hasTree ? (
              <div className="text-center t3 py-16 text-[13px]">
                <span className="spin inline-block w-5 h-5 rounded-full border-2 border-primary border-t-transparent mb-3" />
                <div>加载预览…</div>
              </div>
            ) : (
              <LiveView />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** 顶栏文档名行内改名（双击进入；Enter/失焦保存，Esc 取消） */
function DocRenameInput({ doc }: { doc: DocumentItem }) {
  const [value, setValue] = useState(doc.name)
  const commit = (save: boolean) => {
    useKbStore.getState().stopRename()
    if (!save) return
    const v = value.trim()
    if (!v || v === doc.name) return   // 空值/未变不提交
    useKbStore.getState().renameDoc(doc.id, v)
      .then(() => toast('已重命名'))
      .catch((e: any) => toast(`重命名失败：${e?.message ?? e}`, 'error'))
  }
  return (
    <input
      className="doc-title-input"
      autoFocus
      value={value}
      onChange={e => setValue(e.target.value)}
      onFocus={e => e.currentTarget.select()}
      onKeyDown={e => {
        if (e.key === 'Enter') commit(true)
        else if (e.key === 'Escape') commit(false)
      }}
      onBlur={() => commit(true)}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    />
  )
}

/** 居中显示生成配置（无产物时）。步骤11 配置继承：继承中的文档「开始生成」
 *  不落地配置（保持继承，后端生成时按库默认解析）；显式文档按原逻辑应用。 */
function CenterConfig({ doc, openConfig, genCfg, genInherited }: {
  doc: DocumentItem
  openConfig: (ids: string[]) => void
  genCfg: ReturnType<typeof resolveDocConfigs>['gen']
  genInherited: boolean
}) {
  const start = async () => {
    const store = useKbStore.getState()
    if (!genInherited) await store.applyGenConfig([doc.id], genCfg)
    await store.startGeneration([doc.id])
  }
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-[560px] card p-6">
        <div className="flex items-center gap-2 mb-1">
          <Icon name="sliders" size={15} className="t2" />
          <span className="text-[14px] font-semibold t1">文档生成配置</span>
          {genInherited && (
            <span className="badge badge-primary" style={{ fontSize: 10.5 }}>继承自知识库</span>
          )}
        </div>
        <div className="t3 text-[12px] mb-4">
          {genConfigSummary(genCfg)}{genInherited ? '（继承自知识库）' : ''}（可在底边栏或右键修改）
        </div>
        <div className="rounded-[9px] border border-line p-3 text-[12.5px] t2" style={{ background: 'var(--panel-2)' }}>
          点击「开始生成」后：pass1 整理 + pass2 插件内容将<b>流式实时渲染</b>到本窗口。
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button className="btn btn-primary" onClick={start}>
            <Icon name="sparkles" size={14} /> 开始生成
          </button>
          <button className="btn" onClick={() => openConfig([doc.id])}>
            <Icon name="pencil" size={13} /> 修改配置
          </button>
          <div className="flex-1" />
          {doc.status === 'ready' && <span className="badge badge-ok" style={{ fontSize: 10.5 }}>解析完成</span>}
        </div>
      </div>
    </div>
  )
}
