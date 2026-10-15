/**
 * The link a person can pass on for a shared resource, and the two ways to pass
 * it on: the phone's own share sheet, or the clipboard.
 *
 * A link grants nothing. Opening it asks the server who the reader is, exactly as
 * any other route does, so it only works for people who already have access; the
 * dialog says so beside the button. That is why it can be offered to anyone who
 * can read the thread and not only to its owners.
 */

import type { ShareableResourceType } from '@/lib/sharing/types'

/**
 * The address of a conversation's thread, derived from the page the reader is on.
 *
 * The chat surface reads `?session=` (`useSessionUrl`, and the registry's
 * `deepLink`), and the project is the one in the path. Anything that is not a chat
 * page has no thread address we can honestly build here, so it returns null and
 * the dialog offers no link rather than a wrong one. Other params (a drawer, a
 * scroll anchor) are the reader's own state and are dropped.
 */
export function conversationLink(
  resourceType: ShareableResourceType,
  resourceId: string,
  location: Pick<Location, 'origin' | 'pathname'>,
): string | null {
  if (resourceType !== 'conversation') return null
  if (!/^\/app\/(?:projects\/[^/]+\/)?chat\/?$/.test(location.pathname)) return null
  const url = new URL(location.pathname, location.origin)
  url.searchParams.set('session', resourceId)
  return url.toString()
}

/** Whether this browser can hand a link to the operating system's share sheet. */
export function canShareNatively(
  nav: Partial<Pick<Navigator, 'share'>> | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): nav is Pick<Navigator, 'share'> {
  return typeof nav?.share === 'function'
}

export type ShareLinkOutcome = 'shared' | 'copied' | 'cancelled' | 'failed'

/**
 * Passes `url` on: the native share sheet where there is one, the clipboard
 * where there is not or where the sheet refuses.
 *
 * Feature-detected at the call, never assumed: desktop Firefox has no
 * `navigator.share`, and Safari refuses it outside a user gesture. A person
 * dismissing the sheet is an answer (`AbortError`), not a failure, so it falls
 * through to nothing rather than to a clipboard write they did not ask for.
 */
export async function passOnLink(
  url: string,
  title: string,
  nav: Navigator = navigator,
): Promise<ShareLinkOutcome> {
  if (canShareNatively(nav)) {
    try {
      await nav.share({ title, url })
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
    }
  }
  try {
    await nav.clipboard.writeText(url)
    return 'copied'
  } catch {
    return 'failed'
  }
}
