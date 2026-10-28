/**
 * Where a search surface stands, and the scope it asks the route for.
 *
 * The office-wide page can be narrowed to one project from the project facet
 * (`state.projectId`); a project's Dateien and the office shelf are their own
 * scope, folder-aware when a folder is open.
 */

import type { SearchScopeQuery } from '@/lib/search/search-wire'
import type { SearchUrlState } from './search-url'

export type SearchSurface =
  | { kind: 'office' }
  | { kind: 'project'; projectId: string; folderId?: string | null }
  | { kind: 'office_shelf'; folderId?: string | null }

export function surfaceScope(surface: SearchSurface, state: Pick<SearchUrlState, 'projectId'>): SearchScopeQuery {
  switch (surface.kind) {
    case 'office':
      return state.projectId ? { scope: 'project', projectId: state.projectId } : {}
    case 'project':
      return { scope: 'project', projectId: surface.projectId, ...(surface.folderId ? { folderId: surface.folderId } : {}) }
    case 'office_shelf':
      return { scope: 'office_shelf', ...(surface.folderId ? { folderId: surface.folderId } : {}) }
  }
}

/** The project a saved scope names, for the office-wide page; none for the scoped surfaces, which keep their own. */
export function projectFromSavedScope(surface: SearchSurface, scope: SearchScopeQuery): string | null {
  return surface.kind === 'office' && scope.scope === 'project' && scope.projectId ? scope.projectId : null
}
