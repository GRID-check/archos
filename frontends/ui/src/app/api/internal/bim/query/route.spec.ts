/**
 * @vitest-environment node
 *
 * The agent's way into a building.
 *
 * Everything the user-facing routes do to keep a model inside its tenant and
 * its project has to be done again here, because this route carries a service
 * token instead of a session and therefore shares none of that machinery. Two
 * of those checks were missing, and both failed in the direction that answers
 * a question it should have refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory statically imports the session guard, which pulls in
// authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))

vi.mock('@/lib/bim/repository', () => ({ listBimModels: vi.fn() }))
vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())
vi.mock('@/lib/bim/query', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bim/query')>('@/lib/bim/query')
  return { ...actual, runBimQuery: vi.fn() }
})
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn() }))

const captureServer = vi.hoisted(() => vi.fn(() => true))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer }))

import { POST } from './route'
import { listBimModels } from '@/lib/bim/repository'
import { BimModelNotReadyError, runBimQuery } from '@/lib/bim/query'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import type { BimModelHeader } from '@/lib/bim/repository'
import { getRestrictedFolderIds } from '@/lib/authz/folder-access'

const PROJECT = '44444444-4444-4444-4444-444444444444'

const model = (over: Partial<BimModelHeader> & Pick<BimModelHeader, 'id' | 'filename'>): BimModelHeader => ({
  documentId: `doc-${over.id}`,
  displayName: null,
  projectId: PROJECT,
  status: 'ready',
  schemaVersion: 'IFC4',
  elementCount: 12,
  errorMessage: null,
  summary: null,
  searchKeysIndexed: true,
  updatedAt: new Date('2026-05-04T09:30:15.400Z'),
  ...over,
})

const NEW = model({ id: '11111111-1111-1111-1111-111111111111', filename: 'Haus-A_V3.ifc' })
const OLD = model({ id: '22222222-2222-2222-2222-222222222222', filename: 'Haus-A_V2.ifc' })
/** Same organization, a project this conversation holds no grant on. */
const OTHER_PROJECT = '33333333-3333-3333-3333-333333333333'

const post = (body: unknown): Promise<Response> =>
  POST(
    new Request('http://localhost/api/internal/bim/query', {
      method: 'POST',
      headers: { 'x-grid-internal-token': 'test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

describe('POST /api/internal/bim/query', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
    vi.mocked(listBimModels).mockResolvedValue([NEW, OLD])
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(true)
    vi.mocked(runBimQuery).mockResolvedValue({
      op: 'overview',
      model: { id: NEW.id, filename: NEW.filename, schema: 'IFC4', elementCount: 12 },
      summary: 'ok',
    })
  })

  it('rejects a request without the service token', async () => {
    const denied = await POST(
      new Request('http://localhost/api/internal/bim/query', {
        method: 'POST',
        body: JSON.stringify({ organizationId: 'org-1', projectId: PROJECT, modelId: NEW.id, query: { op: 'overview' } }),
      })
    )
    expect(denied.status).toBe(403)
    expect(runBimQuery).not.toHaveBeenCalled()
  })

  // ADR-0087: the agent's routes carry no session to clear, and a model's
  // building data is keyed by project, so every restricted subtree is hidden.
  it('never queries a model filed under a restricted folder', async () => {
    vi.mocked(getRestrictedFolderIds).mockResolvedValueOnce(['folder-verwaltung'])
    // What the query does with the hidden folders: NEW is filed under one.
    vi.mocked(listBimModels).mockImplementation(async (_org, options) =>
      options?.hiddenFolderIds?.includes('folder-verwaltung') ? [OLD] : [NEW, OLD]
    )

    const response = await post({ organizationId: 'org-1', projectId: PROJECT, modelId: NEW.id, query: { op: 'overview' } })

    expect(getRestrictedFolderIds).toHaveBeenCalledWith('org-1', PROJECT)
    expect(response.status).toBe(404)
    expect(runBimQuery).not.toHaveBeenCalled()
  })

  describe('bim_query_executed (PostHog)', () => {
    const overview = { organizationId: 'org-1', projectId: PROJECT, modelId: NEW.id, query: { op: 'overview' } }

    it('reports the op and success, personless, with no model name or answer', async () => {
      await post(overview)

      expect(captureServer).toHaveBeenCalledTimes(1)
      expect(captureServer).toHaveBeenCalledWith({
        event: 'bim_query_executed',
        distinctId: null,
        organizationId: 'org-1',
        properties: { kind: 'overview', ok: true },
      })
      expect(JSON.stringify(captureServer.mock.calls)).not.toContain('Haus-A')
    })

    it('reports a model that is not ready as not ok, and still answers as before', async () => {
      vi.mocked(runBimQuery).mockRejectedValue(new BimModelNotReadyError('extracting', 'Modell wird noch verarbeitet.'))

      const response = await post(overview)

      expect(response.status).toBe(200)
      expect(captureServer).toHaveBeenCalledWith(
        expect.objectContaining({ properties: { kind: 'overview', ok: false } })
      )
    })

    it('reports an unexpected failure as not ok and leaves the 500 to the factory', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(runBimQuery).mockRejectedValue(new Error('statement timeout'))

      const response = await post(overview)

      expect(response.status).toBe(500)
      expect(captureServer).toHaveBeenCalledWith(
        expect.objectContaining({ properties: { kind: 'overview', ok: false } })
      )
    })

    it('reports nothing when no query ran: unresolved model, refused flag', async () => {
      vi.mocked(listBimModels).mockResolvedValue([])
      await post(overview)

      process.env.IFC_MODELS_ENABLED = 'false'
      await post(overview)

      expect(captureServer).not.toHaveBeenCalled()
    })
  })

  describe('the ifc-models feature flag', () => {
    it('answers when the organization has the feature', async () => {
      const response = await post({ organizationId: 'org-1', projectId: PROJECT, modelId: NEW.id, query: { op: 'overview' } })

      expect(response.status).toBe(200)
      expect(isOrgFeatureEnabled).toHaveBeenCalledWith('ifc-models', 'org-1')
    })

    it('refuses when the organization does not', async () => {
      // The gate covered the upload and the pages but not this route, so
      // revoking the flag left the agent answering questions about the
      // building for as long as anyone kept asking.
      vi.mocked(isOrgFeatureEnabled).mockResolvedValue(false)

      const response = await post({ organizationId: 'org-1', projectId: PROJECT, modelId: NEW.id, query: { op: 'overview' } })

      expect(response.status).toBe(403)
      expect(runBimQuery).not.toHaveBeenCalled()
    })
  })

  describe('the base model of a two-revision op', () => {
    it('resolves `compare` from the file name, within the project', async () => {
      await post({
        organizationId: 'org-1',
        projectId: PROJECT,
        modelId: NEW.id,
        query: { op: 'compare', limit: 20000 },
        compareWithName: 'V2',
      })

      expect(vi.mocked(runBimQuery).mock.calls[0][0]).toMatchObject({
        op: 'compare',
        baseModelId: OLD.id,
      })
    })

    it('resolves `compliance-diff` the same way', async () => {
      // It did not: the route only handled `compare`, so a diff arrived with
      // whatever base the caller named and `runBimQuery` scoped it to the
      // organization alone.
      await post({
        organizationId: 'org-1',
        projectId: PROJECT,
        modelId: NEW.id,
        query: { op: 'compliance-diff' },
        compareWithName: 'V2',
      })

      expect(vi.mocked(runBimQuery).mock.calls[0][0]).toMatchObject({
        op: 'compliance-diff',
        baseModelId: OLD.id,
      })
    })

    for (const op of ['compare', 'compliance-diff'] as const) {
      it(`discards a \`${op}\` baseModelId supplied in the body`, async () => {
        // Another project's building, in the same organization. The diff would
        // report every one of its elements as `removed` — name, type and
        // storey — for a project the caller holds no grant on.
        await post({
          organizationId: 'org-1',
          projectId: PROJECT,
          modelId: NEW.id,
          query: { op, baseModelId: OTHER_PROJECT, ...(op === 'compare' ? { limit: 20000 } : {}) },
          compareWithName: 'V2',
        })

        expect(vi.mocked(runBimQuery).mock.calls[0][0]).toMatchObject({ baseModelId: OLD.id })
      })

      it(`refuses \`${op}\` when no counterpart is named`, async () => {
        const response = await post({
          organizationId: 'org-1',
          projectId: PROJECT,
          modelId: NEW.id,
          query: { op, baseModelId: OTHER_PROJECT, ...(op === 'compare' ? { limit: 20000 } : {}) },
        })

        expect(await response.json()).toMatchObject({ resolved: false, reason: 'compare_target_missing' })
        expect(runBimQuery).not.toHaveBeenCalled()
      })
    }

    it('refuses a counterpart that is not in the readable set', async () => {
      const response = await post({
        organizationId: 'org-1',
        projectId: PROJECT,
        modelId: NEW.id,
        query: { op: 'compliance-diff' },
        compareWithName: 'irgendwas-anderes',
      })

      expect(await response.json()).toMatchObject({ resolved: false, reason: 'no_match' })
      expect(runBimQuery).not.toHaveBeenCalled()
    })
  })

  // The office shelf (Büroablage) is in every project's model scope so a model can
  // be named. It is never the project's own building: a project with no upload
  // used to be answered with the shelf's single sample model.
  describe('a project with no IFC model of its own', () => {
    const SAMPLE = model({
      id: '55555555-5555-5555-5555-555555555555',
      filename: 'Ifc2x3_SampleCastle.ifc',
      projectId: null,
    })
    const overview = { organizationId: 'org-1', projectId: PROJECT, query: { op: 'overview' } }

    beforeEach(() => {
      vi.mocked(listBimModels).mockResolvedValue([SAMPLE])
    })

    it('does not read the shelf model unasked, and lists it as the shelf’s', async () => {
      const body = await (await post(overview)).json()

      expect(runBimQuery).not.toHaveBeenCalled()
      expect(body).toMatchObject({
        resolved: false,
        reason: 'no_own_model',
        models: [{ filename: SAMPLE.filename, shelf: 'office', projectId: null }],
      })
    })

    it('says "still processing", not "no model", when the project’s own IFC is not ready yet', async () => {
      const PROCESSING = model({ id: '66666666-6666-6666-6666-666666666666', filename: 'Haus-B.ifc', status: 'extracting' })
      vi.mocked(listBimModels).mockResolvedValue([SAMPLE, PROCESSING])

      const body = await (await post(overview)).json()

      expect(runBimQuery).not.toHaveBeenCalled()
      expect(body).toMatchObject({
        resolved: false,
        reason: 'not_ready',
        models: [{ modelId: PROCESSING.id, status: 'extracting', shelf: 'project' }],
      })
    })

    it('reads a shelf model that is named, and states that it is not the project’s', async () => {
      vi.mocked(runBimQuery).mockResolvedValue({
        op: 'overview',
        model: { id: SAMPLE.id, filename: SAMPLE.filename, schema: 'IFC2X3', elementCount: 12 },
        summary: 'ok',
      })

      const body = await (await post({ ...overview, modelName: 'castle' })).json()

      expect(body).toMatchObject({
        resolved: true,
        selection: { shelf: 'office', projectId: null, projectHasOwnModel: false },
      })
    })

    it('prefers the project’s own model over a shelf model when none is named', async () => {
      vi.mocked(listBimModels).mockResolvedValue([SAMPLE, NEW])

      const body = await (await post(overview)).json()

      expect(vi.mocked(runBimQuery).mock.calls[0][1]).toMatchObject({ modelId: NEW.id })
      expect(body).toMatchObject({ resolved: true, selection: { shelf: 'project', projectHasOwnModel: true } })
    })
  })
})
