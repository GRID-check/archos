import 'server-only'
/**
 * Who reads the conversation Piloti answers in, and what a workspace read hands
 * out there (ADR-0093, ADR-0094, ADR-0121). `read-gate.ts` asks; this file
 * answers with the database.
 *
 * There is one rule for reaching other projects, ADR-0094's, and the workspace
 * door follows it as `project_lookup` does:
 *
 *  - **Reach is the audience's.** A place a read names (`operation-targets.ts`
 *    is the one place that knows what a call names) must lie in
 *    `audienceReachAmong`, the same function the lookups' `audienceReach` is
 *    built on: in a conversation that is the asker's alone, every project the
 *    asker may chat in, restricted folders they may read included; shared with
 *    at most ten named people, the closed projects and the active ones every
 *    reader may open; wider, the closed projects. Never a restricted folder in a
 *    shared conversation.
 *  - **Recorded before it runs.** Every read is recorded through
 *    `recordCrossProjectHandOut`, under the audience lock every share takes,
 *    refused when the audience changed since it was read: the other projects it
 *    says anything about, and the restricted folders it may carry. The answer
 *    the turn is writing is marked in the same transaction (ADR-0093). A project
 *    closed now restricts nobody, because the record is judged when read.
 *  - **The conversation's own project** keeps its own path: in a solo
 *    conversation every folder of it that restricts someone and that the asker
 *    may read is recorded with the read ({@link ownRestrictingFolders}, over on
 *    purpose: a route's answer does not say which folder it came from).
 *
 * What a read may carry decides what is recorded. A route answers as the asker,
 * and nothing in its answer says which folder it came from, so a read of
 * another project records every folder of it that restricts someone and the
 * asker may read, the same over-record. A read listed in `AUDIENCE_READS`
 * (`read-gate.ts`) declares what its answer is: one document's content (its
 * folder path's restricted folders are recorded, the ones a lookup's passage of
 * it records) or a project's facts (no folder).
 *
 * A shared conversation runs only those listed reads, because only their answer
 * is what every reader of the place reads: the rest answer with the asker's
 * view (their projects, their inbox, a member list's admin-only fields, their
 * own held uploads), which is not the audience's. A listed read there is refused
 * when what it names sits in a restricted folder, is held by screening, or
 * belongs to another conversation.
 *
 * Unchanged from before the one rule, because each is the asker's own view and
 * names no project to judge: a read whose answer spans the office's projects
 * (`spansProjects`) is refused in a project's conversation, and one naming
 * something the lookup cannot place is refused everywhere. A read of another
 * conversation that drew on other projects is refused, as its record is not
 * copied.
 */

import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { folderTree, getHiddenFolderIds, readableByEveryMember, readRestrictingFoldersOnPath } from '@/lib/authz/folder-access'
import { CrossProjectAudienceChangedError } from '@/lib/api/errors'
import {
  audienceKey,
  drewOnOtherProjects,
  isSoloAudience,
  recordCrossProjectHandOut,
  type CrossProjectHandOut,
} from '@/lib/conversations/cross-project-use'
import { readConversationAudience, type ConversationAudienceRow } from '@/lib/conversations/restricted-use-repository'
import { audienceReachAmong } from '@/lib/cross-project/audience-reach'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import type { AgentOperation } from './operation'
import {
  type OperationTarget,
  type TargetInput,
  TooManyTargetsError,
  namesUntypedResource,
  placesOf,
  targetsOf,
} from './operation-targets'
import type { TargetPlace } from './operation-targets-repository'
import type { AgentPrincipal } from './principal'

/** Who reads the conversation, as read once per request. */
export interface ConversationAudience {
  row: ConversationAudienceRow
  /** The asker's alone (or not created yet): the only audience whose reach holds restricted folders. */
  solo: boolean
  /** The {@link audienceKey} the record checks under the lock. */
  key: string
}

/** What a listed read's answer is (`AUDIENCE_READS`): one document's content, or a project's facts. */
export type ReadCarries = 'document' | 'projectFacts'

/** The place kind each {@link ReadCarries} names; a listed read naming anything else is refused in a shared chat. */
const CARRIED_TARGET: Readonly<Record<ReadCarries, OperationTarget['type']>> = {
  document: 'document',
  projectFacts: 'project',
}

const tenantOf = (principal: AgentPrincipal) => ({
  organizationId: principal.session.organizationId,
  userId: principal.session.userId,
})

/** The conversation's audience; null when the call belongs to no conversation of Piloti's. */
export async function conversationAudienceOf(principal: AgentPrincipal): Promise<ConversationAudience | null> {
  const conversationId = principal.conversationId
  if (principal.actor !== 'piloti' || !conversationId) return null
  const row = await withTenant(tenantOf(principal), () =>
    readConversationAudience(getDb(), principal.session.organizationId, conversationId)
  )
  return { row, solo: isSoloAudience(row, principal.session.userId), key: audienceKey(row) }
}

/**
 * The sentences the model relays for a refused read. English, whatever the
 * person's locale: an agent reads them (AGENTS.md, "Industry standard first").
 */
export const READ_REFUSALS = {
  shared:
    'This conversation is shared, and that read answers with what the person may see, not with what everyone in ' +
    'the conversation may: in a shared conversation Piloti reads only a document or a project\'s facts, of a project ' +
    'every reader may open. Tell the person to open it themselves, or to ask in a conversation that is theirs alone.',
  outsideReach:
    'That belongs to a project outside what this conversation may read from: the projects the person may chat in ' +
    'when the conversation is theirs alone; when it is shared, the closed projects and those every reader may open. ' +
    'Tell the person to open it themselves, or to ask in a conversation that is theirs alone.',
  restrictedFolder:
    'That sits in a folder with its own access list, and this conversation is shared, so Piloti does not read it ' +
    'here: not every reader was asked whether they may read that folder. Tell the person to open it themselves, or ' +
    'to ask in a conversation that is theirs alone.',
  notEveryReader:
    'Not everyone who reads this shared conversation may read that (a file still being screened, a file of another ' +
    'conversation, or one outside every project), so Piloti does not read it here. Tell the person to open it themselves.',
  otherConversation:
    'That conversation drew on other projects, so Piloti does not read it here: their content would land in this ' +
    'conversation without the record that keeps it to their readers. Tell the person to open it themselves.',
  spansProjects:
    'That read reaches across the office\'s projects, so Piloti does not run it in this project\'s conversation: ' +
    'it answers with every project the person sees, not with what this conversation may read. Narrow it to one ' +
    'project where the operation allows, or tell the person to open it themselves.',
  unknown:
    'Piloti cannot tell where that lives, so it does not read it here: what it does not find, it cannot hold to ' +
    'this conversation\'s rules for who may read it. Check the id, or tell the person to open it themselves.',
  tooMany:
    'The call names too many projects, documents, folders or conversations to check. Narrow it and call again.',
  proposalOutsideReach:
    'This conversation is shared, and that change names a project not everyone who reads it may open: its card, ' +
    'and what the change returns, would sit here. Tell the person to make the change in Piloti themselves, or to ' +
    'ask in a conversation that is theirs alone.',
  audienceChanged:
    'Who reads this conversation changed while Piloti was reading, so nothing was read. Call again: the read is ' +
    'judged against the readers the conversation has now.',
} as const

/** A read the gate refuses, or what it hands out once recorded. */
export type ReadJudgement = { refusal: string } | { handOut: CrossProjectHandOut }

const refuse = (refusal: string): ReadJudgement => ({ refusal })

/** What the read names, before it is placed: the targets, or why there is nothing to place. */
function namedTargets(
  principal: AgentPrincipal,
  op: Pick<AgentOperation, 'path' | 'spansProjects'>,
  input: TargetInput,
): OperationTarget[] | string {
  const turnProject = principal.projectId ?? null
  if (op.spansProjects === 'always' && turnProject) return READ_REFUSALS.spansProjects
  let targets: OperationTarget[]
  try {
    targets = targetsOf(op, input)
  } catch (error) {
    if (error instanceof TooManyTargetsError) return READ_REFUSALS.tooMany
    throw error
  }
  if (namesUntypedResource(input)) return READ_REFUSALS.unknown
  const namesProject = targets.some((target) => target.type === 'project')
  if (op.spansProjects === 'unlessScoped' && turnProject && !namesProject) return READ_REFUSALS.spansProjects
  return targets
}

/** A target placed in another project, to be judged against the audience's reach. */
interface ForeignPlace {
  target: OperationTarget
  place: TargetPlace & { projectId: string }
}

/**
 * Whether a read of `op` with `input` may run in the conversation of `audience`,
 * and what it hands out if so. See the module docstring. `carries` is the
 * read's `AUDIENCE_READS` entry, if it has one; `ownFolders` the conversation's
 * own project's record, computed once per request. A failed lookup rejects, and
 * the read must not run.
 */
export async function judgeWorkspaceRead(
  principal: AgentPrincipal,
  audience: ConversationAudience,
  op: Pick<AgentOperation, 'path' | 'spansProjects'> | null,
  input: TargetInput,
  carries: ReadCarries | undefined,
  ownFolders: () => Promise<string[]>,
): Promise<ReadJudgement> {
  // A shared conversation runs only reads whose answer is what every reader of the place reads.
  if (!audience.solo && (!op || !carries)) return refuse(READ_REFUSALS.shared)
  const targets = op ? namedTargets(principal, op, input) : []
  if (typeof targets === 'string') return refuse(targets)
  if (!audience.solo && targets.some((target) => target.type !== CARRIED_TARGET[carries as ReadCarries])) {
    return refuse(READ_REFUSALS.shared)
  }
  const { organizationId, userId } = principal.session
  return withTenant(tenantOf(principal), async () => {
    const places = await placesOf(organizationId, userId, targets)
    let touchesOwn = targets.length === 0
    const foreign: ForeignPlace[] = []
    for (const [index, place] of places.entries()) {
      const target = targets[index] as OperationTarget
      if (!place) {
        // This conversation's own first turn names it before its row exists.
        if (target.type === 'conversation' && target.id === principal.conversationId) {
          touchesOwn = true
          continue
        }
        // Not found as this reader is looked up here. The route may still find it with
        // another reader (a reviewer sees a held upload), and nothing here would record
        // where it lives, so it is refused rather than let through.
        return refuse(READ_REFUSALS.unknown)
      }
      const refused = await placeRefusal(principal, audience, place, organizationId)
      if (refused) return refuse(refused)
      const own = place.conversationId === principal.conversationId || place.projectId === (principal.projectId ?? null)
      if (own || !place.projectId) {
        touchesOwn = true
        if (!audience.solo) {
          const shut = await sharedOwnRefusal(organizationId, place, carries)
          if (shut) return refuse(shut)
        }
        continue
      }
      foreign.push({ target, place: { ...place, projectId: place.projectId } })
    }
    const handOut = await foreignHandOut(principal, audience, foreign, carries)
    if ('refusal' in handOut) return handOut
    const own = audience.solo && touchesOwn && principal.projectId ? await ownFolders() : []
    return {
      handOut: { projectIds: handOut.handOut.projectIds, folderIds: [...own, ...handOut.handOut.folderIds] },
    }
  })
}

/** What no audience lets through, whichever project a place lies in. */
async function placeRefusal(
  principal: AgentPrincipal,
  audience: ConversationAudience,
  place: TargetPlace,
  organizationId: string,
): Promise<string | null> {
  const other = place.conversationId !== null && place.conversationId !== principal.conversationId
  if (!other) return null
  // Another conversation's file or record is read by that conversation's readers, not this one's.
  if (!audience.solo) return READ_REFUSALS.notEveryReader
  return (await drewOnOtherProjects(place.conversationId as string, organizationId)) ? READ_REFUSALS.otherConversation : null
}

/**
 * In a shared conversation, a place of its own project (or of none): a listed
 * read of it may run only when everyone reading may read it, which its own
 * project's folder rule and screening decide. Outside every project there is
 * no rule every reader shares (the office shelf has its own folders), so it is
 * refused.
 */
async function sharedOwnRefusal(
  organizationId: string,
  place: TargetPlace,
  carries: ReadCarries | undefined,
): Promise<string | null> {
  if (!place.projectId) return READ_REFUSALS.notEveryReader
  if (carries !== 'document' || !place.document) return null
  if (!place.document.passedScreening) return READ_REFUSALS.notEveryReader
  const path = await restrictingPathOf(organizationId, place.projectId, place.document.folderId)
  return path.length > 0 ? READ_REFUSALS.restrictedFolder : null
}

/** The folders on a document's folder path that restrict reading: what a lookup's passage of it records. */
async function restrictingPathOf(organizationId: string, projectId: string, folderId: string | null): Promise<string[]> {
  if (!folderId) return []
  return readRestrictingFoldersOnPath(folderTree(await listProjectFolderTree(organizationId, projectId)), folderId)
}

/**
 * The places in other projects: each project must lie in the audience's reach
 * (`audienceReachAmong`, the lookups' own rule), and each place hands out its
 * project and the restricted folders it may carry. A shared conversation hands
 * out no restricted folder and no held file, so such a place is refused there.
 */
async function foreignHandOut(
  principal: AgentPrincipal,
  audience: ConversationAudience,
  foreign: readonly ForeignPlace[],
  carries: ReadCarries | undefined,
): Promise<ReadJudgement> {
  if (foreign.length === 0) return { handOut: { projectIds: [], folderIds: [] } }
  const projectIds = [...new Set(foreign.map(({ place }) => place.projectId))]
  const reach = await audienceReachAmong(principal.session, audience.row, projectIds)
  const inReach = new Set(reach.projects.map((project) => project.id))
  if (projectIds.some((projectId) => !inReach.has(projectId))) return refuse(READ_REFUSALS.outsideReach)
  const folderIds: string[] = []
  for (const { target, place } of foreign) {
    if (!reach.restrictedFolders && place.document && !place.document.passedScreening) {
      return refuse(READ_REFUSALS.notEveryReader)
    }
    const carried = await carriedFolders(principal, place, target, carries)
    if (carried.length > 0 && !reach.restrictedFolders) return refuse(READ_REFUSALS.restrictedFolder)
    folderIds.push(...carried)
  }
  return { handOut: { projectIds, folderIds } }
}

/**
 * The restricted folders of another project a read of `target` may carry: none
 * for a project's facts, a document's folder path for a read of that document
 * alone, and otherwise every folder of the project that restricts someone and
 * the asker may read (the route does not say which it drew on).
 */
async function carriedFolders(
  principal: AgentPrincipal,
  place: ForeignPlace['place'],
  target: OperationTarget,
  carries: ReadCarries | undefined,
): Promise<string[]> {
  if (carries === 'projectFacts' && target.type === 'project') return []
  if (carries === 'document' && target.type === 'document' && place.document) {
    return restrictingPathOf(principal.session.organizationId, place.projectId, place.document.folderId)
  }
  return restrictingFolders(principal.session, place.projectId)
}

/**
 * The folders of `projectId` that not every member may read and the requester
 * may: the ones a read as them could have drawn restricted content from. One
 * they may not read never reached them, and recording it would shut them out
 * of their own conversation.
 */
async function restrictingFolders(session: AgentPrincipal['session'], projectId: string): Promise<string[]> {
  const [rows, hidden] = await Promise.all([
    listProjectFolderTree(session.organizationId, projectId),
    getHiddenFolderIds(session, projectId),
  ])
  const tree = folderTree(rows)
  const unseen = new Set(hidden)
  return [...tree.keys()].filter((folderId) => !readableByEveryMember(tree, folderId) && !unseen.has(folderId))
}

/** The conversation's own project's record for a read in a solo conversation: see the module docstring. */
export async function ownRestrictingFolders(principal: AgentPrincipal): Promise<string[]> {
  if (!principal.projectId) return []
  const projectId = principal.projectId
  return withTenant(tenantOf(principal), () => restrictingFolders(principal.session, projectId))
}

/**
 * Record what a read hands out, before it runs: `recordCrossProjectHandOut`,
 * the lookups' own record, under the audience lock with the audience checked
 * against the one the read was judged for. False when the audience changed:
 * nothing was recorded, and the read must not run. A call outside a
 * conversation records nothing.
 */
export async function recordWorkspaceHandOut(
  principal: AgentPrincipal,
  audience: ConversationAudience,
  handOut: CrossProjectHandOut,
): Promise<boolean> {
  const conversationId = principal.conversationId
  if (!conversationId) return true
  const party = {
    organizationId: principal.session.organizationId,
    userId: principal.session.userId,
    conversationId,
    answerMessageId: principal.answerMessageId ?? null,
  }
  try {
    await withTenant(tenantOf(principal), () => recordCrossProjectHandOut(party, handOut, audience.key))
    return true
  } catch (error) {
    if (error instanceof CrossProjectAudienceChangedError) return false
    throw error
  }
}

/**
 * Why a write proposed in this conversation may not be filed here, or null.
 * The card sits in the transcript, so in a shared conversation every project a
 * proposal names, other than the conversation's own, must lie in the
 * audience's reach, the same reach a read is held to. In a solo conversation
 * the only reader is the requester, and `requireTargetsReadable` (they may
 * read every target) is the whole check. Call in the tenant scope.
 */
export async function proposalReachRefusal(
  party: { session: AgentPrincipal['session']; conversationId?: string | null; projectId?: string | null },
  targets: readonly OperationTarget[],
): Promise<string | null> {
  const { conversationId } = party
  if (!conversationId || targets.length === 0) return null
  const { organizationId, userId } = party.session
  const row = await readConversationAudience(getDb(), organizationId, conversationId)
  if (isSoloAudience(row, userId)) return null
  const places = await placesOf(organizationId, userId, targets)
  const own = party.projectId ?? row.projectId ?? null
  const projectIds = [
    ...new Set(places.flatMap((place) => (place?.projectId && place.projectId !== own ? [place.projectId] : []))),
  ]
  if (projectIds.length === 0) return null
  const reach = await audienceReachAmong(party.session, row, projectIds)
  const inReach = new Set(reach.projects.map((project) => project.id))
  return projectIds.every((projectId) => inReach.has(projectId)) ? null : READ_REFUSALS.proposalOutsideReach
}
