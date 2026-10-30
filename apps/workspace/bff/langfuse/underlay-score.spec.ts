/**
 * @vitest-environment node
 *
 * `sketch-underlay` (S6): one trace per event with its categorical score, ids
 * and reasons only, and a refusal scored only by a reason the catalogue names.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { SKETCH_UNDERLAY_VALUES, underlayRefusalValue, underlayScoreBatch } = await import('./underlay-score')

describe('sketch-underlay', () => {
  it('is a trace and its score in one batch, carrying ids and never a name', () => {
    const batch = underlayScoreBatch(
      { organizationId: 'org_1', userId: 'user_1', value: 'refused:underlay_held', baseId: 'doc-1' },
      { traceId: 'a'.repeat(32), scoreId: 's', eventIds: ['e1', 'e2'] },
      new Date(0)
    )
    expect(batch.batch.map((event) => event.type)).toEqual(['trace-create', 'score-create'])
    expect(batch.batch[1].body).toMatchObject({ traceId: 'a'.repeat(32), name: 'sketch-underlay', dataType: 'CATEGORICAL', value: 'refused:underlay_held', metadata: { base_id: 'doc-1' } })
    expect(JSON.stringify(batch)).not.toContain('user_1')
  })

  it('scores a refusal by the reason it names, and no other failure', () => {
    expect(underlayRefusalValue({ details: { reason: 'label_ambiguous' } })).toBe('refused:label_ambiguous')
    expect(underlayRefusalValue({ details: { reason: 'stale_base_version' } })).toBeNull()
    expect(underlayRefusalValue(new Error('boom'))).toBeNull()
    expect(SKETCH_UNDERLAY_VALUES).toContain('created')
  })
})
