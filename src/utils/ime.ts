import { useCallback, useEffect, useRef } from 'react'

type ImeKeyboardEvent = { nativeEvent: KeyboardEvent }

/**
 * 输入法组词状态判断。
 * 部分浏览器在确认候选词的 Enter keydown 里 isComposing 已经变成 false，
 * 只留下兼容属性 keyCode/which = 229，因此不能只信 isComposing。
 */
export const isImeComposing = (event: ImeKeyboardEvent): boolean => {
  const native = event.nativeEvent
  return native.isComposing || native.keyCode === 229 || native.which === 229
}

export type ImeCompositionGuard = {
  onCompositionStart: () => void
  onCompositionEnd: () => void
  onBlur: () => void
  isComposing: (event: ImeKeyboardEvent) => boolean
}

/**
 * 跟踪 compositionstart/end。
 * compositionend 可能先于确认候选词的 Enter keydown 发生；延迟一轮再解除，
 * 避免同一个 Enter 既确认候选词又触发发送。下一次单独的 Enter 仍然正常发送。
 */
export const useImeCompositionGuard = (): ImeCompositionGuard => {
  const composingRef = useRef(false)
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const clearTimer = useCallback(() => {
    clearTimeout(endTimerRef.current)
    endTimerRef.current = undefined
  }, [])

  useEffect(() => clearTimer, [clearTimer])

  const onCompositionStart = useCallback(() => {
    clearTimer()
    composingRef.current = true
  }, [clearTimer])

  const onCompositionEnd = useCallback(() => {
    clearTimer()
    endTimerRef.current = setTimeout(() => {
      composingRef.current = false
      endTimerRef.current = undefined
    }, 0)
  }, [clearTimer])

  const reset = useCallback(() => {
    clearTimer()
    composingRef.current = false
  }, [clearTimer])

  const isComposing = useCallback(
    (event: ImeKeyboardEvent) => composingRef.current || isImeComposing(event),
    []
  )

  return {
    onCompositionStart,
    onCompositionEnd,
    onBlur: reset,
    isComposing,
  }
}
