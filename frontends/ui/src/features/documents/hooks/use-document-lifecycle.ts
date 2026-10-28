'use client'

/**
 * One document's versions and the gestures that move them, as state.
 *
 * Extracted from the lifecycle panel when its two halves (the Freigabe controls
 * and the Fassung timeline) became one section (`document-revisions.tsx`): the
 * data handling is the part that must not be written twice, and the part a
 * component should not own.
 *
 * ## It owns the data, the controls do not
 *
 * Every request goes through the typed client (`lib/documents/lifecycle-client`,
 * ADR-0055). The hook holds the version list, applies a gesture OPTIMISTICALLY,
 * and puts the previous list back if the server disagrees. Optimism is right
 * here because the answer is nearly always yes (the controls were filtered by the
 * same transition table the route reads) and because the alternative — a spinner
 * over the pane between „Freigeben" and the row moving — is half a second of the
 * reader wondering whether the click landed.
 *
 * ## The 409 is not an error message, it is a reload
 *
 * `compareAndSwapVersionState` answers 409 when the version left the state the
 * reader acted on: another reviewer got there first, or a second tab did. The
 * honest response is to say the stand has moved and show what it moved to, so
 * the hook re-reads the list rather than leaving a stale one on screen with a
 * red line under it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import {
  DocumentLifecycleError,
  documentLifecycleClient,
  type DocumentLifecycleClient,
} from '@/lib/documents/lifecycle-client'
import type {
  DocumentLifecycle,
  DocumentVersionListResponse,
  DocumentVersionView,
} from '@/lib/documents/lifecycle-types'
import {
  lifecycleRequestFor,
  type DocumentLifecycleAction,
  type DocumentLifecycleGesture,
} from '../lib/document-lifecycle'
import type { ReviewerOption } from '../components/document-review-controls'

/** The submit of a held document (`details.reason`, `lib/documents/lifecycle.ts`). */
function isHeldRefusal(error: DocumentLifecycleError): boolean {
  const details = error.details
  return (
    error.status === 409 &&
    typeof details === 'object' &&
    details !== null &&
    (details as { reason?: unknown }).reason === 'held'
  )
}

/** The version the controls act on: the newest one. */
export function newestVersion(versions: readonly DocumentVersionView[]): DocumentVersionView | null {
  return versions.reduce<DocumentVersionView | null>(
    (newest, version) =>
      newest === null || version.versionNumber > newest.versionNumber ? version : newest,
    null,
  )
}

/**
 * What a gesture does to the row while the request is in flight.
 *
 * The op's own transition row already says where it lands; this is that `to`
 * looked up by op, so the optimistic state cannot disagree with the state the
 * server will write. `archive` is item-level and moves no version.
 */
const OPTIMISTIC_STATE: Record<
  Exclude<DocumentLifecycleAction, 'archive'>,
  DocumentVersionView['state']
> = {
  submit: 'in_review',
  // „Freigeben" publishes in the same step (ADR-0104 rule 5).
  approve: 'published',
  request_changes: 'changes_requested',
  reject: 'rejected',
  publish: 'published',
}

export interface DocumentLifecycleSummary {
  documentId: string
  state: DocumentVersionView['state']
  versionCount: number
  lifecycle: DocumentLifecycle
}

export interface ActOptions {
  comment?: string
  reviewerUserIds?: readonly string[]
  orderMessage?: string
  dueAt?: string
}

export interface UseDocumentLifecycleOptions {
  documentId: string
  /** Off where nothing needs the versions; no request is made. */
  enabled?: boolean
  /** Whether to read who the version may be sent to. Only a surface with review controls needs it. */
  withReviewers?: boolean
  /** Injected by the dev preview and the specs; the browser gets the real one. */
  client?: DocumentLifecycleClient
  /** The document's editorial state changed here, so the listing behind the pane can update its badge. */
  onChanged?: (summary: DocumentLifecycleSummary) => void
}

export interface DocumentLifecyclePosition {
  /** The server's list, with a gesture applied optimistically while it is in flight. `null` until read. */
  listing: DocumentVersionListResponse | null
  loading: boolean
  /** The list could not be read. A pane that cannot read the history still shows the document. */
  failed: boolean
  /** The gesture currently in flight; its control shows as busy. */
  pending: DocumentLifecycleGesture | null
  /** Who this version may be sent to. Empty when unread: the submission then goes to every editor. */
  reviewers: readonly ReviewerOption[]
  act: (gesture: DocumentLifecycleGesture, options?: ActOptions) => Promise<void>
}

export function useDocumentLifecycle({
  documentId,
  enabled = true,
  withReviewers = false,
  client = documentLifecycleClient,
  onChanged,
}: UseDocumentLifecycleOptions): DocumentLifecyclePosition {
  const t = useTranslations(filesCopy)
  const [listing, setListing] = useState<DocumentVersionListResponse | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState<DocumentLifecycleGesture | null>(null)
  const [reviewers, setReviewers] = useState<readonly ReviewerOption[]>([])

  // A response for a document the pane has since left belongs to nobody.
  const currentId = useRef(documentId)
  currentId.current = documentId

  const load = useCallback(async () => {
    const id = documentId
    setLoading(true)
    try {
      const next = await client.listVersions(id)
      if (currentId.current !== id) return
      setListing(next)
      setFailed(false)
    } catch {
      if (currentId.current !== id) return
      // One quiet line, and the rest of the rail is unaffected.
      setFailed(true)
    } finally {
      if (currentId.current === id) setLoading(false)
    }
  }, [client, documentId])

  useEffect(() => {
    setListing(null)
    setFailed(false)
    if (!enabled) {
      setLoading(false)
      return
    }
    void load()
  }, [enabled, load])

  // One request per document, and a failure is silent on purpose: without the
  // list the picker is simply absent and the submission goes to every editor,
  // which is what it would have done anyway.
  useEffect(() => {
    setReviewers([])
    if (!enabled || !withReviewers) return
    let live = true
    void fetch(`/api/documents/${encodeURIComponent(documentId)}/versions/reviewers`)
      .then((response) => (response.ok ? response.json() : { candidates: [] }))
      .then((body: { candidates?: ReviewerOption[] }) => {
        if (live) setReviewers(body.candidates ?? [])
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [documentId, enabled, withReviewers])

  const announce = useCallback(
    (next: DocumentVersionListResponse) => {
      const newest = newestVersion(next.versions)
      if (!newest) return
      onChanged?.({
        documentId,
        state: newest.state,
        versionCount: next.versions.length,
        lifecycle: next.lifecycle,
      })
    },
    [documentId, onChanged],
  )

  const act = useCallback(
    async (gesture: DocumentLifecycleGesture, options: ActOptions = {}) => {
      const { comment, reviewerUserIds, orderMessage, dueAt } = options
      if (!listing) return
      const version = newestVersion(listing.versions)
      if (!version) return
      const previous = listing
      // „Piloti überarbeiten lassen" is the `request_changes` row with one more
      // field on the request (ADR-0054), so everything below — the optimistic
      // state, the re-read, the 409 — is the same code path as the button
      // beside it.
      const { action, delegateRevision } = lifecycleRequestFor(gesture)

      // Optimistic: the row moves now, and goes back if the server refuses.
      setListing(
        action === 'archive'
          ? { ...listing, lifecycle: 'archived' }
          : {
              ...listing,
              versions: listing.versions.map((row) =>
                row.id === version.id ? { ...row, state: OPTIMISTIC_STATE[action] } : row,
              ),
            },
      )
      setPending(gesture)

      try {
        if (action === 'archive') {
          await client.archive(documentId)
        } else {
          await runVersionOp(client, action, documentId, version.id, {
            comment,
            delegateRevision,
            reviewerUserIds,
            orderMessage,
            dueAt,
            // The bytes this pane was showing when the reviewer decided. A
            // decision on a version somebody has since replaced 409s instead of
            // landing on the new one.
            ifMatch: version.contentHash ?? undefined,
          })
        }
        // Re-read rather than patch: publish supersedes another version and
        // moves the item's pointer, and a client that reconstructed that from
        // one response would be keeping a second copy of the promotion rule.
        const next = await client.listVersions(documentId)
        if (currentId.current !== documentId) return
        setListing(next)
        announce(next)
      } catch (error) {
        if (currentId.current === documentId) setListing(previous)
        if (error instanceof DocumentLifecycleError && isHeldRefusal(error)) {
          // Not a stand that moved: the file is still held by its screening
          // (ADR-0086), and the draft stays a draft until it passes.
          toast.error(t('lifecycle.errors.held'))
        } else if (error instanceof DocumentLifecycleError && error.status === 409) {
          toast.error(t('lifecycle.errors.conflict'))
          await load()
        } else if (error instanceof DocumentLifecycleError && error.code === 'CONVERSATION_CONFINED') {
          // The server's sentence, already in the reader's language: why
          // Piloti may not revise a draft in a restricted folder (ADR-0087).
          toast.error(error.message)
        } else {
          toast.error(t('lifecycle.errors.actionFailed'))
        }
      } finally {
        setPending(null)
      }
    },
    [announce, client, documentId, listing, load, t],
  )

  return { listing, loading, failed, pending, reviewers, act }
}

/**
 * One op, one client call.
 *
 * A `Record` over the op union rather than a `switch`, so an op added to the
 * review set has to be given a call here before this compiles — the same
 * discipline the effects registry uses one tier down.
 */
async function runVersionOp(
  client: DocumentLifecycleClient,
  action: Exclude<DocumentLifecycleAction, 'archive'>,
  documentId: string,
  versionId: string,
  {
    comment,
    delegateRevision = false,
    reviewerUserIds,
    orderMessage,
    dueAt,
    ifMatch,
  }: ActOptions & { delegateRevision?: boolean; ifMatch?: string },
): Promise<void> {
  const calls: Record<typeof action, () => Promise<DocumentVersionView>> = {
    // `undefined` when nobody was singled out, which is the picker's default:
    // the fallback chain (`lib/documents/reviewers.ts`) asks whoever is on the
    // hook and then every editor in the project. The order and Frist ride the
    // same call into the round's inbox payload.
    submit: () => client.submit(documentId, versionId, reviewerUserIds, { orderMessage, dueAt }),
    approve: () => client.approve(documentId, versionId, comment, ifMatch),
    // The flag is PASSED only when it is true, the same decision the client
    // makes one tier down about the wire: „Änderungen anfordern" is the call it
    // always was, and the third control is the only caller that adds anything.
    request_changes: () =>
      delegateRevision
        ? client.requestChanges(documentId, versionId, comment ?? '', true, ifMatch)
        : client.requestChanges(documentId, versionId, comment ?? '', undefined, ifMatch),
    reject: () => client.reject(documentId, versionId, comment ?? '', ifMatch),
    publish: () => client.publish(documentId, versionId),
  }
  await calls[action]()
}
