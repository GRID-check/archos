'use client'

import { type FC } from 'react'

import { usePdfDocumentViewController, type PdfDocumentViewProps } from './use-pdf-document-view-controller'
import { PdfDocumentViewView } from './pdf-document-view-view'
export type { PdfDocumentViewProps } from './use-pdf-document-view-controller'
export { pointOnPage } from './pdf-document-view-helpers'

export const PdfDocumentView: FC<PdfDocumentViewProps> = (props) => {
  const controller = usePdfDocumentViewController(props)
  return <PdfDocumentViewView controller={controller} />
}
