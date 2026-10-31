/**
 * @vitest-environment node
 *
 * A model filed in a restricted folder (ADR-0087), through the real read gate: the person cleared
 * for the folder gets its geometry, from a source the BFF signed after the gate (the service never
 * re-resolves it with narrower rights); the person not cleared is refused before the service is
 * called and before any URL is presigned.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Document } from '@/lib/db/schema/documents'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/feature-flags', () => ({
  FEATURE_FLAGS: { ifcModels: 'ifc-models' },
  isFeatureEnabled: vi.fn().mockReturnValue(true),
  isIfcModelsEnabled: vi.fn().mockReturnValue(true),
}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn(async () => ({ role: 'member' })) }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())
vi.mock('@/lib/download-log/service', () => ({ recordDocumentAccess: vi.fn(async () => undefined) }))

const documents = new Map<string, Document>()
vi.mock('@/lib/documents/repository', () => ({
  findDocumentInOrg: vi.fn(async (documentId: string) => documents.get(documentId) ?? null),
}))
vi.mock('./repository', () => ({
  findBimModelById: vi.fn(async (modelId: string) => ({
    id: modelId,
    documentId: `doc-of-${modelId}`,
    projectId: 'project-a',
    filename: 'Haus-A.ifc',
    displayName: null,
    status: 'ready',
    schemaVersion: 'IFC4',
    elementCount: 10,
    errorMessage: null,
    summary: null,
    searchKeysIndexed: false,
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  })),
}))
vi.mock('@/lib/s3', () => ({ s3Client: { send: vi.fn(async () => ({ ETag: '"etag-1"', ContentLength: 10 })) }, signingS3Client: {}, bucketName: 'documents' }))
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'http://store.internal/presigned') }))
const callGeometry = vi.fn(async () => ({ op: 'warm', result: { value: { status: 'ready' } }, meta: { cacheTier: 'B', ms: 1, elements: 0, truncated: false } }))
vi.mock('./geometry-client', async (importActual) => ({
  ...(await importActual<typeof import('./geometry-client')>()),
  callGeometry: (...args: unknown[]) => callGeometry(...(args as [])),
}))
vi.mock('@/lib/agent-api/acting-session', () => ({ actingReaderIsAgent: () => false }))
vi.mock('@/lib/langfuse/geometry-trace', () => ({ recordGeometryTrace: vi.fn(async () => undefined) }))

import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { isFolderVisibleTo } from '@/lib/authz/folder-access'
import { NotFoundError } from '@/lib/api/errors'
import { makeDocument } from '@/test-utils/db-fixtures'
import { geometryForAccessibleModel } from './geometry-service'

const SESSION = {
  userId: 'user-1',
  organizationId: 'org-1',
  role: 'member',
  permissions: [],
  featureFlags: null,
} as unknown as Parameters<typeof geometryForAccessibleModel>[0]
const RESTRICTED = 'folder-verwaltung'

beforeEach(() => {
  vi.clearAllMocks()
  documents.clear()
  documents.set(
    'doc-of-model-restricted',
    makeDocument({ id: 'doc-of-model-restricted', scope: 'project', projectId: 'project-a', folderId: RESTRICTED, storageKey: 'k/m.ifc' })
  )
})

describe('a model in a restricted folder', () => {
  it('answers a person cleared for the folder, from the source the BFF signed', async () => {
    vi.mocked(isFolderVisibleTo).mockResolvedValue(true)
    const response = await geometryForAccessibleModel(SESSION, 'model-restricted', { op: 'warm' })
    expect(response.result).toEqual({ value: { status: 'ready' } })
    expect(isFolderVisibleTo).toHaveBeenCalledWith(SESSION, 'project-a', RESTRICTED)
    expect(callGeometry).toHaveBeenCalledWith(
      'model-restricted',
      { op: 'warm' },
      expect.objectContaining({
        sources: { 'model-restricted': { url: 'http://store.internal/presigned', etag: 'etag-1', bytes: 10, updatedAt: '2026-08-01T00:00:00.000Z' } },
      })
    )
  })

  it('refuses a person not cleared before the service is called or a URL is presigned', async () => {
    vi.mocked(isFolderVisibleTo).mockResolvedValue(false)
    await expect(geometryForAccessibleModel(SESSION, 'model-restricted', { op: 'warm' })).rejects.toBeInstanceOf(NotFoundError)
    expect(callGeometry).not.toHaveBeenCalled()
    expect(getSignedUrl).not.toHaveBeenCalled()
  })
})
