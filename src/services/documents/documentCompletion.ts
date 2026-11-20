import { answerDocumentInstruction } from '../chat/store.js'
import { useDocumentJob } from './documentJob.js'

/** 应用启动时注册；让文档任务在完成后自动追加最终 Assistant 回答。 */
useDocumentJob
  .getState()
  .setCompletionHandler((job) =>
    answerDocumentInstruction(
      job.sessionId,
      job.messageId,
      job.instruction,
      job.rollingSummary,
      job.failedChunks
    )
  )
