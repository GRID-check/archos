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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listOpenProposals } from '@/lib/proposals/client'
import type { ListedProposal, ProposalListQuery } from '@/lib/proposals/types'
import {
  suggestionsByDocument,
  suggestionsByFolder,
  type FilingFolderSuggestion,
  type FilingSuggestionView,
} from '../lib/filing-suggestions'

/** How often an upload on screen asks again: the runner's poll plus one model call fit in two rounds. */
export const FILING_POLL_MS = 4000

export interface FilingSuggestions {
  /** For a file row: by the id of each document a suggestion names. */
  byDocument: ReadonlyMap<string, FilingSuggestionView>
  /** For a page that lists them: one per target folder. */
  byFolder: readonly FilingFolderSuggestion[]
  reload: () => void
}

const EMPTY: readonly ListedProposal[] = []

export function useFilingSuggestions({
  query,
  refreshKey,
  watching,
}: {
  /** The shelf: a project's (`projectId`) or the Büroablage's (`shelf: 'office_shelf'`); null asks nothing. */
  query: ProposalListQuery | null
  refreshKey?: unknown
  watching: boolean
}): FilingSuggestions {
  const [listed, setListed] = useState<readonly ListedProposal[]>(EMPTY)
  const projectId = query?.projectId
  const officeShelf = query?.shelf === 'office_shelf'
  const asked = query !== null
  const generation = useRef(0)

  const reload = useCallback(() => {
    if (!asked) return
    const mine = ++generation.current
    const shelf: ProposalListQuery = projectId ? { projectId, kind: 'file_operation' } : { shelf: 'office_shelf', kind: 'file_operation' }
    listOpenProposals(shelf).then(
      ({ proposals }) => {
        if (mine === generation.current) setListed(proposals)
      },
      () => undefined
    )
  }, [asked, projectId])

  useEffect(() => {
    reload()
  }, [reload, refreshKey, officeShelf])

  useEffect(() => {
    if (!watching || !asked) return
    const timer = setInterval(reload, FILING_POLL_MS)
    return () => clearInterval(timer)
  }, [watching, asked, reload])

  const byDocument = useMemo(() => suggestionsByDocument(listed), [listed])
  const byFolder = useMemo(() => suggestionsByFolder(listed), [listed])
  return { byDocument, byFolder, reload }
}
