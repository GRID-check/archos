/**
 * @vitest-environment node
 */
/** An import tells each Zuständige once, counting their marks (`./import-attention.ts`). */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./attention', () => ({ emitAboutMark: vi.fn().mockResolvedValue(undefined), excerptOf: (text: string) => text }))
vi.mock('@/lib/inbox/best-effort', () => ({ bestEffortInbox: (_label: string, _org: string, write: () => Promise<unknown>) => write() }))

import { emitAboutMark } from './attention'
import { onMarksAssignedByImport } from './import-attention'

beforeEach(() => vi.clearAllMocks())

const mark = (number: number, assigneeUserId: string) => ({ annotationId: `mark_${number}`, number, body: `Mangel ${number}`, assigneeUserId })

describe('onMarksAssignedByImport', () => {
  it('is one counted row per Zuständige, anchored on their first mark and folded on the import', async () => {
    const marks = [...Array.from({ length: 280 }, (_, index) => mark(index + 3, 'user_max')), mark(1, 'user_lea'), mark(2, 'user_anna')]
    await onMarksAssignedByImport({ organizationId: 'org_1', documentId: 'doc_1', projectId: 'p_1', actorUserId: 'user_anna', batchId: 'batch_1', marks })
    expect(emitAboutMark).toHaveBeenCalledTimes(2)
    const [max, lea] = vi.mocked(emitAboutMark).mock.calls
    expect(max[0]).toBe('annotation.assigned_to_you')
    expect(max[1]).toMatchObject({ annotationId: 'mark_3', annotationNumber: 3 })
    expect(max[2]).toEqual(['user_max'])
    expect(max[3]).toMatchObject({ variant: 'imported', groupAnchor: 'import:batch_1', occurrences: 280 })
    expect(lea[2]).toEqual(['user_lea'])
    expect(lea[3]).toMatchObject({ occurrences: 1 })
  })
})
