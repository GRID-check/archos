'use client'

/**
 * Open a document's Prüfansicht at one mark, over the conversation, without
 * leaving it.
 *
 * ## The one way in
 *
 * The file preview pane already answers a link into the review: `review=1`
 * and `mark=<annotationId>` (and `tool`) open the full-screen review at that
 * mark once the pane shows the document as a PDF. The pane keeps them in the
 * URL while the review is open, `mark` and `tool` following the selection and
 * the tool in hand, and takes them off when it closes (`file-preview-pane.tsx`),
 * so a reload stays in the review and Back leaves it. So this adds no second
 * channel into the canvas. It puts the document in the pane the chat already
 * has beside it (the preview store, the way a citation opens one) and writes
 * those params onto the CURRENT url with `router.replace`: the session, the
 * scroll and the composer stay as they were.
 *
 * Closing the review is the review's own Escape or ✕, or Back. The params go,
 * the document stays in the peek beside the chat, and the conversation is
 * where it was.
 *
 * ## No `doc` on the chat
 *
 * On the project chat `?doc=` is the subject of an Ask Piloti link (a new chat
 * about that file, `project-chat-client.tsx`), so the chat's review link never
 * carries it: the pane in the peek takes `review` and `mark` for the document
 * it shows, which is the one this helper just put there.
 *
 * ## Off the chat
 *
 * A surface with no pane beside it (the card gallery, a report) goes to the
 * project's Dateien with `doc`, `review` and `mark`, whose modal pane answers
 * them the same way.
 *
 * ## Back to where the link was
 *
 * A link from another page (Offene Punkte, the Postfach) lands in Dateien. The
 * pane did not push that entry, so it cannot go Back to leave it: it could be
 * the tab's first page. Such a link carries `back`, the page it came from
 * with its filters ({@link appReturnPath}: a path of this app, nothing else),
 * and closing the review goes there instead of leaving the reader in Dateien.
 * A plain document link carries it the same way (a search hit, {@link withBack}):
 * closing the preview, not only the review, returns to the page it came from
 * (`hooks/use-preview-channel.ts`).
 */

import { appReturnPath } from '@/lib/utils/same-origin-path'
import { useFilePreviewStore } from '../stores/file-preview-store'
import { openFiledDocument } from './open-filed-document'
import { documentFilesHref } from './document-question'

export const REVIEW_PARAM = 'review'
export const MARK_PARAM = 'mark'
export const DOC_PARAM = 'doc'
/** The tool in hand when the review opens: „Anmerken" arms the point. */
export const TOOL_PARAM = 'tool'
/** Where closing the review returns to, for a link from another page of the app. */
export const BACK_PARAM = 'back'

/** The tools a link may arm: the ones that set a mark. Selecting is the review's own start. */
export type ReviewLinkTool = 'point' | 'region'
const isReviewLinkTool = (value: string | null | undefined): value is ReviewLinkTool =>
  value === 'point' || value === 'region'

export interface ReviewTarget {
  documentId: string
  /** The mark to open the review at; absent opens the review at its start. */
  annotationId?: string | null
  /** A tool to have in hand when the review opens. */
  tool?: ReviewLinkTool | null
}

/** What a page's params say about the review: open, at which mark, with which tool. */
export interface ReviewParams {
  /** The document `doc` names, where the page names one. */
  documentId: string | null
  open: boolean
  annotationId: string | null
  tool: ReviewLinkTool | null
  /** The page the link came from, to return to on closing; only a path of this app ({@link appReturnPath}). */
  back: string | null
}

/** Read the review off a page's params. A `mark`, `tool` or `back` without `review` opens nothing. */
export function readReviewParams(params: Pick<URLSearchParams, 'get'> | null | undefined): ReviewParams {
  const open = Boolean(params?.get(REVIEW_PARAM))
  const tool = params?.get(TOOL_PARAM)
  return {
    documentId: params?.get(DOC_PARAM) || null,
    open,
    annotationId: open ? params?.get(MARK_PARAM) || null : null,
    tool: open && isReviewLinkTool(tool) ? tool : null,
    back: open ? appReturnPath(params?.get(BACK_PARAM)) : null,
  }
}

/** Take the review off `params` (mutates it). `doc` stays: the document is still open. */
export function clearReviewParams(params: URLSearchParams): URLSearchParams {
  params.delete(REVIEW_PARAM)
  params.delete(MARK_PARAM)
  params.delete(TOOL_PARAM)
  params.delete(BACK_PARAM)
  return params
}

/** `pathname` with `params`, without a dangling `?`. */
export const hrefWithParams = (pathname: string, params: URLSearchParams): string => {
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

/** Where a review link points: `pathname`, `search` and `hash` of a URL. */
export type ReviewLocation = Pick<Location, 'pathname' | 'search' | 'hash'>

/** Set the review's params on `params` (mutates it); `doc` only where the page needs to be told which file. */
export function setReviewParams(
  params: URLSearchParams,
  target: ReviewTarget,
  { withDocument }: { withDocument: boolean }
): URLSearchParams {
  if (withDocument) params.set(DOC_PARAM, target.documentId)
  params.set(REVIEW_PARAM, '1')
  if (target.annotationId) params.set(MARK_PARAM, target.annotationId)
  else params.delete(MARK_PARAM)
  if (target.tool) params.set(TOOL_PARAM, target.tool)
  else params.delete(TOOL_PARAM)
  return params
}

/**
 * The page's own URL with the review link on it: `review` and `mark`, and
 * every other param and the hash kept, so what is on screen stays on screen.
 * The chat's link carries no `doc` (see the module comment); a shelf's
 * listing (Dateien, the Archiv) names the document with `withDocument`, and
 * its `?doc=` sync opens it with the review.
 */
export function reviewHrefAt(
  location: ReviewLocation,
  target: ReviewTarget,
  { withDocument = false }: { withDocument?: boolean } = {}
): string {
  const params = setReviewParams(new URLSearchParams(location.search), target, { withDocument })
  return `${location.pathname}?${params.toString()}${location.hash}`
}

/**
 * The review link into a project's Dateien, for a surface with no pane of its
 * own. `back`: the page the link is on, with its filters, where closing the
 * review returns (a path outside the app is dropped).
 */
export function reviewFilesHref(projectId: string, target: ReviewTarget, { back }: { back?: string | null } = {}): string {
  const base = documentFilesHref(projectId, target.documentId)
  const [path, search = ''] = base.split('?')
  const params = setReviewParams(new URLSearchParams(search), target, { withDocument: true })
  return withReviewBack(`${path}?${params.toString()}`, back)
}

/**
 * `href` with `back` on it, so closing what it opens (the preview, or the
 * review) returns to `back`; a `back` outside the app leaves `href` unchanged.
 * Every other param and the hash are kept, `page` and `highlight` among them.
 */
export function withBack(href: string, back: string | null | undefined): string {
  return withBackWhen(href, back, () => true)
}

/**
 * A review link (`review=1`) with `back` on it, so closing the review returns
 * to `back`; anything else, or a `back` outside the app, comes back unchanged.
 * For a link built elsewhere, such as a Postfach row's.
 */
export function withReviewBack(href: string, back: string | null | undefined): string {
  return withBackWhen(href, back, (params) => Boolean(params.get(REVIEW_PARAM)))
}

function withBackWhen(href: string, back: string | null | undefined, applies: (params: URLSearchParams) => boolean): string {
  const path = appReturnPath(back)
  const [base, hash = ''] = href.split('#')
  const [pathname, search = ''] = base.split('?')
  const params = new URLSearchParams(search)
  if (!path || !applies(params)) return href
  params.set(BACK_PARAM, path)
  return `${pathname}?${params.toString()}${hash ? `#${hash}` : ''}`
}

/**
 * The page a document link came from, to return to when its preview closes:
 * only a path of this app ({@link appReturnPath}), and only beside the `doc`
 * it was written for. The review's own `back` is {@link readReviewParams}'.
 */
export function readDocumentBack(params: Pick<URLSearchParams, 'get'> | null | undefined): string | null {
  if (!params?.get(DOC_PARAM)) return null
  return appReturnPath(params.get(BACK_PARAM))
}

/** Whether a pathname is a project's chat, which keeps the file pane beside the conversation. */
export const isProjectChatPath = (pathname: string): boolean => /^\/app\/projects\/[^/]+\/chat\/?$/.test(pathname)

export interface DocumentBesideOptions {
  projectId: string
  projectName?: string | null
  canCollaborate?: boolean
}

/**
 * Put a document in the pane beside the chat, unless it is there already.
 * `false` when the document could not be read (gone, or not the reader's).
 *
 * The composer's subject is left alone: looking at a mark is not asking about
 * the document, and the conversation that holds the card already has its own.
 */
export async function showDocumentBeside(documentId: string, options: DocumentBesideOptions): Promise<boolean> {
  const preview = useFilePreviewStore.getState()
  if (preview.file?.id === documentId) {
    if (preview.hidden || preview.mode === 'modal') preview.peek()
    return true
  }
  return openFiledDocument({
    documentId,
    projectId: options.projectId,
    projectName: options.projectName,
    canCollaborate: options.canCollaborate,
  })
}

export interface OpenReviewOptions extends DocumentBesideOptions {
  /** `router.replace` on the chat (the link only addresses the pane), `router.push` to Dateien. */
  navigate: (href: string, how: 'replace' | 'push') => void
  /** The page the reader is on; defaults to `window.location`. */
  location?: ReviewLocation
}

/** How the review was opened: beside the chat, on the Dateien page, or not at all. */
export type OpenReviewResult = 'beside' | 'files' | 'unavailable'

/** Open the document's Prüfansicht at the mark, over whatever the reader is in. */
export async function openReviewAt(target: ReviewTarget, options: OpenReviewOptions): Promise<OpenReviewResult> {
  const location = options.location ?? window.location
  if (!isProjectChatPath(location.pathname)) {
    options.navigate(reviewFilesHref(options.projectId, target), 'push')
    return 'files'
  }
  if (!(await showDocumentBeside(target.documentId, options))) return 'unavailable'
  options.navigate(reviewHrefAt(location, target), 'replace')
  return 'beside'
}
