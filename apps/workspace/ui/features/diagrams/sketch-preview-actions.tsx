'use client'

/**
 * The diagrams feature's action in the Files preview: „Als Skizze bearbeiten"
 * on a filed sketch (ADR-0148), and „Auf Seite zeichnen“ on a PDF page (S6). Mounted by the app shell (`app/app/layout.tsx`)
 * through the documents feature's slot, so the preview needs no import of the
 * editor (`features/documents/preview-actions.tsx` says why).
 */

import type { ReactNode } from 'react'
import { PreviewDocumentActionProvider } from '@/features/documents/preview-actions'
import { DrawOnPageAction } from './sketch/draw-on-page-action'
import { SketchReviseAction } from './sketch/sketch-revise-action'

export function SketchPreviewActions({ children }: { children: ReactNode }) {
  return (
    <PreviewDocumentActionProvider action={SketchReviseAction} pageAction={DrawOnPageAction}>
      {children}
    </PreviewDocumentActionProvider>
  )
}
