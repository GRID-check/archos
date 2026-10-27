import { describe, expect, it } from 'vitest'
import { de, en } from '@/i18n/dictionaries'
import { createTranslator } from '@/i18n/translate'
import type { UploadReport } from '@/lib/upload-batches/upload-report'
import { uploadReportCopy, uploadReportFindingsHref } from './upload-report-copy'

const tDe = createTranslator(de, 'dossier')
const tEn = createTranslator(en, 'dossier')

const report: UploadReport = {
  projectId: 'proj-hubergasse',
  documents: 12,
  read: 12,
  byType: [
    { type: 'submission_drawing', count: 7 },
    { type: 'permit', count: 1 },
    { type: 'fire_safety_concept', count: 1 },
    { type: 'building_description', count: 1 },
    { type: 'photo', count: 2 },
  ],
  facts: 5,
  factSamples: [{ key: 'building_class', value: 'GK 4', unit: null }],
  newFindings: 3,
  findings: [
    { kind: 'missing_document', key: 'soil_report', label: null, documents: 3 },
    { kind: 'profile_contradiction', key: 'building_class', label: null, documents: 1 },
    { kind: 'missing_plan', key: 'EP-07', label: 'EP-07', documents: 1 },
  ],
  resolvedFindings: 1,
  unresolvedReferences: 2,
  pagesNotRead: 3,
  documentsNotFullyRead: 1,
}

describe('uploadReportCopy', () => {
  it('says in German what the upload brought', () => {
    expect(uploadReportCopy(tDe, report)).toEqual({
      read: '12 Dokumente gelesen: 7 Einreichpläne, 1 Bescheid, 1 Brandschutzkonzept, +3 weitere',
      findings:
        '3 neue Befunde: Bodengutachten fehlt (verwiesen in 3 Dokumenten), Gebäudeklasse weicht vom Steckbrief ab, +1 weitere',
      details: [
        '5 Angaben',
        '2 Verweise ohne Dokument im Projekt',
        '3 Seiten nicht vollständig gelesen',
        '1 Befund erledigt',
      ],
    })
  })

  it('says it in English too', () => {
    const copy = uploadReportCopy(tEn, { ...report, newFindings: 1, findings: [report.findings[2]] })
    expect(copy.read).toBe('12 documents read: 7 submission drawings, 1 permit, 1 fire safety concept, +3 more')
    expect(copy.findings).toBe('1 new finding: Drawing number EP-07 missing')
  })

  it('leaves out what is zero', () => {
    const quiet: UploadReport = {
      ...report,
      byType: [],
      newFindings: 0,
      findings: [],
      facts: 0,
      resolvedFindings: 0,
      unresolvedReferences: 0,
      pagesNotRead: 0,
      read: 1,
    }
    expect(uploadReportCopy(tDe, quiet)).toEqual({ read: '1 Dokument gelesen', findings: null, details: [] })
  })

  it('links to the project’s findings panel', () => {
    expect(uploadReportFindingsHref(report, 'document-findings')).toBe('/app/projects/proj-hubergasse/files#document-findings')
  })
})
