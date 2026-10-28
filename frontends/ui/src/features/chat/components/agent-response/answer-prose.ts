import { type CitedDocument } from '../../lib/citations'

/**
 * The first paragraph of a long answer, typeset as a lede.
 *
 * The agent is asked to lead with the ruling or the number. That rule is the
 * `<stimme>` section of the researcher's system prompt („Der erste Satz ist die
 * Antwort"), unconditional on every answering turn since the `piloti-voice`
 * platform skill was folded into it. The answer arrives with its conclusion first —
 * but a conclusion set at exactly the weight of the reasoning beneath it is a
 * conclusion the reader still has to go looking for.
 * One notch of size and air is enough to make the answer legible before the
 * audit trail is read, without turning the reply into a document with a title.
 *
 * Applied only when it earns its keep: a short reply IS its own lede, and
 * enlarging its single paragraph would just look like a font bug.
 */
export const LEDE_CLASS =
  '[&>.markdown-content>p:first-child]:text-[1.0625rem] ' +
  '[&>.markdown-content>p:first-child]:leading-[1.65] ' +
  '[&>.markdown-content>p:first-child]:mb-4'

/**
 * The prose wrapper's classes: the lede. Nothing for the caret: it is placed
 * inside the block being written (`MarkdownRenderer`'s `caret`), so every
 * block keeps its own display while it streams. Forcing the last block inline
 * to trail the caret behind its last glyph made it ignore its measure, its
 * list indent and its margins until the next block began (stream audit
 * 2026-10, A1).
 */
export const proseClass = (lede: string): string | undefined => lede || undefined

/**
 * What separates a written summary from the prose in the one text the pace
 * reveals: a paragraph break, so neither side's markup reaches into the other
 * when the reveal judges a clean cut.
 */
export const SUMMARY_GAP = '\n\n'

/** What the copy actions are handed while the answer is still arriving. */
export const NO_DOCUMENTS: CitedDocument[] = []

/**
 * A lede only makes sense when the answer opens with prose. An answer that
 * opens with a heading, a list, a table, a quote, a fence or a card marker has
 * already chosen a different way in, and enlarging whatever `p` happens to come
 * first would land the emphasis somewhere arbitrary.
 */
const NON_PROSE_OPENER = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|\[\[card:)/

/** Enough of the opening to tell every opener above from prose (`[[card:` is the longest). */
const OPENER_DECIDABLE_CHARS = 8

/**
 * Whether the answer opens with prose, or `null` while too little of it has
 * arrived to say (a lone `#` may yet be a heading).
 */
export function opensWithProse(text: string, final: boolean): boolean | null {
  const trimmed = text.trimStart()
  if (!final && trimmed.length < OPENER_DECIDABLE_CHARS && !trimmed.includes('\n')) return null
  const firstLine = trimmed.split('\n', 1)[0]
  return Boolean(firstLine) && !NON_PROSE_OPENER.test(firstLine)
}
