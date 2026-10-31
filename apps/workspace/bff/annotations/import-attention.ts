/**
 * What a BCF import tells the Zuständige it names: ONE row per person per
 * import, counting their marks, instead of one row (and one push) per mark.
 * A coordination round of 280 topics for one Fachplaner is one request, as
 * the import is one act (`lib/bim/bcf-import-service.ts`).
 *
 * The row is the type every hand-over uses (`annotation.assigned_to_you`, so it
 * is actionable and pushed as a request), worded by its `imported` variant and
 * folded on the import (`groupAnchor` `import:<batch>`, `occurrences` the
 * count). It anchors on the person's first mark of the import, where its link
 * opens the review; closing or handing on THAT mark settles the row, as it
 * would a single hand-over. Later moves of the other marks speak in rows of
 * their own, as ever, and so does each mark's Frist reminder (`due-reminders.ts`),
 * which the push fold already groups into one notification a day.
 */

import 'server-only'
import { bestEffortInbox } from '@/lib/inbox/best-effort'
import { emitAboutMark, excerptOf } from './attention'

/** The group anchor of one import's hand-over rows. */
export const IMPORT_GROUP_ANCHOR = 'import:'

export interface ImportedAssignment {
  annotationId: string
  number: number
  body: string
  assigneeUserId: string
}

/** One counted row per Zuständige of an import's open marks; the importer is never told about their own. */
export async function onMarksAssignedByImport(input: {
  organizationId: string
  documentId: string
  projectId: string | null
  actorUserId: string
  batchId: string
  marks: readonly ImportedAssignment[]
}): Promise<void> {
  const byPerson = new Map<string, ImportedAssignment[]>()
  for (const mark of input.marks) {
    if (mark.assigneeUserId === input.actorUserId) continue
    byPerson.set(mark.assigneeUserId, [...(byPerson.get(mark.assigneeUserId) ?? []), mark])
  }
  // One person after the other: a round with many Zuständige is a short series of writes, never a burst of jobs.
  for (const [assignee, marks] of byPerson) {
    const first = marks.reduce((a, b) => (b.number < a.number ? b : a))
    await bestEffortInbox(`annotation.assigned_to_you (import ${input.batchId})`, input.organizationId, () =>
      emitAboutMark(
        'annotation.assigned_to_you',
        {
          organizationId: input.organizationId,
          documentId: input.documentId,
          projectId: input.projectId,
          annotationId: first.annotationId,
          annotationNumber: first.number,
        },
        [assignee],
        {
          excerpt: excerptOf(first.body),
          mentions: [],
          variant: 'imported',
          actorUserId: input.actorUserId,
          facts: { dueOn: null, reminder: null },
          groupAnchor: `${IMPORT_GROUP_ANCHOR}${input.batchId}`,
          occurrences: marks.length,
        }
      )
    )
  }
}
