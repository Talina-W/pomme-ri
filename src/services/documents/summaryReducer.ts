import type { DocumentChunk, ExtractedDocument } from './chunkDocument.js'

export type DocumentJobStatus = 'parsing' | 'reading' | 'paused' | 'reducing' | 'done' | 'error'

export type DocumentJobState = {
  sessionId: string
  /** 初始用户气泡的消息 ID；Reduce 的 assistant 回复挂在这条消息下 */
  messageId: string
  fileName: string
  instruction: string
  totalTokens: number
  imageCount: number
  chunks: DocumentChunk[]
  /** 已完成块数，也是下一次要发送的块下标 */
  currentIndex: number
  summaries: string[]
  rollingSummary: string
  status: DocumentJobStatus
  error?: string
  /** 失败块号（1-based）；不阻断后续块和 Reduce */
  failedChunks: number[]
  /** 当前块自动重试次数；用于 UI 展示“第 N 次重试” */
  retryAttempt: number
  /** 当前正在重试的块号（1-based） */
  retryPart?: number
  /** 是否正在手动重试失败块 */
  retryingFailed: boolean
  /** parsing 阶段用于刷新后恢复；解析完成后仍保留以便备份 */
  sourceFile?: File
  createdAt: number
  updatedAt: number
}

export type DocumentJobStart = {
  sessionId: string
  messageId: string
  fileName: string
  instruction: string
  sourceFile: File
}

export type SummaryAction =
  | { type: 'start'; input: DocumentJobStart }
  | { type: 'parsed'; document: ExtractedDocument }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'chunkDone'; summary: string }
  | { type: 'chunkRetry'; part: number; attempt: number }
  | { type: 'chunkFailed'; part: number }
  | { type: 'retryFailedStart'; part: number }
  | { type: 'retryFailedAttempt'; part: number; attempt: number }
  | { type: 'retryFailedDone'; part: number; summary: string }
  | { type: 'retryFailedChunkFailed'; part: number }
  | { type: 'retryFailedFinish' }
  | { type: 'reduced' }
  | { type: 'error'; error: string }
  | { type: 'retry' }
  | { type: 'reset' }

export const summaryReducer = (
  state: DocumentJobState | null,
  action: SummaryAction
): DocumentJobState | null => {
  const now = Date.now()
  switch (action.type) {
    case 'start':
      return {
        sessionId: action.input.sessionId,
        messageId: action.input.messageId,
        fileName: action.input.fileName,
        instruction: action.input.instruction,
        totalTokens: 0,
        imageCount: 0,
        chunks: [],
        currentIndex: 0,
        summaries: [],
        rollingSummary: '',
        status: 'parsing',
        failedChunks: [],
        retryAttempt: 0,
        retryingFailed: false,
        sourceFile: action.input.sourceFile,
        createdAt: now,
        updatedAt: now,
      }
    case 'parsed':
      if (!state || state.status !== 'parsing') {
        return state
      }
      return {
        ...state,
        totalTokens: action.document.totalTokens,
        imageCount: action.document.imageCount,
        chunks: action.document.chunks,
        // 解析完成后 chunks/图片已足够恢复，释放原文件占用的 IndexedDB 空间
        sourceFile: undefined,
        status: 'reading',
        updatedAt: now,
      }
    case 'pause':
      return state?.status === 'reading' ? { ...state, status: 'paused', updatedAt: now } : state
    case 'resume':
      if (!state || state.status !== 'paused') {
        return state
      }
      return {
        ...state,
        status: state.currentIndex >= state.chunks.length ? 'reducing' : 'reading',
        error: undefined,
        retryAttempt: 0,
        retryPart: undefined,
        retryingFailed: false,
        updatedAt: now,
      }
    case 'chunkDone': {
      if (!state || state.status !== 'reading') {
        return state
      }
      const summaries = [...state.summaries, action.summary]
      const currentIndex = state.currentIndex + 1
      return {
        ...state,
        summaries,
        currentIndex,
        rollingSummary: action.summary,
        status: currentIndex >= state.chunks.length ? 'reducing' : 'reading',
        retryAttempt: 0,
        retryPart: undefined,
        retryingFailed: false,
        updatedAt: now,
      }
    }
    case 'chunkRetry':
      if (!state || state.status !== 'reading') {
        return state
      }
      return {
        ...state,
        retryAttempt: action.attempt,
        retryPart: action.part,
        retryingFailed: false,
        updatedAt: now,
      }
    case 'chunkFailed': {
      if (!state || state.status !== 'reading') {
        return state
      }
      const currentIndex = state.currentIndex + 1
      return {
        ...state,
        failedChunks: [...new Set([...state.failedChunks, action.part])].sort((a, b) => a - b),
        currentIndex,
        status: currentIndex >= state.chunks.length ? 'reducing' : 'reading',
        retryAttempt: 0,
        retryPart: undefined,
        retryingFailed: false,
        updatedAt: now,
      }
    }
    case 'retryFailedStart':
      return state
        ? {
            ...state,
            status: 'reading',
            retryingFailed: true,
            retryAttempt: 0,
            retryPart: action.part,
            updatedAt: now,
          }
        : state
    case 'retryFailedAttempt':
      return state
        ? {
            ...state,
            status: 'reading',
            retryingFailed: true,
            retryAttempt: action.attempt,
            retryPart: action.part,
            updatedAt: now,
          }
        : state
    case 'retryFailedDone':
      return state
        ? {
            ...state,
            failedChunks: state.failedChunks.filter((part) => part !== action.part),
            rollingSummary: action.summary,
            retryAttempt: 0,
            retryPart: undefined,
            retryingFailed: true,
            updatedAt: now,
          }
        : state
    case 'retryFailedChunkFailed':
      return state
        ? {
            ...state,
            failedChunks: [...new Set([...state.failedChunks, action.part])].sort((a, b) => a - b),
            retryAttempt: 0,
            retryPart: undefined,
            retryingFailed: true,
            updatedAt: now,
          }
        : state
    case 'retryFailedFinish':
      return state?.status === 'reading'
        ? {
            ...state,
            status: 'done',
            retryingFailed: false,
            retryAttempt: 0,
            retryPart: undefined,
            updatedAt: now,
          }
        : state
    case 'reduced':
      return state?.status === 'reducing'
        ? {
            ...state,
            status: 'done',
            error: undefined,
            retryAttempt: 0,
            retryPart: undefined,
            retryingFailed: false,
            updatedAt: now,
          }
        : state
    case 'error':
      return state ? { ...state, status: 'error', error: action.error, updatedAt: now } : state
    case 'retry':
      if (!state || state.status !== 'error') {
        return state
      }
      return {
        ...state,
        status: state.currentIndex >= state.chunks.length ? 'reducing' : 'reading',
        error: undefined,
        retryAttempt: 0,
        retryPart: undefined,
        retryingFailed: false,
        updatedAt: now,
      }
    case 'reset':
      return null
    default:
      return state
  }
}

/** 当前正在处理第几块（1-based），用于 UI；解析中还没有块时返回 0。 */
export const currentPart = (state: DocumentJobState): number => {
  if (state.retryPart !== undefined) {
    return state.retryPart
  }
  if (state.chunks.length === 0) {
    return 0
  }
  return Math.min(state.chunks.length, state.currentIndex + 1)
}

export const progressPercent = (state: DocumentJobState): number => {
  if (state.status === 'done' || state.status === 'reducing') {
    return 100
  }
  if (state.chunks.length === 0) {
    return 0
  }
  return Math.round((state.currentIndex / state.chunks.length) * 100)
}
