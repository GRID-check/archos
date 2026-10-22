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

const COUNT_LINE = /^Found (\d+) (?:relevant )?document\(s\)([^\n]*)$/m

/**
 * A ranked search's header, with what the hits' order means. The tool keeps its
 * hits in the final order (reranked, then spread over documents), and prints each
 * hit's own retrieval score, which is not comparable across shelves; so the
 * score need not fall down the list. The count is the platform's limit, not 16.
 * The tool counts its hits as documents; they are passages, several to a
 * document, so the header says passages.
 */
export function withRankedOrderNote(text: string, groupedByDocument = false): string {
  if (!COUNT_LINE.test(text)) return text
  // Grouped by document, the count is documents (one best passage each); otherwise it counts passages.
  const unit = groupedByDocument ? 'documents' : 'passages'
  const limit = groupedByDocument ? '' : ' The number of hits is the platform’s configured limit.'
  return text.replace(
    COUNT_LINE,
    `Found $1 ${unit}$2\n(Ranked hits are in the search’s final order, after reranking and the per-document spread. ` +
      `Each Relevance Score is that passage’s retrieval score, so it does not fall steadily down the list.${limit})`,
  )
}

/**
 * What a search answer may take of a tool result. A result is cut at
 * `MAX_RESULT_CHARS` (40,000) from the end, which drops the last hits whole; this
 * leaves room under it for the door's own lines.
 */
export const HIT_TEXT_BUDGET = 38_000

const HIT_SPLIT = /(?=^--- Result \d+ ---$)/m
const CUT_NOTE = '\n… [cut to fit the answer; read the whole passage with `passage-read` by its Citation]'

/**
 * `text` with every hit kept: when the hits would not fit `budget`, each hit's
 * passage text is shortened to an even share, its Source, Citation and page lines
 * kept whole, instead of the answer losing its last hits to the cut at the end.
 */
export function fittedHits(text: string, budget: number = HIT_TEXT_BUDGET): string {
  if (text.length <= budget) return text
  const [head = '', ...hits] = text.split(HIT_SPLIT)
  if (hits.length === 0) return text
  const share = Math.floor((budget - head.length) / hits.length) - CUT_NOTE.length - 2
  if (share <= 0) return text
  return head + hits.map((hit) => (hit.length <= share ? hit : shortened(hit, share))).join('')
}

/** One hit cut to `share` characters of passage text, after its metadata lines (up to the first blank line). */
function shortened(hit: string, share: number): string {
  const blank = hit.indexOf('\n\n')
  const meta = blank === -1 ? '' : hit.slice(0, blank + 2)
  const body = blank === -1 ? hit : hit.slice(blank + 2)
  // The share pays for the metadata first: a hit whose citation lines fill it keeps them and drops its text.
  const room = Math.max(share - meta.length, 0)
  return body.length <= room ? hit : `${meta}${body.slice(0, room).trimEnd()}${CUT_NOTE}\n\n`
}
