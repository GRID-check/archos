/**
 * The title-block facts (Plankopf) a drawing carries, as the UI reads them.
 *
 * Read off the sheet during ingestion and stored per document; the backend
 * sends them snake_case on the collection listing as `revision_facts`. Declared
 * here, beside the other document wire types, so the BFF's reconciliation
 * (`reconcile-status.ts`) and the features layer (`FileItem`) import one shape.
 * {@link parseRevisionFacts} is the only place that maps it to camelCase and
 * decides what is junk.
 */

export interface RevisionFacts {
  /** The drawing number (Plannummer). Same number, same document. */
  documentNumber?: string
  /** The revision index (Index), as the sheet writes it. */
  revision?: string
  /** The revision date as ISO `YYYY-MM-DD`. */
  revisionDate?: string
  /** The scale as the sheet writes it (Maßstab). */
  scale?: string
  /** The sheet's own title (Planinhalt). */
  title?: string
  /** The 1-based page of the file the facts were read from. */
  page?: number
}

/** A text fact longer than this is not a title-block fact; it is a paragraph. */
const MAX_TEXT_LENGTH = 80
/** A sheet in a file this long is not one the title block was read from. */
const MAX_PAGE = 2000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const boundedText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim().slice(0, MAX_TEXT_LENGTH)
  return text.length > 0 ? text : undefined
}

const usablePage = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PAGE

/**
 * Read a backend `revision_facts` object into a {@link RevisionFacts}, or
 * `null` when nothing usable is left. Junk is dropped field by field: a bad
 * date does not cost the drawing number, and a fact the sheet did not show is
 * simply absent.
 */
export function parseRevisionFacts(raw: unknown): RevisionFacts | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const fields = raw as Record<string, unknown>

  const facts: RevisionFacts = {}
  const documentNumber = boundedText(fields.document_number)
  if (documentNumber) facts.documentNumber = documentNumber
  const revision = boundedText(fields.revision)
  if (revision) facts.revision = revision
  if (typeof fields.revision_date === 'string' && ISO_DATE.test(fields.revision_date)) {
    facts.revisionDate = fields.revision_date
  }
  const scale = boundedText(fields.scale)
  if (scale) facts.scale = scale
  const title = boundedText(fields.title)
  if (title) facts.title = title
  if (usablePage(fields.page)) facts.page = fields.page

  return Object.keys(facts).length > 0 ? facts : null
}
