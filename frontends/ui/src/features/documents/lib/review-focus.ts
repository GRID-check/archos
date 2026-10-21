/**
 * The Fokusbereich of the document open over the chat: the box a person drew or
 * the mark they selected. The chat's own turns carry it as `focus_region`, the
 * field a canvas question uses (`canvas-turn-client.ts`), so "here" resolves to
 * the same place whichever box the question is typed in.
 */

import type { CanvasFocus } from '@/features/chat/lib/canvas-bridge'
import type { AnnotationView } from '@/lib/annotations/types'
import { regionAround } from '@/lib/annotations/types'
import type { ReviewDraft } from '../hooks/use-document-review'
import type { UseCanvasAskOptions } from '../hooks/use-canvas-ask'

/** The draft box if one is being placed, else the selected mark; null when neither is a place. */
export function reviewFocusOf({
  documentId,
  draft,
  selected,
  document,
}: {
  documentId: string
  draft: ReviewDraft | null
  selected: Pick<AnnotationView, 'page' | 'x' | 'y' | 'w' | 'h'> | null
  document: Pick<UseCanvasAskOptions, 'fileName' | 'versionId' | 'versionState' | 'shelf'> | null
}): CanvasFocus | null {
  const place = draft ?? selected
  if (!place) return null
  return {
    documentId,
    fileName: document?.fileName ?? null,
    versionId: document?.versionId ?? null,
    versionState: document?.versionState ?? null,
    shelf: document?.shelf ?? 'project',
    region: regionAround(place),
    replyInThread: false,
  }
}
