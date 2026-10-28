/**
 * What step 4, Rückfragen, asks, read from the review: the location register's
 * questions and the decisive ones (each once), the location documents still
 * missing a value, the contradictions (a person picks the value that holds),
 * and the rest of the open needs for the folded interview. Pure and shared:
 * the step draws it, the setup frame counts it for the stepper's note and for
 * the step it opens on.
 */

import type { DocumentRequest, IntakeView, Need, Suggestion } from '@/lib/project-intake/types'

/** The three groups step 4 lists, in this order. */
export const ROUND_GROUPS = ['missing', 'location', 'contradiction'] as const
export type RoundGroup = (typeof ROUND_GROUPS)[number]

/** One thing the round asks, by its id (`question:<key>`, `request:<determinant>`, `contradiction:<key>`). */
export type RoundEntry =
  | { id: string; group: 'missing'; kind: 'need'; need: Need }
  | { id: string; group: 'location'; kind: 'request'; request: DocumentRequest }
  | { id: string; group: 'contradiction'; kind: 'contradiction'; contradiction: Suggestion }

/** What step 4 asks, from the review: one list, one question at a time, and the rest folded away. */
export interface QuestionRound {
  /** The register's inputs (Bundesland, Vorhaben), then the decisive needs. */
  questions: Need[]
  /** The location's documents still missing a value. */
  requests: DocumentRequest[]
  /** Keys whose documents disagree: the person picks the value that holds. */
  contradictions: Suggestion[]
  /** Everything open, in the order the step asks it: missing, location, contradiction. */
  entries: RoundEntry[]
  /** The location's documents the server already reports settled: done before the person starts. */
  settled: RoundEntry[]
  /** Item ids for the progress: open now, and settled by the server. */
  openIds: string[]
  settledIds: string[]
  /** Every other open need, not shown above: the optional interview. */
  more: Need[]
}

const requestEntry = (request: DocumentRequest): RoundEntry => ({
  id: `request:${request.determinant}`,
  group: 'location',
  kind: 'request',
  request,
})

/** The round as step 4 shows it. */
export function questionRound(view: IntakeView): QuestionRound {
  const register = view.locationRegister
  const asked = new Map<string, Need>()
  for (const need of [...(register?.questions ?? []), ...view.questions]) if (!asked.has(need.key)) asked.set(need.key, need)
  const questions = [...asked.values()]
  const all = register?.documentRequests ?? []
  const requests = all.filter((request) => !request.satisfied)
  const contradictions = view.contradictions
  const shown = new Set([
    ...asked.keys(),
    ...requests.flatMap((request) => request.keys),
    ...contradictions.map((item) => item.key),
  ])
  const entries: RoundEntry[] = [
    ...questions.map((need): RoundEntry => ({ id: `question:${need.key}`, group: 'missing', kind: 'need', need })),
    ...requests.map(requestEntry),
    ...contradictions.map(
      (contradiction): RoundEntry => ({
        id: `contradiction:${contradiction.key}`,
        group: 'contradiction',
        kind: 'contradiction',
        contradiction,
      })
    ),
  ]
  const settled = all.filter((request) => request.satisfied).map(requestEntry)
  return {
    questions,
    requests,
    contradictions,
    entries,
    settled,
    openIds: entries.map((entry) => entry.id),
    settledIds: settled.map((entry) => entry.id),
    more: view.openQuestions.filter((need) => !shown.has(need.key)),
  }
}
