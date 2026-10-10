/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import { memberReader } from './document-reader'
import type { FassungNames } from './fassung'
import type { FassungSubject } from './fassung-facts'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/folder-access', () => ({ getHiddenFolderIds: vi.fn() }))
vi.mock('./reconcile-status', () => ({ readFassungNames: vi.fn(), refreshCollectionFiles: vi.fn() }))
vi.mock('./repository', () => ({ findFassungCounterparts: vi.fn() }))

import { getHiddenFolderIds } from '@/lib/authz/folder-access'
import { loadFassungFacts } from './fassung-facts'
import { readFassungNames, refreshCollectionFiles } from './reconcile-status'
import { findFassungCounterparts } from './repository'

const session = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession
const reader = memberReader('user-1')

const subject = (overrides: Partial<FassungSubject> = {}): FassungSubject => ({
  id: 'doc-b',
  filename: 'Grundriss_B.pdf',
  collectionName: 'proj_abc',
  authoredBy: 'user',
  publishedVersionId: null,
  ...overrides,
})

const names = (overrides: Partial<FassungNames> = {}): FassungNames => ({
  supersededBy: null,
  supersedes: [],
  suggestion: null,
  change: null,
  ...overrides,
})

const A = { id: 'doc-a', filename: 'Grundriss_A.pdf', projectId: 'p1', folderId: null, createdAt: new Date('2026-07-02T09:00:00Z') }
const HELD = 'Gehaltsliste_intern.xlsx'

describe('loadFassungFacts', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getHiddenFolderIds).mockResolvedValue([])
    vi.mocked(findFassungCounterparts).mockResolvedValue([])
  })

  it('resolves the names of one collection to the documents the reader may see', async () => {
    vi.mocked(readFassungNames).mockResolvedValue(names({ supersedes: [A.filename] }))
    vi.mocked(findFassungCounterparts).mockResolvedValue([A])

    const facts = await loadFassungFacts(session, [subject()], reader)

    expect(facts.get('doc-b')?.supersedes).toEqual([{ id: 'doc-a', filename: 'Grundriss_A.pdf' }])
    // The collection of the document, the reader of the listing, the names asked about.
    expect(findFassungCounterparts).toHaveBeenCalledWith('org-1', 'proj_abc', [A.filename], reader)
  })

  it('never surfaces the name of a document the visibility query did not return (held, archived, deleted)', async () => {
    vi.mocked(readFassungNames).mockResolvedValue(
      names({
        supersededBy: HELD,
        supersedes: [HELD, A.filename],
        suggestion: { of: HELD, confidence: 0.9, reason: `Neuer als ${HELD}`, basis: 'name' },
        change: { text: `Gegenüber ${HELD}: Spalte C entfällt.`, basis: HELD },
      }),
    )
    // The query composes `documentVisibleTo(reader)`: the held row is not returned.
    vi.mocked(findFassungCounterparts).mockResolvedValue([A])

    const facts = await loadFassungFacts(session, [subject()], reader)

    const projected = JSON.stringify([...facts.values()])
    expect(projected).not.toContain(HELD)
    expect(projected).not.toContain('Gehalt')
    expect(facts.get('doc-b')).toEqual({
      supersededBy: null,
      supersedes: [{ id: 'doc-a', filename: 'Grundriss_A.pdf' }],
      suggestion: null,
      changeSummary: null,
      // A's own change line names the held document, so it goes with it.
      history: [{ id: 'doc-a', filename: 'Grundriss_A.pdf', createdAt: '2026-07-02T09:00:00.000Z', changeSummary: null }],
    })
  })

  it('has no entry when everything a document refers to is hidden', async () => {
    vi.mocked(readFassungNames).mockResolvedValue(names({ supersededBy: HELD }))

    const facts = await loadFassungFacts(session, [subject()], reader)

    expect(facts.size).toBe(0)
  })

  it('drops a document in a folder the session may not open (ADR-0087), the Papierkorb included', async () => {
    vi.mocked(readFassungNames).mockResolvedValue(names({ supersedes: [A.filename] }))
    vi.mocked(findFassungCounterparts).mockResolvedValue([{ ...A, folderId: 'folder-closed' }])
    vi.mocked(getHiddenFolderIds).mockResolvedValue(['folder-closed'])

    const facts = await loadFassungFacts(session, [subject()], reader)

    expect(getHiddenFolderIds).toHaveBeenCalledWith(session, 'p1')
    expect(facts.size).toBe(0)
  })

  it('keeps a document in a folder the session may open', async () => {
    vi.mocked(readFassungNames).mockResolvedValue(names({ supersedes: [A.filename] }))
    vi.mocked(findFassungCounterparts).mockResolvedValue([{ ...A, folderId: 'folder-open' }])
    vi.mocked(getHiddenFolderIds).mockResolvedValue(['folder-closed'])

    expect((await loadFassungFacts(session, [subject()], reader)).get('doc-b')?.supersedes).toHaveLength(1)
  })

  it('asks nothing of the database when no document names another', async () => {
    vi.mocked(readFassungNames).mockResolvedValue(names({ change: { text: 'Neu', basis: 'Grundriss_B.pdf' } }))

    const facts = await loadFassungFacts(session, [subject()], reader)

    expect(findFassungCounterparts).not.toHaveBeenCalled()
    expect(facts.get('doc-b')?.changeSummary).toEqual({ text: 'Neu', basis: 'previous' })
  })

  it('reads a machine-authored row for nothing, whatever the listing holds under its name', async () => {
    vi.mocked(readFassungNames).mockResolvedValue(names({ supersedes: [A.filename] }))

    const facts = await loadFassungFacts(session, [subject({ authoredBy: 'agent', publishedVersionId: null })], reader)

    expect(readFassungNames).not.toHaveBeenCalled()
    expect(facts.size).toBe(0)
  })

  it('resolves each collection against its own documents', async () => {
    vi.mocked(readFassungNames).mockImplementation(async (ref) =>
      names({ supersedes: [ref.collectionName === 'proj_abc' ? 'Grundriss_A.pdf' : 'Schnitt_A.pdf'] }),
    )
    vi.mocked(findFassungCounterparts).mockImplementation(async (_org, collection) =>
      collection === 'proj_abc' ? [A] : [{ id: 'doc-s', filename: 'Schnitt_A.pdf', projectId: 'p2', folderId: null, createdAt: null }],
    )

    const facts = await loadFassungFacts(
      session,
      [subject(), subject({ id: 'doc-t', filename: 'Schnitt_B.pdf', collectionName: 'proj_xyz' })],
      reader,
    )

    expect(facts.get('doc-b')?.supersedes[0].id).toBe('doc-a')
    expect(facts.get('doc-t')?.supersedes[0].id).toBe('doc-s')
  })

  it('refreshes each collection once before it reads, when asked', async () => {
    vi.mocked(readFassungNames).mockResolvedValue(null)

    await loadFassungFacts(session, [subject(), subject({ id: 'doc-a', filename: 'Grundriss_A.pdf' })], reader, {
      fresh: true,
    })

    expect(refreshCollectionFiles).toHaveBeenCalledTimes(1)
    expect(refreshCollectionFiles).toHaveBeenCalledWith('proj_abc')
  })

  describe('the history', () => {
    const C = { id: 'doc-c', filename: 'Grundriss_C.pdf', projectId: 'p1', folderId: null, createdAt: new Date('2026-08-14T09:00:00Z') }
    const B = { id: 'doc-b2', filename: 'Grundriss_B.pdf', projectId: 'p1', folderId: null, createdAt: new Date('2026-07-30T09:00:00Z') }
    const byName: Record<string, FassungNames> = {
      'Grundriss_C.pdf': names({ supersedes: ['Grundriss_B.pdf'], change: { text: '- Zufahrt neu', basis: 'Grundriss_B.pdf' } }),
      'Grundriss_B.pdf': names({ supersededBy: 'Grundriss_C.pdf', supersedes: ['Grundriss_A.pdf'], change: { text: '- Stiege verschoben', basis: 'Grundriss_A.pdf' } }),
      'Grundriss_A.pdf': names({ supersededBy: 'Grundriss_B.pdf' }),
    }

    it('lists every older Fassung, newest first, each with its own change line', async () => {
      vi.mocked(readFassungNames).mockImplementation(async (ref) => byName[ref.filename] ?? null)
      vi.mocked(findFassungCounterparts).mockResolvedValue([A, B, C])

      const facts = await loadFassungFacts(session, [subject({ id: 'doc-c', filename: 'Grundriss_C.pdf' })], reader)

      expect(facts.get('doc-c')?.history).toEqual([
        { id: 'doc-b2', filename: 'Grundriss_B.pdf', createdAt: '2026-07-30T09:00:00.000Z', changeSummary: '- Stiege verschoben' },
        { id: 'doc-a', filename: 'Grundriss_A.pdf', createdAt: '2026-07-02T09:00:00.000Z', changeSummary: null },
      ])
    })

    it('stops at a loop instead of walking it forever', async () => {
      vi.mocked(readFassungNames).mockImplementation(async (ref) =>
        ref.filename === 'Grundriss_C.pdf'
          ? names({ supersedes: ['Grundriss_B.pdf'] })
          : names({ supersedes: ['Grundriss_C.pdf'] }),
      )
      vi.mocked(findFassungCounterparts).mockResolvedValue([B, C])

      const facts = await loadFassungFacts(session, [subject({ id: 'doc-c', filename: 'Grundriss_C.pdf' })], reader)

      expect(facts.get('doc-c')?.history?.map((entry) => entry.filename)).toEqual(['Grundriss_B.pdf'])
    })

    it('leaves out an older Fassung the reader may not open, and keeps the ones behind it they may', async () => {
      vi.mocked(readFassungNames).mockImplementation(async (ref) => byName[ref.filename] ?? null)
      // B is held from this reader.
      vi.mocked(findFassungCounterparts).mockResolvedValue([A, C])

      const facts = await loadFassungFacts(session, [subject({ id: 'doc-c', filename: 'Grundriss_C.pdf' })], reader)

      expect(JSON.stringify([...facts.values()])).not.toContain('Grundriss_B')
      expect(facts.get('doc-c')?.history?.map((entry) => entry.filename)).toEqual(['Grundriss_A.pdf'])
    })
  })
})
