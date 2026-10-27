/**
 * What the workspace search tells PostHog (docs/observability/posthog-events.md,
 * "Workspace search"): one `search_issued` per settled question, the hit a
 * reader opens from it, and how they narrowed it.
 *
 * Never the words, never an id: a question is described by its shape (has
 * text, how many words, which kinds and filter dimensions, which view) and its
 * answer by counts. A hit is its kind, its place in its section and why it
 * matched. The events' properties are built here, pure, so a spec holds that
 * line rather than a reviewer.
 */

import { capturePosthog, type PostHogEvent } from '@/lib/analytics/posthog'
import type { DocumentFilters, SearchBody, SearchHit, SearchKind, SearchResponse, SearchScopeQuery } from '@/lib/search/search-wire'
import type { SearchSurface } from './search-surface'

/** Where a search was asked: the ⌘K palette, the search page, a shelf's Suche, Piloti's composer (reserved, nothing sends it yet). */
export type SearchTelemetrySurface = 'palette' | 'page' | 'shelf' | 'composer'

/** The office-wide page is `page`; a project's Dateien → Suche and the office shelf's are `shelf`. */
export function telemetrySurface(surface: SearchSurface): SearchTelemetrySurface {
  return surface.kind === 'office' ? 'page' : 'shelf'
}

/** How long an answer must stand before its question counts as settled, not a pause in typing. */
export const SEARCH_SETTLE_MS = 1000

/** Where the server spent a search's time, from the route's `Server-Timing` header. */
export interface ServerTiming {
  sqlMs: number | null
  contentMs: number | null
}

/** `sql;dur=12.3, content;dur=80.1, total;dur=92.4` → `{ sqlMs: 12.3, contentMs: 80.1 }`; null for a metric it does not name. */
export function parseServerTiming(header: string | null): ServerTiming {
  const metrics = new Map<string, number>()
  for (const entry of (header ?? '').split(',')) {
    const [name, ...params] = entry.trim().split(';')
    const duration = params.map((param) => param.trim()).find((param) => param.startsWith('dur='))
    const value = duration ? Number(duration.slice('dur='.length)) : Number.NaN
    if (name && Number.isFinite(value)) metrics.set(name.trim(), value)
  }
  return { sqlMs: metrics.get('sql') ?? null, contentMs: metrics.get('content') ?? null }
}

/** The filter dimensions a question sets, sorted: the document filters' names, `annotation`, `kind`, `project`. */
export function filterDimensions(body: Pick<SearchBody, 'filters' | 'annotationFilters'>, extra: { kinds?: boolean; project?: boolean } = {}): string[] {
  const filters = body.filters ?? {}
  const set = (Object.keys(filters) as (keyof DocumentFilters)[]).filter((key) => {
    const value = filters[key]
    return value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0)
  })
  return [
    ...set,
    ...(body.annotationFilters && Object.keys(body.annotationFilters).length > 0 ? ['annotation'] : []),
    ...(extra.kinds ? ['kind'] : []),
    ...(extra.project ? ['project'] : []),
  ].sort()
}

/** The dimensions one change of the question added and removed. */
export function refinements(before: readonly string[], after: readonly string[]): Array<{ change: 'added' | 'removed'; dimension: string }> {
  const had = new Set(before)
  const has = new Set(after)
  return [
    ...after.filter((dimension) => !had.has(dimension)).map((dimension) => ({ change: 'added' as const, dimension })),
    ...before.filter((dimension) => !has.has(dimension)).map((dimension) => ({ change: 'removed' as const, dimension })),
  ]
}

/** One answered question, as `search_issued` describes it. */
export interface IssuedSearch {
  scope: SearchScopeQuery
  body: SearchBody
  response: SearchResponse
  /** From the request to the answer, in the browser. */
  durationMs: number
  serverTiming: ServerTiming
  view: 'list' | 'register'
  /** The dimensions beyond the body's filters: the kinds the reader narrowed to, a project picked on the office page. */
  extraDimensions?: { kinds?: boolean; project?: boolean }
}

type Properties = Record<string, string | number | boolean | null>

export function searchIssuedProperties(surface: SearchTelemetrySurface, issued: IssuedSearch): Properties {
  const text = issued.body.text?.trim() ?? ''
  const sections = Object.values(issued.response.sections)
  const total = sections.reduce((sum, section) => sum + (section?.total ?? 0), 0)
  return {
    surface,
    scope: issued.response.scope.kind,
    has_text: text !== '',
    text_tokens: text === '' ? 0 : text.split(/\s+/).length,
    kinds: issued.body.kinds ? [...issued.body.kinds].sort().join(',') : 'all',
    filter_dims: filterDimensions(issued.body, issued.extraDimensions).join(','),
    view: issued.view,
    results_total: total,
    zero_results: total === 0,
    content_partial: issued.response.contentPartial,
    building: issued.response.building.length,
    duration_ms: Math.round(issued.durationMs),
    sql_ms: issued.serverTiming.sqlMs === null ? null : Math.round(issued.serverTiming.sqlMs),
    content_ms: issued.serverTiming.contentMs === null ? null : Math.round(issued.serverTiming.contentMs),
  }
}

export function searchResultOpenedProperties(surface: SearchTelemetrySurface, hit: SearchHit, rank: number, msSinceIssued: number | null): Properties {
  return {
    surface,
    kind: hit.kind,
    rank,
    matched_on: hit.kind === 'document' ? [...hit.matchedOn].sort().join(',') : null,
    has_passage: hit.kind === 'document' && hit.passage !== null,
    ms_since_issued: msSinceIssued === null ? null : Math.round(msSinceIssued),
  }
}

/** The hit a link points at, and its 1-based place in its section; null when no hit of these sections has that href. */
export function findHitByHref(
  sections: Partial<Record<SearchKind, { hits: readonly SearchHit[] }>>,
  href: string,
  hrefOf: (hit: SearchHit) => string
): { hit: SearchHit; rank: number } | null {
  for (const section of Object.values(sections)) {
    const at = section?.hits.findIndex((hit) => hrefOf(hit) === href) ?? -1
    if (section && at >= 0) return { hit: section.hits[at], rank: at + 1 }
  }
  return null
}

export interface SearchTrackerOptions {
  capture?: (event: PostHogEvent, properties: Properties) => void
  settleMs?: number
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/**
 * One surface's search telemetry. An answer is held for {@link SEARCH_SETTLE_MS}
 * and sent as `search_issued` only if no newer answer replaces it in that
 * time, so a reader typing „Fluchtweg“ through three pauses counts once.
 * Opening a hit, or the surface going away, sends a held answer at once: the
 * reader acted on it, so it was settled.
 */
export class SearchTracker {
  private pending: { issued: IssuedSearch; timer: unknown } | null = null
  private issuedAt: number | null = null
  private readonly capture: NonNullable<SearchTrackerOptions['capture']>
  private readonly settleMs: number
  private readonly now: () => number
  private readonly setTimer: NonNullable<SearchTrackerOptions['setTimer']>
  private readonly clearTimer: NonNullable<SearchTrackerOptions['clearTimer']>

  constructor(
    private readonly surface: SearchTelemetrySurface,
    options: SearchTrackerOptions = {}
  ) {
    this.capture = options.capture ?? capturePosthog
    this.settleMs = options.settleMs ?? SEARCH_SETTLE_MS
    this.now = options.now ?? (() => performance.now())
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  /** An answer arrived for the surface's question. */
  answered(issued: IssuedSearch): void {
    if (this.pending) this.clearTimer(this.pending.timer)
    this.issuedAt = this.now()
    this.pending = { issued, timer: this.setTimer(() => this.flush(), this.settleMs) }
  }

  /** The reader opened `hit`, at `rank` in its section. */
  opened(hit: SearchHit, rank: number): void {
    this.flush()
    this.capture('search_result_opened', searchResultOpenedProperties(this.surface, hit, rank, this.issuedAt === null ? null : this.now() - this.issuedAt))
  }

  /** Send the held answer now, if there is one. */
  flush(): void {
    if (!this.pending) return
    this.clearTimer(this.pending.timer)
    const { issued } = this.pending
    this.pending = null
    this.capture('search_issued', searchIssuedProperties(this.surface, issued))
  }
}

/** `search_refined`, once per dimension a change of the question added or removed. */
export function captureRefinements(before: readonly string[], after: readonly string[], capture: SearchTrackerOptions['capture'] = capturePosthog): void {
  for (const refinement of refinements(before, after)) capture('search_refined', refinement)
}

/** `saved_search_created` and `saved_search_run`: whether it is shared, and the scope it asks. */
export function savedSearchProperties(item: { shared: boolean; scope: SearchScopeQuery }): Properties {
  return { shared: item.shared, scope: item.scope.scope ?? (item.scope.projectId ? 'project' : 'office') }
}

/** `saved_search_run`: a saved search was opened, from the palette or a search surface's menu. */
export function captureSavedSearchRun(item: { shared: boolean; scope: SearchScopeQuery }): void {
  capturePosthog('saved_search_run', savedSearchProperties(item))
}

/** `saved_search_created`, once the server kept it. */
export function captureSavedSearchCreated(item: { shared: boolean; scope: SearchScopeQuery }): void {
  capturePosthog('saved_search_created', savedSearchProperties(item))
}
