'use client'

import type { JSX, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { useTranslations } from '@/i18n'
import { SEARCH_LIMIT_DEFAULT } from '@/lib/search/search-wire'
import { useSavedSearches } from '../hooks/use-saved-searches'
import { useSearchResults } from '../hooks/use-search-results'
import { useSearchUrlState } from '../hooks/use-search-url-state'
import { exportSearch, type SearchExportFormat } from '../lib/search-client'
import { fromSearchBody, toSearchBody } from '../lib/search-url'
import { projectFromSavedScope, surfaceScope, type SearchSurface } from '../lib/search-surface'
import { SavedSearchesMenu } from './saved-searches-menu'
import { SearchInset } from './search-atoms'
import { SearchWorkspaceView } from './search-workspace-view'

/** The register reads longer pages than a list: it is walked, not skimmed. */
const REGISTER_LIMIT = 100

export interface SearchWorkspaceProps {
  surface: SearchSurface
  /** Controls before the view switch (the way back to the Dateien). */
  leading?: ReactNode
  currentUserId?: string
  autoFocus?: boolean
  /** Inside a shelf's frame, which lends no page padding. */
  inset?: boolean
}

/**
 * The search organism, connected: the question lives in the URL, the answer
 * comes from `POST /api/search` at the surface's scope, the Planliste from
 * its export, saved searches from `/api/search/saved`. The same component is
 * the office-wide page, a project's Dateien → Suche and the office shelf's.
 */
export function SearchWorkspace({ surface, leading, currentUserId, autoFocus = false, inset = false }: SearchWorkspaceProps): JSX.Element {
  const t = useTranslations('search')
  const { state, setState, fieldValue, setFieldValue } = useSearchUrlState()
  const scope = useMemo(() => surfaceScope(surface, state), [surface, state])
  const body = useMemo(
    () => toSearchBody(state, { limit: state.view === 'register' ? REGISTER_LIMIT : SEARCH_LIMIT_DEFAULT, facets: true }),
    [state]
  )
  const results = useSearchResults(scope, body)
  const saved = useSavedSearches()
  const [exporting, setExporting] = useState(false)

  const onExport = async (format: SearchExportFormat): Promise<void> => {
    setExporting(true)
    const outcome = await exportSearch(scope, toSearchBody(state), format, t('export.fileName'))
    setExporting(false)
    if (!outcome.saved) toast.error(t('export.failed'))
  }

  const view = (
    <SearchWorkspaceView
      surface={surface}
      state={state}
      onStateChange={(next) => setState(next)}
      fieldValue={fieldValue}
      onFieldChange={setFieldValue}
      response={results.response}
      sections={results.sections}
      loading={results.loading}
      failed={results.failed}
      onRetry={results.retry}
      onLoadMore={results.loadMore}
      onExport={(format) => void onExport(format)}
      exporting={exporting}
      leading={leading}
      currentUserId={currentUserId}
      autoFocus={autoFocus}
      savedSearches={(narrow) => (
        <SavedSearchesMenu
          narrow={narrow}
          items={saved.items}
          failed={saved.failed}
          onApply={(item) => setState(fromSearchBody(item.query, projectFromSavedScope(surface, item.scope)))}
          onToggleShare={(item) => {
            void saved.toggleShare(item).then((ok) => {
              if (!ok) toast.error(t('saved.changeFailed'))
            })
          }}
          onDelete={(item) => {
            void saved.remove(item).then((ok) => {
              if (!ok) toast.error(t('saved.deleteFailed'))
            })
          }}
          onSave={async ({ name, shared }) => {
            const created = await saved.save({ name, shared, scope, query: toSearchBody(state) })
            if (created) toast.success(t('saved.savedToast'))
            else toast.error(t('saved.saveFailed'))
            return created !== null
          }}
        />
      )}
    />
  )
  return inset ? <SearchInset>{view}</SearchInset> : view
}
