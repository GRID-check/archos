'use client'

import type { JSX } from 'react'
import { FolderUp } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { ProjectUppyUpload } from '@/features/documents/components/project-uppy-upload'
import { useTranslations } from '@/i18n'

/**
 * The drop zone of a project that has no documents yet: the whole page takes a
 * drop (`IntakeSetup`), this says so and offers the pickers. It is the project's
 * folder upload (`ProjectUppyUpload` with folders), aimed at the project's root,
 * not a second way of uploading.
 */
export function IntakeUploadZone({
  projectId,
  onFiles,
  uploading,
}: {
  projectId: string
  onFiles: (files: File[]) => void
  uploading: boolean
}): JSX.Element {
  const t = useTranslations('projectIntake')
  return (
    <EmptyState
      icon={FolderUp}
      title={t('upload.title')}
      description={`${t('upload.description')} ${t('upload.hint')}`}
      data-testid="intake-upload-zone"
      action={
        <ProjectUppyUpload
          projectId={projectId}
          onUpload={onFiles}
          isUploading={uploading}
          variant="default"
          size="default"
          allowFolders
        />
      }
    />
  )
}
