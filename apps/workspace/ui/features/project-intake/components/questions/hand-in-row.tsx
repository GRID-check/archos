'use client'

import type { JSX } from 'react'
import { useRef } from 'react'
import { FileUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DEFAULT_ACCEPTED_FILE_TYPES } from '@/features/documents/constants'
import { useFileDragDrop, type DropInfo } from '@/features/documents/hooks/use-file-drag-drop'
import { withZipAccepted } from '@/features/documents/lib/zip-types'
import { useTranslations } from '@/i18n'
import { intakeQuestionsStepCopy } from '@/i18n/namespaces/intake-questions-step'
import { cn } from '@/lib/utils'
import { useAppConfig } from '@/shared/context'

/**
 * The dashed row under a Rückfrage: where the answer usually stands, and the
 * place to hand that document in. Dropped or chosen, the files go through the
 * page's one upload and Piloti reads the answer out of them; `onHandedIn`
 * lets the round move on. On a phone the whole row is the button.
 */
export function HandInRow({
  where,
  label,
  onFiles,
  onHandedIn,
  disabled = false,
}: {
  /** The documents the answer is usually in, already joined („Einreichplan (Grundriss) oder Baubeschreibung"). */
  where: string | null
  /** The question it answers, for the button's name. */
  label: string
  onFiles: (files: File[], info?: DropInfo) => void
  onHandedIn?: () => void
  disabled?: boolean
}): JSX.Element {
  const t = useTranslations(intakeQuestionsStepCopy)
  const input = useRef<HTMLInputElement>(null)
  const accepted = withZipAccepted(useAppConfig().fileUpload?.acceptedTypes ?? DEFAULT_ACCEPTED_FILE_TYPES)
  const take = (files: File[], info?: DropInfo): void => {
    if (info) onFiles(files, info)
    else onFiles(files)
    onHandedIn?.()
  }
  const { isDragging, dragHandlers } = useFileDragDrop({ onDrop: take, disabled, acceptZip: true })
  const pick = (): void => input.current?.click()

  return (
    <div
      {...dragHandlers}
      data-testid="document-hand-in"
      data-dragging={isDragging || undefined}
      className={cn(
        'border-border bg-background/60 flex items-center gap-3 rounded-xl border-[1.5px] border-dashed px-4 py-3.5',
        'transition-colors duration-quick ease-out motion-reduce:transition-none',
        isDragging && 'border-primary bg-primary/5'
      )}
    >
      <FileUp className="text-muted-foreground size-[18px] shrink-0" aria-hidden />
      <p className="text-muted-foreground hidden min-w-0 flex-1 text-[13px] leading-snug md:block">
        {where ? (
          <>
            {t('handIn.where')} <span className="text-foreground font-medium">{where}</span>.{' '}
          </>
        ) : null}
        {t('handIn.drop')}
      </p>
      {/* On a phone the row is one 44px target: what to hand in, and where it stands. */}
      <button
        type="button"
        className="flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center text-left md:hidden"
        disabled={disabled}
        aria-label={t('handIn.pickAria', { label })}
        onClick={pick}
      >
        <span className="text-[15px] font-medium">{t('handIn.pick')}</span>
        {where && <span className="text-muted-foreground text-[13px]">{t('handIn.wherePhone', { where })}</span>}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={accepted}
        className="hidden"
        disabled={disabled}
        data-testid="document-hand-in-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length > 0) take(files)
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="hidden h-8 shrink-0 text-[13px] font-normal md:inline-flex"
        disabled={disabled}
        aria-label={t('handIn.pickAria', { label })}
        onClick={pick}
      >
        {t('handIn.pick')}
      </Button>
    </div>
  )
}
