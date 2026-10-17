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
 * A drop made on the create dialog waits under {@link NEW_PROJECT_DROP_KEY}; the
 * first load of a project whose intake is still waiting for its documents takes
 * it. A drop made elsewhere in the app waits under the project's id, and
 * `useShelfUpload` takes that one itself.
 */

import { useCallback, useEffect, useMemo } from 'react'
import { useFolderTree } from '@/features/documents/hooks/use-folder-tree'
import { useProjectDocuments } from '@/features/documents/hooks/use-project-documents'
import { useShelfUpload } from '@/features/documents/hooks/use-shelf-upload'
import { NEW_PROJECT_DROP_KEY, takeDroppedFiles } from '@/features/documents/lib/dropped-file-handover'
import { projectEndpoints } from '@/features/documents/lib/file-shelf'
import { createDocumentNameProbeClient } from '@/lib/documents/name-probe-client'

export interface UseIntakeUploadOptions {
  projectId: string
  collectionName: string
  /** The intake still waits for its first documents: a drop from the create dialog is for this project. */
  takeNewProjectDrop: boolean
  /** An upload finished (or failed): the review may have moved. */
  onSettled: () => void
}

const noop = (): void => undefined
const reloadNothing = (): Promise<void> => Promise.resolve()

export function useIntakeUpload({ projectId, collectionName, takeNewProjectDrop, onSettled }: UseIntakeUploadOptions) {
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
      handoverKey: projectId,
      probeNames: (names) => probe.project(projectId, names),
      probeFassungen: (names, landsIn) => probe.projectFassungen(projectId, names, landsIn),
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
    if (!takeNewProjectDrop || !foldersReady) return
    const dropped = takeDroppedFiles(NEW_PROJECT_DROP_KEY)
    if (dropped.length > 0) handleUpload(dropped)
  }, [takeNewProjectDrop, foldersReady, handleUpload])

  const send = useCallback(
    (files: File[]) => {
      if (files.length > 0) handleUpload(files)
    },
    [handleUpload]
  )

  return { send, shelfUpload, upload }
}
