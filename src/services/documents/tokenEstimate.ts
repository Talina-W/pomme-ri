/** 粗略 token 估算：CJK 字符按 1，其他字符按 1/4。 */
export const estimateTextTokens = (text: string): number => {
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

/** 页面截图按一张图约 1500 token 预留，避免 chunk 文本 + 图片超过 20K。 */
export const IMAGE_TOKEN_ESTIMATE = 1_500
