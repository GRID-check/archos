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
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { fetchOwnFeedback } from '@/lib/product-feedback/client'
import { FEEDBACK_THREAD_PARAM, type OwnProductFeedbackListResponse, type ProductFeedbackKind } from '@/lib/product-feedback/types'
import { FeedbackDialog, type FeedbackDialogProps } from './feedback-dialog'
import { FeedbackThreadsSheet, type FeedbackThreadsApi } from './feedback-threads'

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

/**
 * The count of threads with news, and a way to read it again now. Read when
 * the shell mounts, on focus after {@link UPDATES_REFRESH_MS}, whenever the
 * sheet reads the list itself (`remember`), and when the sheet closes
 * (`refresh`): opening a thread marks it seen on the server, and a sheet closed
 * from inside that thread never goes back through the list to say so.
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

export function FeedbackProvider({
  userEmail = null,
  threadsApi,
  submit,
  children,
}: {
  userEmail?: string | null
  /** Previews inject the sheet's calls (and with them the count); the app uses the live routes. */
  threadsApi?: FeedbackThreadsApi
  /** Previews inject the form's send; the app uses the live route. */
  submit?: FeedbackDialogProps['submit']
  children: React.ReactNode
}): JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [kind, setKind] = React.useState<ProductFeedbackKind>('bug')
  const [threadsOpen, setThreadsOpen] = React.useState(false)
  const [threadId, setThreadId] = React.useState<string | null>(null)
  const list = threadsApi?.list ?? fetchOwnFeedback
  const { count: updatedCount, remember: setUpdatedCount, refresh: refreshUpdatedCount } = useUpdatedCount(list)

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
      <React.Suspense fallback={null}>
        <ThreadFromAddress onThread={openThreads} />
      </React.Suspense>
      <FeedbackDialog
        open={open}
        onOpenChange={setOpen}
        defaultKind={kind}
        userEmail={userEmail}
        submit={submit}
        onViewThread={(reportId) => {
          setOpen(false)
          openThreads(reportId)
        }}
      />
      <FeedbackThreadsSheet
        open={threadsOpen}
        onOpenChange={(next) => {
          setThreadsOpen(next)
          if (!next) refreshUpdatedCount()
        }}
        initialReportId={threadId}
        api={threadsApi}
        onUpdatedCount={setUpdatedCount}
        onNewFeedback={() => {
          setThreadsOpen(false)
          openFeedback()
        }}
      />
    </FeedbackContext.Provider>
  )
}
