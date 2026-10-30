'use client'

/**
 * Dev preview — a Skizze's links into the workspace (S5).
 *
 * A Raumprogramm whose bubbles link to the model's Räume, an arrow to a page
 * of the Polierplan, and a cloud to an Anmerkung that is no longer there for
 * this reader. Each linked element carries a mark; select one element and
 * „Verknüpfen“ opens the picker, answered by stand-ins for the search, the
 * project's models and the model's element query kept in this page. Two
 * Anmerkungen are pinned to the Küche and to the arrow (the review's own
 * layer, `sketch-pins.tsx`), drawn above the canvas like the link marks.
 *
 *   ?select=<element id>   open with that element selected (default: none)
 *
 * Pinned to German. 404s outside development.
 */

import { notFound, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useMemo, useState } from 'react'
import type { AnnotationView } from '@/lib/annotations/types'
import type { ResolvedSketchLink } from '@/lib/diagrams/sketch-links'
import { useDocumentReview } from '@/features/documents/hooks/use-document-review'
import { I18nProvider } from '@/i18n'
import { SketchDialog } from '@/features/diagrams/sketch/sketch-dialog'
import { broadcastRoomTransport } from '../sketch-room/broadcast-room'

const DOCUMENT_ID = 'dev-sketch-links'
const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
const LIVING = '2O2Fr$t4X7Zf8NOew3FLOH'
const KITCHEN = '3K9aB$t4X7Zf8NOew3FLAB'
// Link ids are uuids, as the columns they name (`sketch-links.ts`).
const DOC_IFC = '00000000-0000-4000-8000-0000000000a1'
const DOC_PLAN = '00000000-0000-4000-8000-0000000000a2'
const DOC_GONE = '00000000-0000-4000-8000-0000000000a3'
const DOC_DETAIL = '00000000-0000-4000-8000-0000000000a4'
const ANN_DEFECT = '00000000-0000-4000-8000-0000000000b1'
const ANN_GONE = '00000000-0000-4000-8000-0000000000b2'

const bubble = (id: string, x: number, y: number, color: string, extra: Record<string, unknown> = {}) => ({
  type: 'ellipse', id, x, y, width: 190, height: 100, version: 1, versionNonce: x + y + 1, isDeleted: false,
  backgroundColor: color, fillStyle: 'hachure', strokeColor: '#1e1e1e', roughness: 1, strokeWidth: 1, seed: x + 3,
  boundElements: [{ type: 'text', id: `${id}-t` }], ...extra,
})
const label = (id: string, text: string, x: number, y: number) => ({
  type: 'text', id: `${id}-t`, x: x + 60, y: y + 38, width: 70, height: 25, text, originalText: text, fontSize: 16, fontFamily: 2,
  textAlign: 'center', verticalAlign: 'middle', containerId: id, version: 1, versionNonce: x + y + 7, isDeleted: false,
  strokeColor: '#1e1e1e', seed: x + 9, lineHeight: 1.25,
})

const ELEMENTS = [
    bubble('living', 0, 0, '#b2f2bb', { customData: { documentId: DOC_IFC, ifcGlobalId: LIVING } }),
    label('living', 'Wohnen', 0, 0),
    bubble('kitchen', 300, 0, '#ffec99', { customData: { documentId: DOC_IFC, ifcGlobalId: KITCHEN } }),
    label('kitchen', 'Kochen', 300, 0),
    bubble('sleep', 0, 220, '#a5d8ff', { customData: { documentId: DOC_PLAN, annotationId: ANN_DEFECT } }),
    label('sleep', 'Schlafen', 0, 220),
    bubble('bath', 300, 220, '#ffc9c9', { customData: { documentId: DOC_GONE, annotationId: ANN_GONE } }),
    label('bath', 'Bad', 300, 220),
    {
      type: 'arrow', id: 'detail', x: 560, y: 40, width: 120, height: 80, points: [[0, 0], [120, 80]], version: 1, versionNonce: 77, isDeleted: false,
      strokeColor: '#1e1e1e', roughness: 1, strokeWidth: 1, seed: 5, endArrowhead: 'arrow', startArrowhead: null,
      customData: { documentId: DOC_PLAN, page: 12 },
    },
]
/** Excalidraw orders a scene by fractional index: a0, a1, … */
const SCENE = { type: 'excalidraw', version: 2, elements: ELEMENTS.map((element, index) => ({ ...element, index: `a${index}` })) }

const place = (documentId: string) => ({ shelf: 'project' as const, projectId: PROJECT_ID, documentId })
const LINKS: ResolvedSketchLink[] = [
  { elementId: 'living', kind: 'ifcElement', ref: { documentId: DOC_IFC, ifcGlobalId: LIVING }, state: 'available', title: 'Wohnen (IfcSpace)', place: place(DOC_IFC), modelFile: 'Haus.ifc' },
  { elementId: 'kitchen', kind: 'ifcElement', ref: { documentId: DOC_IFC, ifcGlobalId: KITCHEN }, state: 'available', title: 'Kochen (IfcSpace)', place: place(DOC_IFC), modelFile: 'Haus.ifc' },
  { elementId: 'sleep', kind: 'annotation', ref: { documentId: DOC_PLAN, annotationId: ANN_DEFECT }, state: 'available', title: 'Fensteranschluss prüfen', place: place(DOC_PLAN), status: 'open', annotationKind: 'defect' },
  { elementId: 'bath', kind: 'annotation', ref: { documentId: DOC_GONE, annotationId: ANN_GONE }, state: 'unavailable' },
  { elementId: 'detail', kind: 'document', ref: { documentId: DOC_PLAN, page: 12 }, state: 'available', title: 'Polierplan EG', place: place(DOC_PLAN), page: 12 },
]

/** The Skizze's own Anmerkungen, pinned to elements: their box comes from where the elements stand. */
const mark = (number: number, elementIds: string[], body: string, kind: AnnotationView['kind']): AnnotationView => ({
  id: `00000000-0000-4000-8000-0000000000c${number}`, documentId: DOCUMENT_ID, number, page: 1, shape: 'region', x: 0, y: 0, w: 0.1, h: 0.1,
  elementIds, kind, body, mentions: [], basis: null, authorKind: 'person', status: 'open', assigneeUserId: null, assigneeName: null,
  dueOn: null, revisionNumber: 1, onCurrentRevision: true, createdBy: 'user_anna', createdByName: 'Anna Berger',
  createdAt: '2026-10-28T09:00:00.000Z', updatedAt: '2026-10-28T09:00:00.000Z', acceptedBy: null, acceptedByName: null,
  closedBy: null, closedByName: null, closedAt: null, delegatedBy: null, delegatedByName: null, delegatedAt: null, replies: [],
  canEdit: true, canDelete: true,
})
const MARKS: AnnotationView[] = [mark(1, ['kitchen'], 'Küche an die Terrasse?', 'question'), mark(2, ['detail'], 'Anschluss nach Detail 4 prüfen', 'defect')]

/** The routes the picker and the review ask, answered in this page. */
function useStandInRoutes() {
  useEffect(() => {
    const original = window.fetch
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href)
      if (url.pathname === '/api/search') {
        const body = JSON.parse(String(init?.body)) as { text?: string; kinds?: string[] }
        const hit = { shelf: 'project', projectId: PROJECT_ID, projectName: 'Haus Berger' }
        return json({
          sections: body.kinds?.includes('annotation')
            ? { annotation: { hits: [{ kind: 'annotation', id: ANN_DEFECT, documentId: DOC_PLAN, documentName: 'Polierplan EG', annotationKind: 'defect', status: 'open', excerpt: 'Fensteranschluss prüfen', ...hit }] } }
            : { document: { hits: [{ kind: 'document', id: DOC_PLAN, name: 'Polierplan EG', filename: 'polierplan-eg.pdf', passage: { text: body.text, page: 12 }, ...hit }, { kind: 'document', id: DOC_DETAIL, name: 'Details Fenster', filename: 'details.pdf', passage: null, ...hit }] } },
        })
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/bim/models`) {
        return json({ models: [{ id: 'model-1', documentId: DOC_IFC, projectId: PROJECT_ID, filename: 'Haus.ifc', displayName: 'Haus Berger', status: 'ready' }] })
      }
      if (url.pathname === '/api/bim/models/model-1/query') {
        return json({ elements: [{ globalId: LIVING, name: 'Wohnen', ifcType: 'IfcSpace' }, { globalId: KITCHEN, name: 'Kochen', ifcType: 'IfcSpace' }] })
      }
      if (url.pathname === `/api/documents/${DOCUMENT_ID}/annotations`) return json({ annotations: MARKS, canAnnotate: true })
      if (url.pathname === '/api/inbox/unread-anchors') return json({ anchorIds: [] })
      if (url.pathname === `/api/documents/${DOCUMENT_ID}/sketch`) return json({ documentId: DOCUMENT_ID, versionId: 'ver-1', versionNumber: 1, pdf: null })
      return original(input, init)
    }
    return () => {
      window.fetch = original
    }
  }, [])
}

function Links() {
  const params = useSearchParams()
  useStandInRoutes()
  const [open, setOpen] = useState(true)
  const select = params.get('select')
  const scene = useMemo(() => ({ ...SCENE, appState: select ? { selectedElementIds: { [select]: true } } : {} }), [select])
  const transport = useMemo(() => broadcastRoomTransport(DOCUMENT_ID, { userId: 'user_anna', name: 'Anna Berger', canWrite: true }), [])
  const review = useDocumentReview(DOCUMENT_ID, { enabled: true, transport, viewerUserId: 'user_anna' })
  return (
    <div data-testid="sketch-links-preview" className="bg-background flex min-h-screen flex-col items-center gap-4 p-4 sm:p-10">
      <button type="button" className="text-sm underline" onClick={() => setOpen(true)}>
        Skizze öffnen
      </button>
      <SketchDialog
        open={open}
        onOpenChange={setOpen}
        source=""
        elements={[]}
        title="Raumprogramm"
        revision={{ documentId: DOCUMENT_ID, baseVersionId: 'ver-1', scene, canWrite: true, roomTransport: transport, links: LINKS, projectId: PROJECT_ID, review }}
      />
    </div>
  )
}

export default function SketchLinksPreview() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Suspense>
        <Links />
      </Suspense>
    </I18nProvider>
  )
}
