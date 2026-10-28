import type { Translator } from '@/i18n'
import { type LinkSelection } from '../../../lib/work-list'

/**
 * How many retrieval rounds a spine may show in full before the older layers
 * arrive folded.
 *
 * RESERVED, not read: every layer currently arrives expanded, because evidence
 * hidden by default reads as no evidence. The manual fold control stays — the
 * reader can still close any layer by hand — and should a turn shape arrive
 * that needs an auto-fold again, this is the dial, not a new rule.
 */
export const SPINE_FOLD_THRESHOLD = 3

/**
 * Which layers a spine of `count` rounds opens with, before the reader touches
 * anything: all of them. Exported because it is the rule, not an
 * implementation detail — `ReasoningFlow` seeds its state from it and the spec
 * asserts it directly.
 */
export function defaultFoldedRounds(_count: number): Set<number> {
  return new Set()
}

/**
 * The tools that open a passage of a document the turn already found: `read_file` on the estate
 * since ADR-0133 slice 6, `read_passage` before it and for the turns stored with it. A skill read
 * never reaches a round's tools (`retrieval_status._describe_calls` skips it), and a draft read returns
 * no documents, so a `read_file` round with documents opened the office's own.
 */
const OPEN_TOOLS: ReadonlySet<string> = new Set(['read_file', 'read_passage'])

/** Tool basename as the round records it (`tool: read_passage` → `read_passage`). */
const toolBase = (tool: string): string =>
  tool
    .trim()
    .replace(/^tool:\s*/i, '')
    .toLowerCase()

/** This layer only opened passages — it searched for nothing new. */
const onlyOpened = (tools: string[]): boolean =>
  tools.length > 0 && tools.every((tool) => OPEN_TOOLS.has(toolBase(tool)))

/** Tools that list or open a folder: a round of only these fetched no documents, by design. */
const BROWSE_TOOLS: ReadonlySet<string> = new Set(['ls', 'glob', 'list_files'])

/**
 * Tools whose round can come back empty. A round of tools outside this set
 * (a listing, a workspace call, an IFC query) returns no documents by design,
 * so „no documents“ is no miss there (ADR-0132).
 */
const SEARCH_TOOLS: ReadonlySet<string> = new Set([
  'knowledge_search',
  'grep',
  'read_file',
  'project_lookup',
  'read_passage',
  'surface_documents',
  'web_search_tool',
  'advanced_web_search_tool',
  'ris_search_tool',
  'ris_fetch_tool',
  'ris_lookup_tool',
  'ris_catalog_lookup_tool',
])

/** A round that called tools, and none of them looks for documents. */
const searchedNothing = (tools: string[]): boolean =>
  tools.length > 0 && !tools.some((tool) => SEARCH_TOOLS.has(toolBase(tool)))

export function roundKind(
  hasThought: boolean,
  documentCount: number,
  tools: string[],
  t: Translator,
  accounted = false
): string {
  if (
    documentCount === 0 &&
    tools.length > 0 &&
    tools.every((tool) => BROWSE_TOOLS.has(toolBase(tool)))
  ) {
    return t('thinking.node.stepKindBrowse')
  }
  if (documentCount === 0 && accounted && !searchedNothing(tools))
    return t('thinking.node.stepKindNoHits')
  if (documentCount > 0 && onlyOpened(tools)) return t('thinking.node.stepKindOpen')
  if (hasThought && documentCount > 0) return t('thinking.node.stepKindFinding')
  if (hasThought) return t('thinking.node.stepKindConclusion')
  if (documentCount > 0) return t('thinking.node.stepKindRead')
  return t('thinking.node.stepKindSearch')
}

/**
 * The fold state of the spine, and the way back out of it.
 *
 * Passed in rather than held here because `buildGraph` is pure: the state lives
 * in `ReasoningFlow` (see the note there on where it does NOT live), and a spec
 * can build any fold configuration it wants without rendering.
 */
export interface SpineFolding {
  folded: ReadonlySet<number>
  onToggle: (index: number) => void
}

/**
 * What the reader has tapped, and how to change it: the link between rows and
 * cards, and which rounds' uncited cards are open. Passed in rather than held
 * here for the reason `SpineFolding` is: `buildGraph` is pure.
 */
export interface GraphInteraction {
  selection: LinkSelection | null
  onSelect: (selection: LinkSelection | null) => void
  /** Fans (by key) whose uncited cards the reader opened. */
  openFolds: ReadonlySet<string>
  onToggleFold: (key: string) => void
}

export const NO_INTERACTION: GraphInteraction = {
  selection: null,
  onSelect: () => {},
  openFolds: new Set<string>(),
  onToggleFold: () => {},
}
