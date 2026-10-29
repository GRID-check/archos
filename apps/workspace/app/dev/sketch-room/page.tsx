'use client'

/**
 * Dev preview — two people on one Skizze, live.
 *
 * Open this page in two tabs (or two windows side by side): each is a person
 * in the same document room, joined over a `BroadcastChannel` instead of the
 * server (`broadcast-room.ts`). Draw in one and the other follows; its
 * pointer, selection and name show on the other canvas.
 *
 *   ?as=anna | max      who this tab is (default anna)
 *   ?role=reader        open as someone who may only read: view mode, no save
 *
 * Saving writes a Fassung to a stand-in for `PUT /api/documents/{id}/sketch`
 * kept in this browser's `localStorage`, which answers 409 for a stale base
 * the way the route does, so „someone saved first" can be tried with two
 * tabs. `window.__sketchRoomDropRate = 1` makes a tab deaf to the others for a
 * while; set it back to 0 and the hash beacons repair the scene.
 *
 * Pinned to German. 404s outside development.
 */

import { notFound, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { I18nProvider } from '@/i18n'
import { SketchDialog } from '@/features/diagrams/sketch/sketch-dialog'
import { broadcastRoomTransport } from './broadcast-room'

const DOCUMENT_ID = 'dev-sketch-room'
const STORE_KEY = 'dev-sketch-room:fassung'

const PEOPLE: Record<string, { userId: string; name: string }> = {
  anna: { userId: 'user_anna', name: 'Anna Berger' },
  max: { userId: 'user_max', name: 'Max Huber' },
}

/** The Raumprogramm every tab opens with, as Fassung 1. */
const FIRST_SCENE = {
  type: 'excalidraw',
  version: 2,
  elements: [
    { type: 'ellipse', id: 'wohnen', x: 0, y: 0, width: 200, height: 110, version: 1, versionNonce: 11, isDeleted: false, index: 'a0', backgroundColor: '#b2f2bb', fillStyle: 'hachure', strokeColor: '#1e1e1e', roughness: 1, strokeWidth: 1, seed: 1 },
    { type: 'ellipse', id: 'kochen', x: 300, y: 0, width: 180, height: 100, version: 1, versionNonce: 12, isDeleted: false, index: 'a1', backgroundColor: '#b2f2bb', fillStyle: 'hachure', strokeColor: '#1e1e1e', roughness: 1, strokeWidth: 1, seed: 2 },
    { type: 'ellipse', id: 'schlafen', x: 0, y: 220, width: 180, height: 100, version: 1, versionNonce: 13, isDeleted: false, index: 'a2', backgroundColor: '#a5d8ff', fillStyle: 'hachure', strokeColor: '#1e1e1e', roughness: 1, strokeWidth: 1, seed: 3 },
  ],
}

interface StoredRevision {
  versionId: string
  versionNumber: number
  scene: { elements: object[] }
}

function readStoredRevision(): StoredRevision {
  try {
    const stored = window.localStorage.getItem(STORE_KEY)
    if (stored) return JSON.parse(stored) as StoredRevision
  } catch {
    // A blocked store is a fresh room.
  }
  return { versionId: 'ver-1', versionNumber: 1, scene: FIRST_SCENE }
}

/** The route, in this browser: GET the latest Fassung, PUT the next one unless its base is stale. */
function useStandInRoute() {
  useEffect(() => {
    const original = window.fetch
    const path = `/api/documents/${DOCUMENT_ID}/sketch`
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.endsWith(path)) return original(input, init)
      const current = readStoredRevision()
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (init?.method !== 'PUT') {
        return json(200, { documentId: DOCUMENT_ID, versionId: current.versionId, canWrite: true, title: 'Raumprogramm', scene: { ...FIRST_SCENE, ...current.scene } })
      }
      const body = JSON.parse(String(init.body)) as { baseVersionId: string | null; scene: { elements: object[] } }
      if (body.baseVersionId !== current.versionId) {
        return json(409, { error: 'A newer version exists', details: { reason: 'stale_base_version', currentVersionId: current.versionId } })
      }
      const next = { versionId: `ver-${current.versionNumber + 1}`, versionNumber: current.versionNumber + 1, scene: body.scene }
      window.localStorage.setItem(STORE_KEY, JSON.stringify(next))
      return json(200, { documentId: DOCUMENT_ID, versionId: next.versionId, versionNumber: next.versionNumber, pdf: null })
    }
    return () => {
      window.fetch = original
    }
  }, [])
}

function Room() {
  const params = useSearchParams()
  const who = PEOPLE[params.get('as') ?? 'anna'] ?? PEOPLE.anna
  const canWrite = params.get('role') !== 'reader'
  useStandInRoute()
  const [open, setOpen] = useState(true)
  const [opened, setOpened] = useState<StoredRevision | null>(null)
  useEffect(() => {
    if (open) setOpened(readStoredRevision())
  }, [open])
  const transport = useMemo(() => broadcastRoomTransport(DOCUMENT_ID, { ...who, canWrite }), [who, canWrite])

  return (
    <div data-testid="sketch-room-preview" className="bg-background flex min-h-screen flex-col items-center gap-4 p-4 sm:p-10">
      <p className="text-muted-foreground max-w-xl text-center text-sm">
        Diese Seite in einem zweiten Tab öffnen, mit <code>?as=max</code>: zwei Personen in einer Skizze.{' '}
        {canWrite ? null : 'Dieser Tab darf nur lesen.'}
      </p>
      <button type="button" className="text-sm underline" onClick={() => setOpen(true)} data-testid="sketch-room-open">
        Skizze öffnen
      </button>
      {opened ? (
        <SketchDialog
          open={open}
          onOpenChange={setOpen}
          source=""
          elements={[]}
          title="Raumprogramm"
          revision={{
            documentId: DOCUMENT_ID,
            baseVersionId: opened.versionId,
            scene: opened.scene,
            canWrite,
            roomTransport: transport,
          }}
        />
      ) : null}
    </div>
  )
}

export default function SketchRoomPreview() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Suspense>
        <Room />
      </Suspense>
    </I18nProvider>
  )
}
