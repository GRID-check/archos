'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

/** The query parameter an inbox row sets to land on a sort's dialog: `?rootSort=<runId>`. */
export const ROOT_SORT_PARAM = 'rootSort'

/**
 * Open the root sort dialog a link asks for (`lib/inbox/targets.ts`, the row
 * „Die Sortierung … ist bereit zur Durchsicht“). Opens once per run, and only
 * for a reader who may sort the shelf: `mayOpen` is that answer. Once it has
 * opened, the parameter is dropped, so a reload does not open it again. The
 * dialog reads the run itself (its latest on the shelf), so the id is only the
 * key that makes a link open it once.
 */
export function useRootSortParam(mayOpen: boolean, open: () => void): void {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const runId = searchParams?.get(ROOT_SORT_PARAM)?.trim() || null
  const handled = useRef<string | null>(null)

  useEffect(() => {
    if (!runId || !mayOpen) return
    if (handled.current === runId) return
    handled.current = runId
    open()
    const params = new URLSearchParams(searchParams?.toString() ?? '')
    params.delete(ROOT_SORT_PARAM)
    const query = params.toString()
    const path = pathname ?? ''
    router.replace(query ? `${path}?${query}` : path, { scroll: false })
  }, [mayOpen, open, pathname, router, runId, searchParams])
}
