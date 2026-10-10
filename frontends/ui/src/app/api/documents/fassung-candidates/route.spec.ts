/**
 * @vitest-environment node
 *
 * The Fassung probe's two routes, driven THROUGH the typed client (ADR-0055):
 * the upload dialog's „Als neue Fassung von X ablegen" asks them with the name
 * probe's bodies (ADR-0098).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    email: 'a@b.test',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'admin',
    permissions: [],
    accessToken: '',
    name: null,
    featureFlags: null,
  }),
}))
vi.mock('@/lib/documents/fassung-candidates', () => ({ probeProjectFassungCandidates: vi.fn() }))
vi.mock('@/lib/archiv/service', () => ({ probeArchivFassungCandidates: vi.fn() }))

import { ForbiddenError } from '@/lib/api/errors'
import { probeArchivFassungCandidates } from '@/lib/archiv/service'
import { probeProjectFassungCandidates } from '@/lib/documents/fassung-candidates'
import {
  ARCHIV_FASSUNG_CANDIDATES_PATH,
  PROJECT_FASSUNG_CANDIDATES_PATH,
  NameProbeError,
  createDocumentNameProbeClient,
} from '@/lib/documents/name-probe-client'
import { NAME_PROBE_MAX_NAMES, type FassungCandidateMatch } from '@/lib/documents/name-probe-types'
import { POST as probeProject } from './route'
import { POST as probeArchiv } from '../../archiv/documents/fassung-candidates/route'

const handlers: Record<string, (request: Request) => Promise<Response>> = {
  [PROJECT_FASSUNG_CANDIDATES_PATH]: (request) => probeProject(request, { params: Promise.resolve({}) }),
  [ARCHIV_FASSUNG_CANDIDATES_PATH]: (request) => probeArchiv(request, { params: Promise.resolve({}) }),
}

const client = createDocumentNameProbeClient(async (path, init) => {
  const handler = handlers[path]
  if (!handler) throw new Error(`no route for ${path}`)
  return handler(new Request(new URL(path, 'https://grid.test'), init))
})

const MATCH: FassungCandidateMatch = {
  name: 'EG_Index_C.pdf',
  candidates: [{ id: 'doc_b', filename: 'EG_Index_B.pdf', displayName: null, label: 'Index B' }],
  newer: true,
  unambiguous: true,
}

beforeEach(() => {
  vi.mocked(probeProjectFassungCandidates).mockReset().mockResolvedValue([MATCH])
  vi.mocked(probeArchivFassungCandidates).mockReset().mockResolvedValue([MATCH])
})

describe('POST /api/documents/fassung-candidates', () => {
  it('answers what the names continue on the project shelf', async () => {
    expect(await client.projectFassungen('proj_1', ['EG_Index_C.pdf'])).toEqual([MATCH])
    expect(probeProjectFassungCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1' }),
      'proj_1',
      ['EG_Index_C.pdf'],
    )
  })

  it('splits a long drop into probes the route accepts and answers each name once', async () => {
    const names = Array.from({ length: NAME_PROBE_MAX_NAMES + 5 }, (_, i) => `Blatt_${i}_Index_C.pdf`)

    const found = await client.projectFassungen('proj_1', names)

    expect(probeProjectFassungCandidates).toHaveBeenCalledTimes(2)
    expect(found).toHaveLength(1)
  })

  it('surfaces a refusal as a probe error with its status', async () => {
    vi.mocked(probeProjectFassungCandidates).mockRejectedValue(new ForbiddenError())

    await expect(client.projectFassungen('proj_1', ['x_Index_C.pdf'])).rejects.toEqual(expect.any(NameProbeError))
    await expect(client.projectFassungen('proj_1', ['x_Index_C.pdf'])).rejects.toMatchObject({ status: 403 })
  })

  it('refuses a body without names', async () => {
    const response = await handlers[PROJECT_FASSUNG_CANDIDATES_PATH](
      new Request('https://grid.test/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj_1', names: [] }),
      }),
    )

    expect(response.status).toBe(400)
  })
})

describe('POST /api/archiv/documents/fassung-candidates', () => {
  it('answers what the names continue in the Archiv', async () => {
    expect(await client.archivFassungen(['EG_Index_C.pdf'])).toEqual([MATCH])
    expect(probeArchivFassungCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1' }),
      ['EG_Index_C.pdf'],
    )
  })
})
