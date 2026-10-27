import 'server-only'
/**
 * SQL the Outlook archive import writes its E-Mail-Verläufe with (D33,
 * `./archive.ts`): the Message-ID dedupe, an entry recorded all at once, the
 * threads an import still owes a Fassung, and that Fassung recorded. No
 * authorization here: the import runs as the person who started it and asks
 * their rights in `./archive.ts`; row-level security is the backstop. Every
 * list is bounded.
 *
 * The rules the rows keep are migration 0188's: an archive entry is
 * `source = 'archive'`, `filed_via = 'archive_import'`, `not_checked`, names
 * its import and has no original; DELETE is revoked, so nothing here takes an
 * entry back. An entry's id is the import's and the mail's (uuid5), so a retry
 * finds its own row and changes nothing.
 */

import { and, eq, exists, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  mailThreadEntries,
  mailThreadEntryAttachments,
  mailThreads,
  type MailThreadRow,
  type NewMailThreadEntryAttachmentRow,
  type NewMailThreadEntryRow,
  type NewMailThreadRow,
} from '@/lib/db/schema'
import { insertMessageIds } from './write-repository'

/** Threads one slice renders at most; the rest wait for the next slice, still pending. */
export const ARCHIVE_PENDING_THREADS_LIMIT = 200

/**
 * Another entry of the project that received this Message-ID, in a Verlauf
 * that has a Fassung or is about to get one (D33's dedupe). An entry whose
 * thread never got its first Fassung and no longer waits for one (an archive
 * Verlauf whose name the upload path refused) holds nothing a person can read,
 * so it is no reason to skip a mail. `exceptEntryId` is the mail's own entry:
 * a retry is not its own duplicate.
 */
export async function findEntryWithMessageId(
  projectId: string,
  messageId: string,
  exceptEntryId: string
): Promise<{ entryId: string; threadId: string } | null> {
  const [row] = await getDb()
    .select({ entryId: mailThreadEntries.id, threadId: mailThreadEntries.threadId })
    .from(mailThreadEntries)
    .innerJoin(mailThreads, eq(mailThreads.id, mailThreadEntries.threadId))
    .where(
      and(
        eq(mailThreadEntries.projectId, projectId),
        eq(mailThreadEntries.messageId, messageId),
        ne(mailThreadEntries.id, exceptEntryId),
        or(isNotNull(mailThreads.documentId), isNotNull(mailThreads.renderPendingAt))
      )
    )
    .limit(1)
  return row ?? null
}

/** The entry with this id, wherever it is: the mail's own, written by an earlier run of its slice. */
export async function findArchiveEntry(
  projectId: string,
  entryId: string
): Promise<{ id: string; threadId: string } | null> {
  const [row] = await getDb()
    .select({ id: mailThreadEntries.id, threadId: mailThreadEntries.threadId })
    .from(mailThreadEntries)
    .where(and(eq(mailThreadEntries.projectId, projectId), eq(mailThreadEntries.id, entryId)))
    .limit(1)
  return row ?? null
}

/** Whether the import wrote an entry into the thread before this one: its first mail there is the one counted. */
export async function importWroteInto(
  threadId: string,
  importId: string,
  exceptEntryId: string
): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: mailThreadEntries.id })
    .from(mailThreadEntries)
    .where(
      and(
        eq(mailThreadEntries.threadId, threadId),
        eq(mailThreadEntries.mailImportId, importId),
        ne(mailThreadEntries.id, exceptEntryId)
      )
    )
    .limit(1)
  return Boolean(row)
}

/** Everything one archived mail writes, in one transaction. */
export interface ArchiveEntryCommit {
  /** A Verlauf the mail opens (no document until the slice renders it), or null to join `entry.threadId`. */
  newThread: NewMailThreadRow | null
  entry: NewMailThreadEntryRow
  messageIds: { received: string | null; referenced: readonly string[] }
  /** One row per attachment the mail carried, whatever became of it (D36). */
  attachments: readonly NewMailThreadEntryAttachmentRow[]
}

/**
 * Record an archived mail, all or nothing: its Verlauf when it opens one, the
 * entry, its Message-IDs, what came with it, and the Verlauf marked as owing a
 * Fassung (`render_pending_at`), which the slice's end writes. A second commit
 * of the same entry (a retried mail) finds it and changes nothing.
 */
export async function commitArchiveEntry(commit: ArchiveEntryCommit): Promise<'committed' | 'already'> {
  return getDb().transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: mailThreadEntries.id })
      .from(mailThreadEntries)
      .where(eq(mailThreadEntries.id, commit.entry.id!))
      .limit(1)
    if (existing) return 'already'
    if (commit.newThread) await tx.insert(mailThreads).values(commit.newThread).onConflictDoNothing()
    await tx.insert(mailThreadEntries).values(commit.entry)
    await insertMessageIds(tx, commit.entry, commit.messageIds)
    if (commit.attachments.length > 0) await tx.insert(mailThreadEntryAttachments).values([...commit.attachments])
    await tx
      .update(mailThreads)
      .set({ renderPendingAt: sql`coalesce(${mailThreads.renderPendingAt}, now())` })
      .where(eq(mailThreads.id, commit.entry.threadId))
    return 'committed'
  })
}

/**
 * The Verläufe this import wrote entries into that still owe a Fassung, oldest
 * first. Asked by import, not remembered by the slice, so a slice that died
 * before its end leaves them to the next one.
 */
export async function findPendingThreadsOfImport(
  importId: string,
  limit = ARCHIVE_PENDING_THREADS_LIMIT
): Promise<MailThreadRow[]> {
  return getDb()
    .select()
    .from(mailThreads)
    .where(
      and(
        isNotNull(mailThreads.renderPendingAt),
        exists(
          getDb()
            .select({ one: sql`1` })
            .from(mailThreadEntries)
            .where(
              and(eq(mailThreadEntries.threadId, mailThreads.id), eq(mailThreadEntries.mailImportId, importId))
            )
        )
      )
    )
    .orderBy(mailThreads.renderPendingAt, mailThreads.id)
    .limit(limit)
}

/** A Verlauf's Fassung the slice wrote: the thread's counters and document, and the entries it first holds. */
export interface ArchiveRenderCommit {
  threadId: string
  documentId: string
  versionId: string | null
  entryCount: number
  renderedBytes: number
  lastEntryAt: Date
  participantDomains: string[]
}

/**
 * Record a rendered Fassung, all at once: the thread names its document and
 * no longer owes one, and every entry not in an earlier Fassung names this
 * one as the one it first appeared in.
 */
export async function commitArchiveRender(commit: ArchiveRenderCommit): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx
      .update(mailThreads)
      .set({
        documentId: commit.documentId,
        entryCount: commit.entryCount,
        renderedBytes: commit.renderedBytes,
        lastEntryAt: commit.lastEntryAt,
        participantDomains: commit.participantDomains,
        renderPendingAt: null,
      })
      .where(eq(mailThreads.id, commit.threadId))
    if (commit.versionId) {
      await tx
        .update(mailThreadEntries)
        .set({ firstVersionId: commit.versionId })
        .where(and(eq(mailThreadEntries.threadId, commit.threadId), isNull(mailThreadEntries.firstVersionId)))
    }
  })
}

/**
 * The thread no longer owes the import a Fassung: the upload path refused it
 * for a reason a retry repeats. An archive Verlauf that never got a document
 * is then the retention sweep's (sweep 9 takes a thread without a document);
 * an existing one renders the entries with its next Fassung, whoever writes it.
 */
export async function giveUpPendingRender(threadId: string): Promise<void> {
  await getDb().update(mailThreads).set({ renderPendingAt: null }).where(eq(mailThreads.id, threadId))
}

/** Whether another thread than `threadId` names this document as its Verlauf. */
export async function threadHoldingDocument(documentId: string, threadId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: mailThreads.id })
    .from(mailThreads)
    .where(and(eq(mailThreads.documentId, documentId), ne(mailThreads.id, threadId)))
    .limit(1)
  return Boolean(row)
}
