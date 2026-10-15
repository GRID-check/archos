'use client'

/**
 * Dev preview for the WHOLE Dateien screen as a phone shows it: the shell's
 * phone header and tab bar (stand-ins, same heights), the real
 * `ProjectSectionFrame` (title, description, controls), the real
 * `ProjectFileWorkspace` (breadcrumb row, brief disclosure, cards, floating
 * Hochladen) over fixtures.
 *
 * The path ends in `/files` on purpose: the frame reads its section from the
 * fourth path segment. States by query string: `?unread=1` leaves one document
 * unread (the brief disclosure then has something to say).
 * Nothing leaves the browser; 404s outside development.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { ProjectSectionFrame } from '@/components/shell/project-section-frame'
import { ProjectFileWorkspace } from '@/features/documents/components/project-file-workspace'
import type { DocumentWireRow } from '@/features/documents/lib/file-item'

const row = (id: string, filename: string, summary: string, extra: Partial<DocumentWireRow> = {}): DocumentWireRow => ({
  id,
  filename,
  displayName: null,
  fileSize: 108_000,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: new Date(Date.now() - 15 * 86_400_000).toISOString(),
  errorMessage: null,
  summary,
  pageCount: 2,
  chunkCount: 4,
  contentTypes: ['text'],
  tags: null,
  topics: null,
  capture: null,
  ...extra,
})

const unread = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('unread') === '1'

const FILES: DocumentWireRow[] = [
  row('d1', 'Lebenslauf_SebastianKufner.pdf', 'Das Dokument zeigt einen tabellarischen Lebenslauf mit Stationen.'),
  row('d2', '20260910_WB_Organigramm_Kaiserstrasse_v0.13.pptx', 'Die Folie zeigt eine organisatorische Struktur.', {
    fileSize: 1_600_000,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    createdAt: new Date(Date.now() - 16 * 86_400_000).toISOString(),
    ...(unread ? { status: 'failed', errorMessage: 'Nicht lesbar' } : {}),
  }),
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __filesPageShim?: boolean }
  if (!w.__filesPageShim) {
    w.__filesPageShim = true
    const real = window.fetch.bind(window)
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, window.location.origin).pathname
      if (/\/thumbnail$/.test(path)) return new Response(null, { status: 404 })
      if (path === '/api/documents/summary') {
        const failed = FILES.filter((f) => f.status === 'failed')
        return json({
          folders: [
            {
              folderId: null,
              total: FILES.length,
              latest: FILES[0].createdAt,
              readable: FILES.length - failed.length,
              reading: 0,
              failed: failed.length,
              held: 0,
              unindexed: 0,
            },
          ],
          failed: failed.map((f) => ({ id: f.id, folderId: null })),
          failedTruncated: false,
        })
      }
      if (path === '/api/documents') return json({ documents: FILES, nextCursor: null, collectionName: 'demo' })
      if (/\/folders$/.test(path)) return json({ folders: [], rootAccess: 'write' })
      return real(input, init)
    }
  }
}

export default function FilesPageDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <div className="bg-background flex h-dvh flex-col">
      <div className="flex h-14 shrink-0 items-center border-b px-4 text-lg font-semibold">Kaiserstraße 43</div>
      <main className="min-h-0 flex-1">
        <ProjectSectionFrame projectId="demo" projectName="Kaiserstraße 43">
          <ProjectFileWorkspace
            projectId="demo"
            projectName="Kaiserstraße 43"
            collectionName="demo"
            canCollaborate
            currentUserId="u1"
            initialFolders={[]}
            initialFiles={FILES}
          />
        </ProjectSectionFrame>
      </main>
      <nav className="text-muted-foreground flex h-[51px] shrink-0 items-center justify-around border-t text-xs">
        <span>Frag Piloti</span>
        <span className="text-foreground font-medium">Dateien</span>
        <span>Übersicht</span>
        <span>Postfach</span>
        <span>Mehr</span>
      </nav>
    </div>
  )
}
