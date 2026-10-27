'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import type { ActionMenuEntry } from '@/components/ui/action-menu'
import { askAboutFile } from '@/features/documents/lib/ask-about-file'
import { fileItemFromStatus } from '@/features/documents/lib/document-question'
import { useTranslations } from '@/i18n'
import type { DocumentHit } from '@/lib/search/search-wire'
import { documentHitActionEntries } from '../lib/hit-actions'
import { documentHitHref, documentReviewHitHref } from '../lib/search-hrefs'
import { useSearchReturn } from './use-search-return'

/**
 * The newer Fassung of a superseded document, as this reader may open it:
 * `GET /api/documents/[id]/status` resolves `revision.supersededBy` for the
 * reader (operation `document-status`), so a Fassung they may not open is not
 * named. Asked when the item is chosen, never per row: the hit carries only
 * that a newer Fassung exists. `null` when there is none the reader may open.
 */
export async function currentRevisionId(documentId: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(`/api/documents/${encodeURIComponent(documentId)}/status`)
    if (!response.ok) return null
    const body = (await response.json()) as { revision?: { supersededBy?: { id?: unknown } | null } | null }
    const id = body.revision?.supersededBy?.id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/**
 * A document hit's menu entries, wired: Piloti fragen through the product's
 * one ask (`askAboutFile`, which carries the file into the chat as its
 * subject and its peek), at the passage's page when the hit was found by one;
 * the current Fassung; the open points in the document's Prüfansicht, from
 * which closing comes back to this search.
 */
export function useDocumentHitActions(hit: DocumentHit): ActionMenuEntry[] {
  const t = useTranslations('search.hitActions')
  const router = useRouter()
  const from = useSearchReturn()
  return useMemo(() => {
    const name = hit.title ?? hit.name
    return documentHitActionEntries(
      hit,
      { ask: t('ask'), openCurrent: t('openCurrent'), openPoints: t('openPoints') },
      {
        onAsk: () => {
          if (!hit.projectId) return
          const page = hit.passage?.page ?? null
          askAboutFile({
            projectId: hit.projectId,
            file: fileItemFromStatus({
              id: hit.id,
              filename: hit.filename,
              displayName: hit.name,
              contentType: hit.contentType,
              status: hit.status,
              createdAt: hit.uploadedAt,
              pageCount: hit.pageCount,
            }),
            ask: page !== null ? t('askAtPage', { page, name }) : undefined,
            navigate: (href) => router.push(href),
          })
        },
        onOpenCurrent: () => {
          void currentRevisionId(hit.id).then((current) => {
            if (!current) {
              toast.error(t('currentUnavailable'))
              return
            }
            // A Fassung lives on its predecessor's shelf.
            router.push(documentHitHref({ id: current, shelf: hit.shelf, projectId: hit.projectId }, from))
          })
        },
        onOpenPoints: () => router.push(documentReviewHitHref(hit, from)),
      }
    )
  }, [hit, t, router, from])
}
