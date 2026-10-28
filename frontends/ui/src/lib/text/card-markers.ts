/**
 * The answer's placement markers, `[[card:N]]` and `[[callout]]`: where the
 * renderer splices a card or the callout into the prose. Machinery that means
 * nothing once the answer leaves the chat (the clipboard, Word, an agent over
 * MCP), so every text projection of the answer takes them out here.
 */

/**
 * A `[[card:N]]` or `[[callout]]` placement marker sitting alone on its line.
 * The callout marker survives in the prose when its callout did (the backend
 * leaves at most one for the renderer to splice at), so it is machinery here
 * exactly like the card markers.
 */
const CARD_MARKER_LINE = /^ {0,3}\[\[(?:card:\d+|callout)\]\][ \t]*$/
/** A placement marker anywhere in a line. */
const CARD_MARKER = /\[\[(?:card:\d+|callout)\]\]/g

/**
 * Remove the card placement markers from answer markdown.
 *
 * A marker on its own line takes the line with it (and the blank line the
 * removal would otherwise leave doubled), because that is how the agent is
 * asked to write it; a mid-sentence marker is cut out of the sentence.
 */
export const stripCardMarkers = (markdown: string): string => {
  const lines: string[] = []
  for (const line of markdown.split('\n')) {
    if (CARD_MARKER_LINE.test(line)) continue
    const stripped = CARD_MARKER.test(line) ? line.replace(CARD_MARKER, '').trimEnd() : line
    // Two blank lines are a paragraph gap; three are a hole where a card was.
    if (stripped.trim() === '' && lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
      continue
    }
    lines.push(stripped)
  }
  return lines.join('\n').trim()
}
