'use client'

import type { JSX } from 'react'
import { FolderUp } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { FileDropOverlay } from '@/features/documents/components/file-drop-overlay'
import { ProjectUppyUpload } from '@/features/documents/components/project-uppy-upload'
import { useFileDragDrop } from '@/features/documents/hooks/use-file-drag-drop'
import { useTranslations } from '@/i18n'

/**
 * Where a project folder is chosen: the project's folder pickers
 * (`ProjectUppyUpload` with folders) and, when `takeDrops` is set, a drop onto
 * the zone itself. Not a second way of uploading: whatever is chosen goes to
 * `onFiles`, which is the project's own upload, or (on the Ablage step) the
 * folder tree that is confirmed before the upload.
 *
 * Its own drop stops at the zone, so a folder let go here is the zone's even
 * on a page that takes a drop anywhere.
 */
export function IntakeUploadZone({
  projectId,
  onFiles,
  uploading,
  title,
  description,
  takeDrops = false,
}: {
  projectId: string
  onFiles: (files: File[]) => void
  uploading: boolean
  /** The zone's heading; the setup's „Projektordner hier ablegen" by default. */
  title?: string
  description?: string
  /** The zone takes a drop of its own. */
  takeDrops?: boolean
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: (files) => {
      if (files.length > 0) onFiles(files)
    },
    disabled: !takeDrops || uploading,
    acceptZip: true,
  })
  return (
    <div className="relative" {...dragHandlers}>
      {isDragging && (
        <FileDropOverlay
          isUnsupported={isUnsupportedDrag}
          uploadLabel={t('upload.dropOverlay')}
          unsupportedLabel={t('upload.unsupportedOverlay')}
          testId="intake-upload-zone-overlay"
        />
      )}
      <EmptyState
        icon={FolderUp}
        title={title ?? t('upload.title')}
        description={description ?? `${t('upload.description')} ${t('upload.hint')}`}
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
    </div>
  )
}
