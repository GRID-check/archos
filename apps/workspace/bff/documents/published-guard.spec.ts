/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { DbTransaction } from '@/lib/storage/repository'
import { assertPublishedVersionIs, PublishedVersionMovedError } from './published-guard'

/** A transaction whose one select answers the document's published pointer. */
function txWith(publishedVersionId: string | null): DbTransaction {
  const query = { from: () => query, where: async () => [{ publishedVersionId }] }
  return { select: () => query } as unknown as DbTransaction
}

describe('assertPublishedVersionIs', () => {
  it('lets the write through while the document still answers from the version read', async () => {
    await expect(assertPublishedVersionIs(txWith('v2'), 'doc', 'org', { publishedVersionId: 'v2' })).resolves.toBeUndefined()
    await expect(assertPublishedVersionIs(txWith(null), 'doc', 'org', { publishedVersionId: null })).resolves.toBeUndefined()
  })

  it('refuses with a 409 that names the current version when another writer published first', async () => {
    const refusal = await assertPublishedVersionIs(txWith('v3'), 'doc', 'org', { publishedVersionId: 'v2' }).catch(
      (error: unknown) => error
    )
    expect(refusal).toBeInstanceOf(PublishedVersionMovedError)
    expect(refusal).toMatchObject({ status: 409, details: { reason: 'stale_base_version', currentVersionId: 'v3' } })
  })
})
