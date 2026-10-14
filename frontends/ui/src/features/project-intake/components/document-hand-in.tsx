'use client'

import type { JSX } from 'react'
import { useId, useRef } from 'react'
import { FilePlus2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useFileDragDrop } from '@/features/documents/hooks/use-file-drag-drop'
import { DEFAULT_ACCEPTED_FILE_TYPES } from '@/features/documents/constants'
import { withZipAccepted } from '@/features/documents/lib/zip-types'
import { useTranslations } from '@/i18n'
import { useAppConfig } from '@/shared/context'
import { cn } from '@/lib/utils'

/**
 * „Dokument nachreichen": a small drop target on a Rückfrage. The question
 * names the document that would answer it (`foundIn`); dropping a file here, or
 * choosing one, files it through the page's one upload and Piloti reads it. The
 * question closes when the value is found, which the page notices when it
 * polls, so this only hands the files over.
 */
export function DocumentHandIn({
  label,
  onFiles,
  disabled = false,
}: {
  /** The question this answers, for the choose button's name. */
  label: string
  onFiles: (files: File[]) => void
  disabled?: boolean
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const inputId = useId()
  const input = useRef<HTMLInputElement>(null)
  const accepted = withZipAccepted(useAppConfig().fileUpload?.acceptedTypes ?? DEFAULT_ACCEPTED_FILE_TYPES)
  const { isDragging, dragHandlers } = useFileDragDrop({ onDrop: onFiles, disabled, acceptZip: true })

  return (
    <div
      {...dragHandlers}
      data-testid="document-hand-in"
      data-dragging={isDragging || undefined}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed px-3.5 py-2.5 transition-colors duration-quick ease-out motion-reduce:transition-none',
        isDragging ? 'border-ring bg-primary/5' : 'border-border bg-muted/25'
      )}
    >
      <FilePlus2 className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t('questions.dropTitle')}</p>
        <p className="text-muted-foreground text-xs">{t('questions.dropHint')}</p>
      </div>
      <input
        ref={input}
        id={inputId}
        type="file"
        multiple
        accept={accepted}
        className="hidden"
        disabled={disabled}
        data-testid="document-hand-in-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length > 0) onFiles(files)
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-label={t('questions.pickAria', { label })}
        onClick={() => input.current?.click()}
      >
        {t('questions.pick')}
      </Button>
    </div>
  )
}
