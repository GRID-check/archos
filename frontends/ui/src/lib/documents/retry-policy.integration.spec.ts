/**
 * @vitest-environment node
 *
 * `retryAllowedSql` (`./repository`) against a REAL Postgres, held to
 * `canRetryRow` (`./retry-policy`) row by row: the bulk retry and the org
 * rescan select with the SQL, a single „Erneut lesen“ decides with the
 * TypeScript, and the two must agree on every row (migration 0134).
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/documents/retry-policy.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CURRENT_INGEST_READER_VERSION, canRetryRow } from './retry-policy'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_retry_${STAMP}`
const USER = `user_retry_${STAMP}`
const PROJECT = '0e0e0e0e-0000-4000-8000-000000000001'

interface Seed {
  status: string
  category?: string | null
  retryable?: boolean | null
  reader?: string | null
  contentHash?: string | null
  dispatchedHash?: string | null
}

const SEEDS: Record<string, Seed> = {
  read: { status: 'completed', category: 'deterministic', retryable: false },
  uploaded: { status: 'uploaded' },
  transient: { status: 'failed', category: 'transient', retryable: true },
  configuration: { status: 'failed', category: 'configuration', retryable: true },
  quarantined: { status: 'failed', category: 'quarantined', retryable: false },
  'before-the-column': { status: 'failed' },
  'flag-only-no': { status: 'failed', retryable: false },
  'deterministic-same': { status: 'failed', category: 'deterministic', retryable: false, reader: CURRENT_INGEST_READER_VERSION },
  'deterministic-older-reader': { status: 'failed', category: 'deterministic', retryable: false, reader: '2026.9.4' },
  'deterministic-newer-reader': { status: 'failed', category: 'deterministic', retryable: false, reader: '2099.1.1' },
  'deterministic-no-reader': { status: 'failed', category: 'deterministic', retryable: false },
  'deterministic-odd-reader': { status: 'failed', category: 'deterministic', retryable: false, reader: 'dev' },
  'deterministic-new-bytes': {
    status: 'failed',
    category: 'deterministic',
    retryable: false,
    reader: CURRENT_INGEST_READER_VERSION,
    contentHash: 'b',
    dispatchedHash: 'a',
  },
  'deterministic-same-bytes': {
    status: 'failed',
    category: 'deterministic',
    retryable: false,
    reader: CURRENT_INGEST_READER_VERSION,
    contentHash: 'a',
    dispatchedHash: 'a',
  },
}

describe.skipIf(!url)('the retry rule in SQL against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let context: typeof import('@/lib/db/tenant-context')
  let repository: typeof import('./repository')
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    context = await import('@/lib/db/tenant-context')
    repository = await import('./repository')
    db = (await import('@/lib/db')).getDb()

    await context.withPlatformAccess('test seed: organization', () =>
      db.execute(
        sql`insert into organizations (workos_organization_id, display_name) values (${ORG}, ${ORG}) on conflict do nothing`,
      ),
    )
    await context.withTenant({ organizationId: ORG }, async () => {
      await db.execute(sql`
        insert into projects (id, organization_id, name, created_by, collection_name)
        values (${PROJECT}, ${ORG}, 'Retry', ${USER}, ${'proj_' + PROJECT})
      `)
      for (const [name, seed] of Object.entries(SEEDS)) {
        const metadata = seed.dispatchedHash ? JSON.stringify({ ingestContentHash: seed.dispatchedHash }) : null
        const rows = await db.execute<{ id: string }>(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id,
             metadata, content_hash, ingest_failure_category, ingest_retryable, ingest_reader_version)
          VALUES
            (${ORG}, ${USER}, ${name + '.pdf'}, ${'k/' + name}, 'coll_retry', ${seed.status}, 'project',
             ${PROJECT}::uuid, ${metadata}::jsonb, ${seed.contentHash ?? null}, ${seed.category ?? null},
             ${seed.retryable ?? null}, ${seed.reader ?? null})
          RETURNING id
        `)
        ids[name] = String(Array.from(rows)[0].id)
      }
    })
  })

  afterAll(async () => {
    if (!db) return
    await context.withTenant({ organizationId: ORG }, async () => {
      await db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`)
    })
    await context.withPlatformAccess('test teardown: organization', () =>
      db.execute(sql`DELETE FROM organizations WHERE workos_organization_id = ${ORG}`),
    )
  })

  it.each(Object.keys(SEEDS))('%s: the SQL answers what canRetryRow answers', async (name) => {
    const seed = SEEDS[name]
    const expected = canRetryRow({
      status: seed.status,
      ingestFailureCategory: seed.category ?? null,
      ingestRetryable: seed.retryable ?? null,
      ingestReaderVersion: seed.reader ?? null,
      contentHash: seed.contentHash ?? null,
      metadata: seed.dispatchedHash ? { ingestContentHash: seed.dispatchedHash } : null,
    })
    const rows = await context.withTenant({ organizationId: ORG }, () =>
      db.execute<{ allowed: boolean }>(
        sql`SELECT ${repository.retryAllowedSql()} AS allowed FROM documents WHERE id = ${ids[name]}::uuid`,
      ),
    )
    expect(Array.from(rows)[0].allowed).toBe(expected)
  })

  it('refuses what the rule exists to refuse', () => {
    expect(canRetryRow({ status: 'failed', ingestFailureCategory: 'deterministic', ingestReaderVersion: CURRENT_INGEST_READER_VERSION })).toBe(false)
    expect(canRetryRow({ status: 'failed', ingestFailureCategory: 'quarantined' })).toBe(false)
  })
})
