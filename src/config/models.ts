import type { TranslationKey } from '../i18n/index.js'

/** 官方预设模型；只保留真实可用的模型 ID。 */
export type ModelPreset = {
  id: string
  labelKey: TranslationKey
  descriptionKey: TranslationKey
  contextWindow: number
}

export const PRESET_MODELS = [
  {
    id: 'deepseek-flash',
    labelKey: 'modelDeepseekFlash',
    descriptionKey: 'modelDeepseekFlashDesc',
    contextWindow: 1_000_000,
  },
  {
    id: 'deepseek-v4-pro',
    labelKey: 'modelDeepseekV4Pro',
    descriptionKey: 'modelDeepseekV4ProDesc',
    contextWindow: 1_000_000,
  },
] as const satisfies readonly ModelPreset[]

export const DEFAULT_MODEL_ID = 'deepseek-flash'
/** 超过该 Token 估算值进入长文档分块阅读 */
export const LONG_DOCUMENT_TOKEN_THRESHOLD = 25_000
/** 单个块的目标 Token，给摘要、提示词和图片留出余量 */
export const CHUNK_TARGET_TOKENS = 14_000

export const normalizeModelId = (modelId: string | null | undefined): string =>
  PRESET_MODELS.some((model) => model.id === modelId) ? (modelId as string) : DEFAULT_MODEL_ID

export const getModelPreset = (modelId: string): ModelPreset | undefined =>
  PRESET_MODELS.find((model) => model.id === modelId)

/** 1M / 32K 这类展示文案。 */
export const formatContextWindow = (tokens: number): string =>
  tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1024)}K`
