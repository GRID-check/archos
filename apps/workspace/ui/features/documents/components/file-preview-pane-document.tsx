

import { FileTextPage } from './file-text-page'
import Image from 'next/image'
import type { ReactNode } from 'react'

import { Download, RotateCcw, Sparkles, X } from 'lucide-react'

import { Button } from '@/components/ui/button'

import { SectionLabel } from '@/components/ui/section-label'

import { ClampedText } from '@/components/ui/clamped-text'
import { documentFileUrl } from '@/lib/documents/urls'

import { isOptimizerEligible } from '@/lib/images/optimizable'
import { cn } from '@/lib/utils'

import { PdfDocumentView } from '@/features/knowledge/components/pdf-document-view'

import { dropFileSubject } from '../lib/open-file-peek'

import { ReviewPageLayer } from './review/review-page-layer'
import { InlineMarkPeek } from './inline-mark-peek'

import { PEEK_SUMMARY_CLAMP_LINES, PageMock, PeekPanel, PeekStage } from './file-preview-peek'

import { IfcFilePreview } from './file-preview-pane-lazy'
import type { FilePreviewController } from './use-file-preview-controller'

/** A Skizze's sheet: the picture in a box exactly its size, its marks over it; any other picture alone. */
function SheetMarks({ on, marks, children }: { on: boolean; marks: ReactNode; children: ReactNode }) {
  if (!on) return <>{children}</>
  return (
    <div className="relative h-fit max-h-full w-fit max-w-full" data-testid="sketch-sheet">
      {children}
      {marks}
    </div>
  )
}

export function FilePreviewDocumentPanel({ controller }: { controller: FilePreviewController }) {
  const { actions, annotateLead, canPreview, file, findSimilar, handlePdfFailed, inlineViewer, isLoading, isModel, isOfficeRendition, isTextual, kind, linkedLocus, loadPreview, openReview, pdfInWell, peeking, previewFailed, previewGone, previewImageUrl, previewText, previewUrl, projectId, reader, review, setPreviewFailed, setPreviewImageUrl, setPreviewUrl, showModels, shownFinding, sketchInWell, shownPage, shownType, sideways, t, viewerTarget, wellHostsViewer, wellRef } = controller
  /**
   * A page's marks, drawn the way the review draws them (`ReviewPageLayer`, unfocused) with the peek
   * beside a pin: one path for a PDF page and for a Skizze's one sheet, a click opening the review.
   */
  const marksOn = (page: number) => (
    <>
      <ReviewPageLayer page={page} review={review} focused={false} onOpenMark={openReview} />
      <InlineMarkPeek page={page} review={review} onOpenMark={openReview} />
    </>
  )
  return (
    <>
          {/* Left: live preview, or a decorative page mock while loading / when
              there is no inline preview. Stacked (mobile): a capped ~50dvh block
              that clips to itself so a tall document/image never pushes the
              metadata off-screen. Split (@2xl+): an independently-scrollable
              column. The Maximize2 affordance in the header still opens the
              full-screen viewer for PDFs and images. */}
          {/* The ground under the document. A flat grey box read as "an iframe in
              a panel"; a flat tone with the page set on it on a
              hairline reads as a document ON something — which is what a
              drawing on a desk actually looks like, and the whole reason this
              column exists rather than a download link. */}
          <PeekPanel peeking={peeking} value="document">
          <PeekStage peeking={peeking}>
            <div
              ref={wellRef}
              data-testid="file-preview-well"
              className={cn(
                'flex min-w-0 justify-center',
                // A PDF brings its own stage (the viewer's), so the well under it
                // is no ground of its own: the document looks the same here as in
                // every other place a PDF opens.
                !peeking && !pdfInWell && 'bg-muted/40',
                wellHostsViewer || (reader && (isModel || pdfInWell))
                  ? cn(
                      'h-full min-h-0 flex-1 overflow-hidden',
                      // On its side the reader has no bar below the stage, so the
                      // stage itself stops above the home indicator.
                      reader && sideways && 'pb-[env(safe-area-inset-bottom)]',
                    )
                  : reader
                  ? // The reader's well for what is not a viewer of its own (an
                    // image, a text page, the page mock): the whole height, one
                    // scroll, the document centred while it is shorter than that.
                    'min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] [&>*]:my-auto'
                  : peeking
                  ? // THE GROUND IS THE DOCUMENT'S, and the document sits centred on
                    // it. A drawing fitted to the width of a 320px pane is a quarter
                    // of its height and the well cannot make it bigger — width is the
                    // binding constraint, so the leftover vertical space exists
                    // whatever this element does. Top-aligned, the document read as
                    // having fallen to the top of a box. Handing the slack to the
                    // summary below was worse: that block's content is four lines
                    // whatever the pane's height, so the emptiness simply moved under
                    // it and changed colour. Centred on its own ground, with the
                    // summary as a footer band beneath, is the composition that reads
                    // as deliberate at every height.
                    //
                    // The well is also the peek's document SCROLL container. The peek
                    // body above is `overflow-hidden` and a text page only scrolls
                    // horizontally, so a tall document used to clip here with no way
                    // to reach the rest. Bounded by `flex-1 min-h-0` in the peek
                    // column (the summary footer below is capped and shrink-0), in
                    // the same `scroll-fade-bottom` language the summary speaks.
                    // Centring is per-child `my-auto` rather than `items-center` on
                    // purpose: a centred flex container clips the TOP of overflowing
                    // content unreachably, while auto margins collapse to
                    // top-aligned the moment the document outgrows the well — short
                    // docs sit centred, tall ones scroll from the top.
                    'scroll-fade-bottom h-full min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-4 [&>*]:my-auto'
                    : pdfInWell
                      ? '@2xl:h-auto @2xl:min-h-0 @2xl:flex-1 @2xl:p-4 h-[50dvh] min-h-[50dvh] shrink-0 overflow-hidden p-3'
                      : '@2xl:h-auto @2xl:min-h-0 @2xl:flex-1 @2xl:overflow-y-auto @2xl:overscroll-contain @2xl:p-7 h-[50dvh] min-h-[50dvh] shrink-0 overflow-hidden p-5'
              )}
            >
              {isModel ? (
                <IfcFilePreview
                  documentId={file.id}
                  filename={file.filename}
                  projectId={projectId}
                  canOpenWorkspace={showModels}
                  className="size-full"
                />
              ) : isTextual && isLoading ? (
                <PageMock skeleton />
              ) : isTextual && previewText ? (
                <FileTextPage
                  text={previewText.text}
                  truncated={previewText.truncated}
                  contentType={file.contentType}
                  truncatedLabel={t('preview.textTruncated')}
                  peeking={peeking}
                />
              ) : canPreview && isLoading ? (
                // Converting an office file can take seconds on first open, so the
                // skeleton says what it is waiting for instead of looking stuck.
                <PageMock
                  skeleton
                  caption={isOfficeRendition ? t('preview.renditionPending') : undefined}
                />
              ) : canPreview && previewUrl ? (
                shownType === 'application/pdf' ? (
                  // THE APP'S OWN VIEWER, NOT THE BROWSER'S. A frame on the
                  // presigned URL drew nothing on Android Chrome (no inline PDF
                  // renderer: a blank box, or a download), little on iOS, and
                  // navigated, zoomed and searched unlike the citation viewer
                  // beside it. pdf.js renders it the same everywhere, fitted to the
                  // well's width with pages rasterised only near the viewport. It
                  // FETCHES the bytes, so it reads the same-origin stream, which
                  // for an office file streams the rendition (ADR-0070). The
                  // preview route above still decides whether there is anything
                  // to show; this only decides how it is drawn.
                  inlineViewer ? (
                    <PdfDocumentView
                      key={file.id}
                      src={documentFileUrl(file.id)}
                      title={actions.name}
                      page={shownPage === 'turning' ? null : (shownPage ?? linkedLocus.page ?? shownFinding?.page ?? null)}
                      highlight={
                        viewerTarget?.passage ??
                        (shownPage === null ? (linkedLocus.highlight ?? shownFinding?.highlight ?? null) : null)
                      }
                      regions={viewerTarget?.regions ?? null}
                      onFindSimilar={findSimilar}
                      onLoadError={handlePdfFailed}
                      ground={peeking ? 'host' : 'stage'}
                      bleed={reader}
                      pageOverlay={marksOn}
                      // A page has one canvas, its review: „Skizze auf dieser Seite beginnen“ is in its page menu.
                      toolbarLead={annotateLead}
                      className="size-full"
                    />
                  ) : (
                    <PageMock skeleton />
                  )
                ) : (
                  // This is where the bytes actually were: the preview URL serves
                  // the FULL-SIZE original into a column a few hundred pixels wide,
                  // so a 4000px scan used to cross the wire whole. `previewImageUrl`
                  // is the same-origin signed path the optimizer can resize; it is
                  // null for the formats the optimizer would choke on (SVG and the
                  // exotic ones), which then fall back to the object-store URL
                  // unoptimized — the old behaviour, kept as the safe default.
                  //
                  // Sizing stays with CSS either way: the well is only bounded on
                  // mobile (`h-[50dvh]`) and grows with its content at `@2xl`, where
                  // a `fill` child would collapse the column to nothing. Hence 0/0
                  // for the ratio next/image cannot know, plus an explicit `w-auto`
                  // so the browser sizes to the image and not to the width="0".
                  //
                  // A Skizze's sheet carries its Anmerkungen on its one page, as a PDF page does: the
                  // pins over the picture, a click opening them in the sketch editor (`openReview`).
                  <SheetMarks on={sketchInWell} marks={marksOn(1)}>
                  <Image
                    src={previewImageUrl ?? previewUrl}
                    alt={actions.name}
                    width={0}
                    height={0}
                    sizes="(min-width: 1536px) 720px, 90vw"
                    unoptimized={!isOptimizerEligible(previewImageUrl ?? previewUrl)}
                    // Either URL can be expired or unreachable by the time the
                    // browser fetches the bytes — a presigned link on its own TTL,
                    // or a signed image path whose window has rolled over — and the
                    // fetch above only proves the BFF handed one out. Fall back to
                    // the same failed state the fetch path uses so the user gets the
                    // caption and the retry button instead of a broken-image glyph.
                    onError={() => {
                      setPreviewUrl(null)
                      setPreviewImageUrl(null)
                      setPreviewFailed(true)
                    }}
                    className={cn(
                      'bg-background h-fit max-h-full w-auto max-w-full rounded-surface border object-contain',
                      // The reader's well is the screen: the image fits it whole,
                      // on a phone on its side too (852px wide is past `@2xl`).
                      !reader && '@2xl:max-h-none',
                      peeking ? 'shadow-md' : 'shadow-lg'
                    )}
                  />
                  </SheetMarks>
                )
              ) : (
                <PageMock
                  kind={kind}
                  caption={
                    previewGone
                      ? t('preview.gone')
                      : previewFailed
                        ? t('preview.loadFailed')
                        : t('preview.noInlinePreview')
                  }
                  action={
                    previewGone ? (
                      // The only move left. The document is not coming back, and
                      // the conversation is still pointed at it — so the way out is
                      // to stop asking about it, which is also the one thing the
                      // reader cannot do from inside a viewer that will not load.
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
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
                    ) : previewFailed && (canPreview || isTextual) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={loadPreview}
                      >
                        <RotateCcw className="size-3.5" aria-hidden />
                        {t('preview.tryAgain')}
                      </Button>
                    ) : (
                      // "No inline preview for this file type" used to end there:
                      // a sentence about a document, in the middle of the surface
                      // that exists to show it, with nothing to do next. The
                      // sentence already names the way out ("download it to view
                      // the full document") — so the way out is here, rather than
                      // an icon the reader has to go and find in the chrome.
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => void actions.download()}
                        disabled={actions.isDownloading}
                      >
                        <Download className="size-3.5" aria-hidden />
                        {t('preview.download')}
                      </Button>
                    )
                  }
                />
              )}
            </div>
          </PeekStage>

          {/* WHAT AGENT MADE OF IT, in the peek.
              The peek dropped the whole rail — properties, tags, the lot — which
              is right: a 320px column beside a conversation is not where a
              reader edits metadata. But it dropped the SUMMARY with it, and the
              summary is the one line of that rail this surface is actually about:
              the peek exists because this document is what the next question is
              about, so "does Piloti understand it, and as what" is the question
              the reader has, and the answer was two clicks away in the enlarged
              view.
              It also lands where there was nothing. A portrait plan fitted to a
              320px pane is half its height, so the well below the drawing was
              several hundred pixels of empty ground — the reader's eye had
              nowhere to go and nothing to do. Capped and scrollable so a
              twelve-line ingestion summary cannot take the document's place, and
              absent entirely when there is no summary yet. */}
          {/* Set on the card, not boxed: the stage above is the one framed
              thing in the column, and a bordered card inside a tinted band under
              it was the third frame in 300px. The label and the text are enough
              to make it a section; a capped height keeps a long summary from
              taking the document's place. */}
          {peeking && file.summary && (
            <section
              aria-label={t('preview.indexed.title')}
              data-testid="file-peek-summary"
              className="scroll-fade-bottom max-h-[38%] shrink-0 overflow-y-auto overscroll-contain px-4 pt-3.5 pb-4"
            >
              <SectionLabel as="p" icon={Sparkles} className="font-semibold tracking-[0.05em]">
                {t('preview.indexed.title')}
              </SectionLabel>
              <ClampedText
                key={file.id}
                lines={PEEK_SUMMARY_CLAMP_LINES}
                moreLabel={t('preview.summaryMore')}
                lessLabel={t('preview.summaryLess')}
                className="text-foreground/90 mt-2 text-[13px] leading-[1.6] text-pretty"
              >
                {file.summary}
              </ClampedText>
            </section>
          )}
          </PeekPanel>
    </>
  )
}
