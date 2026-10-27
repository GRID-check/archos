'use client'

/**
 * `/dev/search?composer=1`: the composer's `#` picker (`ComposerSearchPicker`)
 * over the fixture's documents, above a stand-in for the composer's field. The
 * real composer needs a chat session and a socket; the picker is the same
 * component the composer opens, driven the same way (the fragment under the
 * caret, ↑ ↓ ↵ Esc forwarded from the field). A pick writes the name as the
 * composer does and shows the subject it would set.
 */

import type { JSX, KeyboardEvent } from 'react'
import { useMemo, useRef, useState } from 'react'

import { ComposerSearchPicker, type ComposerSearchPickerHandle } from '@/features/search'
import { findDocumentReferenceQuery, insertDocumentReference } from '@/features/search/lib/document-reference'
import type { SearchHit } from '@/lib/search/search-wire'
import { SEARCH_FIXTURE_RESPONSE } from '../_fixtures/search'

const START = 'Was steht zur Fluchtweglänge in #Flucht'

export function ComposerPreview(): JSX.Element {
  const [text, setText] = useState(START)
  const [caret, setCaret] = useState(START.length)
  const [subject, setSubject] = useState<string | null>(null)
  const picker = useRef<ComposerSearchPickerHandle>(null)
  const range = findDocumentReferenceQuery(text, caret)
  const search = useMemo(
    () => ({
      answered: range?.query ?? '',
      response: { ...SEARCH_FIXTURE_RESPONSE, sections: { document: SEARCH_FIXTURE_RESPONSE.sections.document } },
      loading: false,
      failed: false,
    }),
    [range?.query]
  )
  const pick = (hit: SearchHit): void => {
    if (!range || hit.kind !== 'document') return
    const next = insertDocumentReference(text, range, hit.title ?? hit.name)
    setText(next.text)
    setCaret(next.caret)
    setSubject(hit.title ?? hit.name)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!range) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      picker.current?.move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      picker.current?.selectActive()
    }
  }
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 pt-40" data-testid="composer-preview">
      {range ? <ComposerSearchPicker ref={picker} query={range.query} search={search} onPick={pick} /> : null}
      {subject ? <p className="text-xs text-muted-foreground">Gefragt zu: {subject}</p> : null}
      <textarea
        aria-label="Nachricht"
        className="min-h-20 w-full rounded-xl border border-input bg-card px-4 py-3 text-sm shadow-md pointer-coarse:text-base"
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          setCaret(event.target.selectionStart)
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
