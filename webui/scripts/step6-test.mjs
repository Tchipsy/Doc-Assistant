/**
 * 9.5 步骤6 单元测试（node 脚本，esbuild 打包真实源码）：
 * - hooks/useSyncScroll.ts 的几何纯函数：liveCenterToPdf（实时视口中心→PDF 位置）、
 *   pdfPosToLiveTop（PDF 位置→实时内容坐标）、pdfOffsetToPos（PDF 绝对偏移→{page,frac}）。
 *   验证：frac 映射与反向映射互逆（异页锚点）、同页多锚点单调性（计划 §5 退化语义）、
 *   边界（首锚点上方不动/末锚点 frac=0/零跨距护栏/空锚点）、PDF→实时方向精确页与
 *   相邻页内插。
 * - 9.6 修复补充：resolveLiveRoot 多实例滚动根解析（各自绑定，不回退全局查询）；
 *   动态锚点（稀疏页码分布）下地标映射仍互逆单调。
 * 运行：cd webui && node scripts/step6-test.mjs
 */
import { mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert'

const OUT = '.step6-tmp'
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// useSyncScroll.ts 顶部 import react（hook 本体不参与测试）——external 掉即可
execFileSync('node', [
  'node_modules/esbuild/bin/esbuild', 'src/hooks/useSyncScroll.ts',
  '--bundle', '--format=esm', '--platform=browser',
  `--outfile=${OUT}/sync.mjs`,
  '--external:react',
], { stdio: 'inherit' })

const { liveCenterToPdf, pdfPosToLiveTop, pdfOffsetToPos, resolveLiveRoot } =
  await import(pathToFileURL(`${OUT}/sync.mjs`).href)

let n = 0
const ok = (name) => { n++; console.log(`  ✓ ${name}`) }

// ---------- 测试数据 ----------
// PDF 5 页，每页高 100、无间距：tops[n]=第 n+1 页顶，末位=总高哨兵 500
const tops = [0, 100, 200, 300, 400, 500]

console.log('liveCenterToPdf：基本插值与边界')
{
  const anchors = [{ page: 1, top: 0 }, { page: 3, top: 100 }, { page: 5, top: 300 }]
  // c=150：锚点 i=1（page3, top100），frac=(150-100)/200=0.25；
  // 下一锚点是 page5（跳页）→ 段铺 P3→P5：x=200+0.25×200=250 → {3, 0.5}
  const pos = liveCenterToPdf(anchors, tops, 150)
  assert.deepStrictEqual(pos, { page: 3, frac: 0.5 })
  ok('视口中心线性插值（下一锚点跳页时铺到其页顶）')

  // 相邻页（p+1）时即计划 §4 原公式：P[p]+frac×(P[p+1]−P[p])
  const adj = [{ page: 1, top: 0 }, { page: 2, top: 120 }]
  assert.deepStrictEqual(liveCenterToPdf(adj, tops, 60), { page: 1, frac: 0.5 })
  ok('相邻页锚点段 = 计划 §4 原公式')

  assert.strictEqual(liveCenterToPdf(anchors, tops, -50), null)
  ok('中心在首锚点上方 → null（不动）')

  assert.deepStrictEqual(liveCenterToPdf(anchors, tops, 400), { page: 5, frac: 0 })
  assert.deepStrictEqual(liveCenterToPdf(anchors, tops, 9999), { page: 5, frac: 0 })
  ok('末锚点及以后 → frac=0')

  assert.deepStrictEqual(liveCenterToPdf(anchors, tops, 0), { page: 1, frac: 0 })
  ok('中心恰在锚点上 → 该锚点 frac=0')

  assert.strictEqual(liveCenterToPdf([], tops, 100), null)
  assert.strictEqual(liveCenterToPdf(anchors, [], 100), null)
  ok('空锚点/空页表 → null（降级）')
}

console.log('pdfOffsetToPos：哨兵与钳制')
{
  assert.deepStrictEqual(pdfOffsetToPos(tops, 250), { page: 3, frac: 0.5 })
  assert.deepStrictEqual(pdfOffsetToPos(tops, 500), { page: 5, frac: 1 })   // 末页底
  assert.deepStrictEqual(pdfOffsetToPos(tops, 9999), { page: 5, frac: 1 })  // 超界钳制
  assert.deepStrictEqual(pdfOffsetToPos(tops, -5), { page: 1, frac: 0 })
  ok('绝对偏移 → {page, frac}（末页借总高哨兵有定义）')
}

console.log('互逆性：实时→PDF→实时（异页锚点，计划 §4 双向算法）')
{
  // 锚点页码互异：t[i] ↔ P[p[i]] 一一对应，复合映射应为恒等
  const anchors = [
    { page: 1, top: 0 }, { page: 2, top: 120 }, { page: 3, top: 260 },
    { page: 5, top: 480 },
  ]
  const last = anchors[anchors.length - 1].top
  for (let c = 0; c <= last; c += 3.7) {
    const pos = liveCenterToPdf(anchors, tops, c)
    if (!pos) continue
    const back = pdfPosToLiveTop(anchors, tops, pos.page, pos.frac)
    assert.ok(Math.abs(back - c) < 1e-9, `c=${c} → ${JSON.stringify(pos)} → ${back}`)
  }
  ok('全区间采样：frac 映射与反向映射互逆（误差 <1e-9）')
}

console.log('互逆性：跨页距不同的 PDF 页高（非均匀 tops）')
{
  const tops2 = [0, 80, 260, 300, 520, 700]   // 页高 80/180/40/220/180
  const anchors = [{ page: 1, top: 10 }, { page: 3, top: 200 }, { page: 4, top: 420 }]
  const last = anchors[anchors.length - 1].top
  for (let c = 10; c <= last; c += 2.9) {
    const pos = liveCenterToPdf(anchors, tops2, c)
    if (!pos) continue
    const back = pdfPosToLiveTop(anchors, tops2, pos.page, pos.frac)
    assert.ok(Math.abs(back - c) < 1e-9, `c=${c} → ${JSON.stringify(pos)} → ${back}`)
  }
  ok('非均匀页高下仍互逆')
}

console.log('同页多锚点：单调 + 互逆（计划 §5 退化语义的强化实现）')
{
  // page3 上两个锚点（同页内容被拆进两节）：地标 Q 把页内跨度按 DOM 距离均分
  const anchors = [{ page: 1, top: 0 }, { page: 3, top: 100 }, { page: 3, top: 200 }, { page: 4, top: 320 }]
  let prev = -Infinity
  for (let c = 0; c <= 320; c += 1.3) {
    const pos = liveCenterToPdf(anchors, tops, c)
    if (!pos) continue
    const offset = tops[pos.page - 1] + pos.frac * (tops[pos.page] - tops[pos.page - 1])
    assert.ok(offset >= prev - 1e-9, `c=${c} 单调性破坏：${offset} < ${prev}`)
    prev = offset
  }
  ok('c ↦ PDF 偏移全程单调不减')

  // 同页段不再从页顶重来 → 往返也精确互逆
  for (let c = 0; c <= 320; c += 2.1) {
    const pos = liveCenterToPdf(anchors, tops, c)
    if (!pos) continue
    const back = pdfPosToLiveTop(anchors, tops, pos.page, pos.frac)
    assert.ok(Math.abs(back - c) < 1e-9, `c=${c} → ${JSON.stringify(pos)} → ${back}`)
  }
  ok('同页多锚点往返精确互逆')

  // 页内均分：page3 的跨度（P3→P4=100px）被同页两个锚点段均分，
  // c=150（第一段中点）→ x=225 → page3 frac=0.25
  const pos = liveCenterToPdf(anchors, tops, 150)
  assert.deepStrictEqual(pos, { page: 3, frac: 0.25 })
  ok('同页锚点段 → 页内跨度均分插值')
}

console.log('pdfPosToLiveTop：精确页 / 相邻页内插 / 越界')
{
  const anchors = [{ page: 1, top: 0 }, { page: 3, top: 200 }, { page: 5, top: 480 }]
  // {page, frac:0} 精确落在该页首个锚点（计划 §4「找锚点 p[i]==page」语义）
  assert.strictEqual(pdfPosToLiveTop(anchors, tops, 3, 0), 200)
  // {page:3, frac:1} = page3 底（x=300）——下一锚点在 page5（跳页），
  // 地标段 [P3=200, P5=400] 内 0.5 → t = 200 + 0.5×(480−200) = 340
  assert.strictEqual(pdfPosToLiveTop(anchors, tops, 3, 1), 340)
  // 无锚点的页（page4）：PDF 偏移在地标对应关系上反插值
  // x = 300+0.5×100 = 350 → 段 [P3=200, P5=400] 内 0.75 → t = 200+0.75×(480−200) = 410
  assert.strictEqual(pdfPosToLiveTop(anchors, tops, 4, 0.5), 410)
  // page1 frac=0.9 → x=90 → 首段（P1=0→P3=200）内 0.45 → t = 0.45×200 = 90
  assert.strictEqual(pdfPosToLiveTop(anchors, tops, 1, 0.9), 90)
  assert.strictEqual(pdfPosToLiveTop(anchors, tops, 1, 0), 0)     // 首锚点
  assert.strictEqual(pdfPosToLiveTop(anchors, tops, 9, 0.9), 480) // 超出末地标 → 末锚点
  assert.strictEqual(pdfPosToLiveTop([], tops, 3, 0.5), null)     // 空锚点 → null
  ok('精确页首锚点/地标反插值/越界钳制/空锚点')
}

console.log('护栏：零跨距与异常输入')
{
  const anchors = [{ page: 1, top: 0 }, { page: 2, top: 0 }, { page: 3, top: 300 }]
  // 重复 top：最后匹配锚点（page2）生效，frac=0，无 NaN
  const pos = liveCenterToPdf(anchors, tops, 0)
  assert.deepStrictEqual(pos, { page: 2, frac: 0 })
  ok('重复 top（零高锚点相邻）不产生 NaN')

  const topsDup = [0, 100, 100, 300, 400, 500]   // 高度为 0 的页
  // offset=100 与 page2 底/page3 顶重合：取最后一个 tops[i]<=offset 的页（统一末匹配语义）
  assert.deepStrictEqual(pdfOffsetToPos(topsDup, 100), { page: 3, frac: 0 })
  ok('零高页无除零（末匹配语义）')

  // 页码乱序（模型异常输出）：地标钳制保证不产生倒退映射
  const anchorsBad = [{ page: 4, top: 0 }, { page: 2, top: 100 }, { page: 5, top: 200 }]
  let prev2 = -Infinity
  for (let c = 0; c <= 200; c += 4) {
    const p = liveCenterToPdf(anchorsBad, tops, c)
    if (!p) continue
    const offset = tops[p.page - 1] + p.frac * (tops[p.page] - tops[p.page - 1])
    assert.ok(offset >= prev2 - 1e-9, `c=${c} 单调性破坏`)
    prev2 = offset
  }
  ok('页码乱序时映射仍单调（防御性钳制）')
}

console.log('9.6 修复回归：多实例滚动根解析（resolveLiveRoot）')
{
  // 构造两个"滚动根"实例（keep-alive 多标签场景）：各自绑定自身，绝不串根
  const rootA = { isConnected: true }
  const rootB = { isConnected: true }
  assert.strictEqual(resolveLiveRoot(rootA), rootA)
  assert.strictEqual(resolveLiveRoot(rootB), rootB)
  ok('两个实例根各自绑定（不回退全局 querySelector，多标签错根不再发生）')

  // 断连（标签卸载/配置中心切换）→ null（同步静默禁用）；缺省亦 null
  const detached = { isConnected: false }
  assert.strictEqual(resolveLiveRoot(detached), null)
  assert.strictEqual(resolveLiveRoot(null), null)
  assert.strictEqual(resolveLiveRoot(undefined), null)
  ok('断连/缺省滚动根 → null（同步静默禁用，无全局兜底查询）')
}

console.log('9.6 修复回归：动态锚点（稀疏页码）下地标映射仍互逆单调')
{
  // 旧文档动态锚点的典型形态：页码稀疏（2→7 跳页）、同页多锚点、区间起点不连续。
  // 等价于"模型丢标记后存活 5/16"的退化场景，映射必须仍单调且可逆
  const anchors = [
    { page: 1, top: 0 }, { page: 2, top: 340 }, { page: 7, top: 900 },
    { page: 7, top: 1210 }, { page: 8, top: 1500 },
  ]
  const topsSparse = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]   // 9 页
  // 前向单调：c 递增 → PDF 绝对偏移不减
  let prev = -Infinity
  for (let c = 0; c <= 1500; c += 1.7) {
    const pos = liveCenterToPdf(anchors, topsSparse, c)
    if (!pos) continue
    const offset = topsSparse[pos.page - 1] + pos.frac * (topsSparse[pos.page] - topsSparse[pos.page - 1])
    assert.ok(offset >= prev - 1e-9, `c=${c} 单调性破坏：${offset} < ${prev}`)
    prev = offset
  }
  ok('稀疏页码 + 同页多锚点：前向映射全程单调不减')
  // 往返互逆：live → pdf → live 与原 c 一致
  for (let c = 0; c <= 1500; c += 2.3) {
    const pos = liveCenterToPdf(anchors, topsSparse, c)
    if (!pos) continue
    const back = pdfPosToLiveTop(anchors, topsSparse, pos.page, pos.frac)
    assert.ok(Math.abs(back - c) < 1e-9, `c=${c} → ${JSON.stringify(pos)} → ${back}`)
  }
  ok('稀疏页码下往返仍精确互逆（误差 <1e-9）')
}

rmSync(OUT, { recursive: true, force: true })
console.log(`\n全部通过：${n} 项断言组`)
