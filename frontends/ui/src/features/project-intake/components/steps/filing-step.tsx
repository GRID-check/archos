'use client'

import type { JSX } from 'react'
import type { FilingFolderSuggestion } from '@/features/documents/lib/filing-suggestions'
import { FilingSection } from '../filing-section'
import { IntakeUploadZone } from '../intake-upload-zone'
import type { SetupStepProps, SetupStepSlots } from './types'

export interface FilingStepProps extends SetupStepProps, SetupStepSlots {
  /** Piloti's open filing suggestions, one per target folder; absent, none are drawn. */
  filing?: { entries: readonly FilingFolderSuggestion[]; onSettled: () => void }
}

/**
 * Step 2, Ablage (stub): the project folder in, curated per folder, with the
 * blacklist and the folder access for this project. Owned by the step-2 build.
 */
export function FilingStep({ view, projectId, canUpload, uploading, onFiles, filing, children }: FilingStepProps): JSX.Element {
  const noDocuments = view.counts.documentsRead + view.counts.unreadDocuments === 0
  return (
    <div className="space-y-8" data-testid="setup-step-filing">
      {noDocuments && canUpload && <IntakeUploadZone projectId={projectId} onFiles={onFiles} uploading={uploading} />}
      {filing && view.status !== 'completed' && <FilingSection entries={filing.entries} onSettled={filing.onSettled} />}
      {children}
    </div>
  )
}
