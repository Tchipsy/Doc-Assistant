/**
 * debug1（步骤1 流式直达渲染）单测（node 脚本，模拟浏览器全局，esbuild 打包真实源码）。
 * 覆盖：
 * A. live store 直通渲染：append/setmd 后节点内容立即=全文（同步零定时器）、
 *    reveal 恒=全文长度、display 层已删除、rAF 泵零调用；
 * B. 水位线竞态用例（前端视角）：_id==水位线（快照已含内容）→ 丢弃不翻倍；
 *    _id>水位线 → 应用不丢失——配合后端 1.2 修复（get_preview 锁内
 *    snapshot→current_id），"快照后、读水位线前发布的 op"不再产生字符空洞；
 * C. SSE 分帧解析器 parseSseFrame：id/event/data、keep-alive 注释帧、
 *    多行 data（SSE 规范 \n 连接）、CRLF、无 event 名；
 * D. fetch 流式订阅集成：真实帧跨 chunk 边界解析、事件名白名单分发、
 *    建连成功 onResync 恰一次、首连无 Last-Event-ID；
 * E. 20s 无字节看门狗（fake 时钟）：边界 1ms 内不断开；超时 abort → 500ms
 *    退避重建 → onResync 恰一次；keep-alive 字节活动重置看门狗；重连携带
 *    Last-Event-ID（后端据此重放）；
 * F. 指数退避曲线：连续失败 500→1000→2000→4000→8000→10000→10000（封顶），
 *    建连成功复位回 500；
 * G. 取消函数：清看门狗/退避定时器、abort 当前连接、永不重建。
 * 运行：cd webui && node scripts/debug1-test.mjs
 */
import { mkdirSync, rmSync } from 'node:fs'
import assert from 'node:assert'

const OUT = '.debug1-tmp'
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ---------- 浏览器全局模拟（必须在 import bundle 之前） ----------
globalThis.window = globalThis

// fake timers（看门狗/退避/resync 防抖全走 setTimeout；只劫持这两个）
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
const settle = () => new Promise(r => setImmediate(r))
async function advance(ms) {
  now += ms
  const due = timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at)
  for (const t of due) {
    const i = timers.indexOf(t)
    if (i >= 0) {
      timers.splice(i, 1)
      t.fn()
      await settle()          // 定时器回调多为异步 connect：让微任务跑完
    }
  }
}

// rAF 桩：只计数（直通渲染断言用——打字机泵退役后应零调用）
let rafCalls = 0
globalThis.requestAnimationFrame = fn => { rafCalls++; return setTimeout(fn, 6) }
globalThis.cancelAnimationFrame = id => clearTimeout(id)

// ---------- fetch 桩：/preview 计数（resync reload）+ /events 可控流 ----------
let previewCalls = 0
let lastPreviewLastId = 100
const STUB_NODES = () => ({
  root: { id: 'root', type: 'root', parent: null, children: ['exist'], props: {} },
  exist: { id: 'exist', type: 'section', parent: 'root', children: [], props: {}, md: '' },
})

let eventsMode = 'open'        // open=常开流 | fail=fetch 拒绝 | httperror=500
let eventsFetches = []         // [{url, headers, at}]
let eventStreams = []          // 每次 /events 建连对应的 {ctrl}
const enc = new TextEncoder()
const activeStream = () => eventStreams[eventStreams.length - 1]

function makeEventsResponse(signal) {
  let ctrl
  const rs = new ReadableStream({
    start(c) {
      ctrl = c
      if (signal) {
        signal.addEventListener('abort', () => {
          try { c.error(new Error('The user aborted a request.')) } catch { /* 已关闭 */ }
        })
      }
    },
  })
  eventStreams.push({ ctrl })
  return Promise.resolve({ ok: true, status: 200, body: rs })
}

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
    eventsFetches.push({ url, headers: init?.headers ?? {}, at: now })
    if (eventsMode === 'fail') throw new TypeError('Failed to fetch')
    if (eventsMode === 'httperror') {
      return { ok: false, status: 500, text: async () => 'boom', body: null }
    }
    return makeEventsResponse(init?.signal)
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

globalThis.console.warn = () => {}   // 静音传输层告警（用例自己断言行为）

// ---------- esbuild 打包真实源码 ----------
const esbuild = (await import('esbuild')).default
await esbuild.build({
  entryPoints: ['scripts/debug1-entry.ts'],
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: `${OUT}/bundle.js`, jsx: 'automatic',
  external: ['react', 'react-dom'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
})
const { httpAdapter, parseSseFrame, useLiveStore } = await import(`../${OUT}/bundle.js`)

let passed = 0
const ok = name => { passed++; console.log(`  ok ${name}`) }

// ---------- A. live store 直通渲染 ----------
console.log('A) live store 直通渲染：append/setmd 立即全文上屏（打字机层退役）')
{
  useLiveStore.setState({
    docId: 'd1', status: 'generating', html: {}, reveal: {}, cursorId: null, watermark: 100,
    nodes: {
      root: { id: 'root', type: 'root', parent: null, children: ['sec'], props: {} },
      sec: { id: 'sec', type: 'section', parent: 'root', children: [], props: {}, md: '' },
    },
  })
  const s = useLiveStore.getState()
  s.applyOp({ docId: 'd1', _id: 101, op: { op: 'insert', id: 'b1', type: 'section', parent: 'root', props: {} } })
  let st = useLiveStore.getState()
  assert.ok(st.nodes.b1, 'insert 落树')
  assert.equal(st.cursorId, 'b1', 'insert 设 cursorId（流式光标保留）')
  assert.equal(st.reveal.b1, 0)

  s.applyOp({ docId: 'd1', _id: 102, op: { op: 'append', id: 'b1', text: '第一段' } })
  st = useLiveStore.getState()
  assert.equal(st.nodes.b1.md, '第一段', 'append 后节点内容立即=全文（同步、零定时器）')
  assert.equal(st.reveal.b1, 3, 'reveal 立即=全文长度（跳过打字机积压）')
  assert.equal(st.display, undefined, 'display 打字机前缀层已删除')

  s.applyOp({ docId: 'd1', _id: 103, op: { op: 'append', id: 'b1', text: '第二段' } })
  st = useLiveStore.getState()
  assert.equal(st.nodes.b1.md, '第一段第二段')
  assert.equal(st.reveal.b1, 6)

  s.applyOp({ docId: 'd1', _id: 104, op: { op: 'setmd', id: 'b1', text: '覆盖全文' } })
  st = useLiveStore.getState()
  assert.equal(st.nodes.b1.md, '覆盖全文', 'setmd 绝对覆盖立即上屏')
  assert.equal(st.reveal.b1, 4)
  ok('insert/append/setmd 直通：内容与 reveal 同步上屏、display 已删除')

  assert.equal(rafCalls, 0, 'rAF 泵已退役：整个直通流程零 rAF 调用')
  await advance(400)   // 越过 resync 防抖窗口（300ms + 余量）
  assert.equal(previewCalls, 0, '存量节点正常折叠：零 resync、零残留定时器')
  ok('零 rAF、零 resync、零残留定时器（打字机层彻底移除）')
}

// ---------- B. 水位线竞态用例（前端视角） ----------
console.log('B) 水位线竞态：快照后 current_id 前发布的 op 不丢不重')
{
  useLiveStore.setState({
    docId: 'd1', status: 'generating', html: {}, reveal: {}, cursorId: null, watermark: 200,
    nodes: {
      root: { id: 'root', type: 'root', parent: null, children: ['sec'], props: {} },
      sec: { id: 'sec', type: 'section', parent: 'root', children: [], props: {}, md: 'abc' },
    },
  })
  const s = useLiveStore.getState()
  // 1.2 修复后的不变式：快照 md='abc' 已含 _id<=200 全部事件的内容；
  // "快照与读水位线之间发布"的那条 op 必然二选一：内容已在快照（_id<=200，
  // 事件被水位线丢弃 → 不翻倍）或 _id>200（事件必达 → 不丢失）。
  s.applyOp({ docId: 'd1', _id: 200, op: { op: 'append', id: 'sec', text: 'd' } })
  assert.equal(useLiveStore.getState().nodes.sec.md, 'abc',
    '_id==水位线：内容已在快照 → 事件丢弃（不翻倍）')
  s.applyOp({ docId: 'd1', _id: 201, op: { op: 'append', id: 'sec', text: 'd' } })
  assert.equal(useLiveStore.getState().nodes.sec.md, 'abcd',
    '_id>水位线：正常应用（不丢失）')
  ok('竞态两侧各归其位：快照内不重、快照外不丢（最终 md=abcd）')
}

// ---------- C. SSE 分帧解析器 ----------
console.log('C) parseSseFrame：真实帧格式（id/event/data、注释帧、多行 data、CRLF）')
{
  const f1 = parseSseFrame('id: 42\nevent: render.op\ndata: {"channel":"render.op","_id":42}')
  assert.deepEqual(f1, { id: '42', event: 'render.op', data: '{"channel":"render.op","_id":42}' })
  assert.equal(parseSseFrame(': keep-alive'), null, 'keep-alive 注释帧 → null（不分发，只算字节活动）')
  assert.equal(parseSseFrame(''), null)
  const multi = parseSseFrame('event: t\ndata: [\ndata: 1]')
  assert.deepEqual(JSON.parse(multi.data), [1], '多行 data 按 SSE 规范以 \\n 连接后为合法 JSON')
  const crlf = parseSseFrame('id: 7\r\nevent: doc.status\r\ndata: {"x":1}\r\n')
  assert.equal(crlf.id, '7')
  assert.equal(crlf.event, 'doc.status')
  assert.deepEqual(JSON.parse(crlf.data), { x: 1 }, 'CRLF 行尾容忍')
  const noEv = parseSseFrame('data: {"a":1}')
  assert.equal(noEv.event, undefined, '无 event 行 → event undefined')
  ok('id/event/data、注释帧、多行 data、CRLF、无 event 名 —— 解析正确')
}

// ---------- D. fetch 流式订阅集成 ----------
console.log('D) fetch 流式订阅：跨 chunk 事件边界 / 白名单分发 / onResync 恰一次')
{
  eventsMode = 'open'
  eventsFetches = []
  eventStreams = []
  const got = []
  let resyncs = 0
  const un = httpAdapter.subscribeEvents(ev => got.push(ev), () => { resyncs++ })
  await settle(); await settle()
  assert.equal(eventsFetches.length, 1, '订阅即建连（GET /api/events）')
  assert.equal(eventsFetches[0].url, '/api/events')
  assert.equal(eventsFetches[0].headers['Last-Event-ID'], undefined, '首连不带 Last-Event-ID')
  assert.equal(resyncs, 1, '建连成功 → onResync 恰一次')

  const st = activeStream()
  st.ctrl.enqueue(enc.encode(
    'id: 1\nevent: render.op\ndata: {"channel":"render.op","docId":"d1","_id":1,"op":{"op":"append","id":"x","text":"A"}}\n\n'))
  await settle()
  assert.equal(got.length, 1)
  assert.equal(got[0].op.text, 'A', '完整帧解析并按事件名分发')

  st.ctrl.enqueue(enc.encode('id: 2\nev'))
  await settle()
  assert.equal(got.length, 1, '半帧不分发（跨 chunk 边界缓冲）')
  st.ctrl.enqueue(enc.encode(
    'ent: doc.status\ndata: {"channel":"doc.status","docId":"d1","status":"generating"}\n\n'))
  await settle()
  assert.equal(got.length, 2)
  assert.equal(got[1].channel, 'doc.status', '跨 chunk 事件帧拼接后正确分发')

  st.ctrl.enqueue(enc.encode(': keep-alive\n\n'))
  await settle()
  assert.equal(got.length, 2, 'keep-alive 注释帧不分发')

  st.ctrl.enqueue(enc.encode('id: 3\nevent: session.title\ndata: {"channel":"session.title"}\n\n'))
  await settle()
  assert.equal(got.length, 2, '白名单外通道不分发（与旧 EventSource 名单一致）')

  un()
  await settle()
  ok('跨 chunk / keep-alive / 白名单 / 首连 onResync 恰一次 —— 全部正确')
}

// ---------- E. 20s 无字节看门狗 ----------
console.log('E) 20s 无字节看门狗：静默→abort→退避重建→onResync；字节活动重置')
{
  eventsMode = 'open'
  eventsFetches = []
  eventStreams = []
  let resyncs = 0
  const un = httpAdapter.subscribeEvents(() => {}, () => { resyncs++ })
  await settle(); await settle()
  assert.equal(eventsFetches.length, 1)
  assert.equal(resyncs, 1, '首连 onResync')

  await advance(19_999)
  assert.equal(eventsFetches.length, 1, '静默 19.999s 不断开（边界前 1ms）')
  await advance(1)                       // 20s 到期：看门狗 abort
  assert.equal(eventsFetches.length, 1, 'abort 本身不立即新建连接')
  await advance(500); await settle(); await settle()
  assert.equal(eventsFetches.length, 2, '20s 无字节 → 主动断开 → 500ms 退避后重建')
  assert.equal(resyncs, 2, '重建成功 → onResync 恰好再触发一次（共 2）')

  // 字节活动重置看门狗：keep-alive 每 15s 一跳，75s 不断开
  for (let i = 0; i < 5; i++) {
    activeStream().ctrl.enqueue(enc.encode(': keep-alive\n\n'))
    await settle()
    await advance(15_000)
  }
  assert.equal(eventsFetches.length, 2, 'keep-alive 字节活动持续重置看门狗（75s 无断开）')

  // 重连携带 Last-Event-ID：先收一帧带 id，再静默超时
  activeStream().ctrl.enqueue(enc.encode('id: 7\nevent: doc.stage\ndata: {"channel":"doc.stage"}\n\n'))
  await settle()
  await advance(20_000)                  // 看门狗再次超时
  await advance(500); await settle(); await settle()
  assert.equal(eventsFetches.length, 3)
  assert.equal(eventsFetches[2].headers['Last-Event-ID'], '7', '重连携带最后收到的帧 id（后端据此重放）')
  assert.equal(resyncs, 3)

  un()
  await settle()
  ok('看门狗 20s 边界 / abort 重建 / onResync 恰一次 / keep-alive 续命 / Last-Event-ID 重放')
}

// ---------- F. 指数退避曲线 ----------
console.log('F) 指数退避：连续失败 500→1000→2000→4000→8000→10000→10000（封顶），成功复位')
{
  eventsMode = 'fail'
  eventsFetches = []
  eventStreams = []
  let resyncs = 0
  const un = httpAdapter.subscribeEvents(() => {}, () => { resyncs++ })
  await settle(); await settle()
  assert.equal(eventsFetches.length, 1, '尝试 1（失败）')
  assert.equal(resyncs, 0, '失败不触发 onResync')
  const expected = [500, 1000, 2000, 4000, 8000, 10_000, 10_000]
  for (const d of expected) {
    await advance(d)
    await settle(); await settle()
  }
  assert.equal(eventsFetches.length, 8, '共 8 次尝试（1 次首发 + 7 次重连）')
  const gaps = eventsFetches.slice(1).map((f, i) => f.at - eventsFetches[i].at)
  assert.deepEqual(gaps, expected, `重连间隔 = ${gaps.join(',')}`)
  ok('退避曲线 500→1000→2000→4000→8000→10000→10000（10s 封顶）')

  // 建连成功 → 退避复位：恢复后主动断开流，下一次重连间隔应回到 500
  eventsMode = 'open'
  await advance(10_000); await settle(); await settle()      // 第 9 次：成功
  const okAt = eventsFetches[eventsFetches.length - 1].at
  assert.equal(resyncs, 1, '成功建连触发 onResync')
  activeStream().ctrl.error(new Error('server closed'))      // 连接随即断开
  await settle()
  await advance(500); await settle(); await settle()
  const last = eventsFetches[eventsFetches.length - 1]
  assert.equal(last.at - okAt, 500, '成功建连后退避复位：重连间隔回到 500ms')
  un()
  await settle()
  ok('建连成功复位退避（500ms 起）')
}

// ---------- G. 取消函数 ----------
console.log('G) 取消函数：清定时器 + abort 当前连接 + 永不重建')
{
  eventsMode = 'open'
  eventsFetches = []
  eventStreams = []
  let resyncs = 0
  const un = httpAdapter.subscribeEvents(() => {}, () => { resyncs++ })
  await settle(); await settle()
  assert.equal(eventsFetches.length, 1)
  un()
  await settle()
  const n = eventsFetches.length
  await advance(60_000)
  await settle()
  assert.equal(eventsFetches.length, n, '取消后看门狗/退避定时器已清，永不重建')
  assert.equal(resyncs, 1, '取消后不再触发 onResync')
  ok('取消干净（StrictMode cleanup 安全）')
}

rmSync(OUT, { recursive: true, force: true })
console.log(`\n全部通过：${passed} 组断言`)
