import { create } from 'zustand'
import { api } from '../api/client'
import { navigate, goDefaultView } from '../lib/router'
import type {
  ChatMessage, ChatMode, ChatSession, ChatStreamHandlers, Fragment,
  Segment, ToolCallLog,
} from '../api/types'

/** 每会话独立的 模式/模型/知识库/联网开关/输入草稿（9.5 步骤2/步骤4） */
export interface SessionUi {
  mode: ChatMode
  model: string | null
  kbIds: string[]
  webSearch: boolean
  draft: string
}

const DEFAULT_UI: SessionUi = { mode: 'chat', model: null, kbIds: [], webSearch: false, draft: '' }
export const EMPTY_UI = DEFAULT_UI // 供组件 selector 兜底（模块级常量，稳定引用）

function uiOf(s: ChatSession): SessionUi {
  return { mode: s.mode ?? 'chat', model: s.model ?? null, kbIds: s.kbIds ?? [], webSearch: !!s.webSearch, draft: '' }
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as any).name === 'AbortError'
}

/** 确保分段列表 index 处为指定 kind 的段并追加 delta（帧乱序/缺段兜底） */
function segAppend(list: Segment[], kind: 'thinking' | 'text',
  index: number | undefined, delta: string): Segment[] {
  const next = [...list]
  const target = index ?? next.length
  while (next.length <= target) {
    next.push(kind === 'text' ? { kind: 'text', text: '' } : { kind: 'thinking', text: '' })
  }
  const cur = next[target]
  if (cur.kind !== kind) {
    next[target] = kind === 'text' ? { kind: 'text', text: delta } : { kind: 'thinking', text: delta }
  } else {
    next[target] = { ...cur, text: cur.text + delta }
  }
  return next
}

interface ChatState {
  sessions: ChatSession[]
  activeId: string | null
  msgs: Record<string, ChatMessage[]>
  /** 正在流式回复的会话（同一时刻至多一个流）；null=空闲 */
  sendingSid: string | null
  /** 每会话独立的 模式/模型/知识库/草稿 */
  ui: Record<string, SessionUi>
  init: () => Promise<void>
  newSession: () => Promise<ChatSession | null>
  /** 切换会话（导航性变化 → URL pushState；路由回写走 ensureSessionActive 防环） */
  selectSession: (id: string) => Promise<void>
  /** 仅激活会话 + 拉取消息（不写 URL；路由模块同步 store 时使用） */
  ensureSessionActive: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  /** 修改当前会话的独立设置（mode/model/kbIds/webSearch 变更即 PATCH 持久化） */
  patchUi: (patch: Partial<Omit<SessionUi, 'draft'>>) => void
  setDraft: (draft: string) => void
  send: (content: string, kbIds: string[], model: string | null) => Promise<void>
  /** 停止键：中止当前 SSE 流（后端保存已生成部分） */
  stop: () => void
  /** 编辑用户消息：原位替换 + 截断其后 + 重新生成 */
  regenerate: (messageId: string, content: string) => Promise<void>
  /** 对话分支：复制该消息及之前的全部到新会话并选中。
   *  debug4 #14：opts.includeCurrent=false 时不复制该消息本身（user 消息分支=
   *  复制之前的消息，本条内容经 draftContent 放回输入框）；新会话创建选中后把
   *  draftContent 写入该会话草稿 ui[sess.id].draft（纯前端草稿，刷新丢失可接受） */
  branch: (messageId: string, opts?: { includeCurrent?: boolean; draftContent?: string }) => Promise<void>
  /** 生成对话名 */
  generateTitle: (id: string) => Promise<string | null>
}

// 停止键用：AbortController 不进 zustand 状态（无渲染意义）
let abortCtl: AbortController | null = null

export const useChatStore = create<ChatState>((set, get) => {
  /** 更新一条消息（流式帧驱动） */
  const patchMsg = (sessionId: string, msgId: string,
    fn: (m: ChatMessage) => Partial<ChatMessage>) => {
    set(st => {
      const list = [...(st.msgs[sessionId] ?? [])]
      const idx = list.findIndex(m => m.id === msgId)
      if (idx === -1) return {}
      list[idx] = { ...list[idx], ...fn(list[idx]) }
      return { msgs: { ...st.msgs, [sessionId]: list } }
    })
  }

  /** 统一构造 SSE 帧处理器（send 与 regenerate 共用） */
  const streamHandlers = (sessionId: string, aiId: string): ChatStreamHandlers => ({
    onSession: (sid: string, title: string) => set(st => ({
      sessions: st.sessions.some(x => x.id === sid)
        ? st.sessions.map(x => (x.id === sid ? { ...x, title } : x))
        : [{ id: sid, title, createdAt: '', updatedAt: '' }, ...st.sessions],
      activeId: sid,
    })),
    onDelta: (d: string, seg?: number) => patchMsg(sessionId, aiId, m => ({
      segments: segAppend(m.segments ?? [], 'text', seg, d),
      content: m.content + d,
    })),
    onReasoning: (d: string, seg?: number) => patchMsg(sessionId, aiId, m => ({
      segments: segAppend(m.segments ?? [], 'thinking', seg, d),
      reasoning: (m.reasoning ?? '') + d,
    })),
    onCitations: (cs: any[]) => patchMsg(sessionId, aiId, () => ({ citations: cs })),
    onToolCall: (name: string, args: any, seg?: number, callId?: string) => patchMsg(sessionId, aiId, m => {
      const toolSeg: Segment = {
        kind: 'tool', callId: callId ?? `call-${(m.segments ?? []).length}`,
        name, args, result: '', fragments: [],
      }
      const list = [...(m.segments ?? [])]
      if (seg != null && seg >= list.length) {
        while (list.length < seg) list.push({ kind: 'text', text: '' })
        list.push(toolSeg)
      } else if (seg != null) {
        list[seg] = toolSeg
      } else {
        list.push(toolSeg)
      }
      const tc: ToolCallLog = { callId: toolSeg.callId, name, arguments: args }
      return { segments: list, toolCalls: [...(m.toolCalls ?? []), tc] }
    }),
    onToolResult: (name: string, result: string, seg?: number, callId?: string,
      fragments?: Fragment[]) => patchMsg(sessionId, aiId, m => {
      const list = [...(m.segments ?? [])]
      let idx = list.findIndex(s => s.kind === 'tool' && callId && s.callId === callId)
      if (idx === -1 && seg != null && list[seg]?.kind === 'tool') idx = seg
      const cur = idx >= 0 ? list[idx] : undefined
      if (cur && cur.kind === 'tool') {
        list[idx] = { ...cur, result, fragments: fragments ?? cur.fragments }
      }
      const tcs = [...(m.toolCalls ?? [])]
      const ti = callId ? tcs.findIndex(t => t.callId === callId) : tcs.length - 1
      if (ti >= 0 && tcs[ti]) tcs[ti] = { ...tcs[ti], result, fragments }
      return { segments: list, toolCalls: tcs }
    }),
  })

  /** 流式收尾（send/regenerate 共用）：正常/中止不打错误标记，异常追加提示 */
  const finishStream = async (sessionId: string, aiId: string, err: unknown) => {
    if (err && !isAbort(err)) {
      const msg = err instanceof Error ? err.message : String(err)
      patchMsg(sessionId, aiId, m => ({
        streaming: false, content: m.content + (m.content ? '\n\n' : '') + `> ⚠️ 发送失败：${msg}`,
      }))
    } else {
      patchMsg(sessionId, aiId, () => ({ streaming: false }))
    }
    abortCtl = null
    set({ sendingSid: null })
    const sessions = await api.listSessions()
    set(st => {
      const ui = { ...st.ui }
      for (const x of sessions) if (!ui[x.id]) ui[x.id] = uiOf(x)
      return { sessions, ui }
    })
  }

  return {
    sessions: [],
    activeId: null,
    msgs: {},
    sendingSid: null,
    ui: {},

    init: async () => {
      const sessions = await api.listSessions()
      const ui: Record<string, SessionUi> = {}
      for (const s of sessions) ui[s.id] = uiOf(s)
      const msgs: Record<string, ChatMessage[]> = {}
      if (sessions[0]) msgs[sessions[0].id] = await api.listMessages(sessions[0].id)
      set({ sessions, activeId: sessions[0]?.id ?? null, msgs, ui })
    },

    newSession: async () => {
      const sess = await api.createSession()
      set(s => ({
        sessions: [sess, ...s.sessions],
        activeId: sess.id,
        msgs: { ...s.msgs, [sess.id]: [] },
        ui: { ...s.ui, [sess.id]: uiOf(sess) },
      }))
      navigate({ view: 'chat', sessionId: sess.id })
      return sess
    },

    selectSession: async (id) => {
      await get().ensureSessionActive(id)
      navigate({ view: 'chat', sessionId: id })
    },

    ensureSessionActive: async (id) => {
      set(st => {
        if (st.ui[id]) return { activeId: id }
        const row = st.sessions.find(x => x.id === id)
        return {
          activeId: id,
          ui: { ...st.ui, [id]: uiOf(row ?? { id, title: '', createdAt: '', updatedAt: '' }) },
        }
      })
      if (!get().msgs[id]) {
        try {
          const list = await api.listMessages(id)
          set(s => ({ msgs: { ...s.msgs, [id]: list } }))
        } catch { /* 会话不存在/网络失败：保留空列表，路由校验负责提示 */ }
      }
    },

    renameSession: async (id, title) => {
      await api.updateSession(id, { title })
      set(s => ({ sessions: s.sessions.map(x => (x.id === id ? { ...x, title } : x)) }))
    },

    deleteSession: async (id) => {
      const wasActive = get().activeId === id
      await api.deleteSession(id)
      set(s => {
        const sessions = s.sessions.filter(x => x.id !== id)
        const msgs = { ...s.msgs }
        const ui = { ...s.ui }
        delete msgs[id]
        delete ui[id]
        return { sessions, msgs, ui, activeId: s.activeId === id ? (sessions[0]?.id ?? null) : s.activeId }
      })
      if (wasActive) {
        const next = get().activeId
        // 活跃会话被删：URL 落到下一个会话（无会话则默认视图）
        if (next) navigate({ view: 'chat', sessionId: next }, undefined, { replace: true })
        else goDefaultView('chat', { replace: true })
      }
    },

    patchUi: (patch) => {
      const sid = get().activeId
      if (!sid) return
      set(st => ({ ui: { ...st.ui, [sid]: { ...(st.ui[sid] ?? DEFAULT_UI), ...patch } } }))
      const persistent: Record<string, unknown> = {}
      if (patch.mode !== undefined) persistent.mode = patch.mode
      if (patch.model !== undefined) persistent.model = patch.model
      if (patch.kbIds !== undefined) persistent.kbIds = patch.kbIds
      if (patch.webSearch !== undefined) persistent.webSearch = patch.webSearch
      if (Object.keys(persistent).length > 0) {
        api.updateSession(sid, persistent as any).catch(() => { /* 设置持久化失败不阻塞 */ })
      }
    },

    setDraft: (draft) => {
      const sid = get().activeId
      if (!sid) return
      set(st => ({ ui: { ...st.ui, [sid]: { ...(st.ui[sid] ?? DEFAULT_UI), draft } } }))
    },

    send: async (content, kbIds, model) => {
      const s = get()
      if (s.sendingSid) {
        throw new Error('当前有会话正在回复中，请先停止或等待完成')
      }
      let sessionId = s.activeId
      if (!sessionId) {
        const sess = await get().newSession()
        sessionId = sess?.id ?? null
      }
      if (!sessionId) return
      const mode = get().ui[sessionId]?.mode ?? 'chat'
      const webSearch = get().ui[sessionId]?.webSearch ?? false
      const now = Date.now()
      const userMsg: ChatMessage = { id: `tmp-u-${now}`, sessionId, role: 'user', content, kbIds }
      const aiMsg: ChatMessage = {
        id: `tmp-a-${now}`, sessionId, role: 'assistant', content: '',
        reasoning: '', toolCalls: [], citations: [], segments: [], kbIds,
        model: model ?? undefined, mode, streaming: true,
      }
      set(st => ({
        sendingSid: sessionId,
        msgs: { ...st.msgs, [sessionId!]: [...(st.msgs[sessionId!] ?? []), userMsg, aiMsg] },
      }))
      const ctl = new AbortController()
      abortCtl = ctl
      let err: unknown = null
      try {
        await api.chat({ sessionId, content, kbIds, model, mode, webSearch },
          streamHandlers(sessionId, aiMsg.id), ctl.signal)
      } catch (e) {
        err = e
      }
      await finishStream(sessionId, aiMsg.id, err)
    },

    stop: () => {
      const sid = get().sendingSid
      if (!sid) return
      abortCtl?.abort()
      set(st => {
        const list = (st.msgs[sid] ?? []).map(m => (m.streaming ? { ...m, streaming: false } : m))
        return { sendingSid: null, msgs: { ...st.msgs, [sid]: list } }
      })
      // 后端正在保存已生成部分（stopped=1），稍后从服务端同步权威版本
      setTimeout(async () => {
        try {
          const list = await api.listMessages(sid)
          set(st => ({ msgs: { ...st.msgs, [sid]: list } }))
        } catch { /* 忽略 */ }
      }, 800)
    },

    regenerate: async (messageId, content) => {
      const s = get()
      const sid = s.activeId
      if (!sid || s.sendingSid) {
        throw new Error('当前有会话正在回复中，请先停止或等待完成')
      }
      const list = s.msgs[sid] ?? []
      const idx = list.findIndex(m => m.id === messageId)
      if (idx === -1 || list[idx].role !== 'user') return
      const kept: ChatMessage[] = [...list.slice(0, idx), { ...list[idx], content }]
      const aiMsg: ChatMessage = {
        id: `tmp-a-${Date.now()}`, sessionId: sid, role: 'assistant', content: '',
        reasoning: '', toolCalls: [], citations: [], segments: [], streaming: true,
      }
      set(st => ({ sendingSid: sid, msgs: { ...st.msgs, [sid]: [...kept, aiMsg] } }))
      const ctl = new AbortController()
      abortCtl = ctl
      let err: unknown = null
      try {
        await api.regenerate(sid, messageId, content, streamHandlers(sid, aiMsg.id), ctl.signal)
      } catch (e) {
        err = e
      }
      await finishStream(sid, aiMsg.id, err)
    },

    branch: async (messageId, opts) => {
      const sid = get().activeId
      if (!sid) return
      const sess = await api.branchSession(sid, messageId,
        { includeCurrent: opts?.includeCurrent ?? true })
      set(st => ({
        sessions: [sess, ...st.sessions],
        // 草稿先行写入（draftContent 非空=分支语义「本条放入输入框」），uiOf 兜底其余字段
        ui: { ...st.ui, [sess.id]: { ...uiOf(sess), draft: opts?.draftContent ?? '' } },
      }))
      const list = await api.listMessages(sess.id)
      set(st => ({ msgs: { ...st.msgs, [sess.id]: list }, activeId: sess.id }))
      navigate({ view: 'chat', sessionId: sess.id })
    },

    generateTitle: async (id) => {
      const res = await api.generateTitle(id)
      set(st => ({ sessions: st.sessions.map(x => (x.id === id ? { ...x, title: res.title } : x)) }))
      return res.title
    },
  }
})
