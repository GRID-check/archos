'use client'

/**
 * Filing documents from the setup page: the Dateien upload, aimed at the
 * project's root.
 *
 * It is the very machinery Dateien runs (`useShelfUpload`: the folder plan, the
 * Fassung question for a name the project already holds, the screening of the
 * office's sensitive-data list), over the project's shelf with no folder
 * selected, so a dropped tree is recreated under the root. Nothing here uploads
 * a second way. The `FolderUploadDialog` it plans with is the caller's to
 * render: `upload.decision` is what it takes.
 *
 * A drop made on the create dialog waits under the dialog's own key, which the
 * redirect after creating hands to this project's setup page (`?drop=`); only
 * that page takes it. A drop made elsewhere in the app waits under the project's id, and
 * `useShelfUpload` takes that one itself.
 */

import { useCallback, useEffect, useMemo } from 'react'
import { useFolderTree } from '@/features/documents/hooks/use-folder-tree'
import { useProjectDocuments } from '@/features/documents/hooks/use-project-documents'
import { useShelfUpload } from '@/features/documents/hooks/use-shelf-upload'
import { takeDroppedFiles } from '@/features/documents/lib/dropped-file-handover'
import type { DropInfo } from '@/features/documents/hooks/use-file-drag-drop'
import { projectEndpoints } from '@/features/documents/lib/file-shelf'
import { createDocumentNameProbeClient } from '@/lib/documents/name-probe-client'

export interface UseIntakeUploadOptions {
  projectId: string
  collectionName: string
  /** The key the create dialog held a dropped folder under for THIS project, or null. */
  dropKey: string | null
  /** An upload finished (or failed): the review may have moved. */
  onSettled: () => void
}

const noop = (): void => undefined
const reloadNothing = (): Promise<void> => Promise.resolve()

export function useIntakeUpload({ projectId, collectionName, dropKey, onSettled }: UseIntakeUploadOptions) {
  const probe = useMemo(() => createDocumentNameProbeClient(), [])
  const endpoints = useMemo(() => projectEndpoints(projectId), [projectId])
  const upload = useProjectDocuments({ projectId, collectionName, onComplete: onSettled })
  const tree = useFolderTree({
    foldersUrl: endpoints.folders,
    files: [],
    selectedFolderId: null,
    onSelectFolder: noop,
    reloadFiles: reloadNothing,
  })
  const shelfUpload = useShelfUpload({
    shelf: {
      endpoints,
      projectId,
      handoverKey: projectId,
      probeNames: (names) => probe.project(projectId, names),
      probeRevisions: (names, landsIn) => probe.projectRevisions(projectId, names, landsIn),
    },
    upload,
    folders: tree.folders,
    foldersReady: !tree.isLoading && !tree.error,
    selectedFolderId: null,
    loadFolders: tree.load,
    loadFiles: reloadNothing,
  })
  const { handleUpload } = shelfUpload

  const foldersReady = !tree.isLoading && !tree.error
  useEffect(() => {
    if (!dropKey || !foldersReady) return
    const dropped = takeDroppedFiles(dropKey)
    if (dropped.length > 0) handleUpload(dropped)
  }, [dropKey, foldersReady, handleUpload])

  // What a drop could not read is told, as Dateien tells it (`handleUpload`).
  const send = useCallback(
    (files: File[], info?: DropInfo) => {
      if (files.length > 0 || info) handleUpload(files, { info })
    },
    [handleUpload]
  )

  return { send, shelfUpload, upload }
}
