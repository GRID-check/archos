'use client'

import type { JSX, ReactNode } from 'react'
import { FolderUp } from 'lucide-react'
import { FileDropOverlay } from '@/features/documents/components/file-drop-overlay'
import { useFileDragDrop } from '@/features/documents/hooks/use-file-drag-drop'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * Takes a folder let go on it, and only there: the drop stops at this element,
 * so on the Ablage a folder dropped here becomes the tree to confirm rather than
 * going straight to the page's own upload.
 */
export function FolderDropTarget({
  onFiles,
  disabled = false,
  className,
  children,
}: {
  onFiles: (files: File[]) => void
  disabled?: boolean
  className?: string
  children: ReactNode
}): JSX.Element {
  const t = useTranslations('intakeFilingStep')
  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: (files) => {
      if (files.length > 0) onFiles(files)
    },
    disabled,
    acceptZip: true,
  })
  return (
    <div className={cn('relative', className)} {...dragHandlers}>
      {isDragging && (
        <FileDropOverlay
          isUnsupported={isUnsupportedDrag}
          uploadLabel={t('choose.dropOverlay')}
          unsupportedLabel={t('choose.unsupportedOverlay')}
          testId="filing-drop-overlay"
        />
      )}
      {children}
    </div>
  )
}

/**
 * The Ablage before a folder is chosen: one calm, dashed area that takes the
 * project folder by drop or opens the folder picker on a click, and under it
 * the quiet way to pick single files instead.
 */
export function FolderDropArea({
  onFiles,
  onPickFolder,
  onPickFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void
  onPickFolder: () => void
  onPickFiles: () => void
  disabled: boolean
}): JSX.Element {
  const t = useTranslations('intakeFilingStep')
  return (
    <div className="space-y-4" data-testid="intake-upload-zone">
      <FolderDropTarget onFiles={onFiles} disabled={disabled}>
        <button
          type="button"
          onClick={onPickFolder}
          disabled={disabled}
          className="border-border bg-card hover:border-ring focus-visible:ring-ring/60 flex w-full flex-col items-center justify-center gap-3 rounded-[14px] border-2 border-dashed px-6 py-14 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60 md:py-20"
        >
          <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
            <FolderUp className="size-6" aria-hidden />
          </span>
          <span className="text-[15px] font-medium">{t('choose.title')}</span>
          <span className="text-muted-foreground max-w-md text-[13px]">{t('choose.description')}</span>
        </button>
      </FolderDropTarget>
      <p className="text-center">
        <button
          type="button"
          onClick={onPickFiles}
          disabled={disabled}
          className="text-muted-foreground hover:text-foreground touch-target text-[13px] underline underline-offset-[3px]"
        >
          {t('choose.pickFiles')}
        </button>
      </p>
    </div>
  )
}
