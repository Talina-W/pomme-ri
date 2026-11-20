import { useEffect, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { closeSearchPage } from '../../app/route.js'
import { useTranslate } from '../../i18n/index.js'
import { selectSession } from '../../services/chat/store.js'
import { isImeComposing } from '../../utils/ime.js'
import type { SearchHit } from '../../services/chat/search.js'
import { IconArrowLeftOutline16, IconCloseOutline16, IconSearchOutline16 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { jumpToSearchHit } from '../sider/searchJumpState.js'
import { useGlobalSearch } from './useGlobalSearch.js'
import styles from './SearchPage.module.css'

const pad = (value: number) => String(value).padStart(2, '0')

/** 当年只显示月-日，跨年补全年份；时间精确到分钟。 */
const formatHitTime = (createdAt: number): string => {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const now = new Date()
  const day =
    date.getFullYear() === now.getFullYear()
      ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const Hit = ({ hit, onSelect }: { hit: SearchHit; onSelect: (hit: SearchHit) => void }) => {
  const t = useTranslate()
  const time = formatHitTime(hit.createdAt)
  const role = t(hit.role === 'user' ? 'historySearchYou' : 'historySearchAssistant')
  return (
    <button
      type="button"
      className={styles.result}
      data-search-result="true"
      data-session-id={hit.sessionId}
      data-message-id={hit.messageId}
      onClick={() => onSelect(hit)}
      title={hit.sessionTitle || t('untitledChat')}
    >
      <span className={styles.resultHeader}>
        <span className={styles.sessionTitle}>{hit.sessionTitle || t('untitledChat')}</span>
      </span>
      <span className={styles.meta}>
        <span>{role}</span>
        {time ? (
          <>
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(hit.createdAt).toISOString()}>{time}</time>
          </>
        ) : null}
      </span>
      <span className={styles.snippet} data-search-snippet="true">
        {hit.segments.length > 0
          ? hit.segments.map((segment) =>
              segment.match ? (
                <mark key={segment.start} className={styles.mark}>
                  {segment.text}
                </mark>
              ) : (
                <span key={segment.start}>{segment.text}</span>
              )
            )
          : hit.snippet}
      </span>
    </button>
  )
}

/** 全局搜索独立页：顶部返回 + 搜索框，结果按消息时间倒序平铺，点击跳回原消息。 */
export const SearchPage = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const state = useGlobalSearch(query)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const openHit = (hit: SearchHit) => {
    jumpToSearchHit(hit.sessionId, hit.messageId)
    selectSession(hit.sessionId)
    closeSearchPage({ replace: true })
  }

  return (
    <section className={styles.page} aria-label={t('globalSearch')}>
      <header className={styles.header}>
        <IconButton
          size={isMobile ? 'xl' : 'm'}
          icon={<IconArrowLeftOutline16 />}
          tooltip={t('globalSearchBack')}
          tooltipPlacement="bottom"
          onClick={() => closeSearchPage()}
        />
        <h1 className={styles.heading}>{t('globalSearch')}</h1>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.searchBar} role="search">
          <span className={styles.searchIcon} aria-hidden="true">
            <IconSearchOutline16 />
          </span>
          <input
            ref={inputRef}
            type="search"
            className={styles.input}
            value={query}
            placeholder={t('historySearchPlaceholder')}
            aria-label={t('historySearchLabel')}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (isImeComposing(event)) {
                return
              }
              if (event.key === 'Enter') {
                event.currentTarget.blur()
                return
              }
              if (event.key !== 'Escape') {
                return
              }
              event.preventDefault()
              if (query) {
                setQuery('')
                inputRef.current?.focus()
              } else {
                closeSearchPage()
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className={styles.clear}
              aria-label={t('historySearchClear')}
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
            >
              <IconCloseOutline16 />
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.scroll}>
        <div className={styles.content} aria-busy={state.status === 'searching'}>
          <div className={styles.summary} aria-live="polite">
            {state.status === 'done' && state.total > 0 ? (
              <>
                <span>{t('historySearchResultCount', { count: state.total })}</span>
                <span className={styles.order}>{t('globalSearchSortedByTime')}</span>
              </>
            ) : null}
          </div>

          {state.status === 'searching' ? (
            <div className={styles.state} role="status">
              <span className={styles.spinner} aria-hidden="true" />
              {t('historySearchSearching')}
            </div>
          ) : state.status === 'error' ? (
            <div className={styles.state} role="alert">
              {t('historySearchFailed')}
            </div>
          ) : state.status === 'done' && state.hits.length === 0 ? (
            <div className={styles.state}>{t('historySearchNoResult', { query: state.query })}</div>
          ) : state.status === 'done' ? (
            <ul className={styles.results}>
              {state.hits.map((hit) => (
                <li key={hit.id} className={styles.resultItem}>
                  <Hit hit={hit} onSelect={openHit} />
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.state}>
              <span className={styles.emptyIcon} aria-hidden="true">
                <IconSearchOutline16 />
              </span>
              {t('globalSearchHint')}
            </div>
          )}

          {state.status === 'done' && state.hits.length > 0 ? (
            <div className={styles.more}>
              {state.truncated ? (
                <Button
                  variant="outlined"
                  size="m"
                  disabled={state.loadingMore}
                  onClick={state.loadMore}
                >
                  {state.loadingMore ? t('globalSearchLoadingMore') : t('globalSearchLoadMore')}
                </Button>
              ) : null}
              <div className={styles.footer}>
                {t('globalSearchShownCount', {
                  shown: state.hits.length,
                  total: state.total,
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
