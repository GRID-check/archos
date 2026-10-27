import { describe, expect, it } from 'vitest'
import type { DocumentReference, Dossier, DossierFact } from './dossier'
import {
  deriveDocumentFindings,
  documentTypesOf,
  findingConcerns,
  normalizeFactValue,
  referencedBy,
  resolveReferences,
  squashDrawingNumber,
  type FindingsDocument,
} from './findings'

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

const fact = (key: DossierFact['key'], value: string, page: number | null = 1, unit: string | null = null): DossierFact => ({
  key,
  value,
  unit,
  page,
  quote: null,
})

const ref = (kind: DocumentReference['kind'], key: string, label: string, pages: number[] = [1]): DocumentReference => ({
  kind,
  key,
  label,
  pages,
})

const doc = (id: string, overrides: Partial<FindingsDocument> = {}): FindingsDocument => ({
  id,
  name: overrides.filename ?? `${id}.pdf`,
  filename: `${id}.pdf`,
  superseded: false,
  tags: [],
  dossier: null,
  references: [],
  coverage: null,
  documentNumber: null,
  ...overrides,
})

const description = doc('baubeschreibung', {
  name: 'Baubeschreibung Hubergasse 14.pdf',
  filename: 'Baubeschreibung Hubergasse 14.pdf',
  dossier: dossier({
    documentType: 'building_description',
    facts: [fact('storeys_above_ground', '4', 2), fact('gross_floor_area', '1.245,5', 3, 'm²'), fact('building_class', 'GK 4', 2)],
  }),
  references: [
    ref('plan', 'ep-05', 'EP-05', [1, 4]),
    ref('plan', 'ep-07', 'EP-07', [4]),
    ref('document', 'fire_safety_concept', 'Brandschutzkonzept', [6]),
    ref('document', 'soil_report', 'Bodengutachten', [7]),
    ref('norm', 'önorm b 1600', 'ÖNORM B 1600', [3]),
  ],
})

const groundFloor = doc('ep05', {
  name: 'Grundriss EG',
  filename: 'EP05_Grundriss_EG_Index-C.pdf',
  tags: ['Grundriss'],
  dossier: dossier({ documentType: 'submission_drawing', facts: [fact('storeys_above_ground', '5', 1)] }),
  coverage: { pages: 40, text: 30, transcribed: 5, drawings: 5, drawingsRead: 3, notRead: 2, reasons: { render_cap: 2 } },
})

const fireConcept = doc('brandschutz', {
  name: 'Brandschutzkonzept_V2.pdf',
  filename: 'Brandschutzkonzept_V2.pdf',
  tags: ['Gutachten', 'Brandschutz'],
  references: [ref('document', 'building_description', 'Baubeschreibung', [2])],
})

describe('squashDrawingNumber and normalizeFactValue', () => {
  it('drops case, spaces, hyphens and underscores', () => {
    expect(squashDrawingNumber('EP - 05')).toBe('ep05')
    expect(squashDrawingNumber('a_501')).toBe('a501')
  })

  it('reads a decimal comma as a dot and 4.0 as 4', () => {
    expect(normalizeFactValue(' 12,5 ')).toBe('12.5')
    expect(normalizeFactValue('4.0')).toBe('4')
    expect(normalizeFactValue('Wohnen  und Büro')).toBe('wohnen und büro')
    expect(normalizeFactValue('GK 4')).toBe('gk 4')
  })
})

describe('documentTypesOf', () => {
  it('reads the dossier type and the tags', () => {
    expect(documentTypesOf({ dossier: dossier({ documentType: 'permit' }), tags: ['Foto'] })).toEqual(new Set(['permit', 'photo']))
  })

  it('takes a Gutachten with Brandschutz for the fire safety concept', () => {
    expect(documentTypesOf({ dossier: null, tags: ['Gutachten', 'Brandschutz'] })).toEqual(
      new Set(['expert_report', 'fire_safety_concept'])
    )
  })

  it('reads Sonstiges and a discipline alone as no type', () => {
    expect(documentTypesOf({ dossier: null, tags: ['Sonstiges', 'Schallschutz'] }).size).toBe(0)
  })
})

describe('resolveReferences', () => {
  const project = [description, groundFloor, fireConcept]

  it('resolves a drawing number through the file name, case, space and hyphen aside', () => {
    const [ep05, ep07, fire, soil, norm] = resolveReferences(description, project)
    expect(ep05).toMatchObject({ resolution: 'resolved', targets: [{ documentId: 'ep05', name: 'Grundriss EG' }] })
    expect(ep07.resolution).toBe('missing')
    expect(fire).toMatchObject({ resolution: 'resolved', targets: [{ documentId: 'brandschutz' }] })
    expect(soil.resolution).toBe('missing')
    expect(norm).toEqual({ reference: norm.reference, resolution: 'external', targets: [] })
  })

  it('prefers the title block number over a file name', () => {
    const titled = doc('a', { filename: 'Erdgeschoss.pdf', documentNumber: 'EP 05' })
    const named = doc('b', { filename: 'EP-05 alt.pdf' })
    const [resolved] = resolveReferences(description, [description, titled, named])
    expect(resolved.targets.map((target) => target.documentId)).toEqual(['a'])
  })

  it('does not match a longer number or a number inside a word', () => {
    const others = [doc('x', { filename: 'EP-050_Schnitt.pdf' }), doc('y', { filename: 'STEP-05.pdf' })]
    expect(resolveReferences(description, [description, ...others])[0].resolution).toBe('missing')
  })

  it('finds the sheet of a detail reference', () => {
    const source = doc('s', { references: [ref('plan', '3/a-501', 'Detail 3/A-501')] })
    const sheet = doc('t', { documentNumber: 'A-501' })
    expect(resolveReferences(source, [source, sheet])[0]).toMatchObject({ resolution: 'resolved', targets: [{ documentId: 't' }] })
  })

  it('answers a broad Gutachten reference with a specific report', () => {
    const source = doc('s', { references: [ref('document', 'expert_report', 'Gutachten')] })
    const soil = doc('b', { dossier: dossier({ documentType: 'soil_report' }) })
    expect(resolveReferences(source, [source, soil])[0].resolution).toBe('resolved')
  })

  it('reads a reference only the document itself answers as self, not missing', () => {
    const own = doc('own', {
      dossier: dossier({ documentType: 'building_description' }),
      references: [ref('document', 'building_description', 'Baubeschreibung')],
    })
    expect(resolveReferences(own, [own])[0].resolution).toBe('self')
  })
})

describe('referencedBy', () => {
  it('lists the documents that point at this one, and with what', () => {
    const project = [description, groundFloor, fireConcept]
    expect(referencedBy(groundFloor, project)).toEqual([
      { source: { documentId: 'baubeschreibung', name: 'Baubeschreibung Hubergasse 14.pdf' }, reference: description.references[0] },
    ])
    expect(referencedBy(description, project).map((incoming) => incoming.source.documentId)).toEqual(['brandschutz'])
  })
})

describe('deriveDocumentFindings', () => {
  it('finds the contradiction, the missing documents and drawings, and the incomplete read, in that order', () => {
    const findings = deriveDocumentFindings([description, groundFloor, fireConcept])
    expect(findings.map((finding) => finding.kind)).toEqual([
      'contradiction',
      'missing_document',
      'missing_plan',
      'incomplete_read',
    ])
    expect(findings[0]).toEqual({
      kind: 'contradiction',
      factKey: 'storeys_above_ground',
      sources: [
        { documentId: 'baubeschreibung', name: 'Baubeschreibung Hubergasse 14.pdf', pages: [2], value: '4', unit: null },
        { documentId: 'ep05', name: 'Grundriss EG', pages: [1], value: '5', unit: null },
      ],
    })
    expect(findings[1]).toMatchObject({
      kind: 'missing_document',
      documentType: 'soil_report',
      label: 'Bodengutachten',
      sources: [{ documentId: 'baubeschreibung', pages: [7] }],
    })
    expect(findings[2]).toMatchObject({ kind: 'missing_plan', key: 'ep-07', label: 'EP-07', sources: [{ pages: [4] }] })
    expect(findings[3]).toEqual({
      kind: 'incomplete_read',
      pages: 40,
      notRead: 2,
      reasons: { render_cap: 2 },
      sources: [{ documentId: 'ep05', name: 'Grundriss EG', pages: [] }],
    })
  })

  it('reads 12,5 and 12.5 as one value', () => {
    const a = doc('a', { dossier: dossier({ facts: [fact('room_height', '2,60', 3, 'm')] }) })
    const b = doc('b', { dossier: dossier({ facts: [fact('room_height', ' 2.6 ', 5, 'm')] }) })
    expect(deriveDocumentFindings([a, b])).toEqual([])
  })

  it('ignores a superseded document when looking for contradictions', () => {
    const old = { ...groundFloor, id: 'ep05-b', superseded: true, coverage: null }
    const current = { ...groundFloor, dossier: dossier({ facts: [fact('storeys_above_ground', '4', 1)] }), coverage: null }
    const findings = deriveDocumentFindings([description, old, current, fireConcept])
    expect(findings.some((finding) => finding.kind === 'contradiction')).toBe(false)
  })

  it('does not count the references or gaps of a superseded document, but lets it answer one', () => {
    const replaced = doc('old', {
      superseded: true,
      references: [ref('plan', 'ep-99', 'EP-99')],
      coverage: { pages: 3, text: 1, transcribed: 0, drawings: 2, drawingsRead: 0, notRead: 2, reasons: { vision_failed: 2 } },
      dossier: dossier({ documentType: 'soil_report' }),
    })
    const findings = deriveDocumentFindings([description, groundFloor, fireConcept, replaced])
    expect(findings.find((finding) => finding.kind === 'missing_plan' && finding.key === 'ep-99')).toBeUndefined()
    expect(findings.find((finding) => finding.kind === 'missing_document')).toBeUndefined()
    expect(findings.filter((finding) => finding.kind === 'incomplete_read')).toHaveLength(1)
  })

  it('lets a document that states a key twice agree with one that shares a value', () => {
    const a = doc('a', { dossier: dossier({ facts: [fact('room_height', '2,50', 2), fact('room_height', '2,80', 3)] }) })
    const b = doc('b', { dossier: dossier({ facts: [fact('room_height', '2.8', 1)] }) })
    expect(deriveDocumentFindings([a, b])).toEqual([])
  })

  it('groups one missing drawing named by two documents into one finding', () => {
    const a = doc('a', { name: 'Statik.pdf', references: [ref('plan', 'ep-07', 'EP-07', [2])] })
    const b = doc('b', { name: 'Baubeschreibung.pdf', references: [ref('plan', 'EP 07', 'EP 07', [5])] })
    const findings = deriveDocumentFindings([a, b])
    expect(findings).toHaveLength(1)
    expect(findings[0].sources.map((source) => source.name)).toEqual(['Baubeschreibung.pdf', 'Statik.pdf'])
  })

  it('is empty for a project whose documents say nothing about each other', () => {
    expect(deriveDocumentFindings([doc('a'), doc('b', { tags: ['Foto'] })])).toEqual([])
  })
})

describe('findingConcerns', () => {
  it('says whether a finding rests on a document', () => {
    const [contradiction] = deriveDocumentFindings([description, groundFloor])
    expect(findingConcerns(contradiction, 'ep05')).toBe(true)
    expect(findingConcerns(contradiction, 'brandschutz')).toBe(false)
  })
})
