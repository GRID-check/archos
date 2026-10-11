/**
 * The typed client for `GET /api/documents/{id}/text` (ADR-0055): a text
 * document's content, bounded, for the formats the pane renders itself (plain
 * text, Markdown, CSV). Anything else answers 415, which surfaces here as a
 * thrown error the caller turns into one quiet line.
 */

export interface DocumentText {
  text: string
  truncated: boolean
}

export async function readDocumentText(documentId: string, init?: RequestInit): Promise<DocumentText> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/text`, init)
  if (!response.ok) throw new Error(`document text ${response.status}`)
  const body = (await response.json()) as { text?: unknown; truncated?: unknown }
  if (typeof body.text !== 'string') throw new Error('document text: no text')
  return { text: body.text, truncated: body.truncated === true }
}
