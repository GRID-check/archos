'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useLocale, useTranslations } from '@/i18n'
import { isProjectClosedBody } from '@/lib/projects/project-status'
import { formatCalendarDate } from '@/lib/format'
import type { FileItem, FolderItem } from '../file-types'
import type { FolderAccessLevel } from '../lib/file-shelf'
import { refusalOf, shelfRefusalOf, throwUnlessOk } from '../lib/move-refusal'

export interface FolderTreeOptions {
  /** The shelf's folder collection (`/api/projects/{id}/folders`, `/api/archiv/folders`). */
  foldersUrl: string
  /** The tree as the server already read it, for the first paint. */
  initialFolders?: readonly FolderItem[]
  /**
   * What the reader may do at the shelf's root for the first paint (ADR-0088).
   * Absent means `write`; every listing read refreshes it from `rootAccess`.
   * Only a project's listing reports it; the Archiv's root is `write` here and
   * `canManage` decides.
   */
  initialRootAccess?: FolderAccessLevel
  /** What deleting a folder needs to name: how much is inside it. */
  files: readonly FileItem[]
  /**
   * How many documents are filed directly in a folder, when the caller knows
   * it better than `files` (a paged level holds one folder's first pages, the
   * shelf summary counts every folder, ADR-0102). Absent: counted in `files`.
   */
  documentCountIn?: (folderId: string) => number
  selectedFolderId: string | null
  onSelectFolder: (id: string | null) => void
  /** Re-read the documents after a change that moved some (a delete re-files them). */
  reloadFiles: (quiet?: boolean) => Promise<unknown>
  /**
   * The shelf's Papierkorb (a project's, ADR-0088). With it, a delete moves the
   * folder there with its contents and the toast links to it; without it (the
   * Archiv), a delete re-files the contents into the parent.
   */
  binHref?: string
}

/**
 * One shelf's folder tree: read it, and the four things a reader does to it.
 *
 * Every sentence is a `files` key. The Archiv has folders now, and a second set
 * of strings for „Ordner löschen" in another namespace would be the first thing
 * to drift.
 *
 * Rename and move re-read the tree rather than patching it: `path` is
 * materialised on every row, so changing one folder rewrites everything beneath
 * it, and guessing that here would be a second implementation of the server's
 * rule.
 */
export function useFolderTree({
  foldersUrl,
  initialFolders,
  initialRootAccess = 'write',
  files,
  documentCountIn,
  selectedFolderId,
  onSelectFolder,
  reloadFiles,
  binHref,
}: FolderTreeOptions) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const router = useRouter()
  const [folders, setFolders] = useState<FolderItem[]>(() => [...(initialFolders ?? [])])
  const [isLoading, setIsLoading] = useState(initialFolders === undefined)
  /**
   * Whether any read has answered yet (the seed counts). A rename or a move
   * re-reads the tree; the tiles already on screen stay there while it does,
   * so only a tree that was never read is a reason to draw a skeleton.
   */
  const [hasAnswer, setHasAnswer] = useState(initialFolders !== undefined)
  const [error, setError] = useState(false)
  /** What the reader may do at the root (ADR-0088); each folder carries its own `access`. */
  const [rootAccess, setRootAccess] = useState<FolderAccessLevel>(initialRootAccess)

  /*
   * Reads cross: a create re-reads, a rename right after it re-reads, and a
   * live hint (`useShelfLive`) re-reads too. Only the newest read may commit,
   * or an older answer landing last takes the folder just made off the screen.
   * And a re-read that fails keeps the tree it had: emptying it made every
   * folder vanish over one dropped request, and the next hint reads again.
   */
  const generation = useRef(0)
  const answered = useRef(initialFolders !== undefined)
  const load = useCallback(() => {
    const stamp = ++generation.current
    setIsLoading(true)
    setError(false)
    return fetch(foldersUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load folders (${response.status})`)
        return response.json()
      })
      .then((data: { folders?: FolderItem[]; rootAccess?: FolderAccessLevel }) => {
        if (stamp !== generation.current) return
        setFolders(data.folders ?? [])
        setRootAccess(data.rootAccess === 'read' ? 'read' : 'write')
        answered.current = true
      })
      .catch(() => {
        if (stamp !== generation.current || answered.current) return
        setFolders([])
        setError(true)
      })
      .finally(() => {
        if (stamp !== generation.current) return
        setIsLoading(false)
        setHasAnswer(true)
      })
  }, [foldersUrl])

  // The seeded first render is already the answer: skip the mount load once.
  const seeded = useRef(initialFolders !== undefined)
  useEffect(() => {
    if (seeded.current) {
      seeded.current = false
      return
    }
    void load()
  }, [load])

  const parentName = useCallback(
    (parentId: string | null) =>
      parentId ? (folders.find((f) => f.id === parentId)?.name ?? '') : t('folders.allFiles'),
    [folders, t]
  )

  const create = useCallback(
    async (name: string, parentId?: string) => {
      const response = await fetch(foldersUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId }),
      })
      if (!response.ok) {
        toast.error(
          (await shelfRefusalOf(response)) === 'nameTaken'
            ? t('folders.nameTaken', { name, parent: parentName(parentId ?? null) })
            : t('workspace.createFolderError')
        )
        return false
      }
      const data = await response.json()
      setFolders((prev) => [...prev, data.folder])
      return true
    },
    [foldersUrl, parentName, t]
  )

  const rename = useCallback(
    async (folderId: string, name: string) => {
      const response = await fetch(`${foldersUrl}/${folderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!response.ok) {
        const parentId = folders.find((folder) => folder.id === folderId)?.parentId ?? null
        toast.error(
          (await shelfRefusalOf(response)) === 'nameTaken'
            ? t('folders.nameTaken', { name, parent: parentName(parentId) })
            : t('workspace.renameFolderError')
        )
        return false
      }
      const data = await response.json()
      await load()
      setFolders((prev) => prev.map((f) => (f.id === folderId ? { ...f, ...data.folder } : f)))
      return true
    },
    [foldersUrl, folders, parentName, t, load]
  )

  /**
   * Say what belongs in a folder (migration 0145); `null` clears it. Patched
   * from the server's answer, since a description moves no path.
   */
  const describe = useCallback(
    async (folderId: string, description: string | null) => {
      const response = await fetch(`${foldersUrl}/${folderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      })
      if (!response.ok) {
        toast.error(t('folders.description.saveError'))
        return false
      }
      const data = (await response.json()) as { folder?: Partial<FolderItem> }
      setFolders((prev) =>
        prev.map((f) => (f.id === folderId ? { ...f, description: data.folder?.description ?? description } : f))
      )
      return true
    },
    [foldersUrl, t]
  )

  /** Folder moves of this tab still on the wire; a live re-read waits for them, as for documents. */
  const inFlight = useRef(0)
  const isMoving = useCallback(() => inFlight.current > 0, [])
  /** The undo is the same move back, and offers no undo of its own. */
  const undo = useRef<(folderId: string, parentId: string | null) => Promise<void>>(async () => {})

  /**
   * A folder dragged onto another folder (or onto a way up in the path), or
   * moved from its menu. Optimistic on the PARENT (the tile moves in the frame
   * the finger let go) and then re-read for the paths. The pane refuses a move
   * into a folder's own subtree before the drop; what the server still refuses
   * (a sibling of the same name there, a folder only readable, an IFC model
   * bound for a restricted folder, a folder deleted meanwhile) is said by name,
   * and the toast of a move that went through offers it back.
   */
  const move = useCallback(
    async (draggedFolderId: string, parentId: string | null, { undoable = true }: { undoable?: boolean } = {}) => {
      const folder = folders.find((candidate) => candidate.id === draggedFolderId)
      if (!folder || (folder.parentId ?? null) === parentId) return
      const previousParentId = folder.parentId ?? null
      const setParent = (next: string | null) =>
        setFolders((prev) => prev.map((f) => (f.id === draggedFolderId ? { ...f, parentId: next } : f)))

      setParent(parentId)
      inFlight.current += 1
      try {
        await throwUnlessOk(
          await fetch(`${foldersUrl}/${draggedFolderId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parentId }),
          })
        )
        await load()
        const done = { name: folder.name, parent: parentName(parentId) }
        if (!undoable) {
          toast.success(t('folders.movedBack', { name: folder.name, folder: parentName(parentId) }))
          return
        }
        toast.success(t('folders.movedFolder', done), {
          action: { label: t('folders.moveUndo'), onClick: () => void undo.current(draggedFolderId, previousParentId) },
        })
      } catch (error) {
        setParent(previousParentId)
        const refusal = refusalOf(error)
        toast.error(
          refusal === 'nameTaken'
            ? t('folders.nameTaken', { name: folder.name, parent: parentName(parentId) })
            : refusal === 'ifcRestricted'
              ? t('folders.access.ifcRefused')
              : refusal === 'readOnly'
                ? t('folders.moveRefusedReadOnly')
                : refusal === 'gone'
                  ? t('folders.moveRefusedGone')
                  : t('folders.moveFolderError')
        )
        // Someone else's change is why it failed (a folder gone, a name taken
        // meanwhile): the tree on screen is behind, so read it again.
        if (refusal === 'gone' || refusal === 'nameTaken') void load()
      } finally {
        inFlight.current -= 1
      }
    },
    [folders, foldersUrl, load, parentName, t]
  )
  undo.current = (folderId, parentId) => move(folderId, parentId, { undoable: false })

  /**
   * NAME WHAT HAPPENS TO THE WORK. A folder is a label somebody put on a set of
   * documents, and the one question in this reader's head is "does this delete
   * my files?" — so the confirm answers it, instead of a generic "this cannot
   * be undone" that would be frightening and, on both shelves, false. On a
   * shelf with a Papierkorb the contents go into it with the folder and can be
   * restored; on the Archiv they are re-filed into the parent, with the count
   * and where they will be.
   */
  const remove = useCallback(
    async (folderId: string) => {
      const folder = folders.find((f) => f.id === folderId)
      if (!folder) return false
      const inside = documentCountIn ? documentCountIn(folderId) : files.filter((f) => f.folderId === folderId).length
      const nested = folders.filter((f) => f.parentId === folderId).length
      const parent = folder.parentId
        ? (folders.find((f) => f.id === folder.parentId)?.name ?? t('folders.allFiles'))
        : t('folders.allFiles')
      const question = binHref
        ? t('workspace.binFolderConfirm', { name: folder.name })
        : inside > 0 || nested > 0
          ? t('workspace.deleteFolderConfirmWithContents', {
              name: folder.name,
              documents: String(inside),
              folders: String(nested),
              parent,
            })
          : t('workspace.deleteFolderConfirm', { name: folder.name })
      if (!window.confirm(question)) return false

      const response = await fetch(`${foldersUrl}/${folderId}`, { method: 'DELETE' })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { details?: { reason?: unknown } } | null
        const reason = typeof body?.details?.reason === 'string' ? body.details.reason : null
        toast.error(
          isProjectClosedBody(body)
            ? t('errors.projectClosed')
            : reason === 'folder-contents-protected'
              ? t('workspace.deleteFolderProtected')
              : response.status === 502
                ? t('workspace.deleteFolderIndexDown')
                : t('workspace.deleteFolderError')
        )
        return false
      }
      const answer = (await response.json().catch(() => ({}))) as { documentsMoved?: number; purgeAfter?: string }
      // The selection cannot stay on a folder that no longer exists — it would
      // filter the grid to nothing and read as an empty shelf.
      if (selectedFolderId === folderId) onSelectFolder(folder.parentId ?? null)
      await Promise.all([load(), reloadFiles(true)])
      if (binHref) {
        toast.success(
          t('workspace.binFolderDone', {
            name: folder.name,
            date: answer.purgeAfter ? formatCalendarDate(answer.purgeAfter, locale) : '—',
          }),
          { action: { label: t('workspace.openBin'), onClick: () => router.push(binHref) } }
        )
        return true
      }
      toast.success(
        answer.documentsMoved
          ? t('workspace.deleteFolderMoved', { count: String(answer.documentsMoved), parent })
          : t('workspace.deleteFolderDone', { name: folder.name })
      )
      return true
    },
    [foldersUrl, binHref, t, locale, router, folders, files, documentCountIn, selectedFolderId, onSelectFolder, load, reloadFiles]
  )

  /** `isLoading` is any read in flight (the upload plan waits for it); this is only the first. */
  const isFirstLoad = isLoading && !hasAnswer

  return { folders, rootAccess, isLoading, isFirstLoad, error, load, create, rename, describe, move, remove, isMoving }
}
