/**
 * INTERNAL sweep — remind the Zuständige of marks whose Frist is near or past
 * (`lib/annotations/due-reminders.ts`). Called once a day by the job
 * scheduler's daily clock (`scheduler/index.js`, `sweepAnnotationDue`), the
 * shape of the upload sweep. It only enqueues: one `annotation_due_reminders`
 * job per organization on the BFF job queue, whose id is the organization and
 * the office's day, so a second call the same day (a restart, a second replica)
 * queues nothing new, and the job tells each reminder once.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { enqueueDueReminders } from '@/lib/annotations/due-reminders'

export const POST = internalApiRoute('Annotation Due Reminders', () => enqueueDueReminders(), {
  tenancy: {
    crossTenant:
      'discovery only: one grouped read of the organizations that have an open mark with a Zuständige whose ' +
      'Frist is near or past; each organization’s job is enqueued inside withTenant for its own lane, and the ' +
      'job reads its marks and writes its inbox rows inside that organization, under row-level security',
  },
})
