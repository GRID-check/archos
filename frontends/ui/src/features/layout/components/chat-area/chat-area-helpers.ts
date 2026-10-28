import type { ChatMessage } from '@/features/chat/types'
import type { ThinkingEnding } from '@/features/chat/components/ChatThinking'
import type { TurnView } from '@/features/chat/lib/turn-fold'
import { motionQuickExit } from '@/components/motion'

/** How much of an answer the settle announcement reads out. */
const GIST_MAX_CHARS = 120

/**
 * What the settle announcement says the answer comes to: the verdict when the
 * answer earned one, else its first sentence, without Markdown or citation
 * marks, cut at a word.
 */
export const answerGist = (answer: ChatMessage): string => {
  const verdict = answer.answerMeta?.verdict
  if (verdict) return `${verdict.subject}: ${verdict.value}`
  const plain = answer.content
    .replace(/\[\d+\]/g, '')
    .replace(/[#*_`>|~]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  const sentence = plain.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? plain
  if (sentence.length <= GIST_MAX_CHARS) return sentence
  const cut = sentence.slice(0, GIST_MAX_CHARS)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 0)) || cut}…`
}

/** Error cards that say the turn was not taken on, rather than that it failed. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(['research.queue_full', 'budget.exhausted'])

/**
 * How a finished turn ended, when it is not simply „done": what the turn's own
 * terminal said first (a run commissioned, a refusal), then what the thread
 * shows (a run message, a refusal banner), then a failure.
 */
export const turnEnding = (
  view: TurnView | undefined,
  turnMessages: ChatMessage[],
  failed: boolean
): ThinkingEnding | undefined => {
  if (view?.outcome === 'handed_off' || view?.result?.run || turnMessages.some((m) => m.runLedger)) {
    return 'handed_off'
  }
  const refusedByBanner = turnMessages.some(
    (m) => m.messageType === 'error' && REFUSAL_CODES.has(m.errorData?.errorCode ?? '')
  )
  if (view?.outcome === 'refused' || view?.result?.job_admission_rejected || refusedByBanner) return 'refused'
  return failed ? 'failed' : undefined
}

/** How long „Wieder verbunden" stays before the dock goes quiet again. */
export const RECONNECTED_NOTE_MS = 2400

/** A question with no turn yet, without a new array per render. */
export const NO_MESSAGES: ChatMessage[] = []

/** The thread list's `gap-4`, which a leaving row gives back. */
export const ROW_GAP_PX = 16

/**
 * How long a live answer waits for the Herleitung above it to fold: the fold's
 * fade, then two frames for the height to drop while nothing is visible.
 */
export const FOLD_HOLD_MS = (motionQuickExit.duration ?? 0.18) * 1000 + 34

/** `--composer-h` before the composer has measured itself (11rem). */
const COMPOSER_FALLBACK_PX = 176
/** The list's breathing room above the composer (its `+ 1.5rem` bottom padding). */
const LIST_END_GAP_PX = 24
/** Unseen content below, in px, before the jump button is worth showing. */
export const UNSEEN_SLACK_PX = 24
/** A scroll this soon after the reader's own input is the reader's. */
export const READER_SCROLL_MS = 300
/** A wheel or fling is still moving the thread this soon after its last event. */
export const GESTURE_SETTLE_MS = 150
/** How long after a retry the re-sent question counts as a retry. */
export const RETRY_ANCHOR_WINDOW_MS = 1000

/**
 * An element's top as laid out, without the vertical translate of an entrance
 * still playing on it. The thread row rises 4px as it arrives, and the anchor
 * measured mid-rise put the question 4px off for the rest of the turn.
 */
export const layoutTop = (el: HTMLElement): number => {
  const top = el.getBoundingClientRect().top
  const transform = getComputedStyle(el).transform
  if (!transform || transform === 'none' || typeof DOMMatrixReadOnly === 'undefined') return top
  try {
    return top - new DOMMatrixReadOnly(transform).m42
  } catch {
    return top
  }
}

/**
 * The lowest line of the thread the reader can see: the viewport's foot less
 * the floating composer over it and the list's clearance above that (the
 * list's bottom padding is the composer's height plus 1.5rem, the same).
 */
export const visibleBottom = (container: HTMLElement): number => {
  const composer = Number.parseFloat(getComputedStyle(container).getPropertyValue('--composer-h'))
  const covered = (Number.isFinite(composer) ? composer : COMPOSER_FALLBACK_PX) + LIST_END_GAP_PX
  return container.getBoundingClientRect().bottom - covered
}
