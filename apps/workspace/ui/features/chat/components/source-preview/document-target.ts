/** The resolved citation targets a preview opens, and the pure rules about them. */

import { isOfficeRenditionSource } from '@/lib/documents/preview-types'
import type { CitationLocus, CitationTarget, CitedDocument } from '../../lib/citations'

export type DocumentTarget = Extract<CitationTarget, { kind: 'document' }>
export type DownloadTarget = Extract<CitationTarget, { kind: 'download' }>
export type RisTarget = Extract<CitationTarget, { kind: 'ris' }>

export type InfoTarget = Extract<CitationTarget, { kind: 'info' }>

/**
 * An image opens in the same dialog as a PDF but on a different path — it is
 * navigated to by `next/image` at its presigned URL, where a PDF is fetched and
 * parsed. One predicate, because the open path and the render path disagreeing
 * about it is a viewer that presigns a URL nothing then loads.
 */
export const isImageTarget = (target: DocumentTarget): boolean =>
  target.document.type === 'stored' &&
  (target.document.contentType ?? '').toLowerCase().startsWith('image/')

/**
 * Whether the viewer will show a PDF the BFF rendered from this document rather
 * than the document itself (ADR-0070). Decided by the same predicate the BFF
 * uses to decide what to serve, so the header's "PDF-Vorschau" note is never
 * shown over a file's own bytes, nor missing over a rendition.
 */
export const isRenditionTarget = (target: DocumentTarget): boolean =>
  target.document.type === 'stored' && isOfficeRenditionSource(target.document)

/**
 * The same stored document, as the file it is. What an office citation turns
 * into when its rendition cannot be had, and what the viewer's "download the
 * original" action hands over — always the ORIGINAL, through the download
 * route, never the PDF on screen.
 */
export const asDownloadTarget = (target: DocumentTarget): DownloadTarget | null =>
  target.document.type === 'stored'
    ? {
        kind: 'download',
        title: target.title,
        fileName: target.document.filename,
        snippet: target.snippet,
        document: target.document,
      }
    : null

/**
 * The preview route's two answers that mean "there is no PDF of this office
 * file", as opposed to "something broke": 415 when conversion is switched off
 * (`GOTENBERG_URL` unset) and 502 `RENDITION_FAILED` when LibreOffice could not
 * make one. Both leave the reader exactly where #623 left them before ADR-0070
 * — a real file with no viewer — so both get that answer, the download.
 */
export const isRenditionUnavailable = (status: number): boolean => status === 415 || status === 502

/**
 * How long an office open may take before the reader is told a PDF is being
 * made. A rendition already in the store answers in well under this; a first
 * open converts, which can take many seconds, and a busy chip alone does not
 * say why nothing is happening.
 */
export const RENDITION_PENDING_NOTICE_MS = 400

/**
 * The Fundstellen a viewer can actually be pointed at: the ones that name a
 * page, in page order.
 *
 * Page order, not retrieval order — this is a way through the DOCUMENT, and a
 * contents list that jumps 18 → 5 → 22 is a list of hits. Shared with the
 * dialog because "does the rail carry the passage" decides whether the dialog
 * also draws it above the document, and two copies of that answer would drift
 * into showing it twice or not at all.
 */
export const navigableLoci = (doc: CitedDocument): CitationLocus[] =>
  doc.loci.filter((locus) => typeof locus.page === 'number').sort((a, b) => a.page! - b.page!)

/** Placeholder while a target has not resolved — never rendered. */
export const EMPTY_DOCUMENT_TARGET: DocumentTarget = {
  kind: 'document',
  title: '',
  fileName: '',
  document: { type: 'base', fileName: '' },
}
