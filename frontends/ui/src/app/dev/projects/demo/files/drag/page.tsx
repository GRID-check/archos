'use client'

/**
 * Dev harness for drag and drop in Dateien, on a desktop, end to end: the real
 * `ProjectFileWorkspace` over an in-memory project that answers the moves and
 * records the uploads, so a drag in a real browser does what it does in the
 * app and the result is on screen.
 *
 * The project: three folders at the top (Planung with Statik inside it, and
 * Behörde, which the reader may only read, ADR-0088), four documents at the
 * top, one in Planung and one in Behörde. Every move and upload request is
 * appended to `window.__dndLog`, so a script can say what reached the server.
 *
 * The path ends in `/files/…` on purpose: the frame reads its section from the
 * fourth path segment. Nothing leaves the browser; 404s outside development.
 */

import type { JSX } from 'react'
import * as React from 'react'
import { notFound } from 'next/navigation'
import { ProjectSectionFrame } from '@/components/shell/project-section-frame'
import { ProjectFileWorkspace } from '@/features/documents/components/project-file-workspace'
import type { FolderItem } from '@/features/documents/file-types'
import type { DocumentWireRow } from '@/features/documents/lib/file-item'
import { SUGGESTED_SCREENING_POLICY } from '@/lib/upload-screening/policy'

const PROJECT = 'demo'

const doc = (id: string, filename: string, folderId: string | null): DocumentWireRow => ({
  id,
  filename,
  displayName: null,
  fileSize: 240_000,
  contentType: 'application/pdf',
  status: 'completed',
  folderId,
  createdAt: new Date(Date.now() - Number(id.slice(1)) * 86_400_000).toISOString(),
  errorMessage: null,
  summary: null,
  pageCount: 2,
  chunkCount: 4,
  contentTypes: ['text'],
  tags: null,
  topics: null,
  capture: null,
})

interface Store {
  folders: FolderItem[]
  docs: DocumentWireRow[]
}

const initialStore = (): Store => ({
  folders: [
    { id: 'f1', name: 'Planung', parentId: null, path: 'Planung' },
    { id: 'f2', name: 'Statik', parentId: 'f1', path: 'Planung/Statik' },
    { id: 'f3', name: 'Behörde', parentId: null, path: 'Behörde', access: 'read' },
  ],
  docs: [
    doc('d1', 'Einreichplan_EG.pdf', null),
    doc('d2', 'Baubeschreibung.pdf', null),
    doc('d3', 'Brandschutzkonzept.pdf', null),
    doc('d4', 'Energieausweis.pdf', null),
    doc('d5', 'Lageplan.pdf', 'f1'),
    doc('d6', 'Bescheid_2026.pdf', 'f3'),
  ],
})

type LogEntry = { kind: 'move-document' | 'move-folder' | 'upload'; id?: string; to?: string | null; status: number }

declare global {
  interface Window {
    __dndLog?: LogEntry[]
  }
}

const READ_ONLY = new Set(['f3'])

function useProjectFetch(store: React.RefObject<Store>): void {
  React.useLayoutEffect(() => {
    const real = window.fetch
    window.__dndLog = []
    const log = (entry: LogEntry) => window.__dndLog?.push(entry)
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        window.location.origin
      )
      const path = url.pathname
      const method = (init?.method ?? 'GET').toUpperCase()
      const state = store.current
      const ours =
        url.searchParams.get('projectId') === PROJECT ||
        path.startsWith(`/api/projects/${PROJECT}/`) ||
        state.docs.some((d) => path.startsWith(`/api/documents/${d.id}/`)) ||
        path === '/api/documents/upload' ||
        path === '/api/organization/upload-screening' ||
        path.startsWith('/api/upload-batches') ||
        path === '/api/documents/name-matches' ||
        path === '/api/documents/fassung-candidates' ||
        path === '/api/v1/collections/demo'
      if (!ours) return real(input, init)
      // The collection the shelf ingests into, which an upload makes sure exists.
      if (path === '/api/v1/collections/demo') return json({ name: 'demo', file_count: 6, chunk_count: 24, backend: 'harness', metadata: {} })
      // What an upload asks before it sends: the office's screening policy, the
      // names it would collide with or continue, and the batch it opens.
      if (path === '/api/organization/upload-screening') {
        return json({ policy: { ...SUGGESTED_SCREENING_POLICY, enabled: false }, suggested: false, suggestion: SUGGESTED_SCREENING_POLICY })
      }
      if (path === '/api/documents/name-matches') return json({ documents: [] })
      if (path === '/api/documents/fassung-candidates') return json({ candidates: [] })
      if (path.startsWith('/api/upload-batches')) return json({ ok: true })
      if (/\/thumbnail$/.test(path)) return new Response(null, { status: 404 })

      const moveDoc = /^\/api\/documents\/([^/]+)\/folder$/.exec(path)
      if (moveDoc && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { folderId: string | null }
        const row = state.docs.find((d) => d.id === moveDoc[1])
        const refused = !row || READ_ONLY.has(row.folderId ?? '') || READ_ONLY.has(body.folderId ?? '')
        log({ kind: 'move-document', id: moveDoc[1], to: body.folderId, status: refused ? 403 : 200 })
        if (refused || !row) return json({ error: 'Read only' }, 403)
        row.folderId = body.folderId
        return json({ document: { id: row.id, folderId: row.folderId } })
      }
      const moveFolder = new RegExp(`^/api/projects/${PROJECT}/folders/([^/]+)$`).exec(path)
      if (moveFolder && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { parentId?: string | null }
        const folder = state.folders.find((f) => f.id === moveFolder[1])
        log({ kind: 'move-folder', id: moveFolder[1], to: body.parentId ?? null, status: folder ? 200 : 404 })
        if (!folder) return json({ error: 'Not found' }, 404)
        folder.parentId = body.parentId ?? null
        const parent = state.folders.find((f) => f.id === folder.parentId)
        folder.path = parent ? `${parent.path}/${folder.name}` : folder.name
        return json({ folder })
      }
      if (path === '/api/documents/upload' && method === 'POST') {
        const form = init?.body instanceof FormData ? init.body : null
        const file = form?.get('file')
        log({ kind: 'upload', id: file instanceof File ? file.name : undefined, to: (form?.get('folderId') as string) ?? null, status: 503 })
        return json({ error: 'The harness keeps no bytes' }, 503)
      }

      if (path === '/api/documents/summary') {
        const ids = [null, ...state.folders.map((f) => f.id)]
        return json({
          folders: ids.map((folderId) => {
            const inside = state.docs.filter((d) => d.folderId === folderId)
            return { folderId, total: inside.length, latest: inside[0]?.createdAt ?? null, readable: inside.length, reading: 0, failed: 0, held: 0, unindexed: 0 }
          }),
          failed: [],
          failedTruncated: false,
        })
      }
      if (path === '/api/documents') {
        const level = url.searchParams.get('folderId')
        const folderId = level === null ? undefined : level === 'root' ? null : level
        const rows = folderId === undefined ? state.docs : state.docs.filter((d) => d.folderId === folderId)
        return json({ documents: rows.map((d) => ({ ...d })), nextCursor: null, collectionName: 'demo' })
      }
      if (path === `/api/projects/${PROJECT}/folders` && method === 'GET') {
        return json({ folders: state.folders.map((f) => ({ ...f })), rootAccess: 'write' })
      }
      return real(input, init)
    }
    // The bytes go up by XHR (for its progress events): record what was sent
    // and where it was filed, then let the request fail on its own.
    const realOpen = XMLHttpRequest.prototype.open
    const realSend = XMLHttpRequest.prototype.send
    const opened = new WeakMap<XMLHttpRequest, string>()
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      opened.set(this, String(url))
      return (realOpen as (...args: unknown[]) => void).call(this, method, url, ...rest)
    } as typeof XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      if (opened.get(this)?.includes('/upload') && body instanceof FormData) {
        const file = body.get('file')
        log({ kind: 'upload', id: file instanceof File ? file.name : undefined, to: (body.get('folderId') as string | null) ?? null, status: 0 })
      }
      return realSend.call(this, body)
    }
    return () => {
      window.fetch = real
      XMLHttpRequest.prototype.open = realOpen
      XMLHttpRequest.prototype.send = realSend
    }
  }, [store])
}

export default function FilesDragDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <FilesDragPreview />
}

function FilesDragPreview(): JSX.Element {
  const store = React.useRef<Store>(initialStore())
  useProjectFetch(store)
  const top = store.current.docs.filter((d) => d.folderId === null)
  return (
    <div className="bg-background flex h-dvh flex-col" data-testid="dnd-harness">
      <main className="min-h-0 flex-1">
        <ProjectSectionFrame projectId={PROJECT} projectName="Kaiserstraße 43">
          <ProjectFileWorkspace
            projectId={PROJECT}
            projectName="Kaiserstraße 43"
            collectionName="demo"
            currentUserId="u1"
            initialFolders={store.current.folders.map((f) => ({ ...f }))}
            initialFiles={top}
          />
        </ProjectSectionFrame>
      </main>
    </div>
  )
}
