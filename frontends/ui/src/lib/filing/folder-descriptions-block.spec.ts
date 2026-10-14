/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({ listDescribedFolders: vi.fn() }))
vi.mock('@/lib/authz/folder-access-repository', () => ({ listProjectFolderTree: vi.fn() }))
vi.mock('@/lib/upload-screening/service', () => ({
  maskChatText: vi.fn(async (_org: string, text: string) => ({ text: text.replace('Lohnzettel', '[…]'), findings: [] })),
}))

import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { buildFolderDescriptionsBlock, FOLDER_DESCRIPTIONS_HEADER } from './folder-descriptions-block'
import { listDescribedFolders } from './repository'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listProjectFolderTree).mockResolvedValue([
    { id: 'f-bescheide', parentId: null, accessMode: 'inherit', everyoneReads: false },
    { id: 'f-honorare', parentId: null, accessMode: 'custom', everyoneReads: false },
    { id: 'f-2026', parentId: 'f-honorare', accessMode: 'inherit', everyoneReads: false },
  ])
})

describe('buildFolderDescriptionsBlock', () => {
  it('lists the described folders every member reads, on both shelves, with their descriptions masked', async () => {
    vi.mocked(listDescribedFolders).mockResolvedValue([
      { id: 'f-bescheide', scope: 'project', path: 'Bescheide', description: 'Bescheide der Behörden, keine Lohnzettel' },
      { id: 'f-honorare', scope: 'project', path: 'Honorare', description: 'Honorarnoten' },
      { id: 'f-2026', scope: 'project', path: 'Honorare/2026', description: 'Honorarnoten 2026' },
      { id: 'f-normen', scope: 'archiv', path: 'Normen', description: 'Gekaufte ÖNORMEN' },
    ])
    expect(await buildFolderDescriptionsBlock('org-1', 'proj-1')).toBe(
      [
        FOLDER_DESCRIPTIONS_HEADER,
        '- [Projekt | Bescheide] "Bescheide der Behörden, keine […]"',
        '- [Büroablage | Normen] "Gekaufte ÖNORMEN"',
      ].join('\n')
    )
    expect(listDescribedFolders).toHaveBeenCalledWith('org-1', 'proj-1')
  })

  it('is no block when nothing the channel may name is described', async () => {
    vi.mocked(listDescribedFolders).mockResolvedValue([
      { id: 'f-honorare', scope: 'project', path: 'Honorare', description: 'Honorarnoten' },
    ])
    expect(await buildFolderDescriptionsBlock('org-1', 'proj-1')).toBeNull()
  })

  it('reads only the Büroablage outside a project', async () => {
    vi.mocked(listDescribedFolders).mockResolvedValue([])
    expect(await buildFolderDescriptionsBlock('org-1', null)).toBeNull()
    expect(listProjectFolderTree).not.toHaveBeenCalled()
  })
})
