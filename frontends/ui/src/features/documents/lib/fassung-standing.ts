/**
 * Where a document stands, as data: what the header of „Fassungen und Freigabe"
 * says in its one line, whether it shows the approval track, who acts next, and
 * which Fassung Piloti answers from.
 *
 * ## The header describes the newest Fassung, and only it
 *
 * The section used to say „In Prüfung" in its header while a row below, an
 * older published Fassung, said „aktuell". Both were true and together they
 * read as a contradiction. The rule now: the header is about the newest Fassung
 * of this document. When Piloti still answers from an older one, the header
 * says exactly that, in one sentence that names it by number
 * ({@link AnswerBasis} `older`).
 *
 * ## An upload with no approval flow is not „Veröffentlicht"
 *
 * A person's upload is born published (ADR-0054) and never went through a
 * review ({@link bornPublished}). Calling it „Veröffentlicht" with a green
 * track asserts an act nobody took, so such a Fassung has no state word and no
 * track: the header says only that Piloti answers from it. A Fassung a newer
 * document has replaced has no track either, whatever its own chain reached.
 *
 * No React, no I/O, no copy: the component turns this into words.
 */

import type { DocumentReadFamily } from '@/lib/documents/document-status'
import type { DocumentVersionView } from '@/lib/documents/lifecycle-types'
import {
  availableLifecycleGestures,
  lifecycleProgress,
  type DocumentBadgeState,
  type DocumentLifecycleViewer,
  type LifecycleProgress,
} from './document-lifecycle'
import { bornPublished, ownNewestRow, type TimelineRow } from './fassung-timeline'

/** The act that moves the newest Fassung on, named the way the track names its stages. */
export type NextStepKind = 'submit' | 'approve' | 'revise' | 'publish'

export interface NextStep {
  kind: NextStepKind
  /** Who is expected to take it, as user ids. Empty when nobody in particular is. */
  people: readonly string[]
  /** The reader is the one expected to take it: „Ihre Freigabe". */
  you: boolean
}

/** Which Fassung Piloti answers from, said from the header's point of view. */
export type AnswerBasis =
  /** The newest Fassung itself. */
  | { kind: 'this' }
  /**
   * An older Fassung of this document: still published while the newest waits
   * or was refused, or standing in while the newest is read or after its
   * reading failed.
   */
  | { kind: 'older'; number: number }
  /** A newer document that replaced this one. */
  | { kind: 'newer'; number: number }
  /** Nothing yet: the newest waits, and no published Fassung stands behind it. */
  | { kind: 'notYet' }
  /** Nothing yet: the newest is published and still being read, and nothing stands in. */
  | { kind: 'notYetRead' }
  /**
   * Nothing: the newest was refused, or could not be read (or was held, or is
   * deliberately not read), and nothing stands in.
   */
  | { kind: 'never' }
  /** The document was retired: Piloti cites none of it. */
  | { kind: 'retired' }

export interface FassungStanding {
  /** „Fassung {number}": the header's subject. `null` only when there are no rows at all. */
  number: number | null
  /** The state word beside it, or `null` for a Fassung that never had an approval flow. */
  state: DocumentBadgeState | null
  /** The approval track, or `null` where there is no flow to show. */
  progress: LifecycleProgress | null
  /** Which stage name the track sets in ink: the last stage the Fassung reached. */
  stage: number | null
  nextStep: NextStep | null
  answer: AnswerBasis
}

export interface StandingInput {
  rows: readonly TimelineRow[]
  /** The newest upload under this name; `null` when the versions were not read. */
  newest: DocumentVersionView | null
  lifecycle: 'active' | 'archived'
  /** Who the open review round was sent to (`DocumentVersionListResponse.reviewerUserIds`). */
  reviewerUserIds?: readonly string[]
  viewer?: DocumentLifecycleViewer
  /** The reading of the current bytes (`documentReadFamily(file.status)`); the rows were built with the same. */
  newestRead?: DocumentReadFamily
}

/** The states a review walks through, which the track can show honestly. */
const WALKED_STATES: ReadonlySet<DocumentVersionView['state']> = new Set([
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'published',
  'rejected',
])

export function fassungStanding({
  rows,
  newest,
  lifecycle,
  reviewerUserIds = [],
  viewer,
  newestRead = 'readable',
}: StandingInput): FassungStanding {
  const own = ownNewestRow(rows)
  const newer = rows.find((row) => row.kind === 'newer') ?? null
  const state = headerState(newest, lifecycle, newer !== null)
  const tracked = newest !== null && state !== null && state !== 'archived' && state !== 'superseded' && WALKED_STATES.has(newest.state)
  const progress = tracked ? lifecycleProgress(newest, lifecycle) : null
  return {
    number: own?.number ?? null,
    state,
    progress,
    stage: progress ? Math.max(0, progress.reached - 1) : null,
    nextStep: state === 'archived' || newer !== null ? null : nextStepOf(newest, lifecycle, reviewerUserIds, viewer),
    answer: answerBasis(rows, newest, lifecycle, newer?.number ?? null, newestRead),
  }
}

function headerState(
  newest: DocumentVersionView | null,
  lifecycle: 'active' | 'archived',
  replaced: boolean,
): DocumentBadgeState | null {
  if (lifecycle === 'archived') return 'archived'
  if (replaced) return 'superseded'
  if (newest === null || bornPublished(newest)) return null
  return newest.state
}

function answerBasis(
  rows: readonly TimelineRow[],
  newest: DocumentVersionView | null,
  lifecycle: 'active' | 'archived',
  newerNumber: number | null,
  read: DocumentReadFamily,
): AnswerBasis {
  if (lifecycle === 'archived') return { kind: 'retired' }
  if (newerNumber !== null) return { kind: 'newer', number: newerNumber }
  // The timeline already moved `current` off a published Fassung nobody has read.
  const live = rows.find((row) => row.kind === 'version' && row.current && !row.newest)
  if (newest === null || newest.state === 'published' || newest.state === 'superseded') {
    if (read === 'readable') return { kind: 'this' }
    if (live) return { kind: 'older', number: live.number }
    return read === 'reading' ? { kind: 'notYetRead' } : { kind: 'never' }
  }
  if (live) return { kind: 'older', number: live.number }
  return newest.state === 'rejected' ? { kind: 'never' } : { kind: 'notYet' }
}

function nextStepOf(
  newest: DocumentVersionView | null,
  lifecycle: 'active' | 'archived',
  reviewerUserIds: readonly string[],
  viewer: DocumentLifecycleViewer | undefined,
): NextStep | null {
  if (newest === null) return null
  const me = viewer?.userId ?? null
  const may = (gesture: 'approve' | 'publish') =>
    viewer !== undefined && availableLifecycleGestures(newest, lifecycle, viewer).includes(gesture)
  switch (newest.state) {
    case 'in_review': {
      // The people the round was sent to. When the round names nobody the
      // reader can see, a reader who may approve is the one it waits for.
      const people = [...reviewerUserIds]
      const you = (me !== null && people.includes(me)) || (people.length === 0 && may('approve'))
      return { kind: 'approve', people: people.filter((id) => id !== me), you }
    }
    case 'changes_requested': {
      const author = newest.submittedBy ?? newest.createdBy
      return { kind: 'revise', people: [author], you: author === me }
    }
    case 'draft':
      return { kind: 'submit', people: [newest.createdBy], you: newest.createdBy === me }
    case 'approved':
      return { kind: 'publish', people: [], you: may('publish') }
    default:
      return null
  }
}

/** A user id, resolved for copy: the reader, a known name, or nobody the pane can name. */
export type Person = { kind: 'you' } | { kind: 'name'; name: string } | { kind: 'unknown' }

/**
 * Who a user id is, from everything the pane knows: the reader first, then the
 * names the listing resolved, then any other source (the assignees, the
 * reviewer candidates). Never the raw id: an identifier is not a name.
 */
export function resolvePerson(
  userId: string | null | undefined,
  viewerUserId: string | null | undefined,
  ...sources: readonly (ReadonlyMap<string, string> | undefined)[]
): Person {
  if (!userId) return { kind: 'unknown' }
  if (viewerUserId && userId === viewerUserId) return { kind: 'you' }
  for (const source of sources) {
    const name = source?.get(userId)?.trim()
    if (name) return { kind: 'name', name }
  }
  return { kind: 'unknown' }
}
