'use client'

import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { ArrowRight, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useTranslations } from '@/i18n'
import type { IntakeView } from '@/lib/project-intake/types'
import { cn } from '@/lib/utils'
import { displayValue } from '../../lib/display'
import { questionRound, type RoundEntry } from '../../lib/question-round'
import { InterviewSection } from '../question-section'
import type { QuestionPosition, RoundFooter } from '../questions/question-shell'
import { ContradictionQuestion, NeedQuestion, RequestQuestion, useContradictionTitle } from '../questions/round-questions'
import { RoundList } from '../questions/round-list'
import { currentRow, nextOpenRow, useRoundMemory, type RoundRow } from '../questions/use-round-memory'
import { ASIDE_ACTION_CLASS, PRIMARY_ACTION_CLASS, StepFooter } from '../setup-frame'
import type { SetupStepProps } from './types'

export { questionRound, type QuestionRound } from '../../lib/question-round'

/** „Wien", „Graz, Steiermark": where the register reads the location. */
function placeOf(view: IntakeView): string | null {
  const register = view.locationRegister
  if (!register?.federalState) return null
  const federalState = displayValue('bundesland', register.federalState)
  const municipality = register.municipality
  return municipality && municipality.localeCompare(federalState, 'de', { sensitivity: 'base' }) !== 0 ? `${municipality}, ${federalState}` : federalState
}

/**
 * Step 4, Rückfragen: one question at a time (ticket 26). On the left every
 * Rückfrage of the round, grouped: what is missing in the documents (the
 * location register's inputs and the needs that decide a Gebäudeklasse), the
 * documents the location calls for, and the contradictions, where picking a
 * value settles it. On the right the one asked now, answered with the
 * wizard's own control, marked „nicht bekannt", or settled by handing in its
 * document right there; each answer moves on to the next. Nothing waits for
 * the round: „Rest später" goes on to the Steckbrief. While Piloti still
 * reads, the step says so and takes what the person already knows. The other
 * open needs stay reachable, folded into a sheet.
 */
export function QuestionsStep({ view, canDecide, busy, canUpload, onDecide, onFiles, onNext }: SetupStepProps): JSX.Element {
  const t = useTranslations('intakeQuestionsStep')
  const isMobile = useIsMobile()
  const round = questionRound(view)
  const contradictionTitle = useContradictionTitle()
  const labelOf = (entry: RoundEntry): string =>
    entry.kind === 'need' ? entry.need.label : entry.kind === 'request' ? entry.request.label : contradictionTitle(entry.contradiction)
  const { rows, markDone } = useRoundMemory(round.entries, round.settled, labelOf)
  const [chosenId, setChosenId] = useState<string | null>(null)
  const [putOff, setPutOff] = useState<ReadonlySet<string>>(() => new Set())
  const [moreOpen, setMoreOpen] = useState(false)
  const current = currentRow(rows, chosenId, putOff)
  const reading = view.status === 'reading' || (view.status === 'waiting' && view.counts.unreadDocuments > 0)
  const place = placeOf(view)

  const done = rows.filter((row) => row.done).length
  const total = rows.length
  const progress = { done, total, label: t('progress', { done, total }) }
  const allDone = current === null
  const desk: ReactNode = onNext ? (
    <Button type="button" variant={allDone ? 'default' : 'outline'} className={PRIMARY_ACTION_CLASS} onClick={onNext}>
      {allDone ? t('next') : t('rest')}
      <ArrowRight aria-hidden />
    </Button>
  ) : undefined
  const footer: RoundFooter = { progress, desk }

  const note: ReactNode = reading ? (
    <p className="flex gap-1.5" data-testid="questions-reading-note" role="status">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {t('readingNote')}
    </p>
  ) : view.mode === 'closing' ? (
    <p className="flex gap-1.5" data-testid="questions-closing-note" role="status">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {t('closingNote')}
    </p>
  ) : null

  const more =
    round.more.length > 0 && canDecide ? (
      <Button
        type="button"
        variant="link"
        className="text-muted-foreground hover:text-foreground h-auto touch-target gap-2 p-0 text-[15px] font-normal md:text-[13px]"
        onClick={() => setMoreOpen(true)}
      >
        {t('more')}
        <CountPill>{round.more.length}</CountPill>
      </Button>
    ) : null

  const whyOf = (entry: RoundEntry): string => {
    if (entry.kind === 'need') return entry.need.decisive ? t('why.decisive') : t('why.register')
    if (entry.kind === 'request') return place ? t('why.location', { place }) : t('why.locationUnknown')
    return entry.contradiction.decisive ? t('why.decisive') : t('why.contradiction')
  }

  const ask = (row: RoundRow & { entry: RoundEntry }): JSX.Element => {
    const position: QuestionPosition = {
      index: rows.findIndex((candidate) => candidate.id === row.id) + 1,
      total,
      why: whyOf(row.entry),
    }
    const shared = {
      position,
      footer,
      canDecide,
      busy,
      onDecide,
      onFiles: canUpload ? onFiles : undefined,
      onDone: (value: string) => markDone(row.id, value),
      onPutOff: () => {
        const next = new Set(putOff).add(row.id)
        setPutOff(next)
        setChosenId(nextOpenRow(rows, row.id, next)?.id ?? null)
      },
      after: (
        <>
          {more}
          {onNext && (
            <Button type="button" variant="link" className={cn(ASIDE_ACTION_CLASS, 'h-auto px-0 font-normal')} onClick={onNext}>
              {t('rest')}
            </Button>
          )}
        </>
      ),
    }
    const { entry } = row
    // Keyed by the item: a new question starts with an empty draft.
    if (entry.kind === 'need') return <NeedQuestion key={row.id} need={entry.need} {...shared} />
    if (entry.kind === 'request') return <RequestQuestion key={row.id} request={entry.request} {...shared} />
    return <ContradictionQuestion key={row.id} item={entry.contradiction} {...shared} />
  }

  return (
    <div className="mx-auto flex w-full max-w-[1040px] justify-center gap-10" data-testid="setup-step-questions">
      <RoundList rows={rows} currentId={current?.id ?? null} onChoose={setChosenId} note={note} footer={more} />

      {current?.entry ? (
        <div className="flex min-w-0 flex-1 flex-col gap-4 md:max-w-[640px] md:flex-none md:basis-[640px]">
          {isMobile && note && <div className="text-muted-foreground text-[13px] leading-snug">{note}</div>}
          {ask(current as RoundRow & { entry: RoundEntry })}
        </div>
      ) : (
        <section
          className="md:bg-card md:border-border w-full min-w-0 md:max-w-[640px] md:basis-[640px] md:self-start md:rounded-[14px] md:border md:px-9 md:py-8"
          data-testid="questions-done"
        >
          {isMobile && note && <div className="text-muted-foreground text-[13px] leading-snug">{note}</div>}
          <h2 className="text-[22px] leading-[1.3] font-semibold tracking-tight">
            {total > 0 ? t('doneTitle') : reading ? t('waitingTitle') : t('nothingTitle')}
          </h2>
          <p className="text-muted-foreground mt-2.5 text-[15px] leading-normal md:text-sm">
            {total > 0 ? t('done') : reading ? t('waiting') : t('nothing')}
          </p>
          {isMobile && more && <div className="mt-6">{more}</div>}
          <StepFooter primary={desk} progress={total > 0 ? progress : undefined} />
        </section>
      )}

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} closeLabel={t('moreClose')} className="sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{t('more')}</SheetTitle>
            <SheetDescription>{t('moreHint')}</SheetDescription>
          </SheetHeader>
          <InterviewSection needs={round.more} canDecide={canDecide} busy={busy} onDecide={onDecide} bare />
        </SheetContent>
      </Sheet>
    </div>
  )
}
