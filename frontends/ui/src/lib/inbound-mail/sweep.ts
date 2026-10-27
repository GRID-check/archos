import 'server-only'
/**
 * The E-Mail-Eingang's retention sweeps (ADR-0137, DECISION §5 „Retention and
 * sweeps“): what a restart, a dead job, a running-out window or a released
 * legal hold leaves for somebody to finish, finished by the clock.
 *
 * One more part of `reconcile-background-work`, which the job scheduler posts
 * every tick (`scheduler/index.js`), so there is no cron of its own. Each
 * sweep lists what is due across every organization (platform scope, ids
 * only), then acts on each row in that row's own tenant scope, compare-and-set
 * on what it saw, so a person or a job that moved a row in between wins. Rows
 * are deleted as the platform role (DELETE is revoked from the runtime role).
 * Safe on several scheduler replicas at once and more often than needed:
 * every step finds what the step before it left. A sweep that throws costs
 * its own turn, never the others'; each row's failure is counted, not thrown.
 *
 * | # | Sweep | Window | Hold |
 * |---|---|---|---|
 * | 1 | `receiving` left behind: erase its object by key, delete the row | 15 min | skipped |
 * | 2 | `received` with no live job: queue it again (job id = mail id) | 5 min | — |
 * | 5 | `filing` past its claim: waits again (`unavailable`), the decider told | the claim | — |
 * | 13 | an original's move that stopped: finish it (copy proven, then the raw erased) | 15 min | a move erases nothing |
 * | 11 | decisions owed to the audit trail: send them (before 8 and 9, RT-S8) | 1 min | — |
 * | 3 | `waiting` past its end: parts `expired` (restorable 7 days), audited | 30 days | — |
 * | 4 | five days left: `inbound_mail.expiring`, once per mail | day 25 | — |
 * | 6 | dismissed and expired parts past 7 days: bytes erased; a mail nothing of which waits is settled and scrubbed | 7 days | deferred |
 * | 7 | failed scans: scanned again, hourly, up to 24 times | 1 h | — |
 * | 10 | erasures a hold deferred, once it is released | — | the point |
 * | 8 | settled and dropped rows past their keep, with no live document and nothing owed to the trail: deleted | 30 days | skipped |
 * | 12 | follows past their end or whose document is gone: ended, audited; five days left: `mail_thread.follow_expiring`, once | 60 days, day 55 | — |
 * | 9 | threads whose document is gone: originals erased by key, then the thread (and its entries, ids, follows) deleted | 1 h | skipped |
 * | 14 | the staged-bytes caps (D18): `inbound_mail.cap_reached` at 80% and 100%, once per rise; settled below 80% | — | — |
 *
 * „Hold“: a legal hold on the project (and, for a mail's bytes, a custodian
 * hold on the member it came from) is asked in the WHERE of every set that
 * erases or deletes (RT-S20); the delete triggers are the backstop.
 *
 * Imports no filing code (`review-first.spec.ts`): it finishes what a person's
 * filing started (13) and erases what nobody filed, but files nothing.
 */

import { randomUUID } from 'node:crypto'
import { recordAuditEvent, SYSTEM_ACTORS } from '@/lib/audit/service'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { endFollowBySystem } from '@/lib/mail-thread/follows'
import { finishOriginalMove } from '@/lib/mail-thread/originals'
import { findEntryOfMail, forgetMovedRaw } from '@/lib/mail-thread/write-repository'
import { publishProjectChanged } from '@/lib/realtime/door-events'
import {
  announceCapReached,
  announceExpiring,
  announceFilingFailed,
  announceFollowExpiring,
  settleCapReached,
  settleProjectNotices,
} from './announce'
import { auditDecisions } from './audit'
import { projectIsHeld } from './filing-repository'
import type { InboundMailCapNotice } from './inbound-mail-vocabulary'
import { scanForStorage } from './malware-scan'
import { INBOUND_MAIL_ADDRESS_STAGED_BYTES, INBOUND_MAIL_ORGANIZATION_STAGED_BYTES } from './receive'
import { queueReceiveJob } from './repository'
import { eraseStagedObjects, readStagedObject } from './staging'
import * as sweeps from './sweep-repository'

/** Rows one sweep takes per run; the rest wait for the next tick (30 s). */
export const SWEEP_BATCH = 50

/** A reception older than this died half way (D8: 15 minutes). */
export const STALE_RECEPTION_MS = 15 * 60 * 1000
/** A received mail is given this long before its missing job counts as gone. */
export const ORPHANED_RECEPTION_MS = 5 * 60 * 1000
/** An original's move pending this long stopped (D8: 15 minutes). */
export const STALLED_MOVE_MS = 15 * 60 * 1000
/** The request that decided sends its own audit lines; the sweep sends what it could not, after this. */
export const AUDIT_GRACE_MS = 60 * 1000

/** What one sweep did. `errors` counts rows that failed, and a sweep that failed whole. */
export interface SweepCounts {
  checked: number
  errors: number
  [outcome: string]: number
}

/** Every sweep's counts, by name, for the scheduler's log line. */
export interface InboundMailSweepResult {
  staleReceptions: SweepCounts
  orphanedReceptions: SweepCounts
  lapsedClaims: SweepCounts
  stalledMoves: SweepCounts
  audits: SweepCounts
  expired: SweepCounts
  expiring: SweepCounts
  endedParts: SweepCounts
  rescans: SweepCounts
  releasedErasures: SweepCounts
  keptMails: SweepCounts
  follows: SweepCounts
  threads: SweepCounts
  caps: SweepCounts
}

const counts = (...outcomes: string[]): SweepCounts =>
  Object.fromEntries([['checked', 0], ['errors', 0], ...outcomes.map((outcome) => [outcome, 0])]) as SweepCounts

const discover = <T>(what: string, find: () => Promise<T[]>): Promise<T[]> =>
  withPlatformAccess(`inbound mail sweep: finding ${what} across organizations`, find)

/** Run one row's step in its tenant; a failure is counted and logged by id, never thrown. */
async function eachRow<T extends { organizationId: string }>(
  rows: readonly T[],
  result: SweepCounts,
  label: (row: T) => string,
  step: (row: T) => Promise<void>,
): Promise<void> {
  result.checked += rows.length
  for (const row of rows) {
    try {
      await withTenant({ organizationId: row.organizationId }, () => step(row))
    } catch (error) {
      result.errors += 1
      console.error(`[inbound-mail] sweep could not finish ${label(row)}`, error)
    }
  }
}

// ---------------------------------------------------------------------------
// The sweeps, in the order they run
// ---------------------------------------------------------------------------

/** Sweep 1: receptions that never finished. */
export async function sweepStaleReceptions(now: Date): Promise<SweepCounts> {
  const result = counts('deleted')
  const before = new Date(now.getTime() - STALE_RECEPTION_MS)
  const rows = await discover('stale receptions', () => sweeps.findStaleReceptions(before, SWEEP_BATCH))
  await eachRow(rows, result, (row) => `the stale reception ${row.id}`, async (row) => {
    // The key goes only with its object: an object that could not be erased keeps its row for the next run.
    if (row.rawStorageKey && (await eraseStagedObjects(row.stagingBucket, [row.rawStorageKey])).length > 0) {
      throw new Error('its staged raw message could not be erased')
    }
    const deleted = await withPlatformAccess('inbound mail sweep 1: a stale reception', () => sweeps.deleteStaleReception(row.id, before))
    if (deleted) result.deleted += 1
  })
  return result
}

/** Sweep 2: received mail whose job is gone gets it again; a dead job is left for the queue's retention, loudly. */
export async function sweepOrphanedReceptions(now: Date): Promise<SweepCounts> {
  const result = counts('requeued', 'dead')
  const before = new Date(now.getTime() - ORPHANED_RECEPTION_MS)
  const rows = await discover('received mail without a job', () => sweeps.findReceivedWithoutJob(before, SWEEP_BATCH))
  await eachRow(rows, result, (row) => `the received mail ${row.id}`, async (row) => {
    if (row.deadJob) {
      // Every attempt was spent and the last one could not even hold it unreadable: an operator's to look at.
      result.dead += 1
      console.error(`[inbound-mail] mail ${row.id} is received, and its job gave up; it is queued again once the dead job is pruned`)
      return
    }
    if (await queueReceiveJob({ mailId: row.id, organizationId: row.organizationId, projectId: row.projectId })) result.requeued += 1
  })
  return result
}

/** Sweep 5: filing claims that ran out; each mail's decider is told once per run. */
export async function sweepLapsedClaims(now: Date): Promise<SweepCounts> {
  const result = counts('returned')
  const rows = await discover('lapsed filing claims', () => sweeps.findLapsedClaims(now, SWEEP_BATCH))
  const told = new Set<string>()
  await eachRow(rows, result, (row) => `the lapsed claim on part ${row.partId}`, async (row) => {
    if (!(await sweeps.returnLapsedClaim(row, now))) return
    result.returned += 1
    publishProjectChanged(row.organizationId, row.projectId)
    if (told.has(row.mailId)) return
    told.add(row.mailId)
    await announceFilingFailed({ ...row, failure: 'unavailable' })
  })
  return result
}

/** Sweep 13: an original's move that stopped half way is finished; a mail whose entry is gone loses its raw. */
export async function sweepStalledMoves(now: Date): Promise<SweepCounts> {
  const result = counts('moved', 'forgotten', 'held')
  const before = new Date(now.getTime() - STALLED_MOVE_MS)
  const rows = await discover('stalled original moves', () => sweeps.findStalledMoves(before, SWEEP_BATCH))
  await eachRow(rows, result, (row) => `the original move of mail ${row.id}`, async (row) => {
    const mail = await sweeps.findMailRow(row.id)
    if (!mail?.originalMovePendingAt) return
    const entry = await findEntryOfMail(row.projectId, row.id)
    if (entry) {
      // A copy proven by read-back and SHA-256 before the raw is erased: nothing is lost, so no hold waits for it.
      if ((await finishOriginalMove(mail, entry)) === 'moved') result.moved += 1
      return
    }
    // The entry is gone (its thread was deleted, sweep 9): the raw has nowhere to go.
    if (mail.rawStorageKey && (await projectIsHeld(row.projectId, row.organizationId))) {
      result.held += 1
      return
    }
    if (mail.rawStorageKey && (await eraseStagedObjects(mail.stagingBucket, [mail.rawStorageKey])).length > 0) {
      throw new Error('its staged raw message could not be erased')
    }
    await forgetMovedRaw(row.id)
    result.forgotten += 1
  })
  return result
}

/** Sweep 11: decisions still owed to the audit trail. Runs before 8 and 9, which wait for it (RT-S8). */
export async function sweepUnauditedDecisions(now: Date): Promise<SweepCounts> {
  const result = counts('sent')
  const before = new Date(now.getTime() - AUDIT_GRACE_MS)
  const rows = await discover('decisions owed to the audit trail', () => sweeps.findUnauditedDecisions(before, SWEEP_BATCH))
  result.checked = rows.length
  const byOrganization = Map.groupBy(rows, (row) => row.organizationId)
  for (const [organizationId, decisions] of byOrganization) {
    // `auditDecisions` never throws; a line it could not send stays owed for the next run.
    const allTaken = await withTenant({ organizationId }, () => auditDecisions(decisions))
    if (allTaken) result.sent += decisions.length
    else result.errors += 1
  }
  return result
}

/** Sweep 3: held mail past its window expires, restorable for seven days; audited. */
export async function sweepExpiredMails(now: Date): Promise<SweepCounts> {
  const result = counts('expired', 'parts')
  const rows = await discover('held mail past its window', () => sweeps.findExpiredMails(now, SWEEP_BATCH))
  await eachRow(rows, result, (row) => `the expiry of mail ${row.id}`, async (row) => {
    const parts = await sweeps.expireMail(row.id, now)
    if (parts === 0) return
    result.expired += 1
    result.parts += parts
    await recordAuditEvent({
      action: 'inbound_mail.expired',
      organizationId: row.organizationId,
      actor: { userId: SYSTEM_ACTORS.inboundMail, email: null },
      targetType: 'inbound_mail',
      targetId: row.id,
      alsoTargets: [{ type: 'project', id: row.projectId }],
      metadata: { projectId: row.projectId, parts },
      occurredAt: now,
      idempotencyKey: `inbound_mail.expired:${row.id}:${now.toISOString()}`,
    })
    publishProjectChanged(row.organizationId, row.projectId)
    await settleProjectNotices(row.organizationId, row.projectId)
  })
  return result
}

/** Sweep 4: five days left; each held mail's people are told once. */
export async function sweepExpiringMails(now: Date): Promise<SweepCounts> {
  const result = counts('told')
  const rows = await discover('held mail about to expire', () => sweeps.findExpiringMails(now, SWEEP_BATCH))
  await eachRow(rows, result, (row) => `the expiry notice of mail ${row.id}`, async (row) => {
    // Marked first: a notice lost after the mark costs a row, never a second one.
    if (!(await sweeps.claimExpiringNotice(row.id, now))) return
    await announceExpiring({ ...row, mailId: row.id })
    result.told += 1
  })
  return result
}

/**
 * Sweep 6: the bytes of parts past restoring are erased (deferred under a
 * hold), each part's row taken first under the find's condition and the
 * object erased only then, then each mail nothing of which waits or can be restored is settled
 * and scrubbed, its staged objects erased by key (kept under a hold).
 */
export async function sweepEndedParts(now: Date): Promise<SweepCounts> {
  const result = counts('erased', 'deferred', 'settled')
  const parts = await discover('ended parts past restoring', () => sweeps.findEndedPartBytes(now, SWEEP_BATCH))
  await eachRow(parts, result, (row) => `the bytes of part ${row.partId}`, async (row) => {
    if (row.held) {
      await sweeps.deferPartErasure(row.partId, now)
      result.deferred += 1
      return
    }
    // The row first, under the find's whole condition: a restore or a hold that landed since erases nothing.
    if (!(await sweeps.takeEndedPartBytes(row, now))) return
    if ((await eraseStagedObjects(row.stagingBucket, [row.storageKey])).length > 0) {
      await sweeps.returnEndedPartKey(row, now)
      throw new Error('its bytes could not be erased')
    }
    result.erased += 1
  })

  const mails = await discover('mail to settle', () => sweeps.findMailsToSettle(now, SWEEP_BATCH))
  await eachRow(mails, result, (row) => `the settle of mail ${row.id}`, async (row) => {
    const mail = await sweeps.findMailRow(row.id)
    if (!mail || mail.status !== 'waiting') return
    if (!row.held) {
      // A raw message still moving to its entry's original is the move's to erase (sweep 13).
      const keys = [mail.readStorageKey, mail.originalMovePendingAt ? null : mail.rawStorageKey].filter((key): key is string => key !== null)
      if ((await eraseStagedObjects(mail.stagingBucket, keys)).length > 0) throw new Error('its staged objects could not be erased')
    }
    if (!(await sweeps.settleEndedMail(mail, row.held, now))) return
    result.settled += 1
    publishProjectChanged(row.organizationId, row.projectId)
    await settleProjectNotices(row.organizationId, row.projectId)
  })
  return result
}

/** Sweep 7: failed scans of waiting parts and held raw messages, again, hourly, up to 24 times. */
export async function sweepFailedScans(now: Date): Promise<SweepCounts> {
  const result = counts('clean', 'infected', 'failed')
  const rows = await discover('failed scans', () => sweeps.findFailedScans(now, SWEEP_BATCH))
  await eachRow(rows, result, (row) => `the scan of ${row.kind} ${row.id}`, async (row) => {
    const scan = await scanForStorage(await readStagedObject(row.stagingBucket, row.storageKey))
    const recorded = row.kind === 'part' ? await sweeps.recordPartRescan(row.id, scan) : await sweeps.recordRawRescan(row.id, scan)
    if (!recorded) return
    result[scan.status] = (result[scan.status] ?? 0) + 1
  })
  return result
}

/**
 * Sweep 10: what a hold deferred, erased once the hold is released. Each row
 * is taken first, under the find's whole condition with the hold included, and
 * the objects erased only then; what the store kept comes back to the row.
 */
export async function sweepReleasedErasures(now: Date): Promise<SweepCounts> {
  const result = counts('erased')
  const rows = await discover('erasures a released hold deferred', () => sweeps.findReleasedErasures(SWEEP_BATCH))
  await eachRow(rows, result, (row) => `the deferred erasure of ${row.kind} ${row.id}`, async (row) => {
    // The row first: a hold placed since the find erases nothing.
    if (!(await sweeps.takeReleasedErasure(row, now))) return
    const kept = await eraseStagedObjects(row.stagingBucket, row.keys)
    if (kept.length > 0) {
      await sweeps.returnReleasedErasure(row, kept, now)
      throw new Error('its staged objects could not be erased')
    }
    result.erased += 1
  })
  return result
}

/** Sweep 8: settled and dropped rows past their keep are deleted, once nothing is owed to the trail. */
export async function sweepKeptMails(now: Date): Promise<SweepCounts> {
  const result = counts('deleted')
  const rows = await discover('mail rows past their keep', () => sweeps.findKeptMails(now, SWEEP_BATCH))
  result.checked = rows.length
  const deleted = await withPlatformAccess('inbound mail sweep 8: deleting mail rows past their keep', () =>
    sweeps.deleteKeptMails(rows.map((row) => row.id), now),
  )
  result.deleted = deleted.length
  return result
}

/** Sweep 12: follows that ran out, whose document is gone, or in a closed project end (audited); five days left asks to renew, once. */
export async function sweepFollows(now: Date): Promise<SweepCounts> {
  const result = counts('ended', 'told')
  const ending = await discover('follows that end', () => sweeps.findEndingFollows(now, SWEEP_BATCH))
  await eachRow(ending, result, (row) => `the end of follow ${row.id}`, async (row) => {
    // Ending also settles its renewal row.
    if (!(await endFollowBySystem(row, row.reason, now))) return
    result.ended += 1
  })

  const expiring = await discover('follows about to end', () => sweeps.findExpiringFollows(now, SWEEP_BATCH))
  await eachRow(expiring, result, (row) => `the renewal notice of follow ${row.id}`, async (row) => {
    if (!row.threadDocumentId || !(await sweeps.claimFollowExpiringNotice(row.id, now))) return
    await announceFollowExpiring({
      organizationId: row.organizationId,
      projectId: row.projectId,
      followId: row.id,
      threadDocumentId: row.threadDocumentId,
      followerUserId: row.userId,
    })
    result.told += 1
  })
  return result
}

/**
 * Sweep 9: a thread whose document is gone: its render lease taken under the
 * whole condition (the legal hold included), then its originals erased by key,
 * then the thread and all it holds. A hold placed after the find erases
 * nothing.
 */
export async function sweepOrphanedThreads(now: Date): Promise<SweepCounts> {
  const result = counts('deleted', 'entries', 'originals')
  const rows = await discover('threads whose document is gone', () => sweeps.findOrphanedThreads(now, SWEEP_BATCH))
  result.checked = rows.length
  for (const row of rows) {
    const holder = randomUUID()
    try {
      const originals = await withPlatformAccess('inbound mail sweep 9: leasing a thread whose document is gone', () =>
        sweeps.claimOrphanedThread(row.id, holder, now),
      )
      if (originals === null) continue
      for (const [bucket, inBucket] of Map.groupBy(originals, (original) => original.bucket)) {
        const keys = inBucket.map((original) => original.key)
        if ((await eraseStagedObjects(bucket, keys)).length > 0) {
          await withPlatformAccess('inbound mail sweep 9: releasing a thread an original stayed in', () =>
            sweeps.releaseOrphanedThread(row.id, holder),
          )
          throw new Error('an original could not be erased')
        }
        result.originals += keys.length
      }
      const entries = await withPlatformAccess('inbound mail sweep 9: deleting a thread whose document is gone', () =>
        sweeps.deleteOrphanedThread(row.id, holder, now),
      )
      if (entries === null) continue
      result.deleted += 1
      result.entries += entries
    } catch (error) {
      result.errors += 1
      console.error(`[inbound-mail] sweep could not delete thread ${row.id}`, error)
    }
  }
  return result
}

/** The notice an address's staged bytes call for now: 100% of either cap is full, 80% nearly full. */
export function capNoticeFor(state: Pick<sweeps.AddressCapState, 'revoked' | 'addressBytes' | 'organizationBytes'>): InboundMailCapNotice | null {
  if (state.revoked) return null
  const share = Math.max(
    state.addressBytes / INBOUND_MAIL_ADDRESS_STAGED_BYTES,
    state.organizationBytes / INBOUND_MAIL_ORGANIZATION_STAGED_BYTES,
  )
  if (share >= 1) return 'full'
  return share >= 0.8 ? 'nearly_full' : null
}

const CAP_RANK: Record<InboundMailCapNotice, number> = { nearly_full: 1, full: 2 }
const rank = (notice: InboundMailCapNotice | null) => (notice ? CAP_RANK[notice] : 0)

/**
 * Sweep 14, the caps (D18): a rise past 80% or 100% is told to the project's
 * managers once; below 80% (or a revoked address) the notice is settled. A
 * fall from full to nearly full is recorded, not told.
 */
export async function sweepCaps(now: Date): Promise<SweepCounts> {
  const result = counts('told', 'settled')
  const caps = { address: INBOUND_MAIL_ADDRESS_STAGED_BYTES, organization: INBOUND_MAIL_ORGANIZATION_STAGED_BYTES }
  const rows = await discover('addresses near their caps', () => sweeps.findAddressCapStates(caps, SWEEP_BATCH))
  await eachRow(rows, result, (row) => `the cap notice of address ${row.id}`, async (row) => {
    const notice = capNoticeFor(row)
    if (notice === row.capNotice) return
    if (!(await sweeps.setCapNotice(row.id, row.capNotice, notice, now))) return
    if (rank(notice) > rank(row.capNotice) && notice) {
      await announceCapReached({ organizationId: row.organizationId, projectId: row.projectId, addressId: row.id, notice })
      result.told += 1
    } else if (notice === null) {
      await settleCapReached(row.organizationId, row.id)
      result.settled += 1
    }
  })
  return result
}

// ---------------------------------------------------------------------------
// All of them
// ---------------------------------------------------------------------------

/** The sweeps in the order they run: 11 before 8 and 9 (they wait for the trail), 12 before 9 (it ends the follows 9 deletes). */
const ORDER: ReadonlyArray<[keyof InboundMailSweepResult, (now: Date) => Promise<SweepCounts>]> = [
  ['staleReceptions', sweepStaleReceptions],
  ['orphanedReceptions', sweepOrphanedReceptions],
  ['lapsedClaims', sweepLapsedClaims],
  ['stalledMoves', sweepStalledMoves],
  ['audits', sweepUnauditedDecisions],
  ['expired', sweepExpiredMails],
  ['expiring', sweepExpiringMails],
  ['endedParts', sweepEndedParts],
  ['rescans', sweepFailedScans],
  ['releasedErasures', sweepReleasedErasures],
  ['keptMails', sweepKeptMails],
  ['follows', sweepFollows],
  ['threads', sweepOrphanedThreads],
  ['caps', sweepCaps],
]

/**
 * Run every sweep once, in order. A sweep that throws is counted (`errors: 1`)
 * and logged, and the next one runs: one store or database fault in one part
 * never costs the others their turn. Never throws.
 */
export async function sweepInboundMail(now: Date = new Date()): Promise<InboundMailSweepResult> {
  const result = {} as InboundMailSweepResult
  for (const [name, sweep] of ORDER) {
    try {
      result[name] = await sweep(now)
    } catch (error) {
      console.error(`[inbound-mail] the ${name} sweep failed`, error)
      result[name] = { ...counts(), errors: 1 }
    }
  }
  return result
}

/** The order the sweeps run in, for the spec that holds it. */
export const SWEEP_ORDER: ReadonlyArray<keyof InboundMailSweepResult> = ORDER.map(([name]) => name)
