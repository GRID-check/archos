'use client'

/**
 * One feedback dialog and one „Mein Feedback" sheet for the whole shell,
 * opened from anywhere.
 *
 * The avatar menu, the org header and any later entry point (a command in ⌘K,
 * an error screen's "report this") call {@link useOpenFeedback} or
 * {@link useOpenFeedbackThreads} instead of each mounting its own, so there is
 * one form, one reset, and one place the reporter's email reaches the contact
 * hint. The same shape the product tour uses (`useStartProductTour`).
 *
 * The provider also knows how many of the member's threads have news (the team
 * replied or moved the status), for the dot on the entry points: read once when
 * the shell mounts, again when the window regains focus after
 * {@link UPDATES_REFRESH_MS}, and whenever the sheet reads the list itself.
 */

import type { JSX } from 'react'
import * as React from 'react'
import { fetchOwnFeedback } from '@/lib/product-feedback/client'
import type { ProductFeedbackKind } from '@/lib/product-feedback/types'
import { FeedbackDialog } from './feedback-dialog'
import { FeedbackThreadsSheet } from './feedback-threads'

/** A focus sooner than this after the last read does not read again. */
export const UPDATES_REFRESH_MS = 5 * 60 * 1000

type OpenFeedback = (kind?: ProductFeedbackKind) => void
type OpenFeedbackThreads = (reportId?: string) => void

interface FeedbackContextValue {
  openFeedback: OpenFeedback
  openThreads: OpenFeedbackThreads
  /** Threads with news since the member last looked. */
  updatedCount: number
}

const FeedbackContext = React.createContext<FeedbackContextValue | null>(null)

const noop = (): void => undefined

/** Opens the shell's feedback dialog; a no-op outside the provider. */
export function useOpenFeedback(): OpenFeedback {
  return React.useContext(FeedbackContext)?.openFeedback ?? noop
}

/** Opens „Mein Feedback", on one thread when given; a no-op outside the provider. */
export function useOpenFeedbackThreads(): OpenFeedbackThreads {
  return React.useContext(FeedbackContext)?.openThreads ?? noop
}

/** How many of the member's feedback threads have news; 0 outside the provider. */
export function useFeedbackUpdatedCount(): number {
  return React.useContext(FeedbackContext)?.updatedCount ?? 0
}

/** Whether a feedback dialog is mounted above — entry points hide themselves without one. */
export function useFeedbackAvailable(): boolean {
  return React.useContext(FeedbackContext) !== null
}

function useUpdatedCount(): [number, (count: number) => void] {
  const [count, setCount] = React.useState(0)
  const lastRead = React.useRef(0)

  const remember = React.useCallback((next: number) => {
    lastRead.current = Date.now()
    setCount(next)
  }, [])

  React.useEffect(() => {
    let cancelled = false
    const read = (): void => {
      lastRead.current = Date.now()
      fetchOwnFeedback()
        .then((list) => {
          if (!cancelled) setCount(list.updatedCount)
        })
        // The dot is a hint: a failed read leaves the last answer standing.
        .catch(() => undefined)
    }
    const onFocus = (): void => {
      if (Date.now() - lastRead.current >= UPDATES_REFRESH_MS) read()
    }
    read()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return [count, remember]
}

export function FeedbackProvider({
  userEmail = null,
  children,
}: {
  userEmail?: string | null
  children: React.ReactNode
}): JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [kind, setKind] = React.useState<ProductFeedbackKind>('bug')
  const [threadsOpen, setThreadsOpen] = React.useState(false)
  const [threadId, setThreadId] = React.useState<string | null>(null)
  const [updatedCount, setUpdatedCount] = useUpdatedCount()

  const openFeedback = React.useCallback<OpenFeedback>((next) => {
    setKind(next ?? 'bug')
    setOpen(true)
  }, [])

  const openThreads = React.useCallback<OpenFeedbackThreads>((reportId) => {
    setThreadId(reportId ?? null)
    setThreadsOpen(true)
  }, [])

  const value = React.useMemo(
    () => ({ openFeedback, openThreads, updatedCount }),
    [openFeedback, openThreads, updatedCount]
  )

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <FeedbackDialog
        open={open}
        onOpenChange={setOpen}
        defaultKind={kind}
        userEmail={userEmail}
        onViewThread={(reportId) => {
          setOpen(false)
          openThreads(reportId)
        }}
      />
      <FeedbackThreadsSheet
        open={threadsOpen}
        onOpenChange={setThreadsOpen}
        initialReportId={threadId}
        onUpdatedCount={setUpdatedCount}
        onNewFeedback={() => {
          setThreadsOpen(false)
          openFeedback()
        }}
      />
    </FeedbackContext.Provider>
  )
}
