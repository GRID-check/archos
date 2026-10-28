import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { useReducedMotion } from '@/hooks/use-reduced-motion'

/** How far short of its end a scrolled list still counts as at it: a nudge is not leaving. */
export const END_SLACK_PX = 24

/** Whether a scroll area shows its end. */
export const atEnd = (node: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>, slack = END_SLACK_PX): boolean =>
  node.scrollHeight - node.scrollTop - node.clientHeight <= slack

/**
 * A thread that keeps its newest line in view: when `content` changes (a
 * reply, Piloti's work line, its answer), the scroll area at `ref` goes to its
 * end if the reader was there, or has just sent something into it (`follow`).
 * A reader who scrolled up to read is left where they are until they come back
 * down. Only the reader's own scroll up lets go: going to the end is downward,
 * so its own scroll events never do. Reduced motion jumps instead of gliding.
 */
export function useFollowEnd<T extends HTMLElement>(
  content: unknown
): { ref: RefObject<T | null>; onScroll: () => void; follow: () => void } {
  const ref = useRef<T | null>(null)
  const following = useRef<boolean | null>(null)
  const lastTop = useRef(0)
  const reduced = useReducedMotion()

  const onScroll = useCallback(() => {
    const node = ref.current
    if (!node) return
    if (atEnd(node)) following.current = true
    else if (node.scrollTop < lastTop.current - 1) following.current = false
    lastTop.current = node.scrollTop
  }, [])

  const follow = useCallback(() => {
    following.current = true
  }, [])

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    // The first render says where the reader starts: at the end when it all fits.
    if (following.current === null) {
      following.current = atEnd(node)
      lastTop.current = node.scrollTop
      return
    }
    if (!following.current || atEnd(node, 1)) return
    const top = node.scrollHeight - node.clientHeight
    if (typeof node.scrollTo === 'function') node.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' })
    else node.scrollTop = top
  }, [content, reduced])

  // The area itself got shorter (its card keeps inside the stage): the end stays in view for a reader at it.
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (following.current && !atEnd(node, 1)) node.scrollTop = node.scrollHeight - node.clientHeight
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return { ref, onScroll, follow }
}
