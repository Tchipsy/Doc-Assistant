/**
 * 设置页分区清单（debug5：设置页纳入标签页体系）。
 * SettingsPage 导航与 tabs store 的路由规范化共用这一份，保证"合法分区"单一真相——
 * 新增分区只改这里与 SettingsPage 的 NAV（图标/文案仍留在页面侧）。
 */
export type SectionId = 'providers' | 'defaults' | 'parsing' | 'websearch' | 'presets' | 'plugins'

export const SETTINGS_SECTIONS: readonly SectionId[] = [
  'providers', 'defaults', 'parsing', 'websearch', 'presets', 'plugins',
]

/** 路由分区是否合法（#/settings/{section} 规范化依据；无分区/非法 → false） */
export const isSettingsSection = (v?: string): v is SectionId =>
  !!v && (SETTINGS_SECTIONS as readonly string[]).includes(v)
