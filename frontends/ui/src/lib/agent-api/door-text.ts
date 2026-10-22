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

/** Only these are replaced when they stand bare: `look` is also an English word. */
const BARE_SAFE = /^[a-z]+(_[a-z]+)+$/

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const longestFirst = (names: string[]) =>
  names.sort((a, b) => b.length - a.length).map(escapeRegExp)

function mentionPatterns(names: ToolNames): { call: RegExp; ticked: RegExp; bare: RegExp | null } {
  const all = longestFirst(Object.keys(names))
  const bareNames = longestFirst(Object.keys(names).filter((tool) => BARE_SAFE.test(tool)))
  return {
    // `tool(args)`, with or without the backticks around it
    call: new RegExp('`?\\b(' + all.join('|') + ')\\(([^()`]*)\\)`?', 'g'),
    ticked: new RegExp('`(' + all.join('|') + ')`', 'g'),
    bare: bareNames.length ? new RegExp('\\b(' + bareNames.join('|') + ')\\b', 'g') : null,
  }
}

/**
 * `text` with every Python tool name replaced by its operation name, and each
 * call spelled the way the door takes it: `passage-read` with input {document=…, page=…}.
 */
export function withOperationNames(text: string, names: ToolNames): string {
  const { call, ticked, bare } = mentionPatterns(names)
  const renamed = text
    .replace(call, (_m, tool: string, args: string) => {
      const input = args.trim()
      return input ? `\`${names[tool]}\` with input {${input}}` : `\`${names[tool]}\``
    })
    .replace(ticked, (_m, tool: string) => `\`${names[tool]}\``)
  return bare ? renamed.replace(bare, (tool) => names[tool] ?? tool) : renamed
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
