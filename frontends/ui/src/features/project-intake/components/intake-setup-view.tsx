'use client'

import type { JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Info, RefreshCw, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import {
  FileDropOverlay,
  useWindowDragGuard,
} from '@/features/documents/components/file-drop-overlay'
import { useFileDragDrop, type DropInfo } from '@/features/documents/hooks/use-file-drag-drop'
import type { FilingFolderSuggestion } from '@/features/documents/lib/filing-suggestions'
import { useTranslations, type Translator } from '@/i18n'
import type { IntakeDecision, IntakeView } from '@/lib/project-intake/types'
import { usePressed } from '../hooks/use-pressed'
import { CompletedNote } from './complete-footer'
import { EvidenceProjectContext } from './evidence-chips'
import { SetupBar, SetupFooter, StepFooterProvider, useStepFooterChannel } from './setup-frame'
import { FilingStep } from './steps/filing-step'
import { ProfileStep } from './steps/profile-step'
import { ProjectStep } from './steps/project-step'
import type { ParticipantsClient } from '@/lib/projects/participants-client'
import { QuestionsStep } from './steps/questions-step'
import { questionRound } from '../lib/question-round'
import { ReadingStep } from './steps/reading-step'
import {
  SETUP_STEP_IDS,
  isSetupStepId,
  type SetupStepId,
  type SetupStepProps,
  type SetupStepSummary,
} from './steps/types'

export interface IntakeSetupViewProps {
  view: IntakeView
  projectId: string
  /** The project's name, for the page head; absent, the head says only „Einrichtung". */
  projectName?: string
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
   * that re-reads them after one is decided. Absent: the Ablage draws none.
   */
  filing?: { entries: readonly FilingFolderSuggestion[]; onSettled: () => void }
  /** The upload's tray and plan dialog, which the connected page owns; drawn on the Ablage. */
  children?: ReactNode
  /** The participants API step 1 uses; the real one unless the `/dev` preview brings fixtures. */
  participantsClient?: ParticipantsClient
}

/** The URL parameter that holds the step being shown (`?step=questions`). */
export const SETUP_STEP_PARAM = 'step'

function hasNoDocuments(view: IntakeView): boolean {
  return view.counts.documentsRead + view.counts.unreadDocuments === 0
}

function hasFoundNothing(view: IntakeView): boolean {
  return view.counts.suggested === 0 && view.groups.every((group) => group.items.length === 0)
}

/**
 * Where the page opens when the address names no step. A finished setup opens
 * on its Steckbrief. Without documents, on the Ablage, where they go in. While
 * a reading has found nothing yet (or stopped before it did), on the
 * Erfassung. While a decisive question waits, on the Rückfragen. Otherwise on
 * the Steckbrief, to confirm. The Projekt step is never the default: the
 * create dialog has just taken it.
 */
export function defaultSetupStep(view: IntakeView): SetupStepId {
  if (view.status === 'completed') return 'profile'
  if (hasNoDocuments(view)) return 'filing'
  if (view.status !== 'ready' && hasFoundNothing(view)) return 'reading'
  if (questionRound(view).openIds.length > 0) return 'questions'
  return 'profile'
}

/** The note under each step in the stepper, „23 gelesen", „3 offen": short, countable, or nothing. */
export function setupStepSummaries(view: IntakeView, tShell: Translator): SetupStepSummary[] {
  const { counts } = view
  const total = counts.documentsRead + counts.unreadDocuments
  const finished = view.status === 'completed'
  const readingNote = (): string | undefined => {
    // While a reading runs, how far THIS reading got: `documentsRead` is only
    // written when it finishes.
    if (view.status === 'reading') {
      const { documentsOpened, documentsTotal } = view.readingProgress
      return tShell('notes.readOf', { read: documentsOpened, total: documentsTotal })
    }
    if (view.status === 'failed') return tShell('notes.failed')
    return counts.documentsRead > 0 ? tShell('notes.read', { count: counts.documentsRead }) : undefined
  }
  const openQuestions = finished ? 0 : questionRound(view).openIds.length
  // Contradictions are settled in the Rückfragen round and counted there.
  const profileNote = (): string | undefined => {
    if (finished) return tShell('notes.done')
    return counts.suggested > 0 ? tShell('notes.values', { count: counts.suggested }) : undefined
  }
  return [
    { id: 'project', open: false },
    {
      id: 'filing',
      note: total > 0 ? tShell('notes.documents', { count: total }) : undefined,
      open: total === 0 && !finished,
    },
    { id: 'reading', note: readingNote(), open: false },
    {
      id: 'questions',
      // Everything step 4 asks: the decisive questions, the location
      // documents still to hand in, and the contradictions.
      note: openQuestions > 0 ? tShell('notes.open', { count: openQuestions }) : undefined,
      open: openQuestions > 0,
    },
    {
      id: 'profile',
      note: profileNote(),
      open: !finished && counts.suggested > 0,
    },
  ]
}

/**
 * The step shown, kept in the address (`?step=`) so back and forward walk the
 * steps, a reload stays where it was, and a link (the inbox item, the
 * overview) can open a named one. Without a step in the address, the page
 * opens where {@link defaultSetupStep} points when it is first drawn, and stays
 * there while the reading updates the view underneath.
 *
 * A step is written with `history.pushState`, which Next's router follows
 * (`useSearchParams`) without asking the server for the page again.
 */
function useSetupStep(view: IntakeView): [SetupStepId, (next: SetupStepId) => void] {
  const searchParams = useSearchParams()
  const fromUrl = searchParams?.get(SETUP_STEP_PARAM)
  const [fallback] = useState<SetupStepId>(() => defaultSetupStep(view))
  const step = isSetupStepId(fromUrl) ? fromUrl : fallback
  const go = (next: SetupStepId): void => {
    if (next === step) return
    const url = new URL(window.location.href)
    url.searchParams.set(SETUP_STEP_PARAM, next)
    // The create dialog's handover is taken once; a reload must not ask for it again.
    url.searchParams.delete('drop')
    window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }
  return [step, go]
}

/**
 * The setup page's frame (ticket 26, `docs/design/project-setup-five-steps.md`):
 * the head with the project and the way out, the reading's status line, the
 * stepper over the five steps, and the step being shown. Connected to the API
 * in `IntakeSetup`; the `/dev/project-setup` preview draws it from fixtures.
 *
 * Each step is its own organism (`steps/`) and draws its own way on, through
 * `onNext` and `onGoTo`. Every step is reachable: the reading runs in the
 * background, and nothing in one step blocks the next. What holds on every
 * step stays here: a document dropped anywhere on the page is filed in the
 * project, and the stale-load, read-only, failed-reading and finished notices
 * sit above the step.
 */
export function IntakeSetupView({
  view,
  projectId,
  projectName,
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
  participantsClient,
}: IntakeSetupViewProps): JSX.Element {
  const tShell = useTranslations('intakeShell')
  const t = useTranslations('projectIntake')
  const finished = view.status === 'completed'
  const dropping = canUpload && !finished
  const [step, go] = useSetupStep(view)
  // The Ablage takes a folder through its tree (choose, then upload); a drop
  // anywhere else on that step would skip the tree, so the page takes none there.
  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: onFiles,
    disabled: !dropping || step === 'filing',
    acceptZip: true,
  })
  useWindowDragGuard()
  const top = useRef<HTMLElement>(null)
  const footer = useStepFooterChannel()
  const shown = useRef(step)
  // To the top of the page whenever the step changes, by a click or by back
  // and forward; not on the first paint.
  useEffect(() => {
    if (shown.current === step) return
    shown.current = step
    top.current?.scrollTo?.({ top: 0 })
  }, [step])

  // The Erfassung says a failed reading itself, with the retry as its action.
  const failedElsewhere = view.status === 'failed' && step !== 'reading'
  const index = SETUP_STEP_IDS.indexOf(step)
  const next = SETUP_STEP_IDS[index + 1]
  const summaries = setupStepSummaries(view, tShell)
  const stepProps: SetupStepProps = {
    view,
    projectId,
    busy,
    canDecide: view.canDecide && !finished,
    canUpload: dropping,
    uploading,
    onDecide,
    onFiles,
    onReread,
    onNext: next ? () => go(next) : undefined,
    onGoTo: go,
  }

  return (
    <EvidenceProjectContext.Provider value={projectId}>
      <StepFooterProvider value={footer.channel}>
        <div
          className="bg-background relative flex h-full min-h-0 flex-col"
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
              testId="intake-drop-overlay"
            />
          )}

          <SetupBar
            projectId={projectId}
            projectName={projectName}
            step={step}
            summaries={summaries}
            progress={footer.progress ?? undefined}
            onGoTo={go}
          />

          <main
            ref={top}
            className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-6 md:px-8 md:pt-9"
            aria-label={tShell(`steps.${step}`)}
          >
            {(stale || (!view.canDecide && !finished) || finished || failedElsewhere) && (
              <div className="mx-auto mb-6 w-full max-w-[1040px] space-y-3">
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
                {failedElsewhere && (
                  <FailedReading canRetry={view.canDecide} busy={busy} onReread={onReread} />
                )}
              </div>
            )}

            {step === 'project' && <ProjectStep {...stepProps} client={participantsClient} />}
            {step === 'filing' && (
              <FilingStep {...stepProps} filing={filing}>
                {children}
              </FilingStep>
            )}
            {step === 'reading' && <ReadingStep {...stepProps} />}
            {step === 'questions' && <QuestionsStep {...stepProps} />}
            {step === 'profile' && <ProfileStep {...stepProps} onComplete={onComplete} />}
          </main>

          <SetupFooter
            step={step}
            progress={footer.progress}
            ownsPrimary={footer.ownsPrimary}
            slotRef={footer.slotRef}
            onNext={stepProps.onNext}
          />
        </div>
      </StepFooterProvider>
    </EvidenceProjectContext.Provider>
  )
}

/**
 * The reading did not finish. The alert says so above the step, keeps what
 * was found (the steps still show it), and carries the one way forward:
 * another reading of what is still unread.
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
