/**
 * Run one notice of a new Fassung (ADR-0130): the `revision_notice` job of the
 * bff-jobs pool, as the person whose upload or link made the Fassung.
 *
 * Everything is asked again here, because the job waited (the debounce) and the
 * person's rights are those of today:
 *
 * 1. The person, resolved from WorkOS now (`resolvePinnedRequesterSession`);
 *    a person who left ends the notice.
 * 2. The organization's switch, `piloti-notices`, from their session's flags.
 * 3. Their budget: a spent scope ends the notice before a model is asked.
 * 4. The pages: which pages of the newer Fassung changed, read from the index
 *    with no model call (`changedRevisionPages`), at most
 *    `REVISION_NOTICE_MAX_PAGES` of them.
 * 5. One vision call per page through the comparison the compare view uses
 *    (`compareRevisionPage`, purpose `notice`): read access to both, neither
 *    held, one collection, no restricted folder. A page that cannot be
 *    rendered is skipped.
 * 6. The boxes become proposed marks on the newer Fassung through the one path
 *    Piloti's canvas tool uses (`runAgentAnnotationRequest`, op `propose`): the
 *    person must be able to write the document, the change ledger records each
 *    mark against the notice's message, so a decision on it is scored
 *    `piloti-decision` on the trace that produced it.
 * 7. One message in the person's thread about the document, and one inbox row
 *    for them that opens the Prüfansicht at the first mark.
 *
 * Nothing found is silence: no message, no row, only the score (0). Nothing
 * here edits, links, classifies or sets a mark open: everything it leaves waits
 * for a person.
 */

import 'server-only'
import { ApiError } from '@/lib/api/errors'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isPilotiNoticesEnabled } from '@/lib/authz/feature-flags'
import { runAgentAnnotationRequest } from '@/lib/annotations/agent'
import { listDocumentAnnotations } from '@/lib/annotations/repository'
import { unaskedSpendAllowed } from '@/lib/budgets/unasked-spend'
import type { Document } from '@/lib/db/schema'
import { documentDisplayName } from '@/lib/documents/display-name'
import { SCREENED_ONLY } from '@/lib/documents/document-reader'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { changedRevisionPages, compareRevisionPage } from '@/lib/documents/revision-compare-service'
import type { JobAttempt, RevisionNoticePayload } from '@/lib/jobs-queue/types'
import { recordRevisionNoticeScore } from '@/lib/langfuse/revision-notice-score'
import {
  alreadyProposed,
  maxNoticePages,
  noticeExcerpt,
  noticeMessage,
  pagesToCompare,
  proposalsFrom,
  revisionNoticeMessageId,
  type PageComparison,
} from './notice'
import { leaveNotice, noticeThread } from './leave'

/** How a notice ended, for the log and the tests. */
export type NoticeOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'silent'; compared: number[] }
  | { status: 'proposed'; compared: number[]; marks: number }

const skipped = (reason: string): NoticeOutcome => {
  console.debug(`[revision-notice] skipped: ${reason}`)
  return { status: 'skipped', reason }
}

/** A refusal a retry would meet again (no access, gone, restricted, not readable): the notice ends. */
const isFinal = (error: unknown): boolean =>
  error instanceof ApiError && error.status >= 400 && error.status < 500

/** One page's comparison, or null for a page that cannot be compared (past the end, not rendered). */
async function comparePage(
  session: AuthorizedSession,
  payload: RevisionNoticePayload,
  page: number,
): Promise<(PageComparison & { traceId: string | null }) | null> {
  try {
    const { changes, traceId } = await compareRevisionPage(session, payload.newerId, payload.olderId, page, 'notice')
    return { page, changes, traceId }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/** Leave the proposals, the thread message and the inbox row. Returns how many marks were proposed. */
async function leave(input: {
  session: AuthorizedSession
  payload: RevisionNoticePayload
  newer: Document
  older: Document
  compared: number[]
  skippedPages: number[]
  comparisons: PageComparison[]
  traceId: string | null
}): Promise<number> {
  const { session, payload, newer, older } = input
  const olderName = documentDisplayName(older)
  const found = proposalsFrom(input.comparisons, olderName)
  if (found.length === 0) return 0
  // A retry after the marks were written proposes nothing again, and still writes the message.
  const existing = await listDocumentAnnotations(session.organizationId, newer.id)
  const fresh = proposalsFrom(input.comparisons, olderName, existing)
  // ...and still counts the marks it wrote then, for the inbox row and the score.
  const earlier = alreadyProposed(found, existing).flatMap((mark) => (mark.id ? [{ id: mark.id }] : []))

  const conversationId = await noticeThread(session, newer)
  const messageId = revisionNoticeMessageId(payload.noticeId)
  // The marks first: a write the person may no longer make must not leave a message about marks that are not there.
  const result =
    fresh.length > 0
      ? await runAgentAnnotationRequest(
          session,
          { id: newer.id, name: newer.filename, projectId: newer.projectId ?? null },
          { op: 'propose', proposals: fresh, answerMessageId: messageId },
          { organizationId: session.organizationId, conversationId, onBehalfOf: session.userId },
        )
      : null
  const marks = [...earlier, ...((result && 'proposed' in result ? result.proposed : undefined) ?? [])]

  const excerpt = noticeExcerpt(fresh.length > 0 ? fresh : found)
  await leaveNotice({
    session,
    newer,
    conversationId,
    messageId,
    content: noticeMessage({
      newerName: documentDisplayName(newer),
      olderName,
      compared: input.compared,
      skipped: input.skippedPages,
      proposals: found,
    }),
    metadata: {
      // The decision score on each mark finds its trace here (`lib/langfuse/decision-score.ts`).
      ...(input.traceId ? { trace_id: input.traceId } : {}),
      revisionNotice: { noticeId: payload.noticeId, olderDocumentId: older.id, pages: input.compared },
    },
    marks,
    excerpt,
    variant: marks.length === 1 ? 'one' : 'many',
    related: olderName,
  })
  return marks.length
}

/**
 * The notice itself. Throws only for what a retry may fix (the backend or the
 * database did not answer); every refusal ends it with a reason.
 */
export async function noticeRevision(organizationId: string, payload: RevisionNoticePayload): Promise<NoticeOutcome> {
  const session = await resolvePinnedRequesterSession({ ...payload.actor, organizationId })
  if (!session) return skipped('the person is no longer a member')
  if (!isPilotiNoticesEnabled(session)) return skipped('piloti-notices is off for the organization')

  const [newer, older] = await Promise.all([
    findDocumentInOrg(payload.newerId, organizationId, SCREENED_ONLY),
    findDocumentInOrg(payload.olderId, organizationId, SCREENED_ONLY),
  ])
  if (!newer || !older) return skipped('a document is gone or held')
  if (!(await unaskedSpendAllowed(session, newer.projectId ?? null))) return skipped('the budget is spent')

  try {
    const changed = await changedRevisionPages(session, newer.id, older.id)
    const { pages, skipped: skippedPages } = pagesToCompare(changed, maxNoticePages())
    if (pages.length === 0) return { status: 'silent', compared: [] }

    const comparisons: Array<PageComparison & { traceId: string | null }> = []
    for (const page of pages) {
      const comparison = await comparePage(session, payload, page)
      if (comparison) comparisons.push(comparison)
    }
    const compared = comparisons.map((comparison) => comparison.page)
    const traceId = comparisons.find((comparison) => comparison.traceId)?.traceId ?? null
    const marks = await leave({ session, payload, newer, older, compared, skippedPages, comparisons, traceId })
    void recordRevisionNoticeScore({
      noticeId: payload.noticeId,
      traceId,
      proposed: marks,
      pagesCompared: compared.length,
      pagesChanged: changed.pages.length,
    })
    return marks === 0 ? { status: 'silent', compared } : { status: 'proposed', compared, marks }
  } catch (error) {
    if (isFinal(error)) return skipped(`refused: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

/** The job's step (`lib/jobs-queue/handlers.ts`). On its last attempt a failure is logged, not thrown again. */
export async function runRevisionNotice(
  organizationId: string,
  payload: RevisionNoticePayload,
  attempt: JobAttempt,
): Promise<void> {
  try {
    await noticeRevision(organizationId, payload)
  } catch (error) {
    if (!attempt.last) throw error
    console.error(`[revision-notice] gave up on notice ${payload.noticeId}:`, error)
  }
}
