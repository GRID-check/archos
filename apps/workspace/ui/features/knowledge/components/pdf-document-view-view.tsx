

import { AlertTriangle } from 'lucide-react'

import { FloatingNote } from '@/components/ui/floating-toolbar'

import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { REPLAY_BLOCK_CLASS } from '@/lib/analytics/posthog-config'

import { SIMILAR_PASSAGE_TEXT_MIN } from '@/lib/similar-passages/types'

import { MIN_SEARCH_QUERY, normalizePassage } from '../lib/passage-highlight'
import { stepZoom } from '../lib/pdf-zoom'

import { PageSheet } from './pdf-viewer-atoms'
import { PdfThumbnailRail } from './pdf-thumbnail-rail'
import { PdfControls, PdfSearchBar } from './pdf-viewer-toolbar'

import { PLACEHOLDER_PAGE_ASPECT } from './pdf-document-view-helpers'
import { PdfFailure, PdfPasswordPrompt, QuoteBar } from './pdf-document-view-chrome'
import { PdfPageCanvas } from './pdf-page-canvas'

import type { PdfDocumentViewController } from './use-pdf-document-view-controller'

export function PdfDocumentViewView({ controller }: { controller: PdfDocumentViewController }) {
  const { Ground, activeHit, announced, bleed, className, closeSearch, copied, copyQuote, currentPage, defaultAspect, doc, fit, fitAgain, goToPage, handleMiss, handlePassage, highlight, highlightColor, hit, hits, loadState, maxZoom, maxZoomRef, onFindSimilar, onKeyDown, onLoadError, openSearch, page, pageOverlay, pages, passageMissing, ping, query, quote, quoteFormat, radius, railOpen, regionsOnPage, registerPage, registerWidth, revealCited, scrollRef, searchFocus, searchMarks, searchOpen, setAttempt, setContentNode, setFit, setPassword, setQuery, setRailOpen, setZoom, src, stackTransform, stepHit, t, targetWidth, title, toolbarLead, viewSignal, zoom, zoomRef, zoomTo } = controller
  if (loadState === 'failed' && onLoadError) return null
  if (loadState === 'failed' || loadState === 'locked' || loadState === 'wrong-password') {
    return (
      <div className={cn('@container flex min-h-0 min-w-0 flex-1 flex-col', REPLAY_BLOCK_CLASS, className)}>
        <Ground className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-4">
          {loadState === 'failed' ? (
            <PdfFailure
              href={page ? `${src}#page=${page}` : src}
              onRetry={() => setAttempt((value) => value + 1)}
            />
          ) : (
            <PdfPasswordPrompt
              incorrect={loadState === 'wrong-password'}
              onSubmit={(value) => {
                setPassword(value)
                setAttempt((current) => current + 1)
              }}
            />
          )}
        </Ground>
      </div>
    )
  }

  return (
    <div
      className={cn('@container flex min-h-0 min-w-0 flex-1 flex-col', REPLAY_BLOCK_CLASS, className)}
      onKeyDown={onKeyDown}
    >
      <Ground className={cn('flex min-h-0 flex-1 flex-row', bleed && 'phone:rounded-none phone:border-0')}>
        {/* A rail of one thumbnail is a 150px column that says „1". */}
        {doc && railOpen && doc.numPages > 1 && (
          <PdfThumbnailRail
            doc={doc}
            pages={pages}
            currentPage={currentPage}
            defaultAspect={defaultAspect}
            onSelect={goToPage}
            // Not on a phone, not even on its side: 150px of an 852px-wide,
            // 393px-high screen is a column of thumbnails standing where the
            // drawing should be, and the page field turns the pages.
            className="@max-3xl:hidden phone:hidden"
          />
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Focusable on purpose. A bare scrollable div is not reachable by
              keyboard in most engines, so without a tabindex a keyboard-only
              reader could tab to the zoom buttons and still have no way to move
              through the document itself. `touch-pan-*`: one finger scrolls
              natively, two pinch the document rather than the page. */}
          <div
            ref={scrollRef}
            data-testid="pdf-scroll"
            tabIndex={0}
            role="group"
            aria-label={title}
            className={cn(
              // A column flex, so a sheet shorter than the frame sits in its
              // middle (`my-auto` below) rather than at its top over an empty
              // stage, and still scrolls from its top edge once it is taller.
              'isolate flex min-h-0 w-full flex-1 flex-col touch-pan-x touch-pan-y overflow-auto overscroll-contain px-3 pt-4 pb-16 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset',
              bleed &&
                'phone:pt-2 phone:pr-[max(0.25rem,env(safe-area-inset-right))] phone:pl-[max(0.25rem,env(safe-area-inset-left))]',
            )}
          >
            {/* PAGE-SHAPED while it loads: the same sheet a page is drawn on,
                at the width the first page will take and the ISO 216 proportion
                most documents here have, so the document arrives INTO it. */}
            {!doc && (
              <div className="my-auto flex flex-col items-center">
                <PageSheet
                  data-testid="pdf-page-placeholder"
                  className="flex w-full justify-center pt-16"
                  style={{
                    width: targetWidth || undefined,
                    aspectRatio: `1 / ${PLACEHOLDER_PAGE_ASPECT}`,
                  }}
                >
                  <span className="inline-flex items-center gap-2 self-start text-sm text-muted-foreground">
                    <Spinner size="sm" />
                    {t('viewer.loading')}
                  </span>
                </PageSheet>
              </div>
            )}
            {/* `relative`: the quote bar is positioned against this stack, so it
                travels with the words it is offering to quote. `w-fit min-w-full`:
                zoomed past the frame, the stack is as wide as its widest page and
                scrolls sideways from its left edge instead of being clipped on
                both. */}
            <div ref={setContentNode} className="relative mx-auto my-auto flex w-fit min-w-full shrink-0 flex-col items-center gap-3">
              {quote && (quoteFormat || onFindSimilar) && (
                <QuoteBar
                  selection={quote}
                  state={copied}
                  onCopy={quoteFormat ? () => void copyQuote() : undefined}
                  onFindSimilar={
                    onFindSimilar && quote.text.length >= SIMILAR_PASSAGE_TEXT_MIN
                      ? () => onFindSimilar({ text: quote.text, page: quote.page })
                      : undefined
                  }
                />
              )}
              {doc &&
                pages.map((number) => (
                  <PdfPageCanvas
                    key={number}
                    doc={doc}
                    pageNumber={number}
                    label={t('viewer.pageLabel', { page: number })}
                    targetWidth={targetWidth}
                    defaultAspect={defaultAspect}
                    highlight={page && Math.abs(number - page) <= radius ? highlight : null}
                    highlightColor={highlightColor}
                    marks={hit?.page === number ? hit.rects : null}
                    searchMarks={searchMarks.get(number) ?? null}
                    regions={number === page ? regionsOnPage : null}
                    overlay={pageOverlay?.(number)}
                    fuzzy={hit?.page === number && hit.fuzzy}
                    ping={ping}
                    onPassage={handlePassage}
                    onMiss={handleMiss}
                    onBase={registerWidth}
                    registerRef={registerPage}
                    frameRef={scrollRef}
                    viewSignal={viewSignal}
                    moving={stackTransform}
                  />
                ))}
            </div>
          </div>

          {/* Over the head of the stage: what is being looked for, and the one
              thing worth saying about a citation — that its passage could not
              be found. Over the document rather than in a row above it, so the
              row never steals the document's height. */}
          {(searchOpen || passageMissing) && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-2 px-3">
              {searchOpen && (
                <PdfSearchBar
                  key={searchFocus}
                  query={query}
                  onQuery={setQuery}
                  count={hits === null ? null : hits.length}
                  active={activeHit}
                  onStep={stepHit}
                  onClose={closeSearch}
                  tooShort={normalizePassage(query).length < MIN_SEARCH_QUERY}
                />
              )}
              {passageMissing && !searchOpen && (
                // The reader clicked a Fundstelle and nothing lit up. Without
                // this the viewer let them conclude what they liked from that.
                // It is none of those: the page is right and the sentence
                // could not be located on it.
                <FloatingNote data-testid="pdf-passage-missing">
                  <AlertTriangle aria-hidden />
                  {t('viewer.passageNotFound')}
                </FloatingNote>
              )}
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
            <PdfControls
              pageCount={doc ? doc.numPages : null}
              currentPage={currentPage}
              onPage={goToPage}
              onRevealPassage={revealCited}
              zoom={zoom}
              maxZoom={maxZoom}
              fit={fit}
              onZoomStep={(direction) => zoomTo(stepZoom(zoomRef.current, direction, maxZoomRef.current))}
              onResetZoom={fitAgain}
              onToggleFit={() => {
                setFit(fit === 'width' ? 'page' : 'width')
                stackTransform.finish()
                zoomRef.current = 1
                setZoom(1)
              }}
              searchOpen={searchOpen}
              onToggleSearch={() => (searchOpen ? closeSearch() : openSearch())}
              railOpen={railOpen}
              hasRail={doc ? doc.numPages > 1 : false}
              onToggleRail={() => setRailOpen((open) => !open)}
              lead={typeof toolbarLead === 'function' ? toolbarLead(currentPage) : toolbarLead}
            />
          </div>
        </div>
      </Ground>
      <span className="sr-only" role="status" aria-live="polite" data-testid="pdf-page-announcement">
        {announced}
      </span>
    </div>
  )
}
