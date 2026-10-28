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
