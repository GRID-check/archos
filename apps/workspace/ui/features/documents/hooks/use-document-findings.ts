'use client'

import { useEffect, useState } from 'react'
import type { DocumentFindingsResponse } from '@/lib/documents/findings-wire'

/**
 * The project's document findings (`GET /api/projects/[id]/document-findings`),
 * and with `documentId` that document's resolved references. `null` until the
 * read lands, and `null` again when it fails: findings are pointers, and a rail
 * or a panel without them reads exactly as it did before they existed.
 *
 * `refreshKey` re-reads when the caller knows the documents changed (a read
 * finished), without the hook having to know what changed.
 */
export function useDocumentFindings(
  projectId: string | undefined,
  options: { documentId?: string; refreshKey?: string; enabled?: boolean } = {}
): DocumentFindingsResponse | null {
  const { documentId, refreshKey, enabled = true } = options
  const [data, setData] = useState<DocumentFindingsResponse | null>(null)

  useEffect(() => {
    if (!projectId || !enabled) return
    const controller = new AbortController()
    const query = documentId ? `?documentId=${encodeURIComponent(documentId)}` : ''
    fetch(`/api/projects/${encodeURIComponent(projectId)}/document-findings${query}`, { signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as DocumentFindingsResponse) : null))
      .then((body) => setData(body && Array.isArray(body.findings) ? body : null))
      .catch(() => {
        if (!controller.signal.aborted) setData(null)
      })
    return () => controller.abort()
  }, [projectId, documentId, refreshKey, enabled])

  return data
}
