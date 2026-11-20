import { useEffect, useRef, useState } from 'react'

/** 两次更新的最长间隔 */
const MAX_WAIT = 2000
/** 上次渲染耗时的倍数，过了这段时间才允许下次更新 */
const TIME_CONSUMING_RATE = 2
/** 流式正文最短更新间隔，约 30ms；避免每帧都重新解析 Markdown */
const MIN_INTERVAL = 30

/**
 * 流式过程中按渲染耗时节流 Markdown 内容的更新：
 * 更新输出时记录开始时间，提交后按耗时 × TIME_CONSUMING_RATE（不超过 MAX_WAIT）
 * 算出下次允许更新的时间点；新内容在到期时更新，连续输入合并为最新内容。
 * 关闭节流时直接返回最新内容。
 */
export const useThrottleMarkdownRender = (content: string, enable: boolean) => {
  // 首次渲染从挂载时开始计时
  const startRef = useRef(performance.now())
  const updatableAtRef = useRef(0)
  const lastUpdateAtRef = useRef(performance.now())
  const [output, setOutput] = useState(content)

  useEffect(() => {
    const now = performance.now()
    updatableAtRef.current =
      now + Math.min(MAX_WAIT, (now - startRef.current) * TIME_CONSUMING_RATE)
  }, [output])

  useEffect(() => {
    if (!enable) {
      return
    }
    const update = () => {
      startRef.current = performance.now()
      lastUpdateAtRef.current = startRef.current
      setOutput(content)
    }
    const now = performance.now()
    // 渲染耗时 × 2 与 30ms 上限取较大值；渲染很快时也不会每帧更新。
    const delay = Math.max(
      updatableAtRef.current - now,
      lastUpdateAtRef.current + MIN_INTERVAL - now
    )
    if (delay <= 0) {
      update()
      return
    }
    const timer = setTimeout(update, delay)
    return () => clearTimeout(timer)
  }, [content, enable])

  return enable ? output : content
}
