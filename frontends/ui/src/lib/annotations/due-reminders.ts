/**
 * The daily reminder of a Zuständige's Frist (CONTEXT.md „Anmerkung").
 *
 * A mark handed to someone with a date used to say nothing when the date came:
 * the Zuständige was told once, when it was handed to them, and the date then
 * passed in silence. Once a day the Zuständige of every open mark whose Frist
 * is today or tomorrow is reminded (`due_soon`), and of every mark whose Frist
 * passed in the last {@link DUE_REMINDER_OVERDUE_DAYS} days (`overdue`), in the
 * row they already have for the mark
 * (`annotation.assigned_to_you`, folded per mark: the overdue reminder upgrades
 * the earlier one, never a second row). Each reminder for each date is said
 * once (`reminder` on the row, `remindedFor`): a second run on the same day, a
 * retried slice and a restarted scheduler tell nobody twice, and a date moved
 * since is reminded of anew.
 *
 * ## How it runs
 *
 * The scheduler's daily clock (`scheduler/index.js`, `sweepAnnotationDue`)
 * posts `POST /api/internal/annotations/due-reminders`. That route
 * ({@link enqueueDueReminders}) finds the organizations with marks due (one
 * aggregate under the platform scope) and enqueues one `annotation_due_reminders`
 * job per organization on the BFF job queue (ADR-0079), in its own lane, so one
 * office's thousand marks never hold up the next office's handful. The job's id
 * is the organization and the office's day, so a second post while that job is
 * queued, running or dead adds nothing; a finished job's row is gone (the queue
 * deletes what is done, migration 0104), so a post after it queues the day's
 * job again, and the stamps make that run tell nobody twice. The job ({@link runDueRemindersSlice}) walks the
 * organization's due marks a page at a time inside its tenant, asks whether
 * each Zuständige may still open the document (`mayOpenDocument`, as every
 * item about a mark does), tells them, and saves where it got to.
 *
 * ## What is observable
 *
 * Nothing calls a model, so nothing is traced to Langfuse. A finished job is
 * one `annotation_due_reminders_sent` PostHog server event (counts only), the
 * way the push job reports what it sent; a mark that could not be told is a
 * warning in the log and is told by the next run.
 */

import 'server-only'
import { v5 as uuidv5 } from 'uuid'
import { captureServer } from '@/lib/analytics/posthog-server'
import { isUniqueViolation } from '@/lib/db/errors'
import { withTenant } from '@/lib/db/tenant-context'
import { mayOpenDocument } from '@/lib/documents/may-open'
import { addCalendarDays, calendarDayIn, OFFICE_TIME_ZONE } from '@/lib/format'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { readGroupPayloads } from '@/lib/inbox/repository'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { emptyDueReminderCounts, type AnnotationDueRemindersPayload, type JobSliceResult } from '@/lib/jobs-queue/types'
import { onMarkDue, remindedFor, type DueReminder } from './attention'
import { listDueMarksPage, listOrganizationsWithDueMarks, type DueMark, type DueWindow } from './due-repository'

/** Marks one slice reminds of: a page, then the slice saves its place and the next one goes on. */
export const DUE_REMINDER_PAGE = 100

/**
 * Organizations one sweep enqueues (a cap on one request's work, not a design
 * limit). Discovery's order turns over every day, so an office left out today
 * is likely in tomorrow's; a mark of one left out every day of its window is
 * never reminded, which is why reaching the cap is a warning.
 */
export const DUE_REMINDER_MAX_ORGANIZATIONS = 1000

/**
 * How many days after its Frist a mark is still reminded of as overdue. The
 * stamp tells each Frist once anyway; the bound keeps a first run, or a mark
 * whose date passed months ago, from reminding of everything that ever passed,
 * and keeps an office with only stale marks out of the daily discovery.
 */
export const DUE_REMINDER_OVERDUE_DAYS = 7

/** The Fristen a run on the office's day `day` reminds of: the overdue window through tomorrow. Pure. */
export function dueWindowOn(day: string): DueWindow {
  return { from: addCalendarDays(day, -DUE_REMINDER_OVERDUE_DAYS), through: addCalendarDays(day, 1) }
}

/** What a reminder says of `dueOn` on the office's day `today`: passed, near (today or tomorrow), or nothing yet. Pure. */
export function reminderOn(dueOn: string, today: string): DueReminder | null {
  if (dueOn < today) return 'overdue'
  return dueOn <= addCalendarDays(today, 1) ? 'due_soon' : null
}

/** One job per organization and office day: a second sweep while its row is there (queued, running, dead) adds nothing. */
export function dueReminderJobId(organizationId: string, day: string): string {
  return uuidv5(`grid:annotation-due:${organizationId}:${day}`, uuidv5.URL)
}

export interface DueReminderSweep {
  day: string
  organizations: number
  queued: number
  /** Today's job was already queued, running or dead. */
  already: number
}

/**
 * The daily sweep's half (`POST /api/internal/annotations/due-reminders`): one
 * job per organization with a mark due on the office's day or the next.
 * Discovery runs under the route's platform scope; each job is enqueued in its
 * own organization's lane (`withTenant`, which the queue's WITH CHECK asks).
 */
export async function enqueueDueReminders(now: Date = new Date()): Promise<DueReminderSweep> {
  const day = calendarDayIn(OFFICE_TIME_ZONE, now)
  const organizations = await listOrganizationsWithDueMarks(dueWindowOn(day), day, DUE_REMINDER_MAX_ORGANIZATIONS)
  if (organizations.length >= DUE_REMINDER_MAX_ORGANIZATIONS) {
    console.warn(
      `[annotations] due reminders for ${day}: the cap of ${DUE_REMINDER_MAX_ORGANIZATIONS} organizations was reached; ` +
        'the rest wait for a later day'
    )
  }
  const sweep: DueReminderSweep = { day, organizations: organizations.length, queued: 0, already: 0 }
  const failed: string[] = []
  for (const organizationId of organizations) {
    try {
      await withTenant({ organizationId }, () =>
        enqueueJob({
          kind: 'annotation_due_reminders',
          organizationId,
          payload: { day, cursor: null, counts: emptyDueReminderCounts() },
          jobId: dueReminderJobId(organizationId, day),
        })
      )
      sweep.queued += 1
    } catch (error) {
      if (isUniqueViolation(error, 'bff_job_queue_pkey')) sweep.already += 1
      else {
        console.warn(`[annotations] could not queue the due reminders of ${organizationId}:`, error)
        failed.push(organizationId)
      }
    }
  }
  // The others are queued; failing the sweep makes the scheduler retry, and what is queued counts as `already`.
  if (failed.length > 0) {
    throw new Error(`due reminders for ${day}: ${failed.length} of ${organizations.length} organization(s) could not be queued`)
  }
  return sweep
}

/** Which of a page's Zuständige may open each document, asked once per document. */
async function reachable(organizationId: string, marks: readonly DueMark[]): Promise<Map<string, ReadonlySet<string>>> {
  const byDocument = new Map<string, DueMark[]>()
  for (const mark of marks) byDocument.set(mark.documentId, [...(byDocument.get(mark.documentId) ?? []), mark])
  const verdicts = await Promise.all(
    [...byDocument].map(async ([documentId, onIt]) => {
      const allowed = await mayOpenDocument(
        { organizationId },
        onIt[0].document,
        onIt.map((mark) => mark.assigneeUserId)
      ).catch(() => new Set<string>())
      return [documentId, allowed] as const
    })
  )
  return new Map(verdicts)
}

const groupKeyOf = (mark: DueMark) => inboxGroupKey('annotation.assigned_to_you', 'document', mark.documentId, mark.id)

/**
 * One slice of an organization's reminders: a page of its due marks after the
 * cursor, each Zuständige told once per reminder and date. Done when the page
 * came back short; the finished job reports its counts.
 */
export async function runDueRemindersSlice(
  organizationId: string,
  payload: AnnotationDueRemindersPayload
): Promise<JobSliceResult<AnnotationDueRemindersPayload>> {
  const page = await listDueMarksPage(organizationId, dueWindowOn(payload.day), payload.cursor, DUE_REMINDER_PAGE)
  const counts = { ...payload.counts }
  const [stamps, allowed] = await Promise.all([
    readGroupPayloads(
      organizationId,
      page.map((mark) => ({ recipientUserId: mark.assigneeUserId, groupKey: groupKeyOf(mark) }))
    ),
    reachable(organizationId, page),
  ])
  for (const mark of page) {
    counts.checked += 1
    const reminder = reminderOn(mark.dueOn, payload.day)
    if (!reminder) continue
    if (stamps.get(`${mark.assigneeUserId}\n${groupKeyOf(mark)}`)?.reminder === remindedFor(reminder, mark.dueOn)) {
      counts.already += 1
      continue
    }
    if (!allowed.get(mark.documentId)?.has(mark.assigneeUserId)) {
      counts.unreachable += 1
      continue
    }
    try {
      await onMarkDue({
        organizationId,
        documentId: mark.documentId,
        annotationId: mark.id,
        annotationNumber: mark.number,
        projectId: mark.document.projectId ?? null,
        assigneeUserId: mark.assigneeUserId,
        dueOn: mark.dueOn,
        reminder,
        markText: mark.body,
      })
      if (reminder === 'overdue') counts.overdue += 1
      else counts.dueSoon += 1
    } catch (error) {
      counts.failed += 1
      console.warn(`[annotations] could not remind the Zuständige of mark ${mark.id}:`, error)
    }
  }
  const next: AnnotationDueRemindersPayload = { day: payload.day, cursor: page.at(-1)?.id ?? payload.cursor, counts }
  const done = page.length < DUE_REMINDER_PAGE
  if (done) {
    captureServer({
      event: 'annotation_due_reminders_sent',
      distinctId: null,
      organizationId,
      properties: {
        checked: counts.checked,
        due_soon: counts.dueSoon,
        overdue: counts.overdue,
        already: counts.already,
        unreachable: counts.unreachable,
        failed: counts.failed,
      },
    })
  }
  return { done, payload: next }
}
