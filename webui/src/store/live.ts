import { create } from 'zustand'
import { api } from '../api/client'
import type { AppEvent, DocumentItem, LiveNode, PreviewData, RenderOp } from '../api/types'
import { hydrateTree } from '../lib/renderCache'
import { flushBoxState, getBoxState, setBox } from '../lib/boxState'

/**
 * 实时渲染 store：事件溯源折叠器。
 * - loadSnapshot：拉取组件树快照（生成中 = 服务端实时树；已完成 = 产物树）
 * - applyOp：应用 render.op 事件（insert/append/setmd/update/remove/replace）
 *   append/setmd 只更新对应节点（React 按节点订阅，流式输出只重渲当前节点）
 * - 直通渲染（2026-09-07 debug1）：append/setmd 的新内容**立即上屏**
 *   （reveal[id] 恒 = 全文长度，"已展示"标记），打字机 rAF 泵与 display
 *   前缀层已退役——后端 append 已直通（tree.py 节流移除），前端再做逐字
 *   积压只会重新引入滞后；对标 chat 的流式丝滑度。cursorId 光标与流式框
 *   强制展开保留。若超长段落每帧 renderMarkdown 出现卡顿，再考虑隔帧
 *   合并 setState（观察项，不做预防性优化）。
 * - 渲染缓存（步骤9）：完成态快照 load/reload 时经 hydrateTree 水合 html[id]
 *   （IndexedDB 命中零解析；未命中渲染后写回）；流式期间 html 恒为空，组件回退
 *   同步 renderMarkdown——行为与步骤9 之前完全一致。
 * - 断流自愈（2026-09-07）：append/setmd/update 遇缺失节点、或事件流（重）连
 *   成功（建连 → onResync）→ 防抖 300ms 合并触发一次 reload() 快照重拉
 *   （scheduleResync）。
 */
interface LiveState {
  docId: string | null
  status: DocumentItem['status'] | null
  genConfig: any
  nodes: Record<string, LiveNode>
  /** 步骤9 渲染缓存水合结果：nodeId -> HTML（命中/写回的完整节点渲染值）。
   * 仅完成态快照存在；流式期间不使用（组件回退现场渲染）。 */
  html: Record<string, string>
  /** "已展示"标记（2026-09-07 debug1 起恒 = 节点 md 全长：直通渲染无积压；
   * 保留字段供未来若重新引入平滑渲染时复用，组件不读取） */
  reveal: Record<string, number>
  loading: boolean
  cursorId: string | null      // 正在流式输出的节点（渲染光标）
  /** 事件水位线：快照构建时刻的全局事件 id，之前的 render.op 一律跳过（防重放污染） */
  watermark: number
  lastJump: { anchor: string; text?: string; n: number } | null
  /** 内容框展开全局态：null=跟随各框自身；true/false=全部展开/全部收缩（步骤5 顶栏按钮） */
  expandAll: boolean | null
  /** 手动逐框展开覆盖（expandAll=null 时生效；缺省=false 即收缩） */
  boxOpen: Record<string, boolean>
  load: (doc: DocumentItem | null) => Promise<void>
  applyOp: (ev: { docId?: string; _id?: number; op: RenderOp }) => void
  setStatus: (docId: string, status: string) => void
  reload: () => Promise<void>
  setExpandAll: (v: boolean | null) => void
  toggleBox: (id: string) => void
  consumeJump: () => { anchor: string; text?: string } | null
}

let lastDocId: string | null = null

// ---------- 断流自愈（2026-09-07，SSE 投递层丢事件兜底） ----------
// append/update/setmd 遇到节点缺失（或 SSE 重连成功）说明投递链有空洞：
// 不静默丢——防抖 300ms 合并触发一次快照重拉（reload），避免空洞期间
// 反复全量拉取。onopen resync 与缺失节点共用同一防抖。reload 会重建树
// 并重设 lastId 水位线、清空 reveal/display（现状语义，保持）。
export const RESYNC_DEBOUNCE_MS = 300
let resyncTimer: ReturnType<typeof setTimeout> | null = null

export function scheduleResync(delayMs: number = RESYNC_DEBOUNCE_MS) {
  if (resyncTimer) return                       // 已有待触发的 resync：合并
  resyncTimer = setTimeout(() => {
    resyncTimer = null
    void useLiveStore.getState().reload()
  }, delayMs)
}

/** 完成态快照的渲染缓存水合（步骤9）：流式期间不走缓存（返回空）。 */
async function hydrateSnapshot(docId: string, p: PreviewData | null,
                               fallbackPresetId: string): Promise<Record<string, string>> {
  const nodes = p?.tree?.nodes ?? {}
  if (!nodes.root || p?.status === 'generating') return {}
  return hydrateTree(docId, p?.tree?.presetId ?? fallbackPresetId ?? '', nodes)
}

export const useLiveStore = create<LiveState>((set, get) => ({
  docId: null,
  status: null,
  genConfig: null,
  nodes: {},
  html: {},
  reveal: {},
  loading: false,
  cursorId: null,
  watermark: 0,
  lastJump: null,
  expandAll: null,
  boxOpen: {},

  load: async (doc) => {
    flushBoxState()   // debug2 #10：切换前落盘上一文档的折叠记忆（防 500ms 节流丢尾）
    if (!doc) {
      lastDocId = null
      set({ docId: null, status: null, genConfig: null, nodes: {}, html: {}, reveal: {}, loading: false, watermark: 0,
             expandAll: null, boxOpen: {} })
      return
    }
    set({ loading: true, docId: doc.id })
    lastDocId = doc.id
    try {
      const p = await api.getPreview(doc.id)
      if (lastDocId !== doc.id) return
      // 步骤9：完成态快照先水合渲染缓存（IndexedDB 命中零解析），再整树入库
      // 步骤11：/preview 的 genConfig 为生效配置（继承中的文档=库默认），presetId 优先取它
      const html = await hydrateSnapshot(doc.id, p, p?.genConfig?.presetId ?? doc.genConfig?.presetId)
      if (lastDocId !== doc.id) return
      // debug2 #10：按 anchor 回填各内容框折叠记忆（boxOpen 仍以 nodeId 为键；
      // 持久层键=anchor 跨重建稳定。无记录缺省收缩=false）
      const savedBoxes = getBoxState(doc.id)
      const boxOpen: Record<string, boolean> = {}
      for (const n of Object.values(p?.tree?.nodes ?? {})) {
        if ((n.type === 'summary_box' || n.type === 'plugin_box') && n.props?.anchor) {
          boxOpen[n.id] = savedBoxes[n.props.anchor as string] ?? false
        }
      }
      set({
        status: p?.status ?? doc.status,
        genConfig: p?.genConfig ?? doc.genConfig,
        nodes: p?.tree?.nodes ?? {},
        html,
        reveal: {},
        watermark: (p as any)?.lastId ?? 0,
        loading: false,
        cursorId: null,
        expandAll: null,
        boxOpen,
      })
    } catch {
      if (lastDocId === doc.id) set({ loading: false })
    }
  },

  reload: async () => {
    const docId = get().docId
    if (!docId) return
    try {
      const p: PreviewData | null = await api.getPreview(docId)
      if (p && get().docId === docId) {
        const html = await hydrateSnapshot(docId, p, p.genConfig?.presetId)
        if (get().docId !== docId) return
        set({ status: p.status, genConfig: p.genConfig, nodes: p.tree?.nodes ?? {},
              html,
              reveal: {},
              watermark: (p as any)?.lastId ?? get().watermark })
      }
    } catch { /* 忽略 */ }
  },

  applyOp: (ev) => {
    const cur = get()
    if (ev.docId !== cur.docId || !ev.op) return   // 只折叠当前文档
    if (ev._id && ev._id <= get().watermark) return // 快照之前的重放事件：跳过
    const op = ev.op
    // 自愈：目标节点缺失 = 投递链空洞（总线丢旧保新/断线漏收），防抖触发快照重拉
    if ((op.op === 'append' || op.op === 'setmd' || op.op === 'update')
        && !get().nodes[op.id]) {
      scheduleResync()
    }
    set(s => {
      const nodes = { ...s.nodes }
      const reveal = { ...s.reveal }
      switch (op.op) {
        case 'insert': {
          if (nodes[op.id]) return {}   // 幂等：重复投递不重复插入
          nodes[op.id] = {
            id: op.id, type: op.type, parent: op.parent,
            children: [], props: op.props ?? {}, md: '',
          }
          reveal[op.id] = 0             // 直通渲染：md 从空开始，append 即全文上屏
          const parent = nodes[op.parent]
          if (parent && !parent.children.includes(op.id)) {
            nodes[op.parent] = { ...parent, children: [...parent.children, op.id] }
          }
          return { nodes, reveal, cursorId: op.id }
        }
        case 'append': {
          const n = nodes[op.id]
          if (!n) return {}
          // 2026-09-07 修复：曾写 md: prevLen + op.text——数字与字符串相加把
          // 长度前缀进正文（"0"+text），流式 append 每次都在腐蚀节点文本；
          // 本单测（ssefix-test.mjs）实锤后改为纯文本拼接。
          // 2026-09-07 debug1 直通渲染：新内容立即上屏（reveal 恒=全文长度，
          // 打字机积压层已退役）。
          const next = { ...n, md: (n.md ?? '') + op.text }
          nodes[op.id] = next
          reveal[op.id] = next.md.length
          return { nodes, reveal, cursorId: op.id }
        }
        case 'setmd': {
          const n = nodes[op.id]
          if (!n) return {}
          nodes[op.id] = { ...n, md: op.text }
          reveal[op.id] = op.text.length   // 直通渲染：绝对覆盖立即全文上屏
          return { nodes, reveal }
        }
        case 'update': {
          const n = nodes[op.id]
          if (n) nodes[op.id] = { ...n, props: { ...n.props, ...op.props } }
          return { nodes }
        }
        case 'remove': {
          delete nodes[op.id]
          delete reveal[op.id]
          for (const k of Object.keys(nodes)) {
            const c = nodes[k].children?.filter((x: string) => x !== op.id) ?? []
            if (c.length !== (nodes[k].children?.length ?? 0)) {
              nodes[k] = { ...nodes[k], children: c }
            }
          }
          return { nodes, reveal }
        }
        case 'replace':
          return { nodes: { ...op.nodes }, reveal: {}, html: {}, cursorId: null, watermark: get().watermark }
        default:
          return {}
      }
    })
  },

  setStatus: (docId, status) => {
    if (docId === get().docId) {
      // 重新生成开始：清掉旧快照的缓存渲染（流式节点逐字揭示，不走缓存）
      if (status === 'generating' && Object.keys(get().html).length) {
        set({ status: status as any, html: {} })
      } else {
        set({ status: status as any })
      }
    }
    if (['done', 'failed'].includes(status) && docId === get().docId) {
      // 生成结束：拉产物快照替换实时树（自愈解析漂移）
      get().reload()
    }
  },

  setExpandAll: (v) => {
    set({ expandAll: v })
    // debug2 #10：全局展开/收缩写穿所有内容框的持久记录（"全部展开/收缩"跨
    // 刷新/重启长期生效；写穿以 anchor 为键）
    if (v !== null) {
      const s = get()
      if (s.docId) {
        for (const n of Object.values(s.nodes)) {
          if ((n.type === 'summary_box' || n.type === 'plugin_box') && n.props?.anchor) {
            setBox(s.docId, n.props.anchor as string, v)
          }
        }
      }
    }
  },

  toggleBox: (id) => set(s => {
    const docId = s.docId
    const persist = (nid: string, open: boolean) => {
      const anchor = s.nodes[nid]?.props?.anchor as string | undefined
      if (docId && anchor) setBox(docId, anchor, open)   // debug2 #10：折叠记忆落盘
    }
    if (s.expandAll !== null) {
      // 从全局态切回逐框态：把当前全局值物化到每个框，再单独翻转被点的框
      //（避免"全部展开后收起一个框，其余框跟着收缩"）；物化即写穿持久记录
      const boxOpen: Record<string, boolean> = {}
      for (const n of Object.values(s.nodes)) {
        if (n.type === 'summary_box' || n.type === 'plugin_box') {
          boxOpen[n.id] = s.expandAll
          persist(n.id, s.expandAll)
        }
      }
      boxOpen[id] = !s.expandAll
      persist(id, !s.expandAll)
      return { expandAll: null, boxOpen }
    }
    const next = !(s.boxOpen[id] ?? false)
    persist(id, next)
    return { boxOpen: { ...s.boxOpen, [id]: next } }
  }),

  consumeJump: () => {
    const j = get().lastJump
    if (j) set({ lastJump: null })
    return j ? { anchor: j.anchor, text: j.text } : null
  },
}))

/** 全局 SSE -> liveview 接线（App 挂载时调用一次；返回取消函数供 cleanup，StrictMode 双挂载安全）。
 * 自愈契约：事件流（fetch 版，httpAdapter.subscribeEvents）每次建连成功 →
 * onResync → 防抖 reload 拉快照，兜底断线期间被丢弃/漏收的事件（后端重放
 * 上限 BUFFER_SIZE，不再视为正确性依赖）；20s 无字节看门狗主动断开半开管道
 * 后退避重建，同样经 onResync 自愈。 */
export function wireLiveEvents() {
  return api.subscribeEvents((ev: AppEvent) => {
    if (ev.channel === 'render.op') {
      useLiveStore.getState().applyOp(ev as any)
    } else if (ev.channel === 'doc.status') {
      useLiveStore.getState().setStatus(ev.docId, ev.status)
    } else if (ev.channel === 'doc.generated') {
      useLiveStore.getState().reload()
    }
  }, () => scheduleResync())
}

/** 引用跳转：设置待跳转锚点（主界面组件消费后高亮） */
export function setJump(anchor: string, text?: string) {
  useLiveStore.setState({ lastJump: { anchor, text, n: Date.now() } })
}
