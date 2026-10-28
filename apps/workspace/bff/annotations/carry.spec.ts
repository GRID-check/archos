/**
 * Where a carried mark goes on to: the end of the chain of documents that
 * replace its own, walked only as far as the reader may open. A link the shelf
 * shows but the reader cannot open (a closed folder) ends the walk at the last
 * document they can; any other failure is not swallowed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/documents/revision-links-loader', () => ({ loadRevisionLinks: vi.fn() }))
vi.mock('@/lib/upload-screening/quarantine-reviewers', () => ({ shelfReaderFor: vi.fn().mockResolvedValue({}) }))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema/documents'
import { getAccessibleDocument } from '@/lib/documents/access'
import { loadRevisionLinks } from '@/lib/documents/revision-links-loader'
import { replacingDocumentOf } from './carry'

const session = { userId: 'user_1', organizationId: 'org_1' } as unknown as AuthorizedSession
const doc = (id: string) => ({ id }) as unknown as Document

/** B → C → D, as the shelf shows the links. */
const CHAIN: Record<string, string> = { B: 'C', C: 'D' }

beforeEach(() => {
  vi.mocked(loadRevisionLinks).mockImplementation(async (_session, [current]) => {
    const next = CHAIN[current!.id]
    return new Map([[current!.id, { supersededBy: next ? { id: next } : null }]]) as never
  })
})

describe('replacingDocumentOf', () => {
  it('walks to the end of the chain', async () => {
    vi.mocked(getAccessibleDocument).mockImplementation(async (_session, id) => doc(id))
    await expect(replacingDocumentOf(session, doc('B'))).resolves.toMatchObject({ id: 'D' })
  })

  it.each([
    ['not found', new NotFoundError('Document')],
    ['forbidden', new ForbiddenError()],
  ])('ends at the last document the reader may open when the next one is %s', async (_label, refusal) => {
    vi.mocked(getAccessibleDocument).mockImplementation(async (_session, id) => {
      if (id === 'D') throw refusal
      return doc(id)
    })
    await expect(replacingDocumentOf(session, doc('B'))).resolves.toMatchObject({ id: 'C' })
  })

  it('answers null when not even the first replacement can be opened', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError('Document'))
    await expect(replacingDocumentOf(session, doc('B'))).resolves.toBeNull()
  })

  it('lets any other failure through', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new Error('connection reset'))
    await expect(replacingDocumentOf(session, doc('B'))).rejects.toThrow('connection reset')
  })
})
