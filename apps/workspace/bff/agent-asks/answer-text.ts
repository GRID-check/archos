/**
 * Piloti's answer as the agent that asked reads it (ADR-0124): plain Markdown.
 *
 * The stored answer is written for Piloti's own renderer: `:::check` and
 * `:::actions` fences around its tables, `:project[key]` bindings, `[[card:N]]`
 * placement markers, and the verifier's German labels after a quote or a
 * citation it could not back. An MCP client or an A2A peer renders none of
 * that, so it got the machinery raw. The MCP tool result's text content is
 * Markdown (the dominant convention, and what the model on the other side
 * reads), so the answer goes out through the same text projection the copy
 * button and the Word export use (`stripDirectives`, `stripCardMarkers`): a
 * check is still its table, a binding is the project's value. Nothing is
 * rendered twice; this only picks the options an outside reader needs.
 *
 * Pure.
 */

import { stripDirectives, type ProjectKey } from '@/lib/text/answer-directives'
import { stripCardMarkers } from '@/lib/text/card-markers'

/**
 * The verifier's labels, as `common/citation_verification.py` writes them
 * (`UNVERIFIED_QUOTE_MARKER`, `DROPPED_CITATION_MARKER`), and what an agent reads
 * instead: English, because anything an agent reads is (AGENTS.md), and in
 * parentheses, so a bracketed label is not read as a Markdown link reference.
 * `tests/aiq_agent/common/test_answer_dialect_parity.py` holds the keys to
 * the Python constants.
 */
export const VERIFICATION_MARKERS = {
  '[nicht wörtlich in der Quelle belegt]': '(quote not found verbatim in the source)',
  '[Beleg nicht verifiziert]': '(citation not verified)',
} as const

/** The answer's stored Markdown as plain Markdown for another agent. */
export function answerTextForAgent(
  content: string,
  options: { projectValue?: (key: ProjectKey) => string | null } = {}
): string {
  let text = content
  for (const [marker, plain] of Object.entries(VERIFICATION_MARKERS)) text = text.split(marker).join(plain)
  return stripDirectives(stripCardMarkers(text), { projectValue: options.projectValue })
}
