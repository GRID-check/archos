/**
 * @vitest-environment node
 */
/**
 * The read path end to end, with no network: the document is authorized, the
 * organisation's threshold is resolved, the ingest job's status is read from the
 * backend's batch endpoint, and the two are put together into the answer.
 *
 * The fetch is stubbed at the boundary, so the real `readBackendJobFile` and the
 * real parser are exercised — what is mocked is only the two other side effects
 * (the document read and the threshold read), so a failure names the wiring that
 * broke instead of a double.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const getAccessibleDocument = vi.fn()
vi.mock('@/lib/documents/access', () => ({
  getAccessibleDocument: (...args: unknown[]) => getAccessibleDocument(...args),
}))

const resolveIngestCostThreshold = vi.fn()
vi.mock('./threshold', () => ({
  resolveIngestCostThreshold: (...args: unknown[]) => resolveIngestCostThreshold(...args),
}))

import type { Document } from '@/lib/db/schema'
import type { AuthorizedSession } from '@/lib/auth/types'
import { readDocumentIngestCost } from './service'

const SESSION = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'arch@example.com',
} as AuthorizedSession

const documentRow = (overrides: Partial<Document> = {}): Document =>
  ({
    id: 'doc-1',
    filename: 'bescheid.pdf',
    metadata: { ingestJobId: 'job-1' },
    ...overrides,
  }) as Document

/** The batch endpoint's answer for one job: its file, with a pre-read estimate. */
const jobStatus = (files: unknown[]): Response =>
  new Response(JSON.stringify({ statuses: { 'job-1': { status: 'processing', file_details: files } } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const REPORT = { expected_usd: 0.52, upper_usd: 2.08, is_coarse: false, missing_inputs: [] }

describe('readDocumentIngestCost', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    getAccessibleDocument.mockResolvedValue(documentRow())
    resolveIngestCostThreshold.mockResolvedValue(0.5)
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports the estimate and the decision for a file above the threshold', async () => {
    fetchMock.mockResolvedValue(jobStatus([{ file_name: 'bescheid.pdf', ingest_cost: REPORT }]))

    const result = await readDocumentIngestCost(SESSION, 'doc-1')

    expect(result).toEqual({
      estimate: { expectedUsd: 0.52, upperUsd: 2.08, isCoarse: false, missingInputs: [] },
      thresholdUsd: 0.5,
      requiresConfirmation: true,
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/documents/status/batch')
    expect(init.body).toBe(JSON.stringify({ job_ids: ['job-1'] }))
  })

  it('does not ask at exactly the threshold, and asks just above it', async () => {
    fetchMock.mockResolvedValue(
      jobStatus([{ file_name: 'bescheid.pdf', ingest_cost: { ...REPORT, expected_usd: 0.5 } }])
    )
    expect((await readDocumentIngestCost(SESSION, 'doc-1')).requiresConfirmation).toBe(false)

    fetchMock.mockResolvedValue(
      jobStatus([{ file_name: 'bescheid.pdf', ingest_cost: { ...REPORT, expected_usd: 0.5001 } }])
    )
    expect((await readDocumentIngestCost(SESSION, 'doc-1')).requiresConfirmation).toBe(true)
  })

  it('never asks when the organisation switched the prompt off (threshold 0)', async () => {
    resolveIngestCostThreshold.mockResolvedValue(0)
    fetchMock.mockResolvedValue(jobStatus([{ file_name: 'bescheid.pdf', ingest_cost: REPORT }]))

    const result = await readDocumentIngestCost(SESSION, 'doc-1')

    expect(result.thresholdUsd).toBe(0)
    expect(result.requiresConfirmation).toBe(false)
  })

  it('picks the file by name when a job reports several', async () => {
    fetchMock.mockResolvedValue(
      jobStatus([
        { file_name: 'other.pdf', ingest_cost: { ...REPORT, expected_usd: 0.01 } },
        { file_name: 'bescheid.pdf', ingest_cost: REPORT },
      ])
    )

    const result = await readDocumentIngestCost(SESSION, 'doc-1')

    expect(result.estimate?.expectedUsd).toBe(0.52)
  })

  it('falls back to the only file of a single-file job whose name does not match', async () => {
    fetchMock.mockResolvedValue(jobStatus([{ file_name: 'stored-name.pdf', ingest_cost: REPORT }]))

    expect((await readDocumentIngestCost(SESSION, 'doc-1')).estimate?.expectedUsd).toBe(0.52)
  })

  it('reports no estimate when the document has no ingest job', async () => {
    getAccessibleDocument.mockResolvedValue(documentRow({ metadata: {} }))

    const result = await readDocumentIngestCost(SESSION, 'doc-1')

    expect(result.estimate).toBeNull()
    expect(result.requiresConfirmation).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports no estimate when the file was never priced', async () => {
    fetchMock.mockResolvedValue(jobStatus([{ file_name: 'bescheid.pdf' }]))

    expect((await readDocumentIngestCost(SESSION, 'doc-1')).estimate).toBeNull()
  })

  it('fails open when the backend cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('backend down'))

    const result = await readDocumentIngestCost(SESSION, 'doc-1')

    expect(result.estimate).toBeNull()
    expect(result.requiresConfirmation).toBe(false)
  })

  it('authorizes the document read before asking the backend anything', async () => {
    getAccessibleDocument.mockRejectedValue(new Error('not found'))

    await expect(readDocumentIngestCost(SESSION, 'doc-1')).rejects.toThrow('not found')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
