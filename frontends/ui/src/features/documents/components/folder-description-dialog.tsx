'use client'

/**
 * What belongs in a folder (migration 0145): the dialog a person writes it in,
 * and the line that shows it at the top of the folder.
 *
 * The description is the folder's, read by everyone who opens it and by Piloti
 * when it suggests where an upload belongs. Writing it is a write on the folder
 * (the server checks again); a reader who may only read sees the line and no
 * way to change it, and an undescribed folder shows them nothing.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { FOLDER_DESCRIPTION_MAX_LENGTH, normalizeFolderDescription } from '@/lib/projects/folders'
import type { FolderItem } from '../file-types'

export interface FolderDescriptionDialogProps {
  folder: FolderItem | null
  onOpenChange: (open: boolean) => void
  /** Save it (`null` clears it); whether it was saved. */
  onSave: (folderId: string, description: string | null) => Promise<boolean>
}

export function FolderDescriptionDialog({ folder, onOpenChange, onSave }: FolderDescriptionDialogProps): JSX.Element {
  const t = useTranslations(filesCopy)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const folderId = folder?.id ?? null
  const current = folder?.description ?? ''

  useEffect(() => {
    if (folderId) setText(current)
  }, [folderId, current])

  const normalized = normalizeFolderDescription(text)
  const tooLong = (normalized?.length ?? 0) > FOLDER_DESCRIPTION_MAX_LENGTH
  const unchanged = normalized === normalizeFolderDescription(current)

  const commit = async (): Promise<void> => {
    if (!folder || saving || tooLong || unchanged) return
    setSaving(true)
    const ok = await onSave(folder.id, normalized)
    setSaving(false)
    if (ok) onOpenChange(false)
  }

  return (
    <Dialog open={folder !== null} onOpenChange={(next) => (saving ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-md" showCloseButton={false} data-testid="folder-description-dialog">
        <DialogHeader>
          <DialogTitle>{t('folders.description.title', { name: folder?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('folders.description.hint')}</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          rows={3}
          value={text}
          disabled={saving}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void commit()
          }}
          placeholder={t('folders.description.placeholder')}
          aria-label={t('folders.description.label')}
          aria-invalid={tooLong || undefined}
          data-testid="folder-description-input"
        />
        <p className={tooLong ? 'text-destructive text-xs' : 'text-muted-foreground text-xs tabular-nums'}>
          {tooLong
            ? t('folders.description.tooLong', { max: FOLDER_DESCRIPTION_MAX_LENGTH })
            : t('folders.description.count', { count: normalized?.length ?? 0, max: FOLDER_DESCRIPTION_MAX_LENGTH })}
        </p>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('rename.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => void commit()}
            loading={saving}
            disabled={tooLong || unchanged}
            data-testid="folder-description-save"
          >
            {t('folders.description.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The folder's description, at the top of the folder: the text, and for a
 * writer the way to change it. A writer on an undescribed folder gets the
 * invitation to describe it; a reader on one gets nothing.
 */
export function FolderDescriptionLine({
  folder,
  canEdit,
  onEdit,
}: {
  folder: FolderItem
  canEdit: boolean
  onEdit: () => void
}): JSX.Element | null {
  const t = useTranslations(filesCopy)
  const description = folder.description ?? null
  if (!description && !canEdit) return null
  return (
    <div className="flex min-w-0 items-start gap-2" data-testid="folder-description-line">
      {description ? (
        <p className="text-muted-foreground min-w-0 flex-1 text-sm leading-relaxed">{description}</p>
      ) : (
        <span className="flex-1" />
      )}
      {canEdit && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground h-7 shrink-0 px-2"
          onClick={onEdit}
          data-testid="folder-description-edit"
        >
          <Pencil aria-hidden className="size-3.5" />
          {description ? t('folders.description.edit') : t('folders.description.empty')}
        </Button>
      )}
    </div>
  )
}
