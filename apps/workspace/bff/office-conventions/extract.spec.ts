import { describe, expect, it } from 'vitest'
import {
  conventionPathKey,
  documentNumberShape,
  extractOfficeConventions,
  fileDateFormatOf,
  isPattern,
  revisionStyleOf,
  type ConventionDocument,
  type ConventionFolder,
} from './extract'

const doc = (projectId: string, overrides: Partial<ConventionDocument> = {}): ConventionDocument => ({
  projectId,
  folderPath: '',
  filename: 'Dokument.pdf',
  docType: null,
  documentNumber: null,
  revision: null,
  ...overrides,
})

const folders = (projectId: string, ...paths: string[]): ConventionFolder[] => paths.map((path) => ({ projectId, path }))

describe('the pattern threshold', () => {
  it('needs three projects and at least half of those that could show it', () => {
    expect(isPattern({ projects: 3, of: 6 })).toBe(true)
    expect(isPattern({ projects: 2, of: 2 })).toBe(false)
    expect(isPattern({ projects: 3, of: 7 })).toBe(false)
    expect(isPattern({ projects: 0, of: 0 })).toBe(false)
  })
})

describe('conventionPathKey', () => {
  it('compares without case, Unicode form or a leading ordinal, segment by segment', () => {
    expect(conventionPathKey('03_Behörde/Gutachten')).toBe('behörde/gutachten')
    expect(conventionPathKey('3 - BEHÖRDE / gutachten')).toBe('behörde/gutachten')
    expect(conventionPathKey('01.Grundlagen')).toBe('grundlagen')
    expect(conventionPathKey('2026 Fotos')).toBe('2026 fotos')
    expect(conventionPathKey('')).toBe('')
  })
})

describe('extractOfficeConventions: the folder skeleton', () => {
  it('keeps the folders most projects keep, most widely kept first, in their most common spelling', () => {
    const result = extractOfficeConventions({
      documents: [],
      folders: [
        ...folders('p1', '01_Grundlagen', 'Behörde', 'Behörde/Gutachten', 'Fotos'),
        ...folders('p2', '01_Grundlagen', 'Behörde', 'Behörde/Gutachten'),
        ...folders('p3', 'Grundlagen', 'behörde', 'Einreichung'),
        ...folders('p4', '01_Grundlagen', 'Einreichung'),
      ],
    })
    expect(result.projects).toBe(4)
    expect(result.folders).toEqual([
      { path: '01_Grundlagen', projects: 4, of: 4 },
      { path: 'Behörde', projects: 3, of: 4 },
    ])
  })

  it('learns the skeleton two levels deep and never from one project', () => {
    const result = extractOfficeConventions({
      documents: [],
      folders: [
        ...folders('p1', 'Planung/Einreichung/Pläne/Alt'),
        ...folders('p2', 'Planung/Einreichung/Pläne/Alt'),
        ...folders('p3', 'Planung/Einreichung'),
      ],
    })
    expect(result.folders.map((entry) => entry.path)).toEqual(['Planung', 'Planung/Einreichung'])
  })

  it('learns nothing from an office of two projects', () => {
    const result = extractOfficeConventions({
      documents: [],
      folders: [...folders('p1', 'Grundlagen'), ...folders('p2', 'Grundlagen')],
    })
    expect(result.folders).toEqual([])
  })
})

describe('extractOfficeConventions: where each Dokumentart is filed', () => {
  it('counts each project once, by where most of its documents of that kind sit', () => {
    const result = extractOfficeConventions({
      folders: [],
      documents: [
        doc('p1', { docType: 'Gutachten', folderPath: 'Fachplaner/Gutachten' }),
        doc('p1', { docType: 'Gutachten', folderPath: 'Fachplaner/Gutachten' }),
        doc('p1', { docType: 'Gutachten', folderPath: 'Behörde' }),
        doc('p2', { docType: 'Gutachten', folderPath: '02_Fachplaner/Gutachten' }),
        doc('p3', { docType: 'Gutachten', folderPath: 'Fachplaner/Gutachten' }),
        doc('p4', { docType: 'Gutachten', folderPath: 'Gutachten' }),
        doc('p5', { docType: 'Gutachten', folderPath: '' }),
        doc('p1', { docType: 'Bescheid', folderPath: 'Behörde' }),
        doc('p2', { docType: 'Bescheid', folderPath: 'Behörde' }),
      ],
    })
    expect(result.filing).toEqual([{ docType: 'Gutachten', path: 'Fachplaner/Gutachten', projects: 3, of: 4 }])
  })

  it('names no folder deeper than the skeleton: a member reads it about projects they are not on', () => {
    const result = extractOfficeConventions({
      folders: [],
      documents: ['p1', 'p2', 'p3'].map((project) =>
        doc(project, { docType: 'Gutachten', folderPath: `Fachplaner/Gutachten/Statik ${project} Müller` })
      ),
    })
    expect(result.filing).toEqual([{ docType: 'Gutachten', path: 'Fachplaner/Gutachten', projects: 3, of: 3 }])
  })

  it('states no place when the projects disagree', () => {
    const result = extractOfficeConventions({
      folders: [],
      documents: ['A', 'B', 'C', 'D', 'E', 'F'].map((folder, index) =>
        doc(`p${index}`, { docType: 'Bescheid', folderPath: index < 3 ? 'Behörde' : folder })
      ),
    })
    expect(result.filing).toEqual([{ docType: 'Bescheid', path: 'Behörde', projects: 3, of: 6 }])
    const split = extractOfficeConventions({
      folders: [],
      documents: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((folder, index) =>
        doc(`p${index}`, { docType: 'Bescheid', folderPath: index < 3 ? 'Behörde' : folder })
      ),
    })
    expect(split.filing).toEqual([])
  })
})

describe('the naming patterns', () => {
  it('masks a Plannummer to its shape and never keeps its letters', () => {
    expect(documentNumberShape('HUB-EP-01-003')).toBe('A-A-00-000')
    expect(documentNumberShape('west_ep_01_003')).toBe('A_A_00_000')
    expect(documentNumberShape('EG')).toBeNull()
    expect(documentNumberShape('Grundriss')).toBeNull()
  })

  it('reads the Index style, with or without its label', () => {
    expect(revisionStyleOf('B')).toBe('letter')
    expect(revisionStyleOf('Index c')).toBe('letter')
    expect(revisionStyleOf('03')).toBe('padded_number')
    expect(revisionStyleOf('Rev. 2')).toBe('number')
    expect(revisionStyleOf('A1')).toBe('letter_number')
    expect(revisionStyleOf('Vorabzug')).toBeNull()
  })

  it('reads the date a file name writes', () => {
    expect(fileDateFormatOf('2026-03-15_Bescheid.pdf')).toBe('YYYY-MM-DD')
    expect(fileDateFormatOf('Protokoll_2026_03_15.pdf')).toBe('YYYY_MM_DD')
    expect(fileDateFormatOf('20260315_Protokoll.pdf')).toBe('YYYYMMDD')
    expect(fileDateFormatOf('Schreiben 15.03.2026.pdf')).toBe('DD.MM.YYYY')
    expect(fileDateFormatOf('Schreiben 15.03.26.pdf')).toBe('DD.MM.YY')
    expect(fileDateFormatOf('HUB-01-02-03.pdf')).toBeNull()
    expect(fileDateFormatOf('20261315_x.pdf')).toBeNull()
  })

  it('reads six digits as a date only when the upload tells the two readings apart', () => {
    const uploaded = new Date('2026-03-20T10:00:00Z')
    expect(fileDateFormatOf('260315_Bescheid.pdf', uploaded)).toBe('YYMMDD')
    expect(fileDateFormatOf('150326_Bescheid.pdf', uploaded)).toBe('DDMMYY')
    expect(fileDateFormatOf('260315_Bescheid.pdf')).toBeNull()
    expect(fileDateFormatOf('100203_Grundriss.pdf', uploaded)).toBeNull()
  })

  it('keeps the shape, the Index style and the date most projects agree on', () => {
    const uploaded = new Date('2026-03-20T10:00:00Z')
    const project = (id: string, number: string, revision: string, filename: string) => [
      doc(id, { documentNumber: number, revision, filename, uploadedAt: uploaded }),
      doc(id, { documentNumber: number, revision, filename, uploadedAt: uploaded }),
    ]
    const result = extractOfficeConventions({
      folders: [],
      documents: [
        ...project('p1', 'HUB-EP-01-003', 'A', '260310_Grundriss.pdf'),
        ...project('p2', 'WEST-EP-02-001', 'B', '260301_Schnitt.pdf'),
        ...project('p3', 'OST-EP-01-010', 'C', '260215_Ansicht.pdf'),
        ...project('p4', 'X/12', '01', 'Lageplan.pdf'),
      ],
    })
    expect(result.documentNumber).toEqual({ shape: 'A-A-00-000', projects: 3, of: 4 })
    expect(result.revisionStyle).toEqual({ style: 'letter', projects: 3, of: 4 })
    expect(result.fileDate).toEqual({ format: 'YYMMDD', projects: 3, of: 3 })
  })

  it('is deterministic: the same rows in another order give the same conventions', () => {
    const documents = [
      doc('p1', { docType: 'Bescheid', folderPath: 'Behörde', revision: 'A' }),
      doc('p2', { docType: 'Bescheid', folderPath: 'Behörde', revision: 'B' }),
      doc('p3', { docType: 'Bescheid', folderPath: 'Behörde', revision: '01' }),
      doc('p3', { docType: 'Bescheid', folderPath: 'Post', revision: 'C' }),
    ]
    const a = extractOfficeConventions({ documents, folders: [] })
    const b = extractOfficeConventions({ documents: [...documents].reverse(), folders: [] })
    expect(b).toEqual(a)
  })
})

describe('accepted moves', () => {
  const projects = ['p1', 'p2', 'p3']
  const moveTo = (projectId: string, folderPath: string) => ({ projectId, docType: 'Bescheid', folderPath })

  it('teach a Dokumentart line in projects where no document sits in the folder yet', () => {
    const result = extractOfficeConventions({
      documents: [],
      folders: projects.flatMap((id) => folders(id, 'Behörde')),
      moves: projects.map((id) => moveTo(id, 'Behörde')),
    })
    expect(result.filing).toEqual([{ docType: 'Bescheid', path: 'Behörde', projects: 3, of: 3 }])
  })

  it('outweigh where the documents sit: a project that accepted a move votes with its moves', () => {
    const documents = projects.map((id) => doc(id, { folderPath: 'Korrespondenz', docType: 'Bescheid' }))
    const without = extractOfficeConventions({ documents, folders: projects.flatMap((id) => folders(id, 'Korrespondenz', 'Behörde')) })
    expect(without.filing[0]?.path).toBe('Korrespondenz')
    const learned = extractOfficeConventions({
      documents,
      folders: projects.flatMap((id) => folders(id, 'Korrespondenz', 'Behörde')),
      moves: projects.map((id) => moveTo(id, 'Behörde')),
    })
    expect(learned.filing).toEqual([{ docType: 'Bescheid', path: 'Behörde', projects: 3, of: 3 }])
  })

  it('one project that moved many files still counts once', () => {
    const result = extractOfficeConventions({
      documents: [],
      folders: folders('p1', 'Behörde'),
      moves: Array.from({ length: 5 }, () => moveTo('p1', 'Behörde')),
    })
    expect(result.filing).toEqual([])
  })
})
