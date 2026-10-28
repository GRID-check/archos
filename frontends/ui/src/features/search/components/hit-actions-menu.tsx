'use client'

/**
 * A document hit's ⋯: the house's `ActionMenu`, the same dropdown a document
 * row in Dateien opens, with the entries of `lib/hit-actions.ts`.
 *
 * The search page holds which hit's menu is open (`HitMenuProvider`), so the
 * field's keyboard can open the active row's menu (Shift+F10 or the context
 * menu key, the platform's key for "the menu of the thing I am on") while the
 * focus stays in the field. Without a provider (the ⌘K palette, whose rows
 * are options of its own list) a hit has no menu.
 */

import type { JSX, ReactNode } from 'react'
import { createContext, useContext } from 'react'
import { MoreHorizontal } from 'lucide-react'

import { ActionMenu } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { searchCopy } from '@/i18n/namespaces/search'
import type { DocumentHit } from '@/lib/search/search-wire'
import { useDocumentHitActions } from '../hooks/use-document-hit-actions'

export interface HitMenuState {
  /** The hit whose menu is open (`document:<id>`), or null. */
  openKey: string | null
  onOpenKeyChange: (key: string | null) => void
}

const HitMenuContext = createContext<HitMenuState | null>(null)

export function HitMenuProvider({ value, children }: { value: HitMenuState; children: ReactNode }): JSX.Element {
  return <HitMenuContext.Provider value={value}>{children}</HitMenuContext.Provider>
}

/** Whether the hits drawn here carry a menu: on the search page, not in the palette. */
export function useHitMenus(): boolean {
  return useContext(HitMenuContext) !== null
}

export function DocumentHitMenu({ hit }: { hit: DocumentHit }): JSX.Element | null {
  const state = useContext(HitMenuContext)
  const t = useTranslations(searchCopy, 'hitActions')
  const entries = useDocumentHitActions(hit)
  if (!state) return null
  const key = `document:${hit.id}`
  return (
    <ActionMenu
      mode="dropdown"
      entries={entries}
      open={state.openKey === key}
      onOpenChange={(open) => state.onOpenKeyChange(open ? key : null)}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={t('label', { name: hit.title ?? hit.name })}
          title={t('menuLabel')}
          data-testid={`search-hit-actions-${hit.id}`}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      }
    />
  )
}
