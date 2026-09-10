import { create } from 'zustand'
import { api } from '../api/client'
import { navigate, goDefaultView, applyRoute } from '../lib/router'
import { toast } from '../components/Toast'
import { apiErr } from '../lib/utils'
import { useSettingsStore } from './settings'
import type { AppEvent, DocType, DocumentItem, GenConfig, IndexConfig, KbConfigs, KnowledgeBase, PreviewData } from '../api/types'

let initUnsub: (() => void) | null = null

export function docsOf(docsByKb: Record<string, DocumentItem[]>, kbId: string | null): DocumentItem[] {
  return (kbId && docsByKb[kbId]) || []
}

/** 当前默认生成配置（新文档用）。docType 给定时 presetId 取该类型组的第一个预设
 *  （步骤11：网页类文档的默认不该落到文档类预设上）。放本文件避免与
 *  components/GenConfig 的循环依赖（GenConfig 再导出本函数）。 */
export function defaultGenConfig(docType?: DocType): GenConfig {
  const s = useSettingsStore.getState()
  const orgs = s.presets.filter(p => p.kind === 'organization')
  const same = docType ? orgs.filter(p => (p.group ?? 'doc') === docType) : []
  const pick = (same.length ? same : orgs)[0]?.id ?? ''
  return {
    presetId: pick,
    organizeModel: null,
    contentModel: null,
    components: { toc: true, summary: true, images: true },
    plugins: [],
    tools: { crossDocSearch: false, webSearch: false },
  }
}

export function defaultIndexConfig(): IndexConfig {
  return { enabled: false, components: { summary: false, images: false }, plugins: [] }
}

/** 文档生效配置（步骤11 配置继承，前端展示口径，与后端 resolve_effective_config 一致）：
 *  显式（genConfig/indexConfig 非空对象）→ 文档；否则知识库默认（按 docType 取）；
 *  仍无 → 内置默认。inherited=true 时回显处标注"继承自知识库"。 */
export function resolveDocConfigs(doc: DocumentItem): {
  gen: GenConfig
  idx: IndexConfig
  genInherited: boolean
  idxInherited: boolean
} {
  const genInherited = !doc.genConfig || Object.keys(doc.genConfig).length === 0
  const idxInherited = !doc.indexConfig || Object.keys(doc.indexConfig).length === 0
  const dt: DocType = doc.docType ?? 'doc'
  const kbCfg = useKbStore.getState().kbConfigs[doc.kbId]
  const kbGen = kbCfg?.genConfig?.[dt]
  const kbIdx = kbCfg?.indexConfig?.[dt]
  return {
    gen: { ...defaultGenConfig(dt), ...(genInherited ? kbGen : doc.genConfig) },
    idx: { ...defaultIndexConfig(), ...(idxInherited ? kbIdx : doc.indexConfig) },
    genInherited,
    idxInherited,
  }
}

interface ClickMods { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }

interface KbState {
  kbs: KnowledgeBase[]
  /** 知识库级默认配置（步骤11）：{genConfig: {doc, web}, indexConfig: {doc, web}}；
   *  文档配置回显/继承标注的解析数据源（resolveDocConfigs） */
  kbConfigs: Record<string, KbConfigs>
  docsByKb: Record<string, DocumentItem[]>
  activeKbId: string | null
  activeDocId: string | null
  kbSel: string[]
  docSel: string[]
  kbAnchor: string | null
  docAnchor: string | null
  /** 入库进度（SSE index.progress 驱动） */
  indexProgress: Record<string, number>
  /** 最近一次入库错误（index.error 驱动，进度/完成事件清除） */
  indexError: Record<string, string>
  /** 顶栏行内改名的文档 id（文档栏右键「重命名」联动触发；null=非编辑态） */
  renamingDocId: string | null
  init: () => Promise<void>
  clickKb: (id: string, mods: ClickMods) => void
  clickDoc: (id: string, mods: ClickMods) => void
  setActiveKb: (id: string) => void
  setActiveDoc: (id: string | null) => void
  createKb: (name: string) => Promise<void>
  renameKb: (id: string, name: string) => Promise<void>
  deleteKbs: (ids: string[]) => Promise<void>
  /** 知识库默认配置（步骤11）：PUT 保存（不触发生成）并回写 store */
  saveKbConfig: (id: string, cfg: KbConfigs) => Promise<void>
  /** 链接导入（步骤11）：抓取网页 → 网页类文档（status 直达 ready） */
  importLink: (url: string, presetId?: string | null) => Promise<DocumentItem>
  /** 手动排序（步骤10）：一次拖动=整列表新顺序下发 */
  reorderKbs: (ids: string[]) => Promise<void>
  reorderDocs: (kbId: string, ids: string[]) => Promise<void>
  /** 移动文档到目标知识库（打开中的文档视图路由自动纠正） */
  moveDocs: (docIds: string[], targetKbId: string) => Promise<void>
  /** 复制文档到目标知识库（新文档名=原名+"（副本）"，向量复用零重嵌入） */
  copyDoc: (docId: string, targetKbId: string) => Promise<void>
  /** 返回新建文档（步骤11：导入弹窗给选中预设写入显式 gen_config 用） */
  importFiles: (files: File[]) => Promise<DocumentItem[]>
  renameDoc: (id: string, name: string) => Promise<void>
  deleteDocs: (ids: string[]) => Promise<void>
  applyGenConfig: (ids: string[], cfg: Partial<GenConfig>) => Promise<void>
  applyIndexConfig: (ids: string[], cfg: Partial<IndexConfig>) => Promise<void>
  startGeneration: (ids: string[], force?: boolean) => Promise<void>
  reindexDoc: (id: string) => Promise<void>
  reparseDoc: (id: string) => Promise<void>
  retryDoc: (id: string) => Promise<void>
  pauseDoc: (id: string) => Promise<void>
  resumeDoc: (id: string) => Promise<void>
  refreshDoc: (docId?: string) => Promise<void>   // 步骤10：无参调用=全量重拉（移动/复制后）
  /** 引用跳转：解析 kbId + 自动补选组件/插件 + URL 导航（定位参数由路由模块消费） */
  jumpToAnchor: (docId: string, anchor: string, text?: string) => Promise<void>
  startRename: (docId: string) => void
  stopRename: () => void
  setIndexProgress: (docId: string, pct: number | null) => void
  setIndexError: (docId: string, msg: string | null) => void
  clearSel: () => void
}

function replaceDoc(list: DocumentItem[], doc: DocumentItem): DocumentItem[] {
  const idx = list.findIndex(d => d.id === doc.id)
  if (idx === -1) return list
  const next = [...list]
  next[idx] = doc
  return next
}

export const useKbStore = create<KbState>((set, get) => ({
  kbs: [],
  kbConfigs: {},
  docsByKb: {},
  activeKbId: null,
  activeDocId: null,
  kbSel: [],
  docSel: [],
  kbAnchor: null,
  docAnchor: null,
  indexProgress: {},
  indexError: {},
  renamingDocId: null,

  init: async () => {
    const kbs = await api.listKnowledgeBases()
    const entries = await Promise.all(
      kbs.map(async kb => [kb.id, await api.listDocuments(kb.id)] as const),
    )
    // 知识库默认配置（步骤11）：一次性拉全（失败不阻塞 init，打开配置窗时会重拉）
    const kbConfigs: Record<string, KbConfigs> = {}
    await Promise.all(kbs.map(async kb => {
      try { kbConfigs[kb.id] = await api.getKbConfig(kb.id) } catch { /* 保持缺省 {} */ }
    }))
    // 全局事件流：文档状态 / 入库进度
    api.subscribeEvents((ev: AppEvent) => {
      if (ev.channel === 'doc.status') {
        const docId: string = ev.docId
        const status: string = ev.status
        set(s => {
          const docsByKb: Record<string, DocumentItem[]> = {}
          Object.entries(s.docsByKb).forEach(([kb, list]) => {
            docsByKb[kb] = list.map(d => (d.id === docId ? { ...d, status: status as any } : d))
          })
          return { docsByKb }
        })
      } else if (ev.channel === 'doc.paused' || ev.channel === 'doc.resumed') {
        const docId: string = ev.docId
        const paused = ev.channel === 'doc.paused'
        set(s => {
          const docsByKb: Record<string, DocumentItem[]> = {}
          Object.entries(s.docsByKb).forEach(([kb, list]) => {
            docsByKb[kb] = list.map(d => (d.id === docId ? { ...d, paused } : d))
          })
          return { docsByKb }
        })
      } else if (ev.channel === 'index.progress') {
        get().setIndexProgress(ev.docId, ev.progress ?? 0)
        get().setIndexError(ev.docId, null)
      } else if (ev.channel === 'index.done') {
        get().setIndexProgress(ev.docId, null)
        get().setIndexError(ev.docId, null)
        if (ev.docId) get().refreshDoc(ev.docId)
      } else if (ev.channel === 'index.error') {
        get().setIndexProgress(ev.docId, null)
        get().setIndexError(ev.docId, ev.detail ?? '入库失败')
        if (ev.docId) get().refreshDoc(ev.docId)
      } else if (ev.channel === 'doc.parsed' || ev.channel === 'doc.generated') {
        get().refreshDoc(ev.docId)
      }
    })
    set({
      kbs,
      kbConfigs,
      docsByKb: Object.fromEntries(entries),
      activeKbId: kbs[0]?.id ?? null,
      activeDocId: null,
      kbSel: [],
      docSel: [],
    })
  },

  clickKb: (id, mods) => {
    const s = get()
    const shiftIds: string[] | null = (() => {
      if (!mods.shiftKey || !s.kbAnchor) return null
      const ids = s.kbs.map(k => k.id)
      const a = ids.indexOf(s.kbAnchor), b = ids.indexOf(id)
      return a !== -1 && b !== -1 ? ids.slice(Math.min(a, b), Math.max(a, b) + 1) : null
    })()
    if (shiftIds) {
      set({ kbSel: shiftIds, activeKbId: id, activeDocId: null, docSel: [] })
    } else if (mods.ctrlKey || mods.metaKey) {
      const sel = s.kbSel.includes(id) ? s.kbSel.filter(x => x !== id) : [...s.kbSel, id]
      set({ kbSel: sel, kbAnchor: id, activeKbId: id, activeDocId: null, docSel: [] })
    } else {
      set({ kbSel: [id], kbAnchor: id, activeKbId: id, activeDocId: null, docSel: [] })
    }
    // 导航性变化 → pushState（步骤7：视图激活写 URL）
    navigate({ view: 'kb', kbId: id })
  },

  clickDoc: (id, mods) => {
    const s = get()
    const shiftIds: string[] | null = (() => {
      if (!mods.shiftKey || !s.docAnchor) return null
      const list = docsOf(s.docsByKb, s.activeKbId)
      const ids = list.map(d => d.id)
      const a = ids.indexOf(s.docAnchor), b = ids.indexOf(id)
      return a !== -1 && b !== -1 ? ids.slice(Math.min(a, b), Math.max(a, b) + 1) : null
    })()
    if (shiftIds) {
      set({ docSel: shiftIds, activeDocId: id })
    } else if (mods.ctrlKey || mods.metaKey) {
      const sel = s.docSel.includes(id) ? s.docSel.filter(x => x !== id) : [...s.docSel, id]
      set({ docSel: sel, docAnchor: id, activeDocId: id })
    } else {
      set({ docSel: [id], docAnchor: id, activeDocId: id })
    }
    if (s.activeKbId) navigate({ view: 'kb', kbId: s.activeKbId, docId: id })
  },

  setActiveKb: (id) => {
    set({ activeKbId: id, activeDocId: null, docSel: [], kbSel: [id], kbAnchor: id })
    navigate({ view: 'kb', kbId: id })
  },
  setActiveDoc: (id) => {
    set({ activeDocId: id, docSel: id ? [id] : [], docAnchor: id })
    const kbId = get().activeKbId
    if (kbId) navigate(id ? { view: 'kb', kbId, docId: id } : { view: 'kb', kbId })
  },

  createKb: async (name) => {
    const kb = await api.createKnowledgeBase(name)
    set(s => ({
      kbs: [kb, ...s.kbs],
      docsByKb: { ...s.docsByKb, [kb.id]: [] },
      activeKbId: kb.id, activeDocId: null, kbSel: [kb.id], docSel: [],
    }))
    navigate({ view: 'kb', kbId: kb.id })
  },

  renameKb: async (id, name) => {
    await api.renameKnowledgeBase(id, name)
    set(s => ({ kbs: s.kbs.map(k => (k.id === id ? { ...k, name } : k)) }))
  },

  deleteKbs: async (ids) => {
    const wasActive = ids.includes(get().activeKbId ?? '')
    await api.deleteKnowledgeBases(ids)
    set(s => {
      const kbs = s.kbs.filter(k => !ids.includes(k.id))
      const docsByKb = { ...s.docsByKb }
      ids.forEach(id => delete docsByKb[id])
      const activeKbId = ids.includes(s.activeKbId ?? '') ? (kbs[0]?.id ?? null) : s.activeKbId
      const activeDocId = activeKbId === s.activeKbId ? s.activeDocId : null
      return {
        kbs, docsByKb, activeKbId, activeDocId,
        kbSel: [], docSel: [], kbAnchor: null, docAnchor: null,
      }
    })
    if (wasActive) goDefaultView('kb', { replace: true })   // 活跃库被删：URL 落到默认视图
  },

  saveKbConfig: async (id, cfg) => {
    const saved = await api.putKbConfig(id, cfg)
    set(s => ({ kbConfigs: { ...s.kbConfigs, [id]: saved } }))
  },

  importLink: async (url, presetId) => {
    const kbId = get().activeKbId
    if (!kbId) throw new Error('未选择知识库')
    const doc = await api.importLink(kbId, url, presetId)
    set(s => ({
      docsByKb: { ...s.docsByKb, [kbId]: [doc, ...(s.docsByKb[kbId] ?? [])] },
      activeDocId: doc.id,
      docSel: [doc.id],
      docAnchor: doc.id,
    }))
    navigate({ view: 'kb', kbId, docId: doc.id })
    return doc
  },

  reorderKbs: async (ids) => {
    // 乐观更新本地顺序（store 顺序 = 后端 sort_order 序），失败回退服务端顺序
    set(s => {
      const byId = new Map(s.kbs.map(k => [k.id, k] as const))
      const next = ids.map(id => byId.get(id)).filter((k): k is KnowledgeBase => !!k)
      return next.length === s.kbs.length ? { kbs: next } : {}
    })
    try {
      await api.reorderKnowledgeBases(ids)
    } catch (e) {
      toast(`排序保存失败：${apiErr(e)}`, 'error')
      try { set({ kbs: await api.listKnowledgeBases() }) } catch { /* 保持乐观顺序 */ }
    }
  },

  reorderDocs: async (kbId, ids) => {
    set(s => {
      const list = s.docsByKb[kbId]
      if (!list) return {}
      const byId = new Map(list.map(d => [d.id, d] as const))
      const next = ids.map(id => byId.get(id)).filter((d): d is DocumentItem => !!d)
      return next.length === list.length ? { docsByKb: { ...s.docsByKb, [kbId]: next } } : {}
    })
    try {
      await api.reorderDocuments(kbId, ids)
    } catch (e) {
      toast(`排序保存失败：${apiErr(e)}`, 'error')
      try {
        const docs = await api.listDocuments(kbId)
        set(s => ({ docsByKb: { ...s.docsByKb, [kbId]: docs } }))
      } catch { /* 保持乐观顺序 */ }
    }
  },

  moveDocs: async (docIds, targetKbId) => {
    await api.moveDocuments(docIds, targetKbId)
    set(s => {
      const docsByKb: Record<string, DocumentItem[]> = {}
      Object.entries(s.docsByKb).forEach(([kb, list]) => {
        docsByKb[kb] = (list ?? []).filter(d => !docIds.includes(d.id))
      })
      return { docsByKb, docSel: [], docAnchor: null }
    })
    await get().refreshDoc()   // 重拉列表（含目标库的 sort_order 排序视图）
    applyRoute()               // 打开中的被移动文档视图：validateRoute 静默重定向（步骤7）
  },

  copyDoc: async (docId, targetKbId) => {
    await api.copyDocument(docId, targetKbId)
    await get().refreshDoc()
  },

  importFiles: async (files) => {
    const kbId = get().activeKbId
    if (!kbId || !files.length) return []
    const created = await api.importDocuments(kbId, files)
    set(s => ({
      docsByKb: { ...s.docsByKb, [kbId]: [...created, ...(s.docsByKb[kbId] ?? [])] },
      activeDocId: created[0]?.id ?? s.activeDocId,
      docSel: created.map(d => d.id),
      docAnchor: created[0]?.id ?? null,
    }))
    if (created[0]) navigate({ view: 'kb', kbId, docId: created[0].id })
    return created
  },

  renameDoc: async (id, name) => {
    await api.renameDocument(id, name)
    set(s => {
      const docsByKb: Record<string, DocumentItem[]> = {}
      Object.entries(s.docsByKb).forEach(([kb, list]) => {
        docsByKb[kb] = list.map(d => (d.id === id ? { ...d, name } : d))
      })
      return { docsByKb }
    })
  },

  deleteDocs: async (ids) => {
    const wasActive = ids.includes(get().activeDocId ?? '')
    await api.deleteDocuments(ids)
    set(s => {
      const docsByKb: Record<string, DocumentItem[]> = {}
      Object.entries(s.docsByKb).forEach(([kb, list]) => {
        docsByKb[kb] = list.filter(d => !ids.includes(d.id))
      })
      const activeDocId = ids.includes(s.activeDocId ?? '') ? null : s.activeDocId
      return { docsByKb, activeDocId, docSel: [], docAnchor: null }
    })
    if (wasActive) {
      const kbId = get().activeKbId
      if (kbId) navigate({ view: 'kb', kbId }, undefined, { replace: true })
      else goDefaultView('kb', { replace: true })
    }
  },

  applyGenConfig: async (ids, cfg: Partial<GenConfig>) => {
    await api.applyGenConfig(ids, cfg)
    for (const id of ids) await get().refreshDoc(id)
  },

  applyIndexConfig: async (ids, cfg: Partial<IndexConfig>) => {
    await api.applyIndexConfig(ids, cfg)
    for (const id of ids) await get().refreshDoc(id)
  },

  startGeneration: async (ids, force = false) => {
    // debug3 3.1：排队状态统一由后端持久状态机承载（start_generation 置
    // status='queued' 并广播 doc.status），前端不再维护 genQueued 内存标记
    await api.generateDocuments(ids, force)
  },

  reindexDoc: async (id) => { await api.reindexDocument(id) },
  reparseDoc: async (id) => { await api.reparseDocument(id) },
  retryDoc: async (id) => { await api.retryDocument(id) },
  pauseDoc: async (id) => { await api.pauseDocument(id) },
  resumeDoc: async (id) => { await api.resumeDocument(id) },

  refreshDoc: async (docId) => {
    try {
      const kb = await api.listKnowledgeBases()
      const docsByKb: Record<string, DocumentItem[]> = {}
      await Promise.all(kb.map(async (k: KnowledgeBase) => {
        docsByKb[k.id] = await api.listDocuments(k.id)
      }))
      set(s => ({ kbs: kb, docsByKb: { ...s.docsByKb, ...docsByKb } }))
    } catch { /* 刷新失败忽略，SSE 会再触发 */ }
  },

  jumpToAnchor: async (docId, anchor, text) => {
    // 找到文档所在知识库并切换
    const s = get()
    let kbId = docIdToKb(s.docsByKb, docId)
    if (!kbId) {
      await get().refreshDoc(docId)
      kbId = docIdToKb(get().docsByKb, docId)
    }
    if (!kbId) {
      toast('引用的文档不存在或已删除')
      return
    }
    // 规格：若引用组件/插件未在生成配置勾选，自动补选（产物已生成，指纹一致=不重新生成，仅重建渲染）
    const doc = (get().docsByKb[kbId] ?? []).find(d => d.id === docId)
    if (doc) {
      // 步骤11：以生效配置为基底补选——继承中的文档用库默认（按 docType 取），
      // 避免落错整理预设分组；补选后写回=显式化（与"保存配置"同语义）
      const cfg: any = { ...resolveDocConfigs(doc).gen }
      cfg.components = { toc: true, summary: true, images: true, ...(cfg.components ?? {}) }
      cfg.plugins = [...(cfg.plugins ?? [])]
      let needApply = false
      if (anchor.startsWith('summary:') && !cfg.components.summary) {
        cfg.components = { ...cfg.components, summary: true }
        needApply = true
      }
      const m = /^plugin:([^:]+):/.exec(anchor)
      if (m && !cfg.plugins.includes(m[1])) {
        cfg.plugins = [...cfg.plugins, m[1]]   // 排在已启用插件列表末尾
        needApply = true
      }
      if (needApply) {
        try { await api.applyGenConfig([docId], cfg as any) } catch { /* 补选失败不阻塞跳转 */ }
      }
    }
    // 9.5 步骤7：引用点击统一走 URL——定位参数（a=锚点、q=文本回退）由路由模块消费
    navigate({ view: 'kb', kbId, docId }, { a: anchor, q: text ? text.slice(0, 60) : undefined })
  },

  startRename: (docId) => set({ renamingDocId: docId }),
  stopRename: () => set({ renamingDocId: null }),

  setIndexProgress: (docId, pct) => set(s => {
    const indexProgress = { ...s.indexProgress }
    if (pct === null) delete indexProgress[docId]
    else indexProgress[docId] = pct
    return { indexProgress }
  }),

  setIndexError: (docId, msg) => set(s => {
    const indexError = { ...s.indexError }
    if (msg === null) delete indexError[docId]
    else indexError[docId] = msg
    return { indexError }
  }),

  clearSel: () => set({ kbSel: [], docSel: [] }),
}))

function docIdToKb(docsByKb: Record<string, DocumentItem[]>, docId: string): string | null {
  for (const [kbId, docs] of Object.entries(docsByKb)) {
    if (docs.some(d => d.id === docId)) return kbId
  }
  return null
}

export type { PreviewData }
