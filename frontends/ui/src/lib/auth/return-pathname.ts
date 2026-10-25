/**
 * The page a sign-in may send a person back to.
 *
 * The value arrives as the `returnPathname` query parameter on
 * `/api/auth/signin` — the proxy fills it in when it reroutes an unauthenticated
 * navigation — so it is attacker-reachable: `?returnPathname=https://evil.example`
 * must not turn our sign-in into an open redirect.
 */

/** A path on this app, and not an API call. */
export function safeReturnPathname(candidate: string | null | undefined): string | undefined {
  if (!candidate?.startsWith('/')) return undefined

  let resolved: URL
  try {
    // A placeholder origin, never navigated to. Resolving against it is what
    // turns `//evil.example` and `/\evil.example` into a different origin, which
    // the comparison below then refuses. A plain prefix check misses the
    // backslash form because the URL parser reads `\` as `/` for http(s).
    resolved = new URL(candidate, 'https://placeholder.invalid')
  } catch {
    return undefined
  }

  if (resolved.origin !== 'https://placeholder.invalid') return undefined
  // `/api/...` is a fetch from a page, never a place a person was going:
  // landing there after signing in would show them JSON.
  if (resolved.pathname === '/api' || resolved.pathname.startsWith('/api/')) return undefined

  return `${resolved.pathname}${resolved.search}`
}
