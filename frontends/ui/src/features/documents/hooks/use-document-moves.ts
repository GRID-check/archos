'use client'

import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { FileItem, FolderItem } from '../file-types'

/**
 * Re-filing a document: the menu's „Verschieben" lands here, and so does a card
 * dragged onto a folder.
 *
 * Both go through the one `PATCH /api/documents/{id}/folder` — the gesture adds
 * no capability, which is why it is not a second code path that could disagree
 * with the menu about what a move is. The route resolves the shelf from the
 * document, so a project's file and an Archiv file use the same one.
 *
 * The corpus is updated from the answer rather than refetched. The consequence
 * worth noticing: inside a folder, moving a document out makes the row leave the
 * listing under the cursor. That is correct (the folder is the filter), and the
 * toast names where it went, so the disappearance is explained, not observed.
 */
export function useDocumentMoves(
  files: readonly FileItem[],
  setFiles: Dispatch<SetStateAction<FileItem[]>>,
  folders: readonly FolderItem[]
) {
  const t = useTranslations('files')
  /** Moves of this tab still on the wire; a live re-read waits for them (`isMoving`). */
  const inFlight = useRef(0)
  const isMoving = useCallback(() => inFlight.current > 0, [])

  const moved = useCallback(
    (fileId: string, folderId: string | null) =>
      setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, folderId } : f))),
    [setFiles]
  )

  /** Optimistic: the card visibly leaves the level under the finger, so waiting for a round trip would make a good move look broken. */
  const dropInFolder = useCallback(
    async (documentId: string, folderId: string | null) => {
      const file = files.find((candidate) => candidate.id === documentId)
      if (!file || (file.folderId ?? null) === folderId) return
      const previousFolderId = file.folderId ?? null
      const folderName = folderId
        ? (folders.find((folder) => folder.id === folderId)?.name ?? '')
        : t('folders.allFiles')

      moved(documentId, folderId)
      inFlight.current += 1
      try {
        const response = await fetch(`/api/documents/${documentId}/folder`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderId }),
        })
        if (!response.ok) throw new Error(`Move failed (${response.status})`, { cause: response.status })
        toast.success(t('actions.moved', { name: documentDisplayName(file), folder: folderName }))
      } catch (error) {
        moved(documentId, previousFolderId)
        // 409: an IFC model bound for a restricted folder (ADR-0087). Retrying
        // cannot help, so say why.
        toast.error(
          error instanceof Error && error.cause === 409 ? t('folders.access.ifcRefused') : t('actions.moveError')
        )
      } finally {
        inFlight.current -= 1
      }
    },
    [files, folders, moved, t]
  )

  /**
   * Re-file a selection into one folder: the rows leave the level at once (as a
   * drag does) and a failed one comes back, so five site photos are one gesture
   * and ONE toast, not five. A few requests at a time, because a phone on a
   * poor line is better served by four finished moves than by thirty half-open
   * ones. Resolves with how many moved.
   */
  const moveMany = useCallback(
    async (documentIds: readonly string[], folderId: string | null, folderName: string): Promise<number> => {
      const targets = files.filter((file) => documentIds.includes(file.id) && (file.folderId ?? null) !== folderId)
      if (targets.length === 0) return 0
      const previous = new Map(targets.map((file) => [file.id, file.folderId ?? null]))
      for (const file of targets) moved(file.id, folderId)

      const outcome = { moved: 0, refused: 0 }
      const queue = [...targets]
      const worker = async (): Promise<void> => {
        for (let file = queue.shift(); file; file = queue.shift()) {
          const restore = (): void => moved(file.id, previous.get(file.id) ?? null)
          try {
            const response = await fetch(`/api/documents/${file.id}/folder`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folderId }),
            })
            if (response.ok) outcome.moved += 1
            else {
              if (response.status === 409) outcome.refused += 1
              restore()
            }
          } catch {
            restore()
          }
        }
      }
      // Each move announces itself on the shelf's channel; a re-read between
      // two of them would put the rows not yet moved back under the finger.
      inFlight.current += 1
      try {
        await Promise.all(Array.from({ length: Math.min(MOVE_CONCURRENCY, targets.length) }, worker))
      } finally {
        inFlight.current -= 1
      }

      if (outcome.moved > 0) toast.success(t('selection.moved', { count: outcome.moved, folder: folderName }))
      const failed = targets.length - outcome.moved
      if (failed > 0) {
        toast.error(outcome.refused === failed ? t('folders.access.ifcRefused') : t('selection.moveFailed', { count: failed }))
      }
      return outcome.moved
    },
    [files, moved, t]
  )

  return { moved, dropInFolder, moveMany, isMoving }
}

/** How many moves of one selection are in flight at once. */
const MOVE_CONCURRENCY = 4
