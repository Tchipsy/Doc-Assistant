/**
 * SSE 投递链修复——前端自愈单测（node 脚本，模拟浏览器全局，esbuild 打包真实源码）。
 * 覆盖（2026-09-07 "实时预览流式失效"修复；A/B 已随 debug1 适配 fetch 流式订阅）：
 * - httpAdapter.subscribeEvents（fetch 版）：建连成功触发 onResync、事件帧分发、cancel 干净；
 * - wireLiveEvents：建连 onResync → 300ms 防抖一次 reload；断线自动重建后再次防抖 reload；
 * - scheduleResync 防抖：300ms 窗口内多次触发只重拉一次（fake timer）；
 * - applyOp 缺失节点（append/setmd/update）→ 防抖 resync；存量节点/水位线内事件不触发；
 * - reload 后水位线推进（重放污染防护不回归）。
 * 运行：cd webui && node scripts/ssefix-test.mjs
 */
import { mkdirSync, rmSync } from 'node:fs'
import assert from 'node:assert'

const OUT = '.ssefix-tmp'
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ---------- 浏览器全局模拟（必须在 import bundle 之前） ----------
globalThis.window = globalThis

// fake timers（scheduleResync/看门狗/退避用 setTimeout；只劫持 setTimeout/clearTimeout）
let now = 0
let seq = 0
const timers = []
globalThis.setTimeout = (fn, ms) => {
  const id = ++seq
  timers.push({ id, fn, at: now + (ms || 0) })
  return id
}
globalThis.clearTimeout = id => {
  const i = timers.findIndex(t => t.id === id)
  if (i >= 0) timers.splice(i, 1)
}
function advance(ms) {
  now += ms
  const due = timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at)
  for (const t of due) {
    const i = timers.indexOf(t)
    if (i >= 0) {
      timers.splice(i, 1)
      t.fn()
    }
  }
}
const settle = () => new Promise(r => setImmediate(r))
globalThis.requestAnimationFrame = fn => setTimeout(fn, 6)
globalThis.cancelAnimationFrame = id => clearTimeout(id)

// fetch 桩：统计 /preview 调用（reload 次数），返回"生成中"快照（不走 IndexedDB 水合）。
// 树里带 exist 节点：reload 重建树后 exist 仍存在（否则针对 exist 的 op 会正确地
// 触发自愈 resync——那是实现行为，不是本用例要测的场景）。
let previewCalls = 0
let lastPreviewLastId = 100
const STUB_NODES = () => ({
  root: { id: 'root', type: 'root', parent: null, children: ['exist'], props: {} },
  exist: { id: 'exist', type: 'section', parent: 'root', children: [], props: {}, md: '' },
})

// /events 可控流（debug1：fetch 流式订阅）：记录每次建连，abort 时 error 掉流
let eventsFetches = []
let eventStreams = []
const enc = new TextEncoder()
const eventsStream = () => eventStreams[eventStreams.length - 1]

globalThis.fetch = async (path, init) => {
  const url = String(path)
  if (url.includes('/preview')) {
    previewCalls++
    return {
      ok: true, status: 200,
      json: async () => ({
        status: 'generating', genConfig: { presetId: 'p1' },
        tree: { nodes: STUB_NODES() }, lastId: ++lastPreviewLastId,
      }),
    }
  }
  if (url.includes('/events')) {
    eventsFetches.push({ url, headers: init?.headers ?? {} })
    let ctrl
    const rs = new ReadableStream({
      start(c) {
        ctrl = c
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            try { c.error(new Error('aborted')) } catch { /* 已关闭 */ }
          })
        }
      },
    })
    eventStreams.push({ ctrl })
    return Promise.resolve({ ok: true, status: 200, body: rs })
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

globalThis.console.warn = () => {}   // 静音传输层告警

// ---------- esbuild 打包真实源码 ----------
const esbuild = (await import('esbuild')).default
await esbuild.build({
  entryPoints: ['scripts/ssefix-entry.ts'],
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: `${OUT}/bundle.js`, jsx: 'automatic',
  external: ['react', 'react-dom'],
  loader: { '.css': 'empty' },   // katex.min.css 字体链在 node 打包中置空（沿用 step8 模式）
})
const { useLiveStore, wireLiveEvents, scheduleResync, httpAdapter } = await import(`../${OUT}/bundle.js`)

let passed = 0
const ok = name => { passed++; console.log(`  ok ${name}`) }

// ---------- A. subscribeEvents 契约（debug1 起为 fetch 流式版） ----------
console.log('A) httpAdapter.subscribeEvents（fetch 版）：建连→onResync / 帧分发 / cancel')
{
  let resyncs = 0
  const got = []
  const un = httpAdapter.subscribeEvents(ev => got.push(ev), () => { resyncs++ })
  await settle(); await settle()
  assert.equal(eventsFetches.length, 1)
  assert.equal(eventsFetches[0].url, '/api/events')
  assert.equal(resyncs, 1, '建连成功必须触发 onResync（自愈接线）')
  ok('订阅即建连 GET /api/events，建连成功触发 onResync')

  eventsStream().ctrl.enqueue(enc.encode(
    'id: 1\nevent: render.op\ndata: {"channel":"render.op","docId":"d1","_id":1,"op":{"op":"append","id":"x","text":"A"}}\n\n'))
  await settle()
  assert.equal(got.length, 1, 'render.op 帧分发到 handler')
  assert.equal(got[0].op.text, 'A')
  ok('事件帧解析并分发')

  un()
  await settle()
  const n = eventsFetches.length
  advance(60_000)
  await settle()
  assert.equal(eventsFetches.length, n, '取消后不再重建连接')
  ok('取消函数可用（StrictMode cleanup）')
}

// ---------- B. wireLiveEvents 接线：建连 onResync → 防抖 reload；断线重建后再次防抖 reload ----------
console.log('B) wireLiveEvents：建连 → 防抖 300ms reload；断线重建 → 再次防抖 reload')
{
  useLiveStore.setState({ docId: 'd1', nodes: { root: { id: 'root', type: 'root', parent: null, children: [], props: {} } }, watermark: 100 })
  const base = previewCalls
  const baseFetches = eventsFetches.length
  const un = wireLiveEvents()
  await settle(); await settle()          // 首连 → onResync → scheduleResync（防抖）
  assert.equal(eventsFetches.length, baseFetches + 1, 'wireLiveEvents 建连一次')

  advance(299)
  assert.equal(previewCalls, base, '299ms 内不得触发（防抖未到期）')
  advance(1)
  await settle()
  assert.equal(previewCalls, base + 1, '300ms 到期恰好触发一次 reload')
  ok('建连 onResync → 300ms 防抖后一次 reload（299ms 时为零次）')

  // 断线：流断开 → 500ms 退避重建 → onResync → 再次防抖 reload
  eventsStream().ctrl.error(new Error('server closed'))
  await settle()
  advance(500); await settle(); await settle()   // 重建成功 → onResync
  assert.equal(eventsFetches.length, baseFetches + 2, '断线后自动重建连接')
  advance(299)
  assert.equal(previewCalls, base + 1, '第二次 resync 仍在防抖窗口内（未到期）')
  advance(1)
  await settle()
  assert.equal(previewCalls, base + 2, '重建成功后再次防抖 reload 一次')
  ok('断线自动重建 → onResync → 再次防抖 reload（自愈闭环）')

  un()
  await settle()
  ok('wireLiveEvents 取消函数可用（StrictMode cleanup）')
}

// ---------- C. applyOp 缺失节点 → 防抖 resync ----------
console.log('C) applyOp：缺失节点不静默丢——防抖 resync 自愈')
{
  const s = useLiveStore.getState()
  useLiveStore.setState({ docId: 'd2', nodes: { root: { id: 'root', type: 'root', parent: null, children: [], props: {} },
    exist: { id: 'exist', type: 'section', parent: 'root', children: [], props: {}, md: '' } }, watermark: 200 })
  const base = previewCalls

  // 水位线内的事件：跳过，不触发 resync
  s.applyOp({ docId: 'd2', _id: 150, op: { op: 'append', id: 'ghost', text: 'x' } })
  advance(300)
  await settle()
  assert.equal(previewCalls, base, '水位线内缺失节点不触发（重放事件本就丢弃）')
  ok('水位线内重放事件不触发 resync')

  // 缺失节点 append ×5：300ms 内合并为一次
  for (let i = 0; i < 5; i++) s.applyOp({ docId: 'd2', _id: 201 + i, op: { op: 'append', id: 'missing', text: 'a' } })
  advance(299)
  assert.equal(previewCalls, base, '299ms 内不得触发')
  advance(1)
  await settle()
  assert.equal(previewCalls, base + 1, '5 次缺失只触发一次 reload')
  ok('缺失节点 append ×5 → 300ms 防抖合并为一次 reload（防抖不放大）')

  // setmd/update 缺失同样触发；存量节点不触发
  s.applyOp({ docId: 'd2', _id: 210, op: { op: 'setmd', id: 'missing2', text: 'y' } })
  s.applyOp({ docId: 'd2', _id: 211, op: { op: 'update', id: 'missing3', props: { refs: {} } } })
  advance(300)
  await settle()
  assert.equal(previewCalls, base + 2, 'setmd/update 缺失触发一次（与上一批合并窗口独立）')
  s.applyOp({ docId: 'd2', _id: 212, op: { op: 'append', id: 'exist', text: 'ok' } })
  s.applyOp({ docId: 'd2', _id: 213, op: { op: 'update', id: 'exist', props: { a: 1 } } })
  advance(300)
  await settle()
  assert.equal(previewCalls, base + 2, '存量节点 append/update 不触发 resync')
  assert.equal(useLiveStore.getState().nodes.exist.md, 'ok')
  ok('存量节点正常折叠（零 resync），缺失节点 setmd/update 触发')

  // 其它文档的事件不触发
  s.applyOp({ docId: 'other', _id: 300, op: { op: 'append', id: 'nope', text: 'z' } })
  advance(300)
  await settle()
  assert.equal(previewCalls, base + 2, '非当前文档不触发')
  ok('只折叠当前文档（语义不回归）')
}

// ---------- D. reload 推进水位线（防重放污染不回归） ----------
console.log('D) reload 水位线推进')
{
  const before = useLiveStore.getState().watermark
  await scheduleResyncAndSettle()
  const after = useLiveStore.getState().watermark
  assert.ok(after > before, `reload 后水位线应推进：${before} → ${after}`)
  ok(`reload 重建树并推进水位线（${before} → ${after}，重放污染防护保持）`)

  async function scheduleResyncAndSettle() {
    scheduleResync()
    advance(300)
    await settle()
    await settle()
  }
}

rmSync(OUT, { recursive: true, force: true })
console.log(`\n全部通过：${passed} 组断言`)
