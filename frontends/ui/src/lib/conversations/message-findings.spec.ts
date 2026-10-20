import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findingCounts, hasFindingStatuses, sanitizeFindings } from './message-findings'

const FIXTURE_PATH = resolve(__dirname, '../../../../../tests/fixtures/findings/wire_payload.json')
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, unknown>

describe('sanitizeFindings', () => {
  it('accepts the shared fixture whole, so the two sides read one contract', () => {
    const findings = sanitizeFindings(fixture)
    expect(findings).not.toBeNull()
    expect(findings?.items).toHaveLength(3)
    expect(findings?.items[0]).toEqual({
      requirement: 'Feuerwiderstand tragender Bauteile',
      value: 'REI 60',
      status: 'met',
      grounding: 'sourced',
      reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', page: 12 },
      citations: [1],
      comment: 'Gilt für GK 4; im Kellergeschoß REI 90.',
      area: 'Brandschutz',
    })
    expect(findingCounts(findings!)).toEqual({
      met: 1,
      not_met: 0,
      open: 1,
      not_applicable: 1,
    })
  })

  it('drops a row outside the contract and keeps the rest', () => {
    const findings = sanitizeFindings({
      items: [
        { requirement: 'A', status: 'met', grounding: 'sourced' },
        { requirement: 'B', status: 'vielleicht', grounding: 'sourced' },
        'not a row',
      ],
    })
    expect(findings?.items.map((item) => item.requirement)).toEqual(['A'])
  })

  it('bounds the free text and the citation list', () => {
    const findings = sanitizeFindings({
      items: [
        {
          requirement: 'x'.repeat(500),
          status: 'open',
          grounding: 'open',
          comment: 'y'.repeat(2000),
          citations: [1, '2', 0, 3, 4, 5, 6, 7, 8, 9, 10],
        },
      ],
    })
    expect(findings?.items[0]?.requirement).toHaveLength(200)
    expect(findings?.items[0]?.comment).toHaveLength(600)
    expect(findings?.items[0]?.citations).toEqual([1, 3, 4, 5, 6, 7, 8, 9])
  })

  it('keeps a row without a verdict, and drops one with a verdict it does not know', () => {
    const findings = sanitizeFindings({
      items: [
        { requirement: 'Kriterium', value: '12 m', grounding: 'sourced' },
        { requirement: 'B', status: 'vielleicht', grounding: 'sourced' },
      ],
    })
    expect(findings?.items).toEqual([
      { requirement: 'Kriterium', value: '12 m', grounding: 'sourced', citations: [] },
    ])
    expect(hasFindingStatuses(findings!)).toBe(false)
    expect(findingCounts(findings!)).toEqual({
      met: 0,
      not_met: 0,
      open: 0,
      not_applicable: 0,
    })
  })

  it('reads the German spellings a row stored before the rename still carries', () => {
    const findings = sanitizeFindings({
      items: [{ requirement: 'A', status: 'nicht_erfuellt', grounding: 'abgeleitet' }],
    })
    expect(findings?.items).toEqual([
      { requirement: 'A', status: 'not_met', grounding: 'derived', citations: [] },
    ])
  })

  it('is null for nothing usable, never an empty table', () => {
    expect(sanitizeFindings({ items: [] })).toBeNull()
    expect(sanitizeFindings(null)).toBeNull()
    expect(sanitizeFindings({ items: [{ requirement: '' }] })).toBeNull()
  })
})
