/**
 * Where a document stands with Piloti, in the one word every surface says.
 *
 * ## Why this exists
 *
 * Ingestion and the content check (ADR-0086) used to speak four languages
 * about the same row. The badge said „In Quarantäne“, the folder brief
 * „zurückgehalten“, CONTEXT.md **Zurückgehalten**; the status filter had no
 * group for a held file at all; the upload summary counted an undeclared status
 * as stored while the brief counted it as being read and the badge said
 * „Unbekannt“. Each surface read `DOCUMENT_STATUS_FACTS` and then decided on
 * its own what to call the result.
 *
 * This module is that decision, made once. A surface that names a document's
 * state (the badge, the upload tally) asks {@link surfaceStateOf} and says
 * {@link surfaceStateLabel}: one word each, „Zitierbar“, „Wird hochgeladen“,
 * „Wird gelesen“, „Zurückgehalten“, „Fehlgeschlagen“, „Abgelegt“, „Unbekannt“.
 * The badge takes its colour from the same state ({@link surfaceStateVariant}),
 * so the colour and the word cannot disagree.
 *
 * Nothing here restates the status vocabulary. A status reaches its state
 * through the badge colour `DOCUMENT_STATUS_FACTS` already declares for it
 * (`variant`), so a new status is one entry there and arrives here on its own.
 * One refinement the colour cannot carry is declared here: `uploading` is in
 * flight like a read, but the bytes are still arriving, and „Wird gelesen“
 * would claim a read that has not started. `surface-state.spec.ts` holds every
 * declared status to one state.
 *
 * The folder brief's families (`DocumentReadFamily`, counted in SQL) stay in
 * `./document-status`; {@link readFamilyOfState} and {@link stateOfReadFamily}
 * translate between the two, and the spec holds them to one answer per status.
 *
 * Pure and client-safe: no database, no server import.
 */

import type { Translator } from '@/i18n/translate'
import {
  documentStatusFacts,
  type DocumentReadFamily,
  type DocumentStatusVariant,
  type KnownDocumentStatus,
} from './document-status'

/**
 * The eight states a reader can tell apart, and acts on differently.
 *
 * - `citable`    — indexed; Piloti can find and cite it („Zitierbar“).
 * - `uploading`  — the bytes are still arriving; nothing has been read yet
 *                  („Wird hochgeladen“). Counted with `reading`.
 * - `reading`    — in flight; it will change on its own („Wird gelesen“).
 * - `held`       — the content check stopped it, and a person decides
 *                  („Zurückgehalten“, CONTEXT.md). It waits in the Quarantäne.
 * - `unreadable` — the read went wrong; nothing was decided about its content,
 *                  and a person can read it again („Fehlgeschlagen“).
 * - `stored`     — at rest and deliberately not in the knowledge base: a
 *                  report Piloti wrote, a row stranded at birth („Abgelegt“).
 * - `cancelled`  — a person stopped the read before it finished („Abgebrochen“);
 *                  nothing failed and nothing was indexed. The bytes are here.
 * - `unknown`    — a status nobody declared („Unbekannt“). Drift, not
 *                  vocabulary: `document-status.spec.ts` fails for a writer
 *                  that emits one.
 */
export type SurfaceState =
  | 'citable'
  | 'uploading'
  | 'reading'
  | 'held'
  | 'unreadable'
  | 'stored'
  | 'cancelled'
  | 'unknown'

/** Every state, in the order a reader scans for them: what Piloti has, what moves, what needs a person, the rest. */
export const SURFACE_STATES: readonly SurfaceState[] = [
  'citable',
  'uploading',
  'reading',
  'held',
  'unreadable',
  'stored',
  'cancelled',
  'unknown',
]

/**
 * The badge colour is the state: green is "Piloti can quote this", red "the
 * read broke", amber "a person decides". One table, so the colour and the word
 * cannot disagree.
 */
const STATE_BY_VARIANT: Record<DocumentStatusVariant, SurfaceState> = {
  success: 'citable',
  info: 'reading',
  warning: 'held',
  destructive: 'unreadable',
  secondary: 'stored',
}

/**
 * A status whose state is finer than its colour. `uploading` shares the
 * in-flight colour and the `reading` family with a read, but nothing is being
 * read yet: the browser is still sending the bytes.
 */
const STATE_BY_STATUS: ReadonlyMap<string, SurfaceState> = new Map<KnownDocumentStatus, SurfaceState>([
  ['uploading', 'uploading'],
  // Shares the neutral colour with `stored` but is its own word: a reader
  // needs to tell "somebody stopped this" from "this was filed and never read".
  ['cancelled', 'cancelled'],
])

/**
 * The state of a document, by its status alone. An undeclared status is
 * `unknown`, never `citable`: calling something citable that is not is the
 * error that wastes an afternoon.
 *
 * Not by its stored reason: the SQL that counts and filters by family
 * (`declaredStatusesIn`) cannot read a verdict out of `error_message`, and a
 * surface that could would call a row held while the counts beside it say
 * failed. The reconcile writes a held file as `quarantined`
 * (`failedOrQuarantined`), so the status is enough.
 */
export function surfaceStateOf(status: string | null | undefined): SurfaceState {
  const facts = documentStatusFacts(status)
  if (!facts) return 'unknown'
  return STATE_BY_STATUS.get((status ?? '').toLowerCase()) ?? STATE_BY_VARIANT[facts.variant]
}

/**
 * The badge colour of a state: the inverse of the table above, plus the two
 * states it has no row for. `uploading` is in flight like `reading`, and an
 * undeclared status is neutral rather than green.
 */
const VARIANT_BY_STATE: Record<SurfaceState, DocumentStatusVariant> = {
  citable: 'success',
  uploading: 'info',
  reading: 'info',
  held: 'warning',
  unreadable: 'destructive',
  stored: 'secondary',
  cancelled: 'secondary',
  unknown: 'secondary',
}

/** The colour a state is drawn in. The badge asks this of the state it names, never of the status. */
export function surfaceStateVariant(state: SurfaceState): DocumentStatusVariant {
  return VARIANT_BY_STATE[state]
}

/**
 * The `files` dictionary key for each state's word. The states reuse the
 * badge's `status.*` keys, so the badge, the upload tally and anything else
 * that names a state read one entry. `document-status.spec.ts` checks every
 * key exists in both dictionaries.
 */
export const SURFACE_STATE_LABEL_KEYS: Record<SurfaceState, string> = {
  citable: 'status.ready',
  uploading: 'status.uploading',
  reading: 'status.processing',
  held: 'status.quarantined',
  unreadable: 'status.failed',
  stored: 'status.stored',
  cancelled: 'status.cancelled',
  unknown: 'status.unknown',
}

/** The one word for a state, from a translator bound to the `files` namespace (`useTranslations('files')`). */
export function surfaceStateLabel(state: SurfaceState, t: Translator): string {
  return t(SURFACE_STATE_LABEL_KEYS[state])
}

/**
 * The folder brief's families (`DocumentReadFamily`, which the shelf summary
 * counts in SQL and the level listing filters by) as views of a state.
 *
 * `unknown` and `uploading` fold into `reading`, and this is the one place
 * they do. Postgres counts a status no family declares under `reading`
 * (`readFamilyWhere`, `lib/documents/repository.ts`), and the brief must add up
 * to the same numbers; `uploading` is in flight, which is what the family
 * counts. Every other state is its own family.
 */
const FAMILY_BY_STATE: Record<SurfaceState, DocumentReadFamily> = {
  citable: 'readable',
  uploading: 'reading',
  reading: 'reading',
  held: 'held',
  unreadable: 'failed',
  stored: 'unindexed',
  cancelled: 'unindexed',
  unknown: 'reading',
}

/** The family a state is counted in. */
export function readFamilyOfState(state: SurfaceState): DocumentReadFamily {
  return FAMILY_BY_STATE[state]
}

/**
 * The state a family stands for, for a surface that holds a family and has to
 * say its word (the brief's legend, a slice's title). `reading` answers
 * `reading`: what it also counts are bytes still arriving, and a status nobody
 * declared, which is drift.
 */
const STATE_BY_FAMILY: Record<DocumentReadFamily, SurfaceState> = {
  readable: 'citable',
  reading: 'reading',
  held: 'held',
  failed: 'unreadable',
  unindexed: 'stored',
}

export function stateOfReadFamily(family: DocumentReadFamily): SurfaceState {
  return STATE_BY_FAMILY[family]
}
