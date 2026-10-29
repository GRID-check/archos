/**
 * Only a plain primary click counts as "opened". Cmd/ctrl/middle click is the
 * natural triage gesture (open three rows in background tabs), and it must not
 * spend their read state.
 */
export function isPlainClick(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number }): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) && event.button === 0
}
