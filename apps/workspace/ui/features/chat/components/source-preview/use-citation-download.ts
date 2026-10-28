'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { startDocumentDownload } from '@/lib/documents/download'
import type { DownloadTarget } from './document-target'

/**
 * Hand a resolved-but-unrenderable document to the reader as a file.
 *
 * The mechanics are shared with the Files workspace (`lib/documents/download.ts`);
 * this hook adds only the pending state and how a failure reads in a chat — a
 * toast, where the Files pane shows an inline line.
 *
 * The target is nullable because the caller learns whether there IS one only
 * after resolution, and a hook cannot be called conditionally. A null target
 * yields a `download` that does nothing, which no caller renders a control for.
 */
export const useCitationDownload = (
  target: DownloadTarget | null
): { isDownloading: boolean; download: () => Promise<void> } => {
  const t = useTranslations(chatCopy)
  const [isDownloading, setIsDownloading] = useState(false)

  const download = async (): Promise<void> => {
    if (!target) return
    setIsDownloading(true)
    try {
      if (!(await startDocumentDownload(target.document.id, target.fileName))) {
        toast.error(t('sourcePreview.loadFailed'))
      }
    } finally {
      setIsDownloading(false)
    }
  }

  return { isDownloading, download }
}
