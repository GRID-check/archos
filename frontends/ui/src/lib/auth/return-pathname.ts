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
  // landing there after signing in would show them JSON. The router decodes a
  // path segment before matching it, so `/api%2Fv1` reaches the API too.
  if (targetsApi(resolved.pathname)) return undefined

  return `${resolved.pathname}${resolved.search}`
}

function targetsApi(pathname: string): boolean {
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // Not valid percent-encoding, so no route sees anything but these bytes.
  }
  return [pathname, decoded].some((path) => path === '/api' || path.startsWith('/api/'))
}
