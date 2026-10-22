import { describe, expect, it } from 'vitest'
import { EXTRACTOR_VERSION, type OfficeConventions } from './extract'
import type { StoredDecision } from './lines'
import type { ConventionLine } from './office-conventions-wire'
import {
  MAX_CONVENTION_LINE_CHARS,
  MAX_CONVENTION_LINES,
  asksWhereThingsAre,
  officeConventionsHeader,
  renderOfficeConventions,
} from './render'

const conventions = (overrides: Partial<OfficeConventions> = {}): OfficeConventions => ({
  version: EXTRACTOR_VERSION,
  projects: 7,
  folders: [
    { path: 'Grundlagen', projects: 7, of: 7 },
    { path: 'Behörde', projects: 5, of: 7 },
  ],
  filing: [{ docType: 'Gutachten', path: 'Fachplaner/Gutachten', projects: 4, of: 5 }],
  documentNumber: { shape: 'A-A-00-000', projects: 6, of: 7 },
  revisionStyle: { style: 'letter', projects: 5, of: 6 },
  fileDate: { format: 'YYMMDD', projects: 4, of: 5 },
  ...overrides,
})

describe('renderOfficeConventions', () => {
  it('states each convention as usual, with the count behind it', () => {
    expect(renderOfficeConventions(conventions())).toEqual([
      '- Gutachten usually filed under Fachplaner/Gutachten (4 of 5 projects that file one in a folder)',
      '- folders most projects keep: Grundlagen (7/7), Behörde (5/7)',
      '- Plannummer usually shaped A-A-00-000 (A = letters, 0 = a digit; title blocks of 6 of 7 projects)',
      '- Index usually letters (A, B, C) (5 of 6 projects)',
      '- file names usually write a date as YYMMDD (4 of 5 projects)',
    ])
  })

  it('says nothing when nothing was learned', () => {
    expect(
      renderOfficeConventions(
        conventions({ folders: [], filing: [], documentNumber: null, revisionStyle: null, fileDate: null })
      )
    ).toEqual([])
  })

  it('is bounded, dropping filing lines before the naming lines, and clips a long line', () => {
    const filing = ['Bescheid', 'Gutachten', 'Grundriss', 'Schnitt', 'Ansicht', 'Vertrag'].map((docType) => ({
      docType,
      path: `Ordner/${'x'.repeat(300)}`,
      projects: 3,
      of: 4,
    }))
    const lines = renderOfficeConventions(conventions({ filing }))
    expect(lines).toHaveLength(MAX_CONVENTION_LINES)
    expect(lines.filter((line) => line.includes('usually filed under'))).toHaveLength(MAX_CONVENTION_LINES - 4)
    expect(lines.some((line) => line.startsWith('- Plannummer'))).toBe(true)
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(MAX_CONVENTION_LINE_CHARS)
  })

  it('heads the section with the restraint: usually, the project and the person win, propose only', () => {
    const header = officeConventionsHeader(7)
    expect(header).toContain('counted from 7')
    expect(header).toContain('usually, not always')
    expect(header).toContain("this project's own folders and a person's choice win")
    expect(header).toContain('propose, never move on a convention alone')
  })
})

describe('asksWhereThingsAre', () => {
  it.each([
    'Wo legen wir Gutachten normalerweise ab?',
    'In welchen Ordner gehört das Schreiben der MA 37?',
    'Finde mir den letzten Bescheid',
    'Wie nummerieren wir Pläne?',
    'Welcher Index ist aktuell?',
    'Wie heißt die Plannummer vom Erdgeschoss?',
    'Where do we keep the structural report?',
  ])('takes "%s" for a question about filing or finding', (query) => {
    expect(asksWhereThingsAre(query)).toBe(true)
  })

  it.each([
    'Wie hoch darf das Geländer sein?',
    'Ist eine Untersuchung des Bodens nötig?',
    'Fasse den Bescheid zusammen',
    '',
    null,
  ])('leaves "%s" alone', (query) => {
    expect(asksWhereThingsAre(query)).toBe(false)
  })
})

describe('the office decides what the agent reads', () => {
  const decision = (line: ConventionLine, kind: StoredDecision['decision']): StoredDecision => ({
    lineKey: line.key,
    decision: kind,
    line,
    decidedBy: 'user-1',
    decidedAt: new Date('2026-10-22T08:00:00Z'),
  })
  const filing: ConventionLine = {
    kind: 'filing', key: 'filing:gutachten>fachplaner/gutachten', docType: 'Gutachten', path: 'Fachplaner/Gutachten', projects: 4, of: 5,
  }

  it('leaves a declined line out, whether it is a filing line, a folder or a naming line', () => {
    const lines = renderOfficeConventions(conventions(), [
      decision(filing, 'declined'),
      decision({ kind: 'folder', key: 'folder:behörde', path: 'Behörde', projects: 5, of: 7 }, 'declined'),
      decision({ kind: 'revision_style', key: 'revision_style:letter', style: 'letter', projects: 5, of: 6 }, 'declined'),
    ])
    expect(lines.join('\n')).not.toContain('Gutachten')
    expect(lines).toContain('- folders most projects keep: Grundlagen (7/7)')
    expect(lines.join('\n')).not.toContain('Index usually')
  })

  it('keeps a confirmed line the count no longer shows, and says the office confirmed it', () => {
    const lines = renderOfficeConventions(conventions({ filing: [], fileDate: null }), [
      decision(filing, 'confirmed'),
      decision({ kind: 'file_date', key: 'file_date:YYYYMMDD', format: 'YYYYMMDD', projects: 3, of: 8 }, 'confirmed'),
    ])
    expect(lines).toContain('- Gutachten usually filed under Fachplaner/Gutachten (confirmed by the office)')
    expect(lines).toContain('- file names usually write a date as YYYYMMDD (confirmed by the office)')
  })

  it('marks a confirmed line that is still counted with its count', () => {
    const lines = renderOfficeConventions(conventions(), [decision(filing, 'confirmed')])
    expect(lines[0]).toBe(
      '- Gutachten usually filed under Fachplaner/Gutachten (confirmed by the office; 4 of 5 projects that file one in a folder)'
    )
  })

  it('lets a confirmed folder win over a different counted folder for the same Dokumentart', () => {
    const confirmed: ConventionLine = { ...filing, key: 'filing:gutachten>behörde', path: 'Behörde' }
    const lines = renderOfficeConventions(conventions(), [decision(confirmed, 'confirmed')])
    const gutachten = lines.filter((line) => line.startsWith('- Gutachten'))
    expect(gutachten).toEqual(['- Gutachten usually filed under Behörde (confirmed by the office)'])
  })

  it('puts confirmed filing lines ahead of counted ones when the budget is short', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ docType: `Art${i}`, path: `Ordner${i}`, projects: 4, of: 5 }))
    const last: ConventionLine = { kind: 'filing', key: 'filing:art9>ordner9', docType: 'Art9', path: 'Ordner9', projects: 4, of: 5 }
    const lines = renderOfficeConventions(conventions({ filing: many }), [decision(last, 'confirmed')])
    expect(lines).toHaveLength(MAX_CONVENTION_LINES)
    expect(lines[0]).toContain('Art9 usually filed under Ordner9')
  })
})
