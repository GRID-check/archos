/**
 * The Herleitung's work list (ADR-0131): the turn's `action` steps as rounds,
 * each call a row with a bar on the round's shared time axis, so calls that ran
 * together visibly overlap.
 *
 * Pure: the stored steps in, rounds and percentages out. The sentence of a row
 * is `work-sentence.ts`; the drawing is `reasoning/WorkList.tsx`.
 *
 * Time. A stored action's start is the step's `timestamp`; its finish is that
 * plus `action.elapsedMs`. A call still running has no finish: its bar runs to
 * the end of the axis, and the round has no duration until every call ended.
 */

import type { StoredAction, StoredThinkingStep } from '@/lib/conversations/message-provenance'
import { lookStepPlace, type LookStepPlace } from './look-steps'
import type { RetrievalRound } from './retrieval-rounds'

/** The narrowest a bar is drawn, as a share of the axis, so an instant call is still seen. */
export const MIN_BAR_PERCENT = 2
/** The width a running bar starts with when it has the axis to itself. */
export const MIN_RUNNING_PERCENT = 12

export interface WorkRow {
  id: string
  action: StoredAction
  /** The call has started and not ended. */
  running: boolean
  /** Epoch ms of the start; null when the stored timestamp is unreadable. */
  startMs: number | null
  /** Epoch ms of the end; null while running or when the call stored no time. */
  endMs: number | null
  /** The bar's left edge and width, in percent of the round's axis. */
  leftPercent: number
  widthPercent: number
  /** The places this call looked at (a `look` row), drawn as thumbnails under it. */
  looks: LookStepPlace[]
}

export interface WorkRound {
  /** The wire's round number; calls that carry none sit in the round before them (the first, at the start). */
  round: number
  /** The reader's number, from 1, in the order the rounds happened. */
  ordinal: number
  rows: WorkRow[]
  /** Looks of the round that no look row of it explains: drawn as the look rows always were. */
  strayLooks: StoredThinkingStep[]
  /** The round's wall time, start of the first call to the end of the last; null while one is running. */
  durationMs: number | null
  running: boolean
}

const startOf = (step: StoredThinkingStep): number | null => {
  const ms = Date.parse(step.timestamp)
  return Number.isFinite(ms) ? ms : null
}

const isRunning = (step: StoredThinkingStep, action: StoredAction): boolean =>
  !step.isComplete && action.status === 'running'

const endOf = (startMs: number | null, action: StoredAction, running: boolean): number | null =>
  startMs === null || running || action.elapsedMs === undefined ? null : startMs + action.elapsedMs

/** Whether a look at `place` is the one this `look` row made. */
const isLookOf = (action: StoredAction, place: LookStepPlace): boolean => {
  if (action.documentId && place.place.document.id)
    return action.documentId === place.place.document.id
  return Boolean(action.target) && action.target === place.place.document.name
}

interface Draft {
  step: StoredThinkingStep
  action: StoredAction
  running: boolean
  startMs: number | null
  endMs: number | null
}

const rowsOf = (
  drafts: Draft[],
  places: LookStepPlace[]
): { rows: WorkRow[]; used: Set<string> } => {
  const timed = drafts.filter((draft) => draft.startMs !== null)
  const origin = timed.length > 0 ? Math.min(...timed.map((draft) => draft.startMs as number)) : 0
  const finished = timed.map((draft) => draft.endMs).filter((end): end is number => end !== null)
  const lastStart =
    timed.length > 0 ? Math.max(...timed.map((draft) => draft.startMs as number)) : origin
  const axisEnd = Math.max(lastStart, ...finished)
  const span = axisEnd - origin
  const used = new Set<string>()
  const rows = drafts.map((draft): WorkRow => {
    const left = draft.startMs === null || span <= 0 ? 0 : ((draft.startMs - origin) / span) * 100
    const minimum = draft.running ? MIN_RUNNING_PERCENT : MIN_BAR_PERCENT
    const raw =
      draft.running || draft.endMs === null || draft.startMs === null
        ? 100 - left
        : span <= 0
          ? 100
          : ((draft.endMs - draft.startMs) / span) * 100
    const leftPercent = Math.min(left, 100 - minimum)
    const widthPercent = Math.min(Math.max(raw, minimum), 100 - leftPercent)
    const looks =
      draft.action.verb === 'look'
        ? places.filter((place) => !used.has(place.id) && isLookOf(draft.action, place))
        : []
    for (const place of looks) used.add(place.id)
    return {
      id: draft.step.id,
      action: draft.action,
      running: draft.running,
      startMs: draft.startMs,
      endMs: draft.endMs,
      leftPercent,
      widthPercent,
      looks,
    }
  })
  return { rows, used }
}

/** The turn's action rows grouped by round, with each round's time axis; empty when the turn has no actions. */
export function workRounds(steps: readonly StoredThinkingStep[]): WorkRound[] {
  const byRound = new Map<number, { drafts: Draft[]; looks: StoredThinkingStep[] }>()
  const slot = (round: number) => {
    const known = byRound.get(round)
    if (known) return known
    const created = { drafts: [], looks: [] }
    byRound.set(round, created)
    return created
  }
  let current = 0
  for (const step of steps) {
    if (step.scope === 'deep') continue
    if (step.round !== undefined && (step.kind === 'action' || step.kind === 'look'))
      current = step.round
    if (step.kind === 'look') {
      slot(current).looks.push(step)
      continue
    }
    if (step.kind !== 'action' || !step.action) continue
    const running = isRunning(step, step.action)
    const startMs = startOf(step)
    slot(current).drafts.push({
      step,
      action: step.action,
      running,
      startMs,
      endMs: endOf(startMs, step.action, running),
    })
  }

  const rounds: WorkRound[] = []
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const { drafts, looks } = byRound.get(round)!
    if (drafts.length === 0) continue
    drafts.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0))
    const places = looks.flatMap((step) => lookStepPlace(step) ?? [])
    const { rows, used } = rowsOf(drafts, places)
    const running = rows.some((row) => row.running)
    const starts = rows.flatMap((row) => (row.startMs === null ? [] : [row.startMs]))
    const ends = rows.flatMap((row) => (row.endMs === null ? [] : [row.endMs]))
    const timed = !running && starts.length > 0 && ends.length > 0
    rounds.push({
      round,
      ordinal: rounds.length + 1,
      rows,
      strayLooks: looks.filter((step) => !used.has(step.id)),
      durationMs: timed ? Math.max(...ends) - Math.min(...starts) : null,
      running,
    })
  }
  return rounds
}

/** The ids of the looks the rounds draw themselves: what the bare look rows must not repeat. */
export const placedLookIds = (rounds: readonly WorkRound[]): Set<string> =>
  new Set(
    rounds.flatMap((round) => [
      ...round.rows.flatMap((row) => row.looks.map((look) => look.id)),
      ...round.strayLooks.map((step) => step.id),
    ])
  )

/**
 * The retrieval rounds plus a bare one for each round an action ran in that no
 * `retrieval` step opened (a call outside the model's search loop), in order,
 * so every call has a round node to sit in.
 */
export function withActionRounds(
  rounds: readonly RetrievalRound[],
  steps: readonly StoredThinkingStep[]
): RetrievalRound[] {
  const known = new Set(rounds.map((round) => round.index))
  const extra = new Map<number, RetrievalRound>()
  for (const round of workRounds(steps)) {
    if (known.has(round.round)) continue
    extra.set(round.round, { index: round.round, key: 'action', tools: [], sourceNames: [] })
  }
  return extra.size === 0 ? [...rounds] : [...rounds, ...extra.values()].sort((a, b) => a.index - b.index)
}

/** Whether a turn drew any action: the work list replaces the bare look rows only then. */
export const hasActions = (steps: readonly StoredThinkingStep[]): boolean =>
  steps.some((step) => step.kind === 'action' && step.action && step.scope !== 'deep')

/** „2,4 s“; under a tenth of a second „< 0,1 s“; a minute or more „1:05 min“. */
export function formatWorkDuration(ms: number, locale: string): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60)
    const rest = Math.round(seconds - minutes * 60)
    return `${minutes}:${String(rest).padStart(2, '0')} min`
  }
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
  return seconds < 0.05 ? `< ${number.format(0.1)} s` : `${number.format(seconds)} s`
}
