'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import { ArrowRight, ChevronDown, Info } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CountPill } from '@/components/ui/count-pill'
import { Progress } from '@/components/ui/progress'
import { useTranslations } from '@/i18n'
import type { IntakeView } from '@/lib/project-intake/types'
import { cn } from '@/lib/utils'
import { displayValue } from '../../lib/display'
import { IntakeSection } from '../intake-atoms'
import { InterviewSection, QuestionCard } from '../question-section'
import { DocumentRequestCard } from '../questions/document-request-card'
import { useRoundProgress } from '../questions/use-round-progress'
import { questionRound } from '../../lib/question-round'
import type { SetupStepProps } from './types'

export { questionRound, type QuestionRound } from '../../lib/question-round'

/** „Wien", „Graz, Steiermark": where the register reads the location. */
function placeOf(view: IntakeView): string | null {
  const register = view.locationRegister
  if (!register?.bundesland) return null
  const land = displayValue('bundesland', register.bundesland)
  const gemeinde = register.gemeinde
  return gemeinde && gemeinde.localeCompare(land, 'de', { sensitivity: 'base' }) !== 0 ? `${gemeinde}, ${land}` : land
}

/**
 * Step 4, Rückfragen: every question and every document request on one
 * screen, done in one pass (ticket 26). Only what changes the classification:
 * the location register's inputs, the needs that decide a Gebäudeklasse, and
 * the documents the location calls for. Each entry is answered, marked „nicht
 * bekannt", or settled by handing in its document right there; a settled one
 * leaves the list and counts as done. The round belongs after the reading,
 * but nothing waits for it: while Piloti still reads, the step says so and
 * takes what the person already knows. A past project is asked only the few
 * things that matter. The other open needs stay reachable, folded, below.
 */
export function QuestionsStep({ view, canDecide, busy, canUpload, onDecide, onFiles, onNext }: SetupStepProps): JSX.Element {
  const t = useTranslations('intakeQuestionsStep')
  const round = questionRound(view)
  const progress = useRoundProgress(round.openIds, round.settledIds)
  const [moreOpen, setMoreOpen] = useState(false)
  const decide = { canDecide, busy, onDecide }
  const reading = view.status === 'reading' || (view.status === 'waiting' && view.counts.unreadDocuments > 0)
  const place = placeOf(view)
  const nothingOpen = round.questions.length === 0 && round.requests.length === 0
  const hasRequests = round.requests.length > 0 || round.settledIds.length > 0

  return (
    <div className="space-y-8" data-testid="setup-step-questions">
      <IntakeSection label={t('heading')} description={t('description')} testId="questions-round">
        {progress.total > 0 && (
          <div className="space-y-1.5" data-testid="questions-progress">
            <p className="text-muted-foreground text-xs tabular-nums">
              {t('progress', { done: progress.done, total: progress.total })}
            </p>
            <Progress value={(progress.done / progress.total) * 100} aria-label={t('progressLabel')} />
          </div>
        )}
        {reading && (
          <Alert role="status" data-testid="questions-reading-note">
            <Info aria-hidden />
            <AlertDescription>{t('readingNote')}</AlertDescription>
          </Alert>
        )}
        {view.mode === 'closing' && (
          <Alert role="status" data-testid="questions-closing-note">
            <Info aria-hidden />
            <AlertDescription>{t('closingNote')}</AlertDescription>
          </Alert>
        )}
        {nothingOpen && !reading && (
          <p
            className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm"
            data-testid="questions-done"
          >
            {progress.total > 0 ? t('done') : t('nothing')}
          </p>
        )}
      </IntakeSection>

      {round.questions.length > 0 && (
        <IntakeSection label={t('decisiveHeading')} count={round.questions.length} testId="questions-decisive">
          <ul className="space-y-3">
            {round.questions.map((need) => (
              <li key={need.key}>
                <QuestionCard need={need} {...decide} onFiles={canUpload ? onFiles : undefined} />
              </li>
            ))}
          </ul>
        </IntakeSection>
      )}

      {hasRequests && (
        <IntakeSection
          label={t('locationHeading')}
          count={round.requests.length}
          description={place ? t('locationPlace', { place }) : t('locationPlaceUnknown')}
          testId="questions-location"
        >
          <ul className="space-y-3">
            {round.requests.map((request) => (
              <li key={request.determinant}>
                <DocumentRequestCard request={request} {...decide} onFiles={onFiles} canUpload={canUpload} />
              </li>
            ))}
          </ul>
        </IntakeSection>
      )}

      {round.more.length > 0 && canDecide && (
        <Collapsible open={moreOpen} onOpenChange={setMoreOpen} data-testid="questions-more">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" className="h-auto w-full justify-start gap-2 px-2 py-2 text-left">
              <ChevronDown
                className={cn('size-4 shrink-0 transition-transform motion-reduce:transition-none', moreOpen && 'rotate-180')}
                aria-hidden
              />
              <span className="font-medium">{t('more')}</span>
              <CountPill>{round.more.length}</CountPill>
              <span className="text-muted-foreground hidden truncate text-xs font-normal sm:inline">{t('moreHint')}</span>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <InterviewSection needs={round.more} {...decide} bare />
          </CollapsibleContent>
        </Collapsible>
      )}

      {onNext && (
        <nav className="border-border flex justify-end border-t pt-5" data-testid="questions-next">
          <Button type="button" onClick={onNext}>
            {t('next')}
            <ArrowRight aria-hidden />
          </Button>
        </nav>
      )}
    </div>
  )
}
