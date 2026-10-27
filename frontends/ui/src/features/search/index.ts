/**
 * The workspace search (ADR-0136, `docs/design/document-search.md`): one
 * organism at every scope. Routes import from here.
 */

export { SearchWorkspace, type SearchWorkspaceProps } from './components/search-workspace'
export { SearchWorkspaceView, type SearchWorkspaceViewProps } from './components/search-workspace-view'
export { ShelfSearchBack } from './components/shelf-search-toggle'
export {
  PALETTE_ALL_RESULTS_VALUE,
  PaletteSearchResults,
  PaletteSearchStart,
  paletteFilter,
  isPaletteHitValue,
  paletteHitValue,
} from './components/palette-search'
export { usePaletteSearch, usePaletteShortcuts } from './hooks/use-palette-search'
export {
  ComposerSearchPicker,
  type ComposerSearchPickerAria,
  type ComposerSearchPickerHandle,
} from './components/composer-search-picker'
export { useDocumentReference } from './hooks/use-document-reference'
export { savedSearchHref, searchHref, searchPageHref } from './lib/search-hrefs'
export { captureSavedSearchRun } from './lib/search-telemetry'
export { useShelfSearchMode } from './hooks/use-shelf-search-mode'
export type { SearchSurface } from './lib/search-surface'
export { EMPTY_SEARCH_STATE, parseSearchParams, writeSearchParams, type SearchUrlState } from './lib/search-url'
