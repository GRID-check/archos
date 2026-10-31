/**
 * Where a Skizze's link leads inside the app (S5, `lib/diagrams/sketch-links.ts`),
 * built from the helpers the target's own surface links with, so a link from a
 * sketch opens exactly what a link from a search hit or an answer opens:
 *
 *   - a document: its shelf's preview at the page (`withDocumentLocus`);
 *   - a model element: the model view with the element selected (`buildModelHref`);
 *   - an Anmerkung: its document's review at that mark (`reviewFilesHref`).
 *
 * It lives with the documents feature because every link here lands on a
 * document's own surface (its preview, its review, the model it is), and that
 * feature already reaches the model view; the editor takes it from the index.
 *
 * A pinned Fassung opens the document's preview at the page: the preview has no
 * address for a Fassung yet, and the link's mark says „Fassung 3“ beside it.
 * Only an `available` link has an address; an unavailable one has none to
 * offer, and says so quietly.
 */

import type { ResolvedSketchLink } from '@/lib/diagrams/sketch-links'
import { buildModelHref, buildOfficeShelfModelHref } from '@/features/bim'
import { withDocumentLocus } from './document-locus'
import { documentFilesHref } from './document-question'
import { reviewFilesHref, setReviewParams } from './open-review'

export type AvailableSketchLink = Extract<ResolvedSketchLink, { state: 'available' }>

const OFFICE_SHELF = '/app/office-shelf'

function shelfDocumentHref(link: AvailableSketchLink): string {
  const { shelf, projectId, documentId } = link.place
  return shelf === 'project' && projectId ? documentFilesHref(projectId, documentId) : `${OFFICE_SHELF}?doc=${encodeURIComponent(documentId)}`
}

/** The in-app address a link opens, or null when it has none for this reader. */
export function sketchLinkHref(link: ResolvedSketchLink): string | null {
  if (link.state !== 'available') return null
  const { place } = link
  if (link.kind === 'ifcElement') {
    const view = { model: link.modelFile, element: link.ref.ifcGlobalId }
    return place.shelf === 'project' && place.projectId ? buildModelHref(place.projectId, view) : buildOfficeShelfModelHref(view)
  }
  if (link.kind === 'annotation') {
    const target = { documentId: place.documentId, annotationId: link.ref.annotationId }
    if (place.shelf === 'project' && place.projectId) return reviewFilesHref(place.projectId, target)
    return `${OFFICE_SHELF}?${setReviewParams(new URLSearchParams(), target, { withDocument: true }).toString()}`
  }
  return withDocumentLocus(shelfDocumentHref(link), { page: link.page ?? null })
}

/**
 * A traced Skizze's way back (S6, slice 1): the review of the document it lies on, opened at its page.
 * The page rides as the preview's `page` (`document-locus.ts`), which the review opens at.
 */
export function pageReviewHref(projectId: string, documentId: string, page: number): string {
  return withDocumentLocus(reviewFilesHref(projectId, { documentId }), { page })
}
