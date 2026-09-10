// Markdown → HTML 渲染器（markdown-it + KaTeX）——全应用唯一渲染实现，
// LiveView / RightPanel / ExportModal / AssistantPage 共用；步骤9 的落盘快照与
// IndexedDB 渲染缓存都建立在它之上（缓存键含 RENDERER_VERSION）。
//
// 架构（9.5 步骤5）：
// - markdown-it 内核（html:true + linkify + breaks:false）：CommonMark 全特性，
//   修复旧自研渲染器的单层扁平列表、无任务列表等缺陷。
// - HTML 消毒：html_block / html_inline 的渲染规则统一走 passTags 白名单
//   （SAFE_TAGS 放行、script/iframe/math 等整体转义、on*=/javascript: 拒绝），
//   安全策略与旧渲染器一致；MinerU 输出的 div/center/table 原样放行。
// - 数学公式：自定义轻量 inline 规则（$…$、$$…$$、\(…\)、\[…\]）→
//   katex.renderToString（throwOnError:false）；未闭合定界符不匹配 → 普通文本，
//   流式期间公式前半截显示源码、闭合后整段替换，无闪烁。
// - 引用协议：renderMarkdown(src, { refs }) 把 [[c:N]] 转为行内 <sup class="cite">
//   （数据由步骤3 接入；未提供 refs 时标记保持原样不转换）。
// - 任务列表：core 规则把 list_item 的 [ ]/[x] 前缀换成禁用态 checkbox（GFM 风格）。
// - 图片 loading=lazy、链接新窗口打开（沿用旧渲染器行为）。
import MarkdownIt from 'markdown-it'
import type { StateCore, StateInline } from 'markdown-it'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import type { Fragment } from '../api/types'

/**
 * 渲染器版本（步骤9 渲染缓存键的组成部分）。v1 = 旧自研渲染器，v2 = markdown-it+KaTeX，
 * v3 = 步骤3 行内引用 [[c:N]] 转换带悬停浮卡（refs 提供时输出变化，预防性 bump），
 * v4 = 步骤4 web 引用浮卡带 URL 行。
 * 任何影响输出的渲染行为变更都必须 bump，使旧缓存全量失效。
 */
export const RENDERER_VERSION = 4

const SAFE_TAGS = /^(?:img|br|hr|b|strong|em|i|u|s|span|div|center|sup|sub|small|table|thead|tbody|tr|th|td|p|figure|figcaption)$/i
const UNSAFE_TAG = /<\s*(?:script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|svg|math)\b/i

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 白名单放行 HTML 标签：安全标签原样保留，其余整体转义 */
function passTags(raw: string): string {
  return raw.split(/(<[^<>]*>)/).map(p => {
    const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^<>]*>$/.exec(p)
    if (!m) return esc(p)
    if (!SAFE_TAGS.test(m[1]) || UNSAFE_TAG.test(p) || /\son\w+\s*=/i.test(p) || /javascript:/i.test(p)) {
      return esc(p)
    }
    return p
  }).join('')
}

const md = new MarkdownIt({ html: true, linkify: true, breaks: false })

// ---------- HTML 白名单消毒（html:true 打开后所有原生 HTML 都过这两条渲染规则） ----------
md.renderer.rules.html_block = (tokens, idx) => passTags(tokens[idx].content)
md.renderer.rules.html_inline = (tokens, idx) => passTags(tokens[idx].content)

// ---------- 图片 / 链接（沿用旧渲染器行为） ----------
const defaultImage = md.renderer.rules.image!
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('loading', 'lazy')
  return defaultImage(tokens, idx, options, env, self)
}
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noreferrer')
  return self.renderToken(tokens, idx, options)
}

// ---------- 数学公式（KaTeX 轻量插件：四种定界符，未闭合按普通文本） ----------
function renderTex(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode: display, strict: false })
  } catch {
    return esc(tex)
  }
}

function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const src = state.src
  const pos = state.pos
  const ch = src[pos]
  let open: string
  let close: string
  let display = false
  if (ch === '$') {
    if (src[pos + 1] === '$') { open = '$$'; close = '$$'; display = true }
    else { open = '$'; close = '$' }
  } else if (ch === '\\' && src[pos + 1] === '(') {
    open = '\\('; close = '\\)'
  } else if (ch === '\\' && src[pos + 1] === '[') {
    open = '\\['; close = '\\]'; display = true
  } else {
    return false
  }

  const end = src.indexOf(close, pos + open.length)
  if (end < 0) return false                      // 未闭合 → 不匹配，按普通文本（流式中间态）
  const tex = src.slice(pos + open.length, end)
  if (!tex.trim()) return false
  if (open === '$') {                            // 单 $ 启发式（GFM）：防货币金额误判
    if (/^\s|\s$/.test(tex)) return false        // 定界符内侧紧贴空白不构成公式
    if (/\d/.test(src[end + 1] ?? '')) return false  // 闭 $ 后紧跟数字（"$100 … $200"）
  }
  if (!silent) {
    const t = state.push('math_inline', '', 0)
    t.content = tex
    t.markup = open
    t.meta = { display }
  }
  state.pos = end + close.length
  return true
}

md.inline.ruler.before('escape', 'math_inline', mathInlineRule)
md.renderer.rules.math_inline = (tokens, idx) =>
  renderTex(tokens[idx].content, !!tokens[idx].meta?.display)

// ---------- 任务列表（- [ ] / - [x] → 禁用态 checkbox，GFM 风格） ----------
md.core.ruler.after('inline', 'task_lists', (state: StateCore) => {
  const tokens = state.tokens
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].type !== 'inline' || tokens[i - 1].type !== 'paragraph_open'
        || tokens[i - 2].type !== 'list_item_open') continue
    const m = /^\[( |x|X)\]\s+/.exec(tokens[i].content)
    const first = tokens[i].children?.[0]
    if (!m || !first || first.type !== 'text') continue
    first.content = first.content.replace(/^\[( |x|X)\]\s+/, '')
    const box = new state.Token('task_checkbox', '', 0)
    box.content = m[1].toLowerCase() === 'x' ? '1' : ''
    tokens[i].children!.unshift(box)
  }
})
md.renderer.rules.task_checkbox = (tokens, idx) =>
  `<input type="checkbox" disabled${tokens[idx].content ? ' checked' : ''}> `

// ---------- 引用协议 [[c:N]]（步骤3；refs 数据接入前标记保持原样） ----------
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
  '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']

function applyRefs(src: string, refs: Fragment[]): string {
  return src.replace(/\[\[c:(\d+)\]\]/g, (_, raw) => {
    const n = Number(raw)
    const ref = refs.find(r => r.n === n)
    if (!ref) return ''                          // 未命中编号的标记剔除（协议语义）
    const label = n >= 1 && n <= 20 ? CIRCLED[n - 1] : `[${n}]`
    // 悬停浮卡随 ① 一起内联生成（纯 CSS 悬停显隐，LiveView/助手页共用）；
    // 点击交互由外层容器事件委托读取 data-ref 完成（web 引用=新标签打开，各自接线）
    const head = `《${esc(ref.docName ?? '')}》`
      + (ref.breadcrumb || ref.sectionNum ? ` ${esc(ref.breadcrumb || ref.sectionNum)}` : '')
    const body = esc((ref.text ?? '').replace(/\s+/g, ' ').slice(0, 160))
    // 步骤4：web 引用（anchor 存 URL）浮卡显示 URL 行
    const url = ref.kind === 'web' || /^https?:\/\//.test(ref.anchor ?? '') ? ref.anchor : ''
    const urlLine = url ? `<span class="cc-url">${esc(url)}</span>` : ''
    return `<sup class="cite" data-ref="${n}" data-doc="${esc(ref.docName ?? '')}">${label}` +
      `<span class="cite-card"><span class="cc-head">${head}</span>${urlLine}` +
      `<span class="cc-text">${body}</span></span></sup>`
  })
}

/** 渲染 markdown → HTML。opts.refs 提供时把 [[c:N]] 转为行内引用上标。 */
export function renderMarkdown(src: string, opts?: { refs?: Fragment[] }): string {
  let text = (src ?? '').replace(/\r\n/g, '\n')
  if (opts?.refs?.length && text.includes('[[c:')) {
    text = applyRefs(text, opts.refs)
  }
  return md.render(text)
}
