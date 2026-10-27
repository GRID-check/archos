/**
 * Whether the chat peek can stand beside the conversation: on a chat route, on
 * a screen wide enough for two panes. Pure, so the peek's own placement
 * (`useFilePeekPlacement`, `FilePreviewHost`) and Piloti's viewer actions
 * (`ViewerActionHost`) answer it the same way; two copies of it drifted once
 * already, and the cost of a drift is a viewer action that reports a place
 * opened beside the chat while nothing is on screen.
 *
 * There is no research panel sharing the row any more, so it is not a term here.
 */
export const peekHasRoom = (pathname: string | null | undefined, isMobile: boolean): boolean =>
  !isMobile && Boolean(pathname?.includes('/chat'))
