'use client'

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { fetchDocumentRow } from '@/lib/documents/level-client'
import { toFileItem, type DocumentWireRow } from '../lib/file-item'
import type { FileItem } from '../file-types'

export interface LinkedDocumentsOptions {
  /** The rows the workspace already holds: a link to one of them needs nothing. */
  known: readonly FileItem[]
  /** The documents a link names by id (`?doc=`, `?compare=`); empty entries are ignored. */
  ids: readonly (string | null | undefined)[]
  /** A model the URL names by file name (`?model=`), and how to find it when no loaded row has that name. */
  byName?: { name: string | null; resolve: (name: string) => Promise<DocumentWireRow[]> }
  fetcher?: typeof fetch
}

export interface LinkedDocuments {
  /** The linked documents no loaded page holds, read one by one. */
  files: FileItem[]
  setFiles: Dispatch<SetStateAction<FileItem[]>>
  /** Every linked id is resolved: present, read, or known not to be there for this reader. */
  settled: boolean
}

/**
 * The documents a link names that the paged level has not loaded (ADR-0102).
 *
 * `?doc=<id>` and `?compare=<older>` used to wait for the drain to bring the
 * row: the whole shelf was going to arrive, so a missing id was only "not yet".
 * A level read page by page never brings a document from another folder, or
 * one far down a long folder, so each id the loaded rows do not hold is read on
 * its own (`GET /api/documents/{id}`) and pinned beside them. A 403 or 404 is
 * an answer too: the link names nothing this reader may open, and
 * {@link LinkedDocuments.settled} says so, so the comparison stops waiting.
 *
 * The Archiv's model stage finds its document by file name; the same holds
 * for it, through the by-name resolve.
 */
export function useLinkedDocuments({ known, ids, byName, fetcher }: LinkedDocumentsOptions): LinkedDocuments {
  const [files, setFiles] = useState<FileItem[]>([])
  /** Ids already answered, found or not. */
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set())

  const knownIds = useMemo(() => new Set(known.map((file) => file.id)), [known])
  const missingKey = useMemo(
    () =>
      [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
        .filter((id) => !knownIds.has(id))
        .sort()
        .join(','),
    [ids, knownIds]
  )

  useEffect(() => {
    const wanted = missingKey === '' ? [] : missingKey.split(',').filter((id) => !answered.has(id))
    if (wanted.length === 0) return
    const controller = new AbortController()
    void Promise.all(
      wanted.map((id) =>
        fetchDocumentRow(id, { signal: controller.signal, fetcher })
          .then((row) => ({ id, row, answered: true }))
          // A transport failure is no answer: the link may still name a
          // document, so nothing concludes it is absent.
          .catch(() => ({ id, row: null, answered: false }))
      )
    ).then((results) => {
      if (controller.signal.aborted) return
      const found = results.flatMap(({ row }) => (row ? [toFileItem(row)] : []))
      if (found.length > 0) {
        setFiles((previous) => [...previous.filter((file) => !found.some((row) => row.id === file.id)), ...found])
      }
      const settledIds = results.filter((result) => result.answered).map(({ id }) => id)
      if (settledIds.length > 0) setAnswered((previous) => new Set([...previous, ...settledIds]))
    })
    return () => controller.abort()
  }, [missingKey, answered, fetcher])

  const modelName = byName?.name ?? null
  const resolveByName = byName?.resolve
  const nameKnown = modelName !== null && (known.some((file) => file.filename === modelName) || files.some((file) => file.filename === modelName))
  useEffect(() => {
    if (modelName === null || nameKnown || !resolveByName) return
    let cancelled = false
    resolveByName(modelName)
      .then((rows) => {
        if (cancelled) return
        const found = rows.filter((row) => row.filename === modelName).map(toFileItem)
        if (found.length > 0) setFiles((previous) => [...previous, ...found.filter((row) => !previous.some((file) => file.id === row.id))])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [modelName, nameKnown, resolveByName])

  const settled = missingKey === '' || missingKey.split(',').every((id) => answered.has(id) || files.some((file) => file.id === id))
  const pinned = useMemo(() => files.filter((file) => !knownIds.has(file.id)), [files, knownIds])

  return { files: pinned, setFiles, settled }
}
