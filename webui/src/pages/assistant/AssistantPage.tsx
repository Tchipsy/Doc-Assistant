import { useEffect, useRef, useState } from 'react'
import { useChatStore, EMPTY_UI } from '../../store/chat'
import { useKbStore } from '../../store/kb'
import { useSettingsStore, modelsOfType } from '../../store/settings'
import { openMenu } from '../../components/ContextMenu'
import { Modal, ConfirmModal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { openInNewTab } from '../../store/tabs'
import { buildRoute } from '../../lib/router'
import { Dropdown } from '../../components/Dropdown'
import { Markdown } from '../../components/Markdown'
import { HoverPreview } from '../../components/HoverPreview'
import { Icon } from '../../lib/icons'
import { attachCiteFlip, cx, timeStr } from '../../lib/utils'
import { scrollMemoFlush, scrollMemoRestoreWhenReady, scrollMemoSave } from '../../lib/scrollMemo'
import { useColumnWidth } from '../../hooks/useResize'
import type {
  ChatMessage, ChatMode, CheckedModel, Citation, Fragment, Segment,
} from '../../api/types'
import { MentionInput } from './MentionInput'

const EMPTY_CHECKED: CheckedModel[] = []

const MODE_LABELS: Record<ChatMode, string> = {
  chat: 'Chat · 自由回答',
  query: 'Query · 仅知识库',
  automatic: 'Automatic · 智能体',
}

const TOOL_LABELS: Record<string, string> = {
  rag_search: '查询知识库',
  web_search: '联网搜索',
  web_fetch: '读取网页',
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']

/** URL 型引用判断（步骤4）：web 片段 anchor 存 URL，点击新标签打开而非知识库跳转 */
export function isWebRef(x: { kind?: string; anchor?: string }): boolean {
  return x.kind === 'web' || /^https?:\/\//.test(x.anchor ?? '')
}

/** ①引用条目的悬停浮卡内容（FragmentRow 用；debug2 #13 前头部 citations 气泡行
 *  与卡内条目冗余已删，CitationChip 随之移除——浮卡统一走 HoverPreview portal） */
function citePreviewBody(title: string, url: string | '', text: string) {
  return (
    <>
      <div className="text-[11px] font-semibold mb-1 t2">{title}</div>
      {url && <div className="text-[10.5px] mb-1 t3 break-all">{url}</div>}
      <div className="text-[11.5px] leading-relaxed">{text}</div>
    </>
  )
}

/** 折叠卡外壳（思维链/工具卡/引用卡共用样式）；open/onToggle 可选受控 */
function Collapsible({ icon, header, children, defaultOpen = false, open: openProp, onToggle }: {
  icon: string
  header: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  open?: boolean
  onToggle?: (open: boolean) => void
}) {
  const [inner, setInner] = useState(defaultOpen)
  const open = openProp ?? inner
  const setOpen = (o: boolean) => (onToggle ? onToggle(o) : setInner(o))
  return (
    <div className="mt-2 rounded-[9px] border border-line overflow-hidden" style={{ background: 'var(--panel-2)' }}>
      <button
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] font-medium t2 hover:bg-hover"
        onClick={() => setOpen(!open)}
      >
        <Icon name={icon} size={12} />
        {header}
        <div className="flex-1" />
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} className="t3" />
      </button>
      {open && <div className="px-3 pb-2.5 text-[12px]">{children}</div>}
    </div>
  )
}

/** 引用跳转（工具卡片段行与引用 chip 共用链路）：URL 导航，路由模块消费定位参数 */
function jumpToFragment(f: { docId: string; anchor: string; text: string }) {
  useKbStore.getState().jumpToAnchor(f.docId, f.anchor, f.text)
}

/** 检索片段行：①序号 +《文档名》+ breadcrumb + 文本摘要；悬停预览（HoverPreview
 *  portal 浮卡，debug2 #13——不再被 Collapsible overflow-hidden 裁剪、贴顶自动翻
 *  下方）、点击跳转（web 片段：点击新标签打开网页，浮卡显示标题+URL+摘要） */
function FragmentRow({ f }: { f: Fragment }) {
  const [hover, setHover] = useState(false)
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null)
  const web = isWebRef(f)
  return (
    <div ref={setRowEl} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        className="flex w-full items-baseline gap-1.5 rounded-md px-1.5 py-1 text-left text-[11.5px] hover:bg-hover"
        onClick={() => (web ? window.open(f.anchor, '_blank', 'noreferrer') : jumpToFragment(f))}
      >
        <span className="shrink-0 font-semibold" style={{ color: 'var(--primary)' }}>
          {CIRCLED[f.n - 1] ?? f.n}
        </span>
        <span className="shrink-0 t2">《{f.docName}》</span>
        {f.breadcrumb && <span className="shrink-0 t3">{f.breadcrumb}</span>}
        <span className="t3 truncate">{(f.text || '').slice(0, 80)}</span>
      </button>
      {hover && (
        <HoverPreview target={rowEl}>
          {citePreviewBody(`${f.docName} ${f.breadcrumb || f.sectionNum}`, web ? f.anchor : '', f.text)}
        </HoverPreview>
      )}
    </div>
  )
}

function toFragments(list: { idx?: number; n?: number; docId: string; docName: string; anchor: string; breadcrumb: string; sectionNum: string; text: string; kind?: 'kb' | 'web'; url?: string }[]): Fragment[] {
  return list.map((c, i) => ({
    n: c.n ?? c.idx ?? i + 1,
    chunkId: '', docId: c.docId, docName: c.docName, anchor: c.anchor,
    breadcrumb: c.breadcrumb, sectionNum: c.sectionNum, text: c.text,
    kind: c.kind, url: c.url,
  }))
}

/** 正文行内 ① 点击（事件委托）：citations[idx] -> 跳转（web 引用新标签打开网页） */
function handleMsgCiteClick(ev: React.MouseEvent, citations: Citation[]) {
  const sup = (ev.target as HTMLElement).closest?.('sup.cite') as HTMLElement | null
  if (!sup) return
  const n = Number(sup.getAttribute('data-ref'))
  const c = citations.find(x => x.idx === n)
  if (!c) return
  if (isWebRef(c)) window.open(c.anchor, '_blank', 'noreferrer')
  else useKbStore.getState().jumpToAnchor(c.docId, c.anchor, c.text)
}

/** 「查询知识库」工具卡：automatic 模式=真实工具段；chat/query=由 citations 合成的只读卡 */
function ToolCard({ seg }: { seg: Extract<Segment, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const label = TOOL_LABELS[seg.name] ?? seg.name
  const fragments = seg.fragments ?? []
  const query = typeof seg.args?.query === 'string' ? (seg.args.query as string) : ''
  return (
    <Collapsible
      icon="search"
      open={open}
      onToggle={setOpen}
      header={
        <>
          <span>{label}</span>
          {query && <span className="t3 font-normal truncate max-w-[300px]">· {query}</span>}
          {fragments.length > 0 && (
            <span className="badge" style={{ fontSize: 9.5 }}>{fragments.length} 片段</span>
          )}
        </>
      }
    >
      {fragments.length > 0 ? (
        fragments.map(f => <FragmentRow key={`${f.docId}-${f.anchor}-${f.n}`} f={f} />)
      ) : seg.result ? (
        <div className="text-[11px] t3 whitespace-pre-wrap">{seg.result}</div>
      ) : (
        <div className="text-[11px] t3 py-1">无结果</div>
      )}
    </Collapsible>
  )
}

/** 思维链段：默认收起，流式中（作为最新段出现时）默认展开 */
function ThinkingBlock({ text, active }: { text: string; active: boolean }) {
  return (
    <Collapsible icon="brain" defaultOpen={active} header={<span>思维链</span>}>
      <div className="whitespace-pre-wrap t3">{text}</div>
    </Collapsible>
  )
}

/** 消息操作条：复制 / 编辑（仅用户消息）/ 对话分支；流式进行中不显示。
 *  debug4 #14 分支两态：user 消息=复制之前的消息、本条内容放回输入框草稿
 *  （includeCurrent=false + draftContent）；assistant 消息=复制该消息及之前（现状）。
 *  导出供单测（debug4-test.mjs 两态调用断言）。 */
export function MessageActions({ msg, onEdit }: { msg: ChatMessage; onEdit?: () => void }) {
  const copy = () => {
    navigator.clipboard.writeText(msg.content).then(
      () => toast('已复制 Markdown'),
      () => toast('复制失败'),
    )
  }
  const branch = () => {
    const call = msg.role === 'user'
      ? useChatStore.getState().branch(msg.id, { includeCurrent: false, draftContent: msg.content })
      : useChatStore.getState().branch(msg.id)
    call.then(
      () => toast('已创建分支会话'),
      e => toast(e?.message ?? String(e)),
    )
  }
  return (
    <div className="mt-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      <button className="btn btn-ghost btn-icon" style={{ height: 26, width: 26 }} title="复制 Markdown" onClick={copy}>
        <Icon name="copy" size={13} />
      </button>
      {msg.role === 'user' && onEdit && (
        <button className="btn btn-ghost btn-icon" style={{ height: 26, width: 26 }} title="编辑并重发（截断其后重新生成）" onClick={onEdit}>
          <Icon name="pencil" size={13} />
        </button>
      )}
      <button
        className="btn btn-ghost btn-icon" style={{ height: 26, width: 26 }}
        title={msg.role === 'user' ? '复制之前的消息，本条放入输入框' : '对话分支（复制该消息及之前）'}
        onClick={branch}
      >
        <Icon name="branch" size={13} />
      </button>
    </div>
  )
}

function MessageView({ msg }: { msg: ChatMessage }) {
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')

  if (msg.role === 'user') {
    return (
      <div className="group flex flex-col items-end">
        {editing ? (
          <div className="w-[76%] min-w-[300px]">
            <textarea className="textarea min-h-[72px]" autoFocus rows={3}
              value={editDraft} onChange={e => setEditDraft(e.target.value)} />
            <div className="mt-1.5 flex justify-end gap-2">
              <button className="btn" onClick={() => setEditing(false)}>取消</button>
              <button className="btn btn-primary" disabled={!editDraft.trim()}
                onClick={() => {
                  const text = editDraft.trim()
                  setEditing(false)
                  useChatStore.getState().regenerate(msg.id, text)
                    .catch(e => toast(e?.message ?? String(e)))
                }}>
                保存并发送
              </button>
            </div>
          </div>
        ) : (
          <div className="max-w-[76%] rounded-2xl rounded-br-md px-3.5 py-2.5 text-[13.5px] text-white whitespace-pre-wrap"
            style={{ background: 'var(--primary)' }}>
            {msg.content}
          </div>
        )}
        <MessageActions msg={msg} onEdit={() => { setEditDraft(msg.content); setEditing(true) }} />
      </div>
    )
  }

  const segs = msg.segments ?? []
  const hasToolSeg = segs.some(s => s.kind === 'tool')
  // chat/query 模式：检索命中放在 citations（无工具段）——消息最前合成只读「查询知识库」卡
  const citations = msg.citations ?? []
  const synthCard = !hasToolSeg && citations.length > 0 ? toFragments(citations) : null
  // [[c:N]] 协议：N = citations 的 idx（全局编号）；旧消息纯 ① 字符无 refs 不转换
  const citeRefs = citations.length > 0 ? toFragments(citations) : []
  const lastKind = segs.length > 0 ? segs[segs.length - 1].kind : null

  return (
    <div className="group flex gap-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--primary-soft)' }}>
        <Icon name="bot" size={15} style={{ color: 'var(--primary)' }} />
      </div>
      <div className="min-w-0 max-w-[86%]">
        <div className="mb-1 flex items-center gap-1.5">
          <span className="text-[12px] font-medium t2">助手</span>
          {msg.model && <span className="badge" style={{ fontSize: 9.5 }}>{msg.model.split('/').pop()}</span>}
          {msg.mode && <span className="badge" style={{ fontSize: 9.5 }}>{msg.mode}</span>}
          {msg.stopped && (
            <span className="badge flex items-center gap-1" style={{ fontSize: 9.5 }}>
              <Icon name="square" size={8} /> 已停止
            </span>
          )}
        </div>
        {/* debug2 #13：头部 citations 气泡行已删（与卡内条目冗余）——引用入口统一为
            合成「查询知识库」卡 / 工具卡片段行 / 正文行内 ① */}
        {synthCard && (
          <Collapsible
            icon="search"
            header={<><span>查询知识库</span><span className="badge" style={{ fontSize: 9.5 }}>{synthCard.length} 片段</span></>}
          >
            {synthCard.map(f => <FragmentRow key={`${f.docId}-${f.anchor}-${f.n}`} f={f} />)}
          </Collapsible>
        )}
        {segs.map((seg, i) => {
          if (seg.kind === 'thinking') {
            return <ThinkingBlock key={i} text={seg.text} active={msg.streaming === true && i === segs.length - 1} />
          }
          if (seg.kind === 'tool') {
            return <ToolCard key={i} seg={seg} />
          }
          return (
            <div key={i} className="md mt-1" onClick={e => handleMsgCiteClick(e, citations)}>
              <Markdown text={seg.text} refs={citeRefs} />
              {msg.streaming && i === segs.length - 1 && <span className="cursor-blink" />}
            </div>
          )
        })}
        {msg.streaming && lastKind !== 'text' && (
          <div className="t3 text-[12.5px] py-1">
            {lastKind === null ? '思考中' : '生成中'}<span className="cursor-blink">…</span>
          </div>
        )}
        {!msg.streaming && <MessageActions msg={msg} />}
      </div>
    </div>
  )
}

export function AssistantPage({ active = true }: { active?: boolean }) {
  const sessions = useChatStore(s => s.sessions)
  const activeId = useChatStore(s => s.activeId)
  const msgs = useChatStore(s => (activeId ? s.msgs[activeId] : undefined)) ?? []
  const sendingSid = useChatStore(s => s.sendingSid)
  // 每会话独立的 模式/模型/知识库（EMPTY_UI 为模块级常量，selector 引用稳定）
  const ui = useChatStore(s => (activeId ? s.ui[activeId] : undefined)) ?? EMPTY_UI
  const store = useChatStore

  // 不能写 s.checkedModels()（每次新数组 → zustand v5 无限重渲染）
  const settings = useSettingsStore(s => s.settings)
  const checked = settings?.checkedModels ?? EMPTY_CHECKED
  const defaults = settings?.defaults

  const kbs = useKbStore(s => s.kbs)
  const { width: sessionW, onHandleDown: onSessionHandle } = useColumnWidth({
    initial: 252, min: 180, max: 400, storageKey: 'col-sessions', side: 'right',
  })

  const [rename, setRename] = useState<{ id: string; title: string } | null>(null)
  const [delId, setDelId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  // 吸底跟随（9.5 步骤7）：距底 <40px 才跟随新内容；恢复历史位置时置 false（上翻不被拽回）；
  // 手动滚回底部重新吸附；发送新消息总是置 true 滚底。
  const stickRef = useRef(true)
  const restoringRef = useRef(false)
  const scrollRaf = useRef(0)

  const lastMsg = msgs[msgs.length - 1]
  // 步骤8：标签再激活标记（同一会话失活→再激活 = true；切会话/首挂 = false）
  const resumedSidRef = useRef<string | null>(null)

  // debug2 #13：正文行内 ① 浮卡贴顶翻转（消息流容器级 mouseover 委托；LiveView 同款共用）
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    return attachCiteFlip(el)
  }, [])

  // 会话切换 / 首次进入 / 标签再激活：flush 旧会话 → 内容就绪后恢复新会话位置
  //（无记忆则默认吸底；隐藏期间 display:none 清零 scrollTop，靠记忆回填；
  //  同会话再激活且原本贴底 → 直接到底部，覆盖隐藏期间流式新增的位移）
  useEffect(() => {
    if (!active) return   // 隐藏标签：不启动恢复轮询（再激活时重跑本 effect）
    scrollMemoFlush()
    const el = listRef.current
    if (!activeId || !el) return
    const resuming = resumedSidRef.current === activeId
    resumedSidRef.current = activeId
    if (resuming && stickRef.current) {
      restoringRef.current = false
      bottomRef.current?.scrollIntoView()
      return
    }
    restoringRef.current = true
    const restored = scrollMemoRestoreWhenReady(`chat:${activeId}`, el, {
      onDone: () => {
        restoringRef.current = false
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight
        stickRef.current = dist < 40
      },
    })
    if (!restored) { restoringRef.current = false; stickRef.current = true }
  }, [activeId, active])

  // 新内容到达：仅当贴底（stickToBottom）才跟随；恢复位置期间不抢滚动
  useEffect(() => {
    if (restoringRef.current || !stickRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs.length, lastMsg?.content, lastMsg?.reasoning])

  const handleListScroll = (ev: React.UIEvent<HTMLDivElement>) => {
    if (scrollRaf.current) return
    const el = ev.currentTarget
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0
      const sid = useChatStore.getState().activeId
      if (sid) scrollMemoSave(`chat:${sid}`, el)
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight
      stickRef.current = dist < 40
    })
  }

  const sendingHere = !!activeId && sendingSid === activeId

  const sessionMenu = (e: React.MouseEvent, id: string) => {
    openMenu(e, [
      { label: '在新标签页打开', icon: 'layout', onClick: () => openInNewTab(buildRoute({ view: 'chat', sessionId: id })) },
      { label: '重命名', icon: 'pencil', onClick: () => setRename({ id, title: sessions.find(s => s.id === id)?.title ?? '' }) },
      {
        label: '生成对话名', icon: 'sparkles', onClick: () => {
          toast('生成中…')
          store.getState().generateTitle(id).then(
            t => toast(`已生成：${t}`),
            err => toast(`生成失败：${err?.message ?? err}`),
          )
        },
      },
      { separator: true, label: '', icon: '' },
      { label: '删除会话', icon: 'trash', danger: true, onClick: () => setDelId(id) },
    ])
  }

  // 步骤12：助手页模型下拉只列聊天类型（未分类旧模型附注在末尾）
  const modelOptions = modelsOfType(checked, 'chat')
    .map(m => ({ value: m.value, label: m.modelId, group: m.providerName }))
  // 未显式选择时显示设置里的默认助手模型（点选默认模型本身 = 存 null，跟随设置）
  const defaultAssistant = settings?.defaults?.assistant ?? null
  const hasDefaultAssistant = !!defaultAssistant && modelOptions.some(m => m.value === defaultAssistant)
  const activeSession = sessions.find(s => s.id === activeId)

  return (
    <div className="flex h-full">
      {/* 会话列表 */}
      <div
        className="relative flex h-full shrink-0 flex-col border-r border-line"
        style={{ background: 'var(--panel)', width: sessionW }}
      >
        <div
          className="absolute right-[-2.5px] top-0 z-10 h-full w-[5px] cursor-col-resize hover:bg-[var(--primary-soft)]"
          style={{ touchAction: 'none' }}
          onPointerDown={onSessionHandle}
        />
        <div className="px-3 pb-2 pt-3">
          <button className="btn btn-soft w-full" onClick={() => store.getState().newSession()}>
            <Icon name="plus" size={14} /> 新建会话
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {sessions.map(s => (
            <div
              key={s.id}
              className={cx(
                'group mb-0.5 cursor-pointer rounded-[9px] px-2.5 py-2 transition-colors',
                s.id === activeId ? 'row-selected' : 'hover:bg-[var(--hover)]',
              )}
              onClick={() => store.getState().selectSession(s.id)}
              onContextMenu={e => sessionMenu(e, s.id)}
            >
              <div className="truncate text-[13px] font-medium">{s.title}</div>
              <div className="mt-0.5 text-[10.5px] t3">{timeStr(s.updatedAt)}</div>
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="pt-12 text-center text-[12.5px] t3">暂无会话</div>
          )}
        </div>
      </div>

      {/* 聊天区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-2.5" style={{ background: 'var(--panel)' }}>
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold t1">{activeSession?.title ?? '新会话'}</span>
          <Dropdown
            options={(Object.keys(MODE_LABELS) as ChatMode[]).map(m => ({ value: m, label: MODE_LABELS[m] }))}
            value={ui.mode}
            onChange={v => store.getState().patchUi({ mode: v as ChatMode })}
            width={190}
          />
          <Dropdown
            options={modelOptions}
            value={ui.model ?? (hasDefaultAssistant ? defaultAssistant! : '')}
            onChange={v => store.getState().patchUi({ model: v && v !== defaultAssistant ? v : null })}
            emptyText="未勾选模型，请前往设置 → 模型服务"
            placeholder="选择模型"
            width={200}
          />
          {/* 联网开关（步骤4）：仅 chat/automatic 可用，query 隐藏 */}
          {ui.mode !== 'query' && (
            <label
              className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-[9px] px-2 py-1.5 text-[12.5px] t2 transition-colors hover:bg-[var(--hover)]"
              title={ui.mode === 'chat'
                ? '开启后助手可联网搜索并阅读网页回答时效性问题'
                : '智能体模式下额外提供联网搜索 / 读取网页工具'}
            >
              <input
                type="checkbox"
                checked={ui.webSearch}
                onChange={() => store.getState().patchUi({ webSearch: !ui.webSearch })}
              />
              <Icon name="globe" size={13} /> 联网
            </label>
          )}
        </div>

        {/* 消息流 */}
        <div ref={listRef} onScroll={handleListScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {msgs.length === 0 && (
            <div className="mx-auto max-w-[520px] pt-[14vh] text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl" style={{ background: 'var(--primary-soft)' }}>
                <Icon name="message" size={22} style={{ color: 'var(--primary)' }} />
              </div>
              <div className="mb-1.5 text-[15px] font-semibold t1">文档助手</div>
              <div className="text-[12.5px] t3 leading-relaxed">
                输入 <b>@</b> 指定知识库（<b>@all</b> 为全部），模型将基于知识库内容回答。<br />
                回答中的 ①②③ 引用可悬停预览、点击跳转到文档原文位置。
              </div>
            </div>
          )}
          <div className="mx-auto max-w-[820px] space-y-5">
            {msgs.map(m => <MessageView key={m.id} msg={m} />)}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* 输入区 */}
        <div className="border-t border-line px-4 py-3" style={{ background: 'var(--panel)' }}>
          <div className="mx-auto max-w-[820px]">
            <MentionInput
              kbs={kbs}
              inputDisabled={sendingHere}
              streaming={sendingHere}
              onSend={(content, kbIds) => {
                stickRef.current = true   // 发送新消息总是滚底
                store.getState().send(content, kbIds, ui.model)
                  .catch(e => toast(e?.message ?? String(e)))
              }}
              onStop={() => store.getState().stop()}
            />
            <div className="mt-1.5 text-center text-[11px] t3">
              内容由 AI 生成，仅供参考 · Enter 发送 / Shift+Enter 换行
            </div>
          </div>
        </div>
      </div>

      {rename && (
        <Modal title="重命名会话" width={400} onClose={() => setRename(null)} footer={
          <>
            <button className="btn" onClick={() => setRename(null)}>取消</button>
            <button className="btn btn-primary" disabled={!rename.title.trim()}
              onClick={() => { store.getState().renameSession(rename.id, rename.title.trim()); setRename(null) }}>
              确认
            </button>
          </>
        }>
          <input className="input" autoFocus value={rename.title}
            onChange={e => setRename({ ...rename, title: e.target.value })} />
        </Modal>
      )}
      {delId && (
        <ConfirmModal
          title="删除会话"
          message={<>确定删除会话「<b>{sessions.find(s => s.id === delId)?.title}</b>」？消息记录将一并删除。</>}
          onConfirm={() => { store.getState().deleteSession(delId!); toast('已删除会话') }}
          onClose={() => setDelId(null)}
        />
      )}
    </div>
  )
}
