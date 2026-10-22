/**
 * SQL for the E-Mail-Eingang (ADR-0134, migration 0184). No authorization
 * here: the service decides who may ask, and row-level security is the
 * backstop. Every list is bounded.
 *
 * Every function runs in the tenant scope its caller opened, with one exception
 * that says so: {@link findActiveAddressByToken} is the lookup that happens
 * BEFORE any organization is known, and its caller wraps it in
 * `withPlatformAccess`. A function that may run inside a caller's transaction
 * takes its executor rather than calling `getDb()` (`transaction-shape.spec.ts`).
 *
 * The rules a row must keep (a waiting mail was scanned, a member is named
 * exactly when the From address is one, a settled or dropped mail names no
 * third party, every object key is the row's own) are CHECKs in the migration.
 * The functions here write rows that keep them, and a row that does not is a
 * refused statement rather than a quiet inconsistency.
 *
 * This module is shared by the packages that build the feature: the webhook
 * and the receive job (below) first; the review service, the filing and follow
 * jobs and the sweeps add their own sections.
 */

import 'server-only'
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { isUniqueViolation } from '@/lib/db/errors'
import type { DbExecutor } from '@/lib/db/executor'
import {
  documents,
  inboundMailAddresses,
  inboundMailParts,
  inboundMails,
  mailThreadEntries,
  mailThreadFollows,
  mailThreadMessageIds,
  mailThreads,
  projects,
  type InboundMailRow,
  type NewInboundMailPartRow,
  type NewInboundMailRow,
} from '@/lib/db/schema'
import { documentVisibleTo, SCREENED_ONLY } from '@/lib/documents/visibility'
import { insertJobIfAbsent } from '@/lib/jobs-queue/repository'
import { BFF_JOB_PRIORITY } from '@/lib/jobs-queue/types'
import type { FollowRow } from '@/lib/mail-thread/follow-eligibility'
import type { ThreadCandidate } from '@/lib/mail-thread/mail-threading'
import type { MalwareScanStatus } from './inbound-mail-vocabulary'

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

/** What the webhook learns from a token, and nothing more. */
export interface ResolvedInboundAddress {
  addressId: string
  organizationId: string
  projectId: string
}

/**
 * The active address a token names, in whichever organization owns it.
 *
 * Cross-tenant by nature, the token being all the webhook has, so the caller
 * runs it under the platform bypass, and it returns ONLY the ids the rest of
 * the request needs to open a tenant scope. A revoked token and a token whose
 * project is deleted resolve to nothing: the same answer as a token nobody
 * ever minted. A closed project resolves: it holds its mail (RT-X13).
 */
export async function findActiveAddressByToken(token: string): Promise<ResolvedInboundAddress | null> {
  const [row] = await getDb()
    .select({
      addressId: inboundMailAddresses.id,
      organizationId: inboundMailAddresses.organizationId,
      projectId: inboundMailAddresses.projectId,
    })
    .from(inboundMailAddresses)
    .innerJoin(
      projects,
      and(eq(projects.id, inboundMailAddresses.projectId), eq(projects.organizationId, inboundMailAddresses.organizationId)),
    )
    .where(and(eq(inboundMailAddresses.token, token), isNull(inboundMailAddresses.revokedAt), isNull(projects.deletedAt)))
    .limit(1)
  return row ?? null
}

/** The statuses whose raw message is staged: arriving, read by no job yet, or waiting for a person. */
const STAGED_STATUSES = ['receiving', 'received', 'waiting'] as const

/** Raw bytes staged now, for one address and for its whole organization (D18's byte caps). */
export interface StagedBytes {
  address: number
  organization: number
}

/**
 * The raw message bytes staged for this address and for its organization: the
 * sum of `raw_size_bytes` over mail that is arriving, received or waiting. A
 * reception is counted from its insert (the size is its signed length), so a
 * burst of large mails cannot all pass the cap before any of them is written.
 * Attachment parts are copies of bytes inside the raw message and are not
 * counted twice.
 */
export async function stagedBytes(organizationId: string, addressId: string): Promise<StagedBytes> {
  const [row] = await getDb()
    .select({
      address: sql<string>`coalesce(sum(${inboundMails.rawSizeBytes}) filter (where ${inboundMails.addressId} = ${addressId}), 0)`,
      organization: sql<string>`coalesce(sum(${inboundMails.rawSizeBytes}), 0)`,
    })
    .from(inboundMails)
    .where(
      and(
        eq(inboundMails.organizationId, organizationId),
        inArray(inboundMails.status, [...STAGED_STATUSES]),
        isNotNull(inboundMails.rawStorageKey),
      ),
    )
  return { address: Number(row?.address ?? 0), organization: Number(row?.organization ?? 0) }
}

/** A delivery the webhook is about to stream to staging. */
export type NewReception = Pick<
  NewInboundMailRow,
  | 'id'
  | 'organizationId'
  | 'projectId'
  | 'addressId'
  | 'envelopeFrom'
  | 'rawSizeBytes'
  | 'stagingBucket'
  | 'rawStorageKey'
  | 'receivedAt'
  | 'expiresAt'
>

/**
 * Insert the `receiving` row before a byte is written (ADR-0043): the bucket
 * and the key are on the row first, so a reception that dies half way leaves a
 * row the sweep can erase by its exact key (sweep 1), never an object nothing
 * names.
 */
export async function insertReception(reception: NewReception): Promise<void> {
  await getDb()
    .insert(inboundMails)
    .values({ ...reception, status: 'receiving' })
}

/** The mail this address already holds under `deliveryKey`, if any, whatever became of it. */
export async function findMailIdByDeliveryKey(addressId: string, deliveryKey: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ id: inboundMails.id })
    .from(inboundMails)
    .where(and(eq(inboundMails.addressId, addressId), eq(inboundMails.deliveryKey, deliveryKey)))
    .limit(1)
  return row?.id ?? null
}

/** Whether the reception became a mail for the receive job, or was a second delivery of one already held. */
export type ReceptionOutcome = 'received' | 'duplicate'

/**
 * Turn a reception into a received mail AND queue the job that reads it, in
 * one transaction: a mail is never `received` without its job, and a job never
 * names a mail that is not. The job id is the mail's id, so the sweep that
 * re-queues a `received` mail without a live job (sweep 2) names the same job.
 *
 * A second delivery of a mail already held loses the race to
 * `uniq_inbound_mails_address_delivery`: that is `duplicate`, and nothing was
 * written.
 */
export async function completeReception(input: {
  mailId: string
  organizationId: string
  projectId: string
  deliveryKey: string
  rawSizeBytes: number
}): Promise<ReceptionOutcome> {
  try {
    return await getDb().transaction(async (tx) => {
      const updated = await tx
        .update(inboundMails)
        .set({ status: 'received', deliveryKey: input.deliveryKey, rawSizeBytes: input.rawSizeBytes, updatedAt: new Date() })
        .where(and(eq(inboundMails.id, input.mailId), eq(inboundMails.status, 'receiving')))
        .returning({ id: inboundMails.id })
      if (updated.length === 0) throw new Error(`inbound mail ${input.mailId} is not receiving`)
      await queueReceiveJob(input, tx)
      return 'received' as const
    })
  } catch (error) {
    if (isUniqueViolation(error, 'uniq_inbound_mails_address_delivery')) return 'duplicate'
    throw error
  }
}

/** Queue (or find queued) the receive job of a received mail. */
export async function queueReceiveJob(
  mail: { mailId: string; organizationId: string; projectId: string },
  executor: DbExecutor = getDb(),
): Promise<boolean> {
  return insertJobIfAbsent(
    {
      kind: 'inbound_mail_receive',
      organizationId: mail.organizationId,
      priority: BFF_JOB_PRIORITY.bulk,
      jobId: mail.mailId,
      payload: { mailId: mail.mailId, projectId: mail.projectId },
    },
    executor,
  )
}

/**
 * A reception that turned out to be a second delivery, or failed half way:
 * its object was erased (or never written), so the row stops naming it. The
 * row stays `receiving`; DELETE is not the app's (migration 0184), and sweep 1
 * deletes it once it is fifteen minutes old.
 */
export async function forgetReceptionObject(mailId: string): Promise<void> {
  await getDb()
    .update(inboundMails)
    .set({ rawStorageKey: null, updatedAt: new Date() })
    .where(and(eq(inboundMails.id, mailId), eq(inboundMails.status, 'receiving')))
}

// ---------------------------------------------------------------------------
// The receive job
// ---------------------------------------------------------------------------

/** The mail the receive job reads, in any status: a job that finds it past `received` has nothing to do. */
export async function findMailForReceive(mailId: string): Promise<InboundMailRow | null> {
  const [row] = await getDb().select().from(inboundMails).where(eq(inboundMails.id, mailId)).limit(1)
  return row ?? null
}

/** A scan's outcome as the columns store it. */
export interface StoredScan {
  status: Exclude<MalwareScanStatus, 'pending'>
  /** Engine and signature-database version (`ClamAV 1.5.4/28157`); null when no engine answered. */
  engine: string | null
  /** The malware's name, for `infected` only. */
  signature: string | null
  scannedAt: Date
}

/**
 * The whole raw message's scan (D16). Recorded while the mail is still
 * `received`, so a job that dies after it does not scan again, and a mail is
 * never `waiting` without one (`inbound_mails_waiting_is_scanned`).
 */
export async function recordRawScan(mailId: string, scan: StoredScan): Promise<void> {
  await getDb()
    .update(inboundMails)
    .set({
      rawScanStatus: scan.status,
      rawScanEngine: scan.engine,
      rawScanSignature: scan.status === 'infected' ? scan.signature : null,
      rawScannedAt: scan.scannedAt,
      rawScanAttempts: sql`least(${inboundMails.rawScanAttempts} + 1, 100)`,
      updatedAt: new Date(),
    })
    .where(and(eq(inboundMails.id, mailId), eq(inboundMails.status, 'received')))
}

/**
 * Drop an automatic mail nobody needs to see: an auto-reply, a delivery
 * report, a loop (`dropped_reason`). Scrubbed in the same statement
 * (`inbound_mails_ended_is_scrubbed`): the envelope sender goes, and the raw
 * message's key goes once its object is erased, unless a legal hold deferred
 * that (`erasureDeferred`). Whether this call dropped it.
 */
export async function dropMail(
  mailId: string,
  input: { reason: NonNullable<InboundMailRow['droppedReason']>; erasureDeferred: boolean },
): Promise<boolean> {
  const now = new Date()
  const rows = await getDb()
    .update(inboundMails)
    .set({
      status: 'dropped',
      droppedReason: input.reason,
      envelopeFrom: null,
      rawStorageKey: input.erasureDeferred ? inboundMails.rawStorageKey : null,
      erasureDeferredAt: input.erasureDeferred ? now : null,
      updatedAt: now,
    })
    .where(and(eq(inboundMails.id, mailId), eq(inboundMails.status, 'received')))
    .returning({ id: inboundMails.id })
  return rows.length > 0
}

/** The mail's identifiers a thread can be found by. */
export interface ThreadKeys {
  /** The mail's own Message-ID, In-Reply-To and References, normalized. */
  messageIds: readonly string[]
  threadIndexGuid: string | null
  baseSubject: string
  /** The mail's participant addresses, lower-cased, the project's own taken out. */
  participants: readonly string[]
}

/** Threads looked at per mail; a project with more matching threads than this is past what a person picks from. */
const MAX_THREAD_CANDIDATES = 50

/**
 * The project's threads this mail could belong to, in the shape the matching
 * ladder reads (`matchThread`): any thread that received or was referred to by
 * one of the mail's ids, shares its Outlook conversation GUID, or has its base
 * subject. Only threads with a live document: a thread being written for the
 * first time, or whose document is gone, is nothing to file into.
 *
 * The id and participant lists hold only what the mail shares with each
 * thread, which is all the ladder asks of them; a 200-entry thread's whole
 * history is never loaded for one mail.
 */
export async function findThreadCandidates(projectId: string, keys: ThreadKeys): Promise<ThreadCandidate[]> {
  const db = getDb()
  const ids = [...new Set(keys.messageIds)].slice(0, 64)
  const byIds =
    ids.length > 0
      ? db
          .selectDistinct({ threadId: mailThreadMessageIds.threadId })
          .from(mailThreadMessageIds)
          .where(and(eq(mailThreadMessageIds.projectId, projectId), inArray(mailThreadMessageIds.messageId, ids)))
      : null
  const threads = await db
    .select({
      threadId: mailThreads.id,
      baseSubject: mailThreads.baseSubject,
      threadIndexGuid: mailThreads.threadIndexGuid,
      lastEntryAt: mailThreads.lastEntryAt,
    })
    .from(mailThreads)
    .where(
      and(
        eq(mailThreads.projectId, projectId),
        isNotNull(mailThreads.documentId),
        or(
          byIds ? inArray(mailThreads.id, byIds) : undefined,
          keys.threadIndexGuid ? eq(mailThreads.threadIndexGuid, keys.threadIndexGuid) : undefined,
          keys.baseSubject ? eq(mailThreads.baseSubject, keys.baseSubject) : undefined,
          sql`false`,
        ),
      ),
    )
    .orderBy(desc(mailThreads.lastEntryAt))
    .limit(MAX_THREAD_CANDIDATES)
  if (threads.length === 0) return []
  const threadIds = threads.map((thread) => thread.threadId)
  const [knownIds, shared] = await Promise.all([
    ids.length > 0
      ? db
          .select({ threadId: mailThreadMessageIds.threadId, messageId: mailThreadMessageIds.messageId, state: mailThreadMessageIds.state })
          .from(mailThreadMessageIds)
          .where(and(inArray(mailThreadMessageIds.threadId, threadIds), inArray(mailThreadMessageIds.messageId, ids)))
          .limit(MAX_THREAD_CANDIDATES * 64)
      : Promise.resolve([]),
    sharedParticipants(threadIds, keys.participants),
  ])
  return threads.map((thread) => ({
    threadId: thread.threadId,
    baseSubject: thread.baseSubject,
    threadIndexGuid: thread.threadIndexGuid,
    receivedIds: knownIds.filter((row) => row.threadId === thread.threadId && row.state === 'received').map((row) => row.messageId),
    referencedIds: knownIds
      .filter((row) => row.threadId === thread.threadId && row.state === 'referenced')
      .map((row) => row.messageId),
    participants: shared.get(thread.threadId) ?? [],
    lastEntryAt: thread.lastEntryAt ? new Date(thread.lastEntryAt) : null,
  }))
}

/** Which of `addresses` took part in each thread, as a sender or a recipient of a filed entry. */
async function sharedParticipants(threadIds: readonly string[], addresses: readonly string[]): Promise<Map<string, string[]>> {
  const wanted = [...new Set(addresses.map((address) => address.toLowerCase()))].slice(0, 200)
  if (threadIds.length === 0 || wanted.length === 0) return new Map()
  const rows = await getDb().execute<{ thread_id: string; address: string }>(sql`
    SELECT DISTINCT e.thread_id, lower(p.address) AS address
    FROM ${mailThreadEntries} e
    CROSS JOIN LATERAL (
      SELECT e.sender_address AS address
      UNION ALL
      SELECT value ->> 'address' FROM jsonb_array_elements(e.participants)
    ) p
    WHERE e.thread_id IN (${sql.join(threadIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND lower(p.address) IN (${sql.join(wanted.map((address) => sql`${address}`), sql`, `)})
    LIMIT 2000
  `)
  const shared = new Map<string, string[]>()
  for (const row of Array.from(rows)) {
    const threadId = String(row.thread_id)
    shared.set(threadId, [...(shared.get(threadId) ?? []), String(row.address)])
  }
  return shared
}

/** A filed message of the project with a given Message-ID (D11, D33). */
export interface FiledMessage {
  entryId: string
  threadId: string
  source: 'inbound' | 'archive'
  /** SHA-256 hex of the entry's own text, compared with the held mail's. */
  ownTextSha256: string
}

/**
 * The project's filed messages that received this Message-ID: what decides
 * `message_id_reused` (an id the project already has, perhaps a forger's) and
 * `already_filed` (the same message is in a Verlauf already). Received ids are
 * keyed per entry, so a forger who took a genuine id first is one row of
 * several and never blocks the genuine message (RT-S1).
 */
export async function findFiledMessages(projectId: string, messageId: string): Promise<FiledMessage[]> {
  const rows = await getDb()
    .select({
      entryId: mailThreadEntries.id,
      threadId: mailThreadEntries.threadId,
      source: mailThreadEntries.source,
      ownTextSha256: sql<string>`encode(sha256(convert_to(${mailThreadEntries.ownText}, 'UTF8')), 'hex')`,
    })
    .from(mailThreadMessageIds)
    .innerJoin(mailThreadEntries, eq(mailThreadEntries.id, mailThreadMessageIds.entryId))
    .where(
      and(
        eq(mailThreadMessageIds.projectId, projectId),
        eq(mailThreadMessageIds.messageId, messageId),
        eq(mailThreadMessageIds.state, 'received'),
      ),
    )
    .limit(20)
  return rows.map((row) => ({ ...row, ownTextSha256: String(row.ownTextSha256) }))
}

/**
 * Screened documents of the project that hold exactly these bytes, by content
 * hash: the `duplicate_of` candidate of an attachment. Ids only, stored on the
 * part; whether the viewer may see the document is decided when the mail is
 * read (RT-S13). A held document is never a candidate (`SCREENED_ONLY`): its
 * existence is not the project's yet.
 */
export async function findScreenedDuplicates(projectId: string, sha256s: readonly string[]): Promise<Map<string, string>> {
  const hashes = [...new Set(sha256s)].slice(0, 100)
  if (hashes.length === 0) return new Map()
  const rows = await getDb()
    .select({ id: documents.id, contentHash: documents.contentHash })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), inArray(documents.contentHash, hashes), documentVisibleTo(SCREENED_ONLY)))
    .orderBy(desc(documents.createdAt))
    .limit(500)
  return firstByKey(rows.map((row) => [row.contentHash ?? '', row.id]))
}

/**
 * Screened documents of the project under exactly these names (their stored,
 * composed form): the attachment that would become their next Fassung
 * (`revision_candidate_document_id`). Ids only, judged for the viewer at read
 * time, like {@link findScreenedDuplicates}.
 */
export async function findScreenedNamesakes(projectId: string, filenames: readonly string[]): Promise<Map<string, string>> {
  const names = [...new Set(filenames)].slice(0, 100)
  if (names.length === 0) return new Map()
  const rows = await getDb()
    .select({ id: documents.id, filename: documents.filename })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), inArray(documents.filename, names), documentVisibleTo(SCREENED_ONLY)))
    .orderBy(desc(documents.createdAt))
    .limit(500)
  return firstByKey(rows.map((row) => [row.filename, row.id]))
}

/** The first value per key, in row order (newest first). */
function firstByKey(entries: ReadonlyArray<readonly [string, string]>): Map<string, string> {
  const found = new Map<string, string>()
  for (const [key, value] of entries) if (key && !found.has(key)) found.set(key, value)
  return found
}

/** What following needs of one thread (D31): its participant domains and its follows that have not ended. */
export interface ThreadFollowContext {
  threadId: string
  participantDomains: string[]
  follows: FollowRow[]
}

/** {@link ThreadFollowContext} of one thread of the project, or null when it has no live document. */
export async function findThreadFollowContext(projectId: string, threadId: string): Promise<ThreadFollowContext | null> {
  const db = getDb()
  const [thread] = await db
    .select({ id: mailThreads.id, participantDomains: mailThreads.participantDomains })
    .from(mailThreads)
    .where(and(eq(mailThreads.id, threadId), eq(mailThreads.projectId, projectId), isNotNull(mailThreads.documentId)))
    .limit(1)
  if (!thread) return null
  const follows = await db
    .select({
      id: mailThreadFollows.id,
      userId: mailThreadFollows.userId,
      createdAt: mailThreadFollows.createdAt,
      expiresAt: mailThreadFollows.expiresAt,
      endedAt: mailThreadFollows.endedAt,
    })
    .from(mailThreadFollows)
    .where(and(eq(mailThreadFollows.threadId, threadId), isNull(mailThreadFollows.endedAt)))
    .orderBy(mailThreadFollows.createdAt)
    .limit(50)
  return {
    threadId: thread.id,
    participantDomains: thread.participantDomains,
    follows: follows.map((follow) => ({
      ...follow,
      createdAt: new Date(follow.createdAt),
      expiresAt: new Date(follow.expiresAt),
      endedAt: follow.endedAt ? new Date(follow.endedAt) : null,
    })),
  }
}

/** What the receive job writes onto the mail when it is held. */
export type HeldMailFields = Pick<
  NewInboundMailRow,
  | 'readStorageKey'
  | 'messageId'
  | 'inReplyTo'
  | 'referenceIds'
  | 'threadIndexGuid'
  | 'baseSubject'
  | 'threadMatch'
  | 'senderAddress'
  | 'senderName'
  | 'subject'
  | 'participants'
  | 'participantDomains'
  | 'recipientCount'
  | 'senderTrust'
  | 'senderUserId'
  | 'senderReason'
  | 'signerDomain'
  | 'signedHeaders'
  | 'senderFlags'
  | 'authenticationResults'
  | 'automatic'
  | 'sentAt'
  | 'sentAtHeader'
  | 'notStaged'
  | 'ignored'
>

/**
 * Hold the mail for a person: insert its parts and move it to `waiting`, in one
 * transaction, so a person never sees a mail without its parts. Only from
 * `received`: whether this call held it (a second run of the job finds it held
 * and does nothing). The database refuses a `waiting` mail whose raw message
 * was not scanned, and a part that breaks any of its rules.
 */
export async function holdMail(
  mailId: string,
  fields: HeldMailFields,
  parts: readonly NewInboundMailPartRow[],
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const now = new Date()
    const held = await tx
      .update(inboundMails)
      .set({ ...fields, status: 'waiting', updatedAt: now })
      .where(and(eq(inboundMails.id, mailId), eq(inboundMails.status, 'received')))
      .returning({ id: inboundMails.id })
    if (held.length === 0) return false
    if (parts.length > 0) await tx.insert(inboundMailParts).values([...parts])
    return true
  })
}

/** The token of the address a mail arrived at: what its signed recipients must name (D4), and the one B8 keeps. */
export async function findAddressToken(addressId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ token: inboundMailAddresses.token })
    .from(inboundMailAddresses)
    .where(eq(inboundMailAddresses.id, addressId))
    .limit(1)
  return row?.token ?? null
}

/** One part of a held mail, as its announcement and audit read it: kind and flags, no name. */
export interface PartSummary {
  kind: 'message' | 'attachment'
  riskFlags: string[]
  contentFindings: string[]
}

/** The parts of a held mail, in position order (at most 101: the text and 100 attachments). */
export async function findPartSummaries(mailId: string): Promise<PartSummary[]> {
  return getDb()
    .select({ kind: inboundMailParts.kind, riskFlags: inboundMailParts.riskFlags, contentFindings: inboundMailParts.contentFindings })
    .from(inboundMailParts)
    .where(eq(inboundMailParts.mailId, mailId))
    .orderBy(inboundMailParts.position)
    .limit(200)
}

/**
 * The held mail was announced (`notified_at`): its job's last step, so a job
 * that died between holding the mail and telling anyone finishes the telling
 * when it runs again, and a job that finished never tells twice.
 */
export async function markNotified(mailId: string, at: Date = new Date()): Promise<void> {
  await getDb()
    .update(inboundMails)
    .set({ notifiedAt: at, updatedAt: at })
    .where(and(eq(inboundMails.id, mailId), isNull(inboundMails.notifiedAt)))
}
