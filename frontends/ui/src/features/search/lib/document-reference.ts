/**
 * The composer's `#`: typing `#` and a word searches the workspace for a
 * document to put into the message. Pure, so the trigger and the insertion are
 * tested without a DOM.
 *
 * The trigger is the mention's (`lib/mentions/mention-text.ts`):
 * the fragment runs from a `#` at a word boundary to the caret and closes at
 * whitespace, so `#Fluchtweg` opens the picker and `Nr.#3` or a Markdown
 * heading (`# Titel`, a space after the mark) do not.
 *
 * A pick writes the document's name into the text in the office's quotes,
 * „Grundriss EG“, because the agent retrieves by the name it reads in the
 * question (`features/documents/lib/document-question.ts`); the composer also
 * makes the document the message's subject, as „Piloti fragen" does.
 */

/** The `#…` fragment under the caret. */
export interface DocumentReferenceQuery {
  /** Everything after `#` up to the caret (no whitespace). */
  query: string
  /** Index of the `#`. */
  start: number
  /** Index just past the fragment (the caret). */
  end: number
}

/** The longest fragment the trigger reads back; past it the caret is in prose. */
const MAX_QUERY_LENGTH = 60

const OPENING_MARKS = new Set(['(', '[', '{', '<', '„', '“', '«', '‚', '‘', '‹'])

const isBoundary = (character: string | undefined): boolean =>
  character === undefined || /\s/.test(character) || OPENING_MARKS.has(character)

export function findDocumentReferenceQuery(text: string, caret: number): DocumentReferenceQuery | null {
  const position = Math.max(0, Math.min(caret, text.length))
  for (let index = position - 1; index >= 0; index -= 1) {
    if (position - index > MAX_QUERY_LENGTH + 1) return null
    const character = text[index]
    if (/\s/.test(character)) return null
    if (character !== '#') continue
    if (!isBoundary(text[index - 1])) return null
    return { query: text.slice(index + 1, position), start: index, end: position }
  }
  return null
}

/** Replace the `#…` fragment with „name“ and a space, and say where the caret goes. */
export function insertDocumentReference(text: string, range: DocumentReferenceQuery, name: string): { text: string; caret: number } {
  const rest = text.slice(range.end)
  const token = `„${name}“${rest.startsWith(' ') ? '' : ' '}`
  return { text: `${text.slice(0, range.start)}${token}${rest}`, caret: range.start + token.length }
}
