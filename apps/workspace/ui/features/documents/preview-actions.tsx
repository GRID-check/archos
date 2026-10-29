'use client'

/**
 * A slot in the file preview for an action another feature owns.
 *
 * The first is „Als Skizze bearbeiten" on a filed sketch (ADR-0148), which is
 * the diagrams feature's editor. The diagrams feature already imports this one
 * (filing links into Files), so this feature importing the editor back would
 * close a feature cycle (`feature-cycle`, docs/contributing/module-seams.md).
 * The direction is kept by a context instead: the app shell provides the
 * action (`app/app/layout.tsx`), the preview renders whatever is provided, and
 * without a provider (a spec, a surface outside the shell) it renders nothing.
 */

import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { DocumentReview } from './hooks/use-document-review'

export interface PreviewDocumentActionProps {
  documentId: string
  contentType: string | null
  authoredBy: string | null
  /** The document's bytes changed (a new Fassung): the preview reloads them. */
  onChanged: () => void
  /** The preview's review of the document, when it runs one: a Skizze's editor draws its marks with it. */
  review?: DocumentReview | null
  /**
   * The review was asked for (a pin, a link with `?review=1&mark=`): a Skizze's review is its editor, so the
   * action opens it at that mark, and closing it hands the address back (`onOpenChange(false)`).
   */
  reviewRequest?: { open: boolean; annotationId: string | null; onOpenChange: (open: boolean) => void } | null
}

const PreviewDocumentActionContext = createContext<ComponentType<PreviewDocumentActionProps> | null>(null)

export function PreviewDocumentActionProvider({
  action,
  children,
}: {
  action: ComponentType<PreviewDocumentActionProps>
  children: ReactNode
}) {
  return <PreviewDocumentActionContext.Provider value={action}>{children}</PreviewDocumentActionContext.Provider>
}

/** The provided action for this document, or nothing. */
export function PreviewDocumentAction(props: PreviewDocumentActionProps) {
  const Action = useContext(PreviewDocumentActionContext)
  return Action ? <Action {...props} /> : null
}
