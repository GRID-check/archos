'use client'

/**
 * Whether the document in the preview is an E-Mail-Verlauf, and which: the
 * thread the „E-Mails“ tab shows, or null.
 *
 * Asked only of a document that can be one. A thread document is a Markdown
 * file (`threadDocumentFilename`) with the Dokumentart *Korrespondenz*
 * (`correspondence`); the Dokumentart is ingestion's and arrives late, so the
 * `.md` name alone is enough to ask. Every other preview asks nothing. The
 * answer is `mail-thread-list` with `documentId`, which also says no for a
 * thread the reader may not see and for an office without the feature (its
 * 404 reads as „no thread“, never as an error on a preview that has nothing
 * to do with mail).
 */

import { useEffect, useState } from 'react'
import { documentTypeOf } from '@/lib/documents/tag-vocabulary'
import type { MailThreadSummaryView } from '@/lib/mail-thread/mail-thread-wire'
import type { MailThreadClient } from './client'

/** Whether a document could be a thread document, judged by what the listing already carries. */
export function mayBeThreadDocument(file: { filename: string; tags?: readonly string[] | null }): boolean {
  return documentTypeOf(file.tags) === 'correspondence' || /\.md$/i.test(file.filename)
}

export function useMailThreadOfDocument(
  projectId: string | undefined,
  file: { id: string; filename: string; tags?: readonly string[] | null },
  client: Pick<MailThreadClient, 'ofDocument'>,
): MailThreadSummaryView | null {
  const [thread, setThread] = useState<MailThreadSummaryView | null>(null)
  const candidate = projectId !== undefined && mayBeThreadDocument(file)

  useEffect(() => {
    setThread(null)
    if (!candidate || !projectId) return
    const controller = new AbortController()
    client
      .ofDocument(projectId, file.id, controller.signal)
      .then((found) => {
        if (!controller.signal.aborted) setThread(found)
      })
      .catch(() => {
        // No thread, no tab.
      })
    return () => controller.abort()
  }, [candidate, client, file.id, projectId])

  return thread
}
