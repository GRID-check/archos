

import { Download, Maximize2, RotateCcw, ScanEye, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import { documentFileUrl } from '@/lib/documents/urls'

import { isOptimizerEligible } from '@/lib/images/optimizable'

import { FileExtChip } from './file-ext-chip'

import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'

import { DocumentActionsMenu } from './document-actions'
import { DocumentStatusBadge, isCitable } from './document-status'

import { DocumentVersionStateBadge } from './document-version-badge'

import { DiscussDocumentButton } from './discuss-document-button'
import { dropFileSubject } from '../lib/open-file-peek'

import { Presence } from './review/document-review'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import { ProjectClosedChip } from '@/components/projects/project-status'

import { ReaderActions, ReaderHeader } from './file-preview-reader'

import type { FilePreviewController } from './use-file-preview-controller'

export function FilePreviewChrome({ controller }: { controller: FilePreviewController }) {
  const { Icon, actions, canExpandPreview, canManage, closedProjectName, detailsOpen, detectedType, discussHint, file, fileFacts, handleDeleted, inChat, isImage, isLargePreviewOpen, isOfficeRendition, moveInSheet, onClose, onRenamed, openReview, peeking, presenceSentence, previewGone, previewImageUrl, previewUrl, projectId, reader, readerAnnotate, review, reviewEnabled, scope, setDetailsOpen, setIsLargePreviewOpen, showMetadataPanel, sideways, t } = controller
  return (
    <>
        {/* Peek chrome lives on the host — this header is the modal/expanded one,
            and it is deliberately the SAME six elements on every document.

            It used to be the surface's noticeboard: the name, the byline, the
            type · status line, the assignment faces with their popover, "Piloti
            dazu fragen", "Kollegin fragen", Herunterladen, the actions menu,
            expand and close. Ten things, five of them conditional, in a row that
            had to WRAP on anything narrower than a laptop — so the chrome
            reflowed into two or three lines as you moved between files, and the
            controls that were always there moved to make room for the ones that
            were not. A header that changes shape per document cannot be learned;
            the reader re-reads it every time.

            What is left is what acts on THIS FILE AS A FILE — download it, rename
            or delete it, enlarge it, close it — beside the document's identity:
            its name, and under it the two chips that say WHICH document this is,
            status and category. Every one of those is unconditional (or as good
            as: the menu goes with `canManage`, expand with a previewable format),
            so the shape is the same at every width and the icons never move.
            Everything that DESCRIBES what Piloti made of the document, and
            everything that acts on it, moved to the rail — see the identity block
            there. */}
        {reader && (
          <ReaderHeader
            name={actions.name}
            title={actions.isRenamed ? `${actions.name}\n${file.filename}` : actions.name}
            facts={fileFacts}
            contentType={file.contentType}
            status={
              <>
                {!isCitable(file) && (
                  <DocumentStatusBadge status={file.status} queueAhead={file.queueAhead} className="shrink-0" />
                )}
                <DocumentVersionStateBadge
                  versionState={file.versionState}
                  versionCount={file.versionCount}
                  lifecycle={file.lifecycle ?? undefined}
                  authoredBy={file.authoredBy}
                  className="shrink-0"
                  testId="file-preview-lifecycle-badge"
                />
              </>
            }
            closeLabel={t('preview.closePreview')}
            onClose={onClose}
            actions={
              sideways ? (
                <ReaderActions
                  layout="header"
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
                        className="h-9 gap-1.5 pointer-coarse:h-11"
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
                      onRenamed={onRenamed}
                      onDeleted={handleDeleted}
                    />
                  }
                />
              ) : null
            }
          />
        )}
        {!peeking && !reader && (
          <div className="@md:gap-x-3 @md:px-5 flex shrink-0 items-start gap-x-2 border-b px-3.5 pb-3.5 pt-[max(0.875rem,env(safe-area-inset-top))] sm:pt-3.5">
            <FileExtChip filename={file.filename} fallback={<Icon className="size-4" />} />
            {/* The name the document was GIVEN, if it was given one. `title`
              carries it in full for the truncated case — and the file's own name
              underneath it, which is the answer to "which file is this actually"
              for anyone who renamed it. */}
            <div className="min-w-0 flex-1">
              <h3
                className="text-foreground truncate text-sm font-semibold leading-tight tracking-[-0.01em]"
                title={actions.isRenamed ? `${actions.name}\n${file.filename}` : actions.name}
              >
                {actions.name}
              </h3>
              {/* The subheading: what kind of document this is, and — only when
                it matters — that Piloti cannot quote it.

                „Zitierbar" is the case for almost every document in the library,
                so a green badge saying so was a chip that appeared on everything
                and therefore distinguished nothing; a reader scanning the header
                learned only that the app has badges. The states worth a chip are
                the ones that change what the reader can do next: „Wird
                verarbeitet", „Fehlgeschlagen", and „Abgelegt" for a report Piloti
                wrote and deliberately never indexed. In all three the Ask button
                in the rail is grey, and this chip is why. Citable stays silent,
                and the ordinary case has an ordinary header.

                Neither chip is restated in the rail: the Status row and the
                Document type row are gone from Properties, because the same fact
                stated twice on one surface reads as two facts. */}
              {/* `overflow-hidden` on the row and `shrink` on the type badge, and
                both are load-bearing at phone width: `Badge` is `w-fit shrink-0`
                by construction, so `min-w-0` alone never made it narrow — at
                390px „Grundriss" simply ran out of the name column and under the
                Download button beside it. It truncates now instead. The status
                badge keeps `shrink-0` on purpose: „Wird verarbeitet" clipped to
                „Wird ver…" is a state nobody can read, and it is the chip that
                explains why the Ask button in the rail is grey. */}
              <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden">
                {/* What the file is, before any chip: „PDF · 24 Seiten · 4,8 MB",
                  the line the chat peek's header already carries. Format and
                  size used to be two rows of the rail's Properties list, read
                  only by someone who scrolled to them. */}
                {fileFacts && (
                  <span
                    className="text-muted-foreground min-w-0 shrink truncate text-xs tabular-nums"
                    // The MIME type a reader cannot parse, for whoever needs it.
                    title={file.contentType ?? undefined}
                    data-testid="file-preview-facts"
                  >
                    {fileFacts}
                  </span>
                )}
                {!isCitable(file) && (
                  <DocumentStatusBadge
                    status={file.status}
                    queueAhead={file.queueAhead}
                    className="shrink-0"
                  />
                )}
                {/* WHERE THE DOCUMENT STANDS, at the top with its name.

                  „Fassungen und Freigabe" sits in the rail, which is right
                  for the machinery and wrong for the one word: whether the office
                  stands behind this document is a fact about the document, in the
                  class of its name and its type, and a reader should not have to
                  scroll a rail to the bottom to learn it.

                  It obeys `showsVersionStateBadge` rather than `always`, so it is
                  silent on the ordinary upload — one version, born published, a
                  person put it there — exactly like the file card's. A chip that
                  appeared on every document in the library would distinguish
                  nothing, which is the same argument the „Zitierbar" chip lost
                  two paragraphs up.

                  Restating it on the section's own row at the far end of the rail
                  is not the „same fact twice" the Properties rows were: those sat
                  in the reader's eyeful directly under this header. These two are
                  never on screen together — one names the document, the other
                  labels the section you have just opened. */}
                <DocumentVersionStateBadge
                  versionState={file.versionState}
                  versionCount={file.versionCount}
                  lifecycle={file.lifecycle ?? undefined}
                  authoredBy={file.authoredBy}
                  className="shrink-0"
                  testId="file-preview-lifecycle-badge"
                />
                {/* A file of a closed project says which project, and that it is
                    closed (ADR-0090), wherever it is previewed. */}
                {closedProjectName !== null && (
                  <ProjectClosedChip projectName={closedProjectName} className="shrink-0" />
                )}
                {/* The well shows a PDF made from this file, not the file. Said
                  once, calmly, next to the name, so nobody mistakes the rendition's
                  pagination or fonts for the original's; Download beside it still
                  hands out the original. */}
                {isOfficeRendition && previewUrl && (
                  <Badge
                    variant="outline"
                    className="min-w-0 max-w-full shrink font-normal"
                    data-testid="file-preview-rendition-note"
                    title={t('preview.renditionNote', { name: file.filename })}
                  >
                    <span className="truncate">
                      {t('preview.renditionNote', { name: file.filename })}
                    </span>
                  </Badge>
                )}
                {showMetadataPanel && detectedType && (
                  <Badge variant="secondary" className="min-w-0 max-w-full shrink font-normal">
                    <span className="truncate">{detectedType}</span>
                  </Badge>
                )}
              </div>
            </div>
            {/* Who is in the document right now. Following someone is the
              review's; here the faces only tell, and the words say who. */}
            {reviewEnabled && presenceSentence && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="img"
                    tabIndex={0}
                    aria-label={presenceSentence}
                    data-testid="file-preview-presence"
                    className="flex h-8 shrink-0 items-center rounded-full outline-none focus-visible:ring-2"
                  >
                    <Presence review={review} />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{presenceSentence}</TooltipContent>
              </Tooltip>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="pointer-coarse:min-w-11 @md:px-3 h-8 shrink-0 gap-1.5 px-2"
              onClick={() => void actions.download()}
              disabled={actions.isDownloading}
              aria-label={t('preview.download')}
              title={t('preview.download')}
            >
              <Download className="size-3.5" aria-hidden />
              <span className="@md:inline hidden">{t('preview.download')}</span>
            </Button>
            {/* Rename and delete. In the header, with the controls that act on this
              document — not in the metadata rail, which describes it. */}
            <DocumentActionsMenu
              document={file}
              scope={scope}
              actions={['rename', 'delete']}
              canManage={canManage}
              surface="toolbar"
              moveInSheet={moveInSheet}
              onRenamed={onRenamed}
              onDeleted={handleDeleted}
            />
            {/* A PDF that carries Anmerkungen opens full screen AS the review,
              with its marks, the room and the tools; the bare enlarged viewer
              showed the same pages without any of them. Images (and a PDF that
              cannot carry marks) keep the enlarged viewer. */}
            {reviewEnabled ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    onClick={() => openReview()}
                    aria-label={t('annotations.openReview')}
                    data-testid="file-preview-open-review"
                  >
                    <ScanEye className="size-4" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <span className="block">{t('annotations.openReview')}</span>
                  <span className="block opacity-80">{t('annotations.openReviewHint')}</span>
                </TooltipContent>
              </Tooltip>
            ) : canExpandPreview && previewUrl && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                onClick={() => setIsLargePreviewOpen(true)}
                aria-label={t('preview.expandPreview')}
                title={t('preview.expandPreview')}
              >
                <Maximize2 className="size-4" />
              </Button>
            )}
            {onClose && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                onClick={onClose}
                aria-label={t('preview.closePreview')}
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
        )}

        {actions.downloadFailed && (
          <div
            role="alert"
            className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2"
          >
            {/* THE SAME DEAD END, ONE LEVEL DOWN. A download of a document that
                is not there any more fails for the reason the preview already
                established, and offering "Erneut versuchen" for it is the same
                button-until-you-give-up loop — so when the preview has already
                said the document is gone, this says it too, and offers the way
                out rather than the retry. */}
            <p className="text-destructive text-xs">
              {previewGone ? t('preview.gone') : t('preview.downloadFailed')}
            </p>
            {previewGone ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5"
                onClick={() =>
                  dropFileSubject({
                    cleared: t('preview.goneCleared'),
                    undo: t('preview.goneUndo'),
                  })
                }
              >
                <X className="size-3.5" aria-hidden />
                {t('preview.goneAction')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5"
                onClick={() => void actions.download()}
                disabled={actions.isDownloading}
              >
                <RotateCcw className="size-3.5" aria-hidden />
                {t('preview.tryAgain')}
              </Button>
            )}
          </div>
        )}

        {canExpandPreview && previewUrl && !reviewEnabled && (
          <PdfViewerDialog
            open={isLargePreviewOpen}
            onOpenChange={setIsLargePreviewOpen}
            fileName={actions.name}
            // The enlarged view is the other place a full-size original used to
            // cross the wire whole, so it gets the optimizable path too when there
            // is one. A PDF goes to the same-origin stream instead of the
            // presigned URL: the enlarged viewer renders the document with pdf.js,
            // which FETCHES it, and a cross-origin fetch has no CORS policy to
            // land on. See `documentFileUrl`.
            src={isImage ? (previewImageUrl ?? previewUrl) : documentFileUrl(file.id)}
            isImage={isImage}
            // Only ever consulted in image mode, so it is asked of the IMAGE src:
            // the PDF branch renders through pdf.js on the same-origin stream and
            // never reaches the optimizer at all. `isOptimizerEligible` is checked
            // against the optimizer's real allow-list (see `optimizable.ts`).
            imageUnoptimized={!isOptimizerEligible(previewImageUrl ?? previewUrl)}
          />
        )}

    </>
  )
}
