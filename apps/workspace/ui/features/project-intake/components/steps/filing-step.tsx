'use client'

import type { JSX } from 'react'
import { useRef, useState } from 'react'
import { FolderUp, Upload } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ProjectUppyUpload } from '@/features/documents/components/project-uppy-upload'
import { isFolderUpload } from '@/features/documents/lib/folder-upload-plan'
import type { FilingFolderSuggestion } from '@/features/documents/lib/filing-suggestions'
import { useLocale, useTranslations, type Translator } from '@/i18n'
import { intakeFilingStepCopy } from '@/i18n/namespaces/intake-filing-step'
import { formatBytes } from '@/lib/format'
import { FilingSection } from '../filing-section'
import { ASIDE_ACTION_CLASS, PRIMARY_ACTION_CLASS, StepFooter } from '../setup-frame'
import { AccessSummary, accessRows } from '../filing/access-panel'
import type { ExclusionReason } from '../filing/default-exclusions'
import { filingSetupClient, type FilingSetupClient } from '../filing/filing-client'
import { FilingCard, FilingHead } from '../filing/filing-atoms'
import { FolderChoiceTree } from '../filing/folder-choice-tree'
import { FolderDropArea } from '../filing/folder-drop-area'
import { accessFolders, isFolderExcluded } from '../filing/folder-tree'
import { ProjectFoldersCard } from '../filing/project-folders-card'
import { ScreeningSummary } from '../filing/screening-panel'
import { useFilingSetup, type FilingChoice } from '../filing/use-filing-setup'
import type { SetupStepProps, SetupStepSlots } from './types'

export interface FilingStepProps extends SetupStepProps, SetupStepSlots {
  /** Piloti's open filing suggestions, one per target folder; absent, none are drawn. */
  filing?: { entries: readonly FilingFolderSuggestion[]; onSettled: () => void }
  /** What the step reads and writes; the real API unless the preview or a spec brings its own. */
  client?: FilingSetupClient
  /** A folder choice to open on, for the `/dev` preview. */
  initialChoice?: readonly File[]
}

/** What the body shows: the drop area, the tree, the upload on its way, or what is in the project. */
type Mode = 'empty' | 'chosen' | 'uploading' | 'project'

/** „30,4 MB · Sicherungen und Zwischenstände ausgelassen": what the choice leaves out, by Piloti's reasons when they are all there is. */
function leftOut(choice: FilingChoice, t: Translator, locale: string): string {
  const size = formatBytes(choice.summary.size, locale)
  if (choice.excluded.size === 0) return t('summary.allIn', { size })
  const reasons = [...choice.excluded].map((path) => choice.proposed.get(path))
  if (reasons.some((reason) => reason === undefined)) {
    return t('summary.left', { size, what: t('summary.leftFolders', { count: choice.excluded.size }) })
  }
  const kinds = [...new Set(reasons as ExclusionReason[])].map((reason) => t(`summary.reasons.${reason}`))
  const what = new Intl.ListFormat(locale, { type: 'conjunction' }).format(kinds)
  return t('summary.left', { size, what })
}

/**
 * Step 2, Ablage (ticket 26), drawn to the approved mockup (`Ablage.dc.html`).
 *
 * 1. Before a folder is chosen, one calm drop area; the footer's primary
 *    action opens the folder picker. Loose files, picked rather than a folder,
 *    go straight to the upload: there is no tree to confirm.
 * 2. A chosen folder is a card of folders, each switched in or out with its
 *    whole subtree, backups and old states proposed out
 *    (`default-exclusions.ts`). Beside it one summary card: what Piloti reads,
 *    what the office's sensitive-data list keeps on the server (its project
 *    terms in a sheet, ADR-0086), and who opens which folder (its folders in a
 *    sheet, ADR-0088, ADR-0097). The footer's „N Dateien hochladen" hands only
 *    the chosen files to the project's own upload (`onFiles`), whose plan
 *    dialog and tray are the frame's children.
 * 3. While they upload, the step says so and shows the tray.
 * 4. With documents in the project, its folders and the same summary; the
 *    footer goes on to the Erfassung. Piloti's open filing suggestions stay.
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
  const t = useTranslations(intakeFilingStepCopy)
  const { locale } = useLocale()
  const setup = useFilingSetup({ projectId, client, initialChoice })
  const [sent, setSent] = useState(false)
  const pickFolder = useRef<(() => void) | null>(null)
  const pickFiles = useRef<(() => void) | null>(null)
  const finished = view.status === 'completed'
  const documents = view.counts.documentsRead + view.counts.unreadDocuments
  const taking = canUpload && !finished
  const { choice } = setup
  const mode: Mode = choice ? 'chosen' : uploading ? 'uploading' : documents === 0 && taking ? 'empty' : 'project'

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
  // The folders the choice would create, without the ones switched out.
  const chosenTop = choice ? accessFolders(choice.tree).filter((node) => !isFolderExcluded(choice.excluded, node.path)) : []
  const rows = accessRows(setup.folders, chosenTop)
  const skip = onNext && (
    <button type="button" className={ASIDE_ACTION_CLASS} onClick={onNext}>
      {t('actions.skip')}
    </button>
  )

  const summary = (
    <FilingCard aria-label={t('summary.label')} data-testid="filing-summary-card">
      {choice && (
        <div className="px-[18px] py-4">
          <p className="text-muted-foreground text-xs">{t('summary.reads')}</p>
          <p className="mt-0.5 text-[28px] font-medium leading-tight tracking-tight tabular-nums">
            {t('summary.files', { count: choice.summary.files })}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs" data-testid="filing-summary">
            {leftOut(choice, t, locale)}
          </p>
        </div>
      )}
      {(taking || choice) && (
        <ScreeningSummary
          screening={setup.screening}
          loadFailed={setup.screeningFailed}
          onRetry={setup.retryScreening}
          preview={setup.preview}
          draft={setup.draft}
          onDraftChange={setup.setDraft}
          onSave={setup.saveScreening}
        />
      )}
      <AccessSummary
        projectId={projectId}
        rows={rows}
        canManage={canManage && !finished}
        loadFailed={setup.foldersFailed}
        ensureFolder={(path) => client.ensureFolder(projectId, path)}
        onChanged={setup.reloadFolders}
      />
    </FilingCard>
  )

  return (
    <div className="pb-4" data-testid="setup-step-filing">
      {/* The project's own pickers, without a trigger of their own: the drop
          area, the footer and the folder card open them. */}
      <div hidden>
        <ProjectUppyUpload
          projectId={projectId}
          onUpload={choose}
          isUploading={uploading}
          allowFolders
          pickFolderRef={pickFolder}
          pickFilesRef={pickFiles}
        />
      </div>

      {mode === 'empty' && (
        <div className="mx-auto w-full max-w-[640px] space-y-6">
          <FilingHead title={t('head.title')}>{t('head.choose')}</FilingHead>
          {sent && (
            <p className="text-muted-foreground text-sm" role="status" data-testid="filing-sent">
              {t('choose.sent')}
            </p>
          )}
          <FolderDropArea
            onFiles={choose}
            onPickFolder={() => pickFolder.current?.()}
            onPickFiles={() => pickFiles.current?.()}
            disabled={uploading}
          />
          <StepFooter
            primary={
              <Button type="button" className={PRIMARY_ACTION_CLASS} onClick={() => pickFolder.current?.()}>
                <FolderUp aria-hidden />
                {t('choose.pickFolder')}
              </Button>
            }
            aside={skip}
          />
        </div>
      )}

      {mode === 'chosen' && choice && (
        <div className="mx-auto w-full max-w-[1040px] space-y-6">
          <FilingHead title={t('head.title')}>
            {t('head.chosen', {
              name: choice.tree.root.children.length === 1 ? (choice.tree.root.children[0]?.name ?? '') : t('tree.allChosen'),
              count: choice.summary.totalFiles,
            })}{' '}
            <Button type="button" variant="inline" className="text-muted-foreground" onClick={setup.discard}>
              {t('head.other')}
            </Button>
          </FilingHead>
          <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_320px] md:gap-6">
            <FolderChoiceTree
              tree={choice.tree}
              excluded={choice.excluded}
              proposed={choice.proposed}
              heldIn={setup.preview?.heldIn ?? new Map()}
              summary={choice.summary}
              onToggle={setup.toggle}
            />
            {summary}
          </div>
          <StepFooter
            primary={
              <BusyButton
                type="button"
                className={PRIMARY_ACTION_CLASS}
                icon={<Upload aria-hidden />}
                busy={uploading}
                // The browser screens names with the project's list before
                // anything leaves; without it nothing could be sent anyway.
                blocked={!setup.screening || choice.summary.files === 0}
                busyLabel={t('actions.uploading')}
                onClick={upload}
              >
                {choice.summary.files === 0 ? t('actions.nothing') : t('actions.upload', { count: choice.summary.files })}
              </BusyButton>
            }
            aside={skip}
          />
        </div>
      )}

      {mode === 'uploading' && (
        <div className="mx-auto w-full max-w-[640px] space-y-6" data-testid="filing-uploading">
          <FilingHead title={t('head.uploadingTitle')}>{t('head.uploading')}</FilingHead>
          {!children && (
            <FilingCard className="flex items-center gap-3 px-[18px] py-4 text-sm">
              <Spinner size="sm" />
              {t('actions.uploading')}
            </FilingCard>
          )}
          <StepFooter
            primary={
              <BusyButton type="button" className={PRIMARY_ACTION_CLASS} busy busyLabel={t('actions.uploading')}>
                {t('actions.uploading')}
              </BusyButton>
            }
          />
        </div>
      )}

      {mode === 'project' && (
        <div className="mx-auto w-full max-w-[1040px] space-y-6">
          <FilingHead title={t('head.inProjectTitle')}>
            {taking ? t('head.inProject', { count: documents }) : t('head.closed')}
          </FilingHead>
          <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_320px] md:gap-6">
            <ProjectFoldersCard
              rows={rows}
              documents={documents}
              onAddMore={taking ? () => pickFolder.current?.() : undefined}
              onFiles={choose}
            />
            {summary}
          </div>
          {filing && !finished && <FilingSection entries={filing.entries} onSettled={filing.onSettled} />}
        </div>
      )}

      {children && <div className="mx-auto mt-6 w-full max-w-[1040px]">{children}</div>}
    </div>
  )
}
