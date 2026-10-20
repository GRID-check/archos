/**
 * The Fassung facts of a document, as the UI reads them (CONTEXT.md, „Fassung").
 *
 * A Fassung is one state of a document; a later one replaces an earlier one as
 * the basis. Across different file names the backend stores the link the way a
 * person confirmed it (`superseded_by` / `supersedes`), Piloti's own suggestion
 * (`revision_suggestion`) and what changed against the Fassung it replaces
 * (`change_summary`, `change_basis`). The backend speaks in FILE NAMES, because
 * that is all its index knows; the UI wants documents it can open.
 *
 * Two shapes live here, so that the name never travels to the browser by
 * accident:
 *
 *   - {@link RevisionLinkNames}: what the backend said, parsed defensively
 *     (`parseRevisionLinkNames`). Server-side only; nothing that leaves the BFF
 *     carries it.
 *   - {@link RevisionLinks}: the same facts after every name was resolved to a
 *     document THE READER MAY SEE (`resolveRevisionLinks`). A reference the
 *     reader cannot see (held under ADR-0086, in a folder closed to them under
 *     ADR-0087, archived, deleted) is dropped whole; its name is never part of
 *     the result. A name is a fact about a document (a held upload's name can
 *     say what it is), so "dropped" means the string is gone, not hidden.
 *
 * No server-only import: the features layer imports the types, and the specs
 * run the resolution on plain fixtures.
 */

/**
 * What a suggestion rests on: the title block (Plankopf: the same number, a higher Index or later
 * date), the Index and date in the file name, or Piloti's reading of the content. The wire values
 * of `revision_suggestion.basis`.
 */
export const REVISION_BASES = ['title_block', 'name', 'content'] as const
export type RevisionBasis = (typeof REVISION_BASES)[number]

/** A document the reader can open: its id and the file name it is stored under. */
export interface RevisionRef {
  id: string
  filename: string
}

export interface RevisionLinks {
  /** The newer document that replaces this one (a person confirmed it). */
  supersededBy: RevisionRef | null
  /** The older documents this one replaces. */
  supersedes: RevisionRef[]
  /** Piloti's suggestion that THIS document is a newer Fassung of `of`; nobody has confirmed it. */
  suggestion: { of: RevisionRef; confidence: number; reason: string; basis: RevisionBasis } | null
  /** What changed against the Fassung it replaces; `'previous'` is the earlier upload under this very name. */
  changeSummary: { text: string; basis: RevisionRef | 'previous' } | null
  /**
   * Every older Fassung this document replaces, directly or through another,
   * newest first and only those the reader may open (`revision-links-loader.ts`). What
   * the preview's timeline lists and the listing's count is read from, so a
   * document with five Fassungen is one entry that knows all five.
   */
  history?: RevisionHistoryEntry[]
}

/** One older Fassung in a document's history. */
export interface RevisionHistoryEntry extends RevisionRef {
  /** When it was uploaded (ISO), or null when the row does not say. */
  createdAt: string | null
  /** What changed in it against ITS predecessor, when that predecessor is one the reader may see too. */
  changeSummary: string | null
}

/** How deep a history is walked: a cap, never a design limit (an office keeps a few dozen states at most). */
export const REVISION_MAX_HISTORY = 40

/** A document with nothing to say about its Fassungen; what a client holds after an unlink. */
export const EMPTY_REVISION_LINKS: RevisionLinks = { supersededBy: null, supersedes: [], suggestion: null, changeSummary: null }

/** The bounds of what the backend may hand a card; anything longer is cut, never trusted. */
export const REVISION_MAX_NAME_LENGTH = 255
export const REVISION_MAX_REFS = 20
export const REVISION_MAX_REASON_LENGTH = 400
export const REVISION_MAX_SUMMARY_LENGTH = 2000

/** What the backend said about one file, with file names where the UI will have documents. */
export interface RevisionLinkNames {
  supersededBy: string | null
  supersedes: string[]
  suggestion: { of: string; confidence: number; reason: string; basis: RevisionBasis } | null
  change: { text: string; basis: string | null } | null
}

/** The per-file entry fields {@link parseRevisionLinkNames} reads (top level, beside `topics` and `capture`). */
export interface RawRevisionLinkFields {
  superseded_by?: unknown
  supersedes?: unknown
  revision_suggestion?: unknown
  change_summary?: unknown
  change_basis?: unknown
}

const asName = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= REVISION_MAX_NAME_LENGTH ? value : null

const asText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 ? text.slice(0, max) : null
}

const asConfidence = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null

function parseSuggestion(raw: unknown): RevisionLinkNames['suggestion'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const fields = raw as Record<string, unknown>
  const of = asName(fields.of)
  const confidence = asConfidence(fields.confidence)
  const basis = fields.basis
  if (of === null || confidence === null || (typeof basis !== 'string' || !REVISION_BASES.includes(basis as RevisionBasis))) return null
  return { of, confidence, reason: asText(fields.reason, REVISION_MAX_REASON_LENGTH) ?? '', basis: basis as RevisionBasis }
}

/**
 * Read a backend file entry's Fassung fields, or `null` when nothing usable is
 * left. Junk is dropped field by field: a malformed suggestion does not cost a
 * confirmed link, and a suggestion without a usable name or basis is no
 * suggestion at all.
 */
export function parseRevisionLinkNames(raw: RawRevisionLinkFields): RevisionLinkNames | null {
  const supersedes = Array.isArray(raw.supersedes)
    ? [...new Set(raw.supersedes.map(asName).filter((name): name is string => name !== null))].slice(
        0,
        REVISION_MAX_REFS,
      )
    : []
  const changeText = asText(raw.change_summary, REVISION_MAX_SUMMARY_LENGTH)

  const names: RevisionLinkNames = {
    supersededBy: asName(raw.superseded_by),
    supersedes,
    suggestion: parseSuggestion(raw.revision_suggestion),
    change: changeText === null ? null : { text: changeText, basis: asName(raw.change_basis) },
  }
  const empty =
    names.supersededBy === null && supersedes.length === 0 && names.suggestion === null && names.change === null
  return empty ? null : names
}

/** Every file name `names` refers to other than the document's own: what has to be resolved. */
export function referencedNames(names: RevisionLinkNames, ownName: string): string[] {
  const all = [
    names.supersededBy,
    ...names.supersedes,
    names.suggestion?.of ?? null,
    names.change?.basis ?? null,
  ]
  return [...new Set(all.filter((name): name is string => name !== null && name !== ownName))]
}

/**
 * Turn the backend's names into documents the reader may open.
 *
 * `lookup` answers only for documents the reader may see: same collection,
 * active, screened, in a folder open to them. It answers `null` for everything
 * else, and this function drops what it cannot resolve:
 *
 *   - a link or suggestion to an unresolvable document disappears;
 *   - a change summary against an unresolvable document disappears too. The
 *     sentence says what the other document held, so keeping the text while
 *     hiding the name would still hand over what the reader may not read;
 *   - a reference to the document itself is no link, and as a change basis it
 *     means the earlier upload under this name (`'previous'`).
 */
export function resolveRevisionLinks(
  names: RevisionLinkNames | null,
  ownName: string,
  lookup: (filename: string) => RevisionRef | null,
): RevisionLinks | null {
  if (!names) return null
  const resolve = (filename: string | null): RevisionRef | null =>
    filename === null || filename === ownName ? null : lookup(filename)

  const supersededBy = resolve(names.supersededBy)

  const seen = new Set<string>()
  const supersedes: RevisionRef[] = []
  for (const filename of names.supersedes) {
    const ref = resolve(filename)
    if (ref && !seen.has(ref.id)) {
      seen.add(ref.id)
      supersedes.push(ref)
    }
  }

  const suggestedOf = names.suggestion ? resolve(names.suggestion.of) : null
  const suggestion =
    names.suggestion && suggestedOf
      ? { of: suggestedOf, confidence: names.suggestion.confidence, reason: names.suggestion.reason, basis: names.suggestion.basis }
      : null

  let changeSummary: RevisionLinks['changeSummary'] = null
  if (names.change) {
    const { text, basis } = names.change
    if (basis === null || basis === ownName) {
      changeSummary = { text, basis: 'previous' }
    } else {
      const ref = lookup(basis)
      if (ref) changeSummary = { text, basis: ref }
    }
  }

  if (!supersededBy && supersedes.length === 0 && !suggestion && !changeSummary) return null
  return { supersededBy, supersedes, suggestion, changeSummary }
}

/**
 * The text of `summary` when it was written against the document `olderId`, else
 * null. A change summary says what differs from ONE other document, named by
 * its basis; a notification about another pair must not quote it, because it
 * describes a comparison the recipient was not told about, possibly with a
 * document they may not open. Pure.
 */
export function changeSummaryAgainst(summary: RevisionLinks['changeSummary'], olderId: string): string | null {
  if (!summary || summary.basis === 'previous') return null
  return summary.basis.id === olderId ? summary.text : null
}
