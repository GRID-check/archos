/**
 * Why the chat cannot take a dropped file right now, as a dictionary key under
 * `research.inputArea`, or null when it can.
 *
 * The same facts close the paperclip (`ComposerAttach`'s `disabled`) and the
 * attach path (`handleFilesSelected`). The drop zone used to be `disabled` on
 * them instead: it claimed nothing, the window guard refused the drop, and
 * the reader was not told why. Now the chat panel keeps the drag and says it.
 *
 * In order of what the reader can do about it: nothing (they may only read),
 * wait (an answer, a question, an upload), or nothing again (no knowledge
 * layer to read the file).
 */
export type ComposerDropRefusal =
  | 'dropRefusedReadOnly'
  | 'dropRefusedAnswering'
  | 'dropRefusedQuestion'
  | 'dropRefusedUploading'
  | 'uploadNotAvailable'

export interface ComposerDropFacts {
  /** `composerCapabilities(...).canContribute`. */
  canContribute: boolean
  /** A turn is streaming in this conversation. */
  isStreaming: boolean
  /** Piloti asked a question and waits for the answer (HITL). */
  awaitsAnswer: boolean
  /** An attachment is uploading. */
  isUploading: boolean
  /** The knowledge layer that reads an attachment is there. */
  knowledgeLayerAvailable: boolean
}

export function composerDropRefusal(facts: ComposerDropFacts): ComposerDropRefusal | null {
  if (!facts.canContribute) return 'dropRefusedReadOnly'
  if (facts.awaitsAnswer) return 'dropRefusedQuestion'
  if (facts.isStreaming) return 'dropRefusedAnswering'
  if (facts.isUploading) return 'dropRefusedUploading'
  if (!facts.knowledgeLayerAvailable) return 'uploadNotAvailable'
  return null
}
