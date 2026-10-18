/**
 * Passing an answer on from a phone: the operating system's share sheet, with
 * the clipboard behind it.
 *
 * The reader's next move after an answer is rarely inside Piloti: a message to
 * the site manager, a mail to the Bauherr. On a phone that move is the share
 * sheet (WhatsApp, Mail, Messages, Files), not a paste buffer and a second app.
 * What goes into it is the answer as text, sources written out when the turn
 * has them, and the address of the thread when the thread has an address worth
 * giving. The link grants nothing (opening it asks the server who the reader
 * is), so it rides along as the way back to the full answer for anyone who
 * already has access.
 *
 * Feature-detected at the call, never assumed. A person closing the sheet is an
 * answer (`AbortError`), not a failure, and must not fall through to a
 * clipboard write they did not ask for; any other refusal (Safari outside a
 * user gesture, a payload the target rejects) does fall back to the copy.
 */

import { canShareNatively, conversationLink } from '@/features/collaboration/lib/share-link'
import { isConversationOnServer } from './conversation-on-server'

export { canShareNatively }

export interface AnswerSharePayload {
  title: string
  text: string
  /** The thread's address, when there is one worth giving. */
  url?: string
}

export type AnswerShareOutcome = 'shared' | 'cancelled' | 'copied' | 'failed'

/**
 * The address of the thread this answer is in, or undefined when there is none
 * to give: a chat the server has not stored yet has no address anyone else can
 * open, and a page that is not the chat has no honest one to build.
 */
export function answerShareUrl(
  conversationId: string | null | undefined,
  location: Pick<Location, 'origin' | 'pathname'>,
): string | undefined {
  if (!conversationId || !isConversationOnServer(conversationId)) return undefined
  return conversationLink('conversation', conversationId, location) ?? undefined
}

/**
 * Hand the answer to the share sheet; copy it when there is no sheet or the
 * sheet refuses. `copy` throws when it cannot write, which is `failed`.
 */
export async function shareAnswer(
  payload: AnswerSharePayload,
  copy: (text: string) => Promise<void>,
  nav: Partial<Pick<Navigator, 'share'>> | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): Promise<AnswerShareOutcome> {
  if (nav && canShareNatively(nav)) {
    try {
      await nav.share(payload.url ? payload : { title: payload.title, text: payload.text })
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
    }
  }
  try {
    await copy(payload.url ? `${payload.text}\n\n${payload.url}` : payload.text)
    return 'copied'
  } catch {
    return 'failed'
  }
}
