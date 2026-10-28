'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import type { ActionMenuEntry } from '@/components/ui/action-menu'
import { askAboutFile } from '@/features/documents/lib/ask-about-file'
import { fileItemFromStatus } from '@/features/documents/lib/document-question'
import { useTranslations } from '@/i18n'
import { searchCopy } from '@/i18n/namespaces/search'
import type { DocumentHit } from '@/lib/search/search-wire'
import { documentHitActionEntries } from '../lib/hit-actions'
import { documentFolderHref, documentHitHref, documentLinkHref, documentReviewHitHref } from '../lib/search-hrefs'
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
 * Puts `text` on the clipboard and says how it went, as the review's
 * „Link kopieren“ does: a browser without a clipboard, or one that refuses
 * the write, is told rather than left silent.
 */
function copyToClipboard(text: string, messages: { done: string; failed: string }): void {
  if (!navigator.clipboard) {
    toast.error(messages.failed)
    return
  }
  void navigator.clipboard.writeText(text).then(
    () => toast.success(messages.done),
    () => toast.error(messages.failed)
  )
}

/**
 * A document hit's menu entries, wired: open where the row's link goes;
 * Piloti fragen through the product's one ask (`askAboutFile`, which carries
 * the file into the chat as its subject and its peek), at the passage's page
 * when the hit was found by one; the current Fassung; the open points in the
 * document's Prüfansicht, from which closing comes back to this search; the
 * folder it lies in; and its link.
 */
export function useDocumentHitActions(hit: DocumentHit): ActionMenuEntry[] {
  const t = useTranslations(searchCopy, 'hitActions')
  const router = useRouter()
  const from = useSearchReturn()
  return useMemo(() => {
    const name = hit.title ?? hit.name
    return documentHitActionEntries(
      hit,
      {
        open: t('open'),
        ask: t('ask'),
        openCurrent: t('openCurrent'),
        openPoints: t('openPoints'),
        showInFolder: t('showInFolder'),
        copyLink: t('copyLink'),
      },
      {
        onOpen: () => router.push(documentHitHref(hit, from)),
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
        onShowInFolder: () => router.push(documentFolderHref(hit)),
        onCopyLink: () =>
          copyToClipboard(documentLinkHref(hit, window.location.origin), { done: t('linkCopied'), failed: t('linkCopyFailed') }),
      }
    )
  }, [hit, t, router, from])
}
