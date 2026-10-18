/**
 * @vitest-environment node
 *
 * The inbox list's paging against a REAL Postgres, through the restricted
 * runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/inbox/repository.integration.spec.ts
 *
 * What it proves, a claim about SQL a mocked handle cannot disagree with:
 * reading page after page with the cursor each page hands back returns every
 * row exactly once, newest first, also when rows share a microsecond (the id
 * breaks the tie) or only a millisecond (the cursor carries the stored
 * microsecond, which a JS `Date` would have rounded away).
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_inbox_paging_${Date.now()}`
const ME = 'user_inbox_paging'

describe.skipIf(!url)('inbox paging against Postgres', () => {
  let repo: typeof import('./repository')
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let db: ReturnType<typeof import('@/lib/db').getDb>

  const asMe = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: ORG, userId: ME }, run)

  /** Microsecond offsets from one base moment: ties, a shared millisecond, and plain steps. */
  const OFFSETS = [0, 0, 0, 1, 2, 999, 1000, 1000, 1500, 2000, 3001, 3001, 5000, 9000, 9001, 12000, 12000, 20000]

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    await asMe(async () => {
      for (const [index, offset] of OFFSETS.entries()) {
        await db.execute(sql`
          insert into inbox_items (organization_id, recipient_user_id, type, resource_type, resource_id,
                                   group_key, actionable, updated_at)
          values (${ORG}, ${ME}, 'conversation.activity', 'conversation', ${`c-${index}`},
                  ${`conversation.activity:conversation:${ORG}-${index}`}, false,
                  timestamptz '2026-10-01 10:00:00+00' + ${offset}::bigint * interval '1 microsecond')`)
      }
    })
  })

  afterAll(async () => {
    await withPlatformAccess('inbox paging spec cleanup', () =>
      db.execute(sql`DELETE FROM inbox_items WHERE organization_id = ${ORG}`)
    )
  })

  it('reads every row exactly once, newest first, page after page', async () => {
    const all = await asMe(() => repo.listInboxItems(ORG, ME, { limit: 100, types: repo.EVERY_INBOX_TYPE }))
    expect(all).toHaveLength(OFFSETS.length)
    expect(all.every((row) => typeof row.listedAtMicros === 'string')).toBe(true)

    for (const size of [1, 2, 3, 5]) {
      const seen: string[] = []
      let cursor: import('./repository').InboxCursor | null = null
      for (let guard = 0; guard < 100; guard++) {
        const page = await asMe(() => repo.listInboxItems(ORG, ME, { cursor, limit: size, types: repo.EVERY_INBOX_TYPE }))
        seen.push(...page.map((row) => row.id))
        const last = page.at(-1)
        if (page.length < size || !last?.listedAtMicros) break
        cursor = { micros: last.listedAtMicros, id: last.id }
      }
      expect(seen, `page size ${size}`).toEqual(all.map((row) => row.id))
    }
  })

  it('orders by the stored microsecond, then by id', async () => {
    const all = await asMe(() => repo.listInboxItems(ORG, ME, { limit: 100, types: repo.EVERY_INBOX_TYPE }))
    const keys = all.map((row) => [BigInt(row.listedAtMicros ?? '0'), row.id] as const)
    const sorted = [...keys].sort(([ta, ia], [tb, ib]) => (ta !== tb ? (tb > ta ? 1 : -1) : ia < ib ? 1 : ia > ib ? -1 : 0))
    expect(keys).toEqual(sorted)
  })
})

describe.skipIf(!url)('a deleted reply’s rows against Postgres', () => {
  const ANCHOR = '00000000-0000-4000-8000-0000000000aa'
  let repo: typeof import('./repository')
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let db: ReturnType<typeof import('@/lib/db').getDb>
  const REPLY_ORG = `${ORG}_reply`

  const asMe = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: REPLY_ORG, userId: ME }, run)

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    await asMe(async () => {
      for (const [index, payload] of [{ replyId: 'r1', excerpt: 'Eins' }, { replyId: 'r2' }, { replyId: null }, {}].entries()) {
        await db.execute(sql`
          insert into inbox_items (organization_id, recipient_user_id, type, resource_type, resource_id,
                                   anchor_id, group_key, actionable, payload)
          values (${REPLY_ORG}, ${ME}, 'annotation.activity', 'document', 'doc-1', ${ANCHOR},
                  ${`annotation.activity:document:doc-1:${index}`}, false, ${JSON.stringify(payload)}::jsonb)`)
      }
    })
  })

  afterAll(async () => {
    await withPlatformAccess('inbox reply spec cleanup', () =>
      db.execute(sql`DELETE FROM inbox_items WHERE organization_id = ${REPLY_ORG}`)
    )
  })

  it('turns inert only the rows that name the reply, and wipes their quote', async () => {
    const told = await asMe(() =>
      repo.markItemsInertAnchoredOn({
        organizationId: REPLY_ORG,
        types: ['annotation.activity'],
        anchorId: ANCHOR,
        payloadHas: { replyId: 'r1' },
      })
    )
    expect(told).toEqual([ME])
    const rows = await asMe(() =>
      db.execute<{ group_key: string; inert: boolean; payload: Record<string, unknown> }>(sql`
        select group_key, inert_at is not null as inert, payload from inbox_items
        where organization_id = ${REPLY_ORG} order by group_key`)
    )
    expect(Array.from(rows).map((row) => [row.group_key.slice(-1), row.inert, row.payload])).toEqual([
      ['0', true, {}],
      ['1', false, { replyId: 'r2' }],
      ['2', false, { replyId: null }],
      ['3', false, {}],
    ])
  })
})

/**
 * The review's dots (`listUnreadAnchors`) are the rows opening a mark reads
 * (`markAnchorItemsRead`): the recipient's own, informational, unread news
 * anchored on a mark of THIS document, less what they archived or what was
 * redacted. Read, the dot is gone.
 */
describe.skipIf(!url)('unread anchors of a document against Postgres', () => {
  const ORG_ANCHORS = `org_inbox_anchors_${Date.now()}`
  let repo: typeof import('./repository')
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let db: ReturnType<typeof import('@/lib/db').getDb>
  const asMe = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: ORG_ANCHORS, userId: ME }, run)

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    const rows: Array<{ recipient: string; resource: string; anchor: string | null; actionable: boolean; extra: string }> = [
      { recipient: ME, resource: 'doc-1', anchor: 'mark-news', actionable: false, extra: '' },
      // Two rows on one mark are one dot.
      { recipient: ME, resource: 'doc-1', anchor: 'mark-news', actionable: false, extra: '' },
      { recipient: ME, resource: 'doc-1', anchor: 'mark-read', actionable: false, extra: 'read' },
      { recipient: ME, resource: 'doc-1', anchor: 'mark-request', actionable: true, extra: '' },
      { recipient: ME, resource: 'doc-1', anchor: 'mark-archived', actionable: false, extra: 'archived' },
      { recipient: ME, resource: 'doc-1', anchor: 'mark-redacted', actionable: false, extra: 'inert' },
      { recipient: ME, resource: 'doc-1', anchor: null, actionable: false, extra: '' },
      { recipient: ME, resource: 'doc-2', anchor: 'mark-elsewhere', actionable: false, extra: '' },
      { recipient: 'user_someone_else', resource: 'doc-1', anchor: 'mark-theirs', actionable: false, extra: '' },
    ]
    await asMe(async () => {
      for (const [index, row] of rows.entries()) {
        await db.execute(sql`
          insert into inbox_items (organization_id, recipient_user_id, type, resource_type, resource_id, anchor_id,
                                   group_key, actionable, read_at, archived_at, inert_at)
          values (${ORG_ANCHORS}, ${row.recipient}, 'annotation.activity', 'document', ${row.resource}, ${row.anchor},
                  ${`annotation.activity:document:${ORG_ANCHORS}-${index}`}, ${row.actionable},
                  ${row.extra === 'read' ? sql`now()` : sql`null`}, ${row.extra === 'archived' ? sql`now()` : sql`null`},
                  ${row.extra === 'inert' ? sql`now()` : sql`null`})`)
      }
    })
  })

  afterAll(async () => {
    await withPlatformAccess('inbox anchors spec cleanup', () =>
      db.execute(sql`DELETE FROM inbox_items WHERE organization_id = ${ORG_ANCHORS}`)
    )
  })

  it('names each mark with unread news once, and none once its news is read', async () => {
    const unread = () =>
      asMe(() => repo.listUnreadAnchors(ORG_ANCHORS, ME, 'document', 'doc-1', repo.EVERY_INBOX_TYPE))
    expect(await unread()).toEqual(['mark-news'])
    // A reader who may not see the type sees no dot for it.
    expect(await asMe(() => repo.listUnreadAnchors(ORG_ANCHORS, ME, 'document', 'doc-1', []))).toEqual([])

    expect(await asMe(() => repo.markAnchorItemsRead(ORG_ANCHORS, ME, 'document', 'doc-1', 'mark-news', repo.EVERY_INBOX_TYPE))).toBe(2)
    expect(await unread()).toEqual([])
  })
})
