'use client'

import type { JSX, SyntheticEvent } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquareText } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLocale, useTranslations } from '@/i18n'
import type { Translator } from '@/i18n/translate'
import { filesCopy } from '@/i18n/namespaces/files'
import type { MarkTally } from '@/lib/annotations/types'
import { cn } from '@/lib/utils'
import { reviewHrefAt } from '../lib/open-review'

/** What a listing needs of a row to say what is open on it. */
export interface OpenMarksSubject {
  id: string
  marks?: MarkTally | null
}

/** What a document still has: its open marks, the reader's among them (none where unknown), and Piloti's proposals. */
export type MarkCounts = Pick<MarkTally, 'open' | 'proposed'> & { forYou?: number }

/** Whether there is anything to say: an open mark, or a proposal nobody decided on. */
export const hasLiveMarks = (marks: MarkCounts): boolean => marks.open + marks.proposed > 0

/**
 * The sentence the chip stands for, „3 offene Anmerkungen, 1 für Sie und 2
 * Vorschläge von Piloti": the open marks and Piloti's untaken proposals told
 * apart, as everywhere else „offen“ means only the office's own marks
 * (Offene Punkte, the Protokoll, the Postfach). Each part only when it has
 * any. The approve confirm says the same, without „für Sie“.
 */
export function openMarksLabel(t: Translator, locale: string, marks: MarkCounts): string {
  const forYou = marks.forYou ?? 0
  const parts = [
    marks.open > 0
      ? forYou > 0
        ? t('annotations.listedOpenForYou', { count: marks.open, mine: forYou })
        : t('annotations.listedOpen', { count: marks.open })
      : null,
    marks.proposed > 0 ? t('review.proposalsGroup', { count: marks.proposed }) : null,
  ].filter((part): part is string => part !== null)
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(parts)
}

/** What the chip says in its own words, short enough for a card: „2 offen · 1 für Sie · 12 Vorschläge". */
export function openMarksShortLabel(t: Translator, marks: MarkCounts): string {
  const forYou = marks.forYou ?? 0
  return [
    marks.open > 0
      ? forYou > 0
        ? t('annotations.listedOpenShortForYou', { count: marks.open, mine: forYou })
        : t('annotations.listedOpenShort', { count: marks.open })
      : null,
    marks.proposed > 0 ? t('annotations.listedProposedShort', { count: marks.proposed }) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

/** A click or a key on the chip is the chip's: the row or card around it opens the file, not the review. */
const keep = (event: SyntheticEvent) => event.stopPropagation()

/**
 * What a document in a listing still has open: its open Anmerkungen on every
 * Fassung, how many of them are the reader's, and Piloti's proposals nobody
 * decided on, told apart („2 offen · 1 für Sie · 12 Vorschläge"), counted by
 * the server with the listing (`tallyLiveMarks`).
 * Nothing when nothing is open, so a folder scanned at a glance shows only the
 * documents with work on them.
 *
 * It says so in words („4 offen · 2 für Sie"), not in a bubble and a person
 * beside two bare numbers: a count without its noun has to be learnt. The
 * tooltip carries the whole sentence for a pointer; a finger reads the words.
 *
 * A press opens the document's Prüfansicht: the page's own URL with `doc` and
 * `review=1` (`reviewHrefAt`), which the shelf's `?doc=` sync and the preview
 * pane already answer, so this adds no second way in.
 */
export function OpenMarksChip({
  file,
  name,
  className,
}: {
  file: OpenMarksSubject
  /** The document's name as the row shows it: a screen reader moving by buttons hears which document each one opens. */
  name: string
  className?: string
}): JSX.Element | null {
  if (!file.marks || !hasLiveMarks(file.marks)) return null
  return <OpenMarksButton documentId={file.id} name={name} marks={file.marks} className={className} />
}

/** Its own component so `useRouter` runs only for a row that has something open. */
function OpenMarksButton({
  documentId,
  name,
  marks,
  className,
}: {
  documentId: string
  name: string
  marks: MarkTally
  className?: string
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const { locale } = useLocale()
  const router = useRouter()
  const label = openMarksLabel(t, locale, marks)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Chip asChild interactive size="sm" variant="muted" className={cn('tabular-nums', className)}>
          <button
            type="button"
            data-slot="open-marks"
            data-testid="open-marks"
            aria-label={t('annotations.listedOpenIn', { marks: label, name })}
            onPointerDown={keep}
            onKeyDown={keep}
            onClick={(event) => {
              keep(event)
              router.push(reviewHrefAt(window.location, { documentId }, { withDocument: true }), { scroll: false })
            }}
          >
            <MessageSquareText aria-hidden />
            <span>{openMarksShortLabel(t, marks)}</span>
          </button>
        </Chip>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}
