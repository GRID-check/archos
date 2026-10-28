/**
 * Bounded, injection-safe digest formatting — the one way free-text knowledge
 * rows become prompt lines. Shared by the project-memory digest
 * (`lib/projects/memory-service.ts`) and the platform-lessons digest
 * (`lib/platform-lessons/service.ts`) so both carry the same guarantees:
 *
 *  - Each item is ONE line: `- [tag | tag | …] "content"`. Content is
 *    whitespace-collapsed and wrapped in double quotes with internal quotes and
 *    backslashes escaped, so stored text can never forge an additional tag
 *    line or break out of its own entry.
 *  - The whole digest is bounded in characters, and items past the budget are
 *    dropped in order — the caller decides the order, this module enforces the
 *    ceiling.
 */

/**
 * The character budget one prompt block gets.
 *
 * Shared, because the blocks that use it SHARE a channel: the project-memory
 * digest, the proposal decisions and the review decisions all ride the same
 * header on the same turn, and „same order of size as one memory digest" was
 * the reason each of them gave for the number — written out three times, in
 * three files, as three private constants that nothing kept equal. The two that
 * are genuinely different (`lib/projects/memory-service.ts` at 1800, the
 * platform lessons at 1600) keep their own and say so; a block that wants this
 * size takes it from here.
 */
export const DIGEST_BLOCK_MAX_CHARS = 900

export interface DigestLineItem {
  /** Rendered inside the `[...]` bracket, joined with ` | `. */
  tags: string[]
  content: string
}

/**
 * Render `header` plus one line per item, appending in order until `maxChars`
 * would be exceeded. Returns null when no item survives — callers omit the
 * block entirely rather than injecting a bare header.
 */
export function formatBoundedDigest(
  header: string,
  items: DigestLineItem[],
  maxChars: number
): string | null {
  return formatBoundedDigestWithKept(header, items, maxChars).digest
}

/**
 * {@link formatBoundedDigest} that also says which items made it into the
 * text, in order: an item that is blank, or past the budget, is not in `kept`.
 * For a caller that must name what it injected (the platform lessons' trace
 * metadata), where "the first N of the list" would be a guess.
 */
export function formatBoundedDigestWithKept<T extends DigestLineItem>(
  header: string,
  items: T[],
  maxChars: number
): { digest: string | null; kept: T[] } {
  if (items.length === 0) return { digest: null, kept: [] }

  const lines: string[] = [header]
  const kept: T[] = []
  let used = header.length
  for (const item of items) {
    const content = item.content.replace(/\s+/g, ' ').trim()
    if (!content) continue
    const escaped = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const line = `- [${item.tags.join(' | ')}] "${escaped}"`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    kept.push(item)
    used += line.length + 1
  }

  return lines.length > 1 ? { digest: lines.join('\n'), kept } : { digest: null, kept: [] }
}
