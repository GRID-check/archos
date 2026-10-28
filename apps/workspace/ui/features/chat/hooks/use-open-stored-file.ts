'use client'

import { useCallback } from 'react'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { openFilePeek } from '@/features/documents/lib/open-file-peek'
import { isCitable } from '@/features/documents/components/document-status'
import type { StoredFile } from '@/features/documents/hooks/use-surfaced-documents'
import { useChatStore } from '../store'

/** Open a stored file beside the conversation — or over it, where there is no beside. */
export const useOpenStoredFile = (): ((stored: StoredFile) => void) => {
  const projectId = useChatStore((state) => state.projectId)
  const isMobile = useIsMobile()

  return useCallback(
    (stored: StoredFile) => {
      openFilePeek({
        file: stored.file,
        source: stored.corpus === 'office' ? 'office' : stored.corpus === 'session' ? 'session' : 'project',
        projectId,
        presentation: isMobile ? 'modal' : 'peek',
        // Every other door into this pane binds the subject, and the reader
        // pointing at a filename in a sentence has said which document they
        // mean at least as clearly as clicking a card does. Hide keeps the
        // bar, close drops it — the rule stated in `open-file-peek`, unchanged
        // and not special-cased here.
        //
        // Except when the document cannot answer. `isCitable` is the same
        // predicate the preview pane greys its Ask button on, and binding a
        // never-indexed or failed row would promise a retrieval that cannot
        // happen — the argument `open-filed-document` already makes for the
        // reports Piloti writes. The document still OPENS; the hover peek has
        // said in words why it cannot be asked about, so the composer staying
        // where it was agrees with what the reader was just told.
        bindComposerSubject: isCitable(stored.file),
      })
    },
    [projectId, isMobile]
  )
}
