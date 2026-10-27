import { describe, expect, test } from 'vitest'
import { claimEvidenceCount, claimMix, claimWarning, sanitizeClaimStamps } from './message-claim-stamps'
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
      observed: 0,
      reasoning: 0,
      modelKnowledge: 0,
      normativeUncited: 1,
      dropped: 1,
    })
  })

  test('a sentence read off a drawing is its own bucket, and never backs a legal statement', () => {
    const mix = claimMix(
      sanitizeClaimStamps([
        { text: 'Die Tür ist 1,00 m breit.', provenance: 'observed', claim_type: 'value' },
        { text: 'Das ist zulässig.', provenance: 'observed', claim_type: 'normative' },
      ]) ?? []
    )
    expect(mix.observed).toBe(1)
    expect(mix.normativeUncited).toBe(1)
    expect(mix.supported).toBe(0)
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

  test('rule 3 is stored as version 2, and the support each stamp carries survives', () => {
    const provenance = sanitizeProvenance({
      answerConfidence: 'medium',
      answerConfidenceVersion: 2,
      claimStamps: [
        { text: 'A.', provenance: 'cited', claim_type: 'value', load_bearing: true, support: 1 },
        { text: 'B.', provenance: 'reasoning', claim_type: 'normative', load_bearing: true, support: 0.5 },
        { text: 'C.', provenance: 'model_knowledge', claim_type: 'normative', load_bearing: true, support: 0.7 },
      ],
    })
    expect(provenance?.answerConfidenceVersion).toBe(2)
    expect(provenance?.claimStamps?.map((stamp) => stamp.support)).toEqual([1, 0.5, undefined])
  })

  test('the evidence count reads the support the agent computed', () => {
    const stamps = sanitizeClaimStamps([
      { text: 'A.', provenance: 'cited', claim_type: 'value', load_bearing: true, support: 1 },
      { text: 'B.', provenance: 'reasoning', claim_type: 'normative', load_bearing: true, support: 0.5 },
      { text: 'C.', provenance: 'cited', claim_type: 'descriptive', load_bearing: false, support: 1 },
    ])
    expect(claimEvidenceCount(stamps ?? [])).toEqual({ backed: 1, claims: 2 })
    expect(claimEvidenceCount([{ text: 'A.', provenance: 'cited', claimType: 'value', loadBearing: true }])).toBeNull()
  })
})

describe('claimWarning', () => {
  const stamp = (provenance: string, claimType: string, loadBearing = true) =>
    sanitizeClaimStamps([{ text: 'S.', provenance, claim_type: claimType, load_bearing: loadBearing }])?.[0]
  const stamps = (...items: ReturnType<typeof stamp>[]) => items.filter((item) => item !== undefined)

  test('names an uncited statement about the law first', () => {
    expect(
      claimWarning(stamps(stamp('cited', 'value'), stamp('reasoning', 'normative'), stamp('cited_dropped', 'value')))
    ).toBe('normativeClaimUncited')
  })

  test('a record or a measurement beside the law does not count as its source', () => {
    expect(claimWarning(stamps(stamp('measured', 'normative')))).toBe('normativeClaimUncited')
    expect(claimWarning(stamps(stamp('record', 'normative')))).toBe('normativeClaimUncited')
  })

  test('then a citation that did not hold; nothing for a cited or a non-bearing statement', () => {
    expect(claimWarning(stamps(stamp('cited', 'normative'), stamp('cited_dropped', 'value')))).toBe('citationUnverified')
    expect(claimWarning(stamps(stamp('cited', 'normative'), stamp('model_knowledge', 'normative', false)))).toBeNull()
  })
})

describe('rule 3 fields (round 3 of #1231)', () => {
  test('a normative sentence the agent says concludes nothing is no warning: a listing names nothing', () => {
    const stamps = sanitizeClaimStamps([
      { text: 'Abgabepläne · 8', provenance: 'record', claim_type: 'value', load_bearing: true, support: 1, verdict: false },
      { text: 'Die Höhen widersprechen sich.', provenance: 'record', claim_type: 'normative', load_bearing: true, support: 1, verdict: false },
    ])
    expect(claimWarning(stamps ?? [])).toBeNull()
    expect(claimMix(stamps ?? []).normativeUncited).toBe(0)
  })

  test('an uncited verdict is named, and a dropped pointer is a flag, not a class', () => {
    const stamps = sanitizeClaimStamps([
      { text: 'Die Treppe ist 1,10 m breit.', provenance: 'measured', claim_type: 'value', load_bearing: true, support: 1, verdict: false, dropped: true },
      { text: 'Die Treppe ist damit zu schmal.', provenance: 'model_knowledge', claim_type: 'normative', load_bearing: true, support: 0, verdict: true },
    ])
    expect(stamps?.[0].dropped).toBe(true)
    expect(claimWarning(stamps ?? [])).toBe('normativeClaimUncited')
    expect(claimWarning((stamps ?? []).slice(0, 1))).toBe('citationUnverified')
  })

  test('a table under a lead-in counts as one claim, backed only when every row is', () => {
    const stamps = sanitizeClaimStamps([
      { text: 'A [1].', provenance: 'cited', claim_type: 'value', load_bearing: true, support: 1 },
      { text: 'Gliederung [1]:', provenance: 'cited', claim_type: 'normative', load_bearing: true, support: 1, group: 1 },
      { text: '2 · Tragfähigkeit', provenance: 'reasoning', claim_type: 'value', load_bearing: true, support: 0.5, group: 1 },
      { text: '3 · Ausbreitung', provenance: 'reasoning', claim_type: 'value', load_bearing: true, support: 0, group: 1 },
    ])
    expect(claimEvidenceCount(stamps ?? [])).toEqual({ backed: 1, claims: 2 })
  })
})
