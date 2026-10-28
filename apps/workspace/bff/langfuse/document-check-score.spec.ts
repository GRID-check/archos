/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { DOCUMENT_CHECK_SCORE_NAME, toDocumentCheckScore } from './document-check-score'

describe('toDocumentCheckScore', () => {
  it('is a numeric score named document-check on the turn trace, with a retry-safe id', () => {
    const score = toDocumentCheckScore({ checkId: 'c-1', traceId: 't-1', findings: 2 })

    expect(DOCUMENT_CHECK_SCORE_NAME).toBe('document-check')
    expect(score).toMatchObject({
      id: 'document-check-c-1',
      traceId: 't-1',
      name: 'document-check',
      dataType: 'NUMERIC',
      value: 2,
    })
  })

  it('writes zero: checked, everything agrees', () => {
    expect(toDocumentCheckScore({ checkId: 'c-1', traceId: 't-1', findings: 0 }).value).toBe(0)
  })
})
