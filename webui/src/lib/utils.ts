export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function formatBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function timeStr(ts: number | string): string {
  const d = new Date(typeof ts === "string" ? ts.replace(" ", "T") : ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay) return hm
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const sameYear = d.getFullYear() === now.getFullYear()
  return sameYear ? md : `${d.getFullYear()}-${md}`
}

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsText(file)
  })
}

export function readFileDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/**
 * 多实例 DOM 下的可见性过滤查找（debug2 #12）：keep-alive 多标签会把同名节点
 * 渲染多份（live store 全局单例 + 每标签一份 DOM），document.querySelector 会命中
 * 隐藏标签（display:none 容器）里的同名节点——对隐藏容器 scrollTo 无效，目录/
 * 引用跳转因此"只切文档不到位置"。返回 querySelectorAll 结果中第一个
 * offsetParent!==null（参与布局，即可见链上）的元素；全部不可见返回 null。
 */
export function firstVisible(selector: string): Element | null {
  const list = document.querySelectorAll(selector)
  for (let i = 0; i < list.length; i++) {
    if ((list[i] as HTMLElement).offsetParent !== null) return list[i]
  }
  return null
}

/**
 * 行内引用浮卡（.md sup.cite .cite-card）贴顶翻转（debug2 #13）：容器级
 * mouseover 委托——① 位于视口顶部附近（rect.top<260，浮卡恒在上方会溢出视口）
 * 时给 sup.cite 加 .cite-below，浮卡经 CSS 翻到下方。同一时刻只保留一个标记。
 * 返回清理函数。LiveView 与助手页两个挂载点共用。
 */
export function attachCiteFlip(root: HTMLElement): () => void {
  const onOver = (ev: MouseEvent) => {
    const sup = (ev.target as HTMLElement | null)?.closest?.('sup.cite') as HTMLElement | null
    if (!sup) return
    for (const el of root.querySelectorAll('sup.cite.cite-below')) el.classList.remove('cite-below')
    if (sup.getBoundingClientRect().top < 260) sup.classList.add('cite-below')
  }
  root.addEventListener('mouseover', onOver)
  return () => root.removeEventListener('mouseover', onOver)
}

/** 提取 API 错误的可读文本（httpAdapter 的 message 形如 `API 409: {"detail":"…"}`） */
export function apiErr(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const m = /"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)
  return m
    ? m[1].replace(/\\u([\dA-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    : raw
}

/**
 * 在滚动容器内部滚动到目标元素（只滚容器，不带动整页）。
 * container 缺省时自动找最近的 [data-scroll-root] 祖先。
 * 用自绘 rAF 动画而非 behavior:'smooth'——部分环境（如内嵌浏览器）
 * 会抑制原生平滑滚动导致 scrollTo 无效。
 */
export function scrollToWithin(
  container: HTMLElement | null,
  el: HTMLElement | null,
  block: 'start' | 'center' = 'start',
) {
  if (!el) return
  const root = (container ?? (el.closest('[data-scroll-root]') as HTMLElement | null)) as HTMLElement | null
  if (!root || root === el) {
    el.scrollIntoView({ block })
    return
  }
  const cr = root.getBoundingClientRect()
  const er = el.getBoundingClientRect()
  const cur = root.scrollTop
  const to = block === 'center'
    ? cur + (er.top + er.height / 2) - (cr.top + cr.height / 2)
    : cur + (er.top - cr.top) - 12
  animateScroll(root, to)
}

/** 轻量 ease-out 滚动动画（可被同元素的新动画打断）。
 * 9.5 步骤6 起导出供 PDF→实时窗口同步滚动复用（自绘 rAF 动画，onDone 回调
 * 供同步模块在动画结束后解除防回环锁）。 */
export function animateScroll(el: HTMLElement, to: number, dur = 450, onDone?: () => void) {
  const anyEl = el as any
  if (anyEl.__scrollAnim) cancelAnimationFrame(anyEl.__scrollAnim)
  const from = el.scrollTop
  const delta = to - from
  if (Math.abs(delta) < 2) {
    onDone?.()
    return
  }
  const t0 = performance.now()
  const ease = (t: number) => 1 - Math.pow(1 - t, 3)
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / dur)
    el.scrollTop = from + delta * ease(p)
    if (p < 1) anyEl.__scrollAnim = requestAnimationFrame(step)
    else { anyEl.__scrollAnim = null; onDone?.() }
  }
  anyEl.__scrollAnim = requestAnimationFrame(step)
}
