import { create } from 'zustand'
import { navSidebarPage } from '../lib/router'
import type { PageId } from '../api/types'

const THEME_KEY = 'doc-assistant-theme'
export type Theme = 'light' | 'dark'

function applyTheme(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark')
}

export const useAppStore = create<{
  page: PageId
  theme: Theme
  appReady: boolean
  /** 页面切换：main/assistant/settings/stats 全部走 URL 路由（pushState；debug5 起 stats=#/stats 占位标签） */
  setPage: (p: PageId) => void
  toggleTheme: () => void
  setAppReady: (v: boolean) => void
}>((set, get) => ({
  page: 'main',
  theme: ((): Theme => {
    const t = (localStorage.getItem(THEME_KEY) as Theme) || 'light'
    applyTheme(t)
    return t
  })(),
  appReady: false,
  setPage: (page) => {
    navSidebarPage(page)   // 四页均为标签路由（main/assistant 无 kb/会话时退化为仅切 page 不写 URL）
  },
  toggleTheme: () => {
    const next: Theme = get().theme === 'light' ? 'dark' : 'light'
    localStorage.setItem(THEME_KEY, next)
    applyTheme(next)
    set({ theme: next })
  },
  setAppReady: (appReady) => set({ appReady }),
}))
