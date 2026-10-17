'use client'

import { useEffect, useState } from 'react'
import { listAssignmentCandidates } from '@/lib/assignments/client'
import type { DirectoryPerson } from '@/lib/sharing/types'

/**
 * Who may be mentioned on a document's Anmerkungen: whoever may open it, the
 * same list the Zuständige picker reads (`listAssignmentCandidates`, by
 * permission and folder, never by role name). Asked for once, when the first
 * „@" is typed (`requested`), so a composer nobody mentions from asks nothing.
 *
 * A refused or failed read is an empty list, not an error: the picker still
 * offers Piloti, and its „Keine Treffer" line says who can be mentioned. The
 * server decides again on every write either way.
 */
export function useMentionablePeople(
  documentId: string | null,
  requested: boolean
): { people: readonly DirectoryPerson[]; loading: boolean } {
  const [state, setState] = useState<{ documentId: string | null; people: DirectoryPerson[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const loaded = state !== null && state.documentId === documentId

  useEffect(() => {
    if (!documentId || !requested || loaded) return
    let cancelled = false
    setLoading(true)
    listAssignmentCandidates('document', documentId)
      .catch(() => [])
      .then((people) => {
        if (!cancelled) setState({ documentId, people })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [documentId, requested, loaded])

  return { people: loaded ? state.people : [], loading: loading && !loaded }
}
