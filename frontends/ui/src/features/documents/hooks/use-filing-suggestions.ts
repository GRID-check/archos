'use client'

/**
 * A shelf's open filing suggestions (`GET /api/proposals`, through its typed
 * client), keyed by document id for the file rows and the upload tray.
 *
 * Read when the shelf is shown and whenever the caller's `refreshKey` moves (a
 * listing re-read, a decision). While an upload is on screen (`watching`) it
 * is read again every few seconds: the judgement from the file names runs as
 * soon as the batch is sealed, and the person should see its answer while they
 * are still looking at the upload, not on their next visit. A failed read
 * keeps what was shown; a suggestion is never worth an error on the page.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { listOpenProposals } from '@/lib/proposals/client'
import type { ProposalListQuery } from '@/lib/proposals/types'
import { suggestionsByDocument, type FilingSuggestionView } from '../lib/filing-suggestions'

/** How often an upload on screen asks again: the runner's poll plus one model call fit in two rounds. */
export const FILING_POLL_MS = 4000

export interface FilingSuggestions {
  byDocument: ReadonlyMap<string, FilingSuggestionView>
  reload: () => void
}

const EMPTY: ReadonlyMap<string, FilingSuggestionView> = new Map()

export function useFilingSuggestions({
  query,
  refreshKey,
  watching,
}: {
  /** The shelf: a project's (`projectId`) or the Büroablage's (`shelf: 'archiv'`); null asks nothing. */
  query: ProposalListQuery | null
  refreshKey?: unknown
  watching: boolean
}): FilingSuggestions {
  const [byDocument, setByDocument] = useState<ReadonlyMap<string, FilingSuggestionView>>(EMPTY)
  const projectId = query?.projectId
  const archiv = query?.shelf === 'archiv'
  const asked = query !== null
  const generation = useRef(0)

  const reload = useCallback(() => {
    if (!asked) return
    const mine = ++generation.current
    const shelf: ProposalListQuery = projectId ? { projectId, kind: 'file_operation' } : { shelf: 'archiv', kind: 'file_operation' }
    listOpenProposals(shelf).then(
      ({ proposals }) => {
        if (mine === generation.current) setByDocument(suggestionsByDocument(proposals))
      },
      () => undefined
    )
  }, [asked, projectId])

  useEffect(() => {
    reload()
  }, [reload, refreshKey, archiv])

  useEffect(() => {
    if (!watching || !asked) return
    const timer = setInterval(reload, FILING_POLL_MS)
    return () => clearInterval(timer)
  }, [watching, asked, reload])

  return { byDocument, reload }
}
