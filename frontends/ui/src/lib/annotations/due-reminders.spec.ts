/**
 * @vitest-environment node
 */
/**
 * The daily reminder of a Zuständige's Frist: the sweep queues one job per
 * organization and office day, and the job reminds each Zuständige once per
 * reminder and date, only while they may open the document, a page at a time.
 * The repositories, the queue, the inbox rows and PostHog are faked; the
 * reminder's words are `attention.spec.ts`'s and the row's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./due-repository', () => ({ listDueMarksPage: vi.fn(), listOrganizationsWithDueMarks: vi.fn() }))
vi.mock('@/lib/inbox/repository', () => ({ readGroupPayloads: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn().mockResolvedValue(1) }))
vi.mock('@/lib/sharing/registry', () => ({
  describeResource: () => ({ describeRef: async () => ({ title: 'Grundriss EG' }) }),
}))
vi.mock('@/lib/documents/may-open', () => ({ mayOpenDocument: vi.fn() }))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn() }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({
  getTenantContext: vi.fn(),
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => await fn()),
}))

import { captureServer } from '@/lib/analytics/posthog-server'
import { withTenant } from '@/lib/db/tenant-context'
import { mayOpenDocument } from '@/lib/documents/may-open'
import type { InboxEmission } from '@/lib/inbox/service'
import { emitInboxItems } from '@/lib/inbox/service'
import { readGroupPayloads } from '@/lib/inbox/repository'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { emptyDueReminderCounts, type AnnotationDueRemindersPayload } from '@/lib/jobs-queue/types'
import {
  DUE_REMINDER_PAGE,
  dueReminderJobId,
  enqueueDueReminders,
  reminderOn,
  runDueRemindersSlice,
} from './due-reminders'
import { listDueMarksPage, listOrganizationsWithDueMarks, type DueMark } from './due-repository'

const due = (fields: Partial<DueMark> & Pick<DueMark, 'id' | 'dueOn'>): DueMark => ({
  documentId: 'doc_1',
  number: 4,
  body: 'Brüstung unter 1,00 m',
  assigneeUserId: 'user_anna',
  document: {
    id: 'doc_1',
    scope: 'project',
    projectId: 'proj_1',
    folderId: null,
    createdBy: 'user_ben',
    status: 'completed',
    authoredBy: 'user',
    screeningOutcome: 'clean',
    contentHash: 'h',
    screenedHash: 'h',
  },
  ...fields,
})

const FIRST: AnnotationDueRemindersPayload = { day: '2026-10-17', cursor: null, counts: emptyDueReminderCounts() }

const emitted = (): InboxEmission[] => vi.mocked(emitInboxItems).mock.calls.flatMap(([items]) => items)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readGroupPayloads).mockResolvedValue(new Map())
  vi.mocked(mayOpenDocument).mockImplementation(async (_tenant, _doc, userIds) => new Set(userIds))
  vi.mocked(enqueueJob).mockResolvedValue({ jobId: 'job' })
})

describe('reminderOn', () => {
  it('reminds of a Frist today or tomorrow, says one that passed is overdue, and leaves a later one alone', () => {
    expect(reminderOn('2026-10-17', '2026-10-17')).toBe('due_soon')
    expect(reminderOn('2026-10-18', '2026-10-17')).toBe('due_soon')
    expect(reminderOn('2026-10-16', '2026-10-17')).toBe('overdue')
    expect(reminderOn('2026-10-19', '2026-10-17')).toBeNull()
    // Across a month's end.
    expect(reminderOn('2026-11-01', '2026-10-31')).toBe('due_soon')
  })
})

describe('enqueueDueReminders (the daily sweep)', () => {
  it('queues one job per organization with marks due, in its own lane, named by the office’s day', async () => {
    vi.mocked(listOrganizationsWithDueMarks).mockResolvedValue(['org_a', 'org_b'])

    // 23:30 UTC on the 16th is already the 17th in Vienna.
    const sweep = await enqueueDueReminders(new Date('2026-10-16T23:30:00Z'))

    expect(listOrganizationsWithDueMarks).toHaveBeenCalledWith('2026-10-18', 1000)
    expect(sweep).toEqual({ day: '2026-10-17', organizations: 2, queued: 2, already: 0 })
    expect(vi.mocked(withTenant).mock.calls.map(([scope]) => scope)).toEqual([
      { organizationId: 'org_a' },
      { organizationId: 'org_b' },
    ])
    expect(enqueueJob).toHaveBeenCalledWith({
      kind: 'annotation_due_reminders',
      organizationId: 'org_a',
      payload: { day: '2026-10-17', cursor: null, counts: emptyDueReminderCounts() },
      jobId: dueReminderJobId('org_a', '2026-10-17'),
    })
    expect(dueReminderJobId('org_a', '2026-10-17')).not.toBe(dueReminderJobId('org_a', '2026-10-18'))
  })

  it('queues nothing twice on one day: today’s job already there is counted, not an error', async () => {
    vi.mocked(listOrganizationsWithDueMarks).mockResolvedValue(['org_a'])
    const taken = Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'bff_job_queue_pkey' }),
    })
    vi.mocked(enqueueJob).mockRejectedValue(taken)

    await expect(enqueueDueReminders(new Date('2026-10-17T05:00:00Z'))).resolves.toMatchObject({ queued: 0, already: 1 })
  })
})

describe('runDueRemindersSlice (one organization’s job)', () => {
  it('reminds each Zuständige in the row for the mark: near, or overdue', async () => {
    vi.mocked(listDueMarksPage).mockResolvedValue([
      due({ id: 'ann_soon', dueOn: '2026-10-18' }),
      due({ id: 'ann_past', dueOn: '2026-10-10', number: 7, assigneeUserId: 'user_ben' }),
    ])

    const result = await runDueRemindersSlice('org_1', FIRST)

    expect(listDueMarksPage).toHaveBeenCalledWith('org_1', '2026-10-18', null, DUE_REMINDER_PAGE)
    expect(emitted().map((row) => [row.recipientUserId, row.anchorId, row.payload?.variant, row.payload?.reminder])).toEqual([
      ['user_anna', 'ann_soon', 'due_soon', 'due_soon:2026-10-18'],
      ['user_ben', 'ann_past', 'overdue', 'overdue:2026-10-10'],
    ])
    expect(emitted()[0]).toMatchObject({
      type: 'annotation.assigned_to_you',
      actorUserId: null,
      groupKey: 'annotation.assigned_to_you:document:doc_1:ann_soon',
      payload: { dueOn: '2026-10-18', related: '4' },
    })
    expect(result).toEqual({
      done: true,
      payload: {
        day: '2026-10-17',
        cursor: 'ann_past',
        counts: { checked: 2, dueSoon: 1, overdue: 1, already: 0, unreachable: 0, failed: 0 },
      },
    })
    expect(captureServer).toHaveBeenCalledWith({
      event: 'annotation_due_reminders_sent',
      distinctId: null,
      organizationId: 'org_1',
      properties: { checked: 2, due_soon: 1, overdue: 1, already: 0, unreachable: 0, failed: 0 },
    })
  })

  it('tells nobody twice: a row that already says this reminder for this date is left alone', async () => {
    vi.mocked(listDueMarksPage).mockResolvedValue([
      due({ id: 'ann_told', dueOn: '2026-10-18' }),
      // Reminded of when it was near; now it has passed, which upgrades the same row.
      due({ id: 'ann_passed', dueOn: '2026-10-16' }),
    ])
    vi.mocked(readGroupPayloads).mockResolvedValue(
      new Map([
        ['user_anna\nannotation.assigned_to_you:document:doc_1:ann_told', { reminder: 'due_soon:2026-10-18' }],
        ['user_anna\nannotation.assigned_to_you:document:doc_1:ann_passed', { reminder: 'due_soon:2026-10-16' }],
      ])
    )

    const result = await runDueRemindersSlice('org_1', FIRST)

    expect(emitted().map((row) => [row.anchorId, row.payload?.variant])).toEqual([['ann_passed', 'overdue']])
    expect(result.payload.counts).toMatchObject({ already: 1, overdue: 1 })
  })

  it('reminds only a Zuständige who may still open the document, asked once per document', async () => {
    vi.mocked(listDueMarksPage).mockResolvedValue([
      due({ id: 'ann_1', dueOn: '2026-10-18', assigneeUserId: 'user_gone' }),
      due({ id: 'ann_2', dueOn: '2026-10-18' }),
    ])
    vi.mocked(mayOpenDocument).mockResolvedValue(new Set(['user_anna']))

    const result = await runDueRemindersSlice('org_1', FIRST)

    expect(mayOpenDocument).toHaveBeenCalledTimes(1)
    expect(emitted().map((row) => row.recipientUserId)).toEqual(['user_anna'])
    expect(result.payload.counts).toMatchObject({ unreachable: 1, dueSoon: 1 })
  })

  it('goes on from where it got to while pages come back full, and reports only at the end', async () => {
    const full = Array.from({ length: DUE_REMINDER_PAGE }, (_, index) =>
      due({ id: `ann_${String(index).padStart(3, '0')}`, dueOn: '2026-10-30' })
    )
    vi.mocked(listDueMarksPage).mockResolvedValue(full)

    const result = await runDueRemindersSlice('org_1', { ...FIRST, cursor: 'ann_prev' })

    expect(listDueMarksPage).toHaveBeenCalledWith('org_1', '2026-10-18', 'ann_prev', DUE_REMINDER_PAGE)
    expect(result.done).toBe(false)
    expect(result.payload.cursor).toBe(`ann_${String(DUE_REMINDER_PAGE - 1).padStart(3, '0')}`)
    expect(captureServer).not.toHaveBeenCalled()
  })

  it('counts a mark it could not tell and goes on: the next run tells it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(listDueMarksPage).mockResolvedValue([due({ id: 'ann_1', dueOn: '2026-10-18' }), due({ id: 'ann_2', dueOn: '2026-10-18' })])
    vi.mocked(emitInboxItems).mockRejectedValueOnce(new Error('database down'))

    const result = await runDueRemindersSlice('org_1', FIRST)

    expect(result.payload.counts).toMatchObject({ failed: 1, dueSoon: 1 })
  })
})
