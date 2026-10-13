/**
 * One person's thread about one document (ADR-0106): where Piloti's turns on
 * the review canvas run, whether the person asked in the canvas or a reply of
 * theirs woke Piloti with nobody's browser open.
 *
 * The id is derived (`documentThreadConversationId`, uuid5 of the document
 * and the person), so the canvas, the chat and the wake job name the same
 * thread without a lookup, and „ensure the thread" is an insert that does
 * nothing on conflict: the construction `lib/tasks/task-thread.ts` uses for a
 * standing task (ADR-0062). It replaces the per-tab id the canvas kept in
 * session storage, which no server could know.
 *
 * The thread is the person's own: private, created by them, with the document
 * as its subject. A wake runs in the thread of the person whose act woke
 * Piloti, never in somebody else's conversation, so a turn cannot read a
 * conversation its asker could not.
 */

import 'server-only'
import { ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationInOrg, insertConversation } from '@/lib/conversations/repository'
import type { Document } from '@/lib/db/schema'
import { documentThreadConversationId } from './wake-ids'

/** The longest title a thread gets from its document's name. */
const MAX_TITLE = 200

/**
 * The session's thread about `doc`, created when it does not exist yet. The
 * caller has read the document through its reader; a project document also
 * needs the right to chat in its project, as any conversation there does.
 */
export async function ensureDocumentThread(
  session: AuthorizedSession,
  doc: Pick<Document, 'id' | 'projectId' | 'filename' | 'displayName'>,
  title?: string | null
): Promise<string> {
  if (doc.projectId) await requireProjectAccess(session, doc.projectId, CHAT_PERMISSIONS)
  const id = documentThreadConversationId(doc.id, session.userId)
  const inserted = await insertConversation({
    id,
    organizationId: session.organizationId,
    createdBy: session.userId,
    title: (title?.trim() || doc.displayName?.trim() || doc.filename).slice(0, MAX_TITLE),
    projectId: doc.projectId ?? null,
    subjectResourceType: 'document',
    subjectResourceId: doc.id,
  })
  if (inserted) return id
  const existing = await findConversationInOrg(id, session.organizationId)
  // The id is the person's and the document's; a row that is not theirs
  // cannot carry it, and is not handed out.
  if (!existing || existing.createdBy !== session.userId) throw new NotFoundError()
  // Deleted, its erasure pending: the id comes free once the row is gone.
  if (existing.deletedAt) throw new ConflictError('This thread is being deleted. Try again in a few minutes.')
  return id
}
