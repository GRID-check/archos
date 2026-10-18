'use client'

/**
 * Dev preview for a project's Offene Punkte, the REAL `OpenPointsPanel` over
 * a fixture project: four documents, marks with and without a Zuständige and a
 * Frist (one overdue, two due within the week), one set on an earlier Fassung,
 * one with a thread and one that mentions the reader.
 *
 * A module-scope `fetch` shim answers the list
 * (`/api/projects/dev-project/annotations`) as the server would: the filters
 * (`assignee=me`, `due=overdue|soon`), pages by an opaque cursor, and the
 * Protokoll (`…/export`) as a small Markdown file.
 *
 * Routes:
 *   /dev/open-points             the list, every open point grouped by document
 *   /dev/open-points?page=3      three marks a page: „Weitere laden" at the foot
 *   /dev/open-points?fail=1      reads fail for three seconds: the error, then „Erneut versuchen" reads
 *   /dev/open-points?empty=1     nothing open
 *   /dev/open-points?slow=1      each read takes two seconds: the loading state
 *
 * Not linked from anywhere and 404s outside development (`../layout.tsx`).
 */

import type { JSX } from 'react'
import { addCalendarDays, localCalendarDay } from '@/lib/format'
import type { ProjectMarkView } from '@/lib/annotations/project-types'
import type { AnnotationReplyView } from '@/lib/annotations/types'
import { OpenPointsPanel } from '@/features/documents/components/open-points/open-points-panel'

const PROJECT = 'dev-project'
const ME = 'user_anna'
const TODAY = localCalendarDay()

const DOCUMENTS = [
  { id: 'dev-doc-grundriss', name: 'Grundriss EG Index C.pdf' },
  { id: 'dev-doc-schnitt', name: 'Schnitt A-A.pdf' },
  { id: 'dev-doc-ansicht', name: 'Ansicht Süd.pdf' },
  { id: 'dev-doc-brandschutz', name: 'Brandschutzkonzept_v3.pdf' },
] as const

const reply = (body: string, name: string): AnnotationReplyView => ({
  id: `reply-${body.length}`,
  annotationId: 'x',
  authorKind: 'person',
  body,
  createdBy: 'user_bernd',
  createdByName: name,
  createdAt: '2026-10-14T09:00:00.000Z',
  addressesPiloti: false,
  wokenBy: null,
  mentions: [],
})

let serial = 0
const mark = (document: (typeof DOCUMENTS)[number], overrides: Partial<ProjectMarkView>): ProjectMarkView => {
  serial += 1
  return {
    id: `dev-mark-${serial}`,
    documentId: document.id,
    documentName: document.name,
    number: serial,
    page: 1,
    shape: 'point',
    x: 0.4,
    y: 0.5,
    w: null,
    h: null,
    kind: 'hint',
    body: '',
    mentions: [],
    basis: null,
    authorKind: 'person',
    status: 'open',
    assigneeUserId: null,
    assigneeName: null,
    dueOn: null,
    fassungNumber: 3,
    onCurrentFassung: true,
    createdBy: 'user_bernd',
    createdByName: 'Bernd Huber',
    createdAt: '2026-10-12T08:00:00.000Z',
    updatedAt: '2026-10-12T08:00:00.000Z',
    acceptedBy: null,
    acceptedByName: null,
    closedBy: null,
    closedByName: null,
    closedAt: null,
    delegatedBy: null,
    delegatedByName: null,
    delegatedAt: null,
    replies: [],
    pilotiWork: null,
    carriedFrom: null,
    carriedTo: null,
    carryTarget: null,
    canEdit: true,
    canDelete: false,
    ...overrides,
  }
}

const [grundriss, schnitt, ansicht, brandschutz] = DOCUMENTS

const MARKS: ProjectMarkView[] = [
  mark(grundriss, {
    number: 2,
    kind: 'defect',
    body: 'Lichte Breite der Fluchttür T30 unter 90 cm – bitte mit der Tischlerliste abgleichen.',
    assigneeUserId: ME,
    assigneeName: 'Anna Berger',
    dueOn: addCalendarDays(TODAY, -3),
    replies: [reply('Tischlerliste kommt Donnerstag.', 'Bernd Huber')],
  }),
  mark(grundriss, {
    number: 4,
    page: 2,
    kind: 'question',
    body: '@Anna Berger Ist der Schacht hier mit der HKLS abgestimmt?',
    mentions: [{ targetId: ME, display: 'Anna Berger' }],
    assigneeUserId: 'user_lena',
    assigneeName: 'Lena Gruber',
    dueOn: addCalendarDays(TODAY, 2),
  }),
  mark(grundriss, {
    number: 7,
    page: 2,
    kind: 'hint',
    body: 'Raumstempel Abstellraum fehlt.',
    fassungNumber: 2,
    onCurrentFassung: false,
  }),
  mark(schnitt, {
    number: 1,
    kind: 'defect',
    body: 'Geländerhöhe im Stiegenhaus unter 1,00 m (OIB-RL 4, 2.3.2).',
    basis: 'OIB-RL 4, Pkt. 2.3.2',
    authorKind: 'piloti',
    acceptedBy: ME,
    acceptedByName: 'Anna Berger',
    createdBy: ME,
    createdByName: 'Anna Berger',
    assigneeUserId: ME,
    assigneeName: 'Anna Berger',
    dueOn: addCalendarDays(TODAY, 5),
  }),
  mark(schnitt, {
    number: 3,
    kind: 'question',
    body: 'Höhenkote Fußbodenoberkante 1. OG prüfen.',
  }),
  mark(ansicht, {
    number: 1,
    kind: 'hint',
    body: 'Fensterteilung wie in der Einreichung, nicht wie im Vorentwurf.',
    assigneeUserId: 'user_lena',
    assigneeName: 'Lena Gruber',
    dueOn: addCalendarDays(TODAY, 12),
  }),
  mark(brandschutz, {
    number: 5,
    page: 4,
    kind: 'defect',
    body: 'Fluchtweglänge im 2. OG überschreitet 40 m – Nachweis fehlt.',
    assigneeUserId: ME,
    assigneeName: 'Anna Berger',
  }),
]

const params = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search)
const PAGE_SIZE = Number(params.get('page')) || 50

function select(search: URLSearchParams): ProjectMarkView[] {
  if (params.get('empty')) return []
  const due = search.get('due')
  const soonUntil = addCalendarDays(TODAY, 7)
  return MARKS.filter(
    (one) =>
      (search.get('assignee') !== 'me' || one.assigneeUserId === ME) &&
      (due !== 'overdue' || (one.dueOn !== null && one.dueOn < TODAY)) &&
      (due !== 'soon' || (one.dueOn !== null && one.dueOn >= TODAY && one.dueOn <= soonUntil))
  )
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __openPointsShim?: boolean }
  if (!w.__openPointsShim) {
    w.__openPointsShim = true
    // Every read of the first seconds fails, so the error shows however often the page asks; a retry after it reads.
    const failUntil = params.get('fail') ? Date.now() + 3000 : 0
    const real = window.fetch.bind(window)
    const pause = () => new Promise((resolve) => window.setTimeout(resolve, params.get('slow') ? 2000 : 250))
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const url = new URL(raw, window.location.origin)
      if (url.pathname === `/api/projects/${PROJECT}/annotations/export`) {
        await pause()
        const lines = select(url.searchParams).map((one) => `- ${one.documentName} · Nr. ${one.number}: ${one.body}`)
        return new Response(new Blob([`# Offene Punkte – Wohnhaus Lend\n\n${lines.join('\n')}\n`]), {
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('Offene Punkte – Wohnhaus Lend.md')}`,
          },
        })
      }
      if (url.pathname === `/api/projects/${PROJECT}/annotations`) {
        await pause()
        if (Date.now() < failUntil) {
          return Response.json({ error: 'Unavailable', code: 'UNAVAILABLE' }, { status: 503 })
        }
        const all = select(url.searchParams)
        const start = Number(url.searchParams.get('cursor') ?? 0)
        const marks = all.slice(start, start + PAGE_SIZE)
        const next = start + PAGE_SIZE < all.length ? String(start + PAGE_SIZE) : null
        return Response.json({ marks, nextCursor: next })
      }
      return real(input, init)
    }
  }
}

export default function OpenPointsPreview(): JSX.Element {
  return (
    <div className="bg-background h-dvh">
      <OpenPointsPanel projectId={PROJECT} currentUserId={ME} initial={null} />
    </div>
  )
}
