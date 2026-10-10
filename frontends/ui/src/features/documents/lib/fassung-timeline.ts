/**
 * The Fassung timeline of one document, as data: every state it has had, newest
 * first, whether it is an upload under this very name or an older document a
 * person linked under another.
 *
 * ## Two kinds of history, one list
 *
 * A document's history lives in two places. Uploads under the SAME file name are
 * its own versions (ADR-0054, `document_versions`, with a review state each);
 * documents under OTHER names are stored as a confirmed link between two
 * documents (ADR-0097, `FileItem.fassung.history`). A person sees one document
 * with one history, so the two are merged here by date — a rule, not a layout
 * decision, and therefore pure and specced.
 *
 * No React, no I/O. The component decides how a row looks; this decides which
 * rows exist and in which order.
 */

import type { FassungFacts, FassungHistoryEntry, FassungRef } from '@/lib/documents/fassung'
import type { RevisionFacts } from '@/lib/documents/revision-facts'
import type { DocumentVersionState, DocumentVersionView } from '@/lib/documents/lifecycle-types'
import { parseRevisionName } from '@/lib/documents/revision-series'

const isoDay = /^(\d{4})-(\d{2})-(\d{2})/

/**
 * The secondary tag a timeline row carries beside its number: the index the
 * office gave it („Index C"), or, when the name has no index, the date it is
 * stamped with (the caller says „Stand 14.08.2026"). `null` when neither is
 * known: the row is then only its number, and its date is on the act line.
 *
 * The title block is what the drawing says about itself, so it wins over the
 * file name when the reading found anything in it.
 */
export type FassungTag = { kind: 'index'; text: string } | { kind: 'date'; text: string }

export function fassungTag(filename: string, titleBlock?: RevisionFacts | null): FassungTag | null {
  const printed = titleBlock?.revision?.trim()
  if (printed) return { kind: 'index', text: /^index\b/i.test(printed) ? printed : `Index ${printed}` }
  const revision = parseRevisionName(filename)
  if (revision?.index) {
    return { kind: 'index', text: revision.index.kind === 'letter' ? `Index ${revision.index.value}` : `v${revision.index.value}` }
  }
  const date = titleBlock?.revisionDate?.trim() || revision?.date
  if (!date) return null
  const day = isoDay.exec(date)
  return { kind: 'date', text: day ? `${day[3]}.${day[2]}.${day[1]}` : date }
}

/** The model writes bullet lines; a stray marker or blank line is not content. */
export function changeLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-–—•*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
}

/** Whether the facts carry anything to show: an older Fassung, a newer one, a suggestion or a change. */
export function hasLinkedFassungen(facts: FassungFacts | null | undefined): boolean {
  if (!facts) return false
  return (
    facts.supersededBy !== null ||
    facts.supersedes.length > 0 ||
    (facts.history?.length ?? 0) > 0 ||
    facts.suggestion !== null ||
    facts.changeSummary !== null
  )
}

/**
 * Whether the Fassungen section is drawn at all. A reader with review rights
 * always gets it (the state of the document is the subject); everyone else gets
 * it when there is a history to show: older Fassungen under other names, or
 * more than one upload under this one. Decidable from the listing alone, so a
 * pane can leave room for it before anything has loaded.
 */
export function showsFassungenSection(input: {
  facts: FassungFacts | null | undefined
  versionCount: number | null | undefined
  hasViewer: boolean
}): boolean {
  return input.hasViewer || hasLinkedFassungen(input.facts) || (input.versionCount ?? 1) > 1
}

/** A version that still waits for somebody: not yet the basis for answers, and not over. */
const PENDING_STATES: ReadonlySet<DocumentVersionState> = new Set([
  'draft',
  'in_review',
  'changes_requested',
  'approved',
])

export function isPendingVersion(version: Pick<DocumentVersionView, 'state'>): boolean {
  return PENDING_STATES.has(version.state)
}

/** One thing somebody did to a version: the leaf under `files.lifecycle.versions`, who, and when. */
export interface VersionAct {
  key: 'uploaded' | 'submitted' | 'approved' | 'published' | 'changesRequested' | 'rejected'
  /** A WorkOS user id. Resolve it to a word; never print it. */
  actor: string
  when: string
}

/** The persistent milestones, in the order they happen. */
const MILESTONES = [
  { key: 'submitted', by: 'submittedBy', at: 'submittedAt' },
  { key: 'approved', by: 'approvedBy', at: 'approvedAt' },
  { key: 'published', by: 'publishedBy', at: 'publishedAt' },
] as const satisfies readonly {
  key: VersionAct['key']
  by: keyof DocumentVersionView
  at: keyof DocumentVersionView
}[]

/**
 * A refusal's who and when — who sent the version back, and when.
 *
 * `submitted`/`approved`/`published` have columns of their own; a refusal has
 * only the generic review columns (`reviewedBy`/`reviewedAt` beside the
 * comment). Those columns are ALSO stamped by an approval, so the refusal row
 * is gated on the version's state: it renders only on the version the refusal
 * stopped. A later revision clears all three, so a refusal never outlives its
 * subject — and an approval never renders as one.
 */
const REFUSAL_MILESTONES = [
  { state: 'changes_requested', key: 'changesRequested' },
  { state: 'rejected', key: 'rejected' },
] as const satisfies readonly { state: DocumentVersionState; key: VersionAct['key'] }[]

/**
 * A version that arrived as a person's upload and never went through a review:
 * born `published` (ADR-0054), so the row carries `approvedBy`/`publishedBy` =
 * the uploader to satisfy the CHECK, and was never submitted. Those columns are
 * not acts anybody took. Saying „Freigegeben" or „Veröffentlicht" about it
 * would invent an approval flow the document never had.
 */
export function bornPublished(version: Pick<DocumentVersionView, 'state' | 'submittedBy'>): boolean {
  return (version.state === 'published' || version.state === 'superseded') && version.submittedBy === null
}

/**
 * Every act a version reports — the milestones first, then the refusal that
 * stopped it, if one did. A version {@link bornPublished} reports none: its
 * only act is the upload ({@link latestAct}).
 */
export function versionActs(version: DocumentVersionView): VersionAct[] {
  if (bornPublished(version)) return []
  const acts: VersionAct[] = MILESTONES.flatMap(({ key, by, at }) => {
    const actor = version[by]
    const when = version[at]
    return typeof actor === 'string' && typeof when === 'string' ? [{ key, actor, when }] : []
  })
  const refusal = REFUSAL_MILESTONES.find((row) => row.state === version.state)
  if (refusal && version.reviewedBy && version.reviewedAt) {
    acts.push({ key: refusal.key, actor: version.reviewedBy, when: version.reviewedAt })
  }
  return acts
}

/**
 * The act the header names: the latest one, or the upload when nothing has
 * happened to the version since it arrived (a person's upload is born published
 * and carries no milestone of its own).
 */
export function latestAct(version: DocumentVersionView): VersionAct {
  const acts = versionActs(version)
  const latest = acts.reduce<VersionAct | null>(
    (best, act) => (best === null || Date.parse(act.when) >= Date.parse(best.when) ? act : best),
    null,
  )
  return latest ?? { key: 'uploaded', actor: version.createdBy, when: version.createdAt }
}

/** The text of a version that has no bytes of its own to open (`GET …/versions/{id}/content`). */
export const versionContentUrl = (documentId: string, versionId: string): string =>
  `/api/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/content`

/** An upload under this very name, with its review state. */
export interface VersionRow {
  kind: 'version'
  key: string
  at: string
  version: DocumentVersionView
  /** The version with the next lower number: the one a text comparison is against. */
  predecessor: DocumentVersionView | null
  /** The published version: the Fassung answers are given from. */
  current: boolean
  /** The newest version, whatever its state: the one the review controls act on. */
  newest: boolean
  /** „Fassung {number}": its place in the whole timeline, counted from the oldest. */
  number: number
}

/** This document itself, when its versions are not known (not read, or the read failed). */
export interface HeadRow {
  kind: 'head'
  key: string
  at: string | null
  /** Piloti answers from it, unless a newer document has replaced it. */
  current: boolean
  newest: true
  number: number
}

/** An older document under another file name, linked by a person. */
export interface LinkedRow {
  kind: 'linked'
  key: string
  at: string | null
  entry: FassungHistoryEntry
  /** This document replaces it directly, so its link is this document's to take back. */
  direct: boolean
  number: number
}

/**
 * The newer document that replaced this one (ADR-0097). Always the top row: it
 * is the Fassung Piloti answers from, and the one a reader of an older Fassung
 * is most likely to want next.
 */
export interface NewerRow {
  kind: 'newer'
  key: string
  at: null
  ref: FassungRef
  number: number
}

export type TimelineRow = VersionRow | HeadRow | LinkedRow | NewerRow

export interface BuildTimelineInput {
  /** From the lifecycle read, any order. Empty when unread. */
  versions: readonly DocumentVersionView[]
  publishedVersionId: string | null
  /** `FileItem.fassung.history`, or the direct links without dates. */
  history: readonly FassungHistoryEntry[]
  /** Ids of the documents this one replaces directly (`FassungFacts.supersedes`). */
  directIds: ReadonlySet<string>
  /** When this document arrived; the date of the stand-in row when versions are unknown. */
  headAt: string | null
  /** The newer document that replaced this one (`FassungFacts.supersededBy`), if any. */
  newer?: FassungRef | null
}

const time = (value: string | null): number => {
  if (value === null) return Number.NaN
  return Date.parse(value)
}

/**
 * Newest first. A row without a usable date goes last, in the order it came; two
 * rows on the same instant put the upload before the link, and uploads among
 * themselves by number.
 */
function byNewest(a: Unnumbered, b: Unnumbered): number {
  const left = time(a.at)
  const right = time(b.at)
  const leftKnown = !Number.isNaN(left)
  const rightKnown = !Number.isNaN(right)
  if (leftKnown && rightKnown && left !== right) return right - left
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
  if (a.kind === 'version' && b.kind === 'version') return b.version.versionNumber - a.version.versionNumber
  if (a.kind !== 'linked' && b.kind === 'linked') return -1
  if (a.kind === 'linked' && b.kind !== 'linked') return 1
  return 0
}

/**
 * Newest first, numbered from the oldest: „Fassung 3", „Fassung 2", „Fassung 1"
 * across same-name uploads and linked documents alike, because a reader sees
 * one document with one history. The number is a place in THIS list, not the
 * stored `versionNumber`, which counts only the uploads under one name.
 *
 * `current` marks the one Fassung Piloti answers from: the published upload, or
 * the newer document when this one has been replaced (then no row of this
 * document's own is current).
 */
export function buildFassungTimeline(input: BuildTimelineInput): TimelineRow[] {
  const { versions, publishedVersionId, history, directIds, headAt, newer = null } = input
  const replaced = newer !== null
  const byNumber = [...versions].sort((a, b) => b.versionNumber - a.versionNumber)
  const own: Unnumbered[] =
    byNumber.length === 0
      ? [{ kind: 'head', key: 'head', at: headAt, current: !replaced, newest: true }]
      : byNumber.map((version, index) => ({
          kind: 'version',
          key: `version:${version.id}`,
          at: version.createdAt,
          version,
          predecessor: byNumber[index + 1] ?? null,
          current: !replaced && version.id === publishedVersionId,
          newest: index === 0,
        }))
  const linked: Unnumbered[] = history.map((entry) => ({
    kind: 'linked',
    key: `linked:${entry.id}`,
    at: entry.createdAt,
    entry,
    direct: directIds.has(entry.id),
  }))
  const top: Unnumbered[] = newer ? [{ kind: 'newer', key: `newer:${newer.id}`, at: null, ref: newer }] : []
  const ordered = [...top, ...[...own, ...linked].sort(byNewest)]
  return ordered.map((row, index) => ({ ...row, number: ordered.length - index }) as TimelineRow)
}

/** A row before it has its place: `Omit` applied to each member of the union, not to the union. */
type WithoutNumber<Row> = Row extends unknown ? Omit<Row, 'number'> : never
type Unnumbered = WithoutNumber<TimelineRow>

/** The row that stands for the document itself: its newest upload, or the stand-in. */
export function ownNewestRow(rows: readonly TimelineRow[]): VersionRow | HeadRow | null {
  return rows.find((row): row is VersionRow | HeadRow => row.kind === 'head' || (row.kind === 'version' && row.newest)) ?? null
}

/** The display number of an upload under this name, by its version id. */
export function numberOfVersion(rows: readonly TimelineRow[], versionId: string): number | null {
  const row = rows.find((candidate) => candidate.kind === 'version' && candidate.version.id === versionId)
  return row?.number ?? null
}
