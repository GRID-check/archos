'use client'

import type { JSX } from 'react'
import Link from 'next/link'
import { ArrowLeft, ArrowRight, BellRing, MessageSquare } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { IntakeSection } from '../intake-atoms'
import { ReadingMilestoneList } from '../reading/reading-milestone-list'
import { readingMilestones, readingPhase } from '../reading/reading-milestones'
import { ReadingSummarySkeleton } from '../reading-skeleton'
import type { SetupStepProps } from './types'

/** The project's chat: usable from the first minute, whatever the reading is doing. */
export const projectChatHref = (projectId: string): string => `/app/projects/${encodeURIComponent(projectId)}/chat`

/**
 * Step 3, Erfassung. Piloti reads in the background; this step says where it
 * stands as named milestones (Standort, Dokumente x von y, Werte,
 * Widersprüche, Lücken), each a number the server computed on this read, and
 * moves as the frame re-reads the view. It asks nothing of the person: they
 * may watch, leave (and are told when Piloti is done, `piloti.intake_ready`),
 * or ask the project chat now.
 *
 * The frame hides its status line on this step, so the full progress is here,
 * and the reading's summary once it is done. A failed reading's alert and its
 * retry are the frame's, above every step; this step does not draw a second.
 * Reading again is the frame's header's too.
 */
export function ReadingStep({ view, projectId, onNext, onGoTo }: SetupStepProps): JSX.Element {
  const t = useTranslations('intakeReadingStep')
  const phase = readingPhase(view)
  const reading = phase === 'reading'
  const over = phase === 'ready' || phase === 'failed' || phase === 'completed'
  const chat = (
    <Button asChild size="sm" variant="outline">
      <Link href={projectChatHref(projectId)} aria-label={t('askChatAria')} data-testid="reading-ask-chat">
        <MessageSquare aria-hidden />
        {t('askChat')}
      </Link>
    </Button>
  )

  return (
    <div className="space-y-8" data-testid="setup-step-reading" data-phase={phase}>
      <IntakeSection label={t(`heading.${phase}`)} description={t(`lead.${phase}`)} action={chat} testId="reading-head">
        <ReadingMilestoneList milestones={readingMilestones(view)} />
      </IntakeSection>

      {(reading || phase === 'waitingWithDocuments') && (
        <Alert variant="info" role="status" data-testid="reading-leave">
          <BellRing aria-hidden />
          <AlertTitle>{t('leave.title')}</AlertTitle>
          <AlertDescription>{t('leave.body')}</AlertDescription>
        </Alert>
      )}

      {reading && (
        <section className="space-y-3" aria-label={t('summary.heading')} data-testid="reading-summary-pending">
          <SectionLabel as="h3">{t('summary.heading')}</SectionLabel>
          <p className="text-muted-foreground text-sm">{t('summary.pending')}</p>
          <ReadingSummarySkeleton />
        </section>
      )}
      {over && view.summary && (
        <section className="space-y-2" aria-label={t('summary.heading')} data-testid="reading-summary">
          <SectionLabel as="h3">{t('summary.heading')}</SectionLabel>
          <p className="max-w-prose text-sm leading-relaxed whitespace-pre-line">{view.summary}</p>
        </section>
      )}

      <nav className="border-border flex flex-wrap items-center gap-3 border-t pt-5" data-testid="reading-step-nav">
        {phase === 'waiting' ? (
          <Button type="button" onClick={() => onGoTo('filing')}>
            <ArrowLeft aria-hidden />
            {t('toFiling')}
          </Button>
        ) : (
          onNext && (
            <Button
              type="button"
              className="ml-auto"
              // The way on is always open; it leads once the reading is over.
              variant={over ? 'default' : 'outline'}
              data-emphasis={over ? 'lead' : 'quiet'}
              onClick={onNext}
            >
              {t('next')}
              <ArrowRight aria-hidden />
            </Button>
          )
        )}
      </nav>
    </div>
  )
}
