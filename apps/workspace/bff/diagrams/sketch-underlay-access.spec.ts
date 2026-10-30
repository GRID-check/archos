/**
 * @vitest-environment node
 */
/**
 * A Skizze never shows its underlay to a reader who cannot open the base (S6,
 * ADR-0150): its filed picture embeds the page only where the base's own folder
 * would show it, a save or a move that would widen it is refused by name, and a
 * read degrades to `unavailable` instead of failing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { checkSketchScene } from './sketch-scene'
import { newUnderlayElement, type SketchUnderlay } from './sketch-underlay'

vi.mock('server-only', () => ({}))

const access = vi.hoisted(() => ({ getAccessibleDocument: vi.fn() }))
const egress = vi.hoisted(() => ({ folderRestrictsReading: vi.fn(async () => false) }))
const raster = vi.hoisted(() => ({ readPageRaster: vi.fn() }))
const versions = vi.hoisted(() => ({ findDocumentVersion: vi.fn() }))
vi.mock('@/lib/documents/access', () => access)
vi.mock('@/lib/conversations/restricted-egress', () => egress)
vi.mock('@/lib/documents/page-raster', () => raster)
vi.mock('@/lib/documents/version-repository', () => versions)

const { embeddedUnderlayFor, resolveUnderlayView, underlayMoveRefusal, UnderlayRefusedError } = await import('./sketch-underlay-access')

const session = { organizationId: 'org_1', userId: 'user_1' } as AuthorizedSession
const BASE: SketchUnderlay = { documentId: '22222222-2222-4222-8222-222222222222', versionId: '33333333-3333-4333-8333-333333333333', page: 2, dpi: 150 }
const scene = checkSketchScene({ type: 'excalidraw', elements: [newUnderlayElement('page', BASE, { widthPt: 842, heightPt: 595 }, 1)] })
const placement = { x: 16, y: 16, width: 842, height: 595 }
const png = new Uint8Array([1, 2, 3])

beforeEach(() => {
  vi.clearAllMocks()
  access.getAccessibleDocument.mockResolvedValue({ id: BASE.documentId, projectId: 'proj_1', folderId: 'plans', publishedVersionId: BASE.versionId, filename: 'Lageplan.pdf', displayName: null })
  raster.readPageRaster.mockResolvedValue({ png })
  egress.folderRestrictsReading.mockResolvedValue(false)
})

const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error instanceof UnderlayRefusedError ? error.reason : String(error)))

describe('embeddedUnderlayFor', () => {
  it('files the server’s page, read without a second log entry, when the base is open to every member', async () => {
    expect(await embeddedUnderlayFor(session, { projectId: 'proj_1', folderId: 'sketches' }, scene, placement)).toEqual({ ...placement, png })
    expect(raster.readPageRaster).toHaveBeenCalledWith(session, BASE, { log: false })
  })

  it('refuses a Skizze outside a restricted base’s folder, and files it beside the base', async () => {
    egress.folderRestrictsReading.mockResolvedValue(true)
    expect(await refusal(embeddedUnderlayFor(session, { projectId: 'proj_1', folderId: 'sketches' }, scene, placement))).toBe('underlay_wider')
    expect(raster.readPageRaster).not.toHaveBeenCalled()
    expect(await embeddedUnderlayFor(session, { projectId: 'proj_1', folderId: 'plans' }, scene, placement)).toEqual({ ...placement, png })
  })

  it('refuses another project’s page, and a page the saver may not open', async () => {
    expect(await refusal(embeddedUnderlayFor(session, { projectId: 'proj_2', folderId: 'plans' }, scene, placement))).toBe('underlay_other_project')
    access.getAccessibleDocument.mockRejectedValueOnce(new NotFoundError())
    expect(await refusal(embeddedUnderlayFor(session, { projectId: 'proj_1', folderId: 'plans' }, scene, placement))).toBe('underlay_unavailable')
  })

  it('is nothing for a scene without a page', async () => {
    expect(await embeddedUnderlayFor(session, { projectId: 'proj_1', folderId: null }, checkSketchScene({ type: 'excalidraw', elements: [] }), undefined)).toBeNull()
  })
})

describe('underlayMoveRefusal', () => {
  it('says why a Skizze may not leave a restricted base’s folder, and lets it stay or go back', async () => {
    egress.folderRestrictsReading.mockResolvedValue(true)
    expect(await underlayMoveRefusal(session, scene, { projectId: 'proj_1' }, 'open')).toMatch(/not every member may read/)
    expect(await underlayMoveRefusal(session, scene, { projectId: 'proj_1' }, 'plans')).toBeNull()
    expect(await underlayMoveRefusal(session, null, { projectId: 'proj_1' }, 'open')).toBeNull()
  })
})

describe('resolveUnderlayView', () => {
  const underlay = { elementId: 'page', ref: BASE, box: { x: 0, y: 0, w: 842, h: 595 } }

  it('names the base and offers the move when a newer Fassung is current', async () => {
    access.getAccessibleDocument.mockResolvedValueOnce({ id: BASE.documentId, publishedVersionId: 'v4', filename: 'Lageplan.pdf', displayName: null })
    versions.findDocumentVersion.mockImplementation(async (id: string) => (id === 'v4' ? { id: 'v4', versionNumber: 4 } : { id, versionNumber: 3 }))
    expect(await resolveUnderlayView(session, underlay)).toMatchObject({ state: 'available', title: 'Lageplan.pdf', versionNumber: 3, newer: { versionId: 'v4', versionNumber: 4 } })
  })

  it('is unavailable, and fails nothing, for a reader who may not open the base', async () => {
    access.getAccessibleDocument.mockRejectedValueOnce(new NotFoundError())
    expect(await resolveUnderlayView(session, underlay)).toEqual({ state: 'unavailable', elementId: 'page', ref: BASE })
  })
})
