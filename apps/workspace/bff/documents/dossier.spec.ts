import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_REFERENCES_MAX,
  DOSSIER_MAX_FACTS,
  DOSSIER_MAX_PARTIES,
  DOSSIER_MAX_QUOTE_LENGTH,
  parseDocumentReferences,
  parseDossier,
  parseReadingCoverage,
} from './dossier'

describe('parseDossier', () => {
  it('maps the contract example to camelCase', () => {
    expect(
      parseDossier({
        version: 1,
        document_type: 'submission_drawing',
        title: 'Grundriss Erdgeschoss',
        summary: 'Einreichplan des Erdgeschosses im Maßstab 1:100 mit fünf Wohnräumen.',
        parties: [{ role: 'architect', name: 'Atelier Lindner Architektur ZT GmbH' }],
        dates: [{ kind: 'plan_date', date: '2025-03-12' }],
        place: { address: 'Hubergasse 14', municipality: 'Wien', state: 'Wien' },
        facts: [{ key: 'storeys_above_ground', value: '4', unit: null, page: 1, quote: '4 oberirdische Geschosse' }],
      })
    ).toEqual({
      documentType: 'submission_drawing',
      title: 'Grundriss Erdgeschoss',
      summary: 'Einreichplan des Erdgeschosses im Maßstab 1:100 mit fünf Wohnräumen.',
      parties: [{ role: 'architect', name: 'Atelier Lindner Architektur ZT GmbH' }],
      dates: [{ kind: 'plan_date', date: '2025-03-12' }],
      place: { address: 'Hubergasse 14', municipality: 'Wien', state: 'Wien' },
      facts: [{ key: 'storeys_above_ground', value: '4', unit: null, page: 1, quote: '4 oberirdische Geschosse' }],
    })
  })

  it('drops every value outside its vocabulary, entry by entry', () => {
    const dossier = parseDossier({
      document_type: 'Einreichplan',
      parties: [
        { role: 'bauherr', name: 'Familie Gruber' },
        { role: 'client', name: 'Familie Gruber' },
      ],
      dates: [
        { kind: 'whenever', date: '2025-01-01' },
        { kind: 'issued', date: '12.03.2025' },
        { kind: 'received', date: '2025-04-02' },
      ],
      facts: [
        { key: 'gebaeudeklasse', value: '4' },
        { key: 'building_class', value: 'GK 4', page: 0 },
      ],
    })
    expect(dossier).toEqual({
      documentType: null,
      title: null,
      summary: null,
      parties: [{ role: 'client', name: 'Familie Gruber' }],
      dates: [{ kind: 'received', date: '2025-04-02' }],
      place: null,
      facts: [{ key: 'building_class', value: 'GK 4', unit: null, page: null, quote: null }],
    })
  })

  it('reads a numeric value as text and keeps its unit', () => {
    const dossier = parseDossier({ facts: [{ key: 'gross_floor_area', value: 1245.5, unit: 'm²', page: 3 }] })
    expect(dossier?.facts).toEqual([{ key: 'gross_floor_area', value: '1245.5', unit: 'm²', page: 3, quote: null }])
  })

  it('reads what a new Fassung changed against the one it replaced, once per key', () => {
    const dossier = parseDossier({
      document_type: 'submission_drawing',
      facts: [{ key: 'storeys_above_ground', value: '5' }],
      changes: [
        { key: 'storeys_above_ground', before: '4', after: '5', page: 2 },
        { key: 'storeys_above_ground', before: '3', after: '5', page: 2 },
        { key: 'room_height', before: '2.60 m', after: null, page: null },
        { key: 'colour', before: 'rot', after: 'blau' },
        { key: 'units', before: null, after: null },
      ],
      changed_against: 'EP-01_C.pdf',
    })
    expect(dossier?.changes).toEqual([
      { key: 'storeys_above_ground', before: '4', after: '5', page: 2 },
      { key: 'room_height', before: '2.60 m', after: null, page: null },
    ])
  })

  it('has no changes field when the dossier says nothing of a predecessor', () => {
    expect(parseDossier({ document_type: 'permit' })).not.toHaveProperty('changes')
  })

  it('bounds parties, facts and quotes to the contract', () => {
    const dossier = parseDossier({
      parties: Array.from({ length: 12 }, (_, index) => ({ role: 'engineer', name: `Büro ${index}` })),
      facts: Array.from({ length: 30 }, () => ({ key: 'units', value: '12', quote: 'x'.repeat(400) })),
    })
    expect(dossier?.parties).toHaveLength(DOSSIER_MAX_PARTIES)
    expect(dossier?.facts).toHaveLength(DOSSIER_MAX_FACTS)
    expect(dossier?.facts[0].quote).toHaveLength(DOSSIER_MAX_QUOTE_LENGTH)
  })

  it('is null for nothing usable, and for what is not an object', () => {
    expect(parseDossier({ document_type: 'novel', facts: [{ key: 'colour', value: 'rot' }] })).toBeNull()
    expect(parseDossier(null)).toBeNull()
    expect(parseDossier([])).toBeNull()
    expect(parseDossier('Baubeschreibung')).toBeNull()
  })
})

describe('parseDocumentReferences', () => {
  it('keeps the four kinds and sorts and dedupes pages', () => {
    expect(
      parseDocumentReferences([
        { kind: 'norm', key: 'önorm b 1600', label: 'ÖNORM B 1600', pages: [7, 3, 3] },
        { kind: 'law', key: '§ 33 baybo', label: '§ 33 BayBO', pages: [2] },
        { kind: 'plan', key: 'ep-05', label: 'EP-05', pages: [1] },
        { kind: 'document', key: 'fire_safety_concept', label: 'Brandschutzkonzept', pages: [4] },
      ])
    ).toEqual([
      { kind: 'norm', key: 'önorm b 1600', label: 'ÖNORM B 1600', pages: [3, 7] },
      { kind: 'law', key: '§ 33 baybo', label: '§ 33 BayBO', pages: [2] },
      { kind: 'plan', key: 'ep-05', label: 'EP-05', pages: [1] },
      { kind: 'document', key: 'fire_safety_concept', label: 'Brandschutzkonzept', pages: [4] },
    ])
  })

  it('drops an unknown kind, a document key that is no document type, and duplicates', () => {
    expect(
      parseDocumentReferences([
        { kind: 'rumour', key: 'x', label: 'X' },
        { kind: 'document', key: 'Brandschutzkonzept', label: 'Brandschutzkonzept' },
        { kind: 'plan', key: 'ep-05', label: 'EP-05', pages: ['1', -2, 1.5] },
        { kind: 'plan', key: 'ep-05', label: 'EP 05', pages: [9] },
      ])
    ).toEqual([{ kind: 'plan', key: 'ep-05', label: 'EP-05', pages: [] }])
  })

  it('falls back to the key for a missing label and caps the list', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ kind: 'plan', key: `a-${index}` }))
    const parsed = parseDocumentReferences(many)
    expect(parsed).toHaveLength(DOCUMENT_REFERENCES_MAX)
    expect(parsed?.[0]).toEqual({ kind: 'plan', key: 'a-0', label: 'a-0', pages: [] })
  })

  it('is null when nothing survives', () => {
    expect(parseDocumentReferences([])).toBeNull()
    expect(parseDocumentReferences({ kind: 'plan' })).toBeNull()
    expect(parseDocumentReferences(undefined)).toBeNull()
  })
})

describe('parseReadingCoverage', () => {
  it('maps the contract example', () => {
    expect(
      parseReadingCoverage({
        pages: 40,
        text: 30,
        transcribed: 5,
        drawings: 5,
        drawings_read: 3,
        not_read: 2,
        reasons: { render_cap: 2 },
      })
    ).toEqual({ pages: 40, text: 30, transcribed: 5, drawings: 5, drawingsRead: 3, notRead: 2, reasons: { render_cap: 2 } })
  })

  it('drops unknown reasons and reads bad counts as zero', () => {
    expect(
      parseReadingCoverage({ pages: 10, text: -1, not_read: 3, reasons: { render_cap: 1, gremlins: 2, vision_failed: 'two' } })
    ).toEqual({ pages: 10, text: 0, transcribed: 0, drawings: 0, drawingsRead: 0, notRead: 3, reasons: { render_cap: 1 } })
  })

  it('never counts more pages unread than the document has', () => {
    expect(parseReadingCoverage({ pages: 4, not_read: 9 })?.notRead).toBe(4)
  })

  it('is null without a page count', () => {
    expect(parseReadingCoverage({ pages: 0 })).toBeNull()
    expect(parseReadingCoverage({ text: 3 })).toBeNull()
    expect(parseReadingCoverage(null)).toBeNull()
  })
})
