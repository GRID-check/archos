import { describe, expect, it } from 'vitest'
import { RootSortRequestError } from '@/lib/filing/root-sort-client'
import type { RootSortRunStatus, RootSortRunView, RootSortSummary } from '@/lib/filing/root-sort-types'
import { isSortConflict, isWorking, phaseOf } from './root-sort-phase'

function runWith(status: RootSortRunStatus): RootSortRunView {
  return {
    id: 'run-1',
    status,
    progress: { done: 0, total: 0 },
    unreadable: 0,
    truncated: false,
    review: null,
    moved: 0,
    moveFailures: [],
    error: null,
    groupingError: null,
    createdAt: '2026-10-21T08:00:00.000Z',
  }
}

function summaryWith(run: RootSortRunView | null): RootSortSummary {
  return { files: 3, folders: 2, unreadable: 0, truncated: false, run }
}

describe('phaseOf', () => {
  it('is a load failure when the root could not be read, whatever else is known', () => {
    expect(phaseOf(null, null, true)).toBe('failed')
    expect(phaseOf(summaryWith(runWith('ready')), null, true)).toBe('failed')
  })

  it('is loading until the root has been read', () => {
    expect(phaseOf(null, null, false)).toBe('loading')
  })

  it('is intro when the root has no run yet', () => {
    expect(phaseOf(summaryWith(null), null, false)).toBe('intro')
  })

  it('shows the latest run of the root when the dialog follows none', () => {
    expect(phaseOf(summaryWith(runWith('judging')), null, false)).toBe('working')
    expect(phaseOf(summaryWith(runWith('ready')), null, false)).toBe('review')
    expect(phaseOf(summaryWith(runWith('applied')), null, false)).toBe('done')
  })

  it('shows the run the dialog follows over the one the root reported', () => {
    expect(phaseOf(summaryWith(runWith('judging')), runWith('ready'), false)).toBe('review')
    expect(phaseOf(summaryWith(runWith('ready')), runWith('applying'), false)).toBe('working')
  })

  it('shows a run the dialog follows before the root has been read', () => {
    expect(phaseOf(null, runWith('grouping'), false)).toBe('working')
  })

  it.each(['judging', 'grouping', 'applying', 'undoing'] as const)('is working for %s', (status) => {
    expect(phaseOf(summaryWith(null), runWith(status), false)).toBe('working')
  })

  it('is review for a run that waits on the person', () => {
    expect(phaseOf(summaryWith(null), runWith('ready'), false)).toBe('review')
  })

  it('is done for an applied run', () => {
    expect(phaseOf(summaryWith(null), runWith('applied'), false)).toBe('done')
  })

  it('is undone for an undone run', () => {
    expect(phaseOf(summaryWith(null), runWith('undone'), false)).toBe('undone')
  })

  it('is cancelled for a cancelled run', () => {
    expect(phaseOf(summaryWith(null), runWith('cancelled'), false)).toBe('cancelled')
  })

  it('is failed for a failed run', () => {
    expect(phaseOf(summaryWith(null), runWith('failed'), false)).toBe('failed')
  })
})

describe('isWorking', () => {
  it('is true for the four statuses the server works and false for the rest', () => {
    expect(isWorking('judging')).toBe(true)
    expect(isWorking('grouping')).toBe(true)
    expect(isWorking('applying')).toBe(true)
    expect(isWorking('undoing')).toBe(true)
    expect(isWorking('ready')).toBe(false)
    expect(isWorking('applied')).toBe(false)
    expect(isWorking('undone')).toBe(false)
    expect(isWorking('cancelled')).toBe(false)
    expect(isWorking('failed')).toBe(false)
  })
})

describe('isSortConflict', () => {
  it('is true only for a 409 from the root-sort client', () => {
    expect(isSortConflict(new RootSortRequestError(409, 'A sort of this shelf is already running.'))).toBe(true)
    expect(isSortConflict(new RootSortRequestError(500, 'boom'))).toBe(false)
    expect(isSortConflict(new Error('network'))).toBe(false)
    expect(isSortConflict('409')).toBe(false)
  })
})
