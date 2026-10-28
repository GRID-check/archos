/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { Dossier } from '@/lib/documents/dossier'
import type { DocumentMetadata } from '@/lib/documents/reconcile-status'
import { factNumber, factToken, foldFactValue, hasReading, referenceToken, toSearchFacets } from './facets'

const subject = { documentId: '00000000-0000-4000-8000-000000000001', organizationId: 'org_1', superseded: false }

const dossier = (overrides: Partial<Dossier> = {}): Dossier => ({
  documentType: 'submission_drawing',
  title: 'Grundriss Erdgeschoss',
  summary: 'Einreichplan des Erdgeschosses.',
  parties: [{ role: 'architect', name: 'Atelier Lindner ZT GmbH' }],
  dates: [{ kind: 'plan_date', date: '2025-03-12' }],
  place: { address: 'Hubergasse 14', municipality: 'Wien', state: 'Wien' },
  facts: [
    { key: 'building_class', value: 'Gebäudeklasse IV', unit: null, page: 1, quote: null },
    { key: 'floor_area_ratio', value: '1,25', unit: null, page: 2, quote: null },
    { key: 'use', value: 'Wohnen', unit: null, page: 1, quote: null },
  ],
  ...overrides,
})

const reading = (overrides: Partial<DocumentMetadata> = {}): DocumentMetadata => ({
  summary: 'Kurz.',
  pageCount: 4,
  tags: ['plan', 'plan'],
  topics: ['Fluchtweg'],
  dossier: dossier(),
  docReferences: [
    { kind: 'norm', key: 'önorm b 1600', label: 'ÖNORM B 1600', pages: [3] },
    { kind: 'plan', key: 'ep-05', label: 'EP-05', pages: [1] },
  ],
  revisionFacts: { documentNumber: 'EP 03', revision: 'C', revisionDate: '2025-03-14', scale: '1:100' },
  coverage: { pages: 4, text: 2, transcribed: 0, drawings: 2, drawingsRead: 1, notRead: 1, reasons: { render_cap: 1 } },
  ...overrides,
})

describe('the payload tokens', () => {
  it('writes a reference as the Qdrant payload does: kind:key, lower case', () => {
    expect(referenceToken('norm', 'ÖNORM B 1600')).toBe('norm:önorm b 1600')
  })

  it('folds a Gebäudeklasse written in words or Roman numerals to its number', () => {
    expect(foldFactValue('building_class', 'GK 4')).toBe('4')
    expect(foldFactValue('building_class', 'Gebäudeklasse IV')).toBe('4')
    expect(factToken('building_class', '4')).toBe('building_class=4')
  })

  it('folds case, spaces and the decimal comma for every other fact', () => {
    expect(factToken('room_height', ' 2,60 ')).toBe('room_height=2.60')
    expect(factNumber('room_height', '2,60')).toBe(2.6)
    expect(factNumber('use', 'Wohnen')).toBeNull()
  })
})

describe('toSearchFacets', () => {
  it('projects the dossier, the Plankopf and the coverage into one row', () => {
    const row = toSearchFacets(subject, reading())
    expect(row).toMatchObject({
      documentType: 'submission_drawing',
      tags: ['plan'],
      title: 'Grundriss Erdgeschoss',
      summary: 'Einreichplan des Erdgeschosses.',
      partyRoles: ['architect'],
      municipality: 'Wien',
      factTokens: ['building_class=4', 'floor_area_ratio=1.25', 'use=wohnen'],
      factNumbers: { building_class: 4, floor_area_ratio: 1.25 },
      referenceTokens: ['norm:önorm b 1600', 'plan:ep-05'],
      referenceLabels: { 'norm:önorm b 1600': 'ÖNORM B 1600', 'plan:ep-05': 'EP-05' },
      planNumber: 'EP 03',
      planNumberKey: 'ep03',
      planIndex: 'C',
      planDate: '2025-03-14',
      scale: '1:100',
      documentDate: '2025-03-12',
      pageCount: 4,
      pagesNotRead: 1,
      superseded: false,
    })
    expect(row?.searchText).toContain('Atelier Lindner ZT GmbH')
    expect(row?.searchText).toContain('ÖNORM B 1600')
  })

  it('returns null for a listing that said nothing of the reading, so a stored row is not blanked', () => {
    expect(toSearchFacets(subject, null)).toBeNull()
    expect(toSearchFacets(subject, { chunkCount: 12, contentTypes: ['text'] })).toBeNull()
    expect(hasReading({ summary: 'x' })).toBe(true)
  })

  it('gives the same fingerprint for the same reading and another for a changed one', () => {
    const first = toSearchFacets(subject, reading())
    const again = toSearchFacets(subject, reading())
    const changed = toSearchFacets({ ...subject, superseded: true }, reading())
    expect(first?.fingerprint).toBe(again?.fingerprint)
    expect(changed?.fingerprint).not.toBe(first?.fingerprint)
  })

  it('reads an EXIF capture time and drops one it cannot read', () => {
    const photo = toSearchFacets(subject, reading({ capture: { capturedAt: '2026:09:14 10:31:00', camera: 'iPhone 15' } }))
    expect(photo?.capturedAt?.toISOString().slice(0, 10)).toBe('2026-09-14')
    expect(photo?.camera).toBe('iPhone 15')
    expect(toSearchFacets(subject, reading({ capture: { capturedAt: 'gestern' } }))?.capturedAt).toBeNull()
  })

  it('projects what a new Fassung changed, keys in the same order, and re-fingerprints when it does', () => {
    const changes = [
      { key: 'storeys_above_ground' as const, before: '4', after: '5', page: 2 },
      { key: 'room_height' as const, before: '2.60 m', after: null, page: null },
    ]
    const row = toSearchFacets(subject, reading({ dossier: dossier({ changes }) }))
    expect(row?.changedFacts).toEqual(changes)
    expect(row?.changedFactKeys).toEqual(['storeys_above_ground', 'room_height'])
    expect(row?.fingerprint).not.toBe(toSearchFacets(subject, reading())?.fingerprint)
  })

  it('projects no change for a dossier that carries none', () => {
    const row = toSearchFacets(subject, reading())
    expect(row?.changedFacts).toEqual([])
    expect(row?.changedFactKeys).toEqual([])
  })

  it('falls back to the Plankopf date when the dossier names none', () => {
    const row = toSearchFacets(subject, reading({ dossier: dossier({ dates: [] }) }))
    expect(row?.documentDate).toBe('2025-03-14')
  })
})
