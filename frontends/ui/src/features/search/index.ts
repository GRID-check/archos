/**
 * The workspace search (ADR-0133, `docs/design/document-search.md`): one
 * organism at every scope. Routes import from here.
 */

export { SearchWorkspace, type SearchWorkspaceProps } from './components/search-workspace'
export { SearchWorkspaceView, type SearchWorkspaceViewProps } from './components/search-workspace-view'
export { ShelfSearchBack, ShelfSearchToggle } from './components/shelf-search-toggle'
export { useShelfSearchMode } from './hooks/use-shelf-search-mode'
export type { SearchSurface } from './lib/search-surface'
export { EMPTY_SEARCH_STATE, parseSearchParams, writeSearchParams, type SearchUrlState } from './lib/search-url'
