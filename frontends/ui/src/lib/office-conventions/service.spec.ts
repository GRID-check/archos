/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({
  claimOfficeConventionsRefresh: vi.fn(),
  listConventionDocuments: vi.fn(),
  officeSourceFingerprint: vi.fn(),
  readOfficeConventions: vi.fn(),
  writeOfficeConventions: vi.fn(),
}))
vi.mock('@/lib/filing/repository', () => ({ listProjectsFolders: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ listProjectsInOrg: vi.fn() }))
vi.mock('@/lib/documents/reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn() }))

import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { listProjectsFolders, type OfficeFolderRow } from '@/lib/filing/repository'
import { listProjectsInOrg } from '@/lib/projects/repository'
import { EXTRACTOR_VERSION, type OfficeConventions } from './extract'
import {
  claimOfficeConventionsRefresh,
  listConventionDocuments,
  officeSourceFingerprint,
  readOfficeConventions,
  writeOfficeConventions,
} from './repository'
import {
  conventionDocumentOf,
  isStale,
  officeConventionsEnabled,
  officeConventionsForTurn,
  openFolders,
  refreshOfficeConventions,
  requestOfficeConventionsRefresh,
} from './service'

const folder = (projectId: string, id: string, path: string, extra: Partial<OfficeFolderRow> = {}): OfficeFolderRow => ({
  id,
  projectId,
  parentId: null,
  path,
  description: null,
  accessMode: 'inherit',
  ...extra,
})

const LEARNED: OfficeConventions = {
  version: EXTRACTOR_VERSION,
  projects: 4,
  folders: [{ path: 'Behörde', projects: 4, of: 4 }],
  filing: [],
  documentNumber: null,
  revisionStyle: null,
  fileDate: null,
}

const stored = (overrides: Record<string, unknown> = {}) => ({
  organizationId: 'org-1',
  conventions: LEARNED,
  extractorVersion: EXTRACTOR_VERSION,
  sourceFingerprint: 'fp-1',
  computedAt: new Date(),
  refreshRequestedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('GRID_OFFICE_CONVENTIONS', 'on')
  vi.mocked(officeSourceFingerprint).mockResolvedValue('fp-1')
  vi.mocked(claimOfficeConventionsRefresh).mockResolvedValue(false)
})

describe('the switch', () => {
  it('is off unless switched on', () => {
    expect(officeConventionsEnabled({})).toBe(false)
    expect(officeConventionsEnabled({ GRID_OFFICE_CONVENTIONS: 'off' })).toBe(false)
    expect(officeConventionsEnabled({ GRID_OFFICE_CONVENTIONS: ' ON ' })).toBe(true)
  })
})

describe('what counts', () => {
  it('leaves out a folder under an own access list and everything below it', () => {
    const open = openFolders([
      folder('p1', 'a', 'Honorare', { accessMode: 'custom' }),
      folder('p1', 'b', 'Honorare/2026', { parentId: 'a' }),
      folder('p1', 'c', 'Behörde'),
    ])
    expect([...open.keys()]).toEqual(['c'])
  })

  it('leaves out a document filed in a folder that does not count, and keeps one at the root', () => {
    const open = openFolders([folder('p1', 'c', 'Behörde')])
    const row = {
      projectId: 'p1',
      folderId: 'c',
      filename: 'a.pdf',
      displayName: 'Bescheid 2026-03-15.pdf',
      createdAt: '2026-03-20T10:00:00Z',
      tags: ['Brandschutz', 'Bescheid'],
      revisionFacts: { documentNumber: 'HUB-01', revision: 'B' },
    }
    expect(conventionDocumentOf(row, open)).toEqual({
      projectId: 'p1',
      folderPath: 'Behörde',
      filename: 'Bescheid 2026-03-15.pdf',
      docType: 'Bescheid',
      documentNumber: 'HUB-01',
      revision: 'B',
      uploadedAt: new Date('2026-03-20T10:00:00Z'),
    })
    expect(conventionDocumentOf({ ...row, folderId: 'restricted' }, open)).toBeNull()
    expect(conventionDocumentOf({ ...row, folderId: null, tags: ['Sonstiges'] }, open)?.docType).toBeNull()
  })
})

describe('isStale', () => {
  it('is stale with no record, no count, another extractor or another fingerprint', () => {
    expect(isStale(null, 'fp')).toBe(true)
    expect(isStale({ conventions: null, extractorVersion: null, sourceFingerprint: null }, 'fp')).toBe(true)
    expect(isStale({ conventions: LEARNED, extractorVersion: EXTRACTOR_VERSION + 1, sourceFingerprint: 'fp' }, 'fp')).toBe(true)
    expect(isStale({ conventions: LEARNED, extractorVersion: EXTRACTOR_VERSION, sourceFingerprint: 'old' }, 'fp')).toBe(true)
    expect(isStale({ conventions: LEARNED, extractorVersion: EXTRACTOR_VERSION, sourceFingerprint: 'fp' }, 'fp')).toBe(false)
  })
})

describe('officeConventionsForTurn', () => {
  it('reads nothing when the switch is off or the question is not about filing or finding', async () => {
    vi.stubEnv('GRID_OFFICE_CONVENTIONS', '')
    expect(await officeConventionsForTurn('org-1', 'Wo liegt der Bescheid?')).toBeNull()
    vi.stubEnv('GRID_OFFICE_CONVENTIONS', 'on')
    expect(await officeConventionsForTurn('org-1', 'Wie hoch darf das Geländer sein?')).toBeNull()
    expect(readOfficeConventions).not.toHaveBeenCalled()
    expect(officeSourceFingerprint).not.toHaveBeenCalled()
  })

  it('serves the stored conventions, header first, and asks for no refresh while they are current', async () => {
    vi.mocked(readOfficeConventions).mockResolvedValue(stored())
    const lines = await officeConventionsForTurn('org-1', 'Wo legen wir das ab?')
    expect(lines?.[0]).toContain('office conventions (counted from 4')
    expect(lines?.[1]).toBe('- folders most projects keep: Behörde (4/4)')
    expect(claimOfficeConventionsRefresh).not.toHaveBeenCalled()
  })

  it('serves a stale count while it claims a refresh, and nothing before the first count', async () => {
    vi.mocked(readOfficeConventions).mockResolvedValue(stored({ sourceFingerprint: 'fp-0' }))
    expect(await officeConventionsForTurn('org-1', 'Wo legen wir das ab?')).not.toBeNull()
    expect(claimOfficeConventionsRefresh).toHaveBeenCalledWith('org-1', 10 * 60 * 1000)

    vi.mocked(readOfficeConventions).mockResolvedValue(null)
    expect(await officeConventionsForTurn('org-1', 'Wo legen wir das ab?')).toBeNull()
  })
})

describe('refreshing', () => {
  it('starts no refresh another turn already claimed', async () => {
    vi.mocked(claimOfficeConventionsRefresh).mockResolvedValue(false)
    expect(await requestOfficeConventionsRefresh('org-1')).toBe(false)
    expect(listProjectsInOrg).not.toHaveBeenCalled()
  })

  it('counts the screened documents of open folders and stores them with the fingerprint read first', async () => {
    const projects = ['p1', 'p2', 'p3']
    vi.mocked(listProjectsInOrg).mockResolvedValue(projects.map((id) => ({ id })) as never)
    vi.mocked(listProjectsFolders).mockResolvedValue(
      projects.flatMap((id) => [
        folder(id, `${id}-b`, 'Behörde'),
        folder(id, `${id}-h`, 'Honorare', { accessMode: 'custom' }),
      ])
    )
    const row = (projectId: string, folderId: string, screeningOutcome: string) => ({
      id: `${projectId}-${folderId}`,
      projectId,
      folderId,
      filename: 'x.pdf',
      displayName: null,
      createdAt: new Date('2026-03-20T10:00:00Z'),
      status: 'completed',
      screeningOutcome,
      tags: ['Bescheid'],
    })
    const rows = projects.flatMap((id) => [row(id, `${id}-b`, 'clean'), row(id, `${id}-h`, 'clean')])
    vi.mocked(listConventionDocuments).mockResolvedValue(rows as never)
    vi.mocked(reconcileDocumentStatuses).mockImplementation(async (input) => input as never)

    const result = await refreshOfficeConventions('org-1')

    expect(result.folders).toEqual([{ path: 'Behörde', projects: 3, of: 3 }])
    expect(result.filing).toEqual([{ docType: 'Bescheid', path: 'Behörde', projects: 3, of: 3 }])
    expect(writeOfficeConventions).toHaveBeenCalledWith('org-1', {
      conventions: result,
      extractorVersion: EXTRACTOR_VERSION,
      sourceFingerprint: 'fp-1',
    })
  })
})
