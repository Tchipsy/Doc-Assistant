import { create } from 'zustand'
import { api } from '../api/client'
import type {
  AppSettings, CheckedModel, DefaultModelKey, DefaultModels, ModelAttrs, ModelType,
  ParsingSettings, Preset, PresetKind, Provider, WebSearchSettings,
} from '../api/types'

interface SettingsState {
  settings: AppSettings | null
  presets: Preset[]          // 含 organization + where + plugin 三类
  init: () => Promise<void>
  refresh: () => Promise<void>
  updateDefaults: (values: Partial<DefaultModels>) => Promise<void>
  updateParser: (value: Partial<ParsingSettings>) => Promise<void>
  updateWebsearch: (patch: Partial<WebSearchSettings>) => Promise<void>
  createProvider: (name: string, baseUrl: string, apiKey: string) => Promise<void>
  updateProvider: (id: string, patch: Partial<Pick<Provider, 'name' | 'baseUrl' | 'apiKey'>>) => Promise<void>
  deleteProvider: (id: string) => Promise<void>
  fetchModels: (providerId: string) => Promise<string[]>
  setCheckedModels: (providerId: string, checked: string[], attrs?: Record<string, ModelAttrs>) => Promise<void>
  createPreset: (kind: PresetKind, displayName: string, content?: string,
    extra?: { group?: 'doc' | 'web'; whereId?: string }) => Promise<void>
  updatePreset: (id: string, patch: Partial<Pick<Preset, 'displayName' | 'content' | 'whereId' | 'group'>>) => Promise<void>
  deletePreset: (id: string) => Promise<void>
  checkedModels: () => CheckedModel[]
  orgPresets: () => Preset[]
  wherePresets: () => Preset[]
  pluginPresets: () => Preset[]
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  presets: [],

  init: async () => { await get().refresh() },

  refresh: async () => {
    const [settings, presetRes] = await Promise.all([
      api.getSettings(),
      fetch('/api/presets').then(r => r.json()).then((d: { presets: Preset[] }) => d.presets),
    ])
    set({ settings, presets: presetRes ?? [] })
  },

  updateDefaults: async (values) => {
    await api.updateDefaults(values)
    const s = get().settings
    if (s) set({ settings: { ...s, defaults: { ...s.defaults, ...values } } })
  },

  updateParser: async (value) => {
    await api.updateParser(value)
    const s = get().settings
    if (s) set({ settings: { ...s, parser: { ...s.parser, ...value } } })
  },

  // 网络搜索（步骤4）：以服务端返回（打码 key）为准回写，防本地明文/打码不一致
  updateWebsearch: async (patch) => {
    const websearch = await api.updateWebsearch(patch)
    const s = get().settings
    if (s) set({ settings: { ...s, websearch } })
  },

  createProvider: async (name, baseUrl, apiKey) => {
    await api.createProvider(name, baseUrl, apiKey)
    await get().refresh()
  },

  updateProvider: async (id, patch) => {
    await api.updateProvider(id, patch)
    await get().refresh()
  },

  deleteProvider: async (id) => {
    await api.deleteProvider(id)
    await get().refresh()
  },

  fetchModels: async (providerId) => {
    const models = await api.fetchProviderModels(providerId)
    await get().refresh()
    return models
  },

  setCheckedModels: async (providerId, checked, attrs) => {
    await api.setCheckedModels(providerId, checked, attrs)
    await get().refresh()
  },

  createPreset: async (kind, displayName, content = '', extra) => {
    await api.createPreset(kind, displayName, content, extra)
    await get().refresh()
  },

  updatePreset: async (id, patch) => {
    await api.updatePreset(id, patch)
    await get().refresh()
  },

  deletePreset: async (id) => {
    await api.deletePreset(id)
    await get().refresh()
  },

  // 便捷 getter：只能在 getState() 场景使用（非响应式），
  // 禁止用作 useSettingsStore(selector) —— 每次返回新数组会导致 zustand v5 无限重渲染
  checkedModels: () => get().settings?.checkedModels ?? [],

  orgPresets: () => get().presets.filter(p => p.kind === 'organization'),
  wherePresets: () => get().presets.filter(p => p.kind === 'where'),
  pluginPresets: () => get().presets.filter(p => p.kind === 'plugin'),
}))

export type { Provider, DefaultModelKey }

/** 按模型类型过滤已勾选模型（步骤12；模块级纯函数——勿作 zustand selector 用，
 *  组件内经 useMemo 派生）。chat 列表末尾附注未分类（modelType=''）旧模型，
 *  避免升级后旧模型从所有下拉里消失 */
export function modelsOfType(list: CheckedModel[], type: 'chat' | 'embedding' | 'rerank'): CheckedModel[] {
  const exact = list.filter(m => (m.modelType || '') === type)
  if (type !== 'chat') return exact
  return [...exact, ...list.filter(m => !m.modelType)]
}

/** 各默认模型槽位期望的模型类型（步骤12；未列出的槽位=chat） */
export const DEFAULT_KEY_MODEL_TYPES: Record<DefaultModelKey, 'chat' | 'embedding' | 'rerank'> = {
  assistant: 'chat', organize: 'chat', contentGen: 'chat', assist: 'chat',
  embedding: 'embedding', rerank: 'rerank',
}
