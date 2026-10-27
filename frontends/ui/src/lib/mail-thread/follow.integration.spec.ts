/**
 * @vitest-environment node
 *
 * „Verlauf folgen“ against a REAL Postgres with migration 0186, through the
 * restricted runtime role (`scripts/rls-test-db.sh`):
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/mail-thread/follow.integration.spec.ts
 *
 * Two halves. The first proves the follow SQL keeps the migration's rules
 * rather than meet a refusal in production: one running follow per person and
 * thread, a renewal never past 180 days from the start, an end recorded once;
 * the follow job's decision transaction with its caps (the follow's own per
 * day, the project's per day, two jobs racing for the last slot), a follow that
 * ended or is younger than the mail deciding nothing, and the database
 * refusing a follow decision by anyone but the follower.
 *
 * The second is the dynamic ratchet's follow half (DECISION §10, ratchet 3):
 * real DKIM-signed replies through the real receive job, the real follow job
 * and the real filing step, against a followed thread.
 *
 * - A reply whose References are signed, from a domain already in the thread,
 *   becomes exactly ONE new Fassung of the thread, filed as the follower, with
 *   its attachment still waiting for a person.
 * - A reply whose References are NOT signed, and one that brings a new domain
 *   into the conversation, queue no follow job, and the follow job, run for
 *   them anyway, files nothing: no Fassung, no decision.
 *
 * Mocked are only what is outside this tier or the database: the object store
 * (in memory), the scanner, the Python reader, DNS (the signatures are real),
 * the member directory and the identity provider, the folder rights (FGA), the
 * audit trail and the scores' transport, and the upload path past the decision
 * (`uploadDocument`, which here writes the Fassung an upload would).
 */

import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const store = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array>(),
  dns: null as unknown,
}))

vi.mock('@/lib/inbound-mail/staging', () => ({
  RAW_MESSAGE_CONTENT_TYPE: 'message/rfc822',
  readStagedObject: vi.fn(async (_bucket: string, key: string) => {
    const bytes = store.objects.get(key)
    if (!bytes) throw new Error(`no object ${key}`)
    return bytes
  }),
  putStagedObject: vi.fn(async (_bucket: string, key: string, body: Uint8Array) => {
    store.objects.set(key, body)
  }),
  eraseStagedObjects: vi.fn(async (_bucket: string, keys: readonly string[]) => {
    for (const key of keys) store.objects.delete(key)
    return []
  }),
  stagedObjectUrlForBackend: vi.fn(async (_bucket: string, key: string) => `http://store.test/${key}`),
}))
vi.mock('@/lib/malware-scan/client', () => ({
  scanForMalware: vi.fn(async () => ({
    status: 'clean',
    engine: { version: 'ClamAV 1.5.4', signatures: 28157, signaturesPublishedAt: new Date('2026-09-28') },
  })),
}))
vi.mock('@/lib/inbound-mail/read-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inbound-mail/read-client')>()),
  readMail: vi.fn(),
}))
vi.mock('@/lib/inbound-mail/sender-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inbound-mail/sender-auth')>()
  return {
    ...actual,
    authenticateSender: vi.fn((raw: Uint8Array, options: Parameters<typeof actual.authenticateSender>[1]) =>
      actual.authenticateSender(raw, { ...options, resolver: (store.dns as { resolver: never }).resolver }),
    ),
  }
})
vi.mock('@/lib/documents/accepted-types', () => ({
  acceptedTypesForOrganization: vi.fn(async () => ['.pdf', '.docx', '.txt', '.md']),
}))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/upload-screening/service', async (importOriginal) => {
  const { SUGGESTED_SCREENING_POLICY } = await import('@/lib/upload-screening/policy')
  return {
    ...(await importOriginal<typeof import('@/lib/upload-screening/service')>()),
    gatePolicy: vi.fn(async () => SUGGESTED_SCREENING_POLICY),
  }
})
vi.mock('@/lib/audit/after-commit', () => ({ recordAuditEventAfterCommit: vi.fn() }))
vi.mock('@/lib/audit/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/service')>()),
  recordAuditEventOrThrow: vi.fn(async () => undefined),
}))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/realtime/door-events', () => ({ publishProjectChanged: vi.fn() }))
vi.mock('@/lib/auth/pinned-session', () => ({
  resolvePinnedRequesterSession: vi.fn(),
  resolvePinnedRequesterSessionStrict: vi.fn(),
}))
vi.mock('@/lib/authz/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/feature-flags')>()),
  isInboundMailEnabled: vi.fn(() => true),
}))
vi.mock('@/lib/authz/folder-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/folder-access')>()),
  requireFolderWrite: vi.fn(async () => undefined),
  getHiddenFolderIds: vi.fn(async () => []),
}))
vi.mock('@/lib/inbound-mail/announce', () => ({
  announceWaiting: vi.fn(async () => true),
  announceAppended: vi.fn(async () => true),
  announceDecided: vi.fn(async () => true),
  announceFilingFailed: vi.fn(async () => true),
  settleFilingFailed: vi.fn(async () => undefined),
  settleFollowExpiring: vi.fn(async () => undefined),
  settleProjectNotices: vi.fn(async () => undefined),
}))
vi.mock('@/lib/inbound-mail/suggest-scores', () => ({ scoreMailDecision: vi.fn(() => 'no_suggestion') }))
vi.mock('@/lib/inbound-mail/quiet-batch', () => ({
  openQuietBatch: vi.fn(async () => crypto.randomUUID()),
  sealQuietBatch: vi.fn(async () => undefined),
}))
vi.mock('@/lib/inbox/service', () => ({ resolveInboxItemsAnchoredOn: vi.fn(async () => undefined) }))
vi.mock('@/lib/documents/service', () => ({ uploadDocument: vi.fn() }))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now().toString(36)
const ORG = `org_mail_follow_${STAMP}`
const MEMBER_ID = 'user_01J0FOLLOWSPEC0000000000A1'
const COLLEAGUE_ID = 'user_01J0FOLLOWSPEC0000000000B2'
const THIRD_ID = 'user_01J0FOLLOWSPEC0000000000C3'
const MEMBER_EMAIL = 'anna@buero-muster.at'
const DAY = 24 * 60 * 60 * 1000
const token = (seed: string) =>
  (STAMP + seed)
    .replace(/[^a-z2-7]/g, 'a')
    .padEnd(12, 'q')
    .slice(-12)

describe.skipIf(!url)('following an E-Mail-Verlauf against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./follow-repository')
  let reader: typeof import('@/lib/documents/document-reader')

  const session = {
    userId: MEMBER_ID,
    email: MEMBER_EMAIL,
    organizationId: ORG,
    organizationMembershipId: 'om_follow',
    role: 'member',
    permissions: ['project:documents:write'],
    featureFlags: ['inbound-mail'],
  } as unknown as import('@/lib/auth/types').AuthorizedSession

  const inTenant = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: ORG, userId: MEMBER_ID }, run)
  async function rows<T>(statement: ReturnType<typeof sql>): Promise<T[]> {
    return Array.from(await inTenant(() => db.execute(statement))) as T[]
  }
  const one = async <T>(statement: ReturnType<typeof sql>): Promise<T> => (await rows<T>(statement))[0] as T
  const count = async (statement: ReturnType<typeof sql>): Promise<number> =>
    Number((await one<{ count: string }>(statement)).count)

  /** A project with an address and a thread whose document is screened, with one filed message. */
  async function followedProject(seed: string): Promise<{ projectId: string; addressId: string; threadId: string; documentId: string; slug: string; token: string }> {
    const { id: projectId } = await one<{ id: string }>(sql`
      INSERT INTO projects (organization_id, name, created_by, collection_name)
      VALUES (${ORG}, ${`Wohnbau ${seed}`}, ${MEMBER_ID}, ${`coll_follow_${STAMP}_${seed}`}) RETURNING id`)
    const address = { slug: 'wohnbau', token: token(seed) }
    const { id: addressId } = await one<{ id: string }>(sql`
      INSERT INTO inbound_mail_addresses (organization_id, project_id, token, slug, created_by)
      VALUES (${ORG}, ${projectId}::uuid, ${address.token}, ${address.slug}, ${MEMBER_ID}) RETURNING id`)
    const markdown = '# Einreichplan\n'
    const { id: documentId } = await one<{ id: string }>(sql`
      INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, content_hash, screened_hash)
      VALUES (${ORG}, ${MEMBER_ID}, 'Einreichplan.md', ${`k/${STAMP}/${seed}/thread`}, ${`coll_follow_${STAMP}_${seed}`}, 'completed', 'project', ${projectId}::uuid,
              ${createHash('sha256').update(markdown).digest('hex')}, ${createHash('sha256').update(markdown).digest('hex')})
      RETURNING id`)
    const version = await one<{ id: string }>(sql`
      INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by, approved_by, approved_at)
      VALUES (${ORG}, ${documentId}::uuid, ${projectId}::uuid, 1, 'superseded', ${`k/${STAMP}/${seed}/thread/v1`}, ${MEMBER_ID}, ${MEMBER_ID}, now()) RETURNING id`)
    const { id: threadId } = await one<{ id: string }>(sql`
      INSERT INTO mail_threads (organization_id, project_id, document_id, base_subject, participant_domains, locale, created_by, entry_count, rendered_bytes, last_entry_at)
      VALUES (${ORG}, ${projectId}::uuid, ${documentId}::uuid, 'einreichplan', '{buero-muster.at}', 'de', ${MEMBER_ID}, 1, ${markdown.length}, now() - interval '2 days')
      RETURNING id`)
    const sentAt = new Date(Date.now() - 2 * DAY)
    const sender = {
      sentAt,
      receivedAt: sentAt,
      senderName: 'Anna Muster',
      senderAddress: MEMBER_EMAIL,
      senderDomain: 'buero-muster.at',
      signerDomain: 'buero-muster.at',
      senderTrust: 'member_verified' as const,
      source: 'inbound' as const,
    }
    const heading = (await import('./render')).entryHeadingBase(sender, 'de')
    const entry = await one<{ id: string }>(sql`
      INSERT INTO mail_thread_entries (organization_id, project_id, thread_id, source, inbound_mail_id, message_id, sent_at, received_at, heading,
                                       sender_trust, sender_name, sender_address, sender_domain, signer_domain, own_text, filed_by, filed_via, first_version_id, filed_at)
      VALUES (${ORG}, ${projectId}::uuid, ${threadId}::uuid, 'inbound', gen_random_uuid(), ${`m0-${seed}@buero-muster.at`}, ${sentAt.toISOString()}::timestamptz,
              ${sentAt.toISOString()}::timestamptz, ${heading}, 'member_verified', 'Anna Muster', ${MEMBER_EMAIL}, 'buero-muster.at', 'buero-muster.at',
              'Anbei der Einreichplan.', ${MEMBER_ID}, 'app', ${version.id}::uuid, ${sentAt.toISOString()}::timestamptz)
      RETURNING id`)
    await rows(sql`
      INSERT INTO mail_thread_message_ids (organization_id, project_id, thread_id, message_id, state, entry_id)
      VALUES (${ORG}, ${projectId}::uuid, ${threadId}::uuid, ${`m0-${seed}@buero-muster.at`}, 'received', ${entry.id}::uuid)`)
    return { projectId, addressId, threadId, documentId, ...address }
  }

  /** A waiting mail of the project with its text part, received `receivedAt`. */
  async function waitingMail(projectId: string, addressId: string, receivedAt: Date): Promise<{ mailId: string; textPart: string }> {
    const mailId = crypto.randomUUID()
    await rows(sql`
      INSERT INTO inbound_mails (id, organization_id, project_id, address_id, status, delivery_key, raw_size_bytes, staging_bucket,
        read_storage_key, raw_scan_status, raw_scanned_at, sender_address, sender_name, subject, base_subject,
        sender_trust, sender_reason, signer_domain, message_id, participants, participant_domains, sent_at, received_at, expires_at)
      VALUES (${mailId}::uuid, ${ORG}, ${projectId}::uuid, ${addressId}::uuid, 'waiting', ${mailId.replace(/-/g, '').padEnd(64, 'a')}, 2048, 'grid-org-test',
        ${`org/${ORG}/project/${projectId}/_inbound-mail/${mailId}/read.json`}, 'clean', now(), 'anna@buero-muster.at', 'Anna Muster', 'AW: Einreichplan', 'einreichplan',
        'external_verified', 'dkim_pass', 'buero-muster.at', ${`${mailId}@buero-muster.at`}, '[]'::jsonb, '{buero-muster.at}',
        ${receivedAt.toISOString()}::timestamptz, ${receivedAt.toISOString()}::timestamptz, now() + interval '30 days')`)
    const text = await one<{ id: string }>(sql`
      INSERT INTO inbound_mail_parts (organization_id, project_id, mail_id, position, kind, content_type, size_bytes, sha256, scan_status)
      VALUES (${ORG}, ${projectId}::uuid, ${mailId}::uuid, 0, 'message', 'text/plain', 12, ${'a'.repeat(64)}, 'not_applicable') RETURNING id`)
    return { mailId, textPart: text.id }
  }

  const decisionInput = (
    follow: { id: string; userId: string; threadId: string },
    projectId: string,
    mail: { mailId: string; textPart: string },
    receivedAt: Date,
  ) => ({
    follow,
    mail: { id: mail.mailId, organizationId: ORG, projectId, receivedAt },
    partId: mail.textPart,
    decision: { messageText: 'full' as const, documentType: 'correspondence' },
    claimExpiresAt: new Date(Date.now() + 300_000),
    now: new Date(),
  })

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', 'piloti.at')
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./follow-repository')
    reader = await import('@/lib/documents/document-reader')
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await withPlatformAccess('test cleanup', () => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
    await withPlatformAccess('test cleanup', () => db.execute(sql`DELETE FROM bff_job_queue WHERE lane = ${ORG}`))
  })

  // -------------------------------------------------------------------------
  // The follow SQL
  // -------------------------------------------------------------------------

  it('keeps one running follow per person and thread, renews within 180 days of its start, and ends it once', async () => {
    const { projectId, threadId } = await followedProject('rows')
    const now = new Date()
    const start = (userId: string) =>
      inTenant(() =>
        repo.startFollow({ organizationId: ORG, projectId, threadId, userId, createdAt: now, expiresAt: new Date(now.getTime() + 60 * DAY) }),
      )
    const follow = await start(MEMBER_ID)
    expect(follow).not.toBeNull()
    // A second follow of one person is refused by the partial unique index, quietly.
    expect(await start(MEMBER_ID)).toBeNull()
    // Several people may follow one thread.
    expect(await start(COLLEAGUE_ID)).not.toBeNull()

    const renewed = await inTenant(() => repo.renewFollow(follow!.id, new Date(now.getTime() + 400 * DAY), now))
    expect(new Date(renewed!.expiresAt).getTime()).toBe(new Date(follow!.createdAt).getTime() + 180 * DAY)
    expect(renewed!.renewedAt).not.toBeNull()

    const ended = await inTenant(() => repo.endFollow(follow!.id, { reason: 'unfollowed', endedBy: MEMBER_ID }))
    expect(ended).toMatchObject({ endedReason: 'unfollowed', endedBy: MEMBER_ID })
    expect(await inTenant(() => repo.endFollow(follow!.id, { reason: 'unfollowed', endedBy: MEMBER_ID }))).toBeNull()
    expect(await inTenant(() => repo.renewFollow(follow!.id, new Date(now.getTime() + DAY), now))).toBeNull()
    expect(await inTenant(() => repo.findRunningFollow(threadId, MEMBER_ID))).toBeNull()
    // Ended, the person may follow again.
    expect(await start(MEMBER_ID)).not.toBeNull()
    // An unfollow is the follower's own: the migration refuses it in another's name.
    const colleague = await inTenant(() => repo.findRunningFollow(threadId, COLLEAGUE_ID))
    await expect(inTenant(() => repo.endFollow(colleague!.id, { reason: 'unfollowed', endedBy: MEMBER_ID }))).rejects.toThrow()
  })

  it('tells a live thread document from a gone one, and from one held from the reader', async () => {
    const member = reader.memberReader(MEMBER_ID)
    const live = await followedProject('state')
    const state = (thread: { projectId: string; threadId: string }) =>
      inTenant(() => repo.findThreadDocumentState(thread.projectId, thread.threadId, member))
    expect(await state(live)).toBe('live')
    await rows(sql`UPDATE documents SET lifecycle = 'archived' WHERE id = ${live.documentId}::uuid`)
    expect(await state(live)).toBe('gone')
    await rows(sql`DELETE FROM documents WHERE id = ${live.documentId}::uuid`)
    expect(await state(live)).toBe('gone')
    // Held by its screening, uploaded by somebody else: not seen, and not gone either.
    const held = await followedProject('held')
    await rows(sql`UPDATE documents SET status = 'quarantined', created_by = ${COLLEAGUE_ID} WHERE id = ${held.documentId}::uuid`)
    expect(await state(held)).toBe('unseen')
  })

  it('writes the follower’s decision and claims the text, or nothing when the follow is not running', async () => {
    const { projectId, addressId, threadId } = await followedProject('decide')
    const created = new Date(Date.now() - 2 * DAY)
    const follow = await inTenant(() =>
      repo.startFollow({ organizationId: ORG, projectId, threadId, userId: MEMBER_ID, createdAt: created, expiresAt: new Date(Date.now() + 30 * DAY) }),
    )
    const ref = { id: follow!.id, userId: MEMBER_ID, threadId }

    // A mail that arrived before the follow follows nothing (D31 condition 1).
    const early = new Date(created.getTime() - DAY)
    const old = await waitingMail(projectId, addressId, early)
    expect(await inTenant(() => repo.writeFollowDecision(decisionInput(ref, projectId, old, early)))).toEqual({ kind: 'follow_not_running' })

    const received = new Date(Date.now() - 60_000)
    const mail = await waitingMail(projectId, addressId, received)
    const written = await inTenant(() => repo.writeFollowDecision(decisionInput(ref, projectId, mail, received)))
    expect(written.kind).toBe('written')
    expect(
      await one(sql`SELECT via, decided_by, follow_id, thread_action, mail_thread_id, message_text, folder_path, acknowledged_sender
                    FROM inbound_mail_decisions WHERE part_id = ${mail.textPart}::uuid`),
    ).toEqual({
      via: 'follow',
      decided_by: MEMBER_ID,
      follow_id: follow!.id,
      thread_action: 'append',
      mail_thread_id: threadId,
      message_text: 'full',
      folder_path: null,
      acknowledged_sender: false,
    })
    expect(await one(sql`SELECT state, decision_id IS NOT NULL AS claimed FROM inbound_mail_parts WHERE id = ${mail.textPart}::uuid`)).toEqual({
      state: 'filing',
      claimed: true,
    })
    // Decided, not appended yet: the E-Mail-Eingang names no follower until the text is filed.
    const { findFollowDeciders } = await import('@/lib/inbound-mail/repository')
    expect(await inTenant(() => findFollowDeciders([mail.mailId]))).toEqual(new Map())
    // Decided once: the text is no longer waiting.
    expect(await inTenant(() => repo.writeFollowDecision(decisionInput(ref, projectId, mail, received)))).toEqual({ kind: 'not_waiting' })

    // An ended follow decides nothing.
    await inTenant(() => repo.endFollow(follow!.id, { reason: 'unfollowed', endedBy: MEMBER_ID }))
    const after = await waitingMail(projectId, addressId, received)
    expect(await inTenant(() => repo.writeFollowDecision(decisionInput(ref, projectId, after, received)))).toEqual({ kind: 'follow_not_running' })
    expect(await count(sql`SELECT count(*) FROM inbound_mail_decisions WHERE part_id = ${after.textPart}::uuid`)).toBe(0)
  })

  it('refuses a follow decision by anyone but the follower (the composite key)', async () => {
    const { projectId, addressId, threadId } = await followedProject('fkey')
    const follow = await inTenant(() =>
      repo.startFollow({ organizationId: ORG, projectId, threadId, userId: MEMBER_ID, createdAt: new Date(Date.now() - DAY), expiresAt: new Date(Date.now() + DAY) }),
    )
    const mail = await waitingMail(projectId, addressId, new Date())
    const refused = await rows(sql`
        INSERT INTO inbound_mail_decisions (organization_id, project_id, mail_id, part_id, action, decided_by, via, follow_id, thread_action, mail_thread_id, message_text)
        VALUES (${ORG}, ${projectId}::uuid, ${mail.mailId}::uuid, ${mail.textPart}::uuid, 'file', ${COLLEAGUE_ID}, 'follow', ${follow!.id}::uuid, 'append', ${threadId}::uuid, 'full')`).then(
      () => null,
      (error: { cause?: { constraint_name?: string } }) => error.cause?.constraint_name,
    )
    expect(refused).toBe('inbound_mail_decisions_follower_fkey')
  })

  it('caps the appends of one follow per day, also when two jobs race for its last one', async () => {
    const { projectId, addressId, threadId } = await followedProject('cap')
    const follow = await inTenant(() =>
      repo.startFollow({
        organizationId: ORG, projectId, threadId, userId: MEMBER_ID, dailyCap: 1,
        createdAt: new Date(Date.now() - DAY), expiresAt: new Date(Date.now() + DAY),
      }),
    )
    const ref = { id: follow!.id, userId: MEMBER_ID, threadId }
    const received = new Date(Date.now() - 1_000)
    const [a, b] = [await waitingMail(projectId, addressId, received), await waitingMail(projectId, addressId, received)]
    const outcomes = await Promise.all([
      inTenant(() => repo.writeFollowDecision(decisionInput(ref, projectId, a, received))),
      inTenant(() => repo.writeFollowDecision(decisionInput(ref, projectId, b, received))),
    ])
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['follow_cap', 'written'])
    expect(await count(sql`SELECT count(*) FROM inbound_mail_decisions WHERE follow_id = ${follow!.id}::uuid`)).toBe(1)
  })

  it('caps the appends of all follows of one project per day', async () => {
    const { projectId, addressId, threadId } = await followedProject('projectcap')
    const created = new Date(Date.now() - DAY)
    const busy = await inTenant(() =>
      repo.startFollow({ organizationId: ORG, projectId, threadId, userId: COLLEAGUE_ID, dailyCap: 50, createdAt: created, expiresAt: new Date(Date.now() + DAY) }),
    )
    const mine = await inTenant(() =>
      repo.startFollow({ organizationId: ORG, projectId, threadId, userId: MEMBER_ID, createdAt: created, expiresAt: new Date(Date.now() + DAY) }),
    )
    // A hundred appends by the colleague's follow today, as decisions of one text.
    const filler = await waitingMail(projectId, addressId, new Date())
    await rows(sql`
      INSERT INTO inbound_mail_decisions (organization_id, project_id, mail_id, part_id, action, decided_by, via, follow_id, thread_action, mail_thread_id, message_text)
      SELECT ${ORG}, ${projectId}::uuid, ${filler.mailId}::uuid, ${filler.textPart}::uuid, 'file', ${COLLEAGUE_ID}, 'follow', ${busy!.id}::uuid, 'append', ${threadId}::uuid, 'full'
      FROM generate_series(1, 100)`)
    const received = new Date(Date.now() - 1_000)
    const mail = await waitingMail(projectId, addressId, received)
    expect(
      await inTenant(() => repo.writeFollowDecision(decisionInput({ id: mine!.id, userId: MEMBER_ID, threadId }, projectId, mail, received))),
    ).toEqual({ kind: 'project_cap' })
  })

  /** A transaction of another session that takes `lock`, then waits for the spec, then runs `then` and commits. */
  function holding(lock: ReturnType<typeof sql>, then: ReturnType<typeof sql>) {
    let release!: () => void
    let held!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const taken = new Promise<void>((resolve) => (held = resolve))
    const done = inTenant(() =>
      db.transaction(async (tx) => {
        await tx.execute(lock)
        held()
        await gate
        await tx.execute(then)
      }),
    )
    return { taken, release: async () => (release(), await done) }
  }

  it('counts the project’s appends under its lock: an append committed while it waited is counted', async () => {
    const { projectId, addressId, threadId } = await followedProject('projectlock')
    const created = new Date(Date.now() - DAY)
    const start = (userId: string) =>
      inTenant(() =>
        repo.startFollow({ organizationId: ORG, projectId, threadId, userId, dailyCap: 50, createdAt: created, expiresAt: new Date(Date.now() + DAY) }),
      )
    const [mine, third] = [await start(MEMBER_ID), await start(THIRD_ID)]
    const filler = await waitingMail(projectId, addressId, new Date())
    const fill = (n: number) => sql`
      INSERT INTO inbound_mail_decisions (organization_id, project_id, mail_id, part_id, action, decided_by, via, follow_id, thread_action, mail_thread_id, message_text)
      SELECT ${ORG}, ${projectId}::uuid, ${filler.mailId}::uuid, ${filler.textPart}::uuid, 'file', ${THIRD_ID}, 'follow', ${third!.id}::uuid, 'append', ${threadId}::uuid, 'full'
      FROM generate_series(1, ${n})`
    // 99 appends today: one slot left. Another follow job holds the project's lock and takes it.
    await rows(fill(99))
    const other = holding(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inbound_mail_follow:${projectId}`}, 0))`, fill(1))
    await other.taken
    const received = new Date(Date.now() - 1_000)
    const mail = await waitingMail(projectId, addressId, received)
    const deciding = inTenant(() => repo.writeFollowDecision(decisionInput({ id: mine!.id, userId: MEMBER_ID, threadId }, projectId, mail, received)))
    await new Promise((resolve) => setTimeout(resolve, 200))
    await other.release()
    expect(await deciding).toEqual({ kind: 'project_cap' })
  })

  it('decides under the follow’s row lock: an unfollow that held it first wins', async () => {
    const { projectId, addressId, threadId } = await followedProject('rowlock')
    const follow = await inTenant(() =>
      repo.startFollow({ organizationId: ORG, projectId, threadId, userId: MEMBER_ID, createdAt: new Date(Date.now() - DAY), expiresAt: new Date(Date.now() + DAY) }),
    )
    const unfollow = holding(
      sql`SELECT id FROM mail_thread_follows WHERE id = ${follow!.id}::uuid FOR UPDATE`,
      sql`UPDATE mail_thread_follows SET ended_at = now(), ended_by = ${MEMBER_ID}, ended_reason = 'unfollowed' WHERE id = ${follow!.id}::uuid`,
    )
    await unfollow.taken
    const received = new Date(Date.now() - 1_000)
    const mail = await waitingMail(projectId, addressId, received)
    const deciding = inTenant(() => repo.writeFollowDecision(decisionInput({ id: follow!.id, userId: MEMBER_ID, threadId }, projectId, mail, received)))
    await new Promise((resolve) => setTimeout(resolve, 200))
    await unfollow.release()
    expect(await deciding).toEqual({ kind: 'follow_not_running' })
    expect(await count(sql`SELECT count(*) FROM inbound_mail_decisions WHERE part_id = ${mail.textPart}::uuid`)).toBe(0)
  })

  // -------------------------------------------------------------------------
  // The dynamic ratchet's follow half
  // -------------------------------------------------------------------------

  describe('the dynamic ratchet’s follow half', () => {
    let project: Awaited<ReturnType<typeof followedProject>>
    let followId: string
    let hostile: typeof import('@/lib/inbound-mail/__fixtures__/hostile')
    const requester = {
      userId: MEMBER_ID,
      email: MEMBER_EMAIL,
      organizationMembershipId: 'om_follow',
      role: 'member',
      permissions: [],
    }

    beforeAll(async () => {
      hostile = await import('@/lib/inbound-mail/__fixtures__/hostile')
      store.dns = hostile.fakeDns(hostile.keyFor(hostile.MEMBER_DOMAIN))
      const { loadOrganizationDirectory } = await import('@/lib/sharing/directory')
      vi.mocked(loadOrganizationDirectory).mockResolvedValue(
        new Map([[MEMBER_ID, { userId: MEMBER_ID, email: MEMBER_EMAIL, name: 'Anna Muster', profilePictureUrl: null }]]),
      )
      const pinned = await import('@/lib/auth/pinned-session')
      vi.mocked(pinned.resolvePinnedRequesterSession).mockResolvedValue(session)
      vi.mocked(pinned.resolvePinnedRequesterSessionStrict).mockResolvedValue(session)
      const { readMail } = await import('@/lib/inbound-mail/read-client')
      vi.mocked(readMail).mockResolvedValue({
        readerVersion: 1,
        bodySource: 'plain',
        ownText: 'Passt so, danke.',
        ownTextTruncated: false,
        split: true,
        signatureRemoved: true,
        quoted: [],
        quotedTruncated: false,
        calendar: [],
        calendarTruncated: false,
        encrypted: false,
        unreadableReasons: [],
        unreadable: false,
      })
      const { uploadDocument } = await import('@/lib/documents/service')
      // The upload path past the decision: the next Fassung of the document of this name, as the person.
      vi.mocked(uploadDocument).mockImplementation(async (asWho, input) => {
        const bytes = new Uint8Array(await input.file.arrayBuffer())
        const hash = createHash('sha256').update(bytes).digest('hex')
        const [existing] = Array.from(
          await db.execute(sql`SELECT id FROM documents WHERE project_id = ${input.projectId}::uuid AND filename = ${input.file.name}`),
        ) as Array<{ id: string }>
        if (!existing) throw new Error('the follow half files only into an existing thread document')
        // Screened on arrival, as a Fassung that passed the content gate would be.
        await db.execute(sql`UPDATE documents SET content_hash = ${hash}, screened_hash = ${hash} WHERE id = ${existing.id}::uuid`)
        await db.execute(sql`
          INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by, approved_by, approved_at)
          SELECT ${asWho.organizationId}, ${existing.id}::uuid, ${input.projectId}::uuid, max(version_number) + 1, 'superseded',
                 ${`k/${STAMP}/v/${hash}`}, ${asWho.userId}, ${asWho.userId}, now()
          FROM document_versions WHERE document_id = ${existing.id}::uuid`)
        return { documentId: existing.id, jobId: 'job', status: 'pending', filename: input.file.name }
      })

      project = await followedProject('ratchet')
      const follow = await inTenant(() =>
        repo.startFollow({
          organizationId: ORG,
          projectId: project.projectId,
          threadId: project.threadId,
          userId: MEMBER_ID,
          createdAt: new Date(Date.now() - DAY),
          expiresAt: new Date(Date.now() + 30 * DAY),
        }),
      )
      followId = follow!.id
    })

    const threadVersionCount = () =>
      count(sql`SELECT count(*) FROM document_versions WHERE document_id = ${project.documentId}::uuid`)
    const followJobs = async (mailId: string) =>
      (
        Array.from(
          await withPlatformAccess('spec', () =>
            db.execute(sql`SELECT payload FROM bff_job_queue WHERE lane = ${ORG} AND kind = 'inbound_mail_follow'`),
          ),
        ) as Array<{ payload: { mailId: string } }>
      ).filter((job) => job.payload.mailId === mailId)

    /** A reply from the member's domain, signed for real over `headerList`, received through the real receive job. */
    async function receive(seed: string, headers: Record<string, string>, headerList: string): Promise<string> {
      const raw = await hostile.sign(
        hostile.message(
          hostile.multipart('mixed', [hostile.BODY, hostile.attachment(`S-${seed}.pdf`, 'application/pdf', hostile.pdf(`S ${seed}`))]),
          {
            To: `${project.slug}.${project.token}@piloti.at`,
            Subject: 'AW: Einreichplan',
            Date: new Date(Date.now() - 60_000).toUTCString(),
            'Message-ID': `<${seed}-${STAMP}@buero-muster.at>`,
            'In-Reply-To': `<m0-ratchet@buero-muster.at>`,
            References: `<m0-ratchet@buero-muster.at>`,
            ...headers,
          },
        ),
        { headerList },
      )
      const mailId = crypto.randomUUID()
      const rawKey = `org/${ORG}/project/${project.projectId}/_inbound-mail/${mailId}/raw.eml`
      store.objects.set(rawKey, hostile.bytes(raw))
      await rows(sql`
        INSERT INTO inbound_mails (id, organization_id, project_id, address_id, status, delivery_key, envelope_from, raw_size_bytes, staging_bucket, raw_storage_key, expires_at)
        VALUES (${mailId}::uuid, ${ORG}, ${project.projectId}::uuid, ${project.addressId}::uuid, 'received', ${createHash('sha256').update(mailId).digest('hex')},
                ${MEMBER_EMAIL}, ${raw.length}, 'grid-org-test', ${rawKey}, now() + interval '30 days')`)
      const { runInboundMailReceive } = await import('@/lib/inbound-mail/receive-job')
      await inTenant(() => runInboundMailReceive(ORG, { mailId, projectId: project.projectId }, { last: false }))
      return mailId
    }

    const runFollow = async (mailId: string) => {
      const { runInboundMailFollow } = await import('@/lib/inbound-mail/follow-job')
      return inTenant(() => runInboundMailFollow(ORG, { projectId: project.projectId, mailId, followId, requester }))
    }

    const SIGNED = 'from:to:subject:date:message-id:in-reply-to:references:mime-version:content-type'

    it('a reply with signed References becomes exactly one Fassung, filed as the follower; its attachment waits', async () => {
      const { uploadDocument } = await import('@/lib/documents/service')
      vi.mocked(uploadDocument).mockClear()
      const mailId = await receive('signed', {}, SIGNED)
      expect(await one(sql`SELECT status, sender_trust FROM inbound_mails WHERE id = ${mailId}::uuid`)).toEqual({
        status: 'waiting',
        sender_trust: 'member_verified',
      })
      expect(await followJobs(mailId)).toHaveLength(1)
      expect(await threadVersionCount()).toBe(1)

      expect(await runFollow(mailId)).toMatchObject({ done: true })

      expect(await threadVersionCount()).toBe(2)
      expect(uploadDocument).toHaveBeenCalledOnce()
      expect(vi.mocked(uploadDocument).mock.calls[0]![0].userId).toBe(MEMBER_ID)
      expect(
        await rows(sql`SELECT kind, state FROM inbound_mail_parts WHERE mail_id = ${mailId}::uuid ORDER BY position`),
      ).toEqual([
        { kind: 'message', state: 'filed' },
        { kind: 'attachment', state: 'waiting' },
      ])
      expect(
        await rows(sql`SELECT via, decided_by, follow_id FROM inbound_mail_decisions WHERE mail_id = ${mailId}::uuid`),
      ).toEqual([{ via: 'follow', decided_by: MEMBER_ID, follow_id: followId }])
      // The E-Mail-Eingang's `followedBy` names the follow's person, the one the job appended as.
      const { findFollowDeciders } = await import('@/lib/inbound-mail/repository')
      expect(await inTenant(() => findFollowDeciders([mailId]))).toEqual(new Map([[mailId, MEMBER_ID]]))
      expect(
        await one(sql`SELECT entry_count, filed_via FROM mail_threads t JOIN mail_thread_entries e ON e.thread_id = t.id
                      WHERE t.id = ${project.threadId}::uuid AND e.inbound_mail_id = ${mailId}::uuid`),
      ).toEqual({ entry_count: 2, filed_via: 'follow' })
      // Run again (a retry after a lost answer): nothing more.
      expect(await runFollow(mailId)).toMatchObject({ done: true })
      expect(await threadVersionCount()).toBe(2)
    })

    it('a reply whose References are outside the signature queues no follow, and the job files nothing for it', async () => {
      const before = await threadVersionCount()
      const mailId = await receive('unsigned', {}, 'from:to:subject:date:message-id:mime-version:content-type')
      expect(await followJobs(mailId)).toHaveLength(0)
      expect(await runFollow(mailId)).toMatchObject({ done: true })
      expect(await threadVersionCount()).toBe(before)
      expect(await count(sql`SELECT count(*) FROM inbound_mail_decisions WHERE mail_id = ${mailId}::uuid`)).toBe(0)
      expect(await one(sql`SELECT state FROM inbound_mail_parts WHERE mail_id = ${mailId}::uuid AND kind = 'message'`)).toEqual({
        state: 'waiting',
      })
    })

    it('a reply that brings a new domain into the conversation queues no follow, and the job files nothing for it', async () => {
      const before = await threadVersionCount()
      const mailId = await receive('newdomain', { Cc: 'neu@fremd-planer.at' }, `${SIGNED}:cc`)
      expect(await followJobs(mailId)).toHaveLength(0)
      expect(await runFollow(mailId)).toMatchObject({ done: true })
      expect(await threadVersionCount()).toBe(before)
      expect(await count(sql`SELECT count(*) FROM inbound_mail_decisions WHERE mail_id = ${mailId}::uuid`)).toBe(0)
    })
  })
})
