/**
 * Whether one step back in this tab's history lands on a given address, asked of
 * the history itself rather than of a record we keep beside it.
 *
 * The return trail (`./return-trail`) keeps paths only, so it cannot tell
 * `/app/projects/p1/files` from `/app/projects/p1/files?doc=…&review=1`, and it
 * cuts itself back on a revisit: a review opened from the Postfach in the very
 * project the reader came from reads as "the entry behind is Dateien". The
 * Navigation API lists this tab's real entries, query and all, and sees every
 * `replaceState` a page made, so the entry behind is the entry behind.
 *
 * Where the API is missing (an older browser) nothing is known, and the answer
 * is no: the caller replaces rather than going back to a page it cannot name.
 */

/** One history entry as the Navigation API lists it: its URL, null when the API withholds it. */
export interface HistoryEntryLike {
  readonly url: string | null
}

/** Path and query of `href` read against `origin`, its parameters sorted; null for another origin or no URL. */
function pathAndQuery(href: string, origin: string): string | null {
  let url: URL
  try {
    url = new URL(href, origin)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  url.searchParams.sort()
  return `${url.pathname}?${url.searchParams.toString()}`
}

/**
 * Whether the entry one before `index` is `target`: the same origin, path and
 * query, the order of the query's parameters and the hash aside. Pure, so the
 * cases are testable without a browser: `entries` and `index` are the tab's
 * `navigation.entries()` and `navigation.currentEntry.index`.
 */
export function previousEntryIs(
  entries: readonly HistoryEntryLike[],
  index: number,
  target: string,
  origin: string
): boolean {
  const previousUrl = index > 0 ? entries[index - 1]?.url : null
  if (!previousUrl) return false
  const want = pathAndQuery(target, origin)
  return want !== null && pathAndQuery(previousUrl, origin) === want
}

interface NavigationLike {
  entries(): readonly HistoryEntryLike[]
  readonly currentEntry: { readonly index: number } | null
}

function isNavigationLike(value: unknown): value is NavigationLike {
  if (typeof value !== 'object' || value === null) return false
  return typeof Reflect.get(value, 'entries') === 'function' && 'currentEntry' in value
}

/**
 * Whether `history.back()` in this tab lands on `target` (a path of this
 * origin). False on the server, without the Navigation API, and on the tab's
 * first entry.
 */
export function backLandsOn(target: string): boolean {
  if (typeof window === 'undefined' || !('navigation' in window)) return false
  const navigation: unknown = Reflect.get(window, 'navigation')
  if (!isNavigationLike(navigation) || !navigation.currentEntry) return false
  return previousEntryIs(navigation.entries(), navigation.currentEntry.index, target, window.location.origin)
}
