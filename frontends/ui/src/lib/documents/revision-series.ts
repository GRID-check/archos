/**
 * Revision series: which documents exist in several Fassungen, and which one
 * is current — read from the names offices give their files.
 *
 * feld72 (Jour fixe, 2026-10-09) asked for "eine Logik wie bei Planfred": read
 * index and date, treat only the newest Fassung as the basis, the older ones
 * only on request — and only ever as a SUGGESTION a person confirms. Offices
 * name every revision explicitly and never overwrite one, so the names carry
 * it: `EG_Grundriss_Index_C_2026-08-14.pdf`, `A-101_C_Grundriss EG.pdf`,
 * `260814_Schnitt_AA_idx-B.pdf`. This module reads that, and nothing here
 * changes, hides or re-files a document: it says which one looks current.
 *
 * Naming: a name says nothing about WHAT a file is, so nothing here calls a
 * file a plan (CONTEXT.md, „Fassung"). A Grundriss is a Grundriss because a
 * tag says so, never because its name carries an index.
 *
 * The SAME grammar runs for the agent in Python
 * (`sources/knowledge_layer/src/revision_series.py`), and both are held to one set
 * of cases (`tests/fixtures/revision_series_cases.json`), so the folder brief and
 * the agent's `list_files` cannot disagree about which Fassung is current.
 *
 * Lives in `lib/` because both sides of the BFF read it: the folder brief in the
 * browser, and the upload's Fassung probe (`fassung-candidates.ts`) on the server.
 *
 * Pure: no React, no I/O.
 */

import { documentNameKey } from './name-match'

export interface RevisionIndex {
  kind: 'letter' | 'number'
  /** `C`, `12` — as it should be shown (letters upper-cased, numbers without leading zeros). */
  value: string
  /** Comparable within one kind: A=1 … Z=26, numbers as themselves. */
  rank: number
}

export interface RevisionName {
  /** What the Fassungen of one document share: the name without its index, its date and its extension. */
  key: string
  index: RevisionIndex | null
  /** ISO `YYYY-MM-DD`. */
  date: string | null
}

const SEP = '[ _.\\-]'
/** `Index C`, `idx-B`, `index_a`, `Rev. 12`, `Rev02`, `v3`, `Version 2`. */
const KEYWORD_INDEX = new RegExp(
  `(^|${SEP})(?:index|idx|ind|rev|revision|ver|version|v)\\.?${SEP}?([a-z]|\\d{1,3})(?=$|${SEP})`,
  'i'
)
/** A bare letter right after a leading sheet number, before more name: `A-101_C_Grundriss`. Case-sensitive. */
const SHEET_NUMBER_LETTER = /^([A-Za-z]{1,3}[-_ ]?\d{2,4})[ _.-]([A-Z])(?=[ _.-]\S)/
/** `2026-08-14`, `2026_08_14`, `20260814`, optionally after `Stand`. */
const ISO_DATE = new RegExp(
  `(^|${SEP})(?:stand${SEP}*)?(20\\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\\d|3[01])(?=$|${SEP})`,
  'i'
)
/** `14.08.2026`, optionally after `Stand`. */
const DOTTED_DATE = new RegExp(`(^|${SEP})(?:stand${SEP}*)?(0[1-9]|[12]\\d|3[01])\\.(0[1-9]|1[0-2])\\.(20\\d{2})(?=$|${SEP})`, 'i')
/** `260814_…` or `…_260814` — six digits only at either end, where offices put a date. */
const SHORT_DATE_START = /^(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?=[ _.-])/
const SHORT_DATE_END = new RegExp(`${SEP}(\\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])$`)

function splitExtension(filename: string): { stem: string; extension: string } {
  const match = /^(.*)\.([a-z0-9]{1,5})$/i.exec(filename.trim())
  return match ? { stem: match[1], extension: match[2].toLowerCase() } : { stem: filename.trim(), extension: '' }
}

function indexOf(raw: string): RevisionIndex {
  if (/^\d+$/.test(raw)) {
    const number = Number.parseInt(raw, 10)
    return { kind: 'number', value: String(number), rank: number }
  }
  const letter = raw.toUpperCase()
  return { kind: 'letter', value: letter, rank: letter.charCodeAt(0) - 64 }
}

/** The series key: what is left once index and date are cut out, folded and with one space between words. */
function seriesKey(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[\s_.]+/g, ' ')
    .replace(/\s*-\s*(?=\s|$)/g, ' ')
    .replace(/(^|\s)-\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * What a file name says about its revision, or null when it names neither an
 * index nor a date — then it is not part of a series.
 */
export function parseRevisionName(filename: string): RevisionName | null {
  let { stem } = splitExtension(filename)
  let index: RevisionIndex | null = null
  let date: string | null = null

  const cut = (match: RegExpExecArray, keepLead: boolean) => {
    const lead = keepLead ? (match[1] ?? '') : ''
    stem = stem.slice(0, match.index) + lead + ' ' + stem.slice(match.index + match[0].length)
  }

  let match = ISO_DATE.exec(stem)
  if (match) {
    date = `${match[2]}-${match[3]}-${match[4]}`
    cut(match, true)
  } else if ((match = DOTTED_DATE.exec(stem))) {
    date = `${match[4]}-${match[3]}-${match[2]}`
    cut(match, true)
  } else if ((match = SHORT_DATE_START.exec(stem))) {
    date = `20${match[1]}-${match[2]}-${match[3]}`
    cut(match, false)
  } else if ((match = SHORT_DATE_END.exec(stem))) {
    date = `20${match[1]}-${match[2]}-${match[3]}`
    cut(match, false)
  }

  if ((match = KEYWORD_INDEX.exec(stem))) {
    index = indexOf(match[2])
    cut(match, true)
  } else if ((match = SHEET_NUMBER_LETTER.exec(stem))) {
    index = indexOf(match[2])
    stem = match[1] + ' ' + stem.slice(match[0].length)
  }

  if (!index && !date) return null
  const key = seriesKey(stem)
  return key ? { key, index, date } : null
}

export interface RevisionSeriesMember<T> {
  item: T
  revision: RevisionName
}

export interface RevisionSeries<T> {
  /** The series key plus the format, so a PDF and a DWG of one Fassung are not versions of each other. */
  key: string
  /** The revision that looks current: Piloti's suggestion, never a decision. */
  current: RevisionSeriesMember<T>
  /** The others, newest first. */
  older: RevisionSeriesMember<T>[]
}

/**
 * The order revisions of ONE series are compared in, as a tuple — so it is a
 * total order whatever mix of names a series holds. A comparator that let the
 * index decide between some pairs and the date between others was cyclic (an
 * indexed revision older by date than an undated one, itself older than the
 * next index), and the "current" one then depended on the sort algorithm.
 *
 * When every revision carries an index of the same kind, the index decides,
 * then the date, then arrival — an office that numbers its revisions means the
 * number. Otherwise the date decides, then the index, then arrival.
 */
export function newestFirst<T extends { createdAt?: string | null }>(members: RevisionSeriesMember<T>[]): RevisionSeriesMember<T>[] {
  const kinds = new Set(members.map((member) => member.revision.index?.kind ?? 'none'))
  const indexLeads = kinds.size === 1 && !kinds.has('none')
  const tuple = (member: RevisionSeriesMember<T>): [number, string, number, string] => [
    indexLeads ? (member.revision.index?.rank ?? 0) : 0,
    member.revision.date ?? '',
    member.revision.index?.rank ?? 0,
    member.item.createdAt ?? '',
  ]
  return [...members].sort((a, b) => {
    const ta = tuple(a)
    const tb = tuple(b)
    for (let i = 0; i < ta.length; i += 1) {
      if (ta[i] !== tb[i]) return ta[i] < tb[i] ? 1 : -1
    }
    return 0
  })
}

function signature(revision: RevisionName): string {
  return `${revision.index?.kind ?? ''}:${revision.index?.value ?? ''}:${revision.date ?? ''}`
}

/**
 * The documents that exist in more than one Fassung, each with its current one.
 *
 * A series needs at least two DIFFERENT revisions: one Fassung uploaded twice
 * is a duplicate, which the upload already handles, not a version history.
 * Grouped over the whole set handed in (callers pass one shelf's documents),
 * because an older Fassung is often moved into an `alt/` folder.
 */
export function findRevisionSeries<T extends { filename: string; createdAt?: string | null }>(
  items: readonly T[]
): RevisionSeries<T>[] {
  const groups = new Map<string, RevisionSeriesMember<T>[]>()
  for (const item of items) {
    const revision = parseRevisionName(item.filename)
    if (!revision) continue
    const key = `${revision.key}.${splitExtension(item.filename).extension}`
    const bucket = groups.get(key)
    if (bucket) bucket.push({ item, revision })
    else groups.set(key, [{ item, revision }])
  }
  const series: RevisionSeries<T>[] = []
  for (const [key, members] of groups) {
    if (new Set(members.map((member) => signature(member.revision))).size < 2) continue
    const ordered = newestFirst(members)
    series.push({ key, current: ordered[0], older: ordered.slice(1) })
  }
  // Code-point order, not locale order: the Python twin sorts the same way.
  return series.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** How a revision reads to a person: „Index C · 14.08.2026", „v3", „Stand 02.09.2026". */
export function revisionLabel(revision: RevisionName): string {
  const parts: string[] = []
  if (revision.index) parts.push(revision.index.kind === 'letter' ? `Index ${revision.index.value}` : `v${revision.index.value}`)
  if (revision.date) {
    const [year, month, day] = revision.date.split('-')
    parts.push(`${day}.${month}.${year}`)
  }
  return parts.join(' · ')
}

/** The key a series is grouped by: the series key plus the format. */
export function revisionSeriesKeyOf(filename: string): string | null {
  const revision = parseRevisionName(filename)
  return revision ? `${revision.key}.${splitExtension(filename).extension}` : null
}

/** What a dropped file continues: the current documents of its series, and whether it is clearly their successor. */
export interface FassungCandidate<T> {
  /**
   * The current (not yet replaced) documents of the series, newest first, each
   * with how its own name reads: „Index B · 02.07.2026", or '' when only the
   * series says so. At most {@link FASSUNG_MAX_CANDIDATES}.
   */
  candidates: Array<{ item: T; label: string }>
  /** The dropped file is NEWER than the newest of them by the series' order. */
  newer: boolean
  /**
   * Whether a person need not be asked twice: exactly ONE current document of
   * the series is on the shelf and the dropped file is newer than it. With
   * several (two Fassungen nobody ever linked) the file may belong behind any
   * of them; a file that is not newer is not a successor at all. Both are
   * offered unticked, for the person to settle.
   */
  unambiguous: boolean
}

/** Candidates one dropped file lists: a series has a handful of current documents, never dozens. */
export const FASSUNG_MAX_CANDIDATES = 5

/**
 * Which documents a dropped file may be the next Fassung of, if any.
 *
 * `current` is the documents of the shelf that are NOT already replaced by a
 * person's link: a Fassung that has a successor is not what a new file
 * continues. They are matched by series key and format (`findRevisionSeries`'s
 * grouping). "Newer" is the same total order the series uses ({@link newestFirst}),
 * where the dropped file arrives last: an equal revision (the same Index and
 * date) is a duplicate, never a successor. A name the shelf already holds is a
 * new VERSION of that document (ADR-0054), not a Fassung, and has no candidate.
 */
export function findFassungCandidate<T extends { filename: string; createdAt?: string | null }>(
  droppedName: string,
  current: readonly T[]
): FassungCandidate<T> | null {
  const dropped = parseRevisionName(droppedName)
  const key = revisionSeriesKeyOf(droppedName)
  if (!dropped || !key) return null
  const droppedKey = documentNameKey(droppedName)
  const members: RevisionSeriesMember<T>[] = []
  for (const item of current) {
    if (documentNameKey(item.filename) === droppedKey) return null
    const revision = parseRevisionName(item.filename)
    if (revision && revisionSeriesKeyOf(item.filename) === key) members.push({ item, revision })
  }
  if (members.length === 0) return null
  const ordered = newestFirst(members)
  const newest = ordered[0]
  // The dropped file arrives after everything on the shelf, so a tie on index and date goes to it.
  const arrival: RevisionSeriesMember<{ filename: string; createdAt: string }> = {
    item: { filename: droppedName, createdAt: '\uffff' },
    revision: dropped,
  }
  const ranked = newestFirst<{ filename: string; createdAt?: string | null }>([...members, arrival])
  const newer = ranked[0] === arrival && signature(newest.revision) !== signature(dropped)
  return {
    candidates: ordered
      .slice(0, FASSUNG_MAX_CANDIDATES)
      .map((member) => ({ item: member.item, label: revisionLabel(member.revision) })),
    newer,
    unambiguous: newer && members.length === 1,
  }
}
