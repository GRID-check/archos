'use client'

import { useEffect, useState } from 'react'
import { useDocumentsGeneration } from '@/lib/documents/document-changes'
import { useChatStore } from '../../store'
import { loadSourcePreviewIndex, type SourcePreviewIndex } from './source-preview-index'

/**
 * Resolution index for one cited document in the current project AND
 * conversation. Returns null until loaded (or while disabled); on any fetch
 * failure the lists degrade to empty, which downgrades chips to info/plain —
 * never a broken viewer.
 *
 * `fileName` is the name the citation resolves by (`citedFileName`); without
 * one no stored row is asked for, and only the base corpus and attachments
 * load.
 */
export const useSourcePreviewIndex = (
  projectId: string | null,
  conversationId: string | null,
  enabled: boolean,
  fileName: string | null
): SourcePreviewIndex | null => {
  const [index, setIndex] = useState<SourcePreviewIndex | null>(null)
  // Reload after a document was added, renamed or deleted. Dropping the cache
  // above invalidates the next MOUNT; this is what reaches the chips already on
  // screen, which for a rename or a delete is all of them.
  const generation = useDocumentsGeneration()

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    loadSourcePreviewIndex(projectId, conversationId, fileName)
      .then((loaded) => {
        if (!cancelled) setIndex(loaded)
      })
      .catch(() => {
        if (!cancelled) setIndex({ storedDocuments: [], baseCorpusFiles: [] })
      })
    return () => {
      cancelled = true
    }
  }, [projectId, conversationId, enabled, fileName, generation])

  return enabled ? index : null
}

/**
 * The conversation whose private attachments a citation may resolve against —
 * the thread the reader is in. A surface with no conversation (a standalone
 * report view) simply lists no `session` shelf.
 */
export const useConversationId = (): string | null =>
  useChatStore((s) => s.currentConversation?.id ?? null)
