/**
 * A reply as the wire shows it (`AnnotationReplyView`), and the directory
 * lookup that names the people in it.
 */

import type { DocumentAnnotationReplyRow } from '@/lib/db/schema/document-annotations'
import type { AnnotationReplyView } from './types'
import { wakeOfReply, type WakeSpan } from './wake-attribution'

/** Display names by user id; empty when the directory cannot be read, which costs names and nothing else. */
export type Names = ReadonlyMap<string, { name: string }>

export const nameOf = (names: Names, userId: string | null) => (userId ? (names.get(userId)?.name ?? null) : null)

export function toReplyView(
  reply: DocumentAnnotationReplyRow,
  names: Names,
  wakes: readonly WakeSpan[]
): AnnotationReplyView {
  return {
    id: reply.id,
    annotationId: reply.annotationId,
    authorKind: reply.authorKind,
    body: reply.body,
    createdBy: reply.createdBy,
    createdByName: nameOf(names, reply.createdBy),
    createdAt: reply.createdAt.toISOString(),
    addressesPiloti: reply.addressesAgent,
    wokenBy: wakeOfReply(reply, wakes),
    mentions: reply.mentions,
    editedAt: reply.editedAt ? reply.editedAt.toISOString() : null,
  }
}
