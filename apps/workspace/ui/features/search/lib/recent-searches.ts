/**
 * The last few things this person searched for from ⌘K, in this browser: the
 * palette offers them while its field is empty, so a search asked again is
 * recognised rather than retyped.
 *
 * A per-browser convenience, nothing more: the list lives in localStorage and
 * every read and write survives storage that is blocked or full (a private
 * window, a preview), where the palette simply shows no recent searches.
 */

export const RECENT_SEARCHES_KEY = 'search.recent'
export const RECENT_SEARCHES_MAX = 5

/** `text` first, without an earlier copy of it (case-insensitive), at most {@link RECENT_SEARCHES_MAX}. */
export function withRecentSearch(list: readonly string[], text: string): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return [...list]
  const key = trimmed.toLocaleLowerCase()
  return [trimmed, ...list.filter((entry) => entry.toLocaleLowerCase() !== key)].slice(0, RECENT_SEARCHES_MAX)
}

export function readRecentSearches(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCHES_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, RECENT_SEARCHES_MAX) : []
  } catch {
    return []
  }
}

/** Remember `text` as the latest search; returns the list as it now stands. */
export function rememberSearch(text: string): string[] {
  const next = withRecentSearch(readRecentSearches(), text)
  try {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next))
  } catch {
    // Storage blocked or full: the search still runs, it is just not remembered.
  }
  return next
}
