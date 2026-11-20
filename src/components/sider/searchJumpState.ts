import { create } from 'zustand'

export type SearchJumpTarget = {
  sessionId: string
  messageId: string
  /** 同一条消息连续点击时也能重新触发定位与高亮 */
  nonce: number
}

type SearchJumpState = {
  target: SearchJumpTarget | null
}

export const useSearchJump = create<SearchJumpState>(() => ({ target: null }))

let sequence = 0

/** 记录待定位的消息；MessageList 在该会话渲染完成后消费。 */
export const jumpToSearchHit = (sessionId: string, messageId: string) => {
  sequence += 1
  useSearchJump.setState({ target: { sessionId, messageId, nonce: sequence } })
}

/** 只清除自己处理过的目标，避免旧渲染清掉用户刚点的新目标。 */
export const clearSearchJump = (nonce: number) => {
  if (useSearchJump.getState().target?.nonce === nonce) {
    useSearchJump.setState({ target: null })
  }
}
