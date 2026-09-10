/**
 * 内容框折叠状态记忆（debug2 #10）：按文档持久化各内容框（summary_box/plugin_box）
 * 的展开/收缩状态。键 `doc-assistant-boxstate:{docId}`，值 `Record<anchor, boolean>`
 * （true=展开）。**键用 node.props.anchor 而非 nodeId**——流式/产物树跨重建 nodeId
 * 会变，anchor（organized/summary/plugin 命名空间）跨生成稳定。
 * 500ms 写节流 + flush()；无记录的框缺省收缩（与 live store boxOpen 缺省语义一致）。
 * 接线：live store load() 按 anchor 回填、toggleBox 逐框写入、setExpandAll 写穿全部框。
 */
const PREFIX = 'doc-assistant-boxstate:'
const THROTTLE_MS = 500

/** 待写记录：docId -> 全量 {anchor: open}（合并写入，读时以 storage 现值合并） */
const pending = new Map<string, Record<string, boolean>>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export const BOXSTATE_PREFIX = PREFIX
export const BOXSTATE_THROTTLE_MS = THROTTLE_MS

function storageKey(docId: string): string {
  return PREFIX + docId
}

/** 读取该文档的折叠记忆（只读已落盘记录；节流窗口内的待写不含在内） */
export function getBoxState(docId: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(storageKey(docId))
    if (!raw) return {}
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, boolean>) : {}
  } catch {
    return {}   // 隐私模式/损坏数据：等同无记忆
  }
}

/** 写入单个框状态（合并进该文档全量记录；500ms 节流落盘，flushBoxState 可提前） */
export function setBox(docId: string, anchor: string, open: boolean): void {
  if (!docId || !anchor) return
  const rec = pending.get(docId) ?? getBoxState(docId)
  rec[anchor] = open
  pending.set(docId, rec)
  if (!timers.has(docId)) {
    timers.set(docId, setTimeout(() => {
      timers.delete(docId)
      flushBoxState(docId)
    }, THROTTLE_MS))
  }
}

/** 立即落盘（无参=所有待写文档）。切换文档前调用防节流丢尾（live store load 接线）。 */
export function flushBoxState(docId?: string): void {
  const ids = docId ? [docId] : [...pending.keys()]
  for (const id of ids) {
    const rec = pending.get(id)
    if (!rec) continue
    pending.delete(id)
    try { localStorage.setItem(storageKey(id), JSON.stringify(rec)) } catch { /* 隐私模式忽略 */ }
  }
}
