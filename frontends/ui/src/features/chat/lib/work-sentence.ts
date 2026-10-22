/**
 * The sentence of one work-list row (ADR-0131): „Sucht im Projekt „Brandabschnitt“ · 14 Treffer in 3 Dokumenten“.
 *
 * Built from the typed action, never from a tool's text. Every word is a
 * dictionary key (`chat.thinking.work.*`); this only chooses which, so a
 * count the call does not report drops its clause instead of printing „0“.
 */

import type { Translator } from '@/i18n'
import type { StoredAction } from '@/lib/conversations/message-provenance'

export interface WorkSentence {
  /** What was done, with its target. */
  head: string
  /** What it found, or „nichts gefunden“ / „fehlgeschlagen“; absent while running. */
  outcome?: string
  tone: 'normal' | 'empty' | 'error'
}

const SHELF_KEYS: Record<string, string> = {
  project: 'project',
  office: 'office',
  office_shelf: 'office',
  base: 'base',
  web: 'web',
  session: 'session',
}

/** „03 Einreichung/Pläne“ as „03 Einreichung › Pläne“. */
export const breadcrumb = (path: string): string =>
  path
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' › ')

/** The first page of „2-3“ or „2, 4“; null for a Punkt („Pkt. 3.5“) or nothing. */
export const firstPage = (pages: string | undefined): number | null => {
  if (!pages || isPunkt(pages)) return null
  const match = /\d+/.exec(pages)
  const page = match ? Number(match[0]) : 0
  return page >= 1 ? page : null
}

const isPunkt = (pages: string): boolean => /^\s*pkt/i.test(pages)

const headOf = (t: Translator, action: StoredAction): string => {
  const { verb, query, target, pages, mode } = action
  const shelfKey = action.shelf ? SHELF_KEYS[action.shelf.toLowerCase()] : undefined
  const shelf = shelfKey ? t(`thinking.work.shelf.${shelfKey}`) : ''
  const fallback = () => t(`thinking.work.fallback.${verb}`)
  switch (verb) {
    case 'search': {
      if (!query) return fallback()
      const key =
        mode === 'exact' ? 'searchExact' : mode === 'regex' ? 'searchRegex' : 'searchMeaning'
      return t(`thinking.work.${key}${shelf ? 'In' : ''}`, { query, shelf })
    }
    case 'list':
      return target ? t('thinking.work.list', { target: breadcrumb(target) }) : fallback()
    case 'read': {
      if (!target) return fallback()
      if (!pages) return t('thinking.work.read', { target })
      return t(isPunkt(pages) ? 'thinking.work.readClause' : 'thinking.work.readPages', {
        target,
        pages,
      })
    }
    case 'look': {
      if (!target) return fallback()
      return pages && !isPunkt(pages)
        ? t('thinking.work.lookPages', { target, pages })
        : t('thinking.work.look', { target })
    }
    case 'lookup':
      return query ? t('thinking.work.lookupQuery', { query }) : fallback()
    case 'law': {
      const what = target ?? query
      return what ? t('thinking.work.law', { target: what }) : fallback()
    }
    case 'web':
      return query ? t('thinking.work.web', { query }) : fallback()
    case 'model':
      return query ? t('thinking.work.model', { query }) : fallback()
    case 'workspace':
      return target ? t('thinking.work.workspace', { target }) : fallback()
  }
}

/** What the call found, from the counts it reported; undefined when it reported none worth a clause. */
const foundOf = (t: Translator, action: StoredAction): string | undefined => {
  const { hits, documents, searched, files, folders } = action.counts ?? {}
  if (action.verb === 'list') {
    if (files !== undefined && folders !== undefined)
      return t('thinking.work.found.listing', { files, folders })
    if (files !== undefined) return t('thinking.work.found.files', { count: files })
    if (folders !== undefined) return t('thinking.work.found.folders', { count: folders })
    return undefined
  }
  if (hits !== undefined) {
    if (
      documents !== undefined &&
      searched !== undefined &&
      action.mode !== 'meaning' &&
      action.mode !== undefined
    ) {
      return t('thinking.work.found.hitsOfSearched', { hits, documents, searched })
    }
    if (documents !== undefined) return t('thinking.work.found.hitsDocuments', { hits, documents })
    return t('thinking.work.found.hits', { count: hits })
  }
  if (documents !== undefined) return t('thinking.work.found.documents', { count: documents })
  return undefined
}

export function workSentence(t: Translator, action: StoredAction): WorkSentence {
  const head = headOf(t, action)
  if (action.status === 'error') return { head, outcome: t('thinking.work.failed'), tone: 'error' }
  if (action.status === 'empty')
    return { head, outcome: t('thinking.work.nothingFound'), tone: 'empty' }
  if (action.status === 'running') return { head, tone: 'normal' }
  return { head, outcome: foundOf(t, action), tone: 'normal' }
}

/** The whole sentence as one string: head and outcome joined by „ · “. */
export const workSentenceText = (sentence: WorkSentence): string =>
  sentence.outcome ? `${sentence.head} · ${sentence.outcome}` : sentence.head
