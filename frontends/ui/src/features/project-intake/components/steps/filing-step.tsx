'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import { ArrowRight, Upload } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { isFolderUpload } from '@/features/documents/lib/folder-upload-plan'
import type { FilingFolderSuggestion } from '@/features/documents/lib/filing-suggestions'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes } from '@/lib/format'
import { FilingSection } from '../filing-section'
import { IntakeSection } from '../intake-atoms'
import { IntakeUploadZone } from '../intake-upload-zone'
import { AccessPanel, accessRows } from '../filing/access-panel'
import { filingSetupClient, type FilingSetupClient } from '../filing/filing-client'
import { FolderChoiceTree } from '../filing/folder-choice-tree'
import { accessFolders } from '../filing/folder-tree'
import { ScreeningPanel } from '../filing/screening-panel'
import { useFilingSetup } from '../filing/use-filing-setup'
import type { SetupStepProps, SetupStepSlots } from './types'

export interface FilingStepProps extends SetupStepProps, SetupStepSlots {
  /** Piloti's open filing suggestions, one per target folder; absent, none are drawn. */
  filing?: { entries: readonly FilingFolderSuggestion[]; onSettled: () => void }
  /** What the step reads and writes; the real API unless the preview or a spec brings its own. */
  client?: FilingSetupClient
  /** A folder choice to open on, for the `/dev` preview. */
  initialChoice?: readonly File[]
}

/**
 * Step 2, Ablage (ticket 26): the project folder in, curated per folder.
 *
 * 1. The person chooses the project folder. Before a byte is sent it is a tree:
 *    folders with their files and size, each switched in or out with its whole
 *    subtree, backups and old states proposed out (`default-exclusions.ts`).
 * 2. Beside it, what the office's sensitive-data list holds back of the choice
 *    and why, and (for whoever manages the project) that list changed for this
 *    project only (ADR-0086, 2026-10-20).
 * 3. Who may open which top folder, with the way to restrict one, before its
 *    files arrive if it is new (ADR-0088, ADR-0097).
 * 4. „Hochladen" hands only the chosen files to the project's own upload
 *    (`onFiles`), whose plan dialog and tray are the frame's children.
 * 5. Piloti's open filing suggestions stay here after the upload.
 *
 * Loose files, picked rather than a folder, go straight to the upload: there is
 * no tree to confirm.
 */
export function FilingStep({
  view,
  projectId,
  canUpload,
  uploading,
  onFiles,
  onNext,
  filing,
  children,
  client = filingSetupClient,
  initialChoice,
}: FilingStepProps): JSX.Element {
  const t = useTranslations('intakeFilingStep')
  const { locale } = useLocale()
  const setup = useFilingSetup({ projectId, client, initialChoice })
  const [sent, setSent] = useState(false)
  const finished = view.status === 'completed'
  const noDocuments = view.counts.documentsRead + view.counts.unreadDocuments === 0
  const taking = canUpload && !finished
  const { choice } = setup

  const choose = (files: File[]): void => {
    setSent(false)
    if (!isFolderUpload(files)) {
      onFiles(files)
      return
    }
    setup.choose(files)
  }

  const upload = (): void => {
    const files = setup.filesToSend()
    if (files.length === 0) return
    onFiles(files)
    setup.discard()
    setSent(true)
  }

  const canManage = setup.screening?.canManage ?? false
  const rows = accessRows(setup.folders, choice ? accessFolders(choice.tree) : [])

  return (
    <div className="space-y-8" data-testid="setup-step-filing">
      {taking && !choice && (
        <IntakeUploadZone
          projectId={projectId}
          onFiles={choose}
          uploading={uploading}
          takeDrops
          title={noDocuments ? t('choose.title') : t('choose.addMore')}
          description={`${t('choose.description')} ${t('choose.hint')}`}
        />
      )}
      {sent && !choice && (
        <p className="text-muted-foreground text-sm" role="status" data-testid="filing-sent">
          {t('actions.sent')}
        </p>
      )}

      {choice && (
        <IntakeSection label={t('tree.heading')} description={t('tree.description')} testId="filing-choice">
          {choice.proposed.size > 0 && (
            <Alert role="status">
              <AlertDescription>{t('tree.proposed', { count: choice.proposed.size })}</AlertDescription>
            </Alert>
          )}
          <FolderChoiceTree
            tree={choice.tree}
            excluded={choice.excluded}
            proposed={choice.proposed}
            heldIn={setup.preview?.heldIn ?? new Map()}
            onToggle={setup.toggle}
          />
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-muted-foreground mr-auto text-sm" data-testid="filing-summary">
              {t('tree.summary', {
                files: choice.summary.files,
                total: choice.summary.totalFiles,
                size: formatBytes(choice.summary.size, locale),
              })}
            </p>
            <Button type="button" variant="ghost" onClick={setup.discard}>
              {t('actions.discard')}
            </Button>
            {choice.summary.files === 0 ? (
              <p className="text-muted-foreground text-sm">{t('actions.nothing')}</p>
            ) : (
              <BusyButton
                type="button"
                icon={<Upload aria-hidden />}
                busy={uploading}
                // The browser screens names with the project's list before
                // anything leaves; without it nothing could be sent anyway.
                blocked={!setup.screening}
                busyLabel={t('actions.uploading')}
                onClick={upload}
              >
                {t('actions.upload', { count: choice.summary.files })}
              </BusyButton>
            )}
          </div>
        </IntakeSection>
      )}

      {taking && (
        <ScreeningPanel
          screening={setup.screening}
          loadFailed={setup.screeningFailed}
          onRetry={setup.retryScreening}
          preview={setup.preview}
          draft={setup.draft}
          onDraftChange={setup.setDraft}
          onSave={setup.saveScreening}
        />
      )}

      {!finished && (
        <AccessPanel
          projectId={projectId}
          rows={rows}
          canManage={canManage}
          loadFailed={setup.foldersFailed}
          ensureFolder={(path) => client.ensureFolder(projectId, path)}
          onChanged={setup.reloadFolders}
        />
      )}

      {filing && !finished && <FilingSection entries={filing.entries} onSettled={filing.onSettled} />}
      {children}

      {onNext && (
        <nav className="border-border flex flex-wrap items-center justify-end gap-3 border-t pt-5" data-testid="filing-step-nav">
          {view.status === 'reading' && <p className="text-muted-foreground hidden text-xs sm:block">{t('next.hint')}</p>}
          <Button type="button" onClick={onNext}>
            {t('next.label')}
            <ArrowRight aria-hidden />
          </Button>
        </nav>
      )}
    </div>
  )
}
