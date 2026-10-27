// @disk-inputs: ../../tests/fixtures/revision_series_cases.json
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  REVISION_MAX_CANDIDATES,
  findRevisionCandidate,
  findRevisionSeries,
  parseRevisionName,
  revisionLabel,
  revisionSeriesKeyOf,
} from './revision-series'

/**
 * The cases are shared with the agent's Python parser
 * (`tests/knowledge_layer_tests/test_revision_series.py`): one file, so the folder
 * brief and `list_files` cannot read the same file name differently.
 */
interface Cases {
  parse: { name: string; key: string | null; index: [string, string] | null; date: string | null }[]
  series: {
    files: { id: string; name: string; createdAt: string }[]
    expect: { key: string; current: string; older: string[] }[]
  }[]
}

const cases = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../tests/fixtures/revision_series_cases.json'), 'utf8')
) as Cases

describe('parseRevisionName, on the shared cases', () => {
  it.each(cases.parse)('$name', ({ name, key, index, date }) => {
    const revision = parseRevisionName(name)
    if (key === null) {
      expect(revision).toBeNull()
      return
    }
    expect(revision).not.toBeNull()
    expect(revision?.key).toBe(key)
    expect(revision?.index ? [revision.index.kind, revision.index.value] : null).toEqual(index)
    expect(revision?.date ?? null).toBe(date)
  })
})

describe('findRevisionSeries, on the shared cases', () => {
  it.each(cases.series.map((entry, i) => ({ ...entry, i })))('case $i', ({ files, expect: expected }) => {
    const series = findRevisionSeries(files.map((file) => ({ ...file, filename: file.name })))
    expect(
      series.map((entry) => ({
        key: entry.key.replace(/\.[a-z0-9]+$/, ''),
        current: entry.current.item.id,
        older: entry.older.map((member) => member.item.id),
      }))
    ).toEqual(expected)
  })
})

describe('revisionLabel', () => {
  it('reads as an office writes it', () => {
    expect(revisionLabel(parseRevisionName('EG_Grundriss_Index_C_2026-08-14.pdf')!)).toBe('Index C · 14.08.2026')
    expect(revisionLabel(parseRevisionName('Lageplan_v3.pdf')!)).toBe('v3')
    expect(revisionLabel(parseRevisionName('Ansicht Nord Stand 02.09.2026.pdf')!)).toBe('02.09.2026')
  })
})

describe('findRevisionCandidate', () => {
  const doc = (filename: string, createdAt = '2026-07-02T10:00:00Z') => ({ filename, createdAt })

  it('is the one current document of the series, and unambiguous, when the file is newer', () => {
    const found = findRevisionCandidate('EG_Grundriss_Index_C_2026-08-14.pdf', [doc('EG_Grundriss_Index_B_2026-07-02.pdf')])

    expect(found?.candidates.map((candidate) => candidate.item.filename)).toEqual(['EG_Grundriss_Index_B_2026-07-02.pdf'])
    expect(found?.candidates[0].label).toBe('Index B · 02.07.2026')
    expect(found).toMatchObject({ newer: true, unambiguous: true })
  })

  it('is not unambiguous when several current documents could be meant, and lists them newest first', () => {
    const found = findRevisionCandidate('EG_Grundriss_Index_D.pdf', [doc('EG_Grundriss_Index_A.pdf'), doc('EG_Grundriss_Index_C.pdf')])

    expect(found?.candidates.map((candidate) => candidate.label)).toEqual(['Index C', 'Index A'])
    expect(found).toMatchObject({ newer: true, unambiguous: false })
  })

  it('is not newer, and so not unambiguous, when the file is older than what is there', () => {
    const found = findRevisionCandidate('EG_Grundriss_Index_A.pdf', [doc('EG_Grundriss_Index_C.pdf')])

    expect(found).toMatchObject({ newer: false, unambiguous: false })
  })

  it('treats the same revision under another name as no successor: a tie goes to the file, but index and date are equal', () => {
    const found = findRevisionCandidate('EG_Grundriss_Index_B_kopie.pdf', [doc('EG_Grundriss_Index_B.pdf')])

    expect(found).toBeNull()
  })

  it('compares by date when the names carry dates only', () => {
    expect(findRevisionCandidate('Schnitt_2026-09-01.pdf', [doc('Schnitt_2026-08-01.pdf')])).toMatchObject({ newer: true })
    expect(findRevisionCandidate('Schnitt_2026-07-01.pdf', [doc('Schnitt_2026-08-01.pdf')])).toMatchObject({ newer: false })
  })

  it('has no candidate for a name the shelf already holds, in either Unicode form: that is a new version', () => {
    expect(
      findRevisionCandidate('Küche_Index_C.pdf'.normalize('NFC'), [
        doc('Küche_Index_C.pdf'.normalize('NFD')),
        doc('Küche_Index_B.pdf'),
      ]),
    ).toBeNull()
  })

  it('has no candidate across formats, across series, or for a name without a series', () => {
    expect(findRevisionCandidate('EG_Grundriss_Index_C.dwg', [doc('EG_Grundriss_Index_B.pdf')])).toBeNull()
    expect(findRevisionCandidate('OG_Grundriss_Index_C.pdf', [doc('EG_Grundriss_Index_B.pdf')])).toBeNull()
    expect(findRevisionCandidate('Baubeschreibung.pdf', [doc('Baubeschreibung_Index_B.pdf')])).toBeNull()
    expect(findRevisionCandidate('EG_Grundriss_Index_C.pdf', [])).toBeNull()
  })

  it('lists at most five candidates', () => {
    const many = Array.from({ length: 8 }, (_, index) => doc(`EG_Grundriss_Index_${String.fromCharCode(65 + index)}.pdf`))

    expect(findRevisionCandidate('EG_Grundriss_Index_Z.pdf', many)?.candidates).toHaveLength(REVISION_MAX_CANDIDATES)
  })
})

describe('revisionSeriesKeyOf', () => {
  it('is shared by every state of a document in one format, and by nothing else', () => {
    expect(revisionSeriesKeyOf('EG_Grundriss_Index_B.pdf')).toBe(revisionSeriesKeyOf('EG_Grundriss_Index_C_2026-08-14.pdf'))
    expect(revisionSeriesKeyOf('EG_Grundriss_Index_B.pdf')).not.toBe(revisionSeriesKeyOf('EG_Grundriss_Index_B.dwg'))
    expect(revisionSeriesKeyOf('Baubeschreibung.pdf')).toBeNull()
  })
})
