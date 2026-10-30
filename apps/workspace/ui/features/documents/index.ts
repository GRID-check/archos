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
// A Skizze takes the room, the review's pieces and its links' targets from
// top-level modules instead (`document-room.ts`, `sketch-review.ts`,
// `sketch-link-target.ts`): through here they put the upload hooks, and with
// them the folder rules and upload screening, below every sketch canvas.
