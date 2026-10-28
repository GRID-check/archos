/**
 * The cases „für Sie“ is held to, on both sides of the wire: the predicate the
 * review filters with (`isForReader`, `lib/annotations/types.ts`) in
 * `lib/annotations/for-reader.spec.ts`, and the SQL Dateien's chip counts with
 * (`tallyLiveMarks`) in `lib/annotations/repository.integration.spec.ts`. One
 * table, so the two cannot drift: a case added here is asked of both.
 */

import type { AnnotationAuthor, AnnotationStatus } from '@/lib/annotations/types'

/** Who a case names, relative to the person reading. */
export type MarkPerson = 'reader' | 'colleague'

export interface ForReaderCase {
  name: string
  authorKind: AnnotationAuthor
  status: AnnotationStatus
  /** The Zuständige, or nobody. */
  assignee: MarkPerson | null
  /** Who set it (for Piloti's mark: on whose behalf). */
  setBy: MarkPerson
  /** `isForReader`: listed under the review's „Für Sie“. */
  forReader: boolean
  /** Counted in Dateien's „… · N für Sie“: live, and the reader's. */
  counted: boolean
}

export const FOR_READER_CASES: readonly ForReaderCase[] = [
  { name: 'open, the reader is Zuständige', authorKind: 'person', status: 'open', assignee: 'reader', setBy: 'colleague', forReader: true, counted: true },
  { name: 'open, set by the reader, nobody Zuständige', authorKind: 'person', status: 'open', assignee: null, setBy: 'reader', forReader: false, counted: false },
  { name: 'open, set by the reader for a colleague', authorKind: 'person', status: 'open', assignee: 'colleague', setBy: 'reader', forReader: false, counted: false },
  { name: 'open, a colleague is Zuständige', authorKind: 'person', status: 'open', assignee: 'colleague', setBy: 'colleague', forReader: false, counted: false },
  { name: 'a proposal of Piloti that names the reader', authorKind: 'piloti', status: 'proposed', assignee: 'reader', setBy: 'reader', forReader: false, counted: false },
  { name: 'a mark of Piloti taken over, the reader Zuständige', authorKind: 'piloti', status: 'open', assignee: 'reader', setBy: 'colleague', forReader: true, counted: true },
  { name: 'resolved, the reader was Zuständige', authorKind: 'person', status: 'resolved', assignee: 'reader', setBy: 'colleague', forReader: true, counted: false },
  { name: 'dismissed, the reader was Zuständige', authorKind: 'person', status: 'dismissed', assignee: 'reader', setBy: 'reader', forReader: true, counted: false },
]
