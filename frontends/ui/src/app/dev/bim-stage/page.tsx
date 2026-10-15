'use client'

/**
 * Dev preview for the REAL model stage — the full-screen dialog, not its atoms.
 *
 * `/dev/bim-viewport` pins each control on its own, which is right for the
 * material and wrong for the arrangement: whether the dock fits a 393 px phone,
 * whether the selection sheet clears the cut slider, where the notch inset
 * lands. Those are properties of the whole stage, so this mounts the whole
 * stage against a `fetch` shim that answers the model list, the element walk and
 * the element query from fixtures.
 *
 * There is still no picture of the building: headless Chromium has no WebGPU,
 * so the canvas is replaced by the honest "not available" notice and the
 * renderer-dependent tools are disabled. Everything AROUND the canvas is the
 * production code path — which is the part this preview exists to review.
 *
 * Deep-link the state you want to see: `?element=<GlobalId>` opens the
 * selection, `?tab=overview` the drawer, `?storey=Erdgeschoss` a level.
 *
 * Not linked from anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { ModelStage } from '@/features/bim/components/model-stage'
import type { BimModelHeaderView } from '@/features/bim/hooks/use-bim-model'
import { ELEMENTS, SELECTED, SUMMARY } from '../_bim-fixtures'

const PROJECT_ID = 'dev-project'

const MODEL: BimModelHeaderView = {
  id: 'model-v3',
  documentId: 'doc-v3',
  projectId: PROJECT_ID,
  filename: 'wohnhaus-beispielgasse_V3.ifc',
  displayName: null,
  status: 'ready',
  schemaVersion: 'IFC4',
  elementCount: ELEMENTS.length,
  errorMessage: null,
  summary: SUMMARY,
  updatedAt: '2026-05-04T09:30:15.400Z',
}

/** A realistic 22-character GlobalId: the string the old card clipped. */
const LONG_GLOBAL_ID = '1kTvXnbbzCWw8lcMd1dR4o'

// Module scope, not an effect: a shim installed from an effect loses the race
// with the stage's own mount-time fetches.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __bimStageShim?: boolean }
  if (!w.__bimStageShim) {
    w.__bimStageShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/query')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string; globalId?: string }
        if (body.op === 'elements') {
          return Response.json({ elements: ELEMENTS, total: ELEMENTS.length })
        }
        if (body.op === 'element') {
          return Response.json({
            element: { ...SELECTED, globalId: body.globalId ?? LONG_GLOBAL_ID },
          })
        }
        return new Response(null, { status: 404 })
      }
      if (url.includes('/source')) return Response.json({ url: '/dev/bim-stage/none.ifc' })
      if (url.includes('/bim/models')) return Response.json({ models: [MODEL] })
      if (url.includes('/profile')) return Response.json({ facts: {} })
      return real(input, init)
    }
  }
}

export default function BimStageDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Suspense fallback={null}>
        <ModelStage projectId={PROJECT_ID} onClose={() => {}} canCollaborate={false} />
      </Suspense>
    </I18nProvider>
  )
}
