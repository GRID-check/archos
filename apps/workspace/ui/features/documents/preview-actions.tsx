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
 *
 * The second is a page action in the review's page menu: „Skizze auf dieser
 * Seite beginnen“ (S6, slice 1 of `docs/roadmap/working-on-a-plan.md`). A page
 * has one canvas, its review, so the entry lives there and not beside it; the
 * action is given the page in view and hands back the Skizze it made, which
 * the review opens with its own review (`onCreated`).
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

/** What a page action is given: the document, the page the review shows, and where its result goes. */
export interface ReviewPageActionProps {
  documentId: string
  page: number
  /** The action made a document (a Skizze on the page): the review opens it. */
  onCreated: (documentId: string) => void
  /** The action failed, in words the review shows in its toaster. */
  onFailed: (message: string) => void
}

const PreviewDocumentActionContext = createContext<ComponentType<PreviewDocumentActionProps> | null>(null)
const ReviewPageActionContext = createContext<ComponentType<ReviewPageActionProps> | null>(null)

export function PreviewDocumentActionProvider({
  action,
  pageAction = null,
  children,
}: {
  action: ComponentType<PreviewDocumentActionProps>
  pageAction?: ComponentType<ReviewPageActionProps> | null
  children: ReactNode
}) {
  return (
    <PreviewDocumentActionContext.Provider value={action}>
      <ReviewPageActionContext.Provider value={pageAction}>{children}</ReviewPageActionContext.Provider>
    </PreviewDocumentActionContext.Provider>
  )
}

/** The provided page action, a menu item of the review's page menu; null when nothing is provided. */
export const useReviewPageAction = (): ComponentType<ReviewPageActionProps> | null => useContext(ReviewPageActionContext)

/** The provided action for this document, or nothing. */
export function PreviewDocumentAction(props: PreviewDocumentActionProps) {
  const Action = useContext(PreviewDocumentActionContext)
  return Action ? <Action {...props} /> : null
}
