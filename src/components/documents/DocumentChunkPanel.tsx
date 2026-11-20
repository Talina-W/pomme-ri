import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useDocumentJob } from '../../services/documents/documentJob.js'
import { currentPart, progressPercent } from '../../services/documents/summaryReducer.js'
import { Button } from '../base/Button.js'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
} from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { Tooltip } from '../base/Tooltip.js'
import styles from './DocumentChunkPanel.module.css'

const formatTokens = (value: number) => new Intl.NumberFormat().format(Math.round(value))

/**
 * 长文档分块阅读进度：自动 parsing → reading → reducing → done。
 * 完成后自动折叠成输入框左缘的箭头；点击箭头可重新展开。
 */
export const DocumentChunkPanel = ({ sessionId }: { sessionId: string }) => {
  const t = useTranslate()
  const job = useDocumentJob((state) => state.jobs[sessionId])
  const ensureLoaded = useDocumentJob((state) => state.ensureLoaded)
  const pause = useDocumentJob((state) => state.pause)
  const resume = useDocumentJob((state) => state.resume)
  const retry = useDocumentJob((state) => state.retry)
  const retryFailed = useDocumentJob((state) => state.retryFailed)
  const reset = useDocumentJob((state) => state.reset)
  const [collapsed, setCollapsed] = useState(job?.status === 'done' || job?.status === 'error')

  const jobKey = job ? `${sessionId}:${job.fileName}:${job.totalTokens}` : ''

  useEffect(() => {
    void ensureLoaded(sessionId)
  }, [ensureLoaded, sessionId])

  // 新文档任务默认展开；同一任务内用户手动折叠后不被状态更新强行打开。
  useEffect(() => {
    setCollapsed(false)
  }, [jobKey])

  // 完成或失败后都自动缩略；需要补漏时再展开面板。
  useEffect(() => {
    if (job?.status === 'done' || job?.status === 'error') {
      setCollapsed(true)
    }
  }, [job?.status])

  if (!job) {
    return null
  }

  if (collapsed) {
    return (
      <Tooltip content={t('documentChunkExpand')}>
        <button
          type="button"
          className={styles.edgeToggle}
          aria-label={t('documentChunkExpand')}
          aria-expanded={false}
          onClick={() => setCollapsed(false)}
        >
          <IconChevronRightOutline14 />
        </button>
      </Tooltip>
    )
  }

  const total = job.chunks.length
  const part = currentPart(job)
  const progress = progressPercent(job)
  const message =
    job.status === 'error'
      ? (job.error ?? t('documentChunkFailed'))
      : job.status === 'parsing'
        ? t('documentChunkParsing')
        : job.status === 'paused'
          ? t('documentChunkPaused', { current: part, total })
          : job.status === 'reducing'
            ? t('documentChunkReducing')
            : job.status === 'done'
              ? job.failedChunks.length > 0
                ? t('documentChunkDonePartial', { count: job.failedChunks.length })
                : t('documentChunkDone', { total })
              : job.retryingFailed
                ? t('documentChunkRetryingFailed', { current: part, total })
                : job.retryAttempt > 0
                  ? t('documentChunkRetrying', {
                      current: part,
                      total,
                      attempt: job.retryAttempt,
                    })
                  : t('documentChunkReading', { current: part, total })

  return (
    <section className={styles.panel} aria-label={t('documentChunkTitle')}>
      <div className={styles.header}>
        <span className={styles.title}>{t('documentChunkTitle')}</span>
        <span className={styles.fileName} title={job.fileName}>
          {job.fileName}
        </span>
        <IconButton
          size="xs"
          icon={<IconChevronDownOutline14 />}
          tooltip={t('documentChunkCollapse')}
          onClick={() => setCollapsed(true)}
        />
        <IconButton
          size="xs"
          icon={<IconCloseOutline16 />}
          tooltip={t('documentChunkClear')}
          onClick={() => reset(sessionId)}
        />
      </div>
      {total > 0 ? (
        <div className={styles.meta}>
          {t('documentChunkSplit', {
            tokens: formatTokens(job.totalTokens),
            count: total,
          })}
        </div>
      ) : null}
      <div className={styles.progressTrack} aria-hidden="true">
        <div className={styles.progressBar} style={{ width: `${progress}%` }} />
      </div>
      <div className={styles.status} aria-live="polite">
        {message}
      </div>
      <div className={styles.actions}>
        {job.status === 'reading' && !job.retryingFailed ? (
          <Button size="s" variant="outlined" onClick={() => pause(sessionId)}>
            {t('documentChunkPause')}
          </Button>
        ) : null}
        {job.status === 'paused' ? (
          <Button size="s" onClick={() => void resume(sessionId)}>
            {t('documentChunkResume')}
          </Button>
        ) : null}
        {job.status === 'error' ? (
          <Button size="s" variant="outlined" onClick={() => void retry(sessionId)}>
            {t('documentChunkRetry')}
          </Button>
        ) : null}
        {job.status === 'done' && job.failedChunks.length > 0 ? (
          <Button size="s" onClick={() => void retryFailed(sessionId)}>
            {t('documentRetryFailed', { count: job.failedChunks.length })}
          </Button>
        ) : null}
        {job.rollingSummary ? (
          <details className={styles.summary}>
            <summary>{t('documentChunkSummary')}</summary>
            <div className={styles.summaryBody}>{job.rollingSummary}</div>
          </details>
        ) : null}
      </div>
    </section>
  )
}
