import { getSearchDocuments } from './searchIndex.js'
import type { Message, SessionSummary } from './types.js'

/** 单个关键词高亮片段；start 是片段内的字符偏移，同时用作 React key。 */
export type SearchSegment = {
  start: number
  text: string
  match: boolean
}

export type SearchHit = {
  /** 会话 id + 消息 id，同一条消息只会出现一次 */
  id: string
  sessionId: string
  sessionTitle: string
  messageId: string
  role: Message['role']
  /** 命中位置前后各 40 字左右的纯文本摘要，供列表展示 */
  snippet: string
  /** 摘要按关键词切分后的片段，用于安全渲染高亮 */
  segments: SearchSegment[]
  createdAt: number
}

export type SearchResult = {
  query: string
  tokens: string[]
  /** 按消息创建时间倒序，不按会话分组 */
  hits: SearchHit[]
  /** 命中总数（可能大于 hits.length） */
  total: number
  truncated: boolean
}

export type SearchOptions = {
  limit?: number
  /** 从第几条命中开始取；用于搜索结果分页加载 */
  offset?: number
  signal?: AbortSignal
}

/** 单次最多展示的结果数，避免长列表在移动端一次性渲染过多节点 */
const DEFAULT_LIMIT = 60
/** 摘要保留命中词前后的字符数 */
const SNIPPET_CONTEXT = 40
/** 单个摘要里最多标出的关键词次数 */
const MAX_HIGHLIGHTS = 30

const EMPTY: SearchResult = { query: '', tokens: [], hits: [], total: 0, truncated: false }

/** 按空白切分查询词；中文没有空格，整个短语就是一个关键词。最多 8 个词，避免过深遍历。 */
export const tokenizeQuery = (query: string): string[] => {
  const tokens = new Set<string>()
  for (const token of query.trim().toLowerCase().split(/\s+/)) {
    if (!token) {
      continue
    }
    if (tokens.size >= 8) {
      break
    }
    tokens.add(token)
  }
  return [...tokens]
}

/** 取所有关键词中最靠前的位置，摘要围绕它截取；同时返回该关键词长度。 */
const findFirstMatch = (
  text: string,
  tokens: string[]
): { index: number; length: number } => {
  let index = -1
  let length = 0
  for (const token of tokens) {
    const found = text.indexOf(token)
    if (found !== -1 && (index === -1 || found < index)) {
      index = found
      length = token.length
    }
  }
  return { index, length }
}

const buildSegments = (display: string, tokens: string[]): SearchSegment[] => {
  const lower = display.toLowerCase()
  // 少数语言转小写会改变长度，此时偏移不可靠，只展示原文不高亮。
  if (lower.length !== display.length) {
    return display ? [{ start: 0, text: display, match: false }] : []
  }
  const ranges: { start: number; end: number }[] = []
  for (const token of tokens) {
    let from = 0
    while (ranges.length < MAX_HIGHLIGHTS) {
      const index = lower.indexOf(token, from)
      if (index === -1) {
        break
      }
      ranges.push({ start: index, end: index + token.length })
      from = index + token.length
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: { start: number; end: number }[] = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  const segments: SearchSegment[] = []
  let cursor = 0
  for (const range of merged) {
    if (range.start > cursor) {
      segments.push({ start: cursor, text: display.slice(cursor, range.start), match: false })
    }
    segments.push({ start: range.start, text: display.slice(range.start, range.end), match: true })
    cursor = range.end
  }
  if (cursor < display.length) {
    segments.push({ start: cursor, text: display.slice(cursor), match: false })
  }
  return segments
}

/** 压缩空白后围绕首个命中词截取前后各 40 字；高亮偏移与展示文本保持一致。 */
const createSnippet = (
  text: string,
  tokens: string[]
): Pick<SearchHit, 'snippet' | 'segments'> => {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  const { index, length } = findFirstMatch(lower, tokens)
  const start = index <= 0 ? 0 : Math.max(0, index - SNIPPET_CONTEXT)
  const end =
    index < 0
      ? Math.min(flat.length, SNIPPET_CONTEXT * 2)
      : Math.min(flat.length, index + length + SNIPPET_CONTEXT)
  const core = flat.slice(start, end)
  const display = `${start > 0 ? '…' : ''}${core}${end < flat.length ? '…' : ''}`
  return { snippet: display, segments: buildSegments(display, tokens) }
}

const matchesAll = (text: string, tokens: string[]): boolean => {
  for (const token of tokens) {
    if (!text.includes(token)) {
      return false
    }
  }
  return true
}

type SortableHit = { createdAt: number; sessionId: string; messageId: string }

/** 严格按消息时间倒序；同一时间用 id 兜底，保证结果顺序稳定。 */
const compareNewestFirst = (a: SortableHit, b: SortableHit) =>
  b.createdAt - a.createdAt ||
  a.sessionId.localeCompare(b.sessionId) ||
  a.messageId.localeCompare(b.messageId)

/**
 * 搜索全部会话，返回按消息创建时间倒序平铺的结果。
 * 多个关键词按 AND 匹配；英文不区分大小写；中文按子串匹配。
 * 读取与缓存由 searchIndex 负责，这里只做内存中的匹配和摘要生成。
 */
export const searchHistory = async (
  query: string,
  sessions: SessionSummary[],
  options: SearchOptions = {}
): Promise<SearchResult> => {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) {
    return { ...EMPTY, query }
  }
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT)
  const offset = Math.max(0, options.offset ?? 0)
  const documents = await getSearchDocuments(sessions, options.signal)
  if (options.signal?.aborted) {
    throw new DOMException('Search aborted', 'AbortError')
  }
  documents.sort(compareNewestFirst)

  const hits: SearchHit[] = []
  let total = 0
  for (const document of documents) {
    if (options.signal?.aborted) {
      throw new DOMException('Search aborted', 'AbortError')
    }
    if (!matchesAll(document.text.toLowerCase(), tokens)) {
      continue
    }
    if (total >= offset && hits.length < limit) {
      const { snippet, segments } = createSnippet(document.text, tokens)
      hits.push({
        id: document.id,
        sessionId: document.sessionId,
        sessionTitle: document.sessionTitle,
        messageId: document.messageId,
        role: document.role,
        snippet,
        segments,
        createdAt: document.createdAt,
      })
    }
    total += 1
  }

  return {
    query,
    tokens,
    hits,
    total,
    // 取完这一页后是否还有更早的结果
    truncated: total > offset + hits.length,
  }
}
