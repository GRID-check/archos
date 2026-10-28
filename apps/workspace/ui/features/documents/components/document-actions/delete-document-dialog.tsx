'use client'

/**
 * The one confirmation a document's delete asks, wherever it is started: the
 * actions menu, and the held block of the Files preview, where a reviewer
 * deletes a file the content check held back. The work is the hook's
 * (`useDocumentActions().remove`); this is only the question.
 */

import type { JSX } from 'react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTranslations } from '@/i18n'
import type { DocumentActions } from './use-document-actions'
import { DOCUMENT_SCOPE_COPY, type DocumentScope } from './document-scope'

export interface DeleteDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: DocumentScope
  actions: Pick<DocumentActions, 'name' | 'isDeleting' | 'remove'>
}

export function DeleteDocumentDialog({ open, onOpenChange, scope, actions }: DeleteDocumentDialogProps): JSX.Element {
  const t = useTranslations(DOCUMENT_SCOPE_COPY[scope])
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('delete.title', { name: actions.name })}
      description={t('delete.confirm')}
      confirmLabel={actions.isDeleting ? t('delete.deleting') : t('delete.confirmAction')}
      cancelLabel={t('delete.cancel')}
      pending={actions.isDeleting}
      confirmTestId="document-delete-confirm"
      onConfirm={async () => {
        if (await actions.remove()) onOpenChange(false)
      }}
    />
  )
}
