import 'server-only'
/**
 * What on a proposal needs a person's attention, as inbox items (ADR-0035,
 * ADR-0105). Best-effort: never throws into the write that called it.
 *
 * A stored proposal waits on the person it was made for, the one whose turn
 * Piloti acted in (`piloti.proposal_waiting`). Whoever decides it, that person
 * or a colleague who may write in the project, settles it for them.
 *
 * The item points at the chat the proposal was made in, where its card is, and
 * at the project's chat when it has no chat; either way the reader's access to
 * it is re-derived when the row is read. It carries the one-line summary and no
 * actor: Piloti proposed it.
 */

import { bestEffortInbox } from '@/lib/inbox/best-effort'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems, resolveInboxItemsAnchoredOn } from '@/lib/inbox/service'

const TYPE = 'piloti.proposal_waiting'

/** Longest summary quoted in a row. */
const SUMMARY_LENGTH = 200

/** A proposal was stored (`lib/proposals/service.ts`): the person it was made for may decide it. */
export async function onProposalCreated(input: {
  organizationId: string
  projectId: string
  proposalId: string
  originConversationId: string | null
  onBehalfOf: string
  /** One line naming the change, for the inbox row. */
  summary: string
}): Promise<void> {
  await bestEffortInbox(`${TYPE} for proposal ${input.proposalId}`, input.organizationId, () => {
    const [resourceType, resourceId] = input.originConversationId
      ? (['conversation', input.originConversationId] as const)
      : (['project', input.projectId] as const)
    const summary = input.summary.replace(/\s+/g, ' ').trim()
    return emitInboxItems([
      {
        organizationId: input.organizationId,
        recipientUserId: input.onBehalfOf,
        type: TYPE,
        resourceType,
        resourceId,
        anchorId: input.proposalId,
        actorUserId: null,
        groupKey: inboxGroupKey(TYPE, resourceType, resourceId, input.proposalId),
        payload: {
          ...(summary
            ? { excerpt: summary.length > SUMMARY_LENGTH ? `${summary.slice(0, SUMMARY_LENGTH - 1)}…` : summary }
            : {}),
        },
      },
    ])
  })
}

/** A proposal was applied or dismissed: nothing waits on anybody any more. */
export async function onProposalDecided(input: { organizationId: string; proposalId: string }): Promise<void> {
  await bestEffortInbox(`settling proposal ${input.proposalId}`, input.organizationId, () =>
    resolveInboxItemsAnchoredOn({
      organizationId: input.organizationId,
      types: [TYPE],
      anchorId: input.proposalId,
    })
  )
}
