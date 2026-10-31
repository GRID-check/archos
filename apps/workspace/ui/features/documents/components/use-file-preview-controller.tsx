import { INLINE_PREVIEW_CONTENT_TYPES, isOfficeRenditionSource } from '@/lib/documents/preview-types'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { isTextPageType } from './file-text-page'


import type { FileItem } from './project-file-workspace'
import { MessageSquarePlus } from 'lucide-react'
import { firstFinding, quarantineVerdictOf, type QuarantineFinding } from '@/lib/upload-screening/quarantine'

import type { RevisionLinks } from '@/lib/documents/revision-links'
import { documentTypeOf } from '@/lib/documents/tag-vocabulary'

import { useLocale, useTranslations } from '@/i18n'

import { filesCopy } from '@/i18n/namespaces/files'

import { inferDocumentKind } from '../document-kind'

import type { OpenMarksAtApproval } from './document-review-controls'

import type { SimilarPassagesRequest } from '@/lib/similar-passages/types'
import { useSeenOnce } from '@/hooks/use-seen-once'
import { useMediaQuery } from '@/hooks/use-media-query'
import { PHONE_ON_ITS_SIDE_QUERY, PHONE_QUERY } from '@/hooks/use-is-mobile'

import { useDocumentActions, useMoveInSheet, type DocumentScope } from './document-actions'
import { fileTypeIcon, isCitable, isCitableStatus, isNeverIndexed, isSettlingStatus } from './document-status'

import type { VisualDetail } from './page-readings'
import { useFileFacts } from '../hooks/use-file-facts'

import { showsRevisionsSection } from '@/lib/documents/revision-timeline'

import type { DocumentLifecyclePermission, DocumentVersionState } from '@/lib/documents/lifecycle-types'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { backLandsOn } from '@/lib/navigation/history-step'

import { useFilePreviewStore } from '../stores/file-preview-store'
import { useDocumentReview } from '../hooks/use-document-review'

import { useRoomCompany } from './review/presence'
import { tabCounts } from './review/review-panel'

import { clearReviewParams, hrefWithParams, readReviewParams, reviewFilesHref, setReviewParams, type ReviewLinkTool } from '../lib/open-review'
import { readDocumentLocus } from '../lib/document-locus'
import { isLive, type MarkTally } from '@/lib/annotations/types'

import { ToolbarTextButton } from '@/components/ui/floating-toolbar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCurrentProject } from '@/features/projects/lib/current-project'

import { type PeekView } from './file-preview-peek'
import { type ReaderAnnotate } from './file-preview-reader'

export interface FilePreviewPaneProps {
  file: FileItem
  /** Present for project documents; omitted for the org-wide Archiv (unused here). */
  projectId?: string
  /** Project display name for the indexed-metadata panel's Project row. */
  projectName?: string
  /**
   * Whether the viewer may mutate the document (edit tags, re-ingest). Defaults
   * to true (all project callers). The Archiv passes the caller's manage
   * capability so members without `org:office_shelf:manage` get a read-only pane.
   */
  canManage?: boolean
  onClose?: () => void
  /** Notify the parent to flip local state after a successful re-ingestion. */
  onReingested?: (fileId: string, status: string) => void
  /**
   * Notify the parent of the saved tags after a successful PATCH, so the
   * workspace's file state (and thus `initialTags` on reselect) stays fresh —
   * otherwise switching away and back reverts to the pre-edit tags.
   */
  onTagsUpdated?: (fileId: string, tags: string[], topics?: string[]) => void
  /** Open another document of this shelf here, from the Fassungen section. */
  onOpenDocument?: (fileId: string) => void
  /** A link was confirmed or taken back: the Fassung facts of one of the two documents, so the listing moves both cards. */
  onRevisionChanged?: (fileId: string, revision: RevisionLinks | null) => void
  /**
   * Whether the "Indexed by GRID" metadata panel (AI summary, key-value props,
   * editable tags) renders (FB-8). On by default, the chat peek included,
   * where it is the Details tab. Status/type/size rows always render.
   */
  showMetadataPanel?: boolean
  /**
   * Whether an `.ifc` preview offers the model workspace (`ifc-models`).
   *
   * Defaults to true: a link that does not
   * render is a feature nobody can find, and the workspace refuses on its own
   * if the flag is really off.
   */
  showModels?: boolean
  /** Which corpus the document belongs to — decides the file operations' route. */
  scope?: DocumentScope
  /** The document was renamed from the header menu. */
  onRenamed?: (fileId: string, displayName: string | null) => void
  /** The document was deleted from the header menu; the pane closes itself. */
  onDeleted?: (fileId: string) => void
  canCollaborate?: boolean
  /**
   * What this reader may do to the document's versions, resolved on the server
   * (`lib/documents/lifecycle-permissions.ts`). Absent means the surface did not
   * read them — the Archiv sheet, the chat peek — and the rail then shows no
   * Freigabe section at all rather than guessing a set.
   */
  lifecyclePermissions?: readonly DocumentLifecyclePermission[]
  /** The reader, so their own acts in the version list read as „Sie". */
  viewerUserId?: string | null
  /** A Freigabe decision landed — the listing behind the pane moves its badge. */
  onLifecycleChanged?: (
    fileId: string,
    summary: { versionState: DocumentVersionState; versionCount: number },
  ) => void
  /**
   * The review read the marks, or the reader changed them: the listing's tally
   * for this document, as the server counts it (`tallyLiveMarks`), `null` when
   * none is live. Dateien's chip is read with the listing and would otherwise
   * say „5 offen“ after the reader closed all five here.
   */
  onMarksChanged?: (fileId: string, marks: MarkTally | null) => void
  /** Modal on Files; peek/expanded once this file is the chat subject. */
  presentation?: 'modal' | 'peek' | 'expanded'
  onAssigneesChanged?: (assignees: FileItem['assignees']) => void
}

/** The one list (`lib/documents/preview-types.ts`); this pane no longer keeps a copy. */
const PREVIEW_TYPES: readonly string[] = INLINE_PREVIEW_CONTENT_TYPES

const VISUAL_CONTENT_TYPES = ['drawing', 'image', 'chart']

export function useFilePreviewController(props: FilePreviewPaneProps) {
  const {
  file,
  projectId,
  projectName,
  canManage = true,
  lifecyclePermissions,
  viewerUserId,
  onLifecycleChanged,
  onMarksChanged,
  scope = 'files',
  onClose,
  onReingested,
  onTagsUpdated,
  onOpenDocument,
  onRevisionChanged,
  onRenamed,
  onDeleted,
  showMetadataPanel = true,
  showModels = true,
  canCollaborate = false,
  presentation = 'modal',
  onAssigneesChanged,
  } = props
  const t = useTranslations(filesCopy)
  // The project this pane sits in, when it is closed and the file is one of its
  // own (not an Archiv file, not another project's): the chip under the name.
  const currentProject = useCurrentProject()
  const closedProjectName =
    currentProject?.status === 'closed' && scope !== 'officeShelf' && (projectId ?? currentProject.id) === currentProject.id
      ? (projectName ?? currentProject.name)
      : null
  /**
   * „Von Piloti indexiert" is a claim, and on a report Piloti WROTE it is a
   * false one: that document was deliberately never dispatched to `/v1/ingest`,
   * so there is nothing indexed to show and the eyebrow would contradict the
   * hint on the disabled Ask button two lines above it. The rail keeps the
   * facts that come from the file itself (type, size, project) and drops the
   * section that describes an ingestion that never ran.
   */
  const showIndexedSection = showMetadataPanel && !isNeverIndexed(file)
  /**
   * Which of the section's two claims holds right now. „Von Piloti indexiert"
   * over nothing, while the document was still being read or under a failed
   * block, promised a summary that was not coming (yet). Citable: the heading,
   * over the summary once there is one. Still being read: one line saying so,
   * which the settling poll replaces with the summary when it lands. Failed:
   * neither — the failure block above already says what happened.
   */
  const indexedReady = showIndexedSection && isCitableStatus(file.status)
  const indexedPending = showIndexedSection && isSettlingStatus(file.status)
  const showIndexedHeading = indexedReady || indexedPending
  /**
   * What „Besprechen" will and will not be able to do with this document.
   *
   * It is a hint and no longer a reason a control is off: a report Piloti wrote
   * was deliberately never dispatched to `/v1/ingest`, so it is not Projektwissen
   * and cannot be cited as such — and it can still be read and discussed. Only
   * the never-indexed case has anything to say; a citable document's button
   * needs no explaining. The words name Piloti as the author, so a person's
   * upload that is not in the index (archived, or never dispatched) gets none.
   */
  const discussHint =
    file.authoredBy && file.authoredBy !== 'user' && isNeverIndexed(file) ? t('authorship.notInKnowledge') : undefined
  /**
   * Review controls are for a project document and a surface that resolved this
   * reader's lifecycle permissions — the Archiv and the chat peek pass neither,
   * and a control they cannot honour is worse than none.
   */
  const reviewViewer =
    projectId && lifecyclePermissions ? { permissions: lifecyclePermissions, userId: viewerUserId } : undefined
  const assigneeNames = Object.fromEntries(
    (file.assignees ?? []).flatMap((person) => (person.name ? [[person.userId, person.name] as const] : [])),
  )
  const revisionsShown = showsRevisionsSection({
    facts: file.revision ?? null,
    versionCount: file.versionCount,
    hasViewer: reviewViewer !== undefined,
  })
  const storeMode = useFilePreviewStore((state) => state.mode)
  const storeFileId = useFilePreviewStore((state) => state.file?.id)
  const inChat =
    presentation === 'peek' ||
    presentation === 'expanded' ||
    ((storeMode === 'peek' || storeMode === 'expanded') && storeFileId === file.id)
  const peeking = presentation === 'peek'
  /**
   * THE READER, ON A PHONE. Opened from Dateien, from the chat's file pill or
   * from a citation, a document on a phone is one presentation: the document
   * edge to edge between a one-line header and the actions at the thumb, and
   * everything the rail knows one tap away in a sheet. The stacked layout it
   * replaces gave a drawing a 50dvh well with the metadata scrolling under it,
   * which on a 393px phone is a third of the screen for the thing the reader
   * opened. A phone on its side counts: 393px of height cannot spare a second
   * band for the actions, so they move up into the header.
   */
  // On touch or a narrow screen „Verschieben" opens the searchable move sheet,
  // not a dropdown submenu a phone clips.
  const moveInSheet = useMoveInSheet()
  const onPhone = useMediaQuery(PHONE_QUERY)
  const sideways = useMediaQuery(PHONE_ON_ITS_SIDE_QUERY)
  const reader = onPhone && !peeking
  const [detailsOpen, setDetailsOpen] = useState(false)
  useEffect(() => {
    setDetailsOpen(false)
  }, [file.id])
  /**
   * Which face of the peek is up: the document, or everything the Files dialog
   * knows about it. Back to the document whenever a different file arrives —
   * a citation opening the next file should show that file, not its metadata.
   */
  const [peekView, setPeekView] = useState<PeekView>('document')
  useEffect(() => {
    setPeekView('document')
  }, [file.id])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  /**
   * The same-origin signed path for the same bytes, when the optimizer can
   * serve them. Separate from `previewUrl` rather than replacing it: the
   * "open in new tab" link wants the object-store URL, and a format the
   * optimizer rejects still has to render. (A PDF reads neither: the viewer
   * fetches the same-origin stream, see `documentFileUrl`.)
   */
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null)
  /**
   * What the preview route said it is serving, for an office file only.
   *
   * An office file is never shown as itself: the BFF converts it to a PDF
   * rendition (ADR-0070) and the preview answers with `contentType:
   * 'application/pdf'`. The renderer is chosen from THAT answer rather than
   * from the stored type — the stored `.docx` type would send the URL into the
   * image branch — and anything but a PDF is treated as no rendition at all.
   */
  const [renditionType, setRenditionType] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  /** The document is not there any more (or not the reader's) — see `loadPreview`. */
  const [previewGone, setPreviewGone] = useState(false)
  /**
   * A text document's content, when the pane renders the bytes itself rather
   * than handing a URL to an element. Null for every other format, and for a
   * text document whose fetch has not landed — `previewFailed`/`previewGone`
   * carry the failure, exactly as they do for the URL path.
   */
  const [previewText, setPreviewText] = useState<{ text: string; truncated: boolean } | null>(null)
  const [isLargePreviewOpen, setIsLargePreviewOpen] = useState(false)
  // „Auf den Seiten": per-page VLM descriptions of the document's visual
  // chunks (drawings/images/charts), loaded with any document that has them
  // (`PageReadings` says why they lead the rail rather than trail it).
  const [details, setDetails] = useState<VisualDetail[] | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  /**
   * The descriptions could not be READ — a network error, a 500. Not the same
   * answer as "there are none", and it used to say exactly that: a hiccup told
   * the reader the drawing had no descriptions, with no way to ask again.
   */
  const [detailsFailed, setDetailsFailed] = useState(false)
  /**
   * The page a reading asked the viewer to turn to. `'turning'` for the one
   * frame between two asks: the viewer scrolls when its `page` CHANGES, and
   * 7 → 7 is no change, so a second ask for the page the reader has since
   * scrolled away from goes through null first. Null-for-a-frame alone would
   * hand the viewer the quarantine finding's page in between, a second jump.
   */
  const [shownPage, setShownPage] = useState<number | 'turning' | null>(null)
  const turnFrame = useRef<number | null>(null)
  /**
   * An `.ifc` is a building, and it previews as one. This is the ONLY thing
   * this pane knows about the BIM subsystem — `inferDocumentKind` already
   * classifies a model by format (it has to, for the card thumbnails), and the
   * viewport is behind one dynamic import.
   *
   * Every shelf, not just a project's. This used to require a `projectId`,
   * because a model could only be resolved through a project's model list — so
   * a model uploaded into the org-wide Archiv previewed as a grey "no inline
   * preview" page mock, and the file the whole feature is about was the one
   * file the Archiv could do nothing with. The document-scoped lookup behind
   * `IfcFilePreview` removed that prerequisite; the surfaces that have a
   * project still use it, and the ones that do not now work.
   */
  const kind = inferDocumentKind({
    filename: file.filename,
    contentType: file.contentType,
    tags: file.tags,
  })
  const isModel = kind === 'model'
  /**
   * Word, Excel, PowerPoint and their ODF kin are shown through a PDF the BFF
   * makes from them (ADR-0070). They ask the same preview route, so they are
   * `canPreview` too; what differs is what comes back and what a refusal means.
   */
  const isOfficeRendition = isOfficeRenditionSource(file)
  const canPreview = PREVIEW_TYPES.includes(file.contentType ?? '') || isOfficeRendition
  /**
   * Text, Markdown and CSV are previewable too, by a different route: the pane
   * fetches the CONTENT and renders it, because the object store publishes no
   * CORS policy and a presigned URL is therefore unreadable to a `fetch`. Kept
   * out of `canPreview` rather than folded into it — that flag means "there is
   * a URL to put in an element", and these have none.
   */
  const isTextual = isTextPageType(file.contentType)
  const isImage = !isOfficeRendition && (file.contentType ?? '').startsWith('image/')
  /** The type of the bytes the well actually shows: the rendition's, for an office file. */
  const shownType = isOfficeRendition ? renditionType : file.contentType
  // The large viewer dialog enlarges PDFs (the same pdf.js viewer) and images
  // (img mode). Offer the expand affordance for both. An office file's
  // rendition is a PDF, and `/file` streams the rendition for it.
  const canExpandPreview = shownType === 'application/pdf' || isImage
  const isFailed = file.status === 'failed'
  /**
   * Held back by the content check (ADR-0086). Not a failure: nothing broke and
   * nothing is retried; someone has to look. So the pane shows what was found
   * and where, and opens the document at the first finding with the office's
   * term marked, as a citation opens at its Fundstelle. Only the uploader and the
   * reviewers can open a held file, and both are meant to see why.
   */
  const isHeld = file.status === 'quarantined'
  const heldVerdict = useMemo(
    () => (isHeld ? quarantineVerdictOf({ quarantine: file.quarantine, errorMessage: file.errorMessage }) : null),
    [isHeld, file.quarantine, file.errorMessage]
  )
  const [shownFinding, setShownFinding] = useState<QuarantineFinding | null>(null)
  useEffect(() => {
    setShownFinding(firstFinding(heldVerdict))
  }, [file.id, heldVerdict])
  const Icon = fileTypeIcon(file.contentType, file.filename)
  const fileFacts = useFileFacts(file)
  const responsibleNames = (file.assignees ?? [])
    .map((person) => person.name || person.email || '')
    .filter(Boolean)
    .join(', ')
  // The document has visual chunks (drawings/images/charts) whose per-page VLM
  // descriptions can be browsed in the "detailed information" section.
  const hasVisualContent = (file.contentTypes ?? []).some((c) => VISUAL_CONTENT_TYPES.includes(c))
  // The ingestion-detected document type (first document-type tag), shown as
  // the indexed panel's Type row. Only real metadata — nothing is inferred here.
  const detectedType = documentTypeOf(file.tags)
  /**
   * Whether the rail's ownership block has anything in it. In the chat peek an
   * ordinary upload has no Piloti byline, no Discuss button (the reader is
   * already in the conversation) and, without collaboration, no assignees:
   * the block was an empty box with a rule under it, heading the Details tab.
   */
  const hasOwnershipBlock =
    file.authoredBy === 'agent' || canCollaborate || Boolean(projectId && !inChat)

  /**
   * The request the well is waiting on, so a newer one can retire it.
   *
   * An office file's rendition takes seconds. Open one, then open another file
   * before it lands, and the first answer arrived last and won: the pane showed
   * document A under document B's name. Every answer is checked against the
   * request that asked for it; a retired one changes nothing.
   */
  const previewRequest = useRef<AbortController | null>(null)
  const loadPreview = useCallback(() => {
    previewRequest.current?.abort()
    const request = new AbortController()
    previewRequest.current = request
    const { signal } = request
    setPreviewFailed(false)
    setPreviewGone(false)

    if (isTextual) {
      // Same three outcomes as the URL path, and deliberately the same states,
      // so the retry button and the "stop asking about it" way out work on a
      // `.md` exactly as they do on a PDF.
      setPreviewUrl(null)
      setPreviewText(null)
      setIsLoading(true)
      let gone = false
      fetch(`/api/documents/${file.id}/text`, { signal })
        .then(async (r) => {
          if (r.status === 404) {
            gone = true
            return null
          }
          return r.ok ? await r.json() : null
        })
        .then((data) => {
          if (signal.aborted) return
          if (typeof data?.text === 'string') {
            setPreviewText({ text: data.text, truncated: data.truncated === true })
          } else if (gone) {
            setPreviewGone(true)
          } else {
            setPreviewFailed(true)
          }
        })
        .catch(() => {
          if (signal.aborted) return
          setPreviewText(null)
          setPreviewFailed(true)
        })
        .finally(() => {
          if (!signal.aborted) setIsLoading(false)
        })
      return
    }

    setPreviewText(null)
    if (!canPreview) {
      setPreviewUrl(null)
      return
    }

    setIsLoading(true)
    setRenditionType(null)
    // A local, not the state above: the branch that sets it and the branch that
    // reads it are two links of the same promise chain, and a `useState` value
    // does not change between them.
    let gone = false
    // An office file the BFF will not or could not convert: 415 when
    // conversion is switched off, 502 when the converter failed. Neither is a
    // hiccup a retry fixes, so the pane says what it said before renditions
    // existed — no inline preview — and offers the download of the original.
    let noRendition = false
    fetch(`/api/documents/${file.id}/preview`, { signal })
      .then(async (r) => {
        if (isOfficeRendition && (r.status === 415 || r.status === 502)) {
          noRendition = true
          return null
        }
        // A RETRY THAT CANNOT WORK IS A DEAD END WEARING A BUTTON.
        //
        // 404 here is not a hiccup: the service answers it for a document that
        // has been deleted AND for one this reader may no longer open (see
        // `getAccessibleDocument` — cross-tenant and no-access both surface as
        // 404). Neither changes by asking again, and in a shared project both
        // happen while somebody is mid-conversation about the file. Offering
        // "Erneut versuchen" there is an invitation to press a button until
        // they give up; what they need is to be told, and to be let out.
        if (r.status === 404) {
          gone = true
          return null
        }
        return r.ok ? await r.json() : null
      })
      .then((data) => {
        if (signal.aborted) return
        if (isOfficeRendition && data?.url && data.contentType !== 'application/pdf') {
          noRendition = true
        }
        if (noRendition) {
          setPreviewUrl(null)
          setPreviewImageUrl(null)
        } else if (data?.url) {
          if (isOfficeRendition) setRenditionType(data.contentType)
          setPreviewUrl(data.url)
          // Absent for PDFs and for image formats the optimizer cannot process;
          // the renderer falls back to `url` unoptimized in both cases.
          setPreviewImageUrl(typeof data.imageUrl === 'string' ? data.imageUrl : null)
        } else if (gone) {
          setPreviewGone(true)
        } else {
          setPreviewFailed(true)
        }
      })
      .catch(() => {
        if (signal.aborted) return
        setPreviewUrl(null)
        setPreviewImageUrl(null)
        setPreviewFailed(true)
      })
      .finally(() => {
        if (!signal.aborted) setIsLoading(false)
      })
  }, [file.id, canPreview, isTextual, isOfficeRendition])

  /**
   * The viewer could not open the bytes the preview route vouched for: the
   * stream refused, the worker failed to load, the file is not a PDF after
   * all. The same failed state the fetch path and the image `onError` use, so
   * the reader gets the caption and the retry, never a blank frame.
   */
  const handlePdfFailed = useCallback(() => {
    setPreviewUrl(null)
    setPreviewImageUrl(null)
    setPreviewFailed(true)
  }, [])
  /**
   * pdf.js is a megabyte of parser plus a worker, and a document open in it
   * holds its page cache. So it mounts only once the well has been on screen,
   * and steps aside while the enlarged dialog shows the same file: one
   * document open at a time, not two copies of one.
   */
  const [wellRef, wellSeen] = useSeenOnce<HTMLDivElement>()
  const showInlinePdf = wellSeen && !isLargePreviewOpen
  /**
   * The well hands its whole area to a viewer that scrolls and zooms itself —
   * pdf.js, the IFC viewport — instead of padding and scrolling it a second
   * time. In the peek that is what lets a PDF's pages sit directly on the
   * stage with their controls floating over them, rather than a bordered
   * scroller boxed inside a padded box.
   */
  const pdfInWell = canPreview && Boolean(previewUrl) && shownType === 'application/pdf'
  // A Skizze Piloti filed: its one sheet carries marks pinned to its elements, and its review is the sketch editor.
  const sketchInWell = canPreview && Boolean(previewUrl) && shownType === 'image/svg+xml' && file.authoredBy === 'agent'
  const wellHostsViewer = peeking && (isModel || pdfInWell)
  /**
   * The document's Anmerkungen and its room: who else has it open, their pointers, and Piloti's
   * proposals landing. Only where the well IS the PDF viewer or a Skizze's sheet (a mark needs a page
   * under it), and never for a held upload, which nobody but its reviewers reads. One instance for
   * the inline preview and the focused review (or the sketch editor), so the tab is in the room once.
   */
  const reviewEnabled = (pdfInWell || sketchInWell) && showMetadataPanel && !isHeld
  // Where the document stands among its Fassungen under other names, as the
  // reader may see them: the review says it, and lists the open marks of the
  // documents this one replaces to carry them on.
  const replacedBy = file.revision?.supersededBy ?? null
  const replaces = file.revision?.supersedes
  const reviewRevision = useMemo(() => ({ replacedBy, replaces: replaces ?? [] }), [replacedBy, replaces])
  const review = useDocumentReview(file.id, {
    enabled: reviewEnabled,
    viewerUserId,
    revision: reviewRevision,
    // Piloti on the canvas. Over the chat (the pane is its peek) a question is
    // a turn of the chat's own conversation, through its driver, so closing
    // the review finds it in the transcript; elsewhere it goes into the
    // document's own conversation (`use-canvas-ask.ts`).
    piloti: {
      projectId: scope === 'officeShelf' ? null : projectId,
      fileName: file.filename,
      versionState: file.versionState ?? null,
      shelf: 'project',
      chatHosted: inChat,
    },
  })
  const liveMarks = review.annotations.filter(isLive).length
  /**
   * The row behind the pane says what the review says: once the list is read,
   * and whenever a decision changes it, the tally goes to the listing in the
   * shape the server sends (`marks`, `null` with nothing live). „für Sie“ is
   * the review's own „Für Sie“ count (`tabCounts`, `isForReader`). Only a
   * tally the row does not already hold is sent.
   */
  const marksForYou = useMemo(
    () => tabCounts(review.annotations, { on: true, me: review.me }).open,
    [review.annotations, review.me]
  )
  const shownMarks = file.marks ?? null
  useEffect(() => {
    if (!reviewEnabled || review.load !== 'ready' || !onMarksChanged) return
    const { open, proposed } = review.counts
    const tally: MarkTally | null = open + proposed > 0 ? { open, proposed, forYou: marksForYou } : null
    const same =
      tally === null
        ? shownMarks === null
        : shownMarks !== null &&
          shownMarks.open === tally.open &&
          shownMarks.proposed === tally.proposed &&
          shownMarks.forYou === tally.forYou
    if (!same) onMarksChanged(file.id, tally)
  }, [reviewEnabled, review.load, review.counts, marksForYou, shownMarks, onMarksChanged, file.id])
  const [reviewOpen, setReviewOpen] = useState(false)
  /**
   * The inline viewer steps aside while the review is open, as it does for the enlarged dialog: the review is
   * the document full screen, and a second viewer under it redrew the same pages, marks and pointers for nobody.
   */
  const inlineViewer = showInlinePdf && !reviewOpen
  /**
   * The page the reader was on in the review: once it closes, the inline
   * viewer (mounted afresh) opens there, not at the first page.
   */
  const reviewPage = useRef<number | null>(null)
  const onReviewPage = useCallback((page: number) => {
    reviewPage.current = page
  }, [])
  const reviewWasOpen = useRef(false)
  useEffect(() => {
    const was = reviewWasOpen.current
    reviewWasOpen.current = reviewOpen
    if (reviewOpen) {
      if (!was) reviewPage.current = null
      return
    }
    const page = reviewPage.current
    reviewPage.current = null
    if (was && page !== null) setShownPage(page)
  }, [reviewOpen])
  const [reviewFocus, setReviewFocus] = useState<{ annotationId: string | null; page: number | null; key: number } | null>(null)
  /** The tool the review opens with: the point, from „Anmerken". */
  const [reviewTool, setReviewTool] = useState<ReviewLinkTool | null>(null)
  const { setTool: setReviewToolInHand } = review
  /** Open the review's state, at a mark (or a page) and with a tool when given; the URL is the callers'. */
  const showReview = useCallback(
    (annotationId?: string | null, tool?: ReviewLinkTool | null, page: number | null = null) => {
      setReviewFocus(annotationId || page ? { annotationId: annotationId ?? null, page, key: Date.now() } : null)
      setReviewTool(tool ?? null)
      if (tool) setReviewToolInHand(tool)
      setReviewOpen(true)
    },
    [setReviewToolInHand]
  )
  const router = useRouter()
  const searchParams = useSearchParams()
  const pathname = usePathname()
  /**
   * THE REVIEW HAS AN ADDRESS while it is open: `review=1`, with `mark` and
   * `tool` following the selection and the tool in hand
   * (`lib/open-review.ts`). A reload stays in it, Back leaves it, and a
   * bookmark or a copied link comes back to it. Opening from here pushes, so
   * Back closes; what follows replaces, so walking the marks is one entry.
   * A link this pane did not push is taken off on closing, or, when it came
   * from another page and says so (`back`: Offene Punkte, the Postfach),
   * closing returns there.
   *
   * In the chat the pane is the peek, and `doc` there means „a new chat about
   * this file" (`project-chat-client.tsx`): the review of the peeked document
   * is `review`, `mark` and `tool` alone, and this pane writes no `doc`.
   */
  const reviewLink = readReviewParams(searchParams)
  /**
   * The place a link opened this document at (`?page=` and `?highlight=`,
   * `lib/document-locus.ts`): a search hit's passage, handed to the viewer as
   * a citation's page and passage are. Read for the document `doc` names only.
   */
  const linkedLocus = readDocumentLocus(searchParams, file.id)
  /** This page's address names this pane's document: Dateien's `doc`, or the chat's peek. Elsewhere the pane writes no address. */
  const addressed = reviewLink.documentId === file.id || (reviewLink.documentId === null && inChat)
  const urlOpen = reviewLink.open && addressed && (pdfInWell || sketchInWell)
  /** This pane pushed the entry the review is on, so closing goes Back to the one before. */
  const pushedReview = useRef(false)
  const urlWasOpen = useRef(false)
  const reviewOpenRef = useRef(reviewOpen)
  useEffect(() => {
    reviewOpenRef.current = reviewOpen
  }, [reviewOpen])
  const replaceParams = useCallback(
    (params: URLSearchParams, how: 'push' | 'replace' = 'replace') => {
      const href = hrefWithParams(pathname ?? '', params)
      if (how === 'push') router.push(href, { scroll: false })
      else router.replace(href, { scroll: false })
    },
    [pathname, router]
  )
  // The address moved: a link arrived (or this pane's push landed), or Back took it away.
  useEffect(() => {
    const was = urlWasOpen.current
    urlWasOpen.current = urlOpen
    if (urlOpen && !was && !reviewOpenRef.current) showReview(reviewLink.annotationId, reviewLink.tool, linkedLocus.page)
    if (!urlOpen && was && reviewOpenRef.current) {
      pushedReview.current = false
      setReviewOpen(false)
      setReviewToolInHand('select')
    }
  }, [urlOpen, reviewLink.annotationId, reviewLink.tool, linkedLocus.page, showReview, setReviewToolInHand])
  /** Open the review from this pane: its state, and its address pushed. */
  const openReview = useCallback(
    (annotationId?: string, tool?: ReviewLinkTool) => {
      showReview(annotationId, tool)
      if (urlOpen || !addressed) return
      const params = setReviewParams(
        new URLSearchParams(searchParams?.toString() ?? ''),
        { documentId: file.id, annotationId, tool },
        { withDocument: false }
      )
      pushedReview.current = true
      replaceParams(params, 'push')
    },
    [showReview, urlOpen, addressed, searchParams, file.id, replaceParams]
  )
  /**
   * What the approve confirm names before the signature: the open marks and
   * Piloti's untaken proposals, told apart, and the review to see them in. Until the review has read them, or when it
   * could not, the confirm says so: an unknown count is not a zero.
   */
  const openMarks = useMemo((): OpenMarksAtApproval | null => {
    if (!reviewEnabled) return null
    const onOpen = () => openReview()
    if (review.load === 'ready') {
      return { status: 'counted', open: review.counts.open, proposed: review.counts.proposed, onOpen }
    }
    return review.load === 'loading' ? { status: 'loading' } : { status: 'unavailable', onOpen }
  }, [reviewEnabled, review.load, review.counts.open, review.counts.proposed, openReview])
  // While open, the address follows the mark selected and the tool in hand.
  const linkTool: ReviewLinkTool | null = review.tool === 'point' || review.tool === 'region' ? review.tool : null
  useEffect(() => {
    if (!reviewOpen || !urlOpen) return
    if (reviewLink.annotationId === review.selectedId && reviewLink.tool === linkTool) return
    // A link's mark waits for the list: the review opens at it once it is read.
    if (review.load !== 'ready' && reviewLink.annotationId && !review.selectedId) return
    replaceParams(
      setReviewParams(
        new URLSearchParams(searchParams?.toString() ?? ''),
        { documentId: file.id, annotationId: review.selectedId, tool: linkTool },
        { withDocument: false }
      )
    )
  }, [reviewOpen, urlOpen, reviewLink.annotationId, reviewLink.tool, review.selectedId, review.load, linkTool, searchParams, file.id, replaceParams])
  const onReviewOpenChange = useCallback(
    (open: boolean) => {
      if (open) return openReview()
      setReviewOpen(false)
      if (!urlOpen) return
      if (pushedReview.current) {
        pushedReview.current = false
        router.back()
        return
      }
      // A link from another page (Offene Punkte, the Postfach) says where it came from: closing goes there.
      // When that page, query and all, is the entry one step back in this tab (`backLandsOn`, read off
      // the tab's own history), Back is the way: a replace would leave the page in history twice, and a
      // sheet over it closes with Back. Otherwise (a new tab, a shared link, a review reached from
      // another review, no Navigation API) the entry behind is not that page, and this one is replaced.
      if (reviewLink.back) {
        if (backLandsOn(reviewLink.back)) router.back()
        else router.replace(reviewLink.back, { scroll: false })
        return
      }
      replaceParams(clearReviewParams(new URLSearchParams(searchParams?.toString() ?? '')))
    },
    [openReview, urlOpen, router, replaceParams, searchParams, reviewLink.back]
  )
  /** The review on its own, in a tab of its own: the document on its shelf, at the review. */
  const popoutHref =
    projectId && scope !== 'officeShelf' && typeof window !== 'undefined'
      ? new URL(reviewFilesHref(projectId, { documentId: file.id }), window.location.origin).toString()
      : undefined
  const { locale } = useLocale()
  // Who is here, read off the room by membership: a pointer moving does not re-render this pane.
  const company = useRoomCompany(review.room)
  const presenceNames = [...company.people.map((person) => person.name), ...(company.agent ? ['Piloti'] : [])]
  const presenceSentence =
    presenceNames.length > 0
      ? t('annotations.peopleHere', {
          count: presenceNames.length,
          names: new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(presenceNames),
        })
      : null
  /** „Anmerken" in the viewer's pill: the review, with the point in hand. */
  const annotateLead =
    reviewEnabled && review.load === 'ready' && review.canAnnotate && !reader ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <ToolbarTextButton
            className="text-foreground gap-1 px-2 [&_svg]:size-3.5"
            data-testid="inline-annotate"
            onClick={() => openReview(undefined, 'point')}
          >
            <MessageSquarePlus aria-hidden />
            {t('annotations.annotate')}
          </ToolbarTextButton>
        </TooltipTrigger>
        <TooltipContent side="top">{t('annotations.annotateHint')}</TooltipContent>
      </Tooltip>
    ) : undefined
  /**
   * The reader's way onto the marks, at the thumb beside Details: „Anmerken"
   * arms the point; with marks it says how many and opens them.
   */
  const readerAnnotate: ReaderAnnotate | null =
    reviewEnabled && review.load === 'ready' && (review.canAnnotate || liveMarks > 0)
      ? {
          label: liveMarks > 0 ? t('annotations.section') : t('annotations.annotate'),
          count: liveMarks,
          countLabel: t('annotations.readerCount', { count: liveMarks }),
          onClick: () => (liveMarks > 0 ? openReview() : openReview(undefined, 'point')),
        }
      : null

  useEffect(() => {
    loadPreview()
    // A different document (or an unmount) retires whatever was in flight.
    return () => previewRequest.current?.abort()
  }, [loadPreview])

  // Reset the detailed-info section when the selected document changes, so it
  // never shows a previous document's descriptions.
  useEffect(() => {
    setDetails(null)
    setDetailsFailed(false)
    // A turn still in flight belongs to the previous document.
    if (turnFrame.current !== null) cancelAnimationFrame(turnFrame.current)
    turnFrame.current = null
    setShownPage(null)
  }, [file.id])
  useEffect(
    () => () => {
      if (turnFrame.current !== null) cancelAnimationFrame(turnFrame.current)
    },
    [],
  )

  // An answer is about the document AS IT WAS when asked. Opened while it was
  // still being read, the section got an empty list and kept it for good, so
  // the descriptions indexing produced a minute later never appeared without
  // closing the file. What the answer depends on changing — the status, the
  // content types that decide there is anything visual at all — makes it
  // stale, and the effect below asks again.
  const detailsBasis = `${file.status ?? ''}|${(file.contentTypes ?? []).join(',')}`
  useEffect(() => {
    setDetails(null)
    setDetailsFailed(false)
  }, [detailsBasis])

  // Once per basis, and only for a document with visual content: a text-only
  // document has nothing to describe and costs no request. Cancelled on change
  // so a slow answer for the previous document, or basis, never lands.
  useEffect(() => {
    // Nothing to show them in when the metadata panel is off (the peek's
    // Details-less mount, a host that hides the rail): no request either.
    if (!showMetadataPanel || !hasVisualContent || details !== null) return
    let cancelled = false
    setDetailsLoading(true)
    fetch(`/api/documents/${file.id}/visual-details`)
      .then((r) => {
        if (!r.ok) throw new Error(`visual-details ${r.status}`)
        return r.json()
      })
      .then((data) => {
        if (!cancelled) setDetails(Array.isArray(data?.details) ? data.details : [])
      })
      .catch(() => {
        if (cancelled) return
        // An answer, so the effect does not ask again on its own; the retry
        // below is how the reader does.
        setDetails([])
        setDetailsFailed(true)
      })
      .finally(() => {
        if (!cancelled) setDetailsLoading(false)
      })
    return () => {
      cancelled = true
      setDetailsLoading(false)
    }
    // `detailsBasis` too: a change that lands while a request is in flight
    // retires that request rather than letting its older answer stand.
  }, [showMetadataPanel, hasVisualContent, details, file.id, detailsBasis])

  /** Turn the viewer to `page`, from the reading that describes it. */
  const showPage = useCallback((page: number) => {
    setPeekView('document')
    setShownPage('turning')
    if (turnFrame.current !== null) cancelAnimationFrame(turnFrame.current)
    turnFrame.current = requestAnimationFrame(() => {
      turnFrame.current = null
      setShownPage(page)
    })
  }, [])
  /**
   * Where Piloti's viewer action asked this document to be (ADR-0144): the
   * page turns the way a reading turns it, and the passage or the boxes are
   * marked there until the reader asks for another place.
   */
  const viewerTarget = useFilePreviewStore((state) => (state.viewerTarget?.fileId === file.id ? state.viewerTarget : null))
  const viewerTargetKey = viewerTarget?.key ?? null
  const viewerTargetPage = viewerTarget?.page ?? null
  useEffect(() => {
    if (viewerTargetKey !== null && viewerTargetPage !== null) showPage(viewerTargetPage)
  }, [viewerTargetKey, viewerTargetPage, showPage])
  const retryDetails = useCallback(() => {
    setDetailsFailed(false)
    setDetails(null)
  }, [])

  /**
   * The document's name and its download, from the shared hook — this pane
   * holds no request logic of its own any more.
   *
   * Download keeps a BUTTON of its own in the header (it is what most people
   * came to do with a document they are looking at) while rename and delete sit
   * in the menu beside it; offering download twice on one surface would be two
   * controls for one job. Renames and deletions are the menu's, and they reach
   * this pane the same way any other change does: the workspace updates the
   * document it passes in.
   */
  const handleDeleted = useCallback(
    (fileId: string) => {
      onDeleted?.(fileId)
      onClose?.()
    },
    [onDeleted, onClose]
  )
  // `onDeleted` for the held block's „Löschen", which deletes through this hook.
  const actions = useDocumentActions({ document: file, scope, onReingested, onDeleted: handleDeleted })

  // Re-dispatch a failed document to the ingest pipeline. The request itself
  // lives in `useDocumentActions` with rename/delete/download — one document
  // operation belongs in one place, and the actions MENU offers the same retry
  // now, on the card where the failure is actually read.
  const handleReingest = useCallback(() => void actions.reingest(), [actions])

  // „Im Büro behandelt" for a passage the reader selects: only in a document
  // Piloti has read (an unread one has no passages to compare), opened large
  // with the rail of similar passages beside it.
  const [similarAsk, setSimilarAsk] = useState<SimilarPassagesRequest | null>(null)
  const findSimilar = isCitable(file)
    ? ({ text, page }: { text: string; page: number }) =>
        setSimilarAsk({
          document: { kind: 'stored', documentId: file.id },
          passage: { text, page, cited: false },
          projectId: projectId ?? null,
        })
    : undefined

  return {
    Icon,
    actions,
    addressed,
    annotateLead,
    assigneeNames,
    canCollaborate,
    canExpandPreview,
    canManage,
    canPreview,
    closedProjectName,
    company,
    currentProject,
    details,
    detailsBasis,
    detailsFailed,
    detailsLoading,
    detailsOpen,
    detectedType,
    discussHint,
    file,
    fileFacts,
    findSimilar,
    handleDeleted,
    handlePdfFailed,
    handleReingest,
    hasOwnershipBlock,
    hasVisualContent,
    heldVerdict,
    inChat,
    indexedPending,
    indexedReady,
    inlineViewer,
    isFailed,
    isHeld,
    isImage,
    isLargePreviewOpen,
    isLoading,
    isModel,
    isOfficeRendition,
    isTextual,
    kind,
    lifecyclePermissions,
    linkTool,
    linkedLocus,
    liveMarks,
    loadPreview,
    locale,
    marksForYou,
    moveInSheet,
    onAssigneesChanged,
    onClose,
    onDeleted,
    onLifecycleChanged,
    onMarksChanged,
    onOpenDocument,
    onPhone,
    onReingested,
    onRenamed,
    onReviewOpenChange,
    onReviewPage,
    onRevisionChanged,
    onTagsUpdated,
    openMarks,
    openReview,
    pathname,
    pdfInWell,
    peekView,
    peeking,
    popoutHref,
    presenceNames,
    presenceSentence,
    presentation,
    previewFailed,
    previewGone,
    previewImageUrl,
    previewRequest,
    previewText,
    previewUrl,
    projectId,
    projectName,
    pushedReview,
    reader,
    readerAnnotate,
    renditionType,
    replaceParams,
    replacedBy,
    replaces,
    responsibleNames,
    retryDetails,
    review,
    reviewEnabled,
    reviewFocus,
    reviewLink,
    reviewOpen,
    reviewOpenRef,
    reviewPage,
    reviewRevision,
    reviewTool,
    reviewViewer,
    reviewWasOpen,
    revisionsShown,
    router,
    scope,
    searchParams,
    setDetails,
    setDetailsFailed,
    setDetailsLoading,
    setDetailsOpen,
    setIsLargePreviewOpen,
    setIsLoading,
    setPeekView,
    setPreviewFailed,
    setPreviewGone,
    setPreviewImageUrl,
    setPreviewText,
    setPreviewUrl,
    setRenditionType,
    setReviewFocus,
    setReviewOpen,
    setReviewTool,
    setReviewToolInHand,
    setShownFinding,
    setShownPage,
    setSimilarAsk,
    showIndexedHeading,
    showIndexedSection,
    showInlinePdf,
    showMetadataPanel,
    showModels,
    sketchInWell,
    showPage,
    showReview,
    shownFinding,
    shownMarks,
    shownPage,
    shownType,
    sideways,
    similarAsk,
    storeFileId,
    storeMode,
    t,
    turnFrame,
    urlOpen,
    urlWasOpen,
    viewerTarget,
    viewerTargetKey,
    viewerTargetPage,
    viewerUserId,
    wellHostsViewer,
    wellRef,
    wellSeen,
  }
}

export type FilePreviewController = ReturnType<typeof useFilePreviewController>
