'use client'

/**
 * Dev preview for Anmerkungen and the review, in the Files preview pane where
 * they ship, against the REAL pane, viewer, room hook and typed client.
 *
 * Two shims at module scope make it backend-free and alive:
 *   - `fetch` answers the annotations API from memory (setting, taking over,
 *     resolving, replying and deleting work exactly as against the API), the
 *     document's bytes (a Grundriss sheet drawn with vector paths below), and
 *     the room's POST;
 *   - `EventSource` plays the room: Anna Berger moving her pointer across the
 *     corridor, Jakob Huber taking aim with the region tool at the stair, their
 *     presence claims, and, with `&piloti=1`, Piloti proposing three findings
 *     two seconds in, so its pointer walks to each as it lands.
 *
 * Routes:
 *   /dev/annotations                         the pane: pins, regions, pointers inline
 *   /dev/annotations?doc=dev-doc-annotations&review=1            the focused review
 *   …&review=1&mark=ann-1                    the review, open at Anmerkung 1
 *   …&review=1&piloti=1                      the review, while Piloti proposes
 *
 * Not linked from anywhere and 404s outside development (`../layout.tsx`).
 */

import type { JSX } from 'react'
import { FilePreviewPane } from '@/features/documents/components/file-preview-pane'
import type { FileItem } from '@/features/documents/components/project-file-workspace'
import type { RoomEvent, RoomFrame, RoomPeer } from '@/lib/annotations/room-types'
import type { AnnotationReplyView, AnnotationView } from '@/lib/annotations/types'
import { assemblePdf, pdfString } from '../_fixtures/sample-pdf'

const SHEET_WIDTH = 842
const SHEET_HEIGHT = 595

/** One A3-landscape sheet: a Grundriss with a corridor, rooms, doors and a stair, and a title block. */
const sheetContent = (): string => {
  const ops: string[] = ['0 0 0 RG']
  const rect = (x: number, y: number, w: number, h: number, width = 0.8) =>
    ops.push(`${width} w ${x} ${y} ${w} ${h} re S`)
  const line = (x1: number, y1: number, x2: number, y2: number, width = 0.5) =>
    ops.push(`${width} w ${x1} ${y1} m ${x2} ${y2} l S`)
  const text = (x: number, y: number, size: number, value: string, bold = false) =>
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfString(value)}) Tj ET`)

  rect(50, 80, 520, 420, 2.4)
  line(50, 270, 570, 270, 1.2)
  line(50, 320, 570, 320, 1.2)
  for (const x of [190, 330, 450]) {
    line(x, 320, x, 500, 1.2)
    line(x, 80, x, 270, 1.2)
  }
  for (const x of [110, 250, 380, 500]) {
    ops.push(`1 1 1 RG 3 w ${x} 320 m ${x + 26} 320 l S 0 0 0 RG`)
    line(x, 320, x, 346, 0.4)
  }
  rect(470, 110, 80, 140, 0.8)
  for (let step = 0; step <= 9; step += 1) line(470, 110 + step * 14, 550, 110 + step * 14, 0.5)
  for (const [x, y] of [
    [90, 500],
    [230, 500],
    [90, 80],
    [230, 80],
  ]) {
    ops.push(`1 1 1 RG 3 w ${x} ${y} m ${x + 60} ${y} l S 0 0 0 RG`)
    line(x, y - 2, x + 60, y - 2, 0.4)
    line(x, y + 2, x + 60, y + 2, 0.4)
  }
  text(90, 420, 10, 'Wohnen 1')
  text(230, 420, 10, 'Wohnen 2')
  text(370, 420, 10, 'Bad')
  text(480, 420, 10, 'Technik')
  text(90, 180, 10, 'Zimmer 1')
  text(230, 180, 10, 'Zimmer 2')
  text(360, 180, 10, 'Abstellraum')
  text(478, 258, 9, 'Stiege')
  text(240, 292, 10, 'Gang (Fluchtweg)')
  text(50, 515, 12, 'Grundriss Regelgeschoss  1:100', true)
  rect(600, 40, 220, 70, 0.8)
  text(612, 88, 10, 'Wohnbau Nord', true)
  text(612, 70, 9, 'Grundriss RG, Index C')
  text(612, 54, 9, 'Architektur Muster ZT GmbH')
  return ops.join('\n') + '\n'
}

const buildSheet = (): Uint8Array<ArrayBuffer> => {
  const content = sheetContent()
  return assemblePdf([
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${SHEET_WIDTH} ${SHEET_HEIGHT}]` +
      '/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>',
    `<</Length ${content.length}>>\nstream\n${content}endstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>',
  ])
}

const FILE: FileItem = {
  id: 'dev-doc-annotations',
  filename: 'Grundriss_RG_Index-C.pdf',
  displayName: null,
  fileSize: 412_000,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-10-01T09:00:00Z',
  errorMessage: null,
  summary: 'Grundriss des Regelgeschosses im Maßstab 1:100 mit Gang, fünf Räumen, Bad, Technik und Stiege.',
  pageCount: 1,
  chunkCount: 3,
  contentTypes: ['drawing', 'text'],
  tags: ['Grundriss'],
  topics: null,
  capture: null,
  versionCount: 3,
  assignees: [{ userId: 'u-1', name: 'Miriam Hofer', email: 'm.hofer@example.at', profilePictureUrl: null }],
}

const ME = { userId: 'u-1', name: 'Miriam Hofer' }
const ANNA = { userId: 'u-2', name: 'Anna Berger' }
const JAKOB = { userId: 'u-3', name: 'Jakob Huber' }
const NAMES: Record<string, string> = { 'u-1': ME.name, 'u-2': ANNA.name, 'u-3': JAKOB.name }

/** A point on the sheet in PDF points (bottom-left origin), as a share of the page (top-left). */
const pt = (x: number, y: number) => ({ x: +(x / SHEET_WIDTH).toFixed(4), y: +(1 - y / SHEET_HEIGHT).toFixed(4) })
/** A region from two corners in PDF points. */
const region = (x0: number, y0: number, x1: number, y1: number) => {
  const a = pt(x0, y1)
  return { x: a.x, y: a.y, w: +((x1 - x0) / SHEET_WIDTH).toFixed(4), h: +((y1 - y0) / SHEET_HEIGHT).toFixed(4) }
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const base = {
  documentId: FILE.id,
  page: 1,
  w: null,
  h: null,
  basis: null,
  fassungNumber: 3,
  onCurrentFassung: true,
  createdBy: 'u-1',
  createdByName: ME.name,
  createdAt: minutesAgo(140),
  updatedAt: minutesAgo(140),
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  authorKind: 'person' as const,
  status: 'open' as const,
  acceptedBy: null,
  acceptedByName: null,
  closedBy: null,
  closedByName: null,
  closedAt: null,
  replies: [] as AnnotationReplyView[],
  canEdit: true,
  canDelete: true,
}

const reply = (annotationId: string, by: { userId: string; name: string }, minutes: number, body: string): AnnotationReplyView => ({
  id: `${annotationId}-r${minutes}`,
  annotationId,
  authorKind: 'person',
  body,
  createdBy: by.userId,
  createdByName: by.name,
  createdAt: minutesAgo(minutes),
})

let annotations: AnnotationView[] = [
  {
    ...base,
    id: 'ann-1',
    number: 1,
    shape: 'point',
    ...pt(263, 333),
    kind: 'defect',
    body: 'Tür von Wohnen 2 in den Fluchtweg ohne Angabe der Feuerwiderstandsklasse. EI2 30-C eintragen.',
    assigneeUserId: 'u-2',
    assigneeName: ANNA.name,
    dueOn: '2026-10-10',
    replies: [
      reply('ann-1', ANNA, 95, 'Kommt mit Index D. Gilt das auch für die Tür vom Bad?'),
      reply('ann-1', ME, 80, 'Nein, Bad geht nicht in den Gang. Nur Wohnen 1 und 2.'),
    ],
  },
  {
    ...base,
    id: 'ann-2',
    number: 2,
    shape: 'region',
    ...region(470, 110, 550, 250),
    kind: 'question',
    body: 'Laufbreite der Stiege an die Statik: 1,20 m oder 1,10 m zwischen den Wangen?',
    createdBy: 'u-3',
    createdByName: JAKOB.name,
    canDelete: false,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(60),
  },
  {
    ...base,
    id: 'ann-3',
    number: 3,
    shape: 'point',
    ...pt(380, 440),
    kind: 'hint',
    body: 'Bad: Lüftung über Dach, Schacht im Technikraum.',
    status: 'resolved',
    closedBy: 'u-2',
    closedByName: ANNA.name,
    closedAt: minutesAgo(30),
  },
  {
    ...base,
    id: 'ann-4',
    number: 4,
    shape: 'point',
    ...pt(120, 200),
    kind: 'defect',
    body: 'Fensterbrüstung Zimmer 1 unter 1,00 m.',
    fassungNumber: 2,
    onCurrentFassung: false,
  },
]
let nextNumber = 5

const PILOTI_PROPOSALS: AnnotationView[] = [
  {
    ...base,
    id: 'ann-p1',
    number: 0,
    shape: 'region',
    ...region(50, 270, 570, 320),
    kind: 'question',
    body: 'Gang als Fluchtweg: lichte Breite ist nicht kotiert. Mindestens 1,20 m nachweisen.',
    basis: 'OIB-RL 4, Pkt. 2.2.1',
    authorKind: 'piloti',
    status: 'proposed',
    canDelete: false,
  },
  {
    ...base,
    id: 'ann-p2',
    number: 0,
    shape: 'point',
    ...pt(500, 333),
    kind: 'defect',
    body: 'Tür Technik in den Fluchtweg: Feuerwiderstand fehlt, Technikraum gilt als Raum mit erhöhter Brandgefahr.',
    basis: 'OIB-RL 2, Pkt. 3.4',
    authorKind: 'piloti',
    status: 'proposed',
    canDelete: false,
  },
  {
    ...base,
    id: 'ann-p3',
    number: 0,
    shape: 'region',
    ...region(90, 76, 150, 84),
    kind: 'hint',
    body: 'Belichtung Zimmer 1: Fensterfläche gegen 1/10 der Bodenfläche prüfen.',
    basis: 'OIB-RL 3, Pkt. 9.1.1',
    authorKind: 'piloti',
    status: 'proposed',
    canDelete: false,
  },
]

// ── the room ────────────────────────────────────────────────────────────────

type Listener = (frame: RoomFrame) => void
const sources = new Set<Listener>()
const broadcast = (event: RoomEvent) => sources.forEach((listener) => listener({ kind: 'event', event }))
const peer = (who: { userId: string; name: string }, peerId: string): RoomPeer => ({ ...who, peerId, kind: 'person' })
const annaPeer = peer(ANNA, 'peer-anna-0001')
const jakobPeer = peer(JAKOB, 'peer-jakob-001')

let started = false
function startRoom(withPiloti: boolean) {
  if (started) return
  started = true
  const t0 = performance.now()
  for (const who of [annaPeer, jakobPeer]) broadcast({ kind: 'presence', peer: who, state: 'here', ttlMs: 25_000 })
  setInterval(() => {
    for (const who of [annaPeer, jakobPeer]) broadcast({ kind: 'presence', peer: who, state: 'here', ttlMs: 25_000 })
  }, 8_000)
  setInterval(() => {
    const s = (performance.now() - t0) / 1000
    // Anna walks the corridor, pausing at the doors.
    const along = 0.18 + 0.28 * (0.5 + 0.5 * Math.sin(s * 0.55))
    broadcast({
      kind: 'cursor',
      peer: annaPeer,
      tool: 'select',
      cursor: { page: 1, x: along, y: 0.44 + 0.015 * Math.sin(s * 2.1) },
    })
    // Jakob circles the stair with the region tool in hand.
    broadcast({
      kind: 'cursor',
      peer: jakobPeer,
      tool: 'region',
      cursor: { page: 1, x: 0.62 + 0.03 * Math.cos(s * 0.9), y: 0.36 + 0.06 * Math.sin(s * 0.9) },
    })
  }, 80)
  if (withPiloti) {
    setTimeout(() => {
      const proposed = PILOTI_PROPOSALS.map((proposal) => ({ ...proposal, number: nextNumber++, createdAt: new Date().toISOString() }))
      annotations = [...annotations, ...proposed]
      broadcast({
        kind: 'annotations.changed',
        annotationIds: proposed.map((proposal) => proposal.id),
        change: 'created',
        actor: { peerId: null, userId: ME.userId, name: 'Piloti', kind: 'piloti' },
      })
    }, 2200)
  }
}

class RoomEventSource {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  private readonly listener: Listener = (frame) => this.onmessage?.({ data: JSON.stringify(frame) })
  constructor(readonly url: string) {
    setTimeout(() => {
      this.onopen?.()
      this.listener({ kind: 'welcome', self: { ...ME, kind: 'person' } })
      sources.add(this.listener)
      startRoom(new URLSearchParams(window.location.search).has('piloti'))
    }, 50)
  }
  close() {
    sources.delete(this.listener)
  }
}

// ── the API ─────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) => Response.json(body, { status })

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __annotationsShim?: boolean; EventSource: unknown }
  if (!w.__annotationsShim) {
    w.__annotationsShim = true
    w.EventSource = RoomEventSource
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = () => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (url.endsWith(`/api/documents/${FILE.id}/live`)) return new Response(null, { status: 204 })
      const replies = new RegExp(`/api/documents/${FILE.id}/annotations/([^/?]+)/replies$`).exec(url)
      if (replies) {
        const current = annotations.find((annotation) => annotation.id === replies[1])
        if (!current) return json({ error: 'Not found', code: 'NOT_FOUND' }, 404)
        const next = {
          ...current,
          replies: [...current.replies, reply(current.id, ME, 0, String(body().body).trim())],
          updatedAt: new Date().toISOString(),
        }
        annotations = annotations.map((annotation) => (annotation.id === next.id ? next : annotation))
        return json({ annotation: next }, 201)
      }
      const one = new RegExp(`/api/documents/${FILE.id}/annotations/([^/?]+)$`).exec(url)
      if (one) {
        const current = annotations.find((annotation) => annotation.id === one[1])
        if (!current) return json({ error: 'Not found', code: 'NOT_FOUND' }, 404)
        if (method === 'DELETE') {
          annotations = annotations.filter((annotation) => annotation.id !== current.id)
          return new Response(null, { status: 204 })
        }
        const change = body() as Partial<AnnotationView>
        const now = new Date().toISOString()
        const status = change.status ?? current.status
        const moved = status !== current.status
        const next: AnnotationView = {
          ...current,
          ...change,
          status,
          ...(change.assigneeUserId !== undefined ? { assigneeName: change.assigneeUserId ? NAMES[change.assigneeUserId] ?? null : null } : {}),
          ...(moved && (status === 'resolved' || status === 'dismissed')
            ? { closedBy: ME.userId, closedByName: ME.name, closedAt: now }
            : {}),
          ...(moved && status === 'open' ? { closedBy: null, closedByName: null, closedAt: null } : {}),
          ...(moved && status === 'open' && current.authorKind === 'piloti' && !current.acceptedBy
            ? { acceptedBy: ME.userId, acceptedByName: ME.name }
            : {}),
          updatedAt: now,
        }
        annotations = annotations.map((annotation) => (annotation.id === next.id ? next : annotation))
        return json({ annotation: next })
      }
      if (url.endsWith(`/api/documents/${FILE.id}/annotations`)) {
        if (method === 'POST') {
          const input = body() as Pick<AnnotationView, 'page' | 'shape' | 'x' | 'y' | 'w' | 'h' | 'kind' | 'body' | 'assigneeUserId' | 'dueOn'>
          const created: AnnotationView = {
            ...base,
            ...input,
            w: input.w ?? null,
            h: input.h ?? null,
            body: input.body.trim(),
            assigneeUserId: input.assigneeUserId ?? null,
            assigneeName: input.assigneeUserId ? NAMES[input.assigneeUserId] ?? null : null,
            dueOn: input.dueOn ?? null,
            id: `ann-${nextNumber}`,
            number: nextNumber,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          nextNumber += 1
          annotations = [...annotations, created]
          return json({ annotation: created }, 201)
        }
        return json({ annotations, canAnnotate: true })
      }
      if (url.endsWith(`/api/documents/${FILE.id}/file`)) {
        return new Response(buildSheet(), { headers: { 'Content-Type': 'application/pdf' } })
      }
      if (url.endsWith(`/api/documents/${FILE.id}/preview`)) return json({ url: `/api/documents/${FILE.id}/file` })
      if (/\/api\/documents\/.+\/visual-details$/.test(url)) return json({ details: [] })
      if (/\/api\/assignments\/document\/.+\/candidates$/.test(url)) {
        return json({
          candidates: [
            { userId: 'u-2', name: ANNA.name, email: 'a.berger@example.at', profilePictureUrl: null },
            { userId: 'u-3', name: JAKOB.name, email: 'j.huber@example.at', profilePictureUrl: null },
          ],
        })
      }
      return real(input, init)
    }
  }
}

export default function AnnotationsPreview(): JSX.Element {
  // The geometry `file-preview-host` gives the pane (see `/dev/file-preview?variant=review`).
  return (
    <main className="bg-muted/40 flex min-h-dvh items-center justify-center">
      <div className="bg-popover text-popover-foreground h-[85vh] w-[min(1100px,calc(100%-2rem))] overflow-hidden rounded-2xl border shadow-lg">
        <FilePreviewPane
          file={FILE}
          projectId="proj-demo"
          projectName="Wohnbau Nord — Linz"
          canManage
          canCollaborate
          viewerUserId="u-1"
          onClose={() => {}}
        />
      </div>
    </main>
  )
}
