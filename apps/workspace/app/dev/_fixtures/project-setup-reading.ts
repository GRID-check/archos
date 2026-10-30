/**
 * Step 3, Erfassung, in every state it draws, for the `/dev/project-setup`
 * preview (`?step=reading&state=<name>`) and the step's spec. Built on the
 * page's own fixtures (`project-intake.ts`), changing only what the reading
 * step reads: the status, the counts, `readingProgress` and the summary.
 */

import type { IntakeView, ReadingProgress } from '@/lib/project-intake/types'
import {
  FIXTURE_LOCATION,
  INTAKE_COMPLETED,
  INTAKE_FAILED,
  INTAKE_READING,
  INTAKE_READY,
  INTAKE_WAITING,
} from './project-intake'

const SITE_FROM_GEOCODER: ReadingProgress['site'] = {
  federalState: 'Wien',
  municipality: 'Wien',
  address: FIXTURE_LOCATION.label,
  source: 'geocoder',
  confirmed: true,
}

const progress = (documentsOpened: number, documentsTotal: number, site = SITE_FROM_GEOCODER): ReadingProgress => ({
  documentsOpened,
  documentsTotal,
  site,
})

/** Created a moment ago, nothing filed: the step points back to the Ablage; the site already stands. */
export const READING_WAITING: IntakeView = { ...INTAKE_WAITING, readingProgress: progress(0, 0) }

/** Documents filed, the reading not yet claimed (the upload's job runs in a moment). */
export const READING_QUEUED: IntakeView = {
  ...INTAKE_WAITING,
  counts: { ...INTAKE_WAITING.counts, unreadDocuments: 23 },
  readingProgress: progress(0, 23),
}

/** A few minutes in: 9 of 23 opened, the first values found, nothing contested yet. */
export const READING_RUNNING: IntakeView = {
  ...INTAKE_READING,
  counts: { documentsRead: 0, unreadDocuments: 23, suggested: 6, contradictions: 0, decisiveOpen: 4 },
  readingProgress: progress(9, 23),
}

/** No address at creation: the reading looks for the site and found the Bundesland in a document. */
export const READING_SITE_FROM_DOCUMENTS: IntakeView = {
  ...READING_RUNNING,
  location: null,
  readingProgress: progress(14, 23, {
    federalState: 'Niederösterreich',
    municipality: null,
    address: 'Hauptplatz 4, 3100 St. Pölten',
    source: 'document',
    confirmed: false,
  }),
}

/** No address, nothing found yet: the site is being looked for. */
export const READING_SITE_SEARCHING: IntakeView = {
  ...READING_RUNNING,
  location: null,
  readingProgress: progress(3, 23, { federalState: null, municipality: null, address: null, source: null, confirmed: false }),
}

/** Done: every document read, the ticket's own numbers, and the agent's summary. */
export const READING_READY: IntakeView = {
  ...INTAKE_READY,
  counts: { ...INTAKE_READY.counts, contradictions: 6, decisiveOpen: 9 },
  readingProgress: progress(23, 23),
}

/** Done, but two documents stayed unread (the step budget ran out). */
export const READING_READY_WITH_REST: IntakeView = {
  ...READING_READY,
  counts: { ...READING_READY.counts, documentsRead: 21, unreadDocuments: 2 },
  readingProgress: progress(21, 23),
}

/** Stopped part-way: what was found stays; the frame's alert carries the retry. */
export const READING_FAILED: IntakeView = {
  ...INTAKE_FAILED,
  counts: { documentsRead: 0, unreadDocuments: 23, suggested: 6, contradictions: 0, decisiveOpen: 4 },
  summary: null,
  readingProgress: progress(9, 23),
}

/** The review is finished. */
export const READING_COMPLETED: IntakeView = {
  ...INTAKE_COMPLETED,
  summary: INTAKE_READY.summary,
  readingProgress: progress(23, 23),
}

export const READING_FIXTURES = {
  waiting: READING_WAITING,
  queued: READING_QUEUED,
  reading: READING_RUNNING,
  siteFromDocuments: READING_SITE_FROM_DOCUMENTS,
  siteSearching: READING_SITE_SEARCHING,
  ready: READING_READY,
  readyWithRest: READING_READY_WITH_REST,
  failed: READING_FAILED,
  completed: READING_COMPLETED,
} as const satisfies Record<string, IntakeView>
export type ReadingFixtureName = keyof typeof READING_FIXTURES
