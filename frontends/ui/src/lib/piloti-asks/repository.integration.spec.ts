/**
 * @vitest-environment node
 *
 * The asks against a REAL Postgres (migration 0179, ADR-0124), through the
 * restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/piloti-asks/repository.integration.spec.ts
 *
 * The unit specs mock this module; these prove the SQL the service rests on:
 * another organization neither reads nor ends an ask (each function states its
 * organization and runs in that tenant scope, as the wake repository does); the first final word
 * stands; `working` only follows `submitted`; a continued conversation is
 * recognised by the asker alone; the outcome's lookup by id alone works under
 * the audited bypass and nowhere else.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_ask_${Date.now()}`
const OTHER_ORG = `${ORG}_other`
const ANNA = 'user_ask_anna'
const BERT = 'user_ask_bert'
const THREAD = `s_${randomUUID().replace(/-/g, '_')}`
const OTHER_THREAD = `s_${randomUUID().replace(/-/g, '_')}`

describe.skipIf(!url)('asks against Postgres', () => {
  let repo: typeof import('./repository')
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let db: ReturnType<typeof import('@/lib/db').getDb>

  const as = <T>(organizationId: string, run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId, userId: null }, run)

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    await as(ORG, () => db.execute(sql`INSERT INTO conversations (id, organization_id, created_by) VALUES (${THREAD}, ${ORG}, ${ANNA})`))
    await as(OTHER_ORG, () =>
      db.execute(sql`INSERT INTO conversations (id, organization_id, created_by) VALUES (${OTHER_THREAD}, ${OTHER_ORG}, ${BERT})`),
    )
  })

  afterAll(async () => {
    await withPlatformAccess('asks repository spec cleanup', () =>
      db.execute(sql`DELETE FROM conversations WHERE organization_id IN (${ORG}, ${OTHER_ORG})`),
    )
  })

  const newAsk = (organizationId = ORG, conversationId = THREAD, requestedBy = ANNA) =>
    as(organizationId, () => repo.insertAsk({ id: randomUUID(), organizationId, conversationId, requestedBy }))

  it('records an ask submitted, and only its organization reads it', async () => {
    const ask = await newAsk()
    expect(ask.state).toBe('submitted')
    expect(await as(ORG, () => repo.findAsk(ORG, ask.id))).toMatchObject({ id: ask.id })
    expect(await as(OTHER_ORG, () => repo.findAsk(OTHER_ORG, ask.id))).toBeNull()
  })

  it('refuses an ask on another organization’s conversation', async () => {
    await expect(newAsk(ORG, OTHER_THREAD)).rejects.toThrow()
  })

  it('moves to working only from submitted, and the first final word stands', async () => {
    const ask = await newAsk()
    expect(await as(ORG, () => repo.markAskWorking(ORG, ask.id))).toBe(true)
    expect(await as(ORG, () => repo.markAskWorking(ORG, ask.id))).toBe(false)
    const ended = await as(ORG, () => repo.endAsk(ORG, ask.id, { state: 'rejected', reason: '  budget:\n spent ' }))
    expect(ended).toMatchObject({ state: 'rejected', reason: 'budget: spent' })
    expect(ended?.endedAt).toBeInstanceOf(Date)
    expect(await as(ORG, () => repo.endAsk(ORG, ask.id, { state: 'completed' }))).toBeNull()
    expect(await as(ORG, () => repo.markAskWorking(ORG, ask.id))).toBe(false)
  })

  it('never ends another organization’s ask', async () => {
    const ask = await newAsk()
    expect(await as(OTHER_ORG, () => repo.endAsk(OTHER_ORG, ask.id, { state: 'canceled' }))).toBeNull()
    expect((await as(ORG, () => repo.findAsk(ORG, ask.id)))?.state).toBe('submitted')
  })

  it('clips a long reason to the bound the CHECK holds', async () => {
    const ask = await newAsk()
    const ended = await as(ORG, () => repo.endAsk(ORG, ask.id, { state: 'failed', reason: 'x'.repeat(900) }))
    expect(ended?.reason?.length).toBe(500)
  })

  it('knows a conversation an ask of this person started, and of nobody else', async () => {
    await newAsk()
    expect(await as(ORG, () => repo.hasAskedInConversation(ORG, THREAD, ANNA))).toBe(true)
    expect(await as(ORG, () => repo.hasAskedInConversation(ORG, THREAD, BERT))).toBe(false)
    expect(await as(OTHER_ORG, () => repo.hasAskedInConversation(OTHER_ORG, THREAD, ANNA))).toBe(false)
  })

  it('finds an ask by id alone only under the audited bypass', async () => {
    const ask = await newAsk()
    expect(await withPlatformAccess('turn outcome spec', () => repo.findAskById(ask.id))).toMatchObject({ organizationId: ORG })
    expect(await as(OTHER_ORG, () => repo.findAskById(ask.id))).toBeNull()
  })

  it('takes back only the question of the ask it names, in its own organization', async () => {
    const ask = await newAsk()
    const other = randomUUID()
    const insertQuestion = (id: string) =>
      as(ORG, () =>
        db.execute(sql`INSERT INTO messages (id, conversation_id, organization_id, role, content)
                       VALUES (${id}::uuid, ${THREAD}, ${ORG}, 'user', 'Und?')`),
      )
    await insertQuestion(ask.id)
    await insertQuestion(other)
    const count = (id: string) =>
      as(ORG, async () =>
        Number(Array.from(await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE id = ${id}::uuid`))[0]?.n),
      )
    await as(OTHER_ORG, () => repo.deleteAskQuestion(OTHER_ORG, THREAD, ask.id))
    expect(await count(ask.id)).toBe(1)
    await as(ORG, () => repo.deleteAskQuestion(ORG, THREAD, ask.id))
    expect(await count(ask.id)).toBe(0)
    expect(await count(other)).toBe(1)
  })

  it('goes with the thread it opened: deleting the conversation deletes the ask', async () => {
    const thread = `s_${randomUUID().replace(/-/g, '_')}`
    await as(ORG, () => db.execute(sql`INSERT INTO conversations (id, organization_id, created_by) VALUES (${thread}, ${ORG}, ${ANNA})`))
    const ask = await newAsk(ORG, thread)
    const { deleteConversationInOrg } = await import('@/lib/conversations/repository')
    await as(ORG, () => deleteConversationInOrg(thread, ORG))
    expect(await as(ORG, () => repo.findAsk(ORG, ask.id))).toBeNull()
  })

  it('lists no documents for an ask that filed none', async () => {
    const ask = await newAsk()
    expect(await as(ORG, () => repo.listAskDocuments(ask, { kind: 'member', userId: ANNA }))).toEqual([])
  })
})
