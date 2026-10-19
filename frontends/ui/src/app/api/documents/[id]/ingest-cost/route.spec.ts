/**
 * @vitest-environment node
 */
/**
 * `GET /api/documents/[id]/ingest-cost` — the one HTTP API of the ingest-cost
 * primitive, driven through its typed client (ADR-0055), which is what makes the
 * dialog and the agent's tools equal clients of it rather than two that can
 * disagree about the shape.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'arch@example.com',
    role: 'admin',
  }),
}))

const readDocumentIngestCost = vi.fn()
vi.mock('@/lib/ingest-cost/service', () => ({
  readDocumentIngestCost: (...args: unknown[]) => readDocumentIngestCost(...args),
}))

import { NotFoundError } from '@/lib/api/errors'
import { IngestCostError, readIngestCost } from '@/lib/ingest-cost/client'
import { GET } from './route'

/** Drive the real handler through the typed client's injected fetch, as a browser would call it. */
const call = (id: string) =>
  readIngestCost(id, async (path) => {
    expect(path).toBe(`/api/documents/${id}/ingest-cost`)
    return GET(new Request(`https://grid.test${path}`), { params: Promise.resolve({ id }) })
  })

const ANSWER = {
  estimate: { expectedUsd: 0.52, upperUsd: 2.08, isCoarse: false, missingInputs: [] },
  thresholdUsd: 0.5,
  requiresConfirmation: true,
}

describe('GET /api/documents/[id]/ingest-cost', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the estimate and the decision, parsed by the client', async () => {
    readDocumentIngestCost.mockResolvedValue(ANSWER)

    await expect(call('doc-1')).resolves.toEqual(ANSWER)
    expect(readDocumentIngestCost).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', organizationId: 'org-1' }),
      'doc-1'
    )
  })

  it('passes a null estimate through (nothing to show yet)', async () => {
    readDocumentIngestCost.mockResolvedValue({ estimate: null, thresholdUsd: 0.5, requiresConfirmation: false })

    await expect(call('doc-1')).resolves.toEqual({
      estimate: null,
      thresholdUsd: 0.5,
      requiresConfirmation: false,
    })
  })

  it('maps the service NotFoundError to a 404 the client surfaces with its status', async () => {
    readDocumentIngestCost.mockRejectedValue(new NotFoundError())

    const error: unknown = await call('doc-1').catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(IngestCostError)
    expect((error as IngestCostError).status).toBe(404)
  })
})
