/**
 * Keeps the composer's usage notice current (`GET /api/organization/usage/notice`).
 *
 * Spend lands in the ledger when the backend flushes its cost tracker, which it
 * does as the answer finishes; nothing pushes that to the browser (the realtime
 * channels are per document and per conversation, not per person). So the
 * notice is re-read at the moments spend or limits can have moved for this
 * person, and at no other:
 *
 *  - when the chat opens, and when it moves to another project;
 *  - a few seconds after a turn of theirs ends, once the final batch is in;
 *  - when the tab comes back after a while, since colleagues spend the office's
 *    budget and admins raise limits in other tabs;
 *  - when the window it names renews, so a spent day clears itself at midnight UTC.
 *
 * Any failure keeps what is shown: the notice is advice, and the socket's own
 * refusal still stops a turn when a budget is really spent.
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatUsageNotice } from '@/lib/budgets/usage-notice'

/** The tracker's final flush follows the answer; this is comfortably after it. */
export const AFTER_TURN_REFRESH_MS = 3_000
/** A returning tab re-reads only when the last read is at least this old. */
export const STALE_AFTER_MS = 60_000
/** `setTimeout` overflows past ~24.8 days; a month window renews further out, so re-check in steps. */
export const MAX_TIMER_MS = 6 * 60 * 60_000

export function useUsageNotice(options: {
  enabled: boolean
  projectId: string | null
  isStreaming: boolean
}): ChatUsageNotice | null {
  const { enabled, projectId, isStreaming } = options
  // Held with the project it was read for, so a switch drops the old
  // project's notice in the render that switches, not one effect later: a
  // notice that stood for one more frame could start leaving under the new
  // project's composer.
  const [held, setHeld] = useState<{ projectId: string | null; notice: ChatUsageNotice | null }>({
    projectId,
    notice: null,
  })
  const notice = held.projectId === projectId ? held.notice : null
  const lastReadAt = useRef(0)
  const generation = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) return
    const mine = ++generation.current
    lastReadAt.current = Date.now()
    try {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
      const res = await fetch(`/api/organization/usage/notice${query}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) return
      const body = (await res.json()) as { notice?: ChatUsageNotice | null }
      // A slower read for the project the chat just left must not win.
      if (mine === generation.current) setHeld({ projectId, notice: body.notice ?? null })
    } catch {
      // Keep what is shown.
    }
  }, [enabled, projectId])

  // Open, and every project switch. The old project's notice goes at once.
  useEffect(() => {
    setHeld({ projectId, notice: null })
    void refresh()
  }, [refresh, projectId])

  // A turn ending: its spend is in the ledger a moment later.
  const wasStreaming = useRef(isStreaming)
  useEffect(() => {
    const ended = wasStreaming.current && !isStreaming
    wasStreaming.current = isStreaming
    if (!ended) return
    const timer = setTimeout(() => void refresh(), AFTER_TURN_REFRESH_MS)
    return () => clearTimeout(timer)
  }, [isStreaming, refresh])

  // Coming back to the tab.
  useEffect(() => {
    if (!enabled) return
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && Date.now() - lastReadAt.current >= STALE_AFTER_MS) void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [enabled, refresh])

  // The named window renewing. A month is further out than one timer reaches,
  // so the timer re-arms itself in steps and reads only once renewal is due:
  // a read in between returns the same `resetsAt` and would not re-run this.
  const resetsAt = notice?.resetsAt
  useEffect(() => {
    if (!resetsAt) return
    const due = Date.parse(resetsAt) + 5_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      const remaining = due - Date.now()
      if (remaining <= 0) {
        void refresh()
        return
      }
      timer = setTimeout(arm, Math.max(1_000, Math.min(remaining, MAX_TIMER_MS)))
    }
    arm()
    return () => clearTimeout(timer)
  }, [resetsAt, refresh])

  return notice
}

const DISMISSED_KEY = 'usage-notice.dismissed'
/** Keys name a window, so old ones are dead weight; a handful is every live one. */
const DISMISSED_KEPT = 20

/** The notice keys this browser dismissed. Private windows and blocked storage read as none. */
export const readDismissedNotices = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

export const rememberDismissedNotice = (key: string): void => {
  try {
    const kept = [...readDismissedNotices().filter((existing) => existing !== key), key].slice(-DISMISSED_KEPT)
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(kept))
  } catch {
    // Dismissed for this page view only.
  }
}
