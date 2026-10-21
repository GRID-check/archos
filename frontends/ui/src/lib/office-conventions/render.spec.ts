import { describe, expect, it } from 'vitest'
import { EXTRACTOR_VERSION, type OfficeConventions } from './extract'
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
