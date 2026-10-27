/**
 * The filters a search has set, each with the search it leaves behind when
 * taken off: the chips over the results are this list.
 *
 * What a chip says is decided in the component (it needs the dictionary); what
 * removing it does is decided here, so it can be specced.
 */

import type { DocumentFilters, FactFilter } from '@/lib/search/search-wire'
import { compactFilters, type SearchUrlState } from './search-url'

export type ActiveFilterValue =
  | { kind: 'text'; text: string }
  | { kind: 'documentType'; value: string }
  | { kind: 'partyRole'; role: string | null; name: string | null }
  | { kind: 'readState'; value: string }
  | { kind: 'fact'; fact: FactFilter }
  | { kind: 'range'; from: string | number | null; to: string | number | null }
  | { kind: 'project'; projectId: string }
  | { kind: 'flag' }

export interface ActiveFilter {
  id: string
  /** The i18n key of the field's name, under `search`. */
  labelKey: string
  value: ActiveFilterValue
  next: SearchUrlState
}

export function activeFilters(state: SearchUrlState): ActiveFilter[] {
  const f = state.filters
  const out: ActiveFilter[] = []
  const without = (patch: Partial<DocumentFilters>): SearchUrlState => ({ ...state, filters: compactFilters({ ...f, ...patch }) })
  const each = <T>(values: readonly T[] | undefined, field: keyof DocumentFilters, labelKey: string, value: (entry: T) => ActiveFilterValue, id: (entry: T) => string): void => {
    for (const entry of values ?? []) {
      out.push({
        id: `${String(field)}:${id(entry)}`,
        labelKey,
        value: value(entry),
        next: without({ [field]: (values ?? []).filter((other) => other !== entry) } as Partial<DocumentFilters>),
      })
    }
  }
  const text = (entry: string): ActiveFilterValue => ({ kind: 'text', text: entry })
  const same = (entry: string): string => entry

  if (state.projectId) {
    out.push({ id: 'project', labelKey: 'facets.project', value: { kind: 'project', projectId: state.projectId }, next: { ...state, projectId: null } })
  }
  each(f.documentTypes, 'documentTypes', 'facets.documentType', (value) => ({ kind: 'documentType', value }), same)
  each(f.tags, 'tags', 'facets.tag', text, same)
  if (f.planNumber) out.push({ id: 'planNumber', labelKey: 'filters.planNumber', value: text(f.planNumber), next: without({ planNumber: undefined }) })
  each(f.planIndex, 'planIndex', 'filters.planIndex', text, same)
  if (f.planDate) {
    out.push({ id: 'planDate', labelKey: 'filters.planDate', value: { kind: 'range', from: f.planDate.from ?? null, to: f.planDate.to ?? null }, next: without({ planDate: undefined }) })
  }
  each(f.scale, 'scale', 'filters.scale', text, same)
  if (f.currentOnly) out.push({ id: 'currentOnly', labelKey: 'filters.currentOnly', value: { kind: 'flag' }, next: without({ currentOnly: undefined }) })
  each(f.parties, 'parties', 'filters.parties', (party) => ({ kind: 'partyRole', role: party.role ?? null, name: party.name ?? null }), (party) => `${party.role ?? ''}:${party.name ?? ''}`)
  if (f.place) out.push({ id: 'place', labelKey: 'filters.place', value: text(f.place), next: without({ place: undefined }) })
  each(f.facts, 'facts', 'filters.fact', (fact) => ({ kind: 'fact', fact }), (fact) => `${fact.key}:${fact.equals ?? ''}:${fact.min ?? ''}:${fact.max ?? ''}`)
  each(f.cites, 'cites', 'filters.cites', text, same)
  if (f.uploaded) {
    out.push({ id: 'uploaded', labelKey: 'filters.uploaded', value: { kind: 'range', from: f.uploaded.from ?? null, to: f.uploaded.to ?? null }, next: without({ uploaded: undefined }) })
  }
  each(f.uploadedBy, 'uploadedBy', 'filters.uploadedBy', text, same)
  each(f.states, 'states', 'facets.state', (value) => ({ kind: 'readState', value }), same)
  if (f.incompleteRead) out.push({ id: 'incompleteRead', labelKey: 'filters.incompleteRead', value: { kind: 'flag' }, next: without({ incompleteRead: undefined }) })
  each(f.fileTypes, 'fileTypes', 'facets.fileType', text, same)
  if (f.pages) {
    out.push({ id: 'pages', labelKey: 'filters.pages', value: { kind: 'range', from: f.pages.min ?? null, to: f.pages.max ?? null }, next: without({ pages: undefined }) })
  }
  if (f.includeArchived) out.push({ id: 'includeArchived', labelKey: 'filters.includeArchived', value: { kind: 'flag' }, next: without({ includeArchived: undefined }) })
  return out
}

/** The search with every filter off; the words, the view and the order stay. */
export function clearFilters(state: SearchUrlState): SearchUrlState {
  return { ...state, filters: {}, projectId: null }
}

/** A comma list as the form takes it: „C, D“ → ["C", "D"], empty parts dropped. */
export function splitList(value: string): string[] {
  return [...new Set(value.split(',').map((part) => part.trim()).filter((part) => part !== ''))]
}
