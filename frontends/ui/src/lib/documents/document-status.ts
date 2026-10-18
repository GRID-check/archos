/**
 * The document-status vocabulary, declared once, as data.
 *
 * Two sets, and the difference between them is the point:
 *
 *   - {@link DOCUMENT_STATUSES}: the seven values `documents.status` may hold.
 *     Migration 0135 rewrote every legacy spelling to one of them and added a
 *     CHECK (`documents_status_known`), so a writer that emits an eighth fails
 *     its write. `document-status.spec.ts` scans the writers and fails first.
 *   - {@link DOCUMENT_STATUS_FACTS}: every value a SURFACE may be handed, which
 *     is those seven plus the spellings that arrive from outside the column:
 *     the chat's session files keep the backend's file states in the browser
 *     (`uploading`, `ingesting`, `success`, `error`), and the platform corpus
 *     listing reports `ingested`/`ready`. They render as what they mean; none
 *     of them is ever written to `documents.status`.
 *
 * The column used to be open `text`, and three vocabularies disagreed about it:
 * the schema documented `pending → processing → processed | error`, the
 * reconcile wrote `completed` and `failed`, and the badge knew eleven strings.
 * This module once recorded that disagreement without resolving it; 0135
 * resolved it in the database (ADR-0104, rule 8).
 *
 * Two facts per value:
 *
 *   - `variant` — the Badge colour, which is also the FAMILY. Green is not
 *     decoration: it is the product telling the reader "Piloti can quote this",
 *     which is why `isCitableStatus` is exactly the `success` set and
 *     `isFailedStatus` exactly the `destructive` one. The word a surface says
 *     for it is derived from the colour too (`surfaceStateOf`,
 *     `./surface-state`): one word per state, the same on every surface.
 *   - `phase` — whether the row will change on its own. This is the
 *     load-bearing one for `reconcile-status.ts`, which polls the backend for
 *     every in-flight row, and for the workspace, which re-reads the listing
 *     while anything is unsettled.
 */

/**
 * What `documents.status` may hold (migration 0135, CHECK `documents_status_known`).
 * The order is the reading's order; the meanings are in {@link DOCUMENT_STATUS_FACTS}.
 */
export const DOCUMENT_STATUSES = [
  'uploaded',
  'pending',
  'processing',
  'completed',
  'failed',
  'quarantined',
  'stored',
] as const

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

const COLUMN_STATUSES: ReadonlySet<string> = new Set(DOCUMENT_STATUSES)

/** Whether a value is one `documents.status` may hold. */
export function isDocumentStatus(value: string | null | undefined): value is DocumentStatus {
  return value != null && COLUMN_STATUSES.has(value)
}

/**
 * The column's values among `values`: what a SQL filter over `documents.status`
 * needs from a set that also names spellings from outside the column (the
 * in-flight set includes the upload tray's `uploading`).
 */
export function columnStatuses(values: Iterable<string>): DocumentStatus[] {
  return [...values].filter(isDocumentStatus)
}

/** Badge variants the Files chrome uses for a status. */
export type DocumentStatusVariant = 'success' | 'info' | 'destructive' | 'secondary' | 'warning'

/** Whether a status resolves itself, or is where the document has come to rest. */
export type DocumentStatusPhase = 'in-flight' | 'terminal'

export interface DocumentStatusFacts {
  readonly variant: DocumentStatusVariant
  readonly phase: DocumentStatusPhase
}

/**
 * Every status a surface may be handed, and what it means: the seven of
 * {@link DOCUMENT_STATUSES}, and the spellings that arrive from outside the
 * column (marked as such below). Grouped by family, because the family is what
 * a reader acts on.
 */
export const DOCUMENT_STATUS_FACTS = {
  // --- Indexed: Piloti can quote it. --------------------------------------
  /** The column's value, written by `reconcile-status.ts` when the read finishes. */
  completed: { variant: 'success', phase: 'terminal' },
  /** From outside the column: the backend's file state, the platform corpus listing. */
  ready: { variant: 'success', phase: 'terminal' },
  ingested: { variant: 'success', phase: 'terminal' },
  success: { variant: 'success', phase: 'terminal' },
  processed: { variant: 'success', phase: 'terminal' },

  // --- In flight: the row will change on its own, so it gets polled. --------
  pending: { variant: 'info', phase: 'in-flight' },
  processing: { variant: 'info', phase: 'in-flight' },
  /** From outside the column: the upload tray and the chat's session files. */
  uploading: { variant: 'info', phase: 'in-flight' },
  ingesting: { variant: 'info', phase: 'in-flight' },

  // --- Failed: terminal, and the card says why. ----------------------------
  failed: { variant: 'destructive', phase: 'terminal' },
  /** From outside the column: the chat's session files. */
  error: { variant: 'destructive', phase: 'terminal' },

  // --- Neither: the bytes are here and indexing was deliberately skipped. ---
  /**
   * An agent-authored report (migration 0063). Terminal, and NEUTRAL on
   * purpose: it is not a success — the document is not in the knowledge base
   * and never will be — and it is not a failure, because nothing went wrong.
   * A green badge would promise a citation the retrieval path cannot make;
   * a red one would report a fault that did not happen.
   *
   * Its phase is the load-bearing half: `stored` must stay OUT of the
   * in-flight set, or every read polls a backend that has never heard of the
   * job (there is no job — the document was never dispatched to `/v1/ingest`)
   * and the card spins forever on a row that is already at rest.
   */
  stored: { variant: 'secondary', phase: 'terminal' },
  /**
   * Every row's birth status, and nothing else's. The upload path inserts the
   * row as `uploaded` before dispatching, so a listing read in that millisecond
   * window meets it — and rows stranded here by the old dispatch (OK without a
   * job id, status left as-is) still exist in the wild.
   *
   * NEUTRAL on purpose, for the same reason as `stored`: the bytes are here
   * but nothing was ever indexed, so green "Zitierbar" would promise a
   * citation the retrieval path cannot make. It used to sit in the Indexed
   * family above, which is exactly how an unsearchable document wore a green
   * "Ready" forever. Terminal, so nothing polls it: there is no job to ask
   * about. Retry remains possible through the re-ingest action.
   */
  uploaded: { variant: 'secondary', phase: 'terminal' },

  // --- Held back: the bytes are here and a person has to decide. -----------
  /**
   * The content gate matched (ADR-0086): the ingest job read the file's text
   * locally, found something the office's screening names, and stopped before
   * any model saw it. Nothing is indexed. Terminal, so nothing polls it; a
   * reviewer releases it (a re-dispatch with screening skipped for these exact
   * bytes) or deletes it.
   *
   * WARNING, not destructive and not neutral: nothing failed, and nothing is
   * at rest either — it waits on a decision. The reasons are in `errorMessage`
   * as `quarantined:{json}` (`lib/upload-screening/quarantine.ts` reads them).
   */
  quarantined: { variant: 'warning', phase: 'terminal' },
} as const satisfies Record<string, DocumentStatusFacts>

/** The declared vocabulary as a type — `keyof`, so it cannot drift from the data. */
export type KnownDocumentStatus = keyof typeof DOCUMENT_STATUS_FACTS

/**
 * A Map rather than the object itself, because the lookup key comes from the
 * database: `FACTS['constructor']` on a plain object answers with something
 * from `Object.prototype` and every predicate below would then be reading
 * facts off a function.
 */
const FACTS_BY_STATUS: ReadonlyMap<string, DocumentStatusFacts> = new Map(
  Object.entries(DOCUMENT_STATUS_FACTS),
)

/**
 * Every declared status, in declaration order.
 *
 * The cast is the one TypeScript forces: `Object.keys` is typed `string[]`
 * because a JS object may carry more keys than its type declares, which a
 * `const` literal in this file cannot. Narrowing it back to the literal union
 * is sound HERE and nowhere else.
 */
export const KNOWN_DOCUMENT_STATUSES: readonly KnownDocumentStatus[] = Object.keys(
  DOCUMENT_STATUS_FACTS,
) as KnownDocumentStatus[]

/**
 * What is known about a status, or `null` when it was never declared.
 *
 * Case-insensitive because the reading surfaces have always been: the column is
 * written lowercase, and a caller that lower-cases first would otherwise get a
 * different answer from one that does not.
 */
export function documentStatusFacts(status: string | null | undefined): DocumentStatusFacts | null {
  return FACTS_BY_STATUS.get((status ?? '').toLowerCase()) ?? null
}

export function isKnownDocumentStatus(status: string | null | undefined): status is KnownDocumentStatus {
  return documentStatusFacts(status) !== null
}

/**
 * The statuses whose outcome is not yet known — the set `reconcile-status.ts`
 * polls the backend about. Derived, so a new in-flight state is declared once
 * above and reaches the poller without anyone remembering to add it here.
 */
export const IN_FLIGHT_DOCUMENT_STATUSES: ReadonlySet<string> = new Set(
  KNOWN_DOCUMENT_STATUSES.filter((status) => DOCUMENT_STATUS_FACTS[status].phase === 'in-flight'),
)

/**
 * Where a document stands with Piloti, in the five answers a reader acts on —
 * the families of the folder brief and the status filter
 * (`features/documents/lib/folder-knowledge.ts`, `readStateOf`).
 *
 * - `readable`  — indexed; Piloti can find and cite it.
 * - `reading`   — in flight, or a status nobody declared.
 * - `failed`    — the read went wrong; a person can retry it.
 * - `held`      — the content screen stopped it (ADR-0086).
 * - `unindexed` — at rest and deliberately not in the knowledge base.
 *
 * Declared here, beside the vocabulary, because the browser (the brief, the
 * filter) and Postgres (the shelf summary and the level listing's status
 * filter, `lib/documents/repository.ts`) must put a status in the same family.
 */
export type DocumentReadFamily = 'readable' | 'reading' | 'failed' | 'held' | 'unindexed'

export const DOCUMENT_READ_FAMILIES: readonly DocumentReadFamily[] = ['readable', 'reading', 'failed', 'held', 'unindexed']

/** The family is the badge colour: one decision, so the badge and the brief cannot disagree. */
const READ_FAMILY_BY_VARIANT: Record<DocumentStatusVariant, DocumentReadFamily> = {
  success: 'readable',
  info: 'reading',
  destructive: 'failed',
  warning: 'held',
  secondary: 'unindexed',
}

/**
 * The family of a status. An unknown status reads as `reading`, never as
 * `readable`: calling something citable that is not is the error that wastes an
 * afternoon, and a new pipeline state under "being read" until somebody maps it
 * is the harmless direction.
 */
export function documentReadFamily(status: string | null | undefined): DocumentReadFamily {
  const facts = documentStatusFacts(status)
  return facts ? READ_FAMILY_BY_VARIANT[facts.variant] : 'reading'
}

/**
 * The declared statuses of one family, lower-case as the column holds them.
 * `reading` is the declared in-flight set only; the SQL that asks for it also
 * takes every status no family declares (`notInArray` over the other four).
 */
export function declaredStatusesIn(family: DocumentReadFamily): string[] {
  return KNOWN_DOCUMENT_STATUSES.filter(
    (status) => READ_FAMILY_BY_VARIANT[DOCUMENT_STATUS_FACTS[status].variant] === family,
  )
}
