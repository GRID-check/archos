import 'server-only'
/**
 * What on a project's intake needs a person's attention, as inbox items
 * (ADR-0035, ADR-0111). Best-effort: never throws into the reading or the
 * review that called it.
 *
 * A finished reading waits on the person whose upload or click started it
 * (`piloti.intake_ready`). The row points at the project and opens its setup
 * page; it is anchored on the intake, so the next reading folds into the same
 * row. Whoever finishes the review settles it for everyone. No actor: Piloti
 * read the documents.
 */

import { bestEffortInbox } from '@/lib/inbox/best-effort'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems, resolveInboxItemsAnchoredOn } from '@/lib/inbox/service'

const TYPE = 'piloti.intake_ready'

/** Longest summary quoted in a row. */
const SUMMARY_LENGTH = 200

/**
 * A reading ended: its requester may review it (`ready`), or is told it did
 * not finish and may start another (`failed`, the row's `variants.failed`
 * wording). One row per intake either way: the next reading folds into it.
 *
 * The fold MERGES payloads (`upsertInboxItems`, jsonb `||`), so every field a
 * wording reads is written on every emission, empty when it has nothing to
 * say (`coerceText` reads an empty string as absent). Without that a reading
 * with no Rückfragen kept the count of the reading before it, and a reading
 * that finished after a failed one still said it failed.
 */
export async function onIntakeReady(input: {
  organizationId: string
  projectId: string
  intakeId: string
  recipientUserId: string
  /** The project's name: the row's subject. */
  projectName: string | null
  /** How the reading ended. */
  outcome: 'ready' | 'failed'
  /** Questions that decide a building class; named in the title when there are any. */
  decisiveOpen: number
  /** The reading's own summary, already masked. */
  summary: string | null
}): Promise<void> {
  await bestEffortInbox(`${TYPE} for intake ${input.intakeId}`, input.organizationId, () => {
    const summary = (input.summary ?? '').replace(/\s+/g, ' ').trim()
    return emitInboxItems([
      {
        organizationId: input.organizationId,
        recipientUserId: input.recipientUserId,
        type: TYPE,
        resourceType: 'project',
        resourceId: input.projectId,
        anchorId: input.intakeId,
        actorUserId: null,
        groupKey: inboxGroupKey(TYPE, 'project', input.projectId, input.intakeId),
        payload: {
          ...(input.projectName ? { subject: input.projectName } : {}),
          variant: input.outcome,
          related: input.outcome === 'ready' && input.decisiveOpen > 0 ? String(input.decisiveOpen) : '',
          excerpt: summary.length > SUMMARY_LENGTH ? `${summary.slice(0, SUMMARY_LENGTH - 1)}…` : summary,
        },
      },
    ])
  })
}

/** The review was finished: nothing waits on anybody any more. */
export async function onIntakeCompleted(input: { organizationId: string; intakeId: string }): Promise<void> {
  await bestEffortInbox(`settling intake ${input.intakeId}`, input.organizationId, () =>
    resolveInboxItemsAnchoredOn({ organizationId: input.organizationId, types: [TYPE], anchorId: input.intakeId })
  )
}
