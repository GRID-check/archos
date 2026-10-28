/**
 * Whether this page can use the network now, and the moment it can again.
 *
 * A phone that locks, or a reader who switches to the camera, freezes the page:
 * iOS kills its sockets and runs none of its timers until it comes back, and
 * then fires every timer that fell due at once. A tab restored from the
 * back/forward cache (`pageshow` with `persisted`) had its sockets closed on the
 * way in. And a phone on site loses the network outright, which the browser
 * says (`offline`) well before any socket notices.
 *
 * Code that reconnects reads {@link PageLifecycle.active} before it spends an
 * attempt, and is told {@link PageLifecycleListener.resume} the moment the page
 * is back, so it reconnects at once instead of waiting out a rung it scheduled
 * before the freeze. A server caller (the BFF's wake job) has no page and gets
 * {@link ALWAYS_ACTIVE}.
 */

/** What brought the page back. */
export type ResumeCause = 'visible' | 'online' | 'pageshow'

export interface PageLifecycleListener {
  /** The page is visible and online again (or was restored from the back/forward cache). */
  resume: (cause: ResumeCause) => void
  /** The page went hidden or offline: no attempt it makes now can be seen through. */
  suspend?: () => void
}

export interface PageLifecycle {
  /** Visible, and not known to be offline. */
  readonly visible: boolean
  readonly online: boolean
  /** Starts listening; returns the stop. */
  subscribe: (listener: PageLifecycleListener) => () => void
}

/** A page that is always there: a server, or a test that does not care. */
export const ALWAYS_ACTIVE: PageLifecycle = {
  visible: true,
  online: true,
  subscribe: () => () => undefined,
}

/** The globals this reads, injectable so a test can drive them. */
export interface PageLifecycleGlobals {
  document: EventTarget & { readonly visibilityState: DocumentVisibilityState }
  window: EventTarget
  navigator: { readonly onLine: boolean }
}

const browserGlobals = (): PageLifecycleGlobals | null =>
  typeof document === 'undefined' ||
  typeof window === 'undefined' ||
  typeof navigator === 'undefined'
    ? null
    : { document, window, navigator }

/**
 * The browser's page, read live. `navigator.onLine === false` is taken at its
 * word: every engine reports it only when there is no network interface up,
 * while `true` proves nothing, so only `true` is ever second-guessed (by the
 * attempt itself).
 */
export function browserPageLifecycle(
  globals: PageLifecycleGlobals | null = browserGlobals()
): PageLifecycle {
  if (!globals) return ALWAYS_ACTIVE
  const { document: doc, window: win, navigator: nav } = globals
  return {
    get visible() {
      return doc.visibilityState !== 'hidden'
    },
    get online() {
      return nav.onLine !== false
    },
    subscribe(listener) {
      const active = () => doc.visibilityState !== 'hidden' && nav.onLine !== false
      const onVisibility = () => {
        if (doc.visibilityState === 'hidden') listener.suspend?.()
        else if (active()) listener.resume('visible')
      }
      const onOnline = () => {
        if (active()) listener.resume('online')
      }
      const onOffline = () => listener.suspend?.()
      // `pageshow` fires on every show; only a restore from the back/forward
      // cache comes back with its sockets closed under it.
      const onPageShow = (event: Event) => {
        if ((event as PageTransitionEvent).persisted && active()) listener.resume('pageshow')
      }
      const onPageHide = () => listener.suspend?.()
      doc.addEventListener('visibilitychange', onVisibility)
      win.addEventListener('online', onOnline)
      win.addEventListener('offline', onOffline)
      win.addEventListener('pageshow', onPageShow)
      win.addEventListener('pagehide', onPageHide)
      return () => {
        doc.removeEventListener('visibilitychange', onVisibility)
        win.removeEventListener('online', onOnline)
        win.removeEventListener('offline', onOffline)
        win.removeEventListener('pageshow', onPageShow)
        win.removeEventListener('pagehide', onPageHide)
      }
    },
  }
}

/** Visible and online: an attempt made now can succeed. */
export const isActive = (lifecycle: PageLifecycle): boolean => lifecycle.visible && lifecycle.online

/**
 * A page frozen under a timer fires it late, all at once, on its return. A
 * timer that fires more than this past its due time slept through a freeze,
 * and what it measured (silence, an unanswered question) was the freeze, not
 * the server. Generous on purpose: a busy main thread delays a timer by
 * hundreds of milliseconds, never by seconds.
 */
export const FROZEN_SLACK_MS = 5_000

/** Whether a timer armed at `armedAt` for `ms` fired late enough to have slept through a freeze. */
export const sleptThrough = (armedAt: number, ms: number, now: number = Date.now()): boolean =>
  now - armedAt > ms + FROZEN_SLACK_MS
