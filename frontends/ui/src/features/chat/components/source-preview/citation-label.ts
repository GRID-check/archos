import type { CitedDocument } from '../../lib/citations'

/**
 * The project a cited document is resolved in: the other project a
 * cross-project lookup found it in (ADR-0094), else the chat's own. The by-name
 * route still asks the reader's own access to that project.
 */
export const documentProjectId = (doc: CitedDocument, chatProjectId: string | null): string | null =>
  doc.project?.id ?? chatProjectId

/** A chip's label: the document, and the other project it is from when it is from one (ADR-0094). */
export const citationLabel = (doc: CitedDocument): string =>
  doc.project?.name ? `${doc.title} · ${doc.project.name}` : doc.title
