

import { toast } from 'sonner'

import { AlertCircle, FolderTree, Info, RotateCcw, ShieldAlert, Sparkles } from 'lucide-react'

import { QuarantineFindings } from './quarantine-findings'

import { Button } from '@/components/ui/button'

import { InspectorGroup, InspectorRow, InspectorSection } from '@/components/ui/inspector-group'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'

import { cn } from '@/lib/utils'

import { failedWithPreviousVersion, isCitable } from './document-status'
import { PilotiReading } from './piloti-reading'
import { PageReadings } from './page-readings'

import { IngestFailureNotice } from './ingest-failure-notice'
import { AssignmentFaces } from './assignment-faces'
import { AuthorshipLine } from './authorship-line'
import { DocumentRevisions } from './document-revisions'

import { AssignPopover } from './assign-popover'

import { DiscussDocumentButton } from './discuss-document-button'

import { AnnotationsSummary } from './review/annotations-summary'

import { PeekPanel, IndexedSummary } from './file-preview-peek'
import { AskColleagueButton, HeldReview, ReaderDetails } from './file-preview-reader'

import { IfcFileFacts } from './file-preview-pane-lazy'
import type { FilePreviewController } from './use-file-preview-controller'

export function FilePreviewDetailsPanel({ controller }: { controller: FilePreviewController }) {
  const { actions, assigneeNames, canCollaborate, canManage, details, detailsFailed, detailsLoading, detailsOpen, discussHint, file, handleReingest, hasOwnershipBlock, hasVisualContent, heldVerdict, inChat, indexedReady, isFailed, isHeld, isModel, onAssigneesChanged, onLifecycleChanged, onOpenDocument, onReingested, onRevisionChanged, onTagsUpdated, openMarks, openReview, pdfInWell, peeking, projectId, reader, responsibleNames, retryDetails, review, reviewEnabled, reviewViewer, revisionsShown, scope, setDetailsOpen, setShownFinding, setShownPage, showIndexedHeading, showInlinePdf, showMetadataPanel, showPage, shownFinding, shownType, t } = controller
  return (
    <>
          {/* Right: indexed-metadata panel (FB-8; off only in the peek).
              The AI summary that grounds the agent's answers, the ingestion-detected
              key-value props, and the user-correctable tags. Status/type/size sit
              below it and are never gated (they predate the metadata panel).

              Stacked (mobile): plain flow content inside the body's single scroll —
              never `shrink-0` against an unbounded parent, which is what clipped it
              before. Split (@2xl+): a fixed-width column that scrolls on its own. */}
          {/* `scroll-fade-bottom` dissolves the last rows instead of guillotining
              them. This column routinely overflows — summary, six metadata rows,
              tags and the visual-details section — and a hard clip through the
              middle of a value reads as broken rather than as "there is more".
              The utility is scroll-driven, so the fade RETRACTS at the bottom of
              travel: its presence is the signal, not decoration. */}
          <PeekPanel peeking={peeking} value="details">
            <ReaderDetails
              sheet={reader}
              open={detailsOpen}
              onOpenChange={setDetailsOpen}
              title={t('preview.peekViews.details')}
              description={t('preview.dialogLabel', { name: actions.name })}
            >
            <div
              data-testid="file-preview-rail"
              className={
                reader
                  ? // In the reader's sheet: the rail's content, on the sheet's
                    // own paper, scrolling with it and clear of the home indicator.
                    'flex flex-col px-4 pt-1 pb-[max(1.25rem,env(safe-area-inset-bottom))]'
                  : peeking
                  ? // The details view of the peek: the whole column, scrolling
                    // on its own, on the same sunken ground the stage uses.
                    'scroll-fade-bottom bg-surface-sunken border-base mx-3 mb-3 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain rounded-lg border p-4'
                  : 'scroll-fade-bottom bg-surface-sunken @2xl:w-[280px] @2xl:shrink-0 @2xl:min-h-0 @2xl:overflow-y-auto @2xl:overscroll-contain @2xl:border-l @2xl:border-t-0 @2xl:pb-4 flex w-full flex-col border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))]'
              }
            >
              {/* WHO OWNS THIS DOCUMENT, AND WHAT YOU CAN ASK OF IT.

                The byline, who is responsible and „Piloti dazu fragen" all used
                to sit in the chrome above the document, where they made the row
                wrap and where each was conditional. None of them acts on the
                FILE: they say where the document came from, who is on the hook
                for it, and what the agent can do with it — which is the rail's
                whole subject. The Ask button in particular belongs next to the
                summary that tells the reader whether asking is worth it.

                It leads the rail, above the model facts and the summary, so
                „Verantwortlich" and Ask never need a scroll. In the split layout
                (@2xl+) it is level with the top of the document; stacked, it is
                the first thing under the preview. */}
              {hasOwnershipBlock && (
              <div className="mb-5 space-y-2.5">
                {/* Provenance, not status: the badge is up in the header with
                  the name. „Von Piloti erstellt" leads the rail instead, because
                  for the one document where it appears it is the reason the Ask
                  button below is grey. */}
                <AuthorshipLine authoredBy={file.authoredBy} />
                {/* Responsibility, as one more label/value row so it reads with
                  the facts below rather than as chrome. Never merged with the
                  byline above: provenance and responsibility are two answers, and
                  the design forbids reading them as one. */}
                {canCollaborate && (
                  /* A contact row: the face and the NAME, „Verantwortlich" under
                    it. The row used to read „Verantwortlich · MH · Bearbeiten",
                    and initials are a thing to recall, not to recognise; with
                    the label, the name and the control on one 248px line the
                    name was the part that could not fit. */
                  <InspectorGroup className="mb-3.5" data-testid="file-preview-responsible">
                    <Item className="gap-2.5 px-3 py-2 hover:bg-transparent">
                      <AssignmentFaces assignees={file.assignees} faceOnly />
                      <ItemContent>
                        <ItemTitle className="text-xs/5">
                          {responsibleNames || t('assignment.unassigned')}
                        </ItemTitle>
                        <ItemDescription className="text-[11px]/4">{t('assignment.responsible')}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <AssignPopover
                          documentId={file.id}
                          assignees={file.assignees ?? []}
                          onChanged={(next) => onAssigneesChanged?.(next)}
                        />
                      </ItemActions>
                    </Item>
                  </InspectorGroup>
                )}
                {/* Full width, stacked, in the rail's own column. In the header
                  these were two 90px pills competing with four icon controls for
                  the same row; here they are the block's conclusion, and the
                  reader has just been told whether the document is citable. */}
                {/* „Besprechen" — never conditional on the document being
                  citable any more, and that is the whole change.

                  This control used to be a PAIR: an enabled „Piloti dazu fragen"
                  for a citable file and a greyed-out twin for everything else,
                  with a hint explaining the grey. The grey covered exactly the
                  documents a reader most wants to talk about — every report Piloti
                  wrote, and every version nobody has published — because a turn
                  could only reach a document through the retrieval index, and only
                  a published version is dispatched to it (ADR-0054). The turn now
                  reads an unpublished subject version's own bytes into the
                  conversation's working directory, so the reason for the grey is
                  gone and the pair collapses into one always-live button.

                  What survives is the SENTENCE: `discussHint` still says whether
                  this document is in the knowledge base, because that changes what
                  the answer will be able to cite — it no longer changes whether the
                  conversation can happen. */}
                {projectId && !inChat && !reader && (
                  <DiscussDocumentButton
                    projectId={projectId}
                    documentId={file.id}
                    filename={file.filename}
                    file={file}
                    hint={discussHint}
                    withIcon
                    className="w-full gap-1.5"
                  />
                )}
                {projectId && canCollaborate && isCitable(file) && (
                  <AskColleagueButton projectId={projectId} file={file} documentId={file.id} />
                )}
              </div>
              )}
              {/* The building's own numbers lead the rail: they are what the file
                IS. Ungated by the metadata flag, which covers what INGESTION
                derived — these come out of the IFC itself. Renders nothing until
                a model has actually been read. */}
              {isModel && (
                <IfcFileFacts
                  documentId={file.id}
                  projectId={projectId}
                  className="mb-5"
                />
              )}
              {/* What Piloti made of the document, in its own words.
                Promoted out of the fact list and onto a raised card: it is the
                single most valuable thing on this rail — the answer to "does the
                agent actually understand this file" — and it used to sit as one
                more 12.5px paragraph between an eyebrow and six key/value rows,
                read at the same weight as the MIME type. */}
              {showIndexedHeading && (
                <InspectorSection label={t('preview.indexed.title')} icon={Sparkles}>
                  {/* ONE region for one statement. The summary, how much was read
                    and what Piloti took the file to be are a single answer to
                    "does the agent understand this document", and they used to
                    be a card and two loose blocks under it. */}
                  <InspectorGroup>
                    {indexedReady ? (
                      <>
                        {/* Keyed by file so a newly-selected document always
                          starts collapsed and re-measures against its own text. */}
                        {file.summary && <IndexedSummary key={file.id} summary={file.summary} />}
                        {/* What Piloti took the document to be, and the way to
                            correct it — see `piloti-reading.tsx` for why this is
                            no longer an always-open tag form. */}
                        <div className={cn('p-3', file.summary && 'border-border/60 border-t')}>
                          <PilotiReading file={file} canManage={canManage} onTagsUpdated={onTagsUpdated} projectId={projectId} />
                        </div>
                      </>
                    ) : (
                      <p className="text-muted-foreground p-3 text-xs leading-relaxed">
                        {t('preview.indexed.pending')}
                      </p>
                    )}
                  </InspectorGroup>
                </InspectorSection>
              )}

              {/* FASSUNGEN UND FREIGABE — one section, right under what Piloti
                made of the document.

                It used to be two: „Fassungen" here (the older documents linked
                under other names) and „Freigabe und Fassungen" at the bottom of
                the rail (this document's own uploads and the approval controls).
                Both were the document's history; neither could be believed alone.
                Now the header says where the document stands, in words, and the
                body is one timeline.

                OUTSIDE the indexed section on purpose: a report Piloti wrote is
                never indexed, and it is exactly the document whose approval is
                the point. The section is shut at rest and opens itself when
                something is asked of this reader (a decision, or Piloti's
                suggestion). Review controls need the reader's lifecycle
                permissions, which only the Files workspace resolves; the Archiv
                sheet and the chat peek show the timeline and the suggestion
                without them. */}
              {revisionsShown && (
                <DocumentRevisions
                  key={file.id}
                  file={file}
                  canManage={canManage}
                  viewer={reviewViewer}
                  names={assigneeNames}
                  onOpenDocument={onOpenDocument}
                  onRevisionChanged={onRevisionChanged}
                  onLifecycleChanged={(summary) =>
                    onLifecycleChanged?.(file.id, {
                      versionState: summary.state,
                      versionCount: summary.versionCount,
                    })
                  }
                  openMarks={openMarks}
                  className={cn(showIndexedHeading && 'mt-5')}
                />
              )}

              {/* ANMERKUNGEN — how much is open on the pages, and the door into
                the focused review where marks are set and worked. After the
                approval state, before the page readings: what the office found
                on the sheets is work waiting, and the readings are the longest
                list on the rail. */}
              {reviewEnabled && (
                <AnnotationsSummary
                  review={review}
                  onOpenReview={openReview}
                  className={cn((showIndexedHeading || revisionsShown) && 'mt-5')}
                />
              )}

              {/* After the approval state, not before it: whether the office
                stands behind the document outranks what is on sheet 7, and this
                list is the longest thing on the rail. */}
              {showMetadataPanel && hasVisualContent && (
                <PageReadings
                  details={details}
                  loading={detailsLoading}
                  failed={detailsFailed}
                  onRetry={retryDetails}
                  // Only where the well IS the inline PDF viewer: an image, a
                  // PDF whose preview failed or is still loading has no page to
                  // turn to, and a link that does nothing is worse than none.
                  onShowPage={pdfInWell && showInlinePdf ? showPage : undefined}
                  className={cn((showIndexedHeading || revisionsShown) && 'mt-5')}
                />
              )}

              {/* Where the file came from, the one fact about the FILE that has
                no other home. Project, Type, Size and Updated used to be rows
                here: the project is the one the reader is standing in, format
                and size are the line under the name, and the date is on the
                Fassung in „Fassungen und Freigabe". Each was a row the eye had
                to pass on the way to something it came for. */}
              {file.originPath && (
                <InspectorSection
                  label={t('preview.properties')}
                  icon={Info}
                  className="mt-5"
                >
                  <InspectorGroup>
                    {/* WHERE THIS FILE CAME FROM, so the reader can go back to it.
                       The alternative on offer was download-and-edit, which makes
                       a duplicate that the office server never hears about and
                       that diverges from the moment it is saved. A path they can
                       copy and paste into Explorer or Finder is the whole
                       feature. Recorded by a folder upload only — a picked file
                       genuinely has no origin path, and the row is absent rather
                       than empty. */}
                    <InspectorRow label={t('preview.originPath')} icon={FolderTree}>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard
                            ?.writeText(file.originPath!)
                            .then(() => toast.success(t('preview.originPathCopied')))
                            .catch(() => toast.error(t('preview.originPathCopyFailed')))
                        }}
                        title={file.originPath}
                        className="hover:text-foreground/80 block max-w-full truncate text-left font-mono font-normal underline-offset-2 hover:underline"
                        data-testid="file-origin-path"
                      >
                        {file.originPath}
                      </button>
                    </InspectorRow>
                  </InspectorGroup>
                </InspectorSection>
              )}

              {/* Failure reason + re-ingestion affordance (re-ingest is a mutation,
                so the button is hidden for read-only viewers). */}
              {isFailed && (
                <div className="mt-4 space-y-2.5 border-t pt-4">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
                    <div className="min-w-0 space-y-1">
                      <p className="text-destructive text-sm font-medium">
                        {t('preview.ingestionFailed')}
                      </p>
                      <IngestFailureNotice
                        errorMessage={file.errorMessage}
                        sentenceClassName="text-muted-foreground"
                        testId="preview-ingest-failure"
                      />
                      {/* A failed NEW version: the row already points at its
                        bytes, while the ingestor kept the previous version's
                        passages. Without this the two surfaces disagree
                        silently — the download is the new file, the answers
                        quote the old one. */}
                      {failedWithPreviousVersion(file) && (
                        <p className="text-muted-foreground break-words text-xs">
                          {t('preview.ingestionFailedPreviousVersionKept')}
                        </p>
                      )}
                    </div>
                  </div>
                  {/* A file that failed for a lasting reason would fail the same
                    way again (`lib/documents/retry-policy.ts`): no button that
                    can only repeat the failure, the way out instead. */}
                  {file.retryable === false ? (
                    <p className="text-muted-foreground break-words text-xs" data-testid="preview-retry-would-fail-again">
                      {t('preview.retryWouldFailAgain')}
                    </p>
                  ) : (
                    canManage && (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full gap-2"
                        onClick={handleReingest}
                        disabled={actions.isReingesting}
                      >
                        <RotateCcw className="size-4" aria-hidden />
                        {actions.isReingesting
                          ? t('preview.retryingIngestion')
                          : t('preview.retryIngestion')}
                      </Button>
                    )
                  )}
                </div>
              )}

              {isHeld && (
                <div className="mt-4 space-y-2.5 border-t pt-4" data-testid="preview-held">
                  <div className="flex items-start gap-2">
                    <ShieldAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
                    <div className="min-w-0 space-y-2">
                      <p className="text-warning text-sm font-medium">{t('preview.heldTitle')}</p>
                      <QuarantineFindings
                        verdict={heldVerdict}
                        // A page to jump to only where the well is the PDF viewer.
                        onShowFinding={
                          shownType === 'application/pdf'
                            ? (finding) => {
                                // The finding is the page asked for now; a page
                                // reading picked earlier must not mask it.
                                setShownPage(null)
                                setShownFinding(finding)
                              }
                            : undefined
                        }
                        shownFinding={shownFinding}
                        testId="preview-held-findings"
                      />
                      {/* The decision, where the reviewer is looking at the
                          document and the finding, rather than only in the
                          Quarantäne list. The uploader gets the request instead. */}
                      <HeldReview
                        key={file.id}
                        documentId={file.id}
                        scope={scope}
                        actions={actions}
                        onReleased={(status) => onReingested?.(file.id, status)}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* No Delete block here any more. A full-width red button under the
                tags made the most dangerous operation the loudest thing on a
                column whose job is to DESCRIBE the document, and its confirm step
                expanded in place, pushing the rest of the rail down. Both moved
                into the header's actions menu, beside the other controls that act
                on this file. */}

              <div className="flex-1" />
            </div>
            </ReaderDetails>
          </PeekPanel>
    </>
  )
}
