/**
 * API paths that were renamed to English, and where each used to live.
 *
 * `next.config.ts` turns every entry into a permanent redirect (308 keeps the method, the body and
 * the query string), so a browser tab opened before the deploy keeps working. Remove an entry one
 * release after the rename shipped.
 */
export interface LegacyRoute {
  /** The old path, with Next's `:param` segments. */
  from: string
  /** The new path, with the same segments. */
  to: string
}

export const LEGACY_ROUTES: readonly LegacyRoute[] = [
  { from: '/api/documents/:id/fassung', to: '/api/documents/:id/revision' },
  { from: '/api/documents/:id/fassung-compare', to: '/api/documents/:id/revision-compare' },
  { from: '/api/documents/fassung-candidates', to: '/api/documents/revision-candidates' },
  { from: '/api/projects/:id/steckbrief', to: '/api/projects/:id/project-record' },
]
