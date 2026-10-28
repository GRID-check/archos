/**
 * Voice dictation for the chat composer: the facade. The composer imports the
 * button, the recording strip, the channel between them and the insertion rule from here
 * and nothing else; recording, support detection and the call to
 * `/api/dictation` stay inside.
 * `docs/architecture/voice-dictation.md` has the design and its open questions.
 */

export {
  DictationButton,
  DictationControl,
  DictationStrip,
  LiveDictationStrip,
  createDictationChannel,
  type DictationButtonProps,
  type DictationChannel,
  type DictationSnapshot,
  type DictationControlProps,
  type DictationStripProps,
} from './components/DictationButton'
export type { DictationErrorKey, DictationState } from './hooks/use-dictation'
export {
  insertTranscript,
  type ComposerCaret,
  type InsertedTranscript,
} from './lib/insert-transcript'
