/**
 * @vitest-environment node
 */
/** Reading a stored snapshot: an object the store no longer has is a 404, any other failure stays a failure. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/s3', () => ({ s3Client: { send: vi.fn() }, bucketName: 'shared-bucket' }))

import { NotFoundError } from '@/lib/api/errors'
import { s3Client } from '@/lib/s3'
import { readSnapshot } from './viewpoint-snapshot'

const DOC = { storageBucket: null }

beforeEach(() => vi.clearAllMocks())

describe('readSnapshot', () => {
  it('returns the stored bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    vi.mocked(s3Client.send).mockResolvedValue({ Body: { transformToByteArray: async () => bytes } } as never)
    await expect(readSnapshot(DOC, 'k')).resolves.toEqual(bytes)
  })

  it('is a NotFoundError when the object is gone', async () => {
    vi.mocked(s3Client.send).mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchKey' }))
    await expect(readSnapshot(DOC, 'k')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('lets any other failure through', async () => {
    vi.mocked(s3Client.send).mockRejectedValue(new Error('boom'))
    await expect(readSnapshot(DOC, 'k')).rejects.toThrow('boom')
  })
})
