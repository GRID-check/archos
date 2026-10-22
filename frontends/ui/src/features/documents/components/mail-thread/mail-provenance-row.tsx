'use client'

/**
 * The provenance row under the preview's header (D36): for a document whose
 * Fassung in front of the reader came with a mail, which mail, how far its
 * sender was confirmed, and the way to the entry in its E-Mail-Verlauf.
 *
 * Under the header, not in it: the header is the same six controls on every
 * document (`file-preview-pane.tsx`), and a row that appears only for mail
 * attachments would make it change shape between files. A row of its own,
 * absent for every other document, keeps the header learnable.
 *
 * The facts are the version list's (`document-version-list`, each Fassung's
 * `mailOrigins`, only through threads the reader may read): the NEWEST
 * Fassung's mails, so a document a person later uploaded again does not
 * claim the mail that brought an earlier one. That Fassung's row in the
 * timeline says the rest. A failed read says nothing: provenance is a fact
 * the reader may want, never one the preview waits for.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { MailOriginView } from '@/lib/inbound-mail/inbound-mail-wire'
import { cn } from '@/lib/utils'
import { mailThreadClient, type MailThreadClient } from './client'
import { MailOriginLine, useOpenMailOrigin } from './mail-origin-line'

/** The mails that brought the newest Fassung, or none. */
export function newestFassungOrigins(versions: readonly { versionNumber: number; mailOrigins?: MailOriginView[] }[]): MailOriginView[] {
  const newest = versions.reduce<(typeof versions)[number] | null>(
    (best, version) => (best === null || version.versionNumber > best.versionNumber ? version : best),
    null,
  )
  return newest?.mailOrigins ?? []
}

export interface MailProvenanceRowProps {
  projectId: string
  documentId: string
  client?: MailThreadClient
  className?: string
}

export function MailProvenanceRow({ projectId, documentId, client = mailThreadClient, className }: MailProvenanceRowProps): JSX.Element | null {
  const [origins, setOrigins] = useState<MailOriginView[]>([])
  const open = useOpenMailOrigin(projectId, client)

  useEffect(() => {
    let alive = true
    setOrigins([])
    client
      .versions(documentId)
      .then((listing) => {
        if (alive) setOrigins(newestFassungOrigins(listing.versions))
      })
      .catch(() => {
        // Provenance is said when it can be read; a failed read leaves the row out.
      })
    return () => {
      alive = false
    }
  }, [client, documentId])

  if (origins.length === 0) return null
  return (
    <div className={cn('border-b px-3.5 py-2 @md:px-5', className)} data-testid="mail-provenance-row">
      <MailOriginLine origins={origins} onOpen={open} variant="row" />
    </div>
  )
}
