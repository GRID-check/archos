/**
 * „Im Projekt ablegen" for the Protokoll: the export the menu downloads, filed
 * as a document of the project instead, through the door every person's file
 * goes through.
 *
 * Two existing doors, composed in the browser, and no third one (ADR-0055):
 * the export (`GET /api/documents/{id}/annotations/export`, the same bytes the
 * download saves) and the project's upload (`POST /api/documents/upload`,
 * `uploadDocument`), with the person's own session, rights, folder rules,
 * screening, quota and audit. Not the chat draft card's door
 * (`POST /api/conversations/{id}/draft/file`): that one files a text Piloti
 * wrote in a conversation's working directory through
 * `fileGeneratedDocument`, which stamps the bytes as machine-written. A
 * Protokoll is the person's record of the office's marks; it is theirs.
 *
 * The file goes into the folder of the document it is about: a Protokoll of a
 * document in a restricted folder quotes what only that folder's readers may
 * read, and the root would hand it to everyone.
 *
 * The name is the office's day, not the reader's locale's date: two filings on
 * the same day carry the same name, and the upload door makes the second a new
 * Fassung of the first (ADR-0054's same-name re-upload); the same bytes again
 * are `unchanged` and write nothing.
 */

import { isNameTakenBody } from '@/lib/documents/name-taken'
import { splitDocumentName } from '@/lib/documents/display-name'
import { annotationExportHref, type AnnotationExportOptions } from '@/lib/annotations/export-request'
import { calendarDayIn, OFFICE_TIME_ZONE } from '@/lib/format'

/** Where the Protokoll is filed: the document's project, and the folder the document sits in. */
export interface ProtocolFilingTarget {
  projectId: string
  folderId: string | null
}

export interface FiledProtocol {
  documentId: string
  filename: string
  /** The same bytes were already the document's: nothing was written. */
  unchanged: boolean
}

/** Why a filing did not happen: the export, a name another document holds, or the upload. */
export class ProtocolFilingError extends Error {
  constructor(readonly reason: 'export' | 'name-taken' | 'upload') {
    super(`Filing the Protokoll failed: ${reason}`)
    this.name = 'ProtocolFilingError'
  }
}

/** Characters no file name on a person's disk may carry, as the export's own name drops them. */
const UNSAFE = /[\\/:*?"<>|\r\n]+/g

/**
 * „Protokoll – Grundriss EG – 2026-10-18": the name the dictionary gives
 * (`template`, with `{name}` and `{date}`), the document's name without its
 * extension, and the office's day as `YYYY-MM-DD`, which sorts.
 */
export function protocolFilingStem(
  template: (values: { name: string; date: string }) => string,
  documentName: string,
  now: Date = new Date()
): string {
  const name = splitDocumentName(documentName).stem
  return template({ name, date: calendarDayIn(OFFICE_TIME_ZONE, now) }).replace(UNSAFE, ' ').trim()
}

const EXTENSION: Record<AnnotationExportOptions['format'], string> = { pdf: 'pdf', docx: 'docx', md: 'md' }

/**
 * The export to file: a PDF, the record that previews in Dateien and is read
 * like any other file; Word when the Protokoll is too long to lay out as a PDF
 * (the export's 422), so a long review is filed rather than refused.
 */
async function exportFor(documentId: string, options: AnnotationExportOptions) {
  const first = await fetch(annotationExportHref(documentId, options))
  if (first.status !== 422 || options.format !== 'pdf') return { response: first, format: options.format }
  const docx = { ...options, format: 'docx' } as const
  return { response: await fetch(annotationExportHref(documentId, docx)), format: docx.format }
}

/** Export the Protokoll with the menu's choices and file it into the project. */
export async function fileProtocol(
  documentId: string,
  target: ProtocolFilingTarget,
  stem: string,
  options: AnnotationExportOptions
): Promise<FiledProtocol> {
  const { response: exported, format } = await exportFor(documentId, options)
  if (!exported.ok) throw new ProtocolFilingError('export')
  const blob = await exported.blob()
  const filename = `${stem}.${EXTENSION[format]}`
  const form = new FormData()
  form.append('file', new File([blob], filename, { type: blob.type || exported.headers.get('content-type') || '' }))
  form.append('projectId', target.projectId)
  if (target.folderId) form.append('folderId', target.folderId)
  const uploaded = await fetch('/api/documents/upload', { method: 'POST', body: form })
  const body: unknown = await uploaded.json().catch(() => null)
  if (!uploaded.ok) throw new ProtocolFilingError(isNameTakenBody(body) ? 'name-taken' : 'upload')
  const { documentId: filedId, unchanged } = (body ?? {}) as { documentId?: unknown; unchanged?: unknown }
  if (typeof filedId !== 'string' || !filedId) throw new ProtocolFilingError('upload')
  return { documentId: filedId, filename, unchanged: unchanged === true }
}
