/**
 * Canvas and chat are mirrors (ADR-0128, headless first ADR-0122): what a
 * person or Piloti can do on the review canvas, a reader of the chat can see
 * done, and the other way round. This file is the one list of those
 * capabilities with their two forms. It is the sibling of
 * `agent-api/exposure.config.ts`: that file says who is OFFERED a capability,
 * this one says WHERE it is SHOWN.
 *
 * A form is one of:
 *  - a rendering: the component, card type or Herleitung step kind that shows it;
 *  - `exempt`: one line, a reason a reviewer can disagree with, for a surface
 *    that has no meaning for this capability;
 *  - `gap`: the mirror does not exist yet. It names the slice that closes it.
 *    The spec fails a gap whose card already exists in the generated schema,
 *    so a closed gap cannot stay written down as open.
 *
 * `parity.config.spec.ts` holds the file against the code: every op of
 * `internalAnnotationRequestSchema`, every canvas-related catalog operation and
 * (through the fixture `tests/fixtures/surface-parity.json`, read by
 * `tests/aiq_agent/tools/test_surface_parity.py`) every tool of the canvas
 * group and `look` has an entry. Add a capability to the canvas or the chat:
 * add its entry here.
 */

import type { InternalAnnotationRequest } from '@/lib/annotations/types'

/** A way of showing a capability. At least one field; `component` is a path under `src/`, the spec checks it exists. */
export interface Rendering {
  readonly component?: string
  readonly card?: string
  readonly step?: string
}

/** The surface has no meaning for this capability. */
export interface Exempt {
  readonly exempt: string
}

/** The mirror is not built. `slice` closes it (ADR-0128 plan); `card`/`step` name what it will use. */
export interface Gap {
  readonly gap: {
    readonly slice: string
    readonly reason: string
    readonly card?: string
    readonly step?: string
  }
}

export type SurfaceForm = Rendering | Exempt | Gap

export interface SurfaceCapability {
  /** One line: what a person or Piloti does. */
  readonly summary: string
  /** The tool Piloti does it with, as the model binds it (`canvas__mark`, `look`). */
  readonly tool?: string
  /** The `op` of `internalAnnotationRequestSchema` this capability is. */
  readonly annotationOp?: InternalAnnotationRequest['op']
  /** The catalog or backend operations (exposure.config.ts names) that are this capability on the door. */
  readonly operations?: readonly string[]
  readonly canvas: SurfaceForm
  readonly chat: SurfaceForm
}

const REVIEW = 'features/documents/components/review'
const ACTIVITY_CARD = 'features/grid-cards/components/CanvasActivityCard.tsx'

export const SURFACE_CAPABILITIES = {
  look: {
    summary: 'Look at a page or a box on it, then answer from what was seen',
    tool: 'look',
    annotationOp: 'look',
    operations: ['document-look'],
    canvas: { component: `${REVIEW}/review-page-layer.tsx` },
    // The look card (a thumbnail per place, the reading) and the Herleitung's look row.
    chat: { card: 'look', step: 'look', component: 'features/chat/components/reasoning/LookStepRow.tsx' },
  },
  point: {
    summary: 'Move Piloti’s pointer to a place on a page for everyone in the document',
    tool: 'canvas__point',
    annotationOp: 'point',
    canvas: { component: `${REVIEW}/review-page-layer.tsx` },
    // A `reference` item with the pointer on the document's look card (tools/look/cards.py).
    chat: { card: 'look' },
  },
  highlight: {
    summary: 'Show everyone a labelled box on a page for what the answer refers to',
    tool: 'canvas__highlight',
    annotationOp: 'highlight',
    canvas: { component: `${REVIEW}/review-page-layer.tsx` },
    // A `reference` item with the box and its label on the document's look card (tools/look/cards.py).
    chat: { card: 'look' },
  },
  propose: {
    summary: 'Propose marks a person takes over or dismisses',
    tool: 'canvas__mark',
    annotationOp: 'propose',
    canvas: { component: `${REVIEW}/mark-row.tsx` },
    chat: { card: 'canvas_activity', component: ACTIVITY_CARD },
  },
  createMark: {
    summary: 'Set a mark open, in the person’s name, when they asked for exactly that mark',
    tool: 'canvas__mark',
    annotationOp: 'create',
    operations: ['annotation-create'],
    canvas: { component: `${REVIEW}/composer.tsx` },
    chat: { card: 'canvas_activity', component: ACTIVITY_CARD },
  },
  updateMark: {
    summary: 'Change a mark: status, assignee, due date, kind, text',
    tool: 'canvas__update',
    annotationOp: 'update',
    operations: ['annotation-update'],
    canvas: { component: `${REVIEW}/mark-row.tsx` },
    chat: { card: 'canvas_activity', component: ACTIVITY_CARD },
  },
  deleteMark: {
    summary: 'Delete a mark a person set',
    tool: 'canvas__delete',
    annotationOp: 'delete',
    operations: ['annotation-delete'],
    canvas: { component: `${REVIEW}/mark-row.tsx` },
    chat: { card: 'canvas_activity', component: ACTIVITY_CARD },
  },
  replyToMark: {
    summary: 'Reply in a mark’s thread',
    tool: 'canvas__reply',
    annotationOp: 'reply',
    operations: ['annotation-reply-create'],
    canvas: { component: `${REVIEW}/thread-card.tsx` },
    chat: { card: 'canvas_activity', component: ACTIVITY_CARD },
  },
  editReply: {
    summary: 'Reword or remove a reply',
    operations: ['annotation-reply-update', 'annotation-reply-delete'],
    canvas: { component: `${REVIEW}/thread-card.tsx` },
    chat: { exempt: 'Piloti has no tool to edit a reply: its own reply is final and a person’s is theirs to change' },
  },
  readMarks: {
    summary: 'Read the marks of a document or a project',
    tool: 'canvas__marks',
    annotationOp: 'list',
    operations: ['annotation-list', 'annotation-get', 'project-annotation-list'],
    canvas: { component: `${REVIEW}/review-panel.tsx` },
    chat: { exempt: 'A read whose result is the answer; the marks it quotes are cited as text' },
  },
  exportMarks: {
    summary: 'Export a document’s or a project’s marks as a file',
    operations: ['document-annotations-export', 'project-annotations-export'],
    canvas: { component: `${REVIEW}/review-export-menu.tsx` },
    chat: { exempt: 'A file download for a person; the door offers it to agents, the chat has no card for a file of marks' },
  },
  room: {
    summary: 'See who has the document open, on which page, and what they select',
    tool: 'canvas__room',
    annotationOp: 'room',
    canvas: { component: `${REVIEW}/cursor-chat.tsx` },
    chat: { exempt: 'Who is in a document has no meaning in a conversation; a read whose result is the answer' },
  },
  leave: {
    summary: 'Piloti leaves the document’s room when its turn ends',
    annotationOp: 'leave',
    canvas: { component: `${REVIEW}/review-page-layer.tsx` },
    chat: { exempt: 'The turn harness’s own clean-up, not a capability of the person or of Piloti' },
  },
  compareRevisions: {
    summary: 'Compare two Fassungen of a document: what changed on a page, boxed',
    operations: ['document-revision-compare', 'document-revision-candidates', 'document-revision-link-set'],
    canvas: { component: 'features/documents/components/document-revisions.tsx' },
    // The result of Piloti's comparison is the card: both pages side by side, the changes boxed on each.
    chat: { card: 'revision_compare', component: 'features/grid-cards/components/RevisionCompareCard.tsx' },
  },
  askAboutBox: {
    summary: 'Draw a box on a page and ask about it; Piloti answers in context of that box',
    canvas: { component: 'features/documents/hooks/use-canvas-ask.ts' },
    chat: { component: 'features/chat/lib/canvas-bridge.ts' },
  },
  readSelectedRegion: {
    summary: 'Piloti reads what the person selected or points at when the question says "here"',
    tool: 'canvas__room',
    canvas: { component: `${REVIEW}/document-review.tsx` },
    // The review offers its selection to the chat's own turns (`registerCanvasFocusProvider`); the turn sends it as `focus_region`.
    chat: { component: 'features/documents/lib/review-focus.ts' },
  },
  openAtPlace: {
    summary: 'Open a document at a page, with a region glowing',
    canvas: { component: `${REVIEW}/document-review.tsx` },
    // A look card item, a Herleitung look row and a citation with a region open the viewer at the page with the box glowing.
    chat: { card: 'look', component: 'features/knowledge/components/page-place-button.tsx' },
  },
  showInViewer: {
    summary: 'Take the asker to a place: a page, a passage or a box on it, a Fassung comparison, a model element',
    tool: 'show_in_viewer',
    // The BFF's gate before the asker's page moves (ADR-0142), withheld from every door as screen state.
    operations: ['document-viewer-place-get'],
    // The viewer the action moves: the chat peek, turned to the page with the passage or the boxes marked.
    canvas: { component: 'features/documents/components/file-preview-pane.tsx' },
    // The row under the answer: what moved, „Zurück“, or „Anzeigen“ when it did not.
    chat: { component: 'features/chat/components/ViewerActionRow.tsx' },
  },
} as const satisfies Readonly<Record<string, SurfaceCapability>>

export type SurfaceCapabilityName = keyof typeof SURFACE_CAPABILITIES

/** Catalog and backend operations that are canvas capabilities though their names do not start with `annotation-`. */
export const CANVAS_RELATED_OPERATIONS = [
  'document-look',
  'document-revision-compare',
  'document-revision-candidates',
  'document-revision-link-set',
] as const

/** Whether `name` is a catalog operation of the canvas: a mark, a thread, an export of marks, or a listed one. */
export function isCanvasOperation(name: string): boolean {
  return /^(annotation-|document-annotations-|project-annotation)/.test(name) || (CANVAS_RELATED_OPERATIONS as readonly string[]).includes(name)
}
