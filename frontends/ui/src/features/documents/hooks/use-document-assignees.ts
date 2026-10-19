'use client'

import { useEffect, useState } from 'react'
import { listAssignees } from '@/lib/assignments/client'
import type { FileAssignee } from '../components/project-file-workspace'

/**
 * Who is on the hook for a document. Same list the Files preview reads —
 * assignment is on the document, not on the IFC model row.
 */
export function useDocumentAssignees(documentId: string | null, enabled: boolean) {
  const [assignees, setAssignees] = useState<FileAssignee[]>([])

  useEffect(() => {
    if (!documentId || !enabled) {
      setAssignees([])
      return
    }
    let cancelled = false
    void listAssignees('document', documentId)
      .then((people) => {
        if (!cancelled) setAssignees(people)
      })
      .catch(() => {
        if (!cancelled) setAssignees([])
      })
    return () => {
      cancelled = true
    }
  }, [documentId, enabled])

  return [assignees, setAssignees] as const
}
