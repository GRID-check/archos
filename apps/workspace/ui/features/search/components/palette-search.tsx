'use client'

/**
 * The workspace search inside the ⌘K palette: live hits grouped by kind as
 * the reader types, the way to every hit („Alle Treffer für …“) as the last
 * search row, and, while the field is empty, what the search reaches, the
 * recent searches and the saved ones.
 *
 * A hit is drawn by the result list's own row components (`HitRow`) inside a
 * cmdk option (`ResultRowFrameProvider`), so the palette and the search page
 * show one hit with the same parts. In the palette the row is compact: the
 * name, one line of where and what, and the passage on one line under it, on
 * every row that has one, so the rows hold still while the arrows walk them.
 */

import type { JSX } from 'react'
import { createContext, useContext } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Bookmark, History, RotateCw, Search, Users } from 'lucide-react'

import { CommandGroup, CommandItem } from '@/components/ui/command'
import { useDelayedFlag } from '@/hooks/use-transient-flag'
import { useTranslations } from '@/i18n'
import { searchCopy } from '@/i18n/namespaces/search'
import type { SavedSearchView } from '@/lib/search/saved-search-client'
import { SEARCH_KINDS, type SearchHit, type SearchResponse, type SearchScopeQuery } from '@/lib/search/search-wire'
import { PALETTE_HITS_PER_KIND } from '../hooks/use-palette-search'
import { hitHref } from '../lib/search-hrefs'
import {
  PALETTE_HIT_CLASS,
  PALETTE_STALE_CLASS,
  PaletteAside,
  PaletteEmpty,
  PaletteGroupHeading,
  PaletteHitsSkeleton,
  PaletteScopeLine,
  PaletteGlyph,
  PaletteLabel,
  PaletteStatusLine,
  ResultRowFrameProvider,
  type ResultRowFrameProps,
} from './search-atoms'
import { HitRow, HitScopeProvider } from './search-result-list'

/** Every row this module adds carries this prefix, so the palette's filter can rank them above the commands. */
export const PALETTE_SEARCH_VALUE_PREFIX = 'search:'
export const PALETTE_ALL_RESULTS_VALUE = `${PALETTE_SEARCH_VALUE_PREFIX}all`
export const PALETTE_RETRY_VALUE = `${PALETTE_SEARCH_VALUE_PREFIX}retry`
const hitValue = (href: string): string => `${PALETTE_SEARCH_VALUE_PREFIX}hit:${href}`
export const paletteHitValue = (hit: SearchHit): string => hitValue(hitHref(hit))
export const isPaletteHitValue = (value: string): boolean => value.startsWith(`${PALETTE_SEARCH_VALUE_PREFIX}hit:`)
/** Where a hit's option goes: its value without the prefix. */
export const paletteHitHref = (value: string): string => value.slice(`${PALETTE_SEARCH_VALUE_PREFIX}hit:`.length)

type CommandFilter = (value: string, search: string, keywords?: string[]) => number

/**
 * The palette's cmdk filter: its own search rows always match and rank first
 * (the server decided they match; the typed words need not spell them, a
 * passage on page 7 does not contain its document's name), every other row by
 * cmdk's own scoring.
 */
export function paletteFilter(defaultFilter: CommandFilter): CommandFilter {
  return (value, search, keywords) => (value.startsWith(PALETTE_SEARCH_VALUE_PREFIX) ? 2 : defaultFilter(value, search, keywords))
}

const OpenContext = createContext<(href: string) => void>(() => {})

/** A hit's row as a palette option: Enter or a click opens where the workspace shows it. */
function PaletteHitFrame({ href, testId, className, children }: ResultRowFrameProps): JSX.Element {
  const open = useContext(OpenContext)
  return (
    <CommandItem
      // Mounted with the answer, not a render later once cmdk has scored it:
      // the server already decided it matches (`paletteFilter` ranks it first
      // regardless), and a row cmdk drew one commit late landed the panel's new
      // height after the glide (`useHeightGlide`) had measured, so it jumped.
      forceMount
      value={hitValue(href)}
      onSelect={() => open(href)}
      className={`${className} ${PALETTE_HIT_CLASS}`}
      data-testid={testId ? `palette-${testId}` : undefined}
    >
      {children}
    </CommandItem>
  )
}

export interface PaletteSearchResultsProps {
  /** The words in the field. */
  text: string
  /** The words the answer is for; lags `text` while a newer answer is on its way. */
  answered: string
  response: SearchResponse | null
  loading: boolean
  failed: boolean
  /** Open a hit, or the search page, and close the palette. */
  onOpen: (href: string) => void
  /** Ask again after a failed answer; given, the failure's row offers it instead of the search page. */
  onRetry?: () => void
  /**
   * Pick a hit instead of opening it: the composer's `#`, which puts the hit
   * into the message. Given, a hit's Enter or click picks it.
   */
  onPick?: (hit: SearchHit) => void
  /** The search page asking `text` at the palette's scope; null leaves the row out, and the status stands as a line of its own. */
  allHref: string | null
  /** Hits of each kind shown. */
  perKind?: number
  /** The scope the palette searched in; a row leaves out the shelf it already says. */
  scope?: SearchScopeQuery
  itemClassName?: string
}

/**
 * How long a search runs before the palette says it is still searching: the
 * field's progress line and the quieter hits both wait for it, so one wait is
 * one change on screen. The debounce and an ordinary answer fit inside it, so
 * typing never dims the hits on every key.
 */
export const PALETTE_LATE_ANSWER_MS = 300

/** What was typed, answered: three hits of each kind, then the way to all of them. */
export function PaletteSearchResults({
  text,
  answered,
  response,
  loading,
  failed,
  onOpen,
  onRetry,
  onPick,
  allHref,
  perKind = PALETTE_HITS_PER_KIND,
  scope = {},
  itemClassName,
}: PaletteSearchResultsProps): JSX.Element {
  const t = useTranslations(searchCopy)
  const words = text.trim()
  const stale = answered !== words
  const shown = paletteHits(response, perKind)
  const anyHits = shown.length > 0
  const busy = !failed && (loading || stale)
  const late = useDelayedFlag(busy && anyHits, PALETTE_LATE_ANSWER_MS)
  // „3 von 14“ only where there are more than the rows show: a bare 14 over
  // three rows promised hits the palette has no way to reach but the page.
  const tCount = (kind: (typeof SEARCH_KINDS)[number]): string | null => {
    const section = response?.sections[kind]
    const shownHere = Math.min(section?.hits.length ?? 0, perKind)
    if (!section || (section.total <= shownHere && !section.totalIsLowerBound)) return null
    const total = section.totalIsLowerBound ? t('totalAtLeast', { count: section.total }) : String(section.total)
    return t('palette.ofTotal', { shown: shownHere, total })
  }
  // What the search is doing. Searching is said by the field's own progress
  // line (`CommandInput busy`) and here only to a screen reader: a „Sucht…“
  // that came and went at the row's end on every key was the panel's flicker.
  // An answer that found nothing, or failed, is shown.
  const status = failed ? t('error') : busy ? t('loading') : response && !anyHits ? t('palette.noHits') : null
  // On `loading`, not on the words alone: `loading` turns on a render after
  // the keystroke, the render in which cmdk drops the commands the words do not
  // match, so the placeholder and the shorter command list arrive in one frame.
  // On the words, the placeholder stood one frame over the whole command list.
  const firstAnswer = loading && !failed && response === null
  const empty = !busy && (failed || (response !== null && !anyHits))
  const oneProject = scope.scope === 'project' ? null : sharedProject(shown)
  const rowScope: SearchScopeQuery = oneProject ? { scope: 'project', projectId: oneProject.id } : scope
  const select = onPick
    ? (href: string): void => {
        const hit = shown.find((entry) => hitHref(entry) === href)
        if (hit) onPick(hit)
      }
    : onOpen
  return (
    <OpenContext.Provider value={select}>
      {oneProject ? <PaletteScopeLine project={oneProject.name} dimmed={late} /> : null}
      <HitScopeProvider scope={rowScope}>
      <ResultRowFrameProvider value={PaletteHitFrame}>
        {SEARCH_KINDS.map((kind) => {
          const hits = response?.sections[kind]?.hits.slice(0, perKind) ?? []
          if (hits.length === 0) return null
          return (
            <CommandGroup
              key={kind}
              heading={<PaletteGroupHeading count={tCount(kind)}>{t(`kinds.${kind}`)}</PaletteGroupHeading>}
              forceMount
              // No entrance of its own: the hits take the placeholder's place at
              // full strength while the card's height glides, and a fade from
              // nothing in the same frame read as the panel blinking blank.
              className={late ? PALETTE_STALE_CLASS : undefined}
              aria-busy={late || undefined}
              data-testid={`palette-group-${kind}`}
            >
              {hits.map((hit) => (
                <HitRow key={`${hit.kind}:${hit.id}`} hit={hit} text={answered} />
              ))}
            </CommandGroup>
          )
        })}
      </ResultRowFrameProvider>
      </HitScopeProvider>
      {firstAnswer ? <PaletteHitsSkeleton /> : null}
      {allHref === null ? (
        status ? (
          <PaletteStatusLine busy={loading && !failed} testId="palette-search-status">
            {status}
          </PaletteStatusLine>
        ) : null
      ) : (
        <>
          {empty ? (
            <PaletteEmpty
              title={failed ? t('error') : t('palette.noHitsFor', { text: words })}
              hint={failed ? (onRetry ? t('palette.retryHint') : undefined) : t(scope.scope === 'project' ? 'palette.hint.project' : 'palette.hint.office')}
              testId="palette-search-status"
            />
          ) : (
            <span className="sr-only" aria-live="polite" data-testid="palette-search-status">
              {status}
            </span>
          )}
          <CommandGroup forceMount>
            {failed && onRetry ? (
              <CommandItem forceMount value={PALETTE_RETRY_VALUE} onSelect={onRetry} className={itemClassName} data-testid="palette-search-retry">
                <PaletteGlyph icon={RotateCw} />
                <PaletteLabel>{t('palette.retry')}</PaletteLabel>
              </CommandItem>
            ) : null}
            <CommandItem forceMount value={PALETTE_ALL_RESULTS_VALUE} onSelect={() => onOpen(allHref)} className={itemClassName} data-testid="palette-workspace-search">
              <PaletteGlyph icon={Search} />
              {/* Nothing here is no promise of nothing there: the page searches with filters, and further than three of a kind. */}
              <PaletteLabel>{empty ? t('palette.continueInSearch') : t('palette.allResults', { text: words })}</PaletteLabel>
            </CommandItem>
          </CommandGroup>
        </>
      )}
    </OpenContext.Provider>
  )
}

/**
 * The one project every hit shown lives in, when there are several hits and
 * they agree: the palette then names it once above them rather than on each
 * row. Null when any hit is a project itself, sits in the Büroablage, or in
 * another project.
 */
export function sharedProject(hits: readonly SearchHit[]): { id: string; name: string } | null {
  if (hits.length < 2) return null
  let shared: { id: string; name: string } | null = null
  for (const hit of hits) {
    if (hit.kind === 'project' || !hit.projectId || !hit.projectName) return null
    if ('shelf' in hit && hit.shelf !== 'project') return null
    if (shared && shared.id !== hit.projectId) return null
    shared = { id: hit.projectId, name: hit.projectName }
  }
  return shared
}

/** The hits the results show, in their order: each kind's first `perKind`, the kinds in the contract's order. */
export function paletteHits(response: SearchResponse | null, perKind: number = PALETTE_HITS_PER_KIND): SearchHit[] {
  return SEARCH_KINDS.flatMap((kind): SearchHit[] => response?.sections[kind]?.hits.slice(0, perKind) ?? [])
}

export interface PaletteSearchStartProps {
  /** Whether the palette stands in a project, which the search is then scoped to. */
  inProject: boolean
  recent: readonly string[]
  /** null while they are read. */
  saved: readonly SavedSearchView[] | null
  onRecent: (text: string) => void
  onSaved: (item: SavedSearchView) => void
  onOpenSearch: () => void
  itemClassName?: string
}

/**
 * The palette before anything is typed: the search page with one line on what
 * the search reaches (so nobody has to guess whether a plan's content is
 * searched), then the reader's recent and saved searches.
 */
export function PaletteSearchStart({ inProject, recent, saved, onRecent, onSaved, onOpenSearch, itemClassName }: PaletteSearchStartProps): JSX.Element {
  const t = useTranslations(searchCopy)
  return (
    <>
      <CommandGroup forceMount>
        <CommandItem forceMount value={PALETTE_ALL_RESULTS_VALUE} onSelect={onOpenSearch} className={itemClassName} data-testid="palette-workspace-search">
          <PaletteGlyph icon={Search} top />
          <PaletteLabel hint={t(inProject ? 'palette.hint.project' : 'palette.hint.office')} hintTestId="palette-search-hint">
            {t('palette.open')}
          </PaletteLabel>
        </CommandItem>
      </CommandGroup>
      {recent.length > 0 ? (
        <CommandGroup heading={t('palette.recent')} data-testid="palette-recent">
          {recent.map((entry) => (
            <PaletteRow key={entry} value={`${PALETTE_SEARCH_VALUE_PREFIX}recent:${entry}`} icon={History} onSelect={() => onRecent(entry)} className={itemClassName}>
              {entry}
            </PaletteRow>
          ))}
        </CommandGroup>
      ) : null}
      {saved && saved.length > 0 ? (
        <CommandGroup heading={t('saved.label')} data-testid="palette-saved">
          {saved.map((item) => (
            <PaletteRow
              key={item.id}
              value={`${PALETTE_SEARCH_VALUE_PREFIX}saved:${item.id}`}
              icon={item.ownedByMe ? Bookmark : Users}
              onSelect={() => onSaved(item)}
              className={itemClassName}
              aside={item.ownedByMe ? undefined : item.ownerName ? t('saved.byColleague', { name: item.ownerName }) : t('saved.fromColleague')}
            >
              {item.name}
            </PaletteRow>
          ))}
        </CommandGroup>
      ) : null}
    </>
  )
}

function PaletteRow({
  value,
  icon,
  onSelect,
  className,
  aside,
  children,
}: {
  value: string
  icon: LucideIcon
  onSelect: () => void
  className?: string
  aside?: string
  children: string
}): JSX.Element {
  return (
    <CommandItem value={value} onSelect={onSelect} className={className}>
      <PaletteGlyph icon={icon} />
      <PaletteLabel>{children}</PaletteLabel>
      {aside ? <PaletteAside>{aside}</PaletteAside> : null}
    </CommandItem>
  )
}
