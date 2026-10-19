'use client'

/**
 * Dev preview for the IFC/BIM model surfaces.
 *
 * Renders the REAL explorer components (overview, spatial tree, element table,
 * property panel) plus the viewer's no-WebGPU fallback against fixture data
 * matching `tests/fixtures/ifc/sample-building.ifc`, so the layout is
 * reviewable and screenshottable without a backend, an upload, or a GPU.
 *
 * The 3D viewport itself is deliberately NOT exercised here: headless Chromium
 * has no WebGPU adapter, so a screenshot of it would be a picture of the
 * fallback either way — and the fallback is the state worth pinning, because it
 * is what a Safari or Firefox user actually sees.
 *
 * Not linked from anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { notFound } from 'next/navigation'
import {
  IfcElementTable,
  IfcModelHealthPanel,
  IfcModelOverview,
  IfcPropertyPanel,
  IfcSpatialTree,
} from '@/features/bim/components/ifc-model-explorer'
import { IfcModelCompare } from '@/features/bim/components/ifc-model-compare'
import { IfcModelViewer } from '@/features/bim/components/ifc-model-viewer'
import { ELEMENTS, SELECTED, SUMMARY } from '../_bim-fixtures'

export default function BimModelPreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <BimModelPreview />
}

function BimModelPreview(): JSX.Element {
  const [storey, setStorey] = useState<string | null>('Erdgeschoss')
  const [selected, setSelected] = useState<string | null>('g-w1')

  return (
    <div
      data-testid="bim-model-preview"
      className="bg-background text-foreground min-h-dvh p-6"
    >
      <div className="mx-auto grid max-w-[1200px] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="flex flex-col gap-5">
          <IfcModelOverview summary={SUMMARY} filename="wohnhaus-beispielgasse.ifc" />
          {SUMMARY.health && <IfcModelHealthPanel health={SUMMARY.health} />}
          <IfcSpatialTree summary={SUMMARY} selectedStorey={storey} onSelectStorey={setStorey} />
          <IfcElementTable
            elements={ELEMENTS}
            storeyFilter={storey}
            selectedGlobalId={selected}
            onSelect={(element) => setSelected(element.globalId)}
          />
          <IfcModelCompare
            modelId="model-v2"
            candidates={[
              {
                id: 'model-v1',
                documentId: 'doc-v1',
                projectId: 'p1',
                filename: 'wohnhaus-beispielgasse-v1.ifc',
                displayName: null,
                status: 'ready',
                schemaVersion: 'IFC4',
                elementCount: 171,
                errorMessage: null,
                summary: null,
        updatedAt: '2026-02-03T10:00:00.000Z',
              },
            ]}
          />
        </div>
        <div className="flex flex-col gap-4">
          <IfcModelViewer sourceUrl={null} elements={ELEMENTS} className="h-[320px]" />
          <section className="rounded-lg border p-3">
            <h2 className="mb-2 text-sm font-semibold">Properties</h2>
            <IfcPropertyPanel element={SELECTED} isLoading={false} error={null} />
          </section>
        </div>
      </div>
    </div>
  )
}
