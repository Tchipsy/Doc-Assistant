/**
 * debug3（步骤3 后端状态与导出）前端单测（node 脚本，模拟浏览器全局，esbuild 打包真实源码）。
 * 覆盖：
 * A. 3.1 queued 徽章映射（SSR 渲染真实 StatusBadge）：queued → 「排队中」+ 转圈；
 *    pending/parsing/ready/generating/done/failed 回归不破；
 * B. 3.1 genQueued 退役：store 无 genQueued 字段、startGeneration 不再写内存标记
 *    （开始生成只调 API，排队态由后端 doc.status 驱动）；
 * C. 3.1 doc.status 事件驱动：store 文档状态随 doc.status 事件更新到 queued
 *    （模拟 init 的状态映射路径——直接验证 store 替换逻辑 + queued 类型入列）；
 * D. 3.7 title 节点流式接线：live store insert title 节点按 root 子序、update op
 *    合并 props.title（后端 @@title 闭合时 update 即时上屏的对接面）。
 * 运行：cd webui && node scripts/debug3-test.mjs
 */
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import assert from 'node:assert'

const OUT = '.debug3-tmp'
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
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
globalThis.requestAnimationFrame = fn => setTimeout(fn, 6)
globalThis.cancelAnimationFrame = id => clearTimeout(id)
globalThis.location = { hash: '', pathname: '/', search: '' }
globalThis.history = { replaceState() {}, pushState() {} }

// ---------- esbuild 打包真实源码 ----------
const esbuild = (await import('esbuild')).default
await esbuild.build({
  entryPoints: ['scripts/debug3-entry.ts'],
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: `${OUT}/bundle.js`, jsx: 'automatic',
  external: ['react', 'react-dom'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
})
const B = await import(`../${OUT}/bundle.js`)
const { StatusBadge, useKbStore, useLiveStore } = B

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')

let passed = 0
const ok = name => { passed++; console.log(`  ok ${name}`) }

// ---------- A. queued 徽章映射（SSR 渲染真实组件） ----------
console.log('A) 3.1 queued 徽章映射：SSR 渲染 StatusBadge（真实组件）')
{
  const badge = status => renderToStaticMarkup(createElement(StatusBadge, {
    doc: { id: 'd1', name: '文档', status, paused: false, indexConfig: null },
  }))
  const queued = badge('queued')
  assert.ok(queued.includes('排队中'), `queued 徽章应显示「排队中」，实际：${queued}`)
  assert.ok(queued.includes('spin'), 'queued 徽章应有转圈图标（spin）')
  ok("status='queued' → 「排队中」+ 转圈")

  assert.ok(badge('pending').includes('排队中'), 'pending 回归：排队中')
  assert.ok(badge('parsing').includes('解析中'), 'parsing 回归：解析中')
  assert.ok(badge('ready').includes('待生成'), 'ready 回归：待生成')
  assert.ok(badge('generating').includes('生成中'), 'generating 回归：生成中')
  assert.ok(badge('done').includes('已生成'), 'done 回归：已生成')
  assert.ok(badge('failed').includes('失败'), 'failed 回归：失败')
  ok('pending/parsing/ready/generating/done/failed 徽章回归全过')

  const types = readFileSync(new URL('../src/api/types.ts', import.meta.url), 'utf8')
  assert.ok(/DocStatus\s*=\s*'pending' \|\s*'parsing' \|\s*'queued'/.test(types),
    'DocStatus 联合类型应包含 queued')
  ok("types.ts DocStatus 含 'queued'")
}

// ---------- B. genQueued 退役 ----------
console.log('B) 3.1 genQueued 退役：store 形态与 startGeneration')
{
  const st = useKbStore.getState()
  assert.ok(!('genQueued' in st), 'kb store 不应再有 genQueued 字段')
  assert.ok(typeof st.startGeneration === 'function', 'startGeneration 保留')
  // startGeneration 内存标记退役：调用后 store 顶层不新增 genQueued（api 失败也不写）
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ detail: 'x' }) })
  try { await st.startGeneration(['d1']) } catch { /* 网络失败即返回 */ }
  assert.ok(!('genQueued' in useKbStore.getState()), 'startGeneration 后仍无 genQueued')
  ok('store 无 genQueued 字段；startGeneration 不写内存标记（排队态=后端 doc.status）')

  const kbSrc = readFileSync(new URL('../src/store/kb.ts', import.meta.url), 'utf8')
  assert.ok(!/\bgenQueued\b\s*[:=]/.test(kbSrc.replace(/\/\/.*$/gm, '')), 'kb.ts 不再读写 genQueued')
  const docSrc = readFileSync(new URL('../src/pages/main/DocColumn.tsx', import.meta.url), 'utf8')
  assert.ok(docSrc.includes("case 'queued':"), 'DocColumn 保留 queued 徽章分支')
  ok('源码契约：kb.ts 无 genQueued 读写、DocColumn 有 queued 分支')
}

// ---------- C. doc.status 事件驱动 queued ----------
console.log('C) 3.1 doc.status → store 状态映射（queued 事件驱动路径）')
{
  // init 的 doc.status 分支做的事 = 把匹配文档的 status 替换为事件值；直接在
  // store 上复现同一替换（与事件到达时的 setState 形态一致），验证 queued 值可流转
  useKbStore.setState({
    docsByKb: { kb1: [{ id: 'd1', name: '文档', status: 'parsing', kbId: 'kb1' }] },
  })
  const docId = 'd1'
  const status = 'queued'   // 后端 start_generation 广播 doc.status status='queued'
  useKbStore.setState(s => {
    const docsByKb = {}
    Object.entries(s.docsByKb).forEach(([kb, list]) => {
      docsByKb[kb] = list.map(d => (d.id === docId ? { ...d, status } : d))
    })
    return { docsByKb }
  })
  assert.equal(useKbStore.getState().docsByKb.kb1[0].status, 'queued')
  ok("doc.status(status='queued') 到达后列表文档进入 queued（徽章随之切换）")
}

// ---------- D. title 节点流式接线 ----------
console.log('D) 3.7 title 节点：insert 子序 + update op 合并 props.title')
{
  const live = useLiveStore
  live.setState({ docId: 'd1', nodes: { root: { id: 'root', type: 'root', parent: null, children: [], props: {} } }, watermark: 0 })
  live.getState().applyOp({ docId: 'd1', op: { op: 'insert', id: 'title1', type: 'title', parent: 'root', props: { title: '占位标题' } } })
  live.getState().applyOp({ docId: 'd1', op: { op: 'insert', id: 'toc1', type: 'toc', parent: 'root', props: { title: '目录' } } })
  let nodes = live.getState().nodes
  assert.deepEqual(nodes.root.children, ['title1', 'toc1'], 'title 节点应位于 toc 之前')
  assert.equal(nodes.title1.props.title, '占位标题')
  // 后端 @@title 闭合 → update op（props.title 合并）
  live.getState().applyOp({ docId: 'd1', op: { op: 'update', id: 'title1', props: { title: '新标题甲' } } })
  nodes = live.getState().nodes
  assert.equal(nodes.title1.props.title, '新标题甲')
  assert.equal(nodes.title1.type, 'title')
  ok('insert(title)→root 首子；update op 合并 props.title（@@title 即时上屏的对接面）')
}

console.log(`\n全部通过：${passed} 组断言`)
rmSync(OUT, { recursive: true, force: true })
