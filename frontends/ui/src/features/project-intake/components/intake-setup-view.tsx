'use client'

import type { JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft, Info, RefreshCw, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { Stepper } from '@/components/ui/stepper'
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
import { IntakeHeader } from './intake-header'
import { FilingStep } from './steps/filing-step'
import { ProfileStep } from './steps/profile-step'
import { ProjectStep } from './steps/project-step'
import { QuestionsStep } from './steps/questions-step'
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
  if (view.questions.length > 0) return 'questions'
  return 'profile'
}

/** The note under each step in the stepper, „23 gelesen", „3 offen": short, countable, or nothing. */
export function setupStepSummaries(view: IntakeView, tShell: Translator): SetupStepSummary[] {
  const { counts } = view
  const total = counts.documentsRead + counts.unreadDocuments
  const finished = view.status === 'completed'
  const readingNote = (): string | undefined => {
    if (view.status === 'reading') return tShell('notes.readOf', { read: counts.documentsRead, total })
    if (view.status === 'failed') return tShell('notes.failed')
    return counts.documentsRead > 0 ? tShell('notes.read', { count: counts.documentsRead }) : undefined
  }
  const profileNote = (): string | undefined => {
    if (finished) return tShell('notes.done')
    if (counts.contradictions > 0) return tShell('notes.contradictions', { count: counts.contradictions })
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
      note: view.questions.length > 0 ? tShell('notes.open', { count: view.questions.length }) : undefined,
      open: view.questions.length > 0,
    },
    {
      id: 'profile',
      note: profileNote(),
      open: !finished && (counts.contradictions > 0 || counts.suggested > 0),
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
}: IntakeSetupViewProps): JSX.Element {
  const tShell = useTranslations('intakeShell')
  const t = useTranslations('projectIntake')
  const finished = view.status === 'completed'
  const dropping = canUpload && !finished
  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: onFiles,
    disabled: !dropping,
    acceptZip: true,
  })
  useWindowDragGuard()
  const [step, go] = useSetupStep(view)
  const top = useRef<HTMLDivElement>(null)
  const shown = useRef(step)
  // To the top of the page whenever the step changes, by a click or by back
  // and forward; not on the first paint.
  useEffect(() => {
    if (shown.current === step) return
    shown.current = step
    top.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [step])

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
      <div
        ref={top}
        className="relative mx-auto w-full max-w-3xl scroll-mt-4 space-y-6 px-4 py-6 md:px-8 md:py-8"
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
            // The page runs far below the fold on the longer steps.
            followScroll
            testId="intake-drop-overlay"
          />
        )}

        <SetupHead projectId={projectId} projectName={projectName} />

        {/* Where the reading stands, on every step: it runs in the background
            while the person works, and reading again or adding a document is
            never more than one step away. The Ablage has its own upload while
            the project has no documents, so the header offers none there. */}
        <IntakeHeader
          view={view}
          projectId={projectId}
          busy={busy}
          uploading={uploading}
          canUpload={dropping && !(step === 'filing' && hasNoDocuments(view))}
          showStatus={step !== 'reading'}
          onReread={onReread}
          onFiles={onFiles}
        />

        <Stepper
          steps={summaries.map((summary) => ({ key: summary.id, label: tShell(`steps.${summary.id}`), note: summary.note }))}
          current={index}
          // Every step is open from the start: nothing in one blocks the next.
          furthest={SETUP_STEP_IDS.length - 1}
          onSelect={(selected) => go(SETUP_STEP_IDS[selected] ?? step)}
          label={tShell('steps.label')}
          progressLabel={tShell('steps.progress', { current: index + 1, total: SETUP_STEP_IDS.length })}
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
        {view.status === 'failed' && <FailedReading canRetry={view.canDecide} busy={busy} onReread={onReread} />}

        {step === 'project' && <ProjectStep {...stepProps} />}
        {step === 'filing' && (
          <FilingStep {...stepProps} filing={filing}>
            {children}
          </FilingStep>
        )}
        {step === 'reading' && <ReadingStep {...stepProps} />}
        {step === 'questions' && <QuestionsStep {...stepProps} />}
        {step === 'profile' && <ProfileStep {...stepProps} onComplete={onComplete} />}
      </div>
    </EvidenceProjectContext.Provider>
  )
}

/**
 * Where the person is, and the way out. The ticket lets a person leave while
 * Piloti reads, so leaving is a named control rather than the browser's back:
 * „Später fortsetzen" goes to the overview, which keeps the way back in.
 */
function SetupHead({ projectId, projectName }: { projectId: string; projectName?: string }): JSX.Element {
  const tShell = useTranslations('intakeShell')
  return (
    <div className="flex min-w-0 items-center justify-between gap-3" data-testid="intake-setup-head">
      <div className="min-w-0">
        <SectionLabel as="p">{tShell('head.eyebrow')}</SectionLabel>
        {projectName && <h2 className="truncate text-base font-semibold">{projectName}</h2>}
      </div>
      <Button asChild size="sm" variant="ghost" className="shrink-0">
        <Link href={`/app/projects/${encodeURIComponent(projectId)}/settings`} aria-label={tShell('head.laterAria')}>
          <ArrowLeft aria-hidden />
          {tShell('head.later')}
        </Link>
      </Button>
    </div>
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
