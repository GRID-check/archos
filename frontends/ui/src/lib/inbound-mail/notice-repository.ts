import 'server-only'
/**
 * What the E-Mail-Eingang's notices read before they are written or settled
 * (`./announce.ts`, ADR-0137). Ids and states only: no sender, subject or file
 * name is read here, because none may reach a row. Runs in the tenant scope
 * its caller opened; every read is bounded.
 */

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents, inboundMailParts, inboundMails, type InboundMailPartRow } from '@/lib/db/schema'
import type { DocumentReader } from '@/lib/documents/document-reader'
import { documentVisibleTo } from '@/lib/documents/visibility'

/** Which of a project's collapsed notices still describe mail that waits. */
export interface ProjectNoticeState {
  /** A mail of the project has a part still waiting for a person (`inbound_mail.waiting`). */
  waiting: boolean
  /** A mail the project's people were told expires (`expiring_notified_at`) still has a part waiting. */
  expiring: boolean
}

/**
 * Whether anything a project's `waiting` and `expiring` rows count still
 * waits. A part being filed was decided, so it does not count; a dismissed or
 * expired one is history (restorable, but nothing asks anyone to act).
 */
export async function projectNoticeState(projectId: string): Promise<ProjectNoticeState> {
  const [row] = await getDb()
    .select({
      waiting: sql<boolean>`bool_or(true)`,
      expiring: sql<boolean>`coalesce(bool_or(${inboundMails.expiringNotifiedAt} IS NOT NULL), false)`,
    })
    .from(inboundMails)
    .where(
      and(
        eq(inboundMails.projectId, projectId),
        eq(inboundMails.status, 'waiting'),
        sql`EXISTS (SELECT 1 FROM ${inboundMailParts} p WHERE p.mail_id = ${inboundMails.id} AND p.state = 'waiting')`,
      ),
    )
  return { waiting: row?.waiting === true, expiring: row?.expiring === true }
}

/**
 * The folders the filed parts of a mail went to, as their documents stand now
 * and as `reader` may read them (`null` is the project's root): a document
 * deleted since, or held from the reader by its screening, is not counted.
 */
export async function filedFolderIds(mailId: string, reader: DocumentReader): Promise<Array<string | null>> {
  const rows = await getDb()
    .select({ folderId: documents.folderId })
    .from(inboundMailParts)
    .innerJoin(documents, eq(documents.id, inboundMailParts.documentId))
    .where(
      and(
        eq(inboundMailParts.mailId, mailId),
        eq(inboundMailParts.state, 'filed'),
        isNotNull(inboundMailParts.documentId),
        documentVisibleTo(reader),
      ),
    )
    .limit(201)
  return rows.map((row) => row.folderId)
}

/** The parts' states of these mails, by mail: what a notice about the mail's outcome reads. */
export async function partStatesOf(mailIds: readonly string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(mailIds)].slice(0, 50)
  const byMail = new Map<string, string[]>()
  if (ids.length === 0) return byMail
  const rows = await getDb()
    .select({ mailId: inboundMailParts.mailId, state: inboundMailParts.state })
    .from(inboundMailParts)
    .where(inArray(inboundMailParts.mailId, ids))
    .limit(ids.length * 201)
  for (const row of rows) byMail.set(row.mailId, [...(byMail.get(row.mailId) ?? []), row.state])
  return byMail
}

/** Where each part of a mail stands now, and why its last filing failed: what the filing job tells its decider. */
export async function partOutcomesOf(mailId: string): Promise<Array<Pick<InboundMailPartRow, 'id' | 'state' | 'lastFailure'>>> {
  return getDb()
    .select({ id: inboundMailParts.id, state: inboundMailParts.state, lastFailure: inboundMailParts.lastFailure })
    .from(inboundMailParts)
    .where(eq(inboundMailParts.mailId, mailId))
    .limit(201)
}
