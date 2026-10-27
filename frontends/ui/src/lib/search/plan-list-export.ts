/**
 * The current search result as a Planliste: the file an office prints for the
 * Jour fixe and sends with a Planlieferung (`POST /api/search/export`).
 *
 * It is a view of what Piloti read, not a list somebody maintains: the rows are
 * exactly the documents {@link listSearchDocumentsForExport} finds for this
 * reader, in the search's order, and the columns are the register's. CSV for
 * a spreadsheet in a German locale (semicolon, UTF-8 with a BOM, every cell
 * through `csvCell`, which defuses a cell that would open as a formula); XLSX
 * with a header row, a filter and frozen panes.
 *
 * Nothing here calls a model. Each export is the audit event
 * `search.plan_list.exported`, with counts and the scope's kind only.
 */

import 'server-only'
import { Workbook } from 'exceljs'
import { getDictionary } from '@/i18n/dictionaries'
import type { Dictionary } from '@/i18n/dictionaries'
import { getLocale } from '@/i18n/server'
import { interpolate } from '@/i18n/translate'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { csvCell } from '@/lib/text/csv-cell'
import { listSearchDocumentsForExport } from './document-search'
import type { DocumentHit, SearchBody, SearchScopeQuery } from './search-wire'

/** The most documents one Planliste carries. */
export const PLAN_LIST_MAX_ROWS = 5000

export const PLAN_LIST_FORMATS = ['csv', 'xlsx'] as const
export type PlanListFormat = (typeof PLAN_LIST_FORMATS)[number]

type ColumnKey = keyof Dictionary['searchExport']['columns']
type Cell = string | number | null

/** The register's columns, in the order a Planliste reads. */
const COLUMNS: ReadonlyArray<{ key: ColumnKey; value: (hit: DocumentHit, dictionary: Dictionary) => Cell; width: number }> = [
  { key: 'planNumber', value: (hit) => hit.planNumber, width: 14 },
  { key: 'planIndex', value: (hit) => hit.planIndex, width: 8 },
  { key: 'planDate', value: (hit) => hit.planDate, width: 12 },
  { key: 'scale', value: (hit) => hit.scale, width: 10 },
  { key: 'name', value: (hit) => hit.name, width: 40 },
  { key: 'title', value: (hit) => hit.title, width: 36 },
  {
    key: 'documentType',
    value: (hit, dictionary) =>
      hit.documentType ? ((dictionary.dossier.documentTypes as Record<string, string>)[hit.documentType] ?? hit.documentType) : null,
    width: 22,
  },
  { key: 'project', value: (hit, dictionary) => hit.projectName ?? (hit.shelf === 'office_shelf' ? dictionary.searchExport.officeShelf : null), width: 24 },
  { key: 'folder', value: (hit) => hit.folderName, width: 20 },
  { key: 'documentDate', value: (hit) => hit.documentDate, width: 12 },
  { key: 'uploadedAt', value: (hit) => hit.uploadedAt.slice(0, 10), width: 12 },
  { key: 'uploadedBy', value: (hit) => hit.uploadedBy, width: 20 },
  { key: 'pages', value: (hit) => hit.pageCount, width: 8 },
  { key: 'current', value: (hit, dictionary) => (hit.superseded ? dictionary.searchExport.no : dictionary.searchExport.yes), width: 10 },
  { key: 'status', value: (hit) => hit.status, width: 12 },
]

/** The rows as a German-locale CSV: header of the column names, `;` between cells, CRLF. Pure. */
export function renderPlanListCsv(hits: readonly DocumentHit[], dictionary: Dictionary): string {
  const header = COLUMNS.map((column) => csvCell(dictionary.searchExport.columns[column.key])).join(';')
  const lines = hits.map((hit) => COLUMNS.map((column) => csvCell(column.value(hit, dictionary) ?? '')).join(';'))
  return `﻿${[header, ...lines].join('\r\n')}\r\n`
}

/** The rows as a workbook with one sheet. */
export async function renderPlanListWorkbook(hits: readonly DocumentHit[], dictionary: Dictionary): Promise<Uint8Array> {
  const workbook = new Workbook()
  const sheet = workbook.addWorksheet(dictionary.searchExport.sheet, { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = COLUMNS.map((column) => ({ header: dictionary.searchExport.columns[column.key], key: column.key, width: column.width }))
  for (const hit of hits) {
    sheet.addRow(Object.fromEntries(COLUMNS.map((column) => [column.key, column.value(hit, dictionary)])))
  }
  sheet.getRow(1).font = { bold: true }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } }
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

export interface ExportedPlanList {
  filename: string
  mediaType: string
  bytes: Uint8Array
}

/** The Planliste of a search, for `session`, in `format`. */
export async function exportPlanList(
  session: AuthorizedSession,
  scopeQuery: SearchScopeQuery,
  body: SearchBody,
  format: PlanListFormat,
  request?: Request,
  now: Date = new Date()
): Promise<ExportedPlanList> {
  const { scope, hits } = await listSearchDocumentsForExport(session, scopeQuery, body, PLAN_LIST_MAX_ROWS)
  const dictionary = getDictionary(await getLocale())
  const bytes =
    format === 'csv'
      ? new TextEncoder().encode(renderPlanListCsv(hits, dictionary))
      : await renderPlanListWorkbook(hits, dictionary)
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'search.plan_list.exported',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: { format, scope: scope.kind, documentCount: hits.length, filtered: Boolean(body.filters), text: Boolean(body.text) },
    request,
  })
  return {
    filename: `${interpolate(dictionary.searchExport.fileName, { date: now.toISOString().slice(0, 10) })}.${format}`,
    mediaType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes,
  }
}
