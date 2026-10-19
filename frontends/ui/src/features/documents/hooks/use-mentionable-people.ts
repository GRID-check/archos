'use client'

import { useEffect, useState } from 'react'
import { listAssignmentCandidates } from '@/lib/assignments/client'
import type { DirectoryPerson } from '@/lib/sharing/types'

/**
 * Who may be mentioned on a document's Anmerkungen: whoever may open it, the
 * same list the Zuständige picker reads (`listAssignmentCandidates`, by
 * permission and folder, never by role name). Asked for when an „@" is typed
 * (`attempt`, which the composer counts up on each new „@"), so a composer
 * nobody mentions from asks nothing.
 *
 * A failed read is `failed`, never an empty list: „nobody can be mentioned"
 * and „the list did not load" are different sentences, and the next „@" asks
 * again. A loaded list is kept for the document. The server decides again on
 * every write either way.
 */
export function useMentionablePeople(
  documentId: string | null,
  attempt: number
): { people: readonly DirectoryPerson[]; loading: boolean; failed: boolean } {
  const [state, setState] = useState<{ documentId: string | null; people: DirectoryPerson[] } | null>(null)
  const [failure, setFailure] = useState<{ documentId: string | null; attempt: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const loaded = state !== null && state.documentId === documentId

  useEffect(() => {
    if (!documentId || attempt === 0 || loaded) return
    let cancelled = false
    setLoading(true)
    listAssignmentCandidates('document', documentId)
      .then((people) => {
        if (!cancelled) setState({ documentId, people })
      })
      .catch(() => {
        if (!cancelled) setFailure({ documentId, attempt })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [documentId, attempt, loaded])

  const failed = !loaded && failure !== null && failure.documentId === documentId && failure.attempt === attempt
  return { people: loaded ? state.people : [], loading: loading && !loaded, failed }
}
