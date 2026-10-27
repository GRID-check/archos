'use client'

import { useCallback } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { toFileItem } from '@/features/documents/lib/file-item'
import { documentNameLookupKey, resolveDocumentsByName } from '@/features/documents/lib/documents-by-name'
import type { RevisionRef } from '@/lib/documents/revision-links'
import { useChatStore } from '../store'
import { useOpenStoredFile } from './use-open-stored-file'

/**
 * Open the current Fassung of a cited document, beside the conversation.
 *
 * The citation's resolved row names the newer document by id and file name
 * (`revision.supersededBy`, already cut to what this reader may open). The peek
 * needs the whole row to show it, so the id is asked of the by-name resolve the
 * chips already use (one cached request per name) and the row is opened the way
 * a file reference opens one. A Fassung always lives on its predecessor's shelf,
 * so both of the shelves the resolve covers are searched for the id. A row that
 * is gone by now says so, and nothing else happens.
 */
export const useOpenCurrentRevision = (): ((current: RevisionRef) => Promise<void>) => {
  const t = useTranslations(chatCopy)
  const projectId = useChatStore((state) => state.projectId)
  const openFile = useOpenStoredFile()

  return useCallback(
    async (current: RevisionRef) => {
      const named = (await resolveDocumentsByName(projectId, [current.filename])).get(
        documentNameLookupKey(current.filename)
      )
      const projekt = named?.project.find((row) => row.id === current.id)
      const officeShelf = named?.officeShelf.find((row) => row.id === current.id)
      const row = projekt ?? officeShelf
      if (!row) {
        toast.error(t('citationPeek.currentRevisionUnavailable'))
        return
      }
      openFile({ file: toFileItem(row), corpus: projekt ? 'project' : 'office' })
    },
    [projectId, openFile, t]
  )
}
