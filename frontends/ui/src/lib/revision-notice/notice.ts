/**
 * Piloti notices a new Fassung (ADR-0130): the pure half. Which pages it looks
 * at, what each change becomes as a proposed mark, and what it tells the person
 * in their thread and inbox. No I/O here, so every rule is tested without a
 * database or a model; `./job.ts` runs it.
 *
 * ## What a mark says, and what it never says
 *
 * A mark is a hint („Hinweis"), proposed, never open: it waits for a person to
 * take it over or dismiss it (`only_piloti_proposes`, migration 0138). Its body
 * is what the comparison saw, in its own words, and its basis names where it
 * came from: a picture comparison with the older Fassung on one page. Neither
 * says whether the change is allowed. A reading of two pictures is not a
 * finding about the law, and the words say so.
 */

import { v5 as uuidv5 } from 'uuid'
import { MAX_ANNOTATION_BASIS, MAX_ANNOTATION_BODY, MAX_PROPOSALS_PER_CALL, type AnnotationProposal } from '@/lib/annotations/types'
import type { CompareRegion, RevisionVisualChanges } from '@/lib/documents/revision-compare-types'

/** Pages one notice may look at, unless the deployment says otherwise: one vision call each. */
export const DEFAULT_MAX_PAGES = 3
/** The most pages a deployment may let one notice look at. */
export const MAX_PAGES_CEILING = 10
/** How long a notice waits after the Fassung is announced, so a burst of re-reads and relinks settles. */
export const DEFAULT_DELAY_SECONDS = 120
const MAX_DELAY_SECONDS = 3600

/** The id of one notice: the pair it compares. Also its job id, so a pair is noticed once. */
export function revisionNoticeId(newerId: string, olderId: string): string {
  return uuidv5(`grid:revision-notice:${newerId}:${olderId}`, uuidv5.URL)
}

/** The id of the message the notice writes into the person's thread: derived, so a retry writes nothing new. */
export function revisionNoticeMessageId(noticeId: string): string {
  return uuidv5(`grid:revision-notice-message:${noticeId}`, uuidv5.URL)
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** `GRID_REVISION_NOTICE_MAX_PAGES`: the cost cap of one notice, in vision calls. */
export function maxNoticePages(env: Record<string, string | undefined> = process.env): number {
  return boundedInt(env.GRID_REVISION_NOTICE_MAX_PAGES, DEFAULT_MAX_PAGES, 1, MAX_PAGES_CEILING)
}

/** `GRID_REVISION_NOTICE_DELAY_SECONDS`: the debounce before a notice runs. */
export function noticeDelaySeconds(env: Record<string, string | undefined> = process.env): number {
  return boundedInt(env.GRID_REVISION_NOTICE_DELAY_SECONDS, DEFAULT_DELAY_SECONDS, 0, MAX_DELAY_SECONDS)
}

/**
 * The pages to look at, and the changed pages left unlooked at. The index's
 * changed pages when it could compare the two; when neither Fassung has read
 * text or a drawing reading (a scan), nothing can be called unchanged, so the
 * first pages are looked at. Pure.
 */
export function pagesToCompare(
  changed: { pages: readonly number[]; newerPageCount: number; comparable: boolean },
  maxPages: number,
): { pages: number[]; skipped: number[] } {
  if (!changed.comparable) {
    const count = Math.max(1, Math.min(maxPages, changed.newerPageCount || maxPages))
    return { pages: Array.from({ length: count }, (_, index) => index + 1), skipped: [] }
  }
  const sorted = [...new Set(changed.pages)].sort((a, b) => a - b)
  return { pages: sorted.slice(0, maxPages), skipped: sorted.slice(maxPages) }
}

/** One page's comparison as the notice reads it. */
export interface PageComparison {
  page: number
  changes: RevisionVisualChanges
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

/**
 * The sentence for one box. The model is asked for one sentence per change, in
 * the order of its boxes, but nothing holds it to that: the sentence is used
 * only when there are exactly as many sentences as boxes, and the box's own
 * label otherwise.
 */
function sentenceFor(changes: RevisionVisualChanges, index: number): string | null {
  if (changes.summary.length !== changes.regions.length) return null
  return changes.summary[index]?.trim() || null
}

/** The body of the mark for one change: what moved, against which Fassung. */
export function markBody(region: CompareRegion, sentence: string | null, olderName: string): string {
  const label = region.label.trim().replace(/[.!]+$/, '')
  const said = sentence && sentence.toLowerCase() !== label.toLowerCase() ? ` ${sentence}` : ''
  return clip(`Geändert gegenüber „${clip(olderName, 120)}“: ${label}.${said}`, MAX_ANNOTATION_BODY)
}

/** Where the mark comes from, said so a reader weighs it: a picture comparison, not a check. */
export function markBasis(page: number, olderName: string): string {
  return clip(
    `Bildvergleich mit „${clip(olderName, 160)}“, S. ${page}; von Piloti ohne Auftrag vorgeschlagen, nicht geprüft`,
    MAX_ANNOTATION_BASIS,
  )
}

/** A mark already on the document, as the notice compares it. */
export interface ExistingMark {
  page: number
  x: number
  y: number
  w: number | null
  h: number | null
  body: string
  authorKind: string
}

const samePlace = (mark: ExistingMark, proposal: AnnotationProposal): boolean =>
  mark.authorKind === 'piloti' &&
  mark.page === proposal.page &&
  mark.body.trim() === proposal.body.trim() &&
  Math.abs(mark.x - proposal.x) < 1e-4 &&
  Math.abs(mark.y - proposal.y) < 1e-4 &&
  Math.abs((mark.w ?? 0) - (proposal.w ?? 0)) < 1e-4 &&
  Math.abs((mark.h ?? 0) - (proposal.h ?? 0)) < 1e-4

/**
 * The marks Piloti already proposed for ``found`` (a retried notice wrote them
 * before it failed), in ``found``'s order. They stand for the marks the retry
 * does not propose again, so its inbox row and its score count them. Pure.
 */
export function alreadyProposed<T extends ExistingMark>(
  found: readonly AnnotationProposal[],
  existing: readonly T[],
): T[] {
  const marks: T[] = []
  for (const proposal of found) {
    const mark = existing.find((candidate) => samePlace(candidate, proposal) && !marks.includes(candidate))
    if (mark) marks.push(mark)
  }
  return marks
}

/**
 * The proposed marks for what the pages showed, at most
 * {@link MAX_PROPOSALS_PER_CALL}, in page order. A change Piloti already
 * proposed in the same place with the same words (a retried notice) is not
 * proposed twice. Pure.
 */
export function proposalsFrom(
  comparisons: readonly PageComparison[],
  olderName: string,
  existing: readonly ExistingMark[] = [],
): AnnotationProposal[] {
  const proposals: AnnotationProposal[] = []
  for (const { page, changes } of [...comparisons].sort((a, b) => a.page - b.page)) {
    changes.regions.forEach((region, index) => {
      const proposal: AnnotationProposal = {
        page,
        shape: 'region',
        x: region.x,
        y: region.y,
        w: Math.min(region.w, 1 - region.x),
        h: Math.min(region.h, 1 - region.y),
        kind: 'hint',
        body: markBody(region, sentenceFor(changes, index), olderName),
        basis: markBasis(page, olderName),
      }
      if (!existing.some((mark) => samePlace(mark, proposal))) proposals.push(proposal)
    })
  }
  return proposals.slice(0, MAX_PROPOSALS_PER_CALL)
}

const pageList = (pages: readonly number[]): string =>
  pages.length === 1 ? `Seite ${pages[0]}` : `Seiten ${pages.join(', ')}`

/**
 * What Piloti writes into the person's thread about the document: what it
 * compared, what it proposed, what it did not look at, and what the marks are
 * not. German, because a person reads it. Pure.
 */
export function noticeMessage(input: {
  newerName: string
  olderName: string
  compared: readonly number[]
  skipped: readonly number[]
  proposals: readonly AnnotationProposal[]
}): string {
  const { proposals } = input
  const count = proposals.length === 1 ? 'Eine Stelle ist' : `${proposals.length} Stellen sind`
  const lines = [
    `Ich habe die neue Fassung „${input.newerName}“ mit „${input.olderName}“ verglichen (${pageList(input.compared)}). ${count} am Dokument als Vorschlag markiert, noch nicht übernommen:`,
    '',
    ...proposals.map((proposal, index) => `${index + 1}. S. ${proposal.page}: ${proposal.body}`),
  ]
  if (input.skipped.length > 0) {
    lines.push('', `Weitere geänderte ${pageList(input.skipped)} habe ich nicht angesehen; „Vergleichen“ im Dokument zeigt sie.`)
  }
  lines.push(
    '',
    'Grundlage ist ein Bildvergleich der beiden Fassungen, keine Prüfung gegen Vorschriften oder andere Unterlagen. Übernehmen oder verwerfen Sie die Vorschläge in der Prüfansicht.',
  )
  return lines.join('\n')
}

/** The first change, as the inbox row's excerpt. Pure. */
export function noticeExcerpt(proposals: readonly AnnotationProposal[]): string | null {
  const first = proposals[0]
  return first ? clip(`S. ${first.page}: ${first.body}`, 200) : null
}
