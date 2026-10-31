'use client'

/**
 * Dev preview — a Skizze traced over a PDF page (S6).
 *
 * The page of a Grundriss lies locked under a cloud, an arrow and a note; the
 * base has a newer Fassung, so the banner says „liegt auf Fassung 3, aktuell 4“
 * and „Auf neue Fassung übertragen“ opens the move with old and new overlaid.
 * The raster route and the move are answered in this page: the two pages are
 * drawn on a canvas here, the second with a wall moved.
 *
 *   ?move=1     open with the move dialog open
 *   ?reader=1   a reader who may not open the base: the strokes on a blank sheet
 *
 * Pinned to German. 404s outside development.
 */

import { notFound, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useMemo, useState } from 'react'
import type { SketchUnderlayView } from '@/lib/diagrams/sketch-underlay-wire'
import { newUnderlayElement, type SketchUnderlay } from '@/lib/diagrams/sketch-underlay'
import { I18nProvider } from '@/i18n'
import { SketchDialog } from '@/features/diagrams/sketch/sketch-dialog'
import { UnderlayMoveDialog } from '@/features/diagrams/sketch/sketch-underlay'

const DOCUMENT_ID = 'dev-sketch-underlay'
const BASE = '00000000-0000-4000-8000-0000000000a2'
const V3 = '00000000-0000-4000-8000-0000000000d3'
const V4 = '00000000-0000-4000-8000-0000000000d4'
const REF: SketchUnderlay = { documentId: BASE, versionId: V3, page: 2, dpi: 150 }
const A3 = { widthPt: 1191, heightPt: 842 }

/** A Grundriss drawn as a PDF page would be: walls, a stair, a title block. `moved` shifts one wall (Fassung 4). */
function drawPlan(moved: boolean): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 1786
  canvas.height = 1263
  const g = canvas.getContext('2d')!
  const s = canvas.width / A3.widthPt
  g.fillStyle = '#fff'
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.scale(s, s)
  g.strokeStyle = '#222'
  g.lineWidth = 6
  g.strokeRect(120, 120, 760, 520)
  g.lineWidth = 3
  g.beginPath()
  const wall = moved ? 560 : 480
  g.moveTo(wall, 120)
  g.lineTo(wall, 420)
  g.moveTo(120, 380)
  g.lineTo(wall, 380)
  g.moveTo(wall, 520)
  g.lineTo(880, 520)
  g.stroke()
  for (let step = 0; step < 10; step++) g.strokeRect(700 + step * 14, 540, 14, 80)
  g.font = '16px Helvetica'
  g.fillStyle = '#333'
  g.fillText('Wohnen 32,4 m²', 220, 260)
  g.fillText('Küche', 640, 260)
  g.fillText('Bad', 220, 480)
  g.strokeRect(900, 660, 260, 150)
  g.font = '13px Helvetica'
  g.fillText('Grundriss EG  M 1:100', 915, 690)
  g.fillText(moved ? 'Index B · Fassung 4' : 'Index A · Fassung 3', 915, 712)
  g.fillText('Plan-Nr. A-101', 915, 734)
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
}

const markup = (id: string, extra: Record<string, unknown>) => ({
  id, version: 1, versionNonce: id.length * 7, isDeleted: false, strokeColor: '#e03131', backgroundColor: 'transparent', fillStyle: 'solid',
  strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, angle: 0, seed: id.length * 3, groupIds: [], frameId: null, roundness: null,
  boundElements: null, updated: 1, link: null, locked: false, ...extra,
})
const ELEMENTS = [
  newUnderlayElement('page', REF, A3, 11),
  markup('cloud', { type: 'ellipse', x: 440, y: 150, width: 120, height: 200, index: 'a1' }),
  markup('arrow', { type: 'arrow', x: 560, y: 250, width: 160, height: -90, points: [[0, 0], [160, -90]], endArrowhead: 'arrow', startArrowhead: null, index: 'a2' }),
  markup('note', { type: 'text', x: 730, y: 140, width: 210, height: 25, text: 'Wand nach Osten?', originalText: 'Wand nach Osten?', fontSize: 20, fontFamily: 2, textAlign: 'left', verticalAlign: 'top', containerId: null, lineHeight: 1.25, index: 'a3' }),
]
const SCENE = { type: 'excalidraw' as const, elements: ELEMENTS }
const UNDERLAY: Extract<SketchUnderlayView, { state: 'available' }> = {
  state: 'available', elementId: 'page', ref: REF, title: 'Grundriss EG.pdf', versionNumber: 3, newer: { versionId: V4, versionNumber: 4 },
}
const PLAN = {
  from: { versionId: V3, versionNumber: 3, page: 2, pageLabel: 'A-101' },
  to: { versionId: V4, versionNumber: 4, page: 3, pageLabel: 'A-101' },
  matchedBy: 'label' as const,
  labelGone: false,
}

/** The raster route, answered here; a reader gets the 404 the route gives one who may not open the base. */
function usePages(reader: boolean) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  useEffect(() => {
    let blobs: Record<string, Blob> = {}
    const original = window.fetch
    void Promise.all([drawPlan(false), drawPlan(true)]).then(([old, fresh]) => {
      blobs = { [V3]: old, [V4]: fresh }
      setUrls({ [V3]: URL.createObjectURL(old), [V4]: URL.createObjectURL(fresh) })
    })
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href)
      const raster = /\/versions\/([^/]+)\/pages\/\d+\/raster$/.exec(url.pathname)
      if (raster) {
        while (!blobs[raster[1]]) await new Promise((resolve) => setTimeout(resolve, 50))
        return reader ? new Response('{}', { status: 404 }) : new Response(blobs[raster[1]], { status: 200, headers: { 'content-type': 'image/png' } })
      }
      return original(input, init)
    }
    return () => {
      window.fetch = original
    }
  }, [reader])
  return urls
}

function Underlay() {
  const params = useSearchParams()
  const reader = params.get('reader') === '1'
  const urls = usePages(reader)
  const [open, setOpen] = useState(true)
  const [moving, setMoving] = useState(params.get('move') === '1')
  const underlay: SketchUnderlayView = reader ? { state: 'unavailable', elementId: 'page', ref: REF } : UNDERLAY
  const scene = useMemo(() => SCENE, [])
  return (
    <div data-testid="sketch-underlay-preview" className="bg-background flex min-h-screen flex-col items-center gap-4 p-4 sm:p-10">
      <button type="button" className="text-sm underline" onClick={() => setOpen(true)}>
        Skizze öffnen
      </button>
      <SketchDialog
        open={open && !moving}
        onOpenChange={setOpen}
        source=""
        elements={[]}
        title="Wand im Wohnen"
        revision={{ documentId: DOCUMENT_ID, baseVersionId: 'ver-5', scene, canWrite: !reader, underlay, projectId: 'dev-project' }}
      />
      {urls[V4] ? (
        <UnderlayMoveDialog
          open={moving}
          onOpenChange={setMoving}
          documentId={DOCUMENT_ID}
          baseVersionId="ver-5"
          underlay={UNDERLAY}
          onMoved={() => setMoving(false)}
          planOf={async () => PLAN}
          move={async () => ({ versionNumber: 6 })}
          rasterUrl={(ref) => urls[ref.versionId] ?? ''}
        />
      ) : null}
    </div>
  )
}

export default function SketchUnderlayPreview() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Suspense>
        <Underlay />
      </Suspense>
    </I18nProvider>
  )
}
