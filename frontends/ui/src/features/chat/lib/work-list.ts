/**
 * The Herleitung's work list (ADR-0132): the turn's `action` steps as rounds,
 * one row per call, inside the round's node of the graph.
 *
 * Pure: the stored steps in, rounds and rows out. The words of a row are
 * `work-sentence.ts`; the drawing is `reasoning/WorkList.tsx`.
 *
 * What a row is NOT any more: a time. Per-call and per-round times, the
 * „3 gleichzeitig“ label and the shared time axis went by the value test (no
 * one checks an answer by its seconds; Langfuse keeps them). What stays is
 * what lets a reader check and reuse: what was looked for, where, what came
 * back, and which source cards it returned (`callIds`).
 *
 * Three shapes keep a busy round readable:
 *  - the decision's prefetch (round 0, `detail.prefetch`) draws no row; its
 *    sources join the first fan like any other;
 *  - three or more settled calls of one kind fold into one row („×7“);
 *  - more than {@link MAX_ROWS} rows show the worst first and fold the rest
 *    into „+N weitere“.
 */

import type { StoredAction, StoredThinkingStep } from '@/lib/conversations/message-provenance'
import { lookStepPlace, type LookStepGroup, type LookStepPlace } from './look-steps'
import type { RetrievalRound } from './retrieval-rounds'
import type { WorkFold } from './work-sentence'

/** A round shows at most this many rows before the rest fold into „+N weitere“. */
export const MAX_ROWS = 5
/** How many rows a round over {@link MAX_ROWS} keeps in view. */
export const KEPT_ROWS = 3
/** Same-kind calls fold into one row from this many on. */
export const FOLD_FROM = 3

export interface WorkRow {
  id: string
  /** The first call the row stands for: its verb, target and status. */
  action: StoredAction
  /** The call has started and not ended. */
  running: boolean
  /** The calls this row stands for, as the wire names them; empty on a row stored before `call_id`. */
  callIds: string[]
  /** Set when same-kind calls are folded into this row. */
  fold?: WorkFold
  /** The places this call looked at (a `look` row), drawn as thumbnails under it. */
  looks: LookStepPlace[]
}

export interface WorkRound {
  /**
   * The wire's round number. A call that carries none sits in the round before
   * it; after the prefetch (which draws no row) it waits for the next round
   * the wire announces, and gets a round of its own when none follows.
   */
  round: number
  /** The rows in view, in the order the calls started, or worst first in a round over {@link MAX_ROWS}. */
  rows: WorkRow[]
  /** The rows folded into „+N weitere“; empty in a round of {@link MAX_ROWS} or fewer. */
  more: WorkRow[]
  /** Looks of the round that no look row of it explains: drawn as the look rows always were. */
  strayLooks: StoredThinkingStep[]
  running: boolean
}

const startOf = (step: StoredThinkingStep): number => {
  const ms = Date.parse(step.timestamp)
  return Number.isFinite(ms) ? ms : 0
}

const isRunning = (step: StoredThinkingStep, action: StoredAction): boolean =>
  !step.isComplete && action.status === 'running'

/** Stored as running and no longer live: the turn ended before the call settled. */
export const isInterrupted = (row: WorkRow): boolean => !row.running && row.action.status === 'running'

/** Whether a look at `place` is the one this `look` row made. */
const isLookOf = (action: StoredAction, place: LookStepPlace): boolean => {
  if (action.documentId && place.place.document.id)
    return action.documentId === place.place.document.id
  return Boolean(action.target) && action.target === place.place.document.name
}

/** The rounds the decision ran before the model's first call: no row of their own. */
export const prefetchRounds = (steps: readonly StoredThinkingStep[]): Set<number> =>
  new Set(
    steps.flatMap((step) =>
      step.kind === 'retrieval' && step.round !== undefined && step.detail?.prefetch === true
        ? [step.round]
        : []
    )
  )

/** How bad a row's outcome is, for „worst first“: failed, then interrupted or empty, then running, then found. */
const severity = (row: WorkRow): number => {
  if (row.running) return 2
  if (row.action.status === 'error') return 0
  return row.action.status === 'empty' || isInterrupted(row) ? 1 : 3
}

const sum = (values: Array<number | undefined>): number | undefined =>
  values.some((value) => value !== undefined)
    ? values.reduce<number>((a, b) => a + (b ?? 0), 0)
    : undefined

/** The key same-kind calls share: verb and match mode, settled with a result. Running, empty and failed rows never fold. */
const foldKey = (row: WorkRow): string | null =>
  row.running || row.action.status !== 'ok' || row.looks.length > 0
    ? null
    : `${row.action.verb}:${row.action.mode ?? ''}`

/** Three or more settled same-kind calls of a round as one row, at the place of the first. */
export function foldRows(rows: readonly WorkRow[]): WorkRow[] {
  const groups = new Map<string, WorkRow[]>()
  for (const row of rows) {
    const key = foldKey(row)
    if (key) groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const out: WorkRow[] = []
  for (const row of rows) {
    const key = foldKey(row)
    const group = key ? groups.get(key) : undefined
    if (!group || group.length < FOLD_FROM) {
      out.push(row)
      continue
    }
    if (group[0] !== row) continue
    const counts = {
      hits: sum(group.map((member) => member.action.counts?.hits)),
      files: sum(group.map((member) => member.action.counts?.files)),
      folders: sum(group.map((member) => member.action.counts?.folders)),
    }
    out.push({
      ...row,
      callIds: group.flatMap((member) => member.callIds),
      fold: {
        count: group.length,
        counts: Object.fromEntries(
          Object.entries(counts).filter(([, value]) => value !== undefined)
        ),
      },
    })
  }
  return out
}

/** A round over {@link MAX_ROWS}: the worst {@link KEPT_ROWS} in view, the rest folded. */
export function limitRows(rows: readonly WorkRow[]): { rows: WorkRow[]; more: WorkRow[] } {
  if (rows.length <= MAX_ROWS) return { rows: [...rows], more: [] }
  const ranked = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => severity(a.row) - severity(b.row) || a.index - b.index)
  return {
    rows: ranked.slice(0, KEPT_ROWS).map(({ row }) => row),
    more: ranked.slice(KEPT_ROWS).map(({ row }) => row),
  }
}

/** The turn's action rows grouped by round; empty when the turn has no actions. The prefetch draws none. */
export function workRounds(steps: readonly StoredThinkingStep[]): WorkRound[] {
  const prefetch = prefetchRounds(steps)
  const byRound = new Map<
    number,
    { rows: Array<{ row: WorkRow; start: number }>; looks: StoredThinkingStep[] }
  >()
  const slot = (round: number) => {
    const known = byRound.get(round)
    if (known) return known
    const created = { rows: [], looks: [] }
    byRound.set(round, created)
    return created
  }
  // Calls without a round met while the current round is the prefetch: they
  // are the model's, not the prefetch's, and wait for the next announced round.
  let pending: StoredThinkingStep[] = []
  const place = (round: number, step: StoredThinkingStep) => {
    if (step.kind === 'look') {
      slot(round).looks.push(step)
      return
    }
    if (!step.action) return
    slot(round).rows.push({
      start: startOf(step),
      row: {
        id: step.id,
        action: step.action,
        running: isRunning(step, step.action),
        callIds: step.callId ? [step.callId] : [],
        looks: [],
      },
    })
  }
  let current = 0
  let latest = 0
  for (const step of steps) {
    if (step.scope === 'deep') continue
    if (step.round !== undefined) latest = Math.max(latest, step.round)
    const call = (step.kind === 'action' && step.action) || step.kind === 'look'
    if (!call) continue
    if (step.round !== undefined) {
      current = step.round
      // Only a call that carries the prefetch round is the prefetch's.
      if (prefetch.has(current)) continue
      for (const waiting of pending) place(current, waiting)
      pending = []
      place(current, step)
      continue
    }
    if (prefetch.has(current)) pending.push(step)
    else place(current, step)
  }
  // No round announced after them: the next one the wire has opened, else one of their own.
  const own = prefetch.has(latest) ? latest + 1 : latest
  for (const waiting of pending) place(own, waiting)

  const rounds: WorkRound[] = []
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const { rows: drafts, looks } = byRound.get(round)!
    if (drafts.length === 0) continue
    const places = looks.flatMap((step) => lookStepPlace(step) ?? [])
    const used = new Set<string>()
    const rows = [...drafts]
      .sort((a, b) => a.start - b.start)
      .map(({ row }) => {
        if (row.action.verb !== 'look') return row
        const mine = places.filter((place) => !used.has(place.id) && isLookOf(row.action, place))
        for (const place of mine) used.add(place.id)
        return { ...row, looks: mine }
      })
    const limited = limitRows(foldRows(rows))
    rounds.push({
      round,
      ...limited,
      strayLooks: looks.filter((step) => !used.has(step.id)),
      running: rows.some((row) => row.running),
    })
  }
  return rounds
}

/**
 * Looks no action row explains (a turn stored before ADR-0132, a look of the
 * prefetch) as the row a `look` call would have drawn: „Betrachtet
 * Grundriss EG.pdf, S. 2, oben rechts“, or the document and how many places.
 */
export function lookGroupRow(group: LookStepGroup): WorkRow {
  const [first] = group.looks
  const { document } = group
  return {
    id: group.key,
    action: {
      verb: 'look',
      status: 'ok',
      target: document.name,
      ...(document.id ? { documentId: document.id } : {}),
      ...(document.shelf === 'base' ? { shelf: 'base' } : {}),
      ...(group.looks.length === 1
        ? { pages: String(first.place.page) }
        : { counts: { hits: group.looks.length } }),
    },
    running: false,
    callIds: [],
    looks: group.looks,
  }
}

/** Every row of a round, in view and folded. */
export const allRows = (round: WorkRound): WorkRow[] => [...round.rows, ...round.more]

/** The ids of the looks the rounds draw themselves: what the bare look rows must not repeat. */
export const placedLookIds = (rounds: readonly WorkRound[]): Set<string> =>
  new Set(
    rounds.flatMap((round) => [
      ...allRows(round).flatMap((row) => row.looks.map((look) => look.id)),
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
  return extra.size === 0
    ? [...rounds]
    : [...rounds, ...extra.values()].sort((a, b) => a.index - b.index)
}

/** Whether a turn drew any action: the work list replaces the bare look rows only then. */
export const hasActions = (steps: readonly StoredThinkingStep[]): boolean =>
  steps.some((step) => step.kind === 'action' && step.action && step.scope !== 'deep')

/**
 * What the reader tapped in the Herleitung: a row or a source card, and the
 * calls it stands for. The other side of the link is whatever shares one of
 * those calls (`call_id`): a row's cards stay bright, a card's rows light up.
 */
export interface LinkSelection {
  /** The row id or the card key that was tapped. */
  key: string
  callIds: readonly string[]
}

/** Whether something standing for `callIds` is linked to the selection. Nothing is, without a call id. */
export const isLinked = (selection: LinkSelection | null, callIds: readonly string[]): boolean =>
  selection !== null && callIds.some((id) => selection.callIds.includes(id))

/**
 * The calls that returned each document, by normalized name: read off the
 * `sources` steps that carry their call's id. A document no such step names
 * (a turn stored before `call_id`, the prefetch's own hits) maps to nothing,
 * and links to nothing.
 */
export function callIdsByDocument(
  steps: readonly StoredThinkingStep[],
  normalize: (name: string) => string
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const step of steps) {
    if (step.kind !== 'sources' || !step.callId) continue
    for (const lane of step.traceLanes ?? []) {
      for (const source of lane.sources) {
        for (const name of [source.name, source.title]) {
          const key = name ? normalize(name) : ''
          if (!key) continue
          const known = out.get(key) ?? []
          if (!known.includes(step.callId)) out.set(key, [...known, step.callId])
        }
      }
    }
  }
  return out
}

export type WorkKind = 'search' | 'read' | 'list' | 'look' | 'model' | 'workspace'

const SEARCH_VERBS: ReadonlySet<StoredAction['verb']> = new Set(['search', 'lookup', 'law', 'web'])

/**
 * What a step did, from its calls: any search makes it a search, else any
 * read makes it a read, else the first call's own kind. The reader's word
 * for the step („Schritt 2 · Lesen“), never a tool's name.
 */
export function workKind(round: WorkRound): WorkKind {
  const verbs = allRows(round).map((row) => row.action.verb)
  if (verbs.some((verb) => SEARCH_VERBS.has(verb))) return 'search'
  if (verbs.includes('read')) return 'read'
  const first = verbs[0]
  return first === 'list' || first === 'look' || first === 'model' || first === 'workspace'
    ? first
    : 'read'
}
