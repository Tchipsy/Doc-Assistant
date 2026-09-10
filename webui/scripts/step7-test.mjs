/**
 * 9.5 步骤7 单元测试（node 脚本，模拟浏览器全局，esbuild 打包真实源码）：
 * - lib/router.ts：parseHash/parseHashFull/buildRoute 全路由表 + 定位参数解析（a/p/f/q）；
 *   navigate/applyRoute 的 store 同步、文档移动静默重定向、已删除文档/会话回落、
 *   无 hash → localStorage 记忆路由、popstate 后退。
 * - lib/scrollMemo.ts：save/recall/clamp、localStorage 持久化与 500ms 写节流、
 *   restoreWhenReady 内容就绪恢复。
 * 运行：cd webui && node scripts/step7-test.mjs
 */
import { mkdirSync, rmSync } from 'node:fs'
import assert from 'node:assert'

const OUT = '.step7-tmp'
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

// ---------- fetch 桩（debug2 #7：回落前 refreshDoc 重拉文档列表的二次校验） ----------
// serverDocs=服务端"真源"视图（可注入"列表短暂缺行后恢复"场景）；null=网络失败
let serverDocs = null
const settle = () => new Promise(r => setImmediate(r))
const okJson = body => ({ ok: true, status: 200, json: async () => body })
const docRow = (id, kbId) => ({ id, kbId, name: id, sourceKind: 'md', status: 'ready', size: 0, createdAt: '' })
globalThis.fetch = async (path) => {
  const url = String(path)
  if (/\/knowledge-bases$/.test(url)) {
    return okJson({ kbs: [{ id: 'k1', name: 'K1' }, { id: 'k2', name: 'K2' }] })
  }
  const m = /\/knowledge-bases\/([^/]+)\/documents$/.exec(url)
  if (m) return okJson({ docs: serverDocs?.[m[1]] ?? [] })
  return okJson({})
}

// ---------- esbuild 打包真实源码（单入口：router + scrollMemo + stores 共享一份实例；CSS 置空） ----------
const esbuild = (await import('esbuild')).default
await esbuild.build({
  entryPoints: ['scripts/step7-entry.ts'],
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: `${OUT}/bundle.js`, jsx: 'automatic',
  loader: { '.css': 'empty' },
  logLevel: 'silent',
})
const B = await import(`../${OUT}/bundle.js`)
const { parseHash, parseHashFull, buildRoute, navigate, initRouter, onRouteChange,
  hasPendingLoc, scrollMemoSave, scrollMemoRecall, scrollMemoFlush, scrollMemoRestoreWhenReady,
  useKbStore: KB, useChatStore: CHAT, useAppStore: APP } = B

// ---------- 预置数据（与后端 docs.kb_id 对应） ----------
KB.setState({
  kbs: [{ id: 'k1', name: 'K1' }, { id: 'k2', name: 'K2' }],
  docsByKb: {
    k1: [{ id: 'd1', kbId: 'k1', name: 'A' }],
    k2: [{ id: 'd9', kbId: 'k2', name: 'B' }],
  },
  activeKbId: null, activeDocId: null, kbSel: [], docSel: [], kbAnchor: null, docAnchor: null,
})
CHAT.setState({ sessions: [{ id: 's1', title: 'S1', createdAt: '', updatedAt: '' }], activeId: null, msgs: {}, ui: {} })
APP.setState({ page: 'main' })

let pass = 0
const failed = []
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`) } catch (e) { failed.push(name); console.error(`FAIL  ${name}\n      ${e.message}`) }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`) } catch (e) { failed.push(name); console.error(`FAIL  ${name}\n      ${e.message}`) }
}

console.log('\n== router: parseHash 全路由表（名词规范 §十一） ==')
t('chat 路由', () => {
  assert.deepStrictEqual(parseHash('#/chat/abc123'), { view: 'chat', sessionId: 'abc123' })
})
t('kb 路由（未选中文档）', () => {
  assert.deepStrictEqual(parseHash('#/kb/k1'), { view: 'kb', kbId: 'k1', docId: undefined })
})
t('kb 路由（选中文档）= 唯一的文档路由形式', () => {
  assert.deepStrictEqual(parseHash('#/kb/k1/d1'), { view: 'kb', kbId: 'k1', docId: 'd1' })
})
t('settings 路由（带/不带分区）', () => {
  assert.deepStrictEqual(parseHash('#/settings/presets'), { view: 'settings', section: 'presets' })
  assert.deepStrictEqual(parseHash('#/settings'), { view: 'settings', section: undefined })
})
t('无 hash / 非法前缀 → null', () => {
  assert.strictEqual(parseHash(''), null)
  assert.strictEqual(parseHash('#'), null)
  assert.strictEqual(parseHash('#/bogus/x'), null)
  assert.strictEqual(parseHash('#/kb'), null)          // 缺 kbId
  assert.strictEqual(parseHash('#/chat/'), null)       // 缺 sessionId
})
t('默认参数读 location.hash', () => {
  globalThis.location.hash = '#/kb/k9'
  assert.deepStrictEqual(parseHash(), { view: 'kb', kbId: 'k9', docId: undefined })
  globalThis.location.hash = ''
})

console.log('\n== router: 定位参数协议（优先级 a > p > q） ==')
t('a 锚点解析（organized 命名空间）', () => {
  const { route, loc } = parseHashFull('#/kb/k1/d1?a=organized:3.2')
  assert.strictEqual(route.docId, 'd1')
  assert.strictEqual(loc.a, 'organized:3.2')
})
t('a 锚点 URL 编码解码（plugin 中文命名空间）', () => {
  const { loc } = parseHashFull('#/kb/k1/d1?a=' + encodeURIComponent('plugin:作业解答:3.2'))
  assert.strictEqual(loc.a, 'plugin:作业解答:3.2')
})
t('p/f PDF 页定位解析（步骤6 消费）', () => {
  const { loc } = parseHashFull('#/kb/k1/d1?p=5&f=0.66')
  assert.strictEqual(loc.p, 5)
  assert.strictEqual(loc.f, 0.66)
})
t('q 文本回退解析（编码空格）', () => {
  const { loc } = parseHashFull('#/chat/s1?q=hello%20world')
  assert.strictEqual(loc.q, 'hello world')
})
t('全参数组合：写出顺序 a>p>f>q，往返一致', () => {
  const h = buildRoute({ view: 'kb', kbId: 'k1', docId: 'd1' }, { q: '回退文本', f: 0.5, p: 3, a: 'summary:1' })
  assert.ok(h.startsWith('#/kb/k1/d1?'), h)
  const order = ['a=', 'p=3', 'f=0.5', 'q='].map(s => h.indexOf(s))
  assert.deepStrictEqual(order, [...order].sort((x, y) => x - y), '参数顺序应为 a,p,f,q')
  const back = parseHashFull(h)
  assert.strictEqual(back.loc.a, 'summary:1')
  assert.strictEqual(back.loc.p, 3)
  assert.strictEqual(back.loc.f, 0.5)
  assert.strictEqual(back.loc.q, '回退文本')
})
t('buildRoute 无定位参数往返一致', () => {
  assert.strictEqual(buildRoute({ view: 'chat', sessionId: 's1' }), '#/chat/s1')
  assert.strictEqual(buildRoute({ view: 'kb', kbId: 'k1' }), '#/kb/k1')
  assert.strictEqual(buildRoute({ view: 'kb', kbId: 'k1', docId: 'd1' }), '#/kb/k1/d1')
  assert.strictEqual(buildRoute({ view: 'settings', section: 'parsing' }), '#/settings/parsing')
  assert.strictEqual(buildRoute({ view: 'settings' }), '#/settings')
})
t('非法 p/f 被丢弃', () => {
  const { loc } = parseHashFull('#/kb/k1/d1?p=abc&f=xyz')
  assert.strictEqual(loc.p, undefined)
  assert.strictEqual(loc.f, undefined)
})

console.log('\n== router: navigate / applyRoute / store 同步（单视图阶段） ==')
let events = []
const unsub = onRouteChange((route, loc) => events.push({ route: route && { ...route }, loc: { ...loc } }))

await ta('navigate 文档路由 → pushState + page/activeKbId/activeDocId 同步 + 记忆 + 消费调度', async () => {
  const before = historyStack.length
  navigate({ view: 'kb', kbId: 'k1', docId: 'd1' }, { a: 'organized:1.1' })
  assert.strictEqual(globalThis.location.hash, '#/kb/k1/d1?a=' + encodeURIComponent('organized:1.1'))
  assert.strictEqual(historyStack.length, before + 1, '导航性变化应 pushState 新增历史')
  assert.strictEqual(KB.getState().activeKbId, 'k1')
  assert.strictEqual(KB.getState().activeDocId, 'd1')
  assert.deepStrictEqual(KB.getState().docSel, ['d1'])
  assert.strictEqual(APP.getState().page, 'main')
  assert.strictEqual(localStorage.getItem('doc-assistant-last-route'), '#/kb/k1/d1')
  const last = events[events.length - 1]
  assert.strictEqual(last.route.docId, 'd1')
  assert.strictEqual(last.loc.a, 'organized:1.1')
  assert.strictEqual(hasPendingLoc('d1'), true, '带定位参数应进入消费队列')
  assert.strictEqual(hasPendingLoc('d9'), false)
})
await ta('文档被移动知识库 → 以 docId 查 docs.kb_id 静默 replaceState 重定向', async () => {
  const before = historyStack.length
  navigate({ view: 'kb', kbId: 'k1', docId: 'd9' })
  assert.strictEqual(globalThis.location.hash, '#/kb/k2/d9', '应重定向到文档实际所在库')
  assert.strictEqual(historyStack.length, before + 1, '重定向原地替换（replaceState），不额外新增历史')
  assert.strictEqual(historyStack[historyStack.length - 1], '#/kb/k2/d9')
  assert.strictEqual(KB.getState().activeKbId, 'k2')
  assert.strictEqual(KB.getState().activeDocId, 'd9')
})
await ta('文档已删除 → 重拉列表二次校验仍查无 → toast+回落 kb 视图（debug2 #7）', async () => {
  serverDocs = { k1: [docRow('d1', 'k1')], k2: [docRow('d9', 'k2')] }   // 真源也无 nope
  navigate({ view: 'kb', kbId: 'k2', docId: 'nope' })
  assert.strictEqual(globalThis.location.hash, '#/kb/k2/nope', '二次校验期间不立即回落（保持当前视图）')
  for (let i = 0; i < 5; i++) await settle()
  assert.strictEqual(globalThis.location.hash, '#/kb/k2', '重拉后仍查无 → 回落（去掉 docId）')
  assert.strictEqual(KB.getState().activeDocId, null)
  assert.strictEqual(APP.getState().page, 'main')
})
await ta('debug2 #7：列表短暂缺行 → 重拉后查到 → 不回落正常应用', async () => {
  serverDocs = { k1: [docRow('d1', 'k1'), docRow('d1x', 'k1')], k2: [docRow('d9', 'k2')] }
  KB.setState(s => ({ docsByKb: { ...s.docsByKb, k1: [s.docsByKb.k1[0]] } }))   // store 视图暂缺 d1x
  navigate({ view: 'kb', kbId: 'k1', docId: 'd1x' })
  assert.strictEqual(globalThis.location.hash, '#/kb/k1/d1x', '缺行不误回落')
  for (let i = 0; i < 5; i++) await settle()
  assert.strictEqual(globalThis.location.hash, '#/kb/k1/d1x', '重拉命中 → 不回落')
  assert.strictEqual(KB.getState().activeDocId, 'd1x', '文档正常激活')
  assert.strictEqual(KB.getState().docsByKb.k1.some(d => d.id === 'd1x'), true, 'refreshDoc 已回填列表')
})
await ta('知识库已删除 → 默认视图（第一个库）', async () => {
  navigate({ view: 'kb', kbId: 'zzz' })
  assert.strictEqual(globalThis.location.hash, '#/kb/k1')
})
await ta('chat 路由 → page=assistant + activeId 同步', async () => {
  navigate({ view: 'chat', sessionId: 's1' })
  assert.strictEqual(globalThis.location.hash, '#/chat/s1')
  assert.strictEqual(APP.getState().page, 'assistant')
  assert.strictEqual(CHAT.getState().activeId, 's1')
})
await ta('会话已删除 → toast + 回落到默认会话', async () => {
  navigate({ view: 'chat', sessionId: 'gone' })
  assert.strictEqual(globalThis.location.hash, '#/chat/s1')
  assert.strictEqual(CHAT.getState().activeId, 's1')
})
await ta('同 hash 重复导航（再次点击同一引用）不新增历史，但重新消费定位参数', async () => {
  navigate({ view: 'kb', kbId: 'k1', docId: 'd1' }, { a: 'summary:2' })
  const n1 = historyStack.length
  navigate({ view: 'kb', kbId: 'k1', docId: 'd1' }, { a: 'summary:2' })
  assert.strictEqual(historyStack.length, n1, '同 hash 不新增历史')
  assert.strictEqual(hasPendingLoc('d1'), true)
  assert.strictEqual(events[events.length - 1].loc.a, 'summary:2')
})
console.log('\n== router: 无 hash → localStorage 记忆的上次活跃视图 ==')
await ta('initRouter：注册 popstate/hashchange；无 hash 时 replaceState 到记忆路由', async () => {
  localStorage.setItem('doc-assistant-last-route', '#/kb/k2/d9')
  globalThis.location.hash = ''
  globalThis.__teardownRouter = initRouter()
  assert.strictEqual(globalThis.location.hash, '#/kb/k2/d9', '应打开记忆的上次活跃视图')
  assert.strictEqual(KB.getState().activeKbId, 'k2')
  assert.strictEqual(KB.getState().activeDocId, 'd9')
  assert.ok((winListeners.get('popstate') ?? []).length > 0, '应注册 popstate 监听')
  assert.ok((winListeners.get('hashchange') ?? []).length > 0, '应注册 hashchange 监听')
})
await ta('popstate（浏览器后退）→ 重新应用路由并同步 store', async () => {
  globalThis.location.hash = '#/chat/s1'
  for (const l of winListeners.get('popstate') ?? []) l()
  assert.strictEqual(APP.getState().page, 'assistant')
  assert.strictEqual(CHAT.getState().activeId, 's1')
})
await ta('teardown 移除监听（StrictMode 双挂载安全）', async () => {
  globalThis.__teardownRouter()
  assert.strictEqual((winListeners.get('popstate') ?? []).length, 0, 'teardown 移除监听')
  assert.strictEqual((winListeners.get('hashchange') ?? []).length, 0, 'teardown 移除监听')
})

console.log('\n== scrollMemo：存取 / 持久化 / 恢复 ==')
function fakeEl(scrollHeight, clientHeight, scrollTop) {
  return { scrollHeight, clientHeight, scrollTop }
}
t('save/recall：内存即时可读', () => {
  scrollMemoSave('live:d1', fakeEl(5000, 500, 1234))
  assert.strictEqual(scrollMemoRecall('live:d1'), 1234)
})
t('save 超出可滚范围 clamp 到底', () => {
  scrollMemoSave('live:dc', fakeEl(5000, 500, 9999))
  assert.strictEqual(scrollMemoRecall('live:dc'), 4500)
})
t('不可滚动（scrollHeight==clientHeight）存 0', () => {
  scrollMemoSave('live:dz', fakeEl(500, 500, 300))
  assert.strictEqual(scrollMemoRecall('live:dz'), 0)
})
await ta('flush：切换前显式落盘 localStorage（JSON {key: pos}）', async () => {
  scrollMemoSave('src:d1', fakeEl(8000, 400, 700))
  scrollMemoFlush()
  const all = JSON.parse(localStorage.getItem('doc-assistant-scroll'))
  assert.strictEqual(all['src:d1'], 700)
})
await ta('写节流 500ms：未 flush 前不落盘，到期自动落盘', async () => {
  scrollMemoSave('src:d2', fakeEl(8000, 400, 222))
  let all = JSON.parse(localStorage.getItem('doc-assistant-scroll') ?? '{}')
  assert.strictEqual(all['src:d2'], undefined, '节流窗口内未写 localStorage')
  assert.strictEqual(scrollMemoRecall('src:d2'), 222, '但内存可读')
  await new Promise(r => setTimeout(r, 600))
  all = JSON.parse(localStorage.getItem('doc-assistant-scroll'))
  assert.strictEqual(all['src:d2'], 222, '500ms 后自动落盘')
})
t('recall 内存 miss → 读 localStorage（刷新/重启恢复路径）', () => {
  const all = JSON.parse(localStorage.getItem('doc-assistant-scroll') ?? '{}')
  all['src:only-ls'] = 321
  localStorage.setItem('doc-assistant-scroll', JSON.stringify(all))
  assert.strictEqual(scrollMemoRecall('src:only-ls'), 321)
})
await ta('restoreWhenReady：内容就绪（scrollHeight 稳定）后恢复', async () => {
  // 模拟内容逐步加载：getter 前 4 次调用返回增长高度，之后稳定在 9000
  let calls = 0
  const el = { clientHeight: 500, scrollTop: 0 }
  Object.defineProperty(el, 'scrollHeight', { get: () => (calls++ < 4 ? (calls + 1) * 1000 : 9000) })
  const all = JSON.parse(localStorage.getItem('doc-assistant-scroll') ?? '{}')
  all['live:r1'] = 4000
  localStorage.setItem('doc-assistant-scroll', JSON.stringify(all))
  let donePos = null
  const ok = scrollMemoRestoreWhenReady('live:r1', el, { onDone: p => { donePos = p } })
  assert.strictEqual(ok, true, '存在记忆应返回 true')
  await new Promise(r => setTimeout(r, 150))
  assert.strictEqual(el.scrollTop, 4000, '内容就绪后恢复到记忆位置')
  assert.strictEqual(donePos, 4000)
})
await ta('restoreWhenReady：恢复值超出当前高度 → clamp 到当前可滚范围', async () => {
  const el = { clientHeight: 500, scrollHeight: 2000, scrollTop: 0 }
  const all = JSON.parse(localStorage.getItem('doc-assistant-scroll') ?? '{}')
  all['live:r2'] = 5000
  localStorage.setItem('doc-assistant-scroll', JSON.stringify(all))
  const pos = await new Promise(res => scrollMemoRestoreWhenReady('live:r2', el, { onDone: res, timeoutMs: 400 }))
  assert.strictEqual(el.scrollTop, 1500, 'clamp 到底')
  assert.strictEqual(pos, 1500)
})
await ta('restoreWhenReady：超时放弃（内容始终不稳定）', async () => {
  const el = { clientHeight: 500, scrollTop: 0 }
  Object.defineProperty(el, 'scrollHeight', { get: () => 1000 + Math.floor(Math.random() * 5000) })
  const all = JSON.parse(localStorage.getItem('doc-assistant-scroll') ?? '{}')
  all['live:r3'] = 100
  localStorage.setItem('doc-assistant-scroll', JSON.stringify(all))
  const pos = await new Promise(res => scrollMemoRestoreWhenReady('live:r3', el, { onDone: res, timeoutMs: 120 }))
  assert.strictEqual(typeof pos, 'number', '超时也应触发 onDone 收尾')
})
t('restoreWhenReady：无记忆返回 false（调用方走默认行为）', () => {
  const el = fakeEl(2000, 500, 0)
  assert.strictEqual(scrollMemoRestoreWhenReady('live:none', el), false)
})

unsub()
console.log(`\n结果：${pass} 通过，${failed.length} 失败`)
if (failed.length) { console.error('失败用例：', failed); process.exitCode = 1 }
setTimeout(() => process.exit(process.exitCode ?? 0), 50)
