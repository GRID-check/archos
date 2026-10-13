/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/documents/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/repository')>()),
  findDocumentTenancy: vi.fn(),
}))
vi.mock('@/lib/authz/folder-access', () => ({
  clearanceOf: vi.fn(),
  requireFolderWrite: vi.fn(),
}))

import type { AuthorizedSession } from '@/lib/auth/types'
import { requireFolderWrite } from '@/lib/authz/folder-access'
import { findDocumentTenancy } from '@/lib/documents/repository'
import { SHAREABLE_RESOURCE_TYPES } from '@/lib/db/schema'
import { SHAREABLE_REGISTRY, describeResource } from './registry'

const session = { userId: 'user_me', organizationId: 'org_1' } as unknown as AuthorizedSession

describe('SHAREABLE_REGISTRY', () => {
  it('registers every shareable type', () => {
    expect(Object.keys(SHAREABLE_REGISTRY).sort()).toEqual([...SHAREABLE_RESOURCE_TYPES].sort())
  })

  it('conversation and document both persist visibility through the descriptor', () => {
    expect(typeof describeResource('conversation').setVisibility).toBe('function')
    expect(typeof describeResource('document').setVisibility).toBe('function')
  })

  it('reads declared descriptor fields instead of leaving them unread', () => {
    const document = describeResource('document')
    expect(document.defaultVisibility).toBe('project')
    expect(document.supportsMentions).toBe(false)
    expect(document.labelKey).toBe('document')
    expect(document.deepLink('doc-1', { projectId: 'p1' })).toBe('/app/projects/p1/files?doc=doc-1')
  })
})

describe('a document deep link to a mark', () => {
  const link = describeResource('document').deepLink

  it('opens the Prüfansicht at the mark in the project, with the params the preview pane answers', () => {
    expect(link('doc-1', { projectId: 'p1', markId: 'ann-1' })).toBe(
      '/app/projects/p1/files?doc=doc-1&review=1&mark=ann-1',
    )
  })

  it('does the same for a Büroablage document', () => {
    expect(link('doc-1', { markId: 'ann-1' })).toBe('/app/archiv?doc=doc-1&review=1&mark=ann-1')
  })

  it('does not read a plain anchor as a mark: a Fassung anchors its rows too', () => {
    expect(link('doc-1', { projectId: 'p1', anchorId: 'version-9' })).toBe('/app/projects/p1/files?doc=doc-1')
  })

  it('encodes the ids', () => {
    expect(link('a b', { projectId: 'p', markId: 'x&y' })).toBe('/app/projects/p/files?doc=a%20b&review=1&mark=x%26y')
  })
})

describe('a document is changed by writing in its folder (ADR-0088)', () => {
  const tenancy = (folderId: string | null, projectId: string | null = 'proj_1') =>
    ({ organizationId: 'org_1', projectId, folderId, visibility: 'project', createdBy: 'u', filename: 'a.pdf', displayName: null }) as never

  beforeEach(() => vi.clearAllMocks())

  it('asks requireFolderWrite for the folder the document is filed in', async () => {
    vi.mocked(findDocumentTenancy).mockResolvedValue(tenancy('folder_vertraege'))

    await describeResource('document').requireWriteAccess?.(session, 'doc_1')

    expect(requireFolderWrite).toHaveBeenCalledWith(session, 'proj_1', ['folder_vertraege'])
  })

  it('asks for the project root when the document is unfiled, and for nothing outside a project', async () => {
    vi.mocked(findDocumentTenancy).mockResolvedValue(tenancy(null))
    await describeResource('document').requireWriteAccess?.(session, 'doc_1')
    expect(requireFolderWrite).toHaveBeenCalledWith(session, 'proj_1', [null])

    vi.mocked(requireFolderWrite).mockClear()
    vi.mocked(findDocumentTenancy).mockResolvedValue(tenancy(null, null))
    await describeResource('document').requireWriteAccess?.(session, 'doc_1')
    expect(requireFolderWrite).not.toHaveBeenCalled()
  })

  it('has no write rule of its own for a conversation: its role is the rule', () => {
    expect(describeResource('conversation').requireWriteAccess).toBeUndefined()
  })
})
