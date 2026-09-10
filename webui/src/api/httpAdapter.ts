import type {
  ApiAdapter, AppEvent, AppSettings, ChatMessage, ChatParams, ChatSession,
  ChatStreamHandlers, CheckedModel, DocumentItem, ExportMdDoc, Fragment,
  GenConfig, IndexConfig, KbConfigs, KnowledgeBase, PdfExportOptions,
  PdfPreviewData, Preset, PreviewData, Provider, Segment, WebSearchSettings,
} from './types'

// ============ HTTP 后端适配器（唯一实现，无 mock） ============

const BASE = '/api'

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: init?.body instanceof FormData
      ? undefined
      : { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json() as Promise<T>
}

/** 解析 POST SSE 流（/api/chat 等）：逐 data 帧回调 JSON；signal 可中止 */
async function ssePost(path: string, body: unknown, onData: (frame: any) => void,
  signal?: AbortSignal): Promise<void> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`SSE ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += value
    const frames = buf.split('\n\n')
    buf = frames.pop() ?? ''
    for (const f of frames) {
      for (const line of f.split('\n')) {
        if (line.startsWith('data:')) {
          try { onData(JSON.parse(line.slice(5))) } catch { /* 忽略坏帧 */ }
        }
      }
    }
  }
}

// ---------- 工具：后端蛇形 -> 前端驼峰 ----------

function mapDoc(d: any): DocumentItem {
  return {
    id: d.id, kbId: d.kbId, name: d.name, sourceKind: d.sourceKind,
    docType: d.docType ?? 'doc',
    size: d.size, status: d.status,
    genConfig: d.genConfig ?? {}, indexConfig: d.indexConfig ?? {},
    indexedAt: d.indexedAt, indexStale: d.indexStale, paused: !!d.paused,
    createdAt: d.createdAt,
  }
}

function mapKbConfigs(k: any): KbConfigs {
  return {
    genConfig: k?.genConfig ?? {},
    indexConfig: k?.indexConfig ?? {},
  }
}

function mapProvider(p: any): Provider {
  return { id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, models: p.models ?? [] }
}

function mapPreset(p: any): Preset {
  return {
    id: p.id, kind: p.kind, name: p.name, displayName: p.displayName ?? p.name,
    group: p.group ?? null, whereId: p.whereId ?? null,
    content: p.content, updatedAt: p.updatedAt,
  }
}

function mapSession(s: any): ChatSession {
  return {
    id: s.id, title: s.title,
    mode: s.mode ?? 'chat', model: s.model ?? null, kbIds: s.kbIds ?? [],
    webSearch: !!s.webSearch,
    createdAt: s.createdAt ?? s.created_at ?? '', updatedAt: s.updatedAt ?? s.updated_at ?? '',
  }
}

function mapSegments(list: any): Segment[] {
  return (Array.isArray(list) ? list : []).filter((s: any) =>
    s && (s.kind === 'thinking' || s.kind === 'text' || s.kind === 'tool'))
}

function mapMessage(m: any): ChatMessage {
  return {
    id: m.id, sessionId: m.sessionId, role: m.role, content: m.content,
    reasoning: m.reasoning || '', toolCalls: m.toolCalls ?? [],
    citations: m.citations ?? [], kbIds: m.kbIds ?? [], model: m.model,
    mode: m.mode, segments: mapSegments(m.segments), stopped: !!m.stopped,
    createdAt: m.createdAt,
  }
}

/** SSE 帧统一解析（/chat 与 /regenerate 共用） */
function handleChatFrame(msg: any, h: ChatStreamHandlers, fullBox: { full: string }) {
  switch (msg.type) {
    case 'session': h.onSession?.(msg.sessionId, msg.title); break
    case 'session_renamed': h.onSession?.(msg.sessionId, msg.title); break
    case 'delta':
      fullBox.full += msg.content ?? ''
      h.onDelta?.(msg.content ?? '', msg.seg)
      break
    case 'reasoning': h.onReasoning?.(msg.content ?? '', msg.seg); break
    case 'citations': h.onCitations?.(msg.citations ?? []); break
    case 'tool_call': h.onToolCall?.(msg.name, msg.arguments, msg.seg, msg.callId); break
    case 'tool_result':
      h.onToolResult?.(msg.name, msg.result, msg.seg, msg.callId, msg.fragments as Fragment[] | undefined)
      break
    case 'done': h.onDone?.(msg); break
    case 'error': h.onError?.(msg.detail ?? '未知错误'); break
  }
}

export const httpAdapter: ApiAdapter = {
  // ===== 知识库 =====
  async listKnowledgeBases() {
    const d = await http<{ kbs: any[] }>('/knowledge-bases')
    return d.kbs.map((k) => ({ id: k.id, name: k.name, docCount: k.docCount, createdAt: k.createdAt }))
  },
  async createKnowledgeBase(name) {
    return http<KnowledgeBase>('/knowledge-bases', { method: 'POST', body: JSON.stringify({ name }) })
  },
  async renameKnowledgeBase(id, name) {
    await http(`/knowledge-bases/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
  },
  async deleteKnowledgeBases(ids) {
    await http('/knowledge-bases', { method: 'DELETE', body: JSON.stringify({ ids }) })
  },
  async reorderKnowledgeBases(ids) {
    await http('/knowledge-bases/reorder', { method: 'POST', body: JSON.stringify({ ids }) })
  },
  async getKbConfig(id) {
    return mapKbConfigs(await http<any>(`/knowledge-bases/${id}/config`))
  },
  async putKbConfig(id, cfg) {
    return mapKbConfigs(await http<any>(`/knowledge-bases/${id}/config`, {
      method: 'PUT', body: JSON.stringify(cfg),
    }))
  },
  async importLink(kbId, url, presetId) {
    return mapDoc(await http<{ doc: any }>(`/knowledge-bases/${kbId}/import-link`, {
      method: 'POST', body: JSON.stringify({ url, presetId: presetId || null }),
    }))
  },

  // ===== 文档 =====
  async listDocuments(kbId) {
    const d = await http<{ docs: any[] }>(`/knowledge-bases/${kbId}/documents`)
    return d.docs.map(mapDoc)
  },
  async importDocuments(kbId, files) {
    const fd = new FormData()
    for (const f of files) fd.append('files', f, f.name)
    const d = await http<{ docs: any[] }>(`/knowledge-bases/${kbId}/documents`, {
      method: 'POST', body: fd,
    })
    return d.docs.map(mapDoc)
  },
  async renameDocument(id, name) {
    await http(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
  },
  async deleteDocuments(ids) {
    await http('/documents', { method: 'DELETE', body: JSON.stringify({ ids }) })
  },
  async reorderDocuments(kbId, ids) {
    await http('/documents/reorder', { method: 'POST', body: JSON.stringify({ kbId, ids }) })
  },
  async moveDocuments(docIds, targetKbId) {
    const d = await http<{ docs: any[] }>('/documents/move', {
      method: 'POST', body: JSON.stringify({ docIds, targetKbId }),
    })
    return d.docs.map(mapDoc)
  },
  async copyDocument(docId, targetKbId) {
    const d = await http<{ doc: any }>('/documents/copy', {
      method: 'POST', body: JSON.stringify({ docId, targetKbId }),
    })
    return mapDoc(d.doc)
  },
  async reparseDocument(id) {
    await http(`/documents/${id}/reparse`, { method: 'POST' })
  },
  async retryDocument(id) {
    await http(`/documents/${id}/retry`, { method: 'POST' })
  },
  async pauseDocument(id) {
    await http(`/documents/${id}/pause`, { method: 'POST' })
  },
  async resumeDocument(id) {
    await http(`/documents/${id}/resume`, { method: 'POST' })
  },
  async applyGenConfig(ids, config) {
    if (ids.length === 1) {
      await http(`/documents/${ids[0]}/gen-config`, { method: 'PUT', body: JSON.stringify({ config }) })
    } else {
      await http('/documents/gen-config-batch', { method: 'PUT', body: JSON.stringify({ ids, config }) })
    }
  },
  async applyIndexConfig(ids, config) {
    if (ids.length === 1) {
      await http(`/documents/${ids[0]}/index-config`, { method: 'PUT', body: JSON.stringify({ config }) })
    } else {
      await http('/documents/index-config-batch', { method: 'PUT', body: JSON.stringify({ ids, config }) })
    }
  },
  async reindexDocument(id) {
    await http(`/documents/${id}/reindex`, { method: 'POST' })
  },
  async generateDocuments(ids, force = false) {
    await http('/documents/generate', { method: 'POST', body: JSON.stringify({ ids, force }) })
  },
  async getPreview(id) {
    try {
      return await http<PreviewData>(`/documents/${id}/preview`)
    } catch (e: any) {
      if (String(e).includes('404')) return null
      throw e
    }
  },
  async getGeneratedTitle(id) {
    return http<{ title: string | null }>(`/documents/${id}/generated-title`)
  },

  // ===== 助手会话 =====
  async listSessions() {
    const d = await http<{ sessions: any[] }>('/sessions')
    return d.sessions.map(mapSession)
  },
  async createSession(title) {
    return mapSession(await http<any>('/sessions', {
      method: 'POST', body: JSON.stringify({ title: title ?? '新会话' }),
    }))
  },
  async updateSession(id, patch) {
    await http(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
  },
  async deleteSession(id) {
    await http(`/sessions/${id}`, { method: 'DELETE' })
  },
  async listMessages(sessionId) {
    const d = await http<{ messages: any[] }>(`/sessions/${sessionId}/messages`)
    return d.messages.map(mapMessage)
  },
  async chat(params: ChatParams, handlers: ChatStreamHandlers, signal?: AbortSignal) {
    const fullBox = { full: '' }
    await ssePost('/chat', params, (msg) => handleChatFrame(msg, handlers, fullBox), signal)
    return fullBox.full
  },
  async regenerate(sessionId: string, messageId: string, content: string,
    handlers: ChatStreamHandlers, signal?: AbortSignal) {
    const fullBox = { full: '' }
    await ssePost(`/sessions/${sessionId}/regenerate`, { messageId, content },
      (msg) => handleChatFrame(msg, handlers, fullBox), signal)
    return fullBox.full
  },
  async branchSession(sessionId: string, messageId: string,
    opts?: { includeCurrent?: boolean }) {
    return mapSession(await http<any>(`/sessions/${sessionId}/branch`, {
      method: 'POST',
      // debug4 #14：includeCurrent=false=不复制该消息本身；缺省 true（后端默认一致）
      body: JSON.stringify({ messageId, includeCurrent: opts?.includeCurrent ?? true }),
    }))
  },
  async generateTitle(sessionId: string) {
    return http<{ sessionId: string; title: string }>(`/sessions/${sessionId}/generate-title`, {
      method: 'POST',
    })
  },

  // ===== 设置 =====
  async getSettings() {
    const d = await http<any>('/settings')
    const settings: AppSettings = {
      providers: (d.providers ?? []).map(mapProvider),
      defaults: d.defaults ?? {},
      parser: d.parser ?? { parser: 'paddleocr', paddleocr: { apiUrl: '', apiKey: '' }, mineru: { apiUrl: '', apiKey: '' }, local: {} },
      checkedModels: d.checkedModels ?? [],
      websearch: d.websearch ?? { provider: 'examcp', apiUrl: '', apiKey: '' },
    }
    ;(settings as any).presets = d.presets ?? []
    return settings
  },
  async updateDefaults(values) {
    await http('/settings/defaults', { method: 'PUT', body: JSON.stringify(values) })
  },
  async updateParser(value) {
    await http('/settings/parser', { method: 'PUT', body: JSON.stringify(value) })
  },
  async getWebsearch() {
    const d = await http<{ websearch: WebSearchSettings }>('/settings/websearch')
    return d.websearch
  },
  async updateWebsearch(patch) {
    const d = await http<{ websearch: WebSearchSettings }>('/settings/websearch', {
      method: 'PUT', body: JSON.stringify(patch),
    })
    return d.websearch
  },
  async createProvider(name, baseUrl, apiKey) {
    return mapProvider(await http<any>('/providers', {
      method: 'POST', body: JSON.stringify({ name, baseUrl, apiKey }),
    }))
  },
  async updateProvider(id, patch) {
    await http(`/providers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
  },
  async deleteProvider(id) {
    await http(`/providers/${id}`, { method: 'DELETE' })
  },
  async fetchProviderModels(id) {
    const d = await http<{ models: string[] }>(`/providers/${id}/models`, { method: 'POST' })
    return d.models
  },
  async setCheckedModels(id, checked, attrs) {
    await http(`/providers/${id}/models`, {
      method: 'PUT',
      body: JSON.stringify(attrs ? { checked, attrs } : { checked }),
    })
  },
  async createPreset(kind, displayName, content = '', extra) {
    return mapPreset(await http<any>('/presets', {
      method: 'POST',
      body: JSON.stringify({
        kind, displayName, content,
        group: extra?.group, whereId: extra?.whereId,
      }),
    }))
  },
  async updatePreset(id, patch) {
    await http(`/presets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
  },
  async deletePreset(id) {
    await http(`/presets/${id}`, { method: 'DELETE' })
  },

  // ===== 导出 =====
  async exportMarkdown(ids) {
    const d = await http<{ docs: ExportMdDoc[] }>('/documents/export-md', {
      method: 'POST', body: JSON.stringify({ ids }),
    })
    return d.docs
  },
  async pdfPreview(docId, options) {
    return http<PdfPreviewData>('/documents/export-pdf/preview', {
      method: 'POST', body: JSON.stringify({ docId, options }),
    })
  },
  async exportPdf(ids, options) {
    await http('/documents/export-pdf', {
      method: 'POST', body: JSON.stringify({ ids, options }),
    })
  },

  // ===== 事件流（fetch 流式订阅，2026-09-07 debug1 替代 EventSource） =====
  // 传输层实现见模块级 subscribeEventsByFetch：与 chat ssePost 同构（fetch
  // 流式读取 + \n\n 分帧），外加 20s 无字节看门狗、指数退避重建、Last-Event-ID
  // 重放与建连成功 onResync（自愈契约）。
  subscribeEvents(handler, onResync?) {
    return subscribeEventsByFetch(handler, onResync)
  },
}

// ---------- 事件流传输层（模块级，2026-09-07 debug1 替代 EventSource） ----------
// 契约：
// - GET /api/events，TextDecoder 增量解码、按 \n\n 分帧、解析 id:/event:/data:
//   行（多行 data 按 SSE 规则以 \n 连接），按事件名（EVENT_CHANNELS 白名单，
//   与旧 EventSource addEventListener 名单一致）分发 handler(JSON.parse(data))；
// - keep-alive 注释帧（": keep-alive"）无 data 不分发，但计入字节活动；
// - **20s 无字节看门狗**：超时主动 abort 断开（根除"常驻 GET 管道被中间层
//   半开卡死、服务端无感知、前端零触发"的黑屏形态——chat 每次新建 POST 管道
//   故丝滑，live 唯一长连管道死了谁都不知道）→ 指数退避重建（500ms 起、上限
//   10s，建连成功复位）→ 每次建连成功触发 onResync（同旧 EventSource onopen
//   契约，接线方防抖 reload 快照自愈）；
// - 重连携带 Last-Event-ID（最后收到的帧 id），后端重放断线期间事件（后端已
//   做重放/队列去重，不会重复投递）；
// - 取消函数：置 closed、清看门狗/退避定时器并 abort 当前连接（不再重建）。

const EVENTS_WATCHDOG_MS = 20_000
const EVENTS_BACKOFF_MIN_MS = 500
const EVENTS_BACKOFF_MAX_MS = 10_000

const EVENT_CHANNELS: ReadonlySet<string> = new Set([
  'job.started', 'job.progress', 'job.done', 'job.failed',
  'doc.status', 'doc.stage', 'doc.generated', 'doc.parsed', 'doc.error',
  'doc.paused', 'doc.resumed',
  'render.op', 'index.progress', 'index.done', 'index.error',
  'export.done', 'export.error',
])

/** SSE 单帧解析（不含结尾空行的完整帧）→ {id?, event?, data?}；纯注释帧（keep-alive）→ null */
export function parseSseFrame(
  frame: string,
): { id?: string; event?: string; data?: string } | null {
  let id: string | undefined
  let event: string | undefined
  const dataLines: string[] = []
  for (const raw of frame.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line || line.startsWith(':')) continue       // 空行 / 注释（keep-alive）
    if (line.startsWith('id:')) id = line.slice(3).trim()
    else if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  if (dataLines.length === 0) return null
  return { id, event, data: dataLines.join('\n') }
}

function subscribeEventsByFetch(
  handler: (ev: AppEvent) => void,
  onResync?: () => void,
): () => void {
  let closed = false
  let controller: AbortController | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let backoff = EVENTS_BACKOFF_MIN_MS
  let lastId: string | null = null

  const clearWatchdog = () => {
    if (watchdog) { clearTimeout(watchdog); watchdog = null }
  }
  // 看门狗：EVENTS_WATCHDOG_MS 内无任何字节（含 keep-alive 注释帧）→ 主动断开
  const armWatchdog = () => {
    clearWatchdog()
    if (closed) return
    watchdog = setTimeout(() => {
      watchdog = null
      try { controller?.abort() } catch { /* 忽略 */ }
    }, EVENTS_WATCHDOG_MS)
  }

  const scheduleReconnect = () => {
    if (closed) return
    const delay = backoff
    retryTimer = setTimeout(() => { retryTimer = null; void connect() }, delay)
    backoff = Math.min(backoff * 2, EVENTS_BACKOFF_MAX_MS)
  }

  const connect = async (): Promise<void> => {
    if (closed) return
    controller = new AbortController()
    try {
      const res = await fetch(`${BASE}/events`, {
        headers: {
          Accept: 'text/event-stream',
          ...(lastId != null ? { 'Last-Event-ID': lastId } : {}),
        },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        throw new Error(`SSE ${res.status}: ${(await res.text()).slice(0, 300)}`)
      }
      // 建连成功：退避复位 + 触发 resync（同旧 EventSource onopen 契约）
      backoff = EVENTS_BACKOFF_MIN_MS
      try { onResync?.() } catch { /* 忽略 */ }
      armWatchdog()
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        armWatchdog()                        // 任何字节都是连接存活证据
        buf += decoder.decode(value, { stream: true })
        const frames = buf.split('\n\n')
        buf = frames.pop() ?? ''
        for (const f of frames) {
          const parsed = parseSseFrame(f)
          if (!parsed) continue              // keep-alive 注释帧：只算字节活动
          if (parsed.id != null && /^\d+$/.test(parsed.id)) lastId = parsed.id
          if (parsed.event && EVENT_CHANNELS.has(parsed.event) && parsed.data) {
            try { handler(JSON.parse(parsed.data) as AppEvent) } catch { /* 忽略坏帧 */ }
          }
        }
      }
      console.warn('[sse] /api/events 连接被服务端关闭，准备重连')
    } catch (e) {
      if (!closed) console.warn('[sse] /api/events 连接中断，退避重连中', e)
    }
    clearWatchdog()
    scheduleReconnect()
  }

  void connect()
  return () => {
    closed = true
    clearWatchdog()
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    try { controller?.abort() } catch { /* 忽略 */ }
  }
}
