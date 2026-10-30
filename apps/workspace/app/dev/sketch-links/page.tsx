'use client'

/**
 * Dev preview — a Skizze's links into the workspace (S5).
 *
 * A Raumprogramm whose bubbles link to the model's Räume, an arrow to a page
 * of the Polierplan, and a cloud to an Anmerkung that is no longer there for
 * this reader. Each linked element carries a mark; select one element and
 * „Verknüpfen“ opens the picker, answered by stand-ins for the search, the
 * project's models and the model's element query kept in this page.
 *
 *   ?select=<element id>   open with that element selected (default: none)
 *
 * Pinned to German. 404s outside development.
 */

import { notFound, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useMemo, useState } from 'react'
import type { ResolvedSketchLink } from '@/lib/diagrams/sketch-links'
import { I18nProvider } from '@/i18n'
import { SketchDialog } from '@/features/diagrams/sketch/sketch-dialog'
import { broadcastRoomTransport } from '../sketch-room/broadcast-room'

const DOCUMENT_ID = 'dev-sketch-links'
const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
const LIVING = '2O2Fr$t4X7Zf8NOew3FLOH'
const KITCHEN = '3K9aB$t4X7Zf8NOew3FLAB'

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
    bubble('living', 0, 0, '#b2f2bb', { customData: { documentId: 'doc-ifc', ifcGlobalId: LIVING } }),
    label('living', 'Wohnen', 0, 0),
    bubble('kitchen', 300, 0, '#ffec99', { customData: { documentId: 'doc-ifc', ifcGlobalId: KITCHEN } }),
    label('kitchen', 'Kochen', 300, 0),
    bubble('sleep', 0, 220, '#a5d8ff', { customData: { documentId: 'doc-plan', annotationId: 'ann-defect' } }),
    label('sleep', 'Schlafen', 0, 220),
    bubble('bath', 300, 220, '#ffc9c9', { customData: { documentId: 'doc-gone', annotationId: 'ann-gone' } }),
    label('bath', 'Bad', 300, 220),
    {
      type: 'arrow', id: 'detail', x: 560, y: 40, width: 120, height: 80, points: [[0, 0], [120, 80]], version: 1, versionNonce: 77, isDeleted: false,
      strokeColor: '#1e1e1e', roughness: 1, strokeWidth: 1, seed: 5, endArrowhead: 'arrow', startArrowhead: null,
      customData: { documentId: 'doc-plan', page: 12 },
    },
]
/** Excalidraw orders a scene by fractional index: a0, a1, … */
const SCENE = { type: 'excalidraw', version: 2, elements: ELEMENTS.map((element, index) => ({ ...element, index: `a${index}` })) }

const place = (documentId: string) => ({ shelf: 'project' as const, projectId: PROJECT_ID, documentId })
const LINKS: ResolvedSketchLink[] = [
  { elementId: 'living', kind: 'ifcElement', ref: { documentId: 'doc-ifc', ifcGlobalId: LIVING }, state: 'available', title: 'Wohnen (IfcSpace)', place: place('doc-ifc'), modelFile: 'Haus.ifc' },
  { elementId: 'kitchen', kind: 'ifcElement', ref: { documentId: 'doc-ifc', ifcGlobalId: KITCHEN }, state: 'available', title: 'Kochen (IfcSpace)', place: place('doc-ifc'), modelFile: 'Haus.ifc' },
  { elementId: 'sleep', kind: 'annotation', ref: { documentId: 'doc-plan', annotationId: 'ann-defect' }, state: 'available', title: 'Fensteranschluss prüfen', place: place('doc-plan'), status: 'open', annotationKind: 'defect' },
  { elementId: 'bath', kind: 'annotation', ref: { documentId: 'doc-gone', annotationId: 'ann-gone' }, state: 'unavailable' },
  { elementId: 'detail', kind: 'document', ref: { documentId: 'doc-plan', page: 12 }, state: 'available', title: 'Polierplan EG', place: place('doc-plan'), page: 12 },
]

/** The routes the picker asks, answered in this page. */
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
            ? { annotation: { hits: [{ kind: 'annotation', id: 'ann-1', documentId: 'doc-plan', documentName: 'Polierplan EG', annotationKind: 'defect', status: 'open', excerpt: 'Fensteranschluss prüfen', ...hit }] } }
            : { document: { hits: [{ kind: 'document', id: 'doc-plan', name: 'Polierplan EG', filename: 'polierplan-eg.pdf', passage: { text: body.text, page: 12 }, ...hit }, { kind: 'document', id: 'doc-detail', name: 'Details Fenster', filename: 'details.pdf', passage: null, ...hit }] } },
        })
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/bim/models`) {
        return json({ models: [{ id: 'model-1', documentId: 'doc-ifc', projectId: PROJECT_ID, filename: 'Haus.ifc', displayName: 'Haus Berger', status: 'ready' }] })
      }
      if (url.pathname === '/api/bim/models/model-1/query') {
        return json({ elements: [{ globalId: LIVING, name: 'Wohnen', ifcType: 'IfcSpace' }, { globalId: KITCHEN, name: 'Kochen', ifcType: 'IfcSpace' }] })
      }
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
        revision={{ documentId: DOCUMENT_ID, baseVersionId: 'ver-1', scene, canWrite: true, roomTransport: transport, links: LINKS, projectId: PROJECT_ID }}
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
