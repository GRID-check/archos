'use client'

import type { JSX, ReactNode } from 'react'
import { Info, RefreshCw, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import {
  FileDropOverlay,
  useWindowDragGuard,
} from '@/features/documents/components/file-drop-overlay'
import { useFileDragDrop } from '@/features/documents/hooks/use-file-drag-drop'
import { useTranslations } from '@/i18n'
import type { IntakeDecision, IntakeView } from '@/lib/project-intake/types'
import { usePressed } from '../hooks/use-pressed'
import { CompleteFooter, CompletedNote } from './complete-footer'
import { ContradictionSection } from './contradiction-section'
import { DerivationSection } from './derivation-section'
import { EvidenceProjectContext } from './evidence-chips'
import { IntakeHeader } from './intake-header'
import { IntakeUploadZone } from './intake-upload-zone'
import { QuestionSection } from './question-section'
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
  onFiles: (files: File[]) => void
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
  onReread: () => void | Promise<void>
  onComplete: () => Promise<boolean>
  onRetry: () => void
  /** The upload's tray and plan dialog, which the connected page owns. */
  children?: ReactNode
}

/**
 * The setup page's body, drawn from the review it is given and calling back for
 * everything it does. Connected to the API in `IntakeSetup`; the `/dev` preview
 * draws it from fixtures.
 *
 * In order: the status and what a person may do, the drop zone while there are
 * no documents, Widersprüche, Rückfragen, Prüfen, Ableitungen, and the way to
 * finish. A folder dropped anywhere on the page is filed in the project.
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
  children,
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

  const noDocuments = view.counts.documentsRead + view.counts.unreadDocuments === 0
  const reviewing = view.status !== 'waiting' || !noDocuments
  // One upload control while the page has no documents: the empty state's.
  const showUploadZone = noDocuments && view.status === 'waiting' && dropping
  const decideProps = { canDecide: view.canDecide && !finished, busy, onDecide }

  return (
    <EvidenceProjectContext.Provider value={projectId}>
      <div
        className="relative mx-auto w-full max-w-5xl space-y-8 px-4 py-8 md:px-8"
        data-testid="intake-setup"
        data-status={view.status}
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

        <IntakeHeader
          view={view}
          projectId={projectId}
          busy={busy}
          uploading={uploading}
          canUpload={dropping && !showUploadZone}
          onReread={onReread}
          onFiles={onFiles}
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
        {view.status === 'failed' && (
          <FailedReading canRetry={view.canDecide} busy={busy} onReread={onReread} />
        )}
        {!view.canDecide && !finished && (
          <Alert role="status">
            <Info aria-hidden />
            <AlertDescription>{t('header.readOnly')}</AlertDescription>
          </Alert>
        )}

        {finished && <CompletedNote view={view} />}

        {showUploadZone && (
          <IntakeUploadZone projectId={projectId} onFiles={onFiles} uploading={uploading} />
        )}

        <ContradictionSection items={view.contradictions} {...decideProps} />
        <QuestionSection questions={view.questions} {...decideProps} onFiles={onFiles} />
        {reviewing && <ReviewSection groups={view.groups} {...decideProps} />}
        <DerivationSection derivations={view.derivations} {...decideProps} />
        {view.status === 'reading' && <ReadingSkeleton />}
        <CompleteFooter view={view} busy={busy} onComplete={onComplete} />
        {children}
      </div>
    </EvidenceProjectContext.Provider>
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
