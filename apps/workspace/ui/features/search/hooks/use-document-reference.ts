'use client'

/**
 * The composer's `#`, in one place, as `useSlashCommand` keeps the `/`: the
 * composer supplies its text, a way to replace it, and what a pick means;
 * this finds the fragment, asks the workspace search for documents while it is
 * typed (the palette's live search, `usePaletteSearch`), and drives the picker.
 */

import { useCallback, useRef, useState, type KeyboardEvent, type RefObject } from 'react'

import type { DocumentHit, SearchHit, SearchKind, SearchScopeQuery } from '@/lib/search/search-wire'
import type { ComposerSearchPickerAria, ComposerSearchPickerHandle } from '../components/composer-search-picker'
import { COMPOSER_PICKER_HITS } from '../components/composer-search-picker'
import { findDocumentReferenceQuery, insertDocumentReference, type DocumentReferenceQuery } from '../lib/document-reference'
import { usePaletteSearch, type PaletteSearch } from './use-palette-search'

const DOCUMENTS: readonly SearchKind[] = ['document']

export interface UseDocumentReferenceOptions {
  text: string
  /** False: `#` is a character like any other. */
  enabled: boolean
  /** Where the search looks: the chat's project, else the office. */
  scope: SearchScopeQuery
  onReplaceText: (text: string, caret: number) => void
  /** The document picked: the composer makes it the message's subject. */
  onPick: (hit: DocumentHit) => void
}

export interface UseDocumentReferenceResult {
  open: boolean
  query: string
  search: PaletteSearch
  pickerRef: RefObject<ComposerSearchPickerHandle | null>
  aria: ComposerSearchPickerAria
  onAriaChange: (aria: ComposerSearchPickerAria) => void
  syncQuery: (text: string, caret: number) => void
  select: (hit: SearchHit) => void
  /** A key while the picker is open; true when it was used and the composer must do nothing else with it. */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, onSubmit: () => void) => boolean
  dismiss: () => void
}

export function useDocumentReference({ text, enabled, scope, onReplaceText, onPick }: UseDocumentReferenceOptions): UseDocumentReferenceResult {
  const [range, setRange] = useState<DocumentReferenceQuery | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [aria, setAria] = useState<ComposerSearchPickerAria>({ listboxId: null, activeOptionId: null })
  const pickerRef = useRef<ComposerSearchPickerHandle>(null)
  const open = enabled && range !== null && !dismissed
  const search = usePaletteSearch(range?.query ?? '', scope, open, { kinds: DOCUMENTS, limit: COMPOSER_PICKER_HITS })

  const syncQuery = useCallback(
    (nextText: string, caret: number) => {
      if (!enabled) return
      const next = findDocumentReferenceQuery(nextText, caret)
      setRange(next)
      // A fresh `#` opens again a panel Escape closed.
      if (next === null) setDismissed(false)
    },
    [enabled]
  )

  const select = useCallback(
    (hit: SearchHit) => {
      if (!range || hit.kind !== 'document') return
      const { text: nextText, caret } = insertDocumentReference(text, range, hit.title ?? hit.name)
      onReplaceText(nextText, caret)
      onPick(hit)
      setRange(null)
      setDismissed(false)
    },
    [range, text, onReplaceText, onPick]
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>, onSubmit: () => void): boolean => {
      if (!open) return false
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        pickerRef.current?.move(event.key === 'ArrowDown' ? 1 : -1)
        return true
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        if (pickerRef.current?.selectActive()) return true
        // Nothing to pick: close, and an Enter sends as it otherwise would.
        setDismissed(true)
        if (event.key === 'Enter') onSubmit()
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setDismissed(true)
        return true
      }
      return false
    },
    [open]
  )

  const dismiss = useCallback(() => setDismissed(true), [])

  return { open, query: range?.query ?? '', search, pickerRef, aria, onAriaChange: setAria, syncQuery, select, handleKeyDown, dismiss }
}
