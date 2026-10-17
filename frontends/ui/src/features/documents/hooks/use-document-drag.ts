'use client'

/**
 * Dragging things INSIDE the app — a document into a folder, a folder into
 * another folder.
 *
 * Neither adds a capability. `PATCH /api/documents/[id]/folder` and
 * `PATCH .../folders/[folderId]` both existed, offered as „Verschieben" in the
 * overflow menus. What this adds is the gesture people try first, and the
 * absence of which reads as the capability being missing.
 *
 * ## The hazard: the same surface listens for uploads
 *
 * Dropping files from the desktop is how you upload, so the workspace is
 * already covered in drag handlers. An internal drag must be told apart from an
 * OS one, and it is, on a fact the browser guarantees rather than on a flag we
 * set: `dataTransfer.types` contains `Files` only for a drag carrying real
 * files. A drag started inside the page carries our own MIME types and no
 * `Files`.
 *
 * That was the theory. In practice the upload side never asked — it raised its
 * full-surface overlay for any drag with items at all — so dragging a document
 * at a folder covered the folder in "drop files to upload to this project", and
 * the move looked broken. Both sides consult {@link isExternalFileDrag} now.
 *
 * ## Why an id rides in the MIME TYPE
 *
 * `getData` is deliberately blocked during `dragover`: a page must not be able
 * to read what is being dragged over it before the user commits to a drop. Only
 * the list of TYPES is readable. That is fine for a document — every folder can
 * receive any document — and not fine for a folder, which must refuse itself
 * and its own descendants BEFORE it highlights, or the gesture promises a move
 * the server will reject.
 *
 * So a folder drag sets two entries: the id as data under {@link FOLDER_DRAG_TYPE}
 * (read on drop, where `getData` works) and an empty payload under
 * `application/x-grid-folder-id:<id>`, whose TYPE carries the id and is readable
 * throughout the drag. Browsers lowercase drag types; a UUID is already
 * lowercase, so the round trip is exact.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { readDrop } from '../lib/dropped-entries'
import { useDragEnd } from './use-drag-end'

/**
 * Our own drag types. Custom MIME types rather than `text/plain` so a paragraph
 * dragged from another tab cannot look like a document.
 */
export const DOCUMENT_DRAG_TYPE = 'application/x-grid-document-id'
export const FOLDER_DRAG_TYPE = 'application/x-grid-folder-id'

const dragTypes = (dataTransfer: DataTransfer | null): string[] =>
  dataTransfer ? Array.from(dataTransfer.types ?? []) : []

/** True when a drag carries files from outside the browser (an upload). */
export function isExternalFileDrag(dataTransfer: DataTransfer | null): boolean {
  return dragTypes(dataTransfer).includes('Files')
}

/**
 * The folder being dragged, readable DURING a drag — see the module header for
 * why this comes off the type list rather than out of `getData`.
 */
export function draggedFolderId(dataTransfer: DataTransfer | null): string | null {
  const prefix = `${FOLDER_DRAG_TYPE}:`
  const carrier = dragTypes(dataTransfer).find((type) => type.startsWith(prefix))
  return carrier ? carrier.slice(prefix.length) : null
}

/*
 * WHETHER A MOVE IS IN THE AIR, AND WHAT IT CARRIES.
 *
 * The workspace re-reads its level when the shelf changes (`useShelfLive`), and
 * a re-read in the middle of a drag moves the tiles under the pointer: a
 * document aimed at „Statik" lands in whatever slid into its place. So the
 * re-read waits while a move is being dragged (`isInternalDragActive`).
 *
 * What is carried, and from where, is kept too ({@link internalDragSource}):
 * the level on screen takes a drop on its own background, but only of
 * something that is not already in it, and `getData` cannot say that during a
 * drag. A drag started in another tab has no source here and is not taken
 * there; it can still be dropped on a folder.
 *
 * Ended by the source's `dragend`, by any drop or `dragend` the window hears,
 * and, as the last resort for a source that unmounted mid-drag and so never
 * fires `dragend`, by the next pointer movement: there is none during a drag.
 */
export interface InternalDragSource {
  kind: 'document' | 'folder'
  id: string
  /** The folder it is in, or its parent for a folder; `null` is the top level. */
  from: string | null
}

let internalDrag: InternalDragSource | null = null

const endInternalDrag = (): void => {
  internalDrag = null
  window.removeEventListener('drop', endAfterThisEvent, true)
  window.removeEventListener('dragend', endAfterThisEvent, true)
  window.removeEventListener('pointermove', endInternalDrag, true)
}

/**
 * The window hears a drop in the CAPTURE phase, before the target it lands on.
 * Ending there cleared the source before the target read it, and the level on
 * screen, which takes only what is not already in it, refused every drop it
 * was offered. A task later, every handler of this event has run.
 */
const endAfterThisEvent = (): void => {
  setTimeout(endInternalDrag, 0)
}

const beginInternalDrag = (source: InternalDragSource): void => {
  internalDrag = source
  window.addEventListener('drop', endAfterThisEvent, true)
  window.addEventListener('dragend', endAfterThisEvent, true)
  // Armed a frame late: the pointer events that started the drag are still being delivered.
  requestAnimationFrame(() => {
    if (internalDrag) window.addEventListener('pointermove', endInternalDrag, true)
  })
}

/** Whether a document or a folder is being dragged inside the app right now. */
export function isInternalDragActive(): boolean {
  return internalDrag !== null
}

/** What this tab is dragging right now, or null. */
export function internalDragSource(): InternalDragSource | null {
  return internalDrag
}

/**
 * Props for a document being dragged. Spread onto a file card or list row.
 * `from` is the folder it is in, so the level it is already in does not offer
 * to take it.
 */
export function documentDragProps(documentId: string, from: string | null = null) {
  return {
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, documentId)
      // `move` so the cursor states the outcome. A file goes to one folder; it
      // is not copied into a second one.
      event.dataTransfer.effectAllowed = 'move'
      beginInternalDrag({ kind: 'document', id: documentId, from })
    },
    onDragEnd: endInternalDrag,
  }
}

/** Props for a folder being dragged. Spread onto a folder card or row. `parentId` is where it is. */
export function folderDragProps(folderId: string, parentId: string | null = null) {
  return {
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.setData(FOLDER_DRAG_TYPE, folderId)
      // The type-encoded twin, for targets deciding whether to highlight. See
      // the module header.
      event.dataTransfer.setData(`${FOLDER_DRAG_TYPE}:${folderId}`, '')
      event.dataTransfer.effectAllowed = 'move'
      // A folder tile is a drop target as well as a drag source, and a drag
      // that starts inside one would otherwise be reported to it as an incoming
      // drag before it has left.
      event.stopPropagation()
      beginInternalDrag({ kind: 'folder', id: folderId, from: parentId })
    },
    onDragEnd: endInternalDrag,
  }
}

/** Where files dragged in from the desktop would land, for the surface's overlay to name. */
export interface FileDropAim {
  folderId: string | null
  /** The target refuses them, and why. */
  refusal: string | null
}

/**
 * How long a drag is held over a folder before it opens, as in Finder and
 * Explorer: long enough that passing over a tile on the way to another does not
 * open it, short enough that waiting reads as asking.
 */
export const SPRING_OPEN_MS = 800

interface UseFolderDropTargetOptions {
  /** Move the document into this folder. `null` is the project root. */
  onDropDocument: (documentId: string, folderId: string | null) => void
  /**
   * Re-parent the dragged folder into this one. Absent means this target does
   * not take folders at all — which is what keeps a surface without a folder
   * tree (the Archiv) from offering a move it cannot make.
   */
  onDropFolder?: (draggedFolderId: string, parentId: string | null) => void
  /**
   * Whether this target may receive that folder. Called during the drag, so it
   * decides whether the target highlights at all rather than letting the server
   * refuse a drop the reader was invited to make.
   *
   * The caller owns the folder tree, so the caller owns the answer: a folder
   * cannot go into itself, into its own descendant, or into the parent it is
   * already in.
   */
  canAcceptFolder?: (draggedFolderId: string, targetFolderId: string | null) => boolean
  folderId: string | null
  /** Not a target for moves at all (the surface cannot move anything): those drags pass through. */
  disabled?: boolean
  /**
   * Files dragged in from the desktop and released on this folder: they go
   * INTO it. Absent leaves such a drag to the surface around the target, which
   * files it in the folder on screen.
   *
   * It used to be absent everywhere, so a PDF released on „Planung" landed
   * beside Planung, in the folder the reader stood in, while the tile under the
   * pointer never lit up.
   */
  onDropFiles?: (files: File[], info: { truncated: boolean; unreadable: number }, folderId: string | null) => void
  /**
   * The reader may only read this folder (ADR-0088), and why, in their words:
   * nothing lands in it, neither files nor a move. It still claims the drag, so
   * the cursor says „no drop" and the target turns red, rather than the drop
   * falling through to the level around it or nothing saying why.
   */
  refusal?: string | null
  /** Told where desktop files would land while they hover this target, and `null` when they leave it. */
  onFileAim?: (aim: FileDropAim | null) => void
  /**
   * Open this folder when a drag is held over it ({@link SPRING_OPEN_MS}), so a
   * document or a desktop file can be carried down into a folder that is not on
   * screen. Not for a folder dragged over its own subtree.
   */
  onSpringOpen?: () => void
  /**
   * Take a document or folder only when it is not already here
   * ({@link internalDragSource}): for the level on screen as a target, where a
   * release on its own background would otherwise read as a move to where it is.
   */
  onlyFromElsewhere?: boolean
}

type Incoming = 'files' | 'document' | 'folder'

/**
 * A folder as a drop target, with the highlight the gesture needs to be
 * legible — without a hover state a drag has no way to say where it will land.
 */
export function useFolderDropTarget({
  onDropDocument,
  onDropFolder,
  canAcceptFolder,
  folderId,
  disabled = false,
  onDropFiles,
  refusal = null,
  onFileAim,
  onSpringOpen,
  onlyFromElsewhere = false,
}: UseFolderDropTargetOptions) {
  const [isOver, setIsOver] = useState(false)
  const latest = useRef({ onFileAim, onSpringOpen })
  latest.current = { onFileAim, onSpringOpen }
  /**
   * `dragleave` fires when the pointer crosses from a tile onto its OWN
   * children — the button, the label, the count — and each one turned the
   * highlight off and straight back on, so a folder under the finger flickered
   * for the whole drag. `relatedTarget` is where the pointer went; if it is
   * still inside this element, nothing has been left.
   *
   * The ref holds what entered (and so what is to be cleared when it leaves),
   * and is the fallback for the case `relatedTarget` cannot answer: it is null
   * when the pointer leaves the window, and in a synthetic event it may be
   * absent entirely.
   */
  const insideRef = useRef<Incoming | null>(null)
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const disarm = useCallback(() => {
    if (springTimer.current) clearTimeout(springTimer.current)
    springTimer.current = null
  }, [])
  /** Out of the target, however it went: the highlight, the overlay's aim and a pending open go with it. */
  const leave = useCallback(() => {
    disarm()
    if (insideRef.current === 'files') latest.current.onFileAim?.(null)
    insideRef.current = null
    setIsOver(false)
  }, [disarm])
  // However the drag ends (a drop elsewhere, Esc, a release outside the
  // window), the highlight goes with it.
  useDragEnd(isOver, leave)
  // A spring-open navigates away and this target unmounts while it is aimed at.
  useEffect(
    () => () => {
      disarm()
      if (insideRef.current === 'files') latest.current.onFileAim?.(null)
    },
    [disarm]
  )

  /** What is coming in, if this target answers it at all. */
  const incoming = useCallback(
    (event: React.DragEvent): Incoming | null => {
      if (isExternalFileDrag(event.dataTransfer)) return onDropFiles ? 'files' : null
      if (disabled) return null
      const types = dragTypes(event.dataTransfer)
      const source = internalDragSource()
      if (onlyFromElsewhere && (!source || source.from === folderId)) return null
      if (types.includes(DOCUMENT_DRAG_TYPE)) return 'document'
      if (!onDropFolder || !types.includes(FOLDER_DRAG_TYPE)) return null
      const dragged = draggedFolderId(event.dataTransfer)
      // No id means a folder drag we cannot check — refuse rather than offer a
      // move that might be a folder into itself.
      if (!dragged) return null
      if (canAcceptFolder && !canAcceptFolder(dragged, folderId)) return null
      return 'folder'
    },
    [disabled, onDropFiles, onDropFolder, canAcceptFolder, folderId, onlyFromElsewhere]
  )

  const arm = useCallback(() => {
    if (!latest.current.onSpringOpen) return
    disarm()
    springTimer.current = setTimeout(() => {
      springTimer.current = null
      leave()
      latest.current.onSpringOpen?.()
    }, SPRING_OPEN_MS)
  }, [disarm, leave])

  return {
    isOver,
    /** The highlight is a refusal: something is held over a folder that takes nothing. */
    refuses: isOver && Boolean(refusal),
    dropProps: {
      onDragOver: (event: React.DragEvent) => {
        const kind = incoming(event)
        if (!kind) return
        // Both, and in this order: without `preventDefault` the browser refuses
        // the drop, and without stopping propagation the workspace's own
        // handlers also see it and file it in the folder on screen.
        event.preventDefault()
        event.stopPropagation()
        // The cursor states the outcome.
        event.dataTransfer.dropEffect = refusal ? 'none' : kind === 'files' ? 'copy' : 'move'
        if (insideRef.current) return
        insideRef.current = kind
        if (kind === 'files') latest.current.onFileAim?.({ folderId, refusal })
        arm()
        setIsOver(true)
      },
      onDragLeave: (event: React.DragEvent) => {
        // An upload drag is the workspace's: its enter reached the workspace's
        // counter through this tile, so its leave must too, or the counter
        // never returns to zero and „Dateien hier ablegen" stays up. Not stopped.
        if (!isExternalFileDrag(event.dataTransfer)) event.stopPropagation()
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) return
        leave()
      },
      onDrop: (event: React.DragEvent) => {
        const kind = incoming(event)
        if (!kind) return
        event.preventDefault()
        event.stopPropagation()
        leave()
        if (refusal) return
        if (kind === 'files') {
          // Synchronously from the event: the browser empties the transfer when it returns.
          void readDrop(event.dataTransfer).then(({ files, truncated, unreadable }) => {
            if (files.length > 0 || truncated || unreadable > 0) onDropFiles?.(files, { truncated, unreadable }, folderId)
          })
          return
        }
        // `getData` works here — the drop is the moment the page is allowed to
        // read what it was handed.
        if (kind === 'document') {
          const documentId = event.dataTransfer.getData(DOCUMENT_DRAG_TYPE)
          if (documentId) onDropDocument(documentId, folderId)
          return
        }
        const dragged = event.dataTransfer.getData(FOLDER_DRAG_TYPE)
        if (dragged) onDropFolder?.(dragged, folderId)
      },
    },
  }
}
