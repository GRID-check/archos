'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTranslations } from '@/i18n'
import { intakeProfileStepCopy } from '@/i18n/namespaces/intake-profile-step'
import { projectIntakeCopy } from '@/i18n/namespaces/project-intake'
import { projectsCopy } from '@/i18n/namespaces/projects'
import type { ClosingIntent, IntakeView } from '@/lib/project-intake/types'
import { usePressed } from '../../hooks/use-pressed'
import { formatMonth } from '../completed-note'
import { ClassCard } from '../profile/class-card'
import { FindingsCard } from '../profile/findings-card'
import { finishDecisions } from '../profile/profile-review'
import { RulesCard } from '../profile/rules-card'
import { PRIMARY_ACTION_CLASS, StepFooter } from '../setup-frame'
import type { SetupStepProps } from './types'

export interface ProfileStepProps extends SetupStepProps {
  onComplete: () => Promise<boolean>
}

/**
 * Step 5, Steckbrief (ticket 26, `docs/design/project-setup-five-steps.md`):
 * the result first, then the evidence. On top the Gebäudeklasse, big, with why
 * in one line and a confirm, and beside it which OIB-Richtlinien apply; under
 * them one table of what Piloti found, each value with the place it stands and
 * its page on a peek. The few values that decide the most are shown, the rest
 * fold away by topic, and every open one can be taken at once.
 *
 * Contradictions are decided in the Rückfragen; one quiet line points there
 * while any is open. The person checks rather than approves: nothing asks to
 * be clicked one by one. They change what is wrong, and the one way on,
 * „Alles übernehmen und abschließen“, takes the rest as theirs.
 */
export function ProfileStep({ view, projectId, canDecide, busy, onDecide, onComplete, onGoTo }: ProfileStepProps): JSX.Element {
  const t = useTranslations(intakeProfileStepCopy)
  const decide = { canDecide, busy, onDecide }
  const finished = view.status === 'completed'
  return (
    <div className="mx-auto w-full max-w-[1040px]" data-testid="setup-step-profile">
      <h1 className="sr-only">{t('heading')}</h1>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)] md:gap-5">
        <ClassCard derivations={view.derivations} onAnswer={() => onGoTo('questions')} />
        <RulesCard view={view} />
      </div>
      {view.contradictions.length > 0 && (
        <p className="text-muted-foreground mt-4 flex flex-wrap items-center gap-x-2 text-[13px] md:mt-5" data-testid="profile-contradictions">
          <span>{t('contradictions.open', { count: view.contradictions.length })}</span>
          <Button type="button" variant="inline" className="touch-target text-[13px]" onClick={() => onGoTo('questions')}>
            {t('contradictions.resolve')}
          </Button>
        </p>
      )}
      <div className="mt-4 md:mt-5">
        <FindingsCard
          projectId={projectId}
          groups={view.groups}
          derivations={view.derivations}
          reading={view.status === 'reading'}
          editable={!finished}
          {...decide}
        />
      </div>
      <FinishFooter view={view} canDecide={canDecide} busy={busy} onDecide={onDecide} onComplete={onComplete} />
    </div>
  )
}

/** Nothing for a person to look at yet: no value, no contradiction, no question. */
function nothingToReview(view: IntakeView): boolean {
  return view.counts.suggested === 0 && view.contradictions.length === 0 && view.questions.length === 0
}

/** Whether the setup can be finished from here: not yet finished, allowed, and something read or the reading done. */
export function canFinish(view: IntakeView): boolean {
  if (view.status === 'completed' || !view.canComplete) return false
  return view.status === 'ready' || !nothingToReview(view)
}

/**
 * The footer's one action. „Alles übernehmen und abschließen“ takes every open
 * value and class as the person's confirmation, then ends the setup; what they
 * changed or struck out is already decided. Finishing an ongoing project goes
 * at once; finishing a past one closes the project with its outcome and
 * period, so that asks first. A reader who may not decide only finishes.
 */
function FinishFooter({
  view,
  canDecide,
  busy,
  onDecide,
  onComplete,
}: Pick<ProfileStepProps, 'view' | 'canDecide' | 'busy' | 'onDecide' | 'onComplete'>): JSX.Element {
  const t = useTranslations(intakeProfileStepCopy)
  const tIntake = useTranslations(projectIntakeCopy)
  const [finishing, finish] = usePressed()
  const [asking, setAsking] = useState(false)
  const closing = view.closing
  const decisions = canDecide ? finishDecisions(view) : []
  const takeAndFinish = async (): Promise<boolean> => {
    if (decisions.length > 0 && !(await onDecide(decisions))) return false
    return onComplete()
  }
  const primary = canFinish(view) ? (
    <BusyButton
      type="button"
      className={PRIMARY_ACTION_CLASS}
      busy={finishing}
      blocked={busy}
      busyLabel={tIntake('busy.complete')}
      onClick={() => (closing ? setAsking(true) : finish(takeAndFinish))}
      data-testid="profile-finish"
    >
      {decisions.length > 0 ? t('finish.takeAll') : t('finish.button')}
    </BusyButton>
  ) : undefined
  return (
    <>
      <StepFooter
        primary={primary}
        note={primary ? (decisions.length > 0 ? t('finish.noteTakeAll') : t('finish.note')) : undefined}
      />
      {closing && (
        <ConfirmDialog
          open={asking}
          onOpenChange={setAsking}
          title={t('finish.closingTitle')}
          description={<ClosingDescription closing={closing} />}
          confirmLabel={t('finish.confirm')}
          cancelLabel={t('finish.cancel')}
          tone="warning"
          pending={busy}
          onConfirm={async () => {
            if (await takeAndFinish()) setAsking(false)
          }}
        />
      )}
    </>
  )
}

function ClosingDescription({ closing }: { closing: ClosingIntent }): JSX.Element {
  const t = useTranslations(intakeProfileStepCopy)
  const tIntake = useTranslations(projectIntakeCopy)
  const tProjects = useTranslations(projectsCopy)
  const period = closing.startedOn
    ? tIntake('complete.period', { from: formatMonth(closing.startedOn), to: formatMonth(closing.endedOn) })
    : tIntake('complete.periodEnd', { to: formatMonth(closing.endedOn) })
  return <>{t('finish.closingDescription', { outcome: tProjects(`lifecycle.outcome.${closing.outcome}`), period })}</>
}
