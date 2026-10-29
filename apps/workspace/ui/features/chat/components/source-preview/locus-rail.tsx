'use client'

import type { FC } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { SectionLabel } from '@/components/ui/section-label'
import { sourceSignalStyle } from '@/features/layout/components/SourceSignalChip'
import type { CitationLocus, CitedDocument } from '../../lib/citations'
import { navigableLoci } from './document-target'

/**
 * The Fundstellen rail — every place in this document the turn read, as a
 * table of contents you can walk.
 *
 * This is the half the click used to throw away. The model knows a document was
 * read at pages 5, 12, 18 and 22; the viewer opened at 5 and offered no way to
 * reach the rest, so verifying the other three meant closing the dialog,
 * finding another chip, and hoping.
 *
 * A row of page pills was the first repair, and it was still the wrong shape:
 * pills say "p. 12" and nothing else, so choosing between four of them is
 * choosing between four numbers. What the reader is actually looking for is a
 * PASSAGE, so each entry now shows the passage — its marker in the answer, its
 * page, and the opening of the text itself. That turns the rail from a pager
 * into a contents list, which is why it sits BESIDE the document (a contents
 * list you scroll past to reach the book is not a contents list) and stays
 * visible while you read.
 *
 * It shows every retrieved locus, not only the cited ones: a passage retrieval
 * found and the answer passed over is part of what the reader is checking, and
 * hiding it would make the document look thinner than the research was. The
 * `[N]` badge is what separates the two.
 *
 * It shows for ONE Fundstelle too, and that is deliberate. Withholding it there
 * was reasoning about navigation — one entry is nowhere to go — but the rail is
 * not only a way through the document, it is the standing answer to "which
 * passage am I checking", which a reader deep on page 12 needs whether the
 * document was read once or four times. Withholding it also made the dialog
 * change shape between two citations that look identical from the chat, which
 * reads as a glitch rather than as a statement about the document.
 */
export const LocusRail: FC<{
  document: CitedDocument
  activeKey: string | undefined
  onSelect: (locus: CitationLocus) => void
}> = ({ document: doc, activeKey, onSelect }) => {
  const t = useTranslations(chatCopy)
  const loci = navigableLoci(doc)
  // Nothing that names a page is nothing to point at: the passage box says what
  // was read, and a rail of one unplaceable entry would say it again, emptier.
  if (!loci.length) return null

  const activeIndex = loci.findIndex((locus) => locus.key === activeKey)
  const step = (delta: number): void => {
    const next = loci[Math.min(loci.length - 1, Math.max(0, activeIndex + delta))]
    if (next && next.key !== activeKey) onSelect(next)
  }

  return (
    <nav
      aria-label={t('citationPeek.lociAria')}
      // Beside the document on a real screen, above it on a phone — where a
      // 16rem column would leave the document a slot. The entries carry the
      // shape change: full-width rows stacked, or fixed-width cards scrolling
      // sideways, which is the one gesture a narrow viewport has room for.
      className="flex min-h-0 shrink-0 flex-col gap-1.5 md:w-64"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        step(event.key === 'ArrowDown' ? 1 : -1)
      }}
    >
      <div className="flex shrink-0 items-center gap-1.5">
        <SectionLabel>{t('citationPeek.lociLabel', { count: loci.length })}</SectionLabel>
        <span className="flex-1" />
        {/* The stepper is for reading STRAIGHT THROUGH — the reader who wants
            the next passage rather than a particular one, and who should not
            have to find it in the list to get there. A single Fundstelle has no
            through-line, so the controls for one would be three dead affordances
            over the only entry. */}
        {loci.length > 1 && (
          <>
            <span className="text-muted-foreground text-xs tabular-nums">
              {t('citationPeek.lociPosition', {
                index: activeIndex >= 0 ? activeIndex + 1 : 0,
                count: loci.length,
              })}
            </span>
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={activeIndex <= 0}
              aria-label={t('citationPeek.previousLocus')}
              className={stepperClasses}
            >
              <ChevronUp aria-hidden="true" className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              disabled={activeIndex === loci.length - 1}
              aria-label={t('citationPeek.nextLocus')}
              className={stepperClasses}
            >
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </button>
          </>
        )}
      </div>

      <ol className="flex min-h-0 gap-1.5 overflow-x-auto pb-1 md:flex-1 md:flex-col md:overflow-y-auto md:overflow-x-hidden md:pb-0">
        {loci.map((locus) => {
          const isActive = locus.key === activeKey
          return (
            <li key={locus.key} className="w-52 shrink-0 md:w-full">
              <button
                type="button"
                // Follow the reading position. Stepping through a document read
                // at nine places used to walk the mark off the bottom of the
                // rail: the entry was current and out of sight, so the one
                // control that says WHERE YOU ARE stopped saying it exactly when
                // the list got long enough to need it. `nearest` scrolls only
                // when it has to, and covers the sideways strip on a phone as
                // well as the column beside the document.
                ref={(node) => {
                  if (isActive) node?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
                }}
                onClick={() => onSelect(locus)}
                aria-current={isActive ? 'true' : undefined}
                className={cn(
                  'duration-snap w-full rounded-surface border px-2.5 py-2 text-left transition-colors ease-out',
                  'focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-2',
                  isActive ? 'border-transparent' : 'border-border bg-card hover:bg-accent'
                )}
                // The active entry wears the SOURCE's colour, the same tint the
                // chip that opened this dialog wore — so "where am I" is
                // answered by the same signal throughout.
                style={isActive ? sourceSignalStyle(doc.tint) : undefined}
              >
                <span className="flex items-center gap-1.5">
                  {locus.number != null ? (
                    <span className="shrink-0 text-xs font-semibold tabular-nums opacity-70">
                      [{locus.number}]
                    </span>
                  ) : (
                    // No marker means retrieval surfaced this passage and the
                    // answer did not lean on it. Saying so is the difference
                    // between a thin document and an honest one.
                    <SectionLabel className={cn('shrink-0', isActive && 'text-current opacity-70')}>
                      {t('citationPeek.retrievedOnly')}
                    </SectionLabel>
                  )}
                  <span className="flex-1" />
                  <span className="shrink-0 text-xs font-medium tabular-nums">
                    {locus.clause
                      ? t('answerSources.clausePage', { clause: locus.clause, page: locus.page! })
                      : t('answerSources.page', { page: locus.page! })}
                  </span>
                </span>
                {locus.snippet && (
                  <span
                    className={cn(
                      'mt-1 block text-xs leading-snug',
                      // The one being read is the citation itself, so it is
                      // shown whole — this rail replaced the band that used to
                      // carry it above the document. The others stay two lines:
                      // enough to recognise a passage, not enough to bury the
                      // list under one long quotation. Narrow viewports keep the
                      // clamp throughout, where the rail is a strip of cards and
                      // a full quotation would take the screen.
                      isActive
                        ? 'line-clamp-3 opacity-80 md:line-clamp-none md:max-h-48 md:overflow-y-auto'
                        : 'text-muted-foreground line-clamp-2'
                    )}
                  >
                    {locus.snippet}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

const stepperClasses =
  'inline-flex size-5 items-center justify-center rounded-full border border-border text-muted-foreground ' +
  'transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40'
