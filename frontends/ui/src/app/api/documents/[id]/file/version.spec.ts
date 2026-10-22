/**
 * @vitest-environment node
 */
/**
 * The route is a thin adapter: it names the document and the version, reads the
 * one query flag, and lets the service's refusals through as their statuses.
 * What the service refuses, and why, is `version-content.spec.ts`'s subject.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'a@grid.test',
    role: 'member',
    permissions: [],
  }),
}))
vi.mock('@/lib/documents/version-content', () => ({ streamVersionFile: vi.fn() }))
vi.mock('@/lib/documents/service', () => ({ streamDocumentFile: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import { streamVersionFile } from '@/lib/documents/version-content'
import { GET } from './route'

const call = (query = '') =>
  GET(new Request(`https://grid.test/api/documents/doc_1/file?versionId=ver_1${query}`) as unknown as NextRequest, {
    params: Promise.resolve({ id: 'doc_1' }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(streamVersionFile).mockResolvedValue(new Response('bytes', { headers: { 'Content-Type': 'application/pdf' } }))
})

describe('GET /api/documents/[id]/file?versionId=', () => {
  it('streams the version the service resolved, for the session, inline by default', async () => {
    const response = await call()

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('bytes')
    expect(streamVersionFile).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1', organizationId: 'org_1' }),
      'doc_1',
      'ver_1',
      { download: false },
    )
  })

  it('asks for an attachment only with download=1', async () => {
    await call('&download=1')
    expect(streamVersionFile).toHaveBeenLastCalledWith(expect.anything(), 'doc_1', 'ver_1', { download: true })

    await call('&download=true')
    expect(streamVersionFile).toHaveBeenLastCalledWith(expect.anything(), 'doc_1', 'ver_1', { download: false })
  })

  it('answers the 404 of a version that is not this document’s, a draft or a held document', async () => {
    vi.mocked(streamVersionFile).mockRejectedValue(new NotFoundError('Version not found'))

    expect((await call()).status).toBe(404)
  })
})
