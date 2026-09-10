import { memo, useEffect, useRef } from 'react'
import { useLiveStore } from '../store/live'
import { useKbStore } from '../store/kb'
import type { Fragment, LiveNode } from '../api/types'
import { Markdown } from './Markdown'
import { Icon } from '../lib/icons'
import { attachCiteFlip, cx, firstVisible, scrollToWithin } from '../lib/utils'

/**
 * 实时渲染视图：把服务端组件树渲染为文档。
 * - 每个节点是独立 memo 组件（按节点订阅）：流式 append 只重渲当前节点；
 * - 目录（toc）渲染在文档最前，点击跳转到对应节；
 * - summary_box / plugin_box 渲染为彩色标注框，插件框带流式光标；
 * - 高亮：jumpToAnchor 设置的锚点命中节点时滚动+高亮。
 */

const PLUGIN_COLORS = [
  { bg: 'var(--tip-bg, #eef8ee)', border: '#86c78a', title: '#2c7a33' },
  { bg: '#f0eef8', border: '#a99fd6', title: '#5b4fa8' },
  { bg: '#fdf3e7', border: '#dcb67a', title: '#9a6b1f' },
  { bg: '#eaf3fb', border: '#7db4d8', title: '#1d5e8f' },
]
const SUMMARY_STYLE = { bg: '#f0eef8', border: '#a99fd6', title: '#5b4fa8' }

function colorFor(node: LiveNode) {
  if (node.type === 'summary_box') return SUMMARY_STYLE
  const name = node.props.plugin ?? ''
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PLUGIN_COLORS[h % PLUGIN_COLORS.length]
}

/** 节点订阅 hook：只订阅单个节点（流式输出只重渲当前节点） */
function useNode(id: string): LiveNode | undefined {
  return useLiveStore(s => s.nodes[id])
}

/** 行内 ① 点击（事件委托，LiveView/助手页共用协议）：读取 data-ref -> refs 查片段
 * -> jumpToAnchor（内部 = URL 导航，路由模块消费定位参数）；web 引用（步骤4，
 * anchor 存 URL）新标签打开网页。悬停浮卡由 CSS 完成。 */
export function handleCiteClick(
  ev: React.MouseEvent,
  nodes: Record<string, LiveNode>,
): void {
  const sup = (ev.target as HTMLElement).closest?.('sup.cite') as HTMLElement | null
  if (!sup) return
  const n = Number(sup.getAttribute('data-ref'))
  if (!n) return
  const openWeb = (url: string) => {
    window.open(url, '_blank', 'noreferrer')
    return true
  }
  const isWeb = (r: Fragment) => r.kind === 'web' || /^https?:\/\//.test(r.anchor ?? '')
  const tryRef = (refs?: Fragment[]) => {
    const r = refs?.find(x => x.n === n)
    if (!r) return false
    if (isWeb(r)) return openWeb(r.anchor)
    useKbStore.getState().jumpToAnchor(r.docId, r.anchor, r.text)
    return true
  }
  // 优先取标记所在节点（内容框）的 refs（n 为块级编号）；失败再全局兜底
  const holder = sup.closest('[data-node-id]') as HTMLElement | null
  const nodeId = holder?.getAttribute('data-node-id') ?? null
  if (nodeId && tryRef(nodes[nodeId]?.props?.refs as Fragment[] | undefined)) return
  for (const node of Object.values(nodes)) {
    if (tryRef(node.props?.refs as Fragment[] | undefined)) return
  }
}

const NodeChildren = memo(function NodeChildren({ node, want }: {
  node: LiveNode
  /** 'summary' 只渲染 summary_box；'rest' 渲染其余（插件框/子节）；缺省全部 */
  want?: 'summary' | 'rest'
}) {
  return (
    <>
      {node.children?.map(cid => <LiveNodeView key={cid} id={cid} want={want} />)}
    </>
  )
})

/** 目录条目 */
const TocEntry = memo(function TocEntry({ id }: { id: string }) {
  const node = useNode(id)
  if (!node) return null
  const indent = Math.max(0, (node.props.num?.split('.').length ?? 1) - 1)
  return (
    <div
      className="toc-entry"
      style={{ paddingLeft: 8 + indent * 16 }}
      onClick={() => {
        // debug2 #12：firstVisible——多标签下同名节点渲染多份，querySelector 会
        // 命中隐藏标签的实例（display:none 容器 scrollTo 无效）
        const el = firstVisible(`[data-node-id="${node.props.target}"]`)
        scrollToWithin(null, el as HTMLElement | null, 'start')
      }}
    >
      {node.props.num && <span className="toc-num">{node.props.num}</span>}
      <span className="toc-title">{node.props.title}</span>
    </div>
  )
})

/** 目录 */
const TocView = memo(function TocView({ id }: { id: string }) {
  const node = useNode(id)
  if (!node) return null
  return (
    <div className="card mb-5 p-4 liveview-toc">
      <div className="flex items-center gap-1.5 mb-2 t2 font-semibold text-[13px]">
        <Icon name="list" size={14} />
        目录
      </div>
      <div className="space-y-0.5">
        {node.children?.map(cid => <TocEntry key={cid} id={cid} />)}
      </div>
    </div>
  )
})

/** 文档标题（debug2 #4 前端半边）：type='title' 节点渲染为文档大标题，置于目录卡
 * 之前（后端建节点在 9.5_debug 步骤3——无节点时不渲染，向后兼容） */
const TitleView = memo(function TitleView({ id }: { id: string }) {
  const node = useNode(id)
  if (!node) return null
  return <h1 className="doc-title">{node.props.title}</h1>
})

/** 正文节（标题 + summary 框紧跟标题 + 正文 md + 其余子框/子节）——与导出结构一致 */
const SectionView = memo(function SectionView({ id, streaming }: { id: string; streaming: boolean }) {
  const node = useNode(id)
  const cachedHtml = useLiveStore(s => s.html[id]) // 步骤9 渲染缓存（命中零解析）
  const cursorId = useLiveStore(s => s.cursorId)   // debug6：光标只跟随真正流式位置
  if (!node) return null
  const level = node.props.level ?? 2
  const num = node.props.num ?? ''
  const md = node.md ?? ''   // 直通渲染（2026-09-07 debug1）：display 打字机前缀层已退役
  // debug6：原条件（生成中&&叶子节&&有正文）会让 pass2 所有将出现内容框的位置都亮
  // 预置光标——改为只跟随 cursorId（最近 insert/append 的目标节点），与 BoxView 一致
  const isStreamingHere = streaming && cursorId === id
  return (
    <section className="liveview-section" data-node-id={id} data-anchor={node.props.anchor}>
      {level >= 2 ? (
        <div className="md-heading-row">
          {num && <span className="md-heading-num">{num}</span>}
          <span className={`md-h md-h${level}`}>{node.props.title}</span>
        </div>
      ) : null}
      <NodeChildren node={node} want="summary" />
      {md.trim() && (
        <div className="md">
          <Markdown text={md} html={cachedHtml} />
          {isStreamingHere && <span className="cursor-blink" />}
        </div>
      )}
      <NodeChildren node={node} want="rest" />
    </section>
  )
})

/** 摘要框 / 插件框（Obsidian callout 风格：默认收缩，点标题展开/收起；
 * 正在流式输出的框强制展开。展开态 = 顶栏"全部展开/收缩"全局态（expandAll），
 * 手动点框时从全局态物化回逐框覆盖（store.toggleBox），避免全局态锁死单个框） */
const BoxView = memo(function BoxView({ id, streaming }: { id: string; streaming: boolean }) {
  const node = useNode(id)
  const cachedHtml = useLiveStore(s => s.html[id])   // 步骤9 渲染缓存（命中零解析）
  const cursorId = useLiveStore(s => s.cursorId)
  const expandAll = useLiveStore(s => s.expandAll)
  const openOverride = useLiveStore(s => s.boxOpen[id])
  if (!node) return null
  const c = colorFor(node)
  const isPlugin = node.type === 'plugin_box'
  const label = isPlugin
    ? `${node.props.plugin ?? ''}${node.props.num ? ` · ${node.props.num}` : ''}`
    : `本节摘要${node.props.num ? ` · ${node.props.num}` : ''}`
  const isStreamingHere = streaming && cursorId === id
  const open = expandAll !== null ? expandAll : (openOverride ?? false)
  const expanded = open || isStreamingHere
  return (
    <div
      className={cx('liveview-box', !expanded && 'folded')}
      data-node-id={id}
      data-anchor={node.props.anchor}
      style={{ background: c.bg, borderColor: c.border }}
    >
      <button
        className="liveview-box-title"
        style={{ color: c.title }}
        onClick={() => useLiveStore.getState().toggleBox(id)}
        title={expanded ? '点击收起' : '点击展开'}
      >
        <Icon name={isPlugin ? 'zap' : 'sticky'} size={13} />
        {label}
        <span className="flex-1" />
        <Icon name="chevronDown" size={12} className={cx('transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className="liveview-box-body md">
          <Markdown text={node.md ?? ''} refs={node.props.refs as Fragment[] | undefined}
                    html={cachedHtml} />
          {isStreamingHere && <span className="cursor-blink" />}
        </div>
      )}
    </div>
  )
})

function LiveNodeView({ id, want }: { id: string; want?: 'summary' | 'rest' }) {
  const type = useLiveStore(s => s.nodes[id]?.type)
  const streaming = useLiveStore(s => s.status === 'generating')
  if (!type) return null
  if (want === 'summary' && type !== 'summary_box') return null
  if (want === 'rest' && type === 'summary_box') return null
  if (type === 'toc') return <TocView id={id} />
  if (type === 'toc_entry') return null
  if (type === 'title') return <TitleView id={id} />
  if (type === 'section') return <SectionView id={id} streaming={streaming} />
  if (type === 'summary_box' || type === 'plugin_box') return <BoxView id={id} streaming={streaming} />
  return null
}

/** 实时渲染主视图 */
export function LiveView({ onRef }: { onRef?: (el: HTMLDivElement | null) => void }) {
  const nodes = useLiveStore(s => s.nodes)
  const lastJump = useLiveStore(s => s.lastJump)
  const root = nodes['root']
  const containerRef = useRef<HTMLDivElement | null>(null)

  // debug2 #13：行内 ① 浮卡贴顶翻转（容器级 mouseover 委托；助手页同款共用）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    return attachCiteFlip(el)
  }, [])

  // 引用跳转：滚动 + 高亮（debug2 #12：firstVisible 只认本激活标签的可见实例——
  // 全局 store 的 lastJump 会唤醒所有标签的 LiveView，隐藏标签不得抢滚动）
  useEffect(() => {
    if (!lastJump || !root) return
    const target = findAnchorNode(nodes, lastJump.anchor)
    if (!target) return
    const el = firstVisible(`[data-anchor="${CSS.escape(lastJump.anchor)}"]`)
      ?? firstVisible(`[data-node-id="${target}"]`)
    if (el) {
      if (revealBoxIfFolded(el)) {
        setTimeout(() => scrollToWithin(null, el as HTMLElement, 'center'), 80)
      } else {
        scrollToWithin(null, el as HTMLElement, 'center')
      }
      el.classList.add('jump-highlight')
      setTimeout(() => el.classList.remove('jump-highlight'), 2400)
    }
  }, [lastJump, nodes, root])

  return (
    <div
      ref={el => { containerRef.current = el; onRef?.(el) }}
      className="liveview"
      onClick={e => handleCiteClick(e, nodes)}
    >
      {root?.children?.map(cid => <LiveNodeView key={cid} id={cid} />)}
      {(!root || root.children.length === 0) && (
        <div className="t3 text-center py-16 text-[13px]">暂无内容</div>
      )}
    </div>
  )
}

/** 锚点 -> 节点 id（organized:<num> / summary:<num> / plugin:<p>:<num> / image:...） */
export function findAnchorNode(nodes: Record<string, LiveNode>, anchor: string): string | null {  // 前缀匹配：organized:2.1 命中 num=2.1 的节（或其最近祖先）
  const [kind, ...rest] = anchor.split(':')
  if (kind === 'organized') {
    const num = rest.join(':')
    return findByNum(nodes, 'section', num)
  }
  if (kind === 'summary') {
    return findByNum(nodes, 'summary_box', rest.join(':'))
  }
  if (kind === 'plugin') {
    const [plugin, num] = rest
    for (const n of Object.values(nodes)) {
      if (n.type === 'plugin_box' && n.props.plugin === plugin &&
          (n.props.num === num || coveredBy(num, n.props.num))) return n.id
    }
    return null
  }
  if (kind === 'image') {
    // image:<num>:<src> -> 所在节
    const num = rest[0]
    return findByNum(nodes, 'section', num)
  }
  return null
}

function findByNum(nodes: Record<string, LiveNode>, type: string, num: string): string | null {
  if (!num) {
    const first = Object.values(nodes).find(n => n.type === type)
    return first?.id ?? null
  }
  let best: LiveNode | null = null
  for (const n of Object.values(nodes)) {
    if (n.type !== type || !n.props.num) continue
    if (n.props.num === num) return n.id
    if (num.startsWith(n.props.num + '.') || n.props.num.startsWith(num + '.')) {
      if (!best || n.props.num.length > best.props.num.length) best = n
    }
  }
  return best?.id ?? null
}

function coveredBy(target: string, got: string): boolean {
  return target === got || target.startsWith(got + '.') || got.startsWith(target + '.')
}

/** 引用跳转落点在折叠的组件框内时，自动展开（点击其标题）再滚动 */
export function revealBoxIfFolded(el: Element | null): boolean {
  const box = (el as HTMLElement | null)?.closest?.('.liveview-box') as HTMLElement | null
  if (box && !box.querySelector('.liveview-box-body')) {
    box.querySelector('.liveview-box-title')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }
  return false
}
