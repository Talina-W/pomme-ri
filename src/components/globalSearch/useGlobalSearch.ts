import { useCallback, useEffect, useRef, useState } from 'react'
import { reportStorageError } from '../../services/chat/db.js'
import { searchHistory, type SearchHit } from '../../services/chat/search.js'
import { useChatStore } from '../../services/chat/store.js'

export type GlobalSearchStatus = 'idle' | 'searching' | 'done' | 'error'

export type GlobalSearchState = {
  status: GlobalSearchStatus
  query: string
  hits: SearchHit[]
  total: number
  /** 当前页之后是否还有更早的结果 */
  truncated: boolean
  loadingMore: boolean
}

export type GlobalSearchController = GlobalSearchState & { loadMore: () => void }

const EMPTY: GlobalSearchState = {
  status: 'idle',
  query: '',
  hits: [],
  total: 0,
  truncated: false,
  loadingMore: false,
}

/** 单页 60 条；输入停顿 200ms 后才查 IndexedDB。 */
const PAGE_SIZE = 60
const DEBOUNCE_MS = 200

/**
 * 搜索页的生命周期内复用索引缓存；首个关键词会建立文本索引，
 * 后续检索只在内存中匹配，流式回复也不会反复触发全量读库。
 * loadMore 按偏移追加下一页，不重新渲染已经展示的结果。
 */
export const useGlobalSearch = (query: string): GlobalSearchController => {
  const [state, setState] = useState<GlobalSearchState>(EMPTY)
  const ready = useChatStore((store) => store.ready)
  const stateRef = useRef(state)
  const generationRef = useRef(0)
  const nextOffsetRef = useRef(0)
  const loadMoreControllerRef = useRef<AbortController | null>(null)
  const loadingMoreRef = useRef(false)
  stateRef.current = state

  useEffect(() => {
    const trimmed = query.trim()
    const generation = ++generationRef.current
    nextOffsetRef.current = 0
    loadingMoreRef.current = false
    loadMoreControllerRef.current?.abort()
    loadMoreControllerRef.current = null
    if (!trimmed) {
      setState(EMPTY)
      return
    }
    const controller = new AbortController()
    setState({
      status: 'searching',
      query: trimmed,
      hits: [],
      total: 0,
      truncated: false,
      loadingMore: false,
    })
    const timer = setTimeout(() => {
      searchHistory(trimmed, useChatStore.getState().sessions, {
        limit: PAGE_SIZE,
        signal: controller.signal,
      })
        .then((result) => {
          if (generation !== generationRef.current || controller.signal.aborted) {
            return
          }
          nextOffsetRef.current = result.hits.length
          setState({ status: 'done', ...result, loadingMore: false })
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || generation !== generationRef.current) {
            return
          }
          reportStorageError('search local sessions')(error)
          setState({
            status: 'error',
            query: trimmed,
            hits: [],
            total: 0,
            truncated: false,
            loadingMore: false,
          })
        })
    }, DEBOUNCE_MS)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query, ready])

  const loadMore = useCallback(() => {
    const current = stateRef.current
    if (
      loadingMoreRef.current ||
      current.status !== 'done' ||
      current.loadingMore ||
      current.hits.length >= current.total
    ) {
      return
    }
    loadingMoreRef.current = true
    const generation = generationRef.current
    const offset = nextOffsetRef.current
    const controller = new AbortController()
    loadMoreControllerRef.current?.abort()
    loadMoreControllerRef.current = controller
    setState((prev) => ({ ...prev, loadingMore: true }))
    searchHistory(current.query, useChatStore.getState().sessions, {
      limit: PAGE_SIZE,
      offset,
      signal: controller.signal,
    })
      .then((result) => {
        loadingMoreRef.current = false
        if (generation !== generationRef.current || controller.signal.aborted) {
          return
        }
        nextOffsetRef.current = offset + result.hits.length
        setState((prev) => {
          if (prev.query !== current.query) {
            return prev
          }
          const seen = new Set(prev.hits.map((hit) => hit.id))
          const appended = result.hits.filter((hit) => !seen.has(hit.id))
          const hits = [...prev.hits, ...appended]
          return {
            ...prev,
            status: 'done',
            hits,
            total: result.total,
            truncated: result.truncated,
            loadingMore: false,
          }
        })
      })
      .catch((error: unknown) => {
        loadingMoreRef.current = false
        if (controller.signal.aborted || generation !== generationRef.current) {
          return
        }
        reportStorageError('load more local sessions')(error)
        setState((prev) => (prev.query === current.query ? { ...prev, loadingMore: false } : prev))
      })
  }, [])

  useEffect(
    () => () => {
      loadMoreControllerRef.current?.abort()
    },
    []
  )

  return { ...state, loadMore }
}
