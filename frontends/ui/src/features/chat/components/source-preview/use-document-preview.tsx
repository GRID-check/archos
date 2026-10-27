'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import { documentFileUrl } from '@/lib/documents/urls'
import { openAtLocus, type CitationLocus, type CitationRef } from '../../lib/citations'
import {
  RENDITION_PENDING_NOTICE_MS,
  asDownloadTarget,
  isImageTarget,
  isRenditionTarget,
  isRenditionUnavailable,
  type DocumentTarget,
} from './document-target'
import { useCitationDownload } from './use-citation-download'
import { CitationDocumentDialog } from './citation-document-dialog'

/**
 * Open/fetch state for a document target. Project uploads need a fresh
 * presigned preview URL per open (they expire); base-corpus PDFs stream from
 * the knowledge-base route PdfViewerDialog already builds from `fileName`.
 * The dialog only ever opens with a renderable source — a failed presign
 * surfaces as a toast, not a broken viewer, and an office file the BFF cannot
 * render (415/502) is downloaded instead: the reader asked for its content,
 * and the original is the content.
 *
 * `openPreview` says how it ended, so a caller with no chip to degrade (the
 * `?cite=` dialog) knows when there will be no viewer to wait for.
 *
 * The dialog owns an ACTIVE LOCUS, not just a page: which Fundstelle the reader
 * is on is the thing the rail marks, the citation footer copies, and a deep
 * link restores.
 */
export type PreviewOutcome = 'opened' | 'downloaded' | 'failed'

export const useDocumentPreview = (target: DocumentTarget, citation?: CitationRef) => {
  const t = useTranslations('chat')
  const [isOpen, setIsOpen] = useState(false)
  const [isResolving, setIsResolving] = useState(false)
  const [src, setSrc] = useState<string | null>(null)
  // A chip is a DOCUMENT-level reference, so it arrives with no locus — but the
  // viewer still opens at the first cited passage, and the rail must say so.
  // Leaving it unset marked nothing, so the reader could not tell which of four
  // Fundstellen they were looking at.
  //
  // Resolved through `openAtLocus`, the same rule the target used to pick its
  // page: a reference bound to a page-less locus opens at a Fundstelle the
  // document actually has. Picking the locus separately here is how the header
  // and rail came to mark one place while the document showed another.
  const [activeLocus, setActiveLocus] = useState<CitationLocus | undefined>(() =>
    citation ? openAtLocus(citation.document, citation.locus) : undefined
  )

  // A deep link (or a second click on a different marker) can change which
  // locus this dialog should be showing while it is already mounted.
  useEffect(() => {
    if (citation?.locus) setActiveLocus(openAtLocus(citation.document, citation.locus))
    // THE KEY, NOT THE OBJECT. `AgentResponse` rebuilds the whole citation model
    // whenever the turn's citations change, so during a streaming turn every
    // locus is a new object for the same reference — and depending on identity
    // meant this effect fired on each rebuild and threw away the Fundstelle the
    // reader had just chosen in the rail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citation?.locus?.key])

  const isImage = isImageTarget(target)
  const rendition = isRenditionTarget(target)
  const { download } = useCitationDownload(asDownloadTarget(target))

  const openPreview = async (locus?: CitationLocus): Promise<PreviewOutcome> => {
    if (locus && citation) setActiveLocus(openAtLocus(citation.document, locus))
    else if (locus) setActiveLocus(locus)
    if (target.document.type === 'base') {
      setIsOpen(true)
      return 'opened'
    }
    setIsResolving(true)
    // A first open of an office file converts it, which is slow enough to need
    // saying; a rendition already stored answers before this ever shows.
    let pendingToast: string | number | undefined
    const pendingTimer = rendition
      ? setTimeout(() => {
          pendingToast = toast.loading(t('sourcePreview.renditionPending'))
        }, RENDITION_PENDING_NOTICE_MS)
      : undefined
    try {
      // The presign still runs, and not only out of habit: it is the
      // authorization and existence check that keeps a failure a toast instead
      // of a dialog that opens onto nothing.
      const res = await fetch(`/api/documents/${target.document.id}/preview`)
      // Only an office source has a rendition to be refused. A 502 on an
      // ordinary PDF is a gateway hiccup, and downloading the file instead of
      // saying so turned a failed preview into a silent download.
      if (rendition && isRenditionUnavailable(res.status)) {
        clearTimeout(pendingTimer)
        if (pendingToast !== undefined) toast.dismiss(pendingToast)
        await download()
        return 'downloaded'
      }
      const data = res.ok ? await res.json() : null
      if (data?.url) {
        // An image is NAVIGATED to by `next/image` and keeps the presigned URL.
        // A PDF is FETCHED by the viewer to read its text layer, so it has to
        // come from this origin — the object store publishes no CORS policy,
        // and a cross-origin read fails where the same bytes in an iframe would
        // have loaded. See `documentFileUrl`.
        setSrc(isImage ? data.url : documentFileUrl(target.document.id))
        setIsOpen(true)
        return 'opened'
      }
      toast.error(t('sourcePreview.loadFailed'))
      return 'failed'
    } catch {
      toast.error(t('sourcePreview.loadFailed'))
      return 'failed'
    } finally {
      clearTimeout(pendingTimer)
      if (pendingToast !== undefined) toast.dismiss(pendingToast)
      setIsResolving(false)
    }
  }
  const dialog = (
    <CitationDocumentDialog
      target={target}
      citation={citation}
      activeLocus={activeLocus}
      onSelectLocus={setActiveLocus}
      src={src ?? undefined}
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open)
        if (!open) setSrc(null)
      }}
    />
  )

  return { isResolving, openPreview, dialog, isOpen, setIsOpen }
}
