/**
 * What a Protokoll export of a document's Anmerkungen asks for, and the URL
 * that asks it (`GET /api/documents/{id}/annotations/export`).
 *
 * Its own module, free of `server-only`, so the route parses with the same
 * schema the Prüfansicht's menu builds the link from: one list of formats and
 * scopes, not two that drift.
 */

import { z } from 'zod'

/** PDF to send, Word to edit, Markdown to paste into the office's own minutes. */
export const ANNOTATION_EXPORT_FORMATS = ['pdf', 'docx', 'md'] as const
export type AnnotationExportFormat = (typeof ANNOTATION_EXPORT_FORMATS)[number]

/** `open`: what still asks something of somebody. `all`: closed ones too, as the record. */
export const ANNOTATION_EXPORT_SCOPES = ['open', 'all'] as const
export type AnnotationExportScope = (typeof ANNOTATION_EXPORT_SCOPES)[number]

/**
 * `current`: marks set on the Fassung the document shows now, and every mark
 * still open from an earlier one. `all`: the closed marks of earlier Fassungen
 * too. Open work is never narrowed by Fassung (`selectMarks`).
 */
export const ANNOTATION_EXPORT_REVISIONS = ['current', 'all'] as const
export type AnnotationExportRevision = (typeof ANNOTATION_EXPORT_REVISIONS)[number]

/**
 * The query. Every field has a default, so a bare link exports every open
 * mark as a PDF, those still open from earlier Fassungen included, which is
 * what a Jour fixe needs.
 * `includeProposals=1` adds Piloti's proposals nobody took over, under a
 * heading of their own; they never mix with the office's marks.
 */
export const annotationExportQuerySchema = z
  .object({
    format: z.enum(ANNOTATION_EXPORT_FORMATS).default('pdf'),
    scope: z.enum(ANNOTATION_EXPORT_SCOPES).default('open'),
    revision: z.enum(ANNOTATION_EXPORT_REVISIONS).optional(),
    /** The name before the rename: a link a person saved still works. Remove after one release. */
    fassung: z.enum(ANNOTATION_EXPORT_REVISIONS).optional(),
    includeProposals: z
      .enum(['0', '1'])
      .default('0')
      .transform((value) => value === '1'),
  })
  .transform(({ fassung, revision, ...rest }) => ({ ...rest, revision: revision ?? fassung ?? 'current' }))

export interface AnnotationExportOptions {
  format: AnnotationExportFormat
  scope: AnnotationExportScope
  revision: AnnotationExportRevision
  includeProposals: boolean
}

/** The download link. A GET, so the browser's own download handles the file. */
export function annotationExportHref(documentId: string, options: AnnotationExportOptions): string {
  const query = new URLSearchParams({
    format: options.format,
    scope: options.scope,
    revision: options.revision,
  })
  if (options.includeProposals) query.set('includeProposals', '1')
  return `/api/documents/${encodeURIComponent(documentId)}/annotations/export?${query.toString()}`
}

/** Each format's file extension. */
const EXTENSIONS: Record<AnnotationExportFormat, string> = { pdf: 'pdf', docx: 'docx', md: 'md' }

/** Characters no file name on a person's disk may carry. */
const UNSAFE_IN_FILE_NAME = /[\\/:*?"<>|\r\n]+/g

/** A file name's stem without what a file system refuses, each run of it a space. */
export const safeFileStem = (stem: string): string => stem.replace(UNSAFE_IN_FILE_NAME, ' ').trim()

/**
 * A Protokoll's file name: its {@link safeFileStem} and the format's
 * extension. One rule for the name the export routes send and the name the
 * Prüfansicht files a Protokoll under.
 */
export const protocolFileNameOf = (stem: string, format: AnnotationExportFormat): string =>
  `${safeFileStem(stem)}.${EXTENSIONS[format]}`
