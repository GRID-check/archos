/**
 * @vitest-environment node
 */
/**
 * A BCF import's hand-over row outlives the one mark it anchors on
 * (`./import-rows.ts`): settled with it, it stands back up on the person's next
 * open mark of the import, counting what remains, until none does.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/inbox/service', () => ({
  resolveInboxItemsAnchoredOn: vi.fn().mockResolvedValue(1),
  markInboxItemsInertAnchoredOn: vi.fn().mockResolvedValue(1),
}))
vi.mock('@/lib/inbox/folded-rows-repository', () => ({ standingFoldedRows: vi.fn(), reanchorFoldedRow: vi.fn() }))
vi.mock('./import-repository', () => ({ openImportedMarksOf: vi.fn() }))
vi.mock('@/lib/events/bus', () => ({ publishToUser: vi.fn().mockResolvedValue(undefined) }))

import { reanchorFoldedRow, standingFoldedRows } from '@/lib/inbox/folded-rows-repository'
import { markInboxItemsInertAnchoredOn as markInertInInbox, resolveInboxItemsAnchoredOn as resolveInInbox } from '@/lib/inbox/service'
import { openImportedMarksOf } from './import-repository'
import { markInboxItemsInertAnchoredOn, resolveInboxItemsAnchoredOn } from './import-rows'

const ROW = {
  id: 'row_1',
  recipientUserId: 'user_max',
  groupKey: 'annotation.assigned_to_you:document:doc_1:import:batch_1',
  resourceId: 'doc_1',
  payload: { subject: 'Haus A.ifc', related: '3', excerpt: 'Mangel 3', openMarks: 3 },
}
const settle = { organizationId: 'org_1', types: ['annotation.assigned_to_you'] as const, anchorId: 'mark_3' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(standingFoldedRows).mockResolvedValue([ROW])
})

describe('an import’s hand-over row', () => {
  it('moves to the person’s next open mark of the import when its mark is closed, counting what remains', async () => {
    vi.mocked(openImportedMarksOf).mockResolvedValue([
      { id: 'mark_4', number: 4, body: 'Mangel 4' },
      { id: 'mark_9', number: 9, body: 'Mangel 9' },
    ])
    await resolveInboxItemsAnchoredOn(settle)
    expect(resolveInInbox).toHaveBeenCalledWith(settle)
    expect(openImportedMarksOf).toHaveBeenCalledWith({ organizationId: 'org_1', documentId: 'doc_1', importBatchId: 'batch_1', assigneeUserId: 'user_max' })
    expect(reanchorFoldedRow).toHaveBeenCalledWith({
      organizationId: 'org_1',
      id: 'row_1',
      anchorId: 'mark_4',
      payload: { subject: 'Haus A.ifc', related: '4', excerpt: 'Mangel 4', mentions: [], openMarks: 2 },
    })
  })

  it('stays settled once none of the person’s marks of the import is open', async () => {
    vi.mocked(openImportedMarksOf).mockResolvedValue([])
    await resolveInboxItemsAnchoredOn(settle)
    expect(reanchorFoldedRow).not.toHaveBeenCalled()
  })

  it('does the same when its mark is deleted', async () => {
    vi.mocked(openImportedMarksOf).mockResolvedValue([{ id: 'mark_4', number: 4, body: 'Mangel 4' }])
    await markInboxItemsInertAnchoredOn({ ...settle, types: ['annotation.assigned_to_you', 'annotation.activity'] })
    expect(markInertInInbox).toHaveBeenCalled()
    expect(reanchorFoldedRow).toHaveBeenCalledWith(expect.objectContaining({ anchorId: 'mark_4' }))
  })

  it('leaves every other write alone', async () => {
    await resolveInboxItemsAnchoredOn({ ...settle, types: ['annotation.mentioned'] })
    expect(standingFoldedRows).not.toHaveBeenCalled()
    expect(resolveInInbox).toHaveBeenCalledTimes(1)
  })
})
