import { getVisibleMessages } from '../chat/branches.js'
import type { Message, Session } from '../chat/types.js'
import { IMAGE_TOKEN_ESTIMATE, estimateTextTokens } from './tokenEstimate.js'

/** 与服务端硬限制一致的保守上限 */
export const CONTEXT_TOKEN_LIMIT = 32_000
/** 文档最终摘要 + Reduce 指令预留；估算后仍能留出输出余量 */
export const DOCUMENT_SUMMARY_RESERVE = 4_000
/** 历史里已有 document 附件时按整份文档的保守占位估算 */
const DOCUMENT_FILE_RESERVE = 20_000

const messageTokens = (message: Message): number => {
  if (message.role === 'user') {
    const files = message.files.reduce(
      (sum, file) => sum + (file.isImage ? IMAGE_TOKEN_ESTIMATE : DOCUMENT_FILE_RESERVE),
      0
    )
    return (
      estimateTextTokens(message.content) +
      (message.documentContext ? estimateTextTokens(message.documentContext) : 0) +
      files
    )
  }
  if (message.role === 'assistant') {
    if (message.documentNotice) {
      return 0
    }
    const blocks = message.blocks.reduce(
      (sum, block) => (block.type === 'text' ? sum + estimateTextTokens(block.text) : sum),
      0
    )
    const reminder = message.latestReminder ? estimateTextTokens(message.latestReminder) : 0
    return blocks + reminder
  }
  return 0
}

/** 当前可见分支的上下文估算；用于决定文档是否要迁移到新话题。 */
export const estimateSessionContextTokens = (session: Session): number =>
  getVisibleMessages(session).reduce((sum, message) => sum + messageTokens(message), 0)

/** 当前历史 + 原始指令 + 最终摘要预留超过上限时才迁移。 */
export const shouldMigrateDocument = (session: Session, instruction: string): boolean =>
  estimateSessionContextTokens(session) +
    estimateTextTokens(instruction) +
    DOCUMENT_SUMMARY_RESERVE >
  CONTEXT_TOKEN_LIMIT
