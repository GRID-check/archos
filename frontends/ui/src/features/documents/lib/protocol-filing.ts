/**
 * „Im Projekt ablegen" for the Protokoll: the export the menu downloads, filed
 * as a document of the project instead, through the door every person's file
 * goes through. A document's Protokoll (the Prüfansicht) and a project's
 * (Offene Punkte) alike: the caller names its export link.
 *
 * Two existing doors, composed in the browser, and no third one (ADR-0055):
 * the export (`GET /api/documents/{id}/annotations/export` or
 * `GET /api/projects/{id}/annotations/export`, the same bytes the download
 * saves) and the project's upload (`POST /api/documents/upload`,
 * `uploadDocument`), with the person's own session, rights, folder rules,
 * screening, quota and audit. Not the chat draft card's door
 * (`POST /api/conversations/{id}/draft/file`): that one files a text Piloti
 * wrote in a conversation's working directory through
 * `fileGeneratedDocument`, which stamps the bytes as machine-written. A
 * Protokoll is the person's record of the office's marks; it is theirs.
 *
 * The file goes into the folder of the document it is about: a Protokoll of a
 * document in a restricted folder quotes what only that folder's readers may
 * read, and the root would hand it to everyone. A project's Protokoll goes
 * into the root, and is offered only while nothing it quotes sits where not
 * every member may read (`restricted` on the Offene Punkte list).
 *
 * The name is the office's day, not the reader's locale's date: two filings on
 * the same day carry the same name, and the upload door makes the second a new
 * Fassung of the first (ADR-0054's same-name re-upload); the same bytes again
 * are `unchanged` and write nothing.
 */

import { isNameTakenBody } from '@/lib/documents/name-taken'
import { splitDocumentName } from '@/lib/documents/display-name'
import { protocolFileNameOf, safeFileStem, type AnnotationExportFormat } from '@/lib/annotations/export-request'
import { calendarDayIn, OFFICE_TIME_ZONE } from '@/lib/format'

/** Where the Protokoll is filed: the project, and the folder (the document's, or null for the root). */
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

/**
 * „Protokoll – Grundriss EG – 2026-10-18": the name the dictionary gives
 * (`template`, with `{name}` and `{date}`), `name` (a document's without its
 * extension, a project's as it is), and the office's day as `YYYY-MM-DD`,
 * which sorts.
 */
export function protocolFilingStem(
  template: (values: { name: string; date: string }) => string,
  name: string,
  now: Date = new Date()
): string {
  return safeFileStem(template({ name, date: calendarDayIn(OFFICE_TIME_ZONE, now) }))
}

/** A document's name as a Protokoll filed about it carries it: without its extension. */
export const documentStem = (documentName: string): string => splitDocumentName(documentName).stem

/** The export's link in a format: the menu's other choices are the caller's. */
export type ProtocolExportHref = (format: AnnotationExportFormat) => string

/**
 * The export to file: a PDF, the record that previews in Dateien and is read
 * like any other file; Word when the Protokoll is too long to lay out as a PDF
 * (the export's 422), so a long review is filed rather than refused.
 */
async function exportFor(href: ProtocolExportHref) {
  const first = await fetch(href('pdf'))
  if (first.status !== 422) return { response: first, format: 'pdf' as const }
  return { response: await fetch(href('docx')), format: 'docx' as const }
}

/** Export the Protokoll (`href`, with the menu's choices) and file it into the project. */
export async function fileProtocol(
  href: ProtocolExportHref,
  target: ProtocolFilingTarget,
  stem: string
): Promise<FiledProtocol> {
  const { response: exported, format } = await exportFor(href)
  if (!exported.ok) throw new ProtocolFilingError('export')
  const blob = await exported.blob()
  const filename = protocolFileNameOf(stem, format)
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
