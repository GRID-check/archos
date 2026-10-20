'use client'

import type { JSX, ReactNode } from 'react'
import { useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Info, RefreshCw, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { Stepper } from '@/components/ui/stepper'
import {
  FileDropOverlay,
  useWindowDragGuard,
} from '@/features/documents/components/file-drop-overlay'
import { useFileDragDrop, type DropInfo } from '@/features/documents/hooks/use-file-drag-drop'
import type { FilingFolderSuggestion } from '@/features/documents/lib/filing-suggestions'
import { useTranslations } from '@/i18n'
import type { IntakeDecision, IntakeView } from '@/lib/project-intake/types'
import { usePressed } from '../hooks/use-pressed'
import { CompleteFooter, CompletedNote } from './complete-footer'
import { ContradictionSection } from './contradiction-section'
import { DerivationSection } from './derivation-section'
import { EvidenceProjectContext } from './evidence-chips'
import { FilingSection } from './filing-section'
import { IntakeHeader } from './intake-header'
import { IntakeUploadZone } from './intake-upload-zone'
import { InterviewSection, QuestionSection } from './question-section'
import { ReadingSkeleton } from './reading-skeleton'
import { ReviewSection } from './review-section'

export interface IntakeSetupViewProps {
  view: IntakeView
  projectId: string
  /** A call is in flight: the controls wait. */
  busy: boolean
  /** The last refresh failed; `view` is the last good one. */
  stale: boolean
  /** Whether the project takes documents at all (a closed one does not). */
  canUpload: boolean
  uploading: boolean
  onFiles: (files: File[], info?: DropInfo) => void
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
  onReread: () => void | Promise<void>
  onComplete: () => Promise<boolean>
  onRetry: () => void
  /**
   * The project's open filing suggestions, one per target folder, and the call
   * that re-reads them after one is decided. Absent: the section is not drawn.
   */
  filing?: { entries: readonly FilingFolderSuggestion[]; onSettled: () => void }
  /** The upload's tray and plan dialog, which the connected page owns. */
  children?: ReactNode
  /** The step to open on; by default the one {@link initialSetupStep} picks. */
  initialStep?: SetupStep
}

/** The three steps of the setup, in the order a person goes through them. */
export const SETUP_STEPS = ['documents', 'questions', 'profile'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

/**
 * Where the page opens: on the documents while there are none or nothing has
 * been found yet; on the questions while a contradiction or a decisive one is
 * open; otherwise on the profile to confirm. A finished setup opens on its
 * profile.
 */
export function initialSetupStep(view: IntakeView): SetupStep {
  if (view.status === 'completed') return 'profile'
  const noDocuments = view.counts.documentsRead + view.counts.unreadDocuments === 0
  const nothingFound = view.counts.suggested === 0 && view.groups.every((group) => group.items.length === 0)
  if (noDocuments || (view.status === 'reading' && nothingFound)) return 'documents'
  if (view.contradictions.length > 0 || view.questions.length > 0) return 'questions'
  return 'profile'
}

/**
 * The setup page's body, drawn from the review it is given and calling back for
 * everything it does. Connected to the API in `IntakeSetup`; the `/dev` preview
 * draws it from fixtures.
 *
 * Three steps, the three moments ticket 26 promises a person: hand in the
 * documents (Unterlagen), answer what they do not say (Rückfragen), confirm the
 * profile (Steckbrief). It used to be one page with seven sections, 3 000 px
 * tall, which a pilot office read as another form. Every step stays reachable:
 * the reading runs in the background, and nothing blocks going on without
 * documents, which is how a project is set up by hand. A folder dropped
 * anywhere on the page is filed in the project, on every step.
 */
export function IntakeSetupView({
  view,
  projectId,
  busy,
  stale,
  canUpload,
  uploading,
  onFiles,
  onDecide,
  onReread,
  onComplete,
  onRetry,
  filing,
  children,
  initialStep,
}: IntakeSetupViewProps): JSX.Element {
  const t = useTranslations('projectIntake')
  const finished = view.status === 'completed'
  const dropping = canUpload && !finished
  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: onFiles,
    disabled: !dropping,
    acceptZip: true,
  })
  useWindowDragGuard()
  const [step, setStep] = useState<SetupStep>(() => initialStep ?? initialSetupStep(view))
  const top = useRef<HTMLDivElement>(null)
  const go = (next: SetupStep): void => {
    setStep(next)
    top.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const noDocuments = view.counts.documentsRead + view.counts.unreadDocuments === 0
  const decideProps = { canDecide: view.canDecide && !finished, busy, onDecide }
  const toAnswer = view.contradictions.length + view.questions.length
  const index = SETUP_STEPS.indexOf(step)
  const steps = [
    {
      key: 'documents',
      label: t('steps.documents'),
      note: noDocuments ? undefined : t('counts.documents', { count: view.counts.documentsRead }),
    },
    {
      key: 'questions',
      label: t('steps.questions'),
      note: toAnswer > 0 ? t('steps.open', { count: toAnswer }) : undefined,
    },
    { key: 'profile', label: t('steps.profile') },
  ]

  return (
    <EvidenceProjectContext.Provider value={projectId}>
      <div
        ref={top}
        className="relative mx-auto w-full max-w-3xl scroll-mt-4 space-y-8 px-4 py-8 md:px-8"
        data-testid="intake-setup"
        data-status={view.status}
        data-step={step}
        {...dragHandlers}
      >
        {isDragging && (
          <FileDropOverlay
            isUnsupported={isUnsupportedDrag}
            uploadLabel={t('upload.dropOverlay')}
            unsupportedLabel={t('upload.unsupportedOverlay')}
            // The page runs far below the fold once the review is drawn.
            followScroll
            testId="intake-drop-overlay"
          />
        )}

        <Stepper
          steps={steps}
          current={index}
          // Every step is open from the start: nothing in one blocks the next.
          furthest={SETUP_STEPS.length - 1}
          onSelect={(next) => go(SETUP_STEPS[next] ?? 'documents')}
          label={t('steps.label')}
          progressLabel={t('steps.progress', { current: index + 1, total: SETUP_STEPS.length })}
        />

        {stale && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertDescription className="text-current">
              <p>{t('errors.load')}</p>
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                {t('errors.retry')}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {!view.canDecide && !finished && (
          <Alert role="status">
            <Info aria-hidden />
            <AlertDescription>{t('header.readOnly')}</AlertDescription>
          </Alert>
        )}
        {finished && <CompletedNote view={view} />}

        {/* Where the reading stands, on every step: it runs in the background
            while the person answers and confirms, and reading again or adding
            a document is never more than one step away. */}
        <IntakeHeader
          view={view}
          projectId={projectId}
          busy={busy}
          uploading={uploading}
          canUpload={dropping && !noDocuments}
          onReread={onReread}
          onFiles={onFiles}
        />
        {view.status === 'failed' && <FailedReading canRetry={view.canDecide} busy={busy} onReread={onReread} />}

        {step === 'documents' && (
          <>
            {noDocuments && dropping && (
              <IntakeUploadZone projectId={projectId} onFiles={onFiles} uploading={uploading} />
            )}
            {filing && !finished && <FilingSection entries={filing.entries} onSettled={filing.onSettled} />}
            {children}
            <StepNav
              next={{
                label: noDocuments ? t('steps.withoutDocuments') : t('steps.toQuestions'),
                hint: view.status === 'reading' ? t('steps.readingGoesOn') : undefined,
                onClick: () => go('questions'),
              }}
            />
          </>
        )}

        {step === 'questions' && (
          <>
            {toAnswer === 0 && view.openQuestions.length === 0 && (
              <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm" data-testid="intake-questions-none">
                {view.status === 'reading' ? t('steps.questionsWhileReading') : t('steps.questionsNone')}
              </p>
            )}
            <ContradictionSection items={view.contradictions} {...decideProps} />
            <QuestionSection questions={view.questions} {...decideProps} onFiles={onFiles} />
            {!finished && <InterviewSection needs={view.openQuestions} {...decideProps} />}
            <StepNav
              back={{ label: t('steps.documents'), onClick: () => go('documents') }}
              next={{ label: t('steps.toProfile'), onClick: () => go('profile') }}
            />
          </>
        )}

        {step === 'profile' && (
          <>
            <DerivationSection derivations={view.derivations} {...decideProps} />
            <ReviewSection groups={view.groups} {...decideProps} />
            {view.status === 'reading' && <ReadingSkeleton />}
            <CompleteFooter view={view} busy={busy} onComplete={onComplete} onResolve={() => go('questions')} />
            <StepNav back={{ label: t('steps.questions'), onClick: () => go('questions') }} />
          </>
        )}
      </div>
    </EvidenceProjectContext.Provider>
  )
}

/** Back and on between the steps: a quiet back, and the next step as the way forward. */
function StepNav({
  back,
  next,
}: {
  back?: { label: string; onClick: () => void }
  next?: { label: string; hint?: string; onClick: () => void }
}): JSX.Element {
  return (
    <nav className="border-border flex flex-wrap items-center gap-3 border-t pt-5" data-testid="intake-step-nav">
      {back && (
        <Button type="button" variant="ghost" onClick={back.onClick}>
          <ArrowLeft aria-hidden />
          {back.label}
        </Button>
      )}
      {next && (
        <div className="ml-auto flex items-center gap-3">
          {next.hint && <p className="text-muted-foreground hidden text-xs sm:block">{next.hint}</p>}
          <Button type="button" onClick={next.onClick}>
            {next.label}
            <ArrowRight aria-hidden />
          </Button>
        </div>
      )}
    </nav>
  )
}

/**
 * The reading did not finish. The alert says so where the reading would have
 * shown, keeps what was found (the review below), and carries the one way
 * forward: another reading of what is still unread.
 */
function FailedReading({
  canRetry,
  busy,
  onReread,
}: {
  canRetry: boolean
  busy: boolean
  onReread: () => void | Promise<void>
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const [retrying, retry] = usePressed()
  return (
    <Alert variant="destructive" data-testid="intake-failed">
      <TriangleAlert aria-hidden />
      <AlertTitle>{t('header.failedTitle')}</AlertTitle>
      <AlertDescription>
        <p>{t('header.failed')}</p>
        {canRetry && (
          <BusyButton
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            icon={<RefreshCw aria-hidden />}
            busy={retrying}
            blocked={busy}
            busyLabel={t('busy.reread')}
            aria-label={t('header.retryAria')}
            onClick={() => retry(async () => onReread())}
          >
            {t('header.reread')}
          </BusyButton>
        )}
      </AlertDescription>
    </Alert>
  )
}
