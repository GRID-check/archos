/**
 * Drag-and-drop UPLOAD — files from the desktop onto the workspace.
 *
 * Drag state and the handlers for it. Validation happens in `uploadFiles`, not
 * here.
 *
 * ## It answers for uploads only, and that is new
 *
 * The same surface is also where a document is dragged onto a folder, and this
 * hook used to raise its full-surface overlay for ANY drag with items on it —
 * which an in-app drag has, because our own MIME type is an item. So aiming a
 * document at a folder covered that folder in „Dateien hier ablegen", and the
 * move it was about to make read as broken.
 *
 * Every handler now asks {@link isExternalFileDrag} first, which is the same
 * question the folder drop targets ask, from the same module. `Files` in
 * `dataTransfer.types` is a fact the browser guarantees for a drag carrying
 * real files and never sets for one started inside the page.
 *
 * The guard is on ENTER AND LEAVE deliberately. The counter below pairs them,
 * so a leave that is counted after an enter that was not would drive it
 * negative and leave the overlay stuck on the next real upload.
 *
 * ## Off, and saying no, are different
 *
 * A zone that is `disabled` is not a target: it touches no event, so the drop
 * falls through to whatever is around it, or to the window guard. It used to
 * claim the drop anyway (`preventDefault`, `stopPropagation`) and do nothing
 * with it, so the cursor said „copy" and the files vanished without a word:
 * the composer while Piloti answered, a read-only folder in Dateien, a second
 * batch dropped while the first was uploading.
 *
 * A zone that is there but cannot take files right now says so instead:
 * `refusal` keeps the overlay up with the reason in it and the cursor at
 * „no drop", and the drop never fires.
 *
 * ## A portal is not the zone
 *
 * React bubbles a synthetic event along the COMPONENT tree, and a Radix dialog,
 * popover or sheet is portalled out of the DOM but stays inside the component
 * that opened it. So a file let go over a dialog opened from a project page
 * reached the project's zone behind it and was sent to Dateien, and one let go
 * over a dialog opened from the chat was attached to the conversation. An
 * event whose target is not inside the zone's own element is not a drag over
 * the zone: {@link outsideTheZone} leaves it alone, and the window guard gives
 * it „no drop" unless the dialog has a zone of its own.
 *
 * ## The overlay ends when the drag does
 *
 * The counter only hears enters and leaves that reach this zone. A drag that
 * ended elsewhere (a drop on a folder tile, which claims it and stops it there;
 * a drop beside the zone; a release over the desktop) left the overlay up.
 * `useDragEnd` hears every end.
 */

import { useCallback, useRef, useState } from 'react'
import { useAppConfig } from '@/shared/context'
import { checkDraggedFilesSupported } from '../validation'
import { isExternalFileDrag } from './use-document-drag'
import { useDragEnd } from './use-drag-end'
import { readDrop } from '../lib/dropped-entries'

/**
 * Whether the event reached this zone from outside its element: from a portal
 * (a dialog, a popover) that a component inside the zone rendered. Nodes only,
 * so an event without a DOM target is taken as the zone's own.
 */
export function outsideTheZone(e: Pick<React.DragEvent, 'currentTarget' | 'target'>): boolean {
  const zone = e.currentTarget
  const target = e.target
  if (!(zone instanceof Node) || !(target instanceof Node)) return false
  return !zone.contains(target)
}

/** What a drop could not hand over, for the caller to say. */
export interface DropInfo {
  /** A bound was reached: the drop held more than the files passed. */
  truncated: boolean
  /** Files that were dropped and could not be read. */
  unreadable: number
}

interface UseFileDragDropOptions {
  /** The dropped files, folders read through (paths stamped), ZIPs as they are. */
  onDrop: (files: File[], info: DropInfo) => void
  /** Not a target at all: every event passes through untouched. */
  disabled?: boolean
  /**
   * A target that cannot take files right now, and why, in the reader's words
   * („Nur lesen"). The overlay says it and the drop is refused.
   */
  refusal?: string | null
  /**
   * Whether a dragged `.zip` counts as supported. On for the durable shelves,
   * which unpack it before uploading; off for a chat attachment, where an
   * archive is not a document.
   */
  acceptZip?: boolean
}

interface UseFileDragDropReturn {
  /** Whether files are being dragged over the drop zone */
  isDragging: boolean
  /** Whether dragged files contain unsupported types */
  isUnsupportedDrag: boolean
  /** The refusal in force for the drag over the zone, or null when it would be taken. */
  refusal: string | null
  /** Event handlers to spread on the drop zone element */
  dragHandlers: {
    onDragEnter: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

/**
 * Hook for handling drag-and-drop file uploads.
 * Provides drag state for UI feedback and passes dropped files to onDrop callback.
 */
export function useFileDragDrop({
  onDrop,
  disabled = false,
  refusal = null,
  acceptZip = false,
}: UseFileDragDropOptions): UseFileDragDropReturn {
  const [isDragging, setIsDragging] = useState(false)
  const [isUnsupportedDrag, setIsUnsupportedDrag] = useState(false)
  const dragCounterRef = useRef(0)
  const { fileUpload: fileUploadConfig } = useAppConfig()

  const reset = useCallback(() => {
    dragCounterRef.current = 0
    setIsDragging(false)
    setIsUnsupportedDrag(false)
  }, [])
  useDragEnd(isDragging, reset)

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      // Not an upload (a document or a folder being moved inside the page), or
      // not a target: left alone entirely, so what is under or around it decides.
      if (disabled || !isExternalFileDrag(e.dataTransfer) || outsideTheZone(e)) return
      e.preventDefault()
      e.stopPropagation()

      dragCounterRef.current++
      setIsDragging(true)
      // Quick MIME check, for the affordance only.
      const allSupported = checkDraggedFilesSupported(e.dataTransfer, fileUploadConfig, {
        allowZip: acceptZip,
      })
      setIsUnsupportedDrag(!allSupported)
    },
    [disabled, fileUploadConfig, acceptZip]
  )

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      // Paired with the enter above: a leave this hook never counted must not be
      // subtracted, or the counter goes negative and the overlay never clears.
      if (disabled || !isExternalFileDrag(e.dataTransfer) || outsideTheZone(e)) return
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
      if (dragCounterRef.current === 0) {
        setIsDragging(false)
        setIsUnsupportedDrag(false)
      }
    },
    [disabled]
  )

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      // An in-app drag is answered by the folder under the pointer, which calls
      // `preventDefault` itself. Doing it here as well would make the whole
      // workspace a valid drop target for a move, so a document released between
      // two folder tiles would read as accepted and do nothing.
      if (disabled || !isExternalFileDrag(e.dataTransfer) || outsideTheZone(e)) return
      e.preventDefault()
      e.stopPropagation()
      // The cursor states the outcome: a copy onto the shelf, or no drop at all.
      e.dataTransfer.dropEffect = refusal ? 'none' : 'copy'
    },
    [disabled, refusal]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      // Before `preventDefault`, which is what claims a drop. A move that
      // missed its folder is not this surface's to accept: the document stays
      // where it is, and `useWindowDragGuard` is what stops the browser doing
      // anything with the release.
      if (disabled || !isExternalFileDrag(e.dataTransfer) || outsideTheZone(e)) return

      e.preventDefault()
      e.stopPropagation()
      reset()
      // A refused drag shows „no drop" and is not delivered; a browser that
      // delivers it anyway is told no here as well.
      if (refusal) return

      // A DROPPED FOLDER IS INVISIBLE TO `dataTransfer.files`, and the browser
      // empties the transfer the moment this handler returns: `readDrop`
      // captures both the list and the entries synchronously, before its first
      // await (see `lib/dropped-entries`).
      void readDrop(e.dataTransfer).then(({ files, truncated, unreadable }) => {
        if (files.length === 0 && !truncated && unreadable === 0) return
        // Validation happens in uploadFiles.
        onDrop(files, { truncated, unreadable })
      })
    },
    [disabled, refusal, onDrop, reset]
  )

  return {
    isDragging,
    isUnsupportedDrag,
    refusal: isDragging ? refusal : null,
    dragHandlers: {
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
    },
  }
}
