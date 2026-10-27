/**
 * @vitest-environment node
 *
 * The E-Mail-Eingang's retention sweeps (`./sweep.ts`, DECISION §5) against a
 * REAL Postgres with migration 0186, through the restricted runtime role
 * (`scripts/rls-test-db.sh`):
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/inbound-mail/sweep.integration.spec.ts
 *
 * Every sweep of the table, each against rows the migration's CHECKs accept,
 * so a statement that would meet a refusal in production fails here: the
 * windows, the compare-and-sets, the legal hold in the WHERE (a held and an
 * unheld project side by side, RT-S20), sweep 8 waiting for the audit trail
 * (RT-S8), sweep 9 erasing the originals before the thread goes, the notices
 * told once. Object storage, the scanner, the audit trail and the directory
 * are stood in; every row is real.
 *
 * Discovery runs under `withPlatformAccess` in production, across every
 * organization. The suites of `rls-test-db.sh` run side by side on one
 * database, so here discovery runs in this spec's own tenant instead (the same
 * SQL, under row-level security), and a sweep never reaches another suite's
 * rows. The deletes run as the platform role, as in production: DELETE is
 * revoked from the runtime role.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now().toString(36)
const ORG = `org_inbound_sweep_${STAMP}`
const MANAGER = 'user_01J0SWEEPMANAGER000000000A'
const DECIDER = 'user_01J0SWEEPDECIDER000000000A'
const FOLLOWER = 'user_01J0SWEEPFOLLOWER00000000A'
const BUCKET = 'grid-org-sweep'

const staging = vi.hoisted(() => ({
  erased: [] as string[],
  /** Keys whose erasure fails, as an unreachable store would. */
  failing: new Set<string>(),
  written: new Map<string, Uint8Array>(),
}))
vi.mock('@/lib/inbound-mail/staging', () => ({
  RAW_MESSAGE_CONTENT_TYPE: 'message/rfc822',
  eraseStagedObjects: vi.fn(async (_bucket: string, keys: readonly string[]) => {
    const left = keys.filter((key) => staging.failing.has(key))
    staging.erased.push(...keys.filter((key) => !staging.failing.has(key)))
    return left
  }),
  readStagedObject: vi.fn(async (_bucket: string, key: string) => staging.written.get(key) ?? new TextEncoder().encode(`bytes of ${key}`)),
  putStagedObject: vi.fn(async (_bucket: string, key: string, body: Uint8Array) => void staging.written.set(key, body)),
}))

const scan = vi.hoisted(() => ({ status: 'clean' as 'clean' | 'infected' | 'failed' }))
vi.mock('@/lib/inbound-mail/malware-scan', () => ({
  scanForStorage: vi.fn(async () => ({
    status: scan.status,
    engine: 'ClamAV 1.5.4/28157',
    signature: scan.status === 'infected' ? 'Eicar-Test-Signature' : null,
    scannedAt: new Date(),
  })),
}))

const audit = vi.hoisted(() => ({ events: [] as Array<{ action: string; metadata: Record<string, unknown> }> }))
vi.mock('@/lib/audit/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/service')>()
  const record = vi.fn(async (input: { action: string; metadata?: Record<string, unknown> }) => {
    audit.events.push({ action: input.action, metadata: input.metadata ?? {} })
  })
  return { ...actual, recordAuditEvent: record, recordAuditEventOrThrow: record }
})

vi.mock('@/lib/authz/project-membership', () => ({
  userHoldsProjectPermission: vi.fn(async (_scope: unknown, _project: string, userId: string) => userId === MANAGER),
}))
vi.mock('@/lib/sharing/directory', () => ({
  loadOrganizationDirectory: vi.fn(async () => new Map([[MANAGER, { userId: MANAGER, email: null, name: 'M', profilePictureUrl: null }]])),
}))
vi.mock('@/lib/push/enqueue', () => ({ enqueueInboxPushes: vi.fn(async () => undefined) }))
vi.mock('@/lib/events/bus', () => ({ publishToUser: vi.fn(async () => undefined), publishToUsers: vi.fn(async () => undefined) }))
vi.mock('@/lib/realtime/door-events', () => ({ publishProjectChanged: vi.fn() }))
const posthog = vi.hoisted(() => ({ events: [] as Array<{ event: string; properties: unknown }> }))
vi.mock('@/lib/analytics/posthog-server', () => ({
  captureServer: vi.fn((capture: { event: string; properties: unknown }) => {
    posthog.events.push({ event: capture.event, properties: capture.properties })
    return true
  }),
}))

// Discovery in this spec's tenant (see the header); every other platform step as it is.
vi.mock('@/lib/db/tenant-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/tenant-context')>()
  return {
    ...actual,
    withPlatformAccess: <T>(reason: string, fn: () => PromiseLike<T> | T) =>
      reason.startsWith('inbound mail sweep: finding')
        ? actual.withTenant({ organizationId: ORG }, fn)
        : actual.withPlatformAccess(reason, fn),
  }
})

describe.skipIf(!url)('the E-Mail-Eingang’s sweeps against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let sweep: typeof import('./sweep')
  let announce: typeof import('./announce')
  let project: string
  let heldProject: string
  let address: string
  let heldAddress: string

  const inTenant = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: ORG, userId: MANAGER }, run)

  async function rows<T>(statement: ReturnType<typeof sql>): Promise<T[]> {
    return Array.from(await inTenant(() => db.execute(statement))) as T[]
  }
  async function one<T>(statement: ReturnType<typeof sql>): Promise<T> {
    return (await rows<T>(statement))[0] as T
  }

  const stagingKey = (projectId: string, mailId: string, name: string) =>
    `org/${ORG}/project/${projectId}/_inbound-mail/${mailId}/${name}`
  const originalKey = (projectId: string, entryId: string) => `org/${ORG}/project/${projectId}/_mail-originals/${entryId}.eml`
  const deliveryKey = sql`md5(random()::text) || md5(random()::text)`

  interface MailSeed {
    projectId?: string
    status?: 'receiving' | 'received' | 'waiting' | 'settled' | 'dropped'
    trust?: 'external_verified' | 'external_unverified' | 'member_verified'
    senderUserId?: string | null
    raw?: boolean
    read?: boolean
    /** Interval SQL, e.g. `'20 minutes'`: how long ago. */
    updatedAgo?: string
    receivedAgo?: string
    settledAgo?: string
    expiresIn?: string
    movePendingAgo?: string
    erasureDeferred?: boolean
    rawScan?: 'clean' | 'failed'
    rawScannedAgo?: string
    rawScanAttempts?: number
    bytes?: number
  }

  async function seedMail(seed: MailSeed = {}): Promise<string> {
    const id = crypto.randomUUID()
    const projectId = seed.projectId ?? project
    const addressId = projectId === heldProject ? heldAddress : address
    const status = seed.status ?? 'waiting'
    const open = status === 'waiting'
    const shown = status === 'waiting' || status === 'settled'
    const trust = shown ? (seed.trust ?? 'external_verified') : null
    const reason = trust === null ? null : trust.endsWith('_verified') ? 'dkim_pass' : 'dkim_none'
    const userId = trust === 'member_verified' ? (seed.senderUserId ?? MANAGER) : null
    const raw = seed.raw ?? status !== 'settled'
    const read = seed.read ?? open
    await rows(sql`
      INSERT INTO inbound_mails (id, organization_id, project_id, address_id, status, delivery_key, raw_size_bytes,
        staging_bucket, raw_storage_key, read_storage_key, raw_scan_status, raw_scanned_at, raw_scan_attempts,
        sender_address, subject, sender_trust, sender_reason, sender_user_id, dropped_reason,
        received_at, updated_at, expires_at, settled_at, original_move_pending_at, erasure_deferred_at)
      VALUES (${id}::uuid, ${ORG}, ${projectId}::uuid, ${addressId}::uuid, ${status},
        ${status === 'receiving' ? null : deliveryKey}, ${status === 'receiving' ? null : (seed.bytes ?? 4096)},
        ${BUCKET}, ${raw ? stagingKey(projectId, id, 'raw.eml') : null}, ${read ? stagingKey(projectId, id, 'read.json') : null},
        ${status === 'receiving' || status === 'received' ? 'pending' : (seed.rawScan ?? 'clean')},
        ${status === 'receiving' || status === 'received' ? null : sql`now() - ${seed.rawScannedAgo ?? '0 seconds'}::interval`},
        ${seed.rawScanAttempts ?? 1},
        ${open ? 'sender@example.org' : null}, ${open ? 'Bescheid' : null}, ${trust}, ${reason}, ${userId},
        ${status === 'dropped' ? 'auto_reply' : null},
        now() - ${seed.receivedAgo ?? '0 seconds'}::interval, now() - ${seed.updatedAgo ?? '0 seconds'}::interval,
        now() + ${seed.expiresIn ?? '30 days'}::interval - ${seed.receivedAgo ?? '0 seconds'}::interval,
        ${status === 'settled' ? sql`now() - ${seed.settledAgo ?? '0 seconds'}::interval` : null},
        ${seed.movePendingAgo ? sql`now() - ${seed.movePendingAgo}::interval` : null},
        ${seed.erasureDeferred ? sql`now()` : null})`)
    return id
  }

  interface PartSeed {
    position?: number
    kind?: 'message' | 'attachment'
    state?: 'waiting' | 'dismissed' | 'expired'
    bytes?: boolean
    endedAgo?: string
    scan?: 'clean' | 'failed'
    scannedAgo?: string
    attempts?: number
    deferred?: boolean
  }

  async function seedPart(mailId: string, seed: PartSeed = {}): Promise<string> {
    const id = crypto.randomUUID()
    const { project_id: projectId } = await one<{ project_id: string }>(sql`SELECT project_id FROM inbound_mails WHERE id = ${mailId}::uuid`)
    const kind = seed.kind ?? 'attachment'
    const position = seed.position ?? (kind === 'message' ? 0 : 1)
    const bytes = kind === 'attachment' && (seed.bytes ?? true)
    const state = seed.state ?? 'waiting'
    const ended = state === 'dismissed' || state === 'expired'
    await rows(sql`
      INSERT INTO inbound_mail_parts (id, organization_id, project_id, mail_id, position, kind, filename, content_type,
        size_bytes, sha256, storage_key, state, scan_status, scanned_at, scan_attempts, ended_at, erasure_deferred_at)
      VALUES (${id}::uuid, ${ORG}, ${projectId}::uuid, ${mailId}::uuid, ${position}, ${kind},
        ${bytes ? `S-10${position}.pdf` : null}, ${kind === 'message' ? 'text/plain' : 'application/pdf'}, 2048, repeat('b', 64),
        ${bytes ? stagingKey(projectId, mailId, String(position)) : null}, ${state},
        ${kind === 'message' ? 'not_applicable' : (seed.scan ?? 'clean')},
        ${kind === 'message' ? null : sql`now() - ${seed.scannedAgo ?? '0 seconds'}::interval`},
        ${seed.attempts ?? 1},
        ${ended ? sql`now() - ${seed.endedAgo ?? '0 seconds'}::interval` : null},
        ${seed.deferred ? sql`now()` : null})`)
    return id
  }

  async function seedDecision(mailId: string, partId: string, seed: { action?: 'file' | 'dismiss'; audited?: boolean; decidedAgo?: string } = {}): Promise<string> {
    const { project_id: projectId } = await one<{ project_id: string }>(sql`SELECT project_id FROM inbound_mails WHERE id = ${mailId}::uuid`)
    const { id } = await one<{ id: string }>(sql`
      INSERT INTO inbound_mail_decisions (organization_id, project_id, mail_id, part_id, action, folder_path, decided_by, decided_at, audited_at)
      VALUES (${ORG}, ${projectId}::uuid, ${mailId}::uuid, ${partId}::uuid, ${seed.action ?? 'dismiss'},
        ${seed.action === 'file' ? '' : null}, ${DECIDER},
        now() - ${seed.decidedAgo ?? '2 minutes'}::interval, ${seed.audited === false ? null : sql`now()`})
      RETURNING id`)
    return id
  }

  async function seedThread(seed: { projectId?: string; documentId?: string | null; createdAgo?: string } = {}): Promise<string> {
    const { id } = await one<{ id: string }>(sql`
      INSERT INTO mail_threads (organization_id, project_id, document_id, base_subject, locale, created_by, created_at)
      VALUES (${ORG}, ${(seed.projectId ?? project)}::uuid, ${seed.documentId ?? null}, 'Statik Dach', 'de', ${MANAGER},
        now() - ${seed.createdAgo ?? '2 hours'}::interval)
      RETURNING id`)
    return id
  }

  async function seedEntry(threadId: string, projectId: string, withOriginal: boolean): Promise<string> {
    const id = crypto.randomUUID()
    const key = withOriginal ? originalKey(projectId, id) : null
    await rows(sql`
      INSERT INTO mail_thread_entries (id, organization_id, project_id, thread_id, source, inbound_mail_id, message_id,
        sent_at, received_at, heading, sender_trust, own_text, filed_by, filed_via,
        original_bucket, original_storage_key, original_sha256, original_bytes, original_scan_status)
      VALUES (${id}::uuid, ${ORG}, ${projectId}::uuid, ${threadId}::uuid, 'inbound', gen_random_uuid(), ${`${id}@statik.at`},
        now() - interval '1 day', now(), ${`Huber ${id}`}, 'external_verified', 'Die Bewehrung passt.', ${MANAGER}, 'app',
        ${withOriginal ? BUCKET : null}, ${key}, ${withOriginal ? 'a'.repeat(64) : null}, ${withOriginal ? 2048 : null},
        ${withOriginal ? 'clean' : null})`)
    await rows(sql`
      INSERT INTO mail_thread_message_ids (organization_id, project_id, thread_id, message_id, state, entry_id)
      VALUES (${ORG}, ${projectId}::uuid, ${threadId}::uuid, ${`${id}@statik.at`}, 'received', ${id}::uuid)`)
    return id
  }

  const mailRow = (id: string) =>
    one<{
      status: string
      raw_storage_key: string | null
      read_storage_key: string | null
      sender_address: string | null
      erasure_deferred_at: Date | null
      expiring_notified_at: Date | null
      original_move_pending_at: Date | null
      raw_scan_status: string
      raw_scan_attempts: number
    } | undefined>(sql`SELECT * FROM inbound_mails WHERE id = ${id}::uuid`)
  const partRow = (id: string) =>
    one<{ state: string; storage_key: string | null; filename: string | null; ended_at: Date | null; erasure_deferred_at: Date | null; last_failure: string | null; decision_id: string | null; scan_status: string; scan_attempts: number } | undefined>(
      sql`SELECT * FROM inbound_mail_parts WHERE id = ${id}::uuid`,
    )
  const inboxRows = (type: string) =>
    rows<{ recipient_user_id: string; group_key: string; anchor_id: string | null; count: number; resolved_at: Date | null; payload: Record<string, unknown> }>(
      sql`SELECT * FROM inbox_items WHERE organization_id = ${ORG} AND type = ${type} ORDER BY created_at`,
    )

  async function hold(projectId: string): Promise<string> {
    const { id } = await one<{ id: string }>(sql`
      INSERT INTO legal_holds (entity_type, entity_id, organization_id, reason, created_by)
      VALUES ('project', ${projectId}, ${ORG}, 'sweep spec', ${MANAGER}) RETURNING id`)
    return id
  }
  const release = (holdId: string) => rows(sql`UPDATE legal_holds SET released_at = now() WHERE id = ${holdId}::uuid`)

  async function newProject(name: string): Promise<{ projectId: string; addressId: string }> {
    const { id: projectId } = await one<{ id: string }>(sql`
      INSERT INTO projects (organization_id, name, created_by, collection_name)
      VALUES (${ORG}, ${name}, ${MANAGER}, ${`coll_sweep_${STAMP}_${name.length}_${Math.random().toString(36).slice(2, 8)}`}) RETURNING id`)
    const token = (STAMP + Math.random().toString(36).slice(2)).replace(/[^a-z2-7]/g, 'a').padEnd(12, 'q').slice(-12)
    const { id: addressId } = await one<{ id: string }>(sql`
      INSERT INTO inbound_mail_addresses (organization_id, project_id, token, created_by)
      VALUES (${ORG}, ${projectId}::uuid, ${token}, ${MANAGER}) RETURNING id`)
    return { projectId, addressId }
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    sweep = await import('./sweep')
    announce = await import('./announce')
    ;({ projectId: project, addressId: address } = await newProject('Wohnbau Hietzing'))
    ;({ projectId: heldProject, addressId: heldAddress } = await newProject('Gehalten'))
  })

  beforeEach(() => {
    staging.erased.length = 0
    staging.failing.clear()
    audit.events.length = 0
    posthog.events.length = 0
    scan.status = 'clean'
  })

  afterAll(async () => {
    await withPlatformAccess('test cleanup', () => db.execute(sql`UPDATE legal_holds SET released_at = now() WHERE organization_id = ${ORG}`))
    await withPlatformAccess('test cleanup', () => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
    await withPlatformAccess('test cleanup', () => db.execute(sql`DELETE FROM inbox_items WHERE organization_id = ${ORG}`))
    await withPlatformAccess('test cleanup', () => db.execute(sql`DELETE FROM bff_job_queue WHERE lane = ${ORG}`))
  })

  const now = () => new Date()

  describe('sweep 1: receptions that never finished', () => {
    it('erases a stale reception’s object by its key and deletes the row; a fresh one and a held project’s stay', async () => {
      const stale = await seedMail({ status: 'receiving', updatedAgo: '20 minutes' })
      const fresh = await seedMail({ status: 'receiving' })
      const heldStale = await seedMail({ status: 'receiving', updatedAgo: '20 minutes', projectId: heldProject })
      const holdId = await hold(heldProject)
      try {
        const result = await sweep.sweepStaleReceptions(now())

        expect(await mailRow(stale)).toBeUndefined()
        expect(staging.erased).toContain(stagingKey(project, stale, 'raw.eml'))
        expect(await mailRow(fresh)).toBeDefined()
        expect(await mailRow(heldStale)).toBeDefined()
        expect(staging.erased).not.toContain(stagingKey(heldProject, heldStale, 'raw.eml'))
        expect(result.deleted).toBeGreaterThanOrEqual(1)
      } finally {
        await release(holdId)
      }
    })

    it('keeps the row while its object could not be erased: the key goes only with the object', async () => {
      const stale = await seedMail({ status: 'receiving', updatedAgo: '20 minutes' })
      staging.failing.add(stagingKey(project, stale, 'raw.eml'))
      vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await sweep.sweepStaleReceptions(now())

      expect(await mailRow(stale)).toBeDefined()
      expect(result.errors).toBeGreaterThanOrEqual(1)
    })
  })

  describe('sweep 2: received mail whose job is gone', () => {
    it('queues the receive job again under the mail’s id, and leaves a mail whose job is dead to the queue’s retention', async () => {
      const orphan = await seedMail({ status: 'received', updatedAgo: '10 minutes' })
      const dead = await seedMail({ status: 'received', updatedAgo: '10 minutes' })
      await rows(sql`INSERT INTO bff_job_queue (job_id, kind, lane, payload, status, dead_at)
                     VALUES (${dead}::uuid, 'inbound_mail_receive', ${ORG}, '{}'::jsonb, 'dead', now())`)
      vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await sweep.sweepOrphanedReceptions(now())

      const jobs = await rows<{ job_id: string; status: string; kind: string }>(
        sql`SELECT job_id, status, kind FROM bff_job_queue WHERE job_id IN (${orphan}::uuid, ${dead}::uuid) ORDER BY status`,
      )
      expect(jobs).toEqual([
        { job_id: dead, status: 'dead', kind: 'inbound_mail_receive' },
        { job_id: orphan, status: 'queued', kind: 'inbound_mail_receive' },
      ])
      expect(result.requeued).toBeGreaterThanOrEqual(1)
      expect(result.dead).toBeGreaterThanOrEqual(1)
      // A second run finds a live job and queues nothing.
      expect((await sweep.sweepOrphanedReceptions(now())).requeued).toBe(0)
    })
  })

  describe('sweep 3: the window runs out', () => {
    it('expires what still waits, restorable from now, audited with exactly its project and part count, and settles the waiting notice', async () => {
      const mail = await seedMail({ receivedAgo: '31 days' })
      const text = await seedPart(mail, { kind: 'message' })
      const file = await seedPart(mail)
      await announce.announceWaiting({ organizationId: ORG, projectId: project, mailId: mail, senderTrust: 'external_verified', senderUserId: null, senderFlags: [], automatic: false })
      expect((await inboxRows('inbound_mail.waiting')).filter((row) => row.resolved_at === null)).toHaveLength(1)

      const result = await sweep.sweepExpiredMails(now())

      expect(result.expired).toBeGreaterThanOrEqual(1)
      for (const part of [text, file]) {
        const row = await partRow(part)
        expect(row?.state).toBe('expired')
        expect(row?.ended_at).not.toBeNull()
        // Expired, not erased: the seven days to restore start now.
        expect(row?.state === 'expired' && (part === text || row.storage_key !== null)).toBe(true)
      }
      expect(audit.events).toContainEqual({ action: 'inbound_mail.expired', metadata: { projectId: project, parts: 2 } })
      expect((await inboxRows('inbound_mail.waiting')).every((row) => row.resolved_at !== null)).toBe(true)
    })

    it('leaves a mail whose window a restore moved', async () => {
      const mail = await seedMail({ receivedAgo: '31 days', expiresIn: '40 days' })
      const part = await seedPart(mail)

      await sweep.sweepExpiredMails(now())

      expect((await partRow(part))?.state).toBe('waiting')
    })
  })

  describe('sweep 4: five days left', () => {
    it('tells the managers once per mail, in the project’s collapsed row, naming no sender', async () => {
      const mail = await seedMail({ receivedAgo: '26 days' })
      await seedPart(mail)
      const notYet = await seedMail({ receivedAgo: '10 days' })
      await seedPart(notYet)

      // Two scheduler replicas at once: both find the mail, one tells.
      await Promise.all([sweep.sweepExpiringMails(now()), sweep.sweepExpiringMails(now())])
      await sweep.sweepExpiringMails(now())

      expect((await mailRow(mail))?.expiring_notified_at).not.toBeNull()
      expect((await mailRow(notYet))?.expiring_notified_at).toBeNull()
      // The mark is a compare-and-set: a replica that found the mail before it was marked tells nothing.
      const { claimExpiringNotice } = await import('./sweep-repository')
      expect(await inTenant(() => claimExpiringNotice(mail, now()))).toBe(false)
      const told = await inboxRows('inbound_mail.expiring')
      expect(told).toHaveLength(1)
      expect(told[0]).toMatchObject({ recipient_user_id: MANAGER, group_key: `inbound_mail.expiring:project:${project}`, count: 1 })
      expect(told[0]?.payload).toEqual({ subject: 'Wohnbau Hietzing' })
    })
  })

  describe('sweep 5: filing claims that ran out', () => {
    it('puts the part back to waiting as `unavailable` and tells the decider once', async () => {
      const mail = await seedMail()
      const part = await seedPart(mail)
      const decision = await seedDecision(mail, part, { action: 'file' })
      await rows(sql`UPDATE inbound_mail_parts SET state = 'filing', decision_id = ${decision}::uuid, claim_expires_at = now() - interval '1 minute'
                     WHERE id = ${part}::uuid`)

      await sweep.sweepLapsedClaims(now())

      expect(await partRow(part)).toMatchObject({ state: 'waiting', last_failure: 'unavailable', decision_id: null })
      const failed = await inboxRows('inbound_mail.filing_failed')
      expect(failed).toHaveLength(1)
      expect(failed[0]).toMatchObject({ recipient_user_id: DECIDER, anchor_id: mail, payload: { subject: 'Wohnbau Hietzing', variant: 'unavailable' } })
    })
  })

  describe('sweep 6: past the seven days', () => {
    it('erases an ended part’s bytes in an unheld project and defers them in a held one', async () => {
      const mail = await seedMail()
      await seedPart(mail, { kind: 'message' })
      const free = await seedPart(mail, { state: 'dismissed', endedAgo: '8 days' })
      const recent = await seedPart(mail, { position: 2, state: 'expired', endedAgo: '1 day' })
      const heldMail = await seedMail({ projectId: heldProject })
      const held = await seedPart(heldMail, { state: 'expired', endedAgo: '8 days' })
      const holdId = await hold(heldProject)
      try {
        await sweep.sweepEndedParts(now())

        expect(await partRow(free)).toMatchObject({ state: 'dismissed', storage_key: null, filename: null })
        expect(staging.erased).toContain(stagingKey(project, mail, '1'))
        expect((await partRow(recent))?.storage_key).not.toBeNull()
        const heldRow = await partRow(held)
        expect(heldRow?.storage_key).not.toBeNull()
        expect(heldRow?.erasure_deferred_at).not.toBeNull()
        expect(staging.erased).not.toContain(stagingKey(heldProject, heldMail, '1'))
      } finally {
        await release(holdId)
      }
    })

    it('settles and scrubs a mail nothing of which waits or can be restored, erasing its staged objects by key', async () => {
      const mail = await seedMail()
      await seedPart(mail, { kind: 'message', state: 'expired', endedAgo: '8 days' })
      await seedPart(mail, { state: 'dismissed', endedAgo: '8 days', bytes: false })

      await sweep.sweepEndedParts(now())

      expect(await mailRow(mail)).toMatchObject({ status: 'settled', raw_storage_key: null, read_storage_key: null, sender_address: null })
      expect(staging.erased).toEqual(expect.arrayContaining([stagingKey(project, mail, 'read.json'), stagingKey(project, mail, 'raw.eml')]))
    })

    it('erases a dismissed part of mail from an unconfirmed outside domain at once (D8)', async () => {
      const mail = await seedMail({ trust: 'external_unverified' })
      await seedPart(mail, { kind: 'message', state: 'dismissed' })
      const file = await seedPart(mail, { state: 'dismissed' })

      await sweep.sweepEndedParts(now())

      expect((await partRow(file))?.storage_key).toBeNull()
      expect((await mailRow(mail))?.status).toBe('settled')
    })

    it('settles a held project’s mail but keeps its keys, deferred, for sweep 10', async () => {
      const mail = await seedMail({ projectId: heldProject })
      await seedPart(mail, { kind: 'message', state: 'dismissed', endedAgo: '8 days' })
      const holdId = await hold(heldProject)
      try {
        await sweep.sweepEndedParts(now())

        const row = await mailRow(mail)
        expect(row?.status).toBe('settled')
        expect(row?.raw_storage_key).not.toBeNull()
        expect(row?.erasure_deferred_at).not.toBeNull()
        expect(staging.erased).not.toContain(stagingKey(heldProject, mail, 'raw.eml'))
      } finally {
        await release(holdId)
      }
    })

    it('leaves a mail with a part still restorable', async () => {
      const mail = await seedMail()
      await seedPart(mail, { kind: 'message', state: 'dismissed', endedAgo: '2 days' })

      await sweep.sweepEndedParts(now())

      expect((await mailRow(mail))?.status).toBe('waiting')
    })
  })

  describe('sweep 7: failed scans', () => {
    it('scans a failed part and a failed raw message again an hour on, counted, up to 24 times', async () => {
      const mail = await seedMail({ rawScan: 'failed', rawScannedAgo: '2 hours', rawScanAttempts: 3 })
      const due = await seedPart(mail, { scan: 'failed', scannedAgo: '2 hours', attempts: 1 })
      const tooSoon = await seedPart(mail, { position: 2, scan: 'failed', scannedAgo: '10 minutes', attempts: 1 })
      const spent = await seedPart(mail, { position: 3, scan: 'failed', scannedAgo: '2 hours', attempts: 24 })

      const result = await sweep.sweepFailedScans(now())

      expect(await partRow(due)).toMatchObject({ scan_status: 'clean', scan_attempts: 2 })
      expect(await partRow(tooSoon)).toMatchObject({ scan_status: 'failed', scan_attempts: 1 })
      expect(await partRow(spent)).toMatchObject({ scan_status: 'failed', scan_attempts: 24 })
      expect(await mailRow(mail)).toMatchObject({ raw_scan_status: 'clean', raw_scan_attempts: 4 })
      expect(result.clean).toBeGreaterThanOrEqual(2)
    })
  })

  describe('sweep 10: erasures a hold deferred', () => {
    it('waits while the hold stands, and erases by key once it is released', async () => {
      const mail = await seedMail({ projectId: heldProject, status: 'settled', raw: true, read: true, erasureDeferred: true })
      const part = await seedPart(mail, { state: 'dismissed', endedAgo: '9 days', deferred: true })
      const holdId = await hold(heldProject)

      await sweep.sweepReleasedErasures(now())
      expect((await partRow(part))?.storage_key).not.toBeNull()
      expect((await mailRow(mail))?.raw_storage_key).not.toBeNull()

      await release(holdId)
      await sweep.sweepReleasedErasures(now())

      expect(await partRow(part)).toMatchObject({ storage_key: null, filename: null, erasure_deferred_at: null })
      expect(await mailRow(mail)).toMatchObject({ raw_storage_key: null, read_storage_key: null, erasure_deferred_at: null })
      expect(staging.erased).toEqual(
        expect.arrayContaining([
          stagingKey(heldProject, mail, '1'),
          stagingKey(heldProject, mail, 'raw.eml'),
          stagingKey(heldProject, mail, 'read.json'),
        ]),
      )
    })
  })

  describe('sweeps 11 and 8: the trail first, then the rows past their keep', () => {
    it('deletes settled and dropped rows past their keep; keeps one with a decision owed, then deletes it once sweep 11 sent it', async () => {
      const settled = await seedMail({ status: 'settled', settledAgo: '31 days', raw: false, read: false })
      const settledPart = await seedPart(settled, { kind: 'message', state: 'dismissed', endedAgo: '40 days' })
      await seedDecision(settled, settledPart)
      const owed = await seedMail({ status: 'settled', settledAgo: '31 days', raw: false, read: false })
      const owedPart = await seedPart(owed, { kind: 'message', state: 'dismissed', endedAgo: '40 days' })
      await seedDecision(owed, owedPart, { audited: false })
      const dropped = await seedMail({ status: 'dropped', receivedAgo: '31 days', raw: false })
      const young = await seedMail({ status: 'settled', settledAgo: '2 days', raw: false, read: false })

      await sweep.sweepKeptMails(now())

      expect(await mailRow(settled)).toBeUndefined()
      expect(await mailRow(dropped)).toBeUndefined()
      expect(await mailRow(owed)).toBeDefined()
      expect(await mailRow(young)).toBeDefined()

      await sweep.sweepUnauditedDecisions(now())
      expect(audit.events.map((event) => event.action)).toContain('inbound_mail.decided')
      await sweep.sweepKeptMails(now())

      expect(await mailRow(owed)).toBeUndefined()
    })

    it('runs 11 before 8 in one pass, so a mail owed to the trail goes in the same run', async () => {
      const owed = await seedMail({ status: 'settled', settledAgo: '31 days', raw: false, read: false })
      const part = await seedPart(owed, { kind: 'message', state: 'dismissed', endedAgo: '40 days' })
      await seedDecision(owed, part, { audited: false })

      const result = await sweep.sweepInboundMail(now())

      expect(result.audits.sent).toBeGreaterThanOrEqual(1)
      expect(await mailRow(owed)).toBeUndefined()
    })

    it('keeps a held project’s rows past their keep while an unheld project’s go', async () => {
      const free = await seedMail({ status: 'dropped', receivedAgo: '31 days', raw: false })
      const held = await seedMail({ status: 'dropped', receivedAgo: '31 days', raw: false, projectId: heldProject })
      const holdId = await hold(heldProject)
      try {
        await sweep.sweepKeptMails(now())

        expect(await mailRow(free)).toBeUndefined()
        expect(await mailRow(held)).toBeDefined()
      } finally {
        await release(holdId)
      }
    })
  })

  describe('sweep 12: follows', () => {
    it('ends a follow past its end (audited, settles its renewal row) and asks a follower with five days left, once', async () => {
      const documentId = (
        await one<{ id: string }>(sql`
          INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
          VALUES (${ORG}, ${MANAGER}, 'Statik Dach.md', ${`k/sweep/${STAMP}/1`}, 'coll', 'completed', 'project', ${project}::uuid)
          RETURNING id`)
      ).id
      const thread = await seedThread({ documentId })
      const { id: lapsed } = await one<{ id: string }>(sql`
        INSERT INTO mail_thread_follows (organization_id, project_id, thread_id, user_id, created_at, expires_at)
        VALUES (${ORG}, ${project}::uuid, ${thread}::uuid, ${MANAGER}, now() - interval '70 days', now() - interval '10 days') RETURNING id`)
      const { id: ending } = await one<{ id: string }>(sql`
        INSERT INTO mail_thread_follows (organization_id, project_id, thread_id, user_id, created_at, expires_at)
        VALUES (${ORG}, ${project}::uuid, ${thread}::uuid, ${FOLLOWER}, now() - interval '57 days', now() + interval '3 days') RETURNING id`)

      // Two scheduler replicas at once: both find the follows, one ends and one asks.
      await Promise.all([sweep.sweepFollows(now()), sweep.sweepFollows(now())])
      await sweep.sweepFollows(now())

      expect(audit.events.filter((event) => event.action === 'mail_thread.follow_ended' && event.metadata.followId === lapsed)).toHaveLength(1)
      expect(await one(sql`SELECT ended_reason, ended_by FROM mail_thread_follows WHERE id = ${lapsed}::uuid`)).toEqual({ ended_reason: 'expired', ended_by: null })
      expect(audit.events).toContainEqual({
        action: 'mail_thread.follow_ended',
        metadata: { projectId: project, followId: lapsed, reason: 'expired', followerUserId: MANAGER },
      })
      expect(posthog.events).toContainEqual({ event: 'mail_thread_followed', properties: { action: 'end', reason: 'expired' } })
      const asked = await inboxRows('mail_thread.follow_expiring')
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ recipient_user_id: FOLLOWER, anchor_id: ending, count: 1 })
    })

    it('ends every follow of a thread whose document is gone (`document_gone`)', async () => {
      const thread = await seedThread({ documentId: null })
      const { id: follow } = await one<{ id: string }>(sql`
        INSERT INTO mail_thread_follows (organization_id, project_id, thread_id, user_id, expires_at)
        VALUES (${ORG}, ${project}::uuid, ${thread}::uuid, ${FOLLOWER}, now() + interval '30 days') RETURNING id`)

      await sweep.sweepFollows(now())

      expect(await one(sql`SELECT ended_reason FROM mail_thread_follows WHERE id = ${follow}::uuid`)).toEqual({ ended_reason: 'document_gone' })
    })
  })

  describe('sweep 9: threads whose document is gone', () => {
    it('after a document is deleted, erases the originals by key, then leaves 0 entries and 0 message ids', async () => {
      const documentId = (
        await one<{ id: string }>(sql`
          INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
          VALUES (${ORG}, ${MANAGER}, 'Verlauf.md', ${`k/sweep/${STAMP}/2`}, 'coll', 'completed', 'project', ${project}::uuid)
          RETURNING id`)
      ).id
      const thread = await seedThread({ documentId })
      const withOriginal = await seedEntry(thread, project, true)
      await seedEntry(thread, project, false)
      await withPlatformAccess('spec: delete the thread document', () => db.execute(sql`DELETE FROM documents WHERE id = ${documentId}::uuid`))
      expect(await one(sql`SELECT document_id FROM mail_threads WHERE id = ${thread}::uuid`)).toEqual({ document_id: null })

      await sweep.sweepOrphanedThreads(now())

      expect(staging.erased).toContain(originalKey(project, withOriginal))
      expect(await one(sql`SELECT count(*)::int AS n FROM mail_threads WHERE id = ${thread}::uuid`)).toEqual({ n: 0 })
      expect(await one(sql`SELECT count(*)::int AS n FROM mail_thread_entries WHERE thread_id = ${thread}::uuid`)).toEqual({ n: 0 })
      expect(await one(sql`SELECT count(*)::int AS n FROM mail_thread_message_ids WHERE thread_id = ${thread}::uuid`)).toEqual({ n: 0 })
    })

    it('keeps a held project’s thread, a thread an original could not be erased from, a running follow’s and a young one', async () => {
      const held = await seedThread({ projectId: heldProject })
      await seedEntry(held, heldProject, true)
      const stuck = await seedThread()
      const stuckEntry = await seedEntry(stuck, project, true)
      staging.failing.add(originalKey(project, stuckEntry))
      const followed = await seedThread()
      await rows(sql`INSERT INTO mail_thread_follows (organization_id, project_id, thread_id, user_id, expires_at)
                     VALUES (${ORG}, ${project}::uuid, ${followed}::uuid, ${FOLLOWER}, now() + interval '30 days')`)
      const young = await seedThread({ createdAgo: '1 minute' })
      const freeThread = await seedThread()
      const holdId = await hold(heldProject)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await sweep.sweepOrphanedThreads(now())

        const left = await rows<{ id: string }>(
          sql`SELECT id FROM mail_threads WHERE id IN (${held}::uuid, ${stuck}::uuid, ${followed}::uuid, ${young}::uuid, ${freeThread}::uuid)`,
        )
        expect(new Set(left.map((row) => row.id))).toEqual(new Set([held, stuck, followed, young]))
        expect(staging.erased.some((key) => key.includes(heldProject))).toBe(false)
      } finally {
        await release(holdId)
      }
    })
  })

  describe('sweep 9 and the archive (D11)', () => {
    async function archiveThread(status: 'importing' | 'failed', pendingAgo: string): Promise<string> {
      const thread = await seedThread()
      await rows(sql`UPDATE mail_threads SET render_pending_at = now() - ${pendingAgo}::interval WHERE id = ${thread}::uuid`)
      const { id: importId } = await one<{ id: string }>(sql`
        INSERT INTO mail_imports (organization_id, project_id, user_id, filename, size_bytes, status, staging_bucket, staging_key, completed_at)
        VALUES (${ORG}, ${project}::uuid, ${MANAGER}, 'Archiv.pst', 1024, ${status}, ${BUCKET}, ${`org/${ORG}/mail-imports/${crypto.randomUUID()}.pst`},
          ${status === 'failed' ? sql`now()` : null})
        RETURNING id`)
      await rows(sql`
        INSERT INTO mail_thread_entries (organization_id, project_id, thread_id, source, mail_import_id, sent_at, received_at,
          heading, sender_trust, filed_by, filed_via)
        VALUES (${ORG}, ${project}::uuid, ${thread}::uuid, 'archive', ${importId}::uuid, now() - interval '9 days', now() - interval '9 days',
          ${`Mayer ${thread}`}, 'not_checked', ${MANAGER}, 'archive_import')`)
      return thread
    }

    it('leaves an archive Verlauf waiting for its first Fassung, and takes one whose import is over and that waited a day', async () => {
      const rendering = await archiveThread('importing', '2 days')
      const recent = await archiveThread('failed', '1 hour')
      const abandoned = await archiveThread('failed', '2 days')

      await sweep.sweepOrphanedThreads(now())

      const left = await rows<{ id: string }>(sql`SELECT id FROM mail_threads WHERE id IN (${rendering}::uuid, ${recent}::uuid, ${abandoned}::uuid)`)
      expect(new Set(left.map((row) => row.id))).toEqual(new Set([rendering, recent]))
    })

    it('takes a new archive Verlauf whose first Fassung the upload path refused for good, with its entries, without waiting a day', async () => {
      // `giveUpPendingRender` clears `render_pending_at`: the Verlauf never gets a document, its entries hold the text.
      const refused = await archiveThread('failed', '2 hours')
      await rows(sql`UPDATE mail_threads SET render_pending_at = NULL WHERE id = ${refused}::uuid`)

      await sweep.sweepOrphanedThreads(now())

      expect(await rows(sql`SELECT id FROM mail_threads WHERE id = ${refused}::uuid`)).toEqual([])
      expect(await rows(sql`SELECT id FROM mail_thread_entries WHERE thread_id = ${refused}::uuid`)).toEqual([])
    })
  })

  describe('sweep 13: an original’s move that stopped', () => {
    it('finishes the move: the copy proven, recorded on the entry, then the raw erased and forgotten', async () => {
      const thread = await seedThread()
      const entry = await seedEntry(thread, project, false)
      const mail = await seedMail({ status: 'settled', raw: true, read: false, movePendingAgo: '20 minutes' })
      await rows(sql`UPDATE mail_thread_entries SET inbound_mail_id = ${mail}::uuid WHERE id = ${entry}::uuid`)
      const young = await seedMail({ status: 'settled', raw: true, read: false, movePendingAgo: '1 minute' })

      const result = await sweep.sweepStalledMoves(now())

      expect(result.moved).toBeGreaterThanOrEqual(1)
      expect(await one(sql`SELECT original_storage_key FROM mail_thread_entries WHERE id = ${entry}::uuid`)).toEqual({
        original_storage_key: originalKey(project, entry),
      })
      expect(await mailRow(mail)).toMatchObject({ raw_storage_key: null, original_move_pending_at: null })
      expect(staging.erased).toContain(stagingKey(project, mail, 'raw.eml'))
      expect((await mailRow(young))?.original_move_pending_at).not.toBeNull()
    })
  })

  describe('the caps (D18)', () => {
    it('tells the managers once at 80%, and settles the notice once the address is below it', async () => {
      const { projectId, addressId } = await newProject('Volle Adresse')
      // 32 staged receptions of 26 MiB each: 832 MiB, past 80% of the 1 GiB address cap.
      await rows(sql`
        INSERT INTO inbound_mails (id, organization_id, project_id, address_id, status, raw_size_bytes, staging_bucket, raw_storage_key, received_at, expires_at)
        SELECT ids.id, ${ORG}, ${projectId}::uuid, ${addressId}::uuid, 'receiving', 27262976, ${BUCKET},
               'org/' || ${ORG} || '/project/' || ${projectId}::text || '/_inbound-mail/' || ids.id::text || '/raw.eml', now(), now() + interval '30 days'
          FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 32)) ids`)

      // Two scheduler replicas at once: both find the address, one tells.
      await Promise.all([sweep.sweepCaps(now()), sweep.sweepCaps(now())])
      await sweep.sweepCaps(now())

      expect(await one(sql`SELECT cap_notice FROM inbound_mail_addresses WHERE id = ${addressId}::uuid`)).toEqual({ cap_notice: 'nearly_full' })
      const told = await inboxRows('inbound_mail.cap_reached')
      expect(told).toHaveLength(1)
      expect(told[0]).toMatchObject({ recipient_user_id: MANAGER, anchor_id: addressId, count: 1, payload: { subject: 'Volle Adresse', variant: 'nearly_full' } })

      await rows(sql`UPDATE inbound_mails SET raw_storage_key = NULL WHERE address_id = ${addressId}::uuid`)
      await sweep.sweepCaps(now())

      expect(await one(sql`SELECT cap_notice, cap_noticed_at FROM inbound_mail_addresses WHERE id = ${addressId}::uuid`)).toEqual({
        cap_notice: null,
        cap_noticed_at: null,
      })
      expect((await inboxRows('inbound_mail.cap_reached'))[0]?.resolved_at).not.toBeNull()
    })
  })
})
