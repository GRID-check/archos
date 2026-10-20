'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, RefreshCw } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { usePressed } from '../../hooks/use-pressed'
import { ASIDE_ACTION_CLASS, PRIMARY_ACTION_CLASS, StepFooter } from '../setup-frame'
import { foundValues, useArrivalOrder } from '../reading/found-values'
import { FoundValuesFeed } from '../reading/found-values-feed'
import { ReadingChatBand } from '../reading/reading-chat-band'
import {
  AddDocuments,
  ReadingDocumentsBar,
  type AddDocumentsProps,
  type DocumentTools,
} from '../reading/reading-documents-bar'
import { ReadingMilestoneCard } from '../reading/reading-milestone-card'
import {
  documentValues,
  readingDocuments,
  readingMilestones,
  readingOver,
  readingPhase,
  type ReadingPhase,
} from '../reading/reading-milestones'
import type { SetupStepProps } from './types'

export { projectChatHref } from '../reading/reading-chat-band'

/** Which sentence the band says: the bell while Piloti still reads, the chat once it is over. */
const BAND: Record<ReadingPhase, 'reading' | 'ready' | 'failed' | 'waiting'> = {
  waiting: 'waiting',
  waitingWithDocuments: 'reading',
  reading: 'reading',
  ready: 'ready',
  completed: 'ready',
  failed: 'failed',
}

/** What Piloti said about what it read, folded behind one quiet link. */
function SummaryDisclosure({ summary }: { summary: string }): JSX.Element {
  const t = useTranslations('intakeReadingStep')
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="reading-summary">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="inline" className="text-muted-foreground hover:text-foreground gap-1 text-[13px] font-normal pointer-coarse:min-h-11">
          {t('summary.toggle')}
          <ChevronDown aria-hidden className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-2 max-w-prose whitespace-pre-line text-sm leading-relaxed">{summary}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Step 3, Erfassung (the approved mockup, `Erfassung.dc.html`). Piloti reads in
 * the background; the step says where it stands, and asks nothing: the person
 * may watch, leave (Piloti tells them when it is done, `piloti.intake_ready`),
 * or ask the project chat now.
 *
 * One column: the heading, the documents as a bar, one card of milestones
 * (Standort, Werte, Widersprüche, Lücken), the values just found with their
 * page, and the calm band with the chat. The footer leads on to the
 * Rückfragen; without documents, back to the Ablage.
 *
 * The frame has no status header, so what it held lives here, folded into
 * quiet links: reading what is unread, and adding documents. A failed
 * reading is said here, with its retry as the footer's action; the frame's
 * alert says it on every other step.
 */
export function ReadingStep({
  view,
  projectId,
  busy,
  canDecide,
  canUpload,
  uploading,
  onFiles,
  onReread,
  onNext,
  onGoTo,
}: SetupStepProps): JSX.Element {
  const t = useTranslations('intakeReadingStep')
  const [retrying, retry] = usePressed()
  const phase = readingPhase(view)
  const running = phase === 'reading' || phase === 'waitingWithDocuments'
  const values = documentValues(view)
  const arrival = useArrivalOrder(values.map((value) => value.key))
  const shown = foundValues(view, arrival)
  const add: AddDocumentsProps | undefined = canUpload ? { projectId, uploading, onFiles } : undefined
  const tools: DocumentTools = {
    // A failed reading's retry is the frame's alert; a second one here would be two of the same.
    reread: canDecide && phase === 'ready' ? { busy, onReread } : undefined,
  }
  const feedHeading = shown.some((value) => value.fresh)
    ? t('found.fresh')
    : readingOver(phase)
      ? t('found.sample')
      : t('found.soFar')

  return (
    <div className="mx-auto w-full max-w-[640px] md:pt-2" data-testid="setup-step-reading" data-phase={phase}>
      <h1 className="text-[22px] font-semibold tracking-tight md:text-2xl">{t(`heading.${phase}`)}</h1>
      {(phase === 'waiting' || phase === 'waitingWithDocuments' || phase === 'failed') && (
        <p className="text-muted-foreground mt-1.5 text-sm">{t(`lead.${phase}`)}</p>
      )}

      {phase === 'waiting' ? (
        add && (
          <div className="text-muted-foreground mt-2 text-[13px]">
            <AddDocuments {...add} />
          </div>
        )
      ) : (
        <div className="mt-4">
          <ReadingDocumentsBar documents={readingDocuments(view)} showUnread={phase === 'ready' || phase === 'completed'} tools={tools} />
        </div>
      )}

      <div className="mt-[22px]">
        <ReadingMilestoneCard milestones={readingMilestones(view)} />
      </div>

      {shown.length > 0 && (
        <div className="mt-[22px]">
          <FoundValuesFeed values={shown} heading={feedHeading} total={values.length} onShowAll={() => onGoTo('profile')} />
        </div>
      )}

      {readingOver(phase) && view.summary && (
        <div className="mt-3">
          <SummaryDisclosure summary={view.summary} />
        </div>
      )}

      <div className="mt-[26px]">
        <ReadingChatBand projectId={projectId} message={t(`band.${BAND[phase]}`)} notify={running} early={!readingOver(phase)} />
      </div>

      {phase === 'waiting' ? (
        <StepFooter
          primary={
            <Button type="button" className={PRIMARY_ACTION_CLASS} onClick={() => onGoTo('filing')}>
              <ArrowLeft aria-hidden />
              {t('toFiling')}
            </Button>
          }
          aside={
            onNext && (
              <button type="button" className={ASIDE_ACTION_CLASS} onClick={onNext}>
                {t('withoutDocuments')}
              </button>
            )
          }
        />
      ) : phase === 'failed' && canDecide ? (
        <StepFooter
          primary={
            <BusyButton
              type="button"
              className={PRIMARY_ACTION_CLASS}
              icon={<RefreshCw aria-hidden />}
              busy={retrying}
              blocked={busy}
              busyLabel={t('retryBusy')}
              onClick={() => retry(async () => onReread())}
            >
              {t('retry')}
            </BusyButton>
          }
          aside={
            onNext && (
              <button type="button" className={ASIDE_ACTION_CLASS} onClick={onNext}>
                {t('nextAnyway')}
              </button>
            )
          }
        />
      ) : (
        <StepFooter
          primary={
            onNext && (
              <Button type="button" className={PRIMARY_ACTION_CLASS} onClick={onNext}>
                {t('next')}
                <ArrowRight aria-hidden />
              </Button>
            )
          }
          aside={add && <AddDocuments {...add} className={ASIDE_ACTION_CLASS} />}
        />
      )}
    </div>
  )
}
