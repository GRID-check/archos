/**
 * @vitest-environment node
 *
 * „Als neue Fassung von X ablegen" arrives with the upload as the older
 * document's id (ADR-0097). It is checked with the rules the PUT route applies
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
import { readFassungOf, resolveFassungOf, type FassungUploadTarget } from './fassung-upload'

const session = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession
const OLDER_ID = '0b8f3c1e-0d3a-4d2e-9a53-6d1f9d6c2b11'

const target: FassungUploadTarget = {
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

describe('resolveFassungOf', () => {
  it('answers the older file’s name, after asking for WRITE access to the older document', async () => {
    await expect(resolveFassungOf(session, OLDER_ID, target)).resolves.toBe('Grundriss_EG_Index_B.pdf')
    expect(getAccessibleDocument).toHaveBeenCalledWith(session, OLDER_ID, 'write')
  })

  it('has nothing to link when no choice was made', async () => {
    await expect(resolveFassungOf(session, null, target)).resolves.toBeNull()
    await expect(resolveFassungOf(session, undefined, target)).resolves.toBeNull()
    expect(getAccessibleDocument).not.toHaveBeenCalled()
  })

  it('ignores the choice when the names are equal: that is a new version (ADR-0054), never a Fassung', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ filename: 'Grundriss_EG_Index_C.pdf' }))

    await expect(resolveFassungOf(session, OLDER_ID, target)).resolves.toBeNull()
  })

  it('compares names the way the shelf does: one Unicode form', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ filename: 'Küche_Index_B.pdf'.normalize('NFD') }))

    await expect(
      resolveFassungOf(session, OLDER_ID, { ...target, filename: 'Küche_Index_B.pdf'.normalize('NFC') }),
    ).resolves.toBeNull()
  })

  it('refuses an older document in another collection (a restricted folder has its own, ADR-0087)', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ collectionName: 'proj_restricted' }))

    await expect(resolveFassungOf(session, OLDER_ID, target)).rejects.toMatchObject({
      details: { reason: 'different_collection' },
    })
  })

  it('refuses an older document on another shelf', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ projectId: 'proj-2' }))
    await expect(resolveFassungOf(session, OLDER_ID, target)).rejects.toMatchObject({
      details: { reason: 'different_shelf' },
    })

    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ scope: 'archiv', projectId: null }))
    await expect(resolveFassungOf(session, OLDER_ID, target)).rejects.toBeInstanceOf(BadRequestError)
  })

  it('accepts an Archiv document for an Archiv upload', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ scope: 'archiv', projectId: null }))

    await expect(resolveFassungOf(session, OLDER_ID, { ...target, shelf: { kind: 'archiv' } })).resolves.toBe(
      'Grundriss_EG_Index_B.pdf',
    )
  })

  it('refuses an archived older document', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ lifecycle: 'archived' }))

    await expect(resolveFassungOf(session, OLDER_ID, target)).rejects.toMatchObject({ details: { reason: 'archived' } })
  })

  it('does not find an older document that is held (ADR-0086), not even to say so', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ status: 'quarantined' }))
    await expect(resolveFassungOf(session, OLDER_ID, target)).rejects.toBeInstanceOf(NotFoundError)

    // Bytes that were never screened are held the same way.
    vi.mocked(getAccessibleDocument).mockResolvedValue(older({ screenedHash: 'other', screeningOutcome: null }))
    await expect(resolveFassungOf(session, OLDER_ID, target)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('does not find a machine-authored older document: it owns no chunks over there', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(
      older({ authoredBy: 'agent', authoredByProducer: 'research', authoredByRef: 'run-1', authoredByRefKind: 'agent_run' }),
    )

    await expect(resolveFassungOf(session, OLDER_ID, target)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('lets the access rule speak: a reader who may not change the older document is refused', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new ForbiddenError())
    await expect(resolveFassungOf(session, OLDER_ID, target)).rejects.toBeInstanceOf(ForbiddenError)

    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())
    await expect(resolveFassungOf(session, OLDER_ID, target)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('readFassungOf', () => {
  it('reads the document id', () => {
    expect(readFassungOf(` ${OLDER_ID} `)).toBe(OLDER_ID)
  })

  it('reads an absent or empty field as no choice', () => {
    expect(readFassungOf(null)).toBeNull()
    expect(readFassungOf('')).toBeNull()
    expect(readFassungOf('  ')).toBeNull()
    expect(readFassungOf(new File(['x'], 'x.pdf'))).toBeNull()
  })

  it('refuses anything else: a file name is not a document id', () => {
    expect(() => readFassungOf('Grundriss_EG_Index_B.pdf')).toThrow(BadRequestError)
  })
})
