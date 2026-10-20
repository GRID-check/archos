/**
 * The project's documents for the preview, so a document chip can be clicked
 * and the viewer opens at its page with the quote marked, as it does in the
 * app. The page has no API behind it, so the three routes the chip's path
 * calls (`by-name`, `preview`, `file`) are answered here, from the quotes the
 * fixtures cite; everything else goes to the real `fetch`.
 */

import type { IntakeView, ProfileEvidence } from '@/lib/project-intake/types'
import { buildPdf, type PdfLine } from '../_fixtures/sample-pdf'

type DocumentEvidence = Extract<ProfileEvidence, { kind: 'document' }>

const idOf = (fileName: string): string => `dev-${fileName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

/** A quote as printed lines of about sixty characters. */
function wrap(text: string): PdfLine[] {
  const lines: PdfLine[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + word.length + 1 > 60) {
      lines.push([line, 11, false])
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push([line, 11, false])
  return lines
}

function documentEvidenceOf(view: IntakeView): DocumentEvidence[] {
  const suggestions = [...view.contradictions, ...view.groups.flatMap((group) => group.items)]
  const evidence = suggestions.flatMap((item) => [
    ...item.evidence,
    ...item.alternatives.flatMap((alternative) => alternative.evidence),
  ])
  return evidence.filter((entry): entry is DocumentEvidence => entry.kind === 'document')
}

/** One PDF per file name: its quotes on the pages the evidence names, filler elsewhere. */
function pdfsOf(view: IntakeView): Map<string, Uint8Array<ArrayBuffer>> {
  const byFile = new Map<string, DocumentEvidence[]>()
  for (const entry of documentEvidenceOf(view)) {
    if (entry.page === null || !entry.fileName.toLowerCase().endsWith('.pdf')) continue
    byFile.set(entry.fileName, [...(byFile.get(entry.fileName) ?? []), entry])
  }
  const pdfs = new Map<string, Uint8Array<ArrayBuffer>>()
  for (const [fileName, entries] of byFile) {
    const last = Math.max(...entries.map((entry) => entry.page ?? 1))
    const pages: PdfLine[][] = Array.from({ length: last }, (_, index) => [
      [fileName, 16, true],
      [`Seite ${index + 1}`, 11, false],
      ['', 11, false],
      ...[...new Set(entries.filter((entry) => entry.page === index + 1).map((entry) => entry.quote))].flatMap(wrap),
    ])
    pdfs.set(fileName, buildPdf(pages))
  }
  return pdfs
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

let installed = false

/** Answer the document routes from the fixtures. Safe to call again. */
export function installFixtureDocuments(view: IntakeView): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const pdfs = pdfsOf(view)
  const byId = new Map([...pdfs].map(([fileName, bytes]) => [idOf(fileName), bytes]))
  const real = window.fetch.bind(window)

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, window.location.origin)
    if (url.pathname === '/api/documents/by-name') {
      const names = (JSON.parse(String(init?.body ?? '{}')) as { names?: string[] }).names ?? []
      return json({
        documents: names
          .filter((name) => pdfs.has(name))
          .map((name) => ({ id: idOf(name), filename: name, createdAt: '2026-10-14T08:30:00.000Z', contentType: 'application/pdf' })),
      })
    }
    if (url.pathname === '/api/office-shelf/documents/by-name') return json({ documents: [] })
    const route = /^\/api\/documents\/([^/]+)\/(preview|file)$/.exec(url.pathname)
    const bytes = route ? byId.get(decodeURIComponent(route[1])) : undefined
    if (route && bytes) {
      return route[2] === 'preview'
        ? json({ url: url.pathname.replace(/preview$/, 'file') })
        : new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
    }
    return real(input, init)
  }
}
