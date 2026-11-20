import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useTranslate } from '../../i18n/index.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import type { Message, Session } from '../../services/chat/types.js'
import { IconArrowDownOutline16 } from '../base/icons.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { clearSearchJump, useSearchJump } from '../sider/searchJumpState.js'
import { AssistantMessage } from './AssistantMessage.js'
import type { SelectMessageVersion } from './BranchSwitcher.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
/** 距底部超过该值时显示「回到底部」悬浮按钮 */
const SCROLL_BUTTON_THRESHOLD = 300
/** 单次向上/向下预渲染的像素范围；DOM 数量只与视口有关，与会话总消息数无关 */
const VIEWPORT_OVERSHOOT = { top: 800, bottom: 400 }
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}

/** 列表底部留白，替代原来挂在整个消息列上的 padding-bottom。 */
const ListFooter = () => <div className={styles.bottomSpacer} />

type MessageRowProps = {
  sessionId: string
  message: Message
  index: number
  lastIndex: number
  retryUploadId: string | null
  busy: boolean
  streaming: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}

/** 只包住真正挂载的消息；滚出视口后由 Virtuoso 卸载。 */
const MessageRow = memo(function MessageRow({
  sessionId,
  message,
  index,
  lastIndex,
  retryUploadId,
  busy,
  streaming,
  versions,
  onSelectVersion,
}: MessageRowProps) {
  const t = useTranslate()
  const isLast = index === lastIndex
  const partialCount =
    message.role === 'assistant' ? (message.documentPartial?.failedChunks.length ?? 0) : 0
  if (message.role === 'assistant' && message.documentNotice) {
    const content = message.blocks
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim()
    return (
      <div className={styles.item}>
        <div className={styles.documentNotice}>{content}</div>
      </div>
    )
  }
  return (
    <div className={styles.item}>
      {partialCount > 0 ? (
        <div className={styles.documentPartialWarning}>
          {t('documentPartialWarning', { count: partialCount })}
        </div>
      ) : null}
      {message.role === 'user' ? (
        <UserMessage
          sessionId={sessionId}
          message={message}
          retryUploadId={retryUploadId}
          isFirst={index === 0}
          isLast={isLast || index === lastIndex - 1}
          busy={busy}
          versions={versions}
          onSelectVersion={onSelectVersion}
        />
      ) : (
        <AssistantMessage
          sessionId={sessionId}
          message={message}
          isLast={isLast}
          streaming={streaming && isLast}
          busy={busy}
          versions={versions}
          onSelectVersion={onSelectVersion}
        />
      )}
    </div>
  )
})

export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const t = useTranslate()
  const jumpTarget = useSearchJump((state) => state.target)
  const jumpPending = jumpTarget?.sessionId === session.id
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const scrollerElRef = useRef<HTMLElement | null>(null)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const stickyRef = useRef(true)
  const jumpLockRef = useRef(false)
  const jumpReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const previousSessionRef = useRef<string | null>(null)
  const previousLastMessageRef = useRef<string | undefined>(undefined)
  const showScrollRef = useRef(false)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [followEnabled, setFollowEnabled] = useState(!jumpPending)
  const [contentOverflows, setContentOverflows] = useState(false)
  const contentOverflowsRef = useRef(false)
  const totalListHeightRef = useRef(0)
  const initialBottomDoneRef = useRef(jumpPending)
  const [branchRevision, setBranchRevision] = useState(0)
  // 子组件的 layoutEffect 会通过 Markdown 触发 scrollToBottom，必须在首次提交前就关掉跟随，
  // 否则跳转到老消息后会被 mount 时的滚动拉回底部。
  if (jumpPending) {
    stickyRef.current = false
    jumpLockRef.current = true
  }
  // 流式更新只替换最后一条消息；缓存可见路径，避免每一帧都遍历整段历史。
  // 切换分支时 branchRevision 递增，新消息到达时长度的变化都会使缓存失效。
  const visibleCacheRef = useRef<{
    sessionId: string
    rootMessageId: string | null | undefined
    length: number
    revision: number
    messages: Message[]
  } | null>(null)
  let messages: Message[]
  if (session.rootMessageId === undefined) {
    messages = session.messages
  } else {
    const cache = visibleCacheRef.current
    const cacheValid =
      cache !== null &&
      cache.sessionId === session.id &&
      cache.rootMessageId === session.rootMessageId &&
      cache.length === session.messages.length &&
      cache.revision === branchRevision
    if (!cacheValid) {
      messages = getVisibleMessages(session)
      visibleCacheRef.current = {
        sessionId: session.id,
        rootMessageId: session.rootMessageId,
        length: session.messages.length,
        revision: branchRevision,
        messages,
      }
    } else {
      const latest = session.messages.at(-1)
      const lastVisible = cache.messages.at(-1)
      if (latest && lastVisible && latest.id === lastVisible.id && latest !== lastVisible) {
        messages = cache.messages.slice()
        messages[messages.length - 1] = latest
        cache.messages = messages
      } else {
        messages = cache.messages
      }
    }
  }
  const messagesLengthRef = useRef(messages.length)
  messagesLengthRef.current = messages.length
  const jumpIndex =
    jumpTarget?.sessionId === session.id
      ? messages.findIndex((message) => message.id === jumpTarget.messageId)
      : -1
  // 只在会话首次挂载时决定初始位置；搜索跳转清除后不能重新应用 LAST 把视图拉回底部。
  const initialIndexRef = useRef<{
    sessionId: string
    value: { index: number | 'LAST'; align?: 'start' | 'center' }
  } | null>(null)
  if (!initialIndexRef.current || initialIndexRef.current.sessionId !== session.id) {
    initialIndexRef.current = {
      sessionId: session.id,
      value:
        jumpIndex >= 0
          ? { index: jumpIndex, align: jumpIndex === 0 ? 'start' : 'center' }
          : { index: 'LAST' },
    }
  }
  const initialTopMostItemIndex = initialIndexRef.current.value
  const sessionRef = useRef(session)
  sessionRef.current = session
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(sessionRef.current, previousVersions),
    // 只依赖消息结构；流式更新正文时不重算整段历史的版本分组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id, session.rootMessageId, session.messages.length, branchRevision, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  const canFollow = contentOverflows && followEnabled

  /** 流式 Markdown 更新时调用；只有内容超过一屏且用户仍在底部时跟随。 */
  const scrollToBottom = useCallback(() => {
    if (canFollow && stickyRef.current && !jumpLockRef.current) {
      virtuosoRef.current?.autoscrollToBottom()
    }
  }, [canFollow])

  /** 悬浮按钮和主动操作：强制回到底部，并恢复跟随。 */
  const scrollToLatest = useCallback(() => {
    const index = messagesLengthRef.current - 1
    if (index < 0) {
      return
    }
    clearTimeout(jumpReleaseTimerRef.current)
    jumpLockRef.current = false
    setFollowEnabled(true)
    stickyRef.current = true
    virtuosoRef.current?.scrollToIndex({ index, align: 'end', behavior: 'smooth' })
  }, [])

  const updateContentOverflow = useCallback((height = totalListHeightRef.current) => {
    totalListHeightRef.current = height
    const element = scrollerElRef.current
    if (!element) {
      return
    }
    const next = height > element.clientHeight + 1
    if (next !== contentOverflowsRef.current) {
      contentOverflowsRef.current = next
      setContentOverflows(next)
    }
  }, [])

  const updateScrollButton = useCallback(() => {
    const element = scrollerElRef.current
    if (!element) {
      return
    }
    const next =
      element.scrollHeight - element.scrollTop - element.clientHeight > SCROLL_BUTTON_THRESHOLD
    if (next !== showScrollRef.current) {
      showScrollRef.current = next
      setShowScrollToBottom(next)
    }
  }, [])

  const handleScrollerRef = useCallback((ref: HTMLElement | null | Window) => {
    const element = ref instanceof HTMLElement ? ref : null
    if (element) {
      element.dataset.messageScroller = 'true'
    }
    scrollerElRef.current = element
    setScroller(element)
  }, [])

  const handleAtBottom = useCallback((atBottom: boolean) => {
    stickyRef.current = atBottom && !jumpLockRef.current
    if (atBottom && !jumpLockRef.current) {
      setFollowEnabled(true)
    }
    if (atBottom && showScrollRef.current) {
      showScrollRef.current = false
      setShowScrollToBottom(false)
    }
  }, [])

  // Virtuoso 初始化时按估算高度定位 LAST，Markdown/代码块渲染完成后真实高度变大，
  // 会停留在长回答的开头。内容超过一屏后，在首屏布局稳定阶段再强制校准到最底部。
  useEffect(() => {
    if (!contentOverflows || initialBottomDoneRef.current || jumpPending) {
      return
    }
    initialBottomDoneRef.current = true
    let frame = 0
    const timers: ReturnType<typeof setTimeout>[] = []
    const scroll = () => {
      if (jumpLockRef.current || restoreScrollRef.current) {
        return
      }
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
    }
    frame = requestAnimationFrame(scroll)
    timers.push(setTimeout(scroll, 120), setTimeout(scroll, 400))
    return () => {
      cancelAnimationFrame(frame)
      for (const timer of timers) {
        clearTimeout(timer)
      }
    }
  }, [contentOverflows, jumpPending])

  /** 跳转后短暂锁定跟随，等动态高度和子组件的 layoutEffect 全部结束。 */
  const releaseJumpLock = useCallback(() => {
    clearTimeout(jumpReleaseTimerRef.current)
    jumpReleaseTimerRef.current = setTimeout(() => {
      jumpLockRef.current = false
      const element = scrollerElRef.current
      if (
        element &&
        element.scrollHeight - element.scrollTop - element.clientHeight <= STICKY_THRESHOLD
      ) {
        stickyRef.current = true
        setFollowEnabled(true)
      }
    }, 800)
  }, [])

  // 滚动容器变化时重新挂监听；内容高度变化由 Virtuoso 的 totalListHeightChanged 通知。
  useEffect(() => {
    if (!scroller) {
      return
    }
    updateScrollButton()
    updateContentOverflow()
    scroller.addEventListener('scroll', updateScrollButton, { passive: true })
    const observer = new ResizeObserver(() => {
      updateScrollButton()
      updateContentOverflow()
    })
    observer.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', updateScrollButton)
      observer.disconnect()
    }
  }, [scroller, updateScrollButton, updateContentOverflow])

  const jumpPendingRef = useRef(jumpPending)
  jumpPendingRef.current = jumpPending
  // 切换会话时重置跟随状态；Virtuoso 通过 key 重新挂载并从最后一条开始。
  useEffect(() => {
    stickyRef.current = !jumpPendingRef.current
    jumpLockRef.current = jumpPendingRef.current
    setFollowEnabled(!jumpPendingRef.current)
    clearTimeout(jumpReleaseTimerRef.current)
    restoreScrollRef.current = null
    showScrollRef.current = false
    setShowScrollToBottom(false)
  }, [session.id])

  // 新消息到达时回到底部；切换版本或从搜索跳转时不能覆盖目标位置。
  useLayoutEffect(() => {
    const sessionChanged = previousSessionRef.current !== session.id
    const lastMessageChanged = previousLastMessageRef.current !== lastMessageId
    previousSessionRef.current = session.id
    previousLastMessageRef.current = lastMessageId
    if (!sessionChanged && !lastMessageChanged) {
      return
    }
    if (restoreScrollRef.current || (jumpTarget && jumpTarget.sessionId === session.id)) {
      return
    }
    stickyRef.current = true
    setFollowEnabled(true)
    virtuosoRef.current?.autoscrollToBottom()
  }, [session.id, lastMessageId, jumpTarget])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    if (!anchor) {
      return
    }
    const switcher = scrollerElRef.current?.querySelector<HTMLElement>(
      `[data-message-version="${CSS.escape(anchor.messageId)}"]`
    )
    if (switcher) {
      const delta = switcher.getBoundingClientRect().top - anchor.top
      if (delta !== 0) {
        virtuosoRef.current?.scrollBy({ top: delta })
      }
      restoreScrollRef.current = null
    }
  }, [session, messages])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  // 搜索命中跳转：先让 Virtuoso 把目标挂载出来，再滚动并短暂高亮。
  useEffect(() => {
    if (!jumpTarget || jumpTarget.sessionId !== session.id) {
      return
    }
    const index = messages.findIndex((message) => message.id === jumpTarget.messageId)
    if (index === -1) {
      clearSearchJump(jumpTarget.nonce)
      releaseJumpLock()
      return
    }
    stickyRef.current = false

    let attempts = 0
    let frame = 0
    const reveal = () => {
      const element = scrollerElRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(jumpTarget.messageId)}"]`
      )
      // 动态高度还没测量完时 Virtuoso 会暂时隐藏列表，此时先不要停止等待。
      if (element && getComputedStyle(element).visibility !== 'hidden') {
        element.classList.remove(styles.searchHitFlash)
        // 读取布局强制重启动画，避免同一条消息第二次点击没有反馈。
        void element.offsetWidth
        element.classList.add(styles.searchHitFlash)
        clearTimeout(highlightTimerRef.current)
        highlightTimerRef.current = setTimeout(() => {
          element.classList.remove(styles.searchHitFlash)
        }, 2400)
        clearSearchJump(jumpTarget.nonce)
        releaseJumpLock()
        return
      }
      attempts += 1
      if (attempts === 10) {
        // 首屏可能还没完成动态高度测量；再补一次精确定位，避免只高亮但不在视口内。
        virtuosoRef.current?.scrollToIndex({
          index,
          align: index === 0 ? 'start' : 'center',
          behavior: 'auto',
        })
      }
      if (attempts < 120) {
        frame = requestAnimationFrame(reveal)
      } else {
        clearSearchJump(jumpTarget.nonce)
        releaseJumpLock()
      }
    }
    frame = requestAnimationFrame(reveal)
    return () => cancelAnimationFrame(frame)
  }, [jumpTarget, session.id, messages, releaseJumpLock])

  useEffect(
    () => () => {
      clearTimeout(highlightTimerRef.current)
      clearTimeout(jumpReleaseTimerRef.current)
    },
    []
  )

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      setBranchRevision((value) => value + 1)
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  const itemContent = useCallback(
    (index: number, message: Message) => (
      <MessageRow
        sessionId={session.id}
        message={message}
        index={index}
        lastIndex={lastIndex}
        retryUploadId={uploadRetryId}
        busy={streaming}
        streaming={streaming}
        versions={versions.get(message.id) ?? EMPTY_VERSIONS}
        onSelectVersion={selectVersion}
      />
    ),
    [session.id, lastIndex, uploadRetryId, streaming, versions, selectVersion]
  )

  const computeItemKey = useCallback((_: number, message: Message) => message.id, [])
  const handleTotalListHeight = useCallback(
    (height: number) => {
      updateContentOverflow(height)
      updateScrollButton()
    },
    [updateContentOverflow, updateScrollButton]
  )
  const followOutput = useCallback(
    (isAtBottom: boolean) =>
      isAtBottom && !jumpLockRef.current ? ('auto' as const) : (false as const),
    []
  )
  const components = useMemo(() => ({ Footer: ListFooter }), [])

  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <div className={styles.container}>
        <div className={styles.listArea}>
          <Virtuoso
            key={session.id}
            ref={virtuosoRef}
            scrollerRef={handleScrollerRef}
            className={styles.scroller}
            data={messages}
            computeItemKey={computeItemKey}
            initialTopMostItemIndex={initialTopMostItemIndex}
            alignToBottom={contentOverflows}
            followOutput={canFollow ? followOutput : false}
            atBottomThreshold={STICKY_THRESHOLD}
            atBottomStateChange={handleAtBottom}
            increaseViewportBy={VIEWPORT_OVERSHOOT}
            totalListHeightChanged={handleTotalListHeight}
            itemContent={itemContent}
            components={components}
          />
          {showScrollToBottom ? (
            <button
              type="button"
              className={styles.scrollToBottom}
              aria-label={t('scrollToBottom')}
              title={t('scrollToBottom')}
              onClick={scrollToLatest}
            >
              <IconArrowDownOutline16 />
            </button>
          ) : null}
        </div>
        {footer}
      </div>
    </ScrollToBottomContext.Provider>
  )
}
