import { describe, expect, it } from 'vitest'
import type { DocumentReference, Dossier, DossierFact, ReadingCoverage } from '@/lib/documents/dossier'
import type { FindingsDocument } from '@/lib/documents/findings'
import type { ProfileFacts } from '@/lib/documents/profile-contradictions'
import { parseUploadReport, reportSaysSomething, uploadReport, UPLOAD_REPORT_LIMITS } from './upload-report'

const dossier = (overrides: Partial<Dossier> = {}): Dossier => ({
  documentType: null,
  title: null,
  summary: null,
  parties: [],
  dates: [],
  place: null,
  facts: [],
  ...overrides,
})

const fact = (key: DossierFact['key'], value: string, page = 1, unit: string | null = null): DossierFact => ({
  key,
  value,
  unit,
  page,
  quote: null,
})

const ref = (kind: DocumentReference['kind'], key: string, label: string, pages = [1]): DocumentReference => ({
  kind,
  key,
  label,
  pages,
})

const coverage = (pages: number, notRead: number): ReadingCoverage => ({
  pages,
  text: pages - notRead,
  transcribed: 0,
  drawings: notRead,
  drawingsRead: 0,
  notRead,
  reasons: notRead > 0 ? { render_cap: notRead } : {},
})

const doc = (id: string, overrides: Partial<FindingsDocument> = {}): FindingsDocument => ({
  id,
  name: `${id}.pdf`,
  filename: `${id}.pdf`,
  superseded: false,
  tags: [],
  dossier: null,
  references: [],
  coverage: null,
  documentNumber: null,
  ...overrides,
})

const drawing = (id: string, number: string, facts: DossierFact[] = []): FindingsDocument =>
  doc(id, {
    filename: `${number}_Grundriss.pdf`,
    documentNumber: number,
    dossier: dossier({ documentType: 'submission_drawing', facts }),
    coverage: coverage(1, 0),
  })

/** What the project held before the upload: a Baubeschreibung that names a Bodengutachten and EP-01…EP-03. */
const description = doc('baubeschreibung', {
  dossier: dossier({
    documentType: 'building_description',
    facts: [fact('storeys_above_ground', '4', 2), fact('building_class', 'GK 3', 2)],
  }),
  references: [
    ref('document', 'soil_report', 'Bodengutachten', [7]),
    ref('plan', 'EP-01', 'EP-01'),
    ref('plan', 'EP-02', 'EP-02'),
    ref('plan', 'EP-03', 'EP-03'),
  ],
  coverage: coverage(18, 0),
})

describe('uploadReport', () => {
  it('counts what a submission set brought, by type, and the findings it closed and opened', () => {
    const batch = [
      drawing('ep01', 'EP-01', [fact('storeys_above_ground', '4')]),
      drawing('ep02', 'EP-02'),
      drawing('ep03', 'EP-03', [fact('storeys_above_ground', '5')]),
      doc('bescheid', {
        dossier: dossier({ documentType: 'permit' }),
        references: [ref('document', 'fire_safety_concept', 'Brandschutzkonzept', [2])],
        coverage: coverage(4, 0),
      }),
      doc('fire', {
        dossier: dossier({ documentType: 'fire_safety_concept', facts: [fact('building_class', 'GK 4', 2)] }),
        references: [ref('document', 'soil_report', 'Bodengutachten', [3]), ref('plan', 'EP-07', 'EP-07', [5])],
        coverage: coverage(12, 3),
      }),
    ]
    const report = uploadReport(batch, [description, ...batch])

    expect(report.documents).toBe(5)
    expect(report.read).toBe(5)
    expect(report.byType).toEqual([
      { type: 'submission_drawing', count: 3 },
      { type: 'fire_safety_concept', count: 1 },
      { type: 'permit', count: 1 },
    ])
    expect(report.facts).toBe(3)
    expect(report.factSamples).toEqual([
      { key: 'building_class', value: 'GK 4', unit: null },
      { key: 'storeys_above_ground', value: '4', unit: null },
    ])
    // The drawings EP-01…03 answered the Baubeschreibung's references; the Bodengutachten is still missing, not new.
    expect(report.resolvedFindings).toBe(3)
    expect(report.findings).toEqual([
      { kind: 'contradiction', key: 'storeys_above_ground', label: null, documents: 3 },
      { kind: 'contradiction', key: 'building_class', label: null, documents: 2 },
      { kind: 'missing_plan', key: 'EP-07', label: 'EP-07', documents: 1 },
    ])
    expect(report.newFindings).toBe(3)
    // The Brandschutzkonzept the Bescheid names came with it; the Bodengutachten and EP-07 did not.
    expect(report.unresolvedReferences).toBe(2)
    expect(report.pagesNotRead).toBe(3)
    expect(report.documentsNotFullyRead).toBe(1)
  })

  it('reports a contradiction with the Steckbrief that the upload brought', () => {
    const profile: ProfileFacts = { facts: { building_class: { value: 'GK3' } } }
    const fire = doc('fire', {
      dossier: dossier({ documentType: 'fire_safety_concept', facts: [fact('building_class', 'Gebäudeklasse 4', 2)] }),
    })
    const report = uploadReport([fire], [description], profile)
    expect(report.findings[0]).toEqual({ kind: 'profile_contradiction', key: 'building_class', label: null, documents: 1 })
  })

  it('takes the project with or without the batch among its documents alike', () => {
    const batch = [drawing('ep01', 'EP-01')]
    expect(uploadReport(batch, [description])).toEqual(uploadReport(batch, [description, ...batch]))
  })

  it('names no document: the report holds counts, types and keys only', () => {
    const batch = [doc('Lohnzettel_Huber', { name: 'Lohnzettel Huber.pdf', dossier: dossier({ documentType: 'other' }) })]
    expect(JSON.stringify(uploadReport(batch, [description]))).not.toContain('Huber')
  })

  it('keeps its lists within their bounds', () => {
    const batch = Array.from({ length: 12 }, (_, index) =>
      doc(`d${index}`, { references: [ref('plan', `X-${100 + index}`, `X-${100 + index}`)], coverage: coverage(1, 0) })
    )
    const report = uploadReport(batch, [])
    expect(report.newFindings).toBe(12)
    expect(report.findings).toHaveLength(UPLOAD_REPORT_LIMITS.findings)
  })

  it('has nothing to say about an upload Piloti read none of', () => {
    expect(reportSaysSomething(uploadReport([doc('held')], [description]))).toBe(false)
  })
})

describe('parseUploadReport', () => {
  it('reads back what the settle wrote, and nothing it did not', () => {
    const report = { projectId: 'proj-1', ...uploadReport([drawing('ep01', 'EP-01')], [description]) }
    expect(parseUploadReport(JSON.parse(JSON.stringify(report)))).toEqual(report)
    expect(parseUploadReport({ ...report, byType: [{ type: 'secret_dossier', count: 1 }] })).toBeNull()
    expect(parseUploadReport('12 Dokumente')).toBeNull()
    expect(parseUploadReport(undefined)).toBeNull()
  })
})
