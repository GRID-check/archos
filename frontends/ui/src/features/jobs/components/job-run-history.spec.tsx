/**
 * The run history row, at the width of a phone.
 *
 * Two things were wrong on the row that mattered most. The link to a run's
 * conversation was painted over the status badge, because the badges and the
 * link shared one non-wrapping line; and what a skipped run owed the reader (why
 * it was skipped, and when) lived in `title` attributes, which a touch screen
 * never shows.
 */

import { render, screen } from '@/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { JobRun } from '@/adapters/api/jobs-client'
import { JobRunHistory, runTimeLabel } from './job-run-history'

const listJobRuns = vi.hoisted(() => vi.fn())
vi.mock('@/adapters/api/jobs-client', () => ({ listJobRuns }))
vi.mock('@/adapters/api/research-runs-client', () => ({
  listResearchRuns: vi.fn(async () => ({ jobs: [] })),
}))

const run = (overrides: Partial<JobRun> = {}): JobRun => ({
  id: 'run-1',
  scheduleId: 'j1',
  jobId: null,
  conversationId: 'conv-1',
  trigger: 'schedule',
  status: 'submitted',
  detail: null,
  skillSnapshot: {} as JobRun['skillSnapshot'],
  triggeredBy: null,
  createdAt: new Date().toISOString(),
  ...overrides,
})

beforeEach(() => {
  listJobRuns.mockReset()
})

describe('a run row', () => {
  test('keeps the link on a line of its own on a phone, never beside the badges', async () => {
    listJobRuns.mockResolvedValue([run()])
    render(<JobRunHistory projectId="p1" jobId="j1" />)

    const link = await screen.findByRole('link', { name: /Open chat/ })
    const actions = link.closest('[data-slot="item-actions"]')
    const content = document.querySelector('[data-slot="item-content"]')
    expect(actions?.className).toMatch(/max-sm:w-full/)
    expect(content?.className).toMatch(/max-sm:basis-full/)
    expect(content?.className).toMatch(/\bflex-wrap\b/)
  })

  test('says why a run was skipped, as text a finger can read', async () => {
    listJobRuns.mockResolvedValue([
      run({ status: 'skipped', detail: 'The organization already had the maximum number of active jobs.' }),
    ])
    render(<JobRunHistory projectId="p1" jobId="j1" />)

    expect(await screen.findByTestId('run-detail')).toHaveTextContent(
      'The organization already had the maximum number of active jobs.',
    )
  })
})

describe('when a run happened', () => {
  const now = Date.parse('2026-10-15T12:00:00Z')

  test('is relative for the past week', () => {
    expect(runTimeLabel('2026-10-10T12:00:00Z', 'de', now)).toMatch(/Tagen/)
  })

  test('is the date after it, because the title that carried it is not on a phone', () => {
    expect(runTimeLabel('2026-09-20T12:00:00Z', 'de', now)).toMatch(/20\.09\.2026/)
  })
})
