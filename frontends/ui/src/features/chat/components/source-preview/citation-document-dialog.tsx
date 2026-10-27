'use client'

import type { FC } from 'react'
import { Download, Link2, PanelRight, TextSearch } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { Spinner } from '@/components/ui/spinner'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { SimilarPassagesPanel } from '@/features/similar-passages/components/similar-passages-panel'
import { openedPassageView } from '@/features/similar-passages/components/similar-passages-dialog'
import {
  useSimilarPassagesViewer,
  type DocumentSrcOf,
  type SimilarPassagesLoader,
} from '@/features/similar-passages/lib/use-similar-passages'
import { SIMILAR_PASSAGE_TEXT_MIN, type SimilarSourceDocument } from '@/lib/similar-passages/types'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import type { SourceTint } from '@/lib/source-kinds'
import { useDelayedFlag } from '@/hooks/use-transient-flag'
import { citationViewerAction, runViewerActionNow, useViewerBesideChat } from '../../lib/viewer-actions'
import { toQuoteList } from '../../lib/source-citation'
import type { CitationLocus, CitationRef } from '../../lib/citations'
import { useChatStore } from '../../store'
import { COPY_ACTION_CLASSES, CopySourceCitationButton } from '../CopyCitation'
import { CopyCitationLinkButton } from '../CopyCitationLink'
import {
  asDownloadTarget,
  isImageTarget,
  isRenditionTarget,
  navigableLoci,
  type DocumentTarget,
} from './document-target'
import { useCitationDownload } from './use-citation-download'
import { LocusRail } from './locus-rail'
import { CitedPassageBox } from './cited-passage-box'

/**
 * The citation viewer: what a clicked citation opens onto.
 *
 * Three things, composed — the document itself, the Fundstellen rail beside it,
 * and a header that names the source and copies a reference to exactly the
 * passage on screen. It is a component rather than JSX inside the hook because
 * this is the surface a reader judges the citation by: `/dev/pdf-passage` mounts
 * this same composition, so the preview cannot drift from what ships.
 *
 * Stateless on purpose. Which locus is active is the hook's (or the preview's)
 * to own; a dialog that kept its own copy would disagree with the deep link that
 * opened it.
 */
export const CitationDocumentDialog: FC<{
  target: DocumentTarget
  /** The reference this dialog stands for, when the click carried one. */
  citation?: CitationRef
  activeLocus?: CitationLocus
  onSelectLocus: (locus: CitationLocus) => void
  /** Explicit source URL — a presigned preview, or a fixture in the preview route. */
  src?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * How „Im Büro behandelt" asks and where an opened passage's bytes stream
   * from: the real client and the same-origin stream, unless the preview route
   * passes fixtures.
   */
  similarFixtures?: { load: SimilarPassagesLoader; srcOf: DocumentSrcOf }
}> = ({ target, citation, activeLocus, onSelectLocus, src, open, onOpenChange, similarFixtures }) => {
  const t = useTranslations('chat')
  const tKnowledge = useTranslations('knowledge')
  const projectId = useChatStore((s) => s.projectId)
  // The provenance tint comes from the SOURCE, not from where the file happens
  // to be stored: a chip and the dialog it opens must never disagree about what
  // kind of source this is.
  const headerSignal: SourceTint =
    citation?.document.tint ?? (target.document.type === 'base' ? 'law' : 'project')
  const page = activeLocus?.page ?? target.page
  // A passage read off a picture of the page (a plan's Grundriss) is marked
  // by its box, not searched for: its "snippet" is the vision model's
  // description of the drawing, and none of those words are on the sheet
  // (issue #433). A locus with no box keeps the text search, as before.
  const regions = activeLocus?.regions
  const passage = regions?.length ? undefined : (activeLocus?.snippet ?? target.snippet)
  // What the rail will show, decided here because it also decides whether the
  // dialog draws the passage a second time above the document.
  const railLoci = citation ? navigableLoci(citation.document) : []
  // The rail is where the Fundstelle lives once it can hold it: beside the
  // document, in the tint of its source, still there after the reader has
  // scrolled. Now that the rail shows for one Fundstelle too, the band above
  // the frame is the same words a second time, charging the document a band of
  // its height for the repetition. It stays for the passage the rail cannot
  // carry — a locus with no page, or a document-level snippet.
  const passageInRail =
    Boolean(activeLocus?.snippet) && railLoci.some((locus) => locus.key === activeLocus?.key)
  // The reference the dialog is CURRENTLY showing — what its copy actions must
  // describe, so a citation copied from page 18 does not say page 5.
  const shown: CitationRef | undefined = citation && {
    document: citation.document,
    locus: activeLocus,
  }
  // An office file is on screen as a PDF the BFF made from it. The reader is
  // told so, and the one action that must not be lost is the original itself:
  // the viewer's own "open in tab" and any save from it hand over the PDF.
  const rendition = isRenditionTarget(target)
  const { isDownloading, download } = useCitationDownload(
    rendition ? asDownloadTarget(target) : null
  )
  const downloadBusy = useDelayedFlag(isDownloading)

  // „Im Büro behandelt": the rail replaces the Fundstellen while it is open, and
  // a similar passage the reader opens takes the stage until they go back.
  const similar = useSimilarPassagesViewer()
  const sourceDocument: SimilarSourceDocument =
    target.document.type === 'stored'
      ? { kind: 'stored', documentId: target.document.id }
      : { kind: 'base', fileName: target.document.fileName }
  const findSimilar = (text: string, passagePage: number | null, cited: boolean): void =>
    similar.start({ document: sourceDocument, passage: { text, page: passagePage, cited }, projectId })
  const citedSearchable = !!passage && passage.trim().length >= SIMILAR_PASSAGE_TEXT_MIN
  const closeDialog = (next: boolean): void => {
    if (!next) similar.close()
    onOpenChange(next)
  }
  // The same viewer action Piloti proposes (ADR-0144), on the reader's own
  // click: the document beside the chat at this place, read again as the person.
  // Only where the peek has room beside a chat (not on a phone, not on Files),
  // and never for a chat attachment: it is on no shelf, so the read refuses it.
  const besideChat = useViewerBesideChat()
  const beside =
    besideChat && target.document.type === 'stored' && target.document.shelf !== 'session' ? target.document : null
  const openBeside = async (): Promise<void> => {
    if (!beside) return
    const result = await runViewerActionNow(
      citationViewerAction({
        documentId: beside.id,
        documentName: beside.filename,
        page: page ?? null,
        passage,
        box: regions?.[0]?.box ?? null,
      })
    )
    if (result.outcome === 'shown') closeDialog(false)
    else toast.error(t(result.outcome === 'refused' ? `viewerActions.refused.${result.reason}` : 'viewerActions.status.failed'))
  }
  const similarRail = similar.request && (
    <SimilarPassagesPanel
      request={similar.request}
      opened={similar.opened}
      onOpen={similar.open}
      onBackToSource={similar.backToSource}
      onClose={similar.close}
      load={similarFixtures?.load}
    />
  )

  // A similar passage on the stage: the same dialog shows its document instead
  // (spread last, below), and the citation's own affordances step aside.
  const openedView = similar.opened ? openedPassageView(similar.opened, similarFixtures?.srcOf) : null

  return (
    <PdfViewerDialog
      open={open}
      onOpenChange={closeDialog}
      fileName={
        target.document.type === 'base' ? target.document.fileName : target.document.filename
      }
      page={page ?? null}
      title={target.title}
      src={src}
      isImage={isImageTarget(target)}
      // The passage the retrieval actually read. The viewer finds it on the
      // page and marks it, so the click lands on the SENTENCE rather than on a
      // page the reader then has to search — and it wears this source's own
      // tint, the same one the chip that opened the dialog wore.
      highlight={passage}
      regions={openedView ? undefined : regions}
      highlightColor={`var(--source-${headerSignal})`}
      // What the reader's OWN selection becomes on the clipboard. The viewer
      // knows the words and the page; only this side knows the document they
      // belong to, so the citation is built here — in the same Zitiertext form
      // the answer's own "copy citation" produces, because a quotation pasted
      // from the source and one pasted from the chat must not arrive in the
      // reader's Stellungnahme looking like two different conventions.
      quoteFormat={
        citation && !openedView
          ? ({ text, page: quotedPage }) =>
              toQuoteList(
                [
                  {
                    document: citation.document,
                    locus: { key: 'selection', page: quotedPage, snippet: text, isCited: true },
                  },
                ],
                new Date()
              )
          : undefined
      }
      // A selection in the cited document asks for its neighbours; the rail is
      // about that document, so a passage opened from it offers no search of its own.
      onFindSimilar={
        openedView ? undefined : ({ text, page: selectedPage }) => findSimilar(text, selectedPage, false)
      }
      headerChip={
        <SourceSignalChip signal={headerSignal}>
          {t(
            target.document.type === 'base'
              ? 'sourcePreview.corpusDocument'
              : 'sourcePreview.projectDocument'
          )}
        </SourceSignalChip>
      }
      headerActions={
        !openedView &&
        (shown || rendition || citedSearchable || beside) && (
          <span className="flex shrink-0 items-center gap-2">
            {beside && (
              <button
                type="button"
                onClick={() => void openBeside()}
                data-open-beside-chat=""
                className={COPY_ACTION_CLASSES}
              >
                <PanelRight aria-hidden="true" className="size-3" />
                {t('sourcePreview.openBesideChat')}
              </button>
            )}
            {citedSearchable && (
              // The cited passage's own neighbours: the Fundstelle is retrieved
              // text, so the backend finds its stored chunk and embeds nothing.
              <button
                type="button"
                onClick={() => {
                  if (passage) findSimilar(passage, page ?? null, true)
                }}
                aria-label={tKnowledge('similar.forPassage')}
                data-find-similar=""
                className={COPY_ACTION_CLASSES}
              >
                <TextSearch aria-hidden="true" className="size-3" />
                {tKnowledge('similar.action')}
              </button>
            )}
            {rendition && (
              <>
                <span className="text-muted-foreground text-xs font-normal" data-rendition-note="">
                  {t('sourcePreview.renditionNote')}
                </span>
                {/* Busy, not disabled, for the reason the chip gives: the
                    reader's focus stays on the control they pressed. */}
                <button
                  type="button"
                  onClick={() => {
                    if (!isDownloading) void download()
                  }}
                  aria-disabled={isDownloading || undefined}
                  aria-busy={isDownloading || undefined}
                  data-citation-download-original=""
                  className={cn(COPY_ACTION_CLASSES, isDownloading && 'cursor-progress')}
                >
                  {downloadBusy ? (
                    <Spinner size="xs" aria-hidden="true" className="[&_svg]:size-3" />
                  ) : (
                    <Download aria-hidden="true" className="size-3" />
                  )}
                  {t(downloadBusy ? 'citationPeek.downloading' : 'sourcePreview.downloadOriginal')}
                </button>
              </>
            )}
            {shown && (
              <>
                <CopyCitationLinkButton citation={shown} icon={<Link2 className="size-3" />} />
                <CopySourceCitationButton citation={shown} />
              </>
            )}
          </span>
        )
      }
      aside={
        similarRail ||
        (citation && (
          <LocusRail
            document={citation.document}
            activeKey={activeLocus?.key}
            onSelect={onSelectLocus}
          />
        ))
      }
      {...openedView}
    >
      {!openedView && passage && !passageInRail && <CitedPassageBox snippet={passage} signal={headerSignal} />}
    </PdfViewerDialog>
  )
}
