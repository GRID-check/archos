/**
 * „Gerade gefunden": the few values the step shows of what the reading found,
 * each with the page it stands on. Pure, apart from {@link useArrivalOrder},
 * which remembers when a value first appeared on this page.
 *
 * The view carries no time a value was recorded, so „latest" can only mean
 * what this page saw arrive: a value that appears on a later read of the view
 * goes to the top. Without one, the decisive values lead, in the review's
 * order. The step words the list by which of the two it is.
 */

import { useState } from 'react'
import type { DocumentEvidence, IntakeView, Suggestion } from '@/lib/project-intake/types'
import { documentValues } from './reading-milestones'

export interface FoundValue {
  key: string
  label: string
  display: string
  /** Where it stands: the file's name without its extension, and the page. */
  source: { fileName: string; name: string; page: number | null }
  /** It arrived while this page was open. */
  fresh: boolean
}

/** „E-02 Schnitt A-A.pdf" → „E-02 Schnitt A-A": the name a person calls the document. */
export function documentName(fileName: string): string {
  const stripped = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '')
  return stripped.length > 0 ? stripped : fileName
}

function sourceOf(item: Suggestion): FoundValue['source'] | null {
  const evidence = item.evidence.find((entry): entry is DocumentEvidence => entry.kind === 'document')
  if (!evidence) return null
  return { fileName: evidence.fileName, name: documentName(evidence.fileName), page: evidence.page }
}

/**
 * The `limit` values to show: the ones that arrived last on this page first,
 * then the decisive ones, then the rest, each group in the review's order.
 * `arrival` maps a key to the moment this page first saw it (0: it was there
 * when the page opened).
 */
export function foundValues(view: IntakeView, arrival: ReadonlyMap<string, number>, limit = 3): FoundValue[] {
  const ranked = documentValues(view).map((item, index) => ({ item, index, seen: arrival.get(item.key) ?? 0 }))
  ranked.sort(
    (a, b) => b.seen - a.seen || Number(b.item.decisive) - Number(a.item.decisive) || a.index - b.index
  )
  return ranked.slice(0, limit).flatMap(({ item, seen }) => {
    const source = sourceOf(item)
    if (!source) return []
    return [{ key: item.key, label: item.label, display: item.display, source, fresh: seen > 0 }]
  })
}

interface Arrivals {
  signature: string
  arrival: ReadonlyMap<string, number>
  tick: number
}

/**
 * When each key first appeared while this page was open: 0 for what was
 * there at the start, then 1, 2, … for each later read that brought new ones.
 * Updated while rendering (React's „storing information from previous
 * renders"), so the order never lags a read behind.
 */
export function useArrivalOrder(keys: readonly string[]): ReadonlyMap<string, number> {
  const signature = keys.join('\n')
  const [state, setState] = useState<Arrivals>(() => ({
    signature,
    arrival: new Map(keys.map((key) => [key, 0])),
    tick: 0,
  }))
  if (state.signature === signature) return state.arrival
  const fresh = keys.filter((key) => !state.arrival.has(key))
  const tick = fresh.length > 0 ? state.tick + 1 : state.tick
  const arrival = new Map(state.arrival)
  for (const key of fresh) arrival.set(key, tick)
  setState({ signature, arrival, tick })
  return arrival
}
