/**
 * Diagrams API client
 *
 * Typed fetch client for filing a drawn diagram into a project
 * (`POST /api/projects/[id]/diagrams`). The request is the route's own zod
 * schema (`lib/diagrams/diagram-wire.ts`), so the body cannot drift from what
 * the server parses. The answer is validated here with a schema of its own, so a
 * body this client does not understand is refused as a failed filing and never
 * read as a partial one.
 *
 * A refused filing throws {@link DiagramFilingError}, which carries the status and
 * the envelope's `error` sentence as `serverMessage`.
 */

import { z } from 'zod'
import type { fileDiagramSchema } from '@/lib/diagrams/diagram-wire'
import { ROOM_PEER_HEADER, type saveSketchSchema } from '@/lib/diagrams/sketch-wire'
import { SKETCH_LINK_KINDS, type ResolvedSketchLink } from '@/lib/diagrams/sketch-links'
import type { SketchUnderlay } from '@/lib/diagrams/sketch-underlay'
import type { SketchUnderlayView, UnderlayMovePlan } from '@/lib/diagrams/sketch-underlay-wire'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

/** What the filing sends: the route's own request body. */
export type DiagramFilingRequest = z.input<typeof fileDiagramSchema>

/** Which halves of a filing landed: the SVG the reader opens, and whether the PDF came with it. */
export interface FiledDiagram {
  svgDocumentId: string
  pdfFiled: boolean
}

/** A refused filing: the status, and the envelope's `error` sentence when the server sent one. */
export class DiagramFilingError extends ApiRequestError {
  readonly serverMessage: string | null

  constructor(status: number, serverMessage: string | null) {
    super(`Failed to file the diagram: ${status}`, status)
    this.name = 'DiagramFilingError'
    this.serverMessage = serverMessage
  }
}

// ============================================================
// Answer
// ============================================================

const FiledHalfSchema = z.object({ documentId: z.string().min(1) })

/**
 * The route answers 201 with `svg` always and `pdf` when it landed too, and with
 * `pdf: null` when only the SVG did. The PDF half is read on its own, so a PDF
 * that did not land is a smaller success and never a failed filing.
 */
const FiledDiagramSchema = z.object({
  svg: FiledHalfSchema,
  pdf: z.unknown(),
})

const jsonHeaders: HeadersInit = { 'Content-Type': 'application/json' }

// ============================================================
// Filing
// ============================================================

/** File a diagram into the project. Answers which halves landed. */
export const fileDiagram = async (projectId: string, request: DiagramFilingRequest): Promise<FiledDiagram> => {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/diagrams`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(request),
  })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const serverMessage =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : null
    throw new DiagramFilingError(response.status, serverMessage)
  }
  const parsed = FiledDiagramSchema.safeParse(await response.json())
  if (!parsed.success) throw new DiagramFilingError(response.status, null)
  return {
    svgDocumentId: parsed.data.svg.documentId,
    pdfFiled: FiledHalfSchema.safeParse(parsed.data.pdf).success,
  }
}

// ============================================================
// A filed sketch, reopened (ADR-0148)
// ============================================================

/** A sketch request refused: `stale` when a newer Fassung exists (409 `stale_base_version`). */
export class SketchRequestError extends ApiRequestError {
  readonly serverMessage: string | null
  /** The pages to choose from, when a move's label names more than one (`label_ambiguous`). */
  readonly pages: number[]

  constructor(status: number, serverMessage: string | null, reason: string | null, pages: number[] = []) {
    super(`The sketch request failed: ${status}`, status, reason)
    this.name = 'SketchRequestError'
    this.serverMessage = serverMessage
    this.pages = pages
  }

  get stale(): boolean {
    return this.status === 409 && this.reason === 'stale_base_version'
  }

  /** A version of the Skizze is in Freigabe: nothing can be saved until the review is decided. */
  get reviewOpen(): boolean {
    return this.status === 409 && this.reason === 'review_open'
  }
}

async function sketchError(response: Response): Promise<SketchRequestError> {
  const body: unknown = await response.json().catch(() => null)
  const envelope = z
    .object({ error: z.string().optional(), details: z.object({ reason: z.string(), pages: z.array(z.number().int()).max(9999) }).partial().optional() })
    .safeParse(body)
  const data = envelope.success ? envelope.data : {}
  return new SketchRequestError(response.status, data.error ?? null, data.details?.reason ?? null, data.details?.pages ?? [])
}

const SketchViewSchema = z.object({
  documentId: z.string().min(1),
  versionId: z.string().nullable(),
  /** Absent from an older server: the save itself still decides. */
  canWrite: z.boolean().default(true),
  title: z.string(),
  scene: z.looseObject({ type: z.literal('excalidraw'), elements: z.array(z.looseObject({})) }),
  /** What a save writes; absent from an older server, which only published. */
  saveTarget: z.enum(['published', 'draft', 'review_open']).default('published'),
  /** The open draft's hash, sent back with a save into it. */
  contentHash: z.string().nullable().default(null),
  /** The project the Skizze lies in; absent from an older server. */
  projectId: z.string().nullable().default(null),
  /** Its links as the server read them for this reader (`lib/diagrams/sketch-links.ts`); absent from an older server. */
  links: z
    .array(z.looseObject({ elementId: z.string(), kind: z.enum(SKETCH_LINK_KINDS), state: z.enum(['available', 'unavailable']), ref: z.looseObject({}) }))
    .default([])
    .transform((links) => links as unknown as ResolvedSketchLink[]),
  /** The page it is traced over, as this reader sees it (`lib/diagrams/sketch-underlay-wire.ts`); absent from an older server. */
  underlay: z
    .looseObject({ state: z.enum(['available', 'unavailable']), elementId: z.string(), ref: z.looseObject({}) })
    .nullable()
    .default(null)
    .transform((underlay) => underlay as unknown as SketchUnderlayView | null),
})

/** What the editor needs of a filed sketch: its scene and the Fassung (or open draft) it was read from. */
export type SketchForEditing = z.infer<typeof SketchViewSchema>

/**
 * `GET /api/documents/{id}/sketch`: the stored scene, a read the download log records.
 * Throws {@link SketchRequestError} (415: not a sketch).
 */
export const getSketch = async (documentId: string, signal?: AbortSignal): Promise<SketchForEditing> => {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/sketch`, { signal })
  if (!response.ok) throw await sketchError(response)
  const parsed = SketchViewSchema.safeParse(await response.json())
  if (!parsed.success) throw new SketchRequestError(response.status, null, null)
  return parsed.data
}

const SketchProbeSchema = z.object({ hasScene: z.boolean(), canWrite: z.boolean(), versionId: z.string().nullable() })

/** Whether to offer the editor on a file. */
export type SketchProbe = z.infer<typeof SketchProbeSchema>

/**
 * `GET /api/documents/{id}/sketch?probe=1`: whether the file is a Skizze this reader may open or edit. It carries
 * nothing of the drawing, which is why the download log does not record it.
 */
export const probeSketch = async (documentId: string, signal?: AbortSignal): Promise<SketchProbe> => {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/sketch?probe=1`, { signal })
  if (!response.ok) throw await sketchError(response)
  const parsed = SketchProbeSchema.safeParse(await response.json())
  if (!parsed.success) throw new SketchRequestError(response.status, null, null)
  return parsed.data
}

/** What a save sends: the route's own request body. */
export type SketchSaveRequest = z.input<typeof saveSketchSchema>

/** What a save answers, as the editor reads it. */
export interface SavedSketchVersion {
  versionId: string
  versionNumber: number
  /** `draft`: the save went into the open Freigabe draft, nothing was published. */
  state: 'published' | 'draft'
  /** The saved bytes' hash: the next save into the draft sends it back. */
  contentHash: string | null
  /** The PDF beside the sketch could not be drawn again: it still shows an earlier version. */
  pdfStale: boolean
}

/** `PUT /api/documents/{id}/sketch`: the new Fassung's id and number. `peerId`: this tab in the document room. */
export const saveSketch = async (
  documentId: string,
  request: SketchSaveRequest,
  { peerId }: { peerId?: string | null } = {}
): Promise<SavedSketchVersion> => {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/sketch`, {
    method: 'PUT',
    headers: { ...jsonHeaders, ...(peerId ? { [ROOM_PEER_HEADER]: peerId } : {}) },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw await sketchError(response)
  const parsed = z
    .object({
      versionId: z.string().min(1),
      versionNumber: z.number(),
      pdfStale: z.boolean().default(false),
      state: z.enum(['published', 'draft']).default('published'),
      contentHash: z.string().nullable().default(null),
    })
    .safeParse(await response.json())
  if (!parsed.success) throw new SketchRequestError(response.status, null, null)
  return parsed.data
}

// ============================================================
// A Skizze traced over a PDF page (S6, ADR-0150)
// ============================================================

/** The page's raster, same origin and with the reader's rights: what the editor lays under the strokes. */
export const pageRasterUrl = (underlay: Pick<SketchUnderlay, 'documentId' | 'versionId' | 'page' | 'dpi'>): string =>
  `/api/documents/${encodeURIComponent(underlay.documentId)}/versions/${encodeURIComponent(underlay.versionId)}/pages/${underlay.page}/raster?dpi=${underlay.dpi}`

/** The document's current Fassung, which „Auf Seite zeichnen“ traces over. */
export const currentVersionOf = async (documentId: string): Promise<string | null> => {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/versions`)
  if (!response.ok) throw await sketchError(response)
  const parsed = z.object({ publishedVersionId: z.string().nullable() }).safeParse(await response.json())
  return parsed.success ? parsed.data.publishedVersionId : null
}

/** `POST …/pages/{page}/sketch`: a new Skizze on that page; answers its document id. */
export const createSketchFromPage = async (documentId: string, versionId: string, page: number): Promise<{ documentId: string }> => {
  const response = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/pages/${page}/sketch`,
    { method: 'POST', headers: jsonHeaders, body: '{}' }
  )
  if (!response.ok) throw await sketchError(response)
  const parsed = z.object({ documentId: z.string().min(1) }).safeParse(await response.json())
  if (!parsed.success) throw new SketchRequestError(response.status, null, null)
  return parsed.data
}

const UnderlayPageSchema = z.object({ versionId: z.string(), versionNumber: z.number(), page: z.number(), pageLabel: z.string().nullable() })
const UnderlayPlanSchema = z.object({
  from: UnderlayPageSchema,
  to: UnderlayPageSchema,
  matchedBy: z.enum(['label', 'index', 'chosen']),
  labelGone: z.boolean().default(false),
})

/** `GET /api/documents/{id}/sketch/underlay`: which page of the newer Fassung the Skizze would move to, or the `page` the person chose. */
export const getUnderlayMovePlan = async (documentId: string, page?: number, signal?: AbortSignal): Promise<UnderlayMovePlan> => {
  const query = page ? `?page=${page}` : ''
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/sketch/underlay${query}`, { signal })
  if (!response.ok) throw await sketchError(response)
  const parsed = UnderlayPlanSchema.safeParse(await response.json())
  if (!parsed.success) throw new SketchRequestError(response.status, null, null)
  return parsed.data
}

/** `POST /api/documents/{id}/sketch/underlay`: the move, saved as the Skizze's next Fassung. */
export const moveSketchUnderlay = async (documentId: string, baseVersionId: string | null, versionId: string, page?: number): Promise<{ versionNumber: number }> => {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/sketch/underlay`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ baseVersionId, versionId, ...(page ? { page } : {}) }),
  })
  if (!response.ok) throw await sketchError(response)
  const parsed = z.object({ versionNumber: z.number() }).safeParse(await response.json())
  if (!parsed.success) throw new SketchRequestError(response.status, null, null)
  return parsed.data
}
