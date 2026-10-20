/**
 * Draw the excerpt of a cited page into a canvas: find the project's document
 * by the name the evidence gives, open it with the viewer's own pdf.js runtime,
 * find the quote in the page's text as the viewer marks it, and render only
 * that part of the page, at the size it is shown.
 *
 * Every step is the citation viewer's (`documents-by-name`, `pdfjs-runtime`,
 * `pdf-text-chunks`, `passage-highlight`, `pdf-raster`); nothing here parses a
 * PDF or matches text of its own. pdf.js loads only when the first excerpt is
 * asked for, and a few open documents are kept, so ten values from one
 * Baubeschreibung fetch it once.
 */

import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import { documentNameLookupKey, resolveDocumentsByName } from '@/features/documents/lib/documents-by-name'
import { maxCanvasPixels, rasterFor } from '@/features/knowledge/lib/pdf-raster'
import { pageTextChunks } from '@/features/knowledge/lib/pdf-text-chunks'
import { locatePassage, passageBounds } from '@/features/knowledge/lib/passage-highlight'
import { documentParameters, loadPdfjs, readPageTextItems } from '@/features/knowledge/lib/pdfjs-runtime'
import { documentFileUrl } from '@/lib/documents/urls'
import type { ProfileEvidence } from '@/lib/project-intake/types'
import { excerptOf, type Excerpt } from './excerpt-geometry'

export type DocumentEvidence = Extract<ProfileEvidence, { kind: 'document' }>

/** Only a PDF page can be drawn here; an office file opens in the viewer, through its chip. */
export function hasExcerpt(evidence: ProfileEvidence): evidence is DocumentEvidence & { page: number } {
  return evidence.kind === 'document' && evidence.page !== null && /\.pdf$/i.test(evidence.fileName.trim())
}

/** How many opened documents are kept: a Steckbrief cites a handful of files many times. */
const KEEP_DOCUMENTS = 4
const opened = new Map<string, { task: PDFDocumentLoadingTask; promise: Promise<PDFDocumentProxy> }>()

async function openDocument(documentId: string): Promise<PDFDocumentProxy> {
  const kept = opened.get(documentId)
  if (kept) {
    opened.delete(documentId)
    opened.set(documentId, kept)
    return kept.promise
  }
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument(documentParameters(documentFileUrl(documentId)))
  const entry = { task, promise: task.promise }
  opened.set(documentId, entry)
  entry.promise.catch(() => opened.delete(documentId))
  for (const [id, old] of opened) {
    if (opened.size <= KEEP_DOCUMENTS) break
    opened.delete(id)
    void old.task.destroy()
  }
  return entry.promise
}

/** Test hook: forget the opened documents. */
export function resetExcerptDocuments(): void {
  for (const { task } of opened.values()) void task.destroy()
  opened.clear()
}

async function documentIdOf(projectId: string | null, fileName: string): Promise<string | null> {
  const named = (await resolveDocumentsByName(projectId, [fileName])).get(documentNameLookupKey(fileName))
  const row = named?.projekt.find((candidate) => !candidate.contentType || candidate.contentType === 'application/pdf')
  return row?.id ?? null
}

export interface DrawnExcerpt {
  /** The passage relative to the drawn part, or null when the whole page is drawn. */
  mark: Excerpt['mark']
  /** The drawn part's size at scale 1, so the caller can mark the passage in percent. */
  crop: Excerpt['crop']
}

/**
 * Draw the excerpt for `evidence` into `canvas`, `cssWidth` pixels wide.
 * Resolves null when there is nothing to draw (the file is gone, not a PDF,
 * has no such page, or pdf.js would not load); never rejects.
 */
export async function drawExcerpt(options: {
  projectId: string | null
  evidence: DocumentEvidence & { page: number }
  canvas: HTMLCanvasElement
  cssWidth: number
  signal: AbortSignal
}): Promise<DrawnExcerpt | null> {
  const { evidence, canvas, cssWidth, signal } = options
  try {
    const documentId = await documentIdOf(options.projectId, evidence.fileName)
    if (!documentId || signal.aborted) return null
    const doc = await openDocument(documentId)
    if (signal.aborted || evidence.page > doc.numPages) return null
    const page = await doc.getPage(evidence.page)
    const base = page.getViewport({ scale: 1 })
    const chunks = pageTextChunks(await readPageTextItems(page), base.transform)
    const match = locatePassage(chunks, evidence.quote)
    const { crop, mark } = excerptOf(base, match ? passageBounds(match.rects) : null)
    if (signal.aborted) return null

    const scale = cssWidth / crop.width
    const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true
    const raster = rasterFor({
      width: cssWidth,
      height: crop.height * scale,
      dpr: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
      maxPixels: maxCanvasPixels(coarse),
    })
    const pixels = scale * raster.ratio
    const viewport = page.getViewport({ scale: pixels, offsetX: -crop.x * pixels, offsetY: -crop.y * pixels })
    canvas.width = raster.width
    canvas.height = raster.height
    const task = page.render({ canvas, viewport })
    signal.addEventListener('abort', () => task.cancel(), { once: true })
    await task.promise
    return signal.aborted ? null : { crop, mark }
  } catch {
    return null
  }
}
