// IndexedDB 渲染缓存（9.5 步骤9，要求2-2）：每节点 md→HTML 的持久 memo。
// 手写 ~90 行 IndexedDB 封装（未引 idb-keyval，避免新增依赖；实现二选一已定案）。
//
// 一致性原理：渲染只发生在 lib/markdown.ts 一处（renderMarkdown），这里只是
// "渲染结果的持久化 memo"，不是第二套实现。缓存键
//   `{docId}|{presetId}|{nodeId}|{md摘要}|{RENDERER_VERSION}`
// 同键 ⇒ 相同 md 输入（+相同 refs 数据）+ 相同渲染器版本 ⇒ 逐字节相同的输出，
// 命中即等于现场渲染，不可能"过期但被用"：md 变了→键变→miss；
// 渲染器升级→RENDERER_VERSION bump→全量 miss。流式生成期间不走缓存（节点在变）。
// 宽度自适应不受影响：缓存的是 HTML 结构 + CSS 类名，非像素（CSS reflow）。
import type { Fragment, LiveNode } from '../api/types'
import { RENDERER_VERSION, renderMarkdown } from './markdown'

const DB_NAME = 'render-cache'
const STORE = 'html'
const GC_INTERVAL = 10 * 60 * 1000   // 每文档 GC 节流（惰性清理，低优先）

let dbp: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbp
}

/** md+refs 摘要：sha-256 前 8 字节 hex；无 crypto.subtle（非安全上下文）退化 FNV-1a */
async function digest(s: string): Promise<string> {
  try {
    if (crypto?.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
      return Array.from(new Uint8Array(buf).slice(0, 8))
        .map(b => b.toString(16).padStart(2, '0')).join('')
    }
  } catch { /* fallthrough */ }
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** 节点缓存键。无 md 的节点返回 null（不参与缓存）。
 * 摘要覆盖 md 与 refs（refs 参与 renderMarkdown 输出，必须进键）。 */
export async function nodeKey(docId: string, presetId: string, node: LiveNode): Promise<string | null> {
  const md = node.md ?? ''
  if (!md) return null
  const refs = node.props?.refs as Fragment[] | undefined
  const d = await digest(md + '\u0000' + (refs?.length ? JSON.stringify(refs) : ''))
  return `${docId}|${presetId}|${node.id}|${d}|${RENDERER_VERSION}`
}

export async function cacheGet(key: string): Promise<string | null> {
  try {
    const db = await open()
    return await new Promise<string | null>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as string | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch { return null }        // IndexedDB 不可用/损坏：等价于永远 miss
}

export async function cachePut(key: string, html: string): Promise<void> {
  try {
    const db = await open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(html, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch { /* 写失败不影响渲染 */ }
}

/** 惰性 GC：删除该 docId 前缀下不在 keep 集合内的旧条目（快照加载后调用，节流） */
const gcLast = new Map<string, number>()

async function gcDoc(docId: string, keep: Set<string>): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).openCursor(
      IDBKeyRange.bound(`${docId}|`, `${docId}|\uffff`))
    req.onsuccess = () => {
      const cur = req.result
      if (!cur) return
      if (!keep.has(cur.key as string)) cur.delete()
      cur.continue()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function gcSoon(docId: string, keep: Set<string>): void {
  const now = Date.now()
  if (now - (gcLast.get(docId) ?? 0) < GC_INTERVAL) return
  gcLast.set(docId, now)
  void gcDoc(docId, keep).catch(() => {})
}

/**
 * 完成态快照的渲染水合（live store load/reload 专用，流式期间不调用）：
 * 每节点先查缓存——命中直接注入（零解析）；未命中 renderMarkdown 渲染（唯一
 * 渲染实现）并写回。返回 {nodeId: html}；IndexedDB 不可用时返回空对象（回退
 * 组件内同步渲染，行为与步骤9 之前完全一致）。
 */
export async function hydrateTree(docId: string, presetId: string,
                                  nodes: Record<string, LiveNode>): Promise<Record<string, string>> {
  const html: Record<string, string> = {}
  if (!nodes.root || !presetId) return html
  const keys = new Map<string, string>()          // nodeId -> key（GC keep 集合）
  const misses: { key: string; node: LiveNode }[] = []
  await Promise.all(Object.values(nodes).map(async node => {
    const key = await nodeKey(docId, presetId, node)
    if (!key) return
    keys.set(node.id, key)
    const hit = await cacheGet(key)
    if (hit != null) html[node.id] = hit
    else misses.push({ key, node })
  }))
  for (const { key, node } of misses) {
    const h = renderMarkdown(node.md ?? '', {
      refs: node.props?.refs as Fragment[] | undefined,
    })
    html[node.id] = h
    void cachePut(key, h)                          // 写回（fire-and-forget）
  }
  gcSoon(docId, new Set(keys.values()))
  return html
}
