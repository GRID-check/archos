import 'server-only'
/**
 * Whom an Anmerkung's text or a reply in its thread mentions, as the server
 * keeps it (migration 0150).
 *
 * The composer sends what the person PICKED in the chat's „@" picker:
 * `{ targetId, display }`, the chat's own mention shape. Nothing here takes
 * that on trust, and nothing reads a name out of the text (the chat's rule,
 * MN-3: text that merely looks like „@Anna" mentions nobody). A mention is
 * kept only when
 *
 * - its „@Name" token still stands in the text (`reconcileMentions`, the
 *   chat's own reconcile pass, so the two cannot disagree about what a token is);
 * - the name is the one the organization's directory has for that person, so a
 *   crafted request cannot draw a chip that names somebody else;
 * - the person may open the document now (`mayOpenDocument`, the rule that
 *   decides who may be made Zuständige and who hears about a mark at all).
 *   Piloti is kept by its product name alone, and only in a reply: a reply
 *   addresses Piloti, a mark's own text wakes nobody.
 * - the organization has collaboration on, the gate the candidates route and
 *   the chat keep (`isCollaborationEnabled`); without it a text mentions
 *   nobody but Piloti.
 *
 * What is dropped is simply not stored: its „@Name" stays plain text, and the
 * composer, comparing what it sent with what came back, says who was not told.
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import { isCollaborationEnabled } from '@/lib/authz/feature-flags'
import { PRODUCT_NAME } from '@/lib/brand'
import { mayOpenDocument, type OpenableDocument } from '@/lib/documents/may-open'
import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { reconcileMentions } from '@/lib/mentions/mention-text'
import type { MarkMention } from './types'

/**
 * The mentions whose token still stands in `text`, once per person, in text
 * order. Pure: naming somebody twice is emphasis, and the chip needs only one
 * entry to draw every occurrence of the same name.
 */
export function standingMentions(text: string, mentions: readonly MarkMention[]): MarkMention[] {
  const seen = new Set<string>()
  return reconcileMentions(text, mentions).filter((mention) => {
    if (seen.has(mention.targetId)) return false
    seen.add(mention.targetId)
    return true
  })
}

/**
 * The mentions of a write the server stores: standing in the text, named as
 * the directory names them, able to open the document. `piloti`: the write is
 * a reply, where Piloti may be addressed.
 */
export async function keepMentions(
  session: AuthorizedSession,
  doc: OpenableDocument,
  text: string,
  submitted: readonly MarkMention[],
  { piloti }: { piloti: boolean }
): Promise<MarkMention[]> {
  const standing = standingMentions(text, submitted)
  const isPiloti = (mention: MarkMention) => mention.targetId === AGENT_MENTION_ID
  const keptPiloti = (mention: MarkMention) => piloti && mention.display === PRODUCT_NAME
  const people = isCollaborationEnabled(session) ? standing.filter((mention) => !isPiloti(mention)) : []
  if (people.length === 0) return standing.filter((mention) => isPiloti(mention) && keptPiloti(mention))
  const directory = await loadOrganizationDirectory(session.organizationId)
  const named = people.filter((mention) => directory.get(mention.targetId)?.name === mention.display)
  const mayOpen = await mayOpenDocument(
    session,
    doc,
    named.map((mention) => mention.targetId)
  )
  return standing.filter((mention) =>
    isPiloti(mention) ? keptPiloti(mention) : named.includes(mention) && mayOpen.has(mention.targetId)
  )
}

/**
 * The people `after` mentions that `before` did not, minus whoever wrote it:
 * the ones a write tells. Mentioning yourself tells nobody, and an edit tells
 * only the people it adds. Pure.
 */
export function newlyMentioned(
  after: readonly MarkMention[],
  before: readonly MarkMention[],
  writerUserId: string
): string[] {
  const already = new Set(before.map((mention) => mention.targetId))
  return [
    ...new Set(
      after
        .map((mention) => mention.targetId)
        .filter((targetId) => targetId !== AGENT_MENTION_ID && targetId !== writerUserId && !already.has(targetId))
    ),
  ]
}

/** Whether these mentions address Piloti: its chip, as the reply's `addresses_agent` records it. */
export const mentionsPiloti = (mentions: readonly MarkMention[]): boolean =>
  mentions.some((mention) => mention.targetId === AGENT_MENTION_ID)

/**
 * The people `before` mentioned whom nothing on the mark mentions any more
 * (`remaining`: the mark's text and every reply left, as they stand after the
 * write). Their mention was answered by its own removal: its row goes inert.
 * Pure.
 */
export function noLongerMentioned(
  before: readonly MarkMention[],
  remaining: ReadonlyArray<readonly MarkMention[]>
): string[] {
  const still = new Set(remaining.flat().map((mention) => mention.targetId))
  return [
    ...new Set(
      before
        .map((mention) => mention.targetId)
        .filter((targetId) => targetId !== AGENT_MENTION_ID && !still.has(targetId))
    ),
  ]
}
