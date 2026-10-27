import 'server-only'
/**
 * SQL of the E-Mail-Eingang's retention sweeps (ADR-0137, DECISION §5, `./sweep.ts`).
 *
 * Three kinds of statement, each named by its scope:
 *
 * - **Discovery** (`find…`) lists what is due across every organization. Its
 *   caller runs it under `withPlatformAccess`, and it returns ids, keys and
 *   flags, never a sender, subject or file name. Every list is bounded.
 * - **Per-row writes** run in the row's own tenant scope (`withTenant`), each a
 *   compare-and-set on the state discovery saw, so a person or a job that
 *   moved the row in between wins and the sweep changes nothing.
 * - **Deletes** (`delete…`) run as the platform role, because DELETE is revoked
 *   from the runtime role on these tables (migration 0186, „Ending is a
 *   state“). Each repeats its whole condition, the legal hold included.
 *
 * **Legal hold is a filter, the trigger the backstop (RT-S20).** Every set
 * that erases or deletes asks `grid_legal_hold_blocks` in its WHERE: a hold on
 * the project (`project`), and for a mail's bytes also a custodian hold on the
 * member it came from (`user`, `sender_user_id`). A held row is left out of
 * the set, or its erasure is deferred (`erasure_deferred_at`), so one held
 * project never makes a batch fail for every tenant; the triggers
 * (`GLH01`) still refuse whatever a later change forgets to filter.
 */

import { and, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  inboundMailAddresses,
  inboundMailDecisions,
  inboundMailParts,
  inboundMails,
  mailThreadFollows,
  type InboundMailDecisionRow,
  type InboundMailRow,
} from '@/lib/db/schema'
import { ignoredCounts } from './filing-repository'
import type {
  InboundMailCapNotice,
  InboundSenderTrust,
  SenderFlag,
} from './inbound-mail-vocabulary'
import type { StoredScan } from './repository'

const DAY_MS = 24 * 60 * 60 * 1000

/** No legal hold covers the mail's project: what every erasing or deleting set asks (`m` is `inbound_mails`). */
const mailProjectFree = sql`NOT grid_legal_hold_blocks('project', m.project_id::text, m.organization_id)`

/** No custodian hold covers the member the mail came from: its bytes are theirs to keep. */
const mailSenderFree = sql`(m.sender_user_id IS NULL OR NOT grid_legal_hold_blocks('user', m.sender_user_id, m.organization_id))`

/** Both: the mail's bytes may be erased now. */
const mailErasable = sql`${mailProjectFree} AND ${mailSenderFree}`

const rowsOf = <T>(result: Iterable<unknown>): T[] => Array.from(result) as T[]

async function select<T>(statement: SQL): Promise<T[]> {
  return rowsOf<T>(await getDb().execute(statement))
}

// ---------------------------------------------------------------------------
// Sweep 1: receptions that never finished
// ---------------------------------------------------------------------------

/** A reception older than its window: its object (when one was written) and the row go. */
export interface StaleReception {
  id: string
  organizationId: string
  stagingBucket: string
  rawStorageKey: string | null
}

/** `receiving` rows not touched since `before`, outside any held project. Platform scope. */
export async function findStaleReceptions(before: Date, limit: number): Promise<StaleReception[]> {
  return select<StaleReception>(sql`
    SELECT m.id, m.organization_id AS "organizationId", m.staging_bucket AS "stagingBucket",
           m.raw_storage_key AS "rawStorageKey"
      FROM inbound_mails m
     WHERE m.status = 'receiving' AND m.updated_at < ${before.toISOString()}::timestamptz
       AND ${mailProjectFree}
     ORDER BY m.updated_at
     LIMIT ${limit}`)
}

/** Delete a stale reception whose object is gone. Platform scope; whether it was deleted. */
export async function deleteStaleReception(id: string, before: Date): Promise<boolean> {
  const rows = await select<{ id: string }>(sql`
    DELETE FROM inbound_mails m
     WHERE m.id = ${id}::uuid AND m.status = 'receiving' AND m.updated_at < ${before.toISOString()}::timestamptz
       AND ${mailProjectFree}
    RETURNING m.id`)
  return rows.length === 1
}

// ---------------------------------------------------------------------------
// Sweep 2: received mail whose job is gone
// ---------------------------------------------------------------------------

/** A received mail with no job reading it; `deadJob` when its job gave up and is still on the queue. */
export interface OrphanedReception {
  id: string
  organizationId: string
  projectId: string
  deadJob: boolean
}

/**
 * `received` rows not touched since `before` whose job (its id is the mail's)
 * is gone or dead. A dead job keeps its id until the queue's retention prunes
 * it, and only then can the same id be queued again. Platform scope.
 */
export async function findReceivedWithoutJob(before: Date, limit: number): Promise<OrphanedReception[]> {
  return select<OrphanedReception>(sql`
    SELECT m.id, m.organization_id AS "organizationId", m.project_id AS "projectId",
           (j.status = 'dead') AS "deadJob"
      FROM inbound_mails m
      LEFT JOIN bff_job_queue j ON j.job_id = m.id
     WHERE m.status = 'received' AND m.updated_at < ${before.toISOString()}::timestamptz
       AND (j.job_id IS NULL OR j.status = 'dead')
     ORDER BY m.updated_at
     LIMIT ${limit}`)
}

// ---------------------------------------------------------------------------
// Sweeps 3 and 4: the window runs out
// ---------------------------------------------------------------------------

/** What a notice or the trail reads of a held mail: ids and labels only. */
export interface HeldMailFacts {
  id: string
  organizationId: string
  projectId: string
  senderTrust: InboundSenderTrust
  senderUserId: string | null
  senderFlags: SenderFlag[]
  automatic: boolean
}

const heldFacts = sql`m.id, m.organization_id AS "organizationId", m.project_id AS "projectId",
  m.sender_trust AS "senderTrust", m.sender_user_id AS "senderUserId", m.sender_flags AS "senderFlags",
  m.automatic`

const hasWaitingPart = sql`EXISTS (SELECT 1 FROM inbound_mail_parts p WHERE p.mail_id = m.id AND p.state = 'waiting')`

/** Held mail past its window with a part still waiting (sweep 3). Platform scope. */
export async function findExpiredMails(now: Date, limit: number): Promise<HeldMailFacts[]> {
  return select<HeldMailFacts>(sql`
    SELECT ${heldFacts} FROM inbound_mails m
     WHERE m.status = 'waiting' AND m.expires_at < ${now.toISOString()}::timestamptz AND ${hasWaitingPart}
     ORDER BY m.expires_at
     LIMIT ${limit}`)
}

/**
 * Expire what still waits of one mail (sweep 3): each waiting part `expired`,
 * restorable for seven days from now (D8). A part being filed is its job's.
 * Only while the window is still out (a restore may have moved it). The
 * number of parts expired.
 */
export async function expireMail(mailId: string, now: Date): Promise<number> {
  return getDb().transaction(async (tx) => {
    const [mail] = await tx
      .select({ id: inboundMails.id })
      .from(inboundMails)
      .where(and(eq(inboundMails.id, mailId), eq(inboundMails.status, 'waiting'), lt(inboundMails.expiresAt, now)))
      .for('update')
      .limit(1)
    if (!mail) return 0
    const expired = await tx
      .update(inboundMailParts)
      .set({ state: 'expired', endedAt: now, updatedAt: now })
      .where(and(eq(inboundMailParts.mailId, mailId), eq(inboundMailParts.state, 'waiting')))
      .returning({ id: inboundMailParts.id })
    if (expired.length > 0) await tx.update(inboundMails).set({ updatedAt: now }).where(eq(inboundMails.id, mailId))
    return expired.length
  })
}

/** How long before its end a held mail's people are told it expires: day 25 of 30 (D8). */
export const EXPIRING_NOTICE_BEFORE_MS = 5 * DAY_MS

/** Held mail within five days of its end, not told yet, with a part still waiting (sweep 4). Platform scope. */
export async function findExpiringMails(now: Date, limit: number): Promise<HeldMailFacts[]> {
  const from = new Date(now.getTime() + EXPIRING_NOTICE_BEFORE_MS)
  return select<HeldMailFacts>(sql`
    SELECT ${heldFacts} FROM inbound_mails m
     WHERE m.status = 'waiting' AND m.expiring_notified_at IS NULL AND m.sender_trust IS NOT NULL
       AND m.expires_at <= ${from.toISOString()}::timestamptz AND m.expires_at > ${now.toISOString()}::timestamptz
       AND ${hasWaitingPart}
     ORDER BY m.expires_at
     LIMIT ${limit}`)
}

/** Mark a mail told it expires, once: whether this call marked it (the caller then tells). */
export async function claimExpiringNotice(mailId: string, now: Date): Promise<boolean> {
  const rows = await getDb()
    .update(inboundMails)
    .set({ expiringNotifiedAt: now })
    .where(and(eq(inboundMails.id, mailId), eq(inboundMails.status, 'waiting'), isNull(inboundMails.expiringNotifiedAt)))
    .returning({ id: inboundMails.id })
  return rows.length === 1
}

// ---------------------------------------------------------------------------
// Sweep 5: filing claims that ran out
// ---------------------------------------------------------------------------

/** A part whose filing claim ran out, with the person whose filing it was. */
export interface LapsedClaim {
  partId: string
  decisionId: string
  mailId: string
  organizationId: string
  projectId: string
  decidedBy: string
}

/** Parts `filing` past their claim (the job died, or its person left). Platform scope. */
export async function findLapsedClaims(now: Date, limit: number): Promise<LapsedClaim[]> {
  return select<LapsedClaim>(sql`
    SELECT p.id AS "partId", p.decision_id AS "decisionId", p.mail_id AS "mailId",
           p.organization_id AS "organizationId", p.project_id AS "projectId", d.decided_by AS "decidedBy"
      FROM inbound_mail_parts p
      JOIN inbound_mail_decisions d ON d.id = p.decision_id
     WHERE p.state = 'filing' AND p.claim_expires_at < ${now.toISOString()}::timestamptz
     ORDER BY p.claim_expires_at
     LIMIT ${limit}`)
}

/** The part waits again, `unavailable`: only while it is still filing on the same, lapsed claim. */
export async function returnLapsedClaim(claim: LapsedClaim, now: Date): Promise<boolean> {
  const rows = await getDb()
    .update(inboundMailParts)
    .set({ state: 'waiting', decisionId: null, claimExpiresAt: null, lastFailure: 'unavailable', updatedAt: now })
    .where(
      and(
        eq(inboundMailParts.id, claim.partId),
        eq(inboundMailParts.state, 'filing'),
        eq(inboundMailParts.decisionId, claim.decisionId),
        lt(inboundMailParts.claimExpiresAt, now),
      ),
    )
    .returning({ id: inboundMailParts.id })
  return rows.length === 1
}

// ---------------------------------------------------------------------------
// Sweep 6: dismissed and expired parts past their seven days; settling
// ---------------------------------------------------------------------------

/** How long a dismissed or expired part can be restored (D8). */
export const RESTORE_WINDOW_MS = 7 * DAY_MS

/**
 * A dismissed or expired part is past restoring: seven days after it ended,
 * or at once for a dismissed part of mail from an unconfirmed outside domain
 * (D8: nobody vouched for it, and somebody said no).
 */
const pastRestore = (cutoff: Date) => sql`(p.ended_at < ${cutoff.toISOString()}::timestamptz
  OR (p.state = 'dismissed' AND m.sender_trust = 'external_unverified'))`

/** A staged object to erase, and whether a hold defers that. */
export interface EndedPartBytes {
  partId: string
  mailId: string
  organizationId: string
  stagingBucket: string
  storageKey: string
  held: boolean
}

/** Dismissed or expired parts past restoring that still hold bytes, not deferred yet. Platform scope. */
export async function findEndedPartBytes(now: Date, limit: number): Promise<EndedPartBytes[]> {
  return select<EndedPartBytes>(sql`
    SELECT p.id AS "partId", p.mail_id AS "mailId", p.organization_id AS "organizationId",
           m.staging_bucket AS "stagingBucket", p.storage_key AS "storageKey", NOT (${mailErasable}) AS held
      FROM inbound_mail_parts p
      JOIN inbound_mails m ON m.id = p.mail_id
     WHERE p.state IN ('dismissed', 'expired') AND p.storage_key IS NOT NULL AND p.erasure_deferred_at IS NULL
       AND ${pastRestore(new Date(now.getTime() - RESTORE_WINDOW_MS))}
     ORDER BY p.ended_at
     LIMIT ${limit}`)
}

const endedOrFiled = inArray(inboundMailParts.state, ['dismissed', 'expired', 'filed'])

/**
 * A part's bytes were erased (by their key): it forgets the key, the name that
 * goes with them and the suggestion that named them, and any deferral.
 */
export async function forgetPartBytes(partId: string, now: Date): Promise<boolean> {
  const rows = await getDb()
    .update(inboundMailParts)
    .set({ storageKey: null, filename: null, suggestion: null, suggestionTraceId: null, erasureDeferredAt: null, updatedAt: now })
    .where(and(eq(inboundMailParts.id, partId), endedOrFiled))
    .returning({ id: inboundMailParts.id })
  return rows.length === 1
}

/** A hold stopped the erasure of a part's bytes: sweep 10 erases them once it is released. */
export async function deferPartErasure(partId: string, now: Date): Promise<void> {
  await getDb()
    .update(inboundMailParts)
    .set({ erasureDeferredAt: now, updatedAt: now })
    .where(and(eq(inboundMailParts.id, partId), endedOrFiled, isNull(inboundMailParts.erasureDeferredAt)))
}

/** A held mail nothing of which can be decided or restored any more: settled and scrubbed next. */
export interface MailToSettle {
  id: string
  organizationId: string
  projectId: string
  held: boolean
}

/**
 * `waiting` mail with no part waiting or being filed, and none still
 * restorable (sweep 6). Includes mail every part of which was filed but whose
 * settle did not run. Platform scope.
 */
export async function findMailsToSettle(now: Date, limit: number): Promise<MailToSettle[]> {
  const cutoff = new Date(now.getTime() - RESTORE_WINDOW_MS)
  return select<MailToSettle>(sql`
    SELECT m.id, m.organization_id AS "organizationId", m.project_id AS "projectId", NOT (${mailErasable}) AS held
      FROM inbound_mails m
     WHERE m.status = 'waiting'
       AND EXISTS (SELECT 1 FROM inbound_mail_parts p WHERE p.mail_id = m.id)
       AND NOT EXISTS (
         SELECT 1 FROM inbound_mail_parts p
          WHERE p.mail_id = m.id
            AND (p.state IN ('waiting', 'filing')
                 OR (p.state IN ('dismissed', 'expired') AND NOT ${pastRestore(cutoff)})))
     ORDER BY m.updated_at
     LIMIT ${limit}`)
}

/** The row as the settle reads it. */
export async function findMailRow(mailId: string): Promise<InboundMailRow | null> {
  const [row] = await getDb().select().from(inboundMails).where(eq(inboundMails.id, mailId)).limit(1)
  return row ?? null
}

/**
 * Settle a mail nothing of which waits or can be restored: scrubbed to ids
 * (`inbound_mails_ended_is_scrubbed`), its staged objects forgotten (the
 * caller erased them by key first), unless a hold deferred the erasure, which
 * keeps the keys for sweep 10. A raw message still moving to its entry's
 * original is the move's (sweep 13). Only from `waiting`, and only while
 * nothing waits or is being filed; whether this call settled it.
 */
export async function settleEndedMail(mail: InboundMailRow, erasureDeferred: boolean, now: Date): Promise<boolean> {
  const rows = await getDb()
    .update(inboundMails)
    .set({
      status: 'settled',
      settledAt: now,
      senderAddress: null,
      senderName: null,
      subject: null,
      baseSubject: null,
      envelopeFrom: null,
      participants: [],
      participantDomains: [],
      notStaged: [],
      ignored: ignoredCounts(mail.notStaged, mail.ignored),
      ...(erasureDeferred
        ? { erasureDeferredAt: now }
        : { readStorageKey: null, ...(mail.originalMovePendingAt ? {} : { rawStorageKey: null }) }),
      updatedAt: now,
    })
    .where(
      and(
        eq(inboundMails.id, mail.id),
        eq(inboundMails.status, 'waiting'),
        sql`NOT EXISTS (SELECT 1 FROM ${inboundMailParts} p WHERE p.mail_id = ${inboundMails.id} AND p.state IN ('waiting', 'filing'))`,
      ),
    )
    .returning({ id: inboundMails.id })
  return rows.length === 1
}

// ---------------------------------------------------------------------------
// Sweep 7: scans that failed
// ---------------------------------------------------------------------------

/** How many times a failed scan is tried again, an hour apart (D16). */
export const RESCAN_ATTEMPTS = 24
export const RESCAN_AFTER_MS = 60 * 60 * 1000

/** A staged object whose scan failed and is due again. */
export interface FailedScan {
  /** The part's id, or the mail's for its raw message. */
  id: string
  kind: 'part' | 'raw'
  mailId: string
  organizationId: string
  stagingBucket: string
  storageKey: string
}

/** Waiting parts and held raw messages whose scan failed an hour ago or more, under the attempt cap. Platform scope. */
export async function findFailedScans(now: Date, limit: number): Promise<FailedScan[]> {
  const due = new Date(now.getTime() - RESCAN_AFTER_MS).toISOString()
  return select<FailedScan>(sql`
    (SELECT p.id, 'part' AS kind, p.mail_id AS "mailId", p.organization_id AS "organizationId",
            m.staging_bucket AS "stagingBucket", p.storage_key AS "storageKey"
       FROM inbound_mail_parts p
       JOIN inbound_mails m ON m.id = p.mail_id
      WHERE p.scan_status = 'failed' AND p.state = 'waiting' AND p.storage_key IS NOT NULL
        AND p.scan_attempts < ${RESCAN_ATTEMPTS} AND p.scanned_at < ${due}::timestamptz
      ORDER BY p.scanned_at
      LIMIT ${limit})
    UNION ALL
    (SELECT m.id, 'raw' AS kind, m.id AS "mailId", m.organization_id AS "organizationId",
            m.staging_bucket AS "stagingBucket", m.raw_storage_key AS "storageKey"
       FROM inbound_mails m
      WHERE m.raw_scan_status = 'failed' AND m.status = 'waiting' AND m.raw_storage_key IS NOT NULL
        AND m.raw_scan_attempts < ${RESCAN_ATTEMPTS} AND m.raw_scanned_at < ${due}::timestamptz
      ORDER BY m.raw_scanned_at
      LIMIT ${limit})`)
}

/** Store a repeated scan of a part, counted; only while its scan is still the failed one. */
export async function recordPartRescan(partId: string, scan: StoredScan): Promise<boolean> {
  const rows = await getDb()
    .update(inboundMailParts)
    .set({
      scanStatus: scan.status,
      scanEngine: scan.engine,
      scanSignature: scan.status === 'infected' ? scan.signature : null,
      scannedAt: scan.scannedAt,
      scanAttempts: sql`least(${inboundMailParts.scanAttempts} + 1, 100)`,
      updatedAt: new Date(),
    })
    .where(and(eq(inboundMailParts.id, partId), eq(inboundMailParts.scanStatus, 'failed'), eq(inboundMailParts.state, 'waiting')))
    .returning({ id: inboundMailParts.id })
  return rows.length === 1
}

/** Store a repeated scan of a held mail's raw message, counted; only while it is still the failed one. */
export async function recordRawRescan(mailId: string, scan: StoredScan): Promise<boolean> {
  const rows = await getDb()
    .update(inboundMails)
    .set({
      rawScanStatus: scan.status,
      rawScanEngine: scan.engine,
      rawScanSignature: scan.status === 'infected' ? scan.signature : null,
      rawScannedAt: scan.scannedAt,
      rawScanAttempts: sql`least(${inboundMails.rawScanAttempts} + 1, 100)`,
      updatedAt: new Date(),
    })
    .where(and(eq(inboundMails.id, mailId), eq(inboundMails.rawScanStatus, 'failed'), eq(inboundMails.status, 'waiting')))
    .returning({ id: inboundMails.id })
  return rows.length === 1
}

// ---------------------------------------------------------------------------
// Sweep 8: rows past their keep
// ---------------------------------------------------------------------------

/** How long a settled mail's ids are kept once none of its files lives, and a dropped mail's (D8). */
export const SETTLED_KEEP_MS = 30 * DAY_MS
export const DROPPED_KEEP_MS = 30 * DAY_MS

/**
 * Settled and dropped mail past its keep that may be deleted now (`m` is
 * `inbound_mails`): a settled mail only once no filed part names a live
 * document, any mail only once it names no object, none of its decisions is
 * still owed to the audit trail (RT-S8; sweep 11 runs first), and no hold
 * covers its project or its member.
 */
const mailDeletable = (now: Date) => {
  const settledBefore = new Date(now.getTime() - SETTLED_KEEP_MS).toISOString()
  const droppedBefore = new Date(now.getTime() - DROPPED_KEEP_MS).toISOString()
  return sql`((m.status = 'settled' AND m.settled_at < ${settledBefore}::timestamptz
               AND NOT EXISTS (SELECT 1 FROM inbound_mail_parts p WHERE p.mail_id = m.id AND p.document_id IS NOT NULL))
           OR (m.status = 'dropped' AND m.received_at < ${droppedBefore}::timestamptz))
    AND m.raw_storage_key IS NULL AND m.read_storage_key IS NULL
    AND m.erasure_deferred_at IS NULL AND m.original_move_pending_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM inbound_mail_parts p WHERE p.mail_id = m.id AND p.storage_key IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM inbound_mail_decisions d WHERE d.mail_id = m.id AND d.audited_at IS NULL)
    AND ${mailErasable}`
}

/** Settled and dropped mail past its keep (sweep 8). Platform scope. */
export async function findKeptMails(now: Date, limit: number): Promise<Array<{ id: string; organizationId: string }>> {
  return select<{ id: string; organizationId: string }>(sql`
    SELECT m.id, m.organization_id AS "organizationId" FROM inbound_mails m
     WHERE ${mailDeletable(now)}
     ORDER BY coalesce(m.settled_at, m.received_at)
     LIMIT ${limit}`)
}

/**
 * Delete these mails, as the platform role (sweep 8), each only if it still
 * may be: its parts and its (audited) decisions go with it. The ids deleted.
 */
export async function deleteKeptMails(ids: readonly string[], now: Date): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await select<{ id: string }>(sql`
    DELETE FROM inbound_mails m
     WHERE m.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) AND ${mailDeletable(now)}
    RETURNING m.id`)
  return rows.map((row) => row.id)
}

// ---------------------------------------------------------------------------
// Sweep 9: threads whose document is gone
// ---------------------------------------------------------------------------

/** How long a thread without a document is left alone: one being written gets its document in the same commit. */
export const ORPHANED_THREAD_AFTER_MS = 60 * 60 * 1000
/**
 * How long an archive Verlauf may wait for its first Fassung (`render_pending_at`)
 * once no import that wrote into it is open any more: past the import's stall
 * horizon and its backoff ladder, an import whose starter left never renders it.
 */
export const ABANDONED_RENDER_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * A thread may be deleted now (`t` is `mail_threads`): its document is gone
 * (deleted for good, so it is not in a bin either: a binned document keeps its
 * row), no archive slice is about to render it (an archive Verlauf waits for
 * its first Fassung with `render_pending_at`; one whose import is no longer
 * open and that waited a day is abandoned, D11), no writer holds its lease, no
 * hold covers its project, no follow of it is still running (sweep 12 ends
 * them first, audited), and no decision a follow of it made, nor any other
 * decision about a part such a decision filed, is still owed to the trail (the
 * cascade from its follows would take them along, RT-S8).
 */
const threadDeletable = (now: Date) => sql`
  t.document_id IS NULL
  AND (t.render_pending_at IS NULL
       OR (t.render_pending_at < ${new Date(now.getTime() - ABANDONED_RENDER_AFTER_MS).toISOString()}::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM mail_thread_entries e JOIN mail_imports i ON i.id = e.mail_import_id
              WHERE e.thread_id = t.id AND i.status IN ('uploading', 'queued', 'importing'))))
  AND (t.render_lease_until IS NULL OR t.render_lease_until < ${now.toISOString()}::timestamptz)
  AND NOT grid_legal_hold_blocks('project', t.project_id::text, t.organization_id)
  AND NOT EXISTS (SELECT 1 FROM mail_thread_follows f WHERE f.thread_id = t.id AND f.ended_at IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM mail_thread_follows f
      JOIN inbound_mail_decisions d ON d.follow_id = f.id
      JOIN inbound_mail_decisions owed ON owed.part_id = d.part_id
     WHERE f.thread_id = t.id AND owed.audited_at IS NULL)`

/** A thread to delete, and the originals its entries keep. */
export interface OrphanedThread {
  id: string
  organizationId: string
  originals: Array<{ bucket: string; key: string }>
}

/** Threads whose document is gone, past the grace, that may be deleted now. Platform scope. */
export async function findOrphanedThreads(now: Date, limit: number): Promise<OrphanedThread[]> {
  const before = new Date(now.getTime() - ORPHANED_THREAD_AFTER_MS).toISOString()
  const rows = await select<{ id: string; organizationId: string; originals: Array<{ bucket: string; key: string }> | null }>(sql`
    SELECT t.id, t.organization_id AS "organizationId",
           (SELECT json_agg(json_build_object('bucket', e.original_bucket, 'key', e.original_storage_key))
              FROM mail_thread_entries e
             WHERE e.thread_id = t.id AND e.original_storage_key IS NOT NULL) AS originals
      FROM mail_threads t
     WHERE t.created_at < ${before}::timestamptz AND ${threadDeletable(now)}
     ORDER BY t.created_at
     LIMIT ${limit}`)
  return rows.map((row) => ({ ...row, originals: row.originals ?? [] }))
}

/**
 * Delete a thread whose originals were erased (sweep 9), as the platform role:
 * the cascade takes its entries, what came with them, its message ids, its
 * ended follows and their audited decisions. Repeats the whole condition;
 * the number of entries it took, or null when it was not deleted.
 */
export async function deleteOrphanedThread(id: string, now: Date): Promise<number | null> {
  const rows = await select<{ entries: number | string }>(sql`
    WITH gone AS (
      DELETE FROM mail_threads t WHERE t.id = ${id}::uuid AND ${threadDeletable(now)} RETURNING t.id)
    SELECT (SELECT count(*) FROM mail_thread_entries e WHERE e.thread_id IN (SELECT id FROM gone)) AS entries,
           (SELECT count(*) FROM gone) AS deleted`)
  const [row] = rows as Array<{ entries: number | string; deleted: number | string }>
  return row && Number(row.deleted) === 1 ? Number(row.entries) : null
}

// ---------------------------------------------------------------------------
// Sweep 10: erasures a hold deferred, once it is released
// ---------------------------------------------------------------------------

/** A deferred erasure no hold stops any more: a part's bytes, or an ended mail's staged objects. */
export interface DeferredErasure {
  id: string
  kind: 'part' | 'mail'
  organizationId: string
  stagingBucket: string
  keys: string[]
}

/** Deferred erasures whose hold was released. Platform scope. */
export async function findReleasedErasures(limit: number): Promise<DeferredErasure[]> {
  const rows = await select<{ id: string; kind: 'part' | 'mail'; organizationId: string; stagingBucket: string; keys: Array<string | null> }>(sql`
    (SELECT p.id, 'part' AS kind, p.organization_id AS "organizationId", m.staging_bucket AS "stagingBucket",
            ARRAY[p.storage_key] AS keys
       FROM inbound_mail_parts p
       JOIN inbound_mails m ON m.id = p.mail_id
      WHERE p.erasure_deferred_at IS NOT NULL AND p.state IN ('filed', 'dismissed', 'expired') AND ${mailErasable}
      ORDER BY p.erasure_deferred_at
      LIMIT ${limit})
    UNION ALL
    (SELECT m.id, 'mail' AS kind, m.organization_id AS "organizationId", m.staging_bucket AS "stagingBucket",
            ARRAY[m.read_storage_key, CASE WHEN m.original_move_pending_at IS NULL THEN m.raw_storage_key END] AS keys
       FROM inbound_mails m
      WHERE m.erasure_deferred_at IS NOT NULL AND m.status IN ('settled', 'dropped') AND ${mailErasable}
      ORDER BY m.erasure_deferred_at
      LIMIT ${limit})`)
  return rows.map((row) => ({ ...row, keys: row.keys.filter((key): key is string => key !== null) }))
}

/**
 * An ended mail's deferred objects were erased: it forgets their keys and the
 * deferral. A raw message still moving to its entry's original stays the
 * move's (sweep 13).
 */
export async function forgetDeferredMailObjects(mailId: string, now: Date): Promise<boolean> {
  const rows = await getDb()
    .update(inboundMails)
    .set({
      readStorageKey: null,
      rawStorageKey: sql`CASE WHEN ${inboundMails.originalMovePendingAt} IS NULL THEN NULL ELSE ${inboundMails.rawStorageKey} END`,
      erasureDeferredAt: null,
      updatedAt: now,
    })
    .where(and(eq(inboundMails.id, mailId), inArray(inboundMails.status, ['settled', 'dropped'])))
    .returning({ id: inboundMails.id })
  return rows.length === 1
}

// ---------------------------------------------------------------------------
// Sweep 11: decisions still owed to the audit trail
// ---------------------------------------------------------------------------

/** Decisions not audited since `before` (the request that made them sends them first). Platform scope. */
export async function findUnauditedDecisions(before: Date, limit: number): Promise<InboundMailDecisionRow[]> {
  return getDb()
    .select()
    .from(inboundMailDecisions)
    .where(and(isNull(inboundMailDecisions.auditedAt), lt(inboundMailDecisions.decidedAt, before)))
    .orderBy(inboundMailDecisions.decidedAt)
    .limit(limit)
}

// ---------------------------------------------------------------------------
// Sweep 12: follows
// ---------------------------------------------------------------------------

/** A running follow due to end, or to be asked to renew. */
export interface DueFollow {
  id: string
  organizationId: string
  projectId: string
  threadId: string
  userId: string
  threadDocumentId: string | null
}

const followFacts = sql`f.id, f.organization_id AS "organizationId", f.project_id AS "projectId",
  f.thread_id AS "threadId", f.user_id AS "userId", t.document_id AS "threadDocumentId"`

/** Running follows past their end, or whose thread's document is gone. Platform scope. */
export async function findEndingFollows(now: Date, limit: number): Promise<Array<DueFollow & { reason: 'expired' | 'document_gone' }>> {
  return select<DueFollow & { reason: 'expired' | 'document_gone' }>(sql`
    SELECT ${followFacts},
           CASE WHEN t.document_id IS NULL THEN 'document_gone' ELSE 'expired' END AS reason
      FROM mail_thread_follows f
      JOIN mail_threads t ON t.id = f.thread_id
     WHERE f.ended_at IS NULL
       AND (f.expires_at < ${now.toISOString()}::timestamptz OR t.document_id IS NULL)
     ORDER BY f.expires_at
     LIMIT ${limit}`)
}

/** How long before its end a follower is asked to renew: day 55 of 60 (D31). */
export const FOLLOW_EXPIRING_BEFORE_MS = 5 * DAY_MS

/** Running follows within five days of their end, not asked yet, on a live thread. Platform scope. */
export async function findExpiringFollows(now: Date, limit: number): Promise<DueFollow[]> {
  const from = new Date(now.getTime() + FOLLOW_EXPIRING_BEFORE_MS).toISOString()
  return select<DueFollow>(sql`
    SELECT ${followFacts}
      FROM mail_thread_follows f
      JOIN mail_threads t ON t.id = f.thread_id
     WHERE f.ended_at IS NULL AND f.expiring_notified_at IS NULL AND t.document_id IS NOT NULL
       AND f.expires_at <= ${from}::timestamptz AND f.expires_at > ${now.toISOString()}::timestamptz
     ORDER BY f.expires_at
     LIMIT ${limit}`)
}

/** Mark a follow asked to renew, once: whether this call marked it (the caller then asks). */
export async function claimFollowExpiringNotice(followId: string, now: Date): Promise<boolean> {
  const rows = await getDb()
    .update(mailThreadFollows)
    .set({ expiringNotifiedAt: now })
    .where(and(eq(mailThreadFollows.id, followId), isNull(mailThreadFollows.endedAt), isNull(mailThreadFollows.expiringNotifiedAt)))
    .returning({ id: mailThreadFollows.id })
  return rows.length === 1
}

// ---------------------------------------------------------------------------
// Sweep 13: originals whose move stopped half-way
// ---------------------------------------------------------------------------

/** A mail whose raw message was being moved to its entry's original when the run stopped. */
export interface StalledMove {
  id: string
  organizationId: string
  projectId: string
}

/** Moves pending since `before`. Platform scope. */
export async function findStalledMoves(before: Date, limit: number): Promise<StalledMove[]> {
  return select<StalledMove>(sql`
    SELECT m.id, m.organization_id AS "organizationId", m.project_id AS "projectId"
      FROM inbound_mails m
     WHERE m.original_move_pending_at < ${before.toISOString()}::timestamptz
     ORDER BY m.original_move_pending_at
     LIMIT ${limit}`)
}

// ---------------------------------------------------------------------------
// The caps (D18): what each address's managers were told
// ---------------------------------------------------------------------------

/** An address whose staged bytes call for a notice, or whose notice is out of date. */
export interface AddressCapState {
  id: string
  organizationId: string
  projectId: string
  revoked: boolean
  capNotice: InboundMailCapNotice | null
  addressBytes: number
  organizationBytes: number
}

/**
 * Every address at 80% of its cap or whose organization is at 80% of its own,
 * and every address that was told and may need settling. The bytes are
 * counted as the webhook counts them (`stagedBytes`): raw messages of mail
 * arriving, received or waiting. Platform scope.
 */
export async function findAddressCapStates(
  caps: { address: number; organization: number },
  limit: number,
): Promise<AddressCapState[]> {
  const rows = await select<Omit<AddressCapState, 'addressBytes' | 'organizationBytes'> & { addressBytes: string; organizationBytes: string }>(sql`
    WITH staged AS (
      SELECT organization_id, address_id, sum(raw_size_bytes) AS bytes
        FROM inbound_mails
       WHERE status IN ('receiving', 'received', 'waiting') AND raw_storage_key IS NOT NULL
       GROUP BY organization_id, address_id),
    per_org AS (SELECT organization_id, sum(bytes) AS bytes FROM staged GROUP BY organization_id)
    SELECT a.id, a.organization_id AS "organizationId", a.project_id AS "projectId",
           (a.revoked_at IS NOT NULL) AS revoked, a.cap_notice AS "capNotice",
           coalesce(s.bytes, 0) AS "addressBytes", coalesce(o.bytes, 0) AS "organizationBytes"
      FROM inbound_mail_addresses a
      LEFT JOIN staged s ON s.address_id = a.id
      LEFT JOIN per_org o ON o.organization_id = a.organization_id
     WHERE a.cap_notice IS NOT NULL
        OR (a.revoked_at IS NULL
            AND (coalesce(s.bytes, 0) >= ${Math.floor(caps.address * 0.8)}
                 OR coalesce(o.bytes, 0) >= ${Math.floor(caps.organization * 0.8)}))
     ORDER BY a.id
     LIMIT ${limit}`)
  return rows.map((row) => ({ ...row, addressBytes: Number(row.addressBytes), organizationBytes: Number(row.organizationBytes) }))
}

/**
 * Record what the address's managers are told now, from what they were told
 * (compare-and-set): whether this call changed it.
 */
export async function setCapNotice(
  addressId: string,
  from: InboundMailCapNotice | null,
  to: InboundMailCapNotice | null,
  now: Date,
): Promise<boolean> {
  const rows = await getDb()
    .update(inboundMailAddresses)
    .set({ capNotice: to, capNoticedAt: to ? now : null })
    .where(
      and(
        eq(inboundMailAddresses.id, addressId),
        from === null ? isNull(inboundMailAddresses.capNotice) : eq(inboundMailAddresses.capNotice, from),
      ),
    )
    .returning({ id: inboundMailAddresses.id })
  return rows.length === 1
}
