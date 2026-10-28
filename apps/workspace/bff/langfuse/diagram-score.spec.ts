/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const deps = vi.hoisted(() => ({ upsert: vi.fn(), traceId: vi.fn(), config: vi.fn() }))
vi.mock('./feedback-score', () => ({ upsertScore: deps.upsert }))
vi.mock('./config', () => ({ langfuseApiConfig: deps.config }))
vi.mock('@/lib/feedback/repository', () => ({ getAnswerTraceId: deps.traceId }))
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: (_: unknown, run: () => unknown) => run() }))

const { recordDiagramScore, toDiagramScore } = await import('./diagram-score')

beforeEach(() => {
  deps.upsert.mockReset().mockResolvedValue(undefined)
  deps.traceId.mockReset().mockResolvedValue('trace-1')
  deps.config.mockReset().mockReturnValue({ baseUrl: 'x', publicKey: 'p', secretKey: 's' })
})

describe('the diagram-filed score (ADR-0141)', () => {
  it('says whether the filed drawing was edited, keyed by the filed SVG so a second filing upserts', () => {
    expect(toDiagramScore({ traceId: 't-1', documentId: 'doc-1', edited: true })).toEqual({
      id: 'diagram-filed-doc-1',
      traceId: 't-1',
      name: 'diagram-filed',
      dataType: 'CATEGORICAL',
      value: 'edited',
      metadata: { document_id: 'doc-1' },
    })
    expect(toDiagramScore({ traceId: 't-1', documentId: 'doc-1', edited: false }).value).toBe('as_drawn')
  })

  it('goes on the trace of the answer the drawing came from', async () => {
    await recordDiagramScore({ organizationId: 'org-1', answerId: 'msg-1', documentId: 'doc-1', edited: true })
    expect(deps.traceId).toHaveBeenCalledWith('msg-1', 'org-1')
    expect(deps.upsert).toHaveBeenCalledWith(
      expect.anything(),
      'diagram-filed-doc-1',
      expect.objectContaining({ traceId: 'trace-1', value: 'edited' })
    )
  })

  it('records nothing without an answer, without a trace, or without Langfuse, and never throws', async () => {
    await recordDiagramScore({ organizationId: 'org-1', answerId: null, documentId: 'doc-1', edited: false })
    deps.traceId.mockResolvedValueOnce(null)
    await recordDiagramScore({ organizationId: 'org-1', answerId: 'msg-1', documentId: 'doc-1', edited: false })
    deps.config.mockReturnValueOnce(null)
    await recordDiagramScore({ organizationId: 'org-1', answerId: 'msg-1', documentId: 'doc-1', edited: false })
    expect(deps.upsert).not.toHaveBeenCalled()

    deps.upsert.mockRejectedValueOnce(new Error('down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      recordDiagramScore({ organizationId: 'org-1', answerId: 'msg-1', documentId: 'doc-1', edited: false })
    ).resolves.toBeUndefined()
    warn.mockRestore()
  })
})
