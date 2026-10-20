/**
 * @vitest-environment node
 *
 * „Als neue Fassung von X ablegen" arrives with the upload as the older
 * document's id (ADR-0099). It is checked with the rules the PUT route applies
 * to the older document, before a byte is stored, and what the ingest job gets
 * is that document's FILE NAME.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BadRequestError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { makeDocument } from '@/test-utils/db-fixtures'

vi.mock('server-only', () => ({}))
vi.mock('./access', () => ({ getAccessibleDocument: vi.fn() }))

import { getAccessibleDocument } from './access'
import { readRevisionOf, resolveRevisionOf, type RevisionUploadTarget } from './revision-upload'

const session = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession
const OLDER_ID = '0b8f3c1e-0d3a-4d2e-9a53-6d1f9d6c2b11'

const target: RevisionUploadTarget = {
  shelf: { kind: 'project', projectId: 'proj-1' },
  collectionName: 'proj_abc',
  filename: 'Grundriss_EG_Index_C.pdf',
}

const older = (overrides: Parameters<typeof makeDocument>[0] = {}) =>
  makeDocument({
    id: OLDER_ID,
    filename: 'Grundriss_EG_Index_B.pdf',
    collectionName: 'proj_abc',
    projectId: 'proj-1',
    status: 'completed',
    contentHash: 'h',
    screenedHash: 'h',
    screeningOutcome: 'clean',
    ...overrides,
  })

beforeEach(() => {
  vi.mocked(getAccessibleDocument).mockReset().mockResolvedValue(older())
})

const linked = (revisionOf: string) => ({ revisionOf, ignored: null })
const nothing = { revisionOf: null, ignored: null }
const ignored = (reason: string) => ({ revisionOf: null, ignored: reason })

describe('resolveRevisionOf', () => {
  it('answers the older file’s name, after asking for WRITE access to the older document', async () => {
    await expect(resolveRevisionOf(session, OLDER_ID, target)).resolves.toEqual(linked('Grundriss_EG_Index_B.pdf'))
    expect(getAccessibleDocument).toHaveBeenCalledWith(session, OLDER_ID, 'write')
  })

  it('has nothing to link when no choice was made', async () => {
    await expect(resolveRevisionOf(session, null, target)).resolves.toEqual(nothing)
    await expect(resolveRevisionOf(session, undefined, target)).resolves.toEqual(nothing)
    expect(getAccessibleDocument).not.toHaveBeenCalled()
  })

  it('ignores the choice when the names are equal: that is a new version (ADR-0054), never a Fassung', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ filename: 'Grundriss_EG_Index_C.pdf' }))

    await expect(resolveRevisionOf(session, OLDER_ID, target)).resolves.toEqual(nothing)
  })

  it('compares names the way the shelf does: one Unicode form', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ filename: 'Küche_Index_B.pdf'.normalize('NFD') }))

    await expect(
      resolveRevisionOf(session, OLDER_ID, { ...target, filename: 'Küche_Index_B.pdf'.normalize('NFC') }),
    ).resolves.toEqual(nothing)
  })

  // The choice is an addition to the upload, never its gate: what may not be
  // honoured is dropped and reported, and the file is stored on its own.
  it('drops an older document in another collection (a restricted folder has its own, ADR-0087), without throwing', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ collectionName: 'proj_restricted' }))

    await expect(resolveRevisionOf(session, OLDER_ID, target)).resolves.toEqual(ignored('different_collection'))
  })

  it('drops an older document on another shelf', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ projectId: 'proj-2' }))
    await expect(resolveRevisionOf(session, OLDER_ID, target)).resolves.toEqual(ignored('different_shelf'))

    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ scope: 'archiv', projectId: null }))
    await expect(resolveRevisionOf(session, OLDER_ID, target)).resolves.toEqual(ignored('different_shelf'))
  })

  it('accepts an Archiv document for an Archiv upload', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ scope: 'archiv', projectId: null }))

    await expect(resolveRevisionOf(session, OLDER_ID, { ...target, shelf: { kind: 'archiv' } })).resolves.toEqual(
      linked('Grundriss_EG_Index_B.pdf'),
    )
  })

  it('drops an archived older document', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ lifecycle: 'archived' }))

    await expect(resolveRevisionOf(session, OLDER_ID, target)).resolves.toEqual(ignored('archived'))
  })

  it('drops an older document that is held (ADR-0086), reported like one that does not exist', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ status: 'quarantined' }))
    await expect(resolveRevisionOf(session, OLDER_ID, target)).resolves.toEqual(ignored('unavailable'))

    // Bytes that were never screened are held the same way.
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ screenedHash: 'other', screeningOutcome: null }))
    await expect(resolveRevisionOf(session, OLDER_ID, target)).resolves.toEqual(ignored('unavailable'))
  })

  it('drops a machine-authored older document: it owns no chunks over there', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(
      older({ authoredBy: 'agent', authoredByProducer: 'research', authoredByRef: 'run-1', authoredByRefKind: 'agent_run' }),
    )

    await expect(resolveRevisionOf(session, OLDER_ID, target)).resolves.toEqual(ignored('unavailable'))
  })

  it('reports a document the reader may not change exactly like one they may not see', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new ForbiddenError())
    await expect(resolveRevisionOf(session, OLDER_ID, target)).resolves.toEqual(ignored('unavailable'))

    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())
    await expect(resolveRevisionOf(session, OLDER_ID, target)).resolves.toEqual(ignored('unavailable'))
  })

  it('still throws what is not about the choice: a failed read is not a dropped link', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new Error('db down'))

    await expect(resolveRevisionOf(session, OLDER_ID, target)).rejects.toThrow('db down')
  })
})

describe('readRevisionOf', () => {
  it('reads the document id', () => {
    expect(readRevisionOf(` ${OLDER_ID} `)).toBe(OLDER_ID)
  })

  it('reads an absent or empty field as no choice', () => {
    expect(readRevisionOf(null)).toBeNull()
    expect(readRevisionOf('')).toBeNull()
    expect(readRevisionOf('  ')).toBeNull()
    expect(readRevisionOf(new File(['x'], 'x.pdf'))).toBeNull()
  })

  it('refuses anything else: a file name is not a document id', () => {
    expect(() => readRevisionOf('Grundriss_EG_Index_B.pdf')).toThrow(BadRequestError)
  })
})
