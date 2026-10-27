/**
 * SourcePreview (WS-9, spec §6 / backlog FB-4) — clicking a citation/source
 * chip opens a preview of the source instead of doing nothing.
 *
 * Behavior by resolved target (see `resolveCitationTarget`):
 *  - `url`      — Web chips keep linking out to the real source.
 *  - `ris`      — an Austrian RIS source opens the in-app reader
 *                 (`RisDocumentDialog`), with the authoritative RIS link kept in
 *                 its header. It used to link out like any web source, which
 *                 took the reader out of the answer to check it (#622).
 *  - `download` — a stored document with no in-app viewer (.dwg, .ifc, .zip).
 *                 The file is offered and the reason is stated; it is NOT the
 *                 same answer as `info` (#623).
 *  - `document` — knowledge-layer citations that resolve to a project upload
 *                 or a base-corpus PDF open the EXISTING PdfViewerDialog
 *                 (presigned preview URL for project docs, the corpus stream
 *                 route for base docs), with a provenance-tinted header chip
 *                 and the cited passage ("Fundstelle") when one exists. An
 *                 office file opens on its PDF rendition (ADR-0070), says so
 *                 in the header, and keeps a download of the ORIGINAL there;
 *                 when the BFF cannot render one (415 disabled, 502 failed) the
 *                 chip falls back to the `download` behaviour.
 *  - `info`     — unresolvable citations get a light popover (origin, title,
 *                 snippet) — never a broken viewer. Chips with nothing beyond
 *                 their label stay plain, non-interactive chips.
 *
 * Resolution data is fetched lazily and cached for the lifetime of the page:
 * the cited document's project and Archiv rows BY NAME
 * (`POST /api/documents/by-name`, `POST /api/office-shelf/documents/by-name`, batched
 * across the chips of one render — the listings are paged, and a citation of a
 * plan older than their first page used to resolve to nothing), plus this
 * conversation's attachments (`/api/session/documents?conversationId=…`) and
 * the base-corpus file list (`/api/knowledge-base`), per project+conversation.
 *
 * This file is the entry, `SourcePreviewChip`; its parts live in
 * `source-preview/`, one file per concept: the face, each target's chip, the
 * citation viewer and its rail, the standalone dialog, the index and the hooks.
 */

'use client'

import { useState, type FC, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SourceSignalChip, SourceSignalChipLink } from '@/features/layout/components/SourceSignalChip'
import { useChatStore } from '../store'
import { isPrecedent } from '../lib/precedent'
import {
  citationNumbers,
  citedFileName,
  resolveCitationTarget,
  type CitationRef,
  type CitationTarget,
} from '../lib/citations'
import { AuthorityTag } from './AuthorityTag'
import {
  CitationFace,
  CitationIndex,
  faceClasses,
  faceStyle,
  inertCardClasses,
  type CitationDetail,
  type CitationVariant,
} from './source-preview/citation-face'
import { citationLabel, documentProjectId } from './source-preview/citation-label'
import { asDownloadTarget } from './source-preview/document-target'
import { useConversationId, useSourcePreviewIndex } from './source-preview/use-source-preview-index'
import { DocumentPreviewChip } from './source-preview/document-preview-chip'
import { DownloadPreviewChip } from './source-preview/download-preview-chip'
import { InfoPreviewChip } from './source-preview/info-preview-chip'
import { RisPreviewChip } from './source-preview/ris-preview-chip'

// ---------------------------------------------------------------------------
// The chip — one answer source, rendered by its resolved target
// ---------------------------------------------------------------------------

export interface SourcePreviewChipProps {
  /**
   * What this chip stands for: a document, optionally narrowed to one locus.
   *
   * Everything the chip renders — label, tint, authority badge, `[N]`, preview
   * target — comes from here. It is deliberately the ONLY source prop: the
   * component used to take a ref, a signal and a row object that each carried
   * part of the answer, and keeping them in step was left to every call site.
   */
  citation: CitationRef
  /**
   * Cited page / host, localized by the caller — shown in the popover, never on
   * the chip (which stays the compact pill it always was).
   */
  meta?: string
  /** Layout override (width, truncation) for the caller's context. */
  className?: string
  /**
   * Layout shape. `chip` is the compact "Belegt durch" pill; `card` is the
   * full-width list row (the Herleitung source cards). Behaviour —
   * tint, authority badge, target resolution, click — is identical in both.
   */
  variant?: CitationVariant
  /**
   * Card layout only: quiet metadata pinned right of the title (the source
   * list's cited marker + timestamp), rendered inside the card.
   */
  trailing?: ReactNode
  /**
   * Card layout only: how much chrome to print around the name. Defaults to
   * `full`; see {@link CitationDetail}.
   */
  detail?: CitationDetail
  /**
   * The project the cited file is looked up in, for a surface that is not the
   * chat (the Projekterfassung cites the project's own documents and has no
   * conversation to read it from). Unset, it is the chat's project.
   */
  projectId?: string | null
  /** The chip's text where the document's name alone is not the point (name and page). Unset, the document's label. */
  label?: string
}


/**
 * One citation with its preview affordance. Web/RIS chips link out; document
 * chips open the viewer at the locus's page when the document resolves to a
 * project upload, an Archiv document or a base-corpus PDF; anything
 * unresolvable degrades to an info popover, never a broken viewer.
 */
export const SourcePreviewChip: FC<SourcePreviewChipProps> = ({
  citation,
  className,
  meta,
  variant = 'chip',
  trailing,
  detail = 'full',
  projectId: projectIdOverride,
  label: labelOverride,
}) => {
  const chatProjectId = useChatStore((s) => s.projectId)
  const projectId = projectIdOverride === undefined ? chatProjectId : projectIdOverride
  const conversationId = useConversationId()
  const { document: doc, locus } = citation
  // Only a document with a filename and no outbound link can resolve to a
  // stored file, so the index fetch is skipped entirely for link sources AND
  // for card-derived documents, which name a law but no document at all.
  const needsIndex = !doc.url && !!doc.fileName
  const previewIndex = useSourcePreviewIndex(
    documentProjectId(doc, projectId),
    conversationId,
    needsIndex,
    citedFileName(doc)
  )
  // The stored document whose office rendition the BFF refused (415/502). Only
  // the preview route can say so, so it is learned on the first open, and from
  // then on this chip is the download it would have been before ADR-0070.
  const [unrenderableId, setUnrenderableId] = useState<string | null>(null)

  const resolved = resolveCitationTarget(doc, {
    locus,
    storedDocuments: previewIndex?.storedDocuments,
    baseCorpusFiles: previewIndex?.baseCorpusFiles,
  })
  const target: CitationTarget =
    resolved.kind === 'document' &&
    resolved.document.type === 'stored' &&
    resolved.document.id === unrenderableId
      ? (asDownloadTarget(resolved) ?? resolved)
      : resolved

  const label = labelOverride ?? citationLabel(doc)
  const precedent = isPrecedent(doc, projectId)
  // A chip stands for a DOCUMENT, so it names every marker that document
  // carries — "2, 7", not an arbitrary one of them. A chip narrowed to a locus
  // names only that locus's marker.
  const numbers = locus
    ? [locus.number].filter((n): n is number => n != null)
    : citationNumbers(doc)
  const index = numbers.length > 0 ? numbers.join(', ') : undefined
  const shared = {
    signal: doc.tint,
    label,
    authority: doc.authority,
    className,
    index,
    variant,
    citation,
    trailing,
    detail,
    kind: doc.kind,
    precedent,
  }

  if (target.kind === 'url') {
    // A URL source keeps linking out — that is what a web/RIS chip has always
    // done and what makes it feel like a link. It only opens the popover when
    // the click genuinely adds something the link cannot: the "does this bind
    // me?" note or the authority tier of a legal source.
    if (doc.bindingNote || doc.laneLabel) {
      return (
        <InfoPreviewChip
          {...shared}
          target={{ kind: 'info', title: label }}
          tier={doc.laneLabel}
          bindingNote={doc.bindingNote}
          url={target.url}
          meta={meta}
        />
      )
    }
    if (variant === 'card') {
      return (
        <a
          href={target.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(faceClasses(variant), className)}
          style={faceStyle(variant, doc.tint)}
          title={target.url}
        >
          <CitationFace {...shared} />
        </a>
      )
    }
    return (
      <SourceSignalChipLink
        signal={doc.tint}
        href={target.url}
        // `rounded-md` overrides the signal chip's pill: in the answer's source
        // row a web source sits beside a document source, and only the shape
        // differed — one capsule, one rounded rectangle, for two things that
        // are the same kind of thing. The chip keeps its pill everywhere it is
        // used as a label; as a CITATION it wears the citation silhouette.
        className={cn('max-w-56 rounded-md', className)}
      >
        <CitationIndex index={index} />
        {doc.authority && <AuthorityTag>{doc.authority}</AuthorityTag>}
        {label}
      </SourceSignalChipLink>
    )
  }

  // RIS is read INSIDE Piloti now (#622) — the outbound link moves into the
  // reader's header rather than being the only way in.
  if (target.kind === 'ris') {
    return <RisPreviewChip {...shared} target={target} />
  }

  if (target.kind === 'document') {
    const storedId = target.document.type === 'stored' ? target.document.id : null
    return (
      <DocumentPreviewChip
        {...shared}
        target={target}
        onUnrenderable={storedId ? () => setUnrenderableId(storedId) : undefined}
      />
    )
  }

  // Resolved, and unrenderable. Not the same as unresolvable — see the
  // `download` variant on `CitationTarget`.
  if (target.kind === 'download') {
    return (
      <DownloadPreviewChip
        {...shared}
        target={target}
        tier={doc.laneLabel}
        bindingNote={doc.bindingNote}
        meta={meta}
      />
    )
  }

  // Resolution is still in flight: this document MAY yet turn out to be
  // openable, so committing to the info popover now would settle the chip into
  // the weaker affordance and never upgrade it. Render the inert chip until the
  // index answers.
  const resolving = needsIndex && !previewIndex

  // Info target: interactive when the popover adds something beyond the chip
  // label. A real source always does — at minimum it offers a citation to copy,
  // which is the whole reason the popover exists. A card-derived document (a law
  // name with no document, no link and no retrieved passage) has nothing more to
  // show and stays a plain chip rather than promising a preview it cannot give.
  const canCite = !!doc.fileName || !!doc.url || doc.loci.length > 0
  const hasPopoverContent =
    !resolving &&
    (canCite || !!target.snippet || !!doc.laneLabel || !!doc.bindingNote || !!meta || !!index)
  if (hasPopoverContent) {
    return (
      <InfoPreviewChip
        {...shared}
        target={target}
        tier={doc.laneLabel}
        bindingNote={doc.bindingNote}
        meta={meta}
      />
    )
  }

  if (variant === 'card') {
    return (
      <div className={cn(inertCardClasses, className)} style={faceStyle(variant, doc.tint)}>
        <CitationFace {...shared} />
      </div>
    )
  }

  return (
    <SourceSignalChip signal={doc.tint} className={cn('max-w-56', className)}>
      <CitationIndex index={index} />
      {doc.authority && <AuthorityTag>{doc.authority}</AuthorityTag>}
      {label}
    </SourceSignalChip>
  )
}
