'use client'

/**
 * What a filed part became, said where the part stands (the owner's review,
 * 2026-10-27, WOW §3.6): „Abgelegt in Tragwerk · Fassung 3 · Öffnen“ for an
 * attachment, „In E-Mail-Verlauf „Stellplatznachweis“ · Fassung 7 · Öffnen“
 * for the text. The Fassung number is the proof the mechanism did the right
 * thing, so it is named. The place comes from the part's `filedAs`, which the
 * server fills only for a document the viewer may read; without it the line
 * says only that the part was filed, never where (RT-S13).
 *
 * „Öffnen“ is the way on from a filing: there is no undo, the document is the
 * project's now. Its use is counted, so we can tell whether people check
 * where things went.
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { CheckCircle2, Repeat2 } from 'lucide-react'
import { documentFilesHref } from '@/features/documents/lib/document-question'
import { useTranslations } from '@/i18n'
import { capturePosthog } from '@/lib/analytics/posthog'
import type { InboundMailPartView } from '@/lib/inbound-mail/inbound-mail-wire'
import { filedPlace } from '../lib/filed'
import { FactLine } from './inbound-mail-atoms'

export function FiledTo({
  projectId,
  part,
  followed = false,
}: {
  projectId: string
  part: Pick<InboundMailPartView, 'kind' | 'documentId' | 'filedAs'>
  /** The text was appended by a follow, not by a person's press here. */
  followed?: boolean
}): JSX.Element {
  const t = useTranslations('inboundMail')
  const place = filedPlace(part, t('suggestion.root'))
  const words = (() => {
    if (part.kind === 'message') {
      if (!place) return followed ? t('message.followed') : t('message.filed')
      return followed ? t('message.followedTo', { name: place.name }) : t('message.filedTo', { name: place.name })
    }
    return place ? t('attachments.status.filedTo', { folder: place.folder }) : t('attachments.status.filed')
  })()
  return (
    <FactLine icon={followed ? Repeat2 : CheckCircle2} tone="default" testId={part.kind === 'message' ? 'message-filed' : 'status-filed'}>
      {words}
      {place?.version != null && ` · ${t('attachments.status.version', { version: place.version })}`}
      {part.documentId && (
        <>
          {' · '}
          <Link
            className="underline-offset-2 hover:underline"
            href={documentFilesHref(projectId, part.documentId)}
            onClick={() => capturePosthog('inbound_mail_filed_outcome_opened', { kind: part.kind })}
          >
            {t('attachments.open')}
          </Link>
        </>
      )}
    </FactLine>
  )
}
