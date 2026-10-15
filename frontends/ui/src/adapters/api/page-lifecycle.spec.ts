/**
 * @vitest-environment node
 */
/**
 * The page as a reconnect reads it: hidden or offline is away, and visible,
 * online again or restored from the back/forward cache is a resume.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ALWAYS_ACTIVE,
  FROZEN_SLACK_MS,
  browserPageLifecycle,
  isActive,
  sleptThrough,
} from './page-lifecycle'

const fakeGlobals = () => {
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  })
  const win = new EventTarget()
  const nav = { onLine: true }
  return { doc, win, nav, globals: { document: doc, window: win, navigator: nav } }
}

const pageshow = (persisted: boolean) => Object.assign(new Event('pageshow'), { persisted })

describe('browserPageLifecycle', () => {
  it('reads visibility and the network live', () => {
    const { doc, nav, globals } = fakeGlobals()
    const page = browserPageLifecycle(globals)
    expect(isActive(page)).toBe(true)
    doc.visibilityState = 'hidden'
    expect(page.visible).toBe(false)
    doc.visibilityState = 'visible'
    nav.onLine = false
    expect(page.online).toBe(false)
    expect(isActive(page)).toBe(false)
  })

  it('suspends on hide and offline, and resumes only once both visible and online', () => {
    const { doc, win, nav, globals } = fakeGlobals()
    const resume = vi.fn()
    const suspend = vi.fn()
    browserPageLifecycle(globals).subscribe({ resume, suspend })

    nav.onLine = false
    win.dispatchEvent(new Event('offline'))
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(suspend).toHaveBeenCalledTimes(2)

    // Visible, still offline: nothing to resume yet.
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(resume).not.toHaveBeenCalled()

    nav.onLine = true
    win.dispatchEvent(new Event('online'))
    expect(resume).toHaveBeenCalledExactlyOnceWith('online')
  })

  it('resumes a page restored from the back/forward cache, not every show', () => {
    const { win, globals } = fakeGlobals()
    const resume = vi.fn()
    browserPageLifecycle(globals).subscribe({ resume })
    win.dispatchEvent(pageshow(false))
    expect(resume).not.toHaveBeenCalled()
    win.dispatchEvent(pageshow(true))
    expect(resume).toHaveBeenCalledExactlyOnceWith('pageshow')
  })

  it('stops listening when unsubscribed', () => {
    const { doc, globals } = fakeGlobals()
    const resume = vi.fn()
    const stop = browserPageLifecycle(globals).subscribe({ resume })
    stop()
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(resume).not.toHaveBeenCalled()
  })

  it('is always there without a page, as on the server', () => {
    expect(browserPageLifecycle(null)).toBe(ALWAYS_ACTIVE)
  })
})

describe('sleptThrough', () => {
  it('tells a timer that fired a freeze late from one a busy thread delayed', () => {
    expect(sleptThrough(0, 15_000, 15_000 + FROZEN_SLACK_MS)).toBe(false)
    expect(sleptThrough(0, 15_000, 15_000 + FROZEN_SLACK_MS + 1)).toBe(true)
  })
})
