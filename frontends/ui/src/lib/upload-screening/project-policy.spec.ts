import { describe, expect, it } from 'vitest'
import { screenUploadName } from './name-screen'
import { SUGGESTED_SCREENING_POLICY } from './policy'
import { applyProjectOverride, effectiveOverride, projectScreeningOverrideSchema } from './project-policy'

const OFFICE = SUGGESTED_SCREENING_POLICY

describe('applyProjectOverride', () => {
  it('is the office list when the project changes nothing', () => {
    expect(applyProjectOverride(OFFICE, null)).toBe(OFFICE)
    expect(applyProjectOverride(OFFICE, { addedNameTerms: [], removedNameTerms: [] })).toBe(OFFICE)
  })

  it('adds the project terms and leaves out the ones it sets aside, case- and umlaut-folded', () => {
    const policy = applyProjectOverride(OFFICE, { addedNameTerms: ['Wettbewerb intern'], removedNameTerms: ['VERTRAG'] })
    expect(policy.nameTerms).toContain('Wettbewerb intern')
    expect(policy.nameTerms).not.toContain('Vertrag')
    expect(screenUploadName(policy, { filename: 'Werkvertrag Elektro.pdf' }).blocked).toBe(false)
    expect(screenUploadName(policy, { filename: 'a.pdf', originPath: 'Wettbewerb intern/a.pdf' }).blocked).toBe(true)
  })

  it('never touches the content half or the exceptions', () => {
    const policy = applyProjectOverride(OFFICE, { addedNameTerms: ['Wettbewerb'], removedNameTerms: ['Honorar'] })
    expect(policy.contentTerms).toEqual(OFFICE.contentTerms)
    expect(policy.detectors).toEqual(OFFICE.detectors)
    expect(policy.nameExceptions).toEqual(OFFICE.nameExceptions)
  })

  it('leaves a switched-off office list off', () => {
    const off = { ...OFFICE, enabled: false }
    expect(applyProjectOverride(off, { addedNameTerms: ['Wettbewerb'], removedNameTerms: [] })).toBe(off)
  })
})

describe('effectiveOverride', () => {
  it('keeps only what changes something against the office list', () => {
    expect(
      effectiveOverride(OFFICE, {
        addedNameTerms: ['rechnung', 'Wettbewerb', 'wettbewerb', 'Lohn'],
        removedNameTerms: ['Lohn', 'Unbekannt'],
      })
    ).toEqual({ addedNameTerms: ['Wettbewerb'], removedNameTerms: ['Lohn'] })
  })
})

describe('projectScreeningOverrideSchema', () => {
  it('normalizes the lists and refuses unknown keys and long terms', () => {
    expect(projectScreeningOverrideSchema.parse({ addedNameTerms: ['  A  b ', 'x'], removedNameTerms: [] })).toEqual({
      addedNameTerms: ['A b'],
      removedNameTerms: [],
    })
    expect(projectScreeningOverrideSchema.safeParse({ addedNameTerms: [], removedNameTerms: [], enabled: false }).success).toBe(false)
    expect(projectScreeningOverrideSchema.safeParse({ addedNameTerms: ['x'.repeat(81)], removedNameTerms: [] }).success).toBe(false)
    expect(projectScreeningOverrideSchema.safeParse({ addedNameTerms: Array.from({ length: 51 }, (_, i) => `t${i}`), removedNameTerms: [] }).success).toBe(false)
  })
})
