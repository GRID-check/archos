/**
 * The text of a read tool's answer, as an outside agent should read it.
 *
 * The Python tools write for Piloti's own agent: they name the next call by the
 * Python function (`read_passage(document=…, page=…)`), and a ranked search does
 * not say that its hits follow the final ranking rather than the score printed
 * on each. Over MCP the operations have their own names and are called through
 * `call-operation` with flat input. This is the one place that difference is
 * bridged, so the in-product agent keeps seeing the names it was taught.
 */

/** Which Python tool names an answer may mention, and the operation each one is over MCP. */
export interface ToolNames {
  readonly [pythonTool: string]: string
}

/**
 * A tool's name as Python spells it, called (`read_passage(document=…)`, with or
 * without backticks), backticked, or bare. Fixed patterns that match any such
 * identifier; only one the map names is replaced. A bare name must have an
 * underscore: `look` is also an English word.
 */
const CALLED = /`?\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\(([^()`]*)\)`?/g
const TICKED = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)*)`/g
const BARE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g

/**
 * `text` with every Python tool name replaced by its operation name, and each
 * call spelled the way the door takes it: `passage-read` with input {document=…, page=…}.
 */
export function withOperationNames(text: string, names: ToolNames): string {
  const known = (tool: string): string | undefined => (Object.hasOwn(names, tool) ? names[tool] : undefined)
  return text
    .replace(CALLED, (match, tool: string, args: string) => {
      const op = known(tool)
      if (!op) return match
      const input = args.trim()
      return input ? `\`${op}\` with input {${input}}` : `\`${op}\``
    })
    .replace(TICKED, (match, tool: string) => {
      const op = known(tool)
      return op ? `\`${op}\`` : match
    })
    .replace(BARE, (match, tool: string) => known(tool) ?? match)
}

const COUNT_LINE = /^(Found \d+ (?:relevant )?document\(s\)[^\n]*)$/m

/**
 * A ranked search's header, with what the hits' order means. The tool keeps its
 * hits in the final order (reranked, then spread over documents), and prints each
 * hit's own retrieval score, which is not comparable across shelves; so the
 * score need not fall down the list. The count is the platform's limit, not 16.
 */
export function withRankedOrderNote(text: string): string {
  if (!COUNT_LINE.test(text)) return text
  return text.replace(
    COUNT_LINE,
    '$1\n(Ranked hits are in the search’s final order, after reranking and the per-document spread. ' +
      'Each Relevance Score is that passage’s retrieval score, so it does not fall steadily down the list. ' +
      'The number of hits is the platform’s configured limit.)',
  )
}
