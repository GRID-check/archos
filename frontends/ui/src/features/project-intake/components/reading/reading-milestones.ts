/**
 * Step 3, Erfassung: where the reading stands, as named milestones (ticket 26:
 * „Standort ermittelt", „23 Dokumente gelesen", „41 Werte gefunden,
 * 6 Widersprüche, 9 Lücken"). Pure: the view in, the milestones out, so what
 * the step claims is testable without drawing it.
 *
 * Every number is one the server computed: the documents from what the run
 * reported opening (`readingProgress`), the values, contradictions and gaps
 * from the profile as it stands on this read (`counts`, `groups`), which moves
 * with every `record` the run makes. Nothing is interpolated or estimated.
 */

import type { IntakeView } from '@/lib/project-intake/types'

/** Where the reading is, as the step words it. */
export type ReadingPhase = 'waiting' | 'waitingWithDocuments' | 'reading' | 'ready' | 'failed' | 'completed'

/**
 * A milestone's state. `done`: it stands. `active`: the reading is working on
 * it. `pending`: nothing yet, and nothing working on it. `attention`: it
 * stands, and it asks something of the person (a contradiction, a gap, a site
 * nobody named).
 */
export type MilestoneState = 'done' | 'active' | 'pending' | 'attention'

export type ReadingMilestone =
  | { id: 'site'; state: MilestoneState; site: IntakeView['readingProgress']['site'] }
  | { id: 'documents'; state: MilestoneState; read: number; total: number | null }
  | { id: 'values' | 'contradictions' | 'gaps'; state: MilestoneState; count: number }

export function readingPhase(view: IntakeView): ReadingPhase {
  if (view.status === 'waiting') {
    return view.counts.documentsRead + view.counts.unreadDocuments === 0 ? 'waiting' : 'waitingWithDocuments'
  }
  return view.status
}

/**
 * The values a reading found in the documents: every value on the review that
 * carries a document as evidence, confirmed or not. `counts.suggested` is not
 * it: it counts only what is still unconfirmed, so it fell to nought as a
 * person confirmed what Piloti had found.
 */
export function valuesFound(view: IntakeView): number {
  const items = [
    ...view.groups.flatMap((group) => group.items),
    ...view.derivations.flatMap((derivation) => (derivation.suggestion ? [derivation.suggestion] : [])),
  ]
  return items.filter((item) => item.evidence.some((evidence) => evidence.kind === 'document')).length
}

function documentsMilestone(view: IntakeView, reading: boolean): ReadingMilestone {
  const { documentsOpened, documentsTotal } = view.readingProgress
  if (reading) return { id: 'documents', state: 'active', read: documentsOpened, total: documentsTotal }
  const read = view.counts.documentsRead
  if (documentsOpened > 0 || read === 0) {
    return { id: 'documents', state: documentsOpened > 0 ? 'done' : 'pending', read: documentsOpened, total: documentsTotal }
  }
  // A reading from before the run reported what it opened: its stored count, without a total.
  return { id: 'documents', state: 'done', read, total: null }
}

/** A count that asks something of the person once there is one; while reading, still moving. */
function asking(count: number, reading: boolean): MilestoneState {
  if (count > 0) return 'attention'
  return reading ? 'active' : 'done'
}

/** The five milestones in the order the ticket names them. While waiting for documents, only the site. */
export function readingMilestones(view: IntakeView): ReadingMilestone[] {
  const phase = readingPhase(view)
  const reading = phase === 'reading'
  const { site } = view.readingProgress
  const nothingYet = phase === 'waiting' || phase === 'waitingWithDocuments'
  // No Bundesland: the reading looks for it; once a reading is over, it is a Rückfrage.
  const siteState: MilestoneState = site.source ? 'done' : reading ? 'active' : nothingYet ? 'pending' : 'attention'
  const siteMilestone: ReadingMilestone = { id: 'site', state: siteState, site }
  if (phase === 'waiting') return [siteMilestone]
  const values = valuesFound(view)
  return [
    siteMilestone,
    documentsMilestone(view, reading),
    { id: 'values', state: values > 0 ? 'done' : reading ? 'active' : 'pending', count: values },
    {
      id: 'contradictions',
      state: nothingYet ? 'pending' : asking(view.counts.contradictions, reading),
      count: view.counts.contradictions,
    },
    { id: 'gaps', state: nothingYet ? 'pending' : asking(view.counts.decisiveOpen, reading), count: view.counts.decisiveOpen },
  ]
}
