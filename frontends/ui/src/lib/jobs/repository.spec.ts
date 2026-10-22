/**
 * @vitest-environment node
 */
/**
 * The legacy `jobs` table's one remaining read, asserted as the SQL Postgres
 * receives: the organization scoping only exists in the statement.
 *
 * The DB is a drizzle `pg-proxy` instance, the same harness as
 * `lib/inbox/repository.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pg-proxy'

interface CapturedQuery {
  sql: string
  params: unknown[]
}

const captured: CapturedQuery[] = []
let driverRows: unknown[] = []

const proxyDb = drizzle(async (sql, params) => {
  captured.push({ sql, params })
  return { rows: driverRows }
})

vi.mock('@/lib/db', () => ({ getDb: () => proxyDb }))

import { findJob } from './repository'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const JOB = '22222222-2222-4222-8222-222222222222'
const ORG = 'org_1'

function onlyQuery(): CapturedQuery {
  expect(captured).toHaveLength(1)
  return captured[0]
}

/** The predicate Postgres applies, without the projection or the modifiers. */
function where(sql: string): string {
  const match = / where (.+?)(?: order by| limit| offset| returning|$)/.exec(sql)
  expect(match, sql).not.toBeNull()
  return match![1]
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB,
    projectId: PROJECT,
    organizationId: ORG,
    name: 'Wochencheck',
    prompt: 'Prüf das',
    skillName: null,
    skillSnapshot: null,
    output: 'chat',
    dataSources: null,
    enabled: true,
    scheduleCron: '0 8 * * 1',
    scheduleTimezone: 'Europe/Vienna',
    nextRunAt: new Date('2026-09-21T06:00:00.000Z'),
    lastRunAt: null,
    createdBy: 'user_1',
    createdByEmail: 'p@grid.test',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  }
}

beforeEach(() => {
  captured.length = 0
  driverRows = []
})

describe('jobs repository — tenant scoping', () => {
  it('scopes a single job lookup to the organization', async () => {
    driverRows = [jobRow()]
    await findJob(JOB, ORG)

    const { sql, params } = onlyQuery()
    const predicate = where(sql)
    expect(predicate).toContain('"jobs"."id" =')
    expect(predicate).toContain('"jobs"."organization_id" =')
    expect(params).toContain(JOB)
    expect(params).toContain(ORG)
  })
})
