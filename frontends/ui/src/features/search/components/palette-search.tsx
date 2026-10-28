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
 * name, one line of where and what, and the passage only on the row the
 * arrows are on, so a glance takes in every kind's hits and the way to all of
 * them stays in view.
 */

import type { JSX, ReactNode } from 'react'
import { createContext, useContext } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Bookmark, History, Search, Users } from 'lucide-react'

import { CommandGroup, CommandItem } from '@/components/ui/command'
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
const hitValue = (href: string): string => `${PALETTE_SEARCH_VALUE_PREFIX}hit:${href}`
export const paletteHitValue = (hit: SearchHit): string => hitValue(hitHref(hit))
export const isPaletteHitValue = (value: string): boolean => value.startsWith(`${PALETTE_SEARCH_VALUE_PREFIX}hit:`)

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
  /** The keys that open the search page from anywhere in the list, shown on its row. */
  allShortcut?: ReactNode
  itemClassName?: string
}

/**
 * „Alle Treffer für …“ stays in view at the foot of the list while hits run
 * past it, on the palette's own surface, so the way to every hit is never a
 * scroll away. Once the list scrolls on to the commands it goes with them.
 */
// `-bottom-1` covers the list's own 4px padding, so no hit shows beneath it.
const PINNED_GROUP_CLASS = 'sticky -bottom-1 z-10 border-t border-border/70 bg-popover'

/** What was typed, answered: three hits of each kind, then the way to all of them. */
export function PaletteSearchResults({
  text,
  answered,
  response,
  loading,
  failed,
  onOpen,
  onPick,
  allHref,
  perKind = PALETTE_HITS_PER_KIND,
  scope = {},
  allShortcut,
  itemClassName,
}: PaletteSearchResultsProps): JSX.Element {
  const t = useTranslations(searchCopy)
  const words = text.trim()
  const stale = answered !== words
  const shown = paletteHits(response, perKind)
  const anyHits = shown.length > 0
  const status = failed ? t('error') : loading || stale ? t('loading') : response && !anyHits ? t('palette.noHits') : null
  const select = onPick
    ? (href: string): void => {
        const hit = shown.find((entry) => hitHref(entry) === href)
        if (hit) onPick(hit)
      }
    : onOpen
  return (
    <OpenContext.Provider value={select}>
      <HitScopeProvider scope={scope}>
      <ResultRowFrameProvider value={PaletteHitFrame}>
        {SEARCH_KINDS.map((kind) => {
          const hits = response?.sections[kind]?.hits.slice(0, perKind) ?? []
          if (hits.length === 0) return null
          return (
            <CommandGroup key={kind} heading={t(`kinds.${kind}`)} forceMount className={stale ? PALETTE_STALE_CLASS : undefined} data-testid={`palette-group-${kind}`}>
              {hits.map((hit) => (
                <HitRow key={`${hit.kind}:${hit.id}`} hit={hit} text={answered} />
              ))}
            </CommandGroup>
          )
        })}
      </ResultRowFrameProvider>
      </HitScopeProvider>
      {allHref === null ? (
        status ? (
          <PaletteStatusLine busy={loading && !failed} testId="palette-search-status">
            {status}
          </PaletteStatusLine>
        ) : null
      ) : (
        <CommandGroup forceMount className={anyHits ? PINNED_GROUP_CLASS : undefined}>
          <CommandItem forceMount value={PALETTE_ALL_RESULTS_VALUE} onSelect={() => onOpen(allHref)} className={itemClassName} data-testid="palette-workspace-search">
            <PaletteGlyph icon={Search} />
            <PaletteLabel>{t('palette.allResults', { text: words })}</PaletteLabel>
            {status ? (
              <PaletteAside busy={loading && !failed} testId="palette-search-status">
                {status}
              </PaletteAside>
            ) : null}
            {allShortcut ? <span className={status ? 'flex shrink-0' : 'ml-auto flex shrink-0'}>{allShortcut}</span> : null}
          </CommandItem>
        </CommandGroup>
      )}
    </OpenContext.Provider>
  )
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
