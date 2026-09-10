/**
 * 9.5 步骤8 单元测试（node 脚本，模拟浏览器全局，esbuild 打包真实源码）。
 * 随阶段增长：A = tabs store 全 action + routeKind/分发解析 + adoptRoute（知识库类）；
 * B = 会话类标签接入；C = localStorage 持久化与刷新恢复三件套；
 * D（debug5）= 设置/统计纳入标签体系（adoptRoute/activate/close/hydrate/回落/行为断言）。
 * 运行：cd webui && node scripts/step8-test.mjs
 */
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import assert from 'node:assert'

const OUT = '.step8-tmp'
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ---------- 浏览器全局模拟（必须在 import bundle 之前） ----------
const lsStore = new Map()
globalThis.localStorage = {
  getItem: k => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: k => lsStore.delete(k),
}
globalThis.location = { hash: '', pathname: '/', search: '' }
const historyStack = []
const winListeners = new Map()
globalThis.window = globalThis
globalThis.addEventListener = (t, fn) => {
  if (!winListeners.has(t)) winListeners.set(t, [])
  winListeners.get(t).push(fn)
}
globalThis.removeEventListener = (t, fn) => {
  const list = winListeners.get(t) ?? []
  const i = list.indexOf(fn)
  if (i >= 0) list.splice(i, 1)
}
globalThis.history = {
  pushState(_s, _t, url) { historyStack.push(url); globalThis.location.hash = url.startsWith('#') ? url : `#${url}` },
  replaceState(_s, _t, url) { historyStack[historyStack.length - 1] = url; globalThis.location.hash = url.startsWith('#') ? url : `#${url}` },
}
globalThis.document = {
  documentElement: { classList: { toggle() {}, add() {}, remove() {} } },
  querySelector: () => null,
}
globalThis.requestAnimationFrame = fn => setTimeout(fn, 6)
globalThis.cancelAnimationFrame = id => clearTimeout(id)

// ---------- esbuild 打包真实源码 ----------
const esbuild = (await import('esbuild')).default
await esbuild.build({
  entryPoints: ['scripts/step8-entry.ts'],
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: `${OUT}/bundle.js`, jsx: 'automatic',
  loader: { '.css': 'empty' },
  logLevel: 'silent',
})
const B = await import(`../${OUT}/bundle.js`)
const {
  parseHash, buildRoute, navigate, initRouter, onRouteChange,
  useKbStore: KB, useChatStore: CHAT, useAppStore: APP, useTabsStore: TABS, routeKind,
  markHistoryNav, consumeHistoryNav,
} = B

// ---------- 预置数据 ----------
KB.setState({
  kbs: [{ id: 'k1', name: 'K1' }, { id: 'k2', name: 'K2' }],
  docsByKb: {
    k1: [{ id: 'd1', kbId: 'k1', name: '文档A' }, { id: 'd2', kbId: 'k1', name: '文档B' }],
    k2: [{ id: 'd9', kbId: 'k2', name: '文档C' }],
  },
  activeKbId: null, activeDocId: null, kbSel: [], docSel: [], kbAnchor: null, docAnchor: null,
})
CHAT.setState({
  sessions: [
    { id: 's1', title: '会话一', createdAt: '', updatedAt: '' },
    { id: 's2', title: '会话二', createdAt: '', updatedAt: '' },
  ],
  activeId: null, msgs: {}, ui: {},
})
APP.setState({ page: 'main' })

// App 外壳同款：路由 → 标签同步监听（测试里等价接线，navigate 即触发 adoption；
// 浏览器历史发起的路由按回溯语义处理——与 App.tsx 一致。debug5：设置/统计路由
// 也是合法标签路由，不再有 settings 过滤特例）
const unsubTabs = onRouteChange(route => {
  const fromHistory = consumeHistoryNav()
  if (route) TABS.getState().adoptRoute(route, { fromHistory })
})

let pass = 0
const failed = []
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`) } catch (e) { failed.push(name); console.error(`FAIL  ${name}\n      ${e.message}`) }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`) } catch (e) { failed.push(name); console.error(`FAIL  ${name}\n      ${e.message}`) }
}

function resetTabs() { TABS.setState({ tabs: [], activeTabId: null }) }
function tabByRoute(hash) { return TABS.getState().tabs.find(x => x.route === hash) }

console.log('\n== tabs: routeKind / route↔TabView 分发解析 ==')
t('routeKind：chat/kb/settings/stats/非法（debug5：设置/统计为合法标签视图类）', () => {
  assert.strictEqual(routeKind('#/chat/s1'), 'chat')
  assert.strictEqual(routeKind('#/kb/k1'), 'kb')
  assert.strictEqual(routeKind('#/kb/k1/d1'), 'kb')
  assert.strictEqual(routeKind('#/settings/providers'), 'settings')
  assert.strictEqual(routeKind('#/settings'), 'settings')
  assert.strictEqual(routeKind('#/stats'), 'stats')
  assert.strictEqual(routeKind(''), null)
  assert.strictEqual(routeKind('#/bogus'), null)
})
t('分发解析：kb → MainPage、chat → AssistantPage（parseHash 同源）', () => {
  const r1 = parseHash('#/kb/k1/d1')
  assert.strictEqual(r1.view, 'kb')          // TabView → MainPage
  const r2 = parseHash('#/chat/s1')
  assert.strictEqual(r2.view, 'chat')        // TabView → AssistantPage
  assert.strictEqual(r2.sessionId, 's1')
  const r3 = parseHash('#/settings/defaults')
  assert.strictEqual(r3.view, 'settings')    // TabView → SettingsPage
  assert.strictEqual(r3.section, 'defaults')
  assert.strictEqual(parseHash('#/stats').view, 'stats')   // TabView → PlaceholderPage
})

console.log('\n== tabs: openTab 去重激活 / 新建激活 ==')
t('openTab 新建并激活 + 标题从列表数据推导', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1')
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1)
  assert.strictEqual(s.activeTabId, s.tabs[0].id)
  assert.strictEqual(s.tabs[0].route, '#/kb/k1')
  assert.strictEqual(s.tabs[0].title, 'K1', 'kb 路由标题 = 知识库名')
  assert.strictEqual(globalThis.location.hash, '#/kb/k1', 'openTab 落 URL（pushState）')
})
t('openTab 同 route 去重 → 只激活不新建', () => {
  const before = TABS.getState().tabs.length
  TABS.getState().openTab('#/kb/k1')
  assert.strictEqual(TABS.getState().tabs.length, before)
  assert.strictEqual(globalThis.location.hash, '#/kb/k1')
})
t('openTab 文档路由 → 新标签 + 文档名标题；带定位参数的等价路由归一化去重', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1/d1')
  let s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1)
  assert.strictEqual(s.tabs[0].route, '#/kb/k1/d1')
  assert.strictEqual(s.tabs[0].title, '文档A')
  // 定位参数是瞬时消费参数，不属于视图身份：同视图不同 loc = 同一标签
  navigate({ view: 'kb', kbId: 'k1', docId: 'd1' }, { a: 'organized:1.1' })
  TABS.getState().openTab('#/kb/k1/d1')
  s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1, 'loc 参数不产生新标签')
})
t('openTab 会话路由 → 会话标题推导', () => {
  resetTabs()
  TABS.getState().openTab('#/chat/s1')
  const tab = tabByRoute('#/chat/s1')
  assert.ok(tab, '会话标签已建立')
  assert.strictEqual(tab.title, '会话一')
})
t('openTab 非法路由 → 忽略（settings 路由自 debug5 起合法，见 debug5 组）', () => {
  resetTabs()
  TABS.getState().openTab('#/bogus')
  assert.strictEqual(TABS.getState().tabs.length, 0)
})

console.log('\n== tabs: adoptRoute（路由 → 标签同步，阶段A 仅知识库类） ==')
t('精确命中 → 激活对应标签', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1')
  TABS.getState().openTab('#/kb/k2')
  TABS.getState().openTab('#/kb/k1/d1')
  assert.strictEqual(tabByRoute('#/kb/k1/d1').id, TABS.getState().activeTabId)
  TABS.getState().adoptRoute('#/kb/k1')
  assert.strictEqual(TABS.getState().activeTabId, tabByRoute('#/kb/k1').id)
  TABS.getState().adoptRoute('#/kb/k2')
  assert.strictEqual(TABS.getState().activeTabId, tabByRoute('#/kb/k2').id)
  assert.strictEqual(APP.getState().page, 'main', 'syncStores 派生回写照常')
})
t('同类 kb 视图内导航 → 回写当前标签路由（单标签零回归的关键）', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1')
  const kbTabId = TABS.getState().activeTabId
  navigate({ view: 'kb', kbId: 'k1', docId: 'd2' })
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1, '不新建标签')
  const tab = s.tabs.find(x => x.id === kbTabId)
  assert.strictEqual(tab.route, '#/kb/k1/d2')
  assert.strictEqual(tab.title, '文档B', '回写时标题随目标视图刷新')
  navigate({ view: 'kb', kbId: 'k2' })
  const tab2 = TABS.getState().tabs.find(x => x.id === kbTabId)
  assert.strictEqual(tab2.route, '#/kb/k2', '切库同样回写当前标签')
  assert.strictEqual(tab2.title, 'K2')
})
t('跨类导航（kb 标签活跃时收到 chat 路由）→ 新建会话标签并激活', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1')
  const before = TABS.getState().tabs.length
  navigate({ view: 'chat', sessionId: 's1' })
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, before + 1, '跨类 → 新建')
  assert.strictEqual(s.tabs[s.tabs.length - 1].route, '#/chat/s1')
  assert.strictEqual(s.activeTabId, s.tabs[s.tabs.length - 1].id)
  assert.strictEqual(APP.getState().page, 'assistant')
})
t('无标签时收到 kb 路由 → 为其建标签（全新环境首个标签）', () => {
  resetTabs()
  navigate({ view: 'kb', kbId: 'k2', docId: 'd9' })
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1)
  assert.strictEqual(s.tabs[0].route, '#/kb/k2/d9')
  assert.strictEqual(s.activeTabId, s.tabs[0].id)
})

console.log('\n== tabs: activate / close / closeOthers / setRoute / setTitle ==')
t('activate → 导航到标签当前路由（pushState）并激活', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1')
  TABS.getState().openTab('#/kb/k2')
  TABS.getState().openTab('#/kb/k1/d1')
  const target = tabByRoute('#/kb/k1')
  const before = historyStack.length
  TABS.getState().activate(target.id)
  assert.strictEqual(globalThis.location.hash, '#/kb/k1')
  assert.ok(historyStack.length > before, '标签切换 = pushState（可后退回溯）')
  assert.strictEqual(TABS.getState().activeTabId, target.id)
})
t('close 非活跃标签 → 仅移除', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1')
  TABS.getState().openTab('#/kb/k2')
  const activeBefore = TABS.getState().activeTabId
  TABS.getState().close(tabByRoute('#/kb/k1').id)
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1)
  assert.strictEqual(s.activeTabId, activeBefore, '活跃标签不变')
})
t('close 活跃标签 → 激活相邻标签并导航', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1')
  TABS.getState().openTab('#/kb/k2')     // 活跃 = k2；关掉 → 相邻 = k1
  TABS.getState().close(tabByRoute('#/kb/k2').id)
  const s = TABS.getState()
  assert.strictEqual(s.activeTabId, tabByRoute('#/kb/k1').id, '激活相邻标签')
  assert.strictEqual(globalThis.location.hash, '#/kb/k1', '切换到相邻标签走 navigate')
})
t('close 最后一个标签 → goDefaultView（adoption 重建标签）', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k2')
  TABS.getState().close(tabByRoute('#/kb/k2').id)
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1, '默认视图经 adoption 重建标签')
  assert.strictEqual(s.tabs[0].route, '#/kb/k1')
  assert.strictEqual(s.activeTabId, s.tabs[0].id)
})
t('closeOthers 只留指定标签', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1')
  TABS.getState().openTab('#/kb/k2')
  TABS.getState().openTab('#/kb/k1/d1')
  const keep = tabByRoute('#/kb/k2')
  TABS.getState().closeOthers(keep.id)
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1)
  assert.strictEqual(s.tabs[0].id, keep.id)
  assert.strictEqual(s.activeTabId, keep.id)
  assert.strictEqual(globalThis.location.hash, '#/kb/k2')
})
t('setRoute / setTitle', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1')
  const id = TABS.getState().tabs[0].id
  TABS.getState().setRoute(id, '#/kb/k1/d9')
  let tab = TABS.getState().tabs[0]
  assert.strictEqual(tab.route, '#/kb/k1/d9')
  TABS.getState().setTitle(id, '自定义名')
  tab = TABS.getState().tabs[0]
  assert.strictEqual(tab.title, '自定义名')
  TABS.getState().setRoute(id, '#/kb/k2')
  tab = TABS.getState().tabs[0]
  assert.strictEqual(tab.route, '#/kb/k2')
})
t('buildRoute 与 Tab.route 往返一致', () => {
  assert.strictEqual(buildRoute({ view: 'kb', kbId: 'k1', docId: 'd1' }), '#/kb/k1/d1')
  assert.strictEqual(buildRoute({ view: 'kb', kbId: 'k1' }), '#/kb/k1')
})

console.log('\n== tabs: 会话类标签接入（阶段B adoptRoute 放开 chat） ==')
t('adoptRoute：chat 精确命中 → 激活对应会话标签', () => {
  resetTabs()
  TABS.getState().openTab('#/chat/s1')
  TABS.getState().openTab('#/chat/s2')
  TABS.getState().adoptRoute('#/chat/s1')
  assert.strictEqual(TABS.getState().activeTabId, tabByRoute('#/chat/s1').id)
})
t('会话内切换 → 回写活跃标签路由（两个会话标签不重复）', () => {
  resetTabs()
  TABS.getState().openTab('#/chat/s1')
  navigate({ view: 'chat', sessionId: 's2' })
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1, '同类回写不新建')
  assert.strictEqual(s.tabs[0].route, '#/chat/s2')
  assert.strictEqual(s.tabs[0].title, '会话二')
})
t('深链：chat 标签活跃时收到 kb 文档路由 → 新建 kb 标签（引用跳转不吞会话标签）', () => {
  resetTabs()
  TABS.getState().openTab('#/chat/s1')
  navigate({ view: 'kb', kbId: 'k1', docId: 'd1' }, { a: 'organized:1.1' })
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 2, '跨类 → 新建 kb 标签')
  assert.strictEqual(s.tabs[1].route, '#/kb/k1/d1')
  assert.strictEqual(s.tabs[0].route, '#/chat/s1', '会话标签保持不动')
  assert.strictEqual(s.activeTabId, s.tabs[1].id)
})

console.log('\n== tabs: 后退/前进 = 按时间回溯视图（开着则激活、关了按路由重建） ==')
await ta('popstate 后退 → 激活对应标签；前进同理', async () => {
  resetTabs()
  localStorage.removeItem('doc-assistant-last-route')
  globalThis.location.hash = '#/kb/k1'
  globalThis.__teardown8?.()
  markHistoryNav()                          // App 启动语义：首个路由按历史回溯处理
  globalThis.__teardown8 = initRouter()     // applyRoute → adoption 建首标签
  assert.strictEqual(TABS.getState().tabs.length, 1)
  navigate({ view: 'chat', sessionId: 's1' })          // push
  navigate({ view: 'kb', kbId: 'k2', docId: 'd9' })    // push
  assert.strictEqual(TABS.getState().tabs.length, 3)
  // 后退两步
  globalThis.location.hash = '#/chat/s1'
  for (const l of winListeners.get('popstate') ?? []) l()
  assert.strictEqual(TABS.getState().activeTabId, tabByRoute('#/chat/s1').id, '后退 → 激活对应标签')
  assert.strictEqual(TABS.getState().tabs.length, 3)
  globalThis.location.hash = '#/kb/k1'
  for (const l of winListeners.get('popstate') ?? []) l()
  assert.strictEqual(TABS.getState().activeTabId, tabByRoute('#/kb/k1').id)
  // 前进
  globalThis.location.hash = '#/kb/k2/d9'
  for (const l of winListeners.get('popstate') ?? []) l()
  assert.strictEqual(TABS.getState().activeTabId, tabByRoute('#/kb/k2/d9').id)
})
await ta('后退到已关闭标签的路由 → 按路由重建标签再激活', async () => {
  // 当前活跃 = #/kb/k2/d9 → 关闭（相邻 #/chat/s1 激活）→ 后退回 #/kb/k2/d9
  TABS.getState().close(tabByRoute('#/kb/k2/d9').id)
  assert.strictEqual(tabByRoute('#/kb/k2/d9'), undefined, '标签已关')
  globalThis.location.hash = '#/kb/k2/d9'
  for (const l of winListeners.get('popstate') ?? []) l()
  const s = TABS.getState()
  const rebuilt = tabByRoute('#/kb/k2/d9')
  assert.ok(rebuilt, '按路由重建标签')
  assert.strictEqual(s.activeTabId, rebuilt.id, '重建后激活')
  assert.strictEqual(rebuilt.title, '文档C', '重建标签标题照常推导')
  globalThis.__teardown8?.()
  globalThis.__teardown8 = undefined
})
await ta('后退到同类已关闭视图 → 重建新标签，活跃标签路由不被回写', async () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1/d1')   // tabA
  TABS.getState().openTab('#/kb/k2/d9')   // tabB（显式 openTab 新建）
  // 关闭 tabA（非活跃，仅移除）→ 模拟刷新后从历史回到 #/kb/k1/d1
  TABS.getState().close(tabByRoute('#/kb/k1/d1').id)
  assert.strictEqual(tabByRoute('#/kb/k1/d1'), undefined)
  globalThis.location.hash = '#/kb/k1/d1'
  markHistoryNav()
  globalThis.__teardown8?.()
  globalThis.__teardown8 = initRouter()
  const s = TABS.getState()
  const rebuilt = tabByRoute('#/kb/k1/d1')
  assert.ok(rebuilt, '同类视图也已关闭 → 按路由重建')
  assert.strictEqual(tabByRoute('#/kb/k2/d9').route, '#/kb/k2/d9', '活跃标签路由不被回写')
  assert.strictEqual(s.activeTabId, rebuilt.id)
  globalThis.__teardown8?.()
  globalThis.__teardown8 = undefined
})
t('深链：已有同类标签时 URL 指向其它视图 → 重建新标签，现有标签不动（§5）', () => {
  resetTabs()
  localStorage.setItem('doc-assistant-tabs', JSON.stringify({
    tabs: [
      { id: 'a', route: '#/kb/k1', title: 'K1' },
      { id: 'b', route: '#/kb/k2', title: 'K2' },
    ],
    activeTabId: 'b',
  }))
  TABS.getState().hydrate()
  globalThis.location.hash = '#/kb/k1/d1'
  markHistoryNav()
  globalThis.__teardown8?.()
  globalThis.__teardown8 = initRouter()
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 3, '深链重建新标签')
  assert.strictEqual(tabByRoute('#/kb/k1/d1').id, s.activeTabId)
  assert.strictEqual(tabByRoute('#/kb/k2').route, '#/kb/k2', '现有标签路由不被回写')
  assert.strictEqual(tabByRoute('#/kb/k1').route, '#/kb/k1', '其它标签原样保留')
  globalThis.__teardown8?.()
  globalThis.__teardown8 = undefined
})

console.log('\n== tabs: 持久化与刷新恢复三件套（阶段C） ==')
t('persist/hydrate 往返：tabs+activeTabId 落盘、按 route 重建、标题从列表数据回填', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1')
  TABS.getState().openTab('#/kb/k1/d1')
  TABS.getState().openTab('#/chat/s1')
  TABS.getState().activate(tabByRoute('#/kb/k1/d1').id)
  const routes = TABS.getState().tabs.map(t => t.route)
  const activeId = TABS.getState().activeTabId
  TABS.getState().persist()
  const stored = JSON.parse(localStorage.getItem('doc-assistant-tabs'))
  assert.ok(stored.tabs.length === 3 && stored.activeTabId === activeId, '落盘内容 = tabs+activeTabId')
  // 模拟刷新：内存清空（订阅会自动落盘空表，随后再写旧数据模拟持久化）→ 水合
  TABS.setState({ tabs: [], activeTabId: null })
  stored.tabs = stored.tabs.map(t => ({ ...t, title: '过期标题' }))
  localStorage.setItem('doc-assistant-tabs', JSON.stringify(stored))
  assert.strictEqual(TABS.getState().hydrate(), true, '存在持久化数据应恢复')
  const s = TABS.getState()
  assert.deepStrictEqual(s.tabs.map(t => t.route), routes, '按 route 重建')
  assert.strictEqual(s.activeTabId, activeId, '活跃标签恢复')
  assert.strictEqual(s.tabs.find(t => t.route === '#/kb/k1/d1').title, '文档A', '标题从列表数据回填')
  assert.strictEqual(s.tabs.find(t => t.route === '#/chat/s1').title, '会话一')
})
t('hydrate 丢弃非法路由、settings 非法分区规范化（debug5）、route 去重，活跃指向失效时落到第一个标签', () => {
  TABS.setState({ tabs: [], activeTabId: null })   // 先清内存（自动落盘），再写持久化数据
  localStorage.setItem('doc-assistant-tabs', JSON.stringify({
    tabs: [
      { id: 'a', route: '#/kb/k1', title: 'x' },
      { id: 'b', route: '#/kb/k1', title: 'y' },
      { id: 'c', route: '#/settings/bogus', title: 'z' },
      { id: 'd', route: '#/bogus', title: 'w' },
      { id: 'e', route: '#/kb/k1/d9', title: 'v' },
    ],
    activeTabId: 'd',
  }))
  assert.strictEqual(TABS.getState().hydrate(), true)
  const s = TABS.getState()
  assert.deepStrictEqual(s.tabs.map(t => t.route), ['#/kb/k1', '#/settings', '#/kb/k1/d9'],
    '非法分区 #/settings/bogus 规范化为 #/settings 身份；#\/bogus 丢弃')
  assert.strictEqual(s.tabs[1].title, '设置', 'settings 标签标题=「设置」')
  assert.strictEqual(s.activeTabId, 'a', '活跃指向被丢弃 → 落到第一个标签')
})
t('无/空持久化数据 → hydrate 返回 false（走 URL/默认视图）', () => {
  TABS.setState({ tabs: [], activeTabId: null })
  localStorage.setItem('doc-assistant-tabs', JSON.stringify({ tabs: [], activeTabId: null }))
  assert.strictEqual(TABS.getState().hydrate(), false)
  localStorage.removeItem('doc-assistant-tabs')
  assert.strictEqual(TABS.getState().hydrate(), false)
})
t('刷新恢复三件套之一：URL hash 深链 → 无匹配标签时按路由重建并激活', () => {
  resetTabs()
  localStorage.removeItem('doc-assistant-tabs')
  globalThis.location.hash = '#/kb/k2/d9'
  globalThis.__teardown8?.()
  markHistoryNav()                        // App 启动语义：首个路由按历史回溯处理
  globalThis.__teardown8 = initRouter()
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1, '深链路由重建为标签')
  assert.strictEqual(s.tabs[0].route, '#/kb/k2/d9')
  assert.strictEqual(s.activeTabId, s.tabs[0].id)
  assert.strictEqual(KB.getState().activeDocId, 'd9')
})
t('刷新恢复三件套之二：URL 与持久化标签匹配 → 激活该标签（列表保留）', () => {
  resetTabs()
  localStorage.setItem('doc-assistant-tabs', JSON.stringify({
    tabs: [
      { id: 'a', route: '#/kb/k1', title: 'K1' },
      { id: 'b', route: '#/kb/k2/d9', title: '文档C' },
    ],
    activeTabId: 'a',
  }))
  assert.strictEqual(TABS.getState().hydrate(), true)
  globalThis.location.hash = '#/kb/k2/d9'
  globalThis.__teardown8?.()
  markHistoryNav()
  globalThis.__teardown8 = initRouter()
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 2, '持久化列表保留')
  assert.strictEqual(s.activeTabId, 'b', 'hash 命中的标签被激活')
})
t('刷新恢复三件套之三：无 hash → 打开记忆的上次活跃视图（= 持久化的活跃标签）', () => {
  globalThis.location.hash = ''
  globalThis.__teardown8?.()
  markHistoryNav()
  globalThis.__teardown8 = initRouter()   // last-route 记忆为 #/kb/k2/d9（上一用例 applyRoute 写入）
  assert.strictEqual(globalThis.location.hash, '#/kb/k2/d9', '无 hash → replaceState 到记忆路由')
  assert.strictEqual(TABS.getState().activeTabId, 'b')
  globalThis.__teardown8?.()
  globalThis.__teardown8 = undefined
})
t('scrollMemo 序列化往返（三件套之滚动恢复的存储层）', () => {
  localStorage.setItem('doc-assistant-scroll', JSON.stringify({ 'live:d1': 1234, 'chat:s1': 80 }))
  assert.strictEqual(B.scrollMemoRecall('live:d1'), 1234)
  assert.strictEqual(B.scrollMemoRecall('chat:s1'), 80)
})
t('标题联动：文档/会话改名 → 标签标题自动刷新（refreshTitles 订阅）', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1/d1')
  TABS.getState().openTab('#/chat/s1')
  TABS.setState({ tabs: TABS.getState().tabs.map(t => ({ ...t, activeAt: 1 })) })
  KB.setState(s => ({
    docsByKb: { ...s.docsByKb, k1: s.docsByKb.k1.map(d => (d.id === 'd1' ? { ...d, name: '改名后的文档' } : d)) },
  }))
  assert.strictEqual(tabByRoute('#/kb/k1/d1').title, '改名后的文档', 'kb store 变更联动')
  CHAT.setState(s => ({
    sessions: s.sessions.map(x => (x.id === 's1' ? { ...x, title: '改名后的会话' } : x)),
  }))
  assert.strictEqual(tabByRoute('#/chat/s1').title, '改名后的会话', 'chat store 变更联动')
})
t('上限提醒：第 11 个标签 toast（不硬禁）', () => {
  resetTabs()
  TABS.setState({
    tabs: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, route: `#/chat/uniq${i}`, title: `t${i}` })),
    activeTabId: 't9',
  })
  const before = B.useToast.getState().toasts.length
  TABS.getState().openTab('#/kb/k1/d1')   // 第 11 个
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 11, '不硬禁：仍创建')
  const toasts = B.useToast.getState().toasts
  assert.ok(toasts.length > before, '出现提醒 toast')
  assert.ok(toasts.some(x => x.text.includes('10')), '提醒文案含上限数')
})

console.log('\n== tabs: activateRecent（Sidebar 联动，阶段C） ==')
t('激活最近的知识库/会话类标签（activeAt 最新者）', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1')
  TABS.getState().openTab('#/chat/s1')
  TABS.getState().openTab('#/kb/k2')
  // 人为区分 activeAt：k1=100, chat=300, k2=200
  TABS.setState({ tabs: TABS.getState().tabs.map(t => ({
    ...t,
    activeAt: t.route === '#/kb/k1' ? 100 : t.route === '#/chat/s1' ? 300 : 200,
  })) })
  assert.strictEqual(TABS.getState().activateRecent('kb'), true)
  assert.strictEqual(TABS.getState().activeTabId, tabByRoute('#/kb/k2').id, '最近 kb 类 = k2')
  assert.strictEqual(TABS.getState().activateRecent('chat'), true)
  assert.strictEqual(TABS.getState().activeTabId, tabByRoute('#/chat/s1').id, '最近会话类')
})
t('无同类标签 → activateRecent 返回 false（调用方走默认导航）', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1')
  assert.strictEqual(TABS.getState().activateRecent('chat'), false)
  assert.strictEqual(TABS.getState().activateRecent('kb'), true)
})

console.log('\n== tabs: 设置页/统计占位纳入标签体系（debug5 步骤5） ==')
t('openTab settings 路由 → 标题「设置」；非法分区规范化为 #/settings 身份', () => {
  resetTabs()
  TABS.getState().openTab('#/settings/defaults')
  let s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1)
  assert.strictEqual(s.tabs[0].route, '#/settings/defaults')
  assert.strictEqual(s.tabs[0].title, '设置')
  assert.strictEqual(globalThis.location.hash, '#/settings/defaults', 'openTab 落 URL')
  // 非法分区 → 规范化为无分区身份（不形成渲染同内容却互不相同的幽灵标签）
  TABS.getState().openTab('#/settings/bogus')
  s = TABS.getState()
  assert.strictEqual(s.tabs.length, 2)
  assert.strictEqual(s.tabs[1].route, '#/settings', '规范化身份')
  assert.strictEqual(s.tabs[1].title, '设置')
})
t('跨类：kb 标签活跃收到 settings 路由 → 新建设置标签（Sidebar 设置入口语义），kb 标签不动', () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1/d1')
  navigate({ view: 'settings' })   // navSidebarPage('settings') → 无分区
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 2, '跨类 → 新建 settings 标签')
  assert.strictEqual(s.tabs[1].route, '#/settings')
  assert.strictEqual(s.tabs[1].title, '设置')
  assert.strictEqual(s.tabs[0].route, '#/kb/k1/d1', 'kb 标签路由不被设置路由污染')
  assert.strictEqual(s.activeTabId, s.tabs[1].id)
  assert.strictEqual(APP.getState().page, 'settings', 'syncStores 派生 page=settings')
})
t('settings 标签内切分区 → 同类回写（不新建标签，标签=视图=其当前路由）', () => {
  // 承接上一用例：活跃 = #/settings
  navigate({ view: 'settings', section: 'defaults' })   // SettingsPage.switchSection 语义
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 2, '同类回写不新建')
  assert.strictEqual(s.tabs[1].route, '#/settings/defaults')
  assert.strictEqual(APP.getState().page, 'settings')
})
t('行为断言：进入设置 → activateRecent("kb") 切回主界面标签 → active 翻转（恢复 effect 触发路径）', () => {
  // 前置：tabs=[kb(k1/d1), settings(defaults)]，活跃=settings
  const kbTab = tabByRoute('#/kb/k1/d1')
  assert.notStrictEqual(kbTab, undefined)
  assert.notStrictEqual(TABS.getState().activeTabId, kbTab.id, '前置：活跃在设置标签')
  assert.strictEqual(TABS.getState().activateRecent('kb'), true)
  assert.strictEqual(TABS.getState().activeTabId, kbTab.id,
    'activeTabId 翻转 → App 壳层 active prop 随之翻转 → PreviewMain/RightPanel/PdfViewer 的'
    + '"失活重置 restoredDocRef + 再激活 scrollMemo 恢复"路径触发（debug2 位置记忆与本步叠加）')
  assert.strictEqual(globalThis.location.hash, '#/kb/k1/d1')
  assert.ok(TABS.getState().tabs.some(t => t.route.startsWith('#/settings')),
    'TabStrip 仍显示设置标签（keep-alive：设置页保持挂载，表单编辑态保留）')
  // 再进设置：activateRecent 精确命中既有标签（不新建）
  const settingsTabId = TABS.getState().tabs.find(t => t.route === '#/settings/defaults').id
  assert.strictEqual(TABS.getState().activateRecent('settings'), true)
  assert.strictEqual(TABS.getState().activeTabId, settingsTabId)
  assert.strictEqual(TABS.getState().tabs.length, 2, '往返不增标签')
})
t('close 活跃 settings 标签 → 相邻标签激活并导航（回落沿现有规则）', () => {
  // 承接上一用例：tabs=[kb(k1/d1), settings(defaults)]，活跃=settings → 关闭 → 回 kb 标签
  TABS.getState().close(TABS.getState().tabs.find(t => t.route === '#/settings/defaults').id)
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1)
  assert.strictEqual(s.activeTabId, tabByRoute('#/kb/k1/d1').id, '激活相邻（kb）标签')
  assert.strictEqual(globalThis.location.hash, '#/kb/k1/d1', 'navigate 回相邻标签路由')
})
t('close 最后一个（settings）标签 → goDefaultView 重建 kb 默认标签', () => {
  resetTabs()
  TABS.getState().openTab('#/settings')
  TABS.getState().close(tabByRoute('#/settings').id)
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1)
  assert.strictEqual(s.tabs[0].route, '#/kb/k1', '默认视图经 adoption 重建标签')
  assert.strictEqual(APP.getState().page, 'main')
})
t('stats 占位页标签：openTab/activateRecent/标题「统计」/page 派生', () => {
  resetTabs()
  TABS.getState().openTab('#/stats')
  let s = TABS.getState()
  assert.strictEqual(s.tabs.length, 1)
  assert.strictEqual(s.tabs[0].route, '#/stats')
  assert.strictEqual(s.tabs[0].title, '统计')
  assert.strictEqual(globalThis.location.hash, '#/stats')
  assert.strictEqual(APP.getState().page, 'stats', 'syncStores 派生 page=stats')
  TABS.getState().openTab('#/kb/k1')
  assert.strictEqual(TABS.getState().activateRecent('stats'), true, 'Sidebar 统计入口语义')
  assert.strictEqual(TABS.getState().activeTabId, tabByRoute('#/stats').id)
})
t('TAB_LIMIT 计数含 settings 标签（第 11 个 toast 提醒）', () => {
  resetTabs()
  TABS.setState({
    tabs: [
      ...Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, route: `#/chat/uniq${i}`, title: `t${i}` })),
      { id: 'ts', route: '#/settings/defaults', title: '设置' },
    ],
    activeTabId: 'ts',
  })
  const before = B.useToast.getState().toasts.length
  TABS.getState().openTab('#/kb/k1/d1')   // 第 11 个
  assert.strictEqual(TABS.getState().tabs.length, 11, '不硬禁：仍创建')
  assert.ok(B.useToast.getState().toasts.length > before, 'settings 计入上限后出现提醒 toast')
})
await ta('刷新恢复：无 hash + 记忆路由含 settings → 恢复激活 settings 标签', async () => {
  resetTabs()
  TABS.getState().openTab('#/kb/k1')
  TABS.getState().openTab('#/settings/defaults')   // 活跃=settings；last-route 被写入
  assert.strictEqual(globalThis.location.hash, '#/settings/defaults')
  // 模拟刷新：清内存标签（自动落盘空表）→ 写回刷新前持久化 → hydrate → 无 hash initRouter
  const persisted = localStorage.getItem('doc-assistant-tabs')
  TABS.setState({ tabs: [], activeTabId: null })
  localStorage.setItem('doc-assistant-tabs', persisted)
  assert.strictEqual(TABS.getState().hydrate(), true)
  globalThis.location.hash = ''
  markHistoryNav()
  globalThis.__teardown8?.()
  globalThis.__teardown8 = initRouter()   // 无 hash → 记忆路由 replaceState → adoption
  assert.strictEqual(globalThis.location.hash, '#/settings/defaults', '无 hash → 恢复记忆路由')
  const s = TABS.getState()
  assert.strictEqual(s.tabs.length, 2)
  assert.strictEqual(s.activeTabId, tabByRoute('#/settings/defaults').id, 'settings 标签被恢复激活')
  assert.strictEqual(APP.getState().page, 'settings')
  globalThis.__teardown8?.()
  globalThis.__teardown8 = undefined
})
t('源码契约：App 无整页覆盖特例；TabView 分发 settings/stats；恢复链 active 门控在位', () => {
  const appSrc = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.ok(!appSrc.includes("page === 'settings'"), 'App 不再整页覆盖设置页')
  assert.ok(!appSrc.includes("page === 'stats'"), 'App 不再整页覆盖统计占位页')
  assert.ok(appSrc.includes('if (route) useTabsStore.getState().adoptRoute'), 'App 监听采纳全部路由')
  const tvSrc = readFileSync(new URL('../src/components/TabView.tsx', import.meta.url), 'utf8')
  assert.ok(tvSrc.includes('<SettingsPage />'), 'TabView 分发 settings → SettingsPage')
  assert.ok(tvSrc.includes('<PlaceholderPage page="stats" />'), 'TabView 分发 stats → PlaceholderPage')
  // debug2 步骤2 的位置记忆修复与本步叠加的对接面：恢复 effect 依赖 active 翻转
  const pmSrc = readFileSync(new URL('../src/pages/main/PreviewMain.tsx', import.meta.url), 'utf8')
  assert.ok(pmSrc.includes('if (!active) { restoredDocRef.current = null; return }'),
    'PreviewMain 失活重置恢复标记在位（active 翻转才重放恢复）')
  assert.ok(pmSrc.includes('scrollMemoRestoreWhenReady(`live:${activeDocId}`, el)'),
    '再激活时从 scrollMemo 回填实时窗口位置')
})

unsubTabs()
console.log(`\n结果：${pass} 通过，${failed.length} 失败`)
if (failed.length) { console.error('失败用例：', failed); process.exitCode = 1 }
setTimeout(() => process.exit(process.exitCode ?? 0), 50)
