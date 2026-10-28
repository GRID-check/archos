/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { sanitizeConfidenceCheck } from './confidence-check'

describe('sanitizeConfidenceCheck', () => {
  test('keeps a judged check and bounds its findings', () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      statement: `s${i}`,
      problem: 'unbacked',
      reason: 'r',
      source: 'none',
    }))
    const check = sanitizeConfidenceCheck({ status: 'judged', level: 'medium', findings })
    expect(check?.level).toBe('medium')
    expect(check?.findings).toHaveLength(8)
  })

  test('a judged check with no findings on the wire reads as none', () => {
    expect(sanitizeConfidenceCheck({ status: 'judged', level: 'high' })).toEqual({
      status: 'judged',
      level: 'high',
      findings: [],
    })
  })

  test('drops a finding of an unknown kind and reads a judged check without a level as unavailable', () => {
    expect(
      sanitizeConfidenceCheck({
        status: 'judged',
        level: 'low',
        findings: [{ statement: 'x', problem: 'invented', reason: '', source: '' }],
      })?.findings
    ).toEqual([])
    expect(sanitizeConfidenceCheck({ status: 'judged', level: 'certain' })).toEqual({
      status: 'unavailable',
      findings: [],
    })
  })

  test('anything else is no check', () => {
    expect(sanitizeConfidenceCheck(null)).toBeUndefined()
    expect(sanitizeConfidenceCheck({ status: 'maybe' })).toBeUndefined()
  })
})
