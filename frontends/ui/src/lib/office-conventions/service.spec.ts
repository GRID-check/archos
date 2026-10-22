/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({
  claimOfficeConventionsRefresh: vi.fn(),
  deleteConventionDecision: vi.fn(),
  listAcceptedMoves: vi.fn(),
  listConventionDecisions: vi.fn(),
  saveConventionDecision: vi.fn(),
  listConventionDocuments: vi.fn(),
  officeSourceFingerprint: vi.fn(),
  readOfficeConventions: vi.fn(),
  writeOfficeConventions: vi.fn(),
}))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn() }))
vi.mock('@/lib/filing/repository', () => ({ listProjectsFolders: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ listProjectsInOrg: vi.fn() }))
vi.mock('@/lib/documents/reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn() }))

import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { listProjectsFolders, type OfficeFolderRow } from '@/lib/filing/repository'
import { listProjectsInOrg } from '@/lib/projects/repository'
import { EXTRACTOR_VERSION, type OfficeConventions } from './extract'
import {
  claimOfficeConventionsRefresh,
  deleteConventionDecision,
  listAcceptedMoves,
  listConventionDecisions,
  saveConventionDecision,
  listConventionDocuments,
  officeSourceFingerprint,
  readOfficeConventions,
  writeOfficeConventions,
} from './repository'
import {
  conventionDocumentOf,
  conventionMovesOf,
  decideOfficeConvention,
  listOfficeConventions,
  UnknownConventionLineError,
  isStale,
  officeConventionsEnabled,
  forgetOfficeFingerprints,
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
  forgetOfficeFingerprints()
  vi.unstubAllEnvs()
  vi.mocked(isOrgFeatureEnabled).mockResolvedValue(true)
  vi.mocked(officeSourceFingerprint).mockResolvedValue('fp-1')
  vi.mocked(claimOfficeConventionsRefresh).mockResolvedValue(false)
  vi.mocked(listConventionDecisions).mockResolvedValue([])
  vi.mocked(listAcceptedMoves).mockResolvedValue([])
})

describe('the switch', () => {
  it('is the office-conventions flag of the organization', async () => {
    vi.mocked(isOrgFeatureEnabled).mockImplementation(async (_flag, org) => org === 'org-on')
    expect(await officeConventionsEnabled('org-on')).toBe(true)
    expect(await officeConventionsEnabled('org-off')).toBe(false)
    expect(isOrgFeatureEnabled).toHaveBeenCalledWith('office-conventions', 'org-off')
  })

  it('no longer reads the environment variable', async () => {
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(false)
    vi.stubEnv('GRID_OFFICE_CONVENTIONS', 'on')
    expect(await officeConventionsEnabled('org-1')).toBe(false)
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

describe('listOfficeConventions with the flag off', () => {
  it('says so and asks for no refresh', async () => {
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(false)
    vi.mocked(readOfficeConventions).mockResolvedValue(stored({ sourceFingerprint: 'fp-0' }))

    const view = await listOfficeConventions('org-1')

    expect(view.enabled).toBe(false)
    expect(claimOfficeConventionsRefresh).not.toHaveBeenCalled()
  })
})

describe('officeConventionsForTurn', () => {
  it('reads nothing when the flag is off or the question is not about filing or finding', async () => {
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(false)
    expect(await officeConventionsForTurn('org-1', 'Wo liegt der Bescheid?')).toBeNull()
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(true)
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

describe('the fingerprint', () => {
  it('is read once a minute per organization, not on every turn that asks where things are', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-21T10:00:00Z') })
    try {
      vi.mocked(readOfficeConventions).mockResolvedValue(stored())
      await officeConventionsForTurn('org-1', 'Wo legen wir das ab?')
      await officeConventionsForTurn('org-1', 'Wo finde ich den Bescheid?')
      await officeConventionsForTurn('org-2', 'Wo finde ich den Bescheid?')
      expect(vi.mocked(officeSourceFingerprint).mock.calls).toEqual([['org-1'], ['org-2']])

      vi.advanceTimersByTime(61_000)
      await officeConventionsForTurn('org-1', 'Wo legen wir das ab?')
      expect(officeSourceFingerprint).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
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

describe('accepted moves', () => {
  const open = openFolders([folder('p1', 'c', 'Behörde'), folder('p1', 'r', 'Honorare', { accessMode: 'custom' })])
  const documents = [{ projectId: 'p1', filename: 'Schreiben MA 37.pdf', docType: 'Bescheid' }]

  it('places a move by the document name and an open target folder', () => {
    expect(
      conventionMovesOf([{ projectId: 'p1', document: 'schreiben ma 37.pdf', folderPath: '02_Behörde' }], documents, open)
    ).toEqual([{ projectId: 'p1', docType: 'Bescheid', folderPath: '02_Behörde' }])
  })

  it('drops a move whose document is unknown, has no Dokumentart, or whose folder does not count', () => {
    const moves = [
      { projectId: 'p1', document: 'Anderes.pdf', folderPath: 'Behörde' },
      { projectId: 'p1', document: 'Schreiben MA 37.pdf', folderPath: 'Honorare' },
      { projectId: 'p2', document: 'Schreiben MA 37.pdf', folderPath: 'Behörde' },
    ]
    expect(conventionMovesOf(moves, documents, open)).toEqual([])
    expect(
      conventionMovesOf(
        [{ projectId: 'p1', document: 'x.pdf', folderPath: 'Behörde' }],
        [{ projectId: 'p1', filename: 'x.pdf', docType: null }],
        open
      )
    ).toEqual([])
  })

  it('teaches the refresh: accepted moves in three projects make the line though no document sits there', async () => {
    const projects = ['p1', 'p2', 'p3']
    vi.mocked(officeSourceFingerprint).mockResolvedValue('fp-1')
    vi.mocked(listProjectsInOrg).mockResolvedValue(projects.map((id) => ({ id })) as never)
    vi.mocked(listProjectsFolders).mockResolvedValue(
      projects.flatMap((id) => [folder(id, `${id}-b`, 'Behörde'), folder(id, `${id}-k`, 'Korrespondenz')])
    )
    // The letter still sits in Korrespondenz in the documents read; the person's accepted move is the signal.
    vi.mocked(listConventionDocuments).mockResolvedValue(
      projects.map((id) => ({
        projectId: id,
        folderId: `${id}-k`,
        filename: 'Schreiben.pdf',
        displayName: null,
        createdAt: new Date('2026-03-20T10:00:00Z'),
        status: 'completed',
        screeningOutcome: 'clean',
        tags: ['Bescheid'],
      })) as never
    )
    vi.mocked(reconcileDocumentStatuses).mockImplementation(async (input) => input as never)
    vi.mocked(listAcceptedMoves).mockResolvedValue(
      projects.map((id) => ({ projectId: id, document: 'Schreiben.pdf', folderPath: 'Behörde' }))
    )

    const result = await refreshOfficeConventions('org-1')

    expect(result.filing).toEqual([{ docType: 'Bescheid', path: 'Behörde', projects: 3, of: 3 }])
  })
})

describe('the office decides', () => {
  const learned: OfficeConventions = { ...LEARNED, filing: [{ docType: 'Gutachten', path: 'Behörde', projects: 4, of: 4 }] }

  it('lists the counted lines with the decision laid over them', async () => {
    vi.mocked(readOfficeConventions).mockResolvedValue(stored({ conventions: learned }) as never)
    vi.mocked(listConventionDecisions).mockResolvedValue([
      {
        lineKey: 'folder:behörde',
        decision: 'declined',
        line: { kind: 'folder', key: 'folder:behörde', path: 'Behörde', projects: 4, of: 4 },
        decidedBy: 'user-1',
        decidedAt: new Date('2026-10-22T08:00:00Z'),
      },
    ])
    const view = await listOfficeConventions('org-1')
    expect(view.enabled).toBe(true)
    expect(view.projects).toBe(4)
    expect(view.lines.map((entry) => [entry.line.key, entry.decision])).toEqual([
      ['filing:gutachten>behörde', null],
      ['folder:behörde', 'declined'],
    ])
  })

  it('keeps a snapshot with the decision, and refuses a key that names no line', async () => {
    vi.mocked(readOfficeConventions).mockResolvedValue(stored({ conventions: learned }) as never)
    await decideOfficeConvention('org-1', 'user-1', { lineKey: 'filing:gutachten>behörde', decision: 'confirmed' })
    expect(saveConventionDecision).toHaveBeenCalledWith('org-1', {
      lineKey: 'filing:gutachten>behörde',
      decision: 'confirmed',
      line: { kind: 'filing', key: 'filing:gutachten>behörde', docType: 'Gutachten', path: 'Behörde', projects: 4, of: 4 },
      decidedBy: 'user-1',
    })
    await expect(decideOfficeConvention('org-1', 'user-1', { lineKey: 'nope', decision: 'declined' })).rejects.toBeInstanceOf(
      UnknownConventionLineError
    )
  })

  it('takes a decision back without needing the line to be counted', async () => {
    await decideOfficeConvention('org-1', 'user-1', { lineKey: 'gone', decision: 'undecided' })
    expect(deleteConventionDecision).toHaveBeenCalledWith('org-1', 'gone')
  })

  it('sends a turn no declined line and always a confirmed one', async () => {
    vi.mocked(readOfficeConventions).mockResolvedValue(stored({ conventions: learned }) as never)
    vi.mocked(listConventionDecisions).mockResolvedValue([
      {
        lineKey: 'filing:gutachten>behörde',
        decision: 'declined',
        line: { kind: 'filing', key: 'filing:gutachten>behörde', docType: 'Gutachten', path: 'Behörde', projects: 4, of: 4 },
        decidedBy: 'user-1',
        decidedAt: new Date(),
      },
      {
        lineKey: 'file_date:YYYYMMDD',
        decision: 'confirmed',
        line: { kind: 'file_date', key: 'file_date:YYYYMMDD', format: 'YYYYMMDD', projects: 3, of: 8 },
        decidedBy: 'user-1',
        decidedAt: new Date(),
      },
    ])
    const lines = (await officeConventionsForTurn('org-1', 'Wo liegt das Gutachten?')) ?? []
    expect(lines.join('\n')).not.toContain('Gutachten usually filed')
    expect(lines.join('\n')).toContain('file names usually write a date as YYYYMMDD (confirmed by the office)')
  })
})
