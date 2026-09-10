/**
 * debug2（步骤2 预览渲染与交互修复）单测（node 脚本，模拟浏览器全局，esbuild 打包真实源码）。
 * 覆盖：
 * A. #5 图片居中渲染快照：markdown.ts 白名单原样放行 div[style]/center/img（预览
 *    DOM 保留位置标记的 text-align），styles.css 含 img inline-block 与两形态居中规则；
 * B. #12 firstVisible：多实例 DOM（keep-alive 隐藏标签同名节点 offsetParent=null）
 *    命中可见实例、全隐藏返回 null；用户实例 URL（?a=organized:7&q=…）解析 +
 *    findAnchorNode 前缀匹配；
 * C. #13 attachCiteFlip：贴顶（rect.top<260）加 .cite-below、非贴顶不加、
 *    切换目标时清扫旧标记、清理函数解绑；
 * D. #13 hoverPreviewPos：默认上方 / 贴顶翻下方 / 横向 clamp / 底部 clamp（fake rect）；
 * E. #10 boxState：读写、500ms 写节流（窗口内不落盘）、flush 落盘、到期自动落盘；
 * F. #10 live store 接线：load() 按 anchor 回填 boxOpen（无记录缺省收缩）、
 *    toggleBox 写入、toggleBox 从全局态物化写穿、setExpandAll 写穿所有框。
 * 运行：cd webui && node scripts/debug2-test.mjs
 */
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import assert from 'node:assert'

const OUT = '.debug2-tmp'
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ---------- 浏览器全局模拟（必须在 import bundle 之前） ----------
globalThis.window = globalThis

const lsStore = new Map()
globalThis.localStorage = {
  getItem: k => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: k => lsStore.delete(k),
}

// document：firstVisible 用 querySelectorAll（按用例注入结果）；router 等需 documentElement
let qsResult = []
let lastSelector = null
globalThis.document = {
  documentElement: { classList: { toggle() {}, add() {}, remove() {} } },
  querySelector: () => null,
  querySelectorAll: sel => { lastSelector = sel; return qsResult },
  body: {},
}

// fetch：仅 /preview（live store load 用例）
const previewPayloads = new Map()   // docId -> payload
globalThis.fetch = async (path) => {
  const url = String(path)
  const m = /\/documents\/([^/]+)\/preview/.exec(url)
  if (m && previewPayloads.has(m[1])) {
    const payload = previewPayloads.get(m[1])
    return { ok: true, status: 200, json: async () => payload }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}
globalThis.requestAnimationFrame = fn => setTimeout(fn, 6)
globalThis.cancelAnimationFrame = id => clearTimeout(id)

// ---------- esbuild 打包真实源码 ----------
const esbuild = (await import('esbuild')).default
await esbuild.build({
  entryPoints: ['scripts/debug2-entry.ts'],
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: `${OUT}/bundle.js`, jsx: 'automatic',
  external: ['react', 'react-dom'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
})
const B = await import(`../${OUT}/bundle.js`)
const { renderMarkdown, firstVisible, attachCiteFlip, hoverPreviewPos,
  getBoxState, setBox, flushBoxState, BOXSTATE_PREFIX, BOXSTATE_THROTTLE_MS,
  useLiveStore, findAnchorNode, parseHashFull } = B

let passed = 0
const ok = name => { passed++; console.log(`  ok ${name}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- A. #5 图片居中渲染快照 ----------
console.log('A) #5 图片居中：渲染快照保留 div[style]/center/img（CSS 居中的 DOM 前提）')
{
  const html1 = renderMarkdown('<div style="text-align: center;"><img src="fig.png"></div>\n')
  assert.ok(html1.includes('<div style="text-align: center;">'),
    `div 的 style 应原样放行（白名单），实际：${html1}`)
  assert.ok(html1.includes('<img src="fig.png">'), 'HTML img 标签原样放行')

  const html2 = renderMarkdown('<center><img src="fig2.png"></center>\n')
  assert.ok(html2.includes('<center>') && html2.includes('</center>'), '<center> 形态放行')
  assert.ok(html2.includes('<img src="fig2.png">'))

  const html3 = renderMarkdown('![说明](fig3.png)\n')
  assert.ok(html3.includes('<img src="fig3.png"'), 'markdown 语法图片正常渲染')
  assert.ok(html3.includes('loading="lazy"'), 'markdown 图片保留 lazy 属性')

  // styles.css：img 改 inline-block（脱离 preflight 的 block）+ 两形态居中兜底规则
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  assert.ok(/\.md img\s*{\s*display:\s*inline-block/.test(css),
    '.md img 应为 inline-block（block 不受父级 text-align 控制的根因）')
  assert.ok(css.includes('[style*="text-align:center"] img') &&
            css.includes('[style*="text-align: center"] img') &&
            css.includes('.md center img'),
    'div[style] 与 <center> 两形态的居中兜底规则都应存在')
  ok('div[style]/center/img 三形态放行 + inline-block/居中兜底 CSS 就位')
}

// ---------- B. #12 firstVisible（多实例 DOM） ----------
console.log('B) #12 firstVisible：隐藏标签同名节点被过滤，命中可见实例')
{
  const hidden1 = { offsetParent: null, tag: 'hidden-tab-A' }
  const hidden2 = { offsetParent: null, tag: 'hidden-tab-B' }
  const visible = { offsetParent: {}, tag: 'active-tab' }
  qsResult = [hidden1, hidden2, visible]

  const el = firstVisible('[data-anchor="organized:7"]')
  assert.equal(el, visible, 'querySelectorAll 命中多个同名节点时应取第一个可见实例')
  assert.equal(lastSelector, '[data-anchor="organized:7"]')

  qsResult = [hidden1, hidden2]
  assert.equal(firstVisible('[data-node-id="x"]'), null, '全部不可见 → null（消费环稍后重试）')

  qsResult = [visible]
  assert.equal(firstVisible('[data-node-id="x"]'), visible, '单实例可见直接命中')

  // 用户实例 URL：?a=organized:7&q=7 致谢（p.10）…
  const q = encodeURIComponent('7 致谢（p.10）本文提出…')
  const { route, loc } = parseHashFull(`#/kb/kb1/docX?a=${encodeURIComponent('organized:7')}&q=${q}`)
  assert.equal(route?.view, 'kb')
  assert.equal(route?.docId, 'docX')
  assert.equal(loc.a, 'organized:7', 'a 参数解析')
  assert.equal(loc.q, '7 致谢（p.10）本文提出…', 'q 文本回退参数解析（含全角括号/空格）')

  // findAnchorNode：organized:7 精确命中 num=7 的节（7.1/7.2.1 是其子孙前缀）
  const nodes = {
    root: { id: 'root', type: 'root', parent: null, children: [], props: {} },
    s1: { id: 's1', type: 'section', parent: 'root', children: [], props: { num: '1' } },
    s7: { id: 's7', type: 'section', parent: 'root', children: [], props: { num: '7' } },
    s71: { id: 's71', type: 'section', parent: 's7', children: [], props: { num: '7.1' } },
  }
  assert.equal(findAnchorNode(nodes, 'organized:7'), 's7', 'organized:7 → 第 7 节（跳转目标节点）')
  assert.equal(findAnchorNode(nodes, 'organized:7.1'), 's71')
  ok('多实例命中可见 / 全隐藏 null / 用户实例 URL 解析 + 锚点节点匹配')
}

// ---------- C. #13 attachCiteFlip ----------
console.log('C) #13 attachCiteFlip：贴顶翻转标记 / 清扫旧标记 / 解绑')
{
  const listeners = {}
  let allSups = []
  const root = {
    addEventListener(t, fn) { (listeners[t] ??= []).push(fn) },
    removeEventListener(t, fn) {
      const l = listeners[t] ?? []
      const i = l.indexOf(fn)
      if (i >= 0) l.splice(i, 1)
    },
    // 模拟真实语义：querySelectorAll('sup.cite.cite-below') 只返回带该类标记的
    querySelectorAll: () => allSups.filter(s => s.classes.has('cite-below')),
  }
  const mkSup = top => {
    const sup = {
      top, classes: new Set(),
      classList: {
        add: c => sup.classes.add(c),
        remove: c => sup.classes.delete(c),
        contains: c => sup.classes.has(c),
      },
      getBoundingClientRect: () => ({ top: sup.top }),
    }
    return sup
  }
  const nearTop = mkSup(100)     // 贴顶（<260）
  const mid = mkSup(500)         // 不贴顶
  allSups = [nearTop, mid]
  const dispose = attachCiteFlip(root)
  const handler = listeners.mouseover[0]
  assert.ok(handler, 'root 上挂了 mouseover 委托')

  handler({ target: { closest: sel => (sel === 'sup.cite' ? nearTop : null) } })
  assert.ok(nearTop.classes.has('cite-below'), '① 靠近视口顶部（rect.top<260）→ 加 .cite-below')

  handler({ target: { closest: sel => (sel === 'sup.cite' ? mid : null) } })
  assert.ok(!nearTop.classes.has('cite-below'), '切换目标时清扫上一个标记')
  assert.ok(!mid.classes.has('cite-below'), '非贴顶不加翻转标记')

  mid.top = 200
  handler({ target: { closest: sel => (sel === 'sup.cite' ? mid : null) } })
  assert.ok(mid.classes.has('cite-below'), '重新悬停时按当前 rect 重新判定')

  handler({ target: { closest: () => null } })
  assert.ok(mid.classes.has('cite-below'), '非 ① 目标不触发清扫/翻转')

  dispose()
  assert.equal(listeners.mouseover.length, 0, '清理函数解绑监听')
  ok('贴顶加标/清扫/按 rect 重判/非 ① 忽略/解绑')
}

// ---------- D. #13 hoverPreviewPos（fake rect） ----------
console.log('D) #13 hoverPreviewPos：默认上方 / 贴顶翻下方 / 横向与底部 clamp')
{
  // 上方空间充足：top = r.top - 卡高 - 6
  let p = hoverPreviewPos({ left: 100, top: 400, bottom: 420 }, 1200, 800, 380, 200)
  assert.equal(p.below, false)
  assert.equal(p.top, 194)
  assert.equal(p.left, 100)

  // 顶部空间不足（rect.top < 卡高+16）→ 下方：top = r.bottom + 6
  p = hoverPreviewPos({ left: 100, top: 100, bottom: 120 }, 1200, 800, 380, 200)
  assert.equal(p.below, true, 'rect.top=100 < 200+16 → 翻下方')
  assert.equal(p.top, 126)

  // 横向 clamp：右侧越界 → vw-width-8；左侧越界 → 8
  p = hoverPreviewPos({ left: 1100, top: 400, bottom: 420 }, 1200, 800, 380, 200)
  assert.equal(p.left, 812)
  p = hoverPreviewPos({ left: -30, top: 400, bottom: 420 }, 1200, 800, 380, 200)
  assert.equal(p.left, 8)

  // 下方也放不下：底部 clamp 到 vh-卡高-8
  p = hoverPreviewPos({ left: 100, top: 100, bottom: 790 }, 1200, 800, 380, 200)
  assert.equal(p.below, true)
  assert.equal(p.top, 592, 'bottom+6=796 超界 → clamp 到 800-200-8')
  ok('上方/翻下方/横向 clamp 两侧/底部 clamp')
}

// ---------- E. #10 boxState ----------
console.log('E) #10 boxState：读写 / 500ms 写节流 / flush / 到期自动落盘')
{
  assert.ok(BOXSTATE_PREFIX === 'doc-assistant-boxstate:' && BOXSTATE_THROTTLE_MS === 500,
    '键前缀与节流窗口常量')
  assert.deepEqual(getBoxState('docA'), {}, '无记录 → 空')
  lsStore.set(`${BOXSTATE_PREFIX}docA`, 'not-json')
  assert.deepEqual(getBoxState('docA'), {}, '损坏数据 → 空对象（隐私模式同路）')
  lsStore.delete(`${BOXSTATE_PREFIX}docA`)

  setBox('docA', 'summary:1', true)
  assert.deepEqual(getBoxState('docA'), {}, '节流窗口内未落盘（但内存待写）')
  flushBoxState()
  assert.deepEqual(getBoxState('docA'), { 'summary:1': true }, 'flush 后落盘可读')

  setBox('docA', 'plugin:p:2', false)
  setBox('docA', 'summary:1', true)     // 合并写入（不丢前值）
  await sleep(BOXSTATE_THROTTLE_MS + 60)
  assert.deepEqual(getBoxState('docA'), { 'summary:1': true, 'plugin:p:2': false },
    '节流到期自动落盘（全量合并记录）')

  // flush(docId) 只落指定文档
  setBox('docB', 'summary:1', true)
  flushBoxState('docC')                 // docC 无待写：无害
  assert.deepEqual(getBoxState('docB'), {}, '未指定文档未落盘')
  flushBoxState()
  assert.deepEqual(getBoxState('docB'), { 'summary:1': true })
  ok('键前缀/损坏容错/节流窗口/flush/自动落盘/按 docId flush')
}

// ---------- F. #10 live store 接线 ----------
console.log('F) #10 live store：load 回填 / toggleBox 写入 / 全局态写穿')
{
  const docId = 'docL'
  const nodes = {
    root: { id: 'root', type: 'root', parent: null, children: ['sec'], props: {} },
    sec: { id: 'sec', type: 'section', parent: 'root', children: ['b1', 'b2'], props: { num: '1', anchor: 'organized:1' } },
    b1: { id: 'b1', type: 'summary_box', parent: 'sec', children: [], props: { anchor: 'summary:1', num: '1' }, md: '甲' },
    b2: { id: 'b2', type: 'plugin_box', parent: 'sec', children: [], props: { anchor: 'plugin:tp:1', num: '1', plugin: 'tp' }, md: '乙' },
  }
  previewPayloads.set(docId, {
    status: 'done', genConfig: { presetId: 'p1' }, tree: { nodes }, lastId: 10,
  })
  lsStore.set(`${BOXSTATE_PREFIX}${docId}`, JSON.stringify({ 'summary:1': true }))

  await useLiveStore.getState().load({ id: docId, status: 'done', genConfig: { presetId: 'p1' } })
  let st = useLiveStore.getState()
  assert.equal(st.docId, docId)
  assert.equal(st.boxOpen.b1, true, 'load 按 anchor 回填：summary:1 记忆 → b1 展开')
  assert.equal(st.boxOpen.b2, false, '无记录的框缺省收缩')

  // toggleBox（逐框分支）：写入持久记录（anchor 键）
  st.toggleBox('b2')
  st = useLiveStore.getState()
  assert.equal(st.boxOpen.b2, true)
  flushBoxState()
  assert.equal(JSON.parse(lsStore.get(`${BOXSTATE_PREFIX}${docId}`))['plugin:tp:1'], true,
    'toggleBox 落盘用 anchor 键（非 nodeId）')
  st.toggleBox('b2')
  flushBoxState()
  assert.equal(JSON.parse(lsStore.get(`${BOXSTATE_PREFIX}${docId}`))['plugin:tp:1'], false)

  // setExpandAll(true) 写穿所有框
  st.setExpandAll(true)
  flushBoxState()
  assert.deepEqual(JSON.parse(lsStore.get(`${BOXSTATE_PREFIX}${docId}`)),
    { 'summary:1': true, 'plugin:tp:1': true }, '全部展开写穿所有框的 anchor 记录')

  // toggleBox 从全局态物化：全框物化写穿 + 被点框单独翻转
  st.toggleBox('b1')
  st = useLiveStore.getState()
  assert.equal(st.expandAll, null, '点单框后全局态解除')
  assert.equal(st.boxOpen.b1, false, '被点的框翻转')
  assert.equal(st.boxOpen.b2, true, '其余框保持全局值（物化）')
  flushBoxState()
  assert.deepEqual(JSON.parse(lsStore.get(`${BOXSTATE_PREFIX}${docId}`)),
    { 'summary:1': false, 'plugin:tp:1': true }, '物化写穿：被点框 false、其余 true')

  // setExpandAll(false) 写穿收缩
  st.setExpandAll(false)
  flushBoxState()
  assert.deepEqual(JSON.parse(lsStore.get(`${BOXSTATE_PREFIX}${docId}`)),
    { 'summary:1': false, 'plugin:tp:1': false })
  ok('load 回填/缺省收缩/toggleBox anchor 落盘/setExpandAll 写穿/物化写穿')
}

rmSync(OUT, { recursive: true, force: true })
console.log(`\n全部通过：${passed} 组断言`)
