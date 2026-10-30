/**
 * @vitest-environment node
 *
 * The page raster route charges a budget per person (`page-raster`): a miss
 * sends a whole PDF to the renderer, so a reader in a loop is stopped here
 * before the backend is asked (S6 review, finding 6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({ userId: 'user-1', organizationId: 'org-1', email: 'planer@example.at', role: 'member' }),
}))

vi.mock('@/lib/documents/page-raster', () => ({
  readPageRaster: vi.fn(async () => ({ png: new Uint8Array([1]), facts: {} })),
  pageRasterResponse: () => new Response('png', { status: 200 }),
}))

import { GET } from './route'
import { readPageRaster } from '@/lib/documents/page-raster'
import { createInProcessStore, PAGE_RASTER_LIMIT, setLimitStore } from '@/lib/limits'

const call = () =>
  GET(new Request('https://app.test/api/documents/d/versions/v/pages/2/raster?dpi=150'), {
    params: Promise.resolve({ id: 'd', versionId: 'v', page: '2' }),
  })

beforeEach(() => setLimitStore(createInProcessStore()))
afterEach(() => setLimitStore(null))

describe('GET …/pages/[page]/raster', () => {
  it('stops a reader past the burst before the renderer is asked', async () => {
    const answers = await Promise.all(Array.from({ length: (PAGE_RASTER_LIMIT.burst?.limit ?? 0) + 1 }, call))
    expect(answers.filter((response) => response.status === 429)).toHaveLength(1)
    expect(vi.mocked(readPageRaster)).toHaveBeenCalledTimes(PAGE_RASTER_LIMIT.burst?.limit ?? 0)
    expect(PAGE_RASTER_LIMIT.name).toBe('page-raster')
  })
})
