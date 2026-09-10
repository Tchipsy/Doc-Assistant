/**
 * 位置记忆（9.5 步骤7）：滚动位置的双层存储与恢复。
 *
 * - 双层：内存 Map（会话内即时读写，rAF 节流的 scroll 持续覆盖写）
 *   + localStorage `doc-assistant-scroll`（JSON `{key: pos}`，写节流 500ms）。
 *   刷新/重启后 recall 先查内存、miss 读 localStorage——"刷新保留文档/会话位置"由此满足。
 * - key 约定：`chat:{sessionId}` ｜ `live:{docId}`（实时渲染窗口）｜ `src:{docId}`（原文档预览）。
 * - 切换前显式 scrollMemoFlush()（会话/文档切换与路由 applyRoute 里调用），避免节流丢尾。
 * - 恢复：内容就绪后 restoreWhenReady（rAF 轮询 scrollHeight 稳定，≤2s 超时放弃）；
 *   恢复期间抑制 scroll 保存并逐帧校正，用户一旦手动滚动立即让位。
 */

const LS_KEY = 'doc-assistant-scroll'
const FLUSH_DELAY = 500          // localStorage 写节流
const RESTORE_STABLE_FRAMES = 3  // scrollHeight 连续稳定帧数
const RESTORE_TIMEOUT = 2000     // 恢复等待内容就绪的超时

const mem = new Map<string, number>()
let writeTimer: ReturnType<typeof setTimeout> | null = null
let dirty = false
let restoring = 0 // >0 = restoreWhenReady 校正期间：scroll 事件不写入（防止中间态污染记忆）

function lsRead(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return {}
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, number>) : {}
  } catch { return {} }
}

function lsWrite(all: Record<string, number>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)) } catch { /* 隐私模式/配额满：忽略 */ }
}

function clampPos(el: HTMLElement): number {
  const max = Math.max(0, el.scrollHeight - el.clientHeight)
  return Math.max(0, Math.min(Math.floor(el.scrollTop), max))
}

function memSet(key: string, pos: number) {
  mem.set(key, pos)
  dirty = true
  if (writeTimer == null) {
    writeTimer = setTimeout(() => { writeTimer = null; scrollMemoFlush() }, FLUSH_DELAY)
  }
}

/** 把内存中未落盘的位置立即写进 localStorage（切换视图/路由离开/卸载前调用） */
export function scrollMemoFlush() {
  if (writeTimer != null) { clearTimeout(writeTimer); writeTimer = null }
  if (!dirty) return
  const all = lsRead()
  for (const [k, v] of mem) all[k] = v
  lsWrite(all)
  dirty = false
}

/** 保存某 key 的滚动位置（scroll 事件里经 onScrollMemoSave 的 rAF 节流调用） */
export function scrollMemoSave(key: string, el: HTMLElement | null) {
  if (!el || el.clientHeight === 0 || restoring > 0) return
  memSet(key, clampPos(el))
}

/** 读取上次位置：内存优先，miss 读 localStorage */
export function scrollMemoRecall(key: string): number | null {
  if (mem.has(key)) return mem.get(key)!
  const v = lsRead()[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 直接恢复（instant，禁用 smooth）；恢复值超出当前可滚动范围时 clamp 到底 */
export function scrollMemoRestore(el: HTMLElement, pos: number) {
  const max = Math.max(0, el.scrollHeight - el.clientHeight)
  el.scrollTop = Math.max(0, Math.min(pos, max))
}

/** scroll 事件 → rAF 节流保存（React onScroll 处理器工厂；key 用 getter 取避免闭包过期） */
export function onScrollMemoSave(getKey: () => string) {
  let raf = 0
  return (ev: { currentTarget: EventTarget & Element }) => {
    if (raf) return
    const el = ev.currentTarget as HTMLElement
    raf = requestAnimationFrame(() => {
      raf = 0
      scrollMemoSave(getKey(), el)
    })
  }
}

/** 是否有恢复流程进行中（9.5 步骤6：双窗口同步滚动在恢复期间跳过，
 * 防止程序化恢复滚动与同步互相打断/污染位置记忆） */
export function scrollMemoIsRestoring(): boolean {
  return restoring > 0
}

/**
 * 内容就绪后恢复：每帧 restore 一遍（内容未就绪时 scrollHeight 会持续增长），
 * scrollHeight 连续 RESTORE_STABLE_FRAMES 帧稳定即完成；≤timeoutMs 超时放弃。
 * 用户手动滚动（scrollTop 偏离程序设置值 >4px）立即让位并停止。
 * 返回是否确实存在记忆（无记忆时调用方走各自默认行为，如会话滚到底部）。
 */
export function scrollMemoRestoreWhenReady(
  key: string,
  el: HTMLElement | null,
  opts?: { timeoutMs?: number; onDone?: (pos: number) => void },
): boolean {
  const pos = el ? scrollMemoRecall(key) : null
  if (!el || pos == null) return false
  const timeout = opts?.timeoutMs ?? RESTORE_TIMEOUT
  const t0 = Date.now()
  let lastH = -1
  let stable = 0
  let lastSet = -1
  restoring += 1
  const finish = (finalPos: number) => {
    restoring -= 1
    // 以最终恢复位置为准，覆盖轮询期间的任何中间态误存
    if (el.clientHeight > 0) memSet(key, Math.max(0, Math.min(pos, finalPos)))
    opts?.onDone?.(finalPos)
  }
  const tick = () => {
    if (lastSet >= 0 && Math.abs(el.scrollTop - lastSet) > 4) {
      finish(clampPos(el))   // 用户接管滚动：按用户位置收尾
      return
    }
    if (el.clientHeight === 0) {
      // 尚未布局（隐藏/未挂载完成）：等待或超时（超时不覆盖记忆）
      if (Date.now() - t0 > timeout) { restoring -= 1; return }
      requestAnimationFrame(tick)
      return
    }
    scrollMemoRestore(el, pos)
    lastSet = el.scrollTop
    if (el.scrollHeight === lastH) {
      if (++stable >= RESTORE_STABLE_FRAMES) { finish(lastSet); return }
    } else {
      stable = 0
      lastH = el.scrollHeight
    }
    if (Date.now() - t0 > timeout) { finish(lastSet); return }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return true
}
