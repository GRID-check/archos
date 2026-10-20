/**
 * Step 3, Erfassung: where the reading stands (ticket 26: „Standort
 * ermittelt", „23 Dokumente gelesen", „41 Werte gefunden, 6 Widersprüche,
 * 9 Lücken"). Pure: the view in, what the step claims out, so every claim is
 * testable without drawing it.
 *
 * Every number is one the server computed: the documents from what the run
 * reported opening (`readingProgress`), the values, contradictions and gaps
 * from the profile as it stands on this read (`counts`, `groups`), which moves
 * with every `record` the run makes. Nothing is interpolated or estimated:
 * there is no time estimate, because nothing the run reports says how long
 * the documents still to read will take.
 */

import type { IntakeView, Suggestion } from '@/lib/project-intake/types'

/** Where the reading is, as the step words it. */
export type ReadingPhase = 'waiting' | 'waitingWithDocuments' | 'reading' | 'ready' | 'failed' | 'completed'

/**
 * A milestone's state. `done`: it stands. `active`: the reading is working on
 * it. `pending`: nothing yet, and nothing working on it (the gaps, which only
 * a finished reading can name). `attention`: it stands, and it asks something
 * of the person (a contradiction, a gap, a site nobody named).
 */
export type MilestoneState = 'done' | 'active' | 'pending' | 'attention'

export type ReadingMilestone =
  | { id: 'site'; state: MilestoneState; site: IntakeView['readingProgress']['site'] }
  | { id: 'values' | 'contradictions' | 'gaps'; state: MilestoneState; count: number }

/**
 * The documents, for the bar under the heading. `total` is null for a
 * reading from before the run reported what it opened: its stored count,
 * without a total. `unread`: documents no finished reading has read (new
 * ones, or the rest a reading left), which a person may have read now.
 */
export interface ReadingDocuments {
  read: number
  total: number | null
  unread: number
}

export function readingPhase(view: IntakeView): ReadingPhase {
  if (view.status === 'waiting') {
    return view.counts.documentsRead + view.counts.unreadDocuments === 0 ? 'waiting' : 'waitingWithDocuments'
  }
  return view.status
}

/** Whether the reading is over, one way or the other. */
export function readingOver(phase: ReadingPhase): boolean {
  return phase === 'ready' || phase === 'failed' || phase === 'completed'
}

/** Every value on the review, the class's own suggestion included. */
function allValues(view: IntakeView): Suggestion[] {
  return [
    ...view.groups.flatMap((group) => group.items),
    ...view.derivations.flatMap((derivation) => (derivation.suggestion ? [derivation.suggestion] : [])),
  ]
}

/**
 * The values a reading found in the documents: every value on the review that
 * carries a document as evidence, confirmed or not. `counts.suggested` is not
 * it: it counts only what is still unconfirmed, so it fell to nought as a
 * person confirmed what Piloti had found.
 */
export function documentValues(view: IntakeView): Suggestion[] {
  return allValues(view).filter((item) => item.evidence.some((evidence) => evidence.kind === 'document'))
}

export function valuesFound(view: IntakeView): number {
  return documentValues(view).length
}

export function readingDocuments(view: IntakeView): ReadingDocuments {
  const { documentsOpened, documentsTotal } = view.readingProgress
  const { documentsRead, unreadDocuments } = view.counts
  const phase = readingPhase(view)
  if (phase === 'reading') return { read: documentsOpened, total: documentsTotal, unread: unreadDocuments }
  if (phase === 'waiting' || phase === 'waitingWithDocuments') {
    return { read: 0, total: documentsTotal > 0 ? documentsTotal : documentsRead + unreadDocuments, unread: unreadDocuments }
  }
  if (documentsOpened > 0) return { read: documentsOpened, total: documentsTotal, unread: unreadDocuments }
  return { read: documentsRead, total: null, unread: unreadDocuments }
}

/** A count that asks something of the person once there is one; while reading, still moving. */
function asking(count: number, reading: boolean): MilestoneState {
  if (count > 0) return 'attention'
  return reading ? 'active' : 'done'
}

/**
 * The milestones in the order the ticket names them: the site, the values,
 * the contradictions, the gaps that decide the Gebäudeklasse. The documents
 * are the bar above them. While there are no documents, only the site.
 */
export function readingMilestones(view: IntakeView): ReadingMilestone[] {
  const phase = readingPhase(view)
  const reading = phase === 'reading'
  const before = phase === 'waiting' || phase === 'waitingWithDocuments'
  const { site } = view.readingProgress
  // No Bundesland: the reading looks for it; once a reading is over, it is a Rückfrage.
  const siteState: MilestoneState = site.source ? 'done' : reading ? 'active' : before ? 'pending' : 'attention'
  const siteMilestone: ReadingMilestone = { id: 'site', state: siteState, site }
  if (phase === 'waiting') return [siteMilestone]
  const values = valuesFound(view)
  const { contradictions, decisiveOpen } = view.counts
  return [
    siteMilestone,
    { id: 'values', state: values > 0 ? 'done' : reading ? 'active' : 'pending', count: values },
    { id: 'contradictions', state: before ? 'pending' : asking(contradictions, reading), count: contradictions },
    // A gap is only a gap once the reading had its chance at it: until then, „nach dem Lesen".
    { id: 'gaps', state: before || reading ? 'pending' : asking(decisiveOpen, false), count: decisiveOpen },
  ]
}
