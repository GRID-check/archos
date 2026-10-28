/**
 * @vitest-environment node
 */
import { Workbook } from 'exceljs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./document-search', () => ({ listSearchDocumentsForExport: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/i18n/server', () => ({ getLocale: vi.fn().mockResolvedValue('de') }))

import { dossierCopy } from '@/i18n/namespaces/dossier'
import { searchExportCopy } from '@/i18n/namespaces/search-export'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { listSearchDocumentsForExport } from './document-search'
import { exportPlanList, renderPlanListCsv, renderPlanListWorkbook } from './plan-list-export'
import type { DocumentHit } from './search-wire'

const hit = (overrides: Partial<DocumentHit> = {}): DocumentHit => ({
  kind: 'document',
  id: 'd1',
  name: 'EP-03 Grundriss EG.pdf',
  filename: 'EP-03 Grundriss EG.pdf',
  shelf: 'project',
  projectId: 'p1',
  projectName: 'Hubergasse 14',
  folderId: null,
  folderName: 'Grundrisse',
  folderPath: '03 Einreichung/Grundrisse',
  status: 'completed',
  contentType: 'application/pdf',
  uploadedAt: '2026-10-20T08:00:00.000Z',
  uploadedBy: 'Lena Huber',
  documentType: 'submission_drawing',
  title: 'Grundriss Erdgeschoss',
  planNumber: 'EP-03',
  planIndex: 'C',
  planDate: '2025-03-14',
  scale: '1:100',
  documentDate: '2025-03-12',
  pageCount: 1,
  pagesNotRead: 0,
  superseded: false,
  changedFacts: [],
  municipality: 'Wien',
  author: 'Atelier Lindner ZT GmbH',
  matchedOn: [],
  passage: null,
  ...overrides,
})

const de = { dossier: dossierCopy.messages.de, searchExport: searchExportCopy.messages.de }

beforeEach(() => vi.clearAllMocks())

describe('renderPlanListCsv', () => {
  it('writes a German-locale CSV: BOM, German headers, semicolons, the register in order', () => {
    const csv = renderPlanListCsv([hit(), hit({ id: 'd2', planNumber: 'EP-04', superseded: true, shelf: 'office_shelf', projectName: null })], de)
    const [header, first, second] = csv.replace('\uFEFF', '').split('\r\n')
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(header.split(';').slice(0, 4)).toEqual(['"Plannummer"', '"Index"', '"Planstand"', '"Maßstab"'])
    expect(first).toContain('"Einreichplan"')
    expect(first).toContain('"Hubergasse 14"')
    expect(first).toContain('"03 Einreichung/Grundrisse"')
    expect(first).toContain('"ja"')
    expect(second).toContain('"Büroablage"')
    expect(second).toContain('"nein"')
  })

  it('defuses a cell that a spreadsheet would run as a formula', () => {
    const csv = renderPlanListCsv([hit({ name: '=HYPERLINK("x")' })], de)
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
  })
})

describe('renderPlanListWorkbook', () => {
  it('writes one sheet with the header row and one row per document', async () => {
    const bytes = await renderPlanListWorkbook([hit()], de)
    const workbook = new Workbook()
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer)
    const sheet = workbook.getWorksheet('Planliste')
    expect(sheet?.getRow(1).getCell(1).value).toBe('Plannummer')
    expect(sheet?.getRow(2).getCell(1).value).toBe('EP-03')
    expect(sheet?.rowCount).toBe(2)
  })
})

describe('exportPlanList', () => {
  it('names the file by the day, and records counts and the scope kind only', async () => {
    vi.mocked(listSearchDocumentsForExport).mockResolvedValue({ scope: { kind: 'office' }, hits: [hit()] })
    const session = { organizationId: 'org_1', userId: 'user_1', email: 'lena@example.at' } as AuthorizedSession

    const file = await exportPlanList(session, {}, { text: 'Grundriss' }, 'csv', undefined, new Date('2026-10-27T09:00:00Z'))

    expect(file.filename).toBe('Planliste 2026-10-27.csv')
    expect(file.mediaType).toContain('text/csv')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'search.plan_list.exported',
        metadata: { format: 'csv', scope: 'office', documentCount: 1, filtered: false, text: true },
      })
    )
  })
})
