/**
 * URL 路由模块（9.5 步骤7，名词规范 §十一）——应用外壳的公共地基（步骤3 引用跳转、
 * 步骤6 p/f 参数、步骤8 标签页都建在它上面）。
 *
 * 路由表（hash 形式；标签=视图=其当前路由）：
 *   #/chat/{会话id}          会话视图
 *   #/kb/{库id}              知识库视图（未选中文档）
 *   #/kb/{库id}/{文档id}     知识库视图内选中文档（唯一的文档路由形式）
 *   #/settings[/{分区}]      设置页（debug5 起占标签；非法分区由 tabs 规范化为 #/settings）
 *   #/stats                  统计占位页（debug5 起占标签）
 *   无 hash                  打开 localStorage 记忆的上次活跃视图
 *
 * 定位参数协议（挂在 hash 路由后，优先级 a > p > q）：
 *   ?a={anchor}          复用 findAnchorNode 四锚点命名空间 organized/summary/plugin/image
 *   ?p={页}&f={页内分数} PDF 页定位（步骤6 PdfViewer 落地后消费，双向同步共用语义）
 *   ?q={文本}            文本回退：a 缺失/找不到时滚动到首个文本匹配并高亮
 *
 * 行为约定：
 *   - 导航性变化（打开/激活视图、视图内切文档/会话）→ pushState；滚动/折叠/流式不写 URL。
 *   - 文档被移动知识库 → 以 docId 查 docs.kb_id 静默 replaceState 重定向。
 *   - URL 指向已删除的文档/会话 → toast + 默认视图。
 *   - 单视图阶段（步骤8 之前）：路由直接同步 page / activeKbId / activeDocId / activeId，
 *     现有页面组件零改动；步骤8 只把"单视图"升级为"路由的多路复用"，本模块不返工。
 */
import { useAppStore } from '../store/app'
import { useKbStore } from '../store/kb'
import { useChatStore } from '../store/chat'
import { useLiveStore } from '../store/live'
import { findAnchorNode, revealBoxIfFolded } from '../components/LiveView'
import { toast } from '../components/Toast'
import { firstVisible, scrollToWithin } from './utils'
import { scrollMemoFlush } from './scrollMemo'
import type { DocumentItem, LiveNode } from '../api/types'

// ---------- 类型 ----------

export type Route =
  | { view: 'chat'; sessionId: string }
  | { view: 'kb'; kbId: string; docId?: string }
  | { view: 'settings'; section?: string }
  | { view: 'stats' }

/** 定位参数（优先级 a > p > q） */
export interface RouteLoc {
  /** 目标锚点：organized:{num} / summary:{num} / plugin:{插件名}:{num} / image:{num}:{src} */
  a?: string
  /** PDF 页码（步骤6 后生效） */
  p?: number
  /** 页内分数 0~1（步骤6 后生效） */
  f?: number
  /** 文本回退（目标文本前 ~60 字） */
  q?: string
}

export type RouteListener = (route: Route | null, loc: RouteLoc) => void

// ---------- 解析 / 构建 ----------

/** 解析 hash → 定位参数（未知/无 hash 返回空 loc） */
export function parseHashFull(hash = location.hash): { route: Route | null; loc: RouteLoc } {
  const raw = (hash || '').replace(/^#/, '')
  const qIdx = raw.indexOf('?')
  const path = qIdx === -1 ? raw : raw.slice(0, qIdx)
  const query = qIdx === -1 ? '' : raw.slice(qIdx + 1)
  const loc: RouteLoc = {}
  if (query) {
    try {
      const sp = new URLSearchParams(query)
      const a = sp.get('a')
      const p = sp.get('p')
      const f = sp.get('f')
      const q = sp.get('q')
      if (a) loc.a = a
      if (p != null && /^\d+$/.test(p)) loc.p = Number.parseInt(p, 10)
      if (f != null && f !== '' && Number.isFinite(Number(f))) loc.f = Number(f)
      if (q) loc.q = q
    } catch { /* 非法 query：忽略定位参数 */ }
  }
  const seg = path.split('/').filter(Boolean)
  if (seg[0] === 'chat' && seg[1]) return { route: { view: 'chat', sessionId: seg[1] }, loc }
  if (seg[0] === 'kb' && seg[1]) {
    return { route: { view: 'kb', kbId: seg[1], docId: seg[2] || undefined }, loc }
  }
  if (seg[0] === 'settings') return { route: { view: 'settings', section: seg[1] || undefined }, loc }
  if (seg[0] === 'stats') return { route: { view: 'stats' }, loc }
  return { route: null, loc: {} }
}

/** 计划 API：parseHash() -> Route | null（无 hash / 前缀不识别 = null） */
export function parseHash(hash = location.hash): Route | null {
  return parseHashFull(hash).route
}

/** 定位参数 → query 串（a > p > f > q 顺序，文本需编码） */
function locQuery(loc?: RouteLoc): string {
  if (!loc) return ''
  const parts: string[] = []
  if (loc.a) parts.push(`a=${encodeURIComponent(loc.a)}`)
  if (loc.p != null) parts.push(`p=${loc.p}`)
  if (loc.f != null) parts.push(`f=${loc.f}`)
  if (loc.q) parts.push(`q=${encodeURIComponent(loc.q)}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

export function buildRoute(r: Route, loc?: RouteLoc): string {
  if (r.view === 'chat') return `#/chat/${r.sessionId}${locQuery(loc)}`
  if (r.view === 'settings') return `#/settings${r.section ? `/${r.section}` : ''}${locQuery(loc)}`
  if (r.view === 'stats') return '#/stats'
  return `#/kb/${r.kbId}${r.docId ? `/${r.docId}` : ''}${locQuery(loc)}`
}

// ---------- 订阅 / 初始化 ----------

const listeners = new Set<RouteListener>()

/** 订阅路由变化（popstate + hashchange + navigate 统一出口） */
export function onRouteChange(cb: RouteListener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function emit(route: Route | null, loc: RouteLoc) {
  for (const cb of [...listeners]) {
    try { cb(route, loc) } catch (e) { console.error('[router] listener error', e) }
  }
}

let started = false

/** 应用启动时调用一次：注册 popstate/hashchange 并消费当前 URL（无 hash → 记忆路由） */
export function initRouter(): () => void {
  if (started) return () => {}
  started = true
  const onPop = () => applyRoute()
  window.addEventListener('popstate', onPop)
  window.addEventListener('hashchange', onPop)
  applyRoute()
  return () => {
    started = false
    window.removeEventListener('popstate', onPop)
    window.removeEventListener('hashchange', onPop)
  }
}

// ---------- 导航 ----------

/**
 * 导航性变化统一入口：pushState（默认）/ replaceState 后立即应用路由。
 * 同路由重复导航（如再次点击同一引用）不新增历史，但会重新消费定位参数（再次跳转高亮）。
 */
export function navigate(r: Route, loc?: RouteLoc, opts: { replace?: boolean } = {}) {
  const hash = buildRoute(r, loc)
  if (location.hash === hash) { applyRoute(); return }
  if (opts.replace) history.replaceState(null, '', hash)
  else history.pushState(null, '', hash)
  applyRoute()
}

/** 侧边栏打开视图（main/assistant/settings/stats——debug5 起四项均为标签路由） */
export function navSidebarPage(page: 'main' | 'assistant' | 'settings' | 'stats') {
  if (page === 'stats') {
    navigate({ view: 'stats' })
    return
  }
  if (page === 'settings') {
    const cur = parseHashFull().route
    navigate({ view: 'settings', section: cur?.view === 'settings' ? cur.section : undefined })
    return
  }
  if (page === 'assistant') {
    const chat = useChatStore.getState()
    const sid = chat.activeId ?? chat.sessions[0]?.id ?? null
    if (sid) { navigate({ view: 'chat', sessionId: sid }); return }
    useAppStore.setState({ page: 'assistant' })   // 无任何会话：仅切页面，不写 URL
    return
  }
  const kb = useKbStore.getState()
  if (kb.activeKbId) {
    navigate({ view: 'kb', kbId: kb.activeKbId, docId: kb.activeDocId ?? undefined })
    return
  }
  useAppStore.setState({ page: 'main' })          // 无任何知识库：仅切页面，不写 URL
}

/** 落到默认视图（第一个知识库 / 第一个会话）；两者皆无则清空 hash */
export function goDefaultView(prefer: 'kb' | 'chat' = 'kb', opts: { replace?: boolean } = {}) {
  const kb = useKbStore.getState()
  const chat = useChatStore.getState()
  const kbRoute: Route | null = kb.kbs[0] ? { view: 'kb', kbId: kb.kbs[0].id } : null
  const chatRoute: Route | null = chat.sessions[0] ? { view: 'chat', sessionId: chat.sessions[0].id } : null
  const r = prefer === 'kb' ? (kbRoute ?? chatRoute) : (chatRoute ?? kbRoute)
  if (r) navigate(r, undefined, opts)
  else clearRoute()
}

function clearRoute() {
  pending = null
  history.replaceState(null, '', location.pathname + location.search)
  emit(null, {})
}

// ---------- 上次活跃视图记忆（无 hash 时打开） ----------

const LAST_ROUTE_KEY = 'doc-assistant-last-route'

function memoryRoute(): Route | null {
  try {
    const h = localStorage.getItem(LAST_ROUTE_KEY)
    if (!h) return null
    return parseHashFull(h).route
  } catch { return null }
}

function rememberLastRoute(r: Route) {
  try { localStorage.setItem(LAST_ROUTE_KEY, buildRoute(r)) } catch { /* 忽略 */ }
}

// ---------- 路由应用（校验 / 重定向 / store 同步 / 定位消费） ----------

/**
 * 应用当前 URL：无 hash → 记忆路由 → 校验（删除/移动重定向）→ 同步 store → 通知订阅者。
 * navigate、popstate、hashchange、启动初始化都汇聚到这里。
 */
export function applyRoute() {
  scrollMemoFlush()   // 路由离开：切换前显式落盘，避免节流丢尾
  let { route, loc } = parseHashFull()
  if (!route) {
    const mem = memoryRoute()
    if (mem) {
      history.replaceState(null, '', buildRoute(mem))
      route = mem
    } else {
      emit(null, {})   // 全新环境：保持 init 默认（第一个知识库/会话）
      return
    }
  }
  const v = validateRoute(route)
  if (!v.route) { clearRoute(); return }
  if (v.missingDocId) {
    // debug2 #7 加固：文档列表可能短暂缺行（刷新/导入/移动的并发窗口）——回落前
    // 异步重拉一次文档列表再重新校验，两次查无才回落（回落 toast 带 docId）。
    const hash = buildRoute(route)
    if (missingDocRetry !== hash) {
      missingDocRetry = hash
      pending = null   // 路由未落实：挂起的定位消费作废
      void (async () => {
        try { await useKbStore.getState().refreshDoc() } catch { /* 拉取失败视同仍查无 */ }
        if (location.hash === hash) applyRoute()   // 重拉完成后重新校验当前 URL
        else if (missingDocRetry === hash) missingDocRetry = null
      })()
      return   // 二次校验期间不应用（保持当前视图原状，等待重拉结果）
    }
    missingDocRetry = null
    toast(`文档不存在或已删除（${v.missingDocId}）`)
  } else {
    missingDocRetry = null
  }
  if (v.redirect) history.replaceState(null, '', buildRoute(v.route))
  rememberLastRoute(v.route)
  if (v.route.view === 'kb' && v.route.docId && (loc.a || loc.p != null || loc.q)) {
    scheduleLocConsume(v.route.docId, loc)
  } else {
    pending = null
  }
  syncStores(v.route)
  emit(v.route, loc)
}

/** 用 store 数据校验路由：文档移动→静默重定向；文档/会话/知识库已删除→回落。
 * 文档回落经 missingDocId 标记带回 applyRoute 统一处理（先重拉列表二次校验一次
 * 才真正回落——#7 加固；toast 也由 applyRoute 发，带 docId 便于排查） */
function validateRoute(route: Route): { route: Route | null; redirect: boolean; missingDocId?: string } {
  if (route.view === 'settings' || route.view === 'stats') return { route, redirect: false }
  const kbStore = useKbStore.getState()
  const chatStore = useChatStore.getState()
  if (route.view === 'chat') {
    if (chatStore.sessions.length && !chatStore.sessions.some(s => s.id === route.sessionId)) {
      toast('会话不存在或已删除')
      return { route: defaultRoute('chat'), redirect: true }
    }
    return { route, redirect: false }
  }
  // kb 视图
  const kbs = kbStore.kbs
  if (route.docId) {
    const realKb = docKbOf(kbStore.docsByKb, route.docId)
    if (realKb && realKb !== route.kbId) {
      // 文档被移动过知识库：以 docId 查 docs.kb_id 为准，静默重定向
      return { route: { view: 'kb', kbId: realKb, docId: route.docId }, redirect: true }
    }
    if (!realKb && kbs.length > 0 && Object.prototype.hasOwnProperty.call(kbStore.docsByKb, route.kbId)) {
      // 各库文档列表已加载且查不到该文档：疑似已删除（applyRoute 会先重拉
      // 列表二次校验一次——列表短暂缺行（并发刷新/导入/移动窗口）不误回落）
      const fb: Route | null = kbs.some(k => k.id === route.kbId)
        ? { view: 'kb', kbId: route.kbId }
        : defaultRoute('kb')
      return { route: fb, redirect: true, missingDocId: route.docId }
    }
  }
  if (kbs.length > 0 && !kbs.some(k => k.id === route.kbId)) {
    toast('知识库不存在或已删除')
    return { route: defaultRoute('kb'), redirect: true }
  }
  return { route, redirect: false }
}

function defaultRoute(prefer: 'kb' | 'chat'): Route | null {
  const kb = useKbStore.getState()
  const chat = useChatStore.getState()
  const kbRoute: Route | null = kb.kbs[0] ? { view: 'kb', kbId: kb.kbs[0].id } : null
  const chatRoute: Route | null = chat.sessions[0] ? { view: 'chat', sessionId: chat.sessions[0].id } : null
  return prefer === 'kb' ? (kbRoute ?? chatRoute) : (chatRoute ?? kbRoute)
}

function docKbOf(docsByKb: Record<string, DocumentItem[]>, docId: string): string | null {
  for (const [kbId, docs] of Object.entries(docsByKb)) {
    if (docs.some(d => d.id === docId)) return kbId
  }
  return null
}

/** 单视图阶段的同步写入：路由 → page / activeKbId / activeDocId / activeId（现有组件零改动） */
function syncStores(route: Route) {
  const app = useAppStore.getState()
  if (route.view === 'settings') {
    if (app.page !== 'settings') useAppStore.setState({ page: 'settings' })
    return
  }
  if (route.view === 'stats') {
    if (app.page !== 'stats') useAppStore.setState({ page: 'stats' })
    return
  }
  if (route.view === 'kb') {
    const kb = useKbStore.getState()
    const docId = route.docId ?? null
    if (kb.activeKbId !== route.kbId || kb.activeDocId !== docId) {
      // 与 clickKb/clickDoc 的选中语义一致
      useKbStore.setState({
        activeKbId: route.kbId,
        kbSel: [route.kbId], kbAnchor: route.kbId,
        activeDocId: docId,
        docSel: docId ? [docId] : [], docAnchor: docId,
      })
    }
    if (app.page !== 'main') useAppStore.setState({ page: 'main' })
    return
  }
  // chat
  const chat = useChatStore.getState()
  if (chat.activeId !== route.sessionId) void chat.ensureSessionActive(route.sessionId)
  if (app.page !== 'assistant') useAppStore.setState({ page: 'assistant' })
}

// ---------- 定位参数消费（收编原 pendingJump 逻辑） ----------

let locToken = 0
let pending: { token: number; docId: string; loc: RouteLoc } | null = null

/** 该文档是否存在未消费完的路由定位（PreviewMain 据此跳过滚动位置恢复，定位优先） */
export function hasPendingLoc(docId: string): boolean {
  return !!pending && pending.docId === docId
}

/**
 * 取走该文档待消费的 PDF 深链定位（?p=&f=，协议见名词规范 §十一；优先级低于 a，
 * 带 a 的定位不会进入此分支）。9.5 步骤6：PdfViewer 文档就绪后调用一次并
 * scrollToPos({page, frac})；返回 null = 无待消费参数。取走即清除 pending。
 */
export function takePendingPdfLoc(docId: string): { p: number; f: number } | null {
  if (pending && pending.docId === docId && pending.loc.p != null && !pending.loc.a) {
    const loc = { p: pending.loc.p, f: pending.loc.f ?? 0 }
    pending = null
    return loc
  }
  return null
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// debug2 #7：文档"查无"回落前的二次校验状态——同一路由 hash 只重拉重试一次，
// 防止"重拉失败→重试→再重拉"循环；不同路由互不影响（成功应用其它路由时清空）
let missingDocRetry: string | null = null

function scheduleLocConsume(docId: string, loc: RouteLoc) {
  const token = ++locToken
  pending = { token, docId, loc }
  void consumeLocLoop(token)
}

/**
 * 消费流程：恢复该视图 → 快照加载完成 → 等锚点节点出现（24×500ms 重试环，
 * 覆盖配置补选后的重新渲染）→ scrollToWithin 居中 → revealBoxIfFolded →
 * jump-highlight 3.2s；p/f 驱动 PdfViewer 定位（步骤6 接入）；q 仅当 a 缺失/找不到时
 * 滚动到首个文本匹配并高亮。
 */
async function consumeLocLoop(token: number) {
  const me = pending
  if (!me || me.token !== token) return
  const { docId, loc } = me
  // p/f 深链（步骤6）：pending 保留，由 PdfViewer 就绪后 takePendingPdfLoc 消费；
  // 不等实时树（PDF 加载与实时树无关），也不在此清除（hasPendingLoc 保持定位优先）
  if (loc.p != null && !loc.a) return
  const deadline = Date.now() + 30000
  let retries = 0
  while (Date.now() < deadline) {
    if (pending?.token !== token) return   // 路由已变：放弃本次消费
    const live = useLiveStore.getState()
    if (live.docId !== docId || !live.nodes['root']) { await sleep(500); continue }
    if (loc.a) {
      const nodeId = findAnchorNode(live.nodes, loc.a)
      if (nodeId && jumpToElement(loc.a, nodeId)) { pending = null; return }
      if (++retries > 24) {
        // a 找不到（且补选重载后仍未出现）→ q 文本回退
        if (loc.q) findTextNode(live.nodes, loc.q)
        pending = null
        return
      }
      await sleep(500)
      if (pending?.token !== token) return
      void useLiveStore.getState().reload()   // 与原 pendingJump 环一致：重拉快照等锚点出现
      continue
    }
    // 无 a 且无 p：q 文本回退（p/f 已在函数开头让位给 PdfViewer 深链消费）
    if (loc.q && findTextNode(live.nodes, loc.q)) { pending = null; return }
    pending = null
    return
  }
  pending = null
}

/** 滚动到锚点元素：折叠框自动展开 → 居中 → 800ms 二段校正 → 3.2s 高亮。
 * debug2 #12：firstVisible 只认可见实例——keep-alive 多标签下同名节点渲染多份，
 * querySelector 命中隐藏标签实例（display:none 容器 scrollTo 无效）导致
 * "只切文档不到位置"；找不到可见实例返回 false，消费环稍后重试 */
function jumpToElement(anchor: string | null, nodeId: string): boolean {
  const el = (anchor ? firstVisible(`[data-anchor="${CSS.escape(anchor)}"]`) : null)
    ?? firstVisible(`[data-node-id="${nodeId}"]`)
  if (!el) return false
  const doScroll = () => {
    if (revealBoxIfFolded(el)) {
      // 折叠框展开是异步渲染，稍候再滚动定位
      setTimeout(() => scrollToWithin(null, el as HTMLElement, 'center'), 80)
    } else {
      scrollToWithin(null, el as HTMLElement, 'center')
    }
  }
  doScroll()
  setTimeout(doScroll, 800)   // 二段滚动：图片等内容加载后布局位移校正
  el.classList.add('jump-highlight')
  setTimeout(() => el.classList.remove('jump-highlight'), 3200)
  return true
}

/** q 文本回退：在渲染树节点 md 中找首个包含目标文本的节点（空白归一化） */
function findTextNode(nodes: Record<string, LiveNode>, q: string): boolean {
  const target = q.replace(/\s+/g, '')
  if (!target) return false
  for (const n of Object.values(nodes)) {
    if (!n.md || !n.md.replace(/\s+/g, '').includes(target)) continue
    if (jumpToElement(null, n.id)) return true
  }
  return false
}
