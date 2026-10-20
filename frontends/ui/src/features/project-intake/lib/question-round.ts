/**
 * What step 4, Rückfragen, asks, read from the review: the location register's
 * questions and the decisive ones (each once), the location documents still
 * missing a value, and the rest of the open needs for the folded interview.
 * Pure and shared: the step draws it, the setup frame counts it for the
 * stepper's note and for the step it opens on.
 */

import type { DocumentRequest, IntakeView, Need } from '@/lib/project-intake/types'

/** What step 4 asks, from the review: one list, one pass, and the rest folded away. */
export interface QuestionRound {
  /** The register's inputs (Bundesland, Vorhaben), then the decisive needs: each a question card. */
  questions: Need[]
  /** The location's documents still missing a value. */
  requests: DocumentRequest[]
  /** Item ids for the progress: open now, and settled by the server. */
  openIds: string[]
  settledIds: string[]
  /** Every other open need, not shown above: the optional interview. */
  more: Need[]
}

/** The round as step 4 shows it. */
export function questionRound(view: IntakeView): QuestionRound {
  const register = view.locationRegister
  const asked = new Map<string, Need>()
  for (const need of [...(register?.questions ?? []), ...view.questions]) if (!asked.has(need.key)) asked.set(need.key, need)
  const questions = [...asked.values()]
  const all = register?.documentRequests ?? []
  const requests = all.filter((request) => !request.satisfied)
  const shown = new Set([...asked.keys(), ...requests.flatMap((request) => request.keys)])
  return {
    questions,
    requests,
    openIds: [
      ...questions.map((need) => `question:${need.key}`),
      ...requests.map((request) => `request:${request.determinant}`),
    ],
    settledIds: all.filter((request) => request.satisfied).map((request) => `request:${request.determinant}`),
    more: view.openQuestions.filter((need) => !shown.has(need.key)),
  }
}

