'use client'

/**
 * One „Mein Feedback" modal for the whole shell, opened from anywhere: on the
 * form for a new report ({@link useOpenFeedback}, „Feedback senden") or on the
 * list or one thread ({@link useOpenFeedbackThreads}, „Mein Feedback", the
 * `?feedback=<id>` link). There is no standalone feedback dialog any more: the
 * form is a pane of the modal, so a report just sent opens its own thread.
 *
 * The avatar menu, the org header, the phone's „Mehr" sheet and any later
 * entry point (a command in ⌘K, an error screen's "report this") call these
 * hooks instead of each mounting its own, so there is one form, one reset, and
 * one place the reporter's email reaches the contact hint. The same shape the
 * product tour uses (`useStartProductTour`).
 *
 * The provider also knows how many of the member's threads have news (the team
 * replied or moved the status), for the dot on the entry points: read once when
 * the shell mounts, again when the window regains focus after
 * {@link UPDATES_REFRESH_MS}, and whenever the modal reads the list itself.
 */

import type { JSX } from 'react'
import * as React from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { fetchOwnFeedback } from '@/lib/product-feedback/client'
import { FEEDBACK_THREAD_PARAM, type OwnProductFeedbackListResponse, type ProductFeedbackKind } from '@/lib/product-feedback/types'
import { FeedbackThreadsDialog, type FeedbackThreadsApi } from './feedback-threads'

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

/** Opens „Mein Feedback" on the form for a new report; a no-op outside the provider. */
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

/** Whether the feedback modal is mounted above — entry points hide themselves without one. */
export function useFeedbackAvailable(): boolean {
  return React.useContext(FeedbackContext) !== null
}

/**
 * The count of threads with news, and a way to read it again now. Read when
 * the shell mounts, on focus after {@link UPDATES_REFRESH_MS}, whenever the
 * modal reads the list itself (`remember`), and when the modal closes
 * (`refresh`): opening a thread marks it seen on the server, and a modal closed
 * on that thread never reads the list again to say so.
 */
function useUpdatedCount(
  list: () => Promise<OwnProductFeedbackListResponse>
): { count: number; remember: (count: number) => void; refresh: () => void } {
  const [count, setCount] = React.useState(0)
  const lastRead = React.useRef(0)
  const alive = React.useRef(true)

  const remember = React.useCallback((next: number) => {
    lastRead.current = Date.now()
    setCount(next)
  }, [])

  const refresh = React.useCallback(() => {
    lastRead.current = Date.now()
    list()
      .then((page) => {
        if (alive.current) setCount(page.updatedCount)
      })
      // The dot is a hint: a failed read leaves the last answer standing.
      .catch(() => undefined)
  }, [list])

  React.useEffect(() => {
    alive.current = true
    const onFocus = (): void => {
      if (Date.now() - lastRead.current >= UPDATES_REFRESH_MS) refresh()
    }
    refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      alive.current = false
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  return { count, remember, refresh }
}

/**
 * Opens „Mein Feedback" on the thread the address names (`?feedback=<report
 * id>`, `feedbackThreadHref`) and takes the parameter off again, so a reload
 * or a back step does not reopen it. This is where an inbox row, a push or a
 * mail about a team reply lands. Its own component behind a Suspense
 * boundary: reading the query string must not hold up the shell.
 */
function ThreadFromAddress({ onThread }: { onThread: (reportId: string) => void }): null {
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const reportId = params?.get(FEEDBACK_THREAD_PARAM) ?? null

  React.useEffect(() => {
    if (!reportId) return
    onThread(reportId)
    const rest = new URLSearchParams(params?.toString() ?? '')
    rest.delete(FEEDBACK_THREAD_PARAM)
    const query = rest.toString()
    router.replace(`${pathname ?? '/app/projects'}${query ? `?${query}` : ''}`, { scroll: false })
  }, [reportId, onThread, params, pathname, router])

  return null
}

/** Where the modal opens: the form with a kind chosen, or a thread, or the list. */
interface Start {
  compose: ProductFeedbackKind | null
  reportId: string | null
}

export function FeedbackProvider({
  userEmail = null,
  threadsApi,
  children,
}: {
  userEmail?: string | null
  /** Previews inject the modal's calls (and with them the count and the send); the app uses the live routes. */
  threadsApi?: FeedbackThreadsApi
  children: React.ReactNode
}): JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [start, setStart] = React.useState<Start>({ compose: null, reportId: null })
  // The same start again keeps the same object: the address hands over its
  // thread on every render until the router drops the parameter, and a fresh
  // object each time would re-render the shell without end.
  const startAt = React.useCallback((next: Start) => {
    setStart((current) => (current.compose === next.compose && current.reportId === next.reportId ? current : next))
    setOpen(true)
  }, [])
  const list = threadsApi?.list ?? fetchOwnFeedback
  const { count: updatedCount, remember: setUpdatedCount, refresh: refreshUpdatedCount } = useUpdatedCount(list)

  const openFeedback = React.useCallback<OpenFeedback>(
    (kind) => startAt({ compose: kind ?? 'bug', reportId: null }),
    [startAt]
  )

  const openThreads = React.useCallback<OpenFeedbackThreads>(
    (reportId) => startAt({ compose: null, reportId: reportId ?? null }),
    [startAt]
  )

  const value = React.useMemo(
    () => ({ openFeedback, openThreads, updatedCount }),
    [openFeedback, openThreads, updatedCount]
  )

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <React.Suspense fallback={null}>
        <ThreadFromAddress onThread={openThreads} />
      </React.Suspense>
      <FeedbackThreadsDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) refreshUpdatedCount()
        }}
        initialCompose={start.compose}
        initialReportId={start.reportId}
        userEmail={userEmail}
        api={threadsApi}
        onUpdatedCount={setUpdatedCount}
      />
    </FeedbackContext.Provider>
  )
}
