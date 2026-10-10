/**
 * @vitest-environment node
 *
 * What the dropped names continue on a shelf (ADR-0097): the grammar decides
 * which documents belong to a series, the database only narrows, and a
 * document a person already replaced is not what a new file continues.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { FassungNames } from './fassung'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/authz/folder-access', () => ({ getHiddenFolderIds: vi.fn().mockResolvedValue(['hidden-folder']) }))
vi.mock('@/lib/upload-screening/quarantine-reviewers', () => ({
  shelfReaderFor: vi.fn().mockResolvedValue({ kind: 'member', userId: 'user-1' }),
}))
vi.mock('./fassung-candidates-repository', () => ({ findFassungSeriesRows: vi.fn() }))
vi.mock('./reconcile-status', () => ({ readFassungNames: vi.fn() }))

import { requireProjectAccess } from '@/lib/authz/projects'
import { findFassungSeriesRows, type FassungSeriesRow } from './fassung-candidates-repository'
import { fassungCandidatesOnShelf, probeProjectFassungCandidates } from './fassung-candidates'
import { readFassungNames } from './reconcile-status'

const session = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession
const reader = { kind: 'member', userId: 'user-1' } as const

const row = (id: string, filename: string, createdAt = '2026-07-02T10:00:00Z'): FassungSeriesRow => ({
  id,
  filename,
  displayName: null,
  folderId: null,
  createdAt: new Date(createdAt),
  collectionName: 'proj_abc',
  authoredBy: 'user',
  publishedVersionId: null,
})

const names = (overrides: Partial<FassungNames> = {}): FassungNames => ({
  supersededBy: null,
  supersedes: [],
  suggestion: null,
  change: null,
  ...overrides,
})

const ask = (dropped: string[]) =>
  fassungCandidatesOnShelf({ kind: 'project', projectId: 'p1' }, 'org-1', dropped, { reader })

beforeEach(() => {
  vi.mocked(findFassungSeriesRows).mockReset().mockResolvedValue([])
  vi.mocked(readFassungNames).mockReset().mockResolvedValue(null)
})

describe('fassungCandidatesOnShelf', () => {
  it('offers the one current document of the series a newer name continues, unambiguously', async () => {
    vi.mocked(findFassungSeriesRows).mockResolvedValue([row('b', 'EG_Grundriss_Index_B_2026-07-02.pdf')])

    await expect(ask(['EG_Grundriss_Index_C_2026-08-14.pdf'])).resolves.toEqual([
      {
        name: 'EG_Grundriss_Index_C_2026-08-14.pdf',
        candidates: [
          {
            id: 'b',
            filename: 'EG_Grundriss_Index_B_2026-07-02.pdf',
            displayName: null,
            label: 'Index B · 02.07.2026',
          },
        ],
        newer: true,
        unambiguous: true,
      },
    ])
  })

  it('narrows the shelf by the series’ longest plain word, and asks nothing for names without a series', async () => {
    await ask(['EG_Grundriss_Index_C.pdf', 'Baubeschreibung.pdf', 'Notiz.txt'])

    expect(findFassungSeriesRows).toHaveBeenCalledTimes(1)
    expect(findFassungSeriesRows).toHaveBeenCalledWith(
      { kind: 'project', projectId: 'p1' },
      'org-1',
      ['grundriss'],
      { reader },
    )
  })

  it('does not even look at the shelf when no name reads as part of a series', async () => {
    await expect(ask(['Baubeschreibung.pdf', 'Vertrag.pdf'])).resolves.toEqual([])
    expect(findFassungSeriesRows).not.toHaveBeenCalled()
  })

  it('lists a name that is not newer than the document on the shelf as unclear, never as a successor', async () => {
    vi.mocked(findFassungSeriesRows).mockResolvedValue([row('c', 'EG_Grundriss_Index_C.pdf')])

    const offers = await ask(['EG_Grundriss_Index_B.pdf'])

    expect(offers).toHaveLength(1)
    expect(offers[0]).toMatchObject({ candidates: [{ id: 'c' }], newer: false, unambiguous: false })
  })

  it('offers nothing across formats: a DWG is not the next Fassung of a PDF', async () => {
    vi.mocked(findFassungSeriesRows).mockResolvedValue([row('b', 'EG_Grundriss_Index_B.pdf')])

    await expect(ask(['EG_Grundriss_Index_C.dwg'])).resolves.toEqual([])
  })

  it('offers nothing for a name the shelf already holds: that is a new version', async () => {
    vi.mocked(findFassungSeriesRows).mockResolvedValue([row('c', 'EG_Grundriss_Index_C.pdf'), row('b', 'EG_Grundriss_Index_B.pdf')])

    await expect(ask(['EG_Grundriss_Index_C.pdf'])).resolves.toEqual([])
  })

  it('leaves out a document a person already replaced, and offers the one that replaced it', async () => {
    vi.mocked(findFassungSeriesRows).mockResolvedValue([
      row('a', 'EG_Grundriss_Index_A.pdf'),
      row('b', 'EG_Grundriss_Index_B.pdf'),
    ])
    vi.mocked(readFassungNames).mockImplementation(async (ref) =>
      ref.filename === 'EG_Grundriss_Index_A.pdf' ? names({ supersededBy: 'EG_Grundriss_Index_B.pdf' }) : null,
    )

    const [offer] = await ask(['EG_Grundriss_Index_C.pdf'])

    expect(offer.candidates.map((candidate) => candidate.id)).toEqual(['b'])
    expect(offer.unambiguous).toBe(true)
  })

  it('lists several current documents, newest first, and is not unambiguous', async () => {
    vi.mocked(findFassungSeriesRows).mockResolvedValue([
      row('a', 'EG_Grundriss_Index_A.pdf'),
      row('b', 'EG_Grundriss_Index_B.pdf'),
    ])

    const [offer] = await ask(['EG_Grundriss_Index_C.pdf'])

    expect(offer.candidates.map((candidate) => candidate.id)).toEqual(['b', 'a'])
    expect(offer).toMatchObject({ newer: true, unambiguous: false })
  })

  it('does not take a document of another series that merely shares the word', async () => {
    vi.mocked(findFassungSeriesRows).mockResolvedValue([row('x', 'EG_Grundriss_Statik_Index_B.pdf')])

    await expect(ask(['EG_Grundriss_Index_C.pdf'])).resolves.toEqual([])
  })

  it('answers each dropped name of a series, and each series on its own', async () => {
    vi.mocked(findFassungSeriesRows).mockResolvedValue([
      row('b', 'EG_Grundriss_Index_B.pdf'),
      row('s', 'Schnitt_AA_Index_1.pdf'),
    ])

    const offers = await ask(['EG_Grundriss_Index_C.pdf', 'EG_Grundriss_Index_D.pdf', 'Schnitt_AA_Index_2.pdf'])

    expect(offers.map((offer) => [offer.name, offer.candidates[0].id])).toEqual([
      ['EG_Grundriss_Index_C.pdf', 'b'],
      ['EG_Grundriss_Index_D.pdf', 'b'],
      ['Schnitt_AA_Index_2.pdf', 's'],
    ])
  })

  it('names the document the way the shelf shows it: with its rename', async () => {
    vi.mocked(findFassungSeriesRows).mockResolvedValue([{ ...row('b', 'EG_Grundriss_Index_B.pdf'), displayName: 'Grundriss EG' }])

    const [offer] = await ask(['EG_Grundriss_Index_C.pdf'])

    expect(offer.candidates[0].displayName).toBe('Grundriss EG')
  })
})

describe('probeProjectFassungCandidates', () => {
  it('asks for project:view like the name probe, and reads as the caller does: hidden folders out', async () => {
    await probeProjectFassungCandidates(session, 'p1', ['EG_Grundriss_Index_C.pdf'])

    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'p1', 'project:view')
    expect(findFassungSeriesRows).toHaveBeenCalledWith(
      { kind: 'project', projectId: 'p1' },
      'org-1',
      ['grundriss'],
      { hiddenFolderIds: ['hidden-folder'], reader },
    )
  })
})
