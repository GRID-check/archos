// @disk-inputs: ../agent-host/src/agent_host/routes/documents_jobs.py
/**
 * @vitest-environment node
 */
/**
 * The job ids the BFF sends per status call, pinned to the number the backend accepts.
 *
 * `BatchStatusRequest.job_ids` is capped, and a longer list is a 422 the
 * reconciler read as "backend unreachable": two bulk uploads of 309 and 219
 * documents stayed `pending` that way. The limit is read out of the route
 * rather than restated, so this fails when either side is edited alone.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BATCH_STATUS_MAX_IDS, fetchInChunks } from './status-batch'

const ROUTE = join(__dirname, '..', '..', '..', '..', 'apps', 'agent-host', 'src', 'agent_host', 'routes', 'documents_jobs.py')

describe('status batch contract', () => {
  it('sends no more job ids per call than the backend accepts', () => {
    const limit = /^BATCH_STATUS_MAX_IDS\s*=\s*(\d+)/m.exec(readFileSync(ROUTE, 'utf8'))
    expect(limit, 'BATCH_STATUS_MAX_IDS not found in documents_jobs.py').not.toBeNull()
    expect(BATCH_STATUS_MAX_IDS).toBeLessThanOrEqual(Number(limit![1]))
  })
})

describe('fetchInChunks', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `job-${i}`)

  it('reads 309 job ids (the stuck bulk upload) in calls no larger than the limit, and merges them', async () => {
    const sizes: number[] = []
    const merged = await fetchInChunks(ids(309), async (chunk) => {
      sizes.push(chunk.length)
      return Object.fromEntries(chunk.map((id) => [id, id]))
    })
    expect(Math.max(...sizes)).toBeLessThanOrEqual(BATCH_STATUS_MAX_IDS)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(309)
    expect(merged?.size).toBe(309)
  })

  it('answers nothing when any call fails, so no row is judged on half the answers', async () => {
    let calls = 0
    const merged = await fetchInChunks(ids(450), async (chunk) => {
      calls += 1
      return calls === 2 ? null : Object.fromEntries(chunk.map((id) => [id, id]))
    })
    expect(merged).toBeNull()
  })

  it('makes no call for no ids', async () => {
    const merged = await fetchInChunks([], async () => {
      throw new Error('must not be called')
    })
    expect(merged?.size).toBe(0)
  })
})
