/**
 * What `answer_completed` says about a chat turn that has just ended.
 *
 * Pure, so the product question it answers (how long do answers take, how many
 * come back grounded, how many end in an error) is pinned by a spec rather than
 * by whoever last touched the store. The store calls it from `commit`
 * (`messages-store.ts`), the one place every turn's phase change passes through,
 * and from `failTurn` for a turn ended from outside the fold.
 *
 * Non-personal by rule: an enum, a duration, two counts, a list of source KINDS
 * (not names), an effort level and a flag. Never the question, the answer, a
 * file name or a citation.
 */

import type { ChatMessage } from '../types'
import type { TurnView } from './turn-fold'

export type AnswerOutcome = 'ok' | 'handed_off' | 'refused' | 'aborted' | 'error'

export interface AnswerCompletion {
  outcome: AnswerOutcome
  /** Wall time from send to the terminal, on this page; absent when the page did not time the turn. */
  duration_ms: number | undefined
  citation_count: number
  /** Distinct coarse source kinds of the answer's citations, sorted, comma-separated (`building_law,office`). */
  source_kinds: string
  /** The reasoning level the turn ran at, when known. */
  effort: string | undefined
  /** The turn commissioned a run (ADR-0062) instead of answering inline. */
  has_run: boolean
}

const outcomeOf = (view: TurnView): AnswerOutcome => {
  if (view.phase === 'failed') return 'error'
  switch (view.outcome) {
    case 'cancelled':
      return 'aborted'
    case 'refused':
      return 'refused'
    case 'handed_off':
      return 'handed_off'
    default:
      return 'ok'
  }
}

const sourceKindsOf = (answer: ChatMessage | undefined): string => {
  const kinds = new Set<string>()
  for (const citation of answer?.citations ?? []) if (citation.kind) kinds.add(citation.kind)
  return [...kinds].sort().join(',')
}

/**
 * The completion of `view`, or `null` when this change is not a turn ending.
 *
 * A turn ends once: the move from `running` to anything else. A view with no
 * `previous` (a replay of a turn another page ran, folded for the first time)
 * and a terminal that arrives after a local Stop (already `finished`) are both
 * not endings, so neither is counted twice.
 */
export const answerCompletionOf = (
  view: TurnView,
  previous: TurnView | undefined,
  answer: ChatMessage | undefined,
  durationMs: number | undefined
): AnswerCompletion | null => {
  if (previous?.phase !== 'running' || view.phase === 'running') return null
  return {
    outcome: outcomeOf(view),
    duration_ms: durationMs,
    citation_count: answer?.citations?.length ?? view.sources.length,
    source_kinds: sourceKindsOf(answer),
    effort: answer?.reasoningEffort ?? view.effort,
    has_run: Boolean(view.result?.run),
  }
}
