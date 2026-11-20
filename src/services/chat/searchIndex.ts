import { getVisibleMessages } from './branches.js'
import { loadSession } from './db.js'
import { useChatStore } from './store.js'
import type { Message, Session, SessionSummary } from './types.js'

/** 轻量检索文档：只保留命中判断和展示需要的字段，不带 blocks、附件或 Blob。 */
export type SearchDocument = {
  id: string
  sessionId: string
  sessionTitle: string
  messageId: string
  role: Message['role']
  createdAt: number
  text: string
}

type CachedSession = {
  updatedAt: number
  title: string
  documents: SearchDocument[]
}

/** 按会话缓存文本索引；内容没变的会话在本次页面生命周期内不会被重复读取。 */
const sessionIndex = new Map<string, CachedSession>()

/** 展示给用户的消息正文：用户提问 + 助手正文块；模板提示与思考块不参与检索。 */
const messageText = (message: Message): string => {
  if (message.role === 'user') {
    return message.content
  }
  const parts: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'text' && !block.isTemplate && block.text.trim() !== '') {
      parts.push(block.text)
    }
  }
  return parts.join('\n\n')
}

const indexSession = (session: Session, sessionTitle: string): SearchDocument[] => {
  const documents: SearchDocument[] = []
  for (const message of getVisibleMessages(session)) {
    const text = messageText(message)
    if (!text.trim()) {
      continue
    }
    documents.push({
      id: `${session.id}:${message.id}`,
      sessionId: session.id,
      sessionTitle,
      messageId: message.id,
      role: message.role,
      createdAt: message.createdAt,
      text,
    })
  }
  return documents
}

/**
 * 从 IndexedDB 建立/复用轻量文本索引：
 * - 列表只用 sessionSummaries（小记录），不为了搜索读取全部会话；
 * - 每个会话用 loadSession 单独读取，且只有 updatedAt 或标题变化时才重读；
 * - 已经打开在 store 里的会话直接使用内存中的最新副本，流式回答不依赖落库时机；
 * - 读到一条就缓存一条，用户中途改关键词时，下次搜索能复用已完成的部分；
 * - 已删除的会话会从缓存里清理。
 */
export const getSearchDocuments = async (
  sessions: SessionSummary[],
  signal?: AbortSignal
): Promise<SearchDocument[]> => {
  const liveSessions = useChatStore.getState().sessionCache
  const seen = new Set<string>()
  const documents: SearchDocument[] = []

  for (const summary of sessions) {
    if (signal?.aborted) {
      throw new DOMException('Search aborted', 'AbortError')
    }
    seen.add(summary.id)
    const live = Object.hasOwn(liveSessions, summary.id) ? liveSessions[summary.id] : undefined
    if (live) {
      // 流式内容、切换消息版本都不一定更新 updatedAt，内存副本才是最新状态。
      documents.push(...indexSession(live, summary.title))
      continue
    }

    let indexed = sessionIndex.get(summary.id)
    if (!indexed || indexed.updatedAt !== summary.updatedAt || indexed.title !== summary.title) {
      // 逐条 get，而不是 getAll：避免一次性把所有会话和附件读进内存造成卡顿。
      const stored = await loadSession(summary.id)
      if (signal?.aborted) {
        throw new DOMException('Search aborted', 'AbortError')
      }
      if (!stored) {
        sessionIndex.delete(summary.id)
        continue
      }
      indexed = {
        updatedAt: summary.updatedAt,
        title: summary.title,
        documents: indexSession(stored, summary.title),
      }
      sessionIndex.set(summary.id, indexed)
    }
    documents.push(...indexed.documents)
  }

  for (const id of sessionIndex.keys()) {
    if (!seen.has(id)) {
      sessionIndex.delete(id)
    }
  }
  return documents
}
