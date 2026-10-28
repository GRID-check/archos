

import { DocumentActionsMenu } from './document-actions'

import { DiscussDocumentButton } from './discuss-document-button'

import { DocumentReviewMode } from './review/document-review'

import { ReaderActions } from './file-preview-reader'

import type { FilePreviewController } from './use-file-preview-controller'

export function FilePreviewFooter({ controller }: { controller: FilePreviewController }) {
  const { actions, canCollaborate, canManage, closedProjectName, detailsOpen, discussHint, file, handleDeleted, inChat, moveInSheet, onRenamed, onReviewOpenChange, onReviewPage, pdfInWell, popoutHref, projectId, reader, readerAnnotate, review, reviewFocus, reviewOpen, reviewTool, scope, setDetailsOpen, sideways, t } = controller
  return (
    <>
        {reader && !sideways && (
          <ReaderActions
            layout="bar"
            detailsLabel={t('preview.peekViews.details')}
            detailsOpen={detailsOpen}
            onDetails={() => setDetailsOpen(true)}
            annotate={readerAnnotate}
            discuss={
              projectId && !inChat ? (
                <DiscussDocumentButton
                  projectId={projectId}
                  documentId={file.id}
                  filename={file.filename}
                  file={file}
                  hint={discussHint}
                  withIcon
                  size="default"
                  className="h-11 min-w-0 flex-1 gap-1.5"
                />
              ) : null
            }
            menu={
              <DocumentActionsMenu
                document={file}
                scope={scope}
                actions={['download', 'rename', 'delete']}
                canManage={canManage}
                surface="toolbar"
                moveInSheet={moveInSheet}
                side="top"
                onRenamed={onRenamed}
                onDeleted={handleDeleted}
              />
            }
          />
        )}

        {/* No footer page band. It stated the page count a second time, three
            rows below the "Pages" row that already stated it, in a band that cost
            the preview column ~32px of height on every document — the definition
            of a part that could be removed without losing anything. */}

        {pdfInWell && (
          <DocumentReviewMode
            open={reviewOpen}
            onOpenChange={onReviewOpenChange}
            review={review}
            documentName={actions.name}
            revisionLabel={
              file.versionCount && file.versionCount > 1
                ? t('review.revision', { number: file.versionCount })
                : null
            }
            canPickAssignee={canCollaborate}
            focusRequest={reviewFocus}
            popoutHref={popoutHref}
            initialTool={reviewTool ?? undefined}
            onPage={onReviewPage}
            // The Protokoll filed as a document: a project's file, in its own folder. Who may file there
            // (write in that folder) the review knows, and decides (`canAnnotate`).
            protocolFiling={
              projectId && scope !== 'officeShelf' && !closedProjectName ? { projectId, folderId: file.folderId } : null
            }
          />
        )}
    </>
  )
}
