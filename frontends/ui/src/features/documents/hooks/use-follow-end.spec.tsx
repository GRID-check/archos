/**
 * A thread keeps its newest line in view: after „@Piloti …" the work line
 * and then the answer landed below the fold of the thread's scroll area, and
 * the reader had to find them. A reader at the end, or one who just sent
 * something, is taken to the new line; one who scrolled up to read is not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test-utils'
import { atEnd, useFollowEnd } from './use-follow-end'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('@/hooks/use-reduced-motion', () => ({ useReducedMotion: () => motion.reduced }))

/** The scroll area's geometry, which happy-dom does not lay out. */
const box = { scrollHeight: 300, clientHeight: 300, scrollTop: 0 }
const scrollTo = vi.fn()
const saved = new Map<string, PropertyDescriptor | undefined>()

beforeEach(() => {
  Object.assign(box, { scrollHeight: 300, clientHeight: 300, scrollTop: 0 })
  motion.reduced = false
  scrollTo.mockReset()
  for (const key of ['scrollHeight', 'clientHeight', 'scrollTop', 'scrollTo'] as const) {
    saved.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key))
  }
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => box.scrollHeight })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => box.clientHeight })
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get: () => box.scrollTop,
    set: (value: number) => {
      box.scrollTop = value
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })
})

afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, key)
  }
})

let sent: () => void = () => {}

function Thread({ lines }: { lines: number }) {
  const { ref, onScroll, follow } = useFollowEnd<HTMLDivElement>(lines)
  sent = follow
  return <div ref={ref} onScroll={onScroll} data-testid="thread" />
}

/** A reader scrolls to `top`, by hand. */
const scrollBy = (top: number) => {
  box.scrollTop = top
  fireEvent.scroll(screen.getByTestId('thread'))
}

describe('useFollowEnd', () => {
  it('brings a new line into view for a reader at the end', () => {
    const { rerender } = render(<Thread lines={2} />)
    box.scrollHeight = 420
    rerender(<Thread lines={3} />)
    expect(scrollTo).toHaveBeenCalledWith({ top: 120, behavior: 'smooth' })
  })

  it('jumps instead of gliding under reduced motion', () => {
    motion.reduced = true
    const { rerender } = render(<Thread lines={2} />)
    box.scrollHeight = 420
    rerender(<Thread lines={3} />)
    expect(scrollTo).toHaveBeenCalledWith({ top: 120, behavior: 'auto' })
  })

  it('leaves a reader who opened a long thread at its top where they are', () => {
    box.scrollHeight = 600
    const { rerender } = render(<Thread lines={6} />)
    box.scrollHeight = 720
    rerender(<Thread lines={7} />)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('leaves a reader who scrolled up to read where they are, and follows again once they are back down', () => {
    box.scrollHeight = 600
    const { rerender } = render(<Thread lines={6} />)
    scrollBy(300)
    scrollBy(120)
    box.scrollHeight = 720
    rerender(<Thread lines={7} />)
    expect(scrollTo).not.toHaveBeenCalled()
    scrollBy(420)
    box.scrollHeight = 840
    rerender(<Thread lines={8} />)
    expect(scrollTo).toHaveBeenCalledWith({ top: 540, behavior: 'smooth' })
  })

  it('takes a reader who just sent into the thread to what follows', () => {
    box.scrollHeight = 600
    const { rerender } = render(<Thread lines={6} />)
    sent()
    box.scrollHeight = 720
    rerender(<Thread lines={7} />)
    expect(scrollTo).toHaveBeenCalledWith({ top: 420, behavior: 'smooth' })
  })
})

describe('atEnd', () => {
  it('counts a nudge short of the end as at it', () => {
    expect(atEnd({ scrollHeight: 600, clientHeight: 300, scrollTop: 290 })).toBe(true)
    expect(atEnd({ scrollHeight: 600, clientHeight: 300, scrollTop: 200 })).toBe(false)
  })
})
