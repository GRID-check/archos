'use client'

import type { JSX } from 'react'

import { type ReactNode } from 'react'

import { FileText, ListTree } from 'lucide-react'

import { InsetStage } from '@/components/ui/inset-stage'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { ClampedText } from '@/components/ui/clamped-text'

import { useTranslations } from '@/i18n'

import { filesCopy } from '@/i18n/namespaces/files'

import { cn } from '@/lib/utils'

import type { DocumentKind } from '../document-kind'
import { DocumentKindThumbnail } from './document-kind-thumbnail'

/** Lines of summary shown before it has to ask for the space. */
export const SUMMARY_CLAMP_LINES = 5

/**
 * The peek's summary is a footer under the document, not a rail beside it:
 * three lines say what the file is, and the toggle has the rest.
 */
export const PEEK_SUMMARY_CLAMP_LINES = 3

export type PeekView = 'document' | 'details'

/**
 * The peek's two faces, as tabs. Both panels stay MOUNTED and the inactive
 * one is hidden: switching to Details must not reload a PDF or reset an IFC
 * camera, which is the same reason the host parks the pane rather than
 * unmounting it. Off the peek this renders its children untouched.
 */
export function PeekTabs({
  peeking,
  value,
  onValueChange,
  labels,
  children,
}: {
  peeking: boolean
  value: PeekView
  onValueChange: (next: PeekView) => void
  labels: { list: string; document: string; details: string }
  children: ReactNode
}): JSX.Element {
  if (!peeking) return <>{children}</>
  return (
    <Tabs
      value={value}
      onValueChange={(next) => onValueChange(next === 'details' ? 'details' : 'document')}
      className="min-h-0 flex-1 gap-0"
    >
      <TabsList aria-label={labels.list} className="mx-3 mb-2.5 h-8 w-auto shrink-0">
        <TabsTrigger value="document" className="text-xs" data-testid="file-peek-tab-document">
          <FileText aria-hidden className="size-3.5" />
          {labels.document}
        </TabsTrigger>
        <TabsTrigger value="details" className="text-xs" data-testid="file-peek-tab-details">
          <ListTree aria-hidden className="size-3.5" />
          {labels.details}
        </TabsTrigger>
      </TabsList>
      {children}
    </Tabs>
  )
}

export function PeekPanel({
  peeking,
  value,
  children,
}: {
  peeking: boolean
  value: PeekView
  children: ReactNode
}): JSX.Element {
  if (!peeking) return <>{children}</>
  return (
    <TabsContent
      value={value}
      forceMount
      className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
    >
      {children}
    </TabsContent>
  )
}

/**
 * In the peek the well sits ON a stage — inset from the pane's edges, recessed,
 * with the drawing-paper grid — so the document reads as a sheet laid on a
 * desk. Elsewhere the well is its own ground and needs no frame.
 */
export function PeekStage({ peeking, children }: { peeking: boolean; children: ReactNode }): JSX.Element {
  if (!peeking) return <>{children}</>
  return (
    <InsetStage data-testid="file-peek-stage" className="mx-3 flex min-h-0 flex-1 flex-col">
      {children}
    </InsetStage>
  )
}

/**
 * The indexed summary, clamped until asked. It is the first part of the
 * reading group, not a card of its own: the group is the sheet.
 *
 * The summary is the most valuable thing on the rail, which is exactly why it
 * cannot be allowed to take the whole rail: an ingestion pass on a
 * Brandschutzkonzept happily produces twelve lines, and unclamped that pushes
 * the properties, the tags and the delete action off the bottom of a 280px
 * column. The reader then has to scroll to find out that a Type row exists.
 *
 * Five lines is enough to know what the document is and decide whether to read
 * the rest. The toggle appears only when text is genuinely hidden — measured,
 * not guessed from a character count, because the same string wraps differently
 * in the wide modal and the mobile sheet.
 */
export function IndexedSummary({ summary }: { summary: string }) {
  const t = useTranslations(filesCopy)
  return (
    <div className="p-3">
      <ClampedText
        lines={SUMMARY_CLAMP_LINES}
        moreLabel={t('preview.summaryMore')}
        lessLabel={t('preview.summaryLess')}
        className="text-foreground text-sm leading-[1.55]"
      >
        {summary}
      </ClampedText>
    </div>
  )
}

/**
 * The preview column when there is no live preview to show.
 *
 * Two cases with one shape but different intent, which is why `skeleton` is a
 * flag rather than two components:
 *
 *  - LOADING: a page-shaped skeleton. Bars standing in for text that is on its
 *    way is what a skeleton IS, and the silhouette tells the reader the column
 *    is about to hold a document rather than an image or an error.
 *  - NO PREVIEW / FAILED: the same page, EMPTY, carrying the sentence that
 *    explains why and the control that retries. It previously drew the same
 *    paragraph bars here — a document mocked up with fake text, permanently,
 *    for a file whose contents cannot be shown at all. That is decoration
 *    pretending to be content, and on a compliance surface it is worse than
 *    blank: a reader glancing at the column sees "a document" and moves on.
 */
export function PageMock({
  caption,
  action,
  skeleton,
  kind,
}: {
  caption?: string
  action?: ReactNode
  skeleton?: boolean
  /**
   * What the file IS, when there is no preview to show. The empty state used
   * to be a dashed box with a sentence in it — the same box for a contract, a
   * spreadsheet and a DWG floor plan — so the surface that exists to show a
   * document showed nothing about it at all. The card in the grid behind this
   * modal already draws the document's kind; borrowing that sketch means the
   * reader recognises the file they clicked, and the two surfaces speak one
   * visual language instead of two.
   */
  kind?: DocumentKind
}) {
  return (
    <div className="bg-background h-fit min-h-[320px] w-full max-w-[520px] rounded-lg border p-7 shadow-lg">
      <div className="flex items-baseline justify-between border-b pb-2.5">
        <div className="space-y-1.5">
          {/* The alphas are the point here, not drift: a skeleton paints solid
              bars (content is COMING), the page mock paints faded ones (this is
              an illustration of a page, and nothing is coming). Same bars, two
              claims, and the opacity is what separates them. */}
          <div className={cn('h-[9px] w-28 rounded-sm', skeleton ? 'bg-muted' : 'bg-muted/50')} />
          <div
            className={cn('h-[6px] w-16 rounded-sm', skeleton ? 'bg-muted/70' : 'bg-muted/40')}
          />
        </div>
        <div className={cn('h-[6px] w-12 rounded-sm', skeleton ? 'bg-muted/70' : 'bg-muted/40')} />
      </div>
      <div className="mt-3.5 flex h-[260px] flex-col items-center justify-center gap-3 rounded border border-dashed px-6 text-center">
        {/* Faint, and never while loading: a skeleton claims content is coming,
            and a line drawing is not that claim. */}
        {!skeleton && kind && (
          <DocumentKindThumbnail kind={kind} className="text-muted-foreground/45 h-16 w-24" />
        )}
        {/* A caption while loading is a statement of what is coming ("PDF
            preview being created"), which a skeleton may make; most loads have
            none and stay bare. */}
        {caption && (
          <p className="text-muted-foreground max-w-[80%] text-balance text-xs leading-relaxed">
            {caption}
          </p>
        )}
        {action}
      </div>
      {/* Body lines only while loading: bars under a caption that says the file
          cannot be previewed would be text this document does not have. */}
      {skeleton && (
        <div className="mt-3.5 space-y-1.5">
          <div className="bg-muted h-[7px] w-3/5 rounded" />
          <div className="bg-muted h-[7px] w-1/2 rounded" />
          <div className="bg-muted h-[7px] w-[55%] rounded" />
        </div>
      )}
    </div>
  )
}
