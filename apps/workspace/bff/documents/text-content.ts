/**
 * Whether a version's bytes are text a model can rewrite: the question every
 * path that assumes text asks first (revise from comment, the revision task,
 * the text compare).
 *
 * Those paths hand the bytes to a model or a diff as a string and, for a
 * revision, write the model's Markdown back as the version's new bytes
 * (`renderVersionBytes`). For a Skizze (`image/svg+xml`, its scene inside) that
 * stored a Markdown report as the drawing: the preview broke, the editor
 * refused to open it and every pinned mark was stranded. So a type that is not
 * text is refused by name (`not_revisable_as_text`), and the UI does not offer
 * the action. A Skizze is revised in its editor (ADR-0148), and compared by its
 * outline (`lib/diagrams/sketch-outline-text.ts`).
 *
 * No `server-only`: the review controls ask the same question before they draw
 * „Piloti überarbeiten lassen“.
 */

import { ApiError } from '@/lib/api/api-error'

/** The non-`text/*` types whose bytes are text all the same. */
const TEXT_APPLICATION_TYPES: ReadonlySet<string> = new Set(['application/json'])

/** The refusal's reason, for a client to tell it apart. */
export const NOT_REVISABLE_AS_TEXT = 'not_revisable_as_text'

/**
 * True for `text/*` and the few application types that are text. A version
 * with no stored type predates the column and was a Markdown draft, the only
 * kind that had versions then.
 */
export function revisableAsText(contentType: string | null | undefined): boolean {
  if (contentType == null || contentType.trim() === '') return true
  const type = contentType.split(';')[0].trim().toLowerCase()
  return type.startsWith('text/') || TEXT_APPLICATION_TYPES.has(type)
}

/** The 415 a text path answers for bytes that are not text, naming the type and the way that works. */
export function notRevisableAsText(contentType: string | null | undefined): ApiError {
  return new ApiError(
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    `This version is ${contentType ?? 'not text'}, not text: it cannot be revised or compared as text. ` +
      'A sketch is revised in its editor (document-sketch-update).',
    { reason: NOT_REVISABLE_AS_TEXT, contentType: contentType ?? null }
  )
}
