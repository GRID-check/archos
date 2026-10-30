/**
 * The PDF filed beside a Skizze is its rendition, not a second document with a
 * life of its own (ADR-0148, „Consequences"): it is drawn again from the
 * Skizze's current Fassung, it goes no wider than the Skizze, and it takes no
 * Anmerkungen of its own (`lib/annotations/sketch-place.ts` refuses them).
 *
 *   - **Only for the current Fassung.** A save that publishes draws it
 *     (`./sketch-document.ts`); so does a Freigabe that makes a draft current
 *     (`./sketch-promoted.ts`). A save into an open draft does not: the draft is
 *     nobody's current drawing yet.
 *   - **Never wider than the Skizze.** Moving the Skizze moves the PDF with it
 *     (`lib/documents/move-to-folder.ts`). When they sit apart anyway (a move of
 *     the PDF alone, or one made before this rule) and the Skizze's folder is
 *     one some member may not read, the PDF is not drawn again (`confined`):
 *     the new drawing would reach readers the Skizze is kept from (ADR-0087).
 *   - **Published only while its source is current**, checked under the PDF's
 *     lock (`expected.of`), so a slow save never files its older drawing over
 *     a newer save's: the newer save draws its own (`superseded`).
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { markingIsInBytes } from '@/lib/ai-provenance'
import { folderRestrictsReading } from '@/lib/conversations/restricted-egress'
import type { Document } from '@/lib/db/schema/documents'
import { getAccessibleDocument } from '@/lib/documents/access'
import { generatedDocumentMarking } from '@/lib/documents/generated'
import { PublishedVersionMovedError } from '@/lib/documents/published-guard'
import { findDocumentAuthoredByRef } from '@/lib/documents/repository'
import { findProjectInOrg } from '@/lib/projects/repository'
import { publishNextVersion } from './sketch-version'
import { censusSvg, type DiagramSvgViewport, type SvgElement } from './svg'
import { renderDiagramPdf } from './svg-to-pdf'
import type { EmbeddedUnderlay } from './sketch-underlay-svg'

/** What became of the PDF beside a sketch after a save; a score reads it (`sketch-score.ts`). */
export type CompanionPdfOutcome = 'redrawn' | 'none' | 'superseded' | 'confined' | 'failed'

export interface CompanionRedraw {
  session: AuthorizedSession
  /** The Skizze, as the caller read it. */
  sketch: Document
  /** The SVG Fassung the drawing is of; the PDF is published only while it is current. */
  svgVersionId: string
  /** The vector picture, and the page it is traced over (S6), drawn under it from the server's PNG. */
  drawing: { root: SvgElement; viewport: DiagramSvgViewport; underlay?: EmbeddedUnderlay | null }
  /** The two-author line, in the reader's locale (`markingEdited`). */
  marking: string
  title: string
  request?: Request
}

/** The PDF's new Fassung, or `null` with the reason in `outcome`. Never throws. */
export async function redrawCompanionPdf(
  input: CompanionRedraw
): Promise<{ pdf: { documentId: string; versionId: string } | null; outcome: CompanionPdfOutcome }> {
  const { session, sketch } = input
  if (!sketch.projectId || !sketch.authoredByRef) return { pdf: null, outcome: 'none' }
  try {
    const found = await findDocumentAuthoredByRef(sketch.authoredByRef, session.organizationId, sketch.projectId, 'diagram_pdf')
    if (!found) return { pdf: null, outcome: 'none' }
    if (found.folderId !== sketch.folderId && (await folderRestrictsReading(session.organizationId, sketch.projectId, sketch.folderId))) {
      return { pdf: null, outcome: 'confined' }
    }
    const pdfDocument = await getAccessibleDocument(session, found.id, 'write')
    const project = await findProjectInOrg(sketch.projectId, session.organizationId)
    const provenance = generatedDocumentMarking('diagram_pdf', sketch.authoredByRef)
    const bytes = await renderDiagramPdf({
      root: input.drawing.root,
      viewport: input.drawing.viewport,
      underlay: input.drawing.underlay ?? null,
      title: input.title,
      projectName: project?.name ?? '',
      marking: input.marking,
      provenance,
      createdAt: new Date(),
    })
    if (!markingIsInBytes(bytes, provenance)) throw new Error('the sketch PDF does not carry its AI marking')
    const version = await publishNextVersion({
      session,
      document: pdfDocument,
      bytes,
      contentType: 'application/pdf',
      expected: { publishedVersionId: input.svgVersionId, of: sketch.id },
      request: input.request,
    })
    return { pdf: { documentId: pdfDocument.id, versionId: version.id }, outcome: 'redrawn' }
  } catch (error) {
    if (error instanceof PublishedVersionMovedError && error.documentId === sketch.id) return { pdf: null, outcome: 'superseded' }
    console.error('[diagrams] the sketch was saved and its PDF was not', {
      documentId: sketch.id,
      cause: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
      census: censusSvg(input.drawing.root),
    })
    return { pdf: null, outcome: 'failed' }
  }
}
