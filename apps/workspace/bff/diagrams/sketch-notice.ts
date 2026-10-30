/**
 * Which line a Skizze's filed SVG and PDF carry (S6 review, finding 5): who
 * drew it, read from the producer of its first drawing, never assumed.
 *
 *   - Piloti drew it in an answer: `markingEdited`, „Von Piloti entworfen, von
 *     einer Person bearbeitet“, and the AI marking (`AIGenerated=true`).
 *   - A person started it on a page (`person-sketch-` reference,
 *     `lib/documents/generated.ts`): `markingPerson`, „Von einer Person …
 *     gezeichnet“, and `AIGenerated=false`, until an agent's edit is applied
 *     to it; from then on `markingPersonEdited` and the AI marking, kept by
 *     every later save because the stored bytes say so ({@link aiDrewOn}).
 */

import { AI_PROVENANCE_PROPERTIES } from '@/lib/ai-provenance'
import { isPersonSketchRef } from '@/lib/documents/document-authors'

/** The three lines, in one locale. */
export interface SketchNotices {
  edited: string
  person: string
  personEdited: string
}

export const sketchNoticesOf = (messages: { markingEdited: string; markingPerson: string; markingPersonEdited: string }): SketchNotices => ({
  edited: messages.markingEdited,
  person: messages.markingPerson,
  personEdited: messages.markingPersonEdited,
})

/** Whether stored bytes of a Skizze carry the AI marking: a model has drawn on it. */
export const aiDrewOn = (text: string): boolean => text.includes(`${AI_PROVENANCE_PROPERTIES.generated}=true`)

/** The line for a save, and whether its machine marking is the AI one. */
export function sketchNoticeFor(ref: string, notices: SketchNotices, aiAssisted: boolean): { notice: string; aiAssisted: boolean } {
  if (!isPersonSketchRef(ref)) return { notice: notices.edited, aiAssisted: true }
  return aiAssisted ? { notice: notices.personEdited, aiAssisted: true } : { notice: notices.person, aiAssisted: false }
}
