import { useSyncExternalStore } from 'react'

/** 全局搜索页；本项目没有引入路由库，用 hash 就能在静态部署和 Capacitor 内正常前进/后退。 */
const SEARCH_HASH = '#/search'

export type AppRoute = 'chat' | 'search'

const getRoute = (): AppRoute => (window.location.hash === SEARCH_HASH ? 'search' : 'chat')

const subscribe = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

export const useAppRoute = (): AppRoute => useSyncExternalStore(subscribe, getRoute)

export const openSearchPage = () => {
  if (getRoute() !== 'search') {
    window.location.hash = SEARCH_HASH
  }
}

/**
 * 回到对话页。点击搜索结果时用 replace，避免留下「搜索页 → 对话页」的多余历史记录，
 * 手机返回键可以直接回到进入搜索前的页面。
 */
export const closeSearchPage = ({ replace = false }: { replace?: boolean } = {}) => {
  if (getRoute() !== 'search') {
    return
  }
  if (replace) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    // replaceState 不会触发 hashchange，需要手动通知订阅者重新读取路由。
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    window.location.hash = ''
  }
}
