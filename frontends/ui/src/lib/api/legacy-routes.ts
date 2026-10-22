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

/**
 * The office shelf's document routes, merged into `/api/documents` with `scope=office_shelf`
 * (ADR-0131 rule 5), under both old prefixes. The named ones before `:id`, which would match them.
 */
const OFFICE_SHELF_DOCUMENT_ROUTES: readonly LegacyRoute[] = ['/api/office-shelf/documents', '/api/archiv/documents'].flatMap(
  (prefix) => [
    ...['summary', 'by-name', 'name-matches', 'revision-candidates', 'search', 'upload'].map((name) => ({
      from: `${prefix}/${name}`,
      to: `/api/documents/${name}?scope=office_shelf`,
    })),
    { from: `${prefix}/fassung-candidates`, to: '/api/documents/revision-candidates?scope=office_shelf' },
    { from: `${prefix}/:id`, to: '/api/documents/:id' },
    { from: prefix, to: '/api/documents?scope=office_shelf' },
  ]
)

export const LEGACY_ROUTES: readonly LegacyRoute[] = [
  ...OFFICE_SHELF_DOCUMENT_ROUTES,
  // One version's bytes moved onto the document's file route (ADR-0131).
  { from: '/api/documents/:id/versions/:versionId/file', to: '/api/documents/:id/file?versionId=:versionId' },
  { from: '/api/documents/:id/fassung', to: '/api/documents/:id/revision' },
  { from: '/api/documents/:id/fassung-compare', to: '/api/documents/:id/revision-compare' },
  { from: '/api/documents/fassung-candidates', to: '/api/documents/revision-candidates' },
  { from: '/api/projects/:id/steckbrief', to: '/api/projects/:id/project-record' },
]
