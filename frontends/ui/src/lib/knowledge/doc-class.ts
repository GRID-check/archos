/**
 * Frontend Dokumentart (doc_class) mirror — the closed vocabulary of base-corpus
 * document classes the platform owner assigns from the base-knowledge admin UI.
 *
 * SINGLE SOURCE OF TRUTH: the canonical vocabulary lives in the Python backend
 * (`src/aiq_agent/knowledge/document_classification.py` — `DOCUMENT_CLASSES`,
 * `DOCUMENT_CLASS_LABELS`, `DOCUMENT_CLASS_LANES`, `DEFAULT_DOC_CLASS`), which the
 * doc-class edit endpoint validates every write against. This file is a
 * hand-kept TypeScript mirror used only to render the editor's dropdown + badge.
 * A parity test (`doc-class.spec.ts`) reads the Python file and fails if the key
 * list here ever drifts — so the backend stays authoritative and a stale copy is
 * caught in CI (an out-of-vocabulary value the UI might send is still rejected
 * 400 server-side).
 *
 * Keep the ORDER identical to the Python `DOCUMENT_CLASSES` tuple.
 *
 * The badge color + authority tag are derived through the shared source-kind
 * taxonomy (`source-kinds.ts`) so the Dokumentart badge in this admin panel is
 * tinted and tagged identically to the citation chips the same document renders
 * as elsewhere in the app: every base class is in the `law` (Baurecht) family,
 * and carries the OIB / RIS / ÖNORM rung of the authority ladder.
 */

import type { SourceSignal } from '@/features/layout/lib/source-presets'
import { authorityTag, kindForLane, KIND_TO_SIGNAL } from '@/features/chat/lib/source-kinds'

/** Ordered, immutable key list — mirrors backend `DOCUMENT_CLASSES`. */
export const DOC_CLASSES = [
  'oib_guideline',
  'oib_guide',
  'oib_explanatory_note',
  'oib_definitions',
  'oib_reference',
  'oib_amendment',
  'external_standard',
  'law',
  'other',
] as const

export type DocClass = (typeof DOC_CLASSES)[number]

/**
 * doc_class key → German label (mirrors backend `DOCUMENT_CLASS_LABELS`).
 *
 * The backend's vocabulary, held here for the parity test only. The UI renders
 * the translated `platform.knowledge.docClasses.*` through `useDocClassLabel`
 * (`features/platform/components/knowledge-atoms.tsx`); the German dictionary
 * entries equal these, which `base-knowledge.spec.tsx` pins.
 */
export const DOC_CLASS_LABELS: Record<DocClass, string> = {
  oib_guideline: 'OIB-Richtlinie (verbindlich)',
  oib_guide: 'OIB-Leitfaden',
  oib_explanatory_note: 'OIB-Erläuterung',
  oib_definitions: 'OIB-Begriffsbestimmungen',
  oib_reference: 'OIB-Referenzdokument',
  oib_amendment: 'OIB-Änderungsdokument',
  external_standard: 'Norm (ÖNORM u.a.)',
  law: 'Gesetz / Bauordnung',
  other: 'Sonstiges Basisdokument',
}

/** Neutral base class assigned when nothing else is known (mirrors backend). */
export const DEFAULT_DOC_CLASS: DocClass = 'other'

/**
 * doc_class key → fine lane key (mirrors backend `DOCUMENT_CLASS_LANES`). Fed to
 * the source-kind helpers so the badge's tint + authority tag match the chips.
 */
const DOC_CLASS_LANES: Record<DocClass, string> = {
  oib_guideline: 'building_law_oib',
  oib_guide: 'building_law_oib_guide',
  oib_explanatory_note: 'building_law_oib_explanatory_note',
  oib_definitions: 'building_law_oib_definitions',
  oib_reference: 'building_law_oib_reference',
  oib_amendment: 'building_law_oib_amendment',
  external_standard: 'external_standard',
  law: 'building_law_ris',
  other: 'building_law_base',
}

/**
 * The keys as they were stored before the English names, old to current (mirrors
 * `LEGACY_DOC_CLASSES` in `document_classification.py`; `doc-class.spec.ts` pins the
 * two). A Python pod that has not rolled yet still answers with one. Remove after one
 * release.
 */
export const LEGACY_DOC_CLASSES: Readonly<Record<string, DocClass>> = {
  oib_richtlinie: 'oib_guideline',
  oib_leitfaden: 'oib_guide',
  oib_erlaeuterung: 'oib_explanatory_note',
  oib_begriffe: 'oib_definitions',
  oib_referenz: 'oib_reference',
  oib_aenderung: 'oib_amendment',
  norm_extern: 'external_standard',
  gesetz: 'law',
  sonstiges: 'other',
}

/** Narrow an untrusted wire value to a known DocClass (current or legacy), else undefined. */
export const asDocClass = (value: string | null | undefined): DocClass | undefined => {
  if (!value) return undefined
  const current = LEGACY_DOC_CLASSES[value] ?? value
  return (DOC_CLASSES as readonly string[]).includes(current) ? (current as DocClass) : undefined
}

/** Resolve a (possibly null/unknown) doc_class to a real class for display. */
export const resolveDocClass = (value: string | null | undefined): DocClass =>
  asDocClass(value) ?? DEFAULT_DOC_CLASS

/**
 * The decided Dokumentart worth offering: a known class that differs from the
 * one the document has. Undefined when there is nothing to offer.
 */
export const suggestedDocClass = (file: {
  docClass: string | null
  docClassSuggestion: string | null
}): DocClass | undefined => {
  const suggestion = asDocClass(file.docClassSuggestion)
  return suggestion && suggestion !== resolveDocClass(file.docClass) ? suggestion : undefined
}

/**
 * The `--source-*` tint family for a doc_class. All base classes resolve to the
 * `law` (Baurecht) family so they read as authoritative building law, matching
 * the citation chips.
 */
export const docClassSignal = (docClass: string | null | undefined): SourceSignal =>
  KIND_TO_SIGNAL[kindForLane(DOC_CLASS_LANES[resolveDocClass(docClass)])]

/**
 * Compact authority tag (OIB / RIS / ÖNORM) for a doc_class, derived from its
 * lane via the same `authorityTag` the chips use — so the badge matches. Returns
 * null only if a lane carried no authority tier (does not happen for the base
 * vocabulary, but the fallback keeps the contract honest).
 */
export const docClassAuthority = (
  docClass: string | null | undefined
): 'OIB' | 'RIS' | 'ÖNORM' | null => {
  const tag = authorityTag(DOC_CLASS_LANES[resolveDocClass(docClass)])
  return tag === 'OIB' || tag === 'RIS' || tag === 'ÖNORM' ? tag : null
}

/** Whether a doc_class is one of the binding official OIB base laws (`oib_*`). */
export const isOibBinding = (docClass: string | null | undefined): boolean =>
  resolveDocClass(docClass).startsWith('oib_')
