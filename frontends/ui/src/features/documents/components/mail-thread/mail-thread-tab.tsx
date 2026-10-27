'use client'

/**
 * The „E-Mails“ tab of a thread document's preview (ADR-0134, D16): the
 * E-Mail-Verlauf as the mails it holds, where the well beside it shows the
 * document they render into.
 *
 * Top to bottom: how many mails of this thread still wait in the
 * E-Mail-Eingang (for whoever may file them), the follow control, and one row
 * per mail, newest first (`MailThreadEntryItem`). A link (`?mailEntry=`) or a
 * citation (its section heading) scrolls to its entry and marks it.
 *
 * Every write is one call of the thread's client, then the tab reads the
 * thread again: following and ending a follow (`FollowControl`), detaching a
 * mail (`DetachDialog`, which also tells the shelf that two documents have a
 * new Fassung). The thread document's Fassungen are read once, after the
 * thread, for „Vergleichen“ and the detach confirmation's numbers.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Inbox } from 'lucide-react'
import { LoadError } from '@/components/ui/load-error'
import { Skeleton } from '@/components/ui/skeleton'
import { inboundMailPaths } from '@/features/inbound-mail/lib/paths'
import { useTranslations } from '@/i18n'
import { notifyDocumentsChanged } from '@/lib/documents/document-changes'
import type { DocumentVersionView } from '@/lib/documents/lifecycle-types'
import type { MailThreadEntryDetachResultView, MailThreadEntryView, MailThreadView } from '@/lib/mail-thread/mail-thread-wire'
import { cn } from '@/lib/utils'
import { mailThreadClient, type MailThreadClient } from './client'
import { DetachDialog } from './detach-dialog'
import { FollowControl } from './follow-control'
import { MailThreadEntryItem } from './mail-thread-entry'
import { currentVersionNumber, entriesNewestFirst, focusedEntryId, mayWrite } from './mail-thread-model'

type Load = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; view: MailThreadView }

export interface MailThreadTabProps {
  projectId: string
  /** The thread document (the preview's file). */
  documentId: string
  threadId: string
  /** The thread document's folder, where a mail detached into a new thread goes. */
  folderId: string | null
  /** The reader, to find their own follow; null where the surface does not know them. */
  viewerUserId: string | null
  /** The entry a link (`?mailEntry=`) or a citation (its heading) points at. */
  focus?: { entryId?: string | null; heading?: string | null }
  /** The `/dev/mail-thread` preview opens the detach dialog for this entry, to capture it. */
  openDetachFor?: string
  client?: MailThreadClient
  className?: string
}

export function MailThreadTab({
  projectId,
  documentId,
  threadId,
  folderId,
  viewerUserId,
  focus,
  openDetachFor,
  client = mailThreadClient,
  className,
}: MailThreadTabProps): JSX.Element {
  const t = useTranslations('mailThread')
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [versions, setVersions] = useState<DocumentVersionView[] | null>(null)
  const [detaching, setDetaching] = useState<MailThreadEntryView | null>(null)

  const read = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const view = await client.get(projectId, threadId, signal)
        if (signal?.aborted) return
        setLoad({ kind: 'ready', view })
        // The Fassungen follow the thread; without them the tab still says everything but „Vergleichen“.
        client.versions(documentId).then(
          (listing) => !signal?.aborted && setVersions(listing.versions),
          () => undefined,
        )
      } catch {
        if (!signal?.aborted) setLoad({ kind: 'failed' })
      }
    },
    [client, documentId, projectId, threadId],
  )

  useEffect(() => {
    const controller = new AbortController()
    setLoad({ kind: 'loading' })
    setVersions(null)
    void read(controller.signal)
    return () => controller.abort()
  }, [read])

  const view = load.kind === 'ready' ? load.view : null
  const requestedDetach = openDetachFor && view ? (view.entries.find((item) => item.id === openDetachFor) ?? null) : null
  useEffect(() => {
    if (requestedDetach) setDetaching(requestedDetach)
  }, [requestedDetach])
  const focused = useMemo(
    () => (view && focus ? focusedEntryId(view.entries, focus) : null),
    [view, focus],
  )

  if (load.kind === 'loading') {
    return (
      <div className={cn('flex flex-col gap-3', className)} data-testid="mail-thread-tab" data-state="loading" aria-busy>
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    )
  }
  if (load.kind === 'failed' || !view) {
    return (
      <div className={className} data-testid="mail-thread-tab" data-state="failed">
        <LoadError title={t('tab.loadFailed')} onRetry={() => read()} />
      </div>
    )
  }

  const writable = mayWrite(view)
  const current = currentVersionNumber(versions, view.entries)
  const entries = entriesNewestFirst(view.entries)

  const detached = (result: MailThreadEntryDetachResultView, targetName: string | null): void => {
    setDetaching(null)
    toast.success(targetName ? t('detach.done', { name: targetName }) : t('detach.doneNew'), {
      description: result.followsEnded > 0 ? t('detach.followsEnded', { count: result.followsEnded }) : undefined,
    })
    // Both thread documents have a new Fassung: the shelf reads them again.
    notifyDocumentsChanged()
    void read()
  }

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="mail-thread-tab" data-state="ready">
      {view.waitingCount !== null && view.waitingCount > 0 && (
        <p className="text-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="mail-thread-waiting">
          <span className="inline-flex min-w-0 items-start gap-1.5">
            <Inbox className="text-muted-foreground mt-px size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{t('tab.waiting', { count: view.waitingCount })}</span>
          </span>
          <Link
            href={inboundMailPaths(projectId).list({ status: 'waiting', outcome: null })}
            className="touch-target rounded-sm font-medium underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {t('tab.waitingOpen')}
          </Link>
        </p>
      )}

      <FollowControl projectId={projectId} view={view} viewerUserId={viewerUserId} client={client} onChanged={() => void read()} />

      {entries.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-testid="mail-thread-empty">
          {t('tab.empty')}
        </p>
      ) : (
        <ol
          className="bg-card divide-border/60 flex flex-col divide-y overflow-hidden rounded-lg border"
          aria-label={t('tab.timeline')}
          data-testid="mail-thread-entries"
        >
          {entries.map((entry) => (
            <MailThreadEntryItem
              key={entry.id}
              projectId={projectId}
              documentId={documentId}
              threadId={view.id}
              entry={entry}
              versions={versions}
              focused={entry.id === focused}
              // The thread's only mail cannot leave it (`last_entry`): the document is deleted instead.
              onDetach={writable && view.entries.length > 1 ? setDetaching : undefined}
              client={client}
            />
          ))}
        </ol>
      )}

      {detaching && (
        <DetachDialog
          open
          onOpenChange={(open) => !open && setDetaching(null)}
          projectId={projectId}
          thread={view}
          entry={detaching}
          currentVersion={current}
          folderId={folderId}
          client={client}
          onDetached={detached}
        />
      )}
    </div>
  )
}
