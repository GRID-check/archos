/**
 * CitationPeek — what a citation IS, before you commit to opening it.
 *
 * The question a reader asks of an inline `[3]` is not "take me somewhere", it
 * is "what is this?". Answering that with a scroll — the old behaviour — makes
 * them do the work: land somewhere, look around, guess which chip they arrived
 * at. The peek answers it in place: which document, how authoritative, which
 * page, and the passage itself.
 *
 * ONE component, used by every surface that can preview a citation (the inline
 * marker and the provenance chip). That is deliberate: two popovers describing
 * the same citation are two things that can disagree, which is the exact class
 * of defect the citation model exists to remove.
 */

'use client'

import { type FC } from 'react'
import Link from 'next/link'
import { Download, ExternalLink, FileSearch, FolderOpen, History, Link2 } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { PRESSABLE } from '@/components/ui/press'
import { SectionLabel } from '@/components/ui/section-label'
import { Spinner } from '@/components/ui/spinner'
import { useDelayedFlag } from '@/hooks/use-transient-flag'
import type { RevisionRef } from '@/lib/documents/revision-links'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import { documentPages, refPage, type CitationRef, type CitedDocument } from '../lib/citations'
import { isPrecedent } from '../lib/precedent'
import type { Shelf } from '../lib/source-kinds'
import { useOpenCurrentRevision } from '../hooks/use-open-current-revision'
import { useChatStore } from '../store'
import { CopySourceCitationButton } from './CopyCitation'
import { CopyCitationLinkButton } from './CopyCitationLink'
import { CitationPageThumbnail } from './CitationPageThumbnail'

interface CitationPeekProps {
  citation: CitationRef
  /** Passage text to show, when the reference carries one. */
  snippet?: string
  /** Opens the document at this reference's locus. Absent when unopenable. */
  onOpen?: () => void
  /** Outbound link, for web/RIS sources. */
  url?: string
  /**
   * The source resolved to nothing openable — say so, in place of the control.
   *
   * The alternative is silence, which is what this used to be: the reader is
   * looking at a citation and wants to know whether checking it is possible.
   * "There is no way in from here" is an answer; a control that closes the
   * popover and does nothing is not.
   */
  unavailable?: boolean
  /**
   * The document EXISTS but this app cannot draw its format — hand it over
   * instead, and say which of the two is happening.
   *
   * A cited `.docx` used to arrive here as `unavailable`, which is a claim
   * about the citation and was false: nothing was missing, the file was in the
   * project's Dateiablage and the reader was entitled to it. Absent when the
   * source is genuinely unreachable.
   */
  onDownload?: () => void
  /** The download is being presigned — the control says so rather than repeating. */
  downloadPending?: boolean
  /**
   * The newer document a person confirmed replaces the cited one — set only when
   * the cited document IS an older Fassung and the reader may open the newer one.
   * The peek says so in one line and opens the current Fassung.
   */
  supersededBy?: RevisionRef | null
  /**
   * Where the peek is drawn. `popover` is the glance beside a marker; `sheet` is
   * the same content as the body of the phone's bottom sheet, where the open
   * action is the one primary button and the passage gets the room to be read.
   */
  presentation?: 'popover' | 'sheet'
  /**
   * The stored PDF the page can be drawn from (`thumbnailDocumentId`). With it,
   * a locus that carries regions shows its page with the place marked, the
   * same box the viewer opens with. Absent, or without regions: no thumbnail.
   */
  thumbnailDocumentId?: string
}

/**
 * Whether the source BINDS, as a compact pill beside the tier label.
 *
 * Orthogonal to the authority badge (which names OIB/RIS): `binding` for
 * statute and ordinance, `declared_binding` for an OIB-Richtlinie a Land
 * declared binding, `interpretive` for interpretive material. The classification
 * the reader most wants — "does this actually apply to me?" — and the reason
 * the backend went to the trouble of carrying rank onto every source.
 *
 * `unknown` never reaches here: it is dropped to undefined at the wire, so an
 * unclassified source shows no pill rather than a hedged one. Colour is never
 * the only carrier — the German word is always spelled out (the a11y rule the
 * rest of this file follows).
 */
const BINDING_TONE: Record<string, string> = {
  binding: 'border-transparent bg-[var(--source-law,var(--foreground))] text-[var(--background)]',
  declared_binding: 'border-[var(--source-law,var(--foreground))] text-foreground',
  interpretive: 'border-border text-muted-foreground',
}

const BindingStatusChip: FC<{ status?: string }> = ({ status }) => {
  const t = useTranslations(chatCopy)
  if (!status || !(status in BINDING_TONE)) return null
  return (
    <span
      className={cn(
        'rounded-full border px-1.5 py-0.5 text-[0.65rem] font-medium leading-none pointer-coarse:text-xs',
        BINDING_TONE[status]
      )}
    >
      {t(`sourcePreview.binding.${status}`)}
    </span>
  )
}

/**
 * A text action in a peek's footer („An dieser Stelle öffnen", „In Dateien",
 * the download, the outbound link): tinted ink that underlines on hover, the
 * shared press and the one focus ring.
 *
 * Under a finger each takes the 44px floor as its OWN height. The row holds up
 * to six of these a few pixels apart, and the `touch-target` overhang they
 * used to carry is centred on each control and so overlapped its neighbours —
 * a tap between two of them resolved to whichever painted last. A real 44px
 * box per control, in a row that wraps, gives every target its own ground.
 */
export const PEEK_ACTION_CLASSES = cn(
  'inline-flex items-center gap-1 rounded-sm text-xs font-medium outline-none hover:underline pointer-coarse:min-h-11',
  PRESSABLE,
  FOCUS_RING
)

/**
 * The locus line: which page this reference names, or — for a
 * document-level reference — every page the answer drew on.
 *
 * Naming all of them matters: a chip stands for the whole document, so "S. 18"
 * alone would understate a document the answer leaned on at four places.
 */
export const LocusLine: FC<{ citation: CitationRef }> = ({ citation }) => {
  const t = useTranslations(chatCopy)
  const page = refPage(citation)
  const pages = documentPages(citation.document)

  // A PUNKT IS A PLACE. It was nested inside "has a page", so a locus that knew
  // its Punkt and not its page read „Gesamtes Dokument" — dropping the one
  // identifier Austrian building law actually cites by, in favour of saying
  // nothing. The chunker measures it against the corpus's contents pages
  // precisely so it can be shown.
  const clause = citation.locus?.clause?.trim()
  const text = citation.locus
    ? page != null
      ? clause
        ? t('answerSources.clausePage', { clause, page })
        : t('answerSources.page', { page })
      : clause
        ? t('answerSources.clause', { clause })
        : t('citationPeek.wholeDocument')
    : pages.length === 1
      ? t('answerSources.page', { page: pages[0]! })
      : pages.length > 1
        ? t('answerSources.pages', { pages: pages.join(', ') })
        : t('citationPeek.wholeDocument')

  return <p className="text-xs tabular-nums text-muted-foreground">{text}</p>
}

/**
 * The link to where the cited document LIVES in the app.
 *
 * The peek answers "what is this?"; the next question is often "where is it?"
 * — to see the file beside its siblings, to replace it with a newer version,
 * to check who filed it. Answering that used to mean closing the peek and
 * navigating from memory. The project shelf lives in the project's files, the
 * office archive at its own route; the base corpus and the session shelf have
 * no page of their own, and a web source already carries its `url`, so for
 * those there is nothing to offer and nothing is rendered.
 *
 * The project id comes off the chat store, which is how every other consumer
 * of the store on this popover's path already reads it.
 */
const DocumentHomeLink: FC<{ shelf?: Shelf; tint: CitedDocument['tint'] }> = ({
  shelf,
  tint,
}) => {
  const t = useTranslations(chatCopy)
  const projectId = useChatStore((s) => s.projectId)

  const target =
    shelf === 'project' && projectId
      ? {
          href: `/app/projects/${encodeURIComponent(projectId)}/files`,
          label: t('documentGrid.openInFiles'),
        }
      : shelf === 'office_shelf'
        ? { href: '/app/office-shelf', label: t('documentGrid.openInOfficeShelf') }
        : null
  if (!target) return null

  return (
    <Link
      href={target.href}
      data-citation-home=""
      className={PEEK_ACTION_CLASSES}
      style={{ color: `var(--source-${tint}-text, var(--foreground))` }}
    >
      <FolderOpen aria-hidden="true" className="size-3.5" />
      {target.label}
    </Link>
  )
}

/**
 * „An dieser Stelle öffnen": the document at the cited place, in the app.
 * One control for every surface that offers it (the peek, an excerpt's margin).
 *
 * `primary` is the one the phone's sheet shows: the reader who tapped a marker
 * with a thumb wants exactly one thing next, and it is a full-width ink button,
 * not a link among five.
 */
export const CitationOpenButton: FC<{
  tint: CitedDocument['tint']
  onOpen: () => void
  className?: string
  primary?: boolean
}> = ({ tint, onOpen, className, primary = false }) => {
  const t = useTranslations(chatCopy)
  if (primary) {
    return (
      <Button
        type="button"
        onClick={onOpen}
        data-citation-open=""
        className={cn('w-full gap-2', className)}
      >
        <FileSearch aria-hidden="true" className="size-4" />
        {t('citationPeek.openAtPage')}
      </Button>
    )
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      // The screenshot harness needs to walk peek → document the way a
      // reader does; naming the step beats guessing at button order.
      data-citation-open=""
      className={cn(PEEK_ACTION_CLASSES, className)}
      style={{ color: `var(--source-${tint}-text, var(--foreground))` }}
    >
      <FileSearch aria-hidden="true" className="size-3.5" />
      {t('citationPeek.openAtPage')}
    </button>
  )
}

/**
 * „Herunterladen", for a source with no viewer. Busy without being DISABLED:
 * a disabled button drops the keyboard focus that pressed it to `<body>`, and
 * dims to 70% for a presign that usually answers before the eye registers the
 * dim. So it stays focusable, `aria-disabled` while in flight (a second press
 * is ignored rather than refused), and only a wait past the Doherty threshold
 * shows a spinner — in the icon's slot, so the label does not move.
 */
export const PeekDownloadButton: FC<{
  tint: CitedDocument['tint']
  onDownload: () => void
  pending?: boolean
}> = ({ tint, onDownload, pending = false }) => {
  const t = useTranslations(chatCopy)
  const showBusy = useDelayedFlag(pending)
  return (
    <button
      type="button"
      onClick={() => {
        if (!pending) onDownload()
      }}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      data-citation-download=""
      className={cn(PEEK_ACTION_CLASSES, pending && 'cursor-progress')}
      style={{ color: `var(--source-${tint}-text, var(--foreground))` }}
    >
      {showBusy ? (
        <Spinner size="xs" aria-hidden="true" />
      ) : (
        <Download aria-hidden="true" className="size-3.5" />
      )}
      {t(showBusy ? 'citationPeek.downloading' : 'citationPeek.download')}
    </button>
  )
}

/**
 * „Ältere Fassung — aktuell: <Name>": the one line a citation of an older
 * Fassung adds, and the way to the current one.
 *
 * A citation is a claim that this passage backs this sentence; when the passage
 * stands in a Fassung a person has since replaced, the reader should know before
 * relying on it. Muted, because the citation itself is still true of the file it
 * names (an older Fassung is read on request); the name is the control.
 */
const OlderRevisionLine: FC<{ current: RevisionRef }> = ({ current }) => {
  const t = useTranslations(chatCopy)
  const openCurrent = useOpenCurrentRevision()
  return (
    <p
      data-citation-older-revision=""
      className="flex flex-wrap items-baseline gap-x-1 text-xs leading-relaxed text-muted-foreground"
    >
      <History aria-hidden="true" className="size-3.5 shrink-0 self-center" />
      <span>{t('citationPeek.olderRevision')}</span>
      <button
        type="button"
        onClick={() => void openCurrent(current)}
        aria-label={t('citationPeek.openCurrentRevisionAria', { name: current.filename })}
        className={cn(PEEK_ACTION_CLASSES, 'break-all text-foreground underline')}
      >
        {current.filename}
      </button>
    </p>
  )
}

export const CitationPeek: FC<CitationPeekProps> = ({
  citation,
  snippet,
  onOpen,
  url,
  unavailable,
  onDownload,
  downloadPending,
  supersededBy,
  presentation = 'popover',
  thumbnailDocumentId,
}) => {
  const t = useTranslations(chatCopy)
  const projectId = useChatStore((s) => s.projectId)
  const { document: doc } = citation
  const tint = doc.tint
  const sheet = presentation === 'sheet'
  const regions = citation.locus?.regions
  const thumbnailPage = refPage(citation)

  return (
    <div className={sheet ? 'space-y-3' : 'space-y-2'} data-presentation={presentation}>
      {/* What kind of source this is — the answer to "can I rely on it?" */}
      <div className="flex flex-wrap items-center gap-1.5">
        <SourceSignalChip signal={tint}>
          {t(isPrecedent(doc, projectId) ? 'sourcePreview.kinds.praezedenz' : `sourcePreview.kinds.${doc.kind}`)}
        </SourceSignalChip>
        {doc.laneLabel && (
          <span className="text-xs font-medium text-muted-foreground">{doc.laneLabel}</span>
        )}
        <BindingStatusChip status={doc.bindingStatus} />
      </div>

      <div>
        <p className="break-words text-sm font-medium text-foreground">{doc.title}</p>
        <LocusLine citation={citation} />
      </div>

      {/* The place itself: the sheet with the box on it, before the words that describe it. */}
      {thumbnailDocumentId && thumbnailPage != null && regions && regions.length > 0 && (
        <CitationPageThumbnail
          documentId={thumbnailDocumentId}
          page={thumbnailPage}
          regions={regions}
          color={`var(--source-${tint})`}
        />
      )}

      {supersededBy && <OlderRevisionLine current={supersededBy} />}

      {/* Does this actually bind me? The highest-value fact for a legal source. */}
      {doc.bindingNote && (
        <div
          className="rounded-md px-2.5 py-1.5"
          style={{
            backgroundColor: `var(--source-${tint}-tint, var(--muted))`,
          }}
        >
          <SectionLabel
            as="p"
            style={{ color: `var(--source-${tint}-text, var(--muted-foreground))` }}
          >
            {t('sourcePreview.bindingLabel')}
          </SectionLabel>
          <p className="mt-0.5 text-xs leading-relaxed text-foreground">{doc.bindingNote}</p>
        </div>
      )}

      {/* The words themselves — the whole point of checking a citation. */}
      {snippet && (
        <div
          className="rounded-lg border px-3 py-2"
          style={{
            backgroundColor: `var(--source-${tint}-tint, var(--muted))`,
            borderColor: `color-mix(in oklch, var(--source-${tint}, var(--foreground)) 25%, transparent)`,
          }}
        >
          <SectionLabel
            as="p"
            style={{ color: `var(--source-${tint}-text, var(--muted-foreground))` }}
          >
            {t('sourcePreview.citedPassage')}
          </SectionLabel>
          <p
            className={cn(
              'mt-1 overflow-y-auto whitespace-pre-wrap leading-relaxed text-foreground',
              sheet ? 'max-h-[38dvh] text-base' : 'max-h-32 text-sm'
            )}
          >
            {snippet}
          </p>
        </div>
      )}

      {/* WHY there is no viewer, before the control that works around it. Said
          in the popover rather than left to the reader's inference: "this
          format opens outside Piloti" is a fact about the file, and without it
          a download button beside a document chip reads as an arbitrary second
          choice. */}
      {onDownload && !onOpen && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('citationPeek.noInlineViewer')}
        </p>
      )}

      {/* The one thing a thumb wants next, before the secondary actions. */}
      {sheet && onOpen && <CitationOpenButton tint={tint} onOpen={onOpen} primary />}

      {/* A source with nothing to open is said in a sentence, never as a row that
          looks like a disabled control: it used to read „In Piloti nicht zu
          öffnen" beside the copy buttons, a dead action on the one source the
          reader tapped to check. */}
      {unavailable && !onOpen && !onDownload && (
        <p className="text-xs leading-relaxed text-muted-foreground" data-citation-unavailable="">
          {t('citationPeek.notOpenable')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2">
        {onOpen && !sheet && <CitationOpenButton tint={tint} onOpen={onOpen} />}
        {onDownload && !onOpen && (
          <PeekDownloadButton tint={tint} onDownload={onDownload} pending={downloadPending} />
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={PEEK_ACTION_CLASSES}
            style={{ color: `var(--source-${tint}-text, var(--foreground))` }}
          >
            {t('sourcePreview.openExternal')}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        )}
        <DocumentHomeLink shelf={doc.shelf} tint={tint} />
        <span className="flex-1" />
        <CopyCitationLinkButton citation={citation} icon={<Link2 className="size-3" />} />
        <CopySourceCitationButton citation={citation} />
      </div>
    </div>
  )
}
