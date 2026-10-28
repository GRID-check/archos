/**
 * How far the transcript keeps clear of the chat toolbar floating over it.
 *
 * The toolbar is `absolute` over the scroll plane, so the plane has to start
 * lower than the toolbar ends. That used to be a guess written into four class
 * lists (`pt-[max(5rem,…4rem)]`), true while the toolbar was one row. On a phone
 * the toolbar is two rows (the project context above the thread's own pills) and
 * a third while the link is gone, so the guess is replaced by the measurement:
 * `ChatToolbar` reports its height, `MainLayout` publishes
 * `--chat-toolbar-clear` (height plus a breath) on the chat column, and every
 * consumer reads it. Before it is measured, and in a preview with no toolbar,
 * the variable is absent and the old one-row values stand.
 *
 * The classes are whole strings here, not assembled, because Tailwind reads
 * source text.
 */

/** The variable `MainLayout` sets on the chat column. */
export const TOOLBAR_CLEAR_VAR = '--chat-toolbar-clear'

/** Space between the toolbar's lower edge and the first line under it. */
export const TOOLBAR_BREATH_PX = 8

/** The transcript's top padding. */
export const TOOLBAR_CLEAR_PADDING =
  'pt-[var(--chat-toolbar-clear,max(5rem,calc(env(safe-area-inset-top)+4rem)))] sm:pt-[var(--chat-toolbar-clear,max(3.5rem,calc(env(safe-area-inset-top)+3rem)))]'

/** A row that is scrolled to the top lands this far below the screen's edge. */
export const TOOLBAR_CLEAR_SCROLL_MARGIN =
  'scroll-mt-[var(--chat-toolbar-clear,max(5rem,calc(env(safe-area-inset-top)+4rem)))] sm:scroll-mt-[var(--chat-toolbar-clear,max(3.5rem,calc(env(safe-area-inset-top)+3rem)))]'

/** The value `MainLayout` publishes for a measured toolbar height. */
export function toolbarClearance(heightPx: number): string {
  return `${Math.ceil(heightPx) + TOOLBAR_BREATH_PX}px`
}
