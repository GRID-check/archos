'use client'

import type { JSX, ReactNode } from 'react'
import { Info, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FileDropOverlay, useWindowDragGuard } from '@/features/documents/components/file-drop-overlay'
import { useFileDragDrop } from '@/features/documents/hooks/use-file-drag-drop'
import { useTranslations } from '@/i18n'
import type { IntakeDecision, IntakeView } from '@/lib/project-intake/types'
import { CompleteFooter } from './complete-footer'
import { ContradictionSection } from './contradiction-section'
import { DerivationSection } from './derivation-section'
import { IntakeHeader } from './intake-header'
import { IntakeUploadZone } from './intake-upload-zone'
import { QuestionSection } from './question-section'
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
  onReread: () => void
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
  const decideProps = { canDecide: view.canDecide && !finished, busy, onDecide }

  return (
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
        canUpload={dropping}
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
        <Alert variant="warning" role="status">
          <TriangleAlert aria-hidden />
          <AlertDescription className="text-current">{t('header.failed')}</AlertDescription>
        </Alert>
      )}
      {!view.canDecide && !finished && (
        <Alert role="status">
          <Info aria-hidden />
          <AlertDescription>{t('header.readOnly')}</AlertDescription>
        </Alert>
      )}

      {noDocuments && view.status === 'waiting' && dropping && (
        <IntakeUploadZone projectId={projectId} onFiles={onFiles} uploading={uploading} />
      )}

      <ContradictionSection items={view.contradictions} {...decideProps} />
      <QuestionSection questions={view.questions} {...decideProps} onFiles={onFiles} />
      {reviewing && <ReviewSection groups={view.groups} {...decideProps} />}
      <DerivationSection derivations={view.derivations} groups={view.groups} {...decideProps} />
      <CompleteFooter view={view} busy={busy} onComplete={onComplete} />
      {children}
    </div>
  )
}
