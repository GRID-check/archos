/**
 * What another feature may take from `components/` and `hooks/` here: the
 * upload and drop hooks and the drop zone.
 *
 * The rest of the feature's public surface is its top-level modules, imported
 * by name (`@/features/documents/store`, `/utils`, `/types`): the seam rule
 * (`feature-deep-import`) lets a feature reach those directly. This file used
 * to re-export the whole feature, so a composer that needed one hook pulled
 * the orchestrator, persistence and validation in with it, and every spec that
 * rendered the composer re-ran on a change to any of them
 * (docs/audit/blast-radius-2026-10.md §7.5). Add here only what another
 * feature imports from `components/` or `hooks/`.
 */

export { useFileUpload } from './hooks/use-file-upload'
export { useFileDragDrop } from './hooks/use-file-drag-drop'
export { FileUploadZone } from './components/FileUploadZone'
export {
  useDocumentRoom,
  type DocumentRoom,
  type RoomPeerState,
  type RoomTransport,
} from './hooks/use-document-room'
// The review's own pieces, for a Skizze's marks drawn over its live canvas (`features/diagrams/sketch/sketch-pins.tsx`).
export type { DocumentReview, ReviewDraft } from './hooks/use-document-review'
export { ReviewPageLayer } from './components/review/review-page-layer'
export { DraftCard, ThreadCard } from './components/review/thread-card'
// Where a Skizze's link leads: a document's page, its model's element, an Anmerkung (`features/diagrams/sketch/sketch-links.tsx`).
export { sketchLinkHref, type AvailableSketchLink } from './lib/sketch-link-href'
