// ============ 领域模型（与后端契约对齐） ============

export type PageId = 'main' | 'assistant' | 'settings' | 'stats'

// ---------- 实时渲染组件树 ----------
export interface LiveNode {
  id: string
  /** title=文档标题节点（debug2 #4 前端先行；后端建节点在 9.5_debug 步骤3） */
  type: 'root' | 'toc' | 'toc_entry' | 'section' | 'summary_box' | 'plugin_box' | 'title'
  parent: string | null
  children: string[]
  props: Record<string, any>   // num/level/title/anchor/plugin；plugin_box 可带 refs（步骤3 块级引用）
  md?: string                  // 节点内 markdown 文本
}

export interface LiveTreeSnapshot {
  docId: string
  presetId: string
  base: 'live' | 'artifact'
  nodes: Record<string, LiveNode>
}

export type RenderOp =
  | { op: 'insert'; id: string; type: LiveNode['type']; parent: string; props: Record<string, any> }
  | { op: 'append'; id: string; text: string }
  | { op: 'setmd'; id: string; text: string }
  | { op: 'update'; id: string; props: Record<string, any> }
  | { op: 'remove'; id: string }
  | { op: 'replace'; nodes: Record<string, LiveNode> }

// ---------- 知识库 / 文档 ----------
export interface KnowledgeBase {
  id: string
  name: string
  docCount: number
  createdAt: string
}

/** debug3 3.1：queued=生成已提交、在任务队列等待（持久状态，doc.status 广播）。
 *  debug4 #3：fetching=链接导入后台抓取中（占位名文档，抓完自动改名+ready，失败 failed） */
export type DocStatus = 'pending' | 'parsing' | 'queued' | 'fetching' | 'ready' | 'generating' | 'done' | 'failed'

/** 文档类型（步骤11）：doc=文档类 / web=网页类（链接导入）。与 sourceKind（文件格式）
 *  和 presets.group（预设分组）是三个维度：web 文档 sourceKind='md' 但 docType='web' */
export type DocType = 'doc' | 'web'

export interface GenComponents {
  toc: boolean
  summary: boolean
  images: boolean
}

/** 生成工具开关（步骤3/4）：跨文档查询=pass2 工具循环；联网搜索=步骤4 启用 */
export interface GenTools {
  crossDocSearch: boolean
  webSearch: boolean
}

export interface GenConfig {
  presetId: string                 // 文档整理预设 id
  organizeModel: string | null      // "providerId/modelId"
  contentModel: string | null
  components: GenComponents
  plugins: string[]                // 插件预设 id，有序
  tools?: GenTools                 // 旧配置缺省时按 { false, false } 兜底
}

export interface IndexComponents {
  summary: boolean
  images: boolean
}

export interface IndexConfig {
  enabled: boolean                  // 是否入库（取消后向量保留，检索排除）
  components: IndexComponents
  plugins: string[]                // 插件预设 id，无需排序
}

export interface DocumentItem {
  id: string
  kbId: string
  name: string
  sourceKind: 'pdf' | 'md'
  /** 文档类型（步骤11）：决定整理预设分组（group）与配置继承取哪份库默认 */
  docType: DocType
  size: number
  status: DocStatus
  genConfig: GenConfig
  indexConfig: IndexConfig
  indexedAt: string | null
  indexStale?: boolean
  paused?: boolean               // 生成/入库流水线被用户暂停
  createdAt: string
}

/** 知识库级默认配置（步骤11）：文档类/网页类各一份完整配置；缺失的类型键=未设置 */
export interface KbConfigs {
  genConfig: Partial<Record<DocType, GenConfig>>
  indexConfig: Partial<Record<DocType, IndexConfig>>
}

export interface PreviewData {
  status: DocStatus
  tree: LiveTreeSnapshot | null
  genConfig: GenConfig
}

// ---------- 助手 / 聊天 ----------
export type ChatMode = 'chat' | 'query' | 'automatic'

export interface Citation {
  idx: number
  docId: string
  /** 所在知识库 id（步骤3：引用可拼出完整跳转 URL） */
  kbId?: string
  docName: string
  artifact: string
  sectionNum: string
  breadcrumb: string
  anchor: string
  text: string
  score?: number
  /** 步骤4：web 片段（anchor 存 URL，点击新标签打开网页而非知识库跳转） */
  kind?: 'kb' | 'web'
  url?: string
}

/** 结构化检索片段（工具结果/引用元数据；n 即引用协议 [[c:N]] 编号） */
export interface Fragment {
  n: number
  chunkId: string
  docId: string
  kbId?: string
  docName: string
  anchor: string
  breadcrumb: string
  sectionNum: string
  text: string
  /** 步骤4：web 片段（anchor 存 URL，点击新标签打开网页而非知识库跳转） */
  kind?: 'kb' | 'web'
  url?: string
}

/** 消息分段：按发生顺序交错的 思考/工具/正文 段（旧消息由后端读时迁移） */
export type Segment =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; callId: string; name: string; args: any; result?: string; fragments?: Fragment[] }
  | { kind: 'text'; text: string }

export interface ToolCallLog {
  callId?: string
  name: string
  arguments: any
  result?: string
  fragments?: Fragment[]
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  toolCalls?: ToolCallLog[]
  citations?: Citation[]
  kbIds?: string[]
  kbNames?: string[]
  model?: string
  mode?: ChatMode
  segments?: Segment[]
  /** 停止/断连保存的部分消息（含停止点） */
  stopped?: boolean
  streaming?: boolean
  createdAt?: string
}

export interface ChatSession {
  id: string
  title: string
  /** 每会话独立的模式/模型/知识库/联网开关（发送时持久化） */
  mode?: ChatMode
  model?: string | null
  kbIds?: string[]
  webSearch?: boolean
  createdAt: string
  updatedAt: string
}

// ---------- 设置 ----------
/** 模型类型（步骤12）：''=未分类。拉取列表时按服务商 supported_endpoint_types 自动分类，
 *  解析不到时按 id 关键词启发式；均可在「模型服务」中手动修改 */
export type ModelType = '' | 'chat' | 'embedding' | 'rerank'

export interface ModelItem {
  modelId: string
  checked: boolean
  modelType: ModelType
  /** 图片输入能力标记（手动勾选；当前未消费，为多模态预留） */
  imageInput: boolean
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: ModelItem[]
}

export type DefaultModelKey = 'assistant' | 'organize' | 'contentGen' | 'assist' | 'embedding' | 'rerank'

export const DEFAULT_MODEL_LABELS: Record<DefaultModelKey, string> = {
  assistant: '默认助手模型',
  organize: '文档整理模型',
  contentGen: '内容生成模型',
  assist: '辅助模型',
  embedding: '嵌入模型',
  rerank: '重排模型',
}

export type DefaultModels = Record<DefaultModelKey, string | null>

/** 模型类型显示名（步骤12） */
export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  '': '未分类',
  chat: '聊天',
  embedding: '嵌入',
  rerank: '重排',
}

export interface CheckedModel {
  providerId: string
  providerName: string
  modelId: string
  /** 模型类型（步骤12）：''=未分类（只在聊天模型列表末尾附注显示） */
  modelType?: ModelType
  value: string                 // "providerId/modelId"
}

/** 模型属性部分更新（步骤12）：PUT /providers/{id}/models 的 attrs 载荷 */
export interface ModelAttrs {
  modelType?: ModelType
  imageInput?: boolean
}

export interface ParserSubConfig {
  apiUrl: string
  apiKey: string
  model?: string                // 仅 paddleocr
}

export interface ParsingSettings {
  parser: 'paddleocr' | 'mineru' | 'local'
  paddleocr: ParserSubConfig
  mineru: ParserSubConfig
  local: Record<string, never>
}

export type PresetKind = 'organization' | 'plugin' | 'where'

export interface Preset {
  id: string
  kind: PresetKind
  /** 内部名（稳定不变：artifact 文件名/chunks.artifact/pass2 meta 键依赖它） */
  name: string
  /** 显示名（用户可随意改，仅 UI 展示） */
  displayName: string
  /** 仅 organization：源类型分组 文档|网页 */
  group?: 'doc' | 'web' | null
  /** 仅 plugin：指向 kind='where' 的生成位置预设 id */
  whereId?: string | null
  content: string
  updatedAt: string
}

export interface AppSettings {
  providers: Provider[]
  defaults: DefaultModels
  parser: ParsingSettings
  checkedModels: CheckedModel[]
  /** 网络搜索（步骤4）：apiKey 为打码值（尾 4 位），保存空值/打码值=不修改 */
  websearch: WebSearchSettings
}

/** 网络搜索设置（步骤4）：服务商 + API 地址 + API 密钥 */
export interface WebSearchSettings {
  provider: 'tavily' | 'exa' | 'examcp' | 'jina'
  apiUrl: string
  apiKey: string          // 读回为打码值；提交空值/打码值=不修改
}

// ---------- 事件（SSE /api/events） ----------
export interface AppEvent {
  channel: string                // job.* / doc.* / render.op / index.* / export.* / chat.*
  ts: number
  [key: string]: any
}

// ---------- 导出 ----------
export interface ExportMdDoc {
  docId: string
  name: string
  md: string
  warnings: string[]
  url: string
}

export interface PdfPreviewData {
  docId: string
  name: string
  html: string
}

export interface PdfExportOptions {
  paper: string                 // a4 | a5 | letter
  orientation: 'portrait' | 'landscape'
  columns: number
  margin: number
  fontScale: number
}

// ---------- API 适配器 ----------
export interface ChatParams {
  sessionId: string | null
  content: string
  kbIds: string[]               // 空 = 未指定；'*' = @all
  model: string | null
  mode: ChatMode
  webSearch?: boolean           // 会话级联网开关（步骤4，仅 chat/automatic 生效）
}

export interface ChatStreamHandlers {
  onSession?: (sessionId: string, title: string) => void
  onDelta?: (delta: string, seg?: number) => void
  onReasoning?: (delta: string, seg?: number) => void
  onCitations?: (citations: Citation[]) => void
  onToolCall?: (name: string, args: any, seg?: number, callId?: string) => void
  onToolResult?: (name: string, result: string, seg?: number, callId?: string, fragments?: Fragment[]) => void
  onDone?: (frame: any) => void
  onError?: (detail: string) => void
}

export interface ApiAdapter {
  // 知识库
  listKnowledgeBases(): Promise<KnowledgeBase[]>
  createKnowledgeBase(name: string): Promise<KnowledgeBase>
  renameKnowledgeBase(id: string, name: string): Promise<void>
  deleteKnowledgeBases(ids: string[]): Promise<void>
  /** 手动排序（步骤10）：一次拖动=整列表新顺序下发，后端按位赋 sort_order */
  reorderKnowledgeBases(ids: string[]): Promise<void>
  /** 知识库级默认配置（步骤11）：{genConfig: {doc, web}, indexConfig: {doc, web}} */
  getKbConfig(id: string): Promise<KbConfigs>
  putKbConfig(id: string, cfg: KbConfigs): Promise<KbConfigs>
  /** 链接导入（步骤11）：抓取网页 → trafilatura 抽正文 → 网页类文档（status 直达 ready）。
   *  抓取失败/非 HTML → reject（message 为后端 detail） */
  importLink(kbId: string, url: string, presetId?: string | null): Promise<DocumentItem>

  // 文档
  listDocuments(kbId: string): Promise<DocumentItem[]>
  importDocuments(kbId: string, files: File[]): Promise<DocumentItem[]>
  renameDocument(id: string, name: string): Promise<void>
  deleteDocuments(ids: string[]): Promise<void>
  /** 手动排序（步骤10）：一次拖动=整列表新顺序下发（限 kbId 范围内） */
  reorderDocuments(kbId: string, ids: string[]): Promise<void>
  /** 移动文档到目标知识库（运行中文档 409 拒绝，错误文本见 message） */
  moveDocuments(docIds: string[], targetKbId: string): Promise<DocumentItem[]>
  /** 复制文档到目标知识库（chunks 向量复用零重嵌入；新文档名=原名+"（副本）"） */
  copyDocument(docId: string, targetKbId: string): Promise<DocumentItem>
  reparseDocument(id: string): Promise<void>
  retryDocument(id: string): Promise<void>
  /** 暂停/继续该文档进行中的生成/入库流水线 */
  pauseDocument(id: string): Promise<void>
  resumeDocument(id: string): Promise<void>
  applyGenConfig(ids: string[], config: Partial<GenConfig>): Promise<void>
  applyIndexConfig(ids: string[], config: Partial<IndexConfig>): Promise<void>
  /** 总是执行流水线：pass1/pass2/入库按指纹跳过未变化步骤 */
  generateDocuments(ids: string[], force?: boolean): Promise<void>
  reindexDocument(id: string): Promise<void>
  getPreview(id: string): Promise<PreviewData | null>
  /** pass1 生成的文档标题（读产物 .meta.json；无预设/未生成/无标题返回 {title: null}） */
  getGeneratedTitle(id: string): Promise<{ title: string | null }>

  // 助手会话
  listSessions(): Promise<ChatSession[]>
  createSession(title?: string): Promise<ChatSession>
  /** 部分更新会话：标题 / 每会话独立的 mode/model/kbIds/webSearch */
  updateSession(id: string, patch: Partial<Pick<ChatSession, 'title' | 'mode' | 'model' | 'kbIds' | 'webSearch'>>): Promise<void>
  deleteSession(id: string): Promise<void>
  listMessages(sessionId: string): Promise<ChatMessage[]>
  /** 流式聊天（SSE）；返回最终完整回复。signal 可中止（停止键） */
  chat(params: ChatParams, handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<string>
  /** 编辑用户消息：原位替换、截断其后，重新流式生成回答 */
  regenerate(sessionId: string, messageId: string, content: string,
    handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<string>
  /** 对话分支：复制该消息及之前的全部消息到新会话（debug4 #14：includeCurrent=false
   *  时不复制该消息本身——user 消息分支=复制之前的消息，本条由前端放回输入框草稿） */
  branchSession(sessionId: string, messageId: string,
    opts?: { includeCurrent?: boolean }): Promise<ChatSession>
  /** 生成对话名（辅助模型读首条用户消息） */
  generateTitle(sessionId: string): Promise<{ sessionId: string; title: string }>

  // 设置
  getSettings(): Promise<AppSettings>
  updateDefaults(values: Partial<DefaultModels>): Promise<void>
  updateParser(value: Partial<ParsingSettings>): Promise<void>
  /** 网络搜索设置（步骤4）：读=打码 key；写空值/打码值=不修改 */
  getWebsearch(): Promise<WebSearchSettings>
  updateWebsearch(patch: Partial<WebSearchSettings>): Promise<WebSearchSettings>
  createProvider(name: string, baseUrl: string, apiKey: string): Promise<Provider>
  updateProvider(id: string, patch: Partial<Pick<Provider, 'name' | 'baseUrl' | 'apiKey'>>): Promise<void>
  deleteProvider(id: string): Promise<void>
  fetchProviderModels(id: string): Promise<string[]>
  /** 设置勾选 + 模型属性（步骤12）：attrs={modelId: {modelType?, imageInput?}}（部分更新） */
  setCheckedModels(id: string, checked: string[], attrs?: Record<string, ModelAttrs>): Promise<void>
  createPreset(kind: PresetKind, displayName: string, content?: string,
    extra?: { group?: 'doc' | 'web'; whereId?: string }): Promise<Preset>
  updatePreset(id: string, patch: Partial<Pick<Preset, 'displayName' | 'content' | 'whereId' | 'group'>>): Promise<void>
  deletePreset(id: string): Promise<void>

  // 导出
  exportMarkdown(ids: string[]): Promise<ExportMdDoc[]>
  pdfPreview(docId: string, options: PdfExportOptions): Promise<PdfPreviewData>
  exportPdf(ids: string[], options: PdfExportOptions): Promise<void>

  // 事件流
  subscribeEvents(handler: (ev: AppEvent) => void, onResync?: () => void): () => void
}
