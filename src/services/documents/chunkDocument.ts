import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api.js'
import { CHUNK_TARGET_TOKENS } from '../../config/models.js'
import { estimateTextTokens, IMAGE_TOKEN_ESTIMATE } from './tokenEstimate.js'

export type DocumentChunkImage = {
  id: string
  pageNumber: number
  blob: Blob
}

export type DocumentChunk = {
  id: string
  text: string
  /** 文本 + 图片预留后的估算值 */
  tokens: number
  images: DocumentChunkImage[]
  pageStart: number
  pageEnd: number
}

export type ExtractedDocument = {
  fileName: string
  totalTokens: number
  imageCount: number
  chunks: DocumentChunk[]
}

export class DocumentParseError extends Error {
  constructor(readonly reason: 'unsupported' | 'no_text') {
    super(reason)
    this.name = 'DocumentParseError'
  }
}

type PageData = {
  pageNumber: number
  text: string
  image?: Blob
}

const MAX_IMAGES_PER_CHUNK = 2
const getExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

let pdfWorkerReady = false

const renderPageImage = async (page: PDFPageProxy): Promise<Blob | null> => {
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(1.4, 1100 / base.width)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }
  await page.render({ canvasContext: context, viewport }).promise
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.72)
  })
}

const extractPdfPages = async (file: File): Promise<PageData[]> => {
  // legacy 构建自带旧浏览器 polyfill，Safari 16 可用
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (!pdfWorkerReady) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', document.baseURI).toString()
    pdfWorkerReady = true
  }
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
  try {
    const pages: PageData[] = []
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
      let image: Blob | null = null
      try {
        const operators = await page.getOperatorList()
        const hasImages = operators.fnArray.some(
          (fn) =>
            fn === pdfjs.OPS.paintImageXObject ||
            fn === pdfjs.OPS.paintInlineImageXObject ||
            fn === pdfjs.OPS.paintImageMaskXObject
        )
        if (hasImages) {
          image = await renderPageImage(page)
        }
      } catch {
        // 图片/画布提取失败时只发文字块，不阻断整份文档阅读
      }
      pages.push({ pageNumber, text, image: image ?? undefined })
      page.cleanup()
    }
    return pages
  } finally {
    await doc.destroy()
  }
}

/** 按段落切分；单个段落超长时退化为按句子/字符切分。 */
const splitText = (
  text: string,
  maxTokens = CHUNK_TARGET_TOKENS
): { text: string; tokens: number }[] => {
  const normalized = text.trim()
  if (!normalized) {
    return []
  }
  if (estimateTextTokens(normalized) <= maxTokens) {
    return [{ text: normalized, tokens: estimateTextTokens(normalized) }]
  }
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
  const result: { text: string; tokens: number }[] = []
  let current = ''
  let currentTokens = 0
  const flush = () => {
    if (current.trim()) {
      result.push({ text: current.trim(), tokens: currentTokens })
    }
    current = ''
    currentTokens = 0
  }
  for (const paragraph of paragraphs.length > 0 ? paragraphs : [normalized]) {
    const tokens = estimateTextTokens(paragraph)
    if (tokens > maxTokens) {
      flush()
      const sentences = paragraph.match(/[^。！？.!?\n]+[。！？.!?]?/g) ?? [paragraph]
      for (const sentence of sentences) {
        const sentenceTokens = estimateTextTokens(sentence)
        if (sentenceTokens > maxTokens) {
          // 极端长句：按字符比例硬切，保证不会超过单块预算
          const ratio = maxTokens / sentenceTokens
          const size = Math.max(1, Math.floor(sentence.length * ratio * 0.9))
          for (let start = 0; start < sentence.length; start += size) {
            const piece = sentence.slice(start, start + size)
            const pieceTokens = estimateTextTokens(piece)
            if (currentTokens + pieceTokens > maxTokens) {
              flush()
            }
            current += piece
            currentTokens += pieceTokens
          }
        } else {
          if (currentTokens + sentenceTokens > maxTokens) {
            flush()
          }
          current += sentence
          currentTokens += sentenceTokens
        }
      }
      continue
    }
    if (currentTokens + tokens > maxTokens) {
      flush()
    }
    current += `${current ? '\n\n' : ''}${paragraph}`
    currentTokens += tokens
  }
  flush()
  return result
}

const buildChunks = (pages: PageData[]): DocumentChunk[] => {
  const chunks: DocumentChunk[] = []
  let currentText = ''
  let currentTokens = 0
  let currentImages: DocumentChunkImage[] = []
  let startPage = pages[0]?.pageNumber ?? 1
  let endPage = startPage

  const currentBudget = () => currentTokens + currentImages.length * IMAGE_TOKEN_ESTIMATE

  const flush = () => {
    if (!currentText.trim() && currentImages.length === 0) {
      return
    }
    const text = currentText.trim()
    const tokens = estimateTextTokens(text) + currentImages.length * IMAGE_TOKEN_ESTIMATE
    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      text,
      tokens,
      images: currentImages,
      pageStart: startPage,
      pageEnd: endPage,
    })
    currentText = ''
    currentTokens = 0
    currentImages = []
    startPage = endPage
  }

  for (const page of pages) {
    endPage = page.pageNumber
    const pageImages: DocumentChunkImage[] = page.image
      ? [{ id: `page-${page.pageNumber}`, pageNumber: page.pageNumber, blob: page.image }]
      : []
    const pageParts = splitText(page.text)
    // 纯扫描页没有文字层，仍然把页面图片作为一个块送进模型
    const parts =
      pageParts.length > 0
        ? pageParts
        : page.image
          ? [{ text: '（本页没有可提取的文字，请阅读图片内容。）', tokens: 0 }]
          : []
    for (const [index, part] of parts.entries()) {
      const addImages = index === 0 ? pageImages : []
      if (
        currentText.trim() &&
        (currentBudget() + part.tokens + addImages.length * IMAGE_TOKEN_ESTIMATE >
          CHUNK_TARGET_TOKENS ||
          currentImages.length + addImages.length > MAX_IMAGES_PER_CHUNK)
      ) {
        flush()
        startPage = page.pageNumber
      }
      if (!currentText.trim()) {
        startPage = page.pageNumber
      }
      currentText += `${currentText ? '\n\n' : ''}${part.text}`
      currentTokens += part.tokens
      currentImages.push(...addImages)
      endPage = page.pageNumber
    }
  }
  flush()
  return chunks
}

const isPdf = (file: File) => getExt(file.name) === 'pdf' || file.type === 'application/pdf'

/**
 * 仅解析 PDF 并按页面/段落切块。
 * PDF 页面含图片时会渲染整页 JPEG，后续随对应块一起发送。
 */
export const extractDocument = async (file: File): Promise<ExtractedDocument> => {
  // 前端 Map-Reduce 只处理 PDF；Word/Excel/图片等全部走官方 Files API。
  if (!isPdf(file)) {
    throw new DocumentParseError('unsupported')
  }
  const pages = await extractPdfPages(file)
  const hasContent = pages.some((page) => page.text.trim() || page.image)
  if (!hasContent) {
    throw new DocumentParseError('no_text')
  }
  const chunks = buildChunks(pages)
  if (chunks.length === 0) {
    throw new DocumentParseError('no_text')
  }
  return {
    fileName: file.name,
    totalTokens: chunks.reduce((sum, chunk) => sum + chunk.tokens, 0),
    imageCount: chunks.reduce((count, chunk) => count + chunk.images.length, 0),
    chunks,
  }
}
