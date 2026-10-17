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

import { useCallback, useRef, useState } from 'react'
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

/** True when a drag was started inside the app — a document or a folder. */
export function isInternalDrag(dataTransfer: DataTransfer | null): boolean {
  const types = dragTypes(dataTransfer)
  return types.includes(DOCUMENT_DRAG_TYPE) || types.includes(FOLDER_DRAG_TYPE)
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
 * WHETHER A MOVE IS IN THE AIR.
 *
 * The workspace re-reads its level when the shelf changes (`useShelfLive`), and
 * a re-read in the middle of a drag moves the tiles under the pointer: a
 * document aimed at „Statik" lands in whatever slid into its place. So the
 * re-read waits while a move is being dragged (`isInternalDragActive`).
 *
 * Ended by the source's `dragend`, by any drop or `dragend` the window hears,
 * and, as the last resort for a source that unmounted mid-drag and so never
 * fires `dragend`, by the next pointer movement: there is none during a drag.
 */
let internalDragActive = false

const endInternalDrag = (): void => {
  internalDragActive = false
  window.removeEventListener('drop', endInternalDrag, true)
  window.removeEventListener('dragend', endInternalDrag, true)
  window.removeEventListener('pointermove', endInternalDrag, true)
}

const beginInternalDrag = (): void => {
  internalDragActive = true
  window.addEventListener('drop', endInternalDrag, true)
  window.addEventListener('dragend', endInternalDrag, true)
  // Armed a frame late: the pointer events that started the drag are still being delivered.
  requestAnimationFrame(() => {
    if (internalDragActive) window.addEventListener('pointermove', endInternalDrag, true)
  })
}

/** Whether a document or a folder is being dragged inside the app right now. */
export function isInternalDragActive(): boolean {
  return internalDragActive
}

/** Props for a document being dragged. Spread onto a file card or list row. */
export function documentDragProps(documentId: string) {
  return {
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, documentId)
      // `move` so the cursor states the outcome. A file goes to one folder; it
      // is not copied into a second one.
      event.dataTransfer.effectAllowed = 'move'
      beginInternalDrag()
    },
    onDragEnd: endInternalDrag,
  }
}

/** Props for a folder being dragged. Spread onto a folder card or row. */
export function folderDragProps(folderId: string) {
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
      beginInternalDrag()
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
  /** A folder cannot receive what it already holds, nor can it receive itself. */
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
  /** This folder takes no files (it is read-only), and why. The drag shows „no drop" here. */
  fileRefusal?: string | null
  /** Told where desktop files would land while they hover this target, and `null` when they leave it. */
  onFileAim?: (aim: FileDropAim | null) => void
}

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
  fileRefusal = null,
  onFileAim,
}: UseFolderDropTargetOptions) {
  const [isOver, setIsOver] = useState(false)
  const aimRef = useRef(onFileAim)
  aimRef.current = onFileAim
  /**
   * Whether this target answers desktop files at all: whenever it was given a
   * place to put them. `disabled` is about moves (a folder cannot take what it
   * holds); a read-only folder answers files with its `fileRefusal`.
   */
  const takesFiles = Boolean(onDropFiles)
  /**
   * `dragleave` fires when the pointer crosses from a tile onto its OWN
   * children — the button, the label, the count — and each one turned the
   * highlight off and straight back on, so a folder under the finger flickered
   * for the whole drag. `relatedTarget` is where the pointer went; if it is
   * still inside this element, nothing has been left.
   *
   * The ref is the fallback for the case `relatedTarget` cannot answer: it is
   * null when the pointer leaves the window, and in a synthetic event it may be
   * absent entirely.
   */
  const insideRef = useRef(false)
  // However the drag ends (a drop elsewhere, Esc, a release outside the
  // window), the highlight goes with it.
  useDragEnd(isOver, () => {
    insideRef.current = false
    setIsOver(false)
    aimRef.current?.(null)
  })

  const acceptedKind = useCallback(
    (event: React.DragEvent): 'document' | 'folder' | null => {
      if (disabled || isExternalFileDrag(event.dataTransfer)) return null
      const types = Array.from(event.dataTransfer.types ?? [])
      if (types.includes(DOCUMENT_DRAG_TYPE)) return 'document'
      if (!onDropFolder || !types.includes(FOLDER_DRAG_TYPE)) return null
      const dragged = draggedFolderId(event.dataTransfer)
      // No id means a folder drag we cannot check — refuse rather than offer a
      // move that might be a folder into itself.
      if (!dragged) return null
      if (canAcceptFolder && !canAcceptFolder(dragged, folderId)) return null
      return 'folder'
    },
    [disabled, onDropFolder, canAcceptFolder, folderId]
  )

  return {
    isOver,
    /** The highlight is a refusal: desktop files over a folder that takes none. */
    refusesFiles: isOver && Boolean(fileRefusal),
    dropProps: {
      onDragOver: (event: React.DragEvent) => {
        if (takesFiles && isExternalFileDrag(event.dataTransfer)) {
          // Claimed so the workspace around it does not file the drop in the
          // folder on screen; enter and leave still reach its counter.
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = fileRefusal ? 'none' : 'copy'
          if (!insideRef.current) aimRef.current?.({ folderId, refusal: fileRefusal })
          insideRef.current = true
          setIsOver(true)
          return
        }
        if (!acceptedKind(event)) return
        // Both, and in this order: without `preventDefault` the browser refuses
        // the drop, and without stopping propagation the workspace's own
        // upload-drop handler also sees it.
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        insideRef.current = true
        setIsOver(true)
      },
      onDragLeave: (event: React.DragEvent) => {
        // An upload drag is the workspace's: its enter reached the workspace's
        // counter through this tile, so its leave must too, or the counter
        // never returns to zero and „Dateien hier ablegen" stays up. Not stopped.
        if (isExternalFileDrag(event.dataTransfer)) {
          const next = event.relatedTarget
          if (next instanceof Node && event.currentTarget.contains(next)) return
          if (insideRef.current) aimRef.current?.(null)
          insideRef.current = false
          setIsOver(false)
          return
        }
        event.stopPropagation()
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) return
        insideRef.current = false
        setIsOver(false)
      },
      onDrop: (event: React.DragEvent) => {
        if (takesFiles && isExternalFileDrag(event.dataTransfer)) {
          event.preventDefault()
          event.stopPropagation()
          insideRef.current = false
          setIsOver(false)
          aimRef.current?.(null)
          if (fileRefusal || !onDropFiles) return
          // Synchronously from the event: the browser empties the transfer when it returns.
          void readDrop(event.dataTransfer).then(({ files, truncated, unreadable }) => {
            if (files.length > 0 || truncated || unreadable > 0) onDropFiles(files, { truncated, unreadable }, folderId)
          })
          return
        }
        const kind = acceptedKind(event)
        if (!kind) return
        event.preventDefault()
        event.stopPropagation()
        insideRef.current = false
        setIsOver(false)
        if (kind === 'document') {
          const documentId = event.dataTransfer.getData(DOCUMENT_DRAG_TYPE)
          if (documentId) onDropDocument(documentId, folderId)
          return
        }
        // `getData` works here — the drop is the moment the page is allowed to
        // read what it was handed.
        const dragged = event.dataTransfer.getData(FOLDER_DRAG_TYPE)
        if (dragged) onDropFolder?.(dragged, folderId)
      },
    },
  }
}
