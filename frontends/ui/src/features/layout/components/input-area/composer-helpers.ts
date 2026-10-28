import type { DraftMention } from '@/lib/mentions/mention-text'
import { MENTION_ERROR_REASONS } from '@/lib/mentions/types'
import { SHARING_ERROR_REASONS } from '@/lib/sharing/types'
import type { SendMessageOutcome } from '@/features/chat/hooks/use-websocket-chat'

/**
 * Normalise whatever `sendMessage` returned.
 *
 * The fast path answers synchronously with a boolean (and legacy/mocked callers
 * answer with nothing at all), the mention path with the server's ruling. Only an
 * explicit `false` or `ok: false` counts as "not sent" — exactly the contract the
 * composer had before mentions existed.
 */
export function normalizeSendResult(result: unknown): { ok: boolean; outcome?: SendMessageOutcome } {
  if (result === false) return { ok: false }
  if (result && typeof result === 'object' && 'ok' in result) {
    const outcome = result as SendMessageOutcome
    return { ok: outcome.ok, outcome }
  }
  return { ok: true }
}

/**
 * The copy for a refused mention. The server names the reason machine-readably in
 * `details.reason` precisely so the composer can say something useful instead of
 * "something went wrong" — and the user's text is kept either way.
 */
export function mentionRefusalMessage(
  outcome: SendMessageOutcome | undefined,
  taggedHumans: readonly DraftMention[],
  tCollab: (key: string, vars?: Record<string, string | number>) => string
): string | null {
  const reason = outcome?.failure?.reason
  if (!reason) return null
  // Name the person the SERVER refused (the refusal carries their targetId) —
  // tagging two people and hearing the first one's name when the second was
  // refused blames the wrong colleague.
  const refused = outcome?.failure?.targetId
  const name =
    (refused ? taggedHumans.find((mention) => mention.targetId === refused)?.display : undefined) ??
    taggedHumans[0]?.display ??
    ''
  switch (reason) {
    case MENTION_ERROR_REASONS.inviteRequiresOwner:
      return tCollab('mentions.errors.inviteRequiresOwner', { name })
    case MENTION_ERROR_REASONS.containerAccessRequired:
      return tCollab('mentions.errors.containerAccessRequired', { name })
    case MENTION_ERROR_REASONS.rateLimited:
      return tCollab('mentions.errors.rateLimited')
    // Mentioning someone new invites them, and a thread that drew on a
    // restricted folder reaches only people cleared for it (ADR-0087).
    case SHARING_ERROR_REASONS.restrictedContent:
      return name
        ? tCollab('sharing.errors.restrictedContent', { name })
        : tCollab('sharing.errors.restrictedContentSomeone')
    // Likewise a chat that drew on a running other project (ADR-0094).
    case SHARING_ERROR_REASONS.crossProjectContent:
      return name
        ? tCollab('sharing.errors.crossProjectContent', { name })
        : tCollab('sharing.errors.crossProjectContentSomeone')
    default:
      return null
  }
}

/**
 * Maximum height of the auto-sizing textarea in pixels. Must equal the
 * `max-h-52` (13rem) cap on the textarea itself: the JS autosize and the CSS
 * clamp are the same limit stated twice, and when they drift the smaller one
 * silently wins.
 */
export const TEXTAREA_MAX_HEIGHT_PX = 208

/**
 * How much of the layout viewport the visual viewport must lose before it counts
 * as an on-screen keyboard. A soft keyboard takes a third of the screen or more;
 * the shortcut bar iPadOS keeps on screen for a hardware keyboard is a strip,
 * and that reader keeps typing, so it must not read as one.
 */
const SOFT_KEYBOARD_MIN_OCCLUSION_PX = 100

/**
 * Whether an on-screen keyboard is covering the screen right now. A coarse
 * pointer alone is not the answer: an iPad with a hardware keyboard is coarse,
 * has no soft keyboard, and its reader types the follow-up next.
 *
 * iOS shrinks only the visual viewport when the keyboard opens, so the
 * occlusion is measurable. Chromium under `interactiveWidget: 'resizes-content'`
 * (app/layout.tsx) shrinks both viewports together and leaves nothing to
 * measure; there a touch-only device (`navigator.virtualKeyboard` marks the
 * engine) is taken to be typing on glass, which is the overwhelming case.
 */
function softKeyboardIsUp(): boolean {
  if (typeof window.matchMedia !== 'function') return false
  if (!window.matchMedia('(pointer: coarse)').matches) return false
  const viewport = window.visualViewport
  if (
    viewport &&
    document.documentElement.clientHeight - viewport.height * viewport.scale >
      SOFT_KEYBOARD_MIN_OCCLUSION_PX
  ) {
    return true
  }
  return 'virtualKeyboard' in navigator
}

/**
 * Close the on-screen keyboard once a message is sent. It covers half the
 * screen, and the answer the reader is about to watch arrive is exactly what it
 * hides. Without one up (a desk, or an iPad on a hardware keyboard) the field
 * keeps focus: that reader types the follow-up next, and a lost caret is a lost
 * keystroke.
 */
export function releaseSoftKeyboard(el: HTMLTextAreaElement | null): void {
  if (el && softKeyboardIsUp()) el.blur()
}

/**
 * How long after Send turns into Stop (or back) the control ignores presses.
 * One element does both jobs, so the second click of a double click, or a
 * bounce on a touch screen, lands on the OTHER job: a Stop pressed twice would
 * send the follow-up typed ahead, and a Send pressed twice would cancel the
 * turn it just started. Comfortably above a double-click interval, well under
 * the time anyone takes to decide to stop an answer they have just seen begin.
 */
export const SEND_CONTROL_SWAP_GUARD_MS = 400

/**
 * Whether the engine sizes a textarea to its content in CSS. Read once: it is a
 * property of the browser, not of the render. jsdom has no `CSS.supports`, so
 * the specs exercise the measuring fallback.
 */
export const FIELD_SIZING_CONTENT =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('field-sizing', 'content')
