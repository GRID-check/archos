import { describe, expect, test } from 'vitest'
import { claimMix, sanitizeClaimStamps } from './message-claim-stamps'
import { sanitizeProvenance } from './message-provenance'
import { provenanceFromBackendMetadata } from './agent-answer-metadata'

const WIRE = [
  {
    text: 'Anna hat drei offene Freigaben.',
    provenance: 'record',
    claim_type: 'value',
    load_bearing: true,
    operation: 'approvals-list',
  },
  {
    text: 'Die Höhe muss 2,50 m betragen [1].',
    provenance: 'cited',
    claim_type: 'normative',
    load_bearing: true,
    numbers: [1],
  },
  {
    text: 'Laut § 5 ist das zulässig.',
    provenance: 'model_knowledge',
    claim_type: 'normative',
    load_bearing: true,
  },
  {
    text: 'Erfunden [Beleg nicht verifiziert].',
    provenance: 'cited_dropped',
    claim_type: 'descriptive',
    load_bearing: false,
  },
]

describe('claim stamps', () => {
  test('the wire spelling becomes the stored shape, and an unknown class is dropped', () => {
    const stamps = sanitizeClaimStamps([
      ...WIRE,
      { text: 'x', provenance: 'vibes', claim_type: 'value' },
    ])
    expect(stamps).toHaveLength(4)
    expect(stamps?.[0]).toEqual({
      text: 'Anna hat drei offene Freigaben.',
      provenance: 'record',
      claimType: 'value',
      loadBearing: true,
      operation: 'approvals-list',
    })
  })

  test('nothing that survives is null, so no key is written', () => {
    expect(sanitizeClaimStamps([{ provenance: 'cited' }])).toBeNull()
    expect(sanitizeClaimStamps('no')).toBeNull()
  })

  test('each sentence lands in exactly one bucket of the mix', () => {
    const mix = claimMix(sanitizeClaimStamps(WIRE) ?? [])
    expect(mix).toEqual({
      supported: 2,
      reasoning: 0,
      modelKnowledge: 0,
      normativeUncited: 1,
      dropped: 1,
    })
  })

  test('a record never counts as backing a legal statement', () => {
    const mix = claimMix(
      sanitizeClaimStamps([{ text: 'x', provenance: 'record', claim_type: 'normative' }]) ?? []
    )
    expect(mix.normativeUncited).toBe(1)
    expect(mix.supported).toBe(0)
  })

  test('the backend-written row keeps the stamps, the rule version and the banner flag', () => {
    const provenance = provenanceFromBackendMetadata({
      answer_confidence: 'low',
      claim_stamps: WIRE,
      answer_confidence_version: 2,
      lookup_found_nothing: true,
    })
    expect(provenance?.claimStamps).toHaveLength(4)
    expect(provenance?.answerConfidenceVersion).toBe(2)
    expect(provenance?.lookupFoundNothing).toBe(true)
  })

  test('an unknown version or a false flag is not stored', () => {
    const provenance = sanitizeProvenance({
      answerConfidence: 'high',
      answerConfidenceVersion: 3,
      lookupFoundNothing: false,
    })
    expect(provenance).toEqual({ answerConfidence: 'high' })
  })
})
