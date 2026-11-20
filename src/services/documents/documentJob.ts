import { create } from 'zustand'
import { translate } from '../../i18n/index.js'
import { getEffectiveModel, useSettings } from '../settings.js'
import { ApiError, streamMessage, uploadFile } from '../api/client.js'
import { isRetryableApiError } from '../api/errors.js'
import type { CreateMessageRequest, FileBlockParam, TextBlockParam } from '../api/types.js'
import { applyEvent, getReplyText } from '../chat/reply.js'
import type { AssistantMessage } from '../chat/types.js'
import { createId } from '../../utils/id.js'
import {
  deleteDocumentJob,
  clearDocumentJobs,
  loadDocumentJob,
  saveDocumentJob,
} from '../chat/db.js'
import { extractDocument, type DocumentChunkImage } from './chunkDocument.js'
import { estimateTextTokens } from './tokenEstimate.js'
import { summaryReducer, type DocumentJobState, type DocumentJobStart } from './summaryReducer.js'

const DOCUMENT_SYSTEM_PROMPT =
  '你是长文档阅读助手。请准确提取正文、数据和图表中的关键信息，输出结构化、可复核的摘要。'
const SUMMARY_TOKEN_LIMIT = 2_500
const CHUNK_INTERVAL_MS = 1_500
const RETRY_DELAYS = [2_000, 4_000, 8_000] as const
const MAX_RETRIES = RETRY_DELAYS.length

/** 由 documentCompletion 在应用启动时注册，避免 documentJob 反向依赖 chat store。 */
export type DocumentCompletionHandler = (job: DocumentJobState) => Promise<boolean>

let completionHandler: DocumentCompletionHandler | null = null
const completing = new Set<string>()
const controllers = new Map<string, AbortController>()
const imageFileIds = new Map<string, string>()
const loadingSessions = new Set<string>()
const loadedSessions = new Set<string>()

type StartInput = Omit<DocumentJobStart, 'sourceFile'> & {
  file: File
}

type DocumentJobStore = {
  jobs: Record<string, DocumentJobState>
  ensureLoaded: (sessionId: string) => Promise<void>
  start: (input: StartInput) => void
  pause: (sessionId: string) => void
  resume: (sessionId: string) => Promise<void>
  retry: (sessionId: string) => Promise<void>
  retryFailed: (sessionId: string) => Promise<void>
  reset: (sessionId: string) => void
  resetAll: () => void
  setCompletionHandler: (handler: DocumentCompletionHandler) => void
}

const persist = (job: DocumentJobState): void => {
  void saveDocumentJob(job).catch(() => {
    // IndexedDB 不可用时任务仍在内存中运行；UI 不因此中断
  })
}

/** 可中止的等待；暂停/清空时立即返回，由调用方检查 signal 和当前状态。 */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })

/** 网络、Load failed、429、5xx、流中断都值得重试；鉴权/参数错误直接记为失败块。 */
const isTransientChunkError = (error: unknown): boolean => {
  if (error instanceof ApiError) {
    return (
      error.kind === 'network' ||
      error.kind === 'interrupted' ||
      error.status === 429 ||
      (error.status ?? 0) >= 500
    )
  }
  return isRetryableApiError(error)
}

const uploadChunkImage = async (
  sessionId: string,
  image: DocumentChunkImage,
  apiKey: string,
  signal: AbortSignal
): Promise<string> => {
  const cacheKey = `${sessionId}:${image.id}`
  const cached = imageFileIds.get(cacheKey)
  if (cached) {
    return cached
  }
  const file = new File([image.blob], `document-page-${image.pageNumber}.jpg`, {
    type: 'image/jpeg',
  })
  const uploaded = await uploadFile(apiKey, file, null, signal)
  imageFileIds.set(cacheKey, uploaded.id)
  return uploaded.id
}

const chunkPrompt = (state: DocumentJobState, index: number): string => {
  const part = index + 1
  const total = state.chunks.length
  const instruction = state.instruction.trim()
  const common = `用户对这份文档的原始指令：
${instruction}

这是长文档的第 ${part}/${total} 部分。请围绕用户指令提取核心数据、结论和图表信息。不要复述全文。`
  if (part === 1) {
    return `${common}

请输出结构化的总体摘要，供后续合并和最终回答使用，尽量控制在 2000 字以内。`
  }
  return `${common}

前面部分的总体摘要：
${state.rollingSummary || '（前面没有成功读取的摘要，请从当前部分开始整理。）'}

请结合新部分内容，输出更新后的总体摘要，保留仍然重要的信息，删除重复内容，尽量控制在 2000 字以内。`
}

const requestForChunk = (
  state: DocumentJobState,
  index: number,
  imageIds: string[]
): CreateMessageRequest => {
  const content: (FileBlockParam | TextBlockParam)[] = [
    ...imageIds.map(
      (fileId): FileBlockParam => ({
        type: 'image',
        source: { type: 'file', file_id: fileId },
      })
    ),
    {
      type: 'text',
      text: `${chunkPrompt(state, index)}

${state.chunks[index]?.text ?? ''}`,
    },
  ]
  return {
    model: getEffectiveModel(),
    system: DOCUMENT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    thinking: { type: 'disabled' },
    tools: [],
    safety_check: { level: 'high' },
  }
}

const streamSummary = async (
  request: CreateMessageRequest,
  apiKey: string,
  signal: AbortSignal
): Promise<string> => {
  const reply: AssistantMessage = {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: request.model,
    thinking: false,
    search: false,
    prefix: false,
    status: 'streaming',
    blocks: [],
  }
  const blockIndexes = new Map<number, number>()
  let next = reply
  for await (const event of streamMessage(apiKey, request, signal)) {
    next = applyEvent(next, event, Date.now(), blockIndexes)
  }
  const text = getReplyText(next).trim()
  if (!text) {
    throw new Error(translate('documentChunkFailed'))
  }
  const tokens = estimateTextTokens(text)
  if (tokens <= SUMMARY_TOKEN_LIMIT) {
    return text
  }
  const ratio = SUMMARY_TOKEN_LIMIT / tokens
  return `${text.slice(0, Math.max(1, Math.floor(text.length * ratio * 0.9))).trim()}\n…（摘要已压缩）`
}

/** 用当前 job 的 instruction / rollingSummary 请求指定块；自动和手动补漏共用。 */
const runChunk = async (
  sessionId: string,
  index: number,
  apiKey: string,
  signal: AbortSignal
): Promise<string> => {
  const job = useDocumentJob.getState().jobs[sessionId]
  if (!job || !job.chunks[index]) {
    throw new Error(translate('documentChunkFailed'))
  }
  const imageIds: string[] = []
  for (const image of job.chunks[index].images) {
    imageIds.push(await uploadChunkImage(sessionId, image, apiKey, signal))
  }
  return streamSummary(requestForChunk(job, index, imageIds), apiKey, signal)
}

export const useDocumentJob = create<DocumentJobStore>((set, get) => {
  const putJob = (job: DocumentJobState): void => {
    set((state) => ({ jobs: { ...state.jobs, [job.sessionId]: job } }))
    persist(job)
  }

  const parseDocument = async (sessionId: string): Promise<void> => {
    const job = get().jobs[sessionId]
    if (!job || job.status !== 'parsing' || !job.sourceFile) {
      return
    }
    try {
      const document = await extractDocument(job.sourceFile)
      const current = get().jobs[sessionId]
      if (current !== job || current.status !== 'parsing') {
        return
      }
      const next = summaryReducer(current, { type: 'parsed', document })
      if (!next) {
        return
      }
      putJob(next)
      void readNext(sessionId)
    } catch (error) {
      const current = get().jobs[sessionId]
      if (current !== job) {
        return
      }
      const detail = error instanceof Error ? error.message : String(error)
      const next = summaryReducer(current, {
        type: 'error',
        error: `${translate('documentChunkParseFailed')}: ${detail}`,
      })
      if (next) {
        putJob(next)
      }
    }
  }

  /** 块与块之间强制等待 1.5s；暂停时 abort 等待。 */
  const waitBeforeNext = async (sessionId: string): Promise<boolean> => {
    if (get().jobs[sessionId]?.status !== 'reading') {
      return false
    }
    const abort = new AbortController()
    controllers.set(sessionId, abort)
    await sleep(CHUNK_INTERVAL_MS, abort.signal)
    if (controllers.get(sessionId) !== abort) {
      return false
    }
    controllers.delete(sessionId)
    return !abort.signal.aborted && get().jobs[sessionId]?.status === 'reading'
  }

  const readNext = async (sessionId: string): Promise<void> => {
    const initial = get().jobs[sessionId]
    if (!initial || initial.status !== 'reading' || initial.currentIndex >= initial.chunks.length) {
      return
    }
    const apiKey = useSettings.getState().apiKey
    if (!apiKey) {
      const next = summaryReducer(initial, { type: 'error', error: translate('apiKeyStart') })
      if (next) {
        putJob(next)
      }
      return
    }
    const chunkIndex = initial.currentIndex
    const part = chunkIndex + 1
    const abort = new AbortController()
    controllers.set(sessionId, abort)

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (attempt > 0) {
        const current = get().jobs[sessionId]
        if (
          !current ||
          current.status !== 'reading' ||
          current.currentIndex !== chunkIndex ||
          controllers.get(sessionId) !== abort
        ) {
          return
        }
        const retry = summaryReducer(current, { type: 'chunkRetry', part, attempt })
        if (retry) {
          putJob(retry)
        }
        await sleep(RETRY_DELAYS[attempt - 1], abort.signal)
        if (abort.signal.aborted || controllers.get(sessionId) !== abort) {
          return
        }
        const after = get().jobs[sessionId]
        if (!after || after.status !== 'reading' || after.currentIndex !== chunkIndex) {
          return
        }
      }

      try {
        const summary = await runChunk(sessionId, chunkIndex, apiKey, abort.signal)
        if (controllers.get(sessionId) !== abort) {
          return
        }
        controllers.delete(sessionId)
        const current = get().jobs[sessionId]
        if (!current || current.status !== 'reading' || current.currentIndex !== chunkIndex) {
          return
        }
        const next = summaryReducer(current, { type: 'chunkDone', summary })
        if (!next) {
          return
        }
        putJob(next)
        if (next.status === 'reading') {
          if (await waitBeforeNext(sessionId)) {
            void readNext(sessionId)
          }
        } else if (next.status === 'reducing') {
          void completeJob(sessionId)
        }
        return
      } catch (error) {
        if (controllers.get(sessionId) !== abort) {
          return
        }
        if (abort.signal.aborted) {
          controllers.delete(sessionId)
          return
        }
        const current = get().jobs[sessionId]
        if (!current || current.status !== 'reading' || current.currentIndex !== chunkIndex) {
          controllers.delete(sessionId)
          return
        }
        if (isTransientChunkError(error) && attempt < MAX_RETRIES) {
          const retry = summaryReducer(current, {
            type: 'chunkRetry',
            part,
            attempt: attempt + 1,
          })
          if (retry) {
            putJob(retry)
          }
          continue
        }
        controllers.delete(sessionId)
        const failed = summaryReducer(current, { type: 'chunkFailed', part })
        if (!failed) {
          return
        }
        putJob(failed)
        if (failed.status === 'reading') {
          if (await waitBeforeNext(sessionId)) {
            void readNext(sessionId)
          }
        } else if (failed.status === 'reducing') {
          void completeJob(sessionId)
        }
        return
      }
    }
  }

  const completeJob = async (sessionId: string): Promise<void> => {
    const job = get().jobs[sessionId]
    if (!job || job.status !== 'reducing' || !completionHandler || completing.has(sessionId)) {
      return
    }
    completing.add(sessionId)
    try {
      const ok = await completionHandler(job)
      const current = get().jobs[sessionId]
      if (!current || current.status !== 'reducing') {
        return
      }
      const next = ok
        ? summaryReducer(current, { type: 'reduced' })
        : summaryReducer(current, {
            type: 'error',
            error: translate('documentAnswerFailed'),
          })
      if (next) {
        putJob(next)
      }
    } catch (error) {
      const current = get().jobs[sessionId]
      const detail = error instanceof Error ? error.message : String(error)
      const next = current
        ? summaryReducer(current, {
            type: 'error',
            error: `${translate('documentAnswerFailed')}: ${detail}`,
          })
        : null
      if (next) {
        putJob(next)
      }
    } finally {
      completing.delete(sessionId)
    }
  }

  /** 手动补漏：只重试 failedChunks；成功后更新滚动摘要，不自动重答。 */
  const retryFailed = async (sessionId: string): Promise<void> => {
    const initial = get().jobs[sessionId]
    if (!initial || initial.status !== 'done' || initial.failedChunks.length === 0) {
      return
    }
    const apiKey = useSettings.getState().apiKey
    if (!apiKey) {
      putJob({
        ...initial,
        status: 'error',
        error: translate('apiKeyStart'),
        retryingFailed: false,
        retryAttempt: 0,
        retryPart: undefined,
        updatedAt: Date.now(),
      })
      return
    }
    const failed = [...initial.failedChunks]
    const abort = new AbortController()
    controllers.set(sessionId, abort)
    let current = summaryReducer(initial, { type: 'retryFailedStart', part: failed[0] })
    if (!current) {
      return
    }
    putJob(current)

    for (const part of failed) {
      if (abort.signal.aborted || controllers.get(sessionId) !== abort) {
        return
      }
      const index = part - 1
      let recovered = false
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        if (attempt > 0) {
          const state = get().jobs[sessionId]
          if (!state || state.retryPart !== part || controllers.get(sessionId) !== abort) {
            return
          }
          const retry = summaryReducer(state, {
            type: 'retryFailedAttempt',
            part,
            attempt,
          })
          if (retry) {
            putJob(retry)
          }
          await sleep(RETRY_DELAYS[attempt - 1], abort.signal)
          if (abort.signal.aborted || controllers.get(sessionId) !== abort) {
            return
          }
        }
        try {
          const summary = await runChunk(sessionId, index, apiKey, abort.signal)
          if (controllers.get(sessionId) !== abort) {
            return
          }
          const state = get().jobs[sessionId]
          if (!state) {
            return
          }
          const next = summaryReducer(state, {
            type: 'retryFailedDone',
            part,
            summary,
          })
          if (next) {
            putJob(next)
          }
          recovered = true
          break
        } catch (error) {
          if (abort.signal.aborted || controllers.get(sessionId) !== abort) {
            return
          }
          if (isTransientChunkError(error) && attempt < MAX_RETRIES) {
            const state = get().jobs[sessionId]
            if (!state) {
              return
            }
            const retry = summaryReducer(state, {
              type: 'retryFailedAttempt',
              part,
              attempt: attempt + 1,
            })
            if (retry) {
              putJob(retry)
            }
            continue
          }
          const state = get().jobs[sessionId]
          if (state) {
            const failedState = summaryReducer(state, {
              type: 'retryFailedChunkFailed',
              part,
            })
            if (failedState) {
              putJob(failedState)
            }
          }
          break
        }
      }
      if (!recovered) {
        // 继续下一个失败块；不阻断其他补漏
      }
    }

    if (controllers.get(sessionId) === abort) {
      controllers.delete(sessionId)
    }
    const currentJob = get().jobs[sessionId]
    if (!currentJob || currentJob.status !== 'reading') {
      return
    }
    const done = summaryReducer(currentJob, { type: 'retryFailedFinish' })
    if (done) {
      putJob(done)
    }
  }

  return {
    jobs: {},

    ensureLoaded: async (sessionId) => {
      if (
        get().jobs[sessionId] ||
        loadingSessions.has(sessionId) ||
        loadedSessions.has(sessionId)
      ) {
        return
      }
      loadingSessions.add(sessionId)
      try {
        const stored = await loadDocumentJob(sessionId)
        if (!stored || get().jobs[sessionId]) {
          loadedSessions.add(sessionId)
          return
        }
        const normalized: DocumentJobState = {
          ...stored,
          failedChunks: stored.failedChunks ?? [],
          retryAttempt: stored.retryAttempt ?? 0,
          retryingFailed: stored.retryingFailed ?? false,
        }
        if (normalized.status === 'parsing' && !normalized.sourceFile) {
          const broken: DocumentJobState = {
            ...normalized,
            status: 'error',
            error: translate('documentChunkParseFailed'),
            updatedAt: Date.now(),
          }
          set((state) => ({ jobs: { ...state.jobs, [sessionId]: broken } }))
          loadedSessions.add(sessionId)
          persist(broken)
          return
        }
        // 刷新时不可能还有在途请求：reading/reducing 一律恢复为 paused，等用户继续。
        const restored: DocumentJobState =
          normalized.status === 'reading' || normalized.status === 'reducing'
            ? {
                ...normalized,
                status: 'paused',
                retryingFailed: false,
                retryAttempt: 0,
                retryPart: undefined,
                updatedAt: Date.now(),
              }
            : normalized
        set((state) => ({ jobs: { ...state.jobs, [sessionId]: restored } }))
        loadedSessions.add(sessionId)
        if (restored.status !== stored.status) {
          persist(restored)
        }
        if (restored.status === 'parsing') {
          void parseDocument(sessionId)
        }
      } catch {
        // 读取失败时保持无任务状态；下次选中会话还能重试
      } finally {
        loadingSessions.delete(sessionId)
      }
    },

    start: (input) => {
      controllers.get(input.sessionId)?.abort()
      controllers.delete(input.sessionId)
      completing.delete(input.sessionId)
      const job = summaryReducer(null, {
        type: 'start',
        input: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          fileName: input.fileName,
          instruction: input.instruction,
          sourceFile: input.file,
        },
      })
      if (!job) {
        return
      }
      loadedSessions.add(input.sessionId)
      putJob(job)
      void parseDocument(input.sessionId)
    },

    pause: (sessionId) => {
      controllers.get(sessionId)?.abort()
      controllers.delete(sessionId)
      const current = get().jobs[sessionId]
      const next = current ? summaryReducer(current, { type: 'pause' }) : null
      if (next) {
        putJob(next)
      }
    },

    resume: async (sessionId) => {
      const current = get().jobs[sessionId]
      if (!current || current.status !== 'paused') {
        return
      }
      const next = summaryReducer(current, { type: 'resume' })
      if (!next) {
        return
      }
      putJob(next)
      if (next.status === 'reading') {
        void readNext(sessionId)
      } else if (next.status === 'reducing') {
        void completeJob(sessionId)
      }
    },

    retry: async (sessionId) => {
      const current = get().jobs[sessionId]
      if (!current || current.status !== 'error') {
        return
      }
      // PDF 解析阶段失败：重新解析本地文件，而不是误走 Reduce
      if (current.chunks.length === 0) {
        if (!current.sourceFile) {
          return
        }
        const next: DocumentJobState = {
          ...current,
          status: 'parsing',
          error: undefined,
          updatedAt: Date.now(),
        }
        putJob(next)
        void parseDocument(sessionId)
        return
      }
      const next = summaryReducer(current, { type: 'retry' })
      if (!next) {
        return
      }
      putJob(next)
      if (next.status === 'reading') {
        void readNext(sessionId)
      } else if (next.status === 'reducing') {
        void completeJob(sessionId)
      }
    },

    retryFailed,

    reset: (sessionId) => {
      controllers.get(sessionId)?.abort()
      controllers.delete(sessionId)
      completing.delete(sessionId)
      loadedSessions.add(sessionId)
      set((state) => ({
        jobs: Object.fromEntries(Object.entries(state.jobs).filter(([id]) => id !== sessionId)),
      }))
      void deleteDocumentJob(sessionId).catch(() => {})
    },

    resetAll: () => {
      for (const controller of controllers.values()) {
        controller.abort()
      }
      controllers.clear()
      completing.clear()
      loadedSessions.clear()
      set({ jobs: {} })
      void clearDocumentJobs().catch(() => {})
    },

    setCompletionHandler: (handler) => {
      completionHandler = handler
      for (const job of Object.values(get().jobs)) {
        if (job.status === 'reducing') {
          void completeJob(job.sessionId)
        }
      }
    },
  }
})
