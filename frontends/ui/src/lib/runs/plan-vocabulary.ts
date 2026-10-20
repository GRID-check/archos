/**
 * The German spellings the research plan carried before the English names.
 *
 * One table per vocabulary, read-only, mirrored by
 * `src/aiq_agent/common/plan_vocabulary.py`. The plan travels as text (the
 * `plan_json` fence in a stored message), as the edits the plan card sends
 * back (`approve {...}`) and inside a frozen task row; a message stored, a tab
 * left open or a pod not yet rolled from before the rename still holds the old
 * spellings. Nothing writes these: every reader maps them on the way in.
 */

/** `genre` values. */
export const LEGACY_PLAN_GENRE: Readonly<Record<string, string>> = {
  pruefbericht: 'inspection_report',
  aktenvermerk: 'file_note',
  vergleich: 'comparison',
  checkliste: 'checklist',
  bericht: 'report',
}

/** `depth` values. */
export const LEGACY_PLAN_DEPTH: Readonly<Record<string, string>> = {
  kurzpruefung: 'quick_check',
  gutachten: 'expert_report',
}

/** Keys of the plan object, of the `plan_json` fence and of the plan documents. */
export const LEGACY_PLAN_KEYS: Readonly<Record<string, string>> = {
  grundlage: 'basis',
  ausgeschlossen: 'excluded',
  unterlagen: 'documents',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A plan object with the English keys and values, whichever spelling it came
 * in. A key present in both spellings keeps the English one; a non-object is
 * returned as it is.
 */
export function modernizePlan<T>(raw: T): T | Record<string, unknown> {
  if (!isRecord(raw)) return raw
  const out: Record<string, unknown> = { ...raw }
  for (const [old, next] of Object.entries(LEGACY_PLAN_KEYS)) {
    if (!(old in out)) continue
    if (!(next in out)) out[next] = out[old]
    delete out[old]
  }
  if (typeof out.genre === 'string') out.genre = LEGACY_PLAN_GENRE[out.genre] ?? out.genre
  if (typeof out.depth === 'string') out.depth = LEGACY_PLAN_DEPTH[out.depth] ?? out.depth
  return out
}
