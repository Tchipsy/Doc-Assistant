import { create } from 'zustand'
import { buildRoute, goDefaultView, navigate, parseHash, type Route } from '../lib/router'
import { useKbStore } from './kb'
import { useChatStore } from './chat'
import { isSettingsSection } from '../pages/settings/sections'
import { toast } from '../components/Toast'
import { uid } from '../lib/id'

/**
 * 标签页 store（9.5 步骤8）——核心模型：标签 = 视图 = 其当前路由。
 *
 * - Tab.route 形如 "#/kb/{库id}[/{文档id}]" / "#/chat/{会话id}"（名词规范 §十一，
 *   不含定位参数 a/p/q——定位是瞬时消费参数，不属于视图身份）。
 * - 路由是视图状态的唯一真相：URL 变化经 adoptRoute 落实到标签（精确命中 → 激活；
 *   与活跃标签同类 → 视图内导航回写当前标签路由；跨类/无标签 → openTab 新建）。
 *   本 store 不反向写 URL（导航一律走 router.navigate，pushState 语义在步骤7）。
 * - 设置页/统计占位页同为普通标签路由（debug5：#/settings[/{section}] 标题「设置」、
 *   #/stats 标题「统计」；settings 非法分区规范化为 #/settings）。标签切换 = active 翻转，
 *   切回主界面/助手标签时各视图位置恢复照常触发（修复旧整页覆盖的卡顿与位置丢失）。
 * - 持久化：localStorage `doc-assistant-tabs`（tabs+activeTabId），任何变更自动落盘；
 *   hydrate() 在启动时按 route 重建、标题从列表数据回填（刷新恢复三件套之一，§5）。
 * - activeAt：最近激活时间戳（Sidebar「主界面/助手/设置/统计」激活最近同类标签的依据）。
 */
export interface Tab {
  id: string
  route: string
  title: string
  /** 最近激活时间（ms）；Sidebar 激活"最近的知识库/会话类标签"用 */
  activeAt?: number
}

const LS_KEY = 'doc-assistant-tabs'
const TAB_LIMIT = 10   // 超过提醒（不硬禁）

interface OpenTabOpts {
  /** false = 只落标签状态不写 URL（adoptRoute 新建分支用，防 navigate↔applyRoute 循环） */
  navigate?: boolean
}

interface AdoptOpts {
  /** true = 浏览器发起的历史回溯（popstate/hashchange/启动深链）：无精确匹配标签时
   *  按路由重建新标签（计划 §4/§5），而不是回写活跃标签；缺省 = 组件内导航（同类回写） */
  fromHistory?: boolean
}

interface TabsState {
  tabs: Tab[]
  activeTabId: string | null
  /** 打开标签：已存在同 route 的标签 → 激活；否则新建并激活（导航性变化 → pushState） */
  openTab: (route: string, title?: string, opts?: OpenTabOpts) => void
  /** 激活标签（用户点击）：导航到该标签当前路由（pushState），adoption 精确命中后置活跃 */
  activate: (id: string) => void
  /** 关闭标签；关活跃标签 → 激活相邻标签；关最后一个 → 落默认视图 */
  close: (id: string) => void
  /** 关闭其他（只留 id） */
  closeOthers: (id: string) => void
  /** 回写标签当前路由（视图内导航；标题随目标视图数据刷新） */
  setRoute: (id: string, route: string) => void
  setTitle: (id: string, title: string) => void
  /**
   * 路由 → 标签同步（App 挂载的路由监听与 TabView 回写都汇聚到这里）：
   * 精确命中 → 激活；历史回溯（fromHistory）且无精确命中 → 按路由重建新标签；
   * 组件内导航且与活跃标签同类 → setRoute 回写；跨类/无标签 → openTab 新建。
   */
  adoptRoute: (route: Route | string, opts?: AdoptOpts) => void
  /** Sidebar 联动：激活最近的同类标签（kb/chat/settings/stats；无同类标签返回 false，调用方走默认导航） */
  activateRecent: (kind: Route['view']) => boolean
  /** 手动落盘（变更时经订阅自动落盘，这里供测试/特殊时机显式调用） */
  persist: () => void
  /** 启动水合：读 localStorage 按 route 重建标签（标题从列表数据回填、非法路由丢弃、
   *  route 去重）；返回是否确实存在持久化数据 */
  hydrate: () => boolean
}

/** 从路由串解析视图类（chat/kb/settings/stats；不可解析 = null） */
export function routeKind(route: string): Route['view'] | null {
  const r = parseHash(route)
  return r ? r.view : null
}

/** 从 store 数据推导视图标题（打开/回写路由/水合回填/改名联动统一走这里） */
function titleFor(r: Route): string {
  if (r.view === 'settings') return '设置'
  if (r.view === 'stats') return '统计'
  if (r.view === 'chat') {
    const s = useChatStore.getState().sessions.find(x => x.id === r.sessionId)
    return s?.title || '新会话'
  }
  if (r.view !== 'kb') return '知识库'
  const kb = useKbStore.getState()
  if (r.docId) {
    const doc = (kb.docsByKb[r.kbId] ?? []).find(d => d.id === r.docId)
    if (doc) return doc.name
  }
  return kb.kbs.find(k => k.id === r.kbId)?.name ?? '知识库'
}

function canonicalOf(route: Route | string): Route | null {
  const parsed = typeof route === 'string' ? parseHash(route) : route
  if (!parsed) return null
  // debug5：settings 非法分区规范化为无分区（#/settings），防脏路由/旧持久化数据
  // 形成渲染同内容却互不相同的"幽灵标签"身份；合法分区原样保留
  if (parsed.view === 'settings') {
    return { view: 'settings', section: isSettingsSection(parsed.section) ? parsed.section : undefined }
  }
  return parsed
}

/** 生成"激活 id 标签"的状态切片（activeTabId + 该标签 activeAt 刷新） */
function activationOf(tabs: Tab[], current: string | null, id: string):
  { tabs: Tab[]; activeTabId: string } | null {
  if (current === id) return null
  return {
    activeTabId: id,
    tabs: tabs.map(t => (t.id === id ? { ...t, activeAt: Date.now() } : t)),
  }
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: (route, title, opts) => {
    const parsed = canonicalOf(route)
    if (!parsed) return
    const hash = buildRoute(parsed)
    const s = get()
    const existing = s.tabs.find(t => t.route === hash)
    if (existing) {
      const act = activationOf(s.tabs, s.activeTabId, existing.id)
      if (act) set(act)
      if (opts?.navigate !== false) navigate(parsed)
      return
    }
    if (s.tabs.length >= TAB_LIMIT) {
      toast(`标签页已超过 ${TAB_LIMIT} 个，建议关闭不用的标签页`)
    }
    const tab: Tab = { id: uid('tab'), route: hash, title: title ?? titleFor(parsed), activeAt: Date.now() }
    set({ tabs: [...s.tabs, tab], activeTabId: tab.id })
    if (opts?.navigate !== false) {
      // pushState + applyRoute：adoption 精确命中刚建的标签，激活态保持一致
      navigate(parsed)
    }
  },

  activate: (id) => {
    const s = get()
    if (s.activeTabId === id) return
    const tab = s.tabs.find(t => t.id === id)
    if (!tab) return
    const parsed = parseHash(tab.route)
    if (parsed) {
      navigate(parsed)   // 走路由：校验（已删对象 → toast 回落）+ pushState 历史
      return
    }
    const act = activationOf(s.tabs, s.activeTabId, id)
    if (act) set(act)
  },

  close: (id) => {
    const s = get()
    const idx = s.tabs.findIndex(t => t.id === id)
    if (idx === -1) return
    const tabs = s.tabs.filter(t => t.id !== id)
    const wasActive = s.activeTabId === id
    // 关活跃标签 → 激活相邻标签（优先右侧，其次左侧）
    const next = wasActive ? (tabs[idx] ?? tabs[idx - 1] ?? null) : null
    if (next) {
      set({ tabs, ...activationOf(tabs, s.activeTabId, next.id) })
    } else {
      set({ tabs, activeTabId: wasActive ? null : s.activeTabId })
    }
    if (!wasActive) return
    if (next) {
      const parsed = parseHash(next.route)
      if (parsed) { navigate(parsed); return }
    }
    // 最后一个标签已关：落默认视图（kb 会经 adoption 重建标签）
    goDefaultView('kb', { replace: true })
  },

  closeOthers: (id) => {
    const s = get()
    const keep = s.tabs.find(t => t.id === id)
    if (!keep) return
    if (s.activeTabId === id) {
      set({ tabs: [keep] })
    } else {
      set({ tabs: [keep], ...activationOf([keep], s.activeTabId, id) })
      const parsed = parseHash(keep.route)
      if (parsed) navigate(parsed)
    }
  },

  setRoute: (id, route) => {
    const parsed = canonicalOf(route)
    if (!parsed) return
    const hash = buildRoute(parsed)
    set(s => ({
      tabs: s.tabs.map(t => (t.id === id && t.route !== hash
        ? { ...t, route: hash, title: titleFor(parsed) }
        : t)),
    }))
  },

  setTitle: (id, title) => {
    set(s => ({ tabs: s.tabs.map(t => (t.id === id ? { ...t, title } : t)) }))
  },

  adoptRoute: (route, opts) => {
    const parsed = canonicalOf(route)
    if (!parsed) return
    const hash = buildRoute(parsed)
    const fromHistory = opts?.fromHistory ?? consumeHistoryNav()
    const s = get()
    const exact = s.tabs.find(t => t.route === hash)
    if (exact) {
      const act = activationOf(s.tabs, s.activeTabId, exact.id)
      if (act) set(act)
      return
    }
    if (fromHistory) {
      // 历史回溯/深链（计划 §4/§5）：对应视图（精确路由）没有标签开着 → 按路由重建
      get().openTab(hash, undefined, { navigate: false })
      return
    }
    const active = s.tabs.find(t => t.id === s.activeTabId)
    if (active && routeKind(active.route) === routeKind(hash)) {
      // 同类视图内导航（切库/切文档/切会话）：回写当前标签的路由（标签=视图=其当前路由）
      get().setRoute(active.id, hash)
      return
    }
    // 跨类或当前无标签：为新路由开标签（不再 navigate，防循环）
    get().openTab(hash, undefined, { navigate: false })
  },

  activateRecent: (kind) => {
    const tabs = get().tabs.filter(t => routeKind(t.route) === kind)
    if (!tabs.length) return false
    const recent = tabs.reduce((a, b) => ((b.activeAt ?? 0) >= (a.activeAt ?? 0) ? b : a))
    get().activate(recent.id)
    return true
  },

  persist: () => {
    const { tabs, activeTabId } = get()
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ tabs, activeTabId }))
    } catch { /* 隐私模式/配额满：忽略 */ }
  },

  hydrate: () => {
    let data: { tabs?: unknown; activeTabId?: unknown } | null = null
    try {
      const raw = localStorage.getItem(LS_KEY)
      data = raw ? JSON.parse(raw) : null
    } catch { data = null }
    const rows = Array.isArray(data?.tabs) ? (data!.tabs as Tab[]) : []
    if (!rows.length) return false
    // 校验：route 可解析（canonicalOf 顺带做 settings 非法分区规范化）；route 去重（保留首个）
    const seen = new Set<string>()
    const tabs: Tab[] = []
    for (const row of rows) {
      if (!row || typeof row.route !== 'string') continue
      const parsed = canonicalOf(row.route)
      if (!parsed) continue
      const hash = buildRoute(parsed)
      if (seen.has(hash)) continue
      seen.add(hash)
      tabs.push({
        id: typeof row.id === 'string' ? row.id : uid('tab'),
        route: hash,
        title: titleFor(parsed),   // 标题从列表数据回填（不信任持久化的旧标题）
        activeAt: typeof row.activeAt === 'number' ? row.activeAt : 0,
      })
    }
    if (!tabs.length) return false
    const wanted = typeof data!.activeTabId === 'string' ? data!.activeTabId : null
    const activeTabId = tabs.some(t => t.id === wanted) ? wanted! : tabs[0].id
    set({ tabs, activeTabId })
    return true
  },
}))

/** 右键菜单等处的显式新标签入口（步骤8）：统一走 openTab（去重激活/新建激活） */
export function openInNewTab(route: string, title?: string) {
  useTabsStore.getState().openTab(route, title)
}

// ---------- 历史回溯标记（浏览器发起 vs 组件内导航的区分） ----------

let historyNav = false

/** 标记"下一次路由应用来自浏览器历史"（popstate/hashchange/启动深链）。
 *  App 在 initRouter() 前也调用一次，使启动首个路由（深链/记忆路由）按回溯语义处理。 */
export function markHistoryNav() { historyNav = true }

/** 读取并复位标记（路由监听入口每次应用都要消费，防标记滞留污染后续组件内导航） */
export function consumeHistoryNav(): boolean {
  const v = historyNav
  historyNav = false
  return v
}

// 模块级监听（应用生命周期一次）：浏览器前进/后退/手动改 hash → 置回溯标记。
// 注册早于 router 的 popstate 处理（本模块先于 App useEffect initRouter 执行），
// 保证 applyRoute → adoption 读标记时已就位。
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', markHistoryNav)
  window.addEventListener('hashchange', markHistoryNav)
}

// ---------- 自动持久化 + 标题联动（改名/数据变化 → 标签标题同步） ----------

/** 变更即落盘（tabs 变更频率极低——仅标签操作；hydrate 的 set 也会触发，写回相同数据无副作用） */
useTabsStore.subscribe(() => {
  useTabsStore.getState().persist()
})

/** 文档/知识库/会话改名（或列表刷新）→ 重算各标签标题；有变化才 set */
function refreshTitles() {
  const tabs = useTabsStore.getState().tabs
  let changed = false
  const next = tabs.map(t => {
    const parsed = parseHash(t.route)
    if (!parsed) return t
    const title = titleFor(parsed)
    if (title === t.title) return t
    changed = true
    return { ...t, title }
  })
  if (changed) useTabsStore.setState({ tabs: next })
}

useKbStore.subscribe(() => refreshTitles())
useChatStore.subscribe(() => refreshTitles())
