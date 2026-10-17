'use client'

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { FileItem, FolderItem } from '../file-types'
import { refusalOf, shelfRefusalOf, throwUnlessOk, type ShelfRefusal } from '../lib/move-refusal'

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

  /**
   * Every document this workspace has listed, by id. A drag can outlive the
   * level it started on: held over a folder, the folder opens (see
   * `useFolderDropTarget`'s `onSpringOpen`), and the card being carried is no
   * longer in `files` when it is dropped. The move still needs its name and
   * where it came from.
   */
  const seen = useRef(new Map<string, FileItem>())
  useEffect(() => {
    for (const file of files) seen.current.set(file.id, file)
  }, [files])

  const folderLabel = useCallback(
    (folderId: string | null) =>
      folderId ? (folders.find((folder) => folder.id === folderId)?.name ?? '') : t('folders.allFiles'),
    [folders, t]
  )

  /** Why a move did not happen, in words: every one of these fails the same way again, so none asks to retry. */
  const refusalMessage = useCallback(
    (refusal: ShelfRefusal | null): string => {
      if (refusal === 'ifcRestricted') return t('folders.access.ifcRefused')
      if (refusal === 'readOnly') return t('folders.moveRefusedReadOnly')
      if (refusal === 'gone') return t('folders.moveRefusedGone')
      return t('actions.moveError')
    },
    [t]
  )

  /** The undo is the same move back, and offers no undo of its own. Set below, once the move exists. */
  const undo = useRef<(documentId: string, folderId: string | null) => Promise<void>>(async () => {})

  /**
   * Optimistic: the card visibly leaves the level under the finger, so waiting
   * for a round trip would make a good move look broken. The toast offers it
   * back: a drop that landed one tile off is one click to undo, not a search
   * for where the document went.
   */
  const dropInFolder = useCallback(
    async (documentId: string, folderId: string | null, { undoable = true }: { undoable?: boolean } = {}) => {
      // The remembered row first: a move updates it at once, so an undo clicked
      // before the listing re-renders still knows where the document is now.
      const file = seen.current.get(documentId) ?? files.find((candidate) => candidate.id === documentId)
      if (!file || (file.folderId ?? null) === folderId) return
      const previousFolderId = file.folderId ?? null
      const name = documentDisplayName(file)

      moved(documentId, folderId)
      seen.current.set(documentId, { ...file, folderId })
      inFlight.current += 1
      try {
        await throwUnlessOk(
          await fetch(`/api/documents/${documentId}/folder`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderId }),
          })
        )
        if (!undoable) {
          toast.success(t('folders.movedBack', { name, folder: folderLabel(folderId) }))
          return
        }
        toast.success(t('actions.moved', { name, folder: folderLabel(folderId) }), {
          action: {
            label: t('folders.moveUndo'),
            onClick: () => void undo.current(documentId, previousFolderId),
          },
        })
      } catch (error) {
        moved(documentId, previousFolderId)
        seen.current.set(documentId, file)
        toast.error(refusalMessage(refusalOf(error)))
      } finally {
        inFlight.current -= 1
      }
    },
    [files, moved, folderLabel, refusalMessage, t]
  )
  undo.current = (documentId, folderId) => dropInFolder(documentId, folderId, { undoable: false })

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
              if ((await shelfRefusalOf(response)) === 'ifcRestricted') outcome.refused += 1
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
