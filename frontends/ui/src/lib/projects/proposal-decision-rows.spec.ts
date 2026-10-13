/**
 * @vitest-environment node
 *
 * The SQL (which conversations are open to the block, the status set, the
 * order) is proved against real Postgres in `memory-restricted.integration.spec.ts`;
 * this holds the boundary: bounded, and raw column values coerced.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ conversationOpenToProjectReaders: () => ({}) }))

import type { DbExecutor } from '@/lib/db/executor'
import { listRecentDecidedProposals } from './proposal-decision-rows'

/** A drizzle stand-in: every chained call returns itself, `limit` resolves to `rows`. */
function executorReturning(rows: unknown[]) {
  const limit = vi.fn(async () => rows)
  const chain: Record<string, unknown> = { limit }
  for (const method of ['select', 'from', 'innerJoin', 'where', 'orderBy']) chain[method] = vi.fn(() => chain)
  return { db: chain as unknown as DbExecutor, limit }
}

describe('listRecentDecidedProposals', () => {
  it('asks for at most `limit` rows', async () => {
    const { db, limit } = executorReturning([])
    await listRecentDecidedProposals('proj-1', 'org-1', 40, db)
    expect(limit).toHaveBeenCalledWith(40)
  })

  it('coerces the raw columns and drops a row that is not a decision', async () => {
    const { db } = executorReturning([
      { id: 'a', kind: 'memory', status: 'applied', payload: { content: 'x' }, decidedAt: '2026-09-02T09:00:00Z' },
      { id: 'b', kind: 'memory', status: 'failed', payload: {}, decidedAt: '2026-09-02T09:00:00Z' },
      { id: 'c', kind: 'memory', status: 'proposed', payload: {}, decidedAt: null },
      { id: 'd', kind: 'memory', status: 'dismissed', payload: {}, decidedAt: null },
    ])
    const rows = await listRecentDecidedProposals('proj-1', 'org-1', 40, db)
    expect(rows).toHaveLength(1)
    expect(rows[0].decidedAt).toBeInstanceOf(Date)
    expect(rows[0].decidedAt.toISOString()).toBe('2026-09-02T09:00:00.000Z')
    expect(rows[0]).toMatchObject({ id: 'a', status: 'applied', kind: 'memory' })
  })
})
