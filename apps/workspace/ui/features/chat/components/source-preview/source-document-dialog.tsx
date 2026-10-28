'use client'

import { useEffect, useRef, type FC } from 'react'
import { Link2 } from 'lucide-react'
import { capturePosthog } from '@/lib/analytics/posthog'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { RisDocumentDialog } from '@/features/knowledge/components/ris-document-dialog'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import type { SourceTint } from '@/lib/source-kinds'
import { citedFileName, resolveCitationTarget, type CitationRef } from '../../lib/citations'
import { useChatStore } from '../../store'
import { CopySourceCitationButton } from '../CopyCitation'
import { CopyCitationLinkButton } from '../CopyCitationLink'
import { documentProjectId } from './citation-label'
import { useConversationId, useSourcePreviewIndex } from './use-source-preview-index'
import { useCitationDownload } from './use-citation-download'
import { useDocumentPreview } from './use-document-preview'
import { EMPTY_DOCUMENT_TARGET } from './document-target'

// ---------------------------------------------------------------------------
// Standalone document dialog — the same viewer, opened from outside a chip
// ---------------------------------------------------------------------------

/**
 * Opens a citation's document immediately, with no chip in between.
 *
 * The inline `[3]` marker and a deep link both need to put a reader in front of
 * the document without there being a chip to click. They get the SAME dialog —
 * same Fundstellen rail, same passage box, same copy actions — because a source
 * must not behave differently depending on which affordance reached it.
 *
 * Where it lands is the REFERENCE's business, not the caller's: the citation's
 * own locus, or — when it names the document as a whole — the first passage the
 * document was read at. A caller-supplied page would be a second, weaker way to
 * say the same thing (the dialog marks an active *locus*, and a bare page cannot
 * name one), so there is no page prop to disagree with the citation.
 */
export const SourceDocumentDialog: FC<{
  citation: CitationRef
  onClose: () => void
}> = ({ citation, onClose }) => {
  const projectId = useChatStore((s) => s.projectId)
  const conversationId = useConversationId()
  const previewIndex = useSourcePreviewIndex(
    documentProjectId(citation.document, projectId),
    conversationId,
    !citation.document.url,
    citedFileName(citation.document)
  )
  const target = resolveCitationTarget(citation.document, {
    locus: citation.locus,
    storedDocuments: previewIndex?.storedDocuments,
    baseCorpusFiles: previewIndex?.baseCorpusFiles,
  })
  const isDocument = target.kind === 'document'
  const isRis = target.kind === 'ris'
  const downloadTarget = target.kind === 'download' ? target : null
  const { download } = useCitationDownload(downloadTarget)
  const { openPreview, dialog, isOpen } = useDocumentPreview(
    isDocument ? target : EMPTY_DOCUMENT_TARGET,
    citation
  )

  // The reader went from an answer to its evidence: counted once the viewer is
  // actually showing, never for a dialog that mounted and closed because there
  // was nothing to open. `verified` is a quote the server found word for word
  // (`atQuote` keys its locus `…#quote`). Kinds and flags only: no name, no page.
  const openedReportedRef = useRef(false)
  const reportOpened = (viewer: 'document' | 'ris'): void => {
    if (openedReportedRef.current) return
    openedReportedRef.current = true
    capturePosthog('citation_opened', {
      source_kind: citation.document.kind,
      verified: Boolean(citation.locus?.key.endsWith('#quote')),
      viewer,
    })
  }

  // Open as soon as resolution succeeds; close the owner when the reader
  // dismisses the dialog, so the mount is tied to the viewing session. An
  // office citation opens its rendition here like any PDF; when there is none
  // (415/502) the preview has already handed over the original, and when the
  // open failed outright there is nothing left to show either — in both cases
  // the owner is released rather than left mounted over no dialog.
  useEffect(() => {
    if (isDocument && !isOpen)
      void openPreview(citation.locus).then((outcome) => {
        if (outcome === 'opened') reportOpened('document')
        else onClose()
      })
    // Opening is a one-shot per resolved target; re-running on every render
    // would reopen a dialog the reader just dismissed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDocument])

  // A `?cite=` link to a document with no in-app viewer hands over the FILE.
  // It used to fall through to "nothing openable" and close silently — the same
  // dead control #623 removed from the chip, left behind on the one path a
  // reader arrives at from outside the conversation.
  const downloadStartedRef = useRef(false)
  useEffect(() => {
    if (!downloadTarget || downloadStartedRef.current) return
    downloadStartedRef.current = true
    void download().finally(onClose)
  }, [downloadTarget, download, onClose])

  useEffect(() => {
    if (isRis || downloadTarget) return
    if (isDocument && previewIndex && !isOpen) return
    // Nothing openable and the index has answered: there is no viewer to show.
    if (previewIndex && !isDocument) onClose()
  }, [previewIndex, isDocument, isRis, downloadTarget, isOpen, onClose])

  useEffect(() => {
    if (isRis) reportOpened('ris')
    // One report per mounted dialog (the ref guards a re-run).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRis])

  // A RIS source opens its own reader — no stored-document index, no presign,
  // and no page: the reader marks the passage in the text instead.
  if (isRis && target.kind === 'ris') {
    return (
      <RisDocumentDialog
        open
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
        url={target.url}
        title={target.title}
        highlight={target.snippet}
        highlightColor={`var(--source-${citation.document.tint})`}
        headerChip={<RisHeaderChip signal={citation.document.tint} />}
        headerActions={
          <span className="flex shrink-0 items-center gap-2">
            <CopyCitationLinkButton citation={citation} icon={<Link2 className="size-3" />} />
            <CopySourceCitationButton citation={citation} />
          </span>
        }
      />
    )
  }

  if (downloadTarget) return null
  if (!isDocument) return null
  return <>{dialog}</>
}

/** The RIS provenance chip, so the reader's header matches the chip that opened it. */
const RisHeaderChip: FC<{ signal: SourceTint }> = ({ signal }) => {
  const t = useTranslations(chatCopy)
  return <SourceSignalChip signal={signal}>{t('sourcePreview.risDocument')}</SourceSignalChip>
}
