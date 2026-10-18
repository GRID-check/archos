/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inbox/repository', () => ({ listTouchedOfType: vi.fn() }))

import { burstOf, FOLD_MAX_ROWS } from './fold'

const T0 = new Date('2026-10-18T04:45:00.000Z').getTime()
const at = (id: string, seconds: number) => ({ id, updatedAt: new Date(T0 + seconds * 1000) })

describe('which rows one notification tells (burstOf)', () => {
  it('leaves an earlier row of the burst to the newest, which tells them all', () => {
    const rows = [at('a', 0), at('b', 1), at('c', 2.5), at('d', 4)]
    expect(burstOf(rows[0], rows)).toBe('later')
    expect(burstOf(rows[2], rows)).toBe('later')
    expect((burstOf(rows[3], rows) as Array<{ id: string }>).map((row) => row.id)).toEqual(['c', 'b', 'a'])
  })

  it('splits bursts at a quiet gap longer than the hold, so no row is told twice', () => {
    const rows = [at('a', 0), at('b', 3), at('c', 20), at('d', 22)]
    expect((burstOf(rows[1], rows) as Array<{ id: string }>).map((row) => row.id)).toEqual(['a'])
    expect((burstOf(rows[3], rows) as Array<{ id: string }>).map((row) => row.id)).toEqual(['c'])
  })

  it('chains a slow walk: each row within the hold of the next, however long the whole', () => {
    const rows = Array.from({ length: 10 }, (_, index) => at(`r${index}`, index * 4))
    const burst = burstOf(rows[9], rows) as Array<{ id: string }>
    expect(burst).toHaveLength(9)
  })

  it('tells a lone row on its own, and caps a burst at the newest rows', () => {
    expect(burstOf(at('a', 0), [at('a', 0)])).toEqual([])
    const rows = Array.from({ length: FOLD_MAX_ROWS + 10 }, (_, index) => at(`r${index}`, index * 0.01))
    const newest = rows.at(-1) ?? at('x', 0)
    expect(burstOf(newest, rows)).toHaveLength(FOLD_MAX_ROWS - 1)
  })
})
