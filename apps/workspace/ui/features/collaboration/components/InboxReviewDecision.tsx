'use client'

/**
 * A version waiting for a decision, decided from its inbox row (ADR-0054): the
 * three decisions on the row, so the reviewer answers here instead of
 * navigating to Files first. The row draws it only while the round is open for
 * this reader (actionable, unresolved, reachable, naming its version and its
 * Fassung). The server enforces who may decide (project:edit, never the
 * submitter); a refusal there surfaces as an error line, never as a silent
 * nothing. It resolves server-side: the decision settles the round for every
 * reviewer (`resolveReviewInbox`) and the list re-reads on the `inbox.changed`
 * nudge. Nothing persists on a chat message, so `useCardDecision` does not apply.
 *
 * Its own component because it is its own small workflow (pick, confirm or
 * word it, send, a moved STAND), and the row it sits in is about the row.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import Link from 'next/link'

import { useLocale, useTranslations } from '@/i18n'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { formatAbsoluteTime } from '@/lib/format'
import type { InboxItemView } from '@/lib/inbox/types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { DocumentLifecycleError, type DocumentLifecycleClient } from '@/lib/documents/lifecycle-client'
import type { DocumentVersionView } from '@/lib/documents/lifecycle-types'
import { isPlainClick } from '../lib/plain-click'

export type InboxReviewClient = Pick<DocumentLifecycleClient, 'approve' | 'requestChanges' | 'reject'> &
  Partial<Pick<DocumentLifecycleClient, 'getVersion'>>

export interface InboxReviewDecisionProps {
  item: InboxItemView
  reviewClient: InboxReviewClient
  /** Following the file's link counts as opening the row. */
  onOpen?: (item: InboxItemView) => void
}

export function InboxReviewDecision({ item, reviewClient, onOpen }: InboxReviewDecisionProps): JSX.Element {
  const t = useTranslations(collaborationCopy)
  const { locale } = useLocale()
  const [reviewing, setReviewing] = useState<'approve' | 'request_changes' | 'reject' | null>(null)
  const [reviewComment, setReviewComment] = useState('')
  const [reviewChecked, setReviewChecked] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewFailed, setReviewFailed] = useState(false)
  const [reviewStale, setReviewStale] = useState(false)
  const [reviewDecided, setReviewDecided] = useState(false)
  const [reviewVersion, setReviewVersion] = useState<DocumentVersionView | null>(null)
  const [reviewVersionError, setReviewVersionError] = useState(false)

  // The STAND the decisions act on: version number for the signature (Fassung
  // required — nothing is released without naming it) and `contentHash` as the
  // `ifMatch` the calls below send, so a stale row 409s instead of deciding on
  // bytes the reviewer never saw. Read with the row, not when a decision
  // opens: the signature must already name the Fassung when it appears, and a
  // refusal must already carry the expected bytes when it is sent — waiting
  // for the read inside the confirm would race the send. One attempt per
  // version anchor; a failed read falls back to deciding on state alone,
  // exactly as before, rather than stranding the row.
  //
  // Deliberately NO loading flag: setting one before the `await` would re-run
  // this effect (it is in the deps) and its cleanup would flip `live` to false
  // while the read is still in flight — the resolve below would then be
  // discarded and the STAND would never arrive. The pending state is visible
  // anyway: the stand renders '…' and the approve send stays shut until the
  // Fassung number is known.
  useEffect(() => {
    if (!item.anchorId) return
    if (reviewVersion !== null || reviewVersionError) return
    if (typeof reviewClient.getVersion !== 'function') return
    let live = true
    void reviewClient
      .getVersion(item.resourceId, item.anchorId)
      .then((version) => {
        if (live) {
          setReviewVersion(version)
        }
      })
      .catch(() => {
        if (live) {
          setReviewVersionError(true)
        }
      })
    return () => {
      live = false
    }
  }, [
    item.anchorId,
    item.resourceId,
    reviewClient,
    reviewVersion,
    reviewVersionError,
  ])

  const sendReview = async () => {
    if (!reviewing || !item.anchorId || reviewBusy) return
    // Approval is signed, refusals are worded — the transition table's own
    // requirements, read at the same point the file pane reads them. Approval
    // additionally requires the Fassung number: the stand is not released
    // without naming which version it releases.
    if (reviewing === 'approve' && !reviewChecked) return
    if (reviewing === 'approve' && typeof reviewClient.getVersion === 'function') {
      if (reviewVersion?.versionNumber == null) return
    }
    const words = reviewComment.trim()
    if (reviewing !== 'approve' && words === '') return
    setReviewBusy(true)
    setReviewFailed(false)
    setReviewStale(false)
    // The expected bytes, when the STAND above could be read. Absent when the
    // read never ran (old callers, a version without a digest): the server
    // then decides on state alone, exactly as before, and a provided-but-stale
    // digest 409s with the current STAND.
    const ifMatch = reviewVersion?.contentHash ?? undefined
    try {
      if (reviewing === 'approve') {
        await reviewClient.approve(item.resourceId, item.anchorId, undefined, ifMatch)
      } else if (reviewing === 'request_changes') {
        await reviewClient.requestChanges(item.resourceId, item.anchorId, words, undefined, ifMatch)
      } else {
        await reviewClient.reject(item.resourceId, item.anchorId, words, ifMatch)
      }
      // Decided here; resolved everywhere by the server, which settles the
      // round for every reviewer and nudges this list to re-read it.
      setReviewDecided(true)
      setReviewing(null)
      setReviewComment('')
      setReviewChecked(false)
    } catch (error) {
      // A 409 is not a failed decision, it is a moved STAND: somebody decided
      // first, or the bytes changed under the row. Surfaced distinctly, with
      // the file as the way back to the current Fassung — never as a silent
      // nothing, and never as the generic red line.
      if (error instanceof DocumentLifecycleError && error.status === 409) {
        setReviewStale(true)
      } else {
        setReviewFailed(true)
      }
    } finally {
      setReviewBusy(false)
    }
  }

  return (
    <div className="relative z-10 mt-2" data-testid="inbox-review-actions">
      {reviewDecided ? (
        <p
          className="text-muted-foreground text-xs"
          data-testid="inbox-review-decided"
        >
          {t('inbox.review.decided')}
        </p>
      ) : reviewing === null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            disabled={reviewBusy}
            data-testid="inbox-review-approve"
            onClick={() => {
              setReviewFailed(false)
              setReviewStale(false)
              setReviewChecked(false)
              setReviewing('approve')
            }}
          >
            {t('inbox.review.approve')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={reviewBusy}
            data-testid="inbox-review-request-changes"
            onClick={() => {
              setReviewFailed(false)
              setReviewStale(false)
              setReviewComment('')
              setReviewing('request_changes')
            }}
          >
            {t('inbox.review.requestChanges')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={reviewBusy}
            data-testid="inbox-review-reject"
            onClick={() => {
              setReviewFailed(false)
              setReviewStale(false)
              setReviewComment('')
              setReviewing('reject')
            }}
          >
            {t('inbox.review.reject')}
          </Button>
          {item.href && (
            <Link
              href={item.href}
              className="text-primary text-xs font-medium hover:underline"
              data-testid="inbox-review-open"
              onClick={(event) => {
                if (isPlainClick(event)) onOpen?.(item)
              }}
            >
              {t('inbox.review.open')}
            </Link>
          )}
        </div>
      ) : reviewing === 'approve' ? (
        /* The same minimum ceremony as on the file: never one click,
           and the signature names the same facts — which Fassung is
           released (subject + number + round opening) and who acts
           when. The number is required: without the STAND read above
           nothing is released. Who asked is already in the title, so
           the acting line stays date-only like the file pane's own
           fallback when no viewer name is known. */
        <div
          className="space-y-2 rounded-lg border p-2"
          data-testid="inbox-review-approve-confirm"
        >
          <p className="text-xs font-medium" data-testid="inbox-review-approve-as-of">
            {t('inbox.review.approveSummary', {
              subject: item.subject ?? t('inbox.untitledConversation'),
              number: reviewVersion?.versionNumber ?? '…',
              date: formatAbsoluteTime(
                reviewVersion?.updatedAt ?? item.createdAt,
                locale,
              ),
            })}
          </p>
          <p
            className="text-muted-foreground text-xs"
            data-testid="inbox-review-approve-acting"
          >
            {t('inbox.review.approveActing', {
              date: formatAbsoluteTime(new Date().toISOString(), locale),
            })}
          </p>
          {/* The STAND read failed: say so and offer the retry, because
              approval stays blocked without the Fassung number. A silent
              '…' would read as a bug rather than as a blocked signature. */}
          {reviewVersionError && (
            <p className="text-error text-xs" data-testid="inbox-review-stand-failed">
              {t('inbox.review.revisionUnreadable')}{' '}
              <button
                type="button"
                className="text-primary font-medium hover:underline"
                data-testid="inbox-review-stand-retry"
                onClick={() => setReviewVersionError(false)}
              >
                {t('inbox.review.retry')}
              </button>
            </p>
          )}
          <div className="flex items-start gap-2">
            <Checkbox
              id={`inbox-review-approve-${item.id}`}
              checked={reviewChecked}
              onCheckedChange={(checked) => setReviewChecked(checked === true)}
              data-testid="inbox-review-approve-checkbox"
            />
            <label
              htmlFor={`inbox-review-approve-${item.id}`}
              className="text-xs leading-snug"
            >
              {t('inbox.review.approveConfirm')}
            </label>
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => {
                setReviewing(null)
                setReviewChecked(false)
              }}
            >
              {t('inbox.review.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={
                !reviewChecked ||
                reviewBusy ||
                (typeof reviewClient.getVersion === 'function' &&
                  reviewVersion?.versionNumber == null)
              }
              data-testid="inbox-review-approve-send"
              onClick={() => void sendReview()}
            >
              {t('inbox.review.approve')}
            </Button>
          </div>
        </div>
      ) : (
        /* A refusal without words is refused by the transition itself;
           the button stays shut until something is typed. */
        <div className="space-y-2 rounded-lg border p-2" data-testid="inbox-review-comment">
          <label
            htmlFor={`inbox-review-comment-${item.id}`}
            className="text-muted-foreground block text-xs"
          >
            {t(
              reviewing === 'reject'
                ? 'inbox.review.reasonLabel'
                : 'inbox.review.changesLabel',
            )}
          </label>
          <Textarea
            id={`inbox-review-comment-${item.id}`}
            value={reviewComment}
            autoFocus
            rows={2}
            onChange={(event) => setReviewComment(event.target.value)}
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => {
                setReviewing(null)
                setReviewComment('')
              }}
            >
              {t('inbox.review.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={reviewComment.trim() === '' || reviewBusy}
              data-testid="inbox-review-comment-send"
              onClick={() => void sendReview()}
            >
              {t('inbox.review.send')}
            </Button>
          </div>
        </div>
      )}
      {reviewStale && (
        <p className="mt-1.5 text-xs" data-testid="inbox-review-stale">
          <span className="text-error">{t('inbox.review.stale')}</span>{' '}
          {item.href && (
            <Link
              href={item.href}
              className="text-primary font-medium hover:underline"
              data-testid="inbox-review-reload"
              onClick={(event) => {
                if (isPlainClick(event)) onOpen?.(item)
              }}
            >
              {t('inbox.review.reload')}
            </Link>
          )}
        </p>
      )}
      {reviewFailed && (
        <p className="text-error mt-1.5 text-xs" data-testid="inbox-review-failed">
          {t('inbox.review.failed')}
        </p>
      )}
    </div>
  )
}
