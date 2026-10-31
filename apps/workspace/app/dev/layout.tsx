import { notFound } from 'next/navigation'
import { type ReactNode } from 'react'
import { SketchPreviewActions } from '@/features/diagrams/sketch-preview-actions'

/**
 * Server gate for every `/dev/*` preview route.
 *
 * The previews are fixture-driven component galleries, not product surfaces, so
 * they must not resolve outside development. Each page used to gate itself, but
 * a preview page is a `'use client'` component and `notFound()` is a server
 * primitive — thrown from a client render it is not reliably intercepted, so a
 * production request could land on a client-side error instead of a 404.
 *
 * This layout is a Server Component, so the check runs on a server boundary and
 * every nested preview route inherits it: none can forget the gate, and no new
 * preview has to remember to add one.
 *
 * It also provides what the app shell provides (`app/app/layout.tsx`): the
 * Files preview's action slot, so a preview of the pane or the review shows
 * „Als Skizze bearbeiten“ and the review's page menu as the product does
 * (`/dev/annotations?doc=dev-doc-annotations&review=1`, the header's ⋯).
 */
export default function DevLayout({ children }: { children: ReactNode }): ReactNode {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <SketchPreviewActions>{children}</SketchPreviewActions>
}
