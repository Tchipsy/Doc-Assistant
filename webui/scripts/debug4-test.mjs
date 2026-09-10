/**
 * debug4（步骤4 导入与分支）前端单测（node 脚本，模拟浏览器全局，esbuild 打包真实源码）。
 * 覆盖：
 * A. #3 fetching 徽章映射（SSR 渲染真实 StatusBadge）：fetching → 「抓取中」+ 转圈；
 *    pending/parsing/queued/ready/generating/done/failed 回归不破；
 * B. #3 源码契约：DocStatus 联合类型含 'fetching'、DocColumn fetching 分支/
 *    IndexBadge 排除/菜单 hasFetching 禁用/导入弹窗 toast「已开始抓取」；
 * C. #14 branch 两态（真实 store + 桩 fetch 捕获请求体）：includeCurrent=false
 *    请求体落库 + draftContent 写入新会话草稿；缺省 includeCurrent=true、草稿空；
 * D. #14 源码契约：MessageActions user/assistant 两态分支与 tooltip、
 *    httpAdapter includeCurrent 透传、chat.ts 草稿写入。
 * 运行：cd webui && node scripts/debug4-test.mjs
 */
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import assert from 'node:assert'

const OUT = '.debug4-tmp'
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ---------- 浏览器全局模拟（必须在 import bundle 之前） ----------
globalThis.window = globalThis
globalThis.addEventListener = () => {}       // router.ts 模块级 popstate 监听
globalThis.removeEventListener = () => {}

const lsStore = new Map()
globalThis.localStorage = {
  getItem: k => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: k => lsStore.delete(k),
}
globalThis.document = {
  documentElement: { classList: { toggle() {}, add() {}, remove() {} } },
  querySelector: () => null,
  querySelectorAll: () => [],
  body: {},
}
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } }, configurable: true,
})
let fetchCalls = []
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init: init ?? {} })
  // 分支会话桩：按 messageId 返回不同新会话
  if (init?.body && String(init.body).includes('"m2"')) {
    return okRes({ id: 'ns1', title: '源会话（分支）', mode: 'chat', model: null,
      kbIds: [], webSearch: false, createdAt: '', updatedAt: '' })
  }
  if (init?.body && String(init.body).includes('"m3"')) {
    return okRes({ id: 'ns2', title: '源会话（分支）', mode: 'chat', model: null,
      kbIds: [], webSearch: false, createdAt: '', updatedAt: '' })
  }
  if (String(url).endsWith('/messages')) return okRes({ messages: [] })
  return okRes({})
}
function okRes(body) {
  return { ok: true, status: 200, json: async () => body }
}
globalThis.requestAnimationFrame = fn => setTimeout(fn, 6)
globalThis.cancelAnimationFrame = id => clearTimeout(id)
globalThis.location = { hash: '', pathname: '/', search: '' }
globalThis.history = { replaceState() {}, pushState() {} }

// ---------- esbuild 打包真实源码 ----------
const esbuild = (await import('esbuild')).default
await esbuild.build({
  entryPoints: ['scripts/debug4-entry.ts'],
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: `${OUT}/bundle.js`, jsx: 'automatic',
  external: ['react', 'react-dom'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
})
const B = await import(`../${OUT}/bundle.js`)
const { StatusBadge, useChatStore } = B

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')

let passed = 0
const ok = name => { passed++; console.log(`  ok ${name}`) }
const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8')

// ---------- A. fetching 徽章映射（SSR 渲染真实组件） ----------
console.log('A) #3 fetching 徽章映射：SSR 渲染 StatusBadge（真实组件）')
{
  const badge = status => renderToStaticMarkup(createElement(StatusBadge, {
    doc: { id: 'd1', name: '网页', status, paused: false, indexConfig: null },
  }))
  const fetching = badge('fetching')
  assert.ok(fetching.includes('抓取中'), `fetching 徽章应显示「抓取中」，实际：${fetching}`)
  assert.ok(fetching.includes('spin'), 'fetching 徽章应有转圈图标（spin）')
  ok("status='fetching' → 「抓取中」+ 转圈")

  assert.ok(badge('pending').includes('排队中'), 'pending 回归：排队中')
  assert.ok(badge('parsing').includes('解析中'), 'parsing 回归：解析中')
  assert.ok(badge('queued').includes('排队中') && badge('queued').includes('spin'), 'queued 回归：排队中+转圈')
  assert.ok(badge('ready').includes('待生成'), 'ready 回归：待生成')
  assert.ok(badge('generating').includes('生成中'), 'generating 回归：生成中')
  assert.ok(badge('done').includes('已生成'), 'done 回归：已生成')
  assert.ok(badge('failed').includes('失败'), 'failed 回归：失败')
  ok('pending/parsing/queued/ready/generating/done/failed 徽章回归全过')

  const types = read('../src/api/types.ts')
  assert.ok(/'queued' \| 'fetching' \| 'ready'/.test(types), 'DocStatus 联合类型应包含 fetching')
  ok("types.ts DocStatus 含 'fetching'")
}

// ---------- B. #3 源码契约 ----------
console.log('B) #3 源码契约：fetching 门控与导入弹窗提示')
{
  const docSrc = read('../src/pages/main/DocColumn.tsx')
  assert.ok(docSrc.includes("case 'fetching':"), 'StatusBadge 应有 fetching 分支')
  assert.ok(docSrc.includes('抓取中'), '徽章文案「抓取中」')
  assert.ok(docSrc.includes("doc.status === 'parsing' || doc.status === 'fetching'"),
    'IndexBadge 应排除 fetching（无入库状态）')
  assert.ok(docSrc.includes('hasFetching') && docSrc.includes('disabled: hasFetching'),
    '右键菜单应以 hasFetching 禁用 修改配置/导出')
  assert.ok(docSrc.includes("toast('已开始抓取')"), '导入弹窗提交后 toast「已开始抓取」')
  const mainSrc = read('../src/pages/main/MainPage.tsx')
  assert.ok(mainSrc.includes("activeDoc.status !== 'fetching'"), 'BottomBar 对 fetching 隐藏')
  const pvSrc = read('../src/pages/main/PreviewMain.tsx')
  assert.ok(pvSrc.includes("activeDoc.status === 'fetching'"), 'PreviewMain 顶栏/占位含 fetching 分支')
  ok('DocColumn fetching 徽章/IndexBadge 排除/菜单禁用；MainPage 底边栏隐藏；PreviewMain 顶栏占位')
}

// ---------- C. #14 branch 两态（真实 store + 桩 fetch） ----------
console.log('C) #14 branch 两态：includeCurrent 请求体 + draftContent 草稿写入')
{
  // 种子状态：一个源会话 s1 处于激活位
  useChatStore.setState({
    sessions: [{ id: 's1', title: '源会话', mode: 'chat', model: null, kbIds: [],
      webSearch: false, createdAt: '', updatedAt: '' }],
    activeId: 's1',
    msgs: { s1: [] },
    ui: { s1: { mode: 'chat', model: null, kbIds: [], webSearch: false, draft: '' } },
    sendingSid: null,
  })
  fetchCalls = []

  // user 消息分支：includeCurrent=false + 本条内容放回输入框草稿
  await useChatStore.getState().branch('m2', { includeCurrent: false, draftContent: '问题：你好' })
  const br1 = fetchCalls.find(c => c.url.endsWith('/sessions/s1/branch'))
  assert.ok(br1, '应发起 POST /sessions/{sid}/branch')
  const body1 = JSON.parse(br1.init.body)
  assert.equal(body1.messageId, 'm2')
  assert.equal(body1.includeCurrent, false, 'user 消息分支请求体应带 includeCurrent=false')
  const st1 = useChatStore.getState()
  assert.equal(st1.activeId, 'ns1', '分支后选中新会话')
  assert.equal(st1.sessions[0].id, 'ns1', '新会话插入列表首位')
  assert.deepEqual(st1.msgs['ns1'], [], '新会话消息列表=服务端返回（user 分支为空亦正常）')
  assert.equal(st1.ui['ns1'].draft, '问题：你好', 'draftContent 应写入新会话草稿（本条放入输入框）')
  ok('user 分支：includeCurrent=false 落请求体；draftContent 写入 ui[new].draft')

  // assistant 消息分支（缺省 opts）：includeCurrent=true、无草稿
  await useChatStore.getState().branch('m3')
  const br2 = fetchCalls.find(c => c.init?.body && String(c.init.body).includes('"m3"'))
  assert.ok(br2, '应发起第二次 branch 请求')
  const body2 = JSON.parse(br2.init.body)
  assert.equal(body2.includeCurrent, true, '缺省 includeCurrent=true（后端默认一致，旧调用兼容）')
  const st2 = useChatStore.getState()
  assert.equal(st2.ui['ns2'].draft, '', '无 draftContent 时新会话草稿为空')
  assert.equal(st2.activeId, 'ns2')
  ok('assistant 分支（缺省）：includeCurrent=true、草稿为空（现状语义不变）')
}

// ---------- D. #14 源码契约 ----------
console.log('D) #14 源码契约：MessageActions 两态 / httpAdapter 透传 / chat.ts 草稿')
{
  const pageSrc = read('../src/pages/assistant/AssistantPage.tsx')
  assert.ok(pageSrc.includes('export function MessageActions'), 'MessageActions 导出供单测')
  assert.ok(pageSrc.includes('includeCurrent: false, draftContent: msg.content'),
    'user 消息分支：includeCurrent=false + 本条内容入草稿')
  assert.ok(pageSrc.includes('复制之前的消息，本条放入输入框'), 'user 分支 tooltip 文案')
  assert.ok(pageSrc.includes("msg.role === 'user' ? '复制之前的消息，本条放入输入框' : '对话分支（复制该消息及之前）'"),
    'assistant 分支 tooltip 维持现状文案')
  const chatSrc = read('../src/store/chat.ts')
  assert.ok(chatSrc.includes('opts?.includeCurrent ?? true'), 'store branch 缺省 includeCurrent=true')
  assert.ok(chatSrc.includes("draft: opts?.draftContent ?? ''"), 'store branch 写入 draftContent')
  const adapterSrc = read('../src/api/httpAdapter.ts')
  assert.ok(adapterSrc.includes('includeCurrent: opts?.includeCurrent ?? true'),
    'httpAdapter 透传 includeCurrent（缺省 true）')
  ok('MessageActions 两态调用与 tooltip、httpAdapter/chat.ts 契约全过')
}

console.log(`\n全部通过：${passed} 组断言`)
rmSync(OUT, { recursive: true, force: true })
